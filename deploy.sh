#!/bin/bash

# Script de despliegue para la funcionalidad de audio
echo "🎵 Desplegando funcionalidad de audio a texto..."

# 1. Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

# 2. Crear archivo ZIP para Lambda
echo "📁 Creando archivo ZIP..."
zip -r lambda-audio.zip . -x "*.git*" "deploy.sh" "README_AUDIO.md" "*.md"

echo "✅ Archivo lambda-audio.zip creado"
echo ""
echo "🚀 Próximos pasos:"
echo "1. Sube lambda-audio.zip a tu función Lambda"
echo "2. Asegúrate de que el rol de IAM tenga permisos para Transcribe"
echo "3. Prueba enviando un mensaje de audio por WhatsApp"
echo ""
echo "📋 Permisos de IAM necesarios:"
echo "   - transcribe:StartTranscriptionJob"
echo "   - transcribe:GetTranscriptionJob"
echo ""
echo "🎯 ¡Listo! Tu asistente ya puede procesar mensajes de audio."