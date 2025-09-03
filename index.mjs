// index.mjs
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { Readable } from "stream";
import crypto from "crypto";

// Debug: Log all environment variables first
console.log('[ENV_DEBUG] All environment variables:');
console.log('[ENV_DEBUG] AWS_REGION:', process.env.AWS_REGION);
console.log('[ENV_DEBUG] HISTORY_BUCKET:', process.env.HISTORY_BUCKET);
console.log('[ENV_DEBUG] MEDIA_BUCKET:', process.env.MEDIA_BUCKET);
console.log('[ENV_DEBUG] TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? 'SET' : 'NOT_SET');
console.log('[ENV_DEBUG] TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'NOT_SET');
console.log('[ENV_DEBUG] TWILIO_WHATSAPP_FROM:', process.env.TWILIO_WHATSAPP_FROM);
console.log('[ENV_DEBUG] PHONE_NUMBER_ID:', process.env.PHONE_NUMBER_ID);
console.log('[ENV_DEBUG] WHATSAPP_TOKEN:', process.env.WHATSAPP_TOKEN ? 'SET' : 'NOT_SET');

const REGION = process.env.AWS_REGION || "us-west-2";
const HISTORY_BUCKET = process.env.HISTORY_BUCKET || "toori-chat-history";
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || "toori360";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "12", 10);
const DEBUG_S3 = process.env.DEBUG_S3 === "1";
const DEBUG_TWILIO = process.env.DEBUG_TWILIO === "1";

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

// Debug: Log the actual values after assignment
console.log('[ENV_DEBUG] After assignment:');
console.log('[ENV_DEBUG] TWILIO_ACCOUNT_SID:', TWILIO_ACCOUNT_SID ? 'SET' : 'NOT_SET');
console.log('[ENV_DEBUG] TWILIO_AUTH_TOKEN:', TWILIO_AUTH_TOKEN ? 'SET' : 'NOT_SET');
console.log('[ENV_DEBUG] TWILIO_WHATSAPP_FROM:', TWILIO_WHATSAPP_FROM);
console.log('[ENV_DEBUG] PHONE_NUMBER_ID:', PHONE_NUMBER_ID);

const s3 = new S3Client({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const transcribe = new TranscribeClient({ region: REGION });

const SYSTEM_TEXT = `Actuás como un asistente virtual joven, experto en ayudar a inquilinos con problemas en casa.
Respondés en estilo conversacional argentino, breve y directo, como en un chat real.
Usá modismos suaves y abreviaciones comunes (tipo "x", "tmb", "info", "urgente", etc).

IMPORTANTE: Revisá siempre el historial de la conversación para no repetir preguntas ya hechas o información ya dada.

📱 MENSAJES DE AUDIO: Cuando el usuario envía un mensaje de audio que fue transcrito automáticamente, el texto puede tener pequeños errores de transcripción. Interpretá el mensaje con contexto y sentido común. Si no entendés algo por errores de transcripción, pedí aclaración de forma amigable.

🚨 EMERGENCIAS DE GAS: Si detectás olor a gas o problemas con gas, respondé INMEDIATAMENTE con medidas de seguridad (ventilar, no encender luces, salir del lugar, llamar bomberos). Es PRIORIDAD ABSOLUTA.

Reglas clave:
- Respondé con calidez y cercanía, como si charlaras por WhatsApp.
- Usá oraciones cortas, divididas en párrafos naturales.
- No mandes listas, bullets ni bloques largos.
- Hacé solo una pregunta a la vez.
- Nunca le digas al cliente que se arregle solo. Nosotros nos encargamos.
- Pedí una foto del problema, siempre.
- Si el usuario ya te saludó, no vuelvas a presentarte.
- Si ya tenés algún dato (nombre, dirección, etc.), no lo vuelvas a pedir.
- Si el usuario manda mensajes vacíos pero ya hablaron de un problema antes, preguntá específicamente por ese tema.

Secuencia de información a recopilar (solo preguntá lo que falta):
1. Si es el primer mensaje: saludo buena onda + frase motivadora + presentación.
2. Nombre completo (si no lo tenés).
3. Si es el inquilino o alguien más.
4. Dirección exacta.
5. ¿Qué pasó? (detalle del problema).
6. Deducí si necesita plomero/gasista/electricista.
7. Explicá que Toori gestiona presupuestos.
8. Preguntá si es urgente.
9. Sugerí medida preventiva (si aplica).

Si el usuario manda mensajes vacíos o confusos repetidamente:
- Primera vez: preguntá qué necesita
- Segunda vez: ofrecé opciones específicas (plomería, gas, electricidad, etc.)
- Tercera vez: sugerí que llame si no puede escribir

⚠️ Solo cuando tengas TODA la información, prepará este bloque JSON (no mostrar al cliente):
[RESUMEN_JSON]
{
  "nombre": "Nombre completo",
  "direccion": "Dirección exacta",
  "tecnico": "plomero/gasista/electricista",
  "urgente": true/false,
  "problema": "Descripción breve del problema"
}
[/RESUMEN_JSON]`;

const streamToString = async (stream) => {
  const chunks = [];
  const s = stream instanceof Readable ? stream : Readable.from(stream);
  for await (const chunk of s) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
};

const dividirRespuesta = (texto) => {
  // First, split by double newlines (paragraph breaks)
  const paragraphs = texto.split(/\n\n+/);
  const messages = [];
  
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    
    // If paragraph is short enough, send as one message
    if (trimmed.length <= 300) {
      messages.push(trimmed);
    } else {
      // Split longer paragraphs by sentences, but keep them reasonable length
      const sentences = trimmed.split(/(?<=\.)\s+/);
      let currentMessage = "";
      
      for (const sentence of sentences) {
        if (currentMessage.length + sentence.length <= 300) {
          currentMessage += (currentMessage ? " " : "") + sentence;
        } else {
          if (currentMessage) messages.push(currentMessage);
          currentMessage = sentence;
        }
      }
      if (currentMessage) messages.push(currentMessage);
    }
  }
  
  return messages.length > 0 ? messages : [texto.trim()];
};

const esperar = (ms) => new Promise(res => setTimeout(res, ms));

const trimHistory = (messages) =>
  messages.filter(m => m.role === "user" || m.role === "assistant").slice(-MAX_TURNS * 2);

const loadHistory = async (userId) => {
  const key = `history/${encodeURIComponent(userId)}.json`;
  try {
    if (DEBUG_S3) console.log("[S3][GET]", HISTORY_BUCKET, key);
    const res = await s3.send(new GetObjectCommand({ Bucket: HISTORY_BUCKET, Key: key }));
    const body = await streamToString(res.Body);
    const parsed = JSON.parse(body);
    
    console.log(`[DEBUG] Historial cargado para ${userId}:`, JSON.stringify(parsed, null, 2));
    
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (DEBUG_S3) console.warn("[S3][GET] vacío o error:", e?.name, e?.message);
    return [];
  }
};

const saveHistory = async (userId, history) => {
  const key = `history/${encodeURIComponent(userId)}.json`;
  const body = JSON.stringify(history);
  
  console.log(`[DEBUG] Guardando en S3 para ${userId}:`, JSON.stringify(history, null, 2));
  
  if (DEBUG_S3) console.log("[S3][PUT]", HISTORY_BUCKET, key, "bytes:", Buffer.byteLength(body));
  await s3.send(new PutObjectCommand({
    Bucket: HISTORY_BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/json"
  }));
  if (DEBUG_S3) console.log("[S3][PUT] OK");
};

const putMedia = async (buf, contentType, userId, ext = "bin") => {
  const id = crypto.randomUUID();
  const now = new Date();
  const key = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${encodeURIComponent(userId)}/${id}.${ext}`;
  
  console.log(`[S3] Uploading media to: s3://${MEDIA_BUCKET}/${key}`);
  console.log(`[S3] Content type: ${contentType}, Size: ${buf.length} bytes`);
  
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType
  }));
  
  console.log(`[S3] Upload successful: s3://${MEDIA_BUCKET}/${key}`);
  return { bucket: MEDIA_BUCKET, key, url: `s3://${MEDIA_BUCKET}/${key}`, contentType };
};

