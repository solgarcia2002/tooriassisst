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
      return querystring.parse(event.body);
    }
  } catch (error) {
    console.error('Parse error:', error);
    return {};
  }
};

const extractPhone = (form) => {
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
  return !!(form.From || form.WaId || form.MessageSid);
};

// ==========================================
// MEDIA FUNCTIONS
// ==========================================

const downloadMedia = async (mediaUrl) => {
  const response = await fetch(mediaUrl, { 
    headers: { Authorization: getTwilioAuth() } 
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
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
  const form = new URLSearchParams();
  form.set("To", `whatsapp:${phone}`);
  form.set("From", TWILIO_WHATSAPP_FROM);
  form.set("Body", message);

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { 
      Authorization: getTwilioAuth(), 
      "Content-Type": "application/x-www-form-urlencoded" 
    },
    body: form
  });
  
  return response.ok;
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
  
  try {
    // 1. Parse form
    const form = parseBody(event);
    
    // 2. Extract basic info
    const phone = extractPhone(form);
    const userId = phone ? `wa:${normalizePhone(phone)}` : 'anon';
    const useTwilio = isTwilioMessage(form);
    
    if (!phone) {
      console.error('No phone found');
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
    const phone = extractPhone(form);
    
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