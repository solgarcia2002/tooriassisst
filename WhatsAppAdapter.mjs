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
  console.log('[MEDIA_EXTRACT] ===========================================');
  console.log('[MEDIA_EXTRACT] Extracting media from form...');
  console.log('[MEDIA_EXTRACT] Form keys:', Object.keys(form));
  
  // Twilio format
  if (form.MediaUrl0) {
    console.log('[MEDIA_EXTRACT] ✅ Twilio media detected!');
    console.log('[MEDIA_EXTRACT] MediaUrl0:', form.MediaUrl0);
    console.log('[MEDIA_EXTRACT] MediaContentType0:', form.MediaContentType0);
    const media = {
      url: form.MediaUrl0,
      contentType: form.MediaContentType0 || 'audio/ogg'
    };
    console.log('[MEDIA_EXTRACT] Returning media object:', JSON.stringify(media, null, 2));
    console.log('[MEDIA_EXTRACT] ===========================================');
    return media;
  }
  
  // WhatsApp API format
  const message = form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  console.log('[MEDIA_EXTRACT] Checking WhatsApp API format...');
  console.log('[MEDIA_EXTRACT] Message object:', JSON.stringify(message, null, 2));
  
  if (message?.audio?.id) {
    console.log('[MEDIA_EXTRACT] ✅ WhatsApp API audio detected!');
    const media = {
      id: message.audio.id,
      contentType: message.audio.mime_type || 'audio/ogg',
      isWhatsAppMedia: true
    };
    console.log('[MEDIA_EXTRACT] Returning WhatsApp media object:', JSON.stringify(media, null, 2));
    console.log('[MEDIA_EXTRACT] ===========================================');
    return media;
  }
  
  console.log('[MEDIA_EXTRACT] ❌ No media found in form');
  console.log('[MEDIA_EXTRACT] ===========================================');
  return null;
};

const isTwilioMessage = (form) => {
  // Detect Twilio messages by checking for Twilio-specific fields
  const hasTwilioFields = !!(form.From || form.WaId || form.MessageSid || form.MediaUrl0);
  
  // If we have Twilio fields but no Twilio credentials, we'll still process as Twilio
  // but use WhatsApp auth for media downloads
  if (hasTwilioFields) {
    console.log('[TWILIO] Detected Twilio message format');
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      console.log('[TWILIO] No Twilio credentials available, will use WhatsApp auth for media');
    }
  }
  
  return hasTwilioFields;
};

// ==========================================
// MEDIA FUNCTIONS
// ==========================================

