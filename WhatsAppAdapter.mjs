import querystring from 'querystring';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import crypto from "crypto";

// ==========================================
// CONFIGURATION & CLIENTS
// ==========================================

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

// In-memory storage for conversation history
const memory = {};

// ==========================================
// UTILITY METHODS
// ==========================================

/**
 * Enhanced logging for debugging conversation threads
 */
const logConversationState = (userId, action, details = {}) => {
  console.log(`[CONVERSATION_THREAD] ${action} - UserId: ${userId}`, details);
};

/**
 * Check if content type is audio
 */
const isAudioFile = (contentType) => {
  if (!contentType) return false;
  const audioTypes = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/aac'];
  return audioTypes.some(type => contentType.toLowerCase().includes(type.split('/')[1]));
};

/**
 * Twilio authentication header
 */
const getTwilioAuthHeader = () =>
  "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

// ==========================================
// FORM PARSING METHODS
// ==========================================

/**
 * Try to decode Base64 encoded form data
 */
const tryDecodeBase64Form = (singleKey) => {
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(singleKey)) {
      const decodedBody = Buffer.from(singleKey, 'base64').toString('utf8');
      console.log('Successfully decoded Base64 body:', decodedBody);
      return querystring.parse(decodedBody);
    }
  } catch (error) {
    console.log('Base64 decoding failed:', error.message);
  }
  return null;
};

/**
 * Emergency parsing fallback for malformed data
 */
const tryEmergencyParsing = (bodyToParse) => {
  try {
    const emergencyParsed = {};
    const matches = bodyToParse.match(/(\w+)=([^&]*)/g);
    if (matches) {
      matches.forEach(match => {
        const [key, value] = match.split('=');
        emergencyParsed[key] = decodeURIComponent(value || '');
      });
      console.log('Emergency parsing successful:', Object.keys(emergencyParsed));
      return emergencyParsed;
    }
  } catch (error) {
    console.log('Emergency parsing also failed:', error.message);
  }
  return null;
};

/**
 * Parse form data from request body
 */
const parseFormData = (event) => {
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
      if (allKeys.length === 1 && allKeys[0].length > 100 && 
          (!parsed[allKeys[0]] || parsed[allKeys[0]] === '' || parsed[allKeys[0]] === '=')) {
        const singleKey = allKeys[0];
        console.log('Detected potential Base64 encoded form data');
        
        const base64Parsed = tryDecodeBase64Form(singleKey);
        if (base64Parsed) {
          parsed = base64Parsed;
          allKeys = Object.keys(parsed);
          console.log('After Base64 decoding - Keys found:', allKeys.length);
        }
      }
      
      // If still not parsed correctly, try emergency parsing
      if (allKeys.length <= 1) {
        const emergencyParsed = tryEmergencyParsing(bodyToParse);
        if (emergencyParsed) {
          parsed = emergencyParsed;
        }
      }
      
      form = parsed;
    }
  } catch (error) {
    console.error('Error parsing form data:', error);
    form = {};
  }

  return { form, messageId };
};

// ==========================================
// USER EXTRACTION METHODS  
// ==========================================

/**
 * Extract user info from Twilio format
 */
const extractFromTwilioFormat = (form) => {
  if (!form?.From && !form?.WaId) return null;

  let phone, userId;
  const phoneNumberId = PHONE_NUMBER_ID;

  if (form.From) {
    phone = form.From.replace(/^whatsapp:/, "");
    const waid = form?.WaId || phone;
    const normalizedPhone = normalizePhone(waid);
    userId = `wa:${normalizedPhone}`;
    
    logConversationState(userId, 'PHONE_EXTRACTED', { 
      originalFrom: form.From, 
      phone, 
      waid, 
      normalizedPhone,
      phoneNumberId 
    });
  } else if (form.WaId) {
    const waid = form.WaId;
    const normalizedPhone = normalizePhone(waid);
    userId = `wa:${normalizedPhone}`;
    phone = `+${normalizedPhone}`;
    
    logConversationState(userId, 'PHONE_EXTRACTED', { 
      originalFrom: null, 
      phone, 
      waid, 
      normalizedPhone,
      phoneNumberId 
    });
  }

  return { phone, userId, phoneNumberId };
};

