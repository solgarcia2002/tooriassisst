import querystring from 'querystring';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import crypto from "crypto";

// Normalize phone number to match index.mjs format
const normalizePhone = (s) => (s || "").replace(/\D/g, "");

// Get environment variables
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const REGION = process.env.AWS_REGION || "us-west-2";
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || "toori360";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// Initialize AWS clients
const s3 = new S3Client({ region: REGION });
const transcribe = new TranscribeClient({ region: REGION });

const memory = {}; // Historial temporal por usuario

// Twilio authentication
const twilioBasicAuth = () =>
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

// Download media from Twilio
const downloadTwilioMedia = async (mediaUrl) => {
  console.log(`[AUDIO] Descargando audio desde Twilio: ${mediaUrl}`);
  const response = await fetch(mediaUrl, { 
    headers: { Authorization: twilioBasicAuth() } 
  });
  if (!response.ok) {
    throw new Error(`Error descargando audio de Twilio: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

// Upload media to S3
const putMediaToS3 = async (buffer, contentType, userId, extension) => {
  const fileName = `media/${userId}/${crypto.randomUUID()}.${extension}`;
  const key = fileName;
  
  console.log(`[AUDIO] Subiendo audio a S3: ${key}`);
  
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: { userId }
  }));
  
  const url = `https://${MEDIA_BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  console.log(`[AUDIO] Audio subido a S3: ${url}`);
  
  return {
    url,
    key,
    contentType,
    size: buffer.length
  };
};

// Transcribe audio using Amazon Transcribe
const transcribeAudio = async (audioS3Url, audioFormat = 'ogg') => {
  try {
    console.log(`[TRANSCRIBE] Iniciando transcripción de: ${audioS3Url}`);
    
    const jobName = `transcribe-job-${crypto.randomUUID()}`;
    const mediaFormat = audioFormat === 'ogg' ? 'ogg' : audioFormat.toLowerCase();
    
    // Start transcription job
    const startJobCommand = new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'es-ES', // Spanish for Argentina
      MediaFormat: mediaFormat,
      Media: {
        MediaFileUri: audioS3Url
      },
      Settings: {
        ShowSpeakerLabels: false,
        MaxSpeakerLabels: 1
      }
    });
    
    await transcribe.send(startJobCommand);
    console.log(`[TRANSCRIBE] Trabajo iniciado: ${jobName}`);
    
    // Wait for transcription to complete
    let jobStatus = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts * 2 seconds = 60 seconds max
    
    while (jobStatus === 'IN_PROGRESS' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      attempts++;
      
      const getJobCommand = new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName
      });
      
      const result = await transcribe.send(getJobCommand);
      jobStatus = result.TranscriptionJob.TranscriptionJobStatus;
      
      console.log(`[TRANSCRIBE] Estado del trabajo (${attempts}/${maxAttempts}): ${jobStatus}`);
      
      if (jobStatus === 'COMPLETED') {
        const transcriptUri = result.TranscriptionJob.Transcript.TranscriptFileUri;
        console.log(`[TRANSCRIBE] Descargando transcript desde: ${transcriptUri}`);
        
        const transcriptResponse = await fetch(transcriptUri);
        const transcriptData = await transcriptResponse.json();
        
        const transcribedText = transcriptData.results.transcripts[0]?.transcript || '';
        console.log(`[TRANSCRIBE] Texto transcrito: "${transcribedText}"`);
        
        return transcribedText;
      } else if (jobStatus === 'FAILED') {
        console.error(`[TRANSCRIBE] Trabajo falló: ${result.TranscriptionJob.FailureReason}`);
        return null;
      }
    }
    
    if (jobStatus === 'IN_PROGRESS') {
      console.error('[TRANSCRIBE] Timeout: El trabajo de transcripción tomó demasiado tiempo');
      return null;
    }
    
  } catch (error) {
    console.error('[TRANSCRIBE] Error en transcripción:', error);
    return null;
  }
};

// Check if content type is audio
const isAudioFile = (contentType) => {
  if (!contentType) return false;
  const audioTypes = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/aac'];
  return audioTypes.some(type => contentType.toLowerCase().includes(type.split('/')[1]));
};