const downloadMedia = async (mediaUrl, useWhatsAppAuth = true) => {
  try {
    console.log(`[MEDIA] Downloading from: ${mediaUrl}`);
    
    let authHeader;
    if (useWhatsAppAuth) {
      // Use WhatsApp API authentication for WhatsApp media
      authHeader = `Bearer ${WHATSAPP_TOKEN}`;
      console.log(`[MEDIA] Using WhatsApp API auth`);
    } else {
      // Use Twilio authentication for Twilio media
      authHeader = getTwilioAuth();
      if (!authHeader) {
        console.log('[AUTH] Twilio credentials not configured - using WhatsApp API instead');
        authHeader = `Bearer ${WHATSAPP_TOKEN}`;
        console.log(`[MEDIA] Falling back to WhatsApp API auth`);
      } else {
        console.log(`[MEDIA] Using Twilio auth`);
      }
    }
    
    const response = await fetch(mediaUrl, { 
      headers: { 
        Authorization: authHeader,
        'User-Agent': 'AWS Lambda Function'
      } 
    });
    
    console.log(`[MEDIA] Response status: ${response.status}`);
    console.log(`[MEDIA] Response headers:`, Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      console.error(`[MEDIA] Download failed: ${response.status} ${response.statusText}`);
      
      // If using WhatsApp auth failed and this looks like a Twilio URL, try without auth
      if (useWhatsAppAuth && mediaUrl.includes('api.twilio.com')) {
        console.log('[MEDIA] WhatsApp auth failed on Twilio URL, trying without auth...');
        try {
          const noAuthResponse = await fetch(mediaUrl, { 
            headers: { 'User-Agent': 'AWS Lambda Function' } 
          });
          
          console.log(`[MEDIA] No-auth response status: ${noAuthResponse.status}`);
          
          if (noAuthResponse.ok) {
            const buffer = await noAuthResponse.arrayBuffer();
            console.log(`[MEDIA] ✅ Downloaded ${buffer.byteLength} bytes without auth`);
            return Buffer.from(buffer);
          } else {
            console.error(`[MEDIA] No-auth download also failed: ${noAuthResponse.status}`);
          }
        } catch (noAuthError) {
          console.error('[MEDIA] No-auth download error:', noAuthError);
        }
      }
      
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
  try {
    console.log('[S3_UPLOAD] ===========================================');
    console.log('[S3_UPLOAD] Starting S3 upload process...');
    console.log('[S3_UPLOAD] Buffer size:', buffer.length, 'bytes');
    console.log('[S3_UPLOAD] Content type:', contentType);
    console.log('[S3_UPLOAD] User ID:', userId);
    console.log('[S3_UPLOAD] Media bucket:', MEDIA_BUCKET);
    
    // Extract file extension from content type
    let extension = 'ogg'; // default
    if (contentType) {
      const mimeType = contentType.split('/')[1];
      if (mimeType) {
        extension = mimeType.split(';')[0]; // Remove any additional parameters
      }
    }
    
    const fileName = `media/${userId}/${crypto.randomUUID()}.${extension}`;
    const fullS3Path = `s3://${MEDIA_BUCKET}/${fileName}`;
    
    console.log('[S3_UPLOAD] Generated file name:', fileName);
    console.log('[S3_UPLOAD] Full S3 path:', fullS3Path);
    console.log('[S3_UPLOAD] File extension:', extension);
    
    const uploadParams = {
      Bucket: MEDIA_BUCKET,
      Key: fileName,
      Body: buffer,
      ContentType: contentType
    };
    
    console.log('[S3_UPLOAD] Upload parameters:', {
      Bucket: uploadParams.Bucket,
      Key: uploadParams.Key,
      ContentType: uploadParams.ContentType,
      BodySize: uploadParams.Body.length
    });
    
    console.log('[S3_UPLOAD] Sending upload command to S3...');
    const result = await s3.send(new PutObjectCommand(uploadParams));
    
    console.log('[S3_UPLOAD] ✅ Upload successful!');
    console.log('[S3_UPLOAD] S3 response:', JSON.stringify(result, null, 2));
    console.log('[S3_UPLOAD] Final S3 URL:', fullS3Path);
    console.log('[S3_UPLOAD] ===========================================');
    
    return fullS3Path;
  } catch (error) {
    console.error('[S3_UPLOAD] ❌ S3 upload failed!');
    console.error('[S3_UPLOAD] Error type:', error.name);
    console.error('[S3_UPLOAD] Error message:', error.message);
    console.error('[S3_UPLOAD] Error code:', error.code);
    console.error('[S3_UPLOAD] Error stack:', error.stack);
    console.error('[S3_UPLOAD] ===========================================');
    throw error;
  }
};

const startTranscription = async (audioUrl) => {
  const jobName = `job-${crypto.randomUUID()}`;
  
  // Extract format from URL
  let mediaFormat = 'ogg'; // default
  if (audioUrl) {
    const urlParts = audioUrl.split('.');
    const extension = urlParts[urlParts.length - 1];
    if (['mp3', 'mpeg'].includes(extension)) {
      mediaFormat = 'mp3';
    } else if (['mp4', 'm4a'].includes(extension)) {
      mediaFormat = 'mp4';
    } else if (['wav'].includes(extension)) {
      mediaFormat = 'wav';
    } else if (['webm'].includes(extension)) {
      mediaFormat = 'webm';
    } else if (['ogg'].includes(extension)) {
      mediaFormat = 'ogg';
    }
  }
  
  console.log(`[TRANSCRIBE] Starting transcription job: ${jobName}`);
  console.log(`[TRANSCRIBE] Audio URL: ${audioUrl}`);
  console.log(`[TRANSCRIBE] Media format: ${mediaFormat}`);
  
  await transcribe.send(new StartTranscriptionJobCommand({
    TranscriptionJobName: jobName,
    LanguageCode: 'es-AR', // Español argentino
    MediaFormat: mediaFormat,
    Media: { MediaFileUri: audioUrl },
    Settings: {
      ShowSpeakerLabels: false,
      MaxSpeakerLabels: 1,
      ShowAlternatives: false,
      MaxAlternatives: 1
    }
  }));
  
  return jobName;
};

const getTranscriptionResult = async (jobName) => {
  console.log(`[TRANSCRIBE] Waiting for transcription job: ${jobName}`);
  
  for (let i = 0; i < 30; i++) {
    await wait(2000);
    
    try {
      const result = await transcribe.send(new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName
      }));
      
      const status = result.TranscriptionJob.TranscriptionJobStatus;
      
      // Log every 5 attempts to avoid spam
      if (i % 5 === 0 || status !== 'IN_PROGRESS') {
        console.log(`[TRANSCRIBE] Job status (${i + 1}/30): ${status}`);
      }
      
      if (status === 'COMPLETED') {
        const transcriptUri = result.TranscriptionJob.Transcript.TranscriptFileUri;
        if (!transcriptUri) {
          console.error('[TRANSCRIBE] No transcript URI found in completed job');
          return '';
        }
        
        console.log(`[TRANSCRIBE] Downloading transcript from: ${transcriptUri}`);
        const response = await fetch(transcriptUri);
        
        if (!response.ok) {
          console.error(`[TRANSCRIBE] Failed to download transcript: ${response.status}`);
          return '';
        }
        
        const data = await response.json();
        const transcript = data.results?.transcripts?.[0]?.transcript || '';
        console.log(`[TRANSCRIBE] ✅ Transcription completed: "${transcript}"`);
        return transcript;
      }
      
      if (status === 'FAILED') {
        const failureReason = result.TranscriptionJob?.FailureReason || 'Unknown reason';
        console.error(`[TRANSCRIBE] ❌ Transcription failed: ${failureReason}`);
        throw new Error(`Transcription failed: ${failureReason}`);
      }
    } catch (error) {
      console.error(`[TRANSCRIBE] Error checking job status (attempt ${i + 1}):`, error);
      // Continue trying unless it's the last attempt
      if (i === 29) {
        throw error;
      }
    }
  }
  
  console.error('[TRANSCRIBE] ❌ Transcription timeout after 30 attempts');
  throw new Error('Transcription timeout');
};