/**
 * Extract user info from malformed form key
 */
const extractFromMalformedKey = (form) => {
  if (Object.keys(form).length !== 1) return null;

  const singleKey = Object.keys(form)[0];
  const fromMatch = singleKey.match(/From=whatsapp%3A%2B(\d+)/);
  const waidMatch = singleKey.match(/WaId=(\d+)/);
  
  if (fromMatch || waidMatch) {
    const normalizedPhone = normalizePhone(fromMatch?.[1] || waidMatch?.[1]);
    const userId = `wa:${normalizedPhone}`;
    const phone = `+${normalizedPhone}`;
    const phoneNumberId = PHONE_NUMBER_ID;
    
    console.log(`Phone extracted from malformed ${fromMatch ? 'From' : 'WaId'} field:`, { normalizedPhone, userId });
    
    return { phone, userId, phoneNumberId };
  }

  return null;
};

/**
 * Extract user info from Meta WhatsApp webhook
 */
const extractFromMetaWebhook = (form) => {
  if (!form?.entry?.[0]?.changes?.[0]?.value) return null;

  const value = form.entry[0].changes[0].value;
  const contact = value.contacts?.[0];
  const message = value.messages?.[0];

  if (contact?.wa_id || message?.from) {
    const waid = contact?.wa_id || message?.from;
    const phone = waid;
    const normalizedPhone = normalizePhone(waid);
    const userId = `wa:${normalizedPhone}`;
    const phoneNumberId = value.metadata?.phone_number_id || PHONE_NUMBER_ID;
    
    logConversationState(userId, 'META_WEBHOOK_PHONE_EXTRACTED', { 
      waid, 
      phone, 
      normalizedPhone,
      phoneNumberId,
      metadataPhoneId: value.metadata?.phone_number_id
    });

    return { phone, userId, phoneNumberId };
  }

  return null;
};

/**
 * Extract user information from form data
 */
const extractUserInfo = (form) => {
  // Try different extraction methods in order of preference
  let userInfo = extractFromTwilioFormat(form) || 
                 extractFromMalformedKey(form) || 
                 extractFromMetaWebhook(form);

  // Fallback to anonymous if extraction failed
  if (!userInfo) {
    userInfo = { phone: null, userId: 'anon', phoneNumberId: PHONE_NUMBER_ID };
  }

  console.log('Phone:', userInfo.phone, 'UserId:', userInfo.userId, 'PhoneNumberId:', userInfo.phoneNumberId);
  
  return userInfo;
};

// ==========================================
// MEDIA PROCESSING METHODS
// ==========================================

/**
 * Download media from Twilio
 */
const downloadTwilioMedia = async (mediaUrl) => {
  console.log(`[AUDIO] Descargando audio desde Twilio: ${mediaUrl}`);
  const response = await fetch(mediaUrl, { 
    headers: { Authorization: getTwilioAuthHeader() } 
  });
  if (!response.ok) {
    throw new Error(`Error descargando audio de Twilio: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

/**
 * Upload media to S3
 */
const uploadMediaToS3 = async (buffer, contentType, userId, extension) => {
  const fileName = `media/${userId}/${crypto.randomUUID()}.${extension}`;
  
  console.log(`[AUDIO] Subiendo audio a S3: ${fileName}`);
  
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
    Metadata: { userId }
  }));
  
  const url = `https://${MEDIA_BUCKET}.s3.${REGION}.amazonaws.com/${fileName}`;
  console.log(`[AUDIO] Audio subido a S3: ${url}`);
  
  return {
    url,
    key: fileName,
    contentType,
    size: buffer.length
  };
};

/**
 * Wait for transcription job to complete
 */
const waitForTranscriptionCompletion = async (jobName, maxAttempts = 30) => {
  let jobStatus = 'IN_PROGRESS';
  let attempts = 0;
  
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
  
  return null;
};

/**
 * Transcribe audio using Amazon Transcribe
 */
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
    
    // Wait for completion
    return await waitForTranscriptionCompletion(jobName);
    
  } catch (error) {
    console.error('[TRANSCRIBE] Error en transcripción:', error);
    return null;
  }
};

