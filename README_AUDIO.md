# Funcionalidad de Audio a Texto

## 🎯 Funcionalidad Implementada

Tu asistente de WhatsApp ahora puede:
- **Recibir mensajes de audio** de WhatsApp (Meta) y Twilio
- **Convertir automáticamente** el audio a texto usando Amazon Transcribe
- **Procesar el texto transcrito** como si fuera un mensaje normal
- **Manejar errores** de transcripción con mensajes amigables

## 🔧 Cambios Realizados

### 1. Nuevas Dependencias
```json
"@aws-sdk/client-transcribe": "^3.0.0"
```

### 2. Funciones Agregadas
- `transcribeAudio()`: Convierte audio a texto usando Amazon Transcribe
- `isAudioFile()`: Detecta si un archivo es de audio

### 3. Integración
- Detección automática de mensajes de audio en WhatsApp y Twilio
- Transcripción en español (es-ES) optimizada para Argentina
- Fallback amigable si la transcripción falla

## 🚀 Instalación

### 1. Instalar Dependencias
```bash
npm install
```

### 2. Permisos de AWS
Asegúrate de que tu Lambda tenga estos permisos en su rol de IAM:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "transcribe:StartTranscriptionJob",
                "transcribe:GetTranscriptionJob"
            ],
            "Resource": "*"
        }
    ]
}
```

### 3. Variables de Entorno
Las variables existentes siguen funcionando. No se necesitan nuevas variables.

## 📱 Cómo Funciona

1. **Usuario envía audio** por WhatsApp
2. **Sistema descarga** el archivo a S3 (como antes)
3. **Amazon Transcribe** convierte el audio a texto
4. **El texto transcrito** se procesa como `inputText` normal
5. **El asistente responde** basándose en el texto transcrito

## 🎭 Ejemplo de Uso

**Usuario:** *Envía audio: "Hola, tengo un problema con la canilla de la cocina que gotea"*

**Sistema:** 
- Transcribe: "Hola tengo un problema con la canilla de la cocina que gotea"
- Procesa como texto normal
- Responde con el flujo habitual de recopilación de información

**Asistente:** "¡Hola! Entiendo que tenés un problema con la canilla de la cocina que gotea. Para poder ayudarte mejor, ¿me podrías decir tu nombre completo?"

## ⚡ Características

- **Soporte multi-formato**: OGG, MP3, MP4, WAV, WebM, AAC
- **Optimizado para español**: Configurado para Argentina
- **Manejo de errores**: Mensajes amigables si falla la transcripción
- **Timeout inteligente**: Máximo 30 segundos de espera
- **Logging completo**: Para debugging y monitoreo

## 🔍 Monitoreo

Los logs incluyen:
```
[TRANSCRIBE] Iniciando transcripción de: s3://bucket/file.ogg
[TRANSCRIBE] Trabajo iniciado: transcribe-job-uuid
[TRANSCRIBE] Estado del trabajo (1/30): IN_PROGRESS
[TRANSCRIBE] Transcripción completada: https://...
[TRANSCRIBE] Texto transcrito: "hola tengo un problema..."
[AUDIO] Texto transcrito de WhatsApp: "hola tengo un problema..."
```

## 🛠️ Troubleshooting

### Audio no se transcribe
1. Verificar permisos de IAM para Transcribe
2. Confirmar que el archivo se subió correctamente a S3
3. Revisar logs de Lambda para errores específicos

### Transcripción incorrecta
- Amazon Transcribe funciona mejor con audio claro
- Ruido de fondo puede afectar la precisión
- El sistema maneja errores menores con contexto

### Timeout
- Archivos muy largos (>30 segundos) pueden hacer timeout
- Considera aumentar `maxAttempts` si es necesario

## 📊 Costos

- **Amazon Transcribe**: ~$0.024 por minuto de audio
- **Latencia**: 1-10 segundos típicos para audios cortos
- **S3**: Costo mínimo adicional para almacenar archivos

## 🔄 Próximas Mejoras Posibles

1. **Transcripción en tiempo real** con Transcribe Streaming
2. **Detección de idioma** automática
3. **Filtros de ruido** para mejor calidad
4. **Compresión de audio** antes de transcribir