// index.mjs
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import crypto from "crypto";

// ===== Config =====
const REGION = process.env.AWS_REGION || "us-west-2";
const HISTORY_BUCKET = process.env.HISTORY_BUCKET || "toori-chat-history";
const MEDIA_BUCKET   = process.env.MEDIA_BUCKET   || "toori360";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "12", 10);
const DEBUG_S3 = process.env.DEBUG_S3 === "1";
const DEBUG_TWILIO = process.env.DEBUG_TWILIO === "1";

// Meta (WhatsApp Cloud API)
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Twilio
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // ej: whatsapp:+14155238886

// ===== AWS clients =====
const s3 = new S3Client({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });

// ===== Utils =====
const streamToString = async (stream) => {
  const chunks = [];
  const s = stream instanceof Readable ? stream : Readable.from(stream);
  for await (const chunk of s) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
};

const dividirRespuesta = (texto) =>
  texto.split(/\n+|(?<=\.)\s+/).map(p => p.trim()).filter(p => p.length > 0);

const esperar = (ms) => new Promise(res => setTimeout(res, ms));

const trimHistory = (messages) => {
  const system = messages.filter(m => m.role !== "user" && m.role !== "assistant");
  const convo  = messages.filter(m => m.role === "user" || m.role === "assistant");
  return [...system, ...convo.slice(-MAX_TURNS * 2)];
};

// ===== S3: historial =====
const loadHistory = async (userId) => {
  const key = `history/${encodeURIComponent(userId)}.json`;
  try {
    if (DEBUG_S3) console.log("[S3][GET]", HISTORY_BUCKET, key);
    const res = await s3.send(new GetObjectCommand({ Bucket: HISTORY_BUCKET, Key: key }));
    const body = await streamToString(res.Body);
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (DEBUG_S3) console.warn("[S3][GET] vacío o error:", e?.name, e?.message);
    return [];
  }
};

const saveHistory = async (userId, history) => {
  const key = `history/${encodeURIComponent(userId)}.json`;
  const body = JSON.stringify(history);
  if (DEBUG_S3) console.log("[S3][PUT]", HISTORY_BUCKET, key, "bytes:", Buffer.byteLength(body));
  await s3.send(new PutObjectCommand({
    Bucket: HISTORY_BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/json"
  }));
  if (DEBUG_S3) console.log("[S3][PUT] OK");
};

// ===== S3: media =====
const putMedia = async (buf, contentType, userId, ext = "bin") => {
  const id  = crypto.randomUUID();
  const now = new Date();
  const key = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,"0")}/${encodeURIComponent(userId)}/${id}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType
  }));
  return { bucket: MEDIA_BUCKET, key, url: `s3://${MEDIA_BUCKET}/${key}`, contentType };
};

// ===== Meta helpers =====
const waFetchJSON = async (url) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!r.ok) throw new Error(`WA fetch ${url} ${r.status}`);
  return r.json();
};
const waFetchBuffer = async (url) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!r.ok) throw new Error(`WA media ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
};
const saveWhatsAppMediaIfAny = async (msg, userId) => {
  const refs = [];
  if (msg?.image?.id) {
    const meta = await waFetchJSON(`https://graph.facebook.com/v18.0/${msg.image.id}`);
    const buf = await waFetchBuffer(meta.url);
    const mime = msg.image?.mime_type || "image/jpeg";
    const ext = mime.split("/")[1] || "jpg";
    refs.push(await putMedia(buf, mime, userId, ext));
  }
  if (msg?.audio?.id) {
    const meta = await waFetchJSON(`https://graph.facebook.com/v18.0/${msg.audio.id}`);
    const buf = await waFetchBuffer(meta.url);
    const mime = msg.audio?.mime_type || "audio/ogg";
    const ext = mime.split("/")[1] || "ogg";
    refs.push(await putMedia(buf, mime, userId, ext));
  }
  return refs;
};

// ===== Twilio helpers =====
const twilioBasicAuth = () =>
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

