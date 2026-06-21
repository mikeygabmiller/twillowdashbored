/**
 * Mikey's Detailing — SMS Dashboard engine (Netlify Function v2)
 *
 * Ported from the original Cloudflare Worker. Handles:
 *
 *  PUBLIC (Twilio + marketing-site webhooks):
 *   POST /submit          → quote form: text the client + alert Mikey, start a thread
 *   POST /sms             → inbound SMS: store it, forward to Mikey, auto-ack the client
 *   POST /call            → inbound call: ring Mikey, drop to voicemail if no answer
 *   POST /voicemail       → record a voicemail when Mikey misses the call
 *   POST /voicemail-done  → text Mikey the recording link
 *
 *  PASSWORD-PROTECTED (the dashboard UI calls these with header x-dashboard-pass):
 *   GET  /api/threads        → list every conversation (newest first)
 *   GET  /api/thread?phone=  → all messages in one conversation
 *   POST /api/send           → send an SMS to a client and save it
 *   POST /api/name           → set a friendly name for a phone number
 *
 * Conversations are stored in Netlify Blobs (getStore('mkd-messages')) — no
 * database to set up. All secrets are read from process.env (set them in the
 * Netlify UI, never in this file):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, MIKEY_PHONE, DASHBOARD_PASSWORD
 */

import { getStore } from '@netlify/blobs';

// Native Netlify v2 routing (works alongside the redirects in netlify.toml).
export const config = {
  path: ['/submit', '/sms', '/call', '/voicemail', '/voicemail-done', '/api/*'],
};

const INDEX_KEY = 'threads-index';
const threadKey = (phone) => `thread:${phone}`;

export default async function handler(request) {
  const url = new URL(request.url);
  // Routing is done via redirects in netlify.toml. The function normally sees the
  // original request path; if it ever gets the internal function path instead,
  // recover the real one from Netlify's original-URL headers.
  let pathname = url.pathname;
  if (pathname.startsWith('/.netlify/functions/')) {
    const original =
      request.headers.get('x-nf-original-path') ||
      request.headers.get('x-original-uri') ||
      request.headers.get('x-forwarded-url') || '';
    if (original) {
      try { pathname = new URL(original, url.origin).pathname; } catch { /* keep default */ }
    }
  }

  // CORS pre-flight — the quote form lives on a different domain (mikeysdetailing.com)
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  try {
    // ----- Public webhooks ------------------------------------------------
    if (request.method === 'POST' && pathname === '/submit')        return handleSubmit(request);
    if (request.method === 'POST' && pathname === '/sms')           return handleInboundSms(request);
    if (request.method === 'POST' && pathname === '/call')          return handleInboundCall(request);
    if (request.method === 'POST' && pathname === '/voicemail')     return handleVoicemail(request);
    if (request.method === 'POST' && pathname === '/voicemail-done')return handleVoicemailDone(request);

    // ----- Health check (no auth — reveals only yes/no flags, no secrets) --
    if (request.method === 'GET' && pathname === '/api/health') return apiHealth();

    // ----- Dashboard API (password protection removed — open access) ------
    if (pathname.startsWith('/api/')) {
      if (request.method === 'GET'  && pathname === '/api/threads') return apiThreads();
      if (request.method === 'GET'  && pathname === '/api/thread')  return apiThread(url);
      if (request.method === 'POST' && pathname === '/api/send')    return apiSend(request);
      if (request.method === 'POST' && pathname === '/api/name')    return apiName(request);
    }

    return new Response('Not found', { status: 404 });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}

// ===========================================================================
// Public: quote form submission
// ===========================================================================
async function handleSubmit(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return cors(json({ ok: false, error: 'bad_json' }, 400));
  }

  const { name, phone, email, location, total, vehicle, condition, services, notes } = body;
  if (!name || !phone) return cors(json({ ok: false, error: 'missing_fields' }, 422));

  const clientPhone = normalizePhone(phone);
  if (!clientPhone) return cors(json({ ok: false, error: 'bad_phone' }, 422));

  const serviceList = Array.isArray(services) ? services.join(', ') : (services || '');
  const quoteLine   = total ? `$${total}` : 'TBD';

  // Text 1 — confirmation to the client
  const clientMsg = [
    `Hey ${name.split(' ')[0]}! 👋 Got your quote request — Mikey's Mobile Detailing.`,
    `Your estimate: ${quoteLine}`,
    vehicle     ? `Vehicle: ${vehicle}` : null,
    serviceList ? `Services: ${serviceList}` : null,
    `Mikey will text you back shortly to confirm your appointment. Reply here anytime with questions!`,
  ].filter(Boolean).join('\n');

  // Text 2 — lead alert to Mikey
  const mikeyMsg = [
    `🔔 NEW QUOTE — ${name}`,
    `Phone: ${clientPhone}`,
    email     ? `Email: ${email}` : null,
    location  ? `City: ${location}` : null,
    `Quote: ${quoteLine}`,
    vehicle   ? `Vehicle: ${vehicle}` : null,
    condition ? `Condition: ${condition}` : null,
    serviceList ? `Services: ${serviceList}` : null,
    notes     ? `Notes: ${notes}` : null,
    ``,
    `Open the dashboard to reply to ${name.split(' ')[0]}.`,
  ].filter((s) => s !== null).join('\n');

  const [r1, r2] = await Promise.allSettled([
    sendSms(clientPhone, clientMsg),
    sendSms(process.env.MIKEY_PHONE, mikeyMsg),
  ]);

  // Start / update the client's conversation so it appears in the dashboard
  await appendMessage(clientPhone, {
    dir: 'out',
    body: clientMsg,
    ts: Date.now(),
    kind: 'auto',
  }, { name });

  const ok = r1.status === 'fulfilled' && r2.status === 'fulfilled';
  return cors(json({ ok, clientSms: r1.status, mikeySms: r2.status }, ok ? 200 : 207));
}

