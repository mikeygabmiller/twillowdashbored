/**
 * Mikey's Detailing SMS dashboard — API + Twilio webhooks (Netlify Function v2).
 *
 * Public webhooks:  /submit /sms /call /voicemail /voicemail-done
 * Dashboard API:    /api/health /api/threads /api/thread
 *                   /api/send /api/meta /api/schedule /api/unschedule
 *                   /api/call /api/read
 */

import {
  store, loadIndex, loadThread, saveThread, updateIndexEntry, appendMessage,
  sendSms, placeBridgeCall, normalizePhone, genId,
} from '../lib/core.mjs';

export const config = {
  path: ['/submit', '/sms', '/call', '/voicemail', '/voicemail-done', '/api/*'],
};

export default async function handler(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname.startsWith('/.netlify/functions/')) {
    const original = request.headers.get('x-nf-original-path') || request.headers.get('x-forwarded-url') || '';
    if (original) { try { pathname = new URL(original, url.origin).pathname; } catch { /* keep */ } }
  }

  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

  try {
    if (request.method === 'POST' && pathname === '/submit')         return handleSubmit(request);
    if (request.method === 'POST' && pathname === '/sms')            return handleInboundSms(request);
    if (request.method === 'POST' && pathname === '/call')           return handleInboundCall(request);
    if (request.method === 'POST' && pathname === '/voicemail')      return handleVoicemail(request);
    if (request.method === 'POST' && pathname === '/voicemail-done') return handleVoicemailDone(request);

    if (request.method === 'GET'  && pathname === '/api/health')     return apiHealth();
    if (request.method === 'GET'  && pathname === '/api/threads')    return apiThreads();
    if (request.method === 'GET'  && pathname === '/api/thread')     return apiThread(url);
    if (request.method === 'POST' && pathname === '/api/send')       return apiSend(request);
    if (request.method === 'POST' && pathname === '/api/meta')       return apiMeta(request);
    if (request.method === 'POST' && pathname === '/api/schedule')   return apiSchedule(request);
    if (request.method === 'POST' && pathname === '/api/unschedule') return apiUnschedule(request);
    if (request.method === 'POST' && pathname === '/api/call')       return apiCall(request);
    if (request.method === 'POST' && pathname === '/api/read')       return apiRead(request);

    return json({ ok: true, message: 'Mikeys SMS backend running.', seenPath: pathname }, 200);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 500);
  }
}

// ===========================================================================
// Public webhooks
// ===========================================================================
async function handleSubmit(request) {
  let body;
  try { body = await request.json(); } catch { return cors(json({ ok: false, error: 'bad_json' }, 400)); }

  const { name, phone, email, location, total, vehicle, condition, services, notes } = body;
  if (!name || !phone) return cors(json({ ok: false, error: 'missing_fields' }, 422));
  const clientPhone = normalizePhone(phone);
  if (!clientPhone) return cors(json({ ok: false, error: 'bad_phone' }, 422));

  const serviceList = Array.isArray(services) ? services.join(', ') : (services || '');
  const quoteLine = total ? `$${total}` : 'TBD';

  const clientMsg = [
    `Hey ${name.split(' ')[0]}! 👋 Got your quote request — Mikey's Mobile Detailing.`,
    `Your estimate: ${quoteLine}`,
    vehicle ? `Vehicle: ${vehicle}` : null,
    serviceList ? `Services: ${serviceList}` : null,
    `Mikey will text you back shortly to confirm. Reply here anytime!`,
  ].filter(Boolean).join('\n');

  const mikeyMsg = [
    `🔔 NEW QUOTE — ${name}`, `Phone: ${clientPhone}`,
    email ? `Email: ${email}` : null, location ? `City: ${location}` : null,
    `Quote: ${quoteLine}`, vehicle ? `Vehicle: ${vehicle}` : null,
    condition ? `Condition: ${condition}` : null, serviceList ? `Services: ${serviceList}` : null,
    notes ? `Notes: ${notes}` : null, ``, `Open the dashboard to reply to ${name.split(' ')[0]}.`,
  ].filter((s) => s !== null).join('\n');

  const [r1, r2] = await Promise.allSettled([
    sendSms(clientPhone, clientMsg),
    sendSms(process.env.MIKEY_PHONE, mikeyMsg),
  ]);

  // Start the conversation, tag as a new lead, store form details as a note.
  const thread = await loadThread(clientPhone);
  if (!thread.name) thread.name = name;
  if (!thread.status) thread.status = 'new';
  const detail = [
    vehicle ? `Vehicle: ${vehicle}` : null, condition ? `Condition: ${condition}` : null,
    serviceList ? `Services: ${serviceList}` : null, `Quote: ${quoteLine}`,
    email ? `Email: ${email}` : null, location ? `City: ${location}` : null,
    notes ? `Notes: ${notes}` : null,
  ].filter(Boolean).join('\n');
  if (detail && !thread.notes) thread.notes = `Quote request (${new Date().toLocaleDateString()}):\n${detail}`;
  thread.messages.push({ id: genId(), dir: 'out', body: clientMsg, ts: Date.now(), kind: 'auto' });
  await saveThread(thread);
  await updateIndexEntry(thread);

  const ok = r1.status === 'fulfilled' && r2.status === 'fulfilled';
  return cors(json({ ok, clientSms: r1.status, mikeySms: r2.status }, ok ? 200 : 207));
}