const downloadTwilioMedia = async (mediaUrl) => {
  const r = await fetch(mediaUrl, { headers: { Authorization: twilioBasicAuth() } });
  if (!r.ok) throw new Error(`Twilio media ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
};

// ===== Handler =====
export const handler = async (event) => {
  let isWhatsApp = false;
  let isTwilio = false;
  let inputText = "";
  let phone = null;
  let userId = null;
  let history = [];
  let imagenesS3 = [];

  try {
    // --- normalizar body (soporta base64) ---
    const rawBody = typeof event.body === "string"
      ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body)
      : (event.body ? JSON.stringify(event.body) : "");
    const headers = event.headers || {};
    const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

    // --- detectar Meta (JSON) ---
    let metaMsg = null;
    if (rawBody && ct.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody);
        metaMsg = parsed?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
      } catch {}
    }

    // --- detectar Twilio (x-www-form-urlencoded) ---
    let twilioData = null;
    if (!metaMsg && rawBody) {
      try {
        const params = new URLSearchParams(rawBody);
        const from = params.get("From");
        const waid = params.get("WaId");
        const body = params.get("Body");
        const smsStatus = (params.get("SmsStatus") || "").toLowerCase(); // 'received' para inbound
        const messageStatus = params.get("MessageStatus");               // delivered/read (status callback)
        const numMedia = Number(params.get("NumMedia") || "0");

        // procesar sólo inbound
        const isInbound = (smsStatus === "received") || !!body || numMedia > 0;
        if ((from || waid) && isInbound && !messageStatus) {
          const medias = [];
          for (let i = 0; i < numMedia; i++) {
            medias.push({
              url: params.get(`MediaUrl${i}`),
              contentType: params.get(`MediaContentType${i}`)
            });
          }
          twilioData = { From: from, WaId: waid, Body: body || "", medias };
        } else {
          if (DEBUG_TWILIO) console.log("[Twilio] Ignorado (no inbound):", { from, waid, smsStatus, messageStatus, numMedia });
        }
      } catch {}
    }

    // --- normalización de entrada ---
    if (metaMsg) {
      // Meta Cloud
      isWhatsApp = true;
      phone = metaMsg.from;
      userId = `wa-meta:${phone}`;
      inputText = metaMsg?.text?.body?.trim() || "";
      try { imagenesS3 = await saveWhatsAppMediaIfAny(metaMsg, userId); } catch (e) { console.warn("Meta media:", e?.message); }
      history = await loadHistory(userId);

    } else if (twilioData) {
      // Twilio
      isWhatsApp = true;
      isTwilio = true;
      phone = (twilioData.From || "").replace(/^whatsapp:/, "");
      const waid = (twilioData.WaId && /^\d+$/.test(twilioData.WaId))
        ? twilioData.WaId
        : phone.replace(/\D/g, "");
      userId = `wa-twilio:${waid}`;
      inputText = (twilioData.Body || "").trim();

      if (DEBUG_TWILIO) console.log("[Twilio] From:", twilioData.From, "WaId:", twilioData.WaId, "userId:", userId, "Body:", inputText);

      // media N
      try {
        for (const m of (twilioData.medias || [])) {
          if (!m.url) continue;
          const buf = await downloadTwilioMedia(m.url);
          const mime = m.contentType || "image/jpeg";
          const ext = (mime.split("/")[1] || "jpg").split(";")[0];
          imagenesS3.push(await putMedia(buf, mime, userId, ext));
        }
      } catch (e) { console.warn("Twilio media:", e?.message || e); }

      history = await loadHistory(userId);

    } else {
      // Web/API genérico
      const parsed = rawBody ? JSON.parse(rawBody) : {};
      inputText = typeof parsed.input === "string" ? parsed.input : parsed.input?.text;
      
      // Detectar si es una nueva sesión o continuación
      const isNewSession = !parsed.sessionId; // Si no hay sessionId, es una nueva sesión (recarga)
      
      if (isNewSession) {
        // Nueva sesión (recarga de página) - crear nuevo ID único
        const newSessionId = `session-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
        userId = `web:${newSessionId}`;
        history = []; // Iniciar con historial vacío
        console.log(`[DEBUG] NEW SESSION - SessionId: ${newSessionId}, Starting fresh conversation`);
      } else {
        // Continuación de sesión existente - mantener contexto
        userId = `web:${parsed.sessionId}`;
        history = await loadHistory(userId);
        console.log(`[DEBUG] CONTINUING SESSION - SessionId: ${parsed.sessionId}, History loaded: ${history.length} messages`);
      }
    }

    // si no hay texto ni media -> registrar como mensaje vacío pero continuar conversación
    if (!inputText && imagenesS3.length === 0) {
      inputText = "mensaje vacío"; // registrar en historial para debug
      console.log(`[DEBUG] Mensaje vacío detectado para userId: ${userId}`);
    }
    
    console.log(`[DEBUG] InputText: "${inputText}", UserId: ${userId}, HistoryLength: ${history.length}`);

    // ===== Análisis del estado de la conversación =====
    const analyzeConversationState = (history) => {
      // Si no hay historial, es una conversación nueva
      if (!history || history.length === 0) {
        return {
          hasName: false,
          hasAddress: false,
          hasProblem: false,
          hasUrgency: false,
          isGreeted: false,
          isNewConversation: true
        };
      }
      
      const userMessages = history.filter(msg => msg.role === "user").map(msg => 
        msg.content?.[0]?.text || ""
      ).join(" ").toLowerCase();
      
      const assistantMessages = history.filter(msg => msg.role === "assistant").map(msg => 
        msg.content?.[0]?.text || ""
      ).join(" ").toLowerCase();
      
      return {
        hasName: /soy\s+\w+|me llamo|mi nombre es|\b\w+\s+(garcia|martinez|lopez|fernandez|rodriguez|gonzalez|perez|sanchez)\b/.test(userMessages) || /tu nombre|cómo te llam|apellido/.test(assistantMessages),
        hasAddress: /dirección|domicilio|vivo en|casa|calle|avenida|av\s/.test(userMessages) || /dirección|domicilio/.test(assistantMessages),
        hasProblem: /problema|roto|no funciona|se rompió|canilla|inodoro|luz|gas/.test(userMessages) || /qué pasó|problema/.test(assistantMessages),
        hasUrgency: /urgente|ya|ahora|rápido/.test(userMessages) || /urgente/.test(assistantMessages),
        isGreeted: assistantMessages.includes("hola") || assistantMessages.includes("buenas") || assistantMessages.includes("toori"),
        isNewConversation: false
      };
    };
    
    const conversationState = analyzeConversationState(history);
    console.log(`[DEBUG] Conversation state:`, conversationState);

    // ===== Prompt del sistema dinámico =====
    const buildSystemPrompt = (state) => {
      let contextualInstructions = "";
      
      if (state.isNewConversation) {
        contextualInstructions = `
NUEVA CONVERSACIÓN: Esta es una conversación completamente nueva.
- Empezá con el saludo inicial completo
- No asumas información previa
- Seguí la secuencia desde el paso 1`;
      } else if (state.hasName && state.hasAddress && state.hasProblem) {
        contextualInstructions = `
IMPORTANTE: El usuario ya proporcionó información básica. NO vuelvas a preguntar por:
- Su nombre (ya lo tiene)
- Su dirección (ya la tiene) 
- El problema básico (ya lo describió)

Continuá con los siguientes pasos según corresponda:
- Si falta: tipo de técnico necesario
- Si falta: urgencia del problema
- Si falta: foto del problema
- Finalizá con el resumen JSON cuando tengas todo.`;
      } else if (state.isGreeted) {
        contextualInstructions = `
IMPORTANTE: Ya saludaste al usuario. NO repitas el saludo inicial.
Continuá con el siguiente paso de información que falte según la secuencia.`;
      }

      return {
        role: "user",
        content: [{
          type: "text",
          text: `Actuás como un asistente virtual joven, experto en ayudar a inquilinos con problemas en casa. 
Respondés en estilo conversacional argentino, breve y directo, como en un chat real. 
Usá modismos suaves y abreviaciones comunes (tipo "x", "tmb", "info", "urgente", etc).

Reglas clave:
- Respondé con calidez y cercanía, como si charlaras por WhatsApp.
- Usá oraciones cortas, divididas en mensajes como en una conversación real.
- No mandes listas, bullets ni bloques largos.
- Hacé solo una pregunta a la vez.
- Nunca le digas al cliente que se arregle solo. Nosotros nos encargamos.
- Pedí una foto del problema, siempre.
- MANTENÉ EL CONTEXTO: recordá lo que ya te dijeron.

${contextualInstructions}

Secuencia obligatoria (solo avanzá al siguiente paso si no tenés la info):
1. Arrancá con saludo buena onda + frase motivadora.
2. Pedí nombre completo.
3. Preguntá si es el inquilino o alguien más.
4. Dirección exacta.
5. ¿Qué pasó? (detalle del problema).
6. Deducí si necesita plomero/gasista/electricista.
7. Explicá que Toori gestiona presupuestos.
8. Preguntá si es urgente.
9. Sugerí medida preventiva (si aplica).

⚠️ Al final, prepará este bloque JSON (no mostrar al cliente):

[RESUMEN_JSON]
{
  "nombre": "Nombre completo",
  "direccion": "Dirección exacta",
  "tecnico": "plomero/gasista/electricista",
  "urgente": true/false,
  "problema": "Descripción breve del problema"
}
[/RESUMEN_JSON]`
        }]
      };
    };

    const systemPrompt = buildSystemPrompt(conversationState);

    const baseHistory = Array.isArray(history) ? history : [];
    
    // Verificar si ya existe el prompt del sistema en el historial
    const hasSystemPrompt = baseHistory.some(msg => 
      msg.role === "user" && 
      msg.content?.[0]?.text?.includes("Actuás como un asistente virtual joven")
    );
    
    // Solo agregar prompt del sistema si no existe o si es una nueva conversación
    const fullHistory = hasSystemPrompt ? baseHistory : [systemPrompt, ...baseHistory];
    const safeHistory = trimHistory(fullHistory);
    
    console.log(`[DEBUG] System prompt injection - Has system prompt: ${hasSystemPrompt}, Full history length: ${fullHistory.length}`);

    const updatedMessages = [
      ...safeHistory,
      ...(inputText ? [{ role: "user", content: [{ type: "text", text: inputText }] }] : [])
    ];

    // ===== Bedrock (Claude 3.5 Sonnet v2) =====
    const command = new InvokeModelCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
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

    // ===== Extraer RESUMEN_JSON =====
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

    // ===== Enviar resumen si está completo =====
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

    // ===== Persistir historial =====
    // Guardar cada mensaje del asistente por separado para mantener el flujo conversacional
    let newHistory = [...updatedMessages];
    for (const mensaje of mensajes) {
      newHistory.push({ role: "assistant", content: [{ type: "text", text: mensaje }] });
    }
    try { await saveHistory(userId, newHistory); } catch (e) { console.error("S3 save err:", e?.message || e); }

    // ===== Responder por WhatsApp =====
    if (isWhatsApp) {
      if (isTwilio) {
        const basic = twilioBasicAuth();
        for (const fragmento of mensajes) {
          const form = new URLSearchParams();
          form.set("To", `whatsapp:${phone}`);
          form.set("From", TWILIO_WHATSAPP_FROM);
          form.set("Body", fragmento);
          const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
            method: "POST",
            headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
            body: form
          });
          if (!resp.ok) console.error("Twilio send fail:", resp.status, await resp.text());
          await esperar(650);
        }
      } else {
        for (const fragmento of mensajes) {
          await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: fragmento } })
          });
          await esperar(650);
        }
      }
      return { statusCode: 200, body: JSON.stringify({ status: "OK" }) };
    }

    // Web/API
    const assistantReply = mensajes.map(text => ({ type: "text", text }));
    return { 
      statusCode: 200, 
      body: JSON.stringify({ 
        reply: assistantReply, 
        history: newHistory,
        sessionId: userId.replace('web:', ''), // Devolver sessionId para que el cliente lo use en próximas llamadas
        contextMaintained: history.length > 0 // Indicar si se mantuvo contexto
      }) 
    };

  } catch (err) {
    console.error("🔥 Error general:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || "Error", stack: err?.stack }) };
  }
};