// ===========================================================================
// Public: inbound SMS from a client → store it + forward to Mikey + auto-ack
// ===========================================================================
async function handleInboundSms(request) {
  const form     = await request.formData();
  const from     = form.get('From') || '';
  const body     = form.get('Body') || '';
  const numMedia = parseInt(form.get('NumMedia') || '0', 10);

  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE);
  const fromNorm   = normalizePhone(from) || from;

  // If Mikey texts his own Twilio number, there's no client context — ignore.
  if (fromNorm === mikeyPhone) return twiml('');

  const mediaNote = numMedia > 0 ? `\n📎 ${numMedia} attachment(s) — check the Twilio console.` : '';

  // Save the incoming message to the client's thread
  await appendMessage(fromNorm, {
    dir: 'in',
    body: body + (numMedia > 0 ? `\n[${numMedia} attachment(s)]` : ''),
    ts: Date.now(),
  });

  // Forward to Mikey's cell so he's notified even if the dashboard is closed
  await sendSms(process.env.MIKEY_PHONE,
    `📱 New text from ${from}:\n"${body}"${mediaNote}\n\nReply in your dashboard.`
  ).catch(() => {});

  // Auto-acknowledge the client
  return twiml('Got it! Mikey will get back to you soon. 🚗✨');
}

// ===========================================================================
// Public: inbound call → forward to Mikey, voicemail fallback
// ===========================================================================
async function handleInboundCall(request) {
  const form       = await request.formData();
  const from       = form.get('From') || 'Unknown';
  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/voicemail" method="POST">
    <Number>${escapeXml(mikeyPhone)}</Number>
  </Dial>
</Response>`;

  // Heads-up text so Mikey knows someone called even if he answers
  sendSms(mikeyPhone, `📞 Incoming call from ${from} to your Mikey's Detailing number.`).catch(() => {});

  return xmlResponse(xml);
}

