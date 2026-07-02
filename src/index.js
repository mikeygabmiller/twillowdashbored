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
 *   RESEND_API_KEY        (optional — email alerts instead of texting yourself)
 *   ALERT_EMAIL           (optional — where alerts go; defaults to nothing)
 *   ALERT_FROM            (optional — verified sender; defaults to Resend's)
 * Required KV binding: MESSAGES
 */

// env is identical across every request of a deployment (bindings + secrets
// don't change per request), so stashing it in module scope is safe even under
// concurrency. Each invocation sets it before doing any work.
let ENV = null;
// Per-invocation cache of the KV `config` doc so a single request/cron tick
// doesn't re-read it for every thread it touches. Cleared at the top of each
// entry point so a settings change is picked up on the very next invocation.
let CFG_CACHE = null;
function kv() { return ENV.MESSAGES; }

export default {
  async fetch(request, env) {
    ENV = env; CFG_CACHE = null;
    try {
      return await handle(request);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ENV = env; CFG_CACHE = null;
    ctx.waitUntil(runCron());
  },
};

// The minute cron does two jobs: deliver any due scheduled sends, then advance
// the auto follow-up engine (surface nudges + fire autopilot sends).
async function runCron() {
  await dispatchDueScheduled();
  await evaluateFollowups();
}

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

  if (request.method === 'POST' && pathname === '/api/login')      return apiLogin(request);
  if (request.method === 'POST' && pathname === '/api/logout')     return apiLogout();
  // Everything else under /api/ requires the dashboard password (once one is set).
  if (pathname.startsWith('/api/') && !(await isAuthed(request)))   return json({ ok: false, error: 'unauthorized' }, 401);

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
  if (request.method === 'POST' && pathname === '/api/alert-test') return apiAlertTest();
  if (request.method === 'GET'  && pathname === '/api/followups')  return apiFollowups();
  if (request.method === 'POST' && pathname === '/api/followup')   return apiFollowupAction(request);
  if (request.method === 'GET'  && pathname === '/api/config')     return apiGetConfig();
  if (request.method === 'POST' && pathname === '/api/config')     return apiSaveConfig(request);
  if (request.method === 'GET'  && pathname === '/api/migrate')    return apiMigrate(url);
  if (request.method === 'GET'  && pathname === '/api/templates')  return apiGetTemplates();
  if (request.method === 'POST' && pathname === '/api/templates')  return apiSaveTemplates(request);
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

  // Hold the customer's first auto-reply for a few minutes so it reads like Mikey
  // personally texting back, not an instant bot. Mikey's own lead alert still goes
  // out immediately below.
  const FIRST_REACHOUT_DELAY_MS = 210000; // 3.5 minutes

  const mikeyAlert = await notifyMikey(`🔔 New quote — ${name}`, mikeyMsg);

  // Start the conversation, tag as a new lead, store form details as a note.
  const thread = await loadThread(clientPhone);
  if (!thread.name) thread.name = name;
  if (!thread.status) { thread.status = 'new'; thread.statusAt = thread.statusAt || Date.now(); }
  const detail = [
    vehicle ? `Vehicle: ${vehicle}` : null, condition ? `Condition: ${condition}` : null,
    serviceList ? `Services: ${serviceList}` : null, `Quote: ${quoteLine}`,
    email ? `Email: ${email}` : null, location ? `City: ${location}` : null,
    notes ? `Notes: ${notes}` : null,
  ].filter(Boolean).join('\n');
  if (detail && !thread.notes) thread.notes = `Quote request (${new Date().toLocaleDateString()}):\n${detail}`;
  // Queue the first reach-out (if they consented) instead of sending it now. The
  // scheduled-send cron delivers it ~3.5 min later and records it in the thread;
  // until then it shows as "scheduled to send" so Mikey can cancel and reply himself.
  let clientSms = 'skipped';
  if (consent) {
    thread.scheduled.push({ id: genId(), body: clientMsg, sendAt: Date.now() + FIRST_REACHOUT_DELAY_MS });
    thread.scheduled.sort((a, b) => a.sendAt - b.sendAt);
    clientSms = 'scheduled';
  }
  await saveThread(thread);
  await updateIndexEntry(thread);

  const ok = mikeyAlert;
  return cors(json({ ok, clientSms, mikeyAlert }, ok ? 200 : 207));
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
  await notifyMikey(`📱 New text from ${from}`,
    `New text from ${from}:\n"${text}"\n\nReply in your dashboard.`);
  // No auto-reply to the customer — Mikey replies personally from the dashboard.
  return twiml('');
}

async function handleInboundCall(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const mikeyPhone = normalizePhone(ENV.MIKEY_PHONE) || '+13607975831';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/voicemail" method="POST"><Number>${escapeXml(mikeyPhone)}</Number></Dial>
</Response>`;
  notifyMikey(`📞 Incoming call from ${from}`, `Incoming call from ${from} to your Mikey's Detailing number.`).catch(() => {});
  return xmlResponse(xml);
}

async function handleVoicemail(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const dialStatus = form.get('DialCallStatus') || '';
  if (dialStatus === 'completed') return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hey, you've reached Mikey's Mobile Detailing. Leave a message and Mikey will text or call you right back.</Say>
  <Record maxLength="120" action="/voicemail-done" method="POST" playBeep="true" />
</Response>`;
  notifyMikey(`📵 Missed call from ${from}`, `Missed call from ${from} — they're leaving a voicemail now.`).catch(() => {});
  return xmlResponse(xml);
}

async function handleVoicemailDone(request) {
  const form = await request.formData();
  const from = form.get('From') || 'Unknown';
  const recordingUrl = form.get('RecordingUrl') || '';
  const duration = form.get('RecordingDuration') || '?';
  if (recordingUrl) {
    await notifyMikey(`🎙️ Voicemail from ${from}`, `Voicemail from ${from} (${duration}s):\n${recordingUrl}.mp3`);
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
  // Credential SHAPE diagnostic — reports whether the Twilio creds look valid
  // (prefix / length / stray whitespace) WITHOUT ever exposing the secret values.
  const sid = ENV.TWILIO_ACCOUNT_SID || '';
  const token = ENV.TWILIO_AUTH_TOKEN || '';
  const from = ENV.TWILIO_FROM || '';
  const twilio = {
    sidPresent: !!sid,
    sidPrefix: sid.slice(0, 2),                 // should be "AC"
    sidLen: sid.length,                         // should be 34
    sidLooksValid: /^AC[0-9a-f]{32}$/i.test(sid),
    tokenPresent: !!token,
    tokenLen: token.length,                     // should be 32
    fromPresent: !!from,
    from,                                       // your Twilio number (not secret)
    mikeyPresent: !!ENV.MIKEY_PHONE,
    whitespaceInSid: /\s/.test(sid),
    whitespaceInToken: /\s/.test(token),
  };
  return json({
    ok: true, routing: 'worker-reached',
    env: {
      TWILIO_ACCOUNT_SID: Boolean(ENV.TWILIO_ACCOUNT_SID),
      TWILIO_AUTH_TOKEN: Boolean(ENV.TWILIO_AUTH_TOKEN),
      TWILIO_FROM: ENV.TWILIO_FROM || null,
      MIKEY_PHONE: ENV.MIKEY_PHONE || null,
    }, twilio, storage,
    alerts: {
      channel: (ENV.RESEND_API_KEY && ENV.ALERT_EMAIL) ? 'email' : 'sms',
      emailConfigured: Boolean(ENV.RESEND_API_KEY && ENV.ALERT_EMAIL),
      alertEmail: ENV.ALERT_EMAIL || null,
      alertFrom: ENV.ALERT_FROM || 'onboarding@resend.dev',
    },
  });
}

// Fire a test alert through the same path real notifications use, so Mikey can
// confirm email delivery from the dashboard without waiting for a real text.
async function apiAlertTest() {
  const ok = await notifyMikey(
    '✅ Test alert — Mikey\'s Dashboard',
    'This is a test alert from your dashboard. If you got this, inbound-text notifications are working.',
  );
  const channel = (ENV.RESEND_API_KEY && ENV.ALERT_EMAIL) ? 'email' : 'sms';
  return json({ ok, channel, alertEmail: ENV.ALERT_EMAIL || null });
}

async function apiThreads(url) {
  const want = url && url.searchParams.get('phone');
  if (!want) {
    const index = await loadIndex();
    index.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastTs || 0) - (a.lastTs || 0));
    return json({ ok: true, threads: index });
  }
  const phone = normalizePhone(want) || want;
  const thread = await openThreadForRead(phone);
  const index = await loadIndex();
  index.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastTs || 0) - (a.lastTs || 0));
  return json({ ok: true, threads: index, thread });
}

