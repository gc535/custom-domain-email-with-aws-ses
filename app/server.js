/**
 * Simple web app to send email via SES SMTP as your domain addresses.
 * Run locally: npm install && npm start. Protect with SEND_APP_SECRET if exposed.
 * Config: project root .env (copy from .env.example).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config(); // app/.env overrides

const express = require('express');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.SEND_APP_PORT || 3333;

const SMTP_HOST = process.env.SES_SMTP_HOST || `email-smtp.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`;
const SMTP_USER = process.env.SES_SMTP_USER;
const SMTP_PASS = process.env.SES_SMTP_PASS;
const DOMAIN_NAME = (process.env.DOMAIN_NAME || '').toLowerCase().replace(/^@/, '');
const SEND_APP_SECRET = process.env.SEND_APP_SECRET; // optional: require ?key=SECRET to access

// From dropdown and allowed senders: DOMAIN_NAME + FROM_LOCAL_PARTS (set in .env). If empty, any From is allowed (e.g. local use).
const FROM_LOCAL_PARTS = (process.env.FROM_LOCAL_PARTS || 'support,help').trim().split(/\s*,\s*/).filter(Boolean);
const FROM_ADDRESSES = DOMAIN_NAME ? FROM_LOCAL_PARTS.map((p) => `${p.trim()}@${DOMAIN_NAME}`) : [];

function checkAuth(req) {
  if (!SEND_APP_SECRET) return true;
  const key = req.query.key || req.body?.key;
  return key === SEND_APP_SECRET;
}

function normalizeEmails(input) {
  if (!input || typeof input !== 'string') return [];
  return input
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

function isAllowedFrom(from) {
  if (!from || typeof from !== 'string') return false;
  const addr = from.trim().toLowerCase();
  if (!addr.includes('@')) return false;
  if (FROM_ADDRESSES.length === 0) return true; // no config → allow any (local use)
  return FROM_ADDRESSES.includes(addr);
}

/**
 * Extract data:image/...;base64,... from HTML, convert to cid attachments
 * so images display in email clients. Returns { html, attachments }.
 */
function inlineImagesAsAttachments(html) {
  if (!html || typeof html !== 'string') return { html: html || '', attachments: [] };
  const attachments = [];
  let index = 0;
  const htmlOut = html.replace(
    /<img[^>]+src=["'](data:image\/(\w+);base64,([^"']+))["'][^>]*>/gi,
    (match, _dataUrl, ext, base64) => {
      const cid = `img${++index}_${Date.now()}`;
      attachments.push({
        filename: `image${index}.${ext}`,
        content: Buffer.from(base64, 'base64'),
        cid,
      });
      return match.replace(/src=["']data:image\/[^"']+["']/, `src="cid:${cid}"`);
    }
  );
  return { html: htmlOut, attachments };
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '6mb' })); // allow embedded base64 images in HTML
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).send('Missing or invalid key. Use ?key=YOUR_SECRET');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/config', (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Missing or invalid key' });
  }
  res.json({
    fromAddresses: FROM_ADDRESSES,
    domain: DOMAIN_NAME || null,
  });
});

app.post('/send', async (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid key' });
  }

  const from = (req.body.from || '').trim();
  const toInput = (req.body.to || '').trim();
  const subject = (req.body.subject || '').trim();
  const text = (req.body.text || '').trim();
  const html = (req.body.html || '').trim();

  if (!from || !toInput) {
    return res.status(400).json({ ok: false, error: 'From and at least one To address are required' });
  }
  if (!isAllowedFrom(from)) {
    return res.status(400).json({
      ok: false,
      error: FROM_ADDRESSES.length ? `From must be one of: ${FROM_ADDRESSES.join(', ')}` : 'Invalid From address',
    });
  }

  const toList = normalizeEmails(toInput);
  if (toList.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid To address(es)' });
  }

  if (!SMTP_USER || !SMTP_PASS) {
    return res.status(500).json({ ok: false, error: 'SES SMTP not configured (SES_SMTP_USER, SES_SMTP_PASS)' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: 587,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: true },
    });

    const { html: htmlFinal, attachments } = html ? inlineImagesAsAttachments(html) : { html: '', attachments: [] };

    const mailOptions = {
      from,
      to: toList.join(', '),
      subject: subject || '(no subject)',
      text: text || '(no plain text)',
      ...(htmlFinal ? { html: htmlFinal } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    await transporter.sendMail(mailOptions);
    res.json({ ok: true, message: 'Email sent' });
  } catch (err) {
    console.error('Send failed:', err);
    res.status(500).json({ ok: false, error: err.message || 'Send failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Send app at http://localhost:${PORT}/`);
  if (SEND_APP_SECRET) console.log('Access with ?key=YOUR_SECRET');
});
