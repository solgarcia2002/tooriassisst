import querystring from 'querystring';

// Normalize phone number to match index.mjs format
const normalizePhone = (s) => (s || "").replace(/\D/g, "");

// Get PHONE_NUMBER_ID from environment for consistency
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const memory = {}; // Historial temporal por usuario

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
      // For audio messages, set a placeholder text that will be replaced by transcription
      if (messageType === 'audio' || medias.some(m => m.contentType?.includes('audio'))) {
        mensajeUsuario = '[AUDIO_MESSAGE_TO_TRANSCRIBE]';
        console.log('Audio message detected, will be sent for transcription');
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
  
  // Extract and normalize phone number to match index.mjs format
  let phone = null;
  let userId = 'anon';
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
    
    if (userId !== 'anon') {
      logConversationState(userId, 'PHONE_EXTRACTED', { 
        originalFrom: null, 
        phone, 
        waid: normalizedPhone, 
        normalizedPhone,
        phoneNumberId,
        extractedFromMalformedKey: true
      });
    }
  } else if (form?.entry?.[0]?.changes?.[0]?.value) {
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
