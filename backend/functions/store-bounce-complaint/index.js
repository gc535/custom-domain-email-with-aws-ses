/**
 * Lambda: subscribed to SNS topic for SES bounce and complaint events.
 * Writes each event payload to the same inbound bucket under bounce/ or complaints/
 * for book-keeping only (no forwarding).
 */
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client();

function safeKey(str) {
  return (str || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

exports.handler = async (event) => {
  const bucket = process.env.BUCKET_NAME;
  if (!bucket) {
    console.error('Missing BUCKET_NAME');
    return;
  }

  for (const record of event.Records || []) {
    const raw = record.Sns?.Message;
    if (!raw) continue;

    try {
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // SES uses notificationType (basic) or eventType (event publishing)
      const type = (payload.notificationType || payload.eventType || '').toLowerCase();
      const prefix = type === 'bounce' ? 'bounce' : type === 'complaint' ? 'complaints' : null;
      if (!prefix) {
        console.warn('Unknown notificationType/eventType:', payload.notificationType || payload.eventType);
        continue;
      }

      const id = payload.bounce?.feedbackId || payload.complaint?.feedbackId || payload.mail?.messageId || record.Sns.MessageId;
      const ts = payload.mail?.timestamp || payload.bounce?.timestamp || payload.complaint?.timestamp || new Date().toISOString();
      const key = `${prefix}/${ts.replace(/[:.]/g, '-')}-${safeKey(id)}.json`;

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(payload, null, 2),
          ContentType: 'application/json',
        })
      );
      console.log(`Stored ${type} to s3://${bucket}/${key}`);
    } catch (err) {
      console.error('Failed to process SNS message:', err);
    }
  }
};
