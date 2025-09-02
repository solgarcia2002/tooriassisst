import querystring from 'querystring';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import crypto from "crypto";

// ==========================================
// CONFIGURATION
// ==========================================

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const REGION = process.env.AWS_REGION || "us-west-2";
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || "toori360";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

const s3 = new S3Client({ region: REGION });
const transcribe = new TranscribeClient({ region: REGION });
const memory = {};

// ==========================================
// SIMPLE UTILITY FUNCTIONS
// ==========================================

const normalizePhone = (s) => (s || "").replace(/\D/g, "");

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isAudio = (contentType) => {
  return contentType && contentType.includes('audio');
};

const getTwilioAuth = () => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log('[AUTH] Twilio credentials not configured - using WhatsApp API instead');
    return null; // Return null instead of throwing error
  }
  return "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
};

// ==========================================
// PARSING FUNCTIONS
// ==========================================

const parseBody = (event) => {
  try {
    if (event.headers['content-type']?.includes('application/json')) {
      return JSON.parse(event.body);
    } else {
      // Try normal parsing first
      let parsed = querystring.parse(event.body);
      
      // If parsing resulted in a single key with no value, it might be malformed data
      if (Object.keys(parsed).length === 1 && Object.values(parsed)[0] === '') {
        const singleKey = Object.keys(parsed)[0];
        
        // Try to decode as Base64 if it looks like it
        if (/^[A-Za-z0-9+/]+=*$/.test(singleKey) && singleKey.length > 100) {
          try {
            const decodedBody = Buffer.from(singleKey, 'base64').toString('utf8');
            console.log('Successfully decoded Base64 body');
            parsed = querystring.parse(decodedBody);
          } catch (base64Error) {
            console.log('Base64 decode failed:', base64Error.message);
          }
        }
      }
      
      return parsed;
    }
  } catch (error) {
    console.error('Parse error:', error);
    
    // Try emergency parsing from raw body as last resort
    if (event.body) {
      console.log('Attempting emergency parsing from raw body...');
      try {
        const bodyMatch = event.body.match(/Body=([^&]+)/);
        const fromMatch = event.body.match(/From=([^&]+)/);
        const waidMatch = event.body.match(/WaId=([^&]+)/);
        
        if (bodyMatch || fromMatch || waidMatch) {
          const form = {};
          if (bodyMatch) {
            form.Body = decodeURIComponent(bodyMatch[1].replace(/\+/g, ' '));
          }
          if (fromMatch) {
            form.From = decodeURIComponent(fromMatch[1]);
          }
          if (waidMatch) {
            form.WaId = decodeURIComponent(waidMatch[1]);
          }
          return form;
        }
      } catch (emergencyError) {
        console.error('Emergency parsing failed:', emergencyError.message);
      }
    }
    
    return {};
  }
};

const extractPhone = (form, event) => {
  // Twilio format
  if (form.From) {
    return form.From.replace(/^whatsapp:/, "");
  }
  if (form.WaId) {
    return form.WaId;
  }
  
  // Meta format
  if (form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from) {
    return form.entry[0].changes[0].value.messages[0].from;
  }
  
  // Meta contacts format
  if (form?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id) {
    return form.entry[0].changes[0].value.contacts[0].wa_id;
  }
  
  // Fallback: try to extract from malformed form data
  if (Object.keys(form).length === 1) {
    const singleKey = Object.keys(form)[0];
    
    // Try to extract from URL-encoded data in the key itself
    const fromMatch = singleKey.match(/From=whatsapp%3A%2B(\d+)/);
    const waidMatch = singleKey.match(/WaId=(\d+)/);
    
    if (fromMatch) {
      return `+${fromMatch[1]}`;
    }
    if (waidMatch) {
      return `+${waidMatch[1]}`;
    }
  }
  
  // Last resort: try regex patterns on raw event body if available
  if (event?.body) {
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
        const phone = match[1].replace(/^\+/, '');
        return `+${phone}`;
      }
    }
  }
  
  return null;
};

const extractMessage = (form) => {
  // Twilio format
  if (form.Body) {
    return form.Body.trim();
  }
  // Meta format
  if (form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body) {
    return form.entry[0].changes[0].value.messages[0].text.body.trim();
  }
  return null;
};

const extractMediaUrl = (form) => {
  // Twilio format
  if (form.MediaUrl0) {
    return {
      url: form.MediaUrl0,
      contentType: form.MediaContentType0 || 'audio/ogg'
    };
  }
  return null;
};