async function apiThread(url) {
  const phone = normalizePhone(url.searchParams.get('phone')) || url.searchParams.get('phone');
  if (!phone) return json({ ok: false, error: 'missing_phone' }, 422);
  const thread = await openThreadForRead(phone);
  return json({ ok: true, thread });
}

// Load a thread for display: clear its unread badge and make sure any due
// follow-up has a fresh, human-approval suggestion attached before we return it.
async function openThreadForRead(phone) {
  const cfg = await loadConfig();
  const thread = await loadThread(phone);
  let changed = false;
  if (thread.unread) { thread.unread = 0; changed = true; }
  if (thread.status && !thread.statusAt) { thread.statusAt = Date.now(); changed = true; }
  if (await ensureLiveSuggestion(thread, cfg, Date.now())) changed = true;
  if (changed) { await saveThread(thread); await updateIndexEntry(thread); }
  return thread;
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
  if (typeof data.status === 'string') {
    if (data.status !== thread.status) thread.statusAt = Date.now();
    thread.status = data.status;
  }
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
  // Twilio spend for the current calendar month (counts all threads, even archived).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let segOut = 0, msgsIn = 0;

  for (const e of index) {
    const thread = await loadThread(e.phone);
    for (const m of (thread.messages || [])) {
      if (!m.ts || m.ts < monthStart) continue;
      if (m.dir === 'out') segOut += Math.max(1, Math.ceil(String(m.body || '').length / 160));
      else if (m.dir === 'in') msgsIn += 1;
    }
    if (e.archived) continue;
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
  const RATE = 0.0079, NUMBER_FEE = 1.15;
  const costUsd = +(segOut * RATE + msgsIn * RATE + NUMBER_FEE).toFixed(2);
  return json({
    ok: true,
    avgReplyMs: replyCount ? Math.round(totalMs / replyCount) : null,
    replyCount, open, won,
    needsReply, possibleLinks,
    costMonth: { segOut, msgsIn, usd: costUsd },
  });
}

// One-time import of conversations from the old Netlify deployment into KV.
// The Worker can reach Netlify server-to-server, so visiting this URL once in a
// browser copies every thread over with full history. Safe to re-run.
//   GET /api/migrate            (defaults to the Netlify URL below)
//   GET /api/migrate?from=https://mikeysms.netlify.app
async function apiMigrate(url) {
  const src = (url.searchParams.get('from') || 'https://mikeysms.netlify.app').replace(/\/+$/, '');
  let summaries;
  try {
    const r = await fetch(`${src}/api/threads`);
    if (!r.ok) throw new Error(`threads ${r.status}`);
    const data = await r.json();
    summaries = data.threads || (Array.isArray(data) ? data : []);
  } catch (e) {
    return json({ ok: false, error: `could not read ${src}/api/threads: ${String((e && e.message) || e)}` }, 502);
  }

  let imported = 0, skipped = 0;
  const results = [];
  for (const s of summaries) {
    const phone = s && s.phone;
    if (!phone) { skipped++; continue; }
    try {
      const tr = await fetch(`${src}/api/thread?phone=${encodeURIComponent(phone)}`);
      if (!tr.ok) throw new Error(`thread ${tr.status}`);
      const td = await tr.json();
      const thread = td.thread || td;
      if (!thread || !thread.phone) { skipped++; results.push({ phone, error: 'no thread body' }); continue; }
      const merged = Object.assign(blankThread(phone), thread);
      await saveThread(merged);
      await updateIndexEntry(merged);
      imported++;
      results.push({ phone, name: merged.name || '', messages: (merged.messages || []).length });
    } catch (e) {
      skipped++;
      results.push({ phone, error: String((e && e.message) || e) });
    }
  }
  return json({ ok: true, source: src, imported, skipped, results });
}

// Custom quick-reply templates, stored per account in KV so they're shared
// across every device Mikey opens the dashboard on.
async function apiGetTemplates() {
  const tpl = await kv().get('templates', { type: 'json' });
  return json({ ok: true, templates: Array.isArray(tpl) ? tpl : [] });
}

async function apiSaveTemplates(request) {
  const data = await readJson(request);
  const list = Array.isArray(data.templates)
    ? data.templates
        .filter((x) => Array.isArray(x) && x.length >= 2 && String(x[1]).trim())
        .map((x) => [String(x[0]).slice(0, 40), String(x[1]).slice(0, 1000)])
        .slice(0, 50)
    : [];
  await kv().put('templates', JSON.stringify(list));
  return json({ ok: true, templates: list });
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
    const text = await geminiGenerate(prompt, { json: true, maxTokens: 1200 });
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
  const draftText = (data.text || '').trim();
  let prompt;
  if (draftText) {
    // Polish mode: clean up a reply Mikey already wrote, keep his meaning/voice.
    prompt =
      `You are Mikey from Mikey's Mobile Detailing, texting a customer. ` +
      `Polish the draft below so it reads clear, warm and professional: fix grammar, spelling and tone, ` +
      `keep it concise (1-3 short sentences), keep Mikey's friendly voice and the original meaning, ` +
      `no added greeting unless it's already there, no signature, ready to send. ` +
      `Return ONLY the polished message — no quotes, no preamble. ` +
      (hint ? `Also: ${hint}. ` : '') +
      `\n\nConversation so far (for context):\n${transcript(thread)}\n\nDraft to polish:\n${draftText}\n\nPolished message:`;
  } else {
    prompt =
      `You are Mikey replying to a customer by text for Mikey's Mobile Detailing. ` +
      `Write ONE friendly, professional reply (1-3 short complete sentences, no greeting line, no signature, ready to send). ` +
      `Finish every sentence — do not cut off mid-thought. ` +
      (hint ? `Goal of this reply: ${hint}. ` : '') +
      `\n\nConversation so far:\n${transcript(thread)}\n\nReply:`;
  }
  try {
    const text = await geminiGenerate(prompt, { temperature: 0.7, maxTokens: 800 });
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
    const briefing = await geminiGenerate(prompt, { maxTokens: 2000 });
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
// Auto follow-up engine
// ---------------------------------------------------------------------------
// A per-conversation state machine that decides WHEN a follow-up is due and
// WHAT to say, purely from context (who spoke last, how long ago, lead status).
// Timing is deterministic (cheap, reliable); the wording is AI-drafted for the
// suggest-and-approve path and template-based for hands-off autopilot sends.
// ===========================================================================
const FOLLOWUP = {
  OWED_DELAY_MS: 90 * 60 * 1000,          // surface "you owe a reply" ~90 min after the customer texts
  NUDGE_DELAYS_H: [24, 72, 168],          // escalating chase: 1st nudge +1d, 2nd +3d, 3rd +7d, then cold
  WON_REVIEW_MS: 24 * 60 * 60 * 1000,     // ask for a review ~1 day after a job is Won
  LOST_REVIVAL_MS: 30 * 24 * 60 * 60 * 1000, // revive a Lost lead ~30 days later
};

// Trailing count of outbound messages since the customer's last inbound. Drives
// the escalation: each unanswered outreach bumps the next nudge farther out.
function trailingOutStreak(msgs) {
  let n = 0;
  for (let i = (msgs || []).length - 1; i >= 0; i--) {
    if (msgs[i].dir === 'out') n++; else break;
  }
  return n;
}

// The heart of the system: given a conversation, return the single pending
// follow-up step (or null). Priority: a reply Mikey owes > Won/Lost lifecycle >
// chasing an unanswered outreach.
function computeFollowupPlan(thread, now, cfg) {
  const fu = thread.followup || {};
  if (cfg.followupsEnabled === false) return null;
  if (fu.enabled === false) return null;
  if (fu.snoozeUntil && fu.snoozeUntil > now) return null;

  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return null;                  // nothing has been said yet
  const status = thread.status || '';
  // A step whose key we've already sent/skipped is finished — don't resurface it
  // until the context moves on (a new message changes the key).
  const done = (p) => (p && p.stepKey === fu.lastStepKey) ? null : p;

  // 1) Mikey owes a reply — the customer texted last. Highest priority, never auto-sent.
  if (last.dir === 'in') {
    return done({ stage: 'owed', step: 0, stepKey: 'owed:' + last.ts, dueAt: last.ts + FOLLOWUP.OWED_DELAY_MS, urgency: 'high', auto: false });
  }

  // 2) Won lifecycle: review ask, then a rebook nudge months later.
  if (status === 'won') {
    const anchor = thread.statusAt || last.ts;
    if (fu.lastStepKey !== 'won:review' && fu.lastStepKey !== 'won:rebook') {
      return { stage: 'won', step: 1, stepKey: 'won:review', dueAt: anchor + FOLLOWUP.WON_REVIEW_MS, urgency: 'normal', auto: true };
    }
    if (fu.lastStepKey === 'won:review') {
      return { stage: 'won', step: 2, stepKey: 'won:rebook', dueAt: anchor + (cfg.rebookDays || 90) * 86400000, urgency: 'normal', auto: true };
    }
    return null; // review + rebook both done
  }

  // 3) Lost lifecycle: one revival attempt.
  if (status === 'lost') {
    if (fu.lastStepKey === 'lost:revival') return null;
    const anchor = thread.statusAt || last.ts;
    return { stage: 'lost', step: 1, stepKey: 'lost:revival', dueAt: anchor + FOLLOWUP.LOST_REVIVAL_MS, urgency: 'low', auto: true };
  }

  // 4) Chasing an unanswered outreach (last message was Mikey's).
  const streak = trailingOutStreak(msgs);
  if (streak >= 1 && streak <= FOLLOWUP.NUDGE_DELAYS_H.length) {
    const delayH = FOLLOWUP.NUDGE_DELAYS_H[streak - 1];
    return done({
      stage: 'nudge', step: streak, stepKey: 'nudge:' + streak + ':' + last.ts,
      dueAt: last.ts + delayH * 3600000, urgency: streak >= 3 ? 'low' : 'normal', auto: true,
    });
  }
  return null; // gone cold after the final nudge
}

// Whether a due step should send itself, given global + per-contact autopilot.
function autopilotAllowed(plan, fu, cfg) {
  if (!plan || !plan.auto) return false;
  if (fu.auto === true) return true;
  if (fu.auto === false) return false;
  return cfg.autopilot === true;
}

// ---- quiet hours (don't autopilot-text customers overnight) -----------------
function localHour(ts, tz) {
  try {
    const s = new Date(ts).toLocaleString('en-US', { timeZone: tz || 'America/Los_Angeles', hour12: false, hour: '2-digit' });
    return parseInt(s, 10) % 24;
  } catch { return new Date(ts).getUTCHours(); }
}
function inQuietHours(ts, cfg) {
  const qs = cfg.quietStart, qe = cfg.quietEnd;
  if (qs == null || qe == null) return false;
  const h = localHour(ts, cfg.tz);
  return (qs > qe) ? (h >= qs || h < qe) : (h >= qs && h < qe);
}

// ---- wording ---------------------------------------------------------------
function firstName(thread) {
  const n = (thread.name || '').trim().split(/\s+/)[0];
  return n || 'there';
}
// Plain-English "why now" shown to Mikey.
function followupReason(thread, plan) {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  const waited = last ? humanAgo(Date.now() - last.ts) : '';
  switch (plan.stage) {
    case 'owed': return `Customer has been waiting ${waited} for a reply`;
    case 'nudge':
      if (plan.step <= 1) return `No reply for ${waited} — a gentle check-in`;
      if (plan.step === 2) return `Still quiet after ${waited} — second nudge`;
      return `Going cold (${waited}) — one last soft touch`;
    case 'won':
      return plan.stepKey === 'won:rebook' ? `Won job — likely due for a rebook` : `Job won — good moment to ask for a review`;
    case 'lost': return `Lost lead — time for a revival check-in`;
    default: return 'Follow-up';
  }
}
// Deterministic wording used for autopilot sends and as the AI fallback.
function followupTemplate(thread, plan, cfg) {
  const name = firstName(thread);
  const review = cfg.reviewUrl ? (' ' + cfg.reviewUrl) : '';
  const months = Math.max(1, Math.round((cfg.rebookDays || 90) / 30));
  switch (plan.stage) {
    case 'owed':
      return `Hey ${name}, following up on your last message — let me get you an answer. What works best for you?`;
    case 'nudge':
      if (plan.step <= 1) return `Hey ${name}, just following up on your detail — happy to answer any questions or find a time that works. 🚗`;
      if (plan.step === 2) return `Hi ${name}, still glad to help whenever you're ready. If it's timing or price, let me know and I'll work with you.`;
      return `No worries if now's not the time, ${name} — I'll leave it here. Reach out anytime you'd like that detail. 👍`;
    case 'won':
      if (plan.stepKey === 'won:rebook') return `Hey ${name}! It's been about ${months} month${months > 1 ? 's' : ''} since your last detail — want me to get you back on the schedule?`;
      return `Thanks again ${name}! Hope the vehicle's still looking great. If you have 2 minutes, a quick review would mean the world:${review}`;
    case 'lost':
      return `Hey ${name}, circling back from Mikey's Mobile Detailing — happy to put together a fresh quote whenever you're ready. No pressure!`;
    default:
      return `Hey ${name}, just following up!`;
  }
}
// Build the actual message. Autopilot (ai:false) uses the template verbatim;
// the suggest-and-approve path polishes it with Gemini using the live transcript.
async function buildFollowupDraft(thread, plan, cfg, opts = {}) {
  const tmpl = followupTemplate(thread, plan, cfg);
  if (opts.ai === false || !ENV.GEMINI_API_KEY) return tmpl;

  let prompt;
  if (plan.stage === 'owed') {
    prompt =
      `You are Mikey from Mikey's Mobile Detailing, replying to a customer by text. ` +
      `Write ONE friendly, professional reply to their most recent message (1-3 short sentences, no greeting line, no signature, ready to send). ` +
      `Do not invent specific prices, dates, or appointment times — if one is needed, say you'll confirm. Finish every sentence.` +
      `\n\nConversation so far:\n${transcript(thread)}\n\nReply:`;
  } else {
    const goal = {
      'nudge:1': 'a warm, low-pressure first check-in on their detail',
      'nudge:2': 'a second gentle nudge that offers to help with timing or price',
      'nudge:3': 'a final soft touch that leaves the ball in their court',
      'won:review': 'a thank-you that asks for a quick online review',
      'won:rebook': 'a friendly note that it may be time to rebook a detail',
      'lost:revival': 'a no-pressure revival offering a fresh quote',
    }[`${plan.stage}:${plan.step}`] || `${plan.stage} follow-up`;
    prompt =
      `You are Mikey from Mikey's Mobile Detailing, texting a customer. ` +
      `Write ONE short, natural follow-up text (1-2 sentences, no greeting line unless natural, no signature, ready to send). ` +
      `Goal: ${goal}. ` +
      (plan.stepKey === 'won:review' && cfg.reviewUrl ? `End the message with this exact review link: ${cfg.reviewUrl} . ` : '') +
      `Do not invent specific prices, dates, or appointments. Finish every sentence.` +
      `\n\nConversation so far:\n${transcript(thread)}\n\nFollow-up text:`;
  }
  try {
    const t = (await geminiGenerate(prompt, { temperature: 0.7, maxTokens: 500 })).replace(/^["']|["']$/g, '').trim();
    return t || tmpl;
  } catch { return tmpl; }
}

function pushLog(fu, entry) {
  fu.log = fu.log || [];
  fu.log.push(entry);
  if (fu.log.length > 20) fu.log = fu.log.slice(-20);
}
function urgencyRank(u) { return u === 'high' ? 3 : u === 'normal' ? 2 : 1; }

// Make sure a due, human-approval step has a generated suggestion attached.
// Called on the single-thread read path so opening a conversation shows its
// nudge instantly (rather than waiting for the next cron tick). Returns whether
// the thread was mutated and needs saving.
async function ensureLiveSuggestion(thread, cfg, now) {
  const plan = computeFollowupPlan(thread, now, cfg);
  const fu = thread.followup || (thread.followup = defaultFollowup());
  let changed = false;
  if (fu.suggestion && (!plan || fu.suggestion.stepKey !== plan.stepKey)) { fu.suggestion = null; changed = true; }
  if (!plan || plan.dueAt > now) return changed;
  if (autopilotAllowed(plan, fu, cfg)) return changed;   // autopilot handles it; don't nag with a suggestion
  if (!fu.suggestion) {
    const draft = await buildFollowupDraft(thread, plan, cfg, { ai: true });
    fu.suggestion = {
      id: genId(), stage: plan.stage, step: plan.step || 0, stepKey: plan.stepKey,
      reason: followupReason(thread, plan), draft, urgency: plan.urgency, dueAt: plan.dueAt, createdAt: now,
    };
    changed = true;
  }
  return changed;
}

// Cron pass: walk the index, advance each conversation's follow-up. Uses the
// index's cached followupNextAt to skip conversations whose next step is still
// in the future, so a typical tick loads only the few threads actually due.
async function evaluateFollowups(now = Date.now()) {
  const cfg = await loadConfig();
  if (cfg.followupsEnabled === false) return 0;
  const index = await loadIndex();
  let acted = 0;
  for (const e of index) {
    if (e.archived) continue;
    if (e.followupNextAt && e.followupNextAt > now && !e.followupDue) continue; // not due, nothing pending

    const thread = await loadThread(e.phone);
    const fu = thread.followup || (thread.followup = defaultFollowup());
    // Legacy threads that had a status before this feature shipped have no
    // statusAt — anchor them to now so won/lost cadences start fresh, not in the past.
    if (thread.status && !thread.statusAt) thread.statusAt = now;
    const plan = computeFollowupPlan(thread, now, cfg);

    if (fu.suggestion && (!plan || fu.suggestion.stepKey !== plan.stepKey)) fu.suggestion = null; // stale
    if (!plan || plan.dueAt > now) { await saveThread(thread); await updateIndexEntry(thread); continue; }

    if (autopilotAllowed(plan, fu, cfg)) {
      if (inQuietHours(now, cfg)) { await saveThread(thread); await updateIndexEntry(thread); continue; } // wait for daytime
      // Reserve the step (persist lastStepKey) BEFORE sending, mirroring the
      // scheduled-send dispatcher, so an overlapping tick can't double-send.
      const body = followupTemplate(thread, plan, cfg);
      fu.lastStepKey = plan.stepKey; fu.lastActionAt = now; fu.suggestion = null;
      pushLog(fu, { at: now, stage: plan.stage, stepKey: plan.stepKey, action: 'auto-sent' });
      await saveThread(thread);
      try {
        await sendSms(thread.phone, body);
        thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'followup' });
      } catch (err) {
        thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'followup', error: String(err.message || err) });
      }
      await saveThread(thread); await updateIndexEntry(thread); acted++;
    } else if (!fu.suggestion) {
      const draft = await buildFollowupDraft(thread, plan, cfg, { ai: true });
      fu.suggestion = {
        id: genId(), stage: plan.stage, step: plan.step || 0, stepKey: plan.stepKey,
        reason: followupReason(thread, plan), draft, urgency: plan.urgency, dueAt: plan.dueAt, createdAt: now,
      };
      await saveThread(thread); await updateIndexEntry(thread); acted++;
    } else {
      await updateIndexEntry(thread);
    }
  }
  return acted;
}

// ---- follow-up API ---------------------------------------------------------
async function apiFollowups() {
  const cfg = await loadConfig();
  const index = await loadIndex();
  const items = index
    .filter((e) => !e.archived && e.followupDue && e.fu)
    .map((e) => ({ phone: e.phone, name: e.name || '', status: e.status || '', lastBody: e.lastBody || '', ...e.fu }))
    .sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency) || (a.dueAt || 0) - (b.dueAt || 0));
  return json({ ok: true, items, config: cfg });
}

