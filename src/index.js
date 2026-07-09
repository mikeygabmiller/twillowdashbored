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
 *   FOLLOWUPS_DISABLED    (optional kill switch — set to "1" in the Cloudflare
 *                          dashboard to stop the follow-up cron WITHOUT a KV
 *                          write, for when the daily write limit is exhausted and
 *                          the in-app toggle therefore can't save. Unset to resume.)
 * Required KV binding: MESSAGES
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠  KV WRITE BUDGET — READ BEFORE TOUCHING ANY put()/saveThread/saveIndex  │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Cloudflare's free tier allows only ~1,000 KV WRITES (put/delete) PER DAY. │
 * │ That is ~0.7 writes/minute. Reads are far cheaper (~100k/day) — writes are │
 * │ the scarce resource. The minute cron (runCron) touches every conversation,│
 * │ so a SINGLE unnecessary write inside a per-thread loop = thousands/day and │
 * │ the whole app hard-stops with 429s until midnight UTC.                     │
 * │                                                                           │
 * │ RULES for anything that runs in the cron or a loop over the index:        │
 * │   1. NEVER write on a tick where nothing changed. Skip idle threads       │
 * │      BEFORE loading them (see the guard in evaluateFollowups).            │
 * │   2. Gate every saveThread()/saveIndex() behind a real state change.      │
 * │   3. Batch the index: mutate it in memory and saveIndex() ONCE per tick,  │
 * │      not once per thread. (updateIndexEntry de-dupes no-op writes.)       │
 * │ If you add a feature that writes on a schedule, do the math first:        │
 * │   writes/day = (threads touched) × (writes each) × 1440. Keep it << 1000. │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// env is identical across every request of a deployment (bindings + secrets
// don't change per request), so stashing it in module scope is safe even under
// concurrency. Each invocation sets it before doing any work.
let ENV = null;
// Per-invocation cache of the KV `config` doc so a single request/cron tick
// doesn't re-read it for every thread it touches. Cleared at the top of each
// entry point so a settings change is picked up on the very next invocation.
let CFG_CACHE = null;
// The public origin the Worker is reachable at (e.g. https://…workers.dev). Captured
// from the first request so cron-time sends can build an absolute Twilio StatusCallback
// URL; falls back to the PUBLIC_BASE_URL var when no request has been seen yet.
let BASE_URL = null;
function kv() { return ENV.MESSAGES; }
function publicBase() { return String(ENV.PUBLIC_BASE_URL || BASE_URL || '').replace(/\/+$/, ''); }

// Deploy fingerprint. BUMP THIS on every change, and keep APP_BUILD in
// public/index.html identical. The dashboard footer shows "app <build> · server
// <build> ✓" so you can confirm at a glance that the LIVE url (not just a preview
// build) is serving this exact version — front-end assets and Worker script alike.
// A "⚠ mismatch" means they came from different deploys. See DEPLOY.md.
const BUILD = '2026-07-08·t';

// Truthy-check a Worker var/secret. Used for kill switches that must work even
// when KV writes are blocked (the in-app toggles all persist to KV, so they're
// useless once the daily write limit is hit — a var is set in the Cloudflare
// dashboard with no KV write). Accepts 1/true/yes/on (case-insensitive).
function envFlag(name) {
  const v = String((ENV && ENV[name]) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

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
  await seedPlaybookIfNeeded();
  await dispatchDueScheduled();
  await dispatchDueReminders();
  await evaluateFollowups();
}

// Private "remind me to follow up on <date>" reminders — a nudge to Mikey, not a
// text to the customer. Fires once when due (alerts Mikey), then stays surfaced on
// Home until he clears it. Cheap: only loads threads whose reminder is actually due.
async function dispatchDueReminders(now = Date.now()) {
  const index = await loadIndex();
  let dirty = false;
  for (const e of index) {
    if (!e.reminderAt || e.reminderAt > now) continue;
    const thread = await loadThread(e.phone);
    if (!thread.reminderAt || thread.reminderAt > now || thread.reminderNotified) continue;
    thread.reminderNotified = true;
    await saveThread(thread);
    notifyMikey('⏰ Follow-up reminder',
      `Time to follow up with ${thread.name || thread.phone}${thread.reminderNote ? ':\n' + thread.reminderNote : '.'}`).catch(() => {});
    const cfg = await loadConfig();
    if (applyIndexSummary(index, buildIndexSummary(thread, cfg))) dirty = true;
  }
  if (dirty) await saveIndex(index);
}

// ===========================================================================
// Router
// ===========================================================================
async function handle(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  BASE_URL = url.origin;

  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

  if (request.method === 'POST' && pathname === '/submit')         return handleSubmit(request);
  if (request.method === 'POST' && pathname === '/sms')            return handleInboundSms(request);
  if (request.method === 'POST' && pathname === '/call')           return handleInboundCall(request);
  if (request.method === 'POST' && pathname === '/call-screen')    return handleCallScreen(request);
  if (request.method === 'POST' && pathname === '/voicemail')      return handleVoicemail(request);
  if (request.method === 'POST' && pathname === '/voicemail-done') return handleVoicemailDone(request);
  if (request.method === 'POST' && pathname === '/voicemail-tx')   return handleVoicemailTranscription(request);
  if (request.method === 'POST' && pathname === '/status')         return handleStatusCallback(request);
  if (request.method === 'POST' && pathname === '/email-in')       return handleEmailIn(request);

  if (request.method === 'GET'  && pathname === '/api/version')    return json({ ok: true, build: BUILD });
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
  if (request.method === 'POST' && pathname === '/api/request-date') return apiRequestDate(request);
  if (request.method === 'POST' && pathname === '/api/call')       return apiCall(request);
  if (request.method === 'POST' && pathname === '/api/read')       return apiRead(request);
  if (request.method === 'GET'  && pathname === '/api/insights')   return apiInsights();
  if (request.method === 'GET'  && pathname === '/api/emails')     return apiEmails();
  if (request.method === 'POST' && pathname === '/api/email-read') return apiEmailRead(request);
  if ((request.method === 'GET' || request.method === 'POST') && pathname === '/api/email-setup') return apiEmailSetup(request);
  if (request.method === 'GET'  && pathname === '/api/media')      return apiMediaProxy(url);
  if (request.method === 'POST' && pathname === '/api/media-backfill') return apiMediaBackfill(request);
  if (request.method === 'POST' && pathname === '/api/alert-test') return apiAlertTest();
  if (request.method === 'GET'  && pathname === '/api/followups')  return apiFollowups();
  if (request.method === 'POST' && pathname === '/api/followup')   return apiFollowupAction(request);
  if (request.method === 'GET'  && pathname === '/api/config')     return apiGetConfig();
  if (request.method === 'POST' && pathname === '/api/config')     return apiSaveConfig(request);
  if (request.method === 'POST' && pathname === '/api/block')      return apiBlock(request);
  if (request.method === 'GET'  && pathname === '/api/migrate')    return apiMigrate(url);
  if (request.method === 'GET'  && pathname === '/api/templates')  return apiGetTemplates();
  if (request.method === 'POST' && pathname === '/api/templates')  return apiSaveTemplates(request);
  if (request.method === 'POST' && pathname === '/api/ai/summary') return apiAiSummary(request);
  if (request.method === 'POST' && pathname === '/api/ai/draft')   return apiAiDraft(request);
  if (request.method === 'POST' && pathname === '/api/ai/triage')  return apiAiTriage();
  if (request.method === 'POST' && pathname === '/api/ai/coach')   return apiAiCoach(request);
  if (request.method === 'POST' && pathname === '/api/ai/photo-quote') return apiAiPhotoQuote(request);

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

  // Bot honeypot: real customers never fill these hidden fields. If one is set,
  // pretend success and drop the submission — no thread, no text, no alert.
  if (body && (body.website || body._gotcha || body.hp)) return cors(json({ ok: true, clientSms: 'skipped', mikeyAlert: false }, 200));
  // Light per-IP rate limit so a script can't flood the form (and your Twilio bill).
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip) {
    const rlKey = 'rl:submit:' + ip;
    const n = parseInt((await kv().get(rlKey)) || '0', 10);
    if (n >= 8) return cors(json({ ok: false, error: 'rate_limited' }, 429));
    await kv().put(rlKey, String(n + 1), { expirationTtl: 3600 });
  }

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
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || '';
  const text = params.Body || '';
  const numMedia = parseInt(params.NumMedia || '0', 10);
  const fromNorm = normalizePhone(from) || from;
  if (fromNorm === normalizePhone(ENV.MIKEY_PHONE)) return twiml('');

  // STOP / START compliance. Record the opt-out state ourselves so scheduled sends,
  // autopilot nudges and blasts all honor it — Twilio blocks at the API but never
  // tells the app, so without this we'd keep erroring against opted-out numbers.
  const kw = text.trim().toLowerCase();
  const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop all'];
  const START_WORDS = ['start', 'unstop', 'yes', 'unsubscribe stop'];
  if (STOP_WORDS.includes(kw)) {
    await setOptOut(fromNorm, true);
    await appendMessage(fromNorm, { dir: 'in', body: text, ts: Date.now(), kind: 'opt-out' });
    await notifyMikey(`🚫 ${from} opted out (STOP)`, `${from} texted STOP and will not receive further messages until they text START.`);
    return twiml('');
  }
  if (START_WORDS.includes(kw)) {
    await setOptOut(fromNorm, false);
    await appendMessage(fromNorm, { dir: 'in', body: text, ts: Date.now(), kind: 'opt-in' });
    await notifyMikey(`✅ ${from} opted back in (START)`, `${from} texted START and can receive messages again.`);
    return twiml('');
  }

  // Capture MMS media (photos are the quote for a detailing business). Store the
  // Twilio media URLs on the message; the dashboard renders them through an
  // authenticated proxy (/api/media) since the raw URLs need account credentials.
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const u = params['MediaUrl' + i];
    if (u) media.push({ url: u, type: params['MediaContentType' + i] || '' });
  }
  const inMsg = { dir: 'in', body: text, ts: Date.now() };
  if (media.length) inMsg.media = media;
  else if (numMedia > 0) inMsg.body = text + `\n[${numMedia} attachment(s)]`;
  if (params.MessageSid) inMsg.sid = params.MessageSid;
  await appendMessage(fromNorm, inMsg);
  await notifyMikey(`📱 New ${numMedia > 0 ? 'photo/text' : 'text'} from ${from}`,
    `New message from ${from}:\n"${text || (numMedia > 0 ? '[photo]' : '')}"\n\nReply in your dashboard.`);
  // Pre-draft a reply in Mikey's voice so it's already waiting when he opens the
  // thread. Best-effort — never blocks or fails the inbound webhook.
  await maybeSuggestReply(fromNorm);
  // No auto-reply to the customer — Mikey replies personally from the dashboard.
  return twiml('');
}