const isTwilioMessage = (form) => {
  // Force WhatsApp API usage instead of Twilio to avoid credential issues
  return false;
  // Original logic: return !!(form.From || form.WaId || form.MessageSid);
};

// ==========================================
// MEDIA FUNCTIONS
// ==========================================

const downloadMedia = async (mediaUrl) => {
  try {
    const authHeader = getTwilioAuth();
    console.log(`[MEDIA] Downloading from: ${mediaUrl}`);
    console.log(`[MEDIA] Auth header length: ${authHeader.length}`);
    
    const response = await fetch(mediaUrl, { 
      headers: { Authorization: authHeader } 
    });
    
    if (!response.ok) {
      console.error(`[MEDIA] Download failed: ${response.status} ${response.statusText}`);
      console.error(`[MEDIA] Response headers:`, Object.fromEntries(response.headers.entries()));
      throw new Error(`Download failed: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`[MEDIA] Downloaded ${buffer.byteLength} bytes`);
    return Buffer.from(buffer);
  } catch (error) {
    console.error(`[MEDIA] Error downloading media:`, error);
    throw error;
  }
};

const uploadToS3 = async (buffer, contentType, userId) => {
  const fileName = `audio/${userId}/${crypto.randomUUID()}.ogg`;
  
  await s3.send(new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: fileName,
    Body: buffer,
    ContentType: contentType
  }));
  
  return `https://${MEDIA_BUCKET}.s3.${REGION}.amazonaws.com/${fileName}`;
};

const startTranscription = async (audioUrl) => {
  const jobName = `job-${crypto.randomUUID()}`;
  
  await transcribe.send(new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    LanguageCode: 'es-ES',
    MediaFormat: 'ogg',
    Media: { MediaFileUri: audioUrl }
  }));
  
  return jobName;
};

const getTranscriptionResult = async (jobName) => {
  for (let i = 0; i < 30; i++) {
    await wait(2000);
    
    const result = await transcribe.send(new GetTranscriptionJobCommand({
      TranscriptionJobName: jobName
    }));
    
    const status = result.TranscriptionJob.TranscriptionJobStatus;
    
    if (status === 'COMPLETED') {
      const transcriptUri = result.TranscriptionJob.Transcript.TranscriptFileUri;
      const response = await fetch(transcriptUri);
      const data = await response.json();
      return data.results.transcripts[0]?.transcript || '';
    }
    
    if (status === 'FAILED') {
      throw new Error('Transcription failed');
    }
  }
  
  throw new Error('Transcription timeout');
};

const transcribeAudio = async (mediaUrl, userId) => {
  try {
    console.log('[AUDIO] Processing audio...');
    
    const buffer = await downloadMedia(mediaUrl);
    const s3Url = await uploadToS3(buffer, 'audio/ogg', userId);
    const jobName = await startTranscription(s3Url);
    const text = await getTranscriptionResult(jobName);
    
    console.log('[AUDIO] Transcribed:', text);
    return text;
  } catch (error) {
    console.error('[AUDIO] Error:', error);
    return null;
  }
};

// ==========================================
// MESSAGING FUNCTIONS
// ==========================================

const splitMessage = (text) => {
  if (text.length <= 300) {
    return [text];
  }
  
  const parts = [];
  const sentences = text.split('. ');
  let current = '';
  
  for (const sentence of sentences) {
    if (current.length + sentence.length <= 300) {
      current += (current ? '. ' : '') + sentence;
    } else {
      if (current) parts.push(current);
      current = sentence;
    }
  }
  
  if (current) parts.push(current);
  return parts;
};

const sendWhatsAppMessage = async (phone, message) => {
  const response = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ 
      messaging_product: "whatsapp", 
      to: phone, 
      type: "text", 
      text: { body: message } 
    })
  });
  
  return response.ok;
};

const sendTwilioMessage = async (phone, message) => {
  console.log('[TWILIO] sendTwilioMessage called but should not be used - falling back to WhatsApp API');
  // Fallback to WhatsApp API instead of using Twilio
  return await sendWhatsAppMessage(phone, message);
};

const sendMessage = async (phone, message, useTwilio) => {
  if (useTwilio) {
    return await sendTwilioMessage(phone, message);
  } else {
    return await sendWhatsAppMessage(phone, message);
  }
};

const sendMessages = async (phone, messages, useTwilio) => {
  for (let i = 0; i < messages.length; i++) {
    await sendMessage(phone, messages[i], useTwilio);
    if (i < messages.length - 1) {
      await wait(800);
    }
  }
};

