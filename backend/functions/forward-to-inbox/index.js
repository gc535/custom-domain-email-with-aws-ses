/**
 * Lambda: triggered when SES delivers a raw email to S3 (shared bucket, key pattern <domain>/emails/...).
 * Derives domain from the S3 key, looks up forward-to inbox from SSM /domain-email/inbox/<domain>, then forwards.
 * - From: the address that received the email (e.g. support@domain) so you can sort and reply as that address.
 * - Reply-To: original sender so Reply in your client goes to the right person.
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { simpleParser } = require('mailparser');

const s3 = new S3Client();
const ses = new SESClient();
const ssm = new SSMClient();

/** Get the first recipient address that belongs to our domain (To or Cc). */
function getReceivedAtAddress(parsed, domain) {
  const normDomain = (domain || '').toLowerCase();
  const collect = (field) => {
    const v = parsed[field]?.value;
    return Array.isArray(v) ? v.map((x) => x?.address).filter(Boolean) : [];
  };
  const addresses = [...collect('to'), ...collect('cc')];
  return addresses.find((addr) => (addr || '').toLowerCase().endsWith('@' + normDomain)) || null;
}

/** Build a short plain-text summary of the original message (From, To, Cc, Date, Subject). */
function buildSummaryText(parsed) {
  const from = parsed.from?.text || '(unknown)';
  const to = parsed.to?.text || (parsed.to?.value?.map((x) => x?.address).filter(Boolean).join(', ') || '(none)');
  const ccRaw = parsed.cc?.value;
  const cc = ccRaw?.length ? parsed.cc.text || ccRaw.map((x) => x?.address).filter(Boolean).join(', ') : '(none)';
  const date = parsed.date ? parsed.date.toUTCString() : '(no date)';
  const subject = parsed.subject || '(no subject)';
  const lines = [
    '--- Original message ---',
    `From: ${from}`,
    `To: ${to}`,
    `Cc: ${cc}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    '------------------------',
    '',
  ];
  return lines.join('\r\n');
}

/** Build the same summary as a small HTML block. */
function buildSummaryHtml(parsed) {
  const from = parsed.from?.text || '(unknown)';
  const to = parsed.to?.text || (parsed.to?.value?.map((x) => x?.address).filter(Boolean).join(', ') || '(none)');
  const ccRaw = parsed.cc?.value;
  const cc = ccRaw?.length ? (parsed.cc.text || ccRaw.map((x) => x?.address).filter(Boolean).join(', ')) : '(none)';
  const date = parsed.date ? parsed.date.toUTCString() : '(no date)';
  const subject = parsed.subject || '(no subject)';
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    '<div style="margin-bottom:1em;padding:0.6em;background:#f5f5f5;border-left:3px solid #888;font-family:monospace;font-size:12px;line-height:1.4;">' +
    '<div><strong>Original message</strong></div>' +
    `<div>From: ${escape(from)}</div>` +
    `<div>To: ${escape(to)}</div>` +
    `<div>Cc: ${escape(cc)}</div>` +
    `<div>Date: ${escape(date)}</div>` +
    `<div>Subject: ${escape(subject)}</div>` +
    '</div>'
  );
}

/** Derive domain from S3 key: <domain>/emails/<rest> -> domain; skip keys not under <domain>/emails/. */
function domainFromKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split('/').filter(Boolean);
  if (parts.length < 2 || parts[1] !== 'emails') return null;
  return parts[0];
}

/** Get forward-to inbox for domain from SSM /domain-email/inbox/<domain> */
async function getInboxForDomain(domain) {
  if (!domain) return null;
  const name = `/domain-email/inbox/${domain}`;
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: name }));
    return Parameter?.Value?.trim() || null;
  } catch (err) {
    if (err.name === 'ParameterNotFound') return null;
    throw err;
  }
}

exports.handler = async (event) => {
  const bucket = process.env.INBOUND_BUCKET;
  const configurationSetName = process.env.CONFIGURATION_SET_NAME;

  if (!bucket) {
    console.error('Missing INBOUND_BUCKET');
    throw new Error('Configuration error');
  }

  for (const record of event.Records || []) {
    if (record.s3?.bucket?.name !== bucket) continue;

    const key = decodeURIComponent((record.s3.object?.key || '').replace(/\+/g, ' '));
    if (!key) continue;

    const domain = domainFromKey(key);
    if (!domain) {
      console.warn('Skipping key (could not derive domain):', key);
      continue;
    }

    const forwardTo = await getInboxForDomain(domain);
    if (!forwardTo) {
      console.error('No inbox configured for domain:', domain, '(SSM /domain-email/inbox/<domain>)');
      throw new Error(`No inbox for domain: ${domain}`);
    }

    try {
      const { Body } = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const raw = await streamToBuffer(Body);

      const parsed = await simpleParser(raw, { skipImageLinks: true });
      const from = parsed.from?.text || 'unknown@unknown';
      const fromAddress = parsed.from?.value?.[0]?.address || null;
      const subject = parsed.subject || '(no subject)';
      const date = parsed.date ? parsed.date.toUTCString() : new Date().toUTCString();
      const text = parsed.text || '(no plain text)';
      const html = parsed.html || null;

      const receivedAt = getReceivedAtAddress(parsed, domain);
      const forwardFromAddress = receivedAt || `forward@${domain}`;
      const localPart = (forwardFromAddress.split('@')[0] || 'forward').replace(/[^a-z0-9]/gi, '') || 'forward';
      const forwardFrom = `${localPart.charAt(0).toUpperCase() + localPart.slice(1).toLowerCase()} <${forwardFromAddress}>`;

      const forwardSubject = subject.toLowerCase().startsWith('fwd:')
        ? subject
        : `Fwd: ${subject}`;
      const subjectWithTag = receivedAt
        ? `[${receivedAt}] ${forwardSubject}`
        : forwardSubject;

      const summaryText = buildSummaryText(parsed);
      const summaryHtml = buildSummaryHtml(parsed);

      const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const headers = [
        `From: ${forwardFrom}`,
        ...(fromAddress ? [`Reply-To: ${fromAddress}`] : []),
        `To: ${forwardTo}`,
        `Subject: ${subjectWithTag}`,
        `Date: ${date}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        summaryText,
        `---------- Forwarded message ---------`,
        `From: ${from}`,
        `Date: ${date}`,
        `Subject: ${subject}`,
        '',
        text,
        '',
      ];

      if (html) {
        headers.push(
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          '',
          summaryHtml + html,
          ''
        );
      }
      headers.push(`--${boundary}--`);

      const rawMessage = headers.join('\r\n');
      const msg = Buffer.from(rawMessage, 'utf-8');

      const sendParams = {
        Source: forwardFromAddress,
        Destinations: [forwardTo],
        RawMessage: { Data: msg },
      };
      if (configurationSetName) sendParams.ConfigurationSetName = configurationSetName;
      await ses.send(new SendRawEmailCommand(sendParams));

      console.log(`Forwarded to ${forwardTo}: ${subject}`);
    } catch (err) {
      console.error(`Failed to forward S3 object ${key}:`, err);
      throw err;
    }
  }
};

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