// Small TwiML fragment that rings Mikey's cell and then falls through to
// voicemail — shared by the direct path and the post-screening path.
function dialMikeyTwiml() {
  const mikeyPhone = normalizePhone(ENV.MIKEY_PHONE) || '+13607975831';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/voicemail" method="POST"><Number>${escapeXml(mikeyPhone)}</Number></Dial>
</Response>`;
}

// Inbound call. Two guards run before the call is ever forwarded to Mikey's
// phone (which is what was letting robocall/spam auto-dialers flood his Google
// Voice voicemail):
//   1. Block list — known spam numbers are rejected instantly (no ring, no VM).
//   2. Press-1 screening gate — the caller must press a key to be connected.
//      Auto-dialers don't press keys, so they hit <Hangup/> and are never
//      forwarded. Real customers press 1 and reach Mikey exactly like before.
// Mikey is only alerted for calls that clear these guards, so the notification
// flood stops too.
async function handleInboundCall(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || 'Unknown';
  const fromNorm = normalizePhone(from) || from;
  const cfg = await loadConfig();

  // 1. Blocked number → reject with a rejected tone. No forward, no voicemail,
  //    no alert. Costs Mikey nothing and the spammer gets a dead end.
  if (Array.isArray(cfg.blockedNumbers) && cfg.blockedNumbers.includes(fromNorm)) {
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>');
  }

  // 2. Screening gate. Gather waits for a single key; if none is pressed within
  //    the timeout, Twilio falls through to <Hangup/> and the call is dropped
  //    without ever forwarding to Mikey — which is what defeats the robo-dialers.
  if (cfg.callScreening !== false) {
    const gate = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/call-screen" method="POST" timeout="8">
    <Say voice="alice">Thanks for calling Mikey's Mobile Detailing. If you're a customer, press 1 to reach Mikey.</Say>
  </Gather>
  <Hangup/>
</Response>`;
    return xmlResponse(gate);
  }

  // Screening off → original behavior: forward straight to Mikey.
  notifyMikey(`📞 Incoming call from ${from}`, `Incoming call from ${from} to your Mikey's Detailing number.`).catch(() => {});
  return xmlResponse(dialMikeyTwiml());
}

// Screening gate result. Only reached when a caller actually pressed a key, so
// a human is on the line. Press 1 → notify Mikey and forward the call. Any other
// key → polite hangup (still no forward, no voicemail).
async function handleCallScreen(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || 'Unknown';
  const digits = params.Digits || '';
  if (digits === '1') {
    notifyMikey(`📞 Incoming call from ${from}`, `Incoming call from ${from} to your Mikey's Detailing number (passed screening).`).catch(() => {});
    return xmlResponse(dialMikeyTwiml());
  }
  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, I didn\'t get that. Goodbye.</Say><Hangup/></Response>');
}

async function handleVoicemail(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || 'Unknown';
  const dialStatus = params.DialCallStatus || '';
  if (dialStatus === 'completed') return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Missed-call instant text-back — the #1 lead-recovery move for a solo mobile
  // business. Fire a friendly SMS to the caller so a missed call converts into a
  // text thread Mikey can answer from the driveway. Opt-out aware, and throttled so
  // a caller who rings twice in a row doesn't get spammed.
  const cfg = await loadConfig();
  if (cfg.missedCallTextback !== false) {
    const caller = normalizePhone(from);
    if (caller && caller !== normalizePhone(ENV.MIKEY_PHONE) && !isOptedOut(cfg, caller)) {
      const thread = await loadThread(caller);
      const recent = (thread.messages || []).some((m) => m.kind === 'missed-call' && Date.now() - m.ts < 30 * 60000);
      if (!recent) {
        const body = (cfg.missedCallText && cfg.missedCallText.trim()) ||
          `Hey, it's Mikey with Mikey's Mobile Detailing — sorry I missed your call! Text me right here and I'll get back to you as quick as I can. 🚗`;
        try {
          const r = await sendSms(caller, body);
          thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'missed-call', status: 'sent', sid: (r && r.sid) || undefined });
        } catch (err) {
          thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'missed-call', error: String(err.message || err) });
        }
        if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
        await saveThread(thread);
        await updateIndexEntry(thread);
      }
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hey, you've reached Mikey's Mobile Detailing. Leave a message and Mikey will text or call you right back.</Say>
  <Record maxLength="120" action="/voicemail-done" method="POST" playBeep="true" transcribe="true" transcribeCallback="/voicemail-tx" />
