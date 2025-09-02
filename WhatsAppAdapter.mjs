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
      const parsed = querystring.parse(event.body);
      if (Object.keys(parsed).length === 1 && Object.values(parsed)[0].includes('=')) {
        const onlyKey = Object.keys(parsed)[0];
        form = querystring.parse(decodeURIComponent(onlyKey));
      } else {
        form = parsed;
      }
      // For Twilio format, try to get message SID as ID
      messageId = form?.MessageSid || null;
    }
  } catch (e) {
    console.error('Error al parsear el body:', e);
    form = {};
  }

  console.log('Form parseado OK:', form, 'MessageId:', messageId);

  // Extract message text from different formats
  let mensajeUsuario = 'mensaje vacío';
  
  if (form?.Body?.trim?.()) {
    // Twilio format
    mensajeUsuario = form.Body.trim();
  } else if (form?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body) {
    // Meta WhatsApp webhook format
    mensajeUsuario = form.entry[0].changes[0].value.messages[0].text.body.trim();
  }
  
  console.log('Extracted message:', mensajeUsuario);
  
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
    phoneNumberId
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