/**
 * Extract media information from form
 */
const extractMediaInfo = (form) => {
  const numMedia = parseInt(form?.NumMedia || '0');
  const messageType = form?.MessageType;
  
  if (numMedia === 0 && messageType !== 'audio') {
    return null;
  }

  console.log('Detected media message - NumMedia:', numMedia, 'MessageType:', messageType);
  
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
  
  return medias.length > 0 ? { medias } : null;
};

/**
 * Process a single audio file
 */
const processAudioFile = async (audioMedia, userId) => {
  console.log(`[AUDIO] Processing audio: ${audioMedia.url} (${audioMedia.contentType})`);
  
  // Download audio from Twilio
  const audioBuffer = await downloadTwilioMedia(audioMedia.url);
  
  // Determine file extension
  const audioExtension = audioMedia.contentType.split('/')[1] || 'ogg';
  
  // Use the extracted userId for S3 path, fallback to temp if not available
  const s3UserId = userId || ('temp_' + Date.now());
  
  // Upload to S3
  const s3AudioFile = await uploadMediaToS3(audioBuffer, audioMedia.contentType, s3UserId, audioExtension);
  
  // Transcribe the audio
  const transcribedText = await transcribeAudio(s3AudioFile.url, audioExtension);
  
  return transcribedText;
};

/**
 * Process audio media and return transcribed text
 */
const processAudioMedia = async (mediaInfo, userId) => {
  if (!mediaInfo?.medias) {
    return null;
  }

  console.log('Audio message detected, processing transcription...');
  
  try {
    // Find the audio media
    const audioMedia = mediaInfo.medias.find(m => isAudioFile(m.contentType));
    if (!audioMedia) {
      console.log('[AUDIO] No audio file found in media');
      return 'He recibido un archivo multimedia pero no pude procesarlo como audio.';
    }

    const transcribedText = await processAudioFile(audioMedia, userId);
    
    if (transcribedText && transcribedText.trim()) {
      console.log(`[AUDIO] Successfully transcribed: "${transcribedText}"`);
      return transcribedText.trim();
    } else {
      console.log('[AUDIO] Transcription failed or empty');
      return 'He recibido tu mensaje de audio pero no pude entender lo que dijiste. ¿Podrías escribirme o enviar el audio de nuevo?';
    }
  } catch (error) {
    console.error('[AUDIO] Error processing audio:', error);
    return 'He recibido tu mensaje de audio pero hubo un error al procesarlo. ¿Podrías escribirme o intentar de nuevo?';
  }
};

// ==========================================
// MESSAGE EXTRACTION METHODS
// ==========================================

/**
 * Try to extract message from common body fields
 */
const extractFromBodyFields = (form) => {
  if (form?.Body?.trim?.()) {
    const message = form.Body.trim();
    console.log('Message extracted from Twilio Body field:', message);
    return message;
  }
  
  const possibleBodyFields = ['body', 'message', 'Message', 'text', 'Text'];
  for (const field of possibleBodyFields) {
    if (form[field] && typeof form[field] === 'string' && form[field].trim()) {
      console.log(`Message found in field ${field}:`, form[field]);
      return form[field].trim();
    }
  }
  
  return null;
};

/**
 * Try to extract message from Meta WhatsApp webhook format
 */
const extractFromMetaWebhookMessage = (form) => {
  if (form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body) {
    const message = form.entry[0].changes[0].value.messages[0].text.body.trim();
    console.log('Message extracted from Meta webhook format:', message);
    return message;
  }
  return null;
};

/**
 * Try to extract message from malformed form key
 */
const extractFromMalformedForm = (form) => {
  if (Object.keys(form).length !== 1) return null;

  const singleKey = Object.keys(form)[0];
  const bodyMatch = singleKey.match(/Body=([^&]+)/);
  if (bodyMatch) {
    try {
      const extractedMessage = decodeURIComponent(bodyMatch[1]);
      console.log('Message extracted from malformed key:', extractedMessage);
      return extractedMessage;
    } catch (e) {
      console.log('Failed to decode message from malformed key:', e.message);
    }
  }
  
  return null;
};

/**
 * Extract text message from form data
 */