</Response>`;
  notifyMikey(`📵 Missed call from ${from}`, `Missed call from ${from} — I sent them an instant text back, and they may leave a voicemail now.`).catch(() => {});
  return xmlResponse(xml);
}

async function handleVoicemailDone(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || 'Unknown';
  const recordingUrl = params.RecordingUrl || '';
  const duration = params.RecordingDuration || '?';
  if (recordingUrl) {
    await notifyMikey(`🎙️ Voicemail from ${from}`, `Voicemail from ${from} (${duration}s):\n${recordingUrl}.mp3`);
  }
  return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

// Voicemail transcription callback (Twilio's built-in speech-to-text, fired after
// the recording is transcribed). Drops the readable text straight into the caller's
// thread as an inbound message so a voicemail becomes searchable, AI-usable text —
// no more stopping to play an .mp3. Arrives a little after the voicemail itself.
async function handleVoicemailTranscription(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || 'Unknown';
  const fromNorm = normalizePhone(from) || from;
  const text = (params.TranscriptionText || '').trim();
  const status = params.TranscriptionStatus || '';
  const recording = params.RecordingUrl || '';
  if (fromNorm === normalizePhone(ENV.MIKEY_PHONE)) return new Response('', { status: 204 });
  if (status !== 'completed' || !text) {
    // Transcription failed (silence, noise, non-English). The .mp3 alert from
    // /voicemail-done already went out, so just acknowledge.
    return new Response('', { status: 204 });
  }
  await appendMessage(fromNorm, {
    dir: 'in',
    body: `🎙️ Voicemail: "${text}"`,
    ts: Date.now(),
    kind: 'voicemail',
    recording: recording ? recording + '.mp3' : undefined,
  });
  notifyMikey(`🎙️ Voicemail transcript from ${from}`, `"${text}"\n\nOpen the dashboard to reply.`).catch(() => {});
  return new Response('', { status: 204 });
}

// Twilio delivery-status callback (set as StatusCallback on every outbound send).
// To conserve the KV write budget we persist only the states that matter: a final
// `delivered` confirmation and any `failed`/`undelivered` — the intermediate
// queued/sent ticks are ignored. On a failure we flag the message AND alert Mikey,
// so a carrier-filtered reply can never die silently.
async function handleStatusCallback(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const sid = params.MessageSid || params.SmsSid || '';
  const status = params.MessageStatus || params.SmsStatus || '';
  const to = normalizePhone(params.To || '');
  const bad = status === 'failed' || status === 'undelivered';
  if (!sid || !to || !(bad || status === 'delivered')) return new Response('', { status: 204 });

  const thread = await loadThread(to);
  const msg = (thread.messages || []).find((m) => m.sid === sid);
  if (!msg || msg.status === status) return new Response('', { status: 204 }); // unknown or no-op
  msg.status = status;
  if (bad) msg.errorCode = params.ErrorCode || '';
  await saveThread(thread);
  await updateIndexEntry(thread);
  if (bad) {
    notifyMikey('⚠️ A text failed to deliver',
      `Your message to ${thread.name || to} could not be delivered (${status}${params.ErrorCode ? ', code ' + params.ErrorCode : ''}). Open the dashboard to resend.`).catch(() => {});
  }
  return new Response('', { status: 204 });
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
    ok: true, routing: 'worker-reached', build: BUILD,
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
  // In team mode the sender's name rides along so the reply is attributed in the
  // thread ("— Alex"). Solo sends leave it blank and look exactly as before.
  const by = String(data.by || '').trim().slice(0, 40);
  const msg = { dir: 'out', body, ts: Date.now(), kind: 'manual' };
  if (by) msg.by = by;
  let r;
  try {
    r = await sendSms(phone, body);
  } catch (err) {
    const optedOut = /opted_out/.test(String((err && err.message) || err));
    return json({ ok: false, error: optedOut ? 'recipient_opted_out' : String((err && err.message) || err) }, optedOut ? 409 : 502);
  }
  msg.status = 'sent';
  if (r && r.sid) msg.sid = r.sid;
  const thread = await appendMessage(phone, msg);
  // "Learns from your edits": if this send started from an AI draft/suggestion the
  // owner then tweaked, remember the before→after so future drafts sound more like him.
  const aiOriginal = (data.aiOriginal || '').trim();
  if (aiOriginal) { try { await recordEdit(aiOriginal, body); } catch { /* non-fatal */ } }
  return json({ ok: true, thread });
}

// "Request a date": whoever is texting for Mikey taps this when a customer is ready
// to book. It emails Mikey (via notifyMikey — email if Resend is set up, else SMS)
// with the customer, their last message, and a one-tap link to the conversation,
// and flags the thread so the texter sees "date requested" until it's handled.
async function apiRequestDate(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  const who = String(data.by || '').trim().slice(0, 40);
  const note = String(data.note || '').trim().slice(0, 300);
  const name = thread.name || phone;
  const lastIn = (thread.messages || []).filter((m) => m.dir === 'in').slice(-1)[0];
  const lastBody = lastIn ? String(lastIn.body || '').slice(0, 240) : '';
  const link = `${publicBase()}/?c=${encodeURIComponent(phone)}`;
  const subject = `📅 Date needed for ${name}`;
  const body =
    `${who ? who + ' is texting for you and ' : ''}${name} is ready to book and needs one of your open dates.\n\n` +
    (lastBody ? `Their last message:\n"${lastBody}"\n\n` : '') +
    (note ? `Note from ${who || 'your texter'}: ${note}\n\n` : '') +
    `Open the conversation to send them a time:\n${link}`;
  const sent = await notifyMikey(subject, body);
  thread.dateRequest = { at: Date.now(), by: who };
  await saveThread(thread);
  await updateIndexEntry(thread);
  return json({ ok: true, thread, sent });
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
  if (typeof data.assignedTo === 'string') thread.assignedTo = data.assignedTo.slice(0, 24);
  if ('appointmentAt' in data) {
    const a = Number(data.appointmentAt);
    thread.appointmentAt = (data.appointmentAt == null || !a) ? null : a;
    if (thread.appointmentAt) thread.dateRequest = null; // booking answers the date request
  }
  if (data.clearDateRequest) thread.dateRequest = null; // texter/Mikey marked it handled
  if ('reminderAt' in data) {
    const r = Number(data.reminderAt);
    thread.reminderAt = (data.reminderAt == null || !r) ? null : r;
    thread.reminderNotified = false; // re-arm the one-time alert whenever it's (re)set
  }
  if (typeof data.reminderNote === 'string') thread.reminderNote = data.reminderNote.slice(0, 200);
  if (data.clearSuggested) thread.suggested = null; // Mikey dismissed the pre-drafted reply
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
  thread.dateRequest = null; // scheduling a send answers the "need a date" request
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

// ===========================================================================
// Unified inbox — recent emails alongside texts
// ---------------------------------------------------------------------------
// A lightweight feed of recent emails so everything lives in one place. Emails
// are pushed IN by an automation (e.g. a Zapier "New Gmail email → POST" zap) to
// /email-in, guarded by a shared EMAIL_INGEST_TOKEN secret. We keep only the last
// ~60 in a single KV doc (one write per incoming email — emails are low-volume).
// ===========================================================================
async function handleEmailIn(request) {
  const data = await readJson(request);
  const token = request.headers.get('X-Ingest-Token') || data.token || '';
  const cfg = await loadConfig();
  const authed = (ENV.EMAIL_INGEST_TOKEN && token === ENV.EMAIL_INGEST_TOKEN) || (cfg.emailToken && token === cfg.emailToken);
  if (!token || !authed) return json({ ok: false, error: 'unauthorized' }, 401);
  const rawDate = data.date;
  const email = {
    id: genId(),
    from: String(data.from || '').slice(0, 200),
    fromName: String(data.fromName || data.from || '').slice(0, 120),
    subject: String(data.subject || '(no subject)').slice(0, 300),
    snippet: String(data.snippet || data.body || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    body: String(data.body || data.snippet || '').slice(0, 20000),
    date: Number(rawDate) || Date.parse(rawDate) || Date.now(),
    unread: 1,
  };
  const list = (await kv().get('emails', { type: 'json' })) || [];
  // De-dupe on a provided messageId if the automation retries.
  const mid = data.messageId ? String(data.messageId).slice(0, 200) : '';
  if (mid) { if (list.some((e) => e.mid === mid)) return json({ ok: true, duplicate: true }); email.mid = mid; }
  list.unshift(email);
  if (list.length > 60) list.length = 60;
  await kv().put('emails', JSON.stringify(list));
  return json({ ok: true });
}
async function apiEmails() {
  const list = (await kv().get('emails', { type: 'json' })) || [];
  return json({ ok: true, emails: list });
}
// Everything the in-app "Connect email" screen needs: the ingest URL and a token
// (generated + stored in config the first time, so no Cloudflare secret is required).
async function apiEmailSetup(request) {
  const regen = request && request.method === 'POST';
  const cfg = await loadConfig();
  let token = cfg.emailToken;
  if (!token || regen) {
    token = 'ek_' + genId() + genId();
    const next = Object.assign({}, cfg, { emailToken: token });
    await kv().put('config', JSON.stringify(next));
    CFG_CACHE = next;
  }
  const list = (await kv().get('emails', { type: 'json' })) || [];
  return json({ ok: true, url: `${publicBase()}/email-in`, token, connected: list.length > 0, count: list.length, lastAt: list[0] ? list[0].date : null });
}
async function apiEmailRead(request) {
  const data = await readJson(request);
  const list = (await kv().get('emails', { type: 'json' })) || [];
  let changed = false;
  if (data.id) { const e = list.find((x) => x.id === data.id); if (e && e.unread) { e.unread = 0; changed = true; } }
  else { for (const e of list) if (e.unread) { e.unread = 0; changed = true; } }
  if (changed) await kv().put('emails', JSON.stringify(list));
  return json({ ok: true, emails: list });
}

// Authenticated image proxy. Twilio media URLs require the account credentials,
// so the browser can't load them directly; the dashboard points <img> at this
// route (same-origin, already behind the dashboard password) and we fetch the
// bytes with Basic auth and stream them back. Locked to Twilio hosts (no SSRF).
async function apiMediaProxy(url) {
  const u = url.searchParams.get('u') || '';
  if (!/^https:\/\/(api|media)\.twilio\.com\//.test(u)) return json({ ok: false, error: 'bad_url' }, 400);
  const sid = ENV.TWILIO_ACCOUNT_SID, token = ENV.TWILIO_AUTH_TOKEN;
  const r = await fetch(u, { headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}` } });
  if (!r.ok) return json({ ok: false, error: `twilio ${r.status}` }, 502);
  const ct = r.headers.get('Content-Type') || 'application/octet-stream';
  return new Response(r.body, { headers: { 'Content-Type': ct, 'Cache-Control': 'private, max-age=86400' } });
}