const transcribeAudio = async (media, userId) => {
  try {
    console.log('[AUDIO] Processing audio...');
    
    let buffer;
    let contentType = media.contentType || 'audio/ogg';
    
    if (media.isWhatsAppMedia && media.id) {
      // WhatsApp API format - need to get URL first
      console.log(`[AUDIO] Fetching WhatsApp media URL for ID: ${media.id}`);
      const meta = await fetch(`https://graph.facebook.com/v18.0/${media.id}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      });
      
      if (!meta.ok) {
        throw new Error(`Failed to get WhatsApp media metadata: ${meta.status}`);
      }
      
      const metaData = await meta.json();
      console.log(`[AUDIO] Got WhatsApp media URL: ${metaData.url}`);
      buffer = await downloadMedia(metaData.url, true); // Use WhatsApp auth
    } else if (media.url) {
      // Direct URL (could be Twilio or WhatsApp format)
      // Check if Twilio credentials are available
      const hasTwilioAuth = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
      console.log(`[AUDIO] Processing direct URL with ${hasTwilioAuth ? 'Twilio' : 'WhatsApp'} auth`);
      buffer = await downloadMedia(media.url, !hasTwilioAuth); // Use WhatsApp auth if Twilio not available
    } else {
      throw new Error('No valid media URL or ID provided');
    }
    
    console.log(`[AUDIO] Buffer obtained, size: ${buffer.length} bytes`);
    
    const s3Url = await uploadToS3(buffer, contentType, userId);
    console.log(`[AUDIO] Uploaded to S3: ${s3Url}`);
    
    const jobName = await startTranscription(s3Url);
    const text = await getTranscriptionResult(jobName);
    
    console.log('[AUDIO] Transcribed:', text);
    return text;
  } catch (error) {
    console.error('[AUDIO] ❌ Error processing audio:', error);
    console.error('[AUDIO] Error type:', error.name);
    console.error('[AUDIO] Error message:', error.message);
    console.error('[AUDIO] Error stack:', error.stack);
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
  
  console.log('[WEBHOOK] Raw event received:');
  console.log('[WEBHOOK] Headers:', JSON.stringify(event.headers, null, 2));
  console.log('[WEBHOOK] Method:', event.httpMethod || event.requestContext?.http?.method);
  console.log('[WEBHOOK] Content-Type:', event.headers?.['content-type'] || event.headers?.['Content-Type']);
  console.log('[WEBHOOK] Body type:', typeof event.body);
  console.log('[WEBHOOK] Body length:', event.body?.length);
  console.log('[WEBHOOK] Raw body preview:', event.body?.substring(0, 500));
  
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
    console.log('[PARSE] Form keys:', Object.keys(form));
    console.log('[PARSE] Form data preview:', JSON.stringify(form, null, 2).substring(0, 1000));
    
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
    
    console.log('[DEBUG] Message extraction results:');
    console.log('[DEBUG] messageText:', messageText);
    console.log('[DEBUG] media:', JSON.stringify(media, null, 2));
    console.log('[DEBUG] media contentType:', media?.contentType);
    console.log('[DEBUG] isAudio check:', media && isAudio(media.contentType));
    
    // AUDIO DEBUGGING: Log detailed audio information
    if (form.MessageType === 'audio' || form.NumMedia > 0) {
      console.log('[AUDIO_DEBUG] ===========================================');
      console.log('[AUDIO_DEBUG] Audio message detected!');
      console.log('[AUDIO_DEBUG] MessageType:', form.MessageType);
      console.log('[AUDIO_DEBUG] NumMedia:', form.NumMedia);
      console.log('[AUDIO_DEBUG] MediaContentType0:', form.MediaContentType0);
      console.log('[AUDIO_DEBUG] MediaUrl0:', form.MediaUrl0);
      console.log('[AUDIO_DEBUG] Body:', form.Body);
      console.log('[AUDIO_DEBUG] From:', form.From);
      console.log('[AUDIO_DEBUG] To:', form.To);
      console.log('[AUDIO_DEBUG] ===========================================');
      
      if (media) {
        console.log('[AUDIO_DEBUG] Media object created:');
        console.log('[AUDIO_DEBUG] - URL:', media.url);
        console.log('[AUDIO_DEBUG] - Content Type:', media.contentType);
        console.log('[AUDIO_DEBUG] - Is Audio?:', isAudio(media.contentType));
      } else {
        console.log('[AUDIO_DEBUG] ❌ No media object was created!');
      }
    }
    
    // 4. Handle audio
    if (media && isAudio(media.contentType)) {
      console.log('[AUDIO_FLOW] ===========================================');
      console.log('[AUDIO_FLOW] Starting audio processing...');
      console.log('[AUDIO_FLOW] Media URL:', media.url);
      console.log('[AUDIO_FLOW] Content Type:', media.contentType);
      
      // Check if this is a Twilio audio without credentials
      const hasTwilioAuth = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
      const isTwilioAudio = media.url && media.url.includes('api.twilio.com');
      
      console.log('[AUDIO_FLOW] Has Twilio Auth:', hasTwilioAuth);
      console.log('[AUDIO_FLOW] TWILIO_ACCOUNT_SID exists:', !!TWILIO_ACCOUNT_SID);
      console.log('[AUDIO_FLOW] TWILIO_AUTH_TOKEN exists:', !!TWILIO_AUTH_TOKEN);
      console.log('[AUDIO_FLOW] TWILIO_ACCOUNT_SID value:', TWILIO_ACCOUNT_SID ? 'SET' : 'NOT_SET');
      console.log('[AUDIO_FLOW] TWILIO_AUTH_TOKEN value:', TWILIO_AUTH_TOKEN ? 'SET' : 'NOT_SET');
      console.log('[AUDIO_FLOW] Is Twilio Audio:', isTwilioAudio);
      console.log('[AUDIO_FLOW] Media URL:', media.url);
      console.log('[AUDIO_FLOW] ===========================================');
      
      // FORCE LOCAL PROCESSING FOR TESTING - uncomment the next line to force local processing
      const forceLocalProcessing = true;
      // const forceLocalProcessing = false;
      
      if (forceLocalProcessing) {
        console.log('[AUDIO] 🧪 FORCING LOCAL PROCESSING FOR TESTING');
        console.log('[AUDIO] Processing audio locally (forced)...');
        console.log('[AUDIO] Starting local transcription process...');
        const transcribed = await transcribeAudio(media, userId);
        console.log('[AUDIO] Local transcription result:', transcribed);
        messageText = transcribed || 'No pude entender el audio';
        console.log('[AUDIO] Final message text:', messageText);
      } else if (!hasTwilioAuth && isTwilioAudio) {
        console.log('[AUDIO] Twilio audio detected without credentials, forwarding to main backend');
        
        // Forward to main backend for processing
        const payload = {
          input: { type: "text", text: "[AUDIO_MESSAGE_TO_TRANSCRIBE]" },
          userId: userId,
          mediaInfo: {
            medias: [{
              url: media.url,
              contentType: media.contentType
            }]
          }
        };
        
        try {
          const backendResponse = await callBackend(payload);
          
          // Extract the transcribed text from the backend response
          if (backendResponse && typeof backendResponse === 'object') {
            // The backend should return the transcribed text in the reply
            const replyText = extractReplyText(backendResponse);
            if (replyText && !replyText.includes('problema técnico')) {
              messageText = replyText;
              console.log('[AUDIO] ✅ Audio processed successfully by main backend');
              
              // Send the response directly and return
              const messageParts = splitMessage(replyText);
              await sendMessages(phone, messageParts, useTwilio);
              console.log(`Sent ${messageParts.length} messages to ${phone} (audio processed by backend)`);
              
              return {
                statusCode: 200,
                body: replyText
              };
            }
          }
          
          console.warn('[AUDIO] Backend did not return valid transcription');
          messageText = 'No pude procesar el audio correctamente';
        } catch (error) {
          console.error('[AUDIO] Error forwarding to backend:', error);
          messageText = 'Hubo un problema técnico procesando tu audio';
        }
      } else {
        // Process audio locally
        console.log('[AUDIO] Processing audio locally with credentials');
        console.log('[AUDIO] Starting local transcription process...');
        const transcribed = await transcribeAudio(media, userId);
        console.log('[AUDIO] Local transcription result:', transcribed);
        messageText = transcribed || 'No pude entender el audio';
        console.log('[AUDIO] Final message text:', messageText);
      }
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
      body: replyText
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