const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const BRIDGE_KEY = String(process.env.BRIDGE_KEY || '');
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '');
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '');
const TWILIO_PHONE_NUMBER = String(process.env.TWILIO_PHONE_NUMBER || '');
const STORE_PATH = path.resolve(process.env.MESSAGE_STORE_PATH || path.join(__dirname, 'messages.json'));
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 200);

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function requireBridgeKey(req, res) {
  if (!BRIDGE_KEY) return true;
  const header = String(req.headers.authorization || '');
  if (header === `Bearer ${BRIDGE_KEY}`) return true;
  sendJson(res, 401, { error: 'Unauthorized' });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (_) {
    return [];
  }
}

function writeStore(messages) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(messages.slice(0, MAX_MESSAGES), null, 2));
}

function upsertMessage(entry) {
  const existing = readStore();
  const filtered = existing.filter(message => message.id !== entry.id);
  filtered.unshift(entry);
  filtered.sort((a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime());
  writeStore(filtered);
}

function parseFormEncoded(raw) {
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function normalizeStoredMessage(message) {
  return {
    id: String(message.id || message.sid || `${message.from || message.to}-${message.receivedAt || Date.now()}`),
    sid: String(message.sid || message.id || ''),
    from: String(message.from || ''),
    to: String(message.to || ''),
    body: String(message.body || ''),
    direction: String(message.direction || 'inbound'),
    contactName: String(message.contactName || message.from || message.to || 'SMS Contact'),
    unread: Boolean(message.unread),
    receivedAt: message.receivedAt || new Date().toISOString()
  };
}

async function handleIncomingWebhook(req, res) {
  const raw = await readBody(req);
  const form = parseFormEncoded(raw);
  const now = new Date().toISOString();
  const entry = normalizeStoredMessage({
    id: form.MessageSid || `${form.From || 'unknown'}-${now}`,
    sid: form.MessageSid || '',
    from: form.From || '',
    to: form.To || TWILIO_PHONE_NUMBER,
    body: form.Body || '',
    direction: 'inbound',
    contactName: form.ProfileName || form.From || 'SMS Contact',
    unread: true,
    receivedAt: now
  });
  upsertMessage(entry);
  sendText(res, 200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'text/xml; charset=utf-8');
}

async function handleSend(req, res) {
  if (!requireBridgeKey(req, res)) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    sendJson(res, 500, { error: 'Missing Twilio credentials' });
    return;
  }
  const raw = await readBody(req);
  const payload = JSON.parse(raw || '{}');
  const to = String(payload.to || '').trim();
  const body = String(payload.body || '').trim();
  const from = String(payload.from || TWILIO_PHONE_NUMBER || '').trim();
  if (!to || !body || !from) {
    sendJson(res, 400, { error: 'Expected to, body, and from' });
    return;
  }

  const twilioBody = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: twilioBody
  });
  const twilioData = await twilioRes.json();
  if (!twilioRes.ok) {
    sendJson(res, twilioRes.status, { error: twilioData.message || 'Twilio send failed', details: twilioData });
    return;
  }

  const entry = normalizeStoredMessage({
    id: twilioData.sid,
    sid: twilioData.sid,
    from,
    to,
    body,
    direction: 'outbound-api',
    contactName: to,
    unread: false,
    receivedAt: twilioData.date_created ? new Date(twilioData.date_created).toISOString() : new Date().toISOString()
  });
  upsertMessage(entry);
  sendJson(res, 200, { ok: true, sid: twilioData.sid });
}

async function handleMessages(req, res) {
  if (!requireBridgeKey(req, res)) return;
  const messages = readStore().map(normalizeStoredMessage);
  sendJson(res, 200, { messages });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/twilio/messages') {
      await handleMessages(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/twilio/send') {
      await handleSend(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/twilio/incoming') {
      await handleIncomingWebhook(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Twilio bridge listening on http://localhost:${PORT}`);
});