const twilioBasicAuth = () => {
  console.log('[AUTH_DEBUG] Creating Twilio auth...');
  console.log('[AUTH_DEBUG] TWILIO_ACCOUNT_SID exists:', !!TWILIO_ACCOUNT_SID);
  console.log('[AUTH_DEBUG] TWILIO_AUTH_TOKEN exists:', !!TWILIO_AUTH_TOKEN);
  
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials not configured');
  }
  
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  console.log('[AUTH_DEBUG] Auth header created successfully');
  return auth;
};

const downloadTwilioMedia = async (mediaUrl) => {
  console.log(`[MEDIA] Downloading from: ${mediaUrl}`);
  
  try {
    const authHeader = twilioBasicAuth();
    console.log('[MEDIA] Using Twilio authentication');
    
    const r = await fetch(mediaUrl, { 
      headers: { 
        Authorization: authHeader,
        'User-Agent': 'AWS Lambda Function'
      } 
    });
    
    console.log(`[MEDIA] Response status: ${r.status}`);
    console.log(`[MEDIA] Response headers:`, Object.fromEntries(r.headers.entries()));
    
    if (!r.ok) {
      const errorText = await r.text();
      console.error(`[MEDIA] Download failed: ${r.status} ${r.statusText}`);
      console.error(`[MEDIA] Error response body:`, errorText);
      throw new Error(`Twilio media download failed: ${r.status} - ${errorText}`);
    }
    
    const ab = await r.arrayBuffer();
    console.log(`[MEDIA] Downloaded ${ab.byteLength} bytes successfully`);
    return Buffer.from(ab);
  } catch (error) {
    console.error('[MEDIA] Error downloading media:', error);
    console.error('[MEDIA] Error type:', error.name);
    console.error('[MEDIA] Error message:', error.message);
    throw error;
  }
};