// ==========================================
// BACKEND FUNCTIONS
// ==========================================

const callBackend = async (payload) => {
  const response = await fetch('https://main.d3n2gm0ekhq89e.amplifyapp.com/api/chat', {
    method: 'POST',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  
  if (!response.ok) {
    throw new Error(`Backend error: ${response.status}`);
  }
  
  return await response.json();
};

const extractReplyText = (response) => {
  if (!response.reply || !Array.isArray(response.reply)) {
    return null;
  }
  
  const textMessages = response.reply
    .filter(item => item?.type === 'text' && item?.text)
    .map(item => item.text);
  
  return textMessages.length > 0 ? textMessages.join('\n\n') : null;
};

// ==========================================
// MEMORY FUNCTIONS
// ==========================================

const getHistory = (userId) => {
  return memory[userId] || [];
};

const addToHistory = (userId, message) => {
  if (!memory[userId]) {
    memory[userId] = [];
  }
  memory[userId].push(message);
};

// ==========================================
// MAIN HANDLER
// ==========================================

export const handler = async (event) => {
  console.log('Processing message...');
  console.log('[ENV] Environment check:', {
    twilioAccountSid: TWILIO_ACCOUNT_SID ? 'present' : 'missing',
    twilioAuthToken: TWILIO_AUTH_TOKEN ? 'present' : 'missing',
    phoneNumberId: PHONE_NUMBER_ID ? 'present' : 'missing',
    whatsappToken: WHATSAPP_TOKEN ? 'present' : 'missing'
  });
  
  // Handle webhook verification for Meta WhatsApp
  if (event.httpMethod === 'GET' && event.queryStringParameters) {
    const mode = event.queryStringParameters['hub.mode'];
    const token = event.queryStringParameters['hub.verify_token'];
    const challenge = event.queryStringParameters['hub.challenge'];
    
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verified');
      return {
        statusCode: 200,
        body: challenge
      };
    } else {
      console.log('Webhook verification failed');
      return {
        statusCode: 403,
        body: 'Forbidden'
      };
    }
  }
  
  try {
    // 1. Parse form
    const form = parseBody(event);
    
    // 2. Extract basic info
    const phone = extractPhone(form, event);
    const userId = phone ? `wa:${normalizePhone(phone)}` : 'anon';
    const useTwilio = isTwilioMessage(form);
    
    if (!phone) {
      console.error('No phone found');
      console.error('Form keys:', Object.keys(form));
      console.error('Form values:', Object.values(form));
      console.error('Event body preview:', event.body?.substring(0, 200));
      return { statusCode: 400, body: 'No phone number' };
    }
    
    console.log(`Message from: ${phone} (${useTwilio ? 'Twilio' : 'Meta'})`);
    
    // 3. Get message content
    let messageText = extractMessage(form);
    const media = extractMediaUrl(form);
    
    // 4. Handle audio
    if (media && isAudio(media.contentType)) {
      console.log('Processing audio message...');
      const transcribed = await transcribeAudio(media.url, userId);
      messageText = transcribed || 'No pude entender el audio';
    }
    
    if (!messageText) {
      messageText = 'mensaje vacío';
    }
    
    console.log('Message text:', messageText);
    
    // 5. Get conversation history
    const history = getHistory(userId);
    
    // 6. Add user message to history
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: messageText }]
    };
    addToHistory(userId, userMessage);
    
    // 7. Call backend
    const payload = {
      input: { type: "text", text: messageText },
      history: getHistory(userId),
      phone,
      userId
    };
    
    const backendResponse = await callBackend(payload);
    
    // 8. Extract reply
    const replyText = extractReplyText(backendResponse);
    
    if (!replyText) {
      throw new Error('No valid response from backend');
    }
    
    // 9. Add assistant response to history
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: replyText }]
    };
    addToHistory(userId, assistantMessage);
    
    // 10. Split and send messages
    const messageParts = splitMessage(replyText);
    await sendMessages(phone, messageParts, useTwilio);
    
    console.log(`Sent ${messageParts.length} messages to ${phone}`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        status: "success",
        messagesSent: messageParts.length
      })
    };
    
  } catch (error) {
    console.error('Handler error:', error);
    
    // Try to send error message to user
    const form = parseBody(event);
    const phone = extractPhone(form, event);
    
    if (phone) {
      const useTwilio = isTwilioMessage(form);
      await sendMessage(phone, "Disculpa, tuve un problema técnico. ¿Podrías intentar de nuevo?", useTwilio);
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        status: "error",
        error: error.message
      })
    };
  }
};