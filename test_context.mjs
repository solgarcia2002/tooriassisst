#!/usr/bin/env node

// test_context.mjs - Script para probar la persistencia de contexto
import { handler } from './index.mjs';

// Mock de AWS SDK para testing
const mockS3Data = new Map();

// Simular las variables de entorno necesarias
process.env.AWS_REGION = "us-west-2";
process.env.HISTORY_BUCKET = "test-history-bucket";
process.env.MEDIA_BUCKET = "test-media-bucket";
process.env.MAX_TURNS = "12";
process.env.DEBUG_S3 = "1";

console.log("🧪 Iniciando pruebas de contexto del chatbot...\n");

// Simular una conversación completa
const testConversation = async () => {
  const sessionId = `test-session-${Date.now()}`;
  
  console.log(`📱 Sesión de prueba: ${sessionId}\n`);

  // Mensaje 1: Saludo inicial
  console.log("👤 Usuario: hola");
  let response1 = await handler({
    body: JSON.stringify({
      input: "hola",
      sessionId: sessionId
    }),
    headers: { "content-type": "application/json" }
  });
  
  let result1 = JSON.parse(response1.body);
  console.log("🤖 Bot:", result1.reply.map(r => r.text).join("\n"));
  console.log(`📊 Contexto mantenido: ${result1.contextMaintained}`);
  console.log(`📝 Mensajes en historial: ${result1.history?.length || 0}\n`);

  // Mensaje 2: Proporcionar nombre
  console.log("👤 Usuario: soy sol");
  let response2 = await handler({
    body: JSON.stringify({
      input: "soy sol",
      sessionId: sessionId
    }),
    headers: { "content-type": "application/json" }
  });
  
  let result2 = JSON.parse(response2.body);
  console.log("🤖 Bot:", result2.reply.map(r => r.text).join("\n"));
  console.log(`📊 Contexto mantenido: ${result2.contextMaintained}`);
  console.log(`📝 Mensajes en historial: ${result2.history?.length || 0}\n`);

  // Mensaje 3: Proporcionar apellido
  console.log("👤 Usuario: garcia");
  let response3 = await handler({
    body: JSON.stringify({
      input: "garcia",
      sessionId: sessionId
    }),
    headers: { "content-type": "application/json" }
  });
  
  let result3 = JSON.parse(response3.body);
  console.log("🤖 Bot:", result3.reply.map(r => r.text).join("\n"));
  console.log(`📊 Contexto mantenido: ${result3.contextMaintained}`);
  console.log(`📝 Mensajes en historial: ${result3.history?.length || 0}\n`);

  // Mensaje 4: Simular reinicio (nuevo mensaje con mismo sessionId)
  console.log("🔄 Simulando continuación de conversación...");
  console.log("👤 Usuario: mi dirección es av corrientes 1234");
  let response4 = await handler({
    body: JSON.stringify({
      input: "mi dirección es av corrientes 1234",
      sessionId: sessionId
    }),
    headers: { "content-type": "application/json" }
  });
  
  let result4 = JSON.parse(response4.body);
  console.log("🤖 Bot:", result4.reply.map(r => r.text).join("\n"));
  console.log(`📊 Contexto mantenido: ${result4.contextMaintained}`);
  console.log(`📝 Mensajes en historial: ${result4.history?.length || 0}\n`);

  // Verificar que el bot no vuelve a preguntar el nombre
  const botResponsesText = result4.reply.map(r => r.text).join(" ").toLowerCase();
  const isAskingNameAgain = botResponsesText.includes("tu nombre") || 
                           botResponsesText.includes("cómo te llam") ||
                           botResponsesText.includes("me decís tu nombre");
  
  console.log("✅ Resultados de la prueba:");
  console.log(`   - Contexto mantenido: ${result4.contextMaintained ? '✅' : '❌'}`);
  console.log(`   - No repite pregunta de nombre: ${!isAskingNameAgain ? '✅' : '❌'}`);
  console.log(`   - Historial persistente: ${result4.history?.length > 6 ? '✅' : '❌'}`);
  
  if (result4.contextMaintained && !isAskingNameAgain && result4.history?.length > 6) {
    console.log("\n🎉 ¡Prueba EXITOSA! El contexto se mantiene correctamente.");
  } else {
    console.log("\n❌ Prueba FALLÓ. El contexto no se mantiene correctamente.");
  }
};

// Ejecutar la prueba
testConversation().catch(console.error);