async function apiFollowupAction(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const cfg = await loadConfig();
  const thread = await loadThread(phone);
  const fu = thread.followup || (thread.followup = defaultFollowup());
  const now = Date.now();
  const plan = computeFollowupPlan(thread, now, cfg);
  const action = data.action;

  if (action === 'send') {
    const body = (data.body || (fu.suggestion && fu.suggestion.draft) || '').trim();
    if (!body) return json({ ok: false, error: 'empty_message' }, 422);
    const stepKey = (fu.suggestion && fu.suggestion.stepKey) || (plan && plan.stepKey) || '';
    fu.lastStepKey = stepKey; fu.lastActionAt = now; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey, action: 'sent' });
    await saveThread(thread); // reserve before send
    try {
      await sendSms(phone, body);
      thread.messages.push({ id: genId(), dir: 'out', body, ts: now, kind: 'followup' });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 502);
    }
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'snooze') {
    const hours = Number(data.hours) || 24;
    fu.snoozeUntil = now + hours * 3600000; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey: (plan && plan.stepKey) || '', action: 'snoozed' });
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'skip') {
    const stepKey = (fu.suggestion && fu.suggestion.stepKey) || (plan && plan.stepKey) || '';
    fu.lastStepKey = stepKey; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey, action: 'skipped' });
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'off' || action === 'on') {
    fu.enabled = action === 'on';
    if (action === 'on') fu.snoozeUntil = null; else fu.suggestion = null;
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'auto') {
    fu.auto = data.auto === true ? true : (data.auto === false ? false : null);
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'regen') {
    if (!plan) return json({ ok: false, error: 'no_followup' }, 422);
    const draft = await buildFollowupDraft(thread, plan, cfg, { ai: true });
    fu.suggestion = {
      id: genId(), stage: plan.stage, step: plan.step || 0, stepKey: plan.stepKey,
      reason: followupReason(thread, plan), draft, urgency: plan.urgency, dueAt: plan.dueAt, createdAt: now,
    };
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread, suggestion: fu.suggestion });
  }
  return json({ ok: false, error: 'bad_action' }, 422);
}

