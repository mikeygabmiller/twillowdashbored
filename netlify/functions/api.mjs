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
  computeReplyStats, transcript, geminiGenerate,
} from '../lib/core.mjs';

export const config = {
  path: ['/submit', '/sms', '/call', '/voicemail', '/voicemail-done', '/api/*', '/api/ai/*'],
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
    if (request.method === 'GET'  && pathname === '/api/threads')    return apiThreads(url);
    if (request.method === 'GET'  && pathname === '/api/thread')     return apiThread(url);
    if (request.method === 'POST' && pathname === '/api/send')       return apiSend(request);
    if (request.method === 'POST' && pathname === '/api/meta')       return apiMeta(request);
    if (request.method === 'POST' && pathname === '/api/schedule')   return apiSchedule(request);
    if (request.method === 'POST' && pathname === '/api/unschedule') return apiUnschedule(request);
    if (request.method === 'POST' && pathname === '/api/call')       return apiCall(request);
    if (request.method === 'POST' && pathname === '/api/read')       return apiRead(request);
    if (request.method === 'GET'  && pathname === '/api/insights')   return apiInsights();
    if (request.method === 'POST' && pathname === '/api/ai/summary') return apiAiSummary(request);
    if (request.method === 'POST' && pathname === '/api/ai/draft')   return apiAiDraft(request);
    if (request.method === 'POST' && pathname === '/api/ai/triage')  return apiAiTriage();

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

  const { name, phone, email, location, total, vehicle, condition, services, notes, smsConsent } = body;
  // Only auto-text the client if they ticked the SMS consent box on the form
  // (A2P/compliance). Mikey's lead alert + the dashboard lead always go through.
  const consent = smsConsent === true || smsConsent === 'true';
  if (!name || !phone) return cors(json({ ok: false, error: 'missing_fields' }, 422));
  const clientPhone = normalizePhone(phone);
  if (!clientPhone) return cors(json({ ok: false, error: 'bad_phone' }, 422));

  const serviceList = Array.isArray(services) ? services.join(', ') : (services || '');
  const quoteLine = total ? `$${total}` : 'TBD';

  const clientMsg =
    `Hey ${name.split(' ')[0]}, it's Mikey. I got your quote submission on my site. ` +
    `Whenever you have a minute, feel free to send over the year, make, and model of the car ` +
    `you'd like detailed, and I'll confirm that price. Talk soon!`;

  const mikeyMsg = [
    `🔔 NEW QUOTE — ${name}`, `Phone: ${clientPhone}`,
    email ? `Email: ${email}` : null, location ? `City: ${location}` : null,
    `Quote: ${quoteLine}`, vehicle ? `Vehicle: ${vehicle}` : null,
    condition ? `Condition: ${condition}` : null, serviceList ? `Services: ${serviceList}` : null,
    notes ? `Notes: ${notes}` : null, ``, `Open the dashboard to reply to ${name.split(' ')[0]}.`,
  ].filter((s) => s !== null).join('\n');

  const [r1, r2] = await Promise.allSettled([
    consent ? sendSms(clientPhone, clientMsg) : Promise.resolve({ skipped: true }),
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
  // Record the auto-text in the thread only if we actually sent it.
  if (consent) thread.messages.push({ id: genId(), dir: 'out', body: clientMsg, ts: Date.now(), kind: 'auto' });
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
  // No auto-reply to the customer — Mikey replies personally from the dashboard.
  return twiml('');
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

async function apiThreads(url) {
  const index = await loadIndex();
  index.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastTs || 0) - (a.lastTs || 0));

  // Optionally include the currently-open thread in the same response so the
  // dashboard can poll with ONE function call instead of two (saves invocations).
  const want = url && url.searchParams.get('phone');
  if (!want) return json({ ok: true, threads: index });

  const phone = normalizePhone(want) || want;
  const thread = await loadThread(phone);
  if (thread.unread) { thread.unread = 0; await saveThread(thread); await updateIndexEntry(thread); }
  return json({ ok: true, threads: index, thread });
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
  if ('appointmentAt' in data) {
    const a = Number(data.appointmentAt);
    thread.appointmentAt = (data.appointmentAt == null || !a) ? null : a;
  }
  if (Array.isArray(data.linked)) {
    thread.linked = [...new Set(data.linked.map((p) => normalizePhone(p) || p).filter(Boolean))]
      .filter((p) => p !== thread.phone).slice(0, 20);
  }
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
// Insights + AI (Gemini)
// ===========================================================================
async function apiInsights() {
  const index = await loadIndex();
  let totalMs = 0, replyCount = 0;
  const needsReply = [];
  const byName = {};

  for (const e of index) {
    if (e.archived) continue;
    const thread = await loadThread(e.phone);
    const st = computeReplyStats(thread.messages);
    if (st.avgMs != null) { totalMs += st.avgMs * st.count; replyCount += st.count; }

    const last = thread.messages[thread.messages.length - 1];
    if (last && last.dir === 'in') {
      needsReply.push({ phone: e.phone, name: e.name || '', lastBody: e.lastBody || '', since: last.ts, status: e.status || '' });
    }
    const nm = (e.name || '').trim().toLowerCase();
    if (nm) { (byName[nm] = byName[nm] || []).push({ phone: e.phone, name: e.name }); }
  }
  needsReply.sort((a, b) => a.since - b.since);

  // Possible duplicate customers: same name across different numbers.
  const possibleLinks = Object.values(byName).filter((g) => g.length > 1);

  const open = index.filter((e) => !e.archived).length;
  const won = index.filter((e) => e.status === 'won').length;
  return json({
    ok: true,
    avgReplyMs: replyCount ? Math.round(totalMs / replyCount) : null,
    replyCount, open, won,
    needsReply, possibleLinks,
  });
}

async function apiAiSummary(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  if (!thread.messages.length) return json({ ok: false, error: 'no_messages' }, 422);
  const prompt =
    `You are the assistant for Mikey's Mobile Detailing (a car detailing business). ` +
    `Read this SMS conversation and return ONLY JSON with this shape:\n` +
    `{"summary": "2-3 sentence plain-English overview of who this is and where things stand", ` +
    `"status": one of "new","active","won","lost" or "", ` +
    `"tags": array of up to 4 short labels like "Truck","Ceramic","VIP","Quote sent","Needs follow-up"}\n\n` +
    `Conversation:\n${transcript(thread)}`;
  try {
    const text = await geminiGenerate(prompt, { json: true, maxTokens: 800 });
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = { summary: text }; }
    return json({
      ok: true,
      summary: String(parsed.summary || '').trim(),
      status: ['new', 'active', 'won', 'lost'].includes(parsed.status) ? parsed.status : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4) : [],
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

async function apiAiDraft(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  const hint = (data.hint || '').trim();
  const prompt =
    `You are Mikey replying to a customer by text for Mikey's Mobile Detailing. ` +
    `Write ONE friendly, professional reply (1-3 short complete sentences, no greeting line, no signature, ready to send). ` +
    `Finish every sentence — do not cut off mid-thought. ` +
    (hint ? `Goal of this reply: ${hint}. ` : '') +
    `\n\nConversation so far:\n${transcript(thread)}\n\nReply:`;
  try {
    const text = await geminiGenerate(prompt, { temperature: 0.7, maxTokens: 400 });
    return json({ ok: true, draft: text.replace(/^["']|["']$/g, '').trim() });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

async function apiAiTriage() {
  const index = await loadIndex();
  const open = index.filter((e) => !e.archived);
  if (!open.length) return json({ ok: true, briefing: 'No open conversations. All clear! 🚗' });
  const now = Date.now();
  const lines = open.map((e) => {
    const ago = humanAgo(now - (e.lastTs || now));
    const who = e.lastDir === 'in' ? `WAITING ${ago} for reply` : `you replied ${ago} ago`;
    return `- ${e.name || e.phone} [${e.status || 'no status'}] ${who}: "${e.lastBody || ''}"`;
  }).join('\n');
  const prompt =
    `You are the operations assistant for Mikey's Mobile Detailing. Below are the open SMS threads. ` +
    `Give a short, prioritized action list (max 6 bullets) of who to reply to first and the suggested next step. ` +
    `Customers who are WAITING for a reply are top priority; longest waits first. Be concise and practical. ` +
    `Keep each bullet to one complete sentence and finish your final bullet.\n\n${lines}`;
  try {
    const briefing = await geminiGenerate(prompt, { maxTokens: 1200 });
    return json({ ok: true, briefing });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

function humanAgo(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
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
