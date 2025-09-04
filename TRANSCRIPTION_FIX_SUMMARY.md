# Audio Transcription Fix Summary

## Issues Identified

Based on the logs, the audio transcription was failing because:

1. **Missing IAM Permissions**: Lambda functions lacked proper permissions for S3 and Amazon Transcribe
2. **Incomplete Error Handling**: Transcription failures weren't properly logged or handled
3. **Missing S3 Bucket Policy**: Amazon Transcribe service couldn't access audio files in S3
4. **Insufficient Logging**: Not enough diagnostic information to troubleshoot issues

## Fixes Applied

### 1. Lambda IAM Policy (`lambda-iam-policy.json`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::toori360/*",
        "arn:aws:s3:::toori-chat-history/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::toori360",
        "arn:aws:s3:::toori-chat-history"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
        "transcribe:ListTranscriptionJobs",
        "transcribe:DeleteTranscriptionJob"
      ],
      "Resource": "*"
    }
  ]
}
```

### 2. S3 Bucket Policy (`s3-bucket-policy.json`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowTranscribeAccess",
      "Effect": "Allow",
      "Principal": {
        "Service": "transcribe.amazonaws.com"
      },
      "Action": [
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::toori360/*"
      ]
    },
    {
      "Sid": "AllowLambdaAccess",
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::toori360/*",
        "arn:aws:s3:::toori-chat-history/*"
      ]
    }
  ]
}
```

### 3. Code Improvements

#### Enhanced Transcription Function (index.mjs)
- Added S3 URL validation
- Improved audio format mapping (added AAC, FLAC support)
- Added job cleanup for completed, failed, and timed-out jobs
- Better error handling with specific error types
- Increased wait time between polling attempts (2 seconds)

#### Enhanced Transcription Function (WhatsAppAdapter.mjs)
- Added comprehensive error logging
- Added job cleanup functionality
- Improved permission error detection
- Better media object validation

#### Improved Error Handling
- Added detailed logging for audio processing steps
- Added buffer size validation
- Added cleanup of orphaned transcription jobs
- Better error messages for users

## Deployment Steps

### 1. Update Lambda Function Permissions

For both Lambda functions, attach the IAM policy from `lambda-iam-policy.json`:

```bash
# Create the policy
aws iam create-policy \
  --policy-name LambdaTranscriptionPolicy \
  --policy-document file://lambda-iam-policy.json

# Attach to Lambda execution role
aws iam attach-role-policy \
  --role-name YourLambdaExecutionRole \
  --policy-arn arn:aws:iam::YOUR_ACCOUNT:policy/LambdaTranscriptionPolicy
```

### 2. Update S3 Bucket Policy

Apply the bucket policy from `s3-bucket-policy.json` to the `toori360` bucket:

```bash
aws s3api put-bucket-policy \
  --bucket toori360 \
  --policy file://s3-bucket-policy.json
```

### 3. Deploy Updated Lambda Functions

Deploy the updated `index.mjs` and `WhatsAppAdapter.mjs` files to their respective Lambda functions.

## Environment Variables Required

Ensure these environment variables are set in both Lambda functions:

```
AWS_REGION=us-west-2
MEDIA_BUCKET=toori360
HISTORY_BUCKET=toori-chat-history
TWILIO_ACCOUNT_SID=<your_twilio_account_sid>
TWILIO_AUTH_TOKEN=<your_twilio_auth_token>
TWILIO_WHATSAPP_FROM=+14155238886
PHONE_NUMBER_ID=685108458016129
WHATSAPP_TOKEN=<your_whatsapp_token>
```

## Testing

After deployment, test the transcription functionality:

1. Send a WhatsApp voice message
2. Check CloudWatch logs for detailed transcription process logs
3. Verify that audio files are uploaded to S3
4. Verify that transcription jobs are created and completed
5. Confirm that transcribed text appears in the chat response

## Monitoring

Key log messages to monitor:

- `[TRANSCRIBE] Trabajo iniciado exitosamente` - Job started
- `[TRANSCRIBE] Texto transcrito exitosamente` - Successful transcription
- `[TRANSCRIBE] Error de permisos` - Permission errors
- `[TRANSCRIBE] Trabajo falló` - Job failures
- `[S3] Upload successful` - S3 upload success

## Common Issues and Solutions

### Issue: "AccessDenied" errors
**Solution**: Verify IAM permissions are correctly attached to Lambda execution roles

### Issue: "InvalidS3ObjectException" 
**Solution**: Check S3 bucket policy allows transcribe.amazonaws.com to read objects

### Issue: Empty transcription results
**Solution**: 
- Check audio file format is supported (OGG, MP3, MP4, WAV, WebM, FLAC)
- Verify audio file is not corrupted
- Check if audio contains clear speech in Spanish

### Issue: Transcription timeout
**Solution**: 
- Check audio file size (large files take longer)
- Verify Transcribe service limits in your AWS region
- Check CloudWatch logs for specific error details

## Expected Behavior

After applying these fixes:

1. ✅ Audio messages should be properly downloaded from WhatsApp/Twilio
2. ✅ Audio files should be uploaded to S3 successfully
3. ✅ Transcription jobs should start without permission errors
4. ✅ Completed jobs should return transcribed text
5. ✅ Failed jobs should be cleaned up automatically
6. ✅ Users should receive transcribed text or helpful error messages