const normalizePhone = (s) => (s || "").replace(/\D/g, "");

// Función para transcribir audio usando Amazon Transcribe
const transcribeAudio = async (audioS3Url, audioFormat = 'ogg') => {
  try {
    console.log(`[TRANSCRIBE] Iniciando transcripción de: ${audioS3Url}`);
    console.log(`[TRANSCRIBE] Formato de audio: ${audioFormat}`);
    
    const jobName = `transcribe-job-${crypto.randomUUID()}`;
    
    // Mejorar el mapeo de formatos de audio
    let mediaFormat = 'ogg'; // Default
    if (audioFormat) {
      const format = audioFormat.toLowerCase();
      if (['mp3', 'mpeg'].includes(format)) {
        mediaFormat = 'mp3';
      } else if (['mp4', 'm4a'].includes(format)) {
        mediaFormat = 'mp4';
      } else if (['wav'].includes(format)) {
        mediaFormat = 'wav';
      } else if (['webm'].includes(format)) {
        mediaFormat = 'webm';
      } else if (['ogg'].includes(format)) {
        mediaFormat = 'ogg';
      }
    }
    
    console.log(`[TRANSCRIBE] Formato de media para AWS: ${mediaFormat}`);
    
    // Configuración para la transcripción
    const transcriptionConfig = {
      TranscriptionJobName: jobName,
      LanguageCode: 'es-AR', // Español argentino
      MediaFormat: mediaFormat,
      Media: {
        MediaFileUri: audioS3Url
      },
      Settings: {
        ShowSpeakerLabels: false,
        MaxSpeakerLabels: 1,
        ShowAlternatives: false,
        MaxAlternatives: 1
      }
    };
    
    console.log(`[TRANSCRIBE] Configuración del trabajo:`, JSON.stringify(transcriptionConfig, null, 2));
    
    // Iniciar trabajo de transcripción
    const startJobCommand = new StartTranscriptionJobCommand(transcriptionConfig);
    const startResult = await transcribe.send(startJobCommand);
    console.log(`[TRANSCRIBE] Trabajo iniciado exitosamente: ${jobName}`);
    console.log(`[TRANSCRIBE] Estado inicial:`, startResult.TranscriptionJob?.TranscriptionJobStatus);
    
    // Esperar a que termine la transcripción
    let jobStatus = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 60; // 60 intentos = ~60 segundos máximo
    const waitTime = 1000; // 1 segundo entre intentos
    
    while (jobStatus === 'IN_PROGRESS' && attempts < maxAttempts) {
      await esperar(waitTime);
      attempts++;
      
      const getJobCommand = new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName
      });
      
      try {
        const result = await transcribe.send(getJobCommand);
        jobStatus = result.TranscriptionJob?.TranscriptionJobStatus || 'UNKNOWN';
        
        // Log cada 10 intentos para evitar spam
        if (attempts % 10 === 0 || jobStatus !== 'IN_PROGRESS') {
          console.log(`[TRANSCRIBE] Estado del trabajo (${attempts}/${maxAttempts}): ${jobStatus}`);
        }
        
        if (jobStatus === 'COMPLETED') {
          const transcriptUri = result.TranscriptionJob.Transcript?.TranscriptFileUri;
          if (!transcriptUri) {
            console.error('[TRANSCRIBE] No se encontró URI de transcripción en el resultado completado');
            return null;
          }
          
          console.log(`[TRANSCRIBE] Transcripción completada: ${transcriptUri}`);
          
          // Descargar y parsear el resultado
          try {
            const transcriptResponse = await fetch(transcriptUri);
            if (!transcriptResponse.ok) {
              console.error(`[TRANSCRIBE] Error al descargar transcripción: ${transcriptResponse.status} ${transcriptResponse.statusText}`);
              return null;
            }
            
            const transcriptData = await transcriptResponse.json();
            console.log(`[TRANSCRIBE] Datos de transcripción recibidos:`, JSON.stringify(transcriptData, null, 2));
            
            const transcribedText = transcriptData.results?.transcripts?.[0]?.transcript || '';
            
            if (transcribedText.trim()) {
              console.log(`[TRANSCRIBE] Texto transcrito exitosamente: "${transcribedText}"`);
              return transcribedText.trim();
            } else {
              console.warn('[TRANSCRIBE] La transcripción está vacía o no contiene texto');
              return null;
            }
            
          } catch (fetchError) {
            console.error('[TRANSCRIBE] Error al procesar resultado de transcripción:', fetchError);
            return null;
          }
          
        } else if (jobStatus === 'FAILED') {
          const failureReason = result.TranscriptionJob?.FailureReason || 'Razón desconocida';
          console.error(`[TRANSCRIBE] Trabajo falló: ${failureReason}`);
          console.error(`[TRANSCRIBE] Detalles completos del trabajo fallido:`, JSON.stringify(result.TranscriptionJob, null, 2));
          return null;
        }
        
      } catch (pollError) {
        console.error(`[TRANSCRIBE] Error al consultar estado del trabajo (intento ${attempts}):`, pollError);
        if (pollError.name === 'AccessDenied' || pollError.name === 'UnauthorizedOperation') {
          console.error('[TRANSCRIBE] Error de permisos, abortando transcripción');
          return null;
        }
      }
    }
    
    if (attempts >= maxAttempts) {
      console.error(`[TRANSCRIBE] Timeout esperando transcripción después de ${attempts} intentos (${attempts * waitTime / 1000} segundos)`);
      return null;
    }
    
  } catch (error) {
    console.error('[TRANSCRIBE] Error crítico en transcripción:', error);
    console.error('[TRANSCRIBE] Stack trace:', error.stack);
    return null;
  }
};

