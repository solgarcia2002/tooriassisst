import querystring from 'querystring';

const memory = {}; // Historial temporal por usuario

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

  const mensajeUsuario = form?.Body?.trim?.() || 'mensaje vacío';
  const userId = form?.From || 'anon'; // ej: whatsapp:+549351...

  // Obtener historial previo o crear nuevo
  let history = memory[userId] || [];

  // Check for duplicate messages using messageId
  if (messageId) {
    const recentMessages = history.slice(-10); // Check last 10 messages
    const isDuplicate = recentMessages.some(msg => 
      msg.role === "user" && 
      msg.content?.[0]?.text === mensajeUsuario &&
      msg.messageId === messageId
    );
    
    if (isDuplicate) {
      console.log(`[DEBUG] Mensaje duplicado detectado: ${messageId}`);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/xml" },
        body: `<Response></Response>` // Empty response for duplicates
      };
    }
  }

  // Agregar el nuevo mensaje del usuario con messageId
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: mensajeUsuario }],
    ...(messageId && { messageId })
  };
  
  history.push(userMessage);

  const payload = {
    input: { type: "text", text: mensajeUsuario },
    history
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

        // Agregar respuesta completa al historial
        history.push({
          role: "assistant",
          content: response.reply
        });

        // Guardar historial actualizado
        memory[userId] = history;
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