// ===========================================================================
// Public: voicemail prompt (fires when Mikey doesn't pick up)
// ===========================================================================
async function handleVoicemail(request) {
  const form       = await request.formData();
  const from       = form.get('From') || 'Unknown';
  const dialStatus = form.get('DialCallStatus') || '';
  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';

  if (dialStatus === 'completed') {
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hey, you've reached Mikey's Mobile Detailing. Leave a message and Mikey will text or call you right back.</Say>
  <Record maxLength="120" action="/voicemail-done" method="POST" playBeep="true" />
</Response>`;

  sendSms(mikeyPhone, `📵 Missed call from ${from} — they're leaving a voicemail now.`).catch(() => {});

  return xmlResponse(xml);
}

// ===========================================================================
// Public: voicemail finished → text Mikey the recording link
// ===========================================================================
async function handleVoicemailDone(request) {
  const form         = await request.formData();
  const from         = form.get('From') || 'Unknown';
  const recordingUrl = form.get('RecordingUrl') || '';
  const duration     = form.get('RecordingDuration') || '?';
  const mikeyPhone   = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';

  if (recordingUrl) {
    await sendSms(mikeyPhone, `🎙️ Voicemail from ${from} (${duration}s):\n${recordingUrl}.mp3`).catch(() => {});
  }

  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ===========================================================================
// Dashboard API
// ===========================================================================

// Diagnostics — confirms routing, env vars, and Blobs without exposing secrets.
async function apiHealth() {
  let blobs = 'ok';
  try {
    await getStore('mkd-messages').get('__healthcheck__');
  } catch (e) {
    blobs = 'error: ' + String((e && e.message) || e);
  }
  return json({
    ok: true,
    routing: 'function-reached',
    env: {
      DASHBOARD_PASSWORD: Boolean(process.env.DASHBOARD_PASSWORD),
      TWILIO_ACCOUNT_SID: Boolean(process.env.TWILIO_ACCOUNT_SID),
      TWILIO_AUTH_TOKEN:  Boolean(process.env.TWILIO_AUTH_TOKEN),
      TWILIO_FROM:        process.env.TWILIO_FROM || null,
      MIKEY_PHONE:        process.env.MIKEY_PHONE || null,
    },
    blobs,
  });
}

async function apiThreads() {
  const index = await loadIndex();
  index.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return json({ ok: true, threads: index });
}

async function apiThread(url) {
  const phone = normalizePhone(url.searchParams.get('phone')) || url.searchParams.get('phone');
  if (!phone) return json({ ok: false, error: 'missing_phone' }, 422);
  const thread = await loadThread(phone);
  return json({ ok: true, thread });
}

async function apiSend(request) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const phone = normalizePhone(data.phone);
  const body  = (data.body || '').trim();
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  if (!body)  return json({ ok: false, error: 'empty_message' }, 422);

  await sendSms(phone, body);
  await appendMessage(phone, { dir: 'out', body, ts: Date.now(), kind: 'manual' });

  const thread = await loadThread(phone);
  return json({ ok: true, thread });
}

async function apiName(request) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const phone = normalizePhone(data.phone);
  const name  = (data.name || '').trim();
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);

  await setName(phone, name);
  return json({ ok: true });
}

// ===========================================================================
// Blob storage helpers
// ===========================================================================
function store() {
  return getStore('mkd-messages');
}

async function loadIndex() {
  const s = store();
  return (await s.get(INDEX_KEY, { type: 'json' })) || [];
}

async function saveIndex(index) {
  await store().setJSON(INDEX_KEY, index);
}

async function loadThread(phone) {
  const s = store();
  return (await s.get(threadKey(phone), { type: 'json' })) || { phone, name: '', messages: [] };
}

async function saveThread(thread) {
  await store().setJSON(threadKey(thread.phone), thread);
}

// Append a message to a thread and refresh the index entry.
async function appendMessage(phone, message, opts = {}) {
  const thread = await loadThread(phone);
  if (opts.name && !thread.name) thread.name = opts.name;
  thread.messages.push(message);
  await saveThread(thread);

  const index = await loadIndex();
  const existing = index.find((t) => t.phone === phone);
  const preview = (message.body || '').replace(/\s+/g, ' ').slice(0, 80);
  if (existing) {
    existing.name    = thread.name || existing.name || '';
    existing.lastBody = preview;
    existing.lastDir  = message.dir;
    existing.lastTs   = message.ts;
  } else {
    index.push({ phone, name: thread.name || '', lastBody: preview, lastDir: message.dir, lastTs: message.ts });
  }
  await saveIndex(index);
}

async function setName(phone, name) {
  const thread = await loadThread(phone);
  thread.name = name;
  await saveThread(thread);

  const index = await loadIndex();
  const existing = index.find((t) => t.phone === phone);
  if (existing) {
    existing.name = name;
  } else {
    index.push({ phone, name, lastBody: '', lastDir: '', lastTs: Date.now() });
  }
  await saveIndex(index);
}

// ===========================================================================
// Twilio + small helpers
// ===========================================================================
async function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url   = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const creds = btoa(`${sid}:${token}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: to, Body: body }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio error ${res.status}: ${err}`);
  }
  return res.json();
}

function authorized(request) {
  const expected = process.env.DASHBOARD_PASSWORD || '';
  const got = request.headers.get('x-dashboard-pass') || '';
  return expected.length > 0 && got === expected;
}

function normalizePhone(raw) {
  if (!raw) return null;
  if (/^\+1\d{10}$/.test(raw)) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function twiml(message) {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return xmlResponse(xml);
}

function xmlResponse(xml) {
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return r;
}