// Función para determinar si un archivo es de audio
const isAudioFile = (contentType) => {
  if (!contentType) return false;
  const audioTypes = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/aac'];
  return audioTypes.some(type => contentType.toLowerCase().includes(type.split('/')[1]));
};

export const handler = async (event) => {
  let isWhatsApp = false;
  let isTwilio = false;
  let inputText = "";
  let phone = null;
  let userId = null;
  let history = [];
  let imagenesS3 = [];
  let messageId = null;

  try {
    console.log("Processing message...");
    console.log('[ENV] Environment check:', {
      twilioAccountSid: TWILIO_ACCOUNT_SID ? 'present' : 'missing',
      twilioAuthToken: TWILIO_AUTH_TOKEN ? 'present' : 'missing',
      phoneNumberId: PHONE_NUMBER_ID ? 'present' : 'missing',
      whatsappToken: WHATSAPP_TOKEN ? 'present' : 'missing'
    });
    
    const rawBody = typeof event.body === "string"
      ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body)
      : (event.body ? JSON.stringify(event.body) : "");
    const headers = event.headers || {};
    const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

    console.log("Raw body:", rawBody);
    console.log("Headers:", headers);

    let metaMsg = null;
    if (rawBody && ct.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody);
        metaMsg = parsed?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
        messageId = metaMsg?.id || null;
      } catch {}
    }

    let twilioData = null;
    if (!metaMsg && rawBody && ct.includes("application/x-www-form-urlencoded")) {
      try {
        console.log("Procesando datos de Twilio...");
        console.log("Raw body length:", rawBody.length);
        console.log("Raw body sample:", rawBody.substring(0, 200));
        
        // Parsear los parámetros del form
        let params;
        let allKeys;
        
        // First try normal parsing
        params = new URLSearchParams(rawBody);
        allKeys = Array.from(params.keys());
        console.log("Claves encontradas:", allKeys);
        
        // If parsing failed (all data in one key), try to fix it
        if (allKeys.length === 1 && allKeys[0].length > 100 && !params.get(allKeys[0])) {
          console.log("Parsing falló, el body completo está en una clave. Intentando fix...");
          const singleKey = allKeys[0];
          
          // Try to decode if it looks like base64
          let decodedBody = singleKey;
          try {
            if (/^[A-Za-z0-9+/]+=*$/.test(singleKey)) {
              decodedBody = Buffer.from(singleKey, 'base64').toString('utf8');
              console.log("Body decodificado de base64:", decodedBody.substring(0, 300));
            }
          } catch (e) {
            console.log("No es base64 válido, intentando URL decode");
            try {
              decodedBody = decodeURIComponent(singleKey);
              console.log("Body decodificado URL:", decodedBody.substring(0, 300));
            } catch (urlError) {
              console.log("URL decode también falló, usando como está");
            }
          }
          
          // Re-parse with the potentially decoded body
          params = new URLSearchParams(decodedBody);
          allKeys = Array.from(params.keys());
          console.log("Claves después de re-parsing:", allKeys);
        }
        
        // Extract the parameters
        let from = params.get("From");
        let waid = params.get("WaId");
        let body = params.get("Body");
        let smsStatus = (params.get("SmsStatus") || "").toLowerCase();
        let messageStatus = params.get("MessageStatus");
        let numMedia = Number(params.get("NumMedia") || "0");
        let messageSid = params.get("MessageSid") || params.get("SmsSid");
        
        // URL decode the From field if it's encoded
        if (from && from.includes('%')) {
          from = decodeURIComponent(from);
        }
        
        console.log("Datos extraídos:", { 
          from, 
          waid, 
          body, 
          smsStatus, 
          messageStatus, 
          numMedia,
          messageSid
        });
        
        const isInbound = (smsStatus === "received") || !!body || numMedia > 0;
        if ((from || waid) && isInbound && !messageStatus) {
          const medias = [];
          for (let i = 0; i < numMedia; i++) {
            const mediaUrl = params.get(`MediaUrl${i}`) || (allKeys.length === 1 ? new URLSearchParams(allKeys[0]).get(`MediaUrl${i}`) : null);
            const mediaContentType = params.get(`MediaContentType${i}`) || (allKeys.length === 1 ? new URLSearchParams(allKeys[0]).get(`MediaContentType${i}`) : null);
            if (mediaUrl) {
              medias.push({
                url: mediaUrl,
                contentType: mediaContentType
              });
            }
          }
          twilioData = { From: from, WaId: waid, Body: body || "", medias, MessageSid: messageSid };
          console.log("TwilioData creado:", twilioData);
        } else {
          console.log("[Twilio] Mensaje ignorado:", { from, waid, smsStatus, messageStatus, numMedia, isInbound });
        }
      } catch (e) {
        console.error("Error parsing Twilio data:", e);
      }
    }

    if (metaMsg) {
      isWhatsApp = true;
      phone = metaMsg.from;
      userId = `wa:${normalizePhone(phone)}`;
      inputText = metaMsg?.text?.body?.trim() || "";
      
      // Load history first to check for duplicate messages
      history = await loadHistory(userId);
      
      // Check if this message was already processed (prevent duplicates)
      if (messageId) {
        const recentMessages = history.slice(-10); // Check last 10 messages
        const isDuplicate = recentMessages.some(msg => 
          msg.role === "user" && 
          msg.content?.[0]?.text === inputText &&
          msg.messageId === messageId
        );
        
        if (isDuplicate) {
          console.log(`[DEBUG] Mensaje duplicado detectado: ${messageId}`);
          return { statusCode: 200, body: JSON.stringify({ status: "DUPLICATE_IGNORED" }) };
        }
      }
      
      // For Meta WhatsApp, we would need WhatsApp API credentials
      // Since we're using Twilio, we'll skip this part
      console.log('[META] Skipping Meta WhatsApp media processing - using Twilio flow');
      
    } else if (twilioData) {
      isWhatsApp = true;
      isTwilio = true;
      // Extract phone number properly, handling URL encoding and whatsapp: prefix
      const rawFrom = twilioData.From || "";
      const rawWaId = twilioData.WaId || "";
      
      // Try WaId first (it's usually cleaner), then fall back to From
      phone = rawWaId || rawFrom.replace(/^whatsapp:/, "");
      
      // Ensure we have a valid phone number
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) {
        userId = `wa:${normalizedPhone}`;
      } else {
        console.error("No se pudo extraer número de teléfono válido:", { rawFrom, rawWaId, phone });
        userId = "anon";
      }
      inputText = (twilioData.Body || "").trim();
      messageId = twilioData.MessageSid; // Usar MessageSid como messageId único
      
      console.log("Phone:", phone, "UserId:", userId);
      
      // Load history first to check for duplicate messages
      history = await loadHistory(userId);
      
      // Check if this message was already processed using MessageSid
      if (messageId) {
        const recentMessages = history.slice(-10); // Check last 10 messages
        const isDuplicate = recentMessages.some(msg => 
          msg.role === "user" && 
          msg.messageId === messageId
        );
        
        if (isDuplicate) {
          console.log(`[DEBUG] Mensaje Twilio duplicado detectado: ${messageId}`);
          return { statusCode: 200, body: JSON.stringify({ status: "DUPLICATE_IGNORED" }) };
        }
      }
      
      if (DEBUG_TWILIO) console.log("[Twilio] From:", twilioData.From, "WaId:", twilioData.WaId, "userId:", userId, "Body:", inputText);
      try {
        for (const m of (twilioData.medias || [])) {
          if (!m.url) continue;
          
          console.log(`[MEDIA] Processing media: ${m.url}, ContentType: ${m.contentType}`);
          
          const buf = await downloadTwilioMedia(m.url);
          const mime = m.contentType || "image/jpeg";
          const ext = (mime.split("/")[1] || "jpg").split(";")[0];
          const mediaFile = await putMedia(buf, mime, userId, ext);
          imagenesS3.push(mediaFile);
          
          console.log(`[MEDIA] Media uploaded to S3: ${mediaFile.url}`);
          
          // Procesar audio para transcripción si es un archivo de audio
          if (isAudioFile(mime)) {
            console.log(`[AUDIO] Detectado archivo de audio de Twilio: ${mediaFile.url}`);
            console.log(`[AUDIO] MIME type: ${mime}, extensión: ${ext}`);
            
            try {
              console.log(`[AUDIO] Iniciando transcripción de Twilio con extensión: ${ext}`);
              const transcribedText = await transcribeAudio(mediaFile.url, ext);
              
              if (transcribedText && transcribedText.trim()) {
                inputText = transcribedText.trim();
                console.log(`[AUDIO] ✅ Transcripción exitosa de Twilio: "${inputText}"`);
              } else {
                console.warn('[AUDIO] ⚠️ Transcripción vacía de Twilio');
                inputText = "He recibido tu mensaje de audio pero no pude entender lo que dijiste. ¿Podrías escribirme o enviar el audio de nuevo?";
              }
            } catch (transcribeError) {
              console.error('[AUDIO] ❌ Error transcribiendo audio de Twilio:', transcribeError);
              inputText = "He recibido tu mensaje de audio pero hubo un problema al procesarlo. ¿Podrías escribirme o intentar de nuevo?";
            }
          }
        }
      } catch (e) { 
        console.error("Twilio media error:", e?.message || e);
        console.error("Twilio media error stack:", e?.stack);
      }
    } else {
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      inputText = typeof parsed.input === "string" ? parsed.input : parsed.input?.text;
      const baseId = parsed.userId ||
                     parsed?.requestContext?.requestId ||
                     crypto.randomUUID() ||
                     `anon-${Date.now()}`;
      userId = `web:${baseId}`;
      history = parsed.userId ? await loadHistory(userId) : [];
      
      // Handle media from WhatsAppAdapter.mjs
      if (parsed.mediaInfo?.medias && inputText === '[AUDIO_MESSAGE_TO_TRANSCRIBE]') {
        console.log('[WHATSAPP_ADAPTER] Processing audio message from WhatsAppAdapter');
        console.log(`[WHATSAPP_ADAPTER] Total medias to process: ${parsed.mediaInfo.medias.length}`);
        
        try {
          let audioProcessed = false;
          
          for (const [index, media] of parsed.mediaInfo.medias.entries()) {
            console.log(`[WHATSAPP_ADAPTER] Processing media ${index + 1}/${parsed.mediaInfo.medias.length}`);
            console.log(`[WHATSAPP_ADAPTER] Media URL: ${media.url}`);
            console.log(`[WHATSAPP_ADAPTER] Media Content-Type: ${media.contentType}`);
            
            if (media.url && media.contentType?.includes('audio')) {
              console.log(`[AUDIO] Processing audio from WhatsAppAdapter: ${media.url}`);
              console.log(`[AUDIO] Audio content type: ${media.contentType}`);
              
              try {
                // Download and save the audio file to S3
                console.log('[AUDIO] Downloading audio file...');
                const audioBuffer = await downloadTwilioMedia(media.url);
                console.log(`[AUDIO] Audio downloaded successfully, size: ${audioBuffer.length} bytes`);
                
                const audioExtension = media.contentType.split('/')[1] || 'ogg';
                console.log(`[AUDIO] Detected audio extension: ${audioExtension}`);
                
                console.log('[AUDIO] Uploading audio to S3...');
                const audioFile = await putMedia(audioBuffer, media.contentType, userId, audioExtension);
                console.log(`[AUDIO] Audio uploaded to S3: ${audioFile.url}`);
                imagenesS3.push(audioFile);
                
                // Transcribe the audio
                console.log('[AUDIO] Starting transcription process...');
                const transcribedText = await transcribeAudio(audioFile.url, audioExtension);
                
                if (transcribedText && transcribedText.trim()) {
                  inputText = transcribedText.trim();
                  console.log(`[AUDIO] ✅ Transcripción exitosa desde WhatsAppAdapter: "${inputText}"`);
                  audioProcessed = true;
                } else {
                  console.warn('[AUDIO] ⚠️ Transcripción vacía o nula desde WhatsAppAdapter');
                  inputText = "Parece que intentaste mandar un mensaje de audio, pero no me llegó la transcripción del mismo.";
                }
                
              } catch (audioError) {
                console.error('[AUDIO] ❌ Error específico procesando audio individual:', audioError);
                console.error('[AUDIO] Error stack:', audioError.stack);
                inputText = "He recibido tu mensaje de audio pero hubo un problema técnico al procesarlo. ¿Podrías intentar enviarlo de nuevo o escribirme el mensaje?";
              }
              
              break; // Process only the first audio file
            } else {
              console.log(`[WHATSAPP_ADAPTER] Media ${index + 1} is not audio, skipping`);
            }
          }
          
          if (!audioProcessed && inputText === '[AUDIO_MESSAGE_TO_TRANSCRIBE]') {
            console.warn('[WHATSAPP_ADAPTER] No se encontraron archivos de audio válidos para procesar');
            inputText = "Parece que intentaste mandar un mensaje de audio, pero no pude procesarlo. ¿Podrías intentar de nuevo?";
          }
          
        } catch (e) {
          console.error('[AUDIO] ❌ Error general processing audio from WhatsAppAdapter:', e);
          console.error('[AUDIO] Error type:', e.name);
          console.error('[AUDIO] Error message:', e.message);
          console.error('[AUDIO] Error stack:', e.stack);
          inputText = "He recibido tu mensaje de audio pero hubo un error al procesarlo. ¿Podrías escribirme o intentar de nuevo?";
        }
      }
    }

    // Handle empty messages more intelligently
    if (!inputText || inputText === 'mensaje vacío') {
      // Check if this is a repeated empty message
      const recentMessages = history.slice(-10); // Check last 10 messages for better context
      const recentEmptyMessages = recentMessages.filter(m => 
        m.role === "user" && (m.content?.[0]?.text === "mensaje vacío" || !m.content?.[0]?.text?.trim())
      );
      
      // Check for various types of context from recent conversation
      const hasGasContext = recentMessages.some(m => 
        m.role === "user" && m.content?.[0]?.text?.toLowerCase().includes('gas')
      );
      
      const hasElectricalContext = recentMessages.some(m => 
        m.role === "user" && (m.content?.[0]?.text?.toLowerCase().includes('enchufe') || 
                              m.content?.[0]?.text?.toLowerCase().includes('electricidad') ||
                              m.content?.[0]?.text?.toLowerCase().includes('heladera'))
      );
      
      const hasPlumbingContext = recentMessages.some(m => 
        m.role === "user" && (m.content?.[0]?.text?.toLowerCase().includes('agua') ||
                              m.content?.[0]?.text?.toLowerCase().includes('canilla') ||
                              m.content?.[0]?.text?.toLowerCase().includes('pérdida'))
      );
      
      // Check if user provided name and address recently
      const hasUserInfo = recentMessages.some(m => 
        m.role === "user" && (m.content?.[0]?.text?.toLowerCase().includes('rivadavia') ||
                              m.content?.[0]?.text?.toLowerCase().includes('sol') ||
                              m.content?.[0]?.text?.toLowerCase().includes('inqui'))
      );
      
      if (recentEmptyMessages.length >= 3) {
        // Too many empty messages, ask for clarification
        inputText = "necesito ayuda urgente pero no puedo escribir bien, ayúdame";
      } else if (recentEmptyMessages.length >= 2 && hasGasContext) {
        // Multiple empty messages but we know it's about gas - might be an emergency
        inputText = "sigo teniendo el problema de gas que mencioné antes";
      } else if (recentEmptyMessages.length >= 2 && hasElectricalContext) {
        // Multiple empty messages with electrical context
        inputText = "sigo con el problema del enchufe de la heladera que te comenté";
      } else if (recentEmptyMessages.length >= 2 && hasPlumbingContext) {
        // Multiple empty messages with plumbing context
        inputText = "sigo con el problema de agua que te mencioné";
      } else if (recentEmptyMessages.length >= 2 && hasUserInfo) {
        // User has context but multiple empty messages
        inputText = "necesito ayuda con el problema que te estaba contando";
      } else if (recentEmptyMessages.length >= 2) {
        // User sent multiple empty messages, ask for clarification
        inputText = "necesito ayuda pero no sé cómo explicar mi problema";
      } else if (imagenesS3.length === 0 && history.length === 0) {
        // First message and it's empty - treat as greeting
        inputText = "hola";
      } else if (imagenesS3.length === 0) {
        inputText = "mensaje vacío";
      }
      
      console.log(`[DEBUG] Mensaje vacío procesado para userId: ${userId}, recientes: ${recentEmptyMessages.length}, contextos: gas=${hasGasContext}, electrical=${hasElectricalContext}, plumbing=${hasPlumbingContext}, userInfo=${hasUserInfo}`);
    }

    console.log(`[DEBUG] InputText: "${inputText}", UserId: ${userId}, HistoryLength: ${history.length}`);
    
    // Debug: mostrar estructura del historial
    if (history.length > 0) {
      console.log(`[DEBUG] Último mensaje del historial:`, JSON.stringify(history[history.length - 1], null, 2));
      console.log(`[DEBUG] Historial completo:`, JSON.stringify(history, null, 2));
    }

    const baseHistory = Array.isArray(history) ? history : [];
    const safeHistory = trimHistory(baseHistory);
    
    // Create user message with messageId if available
    const userMessage = inputText ? {
      role: "user", 
      content: [{ type: "text", text: inputText }],
      ...(messageId && { messageId })
    } : null;
    
    const updatedMessages = [
      ...safeHistory,
      ...(userMessage ? [userMessage] : [])
    ];

    const command = new InvokeModelCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        system: SYSTEM_TEXT,
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
        messages: updatedMessages
      })
    });

    const bedrockRes = await bedrock.send(command);
    const raw = await bedrockRes.body.transformToString();
    const modelOut = JSON.parse(raw);
    const salidaIA = (modelOut.content || []).map(c => c.text).join(" ").trim();

    let resumen = null;
    const match = salidaIA.match(/\[RESUMEN_JSON\]([\s\S]*?)\[\/RESUMEN_JSON\]/);
    if (match) {
      try {
        resumen = JSON.parse(match[1].trim());
        if (imagenesS3.length) resumen.imagenes = imagenesS3;
      } catch (e) { console.warn("Resumen JSON mal formado:", e?.message); }
    }

    const salidaSinJson = salidaIA.replace(/\[RESUMEN_JSON\][\s\S]*?\[\/RESUMEN_JSON\]/g, "").trim();
    const mensajes = dividirRespuesta(salidaSinJson);

    console.log(`[DEBUG] Mensajes a enviar (${mensajes.length}):`, mensajes);

    if (resumen) {
      if (resumen?.detalle && !resumen.problema) { resumen.problema = resumen.detalle; delete resumen.detalle; }
      const ok = !!resumen?.nombre && !!resumen?.direccion && !!resumen?.problema &&
                 typeof resumen?.urgente === "boolean" && !!resumen?.tecnico;
      if (ok) {
        try {
          const resp = await fetch("https://lxyzkamgvk.execute-api.us-west-2.amazonaws.com/default/proxy-registrar-pedido", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(resumen)
          });
          if (!resp.ok) console.error("Backend error:", resp.status, await resp.text());
        } catch (e) { console.error("Backend fetch error:", e?.message || e); }
      }
    }

    let newHistory = [...updatedMessages];
    const assistantMessage = { role: "assistant", content: [{ type: "text", text: salidaSinJson }] };
    newHistory.push(assistantMessage);
    
    console.log(`[DEBUG] Guardando historial para ${userId}:`);
    console.log(`[DEBUG] Nuevo mensaje asistente:`, JSON.stringify(assistantMessage, null, 2));
    console.log(`[DEBUG] Historial completo a guardar:`, JSON.stringify(newHistory, null, 2));
    
    try { await saveHistory(userId, newHistory); } catch (e) { console.error("S3 save err:", e?.message || e); }

    if (isWhatsApp) {
      if (isTwilio) {
        console.log('[TWILIO] Sending messages via Twilio...');
        try {
          const basic = twilioBasicAuth();
          console.log('[TWILIO] Auth header created successfully');
          
          for (const fragmento of mensajes) {
            console.log(`[TWILIO] Sending message: "${fragmento}"`);
            const form = new URLSearchParams();
            form.set("To", `whatsapp:${phone}`);
            form.set("From", TWILIO_WHATSAPP_FROM);
            form.set("Body", fragmento);
            
            const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
              method: "POST",
              headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
              body: form
            });
            
            if (!resp.ok) {
              const errorText = await resp.text();
              console.error("Twilio send fail:", resp.status, errorText);
            } else {
              console.log(`[TWILIO] Message sent successfully`);
            }
            await esperar(800);
          }
        } catch (twilioSendError) {
          console.error('[TWILIO] Error sending messages:', twilioSendError);
        }
      } else {
        // This shouldn't happen since we're using Twilio, but keeping as fallback
        console.log('[META] Would send via WhatsApp API, but not configured');
      }
      return { statusCode: 200, body: JSON.stringify({ status: "OK" }) };
    }

    const assistantReply = mensajes.map(text => ({ type: "text", text }));
    
    console.log("Respuesta backend:", JSON.stringify({ reply: assistantReply, history: newHistory }, null, 2));
    
    return { statusCode: 200, body: JSON.stringify({ reply: assistantReply, history: newHistory }) };

  } catch (err) {
    console.error("🔥 Error general:", err);
    console.error("🔥 Error stack:", err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || "Error", stack: err?.stack }) };
  }
};