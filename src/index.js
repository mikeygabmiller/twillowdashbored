/**
 * Mikey's Detailing — SMS dashboard, Cloudflare Worker.
 *
 * Ported from the Netlify Functions version. Same features, same dashboard,
 * same JSON API — the only differences are platform plumbing:
 *   - Storage: Netlify Blobs  ->  Cloudflare KV (binding: MESSAGES)
 *   - Secrets: process.env.X  ->  env.X  (Worker secrets / vars)
 *   - Cron:    Netlify schedule -> Cloudflare Cron Trigger (scheduled handler)
 *   - Static dashboard (public/index.html) served via Workers static assets.
 *
 * Public webhooks:  /submit /sms /call /voicemail /voicemail-done
 * Dashboard API:    /api/health /api/threads /api/thread /api/send /api/meta
 *                   /api/schedule /api/unschedule /api/call /api/read
 *                   /api/insights /api/ai/summary /api/ai/draft /api/ai/triage
 *
 * Required secrets (wrangler secret put ...):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, MIKEY_PHONE
 *   GEMINI_API_KEY        (optional — only the AI endpoints need it)
 *   GEMINI_MODEL          (optional — defaults to gemini-2.0-flash)
 * Required KV binding: MESSAGES
 */

// env is identical across every request of a deployment (bindings + secrets
// don't change per request), so stashing it in module scope is safe even under
// concurrency. Each invocation sets it before doing any work.
let ENV = null;
function kv() { return ENV.MESSAGES; }