// Enhanced logging for debugging conversation threads
const logConversationState = (userId, action, details = {}) => {
  console.log(`[CONVERSATION_THREAD] ${action} - UserId: ${userId}`, details);
};

// Backup conversation state to prevent loss
const backupConversation = (userId, history) => {
  try {
    // Create a more persistent backup key
    const backupKey = `backup_${userId}_${Date.now()}`;
    memory[backupKey] = {
      userId,
      history: JSON.parse(JSON.stringify(history)), // Deep copy
      timestamp: new Date().toISOString(),
      lastMessageId: history[history.length - 1]?.messageId
    };
    
    // Keep only last 3 backups per user to prevent memory overflow
    const userBackups = Object.keys(memory)
      .filter(key => key.startsWith(`backup_${userId}_`))
      .sort()
      .reverse();
      
    userBackups.slice(3).forEach(oldBackup => {
      delete memory[oldBackup];
    });
    
    logConversationState(userId, 'CONVERSATION_BACKED_UP', { backupKey, historyLength: history.length });
  } catch (error) {
    console.error('Error backing up conversation:', error);
  }
};

// Restore conversation from backup if main history is lost
const restoreConversation = (userId) => {
  try {
    const userBackups = Object.keys(memory)
      .filter(key => key.startsWith(`backup_${userId}_`))
      .sort()
      .reverse();
      
    if (userBackups.length > 0) {
      const latestBackup = memory[userBackups[0]];
      logConversationState(userId, 'CONVERSATION_RESTORED', { 
        backupKey: userBackups[0], 
        historyLength: latestBackup.history.length 
      });
      return latestBackup.history;
    }
  } catch (error) {
    console.error('Error restoring conversation:', error);
  }
  return [];
};