async function handleInboundSms(request) {
  const form = await request.formData();
  const from = form.get('From') || '';
  const text = form.get('Body') || '';
  const numMedia = parseInt(form.get('NumMedia') || '0', 10);
  const fromNorm = normalizePhone(from) || from;
  if (fromNorm === normalizePhone(process.env.MIKEY_PHONE)) return twiml('');

  await appendMessage(fromNorm, {
    dir: 'in',
    body: text + (numMedia > 0 ? `\n[${numMedia} attachment(s)]` : ''),
    ts: Date.now(),
  });
  await sendSms(process.env.MIKEY_PHONE,
    `📱 New text from ${from}:\n"${text}"\n\nReply in your dashboard.`).catch(() => {});
  return twiml('Got it! Mikey will get back to you soon. 🚗✨');
}

async function handleInboundCall(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/voicemail" method="POST"><Number>${escapeXml(mikeyPhone)}</Number></Dial>
</Response>`;
  sendSms(mikeyPhone, `📞 Incoming call from ${from} to your Mikey's Detailing number.`).catch(() => {});
  return xmlResponse(xml);
}

async function handleVoicemail(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const dialStatus = form.get('DialCallStatus') || '';
  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';
  if (dialStatus === 'completed') return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hey, you've reached Mikey's Mobile Detailing. Leave a message and Mikey will text or call you right back.</Say>
  <Record maxLength="120" action="/voicemail-done" method="POST" playBeep="true" />
</Response>`;
  sendSms(mikeyPhone, `📵 Missed call from ${from} — they're leaving a voicemail now.`).catch(() => {});
  return xmlResponse(xml);
}

async function handleVoicemailDone(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const recordingUrl = form.get('RecordingUrl') || '';
  const duration = form.get('RecordingDuration') || '?';
  const mikeyPhone = normalizePhone(process.env.MIKEY_PHONE) || '+13607975831';
  if (recordingUrl) {
    await sendSms(mikeyPhone, `🎙️ Voicemail from ${from} (${duration}s):\n${recordingUrl}.mp3`).catch(() => {});
  }
  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ===========================================================================
// Dashboard API
// ===========================================================================
async function apiHealth() {
  let blobs = 'ok';
  try { await store().get('__health__'); }
  catch (e) { blobs = 'error: ' + String((e && e.message) || e); }
  return json({
    ok: true, routing: 'function-reached',
    env: {
      TWILIO_ACCOUNT_SID: Boolean(process.env.TWILIO_ACCOUNT_SID),
      TWILIO_AUTH_TOKEN: Boolean(process.env.TWILIO_AUTH_TOKEN),
      TWILIO_FROM: process.env.TWILIO_FROM || null,
      MIKEY_PHONE: process.env.MIKEY_PHONE || null,
    }, blobs,
  });
}

async function apiThreads() {
  const index = await loadIndex();
  index.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastTs || 0) - (a.lastTs || 0));
  return json({ ok: true, threads: index });
}

async function apiThread(url) {
  const phone = normalizePhone(url.searchParams.get('phone')) || url.searchParams.get('phone');
  if (!phone) return json({ ok: false, error: 'missing_phone' }, 422);
  const thread = await loadThread(phone);
  if (thread.unread) { thread.unread = 0; await saveThread(thread); await updateIndexEntry(thread); }
  return json({ ok: true, thread });
}

async function apiSend(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  const body = (data.body || '').trim();
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  if (!body) return json({ ok: false, error: 'empty_message' }, 422);
  await sendSms(phone, body);
  const thread = await appendMessage(phone, { dir: 'out', body, ts: Date.now(), kind: 'manual' });
  return json({ ok: true, thread });
}

async function apiMeta(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  if (typeof data.name === 'string') thread.name = data.name.trim();
  if (Array.isArray(data.tags)) thread.tags = data.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (typeof data.status === 'string') thread.status = data.status;
  if (typeof data.notes === 'string') thread.notes = data.notes;
  if (typeof data.pinned === 'boolean') thread.pinned = data.pinned;
  if (typeof data.archived === 'boolean') thread.archived = data.archived;
  await saveThread(thread);
  await updateIndexEntry(thread);
  return json({ ok: true, thread });
}

async function apiSchedule(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  const body = (data.body || '').trim();
  const sendAt = Number(data.sendAt);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  if (!body) return json({ ok: false, error: 'empty_message' }, 422);
  if (!sendAt || sendAt < Date.now() - 60000) return json({ ok: false, error: 'bad_time' }, 422);
  const thread = await loadThread(phone);
  thread.scheduled.push({ id: genId(), body, sendAt });
  thread.scheduled.sort((a, b) => a.sendAt - b.sendAt);
  await saveThread(thread);
  await updateIndexEntry(thread);
  return json({ ok: true, thread });
}

async function apiUnschedule(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  thread.scheduled = (thread.scheduled || []).filter((s) => s.id !== data.id);
  await saveThread(thread);
  await updateIndexEntry(thread);
  return json({ ok: true, thread });
}

async function apiCall(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  await placeBridgeCall(phone);
  return json({ ok: true });
}

async function apiRead(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  thread.unread = data.read === false ? 1 : 0;
  await saveThread(thread);
  await updateIndexEntry(thread);
  return json({ ok: true });
}

// ===========================================================================
// Helpers
// ===========================================================================
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function twiml(message) {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return xmlResponse(xml);
}
function xmlResponse(xml) { return new Response(xml, { headers: { 'Content-Type': 'text/xml' } }); }
function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return r;
}