// Recover attachments for messages that arrived before inbound media was captured
// (older texts stored as "[N attachment(s)]"). Pulls this contact's recent MMS from
// the Twilio API and attaches each photo to the nearest matching inbound message.
async function apiMediaBackfill(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const sid = ENV.TWILIO_ACCOUNT_SID, token = ENV.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return json({ ok: false, error: 'twilio_not_configured' }, 500);
  const auth = `Basic ${btoa(`${sid}:${token}`)}`;
  const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?From=${encodeURIComponent(phone)}&To=${encodeURIComponent(ENV.TWILIO_FROM || '')}&PageSize=100`;
  let d;
  try {
    const r = await fetch(listUrl, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    d = await r.json();
  } catch (e) {
    return json({ ok: false, error: `twilio_list_failed: ${String((e && e.message) || e)}` }, 502);
  }
  // For each inbound message that carried media, resolve its media instance URLs.
  const twMsgs = [];
  for (const m of (d.messages || [])) {
    if (!(+m.num_media > 0) || !(m.subresource_uris && m.subresource_uris.media)) continue;
    try {
      const mr = await fetch(`https://api.twilio.com${m.subresource_uris.media}`, { headers: { Authorization: auth } });
      if (!mr.ok) continue;
      const md = await mr.json();
      const media = (md.media_list || []).map((x) => ({
        url: `https://api.twilio.com${String(x.uri).replace(/\.json$/, '')}`,
        type: x.content_type || '',
      }));
      if (media.length) twMsgs.push({ date: new Date(m.date_created).getTime(), media });
    } catch { /* skip this one */ }
  }
  // Attach to the nearest inbound thread message (within 10 min) that has no media yet.
  const thread = await loadThread(phone);
  let attached = 0;
  for (const msg of (thread.messages || [])) {
    if (msg.dir !== 'in' || (msg.media && msg.media.length)) continue;
    if (!/\[\d+ attachment\(s\)\]/.test(msg.body || '')) continue; // only recover messages that carried attachments
    let best = null, bestDiff = 600000;
    for (const tw of twMsgs) {
      const diff = Math.abs(tw.date - (msg.ts || 0));
      if (diff < bestDiff) { bestDiff = diff; best = tw; }
    }
    if (best) {
      msg.media = best.media;
      if (/^\s*\[\d+ attachment/.test(msg.body || '')) msg.body = '';
      attached++;
    }
  }
  if (attached) { await saveThread(thread); await updateIndexEntry(thread); }
  return json({ ok: true, attached, found: twMsgs.length, thread });
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
  const cfg = await loadConfig();
  const prompt =
    businessContext(cfg) +
    `You are Mikey's operations assistant for his mobile car detailing business. ` +
    `Read this SMS conversation and return ONLY JSON with this shape:\n` +
    `{"summary": "A tight, practical brief in 2-4 short sentences: who this customer is, ` +
    `what they want (vehicle + service if known), and the current state — e.g. quote sent, ` +
    `waiting on their reply, price agreed, scheduled, or gone quiet. Then finish with a final ` +
    `sentence starting exactly with 'Next: ' naming the single most useful next action for Mikey. ` +
    `Be concrete and specific to THIS conversation; no filler, no restating the obvious.", ` +
    `"status": one of "new","active","won","lost" or "", ` +
    `"tags": array of up to 4 short, useful labels like "Truck","Ceramic","Quote sent","Needs follow-up","VIP"}\n\n` +
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

// The single source of truth for drafting a customer reply — used by the AI draft
// button, the "write it for me" composer, AND the proactive suggested reply that's
// pre-drafted the moment a customer texts. It grounds every reply in the playbook +
// Mikey's voice AND in how he's been editing recent drafts, so it keeps getting
// sharper the more he uses it ("learns from your edits").
async function generateReply(thread, cfg, hint) {
  const prompt =
    businessContext(cfg) +
    (await editsContext()) +
    `You are replying to a customer by text for Mikey's Mobile Detailing. ` +
    `Write ONE friendly, professional reply (1-3 short complete sentences, no greeting line, no signature, ready to send). ` +
    `Ground it in the business playbook above — use the real services, pricing ranges and voice, and never contradict them. ` +
    `Do not make up a specific price or appointment time on your own. ` +
    `BUT if the goal below already specifies details the owner has decided — a price, a day, a time, an answer — use those exactly as given; that is the owner telling you what to say. ` +
    `Finish every sentence — do not cut off mid-thought. ` +
    (hint ? `Goal of this reply (write a text that accomplishes exactly this): ${hint}. ` : '') +
    `\n\nConversation so far:\n${transcript(thread)}\n\nReply:`;
  const text = await geminiGenerate(prompt, { temperature: 0.7, maxTokens: 800 });
  return text.replace(/^["']|["']$/g, '').trim();
}

async function apiAiDraft(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  const cfg = await loadConfig();
  const hint = (data.hint || '').trim();
  const draftText = (data.text || '').trim();
  try {
    if (draftText) {
      // Polish mode = light proofread only. Keep the sender's exact meaning, wording,
      // length and voice; fix only mechanics. No transcript, no playbook — those tempt
      // the model to rewrite. If it's already fine, return it unchanged.
      const prompt =
        `You are lightly proofreading a short text message the user wrote to a customer. ` +
        `Make ONLY the minimal edits needed to fix spelling, grammar, capitalization and punctuation. ` +
        `Keep the EXACT meaning, wording, length and casual texting voice. ` +
        `Do NOT rephrase, do NOT reorder, do NOT add or remove information, and do NOT add greetings, ` +
        `sign-offs, emojis or pleasantries that aren't already there. ` +
        `If the message is already correct, return it exactly as-is. ` +
        `Return ONLY the corrected message text — no quotes, no explanation, no preamble. ` +
        (hint ? `Extra instruction: ${hint}. ` : '') +
        `\n\nMessage to proofread:\n${draftText}\n\nCorrected message:`;
      const text = await geminiGenerate(prompt, { temperature: 0.15, maxTokens: 800 });
      return json({ ok: true, draft: text.replace(/^["']|["']$/g, '').trim() });
    }
    const text = await generateReply(thread, cfg, hint);
    return json({ ok: true, draft: text });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

async function apiAiTriage() {
  const index = await loadIndex();
  const open = index.filter((e) => !e.archived);
  if (!open.length) return json({ ok: true, briefing: 'No open conversations. All clear! 🚗' });
  const cfg = await loadConfig();
  const now = Date.now();
  const lines = open.map((e) => {
    const ago = humanAgo(now - (e.lastTs || now));
    const who = e.lastDir === 'in' ? `WAITING ${ago} for reply` : `you replied ${ago} ago`;
    return `- ${e.name || e.phone} [${e.status || 'no status'}] ${who}: "${e.lastBody || ''}"`;
  }).join('\n');
  const prompt =
    businessContext(cfg) +
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

// Team coach: given a conversation, tell whoever is on the phones EXACTLY what to
// say and why. Returns a ready reply plus talking points, watch-outs, and a tone
// cue — all grounded in the business playbook — so a new team member can answer
// confidently without knowing the business by heart.
// Multimodal quote assist: read the customer's most recent photo, assess the
// vehicle's condition, recommend playbook services, and draft a reply — never a
// specific price. Turns "photo is the quote" into an actual drafted response.
async function fetchTwilioImageB64(u) {
  const r = await fetch(u, { headers: { Authorization: `Basic ${btoa(`${ENV.TWILIO_ACCOUNT_SID}:${ENV.TWILIO_AUTH_TOKEN}`)}` } });
  if (!r.ok) throw new Error(`media ${r.status}`);
  const ct = (r.headers.get('Content-Type') || 'image/jpeg').split(';')[0];
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  return { mimeType: ct, dataB64: btoa(bin) };
}
async function apiAiPhotoQuote(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  let img = null;
  for (let i = (thread.messages || []).length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m.dir === 'in' && Array.isArray(m.media)) {
      const im = m.media.find((x) => /^image\//.test(x.type || '') || !x.type);
      if (im) { img = im; break; }
    }
  }
  if (!img) return json({ ok: false, error: 'no_photo' }, 422);
  let pic;
  try { pic = await fetchTwilioImageB64(img.url); }
  catch { return json({ ok: false, error: 'media_fetch_failed' }, 502); }
  const cfg = await loadConfig();
  const prompt = businessContext(cfg) +
    `You are Mikey from Mikey's Mobile Detailing, looking at a photo a customer just texted of their vehicle. ` +
    `Return ONLY JSON: {"assessment":"2-3 sentences on the vehicle type and its VISIBLE condition (dirt, swirls, stains, oxidation, etc.)", ` +
    `"services":["recommended services drawn from the playbook that fit what you see"], ` +
    `"draft":"a warm 1-3 sentence text reply that acknowledges the vehicle, notes what you'd focus on, and says you'll confirm the exact price — NEVER state a specific price or appointment time"}. ` +
    `Base everything only on what is actually visible.\n\nConversation so far:\n${transcript(thread)}`;
  try {
    const text = await geminiGenerate(prompt, { json: true, maxTokens: 1200, images: [{ mimeType: pic.mimeType, dataB64: pic.dataB64 }] });
    let p = {}; try { p = JSON.parse(text); } catch { p = { draft: text }; }
    return json({
      ok: true,
      assessment: String(p.assessment || '').trim(),
      services: Array.isArray(p.services) ? p.services.map((s) => String(s).trim()).filter(Boolean).slice(0, 6) : [],
      draft: String(p.draft || '').trim(),
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

async function apiAiCoach(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  if (!thread.messages.length) return json({ ok: false, error: 'no_messages' }, 422);
  const cfg = await loadConfig();
  const prompt =
    businessContext(cfg) +
    `You are coaching a NEW team member at Mikey's Mobile Detailing on how to answer this customer text. ` +
    `Use the business playbook above as the single source of truth. ` +
    `Return ONLY JSON with this shape:\n` +
    `{"reply": "one ready-to-send reply (1-3 short, friendly sentences, no greeting line, no signature)", ` +
    `"points": ["2 to 4 short talking points or key facts to mention, drawn from the playbook"], ` +
    `"watchouts": ["1 to 2 things to avoid or be careful about with this specific customer"], ` +
    `"tone": "one short sentence describing the tone to use"}\n` +
    `Never invent a specific price, date, or appointment time — if one is needed, tell them to confirm with Mikey. ` +
    `If the playbook is thin, still give your best general detailing-business guidance.` +
    `\n\nConversation:\n${transcript(thread)}`;
  try {
    const text = await geminiGenerate(prompt, { json: true, maxTokens: 1500 });
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    const arr = (v, n) => Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : [];
    return json({
      ok: true,
      reply: String(parsed.reply || '').trim(),
      points: arr(parsed.points, 4),
      watchouts: arr(parsed.watchouts, 2),
      tone: String(parsed.tone || '').trim(),
    });
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

  const ctx = businessContext(cfg);
  let prompt;
  if (plan.stage === 'owed') {
    prompt =
      ctx +
      `You are Mikey from Mikey's Mobile Detailing, replying to a customer by text. ` +
      `Write ONE friendly, professional reply to their most recent message (1-3 short sentences, no greeting line, no signature, ready to send). ` +
      `Stay consistent with the business playbook above. ` +
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
      ctx +
      `You are Mikey from Mikey's Mobile Detailing, texting a customer. ` +
      `Write ONE short, natural follow-up text (1-2 sentences, no greeting line unless natural, no signature, ready to send). ` +
      `Stay consistent with the business playbook above. ` +
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
  // Two independent off-switches. `followupsEnabled` is the in-app toggle, but
  // saving it is itself a KV write — useless once the daily write limit is
  // already blown. FOLLOWUPS_DISABLED is a Worker var (set in the Cloudflare
  // dashboard, no KV write) so the engine can always be killed even mid-lockout.
  if (cfg.followupsEnabled === false || envFlag('FOLLOWUPS_DISABLED')) return 0;
  const index = await loadIndex();
  let acted = 0;
  let indexDirty = false; // batch: write the whole index at most ONCE per tick
  for (const e of index) {
    if (e.archived) continue;
    // Nothing to do this tick — skip WITHOUT touching KV. This is THE guard that
    // keeps us under the daily write budget (see the KV WRITE BUDGET note up top):
    // a thread is only worth loading if a nudge is already surfaced (followupDue)
    // or its next step has come due. Idle conversations — the vast majority, which
    // have followupNextAt=null because no follow-up applies — fall through here and
    // are never re-saved. (Stale suggestions still get cleared promptly: that
    // happens on the customer's inbound reply and whenever the thread is opened.)
    if (!e.followupDue && (!e.followupNextAt || e.followupNextAt > now)) continue;

    const thread = await loadThread(e.phone);
    const fu = thread.followup || (thread.followup = defaultFollowup());
    // Legacy threads that had a status before this feature shipped have no
    // statusAt — anchor them to now so won/lost cadences start fresh, not in the past.
    if (thread.status && !thread.statusAt) thread.statusAt = now;
    const plan = computeFollowupPlan(thread, now, cfg);

    let changed = false; // only persist this thread if we actually mutate it
    if (fu.suggestion && (!plan || fu.suggestion.stepKey !== plan.stepKey)) { fu.suggestion = null; changed = true; } // stale

    if (plan && plan.dueAt <= now && autopilotAllowed(plan, fu, cfg) && !inQuietHours(now, cfg)) {
      // Reserve the step (persist lastStepKey) BEFORE sending, mirroring the
      // scheduled-send dispatcher, so an overlapping tick can't double-send.
      const body = followupTemplate(thread, plan, cfg);
      fu.lastStepKey = plan.stepKey; fu.lastActionAt = now; fu.suggestion = null;
      pushLog(fu, { at: now, stage: plan.stage, stepKey: plan.stepKey, action: 'auto-sent' });
      await saveThread(thread);
      try {
        const r = await sendSms(thread.phone, body);
        thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'followup', status: 'sent', sid: (r && r.sid) || undefined });
      } catch (err) {
        thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'followup', error: String(err.message || err) });
        notifyMikey('⚠️ Auto follow-up failed', `An automatic follow-up to ${thread.name || thread.phone} did not send: ${String(err.message || err)}`).catch(() => {});
      }
      changed = true; acted++;
    } else if (plan && plan.dueAt <= now && !autopilotAllowed(plan, fu, cfg) && !fu.suggestion) {
      const draft = await buildFollowupDraft(thread, plan, cfg, { ai: true });
      fu.suggestion = {
        id: genId(), stage: plan.stage, step: plan.step || 0, stepKey: plan.stepKey,
        reason: followupReason(thread, plan), draft, urgency: plan.urgency, dueAt: plan.dueAt, createdAt: now,
      };
      changed = true; acted++;
    }

    if (changed) {
      await saveThread(thread);
      if (applyIndexSummary(index, buildIndexSummary(thread, cfg))) indexDirty = true;
    }
  }
  if (indexDirty) await saveIndex(index); // one write covering every thread we advanced
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
      const r = await sendSms(phone, body);
      thread.messages.push({ id: genId(), dir: 'out', body, ts: now, kind: 'followup', status: 'sent', sid: (r && r.sid) || undefined });
    } catch (err) {
      const optedOut = /opted_out/.test(String((err && err.message) || err));
      return json({ ok: false, error: optedOut ? 'recipient_opted_out' : String((err && err.message) || err) }, optedOut ? 409 : 502);
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
  if (typeof data.callScreening === 'boolean') next.callScreening = data.callScreening;
  if (typeof data.missedCallTextback === 'boolean') next.missedCallTextback = data.missedCallTextback;
  if (typeof data.missedCallText === 'string') next.missedCallText = data.missedCallText.slice(0, 320);
  if (typeof data.teamMode === 'boolean') next.teamMode = data.teamMode;
  if (Array.isArray(data.team)) next.team = sanitizeTeam(data.team);
  if (data.playbook && typeof data.playbook === 'object') next.playbook = sanitizePlaybook(data.playbook, next.playbook);
  await kv().put('config', JSON.stringify(next));
  CFG_CACHE = next;
  return json({ ok: true, config: next });
}

// Add or remove a number from the call block list. Blocked numbers are rejected
// instantly at the /call webhook — no ring, no voicemail, no alert.
async function apiBlock(request) {
  const data = await readJson(request);
  const action = data.action === 'unblock' ? 'unblock' : 'block';
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const next = Object.assign({}, await loadConfig());
  const list = Array.isArray(next.blockedNumbers) ? next.blockedNumbers.slice() : [];
  const has = list.includes(phone);
  if (action === 'block' && !has) list.push(phone);
  if (action === 'unblock' && has) list.splice(list.indexOf(phone), 1);
  next.blockedNumbers = list;
  await kv().put('config', JSON.stringify(next));
  CFG_CACHE = next;
  return json({ ok: true, config: next, blockedNumbers: list });
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
    reminderAt: null,  // private "follow up on this date" reminder for Mikey
    reminderNote: '',
    reminderNotified: false,
    assignedTo: '',    // team member id this conversation is assigned to (team mode)
    linked: [],
    messages: [],      // { id, dir:'in'|'out', body, ts, kind, error? }
    suggested: null,   // proactive pre-drafted reply awaiting Mikey: { text, ts, forTs }
    dateRequest: null, // texter asked Mikey for an available date: { at, by }
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
    callScreening: true,     // press-1 gate on inbound calls — stops robocall/spam
                             // auto-dialers before they ring your phone or hit voicemail
    blockedNumbers: [],      // normalized numbers that get rejected instantly (no ring)
    optedOut: [],            // normalized numbers that texted STOP — never messaged again
    emailToken: '',          // shared secret for the /email-in ingest (generated in-app)
    missedCallTextback: true,// auto-text a caller we missed so the lead becomes a text thread
    missedCallText: '',      // custom missed-call text (blank = the friendly default)
    teamMode: false,         // when on: conversations can be assigned, and each reply is
                             // attributed to the sender. Turn off to go back to solo.
    team: [],                // [{ id, name, role }] — the people who help answer texts
    playbook: defaultPlaybook(), // the business "brain" that trains every AI output
  };
}

// The starter playbook. `about`, `tone` and `rules` ship with safe, generic
// content so the AI is a little smarter out of the box; the fact-specific fields
// (services, area, booking, faqs) start empty for the owner to fill in — we never
// invent prices or policies. Everything is editable from the dashboard menu.
function defaultPlaybook() {
  return {
    about: "Mikey's Mobile Detailing is an owner-run mobile car detailing service for the Snohomish and Monroe, WA areas — Mikey comes to your driveway. It's always Mikey himself: personal, friendly work that's tailored to you, and you don't pay until you love it. 300+ cars detailed, 5-star rated.",
    services: "- Interior Detail — starts at $160 (deep interior clean: full vacuum, carpets & seats, all interior surfaces wiped down, interior windows, door jambs, pet-hair removal and stain treatment; about 1½ hours)\n" +
      "- Exterior Detail — starts at $130 (hand wash, wheels & tires, bug & tar removal, polish, and a spray wax/sealant so the paint really shines)\n" +
      "- Full Detail, In & Out — starts at $260 (everything inside and out; a first-time full detail runs about 3–4 hours)\n" +
      "Trucks and heavily-soiled vehicles are priced a bit higher. Every price is a \"starting at\" — the exact price depends on the vehicle's year, make, model and condition, and always gets confirmed before booking.\n" +
      "Add-ons available: ceramic coating, paint correction, and headlight restoration.\n" +
      "Recurring members pay less per visit, and their upkeep visits are quicker (around an hour) since the car stays in great shape.",
    area: "Main area: Snohomish and Monroe. Also serves Mill Creek, Lake Stevens, Marysville, Everett, Duvall, Sultan and nearby towns — all mobile, right at your driveway.\n" +
      "Hours: usually Wednesday–Saturday, afternoons. Never Sundays.\n" +
      "On-site: needs power and water within 20 ft of the vehicle — everything else is covered.",
    booking: "Booking is by text — just text Mikey your vehicle and zip and he'll send a couple of time options and confirm the appointment. There's also an instant-quote tool on mikeysdetailing.com that gives an exact price in about 30 seconds.\n" +
      "For a new customer, find out: their vehicle year/make/model, address or zip, whether they want interior / exterior / or full, the car's current condition (photos help), and the timeframe they're hoping for.\n" +
      "Guarantee: you don't pay until you love it.\n" +
      "No travel fee — the price is the price.\n" +
      "Deposit: none. Cancellation: no cancellation fee.\n" +
      "Payment: cash, Venmo, Zelle, or check.\n" +
      "Lead time: usually booking about a week out.",
    tone: "Friendly and warm, a confident pro, easygoing with a little humor, low-pressure, local and personable. " +
      "Keep it short and casual like a real text. No emoji graphics (no 🚗✨) — but a simple \":)\" now and then is on-brand; that's how Mikey texts. " +
      "Sometimes sign off with \"- Mikey\", but not on every text.",
    faqs: "Q: How much does it cost?\n" +
      "A: Interior details start at $160, exterior at $130, and a full in-and-out starts at $260. Trucks and really dirty vehicles are a bit more. Send me your car's year, make and model plus what you're after and I'll lock in an exact price — and you don't pay until you love it.\n\n" +
      "Q: Do you come to me?\n" +
      "A: Yes, I come to you! All I need is power and water within 20 ft of the vehicle.\n\n" +
      "Q: How long does a full detail take?\n" +
      "A: A first-time full detail usually runs about 3–4 hours.\n\n" +
      "Q: Can you get out pet hair, stains, or smells?\n" +
      "A: Yes! I have a special pet-hair removal process. For carpet and seat stains there's no guaranteeing they'll fully come out, but I'll sure as heck try!\n\n" +
      "Q: Do you do interior-only or exterior-only?\n" +
      "A: Yep! You can book interior-only (starts at $160), exterior-only (starts at $130), or the full in-and-out (starts at $260) — whatever you need.\n\n" +
      "Q: Do you offer ceramic coating or paint correction?\n" +
      "A: I do — ceramic coating, paint correction, and headlight restoration are available as add-ons. Send me your car's info or a photo and I'll get you a price.\n\n" +
      "Q: Do you do regular or recurring cleanings?\n" +
      "A: I do! Recurring members pay less per visit and keep their car looking like the day I first detailed it. Happy to set up a schedule that fits.\n\n" +
      "Q: How far out are you booked?\n" +
      "A: Right now I'm usually booking about a week out.\n\n" +
      "Q: Do you need water and power at my place?\n" +
      "A: Yes — I just need power and water within 20 ft of the vehicle.\n\n" +
      "Q: How do I pay?\n" +
      "A: I accept cash, check, Venmo, and Zelle. And you don't pay until you love it.\n\n" +
      "Q: Do I need to be home while you work?\n" +
      "A: Not at all! I'd prefer you're there at the start and end so we can go over everything, but in between you're free to go about your day.",
    scenarios: "HOW MIKEY HANDLES COMMON SITUATIONS — respond with this same approach, warmth and wording:\n\n" +
      "- Customer says it's more than they wanted to spend / asks for a discount:\n" +
      "  \"I'm sorry to hear that! I can definitely help you mix and match services to get exactly what you need and nothing you don't. What's your budget?\"\n\n" +
      "- Wants it done today / ASAP:\n" +
      "  If booked up: \"Sadly I don't have availability this week, but I'll let you know the moment my next slot opens up.\" If it can be squeezed in: \"I can likely squeeze you in tomorrow if that works!\"\n\n" +
      "- They're outside the service area:\n" +
      "  \"Unfortunately I'm not able to make it out to your area anytime soon — we could plan for next month. If that's not soon enough, I totally understand if you'd rather go with someone else.\"\n\n" +
      "- Arrived but they're not home / can't find access:\n" +
      "  \"Hey, I'm at the address you sent! All I need is the car unlocked and access to power and water — let me know where I can find those.\"\n\n" +
      "- Rain or bad weather on the appointment day:\n" +
      "  \"Hey, the weather isn't looking great today. Any chance we can reschedule? Let me know what day works and I'll get you back on the calendar.\"\n\n" +
      "- Running late:\n" +
      "  \"I'm on my way, just running into a little traffic — ETA is about [time].\"\n\n" +
      "- Unhappy with the result / a complaint (always stay warm and fix it):\n" +
      "  \"I'm so sorry to hear that! I'd be more than happy to come back ASAP and make it right for you.\"",
    rules: "Never promise an exact price or exact appointment time on your own — give the \"starts at\" range and say you'll confirm the exact price.\n" +
      "Never invent details, prices, or policies you don't know.\n" +
      "Only recommend add-ons lightly and when they genuinely fit the car — never pushy.\n" +
      "Always be respectful, low-pressure, and never pushy.\n" +
      "If someone texts STOP, don't text them again.\n" +
      "Never argue with an upset customer — stay calm, apologize, and offer to come back and make it right.",
    examples: "Real texts Mikey has sent — match this exact rhythm, warmth and length:\n" +
      "- \"I can do 10:30 if that works :)\"\n" +
      "- \"Perfect, let's shoot for 10:45.\"\n" +
      "- \"Be there in 20!\"\n" +
      "- \"Ready!\"\n" +
      "- \"Sounds good!\"\n" +
      "- \"Hey, unfortunately I couldn't get a slot for tomorrow. Let me know if there are any days next week that would work for you.\"\n" +
      "- \"Ok, I'll work on getting one of those slots opened up for you right now. Can I get your address?\"\n" +
      "- \"Thank you! I'm looking to open up the Thursday slot for after 3pm. I'll keep in touch and let you know :)\"\n" +
      "- \"Hey Ruth! It'd work best for me to find a time next week for the detail. I'll reach out with the open slots when we're closer to the date. Thanks!\"\n" +
      "- \"Good morning — unfortunately I need to leave town today for an emergency. Any chance we can reschedule for tomorrow at 1pm? Thanks for understanding.\"",
  };
}

const PLAYBOOK_KEYS = ['about', 'services', 'area', 'booking', 'tone', 'faqs', 'scenarios', 'rules', 'examples'];
function sanitizePlaybook(next, prev) {
  const out = Object.assign(defaultPlaybook(), prev || {});
  for (const k of PLAYBOOK_KEYS) {
    if (typeof next[k] === 'string') out[k] = next[k].slice(0, 4000);
  }
  return out;
}

// Normalize the team roster: keep only real members, cap the list, and make sure
// every member has a stable id so assignments and attribution survive edits.
function sanitizeTeam(arr) {
  return (arr || [])
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      id: String(m.id || genId()).slice(0, 24),
      name: String(m.name || '').trim().slice(0, 40),
      role: String(m.role || '').trim().slice(0, 40),
    }))
    .filter((m) => m.name)
    .slice(0, 25);
}

async function loadConfig() {
  if (CFG_CACHE) return CFG_CACHE;
  const raw = await kv().get('config', { type: 'json' });
  CFG_CACHE = Object.assign(defaultConfig(), raw || {});
  return CFG_CACHE;
}

// One-time playbook seed. The live `config` in KV was created before the owner
// filled out his real playbook (services, area, FAQs, voice examples), so its
// playbook is still the generic starter. On the first cron tick after a deploy
// with a newer seed version we upgrade the stored playbook to the current
// defaults, then stamp `playbookSeed` so this never runs again (protecting any
// later dashboard edits). Exactly ONE KV write, ever, per version bump.
const PLAYBOOK_SEED_VERSION = 4;
async function seedPlaybookIfNeeded() {
  const cfg = await loadConfig();
  if ((cfg.playbookSeed || 0) >= PLAYBOOK_SEED_VERSION) return;
  cfg.playbook = Object.assign({}, cfg.playbook || {}, defaultPlaybook());
  cfg.playbookSeed = PLAYBOOK_SEED_VERSION;
  await kv().put('config', JSON.stringify(cfg));
  CFG_CACHE = cfg;
}

async function loadThread(phone) {
  const raw = await kv().get(threadKey(phone), { type: 'json' });
  return Object.assign(blankThread(phone), raw || {});
}

// ⚠ KV WRITE — counts against the ~1,000/day free-tier budget (see note up top).
// Do not call inside a per-thread loop unless the thread actually changed.
async function saveThread(thread) {
  thread.updatedAt = Date.now();
  await kv().put(threadKey(thread.phone), JSON.stringify(thread));
}

async function loadIndex() {
  return (await kv().get(INDEX_KEY, { type: 'json' })) || [];
}

// ⚠ KV WRITE — rewrites the entire index. In cron/loop code, mutate the index in
// memory and call this ONCE at the end, not once per thread (see note up top).
async function saveIndex(index) {
  await kv().put(INDEX_KEY, JSON.stringify(index));
}

function preview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// Build the lightweight index row for a thread. Pure (no KV) so cron loops can
// reuse it while holding the index in memory and batch a single saveIndex().
function buildIndexSummary(thread, cfg) {
  const last = thread.messages[thread.messages.length - 1];
  const plan = computeFollowupPlan(thread, Date.now(), cfg);
  const fu = thread.followup || {};
  // Only mirror a suggestion the current plan still agrees with — if the customer
  // just replied, the old nudge is stale and the badge should clear immediately.
  const sug = (fu.suggestion && plan && fu.suggestion.stepKey === plan.stepKey) ? fu.suggestion : null;
  return {
    phone: thread.phone,
    name: thread.name || '',
    tags: thread.tags || [],
    status: thread.status || '',
    pinned: !!thread.pinned,
    archived: !!thread.archived,
    assignedTo: thread.assignedTo || '',
    unread: thread.unread || 0,
    optedOut: isOptedOut(cfg, thread.phone),
    reminderAt: thread.reminderAt || null,
    reminderNote: (thread.reminderNote || '').slice(0, 120),
    reminderDue: !!(thread.reminderAt && thread.reminderAt <= Date.now()),
    scheduledCount: (thread.scheduled || []).length,
    replyReady: !!(thread.suggested && thread.suggested.text),
    dateRequested: !!thread.dateRequest,
    lastBody: last ? preview(last.body) : '',
    lastDir: last ? last.dir : '',
    lastTs: last ? last.ts : (thread.updatedAt || Date.now()),
    followupNextAt: plan ? plan.dueAt : null,
    followupDue: !!sug,
    fu: sug ? { reason: sug.reason, urgency: sug.urgency, stage: sug.stage, dueAt: sug.dueAt, draft: (sug.draft || '').slice(0, 320) } : null,
  };
}

// Merge `summary` into the in-memory `index`. Returns true only if something
// actually changed, so callers can avoid a pointless saveIndex() write.
function applyIndexSummary(index, summary) {
  const i = index.findIndex((t) => t.phone === summary.phone);
  if (i >= 0) {
    if (JSON.stringify(index[i]) === JSON.stringify(summary)) return false; // no-op, don't spend a write
    index[i] = summary;
  } else {
    index.push(summary);
  }
  return true;
}

async function updateIndexEntry(thread) {
  const cfg = await loadConfig();
  const index = await loadIndex();
  if (applyIndexSummary(index, buildIndexSummary(thread, cfg))) await saveIndex(index);
}

async function appendMessage(phone, message, opts = {}) {
  const thread = await loadThread(phone);
  if (opts.name && !thread.name) thread.name = opts.name;
  message.id = message.id || genId();
  message.ts = message.ts || Date.now();
  thread.messages.push(message);
  if (message.dir === 'in') thread.unread = (thread.unread || 0) + 1;
  // Once Mikey replies, any pre-drafted suggestion is answered — clear it.
  if (message.dir === 'out') thread.suggested = null;
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
// "Learns from your edits" — a small memory of how Mikey rewrites AI drafts
// ===========================================================================
// When Mikey tweaks an AI draft/suggestion before sending, we save the
// before→after pair (capped, most-recent-first) and feed the recent ones back
// into every reply prompt. The AI drifts toward how he actually words things —
// so it literally gets better the more he uses it. One KV write only when he
// actually edits, so it's easy on the write budget.
const EDITS_KEY = 'ai:edits';
async function loadEdits() {
  return (await kv().get(EDITS_KEY, { type: 'json' })) || [];
}
async function recordEdit(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to || from === to) return;          // no change → nothing to learn
  if (to.length > 600 || from.length > 600) return; // skip outliers
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  if (norm(from) === norm(to)) return;              // whitespace/case only
  const list = await loadEdits();
  list.unshift({ from, to, ts: Date.now() });
  await kv().put(EDITS_KEY, JSON.stringify(list.slice(0, 12)));
}
async function editsContext() {
  const recent = (await loadEdits()).filter((e) => e && e.from && e.to).slice(0, 6);
  if (!recent.length) return '';
  const rows = recent.map((e) => `- The draft said: "${e.from}"\n  Mikey changed it to: "${e.to}"`).join('\n');
  return 'HOW MIKEY EDITS DRAFTS (these are his recent corrections — learn the PATTERN of how he rewrites: his length, warmth, word choices — and apply that style, not the specific content):\n' + rows + '\n\n';
}

// Proactively pre-draft a reply the instant a customer texts, so one is already
// waiting when Mikey opens the thread ("reply already waiting"). Best-effort: it
// never blocks or fails the inbound webhook, and only runs when the ball is in
// Mikey's court (last message is inbound, not opted out, not archived).
async function maybeSuggestReply(phone) {
  if (!ENV.GEMINI_API_KEY) return;
  try {
    const cfg = await loadConfig();
    if (isOptedOut(cfg, phone)) return;
    const thread = await loadThread(phone);
    if (thread.archived) return;
    const last = thread.messages[thread.messages.length - 1];
    if (!last || last.dir !== 'in') return;
    const text = await generateReply(thread, cfg, '');
    if (!text) return;
    thread.suggested = { text, ts: Date.now(), forTs: last.ts };
    await saveThread(thread);
    await updateIndexEntry(thread);
  } catch { /* suggestions are a bonus — swallow errors so inbound never breaks */ }
}

// The AI "brain": render the business playbook into a compact prompt preamble so
// every AI output (drafts, polish, follow-ups, summaries, triage, coach) is
// grounded in the real services, pricing, policies and voice. This is what makes
// the writing good enough for a team member to trust and send. Returns '' when
// the playbook is empty so behaviour is unchanged until it's filled in.
const PLAYBOOK_SECTIONS = [
  ['about', 'About the business'],
  ['services', 'Services & pricing'],
  ['area', 'Service area & hours'],
  ['booking', 'Booking & policies'],
  ['tone', 'Voice & tone'],
  ['examples', 'How Mikey texts (copy this voice exactly)'],
  ['faqs', 'Common questions (approved answers)'],
  ['scenarios', 'How Mikey handles common situations'],
  ['rules', 'Golden rules — never break these'],
];
function businessContext(cfg) {
  const p = (cfg && cfg.playbook) || {};
  const rows = PLAYBOOK_SECTIONS
    .filter(([k]) => p[k] && String(p[k]).trim())
    .map(([k, label]) => `## ${label}\n${String(p[k]).trim()}`);
  if (!rows.length) return '';
  return 'BUSINESS PLAYBOOK (your source of truth — never contradict it):\n' + rows.join('\n\n') + '\n\n';
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
  const reqParts = [{ text: prompt }];
  if (opts.images) for (const im of (opts.images || [])) reqParts.push({ inlineData: { mimeType: im.mimeType, data: im.dataB64 } });
  const body = { contents: [{ parts: reqParts }], generationConfig: gen };
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
  try { await sendSms(ENV.MIKEY_PHONE, body, { skipOptOut: true }); return true; }
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
async function sendSms(to, body, opts = {}) {
  const sid = ENV.TWILIO_ACCOUNT_SID;
  const token = ENV.TWILIO_AUTH_TOKEN;
  const toNorm = normalizePhone(to) || to;
  // Opt-out guard: never text a number that sent STOP. Skipped for alerts to Mikey
  // himself (opts.skipOptOut) so notifications always get through.
  if (!opts.skipOptOut) {
    const cfg = await loadConfig();
    if (isOptedOut(cfg, toNorm) && toNorm !== normalizePhone(ENV.MIKEY_PHONE)) {
      throw new Error('recipient_opted_out');
    }
  }
  const form = { From: ENV.TWILIO_FROM, To: toNorm, Body: body };
  // Attach a delivery StatusCallback so failures surface (see handleStatusCallback).
  const base = publicBase();
  if (base && !opts.skipOptOut) form.StatusCallback = `${base}/status`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
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
// Webhook security + opt-out ledger
// ===========================================================================
// Read a Twilio (x-www-form-urlencoded) POST body into a plain object.
async function formParams(request) {
  const form = await request.formData();
  const out = {};
  for (const [k, v] of form) out[k] = v;
  return out;
}
function forbidden() { return new Response('Forbidden', { status: 403 }); }

// Validate Twilio's X-Twilio-Signature so only real Twilio webhooks are accepted.
// Twilio signs base64( HMAC-SHA1( authToken, fullURL + sorted(key+value)… ) ).
//
// SAFE ROLLOUT — enforcement is OPT-IN. It stays OFF until you set the Worker var
// TWILIO_SIGNATURE_ENFORCE=1, so deploying this can NEVER silently 403 real inbound
// texts/calls before you've confirmed the signed URL matches. To turn it on:
//   1. Add  TWILIO_SIGNATURE_ENFORCE = 1  in Worker → Settings → Variables.
//   2. Send yourself a text + do a test call; confirm both land in the dashboard.
//   3. If webhooks stop arriving, the configured Twilio URL and the Worker's URL
//      disagree — remove the var (instantly back to accept-all) and check that the
//      Twilio Messaging/Voice webhooks point at exactly https://<worker>/sms etc.
async function verifyTwilio(request, params) {
  if (!envFlag('TWILIO_SIGNATURE_ENFORCE')) return true; // opt-in; off = accept as before
  const token = ENV.TWILIO_AUTH_TOKEN;
  if (!token) return true; // nothing to validate against — don't lock ourselves out
  const sig = request.headers.get('X-Twilio-Signature');
  if (!sig) return false;
  let data = request.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, sig);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Opt-out ledger lives in the (cached) config doc — opt-outs are rare, so the
// occasional extra write is cheap, and reads piggyback on the per-invocation cache.
function isOptedOut(cfg, phone) {
  return !!(cfg && Array.isArray(cfg.optedOut) && cfg.optedOut.includes(phone));
}
async function setOptOut(phone, on) {
  const cfg = Object.assign({}, await loadConfig());
  const list = Array.isArray(cfg.optedOut) ? cfg.optedOut.slice() : [];
  const has = list.includes(phone);
  if (on && !has) list.push(phone);
  if (!on && has) list.splice(list.indexOf(phone), 1);
  cfg.optedOut = list;
  await kv().put('config', JSON.stringify(cfg));
  CFG_CACHE = cfg;
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
        const r = await sendSms(thread.phone, s.body);
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled', status: 'sent', sid: (r && r.sid) || undefined });
        sent++;
      } catch (err) {
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled', error: String(err.message || err) });
        notifyMikey('⚠️ Scheduled text failed', `A scheduled message to ${thread.name || thread.phone} did not send: ${String(err.message || err)}`).catch(() => {});
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