async function apiGetConfig() {
  return json({ ok: true, config: await loadConfig() });
}
async function apiSaveConfig(request) {
  const data = await readJson(request);
  const next = Object.assign({}, await loadConfig());
  if (typeof data.followupsEnabled === 'boolean') next.followupsEnabled = data.followupsEnabled;
  if (typeof data.autopilot === 'boolean') next.autopilot = data.autopilot;
  if (typeof data.reviewUrl === 'string') next.reviewUrl = data.reviewUrl.slice(0, 300);
  if (data.rebookDays != null && !isNaN(+data.rebookDays)) next.rebookDays = Math.max(1, Math.min(365, Math.round(+data.rebookDays)));
  if (data.quietStart != null && !isNaN(+data.quietStart)) next.quietStart = Math.max(0, Math.min(23, Math.round(+data.quietStart)));
  if (data.quietEnd != null && !isNaN(+data.quietEnd)) next.quietEnd = Math.max(0, Math.min(23, Math.round(+data.quietEnd)));
  if (typeof data.tz === 'string' && data.tz) next.tz = data.tz.slice(0, 64);
  await kv().put('config', JSON.stringify(next));
  CFG_CACHE = next;
  return json({ ok: true, config: next });
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
    statusAt: 0,       // when status last changed (anchor for won/lost cadences)
    notes: '',
    pinned: false,
    archived: false,
    unread: 0,
    appointmentAt: null,
    linked: [],
    messages: [],      // { id, dir:'in'|'out', body, ts, kind, error? }
    scheduled: [],     // { id, body, sendAt }
    followup: defaultFollowup(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// Per-conversation follow-up state. `auto` is a tri-state override of the global
// autopilot setting: true = always auto-send this contact's nudges, false = never,
// null = inherit the global default.
function defaultFollowup() {
  return {
    enabled: true,
    auto: null,
    snoozeUntil: null,
    lastStepKey: '',   // the cadence step we last sent/skipped, so we don't repeat it
    lastActionAt: 0,
    suggestion: null,  // the live nudge awaiting Mikey: { id, stage, step, stepKey, reason, draft, urgency, dueAt, createdAt }
    log: [],           // recent actions: { at, stage, stepKey, action }
  };
}

function defaultConfig() {
  return {
    followupsEnabled: true,  // global master switch for the whole engine
    autopilot: false,        // when true, safe nudges send themselves at the due time
    reviewUrl: '',           // Google review link, dropped into the review-ask nudge
    rebookDays: 90,          // days after a Won job to suggest a rebook
    quietStart: 20,          // 8pm — no autopilot sends after this local hour…
    quietEnd: 8,             // …until 8am (suggestions still surface anytime)
    tz: 'America/Los_Angeles',
  };
}

async function loadConfig() {
  if (CFG_CACHE) return CFG_CACHE;
  const raw = await kv().get('config', { type: 'json' });
  CFG_CACHE = Object.assign(defaultConfig(), raw || {});
  return CFG_CACHE;
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
  const cfg = await loadConfig();
  const plan = computeFollowupPlan(thread, Date.now(), cfg);
  const fu = thread.followup || {};
  // Only mirror a suggestion the current plan still agrees with — if the customer
  // just replied, the old nudge is stale and the badge should clear immediately.
  const sug = (fu.suggestion && plan && fu.suggestion.stepKey === plan.stepKey) ? fu.suggestion : null;
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
    followupNextAt: plan ? plan.dueAt : null,
    followupDue: !!sug,
    fu: sug ? { reason: sug.reason, urgency: sug.urgency, stage: sug.stage, dueAt: sug.dueAt, draft: (sug.draft || '').slice(0, 320) } : null,
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
  const model = ENV.GEMINI_MODEL || 'gemini-2.5-flash';
  const gen = {
    temperature: opts.temperature == null ? 0.4 : opts.temperature,
    maxOutputTokens: opts.maxTokens || 1024,
  };
  if (opts.json) gen.responseMimeType = 'application/json';
  // Gemini 2.5 models "think" by default, and those hidden thinking tokens are
  // spent out of maxOutputTokens — which was truncating replies mid-sentence
  // (and sometimes leaving nothing at all). These are short, direct tasks, so
  // turn thinking off and give the whole budget to the actual answer.
  if (/2\.5|thinking/i.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: gen };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const cand = (data.candidates || [])[0] || {};
  const parts = ((cand.content || {}).parts) || [];
  let text = parts.map((p) => p.text || '').join('').trim();
  // Safety net: if the model still bumped the token ceiling, drop a dangling
  // partial sentence so the user never sees a chopped-off half-word. (Not for
  // JSON responses — trimming those would corrupt the payload.)
  if (!opts.json && cand.finishReason === 'MAX_TOKENS' && text) {
    const m = text.match(/^[\s\S]*[.!?…"”')\]]/);
    if (m && m[0].length > 40) text = m[0].trim();
  }
  return text;
}

// ===========================================================================
// Alerts to Mikey (email preferred, SMS fallback)
// ===========================================================================
// Every "heads up, something happened" alert goes through here. If Resend is
// configured we email it (free) instead of paying Twilio to text ourselves.
// SMS is the automatic fallback when email isn't set up or the send fails, so
// an alert always lands somewhere. Returns true if any channel succeeded.
async function notifyMikey(subject, body) {
  if (ENV.RESEND_API_KEY && ENV.ALERT_EMAIL) {
    try { await sendEmail(subject, body); return true; }
    catch { /* fall through to SMS so the alert still reaches Mikey */ }
  }
  try { await sendSms(ENV.MIKEY_PHONE, body); return true; }
  catch { return false; }
}

// Send an alert email via Resend (https://resend.com). Plain text is plenty for
// a phone notification. ALERT_FROM must be a Resend-verified sender; until a
// domain is verified, Resend only allows onboarding@resend.dev -> your own
// account email, which is exactly the single-recipient case here.
async function sendEmail(subject, text) {
  const to = ENV.ALERT_EMAIL;
  const from = ENV.ALERT_FROM || 'Mikeys Dashboard <onboarding@resend.dev>';
  if (!to) throw new Error('ALERT_EMAIL not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ENV.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
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
// Scheduled-send dispatch (cron every minute — see wrangler.toml [triggers])
// ===========================================================================
async function dispatchDueScheduled(now = Date.now()) {
  const index = await loadIndex();
  let sent = 0;
  for (const entry of index) {
    if (!entry.scheduledCount) continue;
    const thread = await loadThread(entry.phone);
    const due = (thread.scheduled || []).filter((s) => s.sendAt <= now);
    if (!due.length) continue;
    // Reserve the due items FIRST — remove them and persist BEFORE sending. KV is
    // eventually consistent and the cron runs every minute, so if we sent first and
    // saved after, an overlapping/next run could read the stale queue and text the
    // customer twice. Reserving first makes it at-most-once (a rare crash drops a
    // message rather than double-sending it — the safer failure for customer texts).
    thread.scheduled = (thread.scheduled || []).filter((s) => s.sendAt > now);
    await saveThread(thread);
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
// Dashboard auth (password gate). If DASHBOARD_PASSWORD isn't set, the
// dashboard stays open (so nothing locks up before you configure it).
// ===========================================================================
async function tokenFor() {
  const data = new TextEncoder().encode('mkd:' + (ENV.DASHBOARD_PASSWORD || ''));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function getCookie(request, name) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
async function isAuthed(request) {
  if (!ENV.DASHBOARD_PASSWORD) return true;
  return getCookie(request, 'mkd_auth') === (await tokenFor());
}
async function apiLogin(request) {
  const data = await readJson(request);
  if (!ENV.DASHBOARD_PASSWORD) return json({ ok: true });
  if ((data.password || '') !== ENV.DASHBOARD_PASSWORD) return json({ ok: false, error: 'wrong_password' }, 401);
  const token = await tokenFor();
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': `mkd_auth=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000`,
    },
  });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'mkd_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
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