export const handler = async (event) => {
  console.log('Raw body:', event.body);
  console.log('Headers:', event.headers);

  let form;
  let messageId = null;

  try {
    if (event.headers['content-type']?.includes('application/json')) {
      form = JSON.parse(event.body);
      // Extract message ID from WhatsApp webhook format
      const metaMsg = form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      messageId = metaMsg?.id || null;
    } else {
      // Handle Twilio form data which might be Base64 encoded
      let bodyToParse = event.body;
      
      // First try to parse normally
      let parsed = querystring.parse(bodyToParse);
      let allKeys = Object.keys(parsed);
      
      console.log('Initial parsing - Keys found:', allKeys.length);
      console.log('First key sample:', allKeys[0]?.substring(0, 100));
      
      // If we have only one key and it looks like Base64 encoded data
      // Check for single key that's long and either has no value or just '='
      if (allKeys.length === 1 && allKeys[0].length > 100 && 
          (!parsed[allKeys[0]] || parsed[allKeys[0]] === '' || parsed[allKeys[0]] === '=')) {
        const singleKey = allKeys[0];
        console.log('Detected potential Base64 encoded form data');
        
        try {
          // Try to decode as Base64
          if (/^[A-Za-z0-9+/]+=*$/.test(singleKey)) {
            const decodedBody = Buffer.from(singleKey, 'base64').toString('utf8');
            console.log('Successfully decoded Base64 body:', decodedBody.substring(0, 200));
            bodyToParse = decodedBody;
            parsed = querystring.parse(bodyToParse);
            allKeys = Object.keys(parsed);
            console.log('After Base64 decoding - Keys found:', allKeys.length);
          }
        } catch (decodeError) {
          console.log('Base64 decode failed, trying URL decode:', decodeError.message);
          // Try URL decoding instead
          try {
            const urlDecoded = decodeURIComponent(singleKey);
            parsed = querystring.parse(urlDecoded);
            allKeys = Object.keys(parsed);
            console.log('After URL decoding - Keys found:', allKeys.length);
          } catch (urlError) {
            console.log('URL decode also failed:', urlError.message);
          }
        }
      }
      
      // If still having issues with nested encoding or Base64 wasn't detected properly
      if (allKeys.length === 1 && 
          (Object.values(parsed)[0] === '' || Object.values(parsed)[0] === '=') && 
          allKeys[0].includes('=')) {
        console.log('Detected nested form encoding, attempting to parse the key itself');
        const onlyKey = allKeys[0];
        try {
          // First try to decode as Base64 if it looks like it
          if (/^[A-Za-z0-9+/]+=*$/.test(onlyKey) && onlyKey.length > 100) {
            console.log('Attempting Base64 decode in fallback');
            const decodedBody = Buffer.from(onlyKey, 'base64').toString('utf8');
            console.log('Fallback Base64 decoded content:', decodedBody.substring(0, 200));
            form = querystring.parse(decodedBody);
            console.log('Fallback Base64 decode successful, keys:', Object.keys(form).length);
          } else {
            // Try URL decoding
            const urlDecoded = decodeURIComponent(onlyKey);
            form = querystring.parse(urlDecoded);
            console.log('URL decode successful, keys:', Object.keys(form).length);
          }
        } catch (fallbackError) {
          console.log('Fallback parsing failed:', fallbackError.message);
          // If all parsing fails, try to extract from the original body directly
          try {
            console.log('Attempting direct body parsing as last resort');
            form = querystring.parse(event.body);
            console.log('Direct body parsing result, keys:', Object.keys(form).length);
          } catch (directError) {
            console.log('Direct body parsing also failed:', directError.message);
            form = parsed;
          }
        }
      } else {
        form = parsed;
      }
      
      // For Twilio format, try to get message SID as ID
      messageId = form?.MessageSid || form?.SmsSid || null;
    }
  } catch (e) {
    console.error('Error al parsear el body:', e);
    form = {};
    
    // Try one last attempt to extract basic info from raw body if everything else failed
    if (event.body) {
      console.log('Attempting emergency parsing from raw body...');
      try {
        // Try to extract basic Twilio fields with regex as last resort
        const bodyMatch = event.body.match(/Body=([^&]+)/);
        const fromMatch = event.body.match(/From=([^&]+)/);
        const waidMatch = event.body.match(/WaId=([^&]+)/);
        
        if (bodyMatch || fromMatch || waidMatch) {
          form = {};
          if (bodyMatch) {
            form.Body = decodeURIComponent(bodyMatch[1].replace(/\+/g, ' '));
          }
          if (fromMatch) {
            form.From = decodeURIComponent(fromMatch[1]);
          }
          if (waidMatch) {
            form.WaId = decodeURIComponent(waidMatch[1]);
          }
          console.log('Emergency parsing successful:', Object.keys(form));
        }
      } catch (emergencyError) {
        console.log('Emergency parsing also failed:', emergencyError.message);
      }
    }
  }

  console.log('Form parseado OK:', form, 'MessageId:', messageId);

  // Extract userId first for S3 storage
  let phone = null;
  let userId = null;
  let phoneNumberId = PHONE_NUMBER_ID;
  
  if (form?.From) {
    // Handle both WhatsApp Meta format and Twilio format
    phone = form.From.replace(/^whatsapp:/, ""); // Remove whatsapp: prefix if present
    const waid = form?.WaId || phone;
    
    // More robust user ID creation to maintain consistency
    const normalizedPhone = normalizePhone(waid);
    userId = `wa:${normalizedPhone}`;
    
    // Log phone number extraction for debugging
    logConversationState(userId, 'PHONE_EXTRACTED', { 
      originalFrom: form.From, 
      phone, 
      waid, 
      normalizedPhone,
      phoneNumberId 
    });
  } else if (form?.WaId) {
    // Try to extract from WaId directly if From is missing
    const waid = form.WaId;
    const normalizedPhone = normalizePhone(waid);
    userId = `wa:${normalizedPhone}`;
    phone = `+${normalizedPhone}`;
    
    console.log('Phone extracted from WaId field:', { waid, normalizedPhone, userId });
    logConversationState(userId, 'PHONE_EXTRACTED', { 
      originalFrom: null, 
      phone, 
      waid, 
      normalizedPhone,
      phoneNumberId 
    });
  } else if (Object.keys(form).length === 1) {
    // Try to extract phone from malformed form key
    const singleKey = Object.keys(form)[0];
    const fromMatch = singleKey.match(/From=whatsapp%3A%2B(\d+)/);
    const waidMatch = singleKey.match(/WaId=(\d+)/);
    
    if (fromMatch) {
      const normalizedPhone = normalizePhone(fromMatch[1]);
      userId = `wa:${normalizedPhone}`;
      phone = `+${normalizedPhone}`;
      console.log('Phone extracted from malformed From field:', { normalizedPhone, userId });
    } else if (waidMatch) {
      const normalizedPhone = normalizePhone(waidMatch[1]);
      userId = `wa:${normalizedPhone}`;
      phone = `+${normalizedPhone}`;
      console.log('Phone extracted from malformed WaId field:', { normalizedPhone, userId });
    }
  }

  console.log('Phone:', phone, 'UserId:', userId, 'PhoneNumberId:', phoneNumberId);

  // Extract message text and media from different formats
  let mensajeUsuario = 'mensaje vacío';
  let mediaInfo = null;
  
  // Check for media first (Twilio format)
  const numMedia = parseInt(form?.NumMedia || '0');
  const messageType = form?.MessageType;
  
  if (numMedia > 0 || messageType === 'audio') {
    console.log('Detected media message - NumMedia:', numMedia, 'MessageType:', messageType);
    
    // Extract media information
    const medias = [];
    for (let i = 0; i < Math.max(numMedia, 1); i++) {
      const mediaUrl = form[`MediaUrl${i}`];
      const mediaContentType = form[`MediaContentType${i}`];
      if (mediaUrl) {
        medias.push({
          url: mediaUrl,
          contentType: mediaContentType
        });
        console.log(`Media ${i} found:`, { url: mediaUrl, contentType: mediaContentType });
      }
    }
    
    if (medias.length > 0) {
      mediaInfo = { medias };
      
      // Process audio immediately if detected
      if (messageType === 'audio' || medias.some(m => m.contentType?.includes('audio'))) {
        console.log('Audio message detected, processing transcription...');
        
        try {
          // Find the audio media
          const audioMedia = medias.find(m => isAudioFile(m.contentType));
          if (audioMedia) {
            console.log(`[AUDIO] Processing audio: ${audioMedia.url} (${audioMedia.contentType})`);
            
            // Download audio from Twilio
            const audioBuffer = await downloadTwilioMedia(audioMedia.url);
            
            // Determine file extension
            const audioExtension = audioMedia.contentType.split('/')[1] || 'ogg';
            
            // Use the extracted userId for S3 path, fallback to temp if not available
            const s3UserId = userId || ('temp_' + Date.now());
            
            // Upload to S3
            const s3AudioFile = await putMediaToS3(audioBuffer, audioMedia.contentType, s3UserId, audioExtension);
            
            // Transcribe the audio
            const transcribedText = await transcribeAudio(s3AudioFile.url, audioExtension);
            
            if (transcribedText && transcribedText.trim()) {
              mensajeUsuario = transcribedText.trim();
              console.log(`[AUDIO] Successfully transcribed: "${mensajeUsuario}"`);
            } else {
              mensajeUsuario = 'He recibido tu mensaje de audio pero no pude entender lo que dijiste. ¿Podrías escribirme o enviar el audio de nuevo?';
              console.log('[AUDIO] Transcription failed or empty');
            }
          } else {
            console.log('[AUDIO] No audio file found in media');
            mensajeUsuario = 'He recibido un archivo multimedia pero no pude procesarlo como audio.';
          }
        } catch (error) {
          console.error('[AUDIO] Error processing audio:', error);
          mensajeUsuario = 'He recibido tu mensaje de audio pero hubo un error al procesarlo. ¿Podrías escribirme o intentar de nuevo?';
        }
      }
    }
  }
  
  // Extract text message if no audio or if Body has content
  if (form?.Body?.trim?.() && mensajeUsuario === 'mensaje vacío') {
    // Twilio format
    mensajeUsuario = form.Body.trim();
    console.log('Message extracted from Twilio Body field:', mensajeUsuario);
  } else if (form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body) {
    // Meta WhatsApp webhook format
    mensajeUsuario = form.entry[0].changes[0].value.messages[0].text.body.trim();
    console.log('Message extracted from Meta webhook format:', mensajeUsuario);
  } else if (mensajeUsuario === 'mensaje vacío') {
    // Try to find any field that might contain the message
    console.log('Standard extraction failed, trying fallback methods...');
    console.log('Form keys available:', Object.keys(form));
    
    // Look for common Twilio fields that might contain the message
    const possibleMessageFields = ['Body', 'body', 'Text', 'text', 'Message', 'message'];
    for (const field of possibleMessageFields) {
      if (form[field] && typeof form[field] === 'string' && form[field].trim()) {
        mensajeUsuario = form[field].trim();
        console.log(`Message found in field '${field}':`, mensajeUsuario);
        break;
      }
    }
    
    // If still empty and we have only one form key that might be malformed data, try to extract from it
    if (mensajeUsuario === 'mensaje vacío' && Object.keys(form).length === 1) {
      const singleKey = Object.keys(form)[0];
      const singleValue = Object.values(form)[0];
      
      // Try to extract Body parameter from the key itself (in case parsing failed)
      const bodyMatch = singleKey.match(/Body=([^&]+)/);
      if (bodyMatch) {
        try {
          mensajeUsuario = decodeURIComponent(bodyMatch[1].replace(/\+/g, ' ')).trim();
          console.log('Message extracted from malformed form key:', mensajeUsuario);
        } catch (e) {
          console.log('Failed to decode message from form key:', e.message);
        }
      }
    }
    
    // If still empty, log the form structure for debugging
    if (mensajeUsuario === 'mensaje vacío') {
      console.log('No message found in any field. Full form structure:', JSON.stringify(form, null, 2));
    }
  }
  
  console.log('Final extracted message:', mensajeUsuario);
  
  // Ensure we have userId, fallback to anon if extraction failed
  if (!userId) {
    userId = 'anon';
  }
  
  // Handle Meta WhatsApp webhook format if not already processed
  if (!userId || userId === 'anon') {
    if (form?.entry?.[0]?.changes?.[0]?.value) {
      // Handle Meta WhatsApp webhook format
      const value = form.entry[0].changes[0].value;
      const contact = value.contacts?.[0];
      const message = value.messages?.[0];
    
    if (contact?.wa_id || message?.from) {
      const waid = contact?.wa_id || message?.from;
      phone = waid;
      const normalizedPhone = normalizePhone(waid);
      userId = `wa:${normalizedPhone}`;
      
      // Extract phone_number_id from webhook if available
      phoneNumberId = value.metadata?.phone_number_id || PHONE_NUMBER_ID;
      
      logConversationState(userId, 'META_WEBHOOK_PHONE_EXTRACTED', { 
        waid, 
        phone, 
        normalizedPhone,
        phoneNumberId,
        metadataPhoneId: value.metadata?.phone_number_id
      });
      }
    }
  }
  
  // Fallback phone extraction if main parsing failed
  if (userId === 'anon' && event.body) {
    console.log('Main phone extraction failed, trying fallback methods...');
    
    // Try to extract phone from raw body using regex
    const phonePatterns = [
      /From=whatsapp%3A%2B(\d+)/,
      /From=whatsapp:(\+\d+)/,
      /WaId=(\d+)/,
      /"from":"(\d+)"/,
      /"wa_id":"(\d+)"/
    ];
    
    for (const pattern of phonePatterns) {
      const match = event.body.match(pattern);
      if (match) {
        const extractedPhone = match[1].replace(/^\+/, '');
        const normalizedPhone = normalizePhone(extractedPhone);
        userId = `wa:${normalizedPhone}`;
        phone = extractedPhone;
        console.log('Fallback phone extraction successful:', { extractedPhone, normalizedPhone, userId });
        break;
      }
    }
    
    // If still anonymous, try to find existing conversations with recent activity
    if (userId === 'anon') {
      console.log('Phone extraction failed completely, checking for recent conversations...');
      const recentUsers = Object.keys(memory)
        .filter(key => key.startsWith('wa:') && memory[key] && memory[key].length > 0)
        .sort((a, b) => {
          const aLastMsg = memory[a][memory[a].length - 1];
          const bLastMsg = memory[b][memory[b].length - 1];
          const aTime = aLastMsg?.metadata?.timestamp || 0;
          const bTime = bLastMsg?.metadata?.timestamp || 0;
          return new Date(bTime) - new Date(aTime);
        });
      
      if (recentUsers.length > 0) {
        console.log('Found recent conversations, using most recent:', recentUsers[0]);
        userId = recentUsers[0];
        // Extract phone from userId for consistency
        phone = userId.replace('wa:', '');
      }
    }
  }
  
  console.log('Phone:', phone, 'UserId:', userId, 'PhoneNumberId:', phoneNumberId);

  // Obtener historial previo o crear nuevo con fallback a backup
  let history = memory[userId];
  
  if (!history || history.length === 0) {
    // Try to restore from backup if main history is lost
    history = restoreConversation(userId);
    if (history.length > 0) {
      memory[userId] = history; // Restore to main memory
    }
  }
  
  if (!history) {
    history = [];
  }
  
  // Log conversation state for debugging
  logConversationState(userId, 'HISTORY_RETRIEVED', { 
    historyLength: history.length,
    messageId,
    hasExistingConversation: history.length > 0,
    phoneNumberId
  });

  // Check for duplicate messages using messageId
  if (messageId) {
    const recentMessages = history.slice(-10); // Check last 10 messages
    const isDuplicate = recentMessages.some(msg => 
      msg.role === "user" && 
      msg.content?.[0]?.text === mensajeUsuario &&
      msg.messageId === messageId
    );
    
    if (isDuplicate) {
      logConversationState(userId, 'DUPLICATE_MESSAGE_DETECTED', { messageId, mensajeUsuario });
      console.log(`[DEBUG] Mensaje duplicado detectado: ${messageId}`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/xml" },
        body: `<Response></Response>` // Empty response for duplicates
      };
    }
  }

  // Agregar el nuevo mensaje del usuario con messageId y phone info
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: mensajeUsuario }],
    ...(messageId && { messageId }),
    // Add metadata to help maintain conversation thread
    metadata: {
      phone,
      userId,
      phoneNumberId,
      timestamp: new Date().toISOString()
    }
  };
  
  history.push(userMessage);
  
  logConversationState(userId, 'USER_MESSAGE_ADDED', { 
    messageId, 
    messageLength: mensajeUsuario.length,
    newHistoryLength: history.length
  });

  const payload = {
    input: { type: "text", text: mensajeUsuario },
    history,
    // Pass phone info to maintain consistency
    phone,
    userId,
    phoneNumberId,
    // Pass media information for audio processing
    ...(mediaInfo && { mediaInfo })
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const fetchResponse = await fetch('https://main.d3n2gm0ekhq89e.amplifyapp.com/api/chat', {
      method: 'POST',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const response = await fetchResponse.json();
    console.log('Respuesta backend:', response);

    // Preparar mensaje para WhatsApp
    let mensaje = 'Sin respuesta IA';
    if (Array.isArray(response.reply) && response.reply.length > 0) {
      // Concatenar todos los mensajes de texto de la respuesta
      const mensajes = response.reply
        .filter(item => item?.type === 'text' && item?.text)
        .map(item => item.text);
      
      if (mensajes.length > 0) {
        mensaje = mensajes.join('\n\n');

        // Agregar respuesta completa al historial con metadata
        const assistantMessage = {
          role: "assistant",
          content: response.reply,
          metadata: {
            phone,
            userId,
            phoneNumberId,
            timestamp: new Date().toISOString()
          }
        };
        
        history.push(assistantMessage);

        // Guardar historial actualizado
        memory[userId] = history;
        
        // Create backup of conversation to prevent loss
        backupConversation(userId, history);
        
        logConversationState(userId, 'ASSISTANT_RESPONSE_ADDED', { 
          responseLength: mensaje.length,
          finalHistoryLength: history.length,
          phoneNumberId
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/xml" },
      body: `<Response><Message>${mensaje}</Message></Response>`
    };

  } catch (err) {
    console.error('Error en handler:', err);

    let mensajeError = 'Error procesando tu mensaje.';
    if (err.name === 'AbortError') {
      mensajeError = 'Lo siento, el servicio está tardando mucho en responder. Intentá más tarde.';
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/xml" },
      body: `<Response><Message>${mensajeError}</Message></Response>`
    };
  }
};