const extractTextMessage = (form) => {
  // Try different extraction methods
  let message = extractFromBodyFields(form) || 
                extractFromMetaWebhookMessage(form) || 
                extractFromMalformedForm(form);

  if (!message) {
    console.log('Standard extraction failed, trying fallback methods...');
    console.log('Form keys available:', Object.keys(form));
    console.log('No message found in any field. Full form structure:', JSON.stringify(form, null, 2));
  }

  return message;
};

// ==========================================
// CONVERSATION MANAGEMENT METHODS
// ==========================================

/**
 * Backup conversation state to prevent loss
 */
const backupConversation = (userId, history) => {
  try {
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

/**
 * Restore conversation from backup if main history is lost
 */
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

/**
 * Get conversation history for user
 */
const getConversationHistory = (userId) => {
  if (memory[userId]) {
    logConversationState(userId, 'HISTORY_RETRIEVED', { 
      historyLength: memory[userId].length,
      hasExistingConversation: true
    });
    return memory[userId];
  } else {
    const restored = restoreConversation(userId);
    if (restored.length > 0) {
      memory[userId] = restored;
      return restored;
    }
    logConversationState(userId, 'HISTORY_RETRIEVED', { 
      historyLength: 0,
      hasExistingConversation: false
    });
    return [];
  }
};

// ==========================================
// MAIN HANDLER
// ==========================================

export const handler = async (event) => {
  console.log('Raw body:', event.body);
  console.log('Headers:', event.headers);

  try {
    // 1. Parse form data
    const { form, messageId } = parseFormData(event);
    console.log('Form parseado OK:', form, 'MessageId:', messageId);

    // 2. Extract user information
    const { phone, userId, phoneNumberId } = extractUserInfo(form);

    // 3. Extract media information
    const mediaInfo = extractMediaInfo(form);

    // 4. Process message content
    let mensajeUsuario = 'mensaje vacío';

    // Check if we have audio to process
    if (mediaInfo && (form?.MessageType === 'audio' || mediaInfo.medias.some(m => isAudioFile(m.contentType)))) {
      const transcribedText = await processAudioMedia(mediaInfo, userId);
      if (transcribedText) {
        mensajeUsuario = transcribedText;
      }
    } else {
      // Extract text message
      const textMessage = extractTextMessage(form);
      if (textMessage) {
        mensajeUsuario = textMessage;
      }
    }

    console.log('Final extracted message:', mensajeUsuario);

    // 5. Get conversation history
    const history = getConversationHistory(userId);

    // 6. Create user message object
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: mensajeUsuario }],
      messageId,
      timestamp: new Date().toISOString()
    };
    
    history.push(userMessage);
    
    logConversationState(userId, 'USER_MESSAGE_ADDED', { 
      messageId, 
      messageLength: mensajeUsuario.length,
      newHistoryLength: history.length
    });

    // 7. Prepare payload for backend
    const payload = {
      input: { type: "text", text: mensajeUsuario },
      history,
      phone,
      userId,
      phoneNumberId,
      ...(mediaInfo && { mediaInfo })
    };

    // 8. Call backend API
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

    // 9. Process response and update history
    let mensaje = 'Sin respuesta IA';
    if (Array.isArray(response.reply) && response.reply.length > 0) {
      const mensajes = response.reply
        .filter(item => item?.type === 'text' && item?.text)
        .map(item => item.text);
      
      if (mensajes.length > 0) {
        mensaje = mensajes.join('\n\n');

        // Add complete response to history
        const assistantMessage = {
          role: "assistant",
          content: response.reply,
          timestamp: new Date().toISOString()
        };
        
        history.push(assistantMessage);
        
        // Backup conversation
        backupConversation(userId, history);
        
        // Update memory
        memory[userId] = history;
        
        logConversationState(userId, 'ASSISTANT_RESPONSE_ADDED', { 
          responseLength: mensaje.length,
          finalHistoryLength: history.length,
          phoneNumberId
        });
      }
    }

    // 10. Return response
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        status: "success", 
        message: "Mensaje procesado correctamente",
        response: mensaje,
        userId,
        messageId
      })
    };

  } catch (error) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        status: "error", 
        message: "Error interno del servidor",
        error: error.message
      })
    };
  }
};