export default {
  async fetch(request, env) {
    ENV = env;
    try {
      return await handle(request);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ENV = env;
    ctx.waitUntil(dispatchDueScheduled());
  },
};

// ===========================================================================
// Router
// ===========================================================================
async function handle(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

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

  // Static assets (the dashboard at "/") are served by Cloudflare's asset
  // layer before the Worker, so anything reaching here is an unknown route.
  return json({ ok: true, message: 'Mikeys SMS backend running.', seenPath: pathname }, 200);
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
    sendSms(ENV.MIKEY_PHONE, mikeyMsg),
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
  if (fromNorm === normalizePhone(ENV.MIKEY_PHONE)) return twiml('');

  await appendMessage(fromNorm, {
    dir: 'in',
    body: text + (numMedia > 0 ? `\n[${numMedia} attachment(s)]` : ''),
    ts: Date.now(),
  });
  await sendSms(ENV.MIKEY_PHONE,
    `📱 New text from ${from}:\n"${text}"\n\nReply in your dashboard.`).catch(() => {});
  return twiml('Got it! Mikey will get back to you soon. 🚗✨');
}

async function handleInboundCall(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const mikeyPhone = normalizePhone(ENV.MIKEY_PHONE) || '+13607975831';
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
  const mikeyPhone = normalizePhone(ENV.MIKEY_PHONE) || '+13607975831';
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
  const mikeyPhone = normalizePhone(ENV.MIKEY_PHONE) || '+13607975831';
  if (recordingUrl) {
    await sendSms(mikeyPhone, `🎙️ Voicemail from ${from} (${duration}s):\n${recordingUrl}.mp3`).catch(() => {});
  }
  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// ===========================================================================
// Dashboard API
// ===========================================================================
async function apiHealth() {
  let storage = 'ok';
  try { await kv().get('__health__'); }
  catch (e) { storage = 'error: ' + String((e && e.message) || e); }
  return json({
    ok: true, routing: 'worker-reached',
    env: {
      TWILIO_ACCOUNT_SID: Boolean(ENV.TWILIO_ACCOUNT_SID),
      TWILIO_AUTH_TOKEN: Boolean(ENV.TWILIO_AUTH_TOKEN),
      TWILIO_FROM: ENV.TWILIO_FROM || null,
      MIKEY_PHONE: ENV.MIKEY_PHONE || null,
    }, storage,
  });
}

async function apiThreads(url) {
  const index = await loadIndex();
  index.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastTs || 0) - (a.lastTs || 0));

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
// Storage model (Cloudflare KV)
// ===========================================================================
const INDEX_KEY = 'threads-index';
const threadKey = (phone) => `thread:${phone}`;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function blankThread(phone) {
  return {
    phone,
    name: '',
    tags: [],
    status: '',        // '', 'new', 'active', 'won', 'lost'
    notes: '',
    pinned: false,
    archived: false,
    unread: 0,
    appointmentAt: null,
    linked: [],
    messages: [],      // { id, dir:'in'|'out', body, ts, kind, error? }
    scheduled: [],     // { id, body, sendAt }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function loadThread(phone) {
  const raw = await kv().get(threadKey(phone), { type: 'json' });
  return Object.assign(blankThread(phone), raw || {});
}

async function saveThread(thread) {
  thread.updatedAt = Date.now();
  await kv().put(threadKey(thread.phone), JSON.stringify(thread));
}

async function loadIndex() {
  return (await kv().get(INDEX_KEY, { type: 'json' })) || [];
}

async function saveIndex(index) {
  await kv().put(INDEX_KEY, JSON.stringify(index));
}

function preview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

async function updateIndexEntry(thread) {
  const index = await loadIndex();
  const last = thread.messages[thread.messages.length - 1];
  const summary = {
    phone: thread.phone,
    name: thread.name || '',
    tags: thread.tags || [],
    status: thread.status || '',
    pinned: !!thread.pinned,
    archived: !!thread.archived,
    unread: thread.unread || 0,
    scheduledCount: (thread.scheduled || []).length,
    lastBody: last ? preview(last.body) : '',
    lastDir: last ? last.dir : '',
    lastTs: last ? last.ts : (thread.updatedAt || Date.now()),
  };
  const i = index.findIndex((t) => t.phone === thread.phone);
  if (i >= 0) index[i] = summary;
  else index.push(summary);
  await saveIndex(index);
}

async function appendMessage(phone, message, opts = {}) {
  const thread = await loadThread(phone);
  if (opts.name && !thread.name) thread.name = opts.name;
  message.id = message.id || genId();
  message.ts = message.ts || Date.now();
  thread.messages.push(message);
  if (message.dir === 'in') thread.unread = (thread.unread || 0) + 1;
  await saveThread(thread);
  await updateIndexEntry(thread);
  return thread;
}

// ===========================================================================
// Analytics helpers
// ===========================================================================
function computeReplyStats(messages) {
  let total = 0, count = 0, pending = null;
  for (const m of (messages || [])) {
    if (m.dir === 'in') { if (pending == null) pending = m.ts; }
    else if (m.dir === 'out' && pending != null) { total += (m.ts - pending); count++; pending = null; }
  }
  return { avgMs: count ? Math.round(total / count) : null, count, awaiting: pending != null, awaitingSince: pending };
}

function transcript(thread, max = 40) {
  return (thread.messages || []).slice(-max)
    .map((m) => `${m.dir === 'in' ? 'Customer' : 'Mikey'}: ${String(m.body || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// ===========================================================================
// Gemini (Google Generative Language API)
// ===========================================================================
async function geminiGenerate(prompt, opts = {}) {
  const key = ENV.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = ENV.GEMINI_MODEL || 'gemini-2.0-flash';
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature == null ? 0.4 : opts.temperature,
      maxOutputTokens: opts.maxTokens || 1024,
    },
  };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// ===========================================================================
// Twilio
// ===========================================================================
async function sendSms(to, body) {
  const sid = ENV.TWILIO_ACCOUNT_SID;
  const token = ENV.TWILIO_AUTH_TOKEN;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: ENV.TWILIO_FROM, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return res.json();
}

// Click-to-call: ring Mikey's cell, then bridge the call to the customer.
async function placeBridgeCall(customer) {
  const sid = ENV.TWILIO_ACCOUNT_SID;
  const token = ENV.TWILIO_AUTH_TOKEN;
  const from = ENV.TWILIO_FROM;
  const twimlXml =
    `<Response><Say voice="alice">Connecting your call.</Say>` +
    `<Dial callerId="${escapeXml(from)}">${escapeXml(customer)}</Dial></Response>`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: ENV.MIKEY_PHONE, From: from, Twiml: twimlXml }),
  });
  if (!res.ok) throw new Error(`Twilio call ${res.status}: ${await res.text()}`);
  return res.json();
}

function normalizePhone(raw) {
  if (!raw) return null;
  if (/^\+1\d{10}$/.test(raw)) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

// ===========================================================================
// Scheduled-send dispatch (cron every 5 min — see wrangler.toml [triggers])
// ===========================================================================
async function dispatchDueScheduled(now = Date.now()) {
  const index = await loadIndex();
  let sent = 0;
  for (const entry of index) {
    if (!entry.scheduledCount) continue;
    const thread = await loadThread(entry.phone);
    const due = (thread.scheduled || []).filter((s) => s.sendAt <= now);
    if (!due.length) continue;
    thread.scheduled = (thread.scheduled || []).filter((s) => s.sendAt > now);
    for (const s of due) {
      try {
        await sendSms(thread.phone, s.body);
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled' });
        sent++;
      } catch (err) {
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled', error: String(err.message || err) });
      }
    }
    await saveThread(thread);
    await updateIndexEntry(thread);
  }
  return sent;
}

// ===========================================================================
// HTTP helpers
// ===========================================================================
async function readJson(request) { try { return await request.json(); } catch { return {}; } }

function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
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
