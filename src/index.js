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
 *                   /api/money/* (profit tracker — see the Money module)
 *
 * Required secrets (wrangler secret put ...):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, MIKEY_PHONE
 *   GEMINI_API_KEY        (optional — only the AI endpoints need it)
 *   GEMINI_MODEL          (optional — defaults to gemini-2.0-flash)
 *   ANTHROPIC_API_KEY     (optional — when set, Claude writes the customer-facing
 *                          drafts because it holds a specific person's voice far
 *                          better; everything else stays on Gemini. Falls back to
 *                          Gemini automatically if missing or erroring.)
 *   ANTHROPIC_MODEL       (optional — defaults to claude-opus-5)
 *   CLAUDE_DISABLED       (optional kill switch — set to "1" to force drafting
 *                          back onto Gemini without removing the key)
 *   CALL_BRIDGE_PHONE     (optional — the handset dashboard click-to-call rings
 *                          before bridging to the customer; defaults to
 *                          +14252321355. Used ONLY for outbound click-to-call;
 *                          alerts and inbound forwarding still use MIKEY_PHONE.)
 *   RESEND_API_KEY        (optional — email alerts instead of texting yourself)
 *   ALERT_EMAIL           (optional — where alerts go; defaults to nothing)
 *   ALERT_FROM            (optional — verified sender; defaults to Resend's)
 *   FOLLOWUPS_DISABLED    (optional kill switch — set to "1" in the Cloudflare
 *                          dashboard to stop the follow-up cron WITHOUT a KV
 *                          write, for when the daily write limit is exhausted and
 *                          the in-app toggle therefore can't save. Unset to resume.)
 *   USAGE_OFF=1            (kill switch for dashboard usage tracking — stops the
 *                          collectors and their KV writes. Also a var, for the
 *                          same reason: it has to work with writes exhausted.)
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
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ⚠  CPU TIME — A SEPARATE LIMIT FROM THE ONE ABOVE. BOTH APPLY.            │
 * ├───────────────────────────────────────────────────────────────────────────┤
 * │ The free tier also caps CPU at ~10ms PER INVOCATION. Not a daily budget:  │
 * │ every request and every cron tick gets its own 10ms, and one that runs    │
 * │ over is KILLED MID-TASK. That shows up as a dropped alert, a follow-up    │
 * │ that never fires, or a webhook Twilio sees fail — not as a clean error.   │
 * │                                                                           │
 * │ The write box above says "reads are far cheaper". That is true of the     │
 * │ daily QUOTA and FALSE of CPU. `kv().get(k, {type:'json'})` parses that    │
 * │ JSON on our clock, so a read of the index or a fat thread is one of the   │
 * │ most expensive things we do. Waiting on fetch/KV is free; parsing,        │
 * │ stringifying, string-building and looping are not.                        │
 * │                                                                           │
 * │ RULES:                                                                    │
 * │   1. Load a KV doc ONCE per invocation and pass it down. loadConfig()     │
 * │      and loadIndex() are memoized for exactly this reason — do not add    │
 * │      a raw kv().get() for a doc one of them already holds.                │
 * │   2. Never build a timezone formatter inside a loop. Go through           │
 * │      localDateStr/localHour/localDow, which reuse a cached formatter      │
 * │      (see tzFmt) — a bare .toLocaleString({timeZone}) builds a new one    │
 * │      every call.                                                          │
 * │   3. Anything that loads N threads in one invocation (batchLoadThreads,   │
 * │      apiSnapshot, buildBrief) scales its CPU with N. Bound N, or move it  │
 * │      off the request path — it is fine at 20 conversations and not at     │
 * │      500.                                                                 │
 * │   4. Per-tick cron work must be flat, not per-thread. The guard that      │
 * │      keeps writes down (skip before loading) is the same guard that       │
 * │      keeps CPU down — do not load a thread you are not going to act on.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

// env is identical across every request of a deployment (bindings + secrets
// don't change per request), so stashing it in module scope is safe even under
// concurrency. Each invocation sets it before doing any work.
let ENV = null;
// Per-invocation cache of the KV `config` doc so a single request/cron tick
// doesn't re-read it for every thread it touches. Cleared at the top of each
// entry point so a settings change is picked up on the very next invocation.
let CFG_CACHE = null;
// Same idea for the thread index, and for a bigger reason: the index is the
// largest doc we own, and `{type:'json'}` parses it on OUR CPU clock. A minute
// cron that loads it in four separate sub-jobs paid for four full parses of every
// conversation, every minute, forever — which is what put us over the CPU limit
// (see the CPU TIME box up top). Cleared per invocation, same as CFG_CACHE.
let IDX_CACHE = null;
// Every per-invocation cache is dropped here, and both entry points call it
// before doing any work. One function rather than a line per cache: the reason
// the CPU limit crept up on us is that "this is memoized" was knowledge living in
// four separate places, and the next cache added has to be freed here too.
function resetInvocationCaches() { CFG_CACHE = null; IDX_CACHE = null; }
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
const BUILD = '2026-08-25·usage';

// Truthy-check a Worker var/secret. Used for kill switches that must work even
// when KV writes are blocked (the in-app toggles all persist to KV, so they're
// useless once the daily write limit is hit — a var is set in the Cloudflare
// dashboard with no KV write). Accepts 1/true/yes/on (case-insensitive).
function envFlag(name) {
  const v = String((ENV && ENV[name]) || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export default {
  async fetch(request, env, ctx) {
    ENV = env; resetInvocationCaches();
    try {
      return await handle(request);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    } finally {
      // Usage counts ride out AFTER the response, never in front of it. The
      // buffer decides for itself whether it's due (see useMaybeFlush), so this
      // costs a KV write at most once every USE_FLUSH_MS however hard he taps —
      // and a slow KV day can never show up as a slow dashboard.
      try { if (ctx && ctx.waitUntil) ctx.waitUntil(useMaybeFlush(false)); } catch (e) {}
    }
  },
  async scheduled(event, env, ctx) {
    ENV = env; resetInvocationCaches();
    ctx.waitUntil(runCron());
  },
};

// The minute cron does two jobs: deliver any due scheduled sends, then advance
// the auto follow-up engine (surface nudges + fire autopilot sends).
async function runCron() {
  await seedPlaybookIfNeeded();
  await dispatchDueScheduled();
  await dispatchDueReminders();
  // "I'll get back to you Monday" — nudge him when the time he promised arrives.
  await dispatchDuePromises().catch(() => {});
  await evaluateFollowups();
  // Card charges shipped with the deploy (see LEDGER_SEEDS). No-ops after the
  // first tick that lands them.
  await applyLedgerSeeds().catch(() => {});
  await moneyCron().catch(() => {}); // money reminders must never break the SMS cron
  // One KV write a day: snapshot the KPIs that cannot be reconstructed later.
  await recordPulse().catch(() => {});
  // Land any AI counts this isolate is still holding, so a quiet stretch after a
  // busy one doesn't leave the last few calls unrecorded. No-op when empty.
  await flushAiUsage().catch(() => {});
  // Same idea for the usage gate, but NOT forced: this tick runs every minute,
  // and a forced flush in an isolate that has been serving requests would be
  // 1,440 writes a day entirely by itself. It writes only once it is due.
  await useMaybeFlush(false).catch(() => {});
  // Job Day suite. Both are write-frugal by design: the brief stamps one key a
  // day, the invoice sweep only writes when something is actually overdue.
  await maybeDailyBrief().catch(() => {});
  await maybeWeeklyRecap().catch(() => {});
  await maybePayReminders().catch(() => {});
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
  if (request.method === 'POST' && pathname === '/qqc-text')       return handleQqcText(request);
  if (request.method === 'POST' && pathname === '/sms')            return handleInboundSms(request);
  if (request.method === 'POST' && pathname === '/call')           return handleInboundCall(request);
  if (request.method === 'POST' && pathname === '/call-screen')    return handleCallScreen(request);
  if (request.method === 'POST' && pathname === '/voicemail')      return handleVoicemail(request);
  if (request.method === 'POST' && pathname === '/voicemail-done') return handleVoicemailDone(request);
  if (request.method === 'POST' && pathname === '/voicemail-tx')   return handleVoicemailTranscription(request);
  if (request.method === 'POST' && pathname === '/status')         return handleStatusCallback(request);
  if (request.method === 'POST' && pathname === '/email-in')       return handleEmailIn(request);
  // First-party website analytics pixel (public, no auth — it's called from the
  // owner's marketing site). Accepts GET beacons and returns a 1x1 GIF.
  if (request.method === 'GET'  && pathname === '/px')             return handlePixel(url, request);
  if (request.method === 'POST' && pathname === '/px/e')            return handlePixelEvents(request);
  if (request.method === 'OPTIONS' && pathname === '/px/e')          return pxOk();

  // ---- Public booking API (customer-facing /book.html — MUST stay above the /api auth gate) ----
  if (request.method === 'GET'  && (pathname === '/book' || pathname === '/book/')) return Response.redirect(new URL('/book.html', request.url).toString(), 302);
  if (request.method === 'GET'  && pathname === '/api/book-config')  return apiBookConfig();
  if (request.method === 'GET'  && pathname === '/api/availability') return apiAvailability(url);
  if (request.method === 'POST' && pathname === '/api/book')         return apiBook(request);

  // ---- Public customer pages (MUST stay above the /api auth gate) ----
  // /t/<token> — the live "Mikey's on his way" ETA tracker the customer opens.
  // /p/<token> — the pay page a payment-request text links to.
  if (request.method === 'GET'  && pathname.startsWith('/t/'))      return trackPage(pathname.slice(3).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40));
  if (request.method === 'GET'  && pathname.startsWith('/p/'))      return payPage(pathname.slice(3).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40));
  if (request.method === 'GET'  && pathname === '/api/track/state') return apiTrackState(url);
  // /c/<token> — the customer's own page: what's booked, book a time, what I've done
  if (request.method === 'GET'  && pathname.startsWith('/c/'))      return custPage(pathname.slice(3).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80));
  if (request.method === 'GET'  && pathname === '/api/cust/state')  return apiCustState(url);
  if (request.method === 'POST' && pathname === '/api/cust/action') return apiCustAction(request, url);

  if (request.method === 'GET'  && pathname === '/api/version')    return json({ ok: true, build: BUILD });
  if (request.method === 'POST' && pathname === '/api/login')      return apiLogin(request);
  if (request.method === 'POST' && pathname === '/api/logout')     return apiLogout();
  // Everything else under /api/ requires the dashboard password (once one is set).
  if (pathname.startsWith('/api/') && !(await isAuthed(request)))   return json({ ok: false, error: 'unauthorized' }, 401);
  // Past the gate = a real, authenticated use of a real feature. Buffered, never
  // written here: see noteApiUse. This is the half of usage tracking that keeps
  // working when the browser is serving a stale cached shell.
  if (pathname.startsWith('/api/')) noteApiUse(pathname, request.method);

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
  if (request.method === 'GET'  && pathname === '/api/snapshot')    return apiSnapshot(url);
  if (request.method === 'GET'  && pathname === '/api/emails')     return apiEmails();
  if (request.method === 'POST' && pathname === '/api/email-read') return apiEmailRead(request);
  if ((request.method === 'GET' || request.method === 'POST') && pathname === '/api/email-setup') return apiEmailSetup(request);
  if (request.method === 'POST' && pathname === '/api/assist/practice') return apiAssistPractice(request);
  // Voice training — teaching the AI to sound like Mikey (see the VOICE module).
  if (request.method === 'GET'  && pathname === '/api/voice/stats')        return apiVoiceStats();
  if (request.method === 'POST' && pathname === '/api/voice/build')        return apiVoiceBuild();
  if (request.method === 'POST' && pathname === '/api/voice/replay')       return apiVoiceReplayNext(request);
  if (request.method === 'POST' && pathname === '/api/voice/score')        return apiVoiceReplayScore(request);
  if (request.method === 'POST' && pathname === '/api/voice/import')       return apiVoiceImport(request);
  // Predictive keyboard — next-word suggestions built from that same corpus.
  if (request.method === 'GET'  && pathname === '/api/ai/style')           return apiAiStyle(url);
  if (request.method === 'POST' && pathname === '/api/ai/predict')         return apiAiPredict(request);
  if (request.method === 'GET'  && pathname === '/api/ai/usage')           return apiAiUsage(url);
  if (request.method === 'GET'  && pathname === '/api/media')      return apiMediaProxy(url);
  if (request.method === 'POST' && pathname === '/api/media-backfill') return apiMediaBackfill(request);
  if (request.method === 'POST' && pathname === '/api/voicemail-backfill') return apiVoicemailBackfill(request);
  if (request.method === 'POST' && pathname === '/api/alert-test') return apiAlertTest();
  if (request.method === 'GET'  && pathname === '/api/followups')  return apiFollowups();
  if (request.method === 'POST' && pathname === '/api/followup')   return apiFollowupAction(request);
  if (request.method === 'GET'  && pathname === '/api/ai/rules')   return apiRulesGet();
  if (request.method === 'POST' && pathname === '/api/ai/rules')   return apiRulesPost(request);
  if (request.method === 'GET'  && pathname === '/api/config')     return apiGetConfig();
  if (request.method === 'POST' && pathname === '/api/config')     return apiSaveConfig(request);
  // ---- Booking management (authed — the Bookings dashboard view) ----
  if (request.method === 'GET'  && pathname === '/api/bookings')   return apiBookings(url);
  if (request.method === 'POST' && pathname === '/api/booking')    return apiBookingAction(request);
  if (request.method === 'GET'  && pathname === '/api/booking-settings') return apiBookingSettings();
  if (request.method === 'POST' && pathname === '/api/booking-settings') return apiSaveBookingSettings(request);
  if (request.method === 'POST' && pathname === '/api/booking-cal-test') return apiCalTest(request);
  if (request.method === 'POST' && pathname === '/api/block')      return apiBlock(request);
  if (request.method === 'GET'  && pathname === '/api/migrate')    return apiMigrate(url);
  if (request.method === 'GET'  && pathname === '/api/templates')  return apiGetTemplates();
  if (request.method === 'POST' && pathname === '/api/templates')  return apiSaveTemplates(request);
  if (request.method === 'POST' && pathname === '/api/ai/summary') return apiAiSummary(request);
  if (request.method === 'POST' && pathname === '/api/ai/recap')   return apiAiRecap(request);
  if (request.method === 'POST' && pathname === '/api/ai/draft')   return apiAiDraft(request);
  if (request.method === 'POST' && pathname === '/api/ai/triage')  return apiAiTriage();
  if (request.method === 'POST' && pathname === '/api/ai/coach')   return apiAiCoach(request);
  if (request.method === 'POST' && pathname === '/api/ai/photo-quote') return apiAiPhotoQuote(request);
  if (request.method === 'POST' && pathname === '/api/ai/money')    return apiAiMoney(request);
  if (request.method === 'POST' && pathname === '/api/ai/command')  return apiAiCommand(request);
  if (request.method === 'POST' && pathname === '/api/ai/analyze')  return apiAiAnalyze(request);
  if (request.method === 'POST' && pathname === '/api/ai/agent')    return apiAiAgent(request);
  if (request.method === 'POST' && pathname === '/api/ai/generate') return apiAiGenerate(request);

  // QQC quote log (Analytics → Quotes) — every quote the form has sent in.
  if (request.method === 'GET'  && pathname === '/api/journeys')      return apiJourneys(url);
  if (request.method === 'GET'  && pathname === '/api/journey')       return apiJourney(url);
  if (request.method === 'POST' && pathname === '/api/journey/ai')    return apiJourneyAi(request);

  // Dashboard usage — the same recording trick as the journeys above, pointed
  // at this app instead of the website. /api/use is the browser's batch; the
  // gate below counts the server side on its own.
  if (request.method === 'POST' && pathname === '/api/use')           return apiUseIngest(request);
  if (request.method === 'GET'  && pathname === '/api/use')           return apiUse(url);
  if (request.method === 'GET'  && pathname === '/api/use/export')    return apiUseExport(url);
  if (request.method === 'POST' && pathname === '/api/use/ai')        return apiUseAi(request);
  if (request.method === 'GET'  && pathname === '/api/quotes')        return apiQuotes(url);
  if (request.method === 'GET'  && pathname === '/api/quotes/export') return apiQuotesExport(url);
  if (request.method === 'POST' && pathname === '/api/quotes/import') return apiQuotesImport(request);

  // Website analytics (Grow hub) — rollup of the /px pixel data.
  if (request.method === 'GET'  && pathname === '/api/analytics')   return apiAnalytics(url);

  // Website analytics command center — GA4 + Microsoft Clarity, merged & cached.
  if (request.method === 'GET'  && pathname === '/api/webstats')            return apiWebstats(url);
  if (request.method === 'GET'  && pathname === '/api/webstats/status')     return apiWebstatsStatus();
  if (request.method === 'POST' && pathname === '/api/webstats/connect')    return apiWebstatsConnect(request);
  if (request.method === 'POST' && pathname === '/api/webstats/disconnect') return apiWebstatsDisconnect(request);
  if (request.method === 'POST' && pathname === '/api/webstats/ai')         return apiWebstatsAi(request);

  // Map rank grid — Google Maps rank at a grid of points (Local Falcon style).
  if (request.method === 'GET'  && pathname === '/api/geogrid')            return apiGeogrid();
  if (request.method === 'POST' && pathname === '/api/geogrid/scan')       return apiGeogridScan(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/save')       return apiGeogridSave(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/connect')    return apiGeogridConnect(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/find')       return apiGeogridFind(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/preview')    return apiGeogridPreview(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/disconnect') return apiGeogridDisconnect(request);
  if (request.method === 'POST' && pathname === '/api/geogrid/delete')     return apiGeogridDelete(request);

  // Business intelligence — the five deep-analytics reports.
  if (request.method === 'GET'  && pathname === '/api/intel/customers') return apiIntelCustomers();
  if (request.method === 'GET'  && pathname === '/api/intel/services')  return apiIntelServices();
  if (request.method === 'GET'  && pathname === '/api/intel/forecast')  return apiIntelForecast();
  if (request.method === 'GET'  && pathname === '/api/intel/pulse')     return apiIntelPulse();

  // Money tracker (its own dashboard section — see the Money module below)
  if (request.method === 'GET'  && pathname === '/api/money')          return apiMoney(url);
  if (request.method === 'POST' && pathname === '/api/money/entry')    return apiMoneyEntry(request);
  if (request.method === 'POST' && pathname === '/api/money/delete')   return apiMoneyDelete(request);
  if (request.method === 'GET'  && pathname === '/api/money/report')   return apiMoneyReport(url);
  if (request.method === 'GET'  && pathname === '/api/money/by-phone') return apiMoneyByPhone(url);
  if (request.method === 'GET'  && pathname === '/api/money/export')   return apiMoneyExport();
  if (request.method === 'POST' && pathname === '/api/money/import')   return apiMoneyImport(request);
  if (request.method === 'GET'  && pathname === '/api/money/config')   return apiMoneyGetConfig();
  if ((request.method === 'GET' || request.method === 'POST') && pathname === '/api/money/receipt') return apiMoneyReceipt(request, url);
  if (request.method === 'POST' && pathname === '/api/money/config')   return apiMoneySaveConfig(request);
  if (request.method === 'POST' && pathname === '/api/money/balance')  return apiMoneySetBalance(request);

  // ---- Job Day suite (see the JOB DAY SUITE block near the bottom of this file) ----
  // Today's Run
  if (request.method === 'GET'  && pathname === '/api/day')            return apiDay(url);
  if (request.method === 'POST' && pathname === '/api/day/state')      return apiDayState(request);
  if (request.method === 'GET'  && pathname === '/api/detections')     return apiDetections();
  if (request.method === 'POST' && pathname === '/api/detection')      return apiDetectionAction(request);
  // Promises he made to customers ("I'll get back to you Monday").
  if (request.method === 'GET'  && pathname === '/api/promises')       return apiPromises();
  if (request.method === 'POST' && pathname === '/api/promise')        return apiPromiseAction(request);
  if (request.method === 'POST' && pathname === '/api/promises/scan')  return apiPromiseScan(request);
  if (request.method === 'GET'  && pathname === '/api/promise.ics')    return apiPromiseIcs(url);
  if (request.method === 'POST' && pathname === '/api/day/job')        return apiDayJob(request);
  if (request.method === 'POST' && pathname === '/api/day/remove')     return apiDayRemove(request);
  if (request.method === 'POST' && pathname === '/api/day/order')      return apiDayOrder(request);
  // Live ETA tracking (the customer-facing page + /api/track/state are public, above)
  if (request.method === 'POST' && pathname === '/api/track/start')    return apiTrackStart(request);
  if (request.method === 'POST' && pathname === '/api/track/ping')     return apiTrackPing(request);
  if (request.method === 'POST' && pathname === '/api/track/stop')     return apiTrackStop(request);
  // Web push
  if (request.method === 'GET'  && pathname === '/api/push/key')       return apiPushKey();
  if (request.method === 'POST' && pathname === '/api/push/subscribe') return apiPushSubscribe(request);
  if (request.method === 'POST' && pathname === '/api/push/unsubscribe') return apiPushUnsubscribe(request);
  if (request.method === 'POST' && pathname === '/api/push/test')      return apiPushTest();
  if (request.method === 'GET'  && pathname === '/api/push/peek')      return apiPushPeek();
  // Quote builder
  if (request.method === 'GET'  && pathname === '/api/quote/config')   return apiQuoteConfig();
  if (request.method === 'POST' && pathname === '/api/quote')          return apiQuoteCreate(request);
  if (request.method === 'POST' && pathname === '/api/quote/action')   return apiQuoteAction(request);
  // Get paid
  if (request.method === 'GET'  && pathname === '/api/pay')            return apiPay();
  if (request.method === 'POST' && pathname === '/api/pay/config')     return apiPaySaveConfig(request);
  if (request.method === 'POST' && pathname === '/api/pay/request')    return apiPayRequest(request);
  if (request.method === 'POST' && pathname === '/api/pay/action')     return apiPayAction(request);
  // Customer garage
  if (request.method === 'GET'  && pathname === '/api/garage')         return apiGarage(url);

  // Money on the table — quotes gone quiet, customers due again, leads that never booked
  if (request.method === 'GET'  && pathname === '/api/cold')           return apiCold();
  if (request.method === 'POST' && pathname === '/api/cold/action')    return apiColdAction(request);

  // Pricing — what you charge vs what actually gets accepted
  if (request.method === 'GET'  && pathname === '/api/pricing')        return apiPricing(url);

  // The customer's own link — minted once per customer, then reused forever
  if (request.method === 'POST' && pathname === '/api/cust/link')      return apiCustLink(request);

  // Maintenance plans — the every-N-weeks rhythm behind a rebook
  if ((request.method === 'GET' || request.method === 'POST') && pathname === '/api/plan') return apiPlan(request, url);
  // Neighborhood blast
  if (request.method === 'GET'  && pathname === '/api/blast/candidates') return apiBlastCandidates(url);
  if (request.method === 'POST' && pathname === '/api/blast/send')     return apiBlastSend(request);
  // Before / after photos
  if (request.method === 'GET'  && pathname === '/api/photos')         return apiPhotosList(url);
  if (request.method === 'POST' && pathname === '/api/photos')         return apiPhotoUpload(request);
  if (request.method === 'GET'  && pathname === '/api/photos/img')     return apiPhotoImg(url);
  if (request.method === 'POST' && pathname === '/api/photos/delete')  return apiPhotoDelete(request);
  // Daily brief
  if (request.method === 'GET'  && pathname === '/api/brief')          return apiBrief(url);

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
  markSource(thread, 'quote');
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
  // `alertOnSend` makes the cron text him the moment it actually lands, so the 3.5
  // minutes of silence after the lead alert isn't a mystery — see dispatchDueScheduled.
  let clientSms = 'skipped';
  if (consent) {
    thread.scheduled.push({ id: genId(), body: clientMsg, sendAt: Date.now() + FIRST_REACHOUT_DELAY_MS, alertOnSend: true });
    thread.scheduled.sort((a, b) => a.sendAt - b.sendAt);
    clientSms = 'scheduled';
  }
  await saveThread(thread);
  await updateIndexEntry(thread);
  await logQuote({
    name, phone: clientPhone, email, location, total, vehicle, condition,
    services: serviceList, notes, type: body.type, appointment: body.appointment,
  });
  // Put a name on whatever browsing led here. The form carries the visitor id
  // from site-stats.js; without it this is a no-op and the lead is unaffected.
  await journeyLink(body.vid, clientPhone, name);

  const ok = mikeyAlert;
  return cors(json({ ok, clientSms, mikeyAlert }, ok ? 200 : 207));
}

// QQC quote-form auto-text — a faithful port of the (dead-since-6/22) Make scenario
// "Mikey QQC Auto-Text", moved into the Worker so it can't break on a missing Make
// function and stops burning Make credits. Reuses the Twilio creds already here.
//
// Replicates the Make flow exactly:
//   1. Text Mikey immediately:  🔔 NEW QUOTE — name, phone, $total, vehicle, services
//   2. ~3.5 min later, text the customer the first reach-out — but only when they
//      consented (Make's filter: smsConsent != "false") and the phone is a valid +1.
// Improvements over Make: the delayed text goes through the reserve-then-send cron
// (at-most-once, opt-out aware, delivery-tracked), the lead is recorded in the
// dashboard, and Mikey gets a second text confirming the reach-out actually landed
// (`alertOnSend`). Accepts JSON or form-encoded bodies. No new secrets needed.
async function handleQqcText(request) {
  let body = {};
  try {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ct.includes('application/json')) body = await request.json();
    else { const form = await request.formData(); for (const [k, v] of form) body[k] = v; }
  } catch { return cors(json({ ok: false, error: 'bad_body' }, 400)); }

  // Bot honeypot — real customers never fill these hidden fields.
  if (body.website || body._gotcha || body.hp) return cors(json({ ok: true, clientSms: 'skipped', mikeyAlert: false }, 200));

  const name = String(body.name || '').trim();
  const clientPhone = normalizePhone(body.phone);
  if (!name || !clientPhone) return cors(json({ ok: false, error: 'missing_fields' }, 422));

  const total = body.total;
  const vehicle = body.vehicle ? String(body.vehicle).trim() : '';
  const services = Array.isArray(body.services) ? body.services.join(', ') : (body.services ? String(body.services).trim() : '');
  const quoteLine = total ? `$${total}` : 'TBD';
  // Make's filter: send to the customer UNLESS smsConsent is explicitly "false".
  const consent = String(body.smsConsent).toLowerCase() !== 'false';

  const first = name.split(/\s+/)[0];
  const clientMsg =
    `Hey ${first}, it's Mikey. I got your quote submission on my site. ` +
    `Whenever you have a minute, feel free to send over the year, make, and model of the car ` +
    `you'd like detailed, and I'll confirm that price. Talk soon!`;
  const mikeyMsg = `🔔 NEW QUOTE — ${name}, ${clientPhone}, ${quoteLine}` +
    (vehicle ? `, ${vehicle}` : '') + (services ? `, ${services}` : '');

  const mikeyAlert = await notifyMikey(`🔔 New quote — ${name}`, mikeyMsg);

  // Record the lead and queue the delayed reach-out via the existing scheduler.
  const thread = await loadThread(clientPhone);
  if (!thread.name) thread.name = name;
  if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
  const email = body.email ? String(body.email).trim() : '';
  const location = body.location ? String(body.location).trim() : '';
  const condition = body.condition ? String(body.condition).trim() : '';
  const notes = body.notes ? String(body.notes).trim() : '';
  const detail = [
    vehicle ? `Vehicle: ${vehicle}` : null,
    condition ? `Condition: ${condition}` : null,
    services ? `Services: ${services}` : null,
    `Quote: ${quoteLine}`,
    email ? `Email: ${email}` : null,
    location ? `City: ${location}` : null,
    notes ? `Notes: ${notes}` : null,
  ].filter(Boolean).join('\n');
  if (detail && !thread.notes) thread.notes = `QQC quote (${new Date().toLocaleDateString()}):\n${detail}`;
  let clientSms = 'skipped';
  if (consent) {
    thread.scheduled.push({ id: genId(), body: clientMsg, sendAt: Date.now() + 210000, alertOnSend: true }); // 3.5 min, like Make's Sleep
    thread.scheduled.sort((a, b) => a.sendAt - b.sendAt);
    clientSms = 'scheduled';
  }
  await saveThread(thread);
  await updateIndexEntry(thread);
  await logQuote({
    name, phone: clientPhone, email, location, total: body.total, vehicle,
    condition, services, notes, type: body.type, appointment: body.appointment,
  });
  return cors(json({ ok: !!mikeyAlert, clientSms, mikeyAlert }, mikeyAlert ? 200 : 207));
}

// ===========================================================================
// QQC quote log  (Analytics → Quotes)
// ---------------------------------------------------------------------------
// Every quote the Quick-Quote Concierge posts to /submit or /qqc-text is
// appended here, so the dashboard can show what came in over time. The lead
// itself still lives on its conversation thread; this is the flat history a
// thread can't be. Thread notes only ever keep a customer's FIRST quote
// (`if (detail && !thread.notes)` above), so before this log a repeat quote
// left no trace anywhere but Mikey's email.
//
// Storage mirrors the money tracker — one doc per month, so a year of history
// is 12 small reads and a new quote costs a single write:
//   quotes:m:YYYY-MM — { entries: [ { id, ts, date, name, phone, total, … } ] }
// ===========================================================================
const quotesKey = (m) => 'quotes:m:' + m;

async function loadQuoteMonth(m) {
  return (await kv().get(quotesKey(m), { type: 'json' })) || { entries: [] };
}
// ⚠ KV WRITE — one per submitted quote, plus the one-time backfill import.
// Never called from a loop over threads.
async function saveQuoteMonth(m, doc) {
  await kv().put(quotesKey(m), JSON.stringify(doc));
}

// Shape + trim one quote for the log. Returns null when it isn't usable.
function normalizeQuote(q, tz) {
  if (!q) return null;
  const ts = Number(q.ts) > 0 ? Number(q.ts) : Date.now();
  const name = String(q.name || '').trim();
  if (!name) return null;
  const total = Math.round(Number(q.total) || 0);
  return {
    id: q.id || genId(),
    ts,
    date: localDateStr(ts, tz),
    name,
    phone: q.phone ? String(q.phone) : '',
    total: total > 0 ? total : 0,
    vehicle: String(q.vehicle || '').trim(),
    condition: String(q.condition || '').trim(),
    services: Array.isArray(q.services) ? q.services.join(', ') : String(q.services || '').trim(),
    location: String(q.location || '').trim(),
    email: String(q.email || '').trim(),
    notes: String(q.notes || '').trim(),
    // A QQC booking posts to the same endpoint with type:'booking' — worth
    // separating, since a booked slot is a much warmer lead than a bare quote.
    type: q.type === 'booking' ? 'booking' : 'quote',
    appointment: String(q.appointment || '').trim(),
  };
}

// Append one quote to its month. Never throws: losing a log line must not cost
// Mikey the lead alert or the customer their auto-text.
async function logQuote(q) {
  try {
    const cfg = await loadConfig();
    const entry = normalizeQuote(q, cfg.tz);
    if (!entry) return;
    const month = entry.date.slice(0, 7);
    const doc = await loadQuoteMonth(month);
    // Same phone + same total within 10 minutes is the form double-firing (it
    // posts here and to Web3Forms in parallel) or a customer re-tapping submit.
    const dupe = (doc.entries || []).some(
      (e) => e.phone === entry.phone && e.total === entry.total && Math.abs(e.ts - entry.ts) < 600000,
    );
    if (dupe) return;
    doc.entries.push(entry);
    await saveQuoteMonth(month, doc);
  } catch { /* best effort — the submission itself already succeeded */ }
}

// The N months ending with the current one, newest first.
async function quoteWindow(months, tz) {
  let m = localDateStr(Date.now(), tz).slice(0, 7);
  const keys = [];
  for (let i = 0; i < months; i++) { keys.push(m); m = prevMonthKey(m); }
  const docs = await Promise.all(keys.map(loadQuoteMonth));
  return keys.map((month, i) => ({ month, entries: (docs[i] && docs[i].entries) || [] }));
}

function quoteMonthsParam(url) {
  const n = parseInt(url.searchParams.get('months') || '6', 10);
  if (!(n >= 1)) return 6;
  return Math.min(n, 24);
}

// GET /api/quotes?months=6 — everything the Quotes view draws: per-month
// rollups (oldest → newest, so it plots left to right) and the flat list.
async function apiQuotes(url) {
  const cfg = await loadConfig();
  const win = await quoteWindow(quoteMonthsParam(url), cfg.tz);
  const entries = [];
  const months = win.map((m) => {
    let value = 0, priced = 0;
    m.entries.forEach((e) => { value += e.total || 0; if (e.total > 0) priced++; entries.push(e); });
    return {
      month: m.month,
      count: m.entries.length,
      value,
      // Averaged over PRICED quotes only — a booking can come in with no total,
      // and counting it as a $0 quote would drag the average down.
      avg: priced ? Math.round(value / priced) : 0,
      booked: m.entries.filter((e) => e.type === 'booking').length,
    };
  }).reverse();
  entries.sort((a, b) => b.ts - a.ts);
  const value = entries.reduce((s, e) => s + (e.total || 0), 0);
  const priced = entries.filter((e) => e.total > 0).length;
  return json({
    ok: true,
    today: localDateStr(Date.now(), cfg.tz),
    months,
    entries,
    summary: {
      count: entries.length,
      value,
      avg: priced ? Math.round(value / priced) : 0,
      booked: entries.filter((e) => e.type === 'booking').length,
      best: entries.reduce((b, e) => ((e.total || 0) > b ? e.total : b), 0),
    },
  });
}

// GET /api/quotes/export — the same window as a spreadsheet.
async function apiQuotesExport(url) {
  const cfg = await loadConfig();
  const win = await quoteWindow(quoteMonthsParam(url), cfg.tz);
  const rows = [['date', 'time', 'name', 'phone', 'quote', 'type', 'vehicle', 'condition', 'services', 'location', 'appointment']];
  const all = [];
  win.forEach((m) => m.entries.forEach((e) => all.push(e)));
  all.sort((a, b) => b.ts - a.ts);
  all.forEach((e) => rows.push([
    e.date,
    new Date(e.ts).toLocaleTimeString('en-US', { timeZone: cfg.tz || 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }),
    e.name, e.phone, e.total, e.type, e.vehicle, e.condition, e.services, e.location, e.appointment,
  ]));
  const csv = rows.map((r) => r.map((c) => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  return cors(new Response(csv, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="qqc-quotes.csv"' },
  }));
}

// POST /api/quotes/import  { entries: [ { ts|date, name, total, … } ], replace? }
// One-time backfill of the quotes that predate this log (they only ever existed
// as Web3Forms emails). Idempotent by default — the same phone + total inside
// 10 minutes is skipped — so re-running an import can't double a month.
async function apiQuotesImport(request) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const list = Array.isArray(body && body.entries) ? body.entries : null;
  if (!list) return json({ ok: false, error: 'entries_required' }, 422);
  if (list.length > 2000) return json({ ok: false, error: 'too_many' }, 413);

  const cfg = await loadConfig();
  // Group by month so an import of N quotes costs one write per month, not N.
  const byMonth = new Map();
  let skipped = 0;
  for (const raw of list) {
    // Accept a plain "YYYY-MM-DD" (or a full ISO stamp) as well as an epoch ms.
    const q = Object.assign({}, raw);
    if (!q.ts && q.date) q.ts = Date.parse(String(q.date).length === 10 ? q.date + 'T12:00:00Z' : q.date);
    // An imported row is historical by definition. normalizeQuote falls back to
    // "now" when there's no timestamp — right for a live submission, wrong here:
    // it would file an undated row under today and invent a date that never was.
    if (!(Number(q.ts) > 0)) { skipped++; continue; }
    const entry = normalizeQuote(q, cfg.tz);
    if (!entry) { skipped++; continue; }
    const month = entry.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, await loadQuoteMonth(month));
    const doc = byMonth.get(month);
    if (body.replace === true && !doc._cleared) { doc.entries = []; doc._cleared = true; }
    const dupe = doc.entries.some(
      (e) => e.phone === entry.phone && e.total === entry.total && Math.abs(e.ts - entry.ts) < 600000,
    );
    if (dupe) { skipped++; continue; }
    doc.entries.push(entry);
  }
  let added = 0;
  for (const [month, doc] of byMonth) {
    delete doc._cleared;
    doc.entries.sort((a, b) => a.ts - b.ts);
    added += doc.entries.length;
    await saveQuoteMonth(month, doc);
  }
  return json({ ok: true, months: byMonth.size, stored: added, skipped });
}

async function handleInboundSms(request) {
  const params = await formParams(request);
  if (!(await verifyTwilio(request, params))) return forbidden();
  const from = params.From || '';
  const text = params.Body || '';
  const numMedia = parseInt(params.NumMedia || '0', 10);
  const fromNorm = normalizePhone(from) || from;
  // A text from Mikey's own cell isn't a customer message — it's him answering
  // one. See the assist loop below.
  if (fromNorm === normalizePhone(ENV.MIKEY_PHONE)) return handleOwnerSms(text);

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
  const inThread = await appendMessage(fromNorm, inMsg);
  // The alert doubles as the assist prompt: it tells Mikey he can answer straight
  // from his phone by texting the business number the bare facts (handleOwnerSms).
  const alertCfg = await loadConfig();
  // Pre-draft a reply in Mikey's voice so it's already waiting when he opens the
  // thread. Best-effort — never blocks or fails the inbound webhook. Drafted BEFORE
  // the alert goes out so the alert can show him the actual wording and ask for a
  // plain yes or no (see assistAlertBody / runAssist's YES/NO handling).
  const suggestion = await maybeSuggestReply(fromNorm);
  const draft = suggestion.text;
  // Work out what he actually needs to decide, so the alert asks him a question
  // he can answer in four words. Best-effort — a failure just means a plainer email.
  //
  // Skipped entirely when the reply check just ruled that nothing is owed. That
  // ruling is already made — often by a free rule — and triage on a "thanks!" only
  // ever comes back "chitchat, nothing needed", which is exactly what we hand the
  // alert here for nothing. It was the one ungated AI call on the inbound path.
  const ask = (suggestion.verdict && suggestion.verdict.needed === false)
    ? { kind: 'chitchat', ask: suggestion.verdict.reason || 'Nothing to answer here.', examples: [] }
    : await assistAsk(inThread, alertCfg).catch(() => null);
  const who = inThread.name || from;
  // Their actual words go in the subject, so the phone's notification banner —
  // which is all he sees half the time — already says what was asked.
  const gist = String(text || '').replace(/\s+/g, ' ').trim();
  const subject = gist
    ? `📱 ${who}: "${gist.length > 64 ? gist.slice(0, 63).trimEnd() + '…' : gist}"`
    : `📱 ${who} sent a photo`;
  await notifyMikey(subject,
    assistAlertBody(alertCfg, { phone: fromNorm, who, msg: text, ask, draft, media: numMedia }));
  // Watch for "so Saturday at 10 then?" and raise a one-tap job card if so.
  await maybeDetectJob(fromNorm);
  // No auto-reply to the customer — Mikey replies personally from the dashboard.
  return twiml('');
}

// ===========================================================================
// The assist loop  (a text FROM Mikey's own cell TO the business number)
// ---------------------------------------------------------------------------
// The slow part of answering a customer isn't deciding what to say, it's typing
// it out nicely. So Mikey sends the bare facts and the AI does the wording —
// "375, thursday works" becomes a warm, on-voice reply.
//
// Crucially this is NOT autonomy. Every fact in the outgoing message came from
// Mikey; generateReply() is explicitly told a hint is "the owner telling you what
// to say" and must use it exactly. The AI never decides anything, it just writes.
// And nothing leaves immediately: the reply is queued with a cancel window and
// the exact wording is texted back first, so the last word is his.
//
// Security: only reachable from a Twilio-signed webhook whose From matches
// MIKEY_PHONE, so the sender can't be spoofed through the public route.
//
// Grammar (case-insensitive):
//   375, thursday works        → AI writes it, sends to whoever texted last
//   @ruth 375 thursday         → …to Ruth instead (name prefix or phone digits)
//   send: on my way            → send exactly that, no rewriting
//   draft: ...                 → write it but hold it in the dashboard
//   who                        → who's waiting on a reply
//   cancel                     → pull back the queued reply before it goes
//   help                       → this list
// ===========================================================================
const ASSIST_HELP =
  'Answer a customer from your phone:\n' +
  '• "yes" sends the reply I wrote out for you in the alert. "no" drops it.\n' +
  '• Text me the facts — "375, thursday works" — and I\'ll write it out and send it to whoever texted you last.\n' +
  '• "@ruth 375 thursday" to pick who.\n' +
  '• "send: ..." to send your exact words.\n' +
  '• "draft: ..." to write it but hold it in the dashboard.\n' +
  '• "who" = who\'s waiting. "cancel" = pull back the last one.';

// Text Mikey on his cell. Always SMS (not notifyMikey, which prefers email) —
// used for the two things that have to arrive as a text or not at all: an answer
// in the assist loop, where he's mid-text-conversation with the dashboard and the
// reply has to land where he's typing; and the auto-reply confirmation, which he
// asked for as a text precisely so it buzzes his phone instead of an inbox.
async function ownerSay(msg) {
  try { await sendSms(ENV.MIKEY_PHONE, msg, { skipOptOut: true }); } catch { /* best effort */ }
}
function assistWho(e) { return e.name || e.phone; }

// Resolve which conversation an owner text is about. With a @token: match on a
// name-word prefix, then a name substring, then trailing phone digits. Without
// one: whoever is actually waiting on a reply, most recent first. Reads only the
// index, so picking a target costs no extra KV reads.
function assistPickTarget(index, token) {
  const open = index.filter((e) => !e.archived && !e.optedOut);
  if (!token) {
    const waiting = open.filter((e) => e.lastDir === 'in').sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    return waiting[0] || null;
  }
  const t = String(token).toLowerCase().replace(/^@/, '');
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 7) {
    const byPhone = open.find((e) => String(e.phone).replace(/\D/g, '').endsWith(digits));
    if (byPhone) return byPhone;
  }
  const name = (e) => String(e.name || '').toLowerCase();
  for (const test of [(e) => name(e).split(/\s+/).some((w) => w.startsWith(t)), (e) => name(e).includes(t)]) {
    const hits = open.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { ambiguous: hits.slice(0, 5) };
  }
  return null;
}

// A bare yes or no answering the reply we wrote out in the alert. Kept tight on
// purpose: anything with more in it is him telling us what to say instead, and
// should go through the normal path rather than firing off a draft.
const ASSIST_YES = /^(y|ya|yes+|yep|yeah|yup|ok|okay|k|sure|send|send it|send that|do it|go|go ahead|perfect|sounds good|looks good|that works|👍|👌|✅)[\s.!]*$/i;
const ASSIST_NO = /^(n|no+|nope|nah|don'?t|don'?t send|do not send|no thanks|skip|skip it|scrap it|scrap that|delete|toss it|👎)[\s.!]*$/i;

// Which draft is he answering? An email reply is threaded to one customer's
// alert, so it names itself. A text from his cell means the newest one still
// waiting — the same "whoever texted you last" rule the rest of the loop uses.
async function assistDraftTarget(index, forcedPhone) {
  const phones = forcedPhone ? [forcedPhone]
    : index.filter((e) => !e.archived && !e.optedOut && e.replyReady)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 1).map((e) => e.phone);
  for (const p of phones) {
    const th = await loadThread(p);
    if (th.suggested && th.suggested.text) return th;
  }
  return null;
}

async function assistAnswerDraft(yes, { index, cfg, reply, channel, forcedPhone }) {
  const thread = await assistDraftTarget(index, forcedPhone);
  if (!thread) {
    await reply(yes
      ? 'I don\'t have a written-out reply waiting on that one, so there\'s nothing to send yet. Tell me the facts — "375, thursday" — and I\'ll write it.'
      : 'Nothing was waiting to go out, so nothing changed.');
    return;
  }
  const who = thread.name || thread.phone;
  const draft = thread.suggested.text;
  if (!yes) {
    thread.suggested = null;
    await saveThread(thread);
    await updateIndexEntry(thread);
    await reply(`Dropped it — nothing went to ${who}. Tell me what you'd rather say and I'll write that instead.`);
    return;
  }
  // Send the exact words he just approved, through the same queue as everything
  // else: opt-out guard, practice mode, the hold, and the CANCEL window all apply.
  await runAssist({ text: `send: ${draft}`, cfg, reply, channel, forcedPhone: thread.phone });
  // Clear the draft only after the queue write, and only if it's still the one he
  // approved (he may have answered twice, or the customer may have texted again).
  const after = await loadThread(thread.phone);
  if (after.suggested && after.suggested.text === draft) {
    after.suggested = null;
    await saveThread(after);
    await updateIndexEntry(after);
  }
}

// ---------------------------------------------------------------------------
// The channel-agnostic core. Both entry points (a text from Mikey's cell, and a
// reply to an alert email) parse the same grammar and hit the same safety rails;
// they differ only in how the confirmation goes back to him and how long the
// hold is. `reply` is the callback that answers on whichever channel he used.
// ---------------------------------------------------------------------------
async function runAssist({ text, cfg, reply, channel, forcedPhone }) {
  const body0 = String(text || '').trim();
  if (!body0) return;
  const lower = body0.toLowerCase();

  if (lower === 'help' || lower === '?' || lower === 'commands') { await reply(ASSIST_HELP); return; }
  // Carrier keywords aren't answers — swallow them rather than rewriting "stop"
  // into a friendly sentence and texting it to a customer.
  if (['stop', 'stopall', 'unsubscribe', 'cancel all', 'end', 'quit', 'start', 'unstop'].includes(lower)) return;

  const index = await loadIndex();

  if (lower === 'who' || lower === 'waiting' || lower === 'pending') {
    const waiting = index.filter((e) => !e.archived && e.lastDir === 'in')
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 5);
    await reply(waiting.length
      ? 'Waiting on you:\n' + waiting.map((e, i) => `${i + 1}. ${assistWho(e)} — ${humanAgo(Date.now() - (e.lastTs || Date.now()))}: "${(e.lastBody || '').slice(0, 60)}"`).join('\n')
      : 'Nobody\'s waiting on a reply right now. 🚗');
    return;
  }

  // Pull back a queued assist reply. Targets the newest one still in the queue,
  // across every conversation, so "cancel" always undoes the last thing he sent.
  if (/^(cancel|undo|nvm|nevermind|stop that|wait)\b/.test(lower)) {
    let best = null;
    for (const e of index) {
      if (e.archived || !e.scheduledCount) continue;
      const th = await loadThread(e.phone);
      for (const s of (th.scheduled || [])) {
        if (s.kind === 'assist' && (!best || (s.at || 0) > (best.item.at || 0))) best = { thread: th, item: s };
      }
    }
    if (!best) { await reply('Nothing queued to cancel — it may have already gone out.'); return; }
    best.thread.scheduled = best.thread.scheduled.filter((s) => s.id !== best.item.id);
    await saveThread(best.thread);
    await updateIndexEntry(best.thread);
    await reply(`Cancelled — nothing was sent to ${best.thread.name || best.thread.phone}.`);
    return;
  }

  // "yes" / "no" — he's answering the reply we already wrote out for him in the
  // alert. This is the shortest path there is: one word and the customer gets a
  // real answer. Anything longer than a bare yes/no falls through to the normal
  // "tell me the facts" grammar below.
  if (ASSIST_YES.test(lower) || ASSIST_NO.test(lower)) {
    await assistAnswerDraft(ASSIST_YES.test(lower), { index, cfg, reply, channel, forcedPhone });
    return;
  }

  // @target prefix
  let token = '', body = body0;
  const m = body0.match(/^@(\S+)\s+([\s\S]+)$/);
  if (m) { token = m[1]; body = m[2].trim(); }

  // mode prefix
  let mode = 'ai';
  let mm = body.match(/^(?:send|say|verbatim)\s*:\s*([\s\S]+)$/i);
  if (mm) { mode = 'verbatim'; body = mm[1].trim(); }
  else {
    mm = body.match(/^(?:draft|hold)\s*:\s*([\s\S]+)$/i);
    if (mm) { mode = 'draft'; body = mm[1].trim(); }
  }
  if (!body) { await reply(ASSIST_HELP); return; }

  // An email reply already knows who it's about (it's threaded to that customer's
  // alert), so the target comes free — no @name, and no guessing when two people
  // texted at once. An explicit @token still wins, so he can redirect.
  let target = null;
  if (forcedPhone && !token) {
    const e = index.find((x) => x.phone === forcedPhone);
    target = e || { phone: forcedPhone, name: '' };
  } else {
    target = assistPickTarget(index, token);
  }
  if (!target) {
    await reply(token
      ? `I couldn't find anyone matching "${token}". Send "who" to see who's waiting.`
      : 'Nobody has texted in, so I don\'t know who you mean. Try "@name your answer".');
    return;
  }
  if (target.ambiguous) {
    await reply(`"${token}" matches ${target.ambiguous.map(assistWho).join(', ')}. Try a fuller name or the last 4 digits of their number.`);
    return;
  }
  if (isOptedOut(cfg, target.phone)) {
    await reply(`${assistWho(target)} texted STOP, so I can't message them. Give them a call instead.`);
    return;
  }

  const thread = await loadThread(target.phone);
  let out = body;
  if (mode !== 'verbatim') {
    // The hint path: generateReply() is grounded in the playbook, the rules, this
    // customer's history AND how Mikey edits drafts — and is told to use any fact
    // in the hint exactly as given.
    try { out = await generateReply(thread, cfg, body); }
    catch (err) {
      await reply(`Couldn't write that one (${String((err && err.message) || err).slice(0, 60)}). Send "send: <your exact message>" and I'll send it word for word.`);
      return;
    }
  }
  out = String(out || '').trim();
  if (!out) { await reply('That came back empty — try again, or use "send: <your exact message>".'); return; }

  if (mode === 'draft') {
    const last = thread.messages[thread.messages.length - 1];
    thread.suggested = { text: out, ts: Date.now(), forTs: last ? last.ts : Date.now() };
    await saveThread(thread);
    await updateIndexEntry(thread);
    await reply(`Drafted for ${assistWho(target)} (not sent):\n"${out}"\n\nIt's waiting in the dashboard.`);
    return;
  }

  // Practice mode stops here: he sees exactly what would have gone out, and
  // nothing is queued. This is the last gate before the message becomes real.
  if (isPracticePhone(target.phone)) {
    await reply(
      `🧪 PRACTICE — nothing was sent.\n\nHere's what ${assistWho(target)} would have received:\n"${out}"\n\n` +
      `That's the whole loop working. On a real customer this would now be queued with a hold, and you'd get this same message with a countdown and a CANCEL option.`,
    );
    return;
  }

  // Queue it rather than send it. Riding the existing scheduled-send cron gives
  // at-most-once delivery and the opt-out guard for free — and the gap between
  // now and sendAt IS the cancel window. Email gets a longer hold by default,
  // because a "cancel" reply has to make another trip through the inbox.
  const raw = channel === 'email' ? cfg.assistEmailDelaySec : cfg.assistDelaySec;
  const delaySec = Math.max(0, Math.min(900, Number(raw) || 0));
  const item = { id: genId(), kind: 'assist', at: Date.now(), body: out, sendAt: Date.now() + delaySec * 1000 };
  thread.scheduled.push(item);
  thread.scheduled.sort((a, b) => a.sendAt - b.sendAt);
  thread.dateRequest = null;
  await saveThread(thread);
  await updateIndexEntry(thread);
  const when = delaySec >= 60 ? `~${Math.round(delaySec / 60)} min` : delaySec ? `~${delaySec}s` : 'on the next tick (~1 min)';
  await reply(
    `→ ${assistWho(target)}:\n"${out}"\n\n` +
    `Sending in ${when}. Reply CANCEL to stop it` +
    (channel === 'email' ? ', or cancel it in the dashboard (faster).' : '.'),
  );
}

// Entry point 1 — a text from Mikey's own cell to the business number.
async function handleOwnerSms(rawText) {
  const cfg = await loadConfig();
  if (cfg.assistSms === false) return twiml('');   // feature off — stay silent
  await runAssist({ text: rawText, cfg, channel: 'sms', reply: ownerSay });
  return twiml('');
}

// ---------------------------------------------------------------------------
// Entry point 2 — replying to the alert email  (the free channel)
// ---------------------------------------------------------------------------
// Alerts already go out as email (notifyMikey prefers Resend), so the cheapest
// possible answer is to just hit reply. No Twilio segment for his message in,
// none for the confirmation back — the only billable text is the one the
// customer actually receives, which no channel can avoid.
//
// It also routes itself. The reply is threaded to ONE customer's alert, so we
// know who it's about without him typing @anything — and without the "whoever
// texted last" guess going wrong when two people text at the same minute.
const ASSIST_CUT = '--- reply above this line ---';

// Assemble an alert body that can be replied to. The cut marker goes at the very
// TOP — when he replies, his mail client quotes everything below it, so slicing
// at the marker leaves exactly what he typed and nothing else. (Putting it at the
// bottom looks tidier and does not work: the alert's own text ends up above the
// cut and gets treated as part of his answer.)
// ---------------------------------------------------------------------------
// "What do you actually need from me?"
// ---------------------------------------------------------------------------
// An alert that just repeats the customer's message leaves Mikey to work out
// what's being asked and what a usable answer looks like. So each inbound text is
// turned into ONE plain question plus literal example replies he could type
// verbatim. The examples matter more than the question: they show the shape of a
// valid answer, which is the whole skill of using this thing.
//
// `kind` also decides whether to offer the quick path at all — a complaint or a
// damage claim gets "handle this one yourself", never a one-word reply box.
const ASSIST_KINDS = ['price', 'schedule', 'question', 'confirm', 'chitchat', 'escalate'];

async function assistAsk(thread, cfg) {
  if (!ENV.GEMINI_API_KEY) return null;
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.dir !== 'in') return null;
  const prompt =
    businessContext(cfg) +
    `You are triaging ONE inbound customer text for the owner of a mobile car detailing business, ` +
    `so he can answer it in a few words from his phone. Return ONLY JSON:\n` +
    `{"kind": one of ${JSON.stringify(ASSIST_KINDS)},\n` +
    ` "ask": "ONE short sentence (max 20 words) telling the owner exactly what he needs to decide or supply. ` +
    `Write it to him, not to the customer. Be specific to THIS message — name the vehicle/service if known.",\n` +
    ` "examples": ["2 or 3 SHORT literal replies he could type, 1-6 words each, e.g. \\"375\\" or \\"375, thursday works\\" or \\"yes, 9am\\". ` +
    `These are shorthand facts, NOT full sentences and NOT a message to the customer. Make them realistic for this conversation."]}\n\n` +
    `kind guide: "price" = they want a number. "schedule" = they want a day/time. "question" = a factual question about the service. ` +
    `"confirm" = they're agreeing/confirming and just need acknowledgement. "chitchat" = thanks/emoji, nothing needed. ` +
    `"escalate" = a complaint, damage, refund, anger, or anything needing a careful personal reply.\n\n` +
    `Conversation:\n${transcript(thread, AI_CLASSIFY_TURNS)}`;
  try {
    const raw = await geminiGenerate(prompt, { surface: 'inbound triage', json: true, maxTokens: 500, temperature: 0.2 });
    const p = JSON.parse(raw);
    const examples = Array.isArray(p.examples)
      ? p.examples.map((x) => String(x).trim()).filter(Boolean).slice(0, 3) : [];
    return {
      kind: ASSIST_KINDS.includes(p.kind) ? p.kind : 'question',
      ask: String(p.ask || '').trim().slice(0, 200),
      examples,
    };
  } catch { return null; }
}

// Render the ask as the middle of the alert email.
function assistAskBlock(ask, compact) {
  if (!ask) return '';
  if (ask.kind === 'escalate') {
    return `\n⚠️  HANDLE THIS ONE YOURSELF\n   ${ask.ask || 'This needs a careful, personal reply.'}\n` +
      `   I'm not offering a quick answer here on purpose — open the dashboard.\n`;
  }
  if (ask.kind === 'chitchat') {
    return `\n✅ NOTHING NEEDED\n   ${ask.ask || 'Just a friendly note — no answer required.'}\n`;
  }
  // Nothing useful came back — say nothing rather than print an empty header.
  if (!ask.ask && !ask.examples.length) return '';
  // When a written-out reply is already on offer above, this block is the "or
  // not" path, so it shrinks to one line rather than competing with the yes/no.
  if (compact) {
    const lines = [`\n❓ NOT WHAT YOU'D SAY?`];
    if (ask.ask) lines.push(`   ${ask.ask}`);
    if (ask.examples.length) lines.push(`   Reply with something like: ${ask.examples.join(' · ')}`);
    return lines.join('\n') + '\n';
  }
  const lines = [`\n❓ WHAT I NEED FROM YOU`];
  if (ask.ask) lines.push(`   ${ask.ask}`);
  if (ask.examples.length) {
    lines.push(`\n   Reply with something like:`);
    for (const e of ask.examples) lines.push(`     ${e}`);
  }
  return lines.join('\n') + '\n';
}

// The alert as an actual email: the customer's words huge and first, the reply
// I'd send in a card under them, and one-tap YES/NO buttons. See the mail kit
// (mailShell/mailCard/mailBtn) further down for the shared styling.
//
// Two lines in here are load-bearing rather than decorative and must stay
// VISIBLE text: the cut marker at the very top (his mail client quotes the whole
// email below it, so slicing there leaves exactly what he typed) and the [ref:…]
// line at the bottom (it's what routes his reply back to this customer). Gmail
// renders the HTML part when replying, so anything hidden there is lost.
function assistAlertHtml(cfg, o) {
  const { phone, who, msg, note, ask, offer, byEmail, quickOk, media } = o;
  const B = [];
  B.push(`<div style="font:400 11px/1.5 ${MAILF};color:#94a3b8;margin:0 0 10px;">${htmlEsc(ASSIST_CUT)}</div>`);
  if (note) {
    B.push(mailCard(
      mailLabel('Practice — not a real customer', MAILC.purple) +
      `<div style="font:400 14px/1.5 ${MAILF};color:${MAILC.ink};">${mailLines(note)}</div>`,
      { bg: MAILC.purpleBg, border: '#ddd6fe', edge: MAILC.purple }));
  }
  // THE MESSAGE. Everything else on the screen is smaller than this on purpose —
  // one glance from the lock screen should be enough to know what was said.
  B.push(mailCard(
    mailLabel(media && !msg ? `${who} sent a photo` : `${who} texted`, MAILC.amberInk) +
    // A photo with no words gets the count instead of an empty pair of quotes.
    (msg
      ? mailShout(msg)
      : `<div style="font-family:${MAILF};font-size:22px;line-height:1.35;font-weight:800;color:${MAILC.ink};">📷 ${media || 'No message'}${media ? ` photo${media === 1 ? '' : 's'}, no message` : ''}</div>`) +
    (media ? `<div style="font:600 13px/1.5 ${MAILF};color:${MAILC.amberInk};margin-top:10px;">Open the dashboard to see ${media === 1 ? 'it' : 'them'}.</div>` : ''),
    { bg: MAILC.amberBg, border: '#fde68a', edge: MAILC.amber, pad: '18px' }));

  // The written-out reply, with the two answers as buttons. The buttons are just
  // mailto: links that pre-fill YES/NO and the ref — the same reply he'd type by
  // hand, so they ride the exact same path with no new trust in the client.
  if (offer) {
    let inner = mailLabel("Here's what I'd send back", MAILC.greenInk) +
      `<div style="font:600 17px/1.5 ${MAILF};color:${MAILC.ink};background:${MAILC.card};border:1px solid #bbf7d0;border-radius:12px;padding:14px;">${mailLines(offer)}</div>`;
    if (byEmail && assistMailto('')) {
      inner += `<div style="height:14px;line-height:14px;">&nbsp;</div>` +
        mailBtn(assistMailto('YES', phone), '✅  Send it', MAILC.green) +
        `<div style="height:8px;line-height:8px;">&nbsp;</div>` +
        mailBtn(assistMailto('NO', phone), '✋  No — drop it', MAILC.card, { fg: MAILC.ink, border: MAILC.line }) +
        `<div style="font:400 13px/1.6 ${MAILF};color:${MAILC.mute};margin-top:12px;">Buttons not working? Just hit <b>Reply</b> and type <b>YES</b> or <b>NO</b>.</div>`;
    } else {
      inner += `<div style="font:400 14px/1.6 ${MAILF};color:${MAILC.mute};margin-top:12px;">Reply <b>YES</b> and it goes out as written. Reply <b>NO</b> and I'll drop it.</div>`;
    }
    B.push(mailCard(inner, { bg: MAILC.greenBg, border: '#bbf7d0', edge: MAILC.green }));
  }

  // What I need from you — or, on a complaint, why I'm deliberately not offering
  // a one-word answer.
  if (ask && ask.kind === 'escalate') {
    B.push(mailCard(
      mailLabel('Handle this one yourself', MAILC.redInk) +
      `<div style="font:600 16px/1.5 ${MAILF};color:${MAILC.ink};">${mailLines(ask.ask || 'This needs a careful, personal reply.')}</div>` +
      `<div style="font:400 14px/1.6 ${MAILF};color:${MAILC.mute};margin-top:8px;">No quick answer on this one on purpose — open the dashboard and write it yourself.</div>`,
      { bg: MAILC.redBg, border: '#fecaca', edge: MAILC.red }));
  } else if (ask && ask.kind === 'chitchat') {
    B.push(mailCard(
      mailLabel('Nothing needed', MAILC.greenInk) +
      `<div style="font:400 15px/1.6 ${MAILF};color:${MAILC.ink};">${mailLines(ask.ask || 'Just a friendly note — no answer required.')}</div>`,
      { bg: MAILC.greenBg, border: '#bbf7d0', edge: MAILC.green }));
  } else if (ask && (ask.ask || ask.examples.length)) {
    let inner = mailLabel(offer ? "Not what you'd say?" : 'What I need from you', MAILC.blue);
    if (ask.ask) inner += `<div style="font:600 16px/1.5 ${MAILF};color:${MAILC.ink};">${mailLines(ask.ask)}</div>`;
    if (ask.examples.length) {
      inner += `<div style="font:400 13px/1.6 ${MAILF};color:${MAILC.mute};margin:12px 0 8px;">${byEmail && assistMailto('') ? 'Tap one, or reply with your own words:' : 'Reply with something like:'}</div>`;
      for (const e of ask.examples) {
        inner += (byEmail && assistMailto('')
          ? mailBtn(assistMailto(e, phone), htmlEsc(e), MAILC.card, { fg: MAILC.ink, border: '#bfdbfe' })
          : `<div style="font:600 15px/1.5 ${MAILF};color:${MAILC.ink};background:${MAILC.card};border:1px solid #bfdbfe;border-radius:10px;padding:10px 14px;">${htmlEsc(e)}</div>`) +
          `<div style="height:8px;line-height:8px;">&nbsp;</div>`;
      }
    }
    B.push(mailCard(inner, { bg: MAILC.blueBg, border: '#bfdbfe', edge: MAILC.blue }));
  }

  // How this works, kept last and quiet — he only needs it the first few times.
  const tips = [];
  if (quickOk && byEmail) {
    tips.push(offer
      ? `Hit <b>Reply</b>: <b>YES</b> sends it, <b>NO</b> drops it — or tell me what to say instead (&ldquo;375, thursday&rdquo;) and I'll rewrite it in your voice. Free — no text message used.`
      : `Hit <b>Reply</b> with just the facts and I'll write it out in your voice and send it to ${htmlEsc(who)}. Free — no text message used.`);
  }
  if (quickOk && cfg.assistSms !== false) {
    tips.push(`${byEmail && tips.length ? 'Or text' : 'Text'} <b>${htmlEsc(ENV.TWILIO_FROM || 'your business number')}</b> the same thing.`);
  }
  if (quickOk && tips.length) {
    tips.push(`Also: &ldquo;send: your exact words&rdquo; skips the rewriting · &ldquo;draft: …&rdquo; holds it in the dashboard · &ldquo;who&rdquo; lists everyone waiting · &ldquo;cancel&rdquo; pulls one back.`);
    tips.push(`You'll always get the finished wording back before it goes out.`);
  }
  const base = publicBase();
  let footInner = '';
  if (base) footInner += mailBtn(base, 'Open the dashboard', MAILC.ink) + `<div style="height:14px;line-height:14px;">&nbsp;</div>`;
  if (tips.length) {
    footInner += tips.map((t) => `<div style="font:400 13px/1.6 ${MAILF};color:${MAILC.mute};margin:0 0 8px;">${t}</div>`).join('');
  }
  if (footInner) B.push(mailCard(footInner, { bg: MAILC.card }));
  // The routing line. Small, but it has to survive into his reply.
  if (byEmail) B.push(`<div style="font:400 11px/1.5 ${MAILF};color:#94a3b8;padding:0 4px 8px;">[ref:${htmlEsc(phone)}]</div>`);
  return mailShell(msg || who, B.join(''));
}

// A mailto: link that pre-fills a reply to an alert — the button version of
// typing YES. Returns '' when there's no alert mailbox to answer to, which also
// makes it the "can I offer buttons at all?" test.
function assistMailto(text, phone) {
  const to = emailAddr(ENV.ALERT_EMAIL || '');
  if (!to || !/@/.test(to)) return '';
  if (!phone) return to;   // probe form: assistMailto('') just asks "is this on?"
  const body = `${text}\n\n[ref:${phone}]`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent('Re: your customer')}&body=${encodeURIComponent(body)}`;
}

function assistAlertBody(cfg, opts) {
  const { phone, who, msg = '', ask, draft, note = '', media = 0 } = opts;
  const quoted = `${who} texted:\n"${msg || (media ? '[photo]' : '')}"`;
  const core = note ? `${note}\n\n${quoted}` : quoted;
  const byEmail = cfg.assistEmail !== false;
  // A complaint should never come with a one-word answer box next to it.
  const quickOk = !(ask && (ask.kind === 'escalate' || ask.kind === 'chitchat'));
  // The whole point of the yes/no alert: show him the actual words first, so the
  // easiest possible answer is one letter. Only offered when there's something
  // safe to send — never on a complaint, never on a "no reply needed".
  const offer = quickOk && draft ? String(draft).trim() : '';
  const block = assistAskBlock(ask, !!offer);
  const draftBlock = offer
    ? `\n✍️  HERE'S WHAT I'D SEND BACK\n   "${offer}"\n\n   Reply YES and it goes out as written. Reply NO and I'll drop it.\n`
    : '';
  const foot = [];
  if (quickOk && byEmail) {
    foot.push(offer
      ? `💡 Hit REPLY: YES sends it, NO drops it — or just tell me what to say instead ("375, thursday") and I'll rewrite it in your voice. Free — no text message used.`
      : `💡 Hit REPLY with just that and I'll write it out in your voice and send it to ${who}. Free — no text message used.`);
  }
  if (quickOk && cfg.assistSms !== false) {
    foot.push(`📱 ${byEmail && foot.length ? 'Or text' : 'Text'} ${ENV.TWILIO_FROM || 'your business number'} the same thing.`);
  }
  if (quickOk && foot.length) {
    foot.push(`\nOther things you can say: "send: <your exact words>" to skip the rewriting · "draft: …" to hold it in the dashboard · "who" to see everyone waiting · "cancel" to pull one back.`);
    foot.push(`You'll always get the finished wording back before it goes out.`);
  }
  const body = `${core}\n${draftBlock}${block}`.trimEnd();
  // The HTML is what he'll actually see; the text is the fallback every mail
  // client keeps around, and it's also what goes out over SMS if email fails, so
  // it stays exactly as readable as it was before there was an HTML part at all.
  const html = assistAlertHtml(cfg, { phone, who, msg, note, ask, offer, byEmail, quickOk, media });
  let text;
  if (!foot.length) text = block ? body : core;
  // Only invite a reply when replies are actually processed. With email answering
  // off, the marker and ref are left out entirely — otherwise he'd hit reply and
  // nothing would ever happen. The ref is also what makes a reply routable, and
  // requiring it is what stops ordinary mail being read as a command.
  else if (!byEmail) text = `${body}\n\n${foot.join('\n')}`;
  else {
    foot.push(`[ref:${phone}]`);
    text = `${ASSIST_CUT}\n${body}\n\n${foot.join('\n')}`;
  }
  return { text, html };
}

// Strip the quoted original out of a reply so only what he actually typed is
// treated as the answer. Cuts at our own marker first (exact and reliable), then
// falls back to the usual client patterns.
function assistStripQuoted(raw) {
  let s = String(raw || '').replace(/\r\n/g, '\n');
  const cuts = [
    s.indexOf(ASSIST_CUT),
    s.search(/^\s*On .{0,120}\bwrote:\s*$/m),
    s.search(/^\s*-{2,}\s*Original Message\s*-{2,}/mi),
    s.search(/^\s*_{10,}\s*$/m),
    s.search(/^\s*From:\s.+$/m),
    s.search(/^\s*>/m),
  ].filter((i) => i > -1);
  if (cuts.length) s = s.slice(0, Math.min(...cuts));
  // Drop a trailing signature block ("-- \nMikey").
  s = s.replace(/\n--\s*\n[\s\S]*$/, '');
  // The ref rides along in the body when he answered by tapping a button (the
  // mailto pre-fills "YES\n\n[ref:…]"), and it's routing, not words — leaving it
  // in would stop a bare "YES" looking like a bare YES.
  s = s.replace(/\[ref:[^\]]*\]/g, '');
  return s.trim();
}

// Which conversation is this a reply to? ONLY the ref line we planted counts.
// Deliberately not falling back to "a phone number somewhere in the subject" —
// that would make any ordinary email of his with a number in the subject look
// like a command. The ref is present on every alert, so nothing real is lost.
// Returns a normalized phone or ''.
function assistRefPhone(body) {
  // Tolerant of reformatting: iOS Mail and some clients rewrite a bare number
  // into "(360) 555-1234" even inside our marker.
  const m = String(body || '').match(/\[ref:\s*([+\d(][\d\s()+.-]{6,})\]/);
  if (!m) return '';
  return normalizePhone(m[1]) || '';
}

// Bare address out of "Mikey <mikey@example.com>", lowercased.
function emailAddr(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return String(m ? m[1] : s || '').trim().toLowerCase();
}

// Is this ingested email Mikey answering a customer alert? Requires the sender
// to be the alert mailbox AND the mail to reference a conversation — so ordinary
// customer email flowing through the same ingest is never mistaken for a command.
function assistIsOwnerReply(cfg, email) {
  if (cfg.assistEmail === false) return '';
  const owner = emailAddr(ENV.ALERT_EMAIL);
  if (!owner || emailAddr(email.from) !== owner) return '';
  return assistRefPhone(email.body);
}

async function handleAssistEmail(cfg, email, phone) {
  const text = assistStripQuoted(email.body);
  if (!text) return;
  const subject = 'Re: ' + String(email.subject || 'your reply').replace(/^(re:\s*)+/i, '');
  await runAssist({
    text, cfg, channel: 'email', forcedPhone: phone,
    // The confirmation carries the marker and the ref too, so replying "cancel"
    // to IT routes back here instead of landing in the inbox as ordinary mail.
    reply: (msg) => sendEmail(subject, `${ASSIST_CUT}\n${msg}\n\n[ref:${phone}]`).catch(() => {}),
  });
}

// ===========================================================================
// Practice mode — rehearse the whole loop without touching a real customer
// ===========================================================================
// Tapping "Send me a practice question" fabricates a realistic inbound text from
// a fake customer and fires a genuine alert email. Replying to it exercises the
// ENTIRE chain — the Gmail script, the ref routing, the quote stripping, the AI
// drafting, the confirmation — and stops one step short of Twilio: the finished
// message is shown back to him marked TEST and never sent anywhere.
//
// The number is in 555-0100..0199, the range reserved for fictional use, so it
// can't collide with a real customer. sendSms() refuses it outright as a second
// line of defence, so no future code path can text it by accident either.
const PRACTICE_PHONE = '+15555550100';
function isPracticePhone(p) { return normalizePhone(p) === PRACTICE_PHONE; }

const PRACTICE_SCENARIOS = [
  { id: 'price',    name: 'Practice · Ruth',  vehicle: '2019 4Runner',
    body: "Hey! How much would a full detail run on my 2019 4Runner? It's pretty rough inside, two kids and a dog." },
  { id: 'schedule', name: 'Practice · Dave',  vehicle: 'F-150',
    body: 'Do you have anything open Saturday? Anytime in the morning works for me.' },
  { id: 'question', name: 'Practice · Alina', vehicle: 'Model 3',
    body: 'Do you do ceramic coating? And do you come to my place or do I drop it off?' },
  { id: 'escalate', name: 'Practice · Ken',   vehicle: 'Tacoma',
    body: "I just looked at the truck and there's a scratch on the hood that wasn't there this morning. Pretty unhappy about this." },
];

async function apiAssistPractice(request) {
  const d = await readJson(request).catch(() => ({}));
  const cfg = await loadConfig();
  const want = String((d && d.scenario) || '').toLowerCase();
  // Rotate through the scenarios so repeated taps exercise different shapes.
  const prev = (await kv().get('assist:practice', { type: 'json' })) || {};
  const idx = PRACTICE_SCENARIOS.findIndex((s) => s.id === want);
  const sc = idx >= 0 ? PRACTICE_SCENARIOS[idx] : PRACTICE_SCENARIOS[((prev.n || 0) % PRACTICE_SCENARIOS.length)];
  await kv().put('assist:practice', JSON.stringify({ n: ((prev.n || 0) + 1) % 1000, at: Date.now() }));

  // Reset the practice conversation each run so the AI isn't answering a stale
  // thread, and so the fake customer never accumulates history.
  const thread = blankThread(PRACTICE_PHONE);
  thread.name = sc.name;
  thread.tags = ['practice'];
  thread.status = 'new';
  thread.statusAt = Date.now();
  thread.notes = 'Practice conversation for testing "Answer by email". Not a real customer — nothing sent here ever leaves the app.';
  thread.messages = [{ id: genId(), dir: 'in', body: sc.body, ts: Date.now() }];
  thread.unread = 1;

  const ask = await assistAsk(thread, cfg).catch(() => null);
  // Practice the real thing, yes/no included: write the reply out and hang it on
  // the practice thread so answering YES walks the same path a real one would
  // (and stops at the practice guard instead of texting anyone).
  let draft = '';
  if (aiConfigured() && !(ask && (ask.kind === 'escalate' || ask.kind === 'chitchat'))) {
    try { draft = String(await generateReply(thread, cfg, '') || '').trim(); } catch { draft = ''; }
    if (draft) thread.suggested = { text: draft, ts: Date.now(), forTs: thread.messages[0].ts };
  }
  await saveThread(thread);
  await updateIndexEntry(thread);

  const note = `🧪 THIS IS A PRACTICE MESSAGE — ${sc.name} is not a real customer.\nNothing you reply here will ever be sent to anyone.`;
  const body = assistAlertBody(cfg, { phone: PRACTICE_PHONE, who: sc.name, msg: sc.body, ask, draft, note });
  const sent = await notifyMikey(`🧪 Practice · ${sc.name}: "${String(sc.body).slice(0, 52)}${String(sc.body).length > 52 ? '…' : ''}"`, body);
  return json({ ok: !!sent, scenario: sc.id, ask, emailed: !!sent, previewBody: body.text, previewHtml: body.html });
}

// The Gmail script that feeds this. Deliberately reads his SENT mail rather than
// his inbox: whatever address the alert came from, his reply is in Sent, so this
// needs no inbound-mail infrastructure, no custom domain and no third-party
// automation — just a free 1-minute trigger on his own account.
function assistAppsScript(url, token) {
  return `/**
 * Mikey's Dashboard — "Answer by email".
 * Reply to a new-text alert with the facts and the dashboard writes the
 * customer reply in your voice and sends it.
 *
 * SETUP (once, ~2 minutes)
 *  1. Go to script.google.com -> New project
 *  2. Delete what's there, paste ALL of this, hit Save
 *  3. Run -> mikeyAssistSync  (approve the permission prompt the first time)
 *  4. Triggers (clock icon) -> Add Trigger -> mikeyAssistSync ->
 *     Time-driven -> Minutes timer -> Every minute -> Save
 * That's it. Replying to an alert now answers the customer.
 */
var DASH_URL   = ${JSON.stringify(url)};
var DASH_TOKEN = ${JSON.stringify(token)};

function mikeyAssistSync() {
  // Who am I? A search for 'from:me' returns THREADS, and each thread holds both
  // the dashboard's alert and my reply — so every message still has to be checked
  // individually. If Google won't tell us the address (it can come back empty in
  // some trigger contexts) we stop rather than treat every message as ours.
  var me = '';
  try { me = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  if (!me) { Logger.log('Could not read your Gmail address — re-run this once from the editor to re-approve.'); return; }

  var props = PropertiesService.getScriptProperties();
  var seen = JSON.parse(props.getProperty('seen') || '[]');
  var threads = GmailApp.search('from:me newer_than:2d', 0, 30);
  var sent = 0;

  for (var t = 0; t < threads.length; t++) {
    var msgs = threads[t].getMessages();
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var id = m.getId();
      if (seen.indexOf(id) !== -1) continue;                      // already sent
      var from = m.getFrom();
      if (from.toLowerCase().indexOf(me) === -1) continue;         // the alert, not my reply
      var body = m.getPlainBody() || '';
      if (body.indexOf('[ref:') === -1) continue;                  // not a reply to a dashboard alert

      try {
        UrlFetchApp.fetch(DASH_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'X-Ingest-Token': DASH_TOKEN },
          muteHttpExceptions: true,
          payload: JSON.stringify({
            token: DASH_TOKEN,
            from: from,
            subject: m.getSubject(),
            body: body,
            messageId: id,
            date: m.getDate().getTime()
          })
        });
        seen.push(id);
        sent++;
      } catch (err) { /* leave it unseen and try again next run */ }
    }
  }
  if (seen.length > 300) seen = seen.slice(-300);
  props.setProperty('seen', JSON.stringify(seen));
  Logger.log('Checked ' + threads.length + ' recent conversations, sent ' + sent + ' answer(s).');
}
`;
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
  const fromNorm = normalizePhone(from) || from;
  const recordingUrl = params.RecordingUrl || '';
  const recordingSid = params.RecordingSid || '';
  const duration = params.RecordingDuration || '?';
  if (recordingUrl && fromNorm !== normalizePhone(ENV.MIKEY_PHONE)) {
    // Drop the voicemail into the caller's thread right away — with the recording
    // attached — so it's visible AND playable in the dashboard even if the
    // transcript is delayed or never comes (silence/noise/non-English). The
    // transcript callback (/voicemail-tx) fills the text into this same message,
    // matched by RecordingSid so we never show two bubbles for one voicemail.
    const thread = await loadThread(fromNorm);
    markSource(thread, 'call');
    const dup = (thread.messages || []).some((m) => m.kind === 'voicemail' && recordingSid && m.recordingSid === recordingSid);
    if (!dup) {
      thread.messages.push({
        id: genId(),
        dir: 'in',
        body: `🎙️ Voicemail (${duration}s)`,
        ts: Date.now(),
        kind: 'voicemail',
        recording: recordingUrl + '.mp3',
        recordingSid: recordingSid || undefined,
      });
      thread.unread = (thread.unread || 0) + 1;
      if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
      await saveThread(thread);
      await updateIndexEntry(thread);
    }
    await notifyMikey(`🎙️ Voicemail from ${from}`, `Voicemail from ${from} (${duration}s). Open the dashboard to listen.`);
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
  const recordingSid = params.RecordingSid || '';
  if (fromNorm === normalizePhone(ENV.MIKEY_PHONE)) return new Response('', { status: 204 });

  // /voicemail-done normally already stored the voicemail (with the recording).
  // Find it by RecordingSid so we update that bubble in place instead of adding a
  // second one. Fall back to appending if this callback somehow arrives first.
  const thread = await loadThread(fromNorm);
  const existing = (thread.messages || []).find((m) => m.kind === 'voicemail' && recordingSid && m.recordingSid === recordingSid);

  if (status !== 'completed' || !text) {
    // Transcription unavailable (silence, noise, non-English). Mark the stored
    // voicemail so the UI stops implying text is still coming; the recording is
    // still there to play. Nothing stored + no text → just acknowledge.
    if (existing && !existing.transcript) {
      existing.transcriptFailed = true;
      await saveThread(thread);
      await updateIndexEntry(thread);
    }
    return new Response('', { status: 204 });
  }

  if (existing) {
    existing.body = `🎙️ Voicemail: "${text}"`;
    existing.transcript = text;
    existing.transcriptFailed = false;
    if (!existing.recording && recording) existing.recording = recording + '.mp3';
    await saveThread(thread);
    await updateIndexEntry(thread);
  } else {
    thread.messages.push({
      id: genId(),
      dir: 'in',
      body: `🎙️ Voicemail: "${text}"`,
      ts: Date.now(),
      kind: 'voicemail',
      transcript: text,
      recording: recording ? recording + '.mp3' : undefined,
      recordingSid: recordingSid || undefined,
    });
    thread.unread = (thread.unread || 0) + 1;
    if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
    await saveThread(thread);
    await updateIndexEntry(thread);
  }
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
  // Attached after the save on purpose: a guess read out of the conversation is
  // shown, never stored. It becomes real only when he taps save on it, which
  // writes it to the garage through /api/meta like anything else.
  if (!(thread.garage && thread.garage.address)) {
    const found = findAddressInThread(thread);
    if (found) thread.addressGuess = found.text;
  }
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
  // A text he typed with no draft behind it is the purest voice sample there is,
  // and it used to be dropped — the corpus only grew from drafts he accepted or
  // rewrote, so the way he opens a conversation cold was never learned until the
  // next full rebuild. Now every message he writes goes in as he sends it.
  else if (voiceUsable(msg)) { try { await recordVoiceSample(body, 'sent'); } catch { /* non-fatal */ } }
  // Two readings of the text he just sent: "see you Saturday at 10" is a job, and
  // "I'll get back to you Monday" is a promise that becomes a reminder with a
  // calendar invite. Both are best-effort, both gate on a free regex before any
  // AI call, and they touch different KV docs — so they run side by side rather
  // than making him wait through two round trips before his message is confirmed.
  await Promise.all([maybeDetectJob(phone), maybePromise(phone)]);
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
  // Customer garage (vehicles + access notes). Sent whole; sanitized on the way in.
  if ('garage' in data) thread.garage = data.garage ? sanitizeGarage(data.garage) : null;
  if ('plan' in data) thread.plan = data.plan ? sanitizePlan(data.plan) : null;
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
  // src:'manual' records that Mikey typed this one in the composer, so when it goes
  // out the voice corpus can take it. The app's own queued items (the first
  // reach-out, booking reminders, assist replies) carry no src and stay out.
  thread.scheduled.push({ id: genId(), body, sendAt, src: 'manual' });
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
// First-party website analytics
// ---------------------------------------------------------------------------
// A tiny, self-hosted analytics system. The owner drops a one-line snippet on
// their marketing site; every page load hits GET /px, and we roll counts into a
// per-day KV doc (analytics:day:YYYY-MM-DD). No third-party service, no cookies
// beyond a same-day de-dupe key, no PII stored (IPs are hashed, never kept).
// ---------------------------------------------------------------------------
const PX_GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
function pxResponse() {
  return new Response(PX_GIF, { status: 200, headers: {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Access-Control-Allow-Origin': '*',
  } });
}
async function fnv1aHex(str) {
  // Cheap non-cryptographic hash — enough to de-dupe a visitor within a day
  // without ever storing their IP.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h.toString(16);
}
function analyticsDayKey(d) { return 'analytics:day:' + d; }
function utcDayStr(ts) { return new Date(ts).toISOString().slice(0, 10); }
async function handlePixel(url, request) {
  try {
    const now = Date.now();
    const day = utcDayStr(now);
    let path = (url.searchParams.get('p') || '/').slice(0, 120);
    try { path = decodeURIComponent(path); } catch (e) {}
    let ref = (url.searchParams.get('r') || '').slice(0, 200);
    // Reduce a referrer to its hostname so the top-referrers list stays tidy.
    let refHost = '';
    if (ref) { try { refHost = new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { refHost = ref.slice(0, 60); } }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = request.headers.get('User-Agent') || '';
    const doc = (await kv().get(analyticsDayKey(day), { type: 'json' })) || { views: 0, visitors: 0, paths: {}, refs: {} };
    doc.views = (doc.views || 0) + 1;
    doc.paths = doc.paths || {}; doc.refs = doc.refs || {};
    if (path) doc.paths[path] = (doc.paths[path] || 0) + 1;
    if (refHost && !/mikeysdetailingsnohomish/i.test(refHost)) doc.refs[refHost] = (doc.refs[refHost] || 0) + 1;
    // Same-day unique-visitor de-dupe: hash IP+UA, keep a 26h TTL marker.
    if (ip) {
      const vh = await fnv1aHex(ip + '|' + ua + '|' + day);
      const seenKey = 'analytics:seen:' + day + ':' + vh;
      const seen = await kv().get(seenKey);
      if (!seen) { doc.visitors = (doc.visitors || 0) + 1; await kv().put(seenKey, '1', { expirationTtl: 93600 }); }
    }
    // Keep the maps bounded so a busy day can't bloat the doc.
    doc.paths = trimCountMap(doc.paths, 60);
    doc.refs = trimCountMap(doc.refs, 40);
    await kv().put(analyticsDayKey(day), JSON.stringify(doc));
    // Same ping, second job: append this page to that visitor's own path so the
    // Journey board can replay it. `v` is only there if the browser could store
    // an id — no id, no journey, and the counts above are unaffected either way.
    const vid = url.searchParams.get('v');
    if (vid) await journeyStep(vid, { t: now, p: path, r: refHost });
  } catch (e) { /* never let analytics break the pixel */ }
  return pxResponse();
}
function trimCountMap(m, max) {
  const keys = Object.keys(m);
  if (keys.length <= max) return m;
  const top = keys.sort((a, b) => m[b] - m[a]).slice(0, max);
  const out = {}; for (const k of top) out[k] = m[k]; return out;
}
async function pixelRollup(days) {
  const now = Date.now();
  const series = [];
  const paths = {}; const refs = {};
  let totalViews = 0, totalVisitors = 0;
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDayStr(now - i * 86400000);
    const doc = (await kv().get(analyticsDayKey(day), { type: 'json' })) || { views: 0, visitors: 0, paths: {}, refs: {} };
    series.push({ day, views: doc.views || 0, visitors: doc.visitors || 0 });
    totalViews += doc.views || 0; totalVisitors += doc.visitors || 0;
    for (const [k, v] of Object.entries(doc.paths || {})) paths[k] = (paths[k] || 0) + v;
    for (const [k, v] of Object.entries(doc.refs || {})) refs[k] = (refs[k] || 0) + v;
  }
  const topList = (m) => Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 8).map((k) => ({ k, n: m[k] }));
  return { ok: true, days, totalViews, totalVisitors, series, topPaths: topList(paths), topRefs: topList(refs), origin: BASE_URL };
}
async function apiAnalytics(url) {
  const days = Math.min(60, Math.max(7, parseInt(url.searchParams.get('days') || '14', 10)));
  return json(await pixelRollup(days));
}

// ===========================================================================
// Customer journeys — replaying one person's path, not counting page views
// ---------------------------------------------------------------------------
// The /px pixel above answers "how many". This answers "what did THIS one do":
// Google → the ceramic page → Monroe → the quote form → they texted → booked.
//
// How the link is made, because it's the part that matters: site-stats.js mints
// a random id in the visitor's own browser (localStorage `md_vid`) and sends it
// with every page ping. It identifies nobody. When they fill out the quote or
// booking form, that same id rides along with the lead, and THAT is the single
// moment an anonymous path gets a name on it. No id, no journey — a visitor who
// never gives you their number stays a stranger who read four pages.
//
// Storage is one doc per visitor (journey:<vid>), capped and self-expiring, so
// this can never grow without bound. The recent-journeys board is built from KV
// *metadata* alone — listing 500 visitors costs zero reads.
// ===========================================================================
const JOURNEY_TTL = 45 * 86400;   // browsing older than ~6 weeks isn't a journey
// Room for a real session. Page views alone needed 40; sections seen, buttons
// pushed and form steps across several pages need far more, and a journey that
// silently drops the first half of what someone did is worse than no journey.
// ~250 steps is roughly 20 KB — nowhere near KV's 25 MB value ceiling.
const JOURNEY_MAX_STEPS = 250;
const journeyKey = (vid) => 'journey:' + vid;
const journeyPhoneKey = (phone) => 'journeymap:' + phone;

function cleanVid(v) { return String(v || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32); }

// Everything the recent-journeys board needs, small enough to live in KV
// metadata (1 KB cap) so the board never has to open a single doc.
function journeyMeta(doc) {
  const last = doc.steps[doc.steps.length - 1] || {};
  // "Tapped to CALL" tells you more from the board than "/monroe/" does, so the
  // label wins over the path when there is one.
  const lastLabel = last.l || last.p || '';
  return {
    at: doc.lastAt || 0, first: doc.firstAt || 0, n: doc.steps.length,
    phone: doc.phone || '', name: String(doc.name || '').slice(0, 40),
    last: String(lastLabel).slice(0, 60),
    ref: String((doc.steps[0] || {}).r || '').slice(0, 40),
    // Split so the board can say "5 pages · 12 actions" without opening a doc.
    pages: doc.steps.filter((x) => !x.k).length,
    acts: doc.steps.filter((x) => x.k && x.k !== 'lead').length,
    // The loudest thing that happened, for the board's own eye. A tap-to-call
    // buried 40 steps down is the thing worth seeing from the list.
    hot: journeyHotLabel(doc.steps),
  };
}

// The one step on this path most worth Mikey's attention, if there is one.
function journeyHotLabel(steps) {
  const hit = (re) => (steps.find((x) => re.test(String(x.l || ''))) || {}).l || '';
  return hit(/^BOOKED/) || hit(/Tapped to CALL/) || hit(/Tapped to TEXT/) || hit(/^Quote form/) || '';
}

function blankJourney(vid, t) { return { vid, phone: '', name: '', firstAt: t, lastAt: t, steps: [] }; }

// Append one step to a doc in memory. Pulled out of journeyStep so a batch of
// twenty events from one flush costs ONE KV read and ONE write instead of
// twenty of each — which, on a page where someone taps a lot, is the whole
// difference between this being free and this being a bill.
function appendStep(doc, step) {
  doc.steps = doc.steps || [];
  const prev = doc.steps[doc.steps.length - 1];
  // A refresh, a back-button, or the GIF ping and the event POST both reporting
  // the same landing are one visit. Same kind + same page inside a minute moves
  // the timestamp instead of printing "Home page" four times in a row.
  if (prev && prev.k === step.k && prev.p === step.p && prev.l === step.l && step.t - prev.t < 60000) prev.t = step.t;
  else doc.steps.push(step);
  doc.firstAt = doc.firstAt || step.t;
  doc.lastAt = Math.max(doc.lastAt || 0, step.t);
  if (doc.steps.length > JOURNEY_MAX_STEPS) doc.steps = doc.steps.slice(-JOURNEY_MAX_STEPS);
  return doc;
}

async function journeyStep(vid, step) {
  vid = cleanVid(vid);
  if (!vid) return null;
  const key = journeyKey(vid);
  const doc = (await kv().get(key, { type: 'json' })) || blankJourney(vid, step.t);
  appendStep(doc, step);
  await kv().put(key, JSON.stringify(doc), { expirationTtl: JOURNEY_TTL, metadata: journeyMeta(doc) });
  return doc;
}

// POST /px/e — a batch of what someone actually DID on one page: the sections
// they scrolled to, the buttons they pushed, how far down they got, how long
// they stayed. Public and unauthenticated (it comes from the marketing site),
// so everything is clamped hard before it ever reaches KV.
//
// Sent as text/plain by navigator.sendBeacon, which keeps it a "simple" request
// — no CORS preflight, and it survives the page being closed mid-flight.
const PX_EVENT_KINDS = { v: 1, s: 1, c: 1, f: 1, x: 1 };
async function handlePixelEvents(request) {
  try {
    const raw = await request.text();
    if (raw.length > 20000) return pxOk();          // nobody legitimate sends this much
    const body = JSON.parse(raw);
    const vid = cleanVid(body && body.v);
    if (!vid) return pxOk();
    let page = String((body && body.p) || '/').slice(0, 120);
    const list = Array.isArray(body && body.e) ? body.e.slice(0, 80) : [];
    if (!list.length) return pxOk();

    const now = Date.now();
    const key = journeyKey(vid);
    const doc = (await kv().get(key, { type: 'json' })) || blankJourney(vid, now);
    for (const raw2 of list) {
      const k = String((raw2 && raw2.k) || '');
      if (!PX_EVENT_KINDS[k]) continue;
      // Trust the server's clock for ordering, but keep the client's ordering
      // within the batch: a browser with a skewed clock must not scatter its
      // events across the timeline.
      const t = Number(raw2.t) || now;
      const ts = (t > now + 300000 || t < now - 86400000) ? now : t;
      const step = { t: ts, p: page,
        l: String(raw2.l || '').slice(0, 60), d: String(raw2.d || '').slice(0, 80) };
      // A landing IS a page step — same shape the GIF ping writes — so the two
      // reports of the same page load collapse into one instead of doubling up.
      if (k === 'v') { step.r = step.d; delete step.l; delete step.d; }
      else step.k = k;
      appendStep(doc, step);
    }
    await kv().put(key, JSON.stringify(doc), { expirationTtl: JOURNEY_TTL, metadata: journeyMeta(doc) });
  } catch (e) { /* a malformed beacon is not an error worth reporting */ }
  return pxOk();
}
function pxOk() {
  return new Response('', { status: 204, headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  } });
}

// The moment a stranger becomes a customer. Called from /submit with the id the
// form carried. Silent on every failure — a lead must never be lost over this.
async function journeyLink(vid, phone, name) {
  vid = cleanVid(vid);
  if (!vid || !phone) return;
  try {
    const doc = await kv().get(journeyKey(vid), { type: 'json' });
    if (!doc) return;
    doc.phone = phone;
    if (name && !doc.name) doc.name = String(name).slice(0, 60);
    doc.steps = doc.steps || [];
    doc.lastAt = Date.now();
    doc.steps.push({ t: doc.lastAt, k: 'lead' });
    if (doc.steps.length > JOURNEY_MAX_STEPS) doc.steps = doc.steps.slice(-JOURNEY_MAX_STEPS);
    await kv().put(journeyKey(vid), JSON.stringify(doc), { expirationTtl: JOURNEY_TTL, metadata: journeyMeta(doc) });
    // Reverse lookup so a conversation can find its own journey by phone.
    await kv().put(journeyPhoneKey(phone), vid, { expirationTtl: JOURNEY_TTL });
  } catch (e) { /* journeys are never worth failing a lead over */ }
}

// "/ceramic-coating-snohomish-county/" → "Ceramic Coating Snohomish County".
// The URL slugs on the marketing site are already written in plain English, so
// un-hyphenating them beats keeping a title map that goes stale.
function journeyPageTitle(p) {
  const s = String(p || '/').split('?')[0].replace(/\/+$/, '');
  if (!s || s === '') return 'Home page';
  const seg = s.split('/').filter(Boolean).pop() || '';
  if (!seg) return 'Home page';
  return seg.replace(/[-_]+/g, ' ').replace(/\.html?$/i, '').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Where they came from, said the way Mikey would say it.
function journeyRefLabel(r) {
  const h = String(r || '').replace(/^www\./, '').toLowerCase();
  if (!h) return 'Came straight to you';
  if (/google/.test(h)) return 'Found you on Google';
  if (/bing|duckduckgo|yahoo|search/.test(h)) return 'Found you in search';
  if (/facebook|fb\.|instagram|nextdoor|tiktok|yelp/.test(h)) return 'Came from ' + h.split('.')[0].replace(/\b\w/, (c) => c.toUpperCase());
  return 'Came from ' + h;
}

// GET /api/journeys?limit=30 — the recent-journeys board. Built entirely from
// KV list metadata, so it costs one list call and zero document reads.
async function apiJourneys(url) {
  const limit = Math.min(60, Math.max(5, parseInt(url.searchParams.get('limit') || '30', 10)));
  const rows = [];
  let cursor = undefined, guard = 0;
  do {
    const page = await kv().list({ prefix: 'journey:', cursor, limit: 1000 });
    for (const k of page.keys || []) {
      const m = k.metadata || {};
      rows.push({
        vid: k.name.slice('journey:'.length), at: m.at || 0, first: m.first || 0,
        steps: m.n || 0, pages: m.pages || 0, acts: m.acts || 0,
        phone: m.phone || '', name: m.name || '',
        last: m.last || '', ref: m.ref || '', hot: m.hot || '',
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && ++guard < 5);
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  const named = rows.filter((r) => r.phone).length;
  return json({ ok: true, journeys: rows.slice(0, limit), total: rows.length, named });
}

// GET /api/journey?phone=+1425…  (or ?vid=…) — one person's whole story, with
// the website path and the conversation merged into a single ordered list.
// Deliberately uses loadThread, NOT openThreadForRead: opening a thread clears
// its unread badge, and looking at a journey must never do that.
async function apiJourney(url) {
  let vid = cleanVid(url.searchParams.get('vid') || '');
  const phone = normalizePhone(url.searchParams.get('phone') || '') || '';
  if (!vid && phone) vid = cleanVid((await kv().get(journeyPhoneKey(phone))) || '');
  const doc = vid ? await kv().get(journeyKey(vid), { type: 'json' }) : null;
  const who = phone || (doc && doc.phone) || '';

  const steps = [];
  for (const s of (doc && doc.steps) || []) steps.push(journeyReadStep(s));
  // The very first PAGE view is also the "how they found you" moment. It has to
  // be the first page specifically — events carry no referrer.
  const firstPage = ((doc && doc.steps) || []).find((s) => !s.k);
  if (firstPage) steps.push({ t: (firstPage.t || 0) - 1, kind: 'found', title: journeyRefLabel(firstPage.r), detail: '' });

  let thread = null;
  if (who) {
    thread = await kv().get(threadKey(who), { type: 'json' });
    if (thread) steps.push(...journeyThreadSteps(thread));
  }
  steps.sort((a, b) => (a.t || 0) - (b.t || 0));

  return json({
    ok: true, vid: vid || '', phone: who,
    name: (thread && thread.name) || (doc && doc.name) || '',
    hasWeb: !!(doc && (doc.steps || []).length), hasThread: !!thread,
    pages: ((doc && doc.steps) || []).filter((s) => !s.k).length,
    acts: ((doc && doc.steps) || []).filter((s) => s.k && s.k !== 'lead').length,
    firstAt: steps.length ? steps[0].t : 0, lastAt: steps.length ? steps[steps.length - 1].t : 0,
    steps,
  });
}

// POST /api/journey/ai  { vid? }
// ---------------------------------------------------------------------------
// The reason for recording any of this. One journey, or the last 25 of them,
// flattened into plain text and handed to Gemini with one question: what are
// these people doing, where do they give up, and what should Mikey change?
//
// No chart can answer that. A chart can only show you what you already thought
// to plot; this can notice that everyone who books read the ceramic page first.
async function apiJourneyAi(request) {
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  let data = {};
  try { data = await request.json(); } catch (e) {}
  const one = cleanVid(data.vid || '');

  const docs = [];
  if (one) {
    const d = await kv().get(journeyKey(one), { type: 'json' });
    if (d) docs.push(d);
  } else {
    // Newest first, and only paths with enough on them to say anything.
    const page = await kv().list({ prefix: 'journey:', limit: 1000 });
    const rows = (page.keys || []).map((k) => ({ name: k.name, m: k.metadata || {} }))
      .filter((r) => (r.m.n || 0) >= 3)
      .sort((a, b) => (b.m.at || 0) - (a.m.at || 0)).slice(0, 25);
    for (const r of rows) {
      const d = await kv().get(r.name, { type: 'json' });
      if (d) docs.push(d);
    }
  }
  if (!docs.length) return json({ ok: true, read: '', empty: true });

  const lines = [];
  docs.forEach((d, i) => {
    const who = d.name || (d.phone ? 'left their number' : 'never made contact');
    lines.push(`--- VISITOR ${i + 1} (${who}) ---`);
    for (const st of (d.steps || []).slice(0, 60)) {
      const r = journeyReadStep(st);
      lines.push(`  ${new Date(r.t).toISOString().slice(11, 16)}  ${r.title}${r.detail ? ' — ' + r.detail : ''}`);
    }
  });

  const prompt = [
    'You are looking at recorded sessions from a mobile car-detailing website in Snohomish County, WA.',
    'Each block is ONE anonymous visitor: the pages they opened, the sections they scrolled to, the buttons',
    'they pushed, how far down each page they got, how long they stayed, and — if they ever filled out the',
    'quote or booking form — what happened in the conversation afterwards.',
    '',
    one ? 'Tell the owner, Mikey, the story of this one visit in plain language: what they were clearly looking for, how interested they were, and what he should do about it.'
        : 'Find the PATTERNS across these visits. What do the people who make contact do that the people who leave do not? Where exactly do people give up? Which sections and buttons are doing work, and which are being ignored?',
    '',
    'Rules:',
    '- Talk to Mikey like a person, not a report. Short paragraphs, no headings, no bullet symbols.',
    '- Say what the evidence actually supports. If there is not enough here to tell, say that plainly.',
    '- Never invent a number you were not given.',
    '- End with the single most useful thing he could change on the site, and why this data says so.',
    '',
    lines.join('\n').slice(0, 40000),
  ].join('\n');

  try {
    const read = await geminiGenerate(prompt, { surface: 'journey read', temperature: 0.5, maxTokens: 900 });
    return json({ ok: true, read, visitors: docs.length, scope: one ? 'one' : 'all' });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 200) }, 502);
  }
}

// One stored step → one row Mikey can read. The storage shape is deliberately
// terse (k/l/d/p, one or two letters) because it's written on every click and
// read on every page load; all the English lives here, at read time, where it
// costs nothing and can be reworded without a migration.
function journeyReadStep(s) {
  if (!s.k) return { t: s.t, kind: 'page', title: journeyPageTitle(s.p), detail: s.p || '/', page: s.p || '/' };
  if (s.k === 'lead') return { t: s.t, kind: 'lead', title: 'Left their number', detail: 'Filled out the form on your site' };
  const base = { t: s.t, detail: s.d || '', page: s.p || '' };
  if (s.k === 's') return { ...base, kind: 'section', title: 'Scrolled to ' + (s.l || 'a section') };
  if (s.k === 'f') return { ...base, kind: 'form', title: s.l || 'Form step' };
  if (s.k === 'x') return { ...base, kind: 'exit', title: s.l || 'Left the page' };
  if (s.k === 'c') {
    // A tap-to-call or tap-to-text is the single most valuable thing anyone
    // does on that site, so it says so plainly instead of "Pushed (425)…".
    const hot = /^Tapped to (CALL|TEXT)/.test(s.l || '');
    return { ...base, kind: hot ? 'contact' : 'click', title: hot ? s.l : 'Pushed "' + (s.l || 'a button') + '"' };
  }
  return { ...base, kind: 'click', title: s.l || 'Did something' };
}

// The conversation side of a journey. Runs of texts in the same direction
// collapse into one step ("They texted 3 times") — a 60-message thread drawn one
// bubble per row is a transcript, not a story, and Mikey already has the
// transcript one tap away.
function journeyThreadSteps(thread) {
  const out = [];
  const msgs = (thread.messages || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let run = null;
  for (const m of msgs) {
    if (run && run.dir === m.dir) { run.n++; run.last = m.ts; continue; }
    if (run) out.push(runStep(run));
    run = { dir: m.dir, n: 1, t: m.ts, last: m.ts, body: m.body || '' };
  }
  if (run) out.push(runStep(run));

  if (thread.quote && thread.quote.at) {
    out.push({ t: thread.quote.at, kind: 'quote', title: 'You sent a quote',
      detail: (thread.quote.total ? '$' + thread.quote.total : '') + (thread.quote.service ? ' · ' + thread.quote.service : '') });
  }
  if (thread.appointmentAt) out.push({ t: thread.appointmentAt, kind: 'booked', title: 'Booked in', detail: '' });
  if (thread.plan && thread.plan.startedAt) {
    out.push({ t: thread.plan.startedAt, kind: 'plan', title: 'Started a plan',
      detail: thread.plan.every ? 'Every ' + thread.plan.every : '' });
  }
  if (thread.status === 'won' && thread.statusAt) out.push({ t: thread.statusAt, kind: 'won', title: 'Became a customer', detail: '' });
  return out;

  function runStep(r) {
    const them = r.dir === 'in';
    return {
      t: r.t, kind: them ? 'them' : 'you',
      title: them ? (r.n === 1 ? 'They texted you' : 'They texted ' + r.n + ' times')
                  : (r.n === 1 ? 'You replied' : 'You sent ' + r.n + ' texts'),
      detail: String(r.body || '').replace(/\s+/g, ' ').slice(0, 120),
    };
  }
}

// ===========================================================================
// Dashboard usage — what actually gets touched in here
// ---------------------------------------------------------------------------
// The /px pixel above answers "what do customers do on the website". This
// answers the same question about the dashboard itself, and it exists for one
// reason: this app is a 13,000-line HTML file with ~570 named controls on it,
// and nobody — Mikey included — can say from memory which of them he has ever
// pushed. A screen that has been sitting there for a month unused is a screen
// that should come out, and until it's counted, cutting anything is a guess.
//
// Two collectors feed one set of docs:
//
//   THE GATE. `noteApiUse()` sits just past the /api auth check in handle(),
//   so every server-backed feature — all ~130 routes — counts itself with no
//   client code at all. That coverage keeps working if the browser collector
//   is ever broken, blocked, or serving a stale cached shell.
//
//   THE BROWSER. A delegated click listener plus the screen switches report
//   what the server can never see: which screen he's standing on and for how
//   long, which buttons only open a sheet, and which screens he opens and
//   abandons in seconds. Those last ones are the interesting ones — a screen
//   opened daily and left immediately is a screen that isn't answering the
//   question he opened it with.
//
// COST decides the whole shape of this, and the budget is brutal: the free tier
// allows ~1,000 KV WRITES A DAY for the entire app (see the warning at the top
// of this file), and blowing it hard-stops everything with 429s until midnight.
// A feature that measures the dashboard must never be the thing that breaks it.
//
// So the target here is ~100 writes a day, and three decisions get it there:
//
//   ONE WRITE PER FLUSH. The replay tape lives inside the day doc rather than
//   in a key of its own, so a flush is a single put() — not three.
//
//   FLUSHES ARE RARE. The browser's timer is USE_FLUSH_MS — minutes, not
//   seconds — because the real batching boundary is him putting the phone down:
//   hiding the app always beacons. A session of two hundred taps is ONE write.
//
//   THE CATALOG IS WRITTEN ONLY WHEN IT MEANS SOMETHING. Its counts change on
//   every flush, but what it is FOR — the dead list and the cold list — only
//   changes when a control is seen for the first time, or used for the first
//   time. Those force a write; a bumped counter does not, and rides along on
//   the next one. See useCatalogDirty.
//
// AND A KILL SWITCH. Set the Worker var USAGE_OFF=1 and every collector here
// goes quiet at once. It is a var rather than a KV flag on purpose — the exact
// emergency this needs to survive is the daily write limit being exhausted, and
// at that point an in-app toggle cannot save itself. Same reasoning as the other
// kill switches; see envFlag() at the top of this file.
//
// WHAT IS DELIBERATELY NOT RECORDED: content. That he pushed Send, never what
// he sent. That he logged money, never how much. That he opened a thread,
// never whose. /api/use/export exists to be pasted into a chat with Claude,
// and that is only a safe thing to do if no customer has ever been in it.
// ===========================================================================
const USE_TTL = 200 * 86400;        // ~6 months of days is plenty to spot a trend
const USE_TAPE_PER_DAY = 120;       // the replay tape, kept inside the day doc
const USE_TAPE_READ = 120;          // how much of it any one read hands back
const USE_CATALOG_MAX = 1500;       // hard ceiling on the feature index
const USE_FLUSH_MS = 600000;        // gate backstop: ten minutes, not seconds — see COST
const USE_BUF_MAX = 400;            // …or this many, whichever comes first
const USE_CATALOG_STALE = 86400000; // refresh the counters at most once a day
const USE_BAIL_MS = 2500;           // opened and gone again = a dead end, not a visit
const useDayKey = (d) => 'use:day:' + d;
const USE_CATALOG_KEY = 'use:catalog';

// The gate's buffer. Module-level ON PURPOSE, and deliberately NOT cleared by
// resetInvocationCaches(): it has to survive from one request to the next
// inside the same isolate, because surviving is the entire saving. Losing a
// few counts when Cloudflare evicts an idle isolate is the price, and for
// "which features does he use" it costs nothing worth having.
let USE_BUF = [];
let USE_BUF_AT = 0;

// Event kinds. One letter because these are written on every tap; all the
// English lives in useReadKind() at read time, same bargain as journeyReadStep.
//   t = tapped a control      v = opened a screen     x = left a screen (ms)
//   b = bailed out of a screen (opened, gone in seconds)
//   s = opened the app        a = called a server feature (from the gate)
const USE_KINDS = { t: 1, v: 1, x: 1, b: 1, s: 1, a: 1 };

function useLabel(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 60); }

// A route reduced to the feature it is. Tokens, phone numbers and ids in the
// path would otherwise make every call look like its own feature and blow the
// catalog out — "/api/thread/+14255550123" is the same feature every time.
function useRoutePath(pathname) {
  return String(pathname || '').split('?')[0].split('/').map((seg) => {
    if (!seg) return seg;
    // 16 is well past every real segment in the router ("disconnect" is the
    // longest at 10) and well short of any token or id, which is the line that
    // actually needs drawing.
    const plain = /^[a-z][a-z0-9-]*$/i.test(seg) && !/^\d+$/.test(seg) && seg.length <= 16;
    return plain ? seg : ':id';
  }).join('/').slice(0, 60);
}

// ---- the feature index -----------------------------------------------------
// One doc that answers "has this ever been used, and when last" without
// reading a single day doc. This is the cheap surface the dead-list and the
// export both read; the day docs are only for drawing the trend.
//
// `seen` is what makes a dead list possible at all. The browser reports every
// control it has ever PUT ON SCREEN, not just the ones that got pushed — so a
// button with seen-but-never-used is a genuine finding, where a button simply
// missing from the counts might just mean he never opened that screen.
function blankUseCatalog() { return { at: 0, keys: {} }; }
// Returns true when this touch changed something a reader would actually see —
// a control that has never been seen before, or one crossing from never-used to
// used. A bumped counter returns false: it is kept in memory and written out
// with the next real change, because paying a KV write for it would cost more
// than the number is worth.
function useCatalogTouch(cat, key, kind, ts, used) {
  const k = useLabel(key);
  if (!k) return false;
  let notable = false;
  let row = cat.keys[k];
  if (!row) { row = cat.keys[k] = { k: kind || 't', f: ts, l: 0, n: 0 }; notable = true; }
  if (kind && row.k !== kind && row.n === 0) row.k = kind;
  row.f = Math.min(row.f || ts, ts);
  if (used) {
    if (!row.n) notable = true;          // off the dead list — that has to stick
    row.n = (row.n || 0) + 1;
    row.l = Math.max(row.l || 0, ts);
  }
  return notable;
}
// Bound the index. Something that has never been used and was first seen
// longest ago is the safest thing to forget — it's either gone from the UI or
// it's about to be reported again the next time that screen draws.
function useCatalogTrim(cat) {
  const keys = Object.keys(cat.keys);
  if (keys.length <= USE_CATALOG_MAX) return cat;
  const drop = keys.filter((k) => !cat.keys[k].n).sort((a, b) => (cat.keys[a].f || 0) - (cat.keys[b].f || 0));
  let over = keys.length - USE_CATALOG_MAX;
  for (const k of drop) { if (over-- <= 0) break; delete cat.keys[k]; }
  // Still over even after dropping every unused one: fall back to least-recently-used.
  const left = Object.keys(cat.keys);
  if (left.length > USE_CATALOG_MAX) {
    const lru = left.sort((a, b) => (cat.keys[a].l || 0) - (cat.keys[b].l || 0)).slice(0, left.length - USE_CATALOG_MAX);
    for (const k of lru) delete cat.keys[k];
  }
  return cat;
}

function blankUseDay(d) {
  return { d, n: 0, sess: 0, first: 0, last: 0,
    f: {},      // control label -> taps
    api: {},    // server route -> calls
    s: {},      // screen -> times opened
    ms: {},     // screen -> milliseconds actually on it
    b: {},      // screen -> times opened and abandoned in seconds
    h: {},      // local hour -> events, i.e. when in the day he's in here
    // The replay tape lives HERE rather than in a key of its own. Counts tell
    // you what he uses; only the order tells you that he checks Money after
    // every single send. Keeping it in the day doc is what makes a flush one
    // KV write instead of two — and reads want the day docs anyway.
    tape: [] };
}

// Apply one event to a day doc. Split out so a whole flush shares a single
// read-modify-write per day, the same reason appendStep() exists above.
function useApplyEvent(doc, ev, hour) {
  if (!USE_KINDS[ev.k]) return false;
  doc.n = (doc.n || 0) + 1;
  doc.first = doc.first ? Math.min(doc.first, ev.t) : ev.t;
  doc.last = Math.max(doc.last || 0, ev.t);
  if (hour >= 0) doc.h[hour] = (doc.h[hour] || 0) + 1;
  const l = ev.l;
  if (ev.k === 's') doc.sess = (doc.sess || 0) + 1;
  else if (ev.k === 't' && l) doc.f[l] = (doc.f[l] || 0) + 1;
  else if (ev.k === 'a' && l) doc.api[l] = (doc.api[l] || 0) + 1;
  else if (ev.k === 'v' && l) doc.s[l] = (doc.s[l] || 0) + 1;
  else if (ev.k === 'b' && l) doc.b[l] = (doc.b[l] || 0) + 1;
  else if (ev.k === 'x' && l) doc.ms[l] = (doc.ms[l] || 0) + Math.max(0, Math.min(3600000, Number(ev.d) || 0));
  return true;
}

// Write a batch. Events are grouped by their own local day first so a flush
// that straddles midnight lands on both days correctly rather than dumping
// yesterday's evening into today.
//
// The write count is the thing to watch here: one put() per day touched (nearly
// always exactly one), plus the catalog only when it has something new to say.
async function useFlush(events, seenKeys) {
  if (envFlag('USAGE_OFF')) return 0;
  const list = (events || []).filter((e) => e && USE_KINDS[e.k]);
  if (!list.length && !(seenKeys || []).length) return 0;
  const cfg = await loadConfig();
  const tz = cfg.tz;

  const byDay = new Map();
  for (const ev of list) {
    const day = localDateStr(ev.t, tz);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  for (const [day, evs] of byDay) {
    const key = useDayKey(day);
    const doc = (await kv().get(key, { type: 'json' })) || blankUseDay(day);
    // An older doc written before a field existed must not throw here.
    for (const f of ['f', 'api', 's', 'ms', 'b', 'h']) doc[f] = doc[f] || {};
    doc.tape = doc.tape || [];
    for (const ev of evs) useApplyEvent(doc, ev, localHour(ev.t, tz));
    // Screen-exits and app-opens stay off the tape: they are bookkeeping, and
    // they would bury the actual moves under themselves.
    const acts = evs.filter((e) => e.k === 't' || e.k === 'v' || e.k === 'b' || e.k === 'a');
    if (acts.length) {
      doc.tape = doc.tape.concat(acts.map((e) => ({ t: e.t, k: e.k, l: e.l })))
        .sort((a, b) => a.t - b.t).slice(-USE_TAPE_PER_DAY);
    }
    await kv().put(key, JSON.stringify(doc), { expirationTtl: USE_TTL });
  }

  const cat = (await kv().get(USE_CATALOG_KEY, { type: 'json' })) || blankUseCatalog();
  cat.keys = cat.keys || {};
  let notable = false;
  for (const k of seenKeys || []) notable = useCatalogTouch(cat, k, 't', Date.now(), false) || notable;
  for (const ev of list) {
    if (ev.k === 't') notable = useCatalogTouch(cat, ev.l, 't', ev.t, true) || notable;
    else if (ev.k === 'a') notable = useCatalogTouch(cat, ev.l, 'api', ev.t, true) || notable;
    else if (ev.k === 'v') notable = useCatalogTouch(cat, ev.l, 'screen', ev.t, true) || notable;
  }
  // Written when the dead or cold list would actually read differently, or when
  // the counters have gone a day stale — never merely because a number moved.
  if (notable || Date.now() - (cat.at || 0) > USE_CATALOG_STALE) {
    cat.at = Date.now();
    await kv().put(USE_CATALOG_KEY, JSON.stringify(useCatalogTrim(cat)));
  }
  return list.length;
}

// ---- the gate --------------------------------------------------------------
// Called for every authenticated /api/* request. Buffers only; the write
// happens in useMaybeFlush(), off the response path.
function noteApiUse(pathname, method) {
  if (envFlag('USAGE_OFF')) return;
  const p = useRoutePath(pathname);
  // Never count the usage endpoints themselves — a tracker that shows up as
  // the most-used feature in its own report is just noise.
  if (p.indexOf('/api/use') === 0) return;
  const l = useLabel((method === 'GET' ? '' : method + ' ') + p);
  USE_BUF.push({ t: Date.now(), k: 'a', l });
  if (!USE_BUF_AT) USE_BUF_AT = Date.now();
}
function useBufDue() {
  return USE_BUF.length >= USE_BUF_MAX || (USE_BUF_AT && Date.now() - USE_BUF_AT >= USE_FLUSH_MS);
}
// Hand the buffer over and clear it in the same breath, so a flush running in
// waitUntil can't race the next request into writing the same events twice.
function useTakeBuf() { const out = USE_BUF; USE_BUF = []; USE_BUF_AT = 0; return out; }
async function useMaybeFlush(force) {
  if (!USE_BUF.length || (!force && !useBufDue())) return 0;
  try { return await useFlush(useTakeBuf(), []); } catch (e) { return 0; }
}

// ---- POST /api/use — the browser's batch ----------------------------------
// Behind the /api auth gate, so unlike /px/e this is never public. Everything
// is still clamped, because a stale cached shell sending a malformed batch is
// a real thing that happens and must not poison the counts.
async function apiUseIngest(request) {
  if (envFlag('USAGE_OFF')) return json({ ok: true, off: true });
  let body = {};
  try { body = await readJson(request); } catch (e) {}
  const now = Date.now();
  const raw = Array.isArray(body.e) ? body.e.slice(0, 120) : [];
  const events = [];
  for (const r of raw) {
    const k = String((r && r.k) || '');
    if (!USE_KINDS[k] || k === 'a') continue;    // 'a' is the gate's alone
    // Trust the server clock for anything wildly off: a phone whose clock is
    // days out must not scatter its taps across the calendar.
    const t = Number(r.t) || now;
    const ts = (t > now + 300000 || t < now - 86400000) ? now : t;
    events.push({ t: ts, k, l: useLabel(r.l), d: Number(r.d) || 0 });
  }
  const seen = (Array.isArray(body.c) ? body.c.slice(0, 400) : []).map((x) => useLabel(x)).filter(Boolean);
  // Fold in whatever the gate is holding: this request is already paying for a
  // read and a write, so the buffered API counts ride along for free.
  const mine = useTakeBuf();
  const n = await useFlush(events.concat(mine), seen);
  return json({ ok: true, n });
}

// ---- reading it back -------------------------------------------------------
const useSortDesc = (m) => Object.keys(m || {}).map((k) => ({ k, n: m[k] })).sort((a, b) => b.n - a.n);
const useDays = (v) => Math.max(1, Math.min(90, parseInt(v, 10) || 30));

async function useLoadDays(days, tz) {
  const now = Date.now();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = localDateStr(now - i * DAY_MS, tz);
    const doc = await kv().get(useDayKey(d), { type: 'json' });
    out.push(doc || blankUseDay(d));
  }
  return out;
}

// Everything the three read endpoints need, gathered once. They used to each
// walk the day docs themselves, which meant three copies of the same summing
// loop and three chances for the numbers on the screen to disagree with the
// numbers in the export.
async function useGather(days) {
  const cfg = await loadConfig();
  const docs = await useLoadDays(days, cfg.tz);
  const cat = (await kv().get(USE_CATALOG_KEY, { type: 'json' })) || blankUseCatalog();
  const g = { days, docs, cat, tape: [], f: {}, api: {}, s: {}, ms: {}, b: {}, h: {},
              sess: 0, activeDays: 0, events: 0, taps: 0 };
  for (const doc of docs) {
    if (doc.n) g.activeDays++;
    g.events += doc.n || 0;
    g.sess += doc.sess || 0;
    for (const [m, into] of [[doc.f, g.f], [doc.api, g.api], [doc.s, g.s], [doc.ms, g.ms], [doc.b, g.b], [doc.h, g.h]]) {
      for (const k of Object.keys(m || {})) into[k] = (into[k] || 0) + m[k];
    }
    for (const k of Object.keys(doc.f || {})) g.taps += doc.f[k];
  }
  // The tape is stitched back together out of the day docs, which are already
  // loaded — so the replay costs no extra read at all.
  for (const doc of docs) if (doc.tape && doc.tape.length) g.tape = g.tape.concat(doc.tape);
  g.tape = g.tape.slice(-USE_TAPE_READ);
  g.rows = Object.keys(cat.keys || {}).map((key) => Object.assign({ key }, cat.keys[key]));
  return g;
}
// Seen on screen, never once pushed. The list the whole feature is for.
function useDeadRows(g) {
  return g.rows.filter((r) => !r.n && r.k === 't').sort((a, b) => (a.f || 0) - (b.f || 0));
}
// Used once upon a time and not since — a different finding, and a different fix.
function useColdRows(g, now) {
  return g.rows.filter((r) => r.n > 0 && r.l && now - r.l > 30 * DAY_MS).sort((a, b) => (a.l || 0) - (b.l || 0));
}
// Screens ranked by where the time actually goes rather than by how often he
// lands on them: a screen he opens twenty times for three seconds each is a
// very different thing from one he sits on.
function useScreenRows(g) {
  return Object.keys(Object.assign({}, g.s, g.ms)).map((k) => ({
    k, n: g.s[k] || 0, ms: g.ms[k] || 0, bail: g.b[k] || 0,
  })).sort((a, b) => b.ms - a.ms);
}

// GET /api/use?days=30 — everything the Usage screen draws.
async function apiUse(url) {
  const g = await useGather(useDays(url.searchParams.get('days')));
  const now = Date.now();
  const dead = useDeadRows(g).slice(0, 120).map((r) => ({ key: r.key, since: r.f || 0 }));
  const cold = useColdRows(g, now).slice(0, 60).map((r) => ({ key: r.key, n: r.n, last: r.l }));
  return json({ ok: true, days: g.days,
    range: { from: g.docs[0].d, to: g.docs[g.docs.length - 1].d },
    trend: g.docs.map((d) => ({ d: d.d, n: d.n || 0, sess: d.sess || 0 })),
    totals: { events: g.events, taps: g.taps, sessions: g.sess, activeDays: g.activeDays,
              tracked: g.rows.length, dead: dead.length },
    top: useSortDesc(g.f).slice(0, 40),
    server: useSortDesc(g.api).slice(0, 40),
    screens: useScreenRows(g).slice(0, 20),
    hours: Array.from({ length: 24 }, (_, i) => g.h[i] || 0),
    dead, cold,
    tape: g.tape.slice(-60).reverse(),
  });
}

// One stored event -> one line a person can read. Same bargain as
// journeyReadStep: the storage stays one letter, the English lives here.
function useReadKind(k) {
  return k === 't' ? 'pushed' : k === 'v' ? 'opened' : k === 'b' ? 'opened and left' :
         k === 'a' ? 'server' : k === 'x' ? 'left' : k === 's' ? 'opened the app' : k;
}

// The export, as plain text — deliberately.
// This is the deliverable: the thing to paste into a chat with Claude when the
// question is "what do I actually use". JSON would be smaller and worse. The
// point is that it reads as evidence to a person and to a model alike, and
// that anyone can see at a glance that no customer is in it.
function useExportText(g) {
  const now = Date.now();
  const mins = (v) => Math.round((v || 0) / 60000);
  const L = [];
  L.push(`DASHBOARD USAGE — ${g.docs[0].d} to ${g.docs[g.docs.length - 1].d} (${g.days} days)`);
  L.push('Nothing below identifies a customer: features and screens only, never content.');
  L.push('');
  L.push(`App opened ${g.sess} times across ${g.activeDays} of ${g.days} days.`);
  L.push('');
  L.push('WHAT HE PUSHES (times, control)');
  const top = useSortDesc(g.f);
  if (!top.length) L.push('  (nothing recorded yet)');
  top.slice(0, 60).forEach((r) => L.push(`  ${r.n}\t${r.k}`));
  L.push('');
  L.push('WHERE THE TIME GOES (screen, opens, minutes on it, times he walked straight back out)');
  const screens = useScreenRows(g).slice(0, 25);
  if (!screens.length) L.push('  (nothing recorded yet)');
  screens.forEach((r) => L.push(`  ${r.k}\t${r.n} opens\t${mins(r.ms)} min${r.bail ? `\t${r.bail} bailed` : ''}`));
  L.push('');
  L.push('SERVER FEATURES CALLED (times, route)');
  const srv = useSortDesc(g.api);
  if (!srv.length) L.push('  (nothing recorded yet)');
  srv.slice(0, 60).forEach((r) => L.push(`  ${r.n}\t${r.k}`));
  L.push('');
  L.push('WHEN HE IS IN HERE (local hour: events)');
  L.push('  ' + Array.from({ length: 24 }, (_, i) => `${i}:${g.h[i] || 0}`).join('  '));
  L.push('');
  const dead = useDeadRows(g);
  L.push(`NEVER ONCE USED — on screen but never pushed (${dead.length})`);
  if (!dead.length) L.push('  (none yet — the catalog fills in as each screen is opened)');
  dead.slice(0, 150).forEach((r) => L.push(`  ${r.key}\t(first seen ${new Date(r.f || now).toISOString().slice(0, 10)})`));
  L.push('');
  const cold = useColdRows(g, now);
  L.push(`WENT COLD — used before, nothing in 30+ days (${cold.length})`);
  if (!cold.length) L.push('  (none)');
  cold.slice(0, 80).forEach((r) => L.push(`  ${r.key}\t${r.n} times, last ${new Date(r.l).toISOString().slice(0, 10)}`));
  L.push('');
  L.push('THE LAST FEW MOVES, IN ORDER (most recent last)');
  const steps = g.tape.slice(-USE_TAPE_READ);
  if (!steps.length) L.push('  (nothing recorded yet)');
  steps.forEach((st) => {
    L.push(`  ${new Date(st.t).toISOString().replace('T', ' ').slice(0, 16)}  ${useReadKind(st.k)} ${st.l || ''}`.trimEnd());
  });
  return L.join('\n');
}

// GET /api/use/export?days=30
async function apiUseExport(url) {
  const g = await useGather(useDays(url.searchParams.get('days')));
  return new Response(useExportText(g), { status: 200, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  } });
}

// POST /api/use/ai — the reason for recording behaviour instead of counting it.
// A bar chart can only show what someone already thought to plot. This can
// notice that he opens Money right after every send, or that he has opened
// Pipeline every morning for a month and never once pushed anything on it.
async function apiUseAi(request) {
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  let data = {};
  try { data = await readJson(request); } catch (e) {}
  const g = await useGather(useDays(data.days));
  // Emptiness is a fact about the record, not something to infer from the text
  // of the report — the header alone ("across 0 of 30 days") carries digits.
  if (!g.events) return json({ ok: true, read: '', empty: true });
  const body = useExportText(g);

  const prompt = [
    'Below is a recording of how ONE person — Mikey, who runs a mobile car-detailing business alone —',
    'actually uses his own dashboard: which controls he pushes, which screens he sits on and for how long,',
    'which screens he opens and abandons in seconds, what hours he is in there, which controls have been',
    'on his screen for weeks and never once pushed, and the raw order of his last few moves.',
    '',
    'Tell him what this says about how he really works. Specifically:',
    '- What is he leaning on hardest, and what does that suggest is missing right next to it?',
    '- What routine shows up in the ORDER of his moves that could be collapsed into one button?',
    '- What has he never used, or stopped using, that is worth deleting to make the app smaller?',
    '- Where does he open something and leave immediately? That screen is not answering his question.',
    '',
    'Rules:',
    '- Talk to Mikey like a person, not a report. Short paragraphs, no headings, no bullet symbols.',
    '- Say what the evidence actually supports. If there is not enough recorded yet to tell, say so plainly.',
    '- Never invent a number you were not given.',
    '- End with the single most useful change to the dashboard this data argues for, and why.',
    '',
    body.slice(0, 40000),
  ].join('\n');

  try {
    // Tagged like every other call site so this shows up by name in
    // ☰ → Settings → what the AI is actually costing, rather than in "other".
    const read = await geminiGenerate(prompt, { surface: 'usage read', temperature: 0.5, maxTokens: 900 });
    return json({ ok: true, read, days: g.days });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err).slice(0, 200) }, 502);
  }
}

// ===========================================================================
// Website analytics command center — GA4 + Microsoft Clarity
// ---------------------------------------------------------------------------
// One merged, heavily-cached payload for the Grow → Website tab: Google
// Analytics 4 (via a service account — the SAME JSON file the daily-email
// function on Netlify uses), Microsoft Clarity's data-export API, the
// first-party /px pixel, and GA realtime ("N people on the site right now").
//
// Credentials are pasted ONCE inside the dashboard (Website tab → Connect) and
// stored in KV — or provided as Worker secrets, which always win:
//   GOOGLE_SERVICE_ACCOUNT_JSON   service-account JSON (Viewer on the property)
//   CLARITY_API_TOKEN             Clarity → Settings → Data Export → token
//   GA4_PROPERTY_ID               defaults to Mikey's property below
// They are never echoed back by any endpoint and never appear in this repo.
//
// KV-write budget (see warning at the top of this file): everything here is
// read-mostly. GA responses cache 30 min per range (10 min for "today"),
// realtime is fetched live but never written, and Clarity caches for 6 hours —
// their API allows only TEN calls per project per day, so a budget counter
// hard-stops us at 8 and serves stale data after that.
// ===========================================================================
const GA4_DEFAULT_PROPERTY = '489075814';
const WEBSTATS_EVENTS = { qqc: 'qqc_submission', phone: 'phone_click' };
const CLARITY_DAILY_BUDGET = 8; // Clarity's hard API limit is 10/day — keep headroom
const WEBSTATS_RANGES = {
  today: { cur: { startDate: 'today', endDate: 'today' },       prev: { startDate: 'yesterday', endDate: 'yesterday' },   days: 1 },
  '7d':  { cur: { startDate: '6daysAgo', endDate: 'today' },    prev: { startDate: '13daysAgo', endDate: '7daysAgo' },    days: 7 },
  '28d': { cur: { startDate: '27daysAgo', endDate: 'today' },   prev: { startDate: '55daysAgo', endDate: '28daysAgo' },   days: 28 },
  '90d': { cur: { startDate: '89daysAgo', endDate: 'today' },   prev: { startDate: '179daysAgo', endDate: '90daysAgo' }, days: 90 },
};

async function webstatsSecrets() {
  const saved = (await kv().get('webstats:secrets', { type: 'json' })) || {};
  return {
    gaJson: String(ENV.GOOGLE_SERVICE_ACCOUNT_JSON || saved.gaJson || ''),
    clarityToken: String(ENV.CLARITY_API_TOKEN || saved.clarityToken || ''),
    propertyId: String(ENV.GA4_PROPERTY_ID || saved.propertyId || GA4_DEFAULT_PROPERTY),
    gaVia: ENV.GOOGLE_SERVICE_ACCOUNT_JSON ? 'secret' : (saved.gaJson ? 'saved' : ''),
    clarityVia: ENV.CLARITY_API_TOKEN ? 'secret' : (saved.clarityToken ? 'saved' : ''),
  };
}

// --- Google service-account auth (JWT-bearer, signed with WebCrypto RS256) ---
function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToArrayBuffer(pem) {
  const b64 = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function gaAccessToken(creds) {
  const cached = await kv().get('webstats:gatok', { type: 'json' });
  if (cached && cached.email === creds.client_email && cached.exp > Date.now() + 120000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const aud = creds.token_uri || 'https://oauth2.googleapis.com/token';
  const enc = (obj) => b64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud, iat, exp: iat + 3600,
  });
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlFromBytes(new Uint8Array(sig));
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!res.ok) throw new Error('Google auth ' + res.status + ': ' + (await res.text()).slice(0, 180));
  const data = await res.json();
  // Cache ~55 min (1 KV write per hour of active use, max).
  await kv().put('webstats:gatok', JSON.stringify({
    token: data.access_token, email: creds.client_email,
    exp: Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000,
  }), { expirationTtl: 3600 });
  return data.access_token;
}

// --- GA4 Data API ---
async function gaBatch(propertyId, token, requests) {
  const res = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':batchRunReports', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error('GA4 ' + res.status + ': ' + (await res.text()).slice(0, 220));
  return (await res.json()).reports || [];
}
function gaRows(rep) { return (rep && rep.rows) || []; }
function gaNum(mv, i) { return parseFloat((((mv || [])[i] || {}).value) || '0') || 0; }
function gaDim(dv, i) { return String((((dv || [])[i] || {}).value) || ''); }

async function gaBundle(sec, rangeKey, force) {
  const cacheKey = 'webstats:ga:' + rangeKey;
  const freshMs = rangeKey === 'today' ? 600000 : 1800000;
  const cached = await kv().get(cacheKey, { type: 'json' });
  if (cached && !force && Date.now() - cached.fetchedAt < freshMs) {
    return Object.assign({}, cached.ga, { fetchedAt: cached.fetchedAt, cached: true });
  }
  let creds;
  try { creds = JSON.parse(sec.gaJson); } catch { throw new Error('Saved service-account JSON is not valid JSON'); }
  const token = await gaAccessToken(creds);
  const R = WEBSTATS_RANGES[rangeKey];
  const evFilter = { filter: { fieldName: 'eventName', inListFilter: { values: [WEBSTATS_EVENTS.qqc, WEBSTATS_EVENTS.phone] } } };
  const m = (names) => names.map((n) => ({ name: n }));
  const [a, b] = await Promise.all([
    gaBatch(sec.propertyId, token, [
      { dateRanges: [R.cur], dimensions: m(['date']), metrics: m(['sessions', 'totalUsers', 'screenPageViews', 'engagedSessions']), orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
      { dateRanges: [R.cur], dimensions: m(['date', 'eventName']), metrics: m(['eventCount']), dimensionFilter: evFilter, limit: 500 },
      { dateRanges: [R.cur, R.prev], metrics: m(['sessions', 'totalUsers', 'screenPageViews', 'engagedSessions', 'averageSessionDuration', 'newUsers']) },
      { dateRanges: [R.cur, R.prev], dimensions: m(['eventName']), metrics: m(['eventCount']), dimensionFilter: evFilter },
      { dateRanges: [R.cur], dimensions: m(['pagePath']), metrics: m(['screenPageViews', 'activeUsers']), orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 12 },
    ]),
    gaBatch(sec.propertyId, token, [
      { dateRanges: [R.cur], dimensions: m(['sessionDefaultChannelGroup', 'sessionSource']), metrics: m(['sessions']), orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 30 },
      { dateRanges: [R.cur], dimensions: m(['city']), metrics: m(['sessions']), orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 },
      { dateRanges: [R.cur], dimensions: m(['deviceCategory']), metrics: m(['sessions']) },
      { dateRanges: [R.cur], dimensions: m(['hour']), metrics: m(['sessions']), limit: 30 },
      { dateRanges: [R.cur], dimensions: m(['pagePath', 'eventName']), metrics: m(['eventCount']), dimensionFilter: evFilter, orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 24 },
    ]),
  ]);
  const ga = gaShape(a, b);
  ga.propertyId = sec.propertyId;
  await kv().put(cacheKey, JSON.stringify({ fetchedAt: Date.now(), ga }), { expirationTtl: 7200 });
  return Object.assign({}, ga, { fetchedAt: Date.now(), cached: false });
}

// Turn the two batchRunReports responses into one compact, UI-ready object.
// Note: when a request has TWO dateRanges, GA appends an implicit "dateRange"
// dimension as the LAST dimension value (date_range_0 = current period).
function gaShape(a, b) {
  const seriesR = a[0], evSeriesR = a[1], totalsR = a[2], evTotalsR = a[3], pagesR = a[4];
  const srcR = b[0], citiesR = b[1], devicesR = b[2], hoursR = b[3], pageEvR = b[4];

  const byDate = {};
  for (const r of gaRows(seriesR)) {
    const d = gaDim(r.dimensionValues, 0);
    byDate[d] = { d, sessions: gaNum(r.metricValues, 0), users: gaNum(r.metricValues, 1), views: gaNum(r.metricValues, 2), engaged: gaNum(r.metricValues, 3), qqc: 0, phone: 0 };
  }
  for (const r of gaRows(evSeriesR)) {
    const d = gaDim(r.dimensionValues, 0), ev = gaDim(r.dimensionValues, 1), n = gaNum(r.metricValues, 0);
    if (!byDate[d]) byDate[d] = { d, sessions: 0, users: 0, views: 0, engaged: 0, qqc: 0, phone: 0 };
    if (ev === WEBSTATS_EVENTS.qqc) byDate[d].qqc = n;
    else if (ev === WEBSTATS_EVENTS.phone) byDate[d].phone = n;
  }
  const series = Object.values(byDate).sort((x, y) => (x.d < y.d ? -1 : 1));

  const blank = () => ({ sessions: 0, users: 0, views: 0, engaged: 0, avgDur: 0, newUsers: 0, qqc: 0, phone: 0 });
  const totals = blank(), prev = blank();
  for (const r of gaRows(totalsR)) {
    const t = gaDim(r.dimensionValues, 0) === 'date_range_1' ? prev : totals;
    t.sessions = gaNum(r.metricValues, 0); t.users = gaNum(r.metricValues, 1); t.views = gaNum(r.metricValues, 2);
    t.engaged = gaNum(r.metricValues, 3); t.avgDur = Math.round(gaNum(r.metricValues, 4)); t.newUsers = gaNum(r.metricValues, 5);
  }
  for (const r of gaRows(evTotalsR)) {
    const ev = gaDim(r.dimensionValues, 0);
    const t = gaDim(r.dimensionValues, 1) === 'date_range_1' ? prev : totals;
    const n = gaNum(r.metricValues, 0);
    if (ev === WEBSTATS_EVENTS.qqc) t.qqc = n;
    else if (ev === WEBSTATS_EVENTS.phone) t.phone = n;
  }

  const pages = gaRows(pagesR).map((r) => ({ path: gaDim(r.dimensionValues, 0).slice(0, 120), views: gaNum(r.metricValues, 0), users: gaNum(r.metricValues, 1), qqc: 0, phone: 0 }));
  const pageIdx = {};
  pages.forEach((p) => { pageIdx[p.path] = p; });
  for (const r of gaRows(pageEvR)) {
    const path = gaDim(r.dimensionValues, 0).slice(0, 120), ev = gaDim(r.dimensionValues, 1), n = gaNum(r.metricValues, 0);
    let p = pageIdx[path];
    if (!p) { p = { path, views: 0, users: 0, qqc: 0, phone: 0 }; pageIdx[path] = p; pages.push(p); }
    if (ev === WEBSTATS_EVENTS.qqc) p.qqc += n;
    else if (ev === WEBSTATS_EVENTS.phone) p.phone += n;
  }

  const channels = {}, sources = {};
  for (const r of gaRows(srcR)) {
    const ch = gaDim(r.dimensionValues, 0) || '(other)';
    const src = gaDim(r.dimensionValues, 1) || '(direct)';
    const n = gaNum(r.metricValues, 0);
    channels[ch] = (channels[ch] || 0) + n;
    sources[src] = (sources[src] || 0) + n;
  }
  const topList = (mObj, cap) => Object.keys(mObj).sort((x, y) => mObj[y] - mObj[x]).slice(0, cap).map((k) => ({ k, n: mObj[k] }));

  const cities = gaRows(citiesR)
    .map((r) => ({ k: gaDim(r.dimensionValues, 0), n: gaNum(r.metricValues, 0) }))
    .filter((c) => c.k && c.k !== '(not set)');
  const devices = gaRows(devicesR).map((r) => ({ k: gaDim(r.dimensionValues, 0), n: gaNum(r.metricValues, 0) }));
  const hours = new Array(24).fill(0);
  for (const r of gaRows(hoursR)) {
    const h = parseInt(gaDim(r.dimensionValues, 0), 10);
    if (h >= 0 && h < 24) hours[h] = gaNum(r.metricValues, 0);
  }

  return { series, totals, prev, pages: pages.slice(0, 12), channels: topList(channels, 8), sources: topList(sources, 10), cities, devices, hours };
}

async function gaRealtime(sec) {
  let creds;
  try { creds = JSON.parse(sec.gaJson); } catch { return null; }
  const token = await gaAccessToken(creds);
  const res = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + sec.propertyId + ':runRealtimeReport', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] }),
  });
  if (!res.ok) throw new Error('GA realtime ' + res.status);
  const data = await res.json();
  const row = (data.rows || [])[0];
  return { active: row ? Math.round(gaNum(row.metricValues, 0)) : 0 };
}

// --- Microsoft Clarity data-export API ---
function clarityNum(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
function clarityPctCount(info) { return { pct: clarityNum(info.sessionsWithMetricPercentage), count: clarityNum(info.subTotal) }; }
function clarityParseOverall(arr) {
  const out = {};
  for (const mtr of (Array.isArray(arr) ? arr : [])) {
    const name = mtr.metricName || '';
    const info = (mtr.information || [])[0] || {};
    if (name === 'Traffic') {
      out.sessions = clarityNum(info.totalSessionCount);
      out.bots = clarityNum(info.totalBotSessionCount);
      out.users = clarityNum(info.distinctUserCount);
      out.pagesPerSession = clarityNum(info.pagesPerSessionPercentage);
    } else if (name === 'EngagementTime') { out.totalSecs = clarityNum(info.totalTime); out.activeSecs = clarityNum(info.activeTime); }
    else if (name === 'ScrollDepth') out.scrollDepth = clarityNum(info.averageScrollDepth);
    else if (name === 'DeadClickCount') out.dead = clarityPctCount(info);
    else if (name === 'RageClickCount') out.rage = clarityPctCount(info);
    else if (name === 'QuickbackClick') out.quickback = clarityPctCount(info);
    else if (name === 'ExcessiveScroll') out.excessiveScroll = clarityPctCount(info);
    else if (name === 'ScriptErrorCount') out.scriptErrors = clarityNum(info.subTotal);
    else if (name === 'ErrorClickCount') out.errorClicks = clarityNum(info.subTotal);
  }
  return out;
}
function clarityParsePages(arr) {
  if (!Array.isArray(arr)) return [];
  const rowsFor = (name) => { const mtr = arr.find((x) => x.metricName === name); return (mtr && mtr.information) || []; };
  const urlOf = (r) => String(r.URL || r.Url || r.url || '').slice(0, 200);
  const map = {};
  for (const r of rowsFor('Traffic')) {
    const u = urlOf(r);
    if (!u) continue;
    map[u] = { url: u, sessions: clarityNum(r.totalSessionCount), deadPct: 0, ragePct: 0 };
  }
  for (const r of rowsFor('DeadClickCount')) { const u = urlOf(r); if (map[u]) map[u].deadPct = clarityNum(r.sessionsWithMetricPercentage); }
  for (const r of rowsFor('RageClickCount')) { const u = urlOf(r); if (map[u]) map[u].ragePct = clarityNum(r.sessionsWithMetricPercentage); }
  return Object.values(map).filter((p) => p.sessions > 0).sort((x, y) => y.sessions - x.sessions).slice(0, 8);
}
async function clarityFetch(token, force) {
  const cacheKey = 'webstats:clarity';
  const cached = await kv().get(cacheKey, { type: 'json' });
  const fresh = cached && Date.now() - cached.fetchedAt < 6 * 3600 * 1000;
  if (cached && fresh && !force) return Object.assign({}, cached, { stale: false });
  const day = utcDayStr(Date.now());
  const budgetKey = 'webstats:clarity:calls:' + day;
  const used = parseInt((await kv().get(budgetKey)) || '0', 10);
  if (used >= CLARITY_DAILY_BUDGET) {
    // Out of API budget for today — stale data beats no data.
    return cached ? Object.assign({}, cached, { stale: true, callsToday: used }) : null;
  }
  // Count the calls BEFORE making them so a failure can't retry us into the limit.
  await kv().put(budgetKey, String(used + 2), { expirationTtl: 90000 });
  const call = async (params) => {
    const res = await fetch('https://www.clarity.ms/export-data/api/v1/project-live-insights?' + params, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('Clarity ' + res.status + ': ' + (await res.text()).slice(0, 160));
    return res.json();
  };
  const overallRaw = await call('numOfDays=3');
  let byUrlRaw = null;
  try { byUrlRaw = await call('numOfDays=3&dimension1=URL'); } catch (e) { /* per-page detail is optional */ }
  const doc = { fetchedAt: Date.now(), days: 3, overall: clarityParseOverall(overallRaw), pages: clarityParsePages(byUrlRaw) };
  await kv().put(cacheKey, JSON.stringify(doc), { expirationTtl: 26 * 3600 });
  return Object.assign({}, doc, { stale: false, callsToday: used + 2 });
}

// --- The merged endpoint the Website tab polls ---
async function apiWebstats(url) {
  const rangeKey = WEBSTATS_RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '7d';
  const force = url.searchParams.get('force') === '1';
  const sec = await webstatsSecrets();
  const out = {
    ok: true, range: rangeKey, generatedAt: Date.now(),
    connected: { ga: !!sec.gaJson, clarity: !!sec.clarityToken },
    ga: null, realtime: null, clarity: null, pixel: null, errors: {},
  };
  const jobs = [pixelRollup(14).then((d) => { out.pixel = d; }).catch(() => {})];
  if (sec.gaJson) {
    jobs.push(gaBundle(sec, rangeKey, force).then((d) => { out.ga = d; }).catch((e) => { out.errors.ga = String(e.message || e).slice(0, 200); }));
    jobs.push(gaRealtime(sec).then((d) => { out.realtime = d; }).catch(() => {}));
  }
  if (sec.clarityToken) {
    jobs.push(clarityFetch(sec.clarityToken, force).then((d) => { out.clarity = d; }).catch((e) => { out.errors.clarity = String(e.message || e).slice(0, 200); }));
  }
  await Promise.all(jobs);
  return json(out);
}

async function apiWebstatsStatus() {
  const sec = await webstatsSecrets();
  let gaEmail = '';
  if (sec.gaJson) { try { gaEmail = JSON.parse(sec.gaJson).client_email || ''; } catch (e) {} }
  const used = parseInt((await kv().get('webstats:clarity:calls:' + utcDayStr(Date.now()))) || '0', 10);
  return json({
    ok: true,
    ga: { connected: !!sec.gaJson, via: sec.gaVia, email: gaEmail, propertyId: sec.propertyId },
    clarity: { connected: !!sec.clarityToken, via: sec.clarityVia, callsToday: used, budget: CLARITY_DAILY_BUDGET },
  });
}

async function apiWebstatsConnect(request) {
  const data = await readJson(request);
  const saved = (await kv().get('webstats:secrets', { type: 'json' })) || {};
  const out = { ok: true };

  if (typeof data.ga === 'string' && data.ga.trim()) {
    let creds;
    try { creds = JSON.parse(data.ga); } catch {
      return json({ ok: false, error: 'ga_bad_json', hint: 'That does not look like the service-account file. Paste the WHOLE .json file, starting with {' }, 422);
    }
    if (!creds.client_email || !creds.private_key) {
      return json({ ok: false, error: 'ga_missing_fields', hint: 'The JSON needs client_email and private_key — use the key file downloaded from Google Cloud.' }, 422);
    }
    const pid = String(data.propertyId || saved.propertyId || ENV.GA4_PROPERTY_ID || GA4_DEFAULT_PROPERTY).replace(/\D/g, '') || GA4_DEFAULT_PROPERTY;
    try {
      const token = await gaAccessToken(creds);
      const res = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + pid + ':runReport', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateRanges: [{ startDate: 'yesterday', endDate: 'today' }], metrics: [{ name: 'sessions' }] }),
      });
      if (!res.ok) {
        return json({ ok: false, error: 'ga_verify_failed', hint: 'Google said ' + res.status + '. Make sure ' + creds.client_email + ' is added as a Viewer on GA property ' + pid + ' (Admin → Property access management).' }, 422);
      }
    } catch (e) {
      return json({ ok: false, error: 'ga_auth_failed', hint: String(e.message || e).slice(0, 200) }, 422);
    }
    saved.gaJson = data.ga.trim();
    saved.propertyId = pid;
    out.ga = { connected: true, email: creds.client_email, propertyId: pid };
  } else if (data.propertyId && saved.gaJson) {
    saved.propertyId = String(data.propertyId).replace(/\D/g, '') || saved.propertyId;
  }

  if (typeof data.clarity === 'string' && data.clarity.trim()) {
    const tok = data.clarity.trim();
    const budgetKey = 'webstats:clarity:calls:' + utcDayStr(Date.now());
    const used = parseInt((await kv().get(budgetKey)) || '0', 10);
    if (used >= CLARITY_DAILY_BUDGET) {
      saved.clarityToken = tok;
      out.clarity = { connected: true, verified: false, note: 'Saved — today\'s Clarity API budget is used up, so it will verify on tomorrow\'s first load.' };
    } else {
      await kv().put(budgetKey, String(used + 1), { expirationTtl: 90000 });
      const res = await fetch('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1', {
        headers: { Authorization: 'Bearer ' + tok },
      });
      if (!res.ok) {
        return json({ ok: false, error: 'clarity_verify_failed', hint: 'Clarity said ' + res.status + '. Generate a fresh token: Clarity → your project → Settings → Data Export → Generate new API token.' }, 422);
      }
      saved.clarityToken = tok;
      out.clarity = { connected: true, verified: true };
    }
  }

  await kv().put('webstats:secrets', JSON.stringify(saved));
  return json(out);
}

async function apiWebstatsDisconnect(request) {
  const data = await readJson(request);
  const saved = (await kv().get('webstats:secrets', { type: 'json' })) || {};
  if (data.source === 'ga') { delete saved.gaJson; }
  else if (data.source === 'clarity') { delete saved.clarityToken; }
  else return json({ ok: false, error: 'bad_source' }, 422);
  await kv().put('webstats:secrets', JSON.stringify(saved));
  return json({ ok: true });
}

// AI deep-read: compress the current stats into a text brief and let Gemini
// write the "what does this mean & what should I do" narrative.
async function apiWebstatsAi(request) {
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  const data = await readJson(request);
  const rangeKey = WEBSTATS_RANGES[data.range] ? data.range : '7d';
  const sec = await webstatsSecrets();
  if (!sec.gaJson) return json({ ok: false, error: 'ga_not_connected' }, 400);
  let ga;
  try { ga = await gaBundle(sec, rangeKey, false); } catch (e) {
    return json({ ok: false, error: 'ga_error', detail: String(e.message || e).slice(0, 180) }, 502);
  }
  let clar = null;
  if (sec.clarityToken) { try { clar = await clarityFetch(sec.clarityToken, false); } catch (e) {} }
  const L = [];
  const t = ga.totals, p = ga.prev;
  const label = { today: 'today', '7d': 'the last 7 days', '28d': 'the last 28 days', '90d': 'the last 90 days' }[rangeKey];
  L.push('Period: ' + label + ' (vs the period before it).');
  L.push('Sessions ' + t.sessions + ' (prev ' + p.sessions + '), visitors ' + t.users + ' (prev ' + p.users + '), page views ' + t.views + ' (prev ' + p.views + '), engaged sessions ' + t.engaged + ', avg session ' + t.avgDur + 's, new visitors ' + t.newUsers + '.');
  L.push('Phone-call clicks ' + t.phone + ' (prev ' + p.phone + '), quote-form submissions ' + t.qqc + ' (prev ' + p.qqc + ').');
  if (ga.channels.length) L.push('Traffic by channel: ' + ga.channels.map((c) => c.k + ' ' + c.n).join(', ') + '.');
  if (ga.sources.length) L.push('Top sources: ' + ga.sources.slice(0, 5).map((c) => c.k + ' ' + c.n).join(', ') + '.');
  if (ga.pages.length) L.push('Top pages (views | phone | quote): ' + ga.pages.slice(0, 6).map((pg) => pg.path + ' ' + pg.views + '|' + pg.phone + '|' + pg.qqc).join(', ') + '.');
  if (ga.cities.length) L.push('Top cities: ' + ga.cities.slice(0, 5).map((c) => c.k + ' ' + c.n).join(', ') + '.');
  if (ga.devices.length) L.push('Devices: ' + ga.devices.map((c) => c.k + ' ' + c.n).join(', ') + '.');
  if (clar && clar.overall) {
    const o = clar.overall;
    L.push('Clarity UX (last 3 days): ' + (o.sessions || 0) + ' sessions, avg scroll depth ' + (o.scrollDepth || 0).toFixed(0) + '%, dead clicks in ' + ((o.dead || {}).pct || 0).toFixed(1) + '% of sessions, rage clicks ' + ((o.rage || {}).pct || 0).toFixed(1) + '%, quick-backs ' + ((o.quickback || {}).pct || 0).toFixed(1) + '%, JS errors ' + (o.scriptErrors || 0) + '.');
  }
  if (data.extra) L.push('From the SMS dashboard: ' + String(data.extra).slice(0, 300));
  const prompt = 'You are the sharp, no-nonsense marketing analyst for Mikey\'s Mobile Detailing, a one-man mobile car detailing business in Snohomish County, WA. His website stats:\n\n' + L.join('\n') +
    '\n\nWrite for a busy owner reading on his phone:\n1. THREE short bullets — the most important things happening, in plain English, each citing its number.\n2. One line starting "DO THIS WEEK:" — the single highest-impact action.\nNo jargon, no fluff, no headings other than the bullets and that final line.';
  try {
    const text = await geminiGenerate(prompt, { surface: 'website stats', temperature: 0.5, maxTokens: 700 });
    return json({ ok: true, text });
  } catch (e) {
    return json({ ok: false, error: 'ai_error', detail: String(e.message || e).slice(0, 200) }, 502);
  }
}

// ===========================================================================
// Map rank grid — "where do I actually show up on Google Maps?"
// ---------------------------------------------------------------------------
// The Local Falcon idea, built in-house: lay an N x N grid of points over the
// service area, ask Google "detailing near me" AS IF standing at each point,
// and record what position Mikey's business came back at. Colour the grid by
// that rank and you can see, block by block, where the Maps listing is strong
// and where it falls off.
//
// The rank comes from the Google Places API (New) "Text Search" endpoint with a
// locationBias circle at each grid point. Two honest caveats, surfaced in the UI
// too:
//   - Places API results are a very close PROXY for the Maps local pack, not a
//     byte-identical copy of it. (Local Falcon has the same caveat.)
//   - Every grid point is one billable Places call. A 13x13 grid is 169 calls.
//     Google gives a monthly free allowance per SKU; past that it is priced per
//     1,000 calls. Check current pricing before running big grids often.
//
// Cloudflare's free plan caps a single request at 50 subrequests, so a scan is
// CHUNKED: the dashboard posts one batch of grid points at a time (<= 25) and
// stitches the results together client-side, showing a progress bar. That keeps
// any single Worker invocation well under the cap no matter how big the grid.
//
// The API key is pasted once in the dashboard (Analytics -> Map -> setup) and
// stored in KV, or supplied as a PLACES_API_KEY Worker secret, which wins. It is
// never echoed back by any endpoint.
// ===========================================================================
const GEO_SCAN_MAX_POINTS = 25;   // per request — keeps us under the 50-subrequest cap
const GEO_SCAN_KEEP = 24;         // how many past scans to retain
const GEO_NOT_FOUND_RANK = 21;    // "20+" — outside the 20 results Places returns

// ---------------------------------------------------------------------------
// What a Places call costs, and how we stay at $0.
//
// Google prices Text Search by the MOST EXPENSIVE field you ask for, so the
// field mask — not the endpoint — picks the SKU and the bill:
//
//   places.id (+ name/attributions) .... "Text Search Essentials (IDs only)"
//                                        the free tier; no names come back
//   + places.displayName / address ..... "Text Search Pro" — $32 per 1,000
//                                        calls past the monthly free allowance
//
// So a scan is FREE when the Place ID is pinned: we only need to spot which
// result is his, and the ID alone answers that. Matching on the NAME is what
// forces the paid SKU, because names are a paid field.
//
// Defaults below are the published rates at the time of writing; both are
// editable in the dashboard so a Google price change doesn't need a deploy.
// Prices last checked: 2026-07-28.
const GEO_PRO_PER_1000 = 32;      // USD per 1,000 Text Search Pro calls
const GEO_PRO_FREE = 5000;        // free Pro calls per month (Pro-tier SKU)
const GEO_IDS_FREE = 10000;       // free Essentials/IDs-only calls per month

async function geogridSecrets() {
  const saved = (await kv().get('geogrid:secrets', { type: 'json' })) || {};
  return {
    key: String(ENV.PLACES_API_KEY || saved.key || ''),
    via: ENV.PLACES_API_KEY ? 'secret' : (saved.key ? 'saved' : ''),
    placeId: String(saved.placeId || ''),
    bizName: String(saved.bizName || ''),
    keyword: String(saved.keyword || 'mobile detailing'),
    centerLat: Number(saved.centerLat) || 47.9129,   // Snohomish, WA
    centerLng: Number(saved.centerLng) || -122.0982,
    // Spend guard. freeOnly ON is the default and the safe state: the Worker
    // refuses any call that would land past the free allowance, so the answer
    // to "am I being charged?" is no, by construction.
    freeOnly: saved.freeOnly !== false,
    idOnly: saved.idOnly !== false,
    pricePro: Number(saved.pricePro) >= 0 ? Number(saved.pricePro) : GEO_PRO_PER_1000,
    freePro: Number(saved.freePro) >= 0 ? Number(saved.freePro) : GEO_PRO_FREE,
    freeIds: Number(saved.freeIds) >= 0 ? Number(saved.freeIds) : GEO_IDS_FREE,
  };
}

// Which SKU a call bills at. ID-only is possible only with a pinned Place ID —
// without one we need names to recognise the listing, and names cost money.
function geoSku(sec) { return sec.idOnly && sec.placeId ? 'ids' : 'pro'; }
function geoFieldMask(sku) {
  return sku === 'ids' ? 'places.id' : 'places.id,places.displayName';
}
// Google's quotas reset at midnight Pacific, so the meter counts Pacific months
// — that way "used this month" lines up with the allowance it's measured against.
function geoMonthKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
}
async function geoMeter() {
  const m = (await kv().get('geogrid:meter', { type: 'json' })) || {};
  const month = geoMonthKey();
  return m.month === month ? { month, pro: m.pro || 0, ids: m.ids || 0 }
    : { month, pro: 0, ids: 0 };
}
async function geoMeterAdd(sku, n) {
  if (!n) return geoMeter();
  const m = await geoMeter();
  m[sku] = (m[sku] || 0) + n;
  await kv().put('geogrid:meter', JSON.stringify(m));
  return m;
}
// What N more calls on this SKU would do: how many land past the free
// allowance, what they'd cost, and whether the guard should stop them.
async function geoBudget(sec, sku, n) {
  const m = await geoMeter();
  const used = m[sku] || 0;
  const free = sku === 'ids' ? sec.freeIds : sec.freePro;
  const per1000 = sku === 'ids' ? 0 : sec.pricePro;
  const paidCalls = Math.max(0, used + n - free);
  const cost = +(paidCalls * per1000 / 1000).toFixed(2);
  return {
    month: m.month, sku, used, free, per1000, willUse: n,
    left: Math.max(0, free - used), paidCalls, cost,
    blocked: sec.freeOnly && paidCalls > 0,
  };
}
function geoBudgetError(b) {
  return json({
    ok: false, error: 'budget', budget: b,
    hint: 'Stopped before Google could charge you. This would put ' + b.paidCalls +
      ' call' + (b.paidCalls === 1 ? '' : 's') + ' past your ' + b.free.toLocaleString() +
      ' free ' + (b.sku === 'ids' ? 'ID-only' : 'Pro') + ' calls this month (' + b.used.toLocaleString() +
      ' used) — about $' + b.cost.toFixed(2) + '. Wait for the 1st, run a smaller grid, or turn off ' +
      '"Never spend real money" in setup if you want to pay for it.',
  }, 402);
}

// Normalised name compare — Places display names carry punctuation/suffixes that
// never match a hand-typed business name exactly.
function geoNameKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// Words that say nothing about WHICH business this is. They're stripped before
// comparing so "Mikey's Detailing Snohomish" still matches the listing Google
// actually shows ("Mikey's Mobile Detailing") — the old plain-substring compare
// failed on exactly that, and a failed compare looks identical to ranking
// nowhere: a full grid of 20+.
const GEO_GENERIC_WORDS = ['mobile', 'detailing', 'detail', 'details', 'auto', 'autos', 'car', 'cars',
  'wash', 'washing', 'ceramic', 'coating', 'llc', 'inc', 'co', 'company', 'the', 'and', 'of',
  'service', 'services', 'shop', 'pro', 'pros'];
function geoTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function geoDistinctTokens(s) {
  return geoTokens(s).filter((t) => t.length > 2 && GEO_GENERIC_WORDS.indexOf(t) < 0);
}
function geoNameMatches(displayName, want) {
  const a = geoNameKey(displayName), b = geoNameKey(want);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // Neither contains the other — fall back to the distinctive words. Every
  // distinctive word of the SHORTER side has to appear on the other side, so a
  // one-word overlap only counts when that side has just the one distinctive
  // word ("Mikey's Mobile Detailing" -> mikeys). That keeps "Mikey's Pizza" out
  // while still catching the ordinary suffix/city drift.
  const da = geoDistinctTokens(displayName), db = geoDistinctTokens(want);
  if (!da.length || !db.length) return false;
  const shorter = da.length <= db.length ? da : db;
  const longer = da.length <= db.length ? db : da;
  return shorter.every((t) => longer.indexOf(t) >= 0);
}

// The top few names Google returned at a point, kept tiny — it's what turns
// "20+ everywhere" from a mystery into something the owner can act on.
function geoTopNames(places, n) {
  return places.slice(0, n).map((p) => ({
    id: p.id || '', name: (p.displayName && p.displayName.text) || '',
  }));
}

// One grid point -> the business's rank in the Places result list (1-based),
// or GEO_NOT_FOUND_RANK when it does not appear at all.
async function geoRankAt(sec, keyword, lat, lng, radiusM, sku) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': sec.key,
      'X-Goog-FieldMask': geoFieldMask(sku || geoSku(sec)),
    },
    body: JSON.stringify({
      textQuery: keyword,
      maxResultCount: 20,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.max(500, Math.min(50000, radiusM)) } },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('places_' + res.status + (body ? ': ' + body.slice(0, 600) : ''));
    err.status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  const places = Array.isArray(data.places) ? data.places : [];
  for (let i = 0; i < places.length; i++) {
    const p = places[i] || {};
    const nm = (p.displayName && p.displayName.text) || '';
    // Place ID is the exact match and wins; the name is the fallback whenever we
    // paid for names. Matching on a bad ID alone silently produces a grid of
    // "20+" at every point — indistinguishable from a genuine ranking collapse —
    // so the name keeps a mistyped ID a degraded match instead of a confident
    // lie. On the free ID-only SKU there are no names to fall back to, which is
    // the trade for $0: the diagnostic panel says so, and the preview call
    // (one Pro call) is the way out.
    if (sec.placeId && p.id === sec.placeId) return { rank: i + 1, total: places.length, by: 'id', name: nm };
    if (geoNameMatches(nm, sec.bizName)) return { rank: i + 1, total: places.length, by: 'name', name: nm };
  }
  // Not found: hand back what Google DID return so the caller can show it.
  return { rank: GEO_NOT_FOUND_RANK, total: places.length, top: geoTopNames(places, 5) };
}

// GET /api/geogrid — connection status + saved scans (newest first).
async function apiGeogrid() {
  const sec = await geogridSecrets();
  const scans = (await kv().get('geogrid:scans', { type: 'json' })) || [];
  return json({
    ok: true,
    connected: !!sec.key,
    via: sec.via,
    config: {
      placeId: sec.placeId, bizName: sec.bizName, keyword: sec.keyword,
      centerLat: sec.centerLat, centerLng: sec.centerLng,
      freeOnly: sec.freeOnly, idOnly: sec.idOnly,
      pricePro: sec.pricePro, freePro: sec.freePro, freeIds: sec.freeIds,
    },
    maxBatch: GEO_SCAN_MAX_POINTS,
    // Everything the dashboard needs to answer "what will this cost me?" before
    // a single call is made.
    meter: await geoMeter(),
    sku: geoSku(sec),
    scans,
  });
}

// POST /api/geogrid/scan — rank one BATCH of grid points. The dashboard calls
// this repeatedly until the grid is covered. Nothing is written to KV here, so
// a scan costs zero KV writes until it is saved.
async function apiGeogridScan(request) {
  const sec = await geogridSecrets();
  if (!sec.key) return json({ ok: false, error: 'not_connected', hint: 'Add a Google Places API key first (Analytics → Map → setup).' }, 400);
  if (!sec.placeId && !sec.bizName) return json({ ok: false, error: 'no_business', hint: 'Set the business name or Place ID to look for.' }, 400);

  const data = await readJson(request);
  const keyword = String(data.keyword || sec.keyword || '').trim().slice(0, 120);
  if (!keyword) return json({ ok: false, error: 'no_keyword' }, 422);
  const pts = Array.isArray(data.points) ? data.points.slice(0, GEO_SCAN_MAX_POINTS) : [];
  if (!pts.length) return json({ ok: false, error: 'no_points' }, 422);
  const radiusM = Math.max(500, Math.min(50000, Number(data.radiusM) || 3000));

  // Check the budget BEFORE spending anything. Every point is one billable call,
  // so a batch that would cross the free line is refused whole.
  const sku = geoSku(sec);
  const budget = await geoBudget(sec, sku, pts.length);
  if (budget.blocked) return geoBudgetError(budget);

  const out = [];
  let calls = 0;          // what we actually spent, metered even if we bail early
  let matchedName = '';   // what we matched as, the first time we matched
  let sample = null;      // what Google returned at a point where we did NOT match
  for (const p of pts) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng)) { out.push({ lat: 0, lng: 0, rank: GEO_NOT_FOUND_RANK, err: 'bad_point' }); continue; }
    try {
      calls++;
      const r = await geoRankAt(sec, keyword, lat, lng, radiusM, sku);
      out.push({ lat, lng, rank: r.rank, total: r.total });
      if (r.rank < GEO_NOT_FOUND_RANK && !matchedName) matchedName = r.name || '';
      if (r.rank >= GEO_NOT_FOUND_RANK && !sample && r.top) sample = { lat, lng, top: r.top };
    } catch (e) {
      // A 4xx from Google is fatal for the whole scan (bad key / API not enabled)
      // — bail out loudly instead of silently returning a grid of "20+".
      if (e.status && e.status >= 400 && e.status < 500) {
        await geoMeterAdd(sku, calls);
        return json({ ok: false, error: 'places_error', detail: String(e.message || e).slice(0, 700),
          hint: 'Check the key is valid, the Places API (New) is enabled on the project, and billing is on.' }, 502);
      }
      out.push({ lat, lng, rank: GEO_NOT_FOUND_RANK, err: 'fetch_failed' });
    }
  }
  const meter = await geoMeterAdd(sku, calls);
  return json({ ok: true, results: out, matchedName, sample, lookingFor: sec.bizName, placeId: sec.placeId,
    sku, meter, spent: sku === 'ids' ? 0 : budget.cost });
}

// The three headline numbers, computed the way the local-SEO tools define them.
function geoStats(results) {
  const rs = results.map((r) => Number(r.rank) || GEO_NOT_FOUND_RANK);
  const n = rs.length || 1;
  const found = rs.filter((r) => r < GEO_NOT_FOUND_RANK);
  return {
    points: rs.length,
    // ARP — average rank across the points where the listing actually ranked.
    arp: found.length ? +(found.reduce((a, b) => a + b, 0) / found.length).toFixed(2) : null,
    // ATRP — average across EVERY point, counting a miss as 20+.
    atrp: +(rs.reduce((a, b) => a + b, 0) / n).toFixed(2),
    // SoLV — share of local voice: % of points landing in the top 3.
    solv: +((rs.filter((r) => r <= 3).length / n) * 100).toFixed(2),
    top3: rs.filter((r) => r <= 3).length,
    top10: rs.filter((r) => r <= 10).length,
    missing: rs.filter((r) => r >= GEO_NOT_FOUND_RANK).length,
    // Points where Google returned NOTHING at all. A grid of 20+ means something
    // completely different depending on this number: results came back and the
    // listing wasn't among them (a ranking/matching story) vs no results at all
    // (a keyword or API story). Worth one integer to tell them apart.
    empty: results.filter((r) => Number(r.total) === 0).length,
  };
}

// POST /api/geogrid/save — persist a finished scan (one KV write).
async function apiGeogridSave(request) {
  const data = await readJson(request);
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return json({ ok: false, error: 'no_results' }, 422);
  const rec = {
    id: genId(),
    ts: Date.now(),
    keyword: String(data.keyword || '').slice(0, 120),
    size: Math.max(3, Math.min(15, Number(data.size) || 7)),
    radiusMi: +(Number(data.radiusMi) || 5).toFixed(2),
    centerLat: Number(data.centerLat) || 0,
    centerLng: Number(data.centerLng) || 0,
    results: results.map((r) => ({
      lat: +Number(r.lat).toFixed(5), lng: +Number(r.lng).toFixed(5),
      rank: Math.max(1, Math.min(GEO_NOT_FOUND_RANK, Number(r.rank) || GEO_NOT_FOUND_RANK)),
      total: Math.max(0, Math.min(20, Number(r.total) || 0)),
    })),
    // Which listing the ranks actually refer to — blank when nothing matched.
    matchedName: String(data.matchedName || '').slice(0, 120),
  };
  rec.stats = geoStats(rec.results);
  const scans = (await kv().get('geogrid:scans', { type: 'json' })) || [];
  scans.unshift(rec);
  await kv().put('geogrid:scans', JSON.stringify(scans.slice(0, GEO_SCAN_KEEP)));
  return json({ ok: true, scan: rec });
}

// POST /api/geogrid/delete — drop one saved scan.
async function apiGeogridDelete(request) {
  const data = await readJson(request);
  const id = String(data.id || '');
  const scans = (await kv().get('geogrid:scans', { type: 'json' })) || [];
  const next = scans.filter((s) => s.id !== id);
  if (next.length !== scans.length) await kv().put('geogrid:scans', JSON.stringify(next));
  return json({ ok: true });
}

// POST /api/geogrid/connect — save the key + what business to look for. The key
// is verified with one real Places call so a typo surfaces immediately.
async function apiGeogridConnect(request) {
  const data = await readJson(request);
  const saved = (await kv().get('geogrid:secrets', { type: 'json' })) || {};

  if (typeof data.key === 'string' && data.key.trim()) {
    const key = data.key.trim();
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: 'car detailing', maxResultCount: 1,
        locationBias: { circle: { center: { latitude: 47.9129, longitude: -122.0982 }, radius: 5000 } } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return json({ ok: false, error: 'key_verify_failed',
        hint: 'Google said ' + res.status + '. Enable "Places API (New)" on the project, turn on billing, and make sure the key has no HTTP-referrer restriction (this call comes from a server).',
        detail: body.slice(0, 600) }, 422);
    }
    saved.key = key;
    await geoMeterAdd('ids', 1);   // the verify call is IDs-only: free, but counted
  }

  if (typeof data.bizName === 'string') saved.bizName = data.bizName.trim().slice(0, 80);
  if (typeof data.placeId === 'string') {
    const pid = data.placeId.trim().slice(0, 120);
    // The commonest setup mistake by far: pasting the Maps CID (the long number
    // from a maps.google.com/?cid=... link) into the Place ID box. A real Place
    // ID is an opaque token like "ChIJ...". Reject the number outright rather
    // than storing something that can never match.
    if (pid && /^\d{6,}$/.test(pid)) {
      return json({ ok: false, error: 'cid_not_place_id',
        hint: 'That long number is a Maps CID, not a Place ID. A Place ID looks like "ChIJN1t_tDeuEmsRUsoyG83frY4". Use the "Find my Place ID" button below, or leave the field blank and match on the business name.' }, 422);
    }
    saved.placeId = pid;
  }
  if (typeof data.keyword === 'string' && data.keyword.trim()) saved.keyword = data.keyword.trim().slice(0, 120);
  // Spend guard. freeOnly is what actually stops a charge; idOnly is what keeps
  // scans on the free SKU in the first place. Prices are editable so a Google
  // change can be corrected from the phone rather than a deploy.
  if (typeof data.freeOnly === 'boolean') saved.freeOnly = data.freeOnly;
  if (typeof data.idOnly === 'boolean') saved.idOnly = data.idOnly;
  if (data.pricePro != null && isFinite(+data.pricePro) && +data.pricePro >= 0) saved.pricePro = +data.pricePro;
  if (data.freePro != null && isFinite(+data.freePro) && +data.freePro >= 0) saved.freePro = Math.round(+data.freePro);
  if (data.freeIds != null && isFinite(+data.freeIds) && +data.freeIds >= 0) saved.freeIds = Math.round(+data.freeIds);
  if (data.centerLat != null && isFinite(+data.centerLat)) saved.centerLat = +data.centerLat;
  if (data.centerLng != null && isFinite(+data.centerLng)) saved.centerLng = +data.centerLng;

  await kv().put('geogrid:secrets', JSON.stringify(saved));
  return json({ ok: true });
}

// POST /api/geogrid/find — look up candidate Place IDs for a business name so
// the owner never has to go hunting through Google's Place ID Finder. Costs
// exactly ONE Places call, and is the only place the dashboard shows a Place ID.
async function apiGeogridFind(request) {
  const sec = await geogridSecrets();
  if (!sec.key) return json({ ok: false, error: 'not_connected', hint: 'Save the API key first.' }, 400);
  const data = await readJson(request);
  const q = String(data.q || sec.bizName || '').trim().slice(0, 120);
  if (!q) return json({ ok: false, error: 'no_query', hint: 'Enter your business name first.' }, 422);
  const budget = await geoBudget(sec, 'pro', 1);
  if (budget.blocked) return geoBudgetError(budget);
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': sec.key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery: q, maxResultCount: 8,
      locationBias: { circle: { center: { latitude: sec.centerLat, longitude: sec.centerLng }, radius: 50000 } },
    }),
  });
  await geoMeterAdd('pro', 1);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return json({ ok: false, error: 'places_error', detail: body.slice(0, 600),
      hint: 'Google said ' + res.status + '. Check the key and that Places API (New) is enabled.' }, 502);
  }
  const d = await res.json().catch(() => ({}));
  return json({ ok: true, results: ((d.places) || []).map((p) => ({
    id: p.id, name: (p.displayName && p.displayName.text) || '', address: p.formattedAddress || '',
  })) });
}

// POST /api/geogrid/preview — the "why am I 20+ everywhere?" answer. Runs the
// EXACT same Places call one grid point makes, and returns the full result list
// with each row flagged as a match or not. If the listing is in that list but
// unflagged, the name we're matching on is wrong (a settings fix, one tap). If
// it isn't in the list at all, the ranking really is that bad for that keyword.
// Costs exactly ONE Places call.
async function apiGeogridPreview(request) {
  const sec = await geogridSecrets();
  if (!sec.key) return json({ ok: false, error: 'not_connected', hint: 'Add a Google Places API key first.' }, 400);
  const data = await readJson(request);
  const keyword = String(data.keyword || sec.keyword || '').trim().slice(0, 120);
  if (!keyword) return json({ ok: false, error: 'no_keyword' }, 422);
  const lat = isFinite(Number(data.lat)) ? Number(data.lat) : sec.centerLat;
  const lng = isFinite(Number(data.lng)) ? Number(data.lng) : sec.centerLng;
  const radiusM = Math.max(500, Math.min(50000, Number(data.radiusM) || 3000));

  // This one always bills at Pro — names and addresses are the whole point of it.
  const budget = await geoBudget(sec, 'pro', 1);
  if (budget.blocked) return geoBudgetError(budget);

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': sec.key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify({
      textQuery: keyword,
      maxResultCount: 20,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM } },
    }),
  });
  const meter = await geoMeterAdd('pro', 1);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return json({ ok: false, error: 'places_error', detail: body.slice(0, 700),
      hint: 'Google said ' + res.status + '. Check the key, Places API (New), and billing.' }, 502);
  }
  const d = await res.json().catch(() => ({}));
  const places = Array.isArray(d.places) ? d.places : [];
  return json({
    ok: true, keyword, lat, lng, meter,
    lookingFor: sec.bizName, placeId: sec.placeId,
    results: places.map((p, i) => {
      const name = (p.displayName && p.displayName.text) || '';
      return {
        rank: i + 1, id: p.id || '', name, address: p.formattedAddress || '',
        match: (!!sec.placeId && p.id === sec.placeId) || geoNameMatches(name, sec.bizName),
      };
    }),
  });
}

// POST /api/geogrid/disconnect — forget the key (keeps saved scans).
async function apiGeogridDisconnect() {
  const saved = (await kv().get('geogrid:secrets', { type: 'json' })) || {};
  delete saved.key;
  await kv().put('geogrid:secrets', JSON.stringify(saved));
  return json({ ok: true });
}

// ===========================================================================
// 🧠 Business intelligence — the five deep-analytics reports
// ---------------------------------------------------------------------------
// Everything here is derived from data the app already collects (the money
// ledger, the conversation index, the booking list). Nothing is invented and
// nothing needs a third-party service.
//
//   /api/intel/customers  Retention & lifetime value + first-touch attribution.
//   /api/intel/services   Service and vehicle profitability — the real $/hour.
//   /api/intel/forecast   Month-end projection, booked pipeline, capacity.
//   /api/intel/pulse      Daily KPI history + automatic anomaly detection.
//
// READ BUDGET: the ledger is one KV doc per month, so a report that looks back
// 24 months is ~24 reads plus the index. That is nothing against the free tier's
// 100k/day for a single-operator business, so these compute live and are always
// truthful rather than serving a stale cache. The one exception is the Pulse
// history, which has to be *recorded* daily (you cannot reconstruct "how many
// leads were open last Tuesday" after the fact) — that is a single KV write per
// day from the existing cron.
// ===========================================================================
const INTEL_MAX_MONTHS = 24;
const PULSE_KEY = 'intel:pulse';
const PULSE_KEEP_DAYS = 400;

// Load the ledger back `months` calendar months, newest month first. Returns a
// flat entry list with the month key attached to each row.
async function intelLedger(months = INTEL_MAX_MONTHS) {
  const list = await kv().list({ prefix: 'money:m:' });
  const keys = (list.keys || []).map((k) => k.name).sort().reverse().slice(0, months);
  const out = [];
  for (const key of keys) {
    const doc = await kv().get(key, { type: 'json' });
    const m = key.slice('money:m:'.length);
    for (const e of ((doc && doc.entries) || [])) out.push(Object.assign({ _m: m }, e));
  }
  return out;
}
function intelJobs(entries) { return entries.filter((e) => e.type === 'job'); }
const DAY_MS = 86400000;
function intelDays(a, b) { return Math.round((a - b) / DAY_MS); }
// Entry timestamp we trust: the logged date is what the owner actually means,
// `ts` is only the moment it was typed in (which can be days later).
function intelTs(e) {
  const d = String(e.date || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return Date.parse(d + 'T12:00:00Z');
  return e.ts || 0;
}
function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b), h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
function pct(a, b) { return b ? money2((a / b) * 100) : 0; }

// ---------------------------------------------------------------------------
// 1 + 2. Customers — retention, lifetime value, win-back radar, attribution.
// ---------------------------------------------------------------------------
async function apiIntelCustomers() {
  const now = Date.now();
  const entries = await intelLedger();
  const jobs = intelJobs(entries).filter((e) => e.phone); // anonymous jobs can't be attributed to a person
  const anon = intelJobs(entries).length - jobs.length;

  // --- group the ledger into customers -------------------------------------
  const byPhone = new Map();
  for (const e of jobs) {
    const c = byPhone.get(e.phone) || { phone: e.phone, name: '', n: 0, rev: 0, first: Infinity, last: 0, tss: [] };
    const ts = intelTs(e);
    c.n++; c.rev += e.amount; c.tss.push(ts);
    if (ts < c.first) c.first = ts;
    if (ts > c.last) c.last = ts;
    if (e.name && !c.name) c.name = e.name;
    byPhone.set(e.phone, c);
  }
  const custs = [...byPhone.values()].map((c) => {
    c.rev = money2(c.rev);
    c.avgTicket = money2(c.rev / c.n);
    // Personal cadence: the median gap between this customer's own visits.
    const s = c.tss.slice().sort((a, b) => a - b), gaps = [];
    for (let i = 1; i < s.length; i++) gaps.push(intelDays(s[i], s[i - 1]));
    c.gaps = gaps;
    c.cadence = gaps.length ? Math.round(median(gaps)) : 0;
    c.daysSince = intelDays(now, c.last);
    delete c.tss;
    return c;
  });

  const repeat = custs.filter((c) => c.n > 1);
  const allGaps = [].concat(...custs.map((c) => c.gaps));
  // Fleet-wide cadence, used for one-time customers who have no personal one yet.
  const typicalGap = allGaps.length ? Math.round(median(allGaps)) : 0;

  // --- win-back radar -------------------------------------------------------
  // "Overdue" = past their own cadence (or the fleet median) by a margin. Ranked
  // by lifetime value, because a $2k repeat customer going quiet matters more
  // than a one-off $80 wash.
  const winback = custs
    .map((c) => {
      const due = c.cadence || typicalGap;
      if (!due) return null;
      const over = c.daysSince - due;
      if (over < Math.max(14, due * 0.15)) return null;
      return { phone: c.phone, name: c.name, rev: c.rev, n: c.n, avgTicket: c.avgTicket,
        daysSince: c.daysSince, due, over, lapsed: c.daysSince > due * 2.5 };
    })
    .filter(Boolean)
    .sort((a, b) => (b.rev / Math.max(1, b.daysSince)) - (a.rev / Math.max(1, a.daysSince)))
    .slice(0, 25);

  // --- cohorts: group customers by the month of their FIRST job -------------
  // Classic retention grid. cell[k] = how many of that cohort came back in
  // month k after acquisition, so you can see whether newer customers stick
  // around better or worse than older ones.
  const cohorts = new Map();
  for (const c of custs) {
    if (!isFinite(c.first)) continue;
    const key = new Date(c.first).toISOString().slice(0, 7);
    const row = cohorts.get(key) || { m: key, size: 0, rev: 0, cells: {} };
    row.size++; row.rev += c.rev;
    cohorts.set(key, row);
  }
  for (const e of jobs) {
    const c = byPhone.get(e.phone);
    if (!c || !isFinite(c.first)) continue;
    const key = new Date(c.first).toISOString().slice(0, 7);
    const row = cohorts.get(key);
    if (!row) continue;
    const off = Math.max(0, Math.round(intelDays(intelTs(e), c.first) / 30));
    (row.cells[off] = row.cells[off] || { seen: new Set(), rev: 0 });
    row.cells[off].seen.add(e.phone);
    row.cells[off].rev += e.amount;
  }
  const cohortRows = [...cohorts.values()]
    .sort((a, b) => (a.m < b.m ? 1 : -1))
    .slice(0, 12)
    .map((r) => ({
      m: r.m, size: r.size, rev: money2(r.rev), ltv: money2(r.rev / r.size),
      cells: Object.keys(r.cells).map(Number).sort((a, b) => a - b).slice(0, 13)
        .map((k) => ({ k, n: r.cells[k].seen.size, pct: pct(r.cells[k].seen.size, r.size), rev: money2(r.cells[k].rev) })),
    }));

  // --- attribution: first-touch channel → leads → won → actual revenue ------
  const index = await loadIndex();
  const SOURCES = ['quote', 'booking', 'call', 'text'];
  const srcOf = (row) => {
    const s = row.source || '';
    if (SOURCES.includes(s)) return s;
    if ((row.tags || []).includes('booking')) return 'booking'; // pre-`source` rows
    return 'unknown';
  };
  const bySource = {};
  const bucket = (k) => (bySource[k] = bySource[k] || { src: k, leads: 0, won: 0, lost: 0, customers: 0, jobs: 0, rev: 0 });
  const revByPhone = new Map(custs.map((c) => [c.phone, c]));
  for (const row of index) {
    const k = srcOf(row);
    const b = bucket(k);
    b.leads++;
    if (row.status === 'won') b.won++;
    if (row.status === 'lost') b.lost++;
    const c = revByPhone.get(row.phone);
    if (c) { b.customers++; b.jobs += c.n; b.rev += c.rev; }
  }
  // Marketing spend is logged as a single expense category, not per channel, so
  // cost per acquisition is reported BLENDED. Splitting it across channels would
  // be a number we made up.
  const spendWindowStart = now - 365 * DAY_MS;
  const marketing = entries.filter((e) => e.type === 'exp' && e.cat === 'marketing' && intelTs(e) >= spendWindowStart);
  const marketingSpend = money2(marketing.reduce((a, e) => a + e.amount, 0));
  const newCustomers12mo = custs.filter((c) => c.first >= spendWindowStart).length;
  const sources = Object.values(bySource).map((b) => ({
    src: b.src, leads: b.leads, won: b.won, lost: b.lost, customers: b.customers,
    jobs: b.jobs, rev: money2(b.rev),
    winRate: pct(b.won, b.leads),
    revPerLead: b.leads ? money2(b.rev / b.leads) : 0,
  })).sort((a, b) => b.rev - a.rev);

  const totalRev = money2(custs.reduce((a, c) => a + c.rev, 0));
  return json({
    ok: true,
    totals: {
      customers: custs.length,
      repeatCustomers: repeat.length,
      repeatRate: pct(repeat.length, custs.length),
      revenue: totalRev,
      ltv: custs.length ? money2(totalRev / custs.length) : 0,
      repeatLtv: repeat.length ? money2(repeat.reduce((a, c) => a + c.rev, 0) / repeat.length) : 0,
      oneTimeLtv: (custs.length - repeat.length) ? money2(custs.filter((c) => c.n === 1).reduce((a, c) => a + c.rev, 0) / (custs.length - repeat.length)) : 0,
      avgTicket: custs.length ? money2(totalRev / jobs.length) : 0,
      typicalGap, anonJobs: anon,
      // Share of revenue from the top 20% of customers — concentration risk.
      top20Share: (() => {
        const s = custs.map((c) => c.rev).sort((a, b) => b - a);
        const cut = Math.max(1, Math.ceil(s.length * 0.2));
        return pct(s.slice(0, cut).reduce((a, b) => a + b, 0), totalRev);
      })(),
    },
    top: custs.slice().sort((a, b) => b.rev - a.rev).slice(0, 15)
      .map((c) => ({ phone: c.phone, name: c.name, n: c.n, rev: c.rev, avgTicket: c.avgTicket, daysSince: c.daysSince, cadence: c.cadence })),
    winback, cohorts: cohortRows,
    attribution: { sources, marketingSpend, newCustomers12mo,
      cpa: newCustomers12mo ? money2(marketingSpend / newCustomers12mo) : 0 },
  });
}

// ---------------------------------------------------------------------------
// 3. Services — what each service and vehicle size is really worth per hour.
// ---------------------------------------------------------------------------
async function apiIntelServices() {
  const entries = await intelLedger();
  const jobs = intelJobs(entries);

  const group = (rows, keyFn) => {
    const m = new Map();
    for (const e of rows) {
      const k = keyFn(e); if (!k) continue;
      const g = m.get(k) || { k, n: 0, rev: 0, hours: 0, hoursN: 0, revTimed: 0, mat: 0, jp: 0, tickets: [] };
      g.n++; g.rev += e.amount; g.tickets.push(e.amount);
      if (e.hours > 0) { g.hours += e.hours; g.hoursN++; g.revTimed += e.amount; }
      if (e.mat > 0) g.mat += e.mat;
      if (e.jp > 0) g.jp += e.jp;
      m.set(k, g);
    }
    return [...m.values()].map((g) => {
      const cost = g.mat + g.jp;
      // Effective hourly rate pairs the revenue of the timed jobs with the hours
      // of those same jobs. Dividing TOTAL revenue by the hours of the subset
      // that happens to be timed would inflate it every time a job is logged
      // without hours.
      return {
        k: g.k, n: g.n, rev: money2(g.rev), avg: money2(g.rev / g.n),
        median: money2(median(g.tickets)),
        hours: money2(g.hours), hoursN: g.hoursN,
        perHour: g.hours > 0 ? money2(g.revTimed / g.hours) : null,
        mat: money2(g.mat), jp: money2(g.jp),
        margin: g.rev > 0 ? pct(g.rev - cost, g.rev) : null,
        profit: money2(g.rev - cost),
      };
    }).sort((a, b) => b.rev - a.rev);
  };

  const services = group(jobs, (e) => e.service || '');
  const vehicles = group(jobs, (e) => e.veh || '');

  // --- price realization: what the booking quoted vs what was actually paid --
  // Matched on phone + a ±10-day window, because the job is logged on the day it
  // was done and the booking was made earlier.
  const bookings = await loadBookings();
  const pairs = [];
  for (const b of bookings) {
    if (!b.phone || !b.estimate) continue;
    const bt = b.apptAt || Date.parse((b.date || '') + 'T12:00:00Z') || b.createdAt || 0;
    if (!bt) continue;
    let best = null, bestGap = Infinity;
    for (const e of jobs) {
      if (e.phone !== b.phone) continue;
      const gap = Math.abs(intelTs(e) - bt);
      if (gap < bestGap && gap <= 10 * DAY_MS) { best = e; bestGap = gap; }
    }
    if (best) pairs.push({ name: b.name || '', service: b.serviceName || b.service || '',
      quoted: money2(b.estimate), paid: money2(best.amount),
      delta: money2(best.amount - b.estimate), date: best.date });
  }
  const realization = pairs.length ? {
    n: pairs.length,
    quoted: money2(pairs.reduce((a, p) => a + p.quoted, 0)),
    paid: money2(pairs.reduce((a, p) => a + p.paid, 0)),
    avgDelta: money2(pairs.reduce((a, p) => a + p.delta, 0) / pairs.length),
    under: pairs.filter((p) => p.delta < -1).length,
    over: pairs.filter((p) => p.delta > 1).length,
    exact: pairs.filter((p) => Math.abs(p.delta) <= 1).length,
    worst: pairs.slice().sort((a, b) => a.delta - b.delta).slice(0, 6),
  } : null;

  const timed = jobs.filter((e) => e.hours > 0);
  const revenue = money2(jobs.reduce((a, e) => a + e.amount, 0));

  // Per-service margin above only subtracts what is booked AGAINST that job
  // (materials + helper pay), so it lands in the 90s and would flatter every
  // service equally. Overhead — fuel, supplies, insurance, phone, marketing —
  // is a real cost of doing the work but isn't attached to any one job, so it is
  // spread evenly across jobs here and reported separately. That gives an honest
  // "what a job is actually worth after running the business" number without
  // pretending we know which job burned which gallon of fuel.
  const overhead = money2(entries.filter((e) => e.type === 'exp').reduce((a, e) => a + e.amount, 0));
  const overheadPerJob = jobs.length ? money2(overhead / jobs.length) : 0;
  const directCost = money2(jobs.reduce((a, e) => a + (e.mat || 0) + (e.jp || 0), 0));

  return json({
    ok: true,
    services: services.map((s) => Object.assign({}, s, {
      trueProfit: money2(s.profit - overheadPerJob * s.n),
      trueMargin: s.rev > 0 ? pct(s.profit - overheadPerJob * s.n, s.rev) : null,
      trueProfitPerJob: money2(s.profit / s.n - overheadPerJob),
    })),
    vehicles, realization,
    totals: {
      jobs: jobs.length,
      revenue,
      timedJobs: timed.length,
      hours: money2(timed.reduce((a, e) => a + e.hours, 0)),
      blendedPerHour: timed.length
        ? money2(timed.reduce((a, e) => a + e.amount, 0) / timed.reduce((a, e) => a + e.hours, 0)) : null,
      untagged: jobs.filter((e) => !e.service).length,
      overhead, overheadPerJob, directCost,
      netProfit: money2(revenue - directCost - overhead),
      netMargin: revenue ? pct(revenue - directCost - overhead, revenue) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// 4. Forecast — where the month lands, what's already booked, spare capacity.
// ---------------------------------------------------------------------------
async function apiIntelForecast() {
  const cfg = await loadConfig();
  const now = Date.now();
  const todayStr = localDateStr(now, cfg.tz);
  const curMonth = todayStr.slice(0, 7);
  const entries = await intelLedger(13);
  const jobs = intelJobs(entries);

  const dim = new Date(+curMonth.slice(0, 4), +curMonth.slice(5, 7), 0).getDate();
  const dayOfMonth = +todayStr.slice(8, 10);
  const daysLeft = dim - dayOfMonth;

  const mtd = jobs.filter((e) => e._m === curMonth);
  const mtdRev = money2(mtd.reduce((a, e) => a + e.amount, 0));

  // Weekday earning profile from the trailing 90 days — a Saturday is worth far
  // more than a Tuesday in this business, so a flat "daily average × days left"
  // projection would be badly wrong near a weekend.
  const since = now - 90 * DAY_MS;
  const dowRev = [0, 0, 0, 0, 0, 0, 0], dowDays = [0, 0, 0, 0, 0, 0, 0];
  const seenDay = new Set();
  for (const e of jobs) {
    const ts = intelTs(e); if (ts < since) continue;
    const d = localDow(ts, cfg.tz);
    dowRev[d] += e.amount;
    const ds = String(e.date || '');
    if (!seenDay.has(ds)) { seenDay.add(ds); }
  }
  // Count how many of each weekday actually occurred in the window, so the
  // average is per-calendar-weekday and not per-worked-day.
  for (let t = since; t <= now; t += DAY_MS) dowDays[localDow(t, cfg.tz)]++;
  const dowAvg = dowRev.map((r, i) => (dowDays[i] ? r / dowDays[i] : 0));

  let projectedRest = 0;
  for (let d = dayOfMonth + 1; d <= dim; d++) {
    const ts = Date.parse(curMonth + '-' + String(d).padStart(2, '0') + 'T12:00:00Z');
    projectedRest += dowAvg[localDow(ts, cfg.tz)] || 0;
  }
  const projected = money2(mtdRev + projectedRest);

  // Prior full months, for context and the pace comparison.
  const monthTotals = {};
  for (const e of jobs) monthTotals[e._m] = money2((monthTotals[e._m] || 0) + e.amount);
  const priorMonths = Object.keys(monthTotals).filter((m) => m < curMonth).sort().reverse().slice(0, 12)
    .map((m) => ({ m, rev: monthTotals[m] }));
  const avgPrior = priorMonths.length ? money2(priorMonths.reduce((a, x) => a + x.rev, 0) / priorMonths.length) : 0;
  // Same-day-of-month pace last month: is this month ahead or behind?
  const lastM = prevMonthKey(curMonth);
  const lastMSameDay = money2(jobs.filter((e) => e._m === lastM && +String(e.date).slice(8, 10) <= dayOfMonth)
    .reduce((a, e) => a + e.amount, 0));

  // Already-booked pipeline (future confirmed/pending appointments).
  const bookings = await loadBookings();
  const upcoming = bookings.filter((b) => (b.apptAt || 0) > now && b.status !== 'cancelled' && b.status !== 'declined');
  const bookedThisMonth = upcoming.filter((b) => String(b.date || '').slice(0, 7) === curMonth);
  const pipeline = money2(upcoming.reduce((a, b) => a + (b.estimate || 0), 0));

  // Capacity: worked days and hours vs what's available.
  const workedDays = new Set(mtd.map((e) => e.date)).size;
  const mtdHours = money2(mtd.filter((e) => e.hours > 0).reduce((a, e) => a + e.hours, 0));
  const dailyCap = 8;
  return json({
    ok: true, month: curMonth, today: todayStr, dayOfMonth, daysInMonth: dim, daysLeft,
    mtd: { revenue: mtdRev, jobs: mtd.length, workedDays, hours: mtdHours,
      perWorkedDay: workedDays ? money2(mtdRev / workedDays) : 0,
      utilization: workedDays ? pct(mtdHours, workedDays * dailyCap) : 0 },
    projection: { revenue: projected, fromBooked: money2(bookedThisMonth.reduce((a, b) => a + (b.estimate || 0), 0)),
      vsLastMonth: monthTotals[lastM] ? pct(projected - monthTotals[lastM], monthTotals[lastM]) : null,
      vsAverage: avgPrior ? pct(projected - avgPrior, avgPrior) : null },
    pace: { lastMonthSameDay: lastMSameDay,
      delta: lastMSameDay ? pct(mtdRev - lastMSameDay, lastMSameDay) : null },
    pipeline: { total: pipeline, count: upcoming.length, thisMonth: bookedThisMonth.length },
    dow: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ d: i, avg: money2(dowAvg[i]) })),
    priorMonths, avgPrior,
  });
}

// ---------------------------------------------------------------------------
// 5. Pulse — recorded daily KPI history + anomaly detection.
// ---------------------------------------------------------------------------
// Some of this genuinely cannot be reconstructed after the fact (how many leads
// were open on a given day, what the reply time was that day), so the cron
// records one row per day. One KV write daily.
async function recordPulse(now = Date.now()) {
  const cfg = await loadConfig();
  const day = localDateStr(now, cfg.tz);
  const doc = (await kv().get(PULSE_KEY, { type: 'json' })) || { days: [] };
  if (doc.days.length && doc.days[doc.days.length - 1].d === day) return false; // already recorded today

  const index = await loadIndex();
  const active = index.filter((t) => !t.archived);
  const month = day.slice(0, 7);
  const mdoc = await loadMonth(month);
  const todayJobs = ((mdoc && mdoc.entries) || []).filter((e) => e.type === 'job' && e.date === day);

  doc.days.push({
    d: day,
    rev: money2(todayJobs.reduce((a, e) => a + e.amount, 0)),
    jobs: todayJobs.length,
    openLeads: active.filter((t) => t.status === 'new' || t.status === 'active').length,
    won: active.filter((t) => t.status === 'won').length,
    waiting: active.filter(rowAwaitingReply).length,
    newConvos: index.filter((t) => t.firstTs && localDateStr(t.firstTs, cfg.tz) === day).length,
  });
  doc.days = doc.days.slice(-PULSE_KEEP_DAYS);
  await kv().put(PULSE_KEY, JSON.stringify(doc));
  return true;
}

async function apiIntelPulse() {
  const doc = (await kv().get(PULSE_KEY, { type: 'json' })) || { days: [] };
  const days = doc.days || [];
  const cfg = await loadConfig();
  const now = Date.now();

  // Revenue history comes from the ledger (complete and authoritative) rather
  // than the recorded rows, so the trend is right even for days before Pulse was
  // switched on or days the cron missed.
  const entries = await intelLedger(13);
  const jobs = intelJobs(entries);
  const revByDay = {};
  for (const e of jobs) revByDay[e.date] = money2((revByDay[e.date] || 0) + e.amount);

  const series = [];
  for (let i = 89; i >= 0; i--) {
    const d = localDateStr(now - i * DAY_MS, cfg.tz);
    const rec = days.filter((x) => x.d === d)[0] || null;
    series.push({ d, rev: revByDay[d] || 0, jobs: jobs.filter((e) => e.date === d).length,
      openLeads: rec ? rec.openLeads : null, waiting: rec ? rec.waiting : null });
  }

  // --- anomaly detection ----------------------------------------------------
  // Compare the last 7 days against the 28 before them. Flag a metric only when
  // the move is both large in percentage terms AND large relative to the noise
  // in the baseline (a >2σ move), so a normally spiky metric doesn't cry wolf.
  const win = (arr, from, to, f) => arr.slice(from, to).map(f).filter((x) => x != null);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m)))); };
  const check = (label, f, opts) => {
    const recent = win(series, series.length - 7, series.length, f);
    const base = win(series, series.length - 35, series.length - 7, f);
    if (recent.length < 4 || base.length < 10) return null;
    const r = mean(recent), b = mean(base), s = sd(base);
    if (!b && !r) return null;
    const change = b ? ((r - b) / b) * 100 : (r > 0 ? 100 : 0);
    const z = s > 0 ? (r - b) / s : (Math.abs(change) > 40 ? (r > b ? 3 : -3) : 0);
    if (Math.abs(change) < 20 || Math.abs(z) < 1.6) return null;
    const good = opts.higherIsBetter ? change > 0 : change < 0;
    return { label, metric: opts.metric, recent: money2(r), base: money2(b),
      change: money2(change), z: money2(z), good, hint: opts.hint };
  };
  const anomalies = [
    check('Daily revenue', (x) => x.rev, { metric: 'revenue', higherIsBetter: true,
      hint: 'Revenue over the last 7 days vs the 4 weeks before.' }),
    check('Jobs per day', (x) => x.jobs, { metric: 'jobs', higherIsBetter: true,
      hint: 'Volume moved, independent of ticket size.' }),
    check('Open leads', (x) => x.openLeads, { metric: 'leads', higherIsBetter: true,
      hint: 'Leads sitting in new/active — the top of the funnel.' }),
    check('Waiting on you', (x) => x.waiting, { metric: 'waiting', higherIsBetter: false,
      hint: 'Conversations where the customer spoke last.' }),
  ].filter(Boolean).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  const last7 = series.slice(-7), prev7 = series.slice(-14, -7);
  const sum = (xs, f) => money2(xs.reduce((a, x) => a + (f(x) || 0), 0));
  return json({
    ok: true, series, anomalies,
    recorded: days.length,
    firstRecorded: days.length ? days[0].d : null,
    week: {
      revenue: sum(last7, (x) => x.rev), prevRevenue: sum(prev7, (x) => x.rev),
      jobs: sum(last7, (x) => x.jobs), prevJobs: sum(prev7, (x) => x.jobs),
      best: series.slice().sort((a, b) => b.rev - a.rev)[0] || null,
    },
  });
}

// AI content generator (Grow hub → SEO / Content Studio). One flexible endpoint
// that turns a task + short context into ready-to-use marketing copy via Gemini.
async function apiAiGenerate(request) {
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  const data = await readJson(request);
  const task = String(data.task || '').slice(0, 60);
  const context = String(data.context || '').slice(0, 1200);
  const cfg = await loadConfig();
  const biz = (cfg.playbook && cfg.playbook.business) || "Mikey's Mobile Detailing";
  const area = (cfg.playbook && cfg.playbook.area) || 'Snohomish, WA and surrounding areas';
  const PROMPTS = {
    gbp_post: `Write a short, upbeat Google Business Profile post for ${biz}, a mobile auto detailing business serving ${area}. Keep it 2-3 sentences, friendly and local, with a soft call to action. Do not use hashtags or emojis. Topic/details: ${context || 'a general promo for this week'}.`,
    review_response: `Write a warm, professional 1-2 sentence reply from the owner of ${biz} responding to this customer review. Sound genuine and human, thank them, and invite them back. Review: "${context || 'Great job, my car looks brand new!'}"`,
    promo_text: `Write a short SMS promo (under 300 characters, no links) for ${biz} to send past customers. Friendly, local, one clear offer and call to action. Details: ${context || 'a seasonal detailing special'}.`,
    social_caption: `Write an engaging social media caption for ${biz} (mobile auto detailing in ${area}). 1-2 sentences plus up to 3 relevant hashtags. Topic: ${context || 'before-and-after of a full detail'}.`,
    service_desc: `Write a polished, benefit-focused service description (2-3 sentences) for ${biz}. Service: ${context || 'Full interior + exterior detail'}.`,
    email_blast: `Write a short marketing email (subject line + 3-4 sentence body) for ${biz} to past customers. Warm, local, one clear offer. Details: ${context || 'a limited-time detailing special'}.`,
  };
  const prompt = PROMPTS[task] || (`You are the marketing assistant for ${biz}, a mobile auto detailing business in ${area}. ${context}`);
  try {
    const text = await geminiGenerate(prompt, { surface: 'write something', temperature: 0.8, maxTokens: 600 });
    return json({ ok: true, task, text });
  } catch (e) {
    return json({ ok: false, error: 'ai_error', detail: String(e.message || e).slice(0, 200) }, 502);
  }
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

  // Mikey replying to a customer alert isn't inbox mail — it's him answering a
  // customer. Run it through the assist loop and don't file it in the inbox.
  // Checked AFTER the de-dupe so a retrying forwarder can't send the same reply
  // twice; the assist itself is queued, so a stray double would surface as a
  // second queued message he can cancel rather than a second text going out.
  const assistPhone = assistIsOwnerReply(cfg, email);
  if (assistPhone) {
    if (mid) { list.unshift({ id: email.id, mid, assist: true, date: email.date, unread: 0, from: email.from, subject: email.subject, snippet: '' }); if (list.length > 60) list.length = 60; await kv().put('emails', JSON.stringify(list)); }
    await handleAssistEmail(cfg, email, assistPhone);
    return json({ ok: true, assist: true });
  }
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
  const url = `${publicBase()}/email-in`;
  return json({
    ok: true, url, token,
    connected: list.length > 0, count: list.length, lastAt: list[0] ? list[0].date : null,
    // Ready to paste into script.google.com — this is what turns "reply to the
    // alert" into an answered customer.
    script: assistAppsScript(url, token),
    assistReady: !!(ENV.RESEND_API_KEY && ENV.ALERT_EMAIL),
  });
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

// Recover voicemails that live only in Twilio. A voicemail recorded before the
// thread stored it — e.g. its transcription failed, so the old /voicemail-tx
// code saved nothing — is still sitting in Twilio's Recordings. This pulls the
// most recent recordings, finds each caller via the call's From number, and
// drops a playable voicemail (with transcript when Twilio has one) into that
// caller's thread. Deduped by RecordingSid so re-running is safe. Kept to a
// small page so we stay well under the Worker subrequest limit.
async function apiVoicemailBackfill(request) {
  const data = await readJson(request).catch(() => ({}));
  const wantPhone = data && data.phone ? normalizePhone(data.phone) : '';
  const sid = ENV.TWILIO_ACCOUNT_SID, token = ENV.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return json({ ok: false, error: 'twilio_not_configured' }, 500);
  const auth = `Basic ${btoa(`${sid}:${token}`)}`;
  const api = (path) => fetch(`https://api.twilio.com${path}`, { headers: { Authorization: auth } });

  let recs;
  try {
    const r = await api(`/2010-04-01/Accounts/${sid}/Recordings.json?PageSize=15`);
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    recs = (await r.json()).recordings || [];
  } catch (e) {
    return json({ ok: false, error: `twilio_list_failed: ${String((e && e.message) || e)}` }, 502);
  }

  // Resolve caller + transcript per recording, grouping by caller so each
  // thread's KV is written once.
  const mikey = normalizePhone(ENV.MIKEY_PHONE);
  const byPhone = new Map();
  for (const rec of recs) {
    const recSid = rec.sid, callSid = rec.call_sid;
    if (!recSid || !callSid) continue;
    let from = '';
    try { const cr = await api(`/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`); if (cr.ok) from = (await cr.json()).from || ''; } catch { /* skip */ }
    const caller = normalizePhone(from);
    if (!caller || caller === mikey) continue;
    if (wantPhone && caller !== wantPhone) continue;
    let transcript = '';
    try {
      const tr = await api(`/2010-04-01/Accounts/${sid}/Recordings/${recSid}/Transcriptions.json`);
      if (tr.ok) { const done = ((await tr.json()).transcriptions || []).find((t) => t.status === 'completed' && t.transcription_text); if (done) transcript = (done.transcription_text || '').trim(); }
    } catch { /* transcript optional — the recording is what matters */ }
    const list = byPhone.get(caller) || [];
    list.push({
      recordingSid: recSid,
      recording: `https://api.twilio.com${String(rec.uri).replace(/\.json$/, '')}.mp3`,
      ts: rec.date_created ? new Date(rec.date_created).getTime() : Date.now(),
      duration: rec.duration || '',
      transcript,
    });
    byPhone.set(caller, list);
  }

  let added = 0;
  for (const [caller, vms] of byPhone) {
    const thread = await loadThread(caller);
    let changed = false;
    for (const vm of vms) {
      if ((thread.messages || []).some((m) => m.kind === 'voicemail' && m.recordingSid === vm.recordingSid)) continue;
      thread.messages.push({
        id: genId(),
        dir: 'in',
        body: vm.transcript ? `🎙️ Voicemail: "${vm.transcript}"` : `🎙️ Voicemail (${vm.duration || '?'}s)`,
        ts: vm.ts,
        kind: 'voicemail',
        recording: vm.recording,
        recordingSid: vm.recordingSid,
        transcript: vm.transcript || undefined,
        transcriptFailed: vm.transcript ? undefined : true,
      });
      changed = true; added++;
    }
    if (changed) {
      thread.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      thread.unread = (thread.unread || 0) + 1;
      if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
      await saveThread(thread);
      await updateIndexEntry(thread);
    }
  }
  return json({ ok: true, added, scanned: recs.length });
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
    const text = await geminiGenerate(prompt, { surface: 'summary', json: true, maxTokens: 1200 });
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
  const spend = await customerSpend(thread.phone, cfg);
  const voice = await loadVoice();
  // Which situation is this? Take it from what he's being asked to write about —
  // the hint if he gave one, otherwise the customer's last message.
  const msgs = thread.messages || [];
  const lastIn = [...msgs].reverse().find((m) => m.dir === 'in');
  // The same text also drives which of his real texts get retrieved below, so a
  // "how much for a truck" pulls his actual truck-pricing replies, not just any
  // price text.
  const situation = hint || (lastIn && lastIn.body) || '';
  const bucket = voiceBucket(situation);
  // Resolve the async context blocks once, then reuse them across attempts.
  const rulesCtx = await rulesContext();
  const editsCtx = await editsContext(bucket);
  const build = (extra) =>
    businessContext(cfg) +
    rulesCtx +
    customerContext(thread, spend) +
    voiceContext(voice, bucket, situation) +
    editsCtx +
    `You are replying to a customer by text for Mikey's Mobile Detailing. ` +
    `Write ONE reply (1-3 short complete sentences, no greeting line, no signature, ready to send). ` +
    `It must be indistinguishable from the real texts above — same length, same rhythm, same punctuation habits. ` +
    `Ground it in the business playbook — use the real services, pricing ranges and voice, and never contradict them. ` +
    `Do not make up a specific price or appointment time on your own. ` +
    `BUT if the goal below already specifies details the owner has decided — a price, a day, a time, an answer — use those exactly as given; that is the owner telling you what to say. ` +
    `Write it the way a busy person texts, not the way an assistant writes. Finish every sentence. ` +
    (hint ? `Goal of this reply (write a text that accomplishes exactly this): ${hint}. ` : '') +
    (extra || '') +
    `\n\nConversation so far:\n${transcript(thread)}\n\nReply:`;

  let text = await aiGenerate(build(''), { surface: 'reply draft', tier: 'voice', maxTokens: 800, temperature: 0.45 });
  text = cleanReply(text);
  // One regeneration if the draft gave itself away — either a stock AI phrase, or a
  // shape outside his measured habits (far too long, an emoji he'd never use, a
  // greeting he never writes). Naming the exact offence beats asking again nicely,
  // because it can't fix what it hasn't been told is wrong.
  const tell = findTell(text);
  const off = tell
    ? `used the phrase "${tell}", which is a dead giveaway that a machine wrote it`
    : styleViolation(text, voice && voice.style);
  if (off) {
    try {
      const retry = await aiGenerate(
        build(`CRITICAL: your previous attempt ${off}. Mikey does not write like that. Rewrite it to read exactly like the real texts above, and avoid any customer-service filler. `),
        { surface: 'reply draft', tier: 'voice', maxTokens: 800, temperature: 0.45 },
      );
      const cleaned = cleanReply(retry);
      // Take the retry even if it still trips a rule — it was written under the
      // stricter instruction, so it is the better of the two either way.
      if (cleaned) text = cleaned;
    } catch { /* keep the first attempt rather than failing the draft */ }
  }
  return text;
}

// Strip the wrappers models like to add, and normalise the punctuation he
// doesn't use. Em-dashes are the single most recognisable AI tell in a text.
function cleanReply(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  t = t.replace(/^["']|["']$/g, '').trim();
  t = t.replace(/\s*—\s*/g, ' - ');   // em-dash → the hyphen he actually types
  t = t.replace(/\s*–\s*/g, ' - ');   // en-dash, same
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
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
      // Polish mode = clean up and reword for clarity while keeping the sender's
      // meaning, facts and casual voice. We include just the voice/tone (not the
      // whole playbook) so it sounds like Mikey, and forbid changing any facts so
      // it can't invent prices/times. This actually rewrites awkward phrasing —
      // it's not a bare proofread.
      const voice = (cfg.playbook && cfg.playbook.tone) ? `Write in this texting voice:\n${cfg.playbook.tone}\n\n` : '';
      const prompt =
        voice +
        (await rulesContext()) +
        `You are polishing a short text message the user is about to send a customer. ` +
        `Rewrite it so it reads clearly and sounds great: fix spelling, grammar and punctuation, and reword any awkward, clunky or confusing phrasing so every sentence makes sense and flows naturally. ` +
        `KEEP the user's exact meaning and intent. Keep it casual and friendly like a real text — never stiff, formal or corporate — and keep it about the same length (it's a text, so stay concise). ` +
        `Do NOT add, remove, or change any facts, prices, dates, times, names or details, and do NOT invent anything the user didn't say. ` +
        `Do NOT add greetings, sign-offs, or emojis that aren't already there. ` +
        `Return ONLY the polished message — no quotes, no explanation, no preamble. ` +
        (hint ? `Also follow this instruction: ${hint}. ` : '') +
        `\n\nMessage to polish:\n${draftText}\n\nPolished message:`;
      const text = await geminiGenerate(prompt, { surface: 'auto polish', temperature: 0.4, maxTokens: 800 });
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
    const who = e.lastDir !== 'in' ? `you replied ${ago} ago`
      : e.awaitingReply === false ? `they wrote ${ago} ago but nothing is owed — ${e.closedReason || 'conversation wrapped up'}`
      : `WAITING ${ago} for reply`;
    return `- ${e.name || e.phone} [${e.status || 'no status'}] ${who}: "${e.lastBody || ''}"`;
  }).join('\n');
  const prompt =
    businessContext(cfg) +
    `You are the operations assistant for Mikey's Mobile Detailing. Below are the open SMS threads. ` +
    `Give a short, prioritized action list (max 6 bullets) of who to reply to first and the suggested next step. ` +
    `Customers who are WAITING for a reply are top priority; longest waits first. ` +
    `Threads marked "nothing is owed" have already wrapped up (a thank-you, an acknowledgement) — leave them alone, never suggest replying to or chasing them. ` +
    `Be concise and practical. ` +
    `Keep each bullet to one complete sentence and finish your final bullet.\n\n${lines}`;
  try {
    const briefing = await geminiGenerate(prompt, { surface: 'triage board', maxTokens: 2000 });
    return json({ ok: true, briefing });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

// ===========================================================================
// AI command bar  (POST /api/ai/command)
// ---------------------------------------------------------------------------
// "Just tell it what you want done." Mikey types a plain-English instruction
// ("mark all unread as read", "archive everything marked lost", "clear the
// email inbox") and Gemini turns it into ONE bulk action + a filter. The flow
// is two-phase and safe:
//   Phase 1 (no confirm)  -> interpret + PREVIEW: returns the resolved action,
//                            how many items it touches, and a few sample names.
//                            Nothing is changed.
//   Phase 2 (confirm+plan) -> execute the previewed plan, batched (one index
//                            write for the whole run), and report the count.
// There is deliberately no hard-delete: "delete / remove / clear out" a
// conversation maps to ARCHIVE, so every action is reversible.
// ===========================================================================
const CMD_ACTIONS = ['mark_read', 'mark_unread', 'archive', 'unarchive', 'set_status', 'pin', 'unpin', 'block', 'unblock', 'emails_mark_read', 'hold', 'release', 'none'];
const CMD_STATUSES = ['new', 'active', 'won', 'lost'];

// Resolve a plan's filter into the list of index rows it applies to. Pure (no
// KV) so both the preview and the executor share one definition of "which".
function selectThreads(index, filter) {
  filter = filter || {};
  let list = index.slice();
  const match = filter.match || 'active';
  if (match === 'unread') list = list.filter((t) => (t.unread || 0) > 0);
  else if (match === 'read') list = list.filter((t) => !((t.unread || 0) > 0));
  else if (match === 'archived') list = list.filter((t) => !!t.archived);
  else if (match === 'active') list = list.filter((t) => !t.archived);
  // 'all' -> no base restriction (includes archived)
  if (filter.status && CMD_STATUSES.includes(filter.status)) list = list.filter((t) => (t.status || '') === filter.status);
  if (Number(filter.olderThanDays) > 0) { const cut = Date.now() - Number(filter.olderThanDays) * 86400000; list = list.filter((t) => (t.lastTs || 0) < cut); }
  if (Number(filter.newerThanDays) > 0) { const cut = Date.now() - Number(filter.newerThanDays) * 86400000; list = list.filter((t) => (t.lastTs || 0) >= cut); }
  if (filter.nameOrPhone) {
    const q = String(filter.nameOrPhone).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (q) list = list.filter((t) => ((t.name || '') + (t.phone || '')).toLowerCase().replace(/[^a-z0-9]/g, '').includes(q));
  }
  return list;
}

// Friendly past-tense sentence for the result toast.
function describeCount(action, n, status) {
  if (!n) return 'Nothing needed changing — you\'re all set.';
  const c = n + ' conversation' + (n > 1 ? 's' : '');
  switch (action) {
    case 'mark_read':   return 'Marked ' + c + ' as read.';
    case 'mark_unread': return 'Marked ' + c + ' as unread.';
    case 'archive':     return 'Archived ' + c + '.';
    case 'unarchive':   return 'Restored ' + c + ' from the archive.';
    case 'pin':         return 'Pinned ' + c + '.';
    case 'unpin':       return 'Unpinned ' + c + '.';
    case 'block':       return 'Blocked ' + n + ' number' + (n > 1 ? 's' : '') + '.';
    case 'unblock':     return 'Unblocked ' + n + ' number' + (n > 1 ? 's' : '') + '.';
    case 'set_status':  return 'Moved ' + c + ' to "' + (status || '') + '".';
    case 'hold':        return 'Holding ' + c + ' — I won\'t chase them until then.';
    case 'release':     return 'Back on your list: ' + c + '.';
    default:            return 'Done — ' + c + ' updated.';
  }
}

// ---------------------------------------------------------------------------
// Standing instructions ("Sabine's handled, I'm doing her car in August")
// ---------------------------------------------------------------------------
// A hold is a snooze that remembers WHY. The follow-up engine already refuses to
// plan anything while followup.snoozeUntil is in the future, so the mechanism
// exists; what's new is that the reason travels with it, shows on the board, and
// goes into the AI advisor's snapshot — so the AI stops recommending someone
// because it knows the reason, not because they were hidden from it.
//
// Two things end a hold on their own: the date passing, and the customer texting
// in. A person reaching out always beats a note you left yourself.
const HOLD_MAX_MS = 400 * 86400000; // a year and a bit — anything longer is a parse mistake

// Turn whatever the model returned into a timestamp. Accepts an ISO date
// ("2026-08-01"), a full timestamp, or a plain number of days.
function parseHoldUntil(until, days, now = Date.now()) {
  if (days != null && !isNaN(+days) && +days > 0) return now + Math.min(+days * 86400000, HOLD_MAX_MS);
  if (typeof until === 'number' && until > now) return Math.min(until, now + HOLD_MAX_MS);
  const s = String(until || '').trim();
  if (!s) return 0;
  // A bare date means "the start of that day", local to the business.
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T09:00:00' : s;
  const t = Date.parse(bare);
  if (isNaN(t)) return 0;
  if (t <= now) return 0;
  return Math.min(t, now + HOLD_MAX_MS);
}

function holdIsActive(fu, now = Date.now()) {
  return !!(fu && fu.snoozeUntil && fu.snoozeUntil > now);
}

// One-line description used in the preview, the board snapshot and the UI.
function describeHold(fu, cfg) {
  if (!holdIsActive(fu)) return '';
  const when = new Date(fu.snoozeUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: (cfg && cfg.tz) || 'America/Los_Angeles' });
  return 'on hold until ' + when + (fu.holdReason ? ' — ' + fu.holdReason : '');
}

// Gemini: plain English -> ONE structured bulk action. Strict JSON, enum-locked.
async function interpretCommand(text) {
  const prompt =
    `You translate a small-business owner's plain-English request into ONE bulk action on their SMS dashboard. ` +
    `Return ONLY a JSON object, no prose, no code fences. Shape:\n` +
    `{"action": one of ${JSON.stringify(CMD_ACTIONS)}, ` +
    `"status": one of ${JSON.stringify(CMD_STATUSES)} (ONLY when action is "set_status", else null), ` +
    `"filter": {"match": "all"|"unread"|"read"|"archived"|"active", "status": null or one of ${JSON.stringify(CMD_STATUSES)}, "olderThanDays": null or number, "newerThanDays": null or number, "nameOrPhone": null or string}, ` +
    `"until": null or "YYYY-MM-DD" (ONLY for action "hold"), ` +
    `"holdDays": null or number (ONLY for action "hold", when they say a duration rather than a date), ` +
    `"reason": null or a SHORT phrase in the owner's own words explaining why (ONLY for action "hold"), ` +
    `"reply": "one short friendly sentence stating exactly what you will do"}\n\n` +
    `Today is ${new Date().toISOString().slice(0, 10)}.\n\n` +
    `Rules:\n` +
    `- HOLD is the important one. When the owner says a customer is handled, taken care of, doesn't need a reply, or shouldn't be chased until some point — "Sabine doesn't need responded to, I'm doing her car in August", "leave Rick alone till spring", "don't bug the Hendersons for a couple weeks" — use action "hold", put the person in filter.nameOrPhone, set "until" to the date it should end (pick a sensible date: a bare month means the 1st of that month; "spring" means Mar 1; if they only give a duration use holdDays instead), and put their reason in "reason" as a short phrase ("doing her car in August"). Set filter.match to "all" so it works even if the thread is archived.\n` +
    `- "start chasing X again / un-hold / never mind about X / put X back" -> release.\n` +
    `- "mark as read / mark read / clear unread" -> mark_read. "mark unread" -> mark_unread.\n` +
    `- "delete / remove / clear out / get rid of / hide / clean up" a conversation -> archive. This dashboard has NO hard delete; archiving is how threads are removed. "unarchive / restore / bring back" -> unarchive.\n` +
    `- "mark won / mark lost / mark new / mark active / move to X" -> set_status with that status.\n` +
    `- "pin / unpin" and "block / unblock" map to those actions.\n` +
    `- "mark emails read / clear the email inbox" -> emails_mark_read.\n` +
    `- filter.match defaults to "active" (not-archived threads). Use "unread" when they mention unread; "all" only when they clearly mean everything including archived; "archived" when they act on archived ones; "read" for already-read ones.\n` +
    `- "old / older than a week/month" -> olderThanDays (week=7, month=30). "recent / in the last few days" -> newerThanDays.\n` +
    `- A specific person or phone number -> nameOrPhone.\n` +
    `- If the request is unclear, unsafe, or not one of the supported actions, use action "none" and put a short clarifying question in "reply".\n\n` +
    `Request: ${JSON.stringify(String(text || '').slice(0, 400))}`;
  const raw = await geminiGenerate(prompt, { surface: 'command', json: true, maxTokens: 500, temperature: 0.1 });
  let p = {};
  try { p = JSON.parse(raw); } catch { p = { action: 'none', reply: 'Sorry, I didn\'t catch that — try rephrasing.' }; }
  if (!CMD_ACTIONS.includes(p.action)) p.action = 'none';
  if (p.action !== 'set_status') p.status = null;
  p.filter = (p.filter && typeof p.filter === 'object') ? p.filter : {};
  if (p.action === 'hold') {
    p.holdUntil = parseHoldUntil(p.until, p.holdDays);
    p.reason = String(p.reason || '').trim().slice(0, 140);
    // A hold with no usable date is worse than none — it would silence someone
    // forever. Fall back to asking rather than guessing.
    if (!p.holdUntil) { p.action = 'none'; p.reply = 'Until when should I leave them alone? Give me a date or "for two weeks".'; }
  } else { p.holdUntil = 0; p.reason = ''; }
  return p;
}

// Dry-run: how many items the plan touches + a few sample labels. No writes.
async function previewCommandPlan(plan) {
  if (plan.action === 'emails_mark_read') {
    const list = (await kv().get('emails', { type: 'json' })) || [];
    const un = list.filter((e) => e.unread);
    return { count: un.length, unit: 'email', samples: un.slice(0, 6).map((e) => e.subject || e.from || '(email)') };
  }
  const index = await loadIndex();
  const list = selectThreads(index, plan.filter);
  const preview = { count: list.length, unit: 'conversation', samples: list.slice(0, 6).map((t) => t.name || t.phone) };
  if (plan.action === 'hold' && plan.holdUntil) {
    preview.until = plan.holdUntil;
    preview.reason = plan.reason || '';
  }
  return preview;
}

// Execute a previewed plan. Batched: the thread ops mutate the index in memory
// and write it ONCE at the end (see the KV-frugality note near loadIndex).
async function executeCommandPlan(plan) {
  const action = plan.action;
  const cap = 500; // hard blast-radius ceiling, just in case
  if (action === 'emails_mark_read') {
    const list = (await kv().get('emails', { type: 'json' })) || [];
    let n = 0;
    for (const e of list) if (e.unread) { e.unread = 0; n++; }
    if (n) await kv().put('emails', JSON.stringify(list));
    return { count: n, reply: n ? ('Marked ' + n + ' email' + (n > 1 ? 's' : '') + ' as read.') : 'No unread emails to clear.' };
  }
  const cfg = await loadConfig();
  const index = await loadIndex();
  const targets = selectThreads(index, plan.filter).slice(0, cap);
  if (action === 'block' || action === 'unblock') {
    const next = Object.assign({}, cfg);
    const set = new Set(Array.isArray(next.blockedNumbers) ? next.blockedNumbers : []);
    let n = 0;
    for (const t of targets) {
      const has = set.has(t.phone);
      if (action === 'block' && !has) { set.add(t.phone); n++; }
      if (action === 'unblock' && has) { set.delete(t.phone); n++; }
    }
    next.blockedNumbers = Array.from(set);
    if (n) { await kv().put('config', JSON.stringify(next)); CFG_CACHE = next; }
    return { count: n, reply: describeCount(action, n) };
  }
  let n = 0, indexChanged = false;
  for (const entry of targets) {
    const thread = await loadThread(entry.phone);
    let ch = false;
    switch (action) {
      case 'mark_read':   if (thread.unread) { thread.unread = 0; ch = true; } break;
      case 'mark_unread': if (!thread.unread) { thread.unread = 1; ch = true; } break;
      case 'archive':     if (!thread.archived) { thread.archived = true; ch = true; } break;
      case 'unarchive':   if (thread.archived) { thread.archived = false; ch = true; } break;
      case 'pin':         if (!thread.pinned) { thread.pinned = true; ch = true; } break;
      case 'unpin':       if (thread.pinned) { thread.pinned = false; ch = true; } break;
      case 'set_status': {
        const s = plan.status;
        if (CMD_STATUSES.includes(s) && thread.status !== s) { thread.status = s; thread.statusAt = Date.now(); ch = true; }
        break;
      }
      case 'hold': {
        const until = Number(plan.holdUntil) || 0;
        if (until > Date.now()) {
          const fu = thread.followup || (thread.followup = defaultFollowup());
          fu.snoozeUntil = until;
          fu.holdReason = String(plan.reason || '').slice(0, 140);
          fu.heldAt = Date.now();
          fu.suggestion = null;           // drop any nudge already waiting
          ch = true;
        }
        break;
      }
      case 'release': {
        const fu = thread.followup;
        if (fu && (fu.snoozeUntil || fu.holdReason)) {
          fu.snoozeUntil = null; fu.holdReason = ''; fu.heldAt = 0;
          ch = true;
        }
        break;
      }
      default: break;
    }
    if (ch) { await saveThread(thread); if (applyIndexSummary(index, buildIndexSummary(thread, cfg))) indexChanged = true; n++; }
  }
  if (indexChanged) await saveIndex(index);
  return { count: n, reply: describeCount(action, n, plan.status) };
}

async function apiAiCommand(request) {
  const data = await readJson(request);
  // Phase 2 — execute a plan the user already previewed and confirmed.
  if (data.confirm && data.plan && CMD_ACTIONS.includes(data.plan.action) && data.plan.action !== 'none') {
    try {
      const r = await executeCommandPlan(data.plan);
      return json({ ok: true, done: true, count: r.count, reply: r.reply });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 502);
    }
  }
  // Phase 1 — interpret the request and return a preview (no changes made).
  const text = String(data.text || '').trim();
  if (!text) return json({ ok: false, error: 'empty' }, 422);
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  let plan;
  try { plan = await interpretCommand(text); }
  catch (err) { return json({ ok: false, error: String(err.message || err) }, 502); }
  if (plan.action === 'none') {
    return json({ ok: true, action: 'none', reply: plan.reply || 'I\'m not sure what you mean — can you rephrase?' });
  }
  const preview = await previewCommandPlan(plan);
  return json({
    ok: true,
    plan: { action: plan.action, status: plan.status || null, filter: plan.filter || {},
            holdUntil: plan.holdUntil || 0, reason: plan.reason || '' },
    reply: plan.reply || describeCount(plan.action, preview.count, plan.status),
    count: preview.count,
    unit: preview.unit,
    samples: preview.samples,
    until: preview.until || 0,
    reason: preview.reason || '',
  });
}

// ===========================================================================
// AI advisor  (POST /api/ai/analyze)
// ---------------------------------------------------------------------------
// "Tell me what needs attention and what you'd do." Mikey taps a preset ("What
// needs my attention?", "What should I clean up?") or types a focus, and Gemini
// reviews a snapshot of the WHOLE dashboard against the operations playbook
// below, then returns a prioritized advisory in three buckets:
//   attention  — reply/act on these now, and why
//   recommend  — next moves that move money forward, and why
//   organize   — cleanup so the board stays tidy (each can carry a `command`
//                phrase that runs straight through the safe command bar).
// This is read-only: it never changes anything. Acting on a suggestion goes
// through /api/ai/command's preview→confirm flow, so nothing happens by surprise.
// ===========================================================================

// The operating philosophy the advisor reasons from. This is deliberately about
// HOW Mikey wants the board run — fast replies, an accurate pipeline, a clean
// inbox, no lead left on the table — not the sales script (that's the playbook).
function opsPlaybook() {
  return [
    'HOW MIKEY WANTS THIS DASHBOARD RUN (your operating principles):',
    '1. A customer WAITING on a reply is the #1 priority — longest wait first. Every hour cold costs a booking. Flag these loudest.',
    '2. The lead pipeline must stay accurate: every open thread should have a status (New / Active / Won / Lost). A thread with no status is invisible to planning — call it out.',
    '3. Keep the inbox clean. Dead threads (Lost, or clearly finished Won jobs, or long-silent with no path forward) should be archived so what remains is what needs work. Archiving is reversible — treat it as "filing away", not deleting.',
    '4. Never drop a warm lead. Date-requested, due follow-ups, and reminders coming due are money on the table — surface them.',
    '4b. But never invent work either: a conversation that ended on a thank-you, a 👍 or an acknowledgement is FINISHED. Do not tell Mikey to reply to it or chase it — the CLOSED OUT list below is there so you skip them.',
    '5. Won leads that were never logged in the money tracker are lost profit visibility — worth a nudge.',
    '6. Be concrete and efficient: say exactly what to do, tie it to a specific customer or bucket, and keep the "why" to one line. Prefer a few high-impact moves over a long list.',
    '7. When you recommend a bulk cleanup that the command bar can do, put the exact plain-English command in the item\'s "command" field so Mikey can run it in one tap.',
    '8. RESPECT HOLDS. Anyone in the ON HOLD list has been parked by Mikey himself, with his reason. Do not tell him to reply to them, chase them, archive them or change their status — he has already decided. Never list a held customer under attention. The single exception: if something genuinely new has happened that his reason plainly does not cover, you may mention it in one line that repeats his own reason back to him first.',
  ].join('\n');
}

// Compact, token-cheap snapshot of the whole board for the advisor to reason on.
function boardSnapshot(index, cfg, now) {
  // Conversations Mikey has explicitly parked are pulled out of every priority
  // list below and reported separately WITH his reason. The advisor then stops
  // recommending them because it knows why they're quiet — not because they were
  // hidden from it. That distinction is the whole point: it can still mention one
  // if something genuinely changed.
  const held = index.filter((e) => !e.archived && e.heldUntil && e.heldUntil > now);
  const heldPhones = new Set(held.map((e) => e.phone));
  const open = index.filter((e) => !e.archived && !heldPhones.has(e.phone));
  const line = (e) => {
    const ago = humanAgo(now - (e.lastTs || now));
    const who = e.lastDir === 'in' ? `waiting ${ago}` : `you replied ${ago} ago`;
    return `  - ${e.name || e.phone} [${e.status || 'NO STATUS'}] ${who}: "${(e.lastBody || '').slice(0, 70)}"`;
  };
  // "Waiting" means the customer spoke last AND something is genuinely open —
  // threads that ended on a thank-you are filed under CLOSED OUT below instead.
  const waiting = open.filter(rowAwaitingReply).sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
  const closedOut = open.filter((e) => e.lastDir === 'in' && e.awaitingReply === false);
  const unread = open.filter((e) => (e.unread || 0) > 0);
  const noStatus = open.filter((e) => !e.status);
  const dueFollow = open.filter((e) => e.followupDue);
  const dateReq = open.filter((e) => e.dateRequested);
  const remindDue = open.filter((e) => e.reminderDue);
  const won = open.filter((e) => e.status === 'won');
  const lost = open.filter((e) => e.status === 'lost');
  const stale = open.filter((e) => e.status !== 'won' && e.status !== 'lost' && (now - (e.lastTs || now)) > 10 * 86400000);
  const S = [];
  S.push(`BOARD SNAPSHOT (now = ${new Date(now).toISOString()}):`);
  S.push(`Totals: ${index.length} conversations, ${open.length} open, ${index.length - open.length} archived, ${unread.length} unread.`);
  S.push('');
  S.push(`WAITING ON A REPLY (${waiting.length}) — top priority, longest first:`);
  S.push(waiting.slice(0, 18).map(line).join('\n') || '  (none)');
  S.push('');
  S.push(`CLOSED OUT — customer spoke last but nothing is owed, do NOT chase these (${closedOut.length}):`);
  S.push(closedOut.slice(0, 12).map((e) => `  - ${e.name || e.phone}: "${(e.lastBody || '').slice(0, 50)}" (${e.closedReason || 'wrapped up'})`).join('\n') || '  (none)');
  S.push('');
  S.push(`DUE FOLLOW-UPS (${dueFollow.length}):`);
  S.push(dueFollow.slice(0, 12).map(line).join('\n') || '  (none)');
  S.push('');
  S.push(`DATE REQUESTED / READY TO BOOK (${dateReq.length}):`);
  S.push(dateReq.slice(0, 12).map(line).join('\n') || '  (none)');
  S.push('');
  const voicemails = open.filter((e) => e.hasVoicemail);
  S.push(`REMINDERS DUE (${remindDue.length}): ${remindDue.slice(0, 10).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  S.push(`VOICEMAILS in open threads (${voicemails.length}): ${voicemails.slice(0, 12).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  S.push(`NO STATUS SET (${noStatus.length}): ${noStatus.slice(0, 14).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  S.push(`STALE — active but silent 10+ days (${stale.length}): ${stale.slice(0, 14).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  S.push(`LOST leads still in the open inbox (${lost.length}): ${lost.slice(0, 14).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  S.push(`WON leads (${won.length}): ${won.slice(0, 14).map((e) => e.name || e.phone).join(', ') || '(none)'}`);
  const aging = open.filter((e) => e.quoteAt && (now - e.quoteAt) > 2 * 86400000)
    .sort((a, b) => a.quoteAt - b.quoteAt);
  S.push(`QUOTES SENT, STILL NO ANSWER (${aging.length}) — the most winnable money here:`);
  S.push(aging.slice(0, 12).map((e) =>
    `  - ${e.name || e.phone}: $${e.quoteTotal || '?'} quoted ${humanAgo(now - e.quoteAt)} ago, not accepted or declined`
  ).join('\n') || '  (none)');
  S.push('');
  S.push(`ON HOLD — Mikey told you to leave these alone (${held.length}). They are DELIBERATELY excluded from every list above:`);
  S.push(held.slice(0, 20).map((e) =>
    `  - ${e.name || e.phone}: until ${new Date(e.heldUntil).toISOString().slice(0, 10)}` +
    (e.holdReason ? ` because "${e.holdReason}"` : '') +
    (e.lastDir === 'in' ? ' (note: they texted last)' : '')
  ).join('\n') || '  (none)');
  return S.join('\n');
}

async function apiAiAnalyze(request) {
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  const data = await readJson(request).catch(() => ({}));
  const focus = String((data && data.focus) || '').slice(0, 300).trim();
  const cfg = await loadConfig();
  const index = await loadIndex();
  const now = Date.now();
  if (!index.filter((e) => !e.archived).length) {
    return json({ ok: true, headline: 'Inbox is all clear — nothing open needs attention right now. 🚗', attention: [], recommend: [], organize: [] });
  }
  const prompt =
    businessContext(cfg) +
    (await rulesContext()) +
    opsPlaybook() + '\n\n' +
    boardSnapshot(index, cfg, now) + '\n\n' +
    (focus ? `MIKEY'S FOCUS FOR THIS REVIEW: "${focus}"\n\n` : '') +
    `Review the board and respond with ONLY JSON (no prose, no code fences):\n` +
    `{"headline":"one honest sentence on the overall state right now",` +
    `"attention":[{"title":"short — usually a customer name + what's needed","detail":"one line: what to do and why it matters now"}],` +
    `"recommend":[{"title":"short next move","detail":"one line why","command":"OPTIONAL plain-English command the command bar can run, else omit"}],` +
    `"organize":[{"title":"short cleanup","detail":"one line why","command":"OPTIONAL plain-English command, else omit"}]}\n` +
    `Rules: Max 6 items per bucket, fewer is better — only real, high-impact items. Ground every item in the snapshot (use real names). ` +
    `A "command" must be a phrase like "archive everything marked lost", "mark all unread as read", "mark <name> as won", "pin the won leads" — only include it when a bulk command bar action genuinely fits. Never invent customers or facts not in the snapshot.`;
  let raw;
  try { raw = await geminiGenerate(prompt, { surface: 'analyze', json: true, maxTokens: 2600, temperature: 0.3 }); }
  catch (err) { return json({ ok: false, error: String(err.message || err) }, 502); }
  let p = {};
  try { p = JSON.parse(raw); } catch { return json({ ok: false, error: 'ai_parse_failed', raw: String(raw).slice(0, 400) }, 502); }
  const clean = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 6).map((x) => ({
    title: String((x && x.title) || '').slice(0, 120),
    detail: String((x && x.detail) || '').slice(0, 260),
    command: (x && x.command) ? String(x.command).slice(0, 160) : undefined,
  })).filter((x) => x.title || x.detail);
  return json({
    ok: true,
    headline: String(p.headline || '').slice(0, 240),
    attention: clean(p.attention),
    recommend: clean(p.recommend),
    organize: clean(p.organize),
  });
}

// ===========================================================================
// AI command center  (POST /api/ai/agent)
// ---------------------------------------------------------------------------
// The "just tell it what you want" brain. Unlike the narrow command bar, this
// hands Gemini the WHOLE picture in one shot — every open conversation's recent
// messages, voicemail/photo flags, lead status and tags, plus the money summary
// — and asks it to either ANSWER (ranking leads, "how much did I make this
// month", advice) or PROPOSE actions Mikey approves. It never executes on its
// own: proposed actions come back to the UI, and only run on a second confirm
// call. This mirrors how production AI assistants work (rich context + tool-
// style actions + human-in-the-loop), while staying on a single Gemini call so
// it's fast and cheap.
// ===========================================================================

// Load many threads without hammering KV serially — small parallel batches.
async function batchLoadThreads(phones) {
  const out = [];
  const chunk = 15;
  for (let i = 0; i < phones.length; i += chunk) {
    const part = await Promise.all(phones.slice(i, i + chunk).map((p) => loadThread(p).catch(() => null)));
    for (const t of part) if (t) out.push(t);
  }
  return out;
}

// This month + last month rollups and recent entries, for money questions and
// logging. Reuses the same summarizeMonth the Money tab shows, so numbers match.
async function agentMoney(cfg, now) {
  const tz = cfg.tz;
  const thisM = localDateStr(now, tz).slice(0, 7);
  const lastM = prevMonthKey(thisM);
  const [dThis, dLast] = await Promise.all([loadMonth(thisM), loadMonth(lastM)]);
  const sThis = summarizeMonth(dThis.entries);
  const sLast = summarizeMonth(dLast.entries);
  const recent = (dThis.entries || []).slice(-8).reverse().map((e) => ({
    date: e.date, type: e.type, amount: e.amount, cat: e.cat, service: e.service, note: e.note, name: e.name,
  }));
  return { thisMonth: thisM, thisSummary: sThis, lastMonth: lastM, lastSummary: sLast, recent, today: localDateStr(now, tz) };
}

// The single big context string handed to Gemini. Small businesses have few
// enough threads that stuffing the whole board (capped) beats a fragile multi-
// call tool loop — and it makes the model genuinely situationally aware.
async function buildAgentContext({ index, cfg, now, money }) {
  const L = [];
  const bc = businessContext(cfg); if (bc) L.push(bc);
  const rc = await rulesContext(); if (rc) L.push(rc);
  L.push(opsPlaybook());
  L.push('');
  const m = money;
  const fmt = (s) => `gross $${s.gross}, expenses $${s.exp}, labor $${s.jp}, NET $${s.net}, ${s.jobs} job(s)` + (s.owed ? `, $${s.owed} still owed` : '');
  L.push('MONEY (from the money tracker — these figures are exact, use them for money questions):');
  L.push(`  This month (${m.thisMonth}): ${fmt(m.thisSummary)}. Personal spend $${m.thisSummary.personal}.`);
  L.push(`  Last month (${m.lastMonth}): ${fmt(m.lastSummary)}.`);
  if (m.recent.length) {
    L.push('  Recent entries this month:');
    m.recent.forEach((e) => L.push(`   - ${e.date} ${e.type} $${e.amount}${e.cat ? (' ' + e.cat) : ''}${e.service ? (' ' + e.service) : ''}${e.note ? (' "' + e.note + '"') : ''}${e.name ? (' [' + e.name + ']') : ''}`));
  }
  L.push(`  To LOG money: entry types = job (income), exp (expense — needs a category), jp (labor pay), personal. Expense categories: ${MONEY_CATS.join(', ')}. Today is ${m.today}.`);
  L.push('');
  const open = index.filter((e) => !e.archived).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const cap = 60;
  const top = open.slice(0, cap);
  const threads = await batchLoadThreads(top.map((r) => r.phone));
  const tById = new Map(threads.map((t) => [t.phone, t]));
  L.push(`OPEN CONVERSATIONS (${open.length} total; showing the ${top.length} most recent). Use the exact phone= value as the handle when proposing an action on a conversation:`);
  top.forEach((r) => {
    const t = tById.get(r.phone);
    const ago = humanAgo(now - (r.lastTs || now));
    const wait = r.lastDir !== 'in' ? `you replied ${ago} ago`
      : r.awaitingReply === false ? `they wrote ${ago} ago, nothing owed (${r.closedReason || 'wrapped up'})`
      : `WAITING ${ago} for your reply`;
    const flags = [];
    const hasVm = r.hasVoicemail || (t && (t.messages || []).some((x) => x.kind === 'voicemail'));
    const hasPh = r.hasMedia || (t && (t.messages || []).some((x) => Array.isArray(x.media) && x.media.length));
    if (hasVm) flags.push('has-voicemail');
    if (hasPh) flags.push('has-photo');
    if (r.unread) flags.push('unread');
    if (r.pinned) flags.push('pinned');
    if (r.dateRequested) flags.push('ready-to-book');
    // Mikey's own standing instruction travels with the conversation, so the AI
    // reasons about a parked customer instead of re-suggesting them every time.
    const heldNote = (r.heldUntil && r.heldUntil > now)
      ? ` | ON HOLD until ${new Date(r.heldUntil).toISOString().slice(0, 10)}${r.holdReason ? ` because "${r.holdReason}"` : ''} — Mikey decided this; do not propose chasing, replying to, archiving or re-statusing them`
      : '';
    L.push(`- ${r.name || r.phone} | phone=${r.phone} | status=${r.status || 'NONE'} | tags=[${(r.tags || []).join(', ')}] | ${wait}${flags.length ? (' | ' + flags.join(', ')) : ''}${heldNote}`);
    if (t) {
      (t.messages || []).slice(-4).forEach((msg) => {
        const who = msg.dir === 'in' ? 'CUST' : msg.dir === 'out' ? 'YOU' : 'SYS';
        let b = msg.body || '';
        if (msg.kind === 'voicemail') b = '[VOICEMAIL] ' + b;
        if (Array.isArray(msg.media) && msg.media.length) b = '[PHOTO] ' + b;
        L.push(`      ${who}: ${String(b).replace(/\s+/g, ' ').slice(0, 140)}`);
      });
    }
  });
  const archAll = index.filter((e) => e.archived);
  if (archAll.length) {
    const arch = archAll.slice(0, 40);
    L.push('');
    L.push(`ARCHIVED (${archAll.length} total; first ${arch.length}):`);
    arch.forEach((r) => L.push(`- ${r.name || r.phone} | phone=${r.phone} | status=${r.status || 'NONE'}`));
  }
  return L.join('\n');
}

function convActionLabel(op, name, act) {
  switch (op) {
    case 'archive':      return 'Archive ' + name;
    case 'unarchive':    return 'Restore ' + name;
    case 'mark_read':    return 'Mark ' + name + ' read';
    case 'mark_unread':  return 'Mark ' + name + ' unread';
    case 'pin':          return 'Pin ' + name;
    case 'unpin':        return 'Unpin ' + name;
    case 'set_status':   return 'Set ' + name + ' → ' + act.status;
    case 'add_tags':     return 'Label ' + name + ': ' + (act.tags || []).join(', ');
    case 'remove_tags':  return 'Unlabel ' + name + ': ' + (act.tags || []).join(', ');
    case 'hold':         return 'Leave ' + name + ' alone until ' +
                                new Date(act.holdUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
                                (act.reason ? ' — ' + act.reason : '');
    case 'release':      return 'Put ' + name + ' back on the list';
    default:             return op + ' ' + name;
  }
}
function moneyActionLabel(entry) {
  const t = entry.type === 'job' ? 'Income' : entry.type === 'jp' ? 'Labor pay' : entry.type === 'personal' ? 'Personal' : 'Expense';
  return 'Log ' + t + ' $' + entry.amount + (entry.cat ? (' · ' + entry.cat) : '') + (entry.service ? (' · ' + entry.service) : '') + (entry.note ? (' · ' + entry.note) : '');
}

// Validate + clean the model's proposed actions into a safe, executable list,
// attaching a human label for the approval UI. Unknown ops / bad shapes drop out.
const AGENT_CONV_OPS = ['archive', 'unarchive', 'mark_read', 'mark_unread', 'pin', 'unpin', 'set_status', 'add_tags', 'remove_tags', 'hold', 'release'];
function normalizeAgentActions(list, index) {
  const byPhone = index ? new Map(index.map((e) => [e.phone, e])) : null;
  const out = [];
  for (const a of (Array.isArray(list) ? list : [])) {
    if (!a || typeof a !== 'object') continue;
    const op = String(a.op || '');
    if (op === 'remember_rule' || op === 'forget_rule') {
      const text = String(a.text || '').trim().slice(0, 200);
      if (!text) continue;
      out.push({ op, text, reason: String(a.reason || '').slice(0, 160),
                 label: (op === 'remember_rule' ? 'Remember: ' : 'Forget the rule: ') + text });
      continue;
    }
    if (op === 'log_money') {
      const e = a.entry || {};
      const amount = money2(e.amount);
      if (!(amount > 0)) continue;
      const type = MONEY_TYPES.includes(e.type) ? e.type : 'exp';
      const entry = { type, amount };
      if (type === 'exp') entry.cat = MONEY_CATS.includes(e.cat) ? e.cat : 'misc';
      if (e.service) entry.service = String(e.service).slice(0, 32);
      if (e.note) entry.note = String(e.note).slice(0, 200);
      if (e.name) entry.name = String(e.name).slice(0, 60);
      if (e.phone) { const ph = normalizePhone(e.phone); if (ph) entry.phone = ph; }
      if (e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) entry.date = e.date;
      out.push({ op, entry, reason: String(a.reason || '').slice(0, 160), label: moneyActionLabel(entry) });
    } else if (AGENT_CONV_OPS.includes(op)) {
      const phone = normalizePhone(a.phone) || a.phone;
      if (!phone) continue;
      const act = { op, phone, reason: String(a.reason || '').slice(0, 160) };
      if (op === 'set_status') { if (!CMD_STATUSES.includes(a.status)) continue; act.status = a.status; }
      if (op === 'hold') {
        // No usable date means we'd silence someone forever — drop the action
        // rather than guess.
        act.holdUntil = parseHoldUntil(a.until, a.holdDays);
        if (!act.holdUntil) continue;
        act.reason = String(a.reason || '').trim().slice(0, 140);
      }
      if (op === 'add_tags' || op === 'remove_tags') {
        const tags = (Array.isArray(a.tags) ? a.tags : []).map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 10);
        if (!tags.length) continue;
        act.tags = tags;
      }
      const row = byPhone ? byPhone.get(phone) : null;
      act.label = convActionLabel(op, (row && (row.name || row.phone)) || phone, act);
      out.push(act);
    }
    if (out.length >= 200) break;
  }
  return out;
}

// Run an approved action list. Conversation ops are grouped per phone (one load/
// save/index-apply each) and the index is written once; money entries append to
// their month doc. Returns a friendly summary of what changed.
async function executeAgentActions(actions, cfg) {
  const now = Date.now();
  const ruleActs = actions.filter((a) => a.op === 'remember_rule' || a.op === 'forget_rule');
  const convActs = actions.filter((a) => a.op !== 'log_money' && a.op !== 'remember_rule' && a.op !== 'forget_rule');
  const moneyActs = actions.filter((a) => a.op === 'log_money');
  let nRules = 0;
  for (const a of ruleActs) {
    const r = a.op === 'remember_rule' ? await addRule(a.text) : await removeRule(a.text);
    if (r) nRules++;
  }
  const index = await loadIndex();
  let convChanged = false, nConv = 0, nMoney = 0;
  const errors = [];
  const phones = [...new Set(convActs.map((a) => normalizePhone(a.phone) || a.phone).filter(Boolean))];
  for (const phone of phones) {
    const thread = await loadThread(phone);
    let ch = false;
    for (const a of convActs.filter((x) => (normalizePhone(x.phone) || x.phone) === phone)) {
      switch (a.op) {
        case 'archive':     if (!thread.archived) { thread.archived = true; ch = true; } break;
        case 'unarchive':   if (thread.archived) { thread.archived = false; ch = true; } break;
        case 'mark_read':   if (thread.unread) { thread.unread = 0; ch = true; } break;
        case 'mark_unread': if (!thread.unread) { thread.unread = 1; ch = true; } break;
        case 'pin':         if (!thread.pinned) { thread.pinned = true; ch = true; } break;
        case 'unpin':       if (thread.pinned) { thread.pinned = false; ch = true; } break;
        case 'set_status':  if (CMD_STATUSES.includes(a.status) && thread.status !== a.status) { thread.status = a.status; thread.statusAt = now; ch = true; } break;
        case 'add_tags': {
          const cur = new Set((thread.tags || []).map(String));
          (a.tags || []).forEach((t) => { const v = String(t).trim().slice(0, 24); if (v) cur.add(v); });
          const arr = [...cur].slice(0, 20);
          if (JSON.stringify(arr) !== JSON.stringify(thread.tags || [])) { thread.tags = arr; ch = true; }
          break;
        }
        case 'remove_tags': {
          const rm = new Set((a.tags || []).map((t) => String(t).trim().toLowerCase()));
          const arr = (thread.tags || []).filter((t) => !rm.has(String(t).trim().toLowerCase()));
          if (arr.length !== (thread.tags || []).length) { thread.tags = arr; ch = true; }
          break;
        }
        case 'hold': {
          if (a.holdUntil > now) {
            const fu = thread.followup || (thread.followup = defaultFollowup());
            fu.snoozeUntil = a.holdUntil; fu.holdReason = a.reason || ''; fu.heldAt = now; fu.suggestion = null;
            ch = true;
          }
          break;
        }
        case 'release': {
          const fu = thread.followup;
          if (fu && (fu.snoozeUntil || fu.holdReason)) { fu.snoozeUntil = null; fu.holdReason = ''; fu.heldAt = 0; ch = true; }
          break;
        }
        default: break;
      }
    }
    if (ch) { await saveThread(thread); if (applyIndexSummary(index, buildIndexSummary(thread, cfg))) convChanged = true; nConv++; }
  }
  if (convChanged) await saveIndex(index);
  // Money: group by month so each month doc is written once.
  const byMonth = {};
  for (const a of moneyActs) {
    const e = a.entry || {};
    const date = (e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) ? e.date : localDateStr(now, cfg.tz);
    const clean = sanitizeMoneyEntry(Object.assign({}, e, { date }), null);
    if (!clean) { errors.push('skipped a money entry (bad amount/type)'); continue; }
    const month = clean.date.slice(0, 7);
    (byMonth[month] = byMonth[month] || []).push(clean);
  }
  for (const month of Object.keys(byMonth)) {
    const doc = await loadMonth(month);
    for (const clean of byMonth[month]) { doc.entries.push(clean); nMoney++; }
    await saveMonth(month, doc);
  }
  const parts = [];
  if (nConv) parts.push(nConv + ' conversation' + (nConv > 1 ? 's' : '') + ' updated');
  if (nMoney) parts.push(nMoney + ' money entr' + (nMoney > 1 ? 'ies' : 'y') + ' logged');
  if (nRules) parts.push(nRules + ' rule' + (nRules > 1 ? 's' : '') + ' saved — I\'ll follow that from now on');
  let reply = parts.length ? ('Done — ' + parts.join(' and ') + '.') : 'Nothing needed changing.';
  if (errors.length) reply += ' (' + errors.join('; ') + ')';
  return { reply, nConv, nMoney, nRules };
}

async function apiAiAgent(request) {
  const data = await readJson(request);
  // Phase 2 — execute the actions Mikey approved.
  if (data.confirm && Array.isArray(data.actions)) {
    const cfg = await loadConfig();
    const acts = normalizeAgentActions(data.actions, null);
    if (!acts.length) return json({ ok: false, error: 'no_valid_actions' }, 422);
    try {
      const r = await executeAgentActions(acts, cfg);
      return json({ ok: true, done: true, reply: r.reply, nConv: r.nConv, nMoney: r.nMoney });
    } catch (err) {
      return json({ ok: false, error: String(err.message || err) }, 502);
    }
  }
  // Phase 1 — understand + answer, and optionally propose actions.
  const text = String(data.text || '').trim();
  if (!text) return json({ ok: false, error: 'empty' }, 422);
  if (!ENV.GEMINI_API_KEY) return json({ ok: false, error: 'ai_not_configured' }, 503);
  const cfg = await loadConfig();
  const index = await loadIndex();
  const now = Date.now();
  const money = await agentMoney(cfg, now);
  const ctx = await buildAgentContext({ index, cfg, now, money });
  const prompt =
    ctx + '\n\n' +
    'YOU ARE THE COMMAND-CENTER AI for this dashboard. Two jobs: ANSWER questions from the data above, and PROPOSE actions Mikey can approve. You NEVER perform actions yourself — everything you list is shown to Mikey and only runs if he approves it.\n' +
    'Respond with ONLY JSON (no prose, no code fences):\n' +
    '{"answer":"your reply to Mikey — ALWAYS fill this in: answer the question fully, or clearly summarize what you\'re about to do and why","actions":[{"op":"...","phone":"exact phone from a conversation","status":"new|active|won|lost","tags":["..."],"entry":{"type":"job|exp|jp|personal","amount":0,"cat":"","service":"","note":"","name":""},"reason":"short why"}]}\n' +
    'Conversation ops (need phone=): archive, unarchive, mark_read, mark_unread, pin, unpin, set_status (+status), add_tags (+tags), remove_tags (+tags), hold (+until +reason), release. Money op: log_money (+entry). Rule ops (no phone): remember_rule (+text), forget_rule (+text).\n' +
    'RULES HE TELLS YOU OUTRIGHT: when Mikey states a preference about how you write or price — "stop using exclamation points", "never quote a full detail under $150", "always mention I bring my own water", "don\'t send payment links to Tanya" — propose remember_rule with "text" set to the rule in one short imperative sentence. When he takes one back ("you can use exclamation points again", "forget that pricing rule"), propose forget_rule with the text of the rule to drop. State in "answer" exactly what you are about to remember, word for word, so he can correct it before approving.\n' +
    `Today is ${new Date().toISOString().slice(0, 10)}.\n` +
    'STANDING INSTRUCTIONS — this is how Mikey tells you to remember something:\n' +
    '- When he says a customer is handled, taken care of, doesn\'t need a reply, or shouldn\'t be chased until later — "Sabine doesn\'t need responded to, I\'m doing her car in August", "leave Rick alone till spring", "don\'t bug the Hendersons for a couple weeks" — propose op "hold" for that phone, with "until" as a YYYY-MM-DD date and "reason" as a SHORT phrase in HIS words ("doing her car in August"). A bare month means the 1st; "spring" means Mar 1; "a couple weeks" means 14 days from today (use "holdDays":14 instead of a date).\n' +
    '- Say plainly in "answer" what you understood, including the date and the reason, so he can correct you before approving.\n' +
    '- "start chasing X again / never mind about X / put X back on the list" -> op "release".\n' +
    '- Anyone in ON HOLD has already been decided by Mikey. Never propose replying to, chasing, archiving or re-statusing them, and never list them as needing attention. If something genuinely new happened that his reason plainly doesn\'t cover, say so in "answer" and repeat his own reason back first — do not turn it into an action.\n' +
    'Rules:\n' +
    '- Pure question or ranking ("how much did I make this month", "rank my leads highest to lowest priority") → put the full answer in "answer" and leave "actions" empty.\n' +
    '- Reference conversations ONLY by an exact phone= shown above. Never invent people, phone numbers, or money figures.\n' +
    '- "conversations with a voicemail" = threads flagged has-voicemail; "photos" = has-photo.\n' +
    '- Labeling leads: use add_tags with 1-3 short, consistent tags grounded in the actual messages (vehicle type, service interest, or a stage like "hot-lead"/"needs-callback").\n' +
    '- Prioritize by the operating principles: customers waiting for a reply first, keep every open lead statused, keep the inbox clean.\n' +
    '- Money: amounts are positive numbers; expense entries need a category from the list; use today\'s date unless Mikey specifies one.\n' +
    '- Only propose actions Mikey actually asked for or that directly serve his request. If you are unsure, ask in "answer" instead of guessing with actions.\n\n' +
    'MIKEY SAYS: ' + JSON.stringify(text);
  let raw;
  try { raw = await geminiGenerate(prompt, { surface: 'agent', json: true, maxTokens: 4096, temperature: 0.2 }); }
  catch (err) { return json({ ok: false, error: String(err.message || err) }, 502); }
  let p = {};
  try { p = JSON.parse(raw); } catch { return json({ ok: false, error: 'ai_parse_failed', raw: String(raw).slice(0, 400) }, 502); }
  const actions = normalizeAgentActions(p.actions, index);
  return json({ ok: true, answer: String(p.answer || '').slice(0, 4000), actions });
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
  const spend = await customerSpend(phone, cfg);
  const prompt = businessContext(cfg) +
    (await rulesContext()) +
    customerContext(thread, spend) +
    `You are Mikey from Mikey's Mobile Detailing, looking at a photo a customer just texted of their vehicle. ` +
    `Return ONLY JSON: {"assessment":"2-3 sentences on the vehicle type and its VISIBLE condition (dirt, swirls, stains, oxidation, etc.)", ` +
    `"services":["recommended services drawn from the playbook that fit what you see"], ` +
    `"draft":"a warm 1-3 sentence text reply that acknowledges the vehicle, notes what you'd focus on, and says you'll confirm the exact price — NEVER state a specific price or appointment time"}. ` +
    `Base everything only on what is actually visible.\n\nConversation so far:\n${transcript(thread)}`;
  try {
    const text = await geminiGenerate(prompt, { surface: 'photo quote', json: true, maxTokens: 1200, images: [{ mimeType: pic.mimeType, dataB64: pic.dataB64 }] });
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
  const spend = await customerSpend(phone, cfg);
  const prompt =
    businessContext(cfg) +
    (await rulesContext()) +
    customerContext(thread, spend) +
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
    const text = await geminiGenerate(prompt, { surface: 'coach', json: true, maxTokens: 1500 });
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

// Money Brain: AI reads the last 6 months of real numbers and hands back a
// headline + wins + watch-outs + next moves. Cached per-day in KV so casual
// opens are free; pass {refresh:true} to force a fresh read.
async function apiAiMoney(request) {
  let body = {};
  try { body = await readJson(request); } catch { body = {}; }
  const mainCfg = await loadConfig();
  const today = localDateStr(Date.now(), mainCfg.tz);
  const cacheKey = 'money:ai:' + today;
  if (!body.refresh) {
    const hit = await kv().get(cacheKey, { type: 'json' });
    if (hit) return json(Object.assign({ ok: true, cached: true }, hit));
  }
  const cfg = await loadMoneyConfig();
  const sp = moneySplit(cfg);
  let mk = today.slice(0, 7);
  const lines = [];
  let cur = null;
  for (let i = 0; i < 6; i++) {
    const s = summarizeMonth((await loadMonth(mk)).entries);
    if (i === 0) cur = s;
    const cats = Object.keys(s.byCat).sort((a, b) => s.byCat[b] - s.byCat[a]).slice(0, 3)
      .map((c) => `${c} $${s.byCat[c]}`).join(', ');
    lines.unshift(`${mk}: gross $${s.gross}, jobs ${s.jobs}, labor $${s.jp}, expenses $${s.exp} (${cats || 'none'}), net $${s.net}${s.owed ? `, still owed $${s.owed}` : ''}`);
    mk = prevMonthKey(mk);
  }
  const prompt =
    `You are the money brain for Mikey's Mobile Detailing, a small mobile car-detailing business. ` +
    `Their income auto-sorts ${sp.costs}% costs / ${sp.you}% owner's pay / ${sp.savings}% savings (no separate tax bucket). ` +
    `Today is ${today}. Six months of real numbers, oldest first:\n${lines.join('\n')}\n\n` +
    `Return ONLY JSON: {"headline":"one punchy sentence on how the business is doing right now", ` +
    `"wins":["1-3 short specific things going well, with numbers"], ` +
    `"watch":["1-3 short specific things to watch out for, with numbers"], ` +
    `"moves":["2-3 concrete money moves for this week, imperative voice"]}\n` +
    `Be specific to THESE numbers (call out trends, spikes, the food/misc leak, unpaid balances). ` +
    `Plain language, no jargon, no invented numbers.`;
  try {
    const text = await geminiGenerate(prompt, { surface: 'money advisor', json: true, maxTokens: 1200 });
    let p = {};
    try { p = JSON.parse(text); } catch { p = {}; }
    const arr = (v, n) => Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, n) : [];
    const out = {
      headline: String(p.headline || '').trim().slice(0, 200),
      wins: arr(p.wins, 3), watch: arr(p.watch, 3), moves: arr(p.moves, 3),
      at: today, net: cur ? cur.net : 0,
    };
    if (out.headline) await kv().put(cacheKey, JSON.stringify(out), { expirationTtl: 172800 });
    return json(Object.assign({ ok: true }, out));
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
// "Does this actually need a reply?" — conversation-closure check
// ---------------------------------------------------------------------------
// The follow-up engine used to treat ANY conversation whose last message came
// from the customer as a reply Mikey owes. So a thread that ended with
// "Thanks! 🙂", a 👍, or a "Liked ..." tapback sat in "Needs your attention"
// forever and kept generating nudges nobody should send.
//
// Before an `owed` step is surfaced we now read the WHOLE conversation and ask:
// is anything actually outstanding on Mikey's side? The verdict is cached on the
// thread against the exact inbound message it was made for, so it costs at most
// one small AI call per customer message — and none at all for the obvious
// cases (a question mark, a photo, a voicemail: always needs a reply).
//
// Bias: when it's genuinely unclear we answer "yes, reply". Nagging Mikey about
// a wrapped-up thread is annoying; missing a real customer costs a booking.
// ===========================================================================

// iMessage/Android tapbacks arrive as literal text ('Liked "see you then"').
const REACTION_RE = /^(liked|loved|laughed at|emphasi[sz]ed|disliked|questioned)\s+["“”']/i;

// Lowercase, drop emoji and punctuation (keeping "?"), collapse whitespace.
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, ' ')
    .replace(/[^a-z0-9?'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fast "this obviously needs an answer" test. Only ever used to SKIP the AI call
// and keep the nudge — so a false positive costs nothing but an extra reminder.
function looksLikeQuestion(body) {
  const t = normText(body);
  if (!t) return false;
  if (t.includes('?')) return true;
  return /\b(how much|how many|how long|what time|what day|what about|when can|when are|when will|where|can you|could you|would you|will you|do you|did you|does that|are you|is it|is that|price|quote|cost|estimate|available|availability|schedule|book|booking|appointment|reschedule|call me|text me|let me know|send me|i need|we need|i want|id like|i'd like|im looking|i'm looking|looking for|interested)\b/.test(t);
}

// Words that carry no ask on their own. A message made up entirely of these is a
// sign-off, not a question. Deliberately conservative: bare agreements ("yes",
// "sure", "that works") are NOT here, because after "does Saturday work?" they
// still need Mikey to confirm. Only used as the offline fallback when the AI
// can't be reached — the AI itself reads the whole conversation.
const CLOSER_WORDS = new Set([
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'tysm', 'appreciate', 'appreciated', 'thankful',
  'you', 'u', 'so', 'much', 'very', 'again', 'a', 'lot', 'the', 'my', 'me', 'im', 'i', 'it', 'that', 'thats', 'this',
  'ok', 'okay', 'k', 'kk', 'cool', 'alright', 'got', 'sounds', 'sound', 'good', 'well',
  'great', 'perfect', 'awesome', 'nice', 'sweet', 'excellent', 'wonderful', 'amazing', 'beautiful', 'love', 'loved', 'lovely',
  'no', 'nope', 'problem', 'worries', 'np', 'nvm', 'mind',
  'see', 'ya', 'then', 'later', 'soon', 'there', 'sir', 'maam', 'man', 'bro', 'dude', 'buddy',
  'have', 'day', 'night', 'weekend', 'one', 'take', 'care', 'too', 'and', 'best', 'cheers',
  'welcome', 'youre', 'yw', 'copy', 'understood', 'roger', 'will', 'do', 'talk', 'bye', 'goodbye',
]);
function isClosingRemark(body) {
  const raw = String(body || '').trim();
  if (REACTION_RE.test(raw)) return true;      // tapback reaction
  const t = normText(raw);
  if (!t) return true;                          // emoji-only / sticker / blank
  if (t.includes('?')) return false;
  const words = t.split(' ').map((w) => w.replace(/'/g, '')).filter(Boolean);
  if (words.length > 10) return false;          // a real paragraph is never a sign-off
  return words.every((w) => CLOSER_WORDS.has(w));
}

// Ask Gemini to read the whole conversation and rule on whether Mikey still owes
// the customer something. Returns { needed, reason }. Throws if the AI is
// unavailable so the caller can fall back to the heuristic above.
async function judgeReplyNeeded(thread, cfg) {
  const prompt =
    businessContext(cfg) +
    `You are triaging text conversations for Mikey's Mobile Detailing so Mikey only gets reminded about the ones that still need him.\n\n` +
    `Read the conversation below, then decide ONE thing: after the customer's most recent message, is there still something for Mikey to answer or do?\n\n` +
    `Answer "needsReply": false when the conversation has reached a natural resting point — for example:\n` +
    `- the customer's last message is just thanks, praise, or an acknowledgement ("thanks!", "ok", "sounds good", "perfect", "👍")\n` +
    `- it is a reaction/tapback (a message that starts with Liked/Loved/Laughed at)\n` +
    `- it simply closes out a question Mikey already answered, and nothing new was raised\n` +
    `- it is friendly small talk that asks for nothing, and Mikey owes nothing\n\n` +
    `Answer "needsReply": true when anything is still open — for example:\n` +
    `- they asked a question, or asked about price, availability, timing, or booking\n` +
    `- they raised a problem, complaint, or concern\n` +
    `- they sent photos or a voicemail for a quote\n` +
    `- they agreed to something that still needs Mikey to confirm a specific date, time, address, or price\n` +
    `- Mikey's last message promised something (a quote, a time, a call back) that he has not delivered yet\n\n` +
    `If you are genuinely unsure, answer true — missing a real customer is worse than an extra reminder.\n\n` +
    `Return ONLY JSON: {"needsReply": true|false, "reason": "<plain English, max 10 words, why>"}\n\n` +
    `Conversation (the recent messages, oldest to newest):\n${transcript(thread, AI_CLASSIFY_TURNS)}\n`;
  const raw = await geminiGenerate(prompt, { surface: 'reply check', json: true, maxTokens: 300, temperature: 0.1 });
  const p = JSON.parse(raw);
  return {
    needed: p.needsReply !== false,
    reason: String(p.reason || '').trim().slice(0, 90) || (p.needsReply === false ? 'Conversation wrapped up' : 'Something is still open'),
  };
}

// The cached verdict for the CURRENT last inbound message, or null.
function replyCheckFor(thread) {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.dir !== 'in') return null;
  const rc = thread.replyCheck;
  return (rc && rc.forTs === last.ts) ? rc : null;
}

// ===========================================================================
// Conversation recap — "what happened here, in one line"
// ---------------------------------------------------------------------------
// The swipe-left peek can show WHAT IS TRUE of a customer (booked Thursday,
// quoted $240) straight off the index row, but not what actually HAPPENED
// between the two of you. That's the part you're really trying to remember:
// "he asked about ceramic, you said you'd price it Thursday".
//
// Cached against the last message's timestamp, exactly like replyCheck: a new
// message in either direction invalidates it, so a stale recap can't outlive
// the conversation it describes. One AI call per conversation per new message,
// and only when something actually asks for it.
// ===========================================================================
function recapFor(thread) {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const r = thread.recap;
  return (r && r.forTs === last.ts && r.text) ? r : null;
}

async function ensureRecap(thread, cfg) {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return false;                 // nothing has happened yet
  if (recapFor(thread)) return false;      // already summarised this exact state
  if (!ENV.GEMINI_API_KEY) return false;   // no key — the card falls back to the last message

  const who = (thread.name || '').trim().split(/\s+/)[0] || 'they';
  const prompt =
    businessContext(cfg) +
    `You are reminding Mikey (mobile car detailer) what happened with one customer, ` +
    `so he can place them at a glance while scrolling his texts.\n\n` +
    `Write ONE short sentence — 14 words maximum — saying what happened and where it ` +
    `stands. Write it the way you'd remind a friend, e.g.:\n` +
    `  "asked about ceramic on his truck, you said you'd price it Thursday"\n` +
    `  "job finished, he Venmo'd you $180"\n` +
    `  "wanted a Saturday slot, you offered Tuesday, no answer since"\n\n` +
    `Rules:\n` +
    `- Past tense. What HAPPENED, not what to do next.\n` +
    `- Concrete beats vague: name the vehicle, the service, the dollar amount when they're known.\n` +
    `- Say who did what. Call the customer "${who}" or "he"/"she"/"they"; call Mikey "you".\n` +
    `- No greeting, no "the customer", no advice, no quotation marks, no trailing period needed.\n` +
    `- If they only just reached out and nothing has been settled, say that plainly.\n\n` +
    `Return ONLY JSON: {"recap":"..."}\n\n` +
    `Conversation:\n${transcript(thread, AI_CLASSIFY_TURNS)}`;

  let text = '';
  try {
    const raw = await geminiGenerate(prompt, { surface: 'recap', json: true, maxTokens: 200 });
    try { text = String(JSON.parse(raw).recap || '').trim(); }
    catch { text = String(raw || '').trim(); }
  } catch {
    return false;                          // AI unreachable — leave it uncached and try again later
  }
  text = text.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 160);
  if (!text) return false;
  thread.recap = { forTs: last.ts, at: Date.now(), text };
  return true;
}

// POST /api/ai/recap {phone} — used by the conversation peek.
// Deliberately loads the thread with loadThread() rather than
// openThreadForRead(): the latter clears `unread`, and looking at a summary must
// never count as having read the conversation.
async function apiAiRecap(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const thread = await loadThread(phone);
  if (!(thread.messages || []).length) return json({ ok: true, recap: '' });
  const cached = recapFor(thread);
  if (cached) return json({ ok: true, recap: cached.text, cached: true });
  const cfg = await loadConfig();
  if (await ensureRecap(thread, cfg)) {
    await saveThread(thread);
    await updateIndexEntry(thread);
    return json({ ok: true, recap: (thread.recap || {}).text || '' });
  }
  return json({ ok: true, recap: '', error: ENV.GEMINI_API_KEY ? 'ai_failed' : 'ai_not_configured' });
}

// Sync read used by the (sync) follow-up planner and the index builder.
// Un-judged threads default to "yes" — identical to the old behavior.
function replyOwed(thread) {
  const rc = replyCheckFor(thread);
  return rc ? rc.needed !== false : true;
}

// Same question against a cheap INDEX ROW (which carries the cached verdict as
// `awaitingReply`). Use this everywhere "is someone waiting on me?" is counted —
// the Home rundown, the daily brief, push notifications, the AI advisor — so
// they all agree. Rows written before this shipped have no flag: treated as
// waiting, exactly like before.
function rowAwaitingReply(e) {
  return !!e && e.lastDir === 'in' && e.awaitingReply !== false;
}

// Make sure the current last inbound message has a verdict. Returns whether the
// thread was mutated (so callers can batch the KV write). At most one AI call
// per inbound message, ever — the verdict is keyed to that message's timestamp.
async function ensureReplyCheck(thread, cfg) {
  const msgs = thread.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || last.dir !== 'in') return false;   // Mikey spoke last — nothing to judge
  if (replyCheckFor(thread)) return false;        // already judged this message

  let verdict;
  if (last.kind === 'opt-out' || last.kind === 'opt-in') {
    verdict = { needed: false, reason: 'STOP/START keyword — no reply', via: 'rule' };
  } else if (last.kind === 'voicemail' || (Array.isArray(last.media) && last.media.length)) {
    verdict = { needed: true, reason: 'Voicemail or photo to respond to', via: 'rule' };
  } else if (looksLikeQuestion(last.body)) {
    verdict = { needed: true, reason: 'They asked you something', via: 'rule' };
  } else if (!ENV.GEMINI_API_KEY) {
    verdict = isClosingRemark(last.body)
      ? { needed: false, reason: 'Wrapped up — nothing asked', via: 'rule' }
      : { needed: true, reason: 'Waiting on you', via: 'rule' };
  } else {
    try {
      verdict = Object.assign({ via: 'ai' }, await judgeReplyNeeded(thread, cfg));
    } catch {
      // AI unreachable — fall back to the heuristic rather than nagging blindly.
      verdict = isClosingRemark(last.body)
        ? { needed: false, reason: 'Wrapped up — nothing asked', via: 'rule' }
        : { needed: true, reason: 'Waiting on you', via: 'rule' };
    }
  }
  thread.replyCheck = { forTs: last.ts, at: Date.now(), needed: verdict.needed, reason: verdict.reason, via: verdict.via };
  return true;
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
  //    ...but only when a reply is genuinely outstanding. A thread that ended on
  //    "Thanks!" or a 👍 is at rest: fall through so the Won/Lost lifecycle can
  //    still run (a review ask is legitimate) while never starting a nudge chase
  //    — the chase below requires Mikey to have spoken last anyway.
  if (last.dir === 'in') {
    if (replyOwed(thread)) {
      return done({ stage: 'owed', step: 0, stepKey: 'owed:' + last.ts, dueAt: last.ts + FOLLOWUP.OWED_DELAY_MS, urgency: 'high', auto: false });
    }
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
  // See tzFmt: the formatter is cached, because inQuietHours asks this on every
  // autopilot candidate on every tick.
  const f = tzFmt('hour', tz);
  return f ? parseInt(f.format(new Date(ts)), 10) % 24 : new Date(ts).getUTCHours();
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
  if (opts.ai === false || !aiConfigured()) return tmpl;

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
    const t = (await geminiGenerate(prompt, { surface: 'follow-up draft', temperature: 0.7, maxTokens: 500 })).replace(/^["']|["']$/g, '').trim();
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
  // Read the conversation first — a thread that ended on "Thanks!" should show no
  // nudge at all, even the instant it's opened.
  let changed = await ensureReplyCheck(thread, cfg);
  const plan = computeFollowupPlan(thread, now, cfg);
  const fu = thread.followup || (thread.followup = defaultFollowup());
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
  // Reading a conversation to decide whether it still needs a reply costs one AI
  // call. Cap it per tick so a big backlog (e.g. the first tick after this
  // shipped) spreads over a few minutes instead of stalling one cron run.
  let judgeBudget = 8;
  for (const e of index) {
    if (e.archived) continue;
    // Nothing to do this tick — skip WITHOUT touching KV. This is THE guard that
    // keeps us under the daily write budget (see the KV WRITE BUDGET note up top):
    // a thread is only worth loading if a nudge is already surfaced (followupDue)
    // or its next step has come due. Idle conversations — the vast majority, which
    // have followupNextAt=null because no follow-up applies — fall through here and
    // are never re-saved. (Stale suggestions still get cleared promptly: that
    // happens on the customer's inbound reply and whenever the thread is opened.)
    // ...with one addition: a conversation whose last message is the customer's
    // and that has never been read for "is anything still open?" is loaded once
    // so it can be judged (legacy threads, and anything whose nudge was already
    // skipped). Once judged the flag sticks in the index and it's skipped again.
    const dueNow = e.followupDue || !!(e.followupNextAt && e.followupNextAt <= now);
    const needsJudging = e.lastDir === 'in' && !e.replyChecked;
    if (!dueNow && !(needsJudging && judgeBudget > 0)) continue;

    const thread = await loadThread(e.phone);
    const fu = thread.followup || (thread.followup = defaultFollowup());
    // Legacy threads that had a status before this feature shipped have no
    // statusAt — anchor them to now so won/lost cadences start fresh, not in the past.
    if (thread.status && !thread.statusAt) thread.statusAt = now;

    // Before deciding anything, make sure we know whether this conversation is
    // actually still open. Skipped once the per-tick AI budget is spent — the
    // thread just gets judged on a later tick (nothing is sent meanwhile,
    // because an un-judged inbound-last thread only ever produces a suggestion).
    let changed = false; // only persist this thread if we actually mutate it
    const lastMsg = (thread.messages || [])[(thread.messages || []).length - 1];
    if (lastMsg && lastMsg.dir === 'in' && !replyCheckFor(thread) && judgeBudget > 0) {
      judgeBudget--;
      if (await ensureReplyCheck(thread, cfg)) changed = true;
    }
    const plan = computeFollowupPlan(thread, now, cfg);

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

// The standing rules Mikey has told the AI, so he can see and drop them without
// having to remember what he said three weeks ago.
async function apiRulesGet() {
  return json({ ok: true, rules: await loadRules() });
}
async function apiRulesPost(request) {
  const data = await readJson(request);
  if (data.remove) {
    const next = await removeRule(data.remove);
    return json({ ok: true, rules: next || (await loadRules()) });
  }
  const next = await addRule(data.text);
  if (!next) return json({ ok: false, error: 'empty' }, 422);
  return json({ ok: true, rules: next });
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
    // What the machine proposed, captured before the suggestion is cleared below, so
    // we can tell a nudge he rewrote from one he approved untouched.
    const machineDraft = (fu.suggestion && fu.suggestion.draft) || '';
    const stepKey = (fu.suggestion && fu.suggestion.stepKey) || (plan && plan.stepKey) || '';
    fu.lastStepKey = stepKey; fu.lastActionAt = now; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey, action: 'sent' });
    await saveThread(thread); // reserve before send
    // A nudge he rewrote before approving is his wording, so it counts as voice —
    // same reasoning as an edited draft. One he approved verbatim is the template's
    // words and stays out, which is why 'followup' is excluded from mining at all.
    const same = (a, b) => a.replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase();
    const tmpl = plan ? followupTemplate(thread, plan, cfg) : '';
    const hisWords = !same(body, machineDraft) && !same(body, tmpl);
    const msg = { id: genId(), dir: 'out', body, ts: now, kind: 'followup', status: 'sent' };
    if (hisWords) msg.src = 'manual'; // so a rebuild keeps it too (see voiceUsable)
    try {
      const r = await sendSms(phone, body);
      if (r && r.sid) msg.sid = r.sid;
      thread.messages.push(msg);
    } catch (err) {
      const optedOut = /opted_out/.test(String((err && err.message) || err));
      return json({ ok: false, error: optedOut ? 'recipient_opted_out' : String((err && err.message) || err) }, optedOut ? 409 : 502);
    }
    await saveThread(thread); await updateIndexEntry(thread);
    if (voiceUsable(msg)) { try { await recordVoiceSample(body, 'edited'); } catch { /* non-fatal */ } }
    return json({ ok: true, thread });
  }
  if (action === 'snooze') {
    const hours = Number(data.hours) || 24;
    fu.snoozeUntil = now + hours * 3600000; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey: (plan && plan.stepKey) || '', action: 'snoozed' });
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  // A hold is a snooze that carries Mikey's reason with it. Set from the thread
  // UI as well as from a plain-English command.
  if (action === 'hold') {
    const until = parseHoldUntil(data.until, data.days, now);
    if (!until) return json({ ok: false, error: 'bad_until' }, 422);
    fu.snoozeUntil = until;
    fu.holdReason = String(data.reason || '').trim().slice(0, 140);
    fu.heldAt = now; fu.suggestion = null;
    pushLog(fu, { at: now, stepKey: (plan && plan.stepKey) || '', action: 'held' });
    await saveThread(thread); await updateIndexEntry(thread);
    return json({ ok: true, thread });
  }
  if (action === 'release') {
    fu.snoozeUntil = null; fu.holdReason = ''; fu.heldAt = 0;
    pushLog(fu, { at: now, stepKey: '', action: 'released' });
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
  if (typeof data.autoReplyAlert === 'boolean') next.autoReplyAlert = data.autoReplyAlert;
  if (typeof data.predictive === 'boolean') next.predictive = data.predictive;
  if (typeof data.predictiveAi === 'boolean') next.predictiveAi = data.predictiveAi;
  if (typeof data.assistSms === 'boolean') next.assistSms = data.assistSms;
  if (data.assistDelaySec != null && !isNaN(+data.assistDelaySec)) next.assistDelaySec = Math.max(0, Math.min(600, Math.round(+data.assistDelaySec)));
  if (typeof data.assistEmail === 'boolean') next.assistEmail = data.assistEmail;
  if (data.assistEmailDelaySec != null && !isNaN(+data.assistEmailDelaySec)) next.assistEmailDelaySec = Math.max(0, Math.min(900, Math.round(+data.assistEmailDelaySec)));
  if (typeof data.teamMode === 'boolean') next.teamMode = data.teamMode;
  if (typeof data.briefEnabled === 'boolean') next.briefEnabled = data.briefEnabled;
  if (typeof data.dailyEmailsPaused === 'boolean') next.dailyEmailsPaused = data.dailyEmailsPaused;
  if (data.briefHour != null && !isNaN(+data.briefHour)) next.briefHour = Math.max(4, Math.min(11, Math.round(+data.briefHour)));
  if (Array.isArray(data.team)) next.team = sanitizeTeam(data.team);
  if (data.playbook && typeof data.playbook === 'object') next.playbook = sanitizePlaybook(data.playbook, next.playbook);
  if (data.detect && typeof data.detect === 'object') next.detect = sanitizeDetect(data.detect, next.detect);
  if (data.promise && typeof data.promise === 'object') next.promise = sanitizePromiseCfg(data.promise, next.promise);
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
// Money tracker
// ---------------------------------------------------------------------------
// A business-first profit ledger that lives as its own section in the dashboard.
// Design decisions come straight from Mikey's questionnaire: real monthly net
// (gross − JP labor − expenses), personal spending walled off in its own bucket,
// per-job JP cost for true job profit, no mileage, evening "log today?" reminder,
// weekly recap, won-lead "you never logged the $" nudges, CSV import/export, and
// a settings doc where every feature can be switched off.
//
// Storage (KV, write-frugal):
//   money:m:YYYY-MM — one doc per month { entries:[], rec:{recurringId:true} }.
//                     Written only on user actions and the once-a-month
//                     recurring-bill post.
//   money:cfg       — feature toggles, recurring bills, service types.
//   money:state     — { dailySent, weeklySentOn } reminder markers (≤2 writes/day).
// ===========================================================================
const MONEY_CFG_KEY = 'money:cfg';
const MONEY_STATE_KEY = 'money:state';
const MONEY_TYPES = ['job', 'jp', 'exp', 'personal'];
const MONEY_CATS = ['fuel', 'supplies', 'equipment', 'food', 'bills', 'marketing', 'insurance', 'phone', 'misc'];
const moneyKey = (m) => 'money:m:' + m;

function defaultMoneyConfig() {
  return {
    reminderEnabled: true,  // evening "log today's money?" nudge (via notifyMikey)
    reminderHour: 19,       // local hour it fires (only if nothing logged that day)
    weeklyEmail: true,      // weekly recap (email if Resend is set up, else SMS)
    weeklyDay: 0,           // 0=Sunday
    weeklyHour: 17,
    wonNudge: true,         // "you marked them Won but never logged the $"
    personalEnabled: true,  // show the Personal bucket (never touches profit)
    recurringEnabled: true, // auto-post monthly bills
    recurring: [],          // { id, label, amount, cat, day, personal }
    serviceTypes: ['Interior', 'Exterior', 'Full detail', 'Add-on'],
    jpName: 'JP',
    taxRate: 0,             // % of net profit to reserve for taxes. 0 = off (no
                            // change to any existing number). Set it (e.g. 25) to
                            // unlock the "take-home" and "reserved for taxes"
                            // headline metrics. Front-end derives both from net.
    split: { costs: 30, you: 50, savings: 20 },
                            // The auto-sort: every dollar of income is silently
                            // split Costs / You / Savings in the background (derived
                            // math only — no money moves, no extra KV). Owner's pay
                            // leads; no separate tax bucket by design. Editable in
                            // settings; must total 100.
    matRate: 5,             // auto-estimated materials % of a job's ticket, used
                            // for profit-per-job when no exact cost is logged.
    monthlyEmail: true,     // 1st-of-month close-out email + CSV backup link.
    catsOff: [],            // category buttons hidden from the log grid
    nudgeDismissed: {},     // phone -> dismissedAt (won-nudges Mikey waved off)
    budgets: [],            // spending caps: { id, cat, amount, period }
                            // cat ∈ MONEY_CATS ∪ {'jp','expenses','personal'}
                            // period ∈ 'month' (default) | 'week' (Sun–Sat, auto-resets)
    goals: [],              // targets: { id, label, type, target, deadline, startMonth }
                            // type ∈ 'net'|'gross'|'jobs'|'save' (save = cumulative net by a deadline)
    hero: defaultHero(),    // the customizable Log-screen headline (see defaultHero)
  };
}

// The Log-screen headline. Defaults to the running balance (all money you have
// now) up top, with this month's income, spend and top spending category below —
// every slot is swappable from the in-app customizer.
//
// startingBalance is the offset between the ledger and real life: balance =
// all-time net + startingBalance. It can be typed in by hand, or — far easier —
// set by "correct the balance" (POST /api/money/balance), which counts what the
// ledger says and solves for the offset that lands on the number actually in
// pocket. balanceSetTo/balanceSetAt remember that correction so the headline can
// say what it was set to and how much has come in since. No entry is touched.
function defaultHero() {
  return { primary: 'balance', stats: ['monthIn', 'monthOut', 'topCat'], startingBalance: 0, title: '', balanceSetTo: null, balanceSetAt: 0 };
}
const HERO_METRICS = ['balance', 'monthNet', 'takeHome', 'taxReserve', 'youBucket', 'costsBucket', 'savingsBucket', 'mineBucket', 'taxBucket', 'bizBucket', 'monthIn', 'monthOut', 'monthJobs', 'monthAvg', 'topCat', 'monthPersonal', 'allIn', 'allOut'];
function sanitizeHero(h, prev) {
  const out = Object.assign(defaultHero(), prev || {});
  if (h && typeof h === 'object') {
    if (HERO_METRICS.includes(h.primary)) out.primary = h.primary;
    if (Array.isArray(h.stats)) out.stats = h.stats.filter((x) => HERO_METRICS.includes(x)).slice(0, 3);
    if (h.startingBalance != null && !isNaN(+h.startingBalance)) {
      const next = money2(h.startingBalance);
      // Typing the offset by hand supersedes any earlier correction, so the
      // headline stops claiming a "set to" number that no longer holds.
      if (next !== out.startingBalance) { out.balanceSetTo = null; out.balanceSetAt = 0; }
      out.startingBalance = next;
    }
    if (typeof h.title === 'string') out.title = h.title.slice(0, 40);
  }
  return out;
}

// Buckets a budget cap can target: any expense category, labor, all business
// expenses combined, or the personal bucket.
const BUDGET_CATS = MONEY_CATS.concat(['jp', 'expenses', 'personal']);
const GOAL_TYPES = ['net', 'gross', 'jobs', 'save'];
function sanitizeBudgets(arr) {
  return (arr || [])
    .filter((b) => b && typeof b === 'object' && +b.amount > 0 && BUDGET_CATS.includes(b.cat))
    .map((b) => ({ id: String(b.id || genId()).slice(0, 24), cat: b.cat, amount: money2(b.amount), period: b.period === 'week' ? 'week' : 'month' }))
    .slice(0, 20);
}
function sanitizeGoals(arr) {
  return (arr || [])
    .filter((g) => g && typeof g === 'object' && GOAL_TYPES.includes(g.type) && +g.target > 0 && String(g.label || '').trim())
    .map((g) => {
      const out = {
        id: String(g.id || genId()).slice(0, 24),
        label: String(g.label).trim().slice(0, 40),
        type: g.type,
        target: money2(g.target),
      };
      if (/^\d{4}-\d{2}$/.test(String(g.deadline || ''))) out.deadline = String(g.deadline);
      out.startMonth = /^\d{4}-\d{2}$/.test(String(g.startMonth || '')) ? String(g.startMonth) : '';
      return out;
    })
    .slice(0, 20);
}
async function loadMoneyConfig() {
  const raw = await kv().get(MONEY_CFG_KEY, { type: 'json' });
  return Object.assign(defaultMoneyConfig(), raw || {});
}
// The Costs/You/Savings split, validated and migrated. Old {tax,biz,mine}
// configs (or anything that doesn't total 100) fall back to the default so
// nobody sees a broken split after the tax bucket was removed.
function moneySplit(cfg) {
  const s = (cfg && cfg.split) || {};
  const c = +s.costs, y = +s.you, v = +s.savings;
  if (c >= 0 && y >= 0 && v >= 0 && c + y + v === 100) return { costs: c, you: y, savings: v };
  return { costs: 30, you: 50, savings: 20 };
}
async function loadMoneyState() {
  return (await kv().get(MONEY_STATE_KEY, { type: 'json' })) || {};
}
async function loadMonth(m) {
  return (await kv().get(moneyKey(m), { type: 'json' })) || { entries: [], rec: {} };
}
// ⚠ KV WRITE — only ever called from user actions, imports, the once-a-month
// recurring post, and never from a per-thread loop.
async function saveMonth(m, doc) {
  await kv().put(moneyKey(m), JSON.stringify(doc));
}

function money2(n) { return Math.round(Number(n) * 100) / 100; }
function prevMonthKey(m) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  return mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
}
// Local calendar date (YYYY-MM-DD) / weekday in the business's timezone, so the
// "day" an entry belongs to matches Mikey's clock, not UTC.
//
// Every one of these goes through a timezone formatter, and BUILDING one is the
// expensive half — a `toLocaleDateString({timeZone})` constructs a throwaway
// formatter on each call, which is why "which day did this land on?" over a few
// hundred conversations was one of the costliest loops in the Worker. Formatting
// with a formatter we already have is cheap, so they're built once per timezone
// and kept. Same output, a fraction of the CPU.
const TZFMT = new Map();
// Returns null — never throws — when the timezone itself is unusable, and
// remembers that so a bad `tz` in config costs one failed construction rather
// than one per call. Narrow on purpose: the callers below used to wrap the whole
// conversion in try/catch, which meant ANY error in here (a typo, a helper that
// hadn't been wired up) came back as a plausible-looking UTC date instead of a
// crash. A wrong day on the run board is much worse than a loud failure.
function tzFmt(kind, tz) {
  const zone = tz || 'America/Los_Angeles';
  const key = kind + '|' + zone;
  if (TZFMT.has(key)) return TZFMT.get(key);
  let f = null;
  try {
    f = kind === 'date' ? new Intl.DateTimeFormat('en-CA', { timeZone: zone })
      : kind === 'dow' ? new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' })
      : new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, hour: '2-digit' });
  } catch { f = null; }
  TZFMT.set(key, f);
  return f;
}
function localDateStr(ts, tz) {
  const f = tzFmt('date', tz);
  return f ? f.format(new Date(ts)) : new Date(ts).toISOString().slice(0, 10);
}
function localDow(ts, tz) {
  const f = tzFmt('dow', tz);
  if (!f) return new Date(ts).getUTCDay();
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.format(new Date(ts)).slice(0, 3));
}

// Validate + trim an incoming entry. Returns null when it isn't usable.
// Types: job (income; may carry a per-job JP cost), jp (labor payment),
// exp (business expense with a category), personal (separate bucket).
function sanitizeMoneyEntry(e, existingId) {
  const amount = money2(e.amount);
  if (!amount || !isFinite(amount) || amount <= 0 || amount > 1000000) return null;
  const type = MONEY_TYPES.includes(e.type) ? e.type : 'exp';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) ? String(e.date) : null;
  if (!date) return null;
  const out = { id: existingId || genId(), date, ts: Number(e.ts) || Date.now(), type, amount };
  if (type === 'exp') out.cat = MONEY_CATS.includes(e.cat) ? e.cat : 'misc';
  if (type === 'personal' && e.cat) out.cat = String(e.cat).slice(0, 30);
  if (e.sub) out.sub = String(e.sub).slice(0, 24);
  if (e.method) out.method = String(e.method).slice(0, 16);
  if (e.service) out.service = String(e.service).slice(0, 32);
  if (e.phone) { const p = normalizePhone(e.phone); if (p) out.phone = p; }
  if (e.name) out.name = String(e.name).slice(0, 60);
  if (e.city) out.city = String(e.city).slice(0, 40);
  if (e.note) out.note = String(e.note).slice(0, 200);
  if (type === 'job' && e.jp != null && +e.jp > 0) out.jp = money2(e.jp);
  if (type === 'job') {
    // Optional per-job detail (all additive — old entries stay untouched):
    // hours worked, vehicle type, exact material cost, and a balance the
    // customer still owes (deposits / pay-later).
    if (e.hours != null && +e.hours > 0) out.hours = Math.min(99, money2(e.hours));
    if (e.veh) out.veh = String(e.veh).slice(0, 20);
    if (e.mat != null && +e.mat > 0) out.mat = money2(e.mat);
    if (e.owed != null && +e.owed > 0) out.owed = money2(e.owed);
  }
  if (e.rc) out.rc = 1; // has a receipt photo stored under money:rc:<id>
  if (e.imp) out.imp = true; // came from a CSV import (used for de-dupe on re-import)
  return out;
}

// ===========================================================================
// One-time ledger seeds
// ---------------------------------------------------------------------------
// Card charges that reached Mikey as a bank screenshot instead of through the
// Log screen. There is no door into the live ledger from outside the app —
// every /api/money route sits behind the dashboard password — so a batch like
// this ships WITH the deploy: the first cron tick after it goes live writes the
// entries, stamps the batch, and never writes again. Mikey taps nothing.
//
// Two rules keep a seed from becoming a duplicate or a zombie:
//   • Stable ids — a re-run recognises what it already wrote and skips it, so a
//     tick that dies between the month write and the stamp costs nothing.
//   • The stamp is a batch version, and only batches NEWER than it are applied.
//     That makes deleting a seeded entry in the app final: the next tick won't
//     bring it back. To send another batch, add rows carrying the next `v` and
//     bump LEDGER_SEED_VERSION to match.
//
// Amounts and categories are Mikey's own call, not a guess from the merchant
// name — the 76 fill-up is fuel, the rest of that day's card 1917 charges are
// food (two of them rung up at a gas station, which is exactly why the merchant
// can't be trusted to pick the category).
// ===========================================================================
const LEDGER_SEED_VERSION = 1;
const LEDGER_SEED_KEY = 'money:seed';
const LEDGER_SEEDS = [
  { v: 1, id: 'sd1-76express', date: '2026-08-20', type: 'exp', cat: 'fuel', amount: 25.11, note: '76 Express, Snohomish · card 1917' },
  { v: 1, id: 'sd1-chickfila', date: '2026-08-20', type: 'exp', cat: 'food', amount: 7.61,  note: 'Chick-fil-A, Bothell · card 1917' },
  { v: 1, id: 'sd1-shell-491', date: '2026-08-20', type: 'exp', cat: 'food', amount: 4.91,  note: 'Shell, Snohomish · card 1917' },
  { v: 1, id: 'sd1-shell-548', date: '2026-08-20', type: 'exp', cat: 'food', amount: 5.48,  note: 'Shell, Snohomish · card 1917' },
  { v: 1, id: 'sd1-safeway',   date: '2026-08-20', type: 'exp', cat: 'food', amount: 1.19,  note: 'Safeway #107, Snohomish · card 1917' },
];

// Set once the stamp is known to be current, so a long-lived isolate stops
// reading the key every minute. A cold isolate costs one KV read, then nothing.
let LEDGER_SEEDS_DONE = false;

// ⚠ KV WRITE — at most one per month touched, once ever per batch.
async function applyLedgerSeeds() {
  if (LEDGER_SEEDS_DONE) return;
  const applied = Number(await kv().get(LEDGER_SEED_KEY)) || 0;
  if (applied >= LEDGER_SEED_VERSION) { LEDGER_SEEDS_DONE = true; return; }

  // Group by month so a batch spanning a month boundary still costs one write
  // per month, not one per entry.
  const byMonth = new Map();
  LEDGER_SEEDS.filter((s) => (s.v || 1) > applied).forEach((s, i) => {
    // A fixed timestamp — midday local on the day of the charge, nudged a minute
    // per row so the day reads in statement order — keeps the entry honest about
    // when the money went out rather than when the deploy happened.
    const e = sanitizeMoneyEntry(Object.assign({ ts: Date.parse(s.date + 'T19:00:00Z') + i * 60000 }, s), s.id);
    if (!e) return;
    const m = e.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(e);
  });

  for (const [month, entries] of byMonth) {
    const doc = await loadMonth(month);
    let dirty = false;
    for (const e of entries) {
      // Already there — a previous tick wrote it, or Mikey has since edited it.
      // Either way his copy wins.
      if (doc.entries.some((x) => x.id === e.id)) continue;
      doc.entries.push(e);
      dirty = true;
    }
    if (dirty) await saveMonth(month, doc);
  }
  await kv().put(LEDGER_SEED_KEY, String(LEDGER_SEED_VERSION));
  LEDGER_SEEDS_DONE = true;
}

// One month, one pass: everything the Report view and the recaps need.
function summarizeMonth(entries) {
  const s = { gross: 0, jp: 0, exp: 0, personal: 0, net: 0, jobs: 0, owed: 0, byCat: {}, byService: {}, byMethod: {} };
  for (const e of (entries || [])) {
    if (e.type === 'job') {
      s.gross += e.amount; s.jobs++;
      if (e.owed) s.owed += e.owed;
      if (e.jp) s.jp += e.jp;
      if (e.service) { const v = s.byService[e.service] = s.byService[e.service] || { n: 0, total: 0 }; v.n++; v.total += e.amount; }
      if (e.method) s.byMethod[e.method] = money2((s.byMethod[e.method] || 0) + e.amount);
    } else if (e.type === 'jp') s.jp += e.amount;
    else if (e.type === 'personal') s.personal += e.amount;
    else { s.exp += e.amount; s.byCat[e.cat || 'misc'] = money2((s.byCat[e.cat || 'misc'] || 0) + e.amount); }
  }
  s.gross = money2(s.gross); s.jp = money2(s.jp); s.exp = money2(s.exp); s.personal = money2(s.personal); s.owed = money2(s.owed);
  s.net = money2(s.gross - s.jp - s.exp); // personal deliberately excluded
  for (const k of Object.keys(s.byService)) s.byService[k].total = money2(s.byService[k].total);
  return s;
}

// The current Sunday–Saturday week as calendar dates (YYYY-MM-DD). Derived from
// the business-local "today" string, so a weekly budget resets on the same clock
// Mikey lives on. Treating the date at UTC midnight makes getUTCDay() the correct
// weekday for that calendar date without dragging timezones back in.
function weekWindow(todayStr) {
  const d = new Date(todayStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Spend within [start,end] for the buckets a budget can cap (expense categories,
// labor, personal). Same bucket rules as summarizeMonth, just windowed by date so
// a weekly cap can span a month boundary. Reads only — no KV writes.
function summarizeWeek(entries, start, end) {
  const s = { exp: 0, personal: 0, jp: 0, gross: 0, jobs: 0, byCat: {}, byService: {} };
  for (const e of (entries || [])) {
    if (!e.date || e.date < start || e.date > end) continue;
    if (e.type === 'jp') s.jp += e.amount;
    else if (e.type === 'personal') s.personal += e.amount;
    else if (e.type === 'exp') { s.exp += e.amount; s.byCat[e.cat || 'misc'] = money2((s.byCat[e.cat || 'misc'] || 0) + e.amount); }
    else if (e.type === 'job') {
      s.gross += e.amount; s.jobs++;
      if (e.jp) s.jp += e.jp; // labor cost carried on a job
      if (e.service) { const v = s.byService[e.service] = s.byService[e.service] || { n: 0, total: 0 }; v.n++; v.total = money2(v.total + e.amount); }
    }
  }
  s.exp = money2(s.exp); s.personal = money2(s.personal); s.jp = money2(s.jp); s.gross = money2(s.gross);
  s.net = money2(s.gross - s.jp - s.exp);
  return s;
}

// Lazily post recurring bills into the CURRENT month the first time it's viewed
// on/after each bill's day — no cron writes needed, exactly one write per month
// with recurring bills. Returns whether the doc changed.
function postRecurring(cfg, monthKeyStr, doc, todayStr) {
  if (cfg.recurringEnabled === false) return false;
  let changed = false;
  const today = +todayStr.slice(8, 10);
  for (const r of (cfg.recurring || [])) {
    if (!r || !r.id || !(+r.amount > 0)) continue;
    if (doc.rec && doc.rec[r.id]) continue;
    const postDay = Math.min(Math.max(1, Math.round(+r.day) || 1), 28);
    if (today < postDay) continue;
    doc.entries.push({
      id: genId(), date: monthKeyStr + '-' + String(postDay).padStart(2, '0'), ts: Date.now(),
      type: r.personal ? 'personal' : 'exp', amount: money2(r.amount),
      cat: r.personal ? (r.cat || 'recurring') : (MONEY_CATS.includes(r.cat) ? r.cat : 'bills'),
      note: (r.label || 'Recurring') + ' · auto', auto: true,
    });
    doc.rec = doc.rec || {}; doc.rec[r.id] = true;
    changed = true;
  }
  return changed;
}

// All-time rollup across every month doc — the "money you have now" balance and
// the lifetime income/spend totals the customizable hero can show. A handful of
// KV reads (one per month with data); reads are the cheap side of the budget.
async function allTimeSummary() {
  const list = await kv().list({ prefix: 'money:m:' });
  const s = { gross: 0, jp: 0, exp: 0, personal: 0, net: 0, jobs: 0, months: 0 };
  for (const k of (list.keys || [])) {
    const doc = await kv().get(k.name, { type: 'json' });
    const m = summarizeMonth((doc && doc.entries) || []);
    s.gross += m.gross; s.jp += m.jp; s.exp += m.exp; s.personal += m.personal; s.net += m.net; s.jobs += m.jobs; s.months++;
  }
  for (const kk of ['gross', 'jp', 'exp', 'personal', 'net']) s[kk] = money2(s[kk]);
  return s;
}

// Won leads with no job $ logged since they were won (recent wins only). The
// dashboard already knows who was won and when (index statusAt); the ledger
// knows what got logged — the gap is exactly what Mikey asked to be caught.
async function moneyWonNudges(entries, cfg, now) {
  const index = await loadIndex();
  const out = [];
  for (const t of index) {
    if (t.archived || t.status !== 'won') continue;
    const at = t.statusAt || t.lastTs || 0;
    if (!at || now - at > 21 * 86400000) continue;
    if (cfg.nudgeDismissed && cfg.nudgeDismissed[t.phone] >= at) continue;
    const logged = entries.some((e) => e.type === 'job' && e.phone === t.phone && e.ts >= at - 86400000);
    if (!logged) out.push({ phone: t.phone, name: t.name || '', wonAt: at });
  }
  out.sort((a, b) => b.wonAt - a.wonAt);
  return out.slice(0, 6);
}

// ---- money API --------------------------------------------------------------
async function apiMoney(url) {
  const now = Date.now();
  const cfg = await loadMoneyConfig();
  const mainCfg = await loadConfig();
  const todayStr = localDateStr(now, mainCfg.tz);
  const curMonth = todayStr.slice(0, 7);
  const want = url.searchParams.get('month') || '';
  const month = /^\d{4}-\d{2}$/.test(want) ? want : curMonth;
  const doc = await loadMonth(month);
  if (month === curMonth && postRecurring(cfg, month, doc, todayStr)) await saveMonth(month, doc);
  doc.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (b.ts - a.ts));
  let nudges = [], week = null, owed = [];
  if (month === curMonth) {
    // The current week can reach into last month, so combine both docs once and
    // reuse the read for the won-lead nudges too.
    const prevDoc = await loadMonth(prevMonthKey(month));
    const combined = doc.entries.concat(prevDoc.entries);
    const w = weekWindow(todayStr);
    week = Object.assign({ start: w.start, end: w.end }, summarizeWeek(combined, w.start, w.end));
    if (cfg.wonNudge !== false) nudges = await moneyWonNudges(combined, cfg, now);
    // Jobs with a balance the customer still owes — reuses the combined read.
    owed = combined.filter((e) => e.type === 'job' && e.owed > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 12)
      .map((e) => ({ id: e.id, date: e.date, name: e.name || '', phone: e.phone || '', amount: e.amount, owed: e.owed }));
  }
  const allTime = await allTimeSummary();
  return json({ ok: true, month, today: todayStr, entries: doc.entries, summary: summarizeMonth(doc.entries), week, allTime, config: cfg, nudges, owed });
}

async function apiMoneyEntry(request) {
  const data = await readJson(request);
  // One-tap "mark paid": clear the owed balance without resending the whole
  // entry (works for any month, keeps every other field exactly as it was).
  if (data.id && data.clearOwed) {
    const cm = String(data.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(cm)) return json({ ok: false, error: 'bad_request' }, 422);
    const cdoc = await loadMonth(cm);
    const ci = cdoc.entries.findIndex((x) => x.id === String(data.id));
    if (ci < 0) return json({ ok: false, error: 'not_found' }, 404);
    delete cdoc.entries[ci].owed;
    await saveMonth(cm, cdoc);
    return json({ ok: true, entry: cdoc.entries[ci], month: cm, summary: summarizeMonth(cdoc.entries) });
  }
  const e = sanitizeMoneyEntry(data, data.id ? String(data.id).slice(0, 24) : null);
  if (!e) return json({ ok: false, error: 'bad_entry' }, 422);
  const month = e.date.slice(0, 7);
  // Editing an entry whose date moved to another month: pull it out of the old doc.
  if (data.id && data.origDate && String(data.origDate).slice(0, 7) !== month) {
    const om = String(data.origDate).slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(om)) {
      const od = await loadMonth(om);
      const before = od.entries.length;
      od.entries = od.entries.filter((x) => x.id !== e.id);
      if (od.entries.length !== before) await saveMonth(om, od);
    }
  }
  const doc = await loadMonth(month);
  const i = doc.entries.findIndex((x) => x.id === e.id);
  if (i >= 0) e.ts = doc.entries[i].ts || e.ts; // edits keep their original position
  if (i >= 0) doc.entries[i] = e; else doc.entries.push(e);
  if (doc.entries.length > 3000) return json({ ok: false, error: 'month_full' }, 422);
  await saveMonth(month, doc);
  return json({ ok: true, entry: e, month, summary: summarizeMonth(doc.entries) });
}

async function apiMoneyDelete(request) {
  const data = await readJson(request);
  const id = String(data.id || '');
  const month = String(data.date || '').slice(0, 7);
  if (!id || !/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: 'bad_request' }, 422);
  const doc = await loadMonth(month);
  const before = doc.entries.length;
  const gone = doc.entries.find((x) => x.id === id);
  doc.entries = doc.entries.filter((x) => x.id !== id);
  if (doc.entries.length === before) return json({ ok: false, error: 'not_found' }, 404);
  await saveMonth(month, doc);
  if (gone && gone.rc) { try { await kv().delete('money:rc:' + id); } catch { /* best effort */ } }
  return json({ ok: true, month, summary: summarizeMonth(doc.entries) });
}

// ---- receipt photos --------------------------------------------------------
// One small JPEG per entry, stored as a data URL under money:rc:<entryId>.
// Client compresses to ≤~280KB before upload; deleted with its entry.
async function apiMoneyReceipt(request, url) {
  if (request.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 24);
    if (!id) return json({ ok: false, error: 'bad_request' }, 422);
    const data = await kv().get('money:rc:' + id);
    if (!data) return json({ ok: false, error: 'not_found' }, 404);
    const m = String(data).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
    if (!m) return json({ ok: false, error: 'bad_data' }, 500);
    const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400' } });
  }
  const data = await readJson(request);
  const id = String(data.id || '').slice(0, 24);
  const month = String(data.date || '').slice(0, 7);
  const img = String(data.img || '');
  if (!id || !/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: 'bad_request' }, 422);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 400000) return json({ ok: false, error: 'bad_image' }, 422);
  const doc = await loadMonth(month);
  const e = doc.entries.find((x) => x.id === id);
  if (!e) return json({ ok: false, error: 'not_found' }, 404);
  await kv().put('money:rc:' + id, img);
  e.rc = 1;
  await saveMonth(month, doc);
  return json({ ok: true });
}

// Per-month aggregates going back N months — feeds the month-vs-month chart.
async function apiMoneyReport(url) {
  const n = Math.max(2, Math.min(12, parseInt(url.searchParams.get('months') || '6', 10) || 6));
  const mainCfg = await loadConfig();
  let m = localDateStr(Date.now(), mainCfg.tz).slice(0, 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const doc = await loadMonth(m);
    out.unshift(Object.assign({ month: m }, summarizeMonth(doc.entries)));
    m = prevMonthKey(m);
  }
  return json({ ok: true, months: out });
}

// Everything logged for one customer (last 12 months) — the thread-details
// cross-link ("job history + $ spent with you").
async function apiMoneyByPhone(url) {
  const phone = normalizePhone(url.searchParams.get('phone'));
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const mainCfg = await loadConfig();
  let m = localDateStr(Date.now(), mainCfg.tz).slice(0, 7);
  const entries = [];
  for (let i = 0; i < 12; i++) {
    const doc = await loadMonth(m);
    for (const e of doc.entries) if (e.phone === phone) entries.push(e);
    m = prevMonthKey(m);
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || (b.ts - a.ts));
  const jobs = entries.filter((e) => e.type === 'job');
  return json({
    ok: true, phone,
    jobs: jobs.length,
    total: money2(jobs.reduce((a, e) => a + e.amount, 0)),
    entries: entries.slice(0, 20),
  });
}

// Read-only snapshot of what the owner sees, in one JSON bundle — a "show Claude
// what I see" export. Password-gated (like every /api/* route), never writes, and
// defensively strips anything secret-looking from config.
//
// Ask for only the pieces you need — a file that is just the texts answers a
// question about texts far better than a dump of the whole app:
//   ?parts=messages,money   which sections to include (default: all of them)
//   ?days=90                only stuff that happened in the last N days (0 = all)
//   ?msgs=60                messages kept per conversation ('all' = up to 500)
//   ?q=sarah                only conversations matching a name or number
//   ?limit=300              max conversations
// No params at all = the old behavior (everything), so older links keep working.
const SNAP_PARTS = ['messages', 'leads', 'money', 'bookings', 'emails', 'settings'];

async function apiSnapshot(url) {
  const P = url.searchParams;
  const num = (v, dflt, lo, hi) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n));
  };
  const asked = String(P.get('parts') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  let parts = (!asked.length || asked.includes('all'))
    ? SNAP_PARTS.slice()
    : SNAP_PARTS.filter((p) => asked.includes(p));
  if (!parts.length) parts = SNAP_PARTS.slice();          // nothing recognized → everything
  if (P.get('messages') === '0') parts = parts.filter((p) => p !== 'messages'); // legacy flag
  const want = (k) => parts.indexOf(k) >= 0;

  const days    = num(P.get('days'), 0, 0, 3650);
  const since   = days ? Date.now() - days * 86400000 : 0;
  const sinceD  = since ? new Date(since).toISOString().slice(0, 10) : '';
  const sinceM  = sinceD.slice(0, 7);
  const msgCap  = P.get('msgs') === 'all' ? 500 : num(P.get('msgs'), 60, 1, 500);
  const limit   = num(P.get('limit'), 300, 1, 500);
  const q       = String(P.get('q') || '').trim().toLowerCase();

  const scrub = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = Array.isArray(o) ? [] : {};
    for (const k of Object.keys(o)) {
      if (/secret|token|apikey|api_key|password|auth/i.test(k)) { out[k] = '[hidden]'; continue; }
      out[k] = (o[k] && typeof o[k] === 'object') ? scrub(o[k]) : o[k];
    }
    return out;
  };

  const out = {
    ok: true, kind: 'mikeys-app-snapshot', build: BUILD, at: new Date().toISOString(),
    included: parts,
    filters: { days: days || null, since: sinceD || null, msgsPerChat: msgCap, who: q || null, maxChats: limit },
  };
  const counts = {};

  // ---- conversations (the index rows, and optionally the texts themselves) ----
  if (want('messages') || want('leads')) {
    let index = await loadIndex();
    index.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    counts.conversationsTotal = index.length;
    let rows = index;
    if (since) rows = rows.filter((t) => (t.lastTs || 0) >= since);
    if (q) rows = rows.filter((t) => (String(t.name || '') + ' ' + String(t.phone || '')).toLowerCase().indexOf(q) >= 0);
    rows = rows.slice(0, limit);
    if (want('leads')) out.leadsAndChats = rows;
    if (want('messages')) {
      const threadsFull = [];
      for (const t of rows) {
        const doc = await loadThread(t.phone);
        const trimmed = Object.assign({}, doc);
        const all = Array.isArray(doc.messages) ? doc.messages : [];
        trimmed.msgTotal = all.length;
        const inRange = since ? all.filter((m) => (m.ts || 0) >= since) : all;
        trimmed.messages = inRange.slice(-msgCap);
        if (since && !trimmed.messages.length) continue;   // nothing said in the window
        threadsFull.push(scrub(trimmed));
      }
      out.conversations = threadsFull;
      counts.conversations = threadsFull.length;
      counts.messages = threadsFull.reduce((a, t) => a + t.messages.length, 0);
    } else {
      counts.conversations = rows.length;
    }
  }

  // ---- money (income & expenses, month by month) ----
  if (want('money')) {
    const list = await kv().list({ prefix: 'money:m:' });
    const money = [];
    for (const k of (list.keys || [])) {
      const month = k.name.replace('money:m:', '');
      if (sinceM && month < sinceM) continue;              // whole month predates the window
      const doc = await kv().get(k.name, { type: 'json' });
      let entries = (doc && doc.entries) || [];
      if (sinceD) entries = entries.filter((e) => String(e.date || '') >= sinceD);
      if (!entries.length && sinceD) continue;
      money.push({ month, entries });
    }
    money.sort((a, b) => (a.month < b.month ? -1 : 1));
    out.money = money;
    counts.moneyMonths = money.length;
    counts.moneyEntries = money.reduce((a, m) => a + m.entries.length, 0);
  }

  // ---- bookings ----
  if (want('bookings')) {
    let bookings = await loadBookings();
    if (since) bookings = bookings.filter((b) => (b.apptAt || 0) >= since || (b.createdAt || 0) >= since);
    out.bookings = scrub(bookings);
    counts.bookings = bookings.length;
  }

  // ---- forwarded emails ----
  if (want('emails')) {
    let emails = (await kv().get('emails', { type: 'json' })) || [];
    if (since) emails = emails.filter((e) => (e.ts || 0) >= since);
    out.emails = scrub(emails);
    counts.emails = emails.length;
  }

  // ---- settings, playbook, templates ----
  if (want('settings')) {
    out.config = scrub(await loadConfig());
    out.moneyConfig = scrub(await loadMoneyConfig());
    out.bookingConfig = scrub(await loadBookingConfig());
    out.templates = (await kv().get('templates', { type: 'json' })) || [];
  }

  out.counts = counts;
  return json(out);
}

// Full CSV export — every month doc, one flat file. No lock-in, ever.
async function apiMoneyExport() {
  const list = await kv().list({ prefix: 'money:m:' });
  const rows = [];
  for (const k of (list.keys || [])) {
    const doc = await kv().get(k.name, { type: 'json' });
    for (const e of ((doc && doc.entries) || [])) rows.push(e);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.ts - b.ts));
  const csv = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = 'date,type,category,sub,amount,jp_cost,method,service,customer,phone,city,note,hours,vehicle,material,owed';
  const body = rows.map((e) => [e.date, e.type, e.cat || '', e.sub || '', e.amount, e.jp || '', e.method || '', e.service || '', e.name || '', e.phone || '', e.city || '', e.note || '', e.hours || '', e.veh || '', e.mat || '', e.owed || ''].map(csv).join(',')).join('\n');
  return new Response(head + '\n' + body, {
    headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="mikeys-money.csv"' },
  });
}

// Bulk import (the dashboard parses + maps the CSV client-side and sends clean
// entries). Re-running the same import is safe: imported rows de-dupe on
// date+type+amount+note. One KV write per month touched.
async function apiMoneyImport(request) {
  const data = await readJson(request);
  const list = Array.isArray(data.entries) ? data.entries.slice(0, 3000) : [];
  const byMonth = {};
  let imported = 0, skipped = 0;
  for (const raw of list) {
    const e = sanitizeMoneyEntry(Object.assign({}, raw, { imp: true }));
    if (!e) { skipped++; continue; }
    (byMonth[e.date.slice(0, 7)] = byMonth[e.date.slice(0, 7)] || []).push(e);
  }
  for (const m of Object.keys(byMonth)) {
    const doc = await loadMonth(m);
    const seen = {};
    for (const x of doc.entries) if (x.imp) seen[x.date + '|' + x.type + '|' + x.amount + '|' + (x.note || '')] = 1;
    let added = 0;
    for (const e of byMonth[m]) {
      const key = e.date + '|' + e.type + '|' + e.amount + '|' + (e.note || '');
      if (seen[key]) { skipped++; continue; }
      seen[key] = 1; doc.entries.push(e); added++; imported++;
    }
    if (added) {
      if (doc.entries.length > 3000) doc.entries = doc.entries.slice(-3000);
      await saveMonth(m, doc);
    }
  }
  return json({ ok: true, imported, skipped, months: Object.keys(byMonth).length });
}

async function apiMoneyGetConfig() {
  return json({ ok: true, config: await loadMoneyConfig() });
}

async function apiMoneySaveConfig(request) {
  const data = await readJson(request);
  const next = Object.assign({}, await loadMoneyConfig());
  for (const k of ['reminderEnabled', 'weeklyEmail', 'wonNudge', 'personalEnabled', 'recurringEnabled', 'monthlyEmail']) {
    if (typeof data[k] === 'boolean') next[k] = data[k];
  }
  if (data.reminderHour != null && !isNaN(+data.reminderHour)) next.reminderHour = Math.max(0, Math.min(23, Math.round(+data.reminderHour)));
  if (data.weeklyHour != null && !isNaN(+data.weeklyHour)) next.weeklyHour = Math.max(0, Math.min(23, Math.round(+data.weeklyHour)));
  if (data.weeklyDay != null && !isNaN(+data.weeklyDay)) next.weeklyDay = Math.max(0, Math.min(6, Math.round(+data.weeklyDay)));
  if (typeof data.jpName === 'string') next.jpName = data.jpName.trim().slice(0, 20) || 'JP';
  if (data.taxRate != null && !isNaN(+data.taxRate)) next.taxRate = Math.max(0, Math.min(60, Math.round(+data.taxRate * 10) / 10));
  if (data.split && typeof data.split === 'object') {
    const c = Math.max(0, Math.min(100, Math.round(+data.split.costs) || 0));
    const y = Math.max(0, Math.min(100, Math.round(+data.split.you) || 0));
    const v = Math.max(0, Math.min(100, Math.round(+data.split.savings) || 0));
    if (c + y + v === 100) next.split = { costs: c, you: y, savings: v }; // must total 100 or it's ignored
  }
  if (data.matRate != null && !isNaN(+data.matRate)) next.matRate = Math.max(0, Math.min(30, Math.round(+data.matRate * 10) / 10));
  if (Array.isArray(data.serviceTypes)) next.serviceTypes = data.serviceTypes.map((s) => String(s).trim().slice(0, 32)).filter(Boolean).slice(0, 10);
  if (Array.isArray(data.catsOff)) next.catsOff = data.catsOff.map(String).filter((c) => MONEY_CATS.includes(c)).slice(0, MONEY_CATS.length);
  if (Array.isArray(data.budgets)) next.budgets = sanitizeBudgets(data.budgets);
  if (Array.isArray(data.goals)) next.goals = sanitizeGoals(data.goals);
  if (data.hero) next.hero = sanitizeHero(data.hero, next.hero);
  if (Array.isArray(data.recurring)) {
    next.recurring = data.recurring
      .filter((r) => r && typeof r === 'object' && +r.amount > 0 && String(r.label || '').trim())
      .map((r) => ({
        id: String(r.id || genId()).slice(0, 24),
        label: String(r.label).trim().slice(0, 40),
        amount: money2(r.amount),
        cat: MONEY_CATS.includes(r.cat) ? r.cat : 'bills',
        day: Math.max(1, Math.min(28, Math.round(+r.day) || 1)),
        personal: !!r.personal,
      })).slice(0, 20);
  }
  if (typeof data.dismissNudge === 'string') {
    const p = normalizePhone(data.dismissNudge);
    if (p) {
      next.nudgeDismissed = Object.assign({}, next.nudgeDismissed);
      next.nudgeDismissed[p] = Date.now();
      const keys = Object.keys(next.nudgeDismissed);
      if (keys.length > 30) { keys.sort((a, b) => next.nudgeDismissed[a] - next.nudgeDismissed[b]); delete next.nudgeDismissed[keys[0]]; }
    }
  }
  await kv().put(MONEY_CFG_KEY, JSON.stringify(next));
  return json({ ok: true, config: next });
}

// "The balance is wrong — I've actually got $5,000." Rather than inventing an
// entry (which would poison income, margins, averages and every report), this
// solves for the starting-balance offset that makes the headline land on the
// real number: offset = actual − what the ledger nets all-time. History is read,
// never written; from here the balance moves with every job and expense again.
// { balance: 5000 } sets it, { clear: true } drops the correction entirely.
async function apiMoneySetBalance(request) {
  const data = await readJson(request);
  const cfg = await loadMoneyConfig();
  const hero = Object.assign(defaultHero(), cfg.hero || {});
  const at = await allTimeSummary();
  if (data.clear) {
    hero.startingBalance = 0; hero.balanceSetTo = null; hero.balanceSetAt = 0;
  } else {
    if (data.balance == null || isNaN(+data.balance)) return json({ ok: false, error: 'Enter the amount you actually have.' }, 400);
    const target = money2(data.balance);
    hero.startingBalance = money2(target - at.net);
    hero.balanceSetTo = target;
    hero.balanceSetAt = Date.now();
  }
  const next = Object.assign({}, cfg, { hero });
  await kv().put(MONEY_CFG_KEY, JSON.stringify(next));
  return json({ ok: true, config: next, ledgerNet: at.net, adjustment: hero.startingBalance, balance: money2(at.net + hero.startingBalance) });
}

// ---- money cron -------------------------------------------------------------
// Two nudges, both through notifyMikey (email if Resend is configured, else SMS):
//   1. Evening "log today's money?" — only when NOTHING business got logged today.
//   2. Weekly recap — last 7 days of gross / labor / expenses / net.
// Markers in money:state keep this to at most 2 KV writes per day. Kill switch:
// set MONEY_CRON_DISABLED=1 as a Worker var (no KV write needed), same pattern
// as FOLLOWUPS_DISABLED.
async function moneyCron(now = Date.now()) {
  if (envFlag('MONEY_CRON_DISABLED')) return;
  const cfg = await loadMoneyConfig();
  if (cfg.reminderEnabled === false && cfg.weeklyEmail === false && cfg.monthlyEmail === false) return;
  const mainCfg = await loadConfig();
  const tz = mainCfg.tz || 'America/Los_Angeles';
  const hour = localHour(now, tz);
  const today = localDateStr(now, tz);

  if (!mainCfg.dailyEmailsPaused &&
      cfg.reminderEnabled !== false && hour === (cfg.reminderHour == null ? 19 : cfg.reminderHour)) {
    const state = await loadMoneyState();
    if (state.dailySent !== today) {
      const doc = await loadMonth(today.slice(0, 7));
      const loggedToday = doc.entries.some((e) => e.date === today && e.type !== 'personal');
      state.dailySent = today; // mark either way — one write, stops the hourly rechecks
      await kv().put(MONEY_STATE_KEY, JSON.stringify(state));
      if (!loggedToday) {
        let extra = '';
        if (cfg.wonNudge !== false) {
          try {
            const prevDoc = await loadMonth(prevMonthKey(today.slice(0, 7)));
            const nudges = await moneyWonNudges(doc.entries.concat(prevDoc.entries), cfg, now);
            if (nudges.length) extra = `\n\nStill unlogged Won jobs: ${nudges.map((n) => n.name || n.phone).join(', ')}.`;
          } catch { /* nudges are a bonus */ }
        }
        notifyMikey('💵 Log today\'s money?',
          `Nothing logged today yet — jobs, fuel, supplies, ${cfg.jpName || 'JP'}. 30 seconds now keeps the month's profit real.${extra}\n\nOpen the tracker: ${publicBase()}/?money=1`).catch(() => {});
      }
    }
  }

  if (cfg.weeklyEmail !== false &&
      localDow(now, tz) === (cfg.weeklyDay == null ? 0 : cfg.weeklyDay) &&
      hour === (cfg.weeklyHour == null ? 17 : cfg.weeklyHour)) {
    const state = await loadMoneyState();
    if (state.weeklySentOn !== today) {
      state.weeklySentOn = today;
      await kv().put(MONEY_STATE_KEY, JSON.stringify(state));
      const days = {};
      for (let i = 0; i < 7; i++) days[localDateStr(now - i * 86400000, tz)] = 1;
      const months = [...new Set(Object.keys(days).map((d) => d.slice(0, 7)))];
      let entries = [];
      for (const m of months) entries = entries.concat((await loadMonth(m)).entries.filter((e) => days[e.date]));
      const s = summarizeMonth(entries);
      const avg = s.jobs ? money2(s.gross / s.jobs) : 0;
      const topCat = Object.keys(s.byCat).sort((a, b) => s.byCat[b] - s.byCat[a])[0];
      notifyMikey('📊 Your week in money',
        `Last 7 days at Mikey's Mobile Detailing:\n\n` +
        `• Gross: $${s.gross}\n• ${cfg.jpName || 'JP'} / labor: $${s.jp}\n• Expenses: $${s.exp}` +
        (topCat ? ` (biggest: ${topCat} $${s.byCat[topCat]})` : '') + `\n` +
        `• NET PROFIT: $${s.net}\n• Jobs: ${s.jobs}${s.jobs ? ` · avg ticket $${avg}` : ''}` +
        (s.personal ? `\n• Personal (kept separate): $${s.personal}` : '') +
        `\n\nFull report: ${publicBase()}/?money=1`).catch(() => {});
    }
  }

  // Monthly close-out: on the 1st, ~9am — last month's P&L, the auto-split
  // buckets, and a CSV backup link. State marker keeps it to one send/month.
  if (cfg.monthlyEmail !== false && today.slice(8) === '01' && hour === 9) {
    const state = await loadMoneyState();
    const mPrev = prevMonthKey(today.slice(0, 7));
    if (state.monthlySent !== mPrev) {
      state.monthlySent = mPrev;
      await kv().put(MONEY_STATE_KEY, JSON.stringify(state));
      const s = summarizeMonth((await loadMonth(mPrev)).entries);
      const sp = moneySplit(cfg);
      const label = new Date(+mPrev.slice(0, 4), +mPrev.slice(5, 7) - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      notifyMikey(`📗 ${label} close-out`,
        `${label} at Mikey's Mobile Detailing:\n\n` +
        `• Gross: $${s.gross} · Jobs: ${s.jobs}\n• ${cfg.jpName || 'JP'} / labor: $${s.jp}\n` +
        `• Expenses: $${s.exp}\n• NET PROFIT: $${s.net}` +
        (s.owed ? `\n• Customers still owe: $${s.owed}` : '') +
        `\n\nAuto-split of the month's income (${sp.costs}/${sp.you}/${sp.savings}):\n` +
        `• Costs: $${money2(s.gross * sp.costs / 100)}\n• Yours: $${money2(s.gross * sp.you / 100)}\n• Savings: $${money2(s.gross * sp.savings / 100)}` +
        `\n\nBackup your data (CSV): ${publicBase()}/api/money/export\nFull report: ${publicBase()}/?money=1`).catch(() => {});
    }
  }
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
    source: '',        // FIRST-TOUCH acquisition channel — 'quote' | 'booking' |
                       // 'call' | 'text'. Stamped once, by whichever entry point
                       // created the conversation, and never overwritten, so the
                       // attribution report can tell where a customer came from.
                       // Threads that predate this field fall back to a derived
                       // guess (see deriveSource) and are flagged as estimated.
    sourceAt: 0,       // when the first touch happened
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
    garage: null,      // customer garage: { vehicles[], address, city, zip, gate,
                       // parking, water, power, prefs, avoid } — see sanitizeGarage
    quote: null,       // most recent quote sent: { id, total, service, at }
    plan: null,        // maintenance plan: { every, startedAt, lastJobAt, service,
                       // price, askedAt, paused, note } — see sanitizePlan
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
    holdReason: '',    // Mikey's own words for WHY this one is parked ("doing her car in August")
    heldAt: 0,
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
    autoReplyAlert: true,    // text Mikey the moment the quote-form auto-reply actually
                             // reaches the customer. The "NEW QUOTE" alert fires on
                             // submission; this one fires ~3.5 min later when the text
                             // really goes out, so he knows the customer has heard from
                             // him and can take over the conversation.
    predictive: true,        // predictive keyboard: next-word chips above the compose box,
                             // learned from the texts he's sent. Runs in the browser off a
                             // downloaded n-gram model — no API call, so it costs nothing.
    predictiveAi: false,     // the AI half of that keyboard: ghost text that finishes the
                             // sentence, one Gemini call per typing pause. Off by default
                             // because it was quietly the single biggest line on the AI
                             // bill (~29% of it) for a suggestion he mostly typed past.
                             // See docs/AI-COST.md.
    assistSms: true,         // text your own business number the bare facts ("375, thursday
                             // works") and the AI writes the customer reply in your voice.
                             // You supply every fact; the AI only does the wording.
    assistDelaySec: 60,      // cancel window before an assist reply actually goes out
    assistEmail: true,       // same thing by replying to the alert email — costs nothing,
                             // and the reply already knows which customer it's about
    assistEmailDelaySec: 180,// longer hold on the email path: a "cancel" reply has to make
                             // another trip through the inbox before it reaches us
    teamMode: false,         // when on: conversations can be assigned, and each reply is
                             // attributed to the sender. Turn off to go back to solo.
    team: [],                // [{ id, name, role }] — the people who help answer texts
    briefEnabled: true,      // the 6am daily brief (push + email). Off = never sent.
    briefHour: 6,            // local hour the brief fires (4–11)
    dailyEmailsPaused: true, // one switch over BOTH things that email him every single day:
                             // the morning brief and the evening "log today's money?" nudge.
                             // Paused 2026-08-25 at his request — he wasn't reading either,
                             // and two mails a day is the kind of noise that makes the alerts
                             // that DO matter (a customer texted) easy to scroll past. It sits
                             // in front of briefEnabled / money reminderEnabled rather than
                             // replacing them, so flipping it back restores whatever those
                             // were already set to. New key, so an existing stored config
                             // inherits the pause; weekly and monthly recaps are unaffected.
    playbook: defaultPlaybook(), // the business "brain" that trains every AI output
    detect: detDefaults(),   // auto-detecting appointments out of text conversations
    promise: promDefaults(), // catching "I'll get back to you Monday" and reminding him
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

// One KV read and ONE parse per invocation, however many callers ask for it.
// Each caller gets its own array so the existing habits still hold — sorting it
// (apiSnapshot), filtering it, or swapping an entry via applyIndexSummary can't
// leak into the next caller. Entries themselves are never mutated in place
// anywhere in this file; they're replaced wholesale, which is what makes the
// shallow copy enough.
async function loadIndex() {
  if (!IDX_CACHE) IDX_CACHE = (await kv().get(INDEX_KEY, { type: 'json' })) || [];
  return IDX_CACHE.slice();
}

// ⚠ KV WRITE — rewrites the entire index. In cron/loop code, mutate the index in
// memory and call this ONCE at the end, not once per thread (see note up top).
// Refreshing the cache here also closes a real hole: KV is eventually consistent,
// so a later sub-job in the same tick re-reading from KV could get the version
// from BEFORE this write and quietly undo it on its own save.
async function saveIndex(index) {
  await kv().put(INDEX_KEY, JSON.stringify(index));
  IDX_CACHE = index.slice();
}

function preview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// Stamp the first-touch source on a conversation. First writer wins — a customer
// who fills in the web quote form and THEN texts is still a 'quote' lead, which
// is the whole point of first-touch attribution.
function markSource(thread, src) {
  if (!thread.source) { thread.source = src; thread.sourceAt = thread.sourceAt || Date.now(); }
  return thread;
}
// Best guess for conversations that started before `source` existed. Ordered
// most- to least-certain. Anything that reaches the end is genuinely unknown and
// is reported as such rather than being lumped into a real channel.
function deriveSource(thread) {
  if (thread.source) return thread.source;
  const tags = thread.tags || [];
  if (tags.includes('booking')) return 'booking';
  const msgs = thread.messages || [];
  if (msgs.some((m) => m.kind === 'voicemail')) return 'call';
  if (/\bquote:/i.test(thread.notes || '')) return 'quote';
  const firstIn = msgs.filter((m) => m.dir === 'in')[0];
  if (firstIn) return 'text';
  return '';
}

// Build the lightweight index row for a thread. Pure (no KV) so cron loops can
// reuse it while holding the index in memory and batch a single saveIndex().
function buildIndexSummary(thread, cfg) {
  const last = thread.messages[thread.messages.length - 1];
  const plan = computeFollowupPlan(thread, Date.now(), cfg);
  const fu = thread.followup || {};
  // Whether the customer is genuinely waiting on Mikey. Only meaningful when they
  // spoke last; un-judged threads read as `true` so nothing goes missing.
  const rc = replyCheckFor(thread);
  const awaiting = !!(last && last.dir === 'in') && replyOwed(thread);
  // Only mirror a suggestion the current plan still agrees with — if the customer
  // just replied, the old nudge is stale and the badge should clear immediately.
  const sug = (fu.suggestion && plan && fu.suggestion.stepKey === plan.stepKey) ? fu.suggestion : null;
  return {
    phone: thread.phone,
    name: thread.name || '',
    tags: thread.tags || [],
    status: thread.status || '',
    statusAt: thread.statusAt || 0,
    // Mirrored into the index so the attribution report never has to load every
    // thread body. Derived here (not at read time) because the derivation needs
    // messages/notes, which the index row deliberately doesn't carry.
    source: thread.source || deriveSource(thread),
    sourceAt: thread.sourceAt || thread.createdAt || 0,
    firstTs: thread.createdAt || ((thread.messages || [])[0] || {}).ts || 0,
    pinned: !!thread.pinned,
    archived: !!thread.archived,
    assignedTo: thread.assignedTo || '',
    unread: thread.unread || 0,
    optedOut: isOptedOut(cfg, thread.phone),
    // Booked time (the day board finds the day's jobs from here without loading
    // every thread) plus the garage headline for the customer roster.
    appointmentAt: thread.appointmentAt || null,
    // A maintenance plan, mirrored whole so "who is due" can be answered from
    // the index alone — null for almost everyone, so it costs nothing.
    plan: thread.plan ? {
      every: thread.plan.every, paused: !!thread.plan.paused,
      askedAt: thread.plan.askedAt || 0, startedAt: thread.plan.startedAt || 0,
      lastJobAt: thread.plan.lastJobAt || 0,
      service: thread.plan.service || '', price: thread.plan.price || 0,
    } : null,
    hasGarage: !!(thread.garage && ((thread.garage.vehicles || []).length || thread.garage.address)),
    vehicleLabel: garageVehicleLabel(thread.garage),
    city: (thread.garage && thread.garage.city) || '',
    // The street line too, not just the city. The swipe-left peek has to answer
    // "where is this one" from the list row alone — reading the thread itself
    // would mark it read, which is exactly what peeking is meant to avoid.
    address: (thread.garage && thread.garage.address) || '',
    // A standing instruction Mikey gave in his own words ("doing her car in
    // August"). Mirrored here so the board and the AI advisor can both see WHY
    // someone is quiet without loading every thread.
    heldUntil: (fu.snoozeUntil && fu.snoozeUntil > Date.now()) ? fu.snoozeUntil : null,
    holdReason: (fu.snoozeUntil && fu.snoozeUntil > Date.now()) ? (fu.holdReason || '') : '',
    // An open quote and how long it has been sitting. Mirrored so "you quoted
    // them six days ago and never heard back" can be surfaced without loading
    // every thread — it's the most winnable money on the board.
    quoteAt: (thread.quote && thread.status !== 'won' && thread.status !== 'lost') ? (thread.quote.at || 0) : 0,
    quoteTotal: (thread.quote && thread.status !== 'won' && thread.status !== 'lost') ? (thread.quote.total || 0) : 0,
    reminderAt: thread.reminderAt || null,
    reminderNote: (thread.reminderNote || '').slice(0, 120),
    reminderDue: !!(thread.reminderAt && thread.reminderAt <= Date.now()),
    scheduledCount: (thread.scheduled || []).length,
    nextScheduledAt: (thread.scheduled && thread.scheduled.length) ? thread.scheduled[0].sendAt : null,
    replyReady: !!(thread.suggested && thread.suggested.text),
    dateRequested: !!thread.dateRequest,
    // Cheap content flags so the AI advisor/agent can filter on "has a voicemail"
    // or "sent a photo" without loading every thread body.
    hasVoicemail: (thread.messages || []).some((m) => m.kind === 'voicemail'),
    hasMedia: (thread.messages || []).some((m) => Array.isArray(m.media) && m.media.length),
    // One-line "what happened", mirrored so the peek renders it instantly and
    // only pays for an AI call the first time a conversation reaches a new
    // state. Goes empty the moment a new message lands, which is what makes the
    // front end ask for a fresh one — see recapFor().
    recap: (recapFor(thread) || {}).text || '',
    lastBody: last ? preview(last.body) : '',
    lastDir: last ? last.dir : '',
    lastTs: last ? last.ts : (thread.updatedAt || Date.now()),
    awaitingReply: awaiting,
    // Has the current inbound message been read for "is anything still open?"
    // yet? Lets the cron find the few threads that still need judging without
    // loading every conversation on every tick.
    replyChecked: !!rc,
    // Why we're NOT counting them as waiting ("Thanks — conversation wrapped up").
    closedReason: (!awaiting && rc && rc.needed === false) ? (rc.reason || 'Conversation wrapped up') : '',
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
  // First-touch attribution: an inbound message is how most conversations start,
  // so stamp the channel here (markSource keeps the first one that lands).
  if (message.dir === 'in') markSource(thread, message.kind === 'voicemail' ? 'call' : 'text');
  message.id = message.id || genId();
  message.ts = message.ts || Date.now();
  thread.messages.push(message);
  if (message.dir === 'in') thread.unread = (thread.unread || 0) + 1;
  // A customer reaching out beats any note Mikey left himself: an inbound text
  // ends a hold immediately, so "leave Sabine alone till August" never swallows
  // her when she actually writes in.
  if (message.dir === 'in' && thread.followup && (thread.followup.snoozeUntil || thread.followup.holdReason)) {
    thread.followup.snoozeUntil = null;
    thread.followup.holdReason = '';
    thread.followup.heldAt = 0;
  }
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

// How much conversation a CLASSIFY-style prompt gets. Input tokens dominate those
// calls — the full playbook is prepended to every one of them — and the last dozen
// turns is all "does he still owe a reply?" or "what happened here?" ever reads.
// Drafting deliberately keeps the full 40: holding his voice is worth the context.
const AI_CLASSIFY_TURNS = 12;

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
// ---------------------------------------------------------------------------
// Standing rules Mikey states in words ("stop using exclamation points",
// "never quote a full detail under $150").
// ---------------------------------------------------------------------------
// The AI already learns his VOICE by watching how he edits its drafts (see
// editsContext below). What it couldn't do was be told something outright. These
// are hard instructions, kept small and injected into every place that writes on
// his behalf, so a correction sticks instead of having to be re-made every time.
const RULES_KEY = 'ai:rules';
const RULES_MAX = 25;
async function loadRules() {
  const list = (await kv().get(RULES_KEY, { type: 'json' })) || [];
  return Array.isArray(list) ? list.filter((r) => r && r.text) : [];
}
async function addRule(text) {
  const t = String(text || '').trim().slice(0, 200);
  if (!t) return null;
  const list = await loadRules();
  // Same rule twice is a no-op rather than a duplicate line in every prompt.
  if (list.some((r) => r.text.toLowerCase() === t.toLowerCase())) return list;
  list.unshift({ id: genId(), text: t, at: Date.now() });
  const next = list.slice(0, RULES_MAX);
  await kv().put(RULES_KEY, JSON.stringify(next));
  return next;
}
async function removeRule(idOrText) {
  const key = String(idOrText || '').trim().toLowerCase();
  if (!key) return null;
  const list = await loadRules();
  const next = list.filter((r) => r.id !== idOrText && r.text.toLowerCase() !== key);
  if (next.length === list.length) return null;
  await kv().put(RULES_KEY, JSON.stringify(next));
  return next;
}
// Injected wherever the AI writes for Mikey. Phrased as non-negotiable, because
// that is what he means when he says one of these out loud.
async function rulesContext() {
  const list = await loadRules();
  if (!list.length) return '';
  return 'MIKEY\'S STANDING RULES — he told you these directly. They override anything else, including the playbook and your own instincts. Follow every one:\n'
    + list.map((r) => `- ${r.text}`).join('\n') + '\n\n';
}

// ---------------------------------------------------------------------------
// What the AI knows about the person it's writing to.
// ---------------------------------------------------------------------------
// Drafts used to be written from the message thread alone, which is why they
// read generically. Everything below is already stored on the conversation — the
// vehicle, where they are, Mikey's own notes, what they've paid — it just never
// reached the prompt.
function customerContext(thread, spend) {
  const L = [];
  const g = thread.garage || {};
  const vehicles = (g.vehicles || []).map((v) => [v.year, v.color, v.make, v.model].filter(Boolean).join(' ')).filter(Boolean);
  if (vehicles.length) L.push(`Vehicle${vehicles.length > 1 ? 's' : ''}: ${vehicles.join('; ')}`);
  if (g.city || g.address) L.push(`Where: ${[g.address, g.city].filter(Boolean).join(', ')}`);
  if (thread.status) L.push(`Lead status: ${thread.status}`);
  if (thread.appointmentAt) L.push(`Booked: ${new Date(thread.appointmentAt).toISOString().slice(0, 16).replace('T', ' ')}`);
  if (thread.notes) L.push(`Mikey's private notes (never quote these back): ${String(thread.notes).slice(0, 300)}`);
  if (spend && spend.jobs > 0) {
    L.push(`History: ${spend.jobs} job${spend.jobs > 1 ? 's' : ''} paid, $${spend.total} lifetime` +
      (spend.lastService ? `, last was ${spend.lastService}` : '') +
      (spend.lastDate ? ` on ${spend.lastDate}` : ''));
  }
  if (thread.followup && thread.followup.snoozeUntil && thread.followup.snoozeUntil > Date.now() && thread.followup.holdReason) {
    L.push(`Note: Mikey has this one on hold — "${thread.followup.holdReason}"`);
  }
  if (!L.length) return '';
  return 'WHO YOU ARE WRITING TO (use it to sound like you know them — never recite it back at them):\n' + L.map((x) => '- ' + x).join('\n') + '\n\n';
}

// Lifetime spend for one customer. Walks the last 12 monthly docs, same as the
// money-by-phone endpoint, and stays best-effort: the AI is nicer with it and
// still correct without it.
async function customerSpend(phone, cfg) {
  try {
    let m = localDateStr(Date.now(), cfg && cfg.tz).slice(0, 7);
    let total = 0, jobs = 0, lastService = '', lastDate = '';
    for (let i = 0; i < 12; i++) {
      const doc = await loadMonth(m);
      for (const e of (doc.entries || [])) {
        if (e.phone !== phone || e.type !== 'job') continue;
        total += Number(e.amount) || 0; jobs++;
        if (!lastDate || e.date > lastDate) { lastDate = e.date; lastService = e.service || ''; }
      }
      m = prevMonthKey(m);
    }
    return { total: Math.round(total * 100) / 100, jobs, lastService, lastDate };
  } catch { return null; }
}

const EDITS_KEY = 'ai:edits';
const EDITS_KEEP = 100;   // was 12 — enough to retrieve a *relevant* pattern, not just a recent one
async function loadEdits() {
  return (await kv().get(EDITS_KEY, { type: 'json' })) || [];
}
async function recordEdit(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to) return;
  if (to.length > 600 || from.length > 600) return; // skip outliers
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  // Sending a draft WORD FOR WORD is the strongest signal there is: the AI wrote
  // it and he shipped it. That used to be thrown away — now it's a positive
  // example that goes straight into the voice corpus.
  if (norm(from) === norm(to)) { await recordVoiceSample(to, 'accepted'); return; }
  const list = await loadEdits();
  list.unshift({ from, to, ts: Date.now() });
  await kv().put(EDITS_KEY, JSON.stringify(list.slice(0, EDITS_KEEP)));
  // His rewrite is, by definition, how he'd have said it.
  await recordVoiceSample(to, 'edited');
}
// Pull the edit pairs most relevant to the situation being drafted, not merely
// the most recent — a price rewrite teaches little about a scheduling reply.
async function editsContext(bucket) {
  const all = (await loadEdits()).filter((e) => e && e.from && e.to);
  if (!all.length) return '';
  const hits = bucket ? all.filter((e) => voiceBucket(e.to) === bucket) : [];
  const recent = hits.concat(all.filter((e) => !hits.includes(e))).slice(0, 6);
  const rows = recent.map((e) => `- The draft said: "${e.from}"\n  Mikey changed it to: "${e.to}"`).join('\n');
  return 'HOW MIKEY EDITS DRAFTS (these are his recent corrections — learn the PATTERN of how he rewrites: his length, warmth, word choices — and apply that style, not the specific content):\n' + rows + '\n\n';
}

// ===========================================================================
// VOICE — sounding like Mikey instead of like an assistant
// ===========================================================================
// The AI used to learn his voice from ten hand-written example texts while
// thousands of his real ones sat unread in KV. This module fixes that: it mines
// the messages he actually typed, buckets them by situation, derives a
// measurable fingerprint from them, and shows the model the ones that match the
// situation being drafted.
//
// Showing ten real texts beats any amount of describing the style in prose, and
// unlike a hand-written list it covers the situations that actually come up, in
// the proportions they actually come up.
const VOICE_KEY = 'voice:profile';
// Retrieval now ranks by relevance rather than taking the newest N, so a deeper pool
// is a straight win: more chance something genuinely close to the question is in
// there. 40 × 8 buckets ≈ 320 short texts, comfortably inside a single KV value.
const VOICE_PER_BUCKET = 40;    // kept per situation (retrieval ranks across all of them)
const VOICE_SHOW = 12;          // shown to the model per draft

// Situation buckets. Deterministic and free — no AI call to file a message.
const VOICE_BUCKETS = ['price', 'schedule', 'confirm', 'answer', 'apology', 'closing', 'quick', 'general'];
// Order matters. The rule: a message goes in the bucket whose OTHER messages it
// most resembles stylistically, because the bucket decides which of his real
// texts the model gets shown.
//
// Two consequences worth stating, since both are easy to get backwards:
//   - Bad news outranks its own subject. "Unfortunately I couldn't get a slot"
//     belongs with how he softens bad news, not with scheduling.
//   - A concrete day or time makes it scheduling even when it opens like a
//     confirmation. "You're all set for Tuesday" and "Perfect, let's shoot for
//     10:45" are the same kind of message and must not be split apart; `confirm`
//     is for agreements with no time in them ("Sounds good!", "Yep, will do").
function voiceBucket(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'general';
  if (/\$|\b\d{2,4}\b\s*(for|to|out the door)|\bprice|\bquote|\bcost/.test(t)) return 'price';
  if (/\b(sorry|unfortunately|apolog|my bad|ran late|running late)\b/.test(t)) return 'apology';
  // Bare clock times ("10:30", "let's shoot for 10:45") are how he actually writes
  // times — an am/pm suffix is the exception, not the rule.
  if (/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b|\btomorrow\b|\btoday\b|\bnext week\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\bmorning\b|\bafternoon\b|\bslot\b|\bschedule\b|\bavailab/.test(t)) return 'schedule';
  if (/^(yes|yep|yeah|perfect|sounds good|you'?re all set|got it|ok|okay|will do)\b/.test(t)) return 'confirm';
  if (/\b(thank|thanks|appreciate|means a lot|no worries)\b/.test(t)) return 'closing';
  if (/\?/.test(t)) return 'answer';
  if (t.length <= 40) return 'quick';
  return 'general';
}

// Is this outbound message actually HIS writing? Templates, follow-ups, booking
// texts and run-board messages are the app's words, not his — training on them
// would teach the AI to imitate itself, which is exactly the drift to avoid.
const VOICE_EXCLUDE_KINDS = ['followup', 'scheduled', 'booking', 'run', 'assist', 'auto', 'payment'];
function voiceUsable(m) {
  if (!m || m.dir !== 'out') return false;
  // src:'manual' means Mikey typed these exact words, which beats the kind guess: a
  // text he wrote and queued for later is 'scheduled', and a nudge he rewrote before
  // approving is 'followup', yet both are his voice. Without this a rebuild would
  // re-mine history and drop the samples the live path had already learned.
  if (m.src !== 'manual' && m.kind && VOICE_EXCLUDE_KINDS.includes(m.kind)) return false;
  const b = String(m.body || '').trim();
  if (b.length < 8 || b.length > 400) return false;
  if (/^https?:\/\/\S+$/.test(b)) return false;              // a bare link teaches nothing
  if (/- Mikey$/.test(b) && /water & power/.test(b)) return false; // stray template
  return true;
}

async function loadVoice() {
  return (await kv().get(VOICE_KEY, { type: 'json' })) || null;
}
// ⚠ KV WRITE — only on an explicit rebuild or when a training verdict lands.
async function saveVoice(v) { await kv().put(VOICE_KEY, JSON.stringify(v)); }

function emptyVoice() {
  const buckets = {};
  for (const b of VOICE_BUCKETS) buckets[b] = [];
  return { builtAt: 0, fingerprint: '', counts: {}, buckets };
}

// Add one sample to the corpus without a full rebuild. Used by the learning loop
// (accepted drafts, his rewrites, trainer verdicts) so the profile keeps
// sharpening between rebuilds.
async function recordVoiceSample(text, source) { return addVoiceSamples([text], source); }

// Batch version — one KV read and one write no matter how many samples, which
// matters when an import drops fifty of them in at once.
async function addVoiceSamples(list, source) {
  const v = (await loadVoice()) || emptyVoice();
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  let added = 0;
  for (const raw of (list || [])) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > 400) continue;
    const b = voiceBucket(t);
    v.buckets[b] = v.buckets[b] || [];
    if (v.buckets[b].some((x) => norm(x.t) === norm(t))) continue;   // already have it
    v.buckets[b].unshift({ t, s: source || 'sent', at: Date.now() });
    if (v.buckets[b].length > VOICE_PER_BUCKET) v.buckets[b].length = VOICE_PER_BUCKET;
    added++;
  }
  if (!added) return 0;
  for (const b of VOICE_BUCKETS) v.counts[b] = (v.buckets[b] || []).length;
  // Recount the measured style so it tracks live learning, not just rebuilds.
  // Pure arithmetic over what we already hold — no AI call, no extra read.
  v.style = measureStyle(v);
  await saveVoice(v);
  return added;
}

// ---------------------------------------------------------------------------
// Importing a transcript export
// ---------------------------------------------------------------------------
// The dashboard only knows the conversations that came through it. Years of his
// real texting lives in a phone export, and that is the best training data there
// is — so let him paste one in.
//
// Google Voice / Messages exports label each bubble for screen readers as
//   "Message from you, <text>, Tuesday, July 28 2026, 3:05 PM."
// which is a precise way to take HIS side and leave the customer's out. Anything
// that doesn't match that shape falls back to one-message-per-line, so a plain
// list of his texts works too.
const VOICE_MINE_RE = /Message from you,\s*([\s\S]*?),\s*(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s*[A-Z][a-z]+ \d{1,2} \d{4},\s*\d{1,2}:\d{2}\s*(?:AM|PM)\./g;

function parseTranscript(raw) {
  const text = String(raw || '');
  const out = [];
  let m;
  VOICE_MINE_RE.lastIndex = 0;
  while ((m = VOICE_MINE_RE.exec(text))) out.push(m[1]);
  if (out.length) return { mode: 'export', texts: out };
  // Fallback: a plain list. Drop anything that looks like the other side of the
  // conversation rather than guessing.
  const lines = text.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !/^(me|you|customer|them)\s*[:\-]/i.test(s));
  return { mode: 'lines', texts: lines };
}

// A bare link or a phone number is not a voice sample.
function voiceImportable(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length < 8 || s.length > 400) return false;
  if (/^https?:\/\/\S+$/i.test(s)) return false;
  if (/^[\w.]+\.(com|net|org)\/\S*$/i.test(s)) return false;   // "venmo.com/…" on its own
  if (/^[-+\d()\s.]+$/.test(s)) return false;                  // just a number
  return true;
}

async function apiVoiceImport(request) {
  const d = await readJson(request);
  const raw = String((d && d.text) || '').slice(0, 400000);
  if (!raw.trim()) return json({ ok: false, error: 'empty' }, 422);
  const parsed = parseTranscript(raw);
  const seen = new Set();
  const texts = [];
  for (const t of parsed.texts) {
    const s = String(t).replace(/\s+/g, ' ').trim();
    if (!voiceImportable(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;                                  // exports repeat every bubble
    seen.add(k); texts.push(s);
  }
  if (!texts.length) return json({ ok: false, error: 'nothing_found', mode: parsed.mode }, 422);
  const added = await addVoiceSamples(texts, 'import');
  // A fresh fingerprint is the point of importing — redo it over the new corpus.
  let fingerprint = '';
  if (aiConfigured()) {
    try {
      const v = await loadVoice();
      fingerprint = await deriveVoiceFingerprint(v, await loadConfig());
      if (fingerprint) { v.fingerprint = fingerprint; await saveVoice(v); }
    } catch { /* samples are in either way */ }
  }
  return json({ ok: true, mode: parsed.mode, found: texts.length, added, fingerprint });
}

// Walk every conversation and pull out the texts Mikey actually typed. Expensive
// (one KV read per thread) so it is never automatic — it runs when he taps
// "Rebuild my voice profile", and again after a training session.
async function buildVoiceProfile(opts = {}) {
  const index = await loadIndex();
  const cfg = await loadConfig();
  const prev = await loadVoice();
  const v = emptyVoice();
  let scanned = 0, kept = 0;
  // Newest conversations first: recent writing is the better model of how he
  // sounds now, and the per-bucket cap fills from the front.
  const rows = index.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 400);
  for (const e of rows) {
    if (isPracticePhone(e.phone)) continue;             // the fake customer isn't training data
    const thread = await loadThread(e.phone);
    for (const m of (thread.messages || [])) {
      scanned++;
      if (!voiceUsable(m)) continue;
      const b = voiceBucket(m.body);
      if (v.buckets[b].length >= VOICE_PER_BUCKET) continue;
      const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
      if (v.buckets[b].some((x) => norm(x.t) === norm(m.body))) continue;
      v.buckets[b].push({ t: String(m.body).trim(), s: 'sent', at: m.ts || 0 });
      kept++;
    }
  }
  // Carry over the samples a rebuild cannot re-derive. A pasted phone export never
  // existed as a thread, and trainer verdicts come from the practice number that the
  // scan above deliberately skips — so rebuilding from threads alone silently threw
  // away the best training data he had. Mined samples come first; these fill in
  // behind them, up to the same per-bucket cap.
  const VOICE_KEEP_SOURCES = ['import', 'trainer'];
  const vnorm = (s) => String(s || '').replace(/\s+/g, ' ').toLowerCase();
  for (const b of VOICE_BUCKETS) {
    for (const s of (prev && prev.buckets && prev.buckets[b]) || []) {
      if (!s || !s.t || !VOICE_KEEP_SOURCES.includes(s.s)) continue;
      if (v.buckets[b].length >= VOICE_PER_BUCKET) break;
      if (v.buckets[b].some((x) => vnorm(x.t) === vnorm(s.t))) continue;
      v.buckets[b].push(s);
      kept++;
    }
  }
  for (const b of VOICE_BUCKETS) v.counts[b] = v.buckets[b].length;
  v.builtAt = Date.now();
  v.scanned = scanned;
  v.kept = kept;
  v.style = measureStyle(v);   // free, and it drives both the prompt and the gate
  // Derive the fingerprint from the real samples. One AI call, and the only one
  // this whole build makes.
  if (kept >= 12 && opts.fingerprint !== false) {
    try { v.fingerprint = await deriveVoiceFingerprint(v, cfg); } catch { v.fingerprint = ''; }
  }
  await saveVoice(v);
  return v;
}

// ---------------------------------------------------------------------------
// Measured style — counted, not described
// ---------------------------------------------------------------------------
// The AI-written fingerprint below is useful but it is still one model's prose
// about another model's target. These are just counts over his real texts, so
// they cannot drift or flatter: the model gets told his actual median length in
// characters, how often he really uses an emoji, whether he opens with a name.
// Free (no AI call), recomputed on every build, and the same numbers drive the
// output gate in styleViolation() so the rule that goes in is the rule enforced.
function measureStyle(v) {
  const all = [];
  for (const b of VOICE_BUCKETS) for (const x of (v.buckets[b] || [])) if (x && x.t) all.push(String(x.t));
  if (all.length < 8) return null;
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const pct = (n) => Math.round((n / all.length) * 100);
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const lens = all.map((t) => t.length);
  const sentences = all.map((t) => (t.match(/[.!?]+(\s|$)/g) || []).length || 1);
  return {
    n: all.length,
    medLen: med(lens),
    p90Len: lens.slice().sort((a, b) => a - b)[Math.floor(lens.length * 0.9)],
    maxLen: Math.max(...lens),
    medSentences: med(sentences),
    emojiPct: pct(all.filter((t) => EMOJI.test(t)).length),
    exclaimPct: pct(all.filter((t) => t.includes('!')).length),
    // "Hey Ruth!" / "Good morning" — does he open by addressing them, or dive in?
    greetPct: pct(all.filter((t) => /^(hey|hi|hello|good (morning|afternoon|evening))\b/i.test(t)).length),
    questionPct: pct(all.filter((t) => t.includes('?')).length),
    lowerStartPct: pct(all.filter((t) => /^[a-z]/.test(t)).length),
    smileyPct: pct(all.filter((t) => /:\)|:-\)/.test(t)).length),
  };
}

// The measured numbers as prompt rules. Deliberately phrased as ranges and
// frequencies so the model has room to write naturally inside his real habits
// rather than mimicking one sample.
function measuredStyleRules(st) {
  if (!st) return '';
  const L = [];
  L.push(`- Length: his texts run about ${st.medLen} characters typically; ${st.p90Len} is already long for him. Do not exceed ${Math.max(st.p90Len, 160)}.`);
  L.push(`- Sentences: usually ${st.medSentences === 1 ? 'ONE sentence' : st.medSentences + ' short sentences'}.`);
  L.push(`- Opening: he starts with a greeting or their name in only ${st.greetPct}% of texts — ${st.greetPct < 30 ? 'so usually dive straight in with no greeting' : 'so a short greeting is normal'}.`);
  L.push(`- Emoji: ${st.emojiPct === 0 ? 'he never uses emoji. Use none.' : `about ${st.emojiPct}% of his texts have one — so most have none.`}`);
  if (st.smileyPct >= 5) L.push(`- He writes a plain ":)" in about ${st.smileyPct}% of texts.`);
  L.push(`- Exclamation marks: in about ${st.exclaimPct}% of his texts${st.exclaimPct < 50 ? ' — not every message' : ''}.`);
  if (st.lowerStartPct >= 15) L.push(`- He begins about ${st.lowerStartPct}% of texts in lowercase; that is normal for him.`);
  return 'HIS STYLE, MEASURED FROM ' + st.n + ' REAL TEXTS (these are counts, not opinions — match them):\n' + L.join('\n');
}

// Turn the corpus into MEASURABLE rules — "one exclamation mark every third
// message", "never says Certainly" — rather than adjectives. Evidence beats the
// hand-written tone paragraph because it describes what he actually does.
async function deriveVoiceFingerprint(v, cfg) {
  const sample = [];
  for (const b of VOICE_BUCKETS) for (const x of (v.buckets[b] || []).slice(0, 18)) sample.push(x.t);
  if (sample.length < 12) return '';
  const prompt =
    `Below are real text messages a mobile car detailer sent his customers. Study them and write a STYLE FINGERPRINT ` +
    `another writer could follow to be indistinguishable from him.\n\n` +
    `Return ONLY plain text, max 200 words, as short factual bullets. Be MEASURABLE, not complimentary — ` +
    `state typical sentence count and length, greeting habits (does he open with a name? dive straight in?), ` +
    `capitalisation, punctuation and dash habits, emoji (which ones, roughly how often), contractions, sign-offs, ` +
    `recurring phrases he actually uses, and how he softens bad news. ` +
    `Finish with a line starting exactly "NEVER: " listing things he never does.\n\n` +
    `Do not quote the messages back. Do not praise him. Just the rules.\n\n` +
    sample.map((s) => `- ${s}`).join('\n');
  const text = await aiGenerate(prompt, { surface: 'voice training', tier: 'fast', maxTokens: 800, temperature: 0.2 });
  return String(text || '').trim().slice(0, 1600);
}

// ---------------------------------------------------------------------------
// Retrieval — which of his texts the model actually gets shown
// ---------------------------------------------------------------------------
// This is the highest-signal part of the prompt, so it is worth doing properly.
// Bucketing alone is coarse: it answers "is this about scheduling?" but not "which
// of his 24 scheduling texts is closest to what this customer just asked?" — and
// it hands over the NEWEST 24, which on a repetitive bucket can be twelve near-
// copies of "sounds good".
//
// So: score every sample against the actual incoming message by shared rare words,
// boost same-bucket ones, and drop candidates that duplicate something already
// picked. No embeddings and no vector store — over a few hundred short texts, IDF
// overlap gets most of the benefit for none of the infrastructure, and it runs in
// well under a millisecond inside the Worker.
const VOICE_STOP = new Set(('a an the and or but if to of for on in at is are was were be been am do does did have has had ' +
  'i you he she it we they me him her them my your his their this that these those with as by from up out so no not ' +
  'can could will would should may might just get got go going about what when where who how why yes yeah ok okay ' +
  'll ve re s t d m thanks thank please hey hi').split(' '));
function voiceTokens(s) {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9$]+/)) {
    if (w.length < 2 || VOICE_STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}
// Jaccard over token sets — used to reject a candidate that says the same thing as
// one already chosen, so the model sees variety rather than the same text twice.
function voiceOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// Rank his real texts by relevance to what the customer actually said.
function pickVoiceExamples(voice, bucket, query, limit) {
  const rows = [];
  for (const b of VOICE_BUCKETS) {
    for (const x of (voice.buckets[b] || [])) {
      if (x && x.t) rows.push({ t: String(x.t), bucket: b, toks: voiceTokens(x.t) });
    }
  }
  if (!rows.length) return [];
  const q = voiceTokens(query);

  // Document frequency, so a word like "detail" (in half his texts) counts for far
  // less than "ceramic" or "Tuesday".
  const df = new Map();
  for (const r of rows) for (const t of r.toks) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + rows.length / (1 + (df.get(t) || 0)));

  for (const r of rows) {
    let s = 0;
    for (const t of r.toks) if (q.has(t)) s += idf(t);
    // Normalised so a long text does not win on sheer word count.
    r.score = s / Math.sqrt(r.toks.size + 1);
    if (r.bucket === bucket) r.score += 0.6;   // same situation is real evidence
  }
  rows.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const r of rows) {
    if (picked.length >= limit) break;
    // Near-duplicate of something already shown teaches nothing new.
    if (picked.some((p) => voiceOverlap(p.toks, r.toks) > 0.6)) continue;
    picked.push(r);
  }
  // If dedupe was aggressive on a thin corpus, top back up rather than show too few.
  if (picked.length < Math.min(6, rows.length)) {
    for (const r of rows) {
      if (picked.length >= limit) break;
      if (!picked.includes(r)) picked.push(r);
    }
  }
  return picked;
}

// What goes into a draft prompt: the measured numbers, the AI-derived fingerprint,
// and his real texts closest to the message being answered.
function voiceContext(voice, bucket, query) {
  if (!voice) return '';
  const out = [];
  const measured = measuredStyleRules(voice.style);
  if (measured) out.push(measured);
  if (voice.fingerprint) {
    out.push('HOW MIKEY WRITES (derived from his real texts — follow this exactly):\n' + voice.fingerprint);
  }
  const picked = pickVoiceExamples(voice, bucket, query || '', VOICE_SHOW);
  if (picked.length) {
    out.push(
      `REAL TEXTS MIKEY SENT, closest first, mostly from this same kind of moment (${bucket}). Match their rhythm, ` +
      `length and word choice — these are the target, not the playbook's phrasing. Copy the STYLE, never the specific ` +
      `prices, times or names, which belong to other conversations:\n` + picked.map((r) => `- "${r.t}"`).join('\n'),
    );
  }
  return out.length ? out.join('\n\n') + '\n\n' : '';
}

// ---------------------------------------------------------------------------
// The tell-blocker
// ---------------------------------------------------------------------------
// Being spotted as AI is mostly about a handful of characteristic phrases, not
// about missing warmth. Cheaper and more reliable to ban them outright than to
// ask the model nicely.
const AI_TELLS = [
  /\bcertainly[!,.]/i, /\bi'?d be happy to\b/i, /\bhappy to assist\b/i, /\bfeel free to\b/i,
  /\brest assured\b/i, /\bat your earliest convenience\b/i, /\bplease don'?t hesitate\b/i,
  /\blet me know if you have any (other )?questions\b/i, /\bi hope this (message )?finds you\b/i,
  /\bthank you for reaching out\b/i, /\bi understand your concern\b/i, /\bgreat question\b/i,
  /\bas an ai\b/i, /\bi'?m here to help\b/i, /\bplease be advised\b/i, /\bkindly\b/i,
  /\bdelve\b/i, /\bit('?s| is) worth noting\b/i, /\bthat said,/i, /—/,   // em-dash: he doesn't use them
];
function findTell(text) {
  for (const re of AI_TELLS) { const m = String(text || '').match(re); if (m) return m[0]; }
  return '';
}

// The other half of the gate. A tell is a phrase; this catches drafts that use no
// banned phrase but still don't read like him — three times his usual length, an
// emoji when he almost never uses one, "Hi Sarah," when he never opens with a
// greeting. Measured against his own counts, so the bar is his habits and not some
// generic idea of a good text. Returns a fixable instruction, or ''.
function styleViolation(text, st) {
  if (!st || !text) return '';
  const t = String(text).trim();
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  // Generous ceiling: 1.6× his 90th percentile, floor 160, so only real bloat trips.
  const ceiling = Math.max(Math.round((st.p90Len || 120) * 1.6), 160);
  if (t.length > ceiling) {
    return `it is ${t.length} characters, and his texts run about ${st.medLen}. Cut it to roughly ${st.medLen}–${st.p90Len} characters — say less`;
  }
  if (st.emojiPct <= 5 && EMOJI.test(t)) {
    return 'it uses an emoji, and he essentially never does. Remove it';
  }
  if (st.greetPct <= 15 && /^(hey|hi|hello|good (morning|afternoon|evening))\b[\s,!]*[A-Z][a-z]+[,!]/i.test(t)) {
    return 'it opens by greeting them by name, and he almost never does. Start with the actual answer';
  }
  const sentences = (t.match(/[.!?]+(\s|$)/g) || []).length || 1;
  if (st.medSentences <= 2 && sentences >= 5) {
    return `it runs ${sentences} sentences and he usually writes ${st.medSentences}. Make it shorter`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// The replay trainer
// ---------------------------------------------------------------------------
// Find a real moment from the past — a customer texted, Mikey answered — and
// have the AI write what it would say now. Show both, unlabelled effort on his
// part: one tap says whether it sounds like him.
//
// This is the only source of NEGATIVE signal in the whole system. The corpus
// learns how he writes; only the trainer learns which drafts he'd have thrown
// out. It doubles as the scoreboard: the match rate is the number to watch.
const VOICE_SCORE_KEY = 'voice:scores';

async function loadVoiceScores() {
  return (await kv().get(VOICE_SCORE_KEY, { type: 'json' })) || { rounds: [], match: 0, off: 0 };
}

// Pick one past exchange to replay. Prefers conversations we haven't drilled yet
// and messages long enough to actually carry a voice.
// Returns a BATCH of ready-to-judge cards, with the drafts written in parallel.
//
// The old version served one card per request and re-walked the whole index and
// every thread to find it, so each tap cost a fresh scan plus a serial AI call —
// seconds of staring at a spinner per verdict. Now: scan once, collect every
// candidate moment as cheap metadata, then draft several at once. The client keeps
// a queue and prefetches, so tapping a verdict advances with no wait at all.
const REPLAY_SCAN_THREADS = 60;
const REPLAY_BATCH_MAX = 6;
async function apiVoiceReplayNext(request) {
  if (!aiConfigured()) return json({ ok: false, error: 'ai_not_configured' }, 503);
  const d = await readJson(request).catch(() => ({}));
  const seen = new Set((Array.isArray(d && d.seen) ? d.seen : []).map(String));
  const want = Math.max(1, Math.min(REPLAY_BATCH_MAX, Number((d && d.count) || 4)));
  const cfg = await loadConfig();
  const index = await loadIndex();
  const rows = index.filter((e) => !e.archived && !isPracticePhone(e.phone))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, REPLAY_SCAN_THREADS);

  // One parallel pass over the threads, collecting every moment worth replaying:
  // a customer message he answered himself. No AI yet — this is just bookkeeping.
  const threads = await batchLoadThreads(rows.map((e) => e.phone));
  const cands = [];
  for (const thread of threads) {
    const msgs = thread.messages || [];
    for (let i = msgs.length - 1; i > 0; i--) {
      const reply = msgs[i], asked = msgs[i - 1];
      if (!voiceUsable(reply)) continue;
      if (!asked || asked.dir !== 'in' || !String(asked.body || '').trim()) continue;
      const id = `${thread.phone}:${reply.ts}`;
      if (seen.has(id)) continue;
      cands.push({
        id, phone: thread.phone, name: thread.name || '', i, thread,
        customer: String(asked.body || '').slice(0, 400),
        mine: String(reply.body || '').trim(),
        bucket: voiceBucket(asked.body),
        ts: reply.ts || 0,
      });
    }
  }
  if (!cands.length) return json({ ok: true, done: true, cards: [] });

  // Spread the batch across situations and conversations rather than serving four
  // near-identical scheduling moments from one thread — a mixed batch tells him far
  // more about where the voice actually breaks down.
  cands.sort((a, b) => b.ts - a.ts);
  const byBucket = new Map();
  for (const c of cands) {
    if (!byBucket.has(c.bucket)) byBucket.set(c.bucket, []);
    byBucket.get(c.bucket).push(c);
  }
  const order = [];
  const lists = [...byBucket.values()];
  for (let round = 0; order.length < cands.length; round++) {
    let addedAny = false;
    for (const l of lists) {
      if (round < l.length) { order.push(l[round]); addedAny = true; }
      if (order.length >= want * 3) break;   // enough to choose from; stop early
    }
    if (!addedAny) break;
  }
  const chosen = [];
  const usedPhones = new Set();
  for (const c of order) {                    // first pass: one per conversation
    if (chosen.length >= want) break;
    if (usedPhones.has(c.phone)) continue;
    usedPhones.add(c.phone);
    chosen.push(c);
  }
  for (const c of order) {                    // top up if he has few conversations
    if (chosen.length >= want) break;
    if (!chosen.includes(c)) chosen.push(c);
  }

  // Draft them all at once. Each one sees the thread as it stood at that moment, so
  // the AI answers the same question with the same history — never with hindsight.
  const cards = await Promise.all(chosen.map(async (c) => {
    const asOf = Object.assign({}, c.thread, { messages: (c.thread.messages || []).slice(0, c.i) });
    try {
      const draft = await generateReply(asOf, cfg, '');
      if (!draft) return null;
      return { id: c.id, phone: c.phone, name: c.name, customer: c.customer, mine: c.mine, ai: draft, bucket: c.bucket };
    } catch { return null; }   // one failed draft shouldn't sink the whole batch
  }));
  const out = cards.filter(Boolean);
  if (!out.length) return json({ ok: false, error: 'draft_failed' }, 502);
  return json({ ok: true, cards: out, remaining: Math.max(0, cands.length - out.length) });
}

// Record a verdict. "Off" is the valuable one — it feeds his real wording back
// in as a positive example AND records the AI's attempt as a thing to avoid.
async function apiVoiceReplayScore(request) {
  const d = await readJson(request);
  const id = String((d && d.id) || '').slice(0, 80);
  const verdict = (d && d.verdict) === 'match' ? 'match' : 'off';
  const mine = String((d && d.mine) || '').trim();
  const ai = String((d && d.ai) || '').trim();
  if (!id) return json({ ok: false, error: 'bad_request' }, 422);

  // Which situation this round was, so the scoreboard can say WHERE it's weak. A
  // single global percentage tells him the voice is 78% right but not that pricing
  // is the half that's wrong — and pricing is the half worth fixing.
  const bucket = VOICE_BUCKETS.includes(d && d.bucket) ? d.bucket : 'general';

  const s = await loadVoiceScores();
  s.rounds.unshift({ id, verdict, at: Date.now(), b: bucket });
  if (s.rounds.length > 200) s.rounds.length = 200;
  s[verdict] = (s[verdict] || 0) + 1;
  s.byBucket = s.byBucket || {};
  const bb = s.byBucket[bucket] || (s.byBucket[bucket] = { match: 0, off: 0 });
  bb[verdict] = (bb[verdict] || 0) + 1;
  await kv().put(VOICE_SCORE_KEY, JSON.stringify(s));

  // His real words are always worth having in the corpus.
  if (mine) await recordVoiceSample(mine, verdict === 'off' ? 'trainer' : 'sent');
  // A miss is a before→after pair: what the AI wrote, and what he'd have written.
  if (verdict === 'off' && mine && ai) { try { await recordEdit(ai, mine); } catch { /* non-fatal */ } }
  return json({ ok: true, scores: { match: s.match || 0, off: s.off || 0 }, byBucket: s.byBucket });
}

// ===========================================================================
// TYPING MODEL — the predictive keyboard's local half
// ===========================================================================
// The voice profile above already holds the texts he really wrote, filed by
// situation. This boils that same corpus down into something a browser can run
// on every keystroke: the words he opens messages with, which word tends to
// follow which (1- and 2-word context), and his real vocabulary — so "app"
// completes to "appointment" and not to the dictionary's "apple".
//
// Built from the voice corpus on purpose. It is already de-templated (see
// voiceUsable) and it includes the messages imported from his Google Voice
// history, which never existed as threads in KV. One KV read instead of eighty.
//
// KV cost: ONE write per rebuild, and only when the cached model is older than
// STYLE_TTL — about 2 writes/day.
const STYLE_KEY = 'ai:style';
const STYLE_TTL = 12 * 60 * 60 * 1000;   // rebuild at most twice a day
const STYLE_MAX_KEYS = 1400;             // n-gram contexts kept (payload size guard)
const STYLE_MAX_WORDS = 500;             // vocabulary kept for prefix completion
let STYLE_CACHE = null;

// Words as a texter types them: letters/digits, plus the apostrophes, hyphens
// and $ that show up in real messages ("I'll", "add-on", "$160").
function styleTokens(body) {
  return String(body || '').match(/[A-Za-z0-9$][A-Za-z0-9'’\-$%]*/g) || [];
}

function buildStyleFrom(bodies) {
  const next = new Map();       // context (lowercased, 1 or 2 words) -> Map(word -> count)
  const starters = new Map();   // first word of a message -> count
  const vocab = new Map();      // lowercased word -> count
  const surface = new Map();    // lowercased word -> Map(as-typed form -> count)
  let used = 0;

  const bumpNext = (ctx, word) => {
    let m = next.get(ctx);
    if (!m) { m = new Map(); next.set(ctx, m); }
    m.set(word, (m.get(word) || 0) + 1);
  };
  const noteForm = (w) => {
    const k = w.toLowerCase();
    let m = surface.get(k);
    if (!m) { m = new Map(); surface.set(k, m); }
    m.set(w, (m.get(w) || 0) + 1);
  };
  // The casing he actually uses most for a word ("I'll", "Mikey", "Tuesday").
  const asTyped = (k) => {
    const m = surface.get(k);
    if (!m) return k;
    let best = k, bestN = -1;
    for (const [form, n] of m) if (n > bestN) { bestN = n; best = form; }
    return best;
  };

  for (const raw of bodies) {
    const body = String(raw || '').replace(/https?:\/\/\S+/g, ' ').trim();
    if (!body || body.length > 400) continue;
    const toks = styleTokens(body);
    if (toks.length < 2) continue;
    used++;
    starters.set(toks[0], (starters.get(toks[0]) || 0) + 1);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      const lw = w.toLowerCase();
      noteForm(w);
      vocab.set(lw, (vocab.get(lw) || 0) + 1);
      if (i === 0) continue;
      const p1 = toks[i - 1].toLowerCase();
      bumpNext(p1, lw);
      if (i > 1) bumpNext(toks[i - 2].toLowerCase() + ' ' + p1, lw);
    }
  }

  // Rank + prune. Keep the contexts he uses most, up to 4 predictions each, and
  // drop the one-offs — a word he typed once isn't a habit worth predicting.
  const total = (m) => { let s = 0; for (const n of m.values()) s += n; return s; };
  const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const outNext = {};
  for (const [ctx, m] of [...next.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, STYLE_MAX_KEYS)) {
    const picks = top(m, 4).filter(([, n]) => n >= 2 || ctx.indexOf(' ') > 0).map(([w]) => asTyped(w));
    if (picks.length) outNext[ctx] = picks;
  }
  return {
    builtAt: Date.now(),
    n: used,
    start: top(starters, 8).map(([w]) => w),
    next: outNext,
    // Vocabulary for prefix completion. Frequency-ranked and capped rather than
    // threshold-filtered, so the long, distinctive words he types — the ones
    // actually worth completing — survive the cut.
    words: top(vocab, STYLE_MAX_WORDS).map(([w]) => asTyped(w)),
  };
}

async function rebuildStyleModel() {
  const voice = await loadVoice();
  const bodies = [];
  if (voice) {
    for (const b of VOICE_BUCKETS) for (const x of (voice.buckets[b] || [])) if (x && x.t) bodies.push(String(x.t));
  }
  // Nothing trained yet (a fresh install, or before the first voice build) — fall
  // back to reading his sent messages straight off the recent threads, so the
  // keyboard still knows him on day one.
  if (bodies.length < 20) {
    const index = await loadIndex();
    const phones = index.slice().sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .slice(0, 60).map((e) => e.phone).filter(Boolean);
    for (const t of await batchLoadThreads(phones)) {
      for (const m of (t.messages || [])) if (voiceUsable(m)) bodies.push(String(m.body));
    }
  }
  return buildStyleFrom(bodies);
}

async function loadStyleModel(force) {
  const now = Date.now();
  if (!force && STYLE_CACHE && now - (STYLE_CACHE.builtAt || 0) < STYLE_TTL) return STYLE_CACHE;
  if (!force) {
    const cached = await kv().get(STYLE_KEY, { type: 'json' }).catch(() => null);
    if (cached && now - (cached.builtAt || 0) < STYLE_TTL) { STYLE_CACHE = cached; return cached; }
  }
  const model = await rebuildStyleModel();
  await kv().put(STYLE_KEY, JSON.stringify(model));
  STYLE_CACHE = model;
  return model;
}

// GET /api/ai/style — the browser downloads this once and predicts locally from
// it, so word suggestions land as fast as the phone keyboard's. ?force=1
// retrains it on demand (after an import, or a batch of new texts).
async function apiAiStyle(url) {
  try {
    const model = await loadStyleModel(url.searchParams.get('force') === '1');
    return json({ ok: true, style: model, ttl: STYLE_TTL });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}

// Rolling one-minute cap on predictive-keyboard calls, held in the isolate (no
// KV writes). Not a precise global limit — a cheap ceiling so a long typing
// session can't starve the AI features that matter more.
const PREDICT_PER_MIN = 12;
let PREDICT_HITS = [];
function predictBudgetOk() {
  const now = Date.now();
  PREDICT_HITS = PREDICT_HITS.filter((t) => now - t < 60000);
  if (PREDICT_HITS.length >= PREDICT_PER_MIN) return false;
  PREDICT_HITS.push(now);
  return true;
}

// Normalise a completion without touching its leading space — that space is load
// bearing here (it decides whether we're finishing his word or starting the next
// one), so cleanReply's trim() would corrupt it.
function cleanCompletion(raw) {
  let t = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/g, '');
  t = t.replace(/\s*—\s*/g, ' - ').replace(/\s*–\s*/g, ' - ');   // dashes he never types
  t = t.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
  return t.slice(0, 160);
}

// POST /api/ai/predict — the smart half of the keyboard. Given what he's typed so
// far, finish the sentence the way HE would, in THIS conversation. Deliberately
// tiny: the fast model, a few lines of transcript, a short output cap. It has to
// feel like a keyboard, not like waiting on a chatbot.
async function apiAiPredict(request) {
  const data = await readJson(request);
  const phone = normalizePhone(data.phone);
  const text = String(data.text || '').slice(0, 400);
  if (!ENV.GEMINI_API_KEY && !ENV.ANTHROPIC_API_KEY) return json({ ok: false, error: 'no_ai' }, 503);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  // Off by default. The browser already knows this and shouldn't be calling, but
  // a stale tab (or a cached shell after a deploy) still can — and the whole
  // point of the switch is that no call gets paid for while it's off. `no_ai` is
  // the answer the keyboard already understands: it stops asking and carries on
  // with its free local half.
  const preCfg = await loadConfig();
  if (preCfg.predictiveAi !== true) return json({ ok: false, error: 'no_ai' }, 503);
  // A typing suggestion is the least important thing the AI does here. Over
  // budget, drop it quietly — the keyboard falls back to its local model.
  if (!predictBudgetOk()) return json({ ok: true, completion: '', options: [], throttled: true });
  try {
    const [thread, cfg, voice, model] = await Promise.all([
      loadThread(phone), loadConfig(), loadVoice(), loadStyleModel(false).catch(() => null),
    ]);
    const msgs = thread.messages || [];
    const lastIn = [...msgs].reverse().find((m) => m.dir === 'in');
    // Retrieve his real texts by what he's writing about — the half-typed line
    // itself is the best clue, with the customer's last message behind it.
    const situation = text || (lastIn && lastIn.body) || '';
    const bucket = voiceBucket(situation);
    const convo = transcript(thread, 8);
    const prompt =
      businessContext(cfg) +
      voiceContext(voice, bucket, situation) +
      `You are the predictive keyboard inside Mikey's texting app — like the next-word suggestions on a phone keyboard, except it knows how Mikey writes and it knows this conversation. ` +
      `He is part-way through typing a text to this customer. Predict how HE would finish it.\n\n` +
      `Return ONLY JSON: {"completion": "...", "options": ["...", "...", "..."]}\n` +
      `- "completion": the rest of what he's typing. It gets appended to his text character-for-character, so it has to read correctly glued straight on: never repeat a word he already typed, and get the leading space right — if he stopped part-way through a word, start with the REST OF THAT WORD and no leading space; if he finished a word, start with a single leading space. Keep it to what plausibly comes next — the rest of this sentence, roughly 3-12 words, ending cleanly. Empty string if nothing sensible follows.\n` +
      `- "options": 3 single words or 2-3 word fragments that could come next, shortest first. Continuations only, never a repeat of what he typed.\n` +
      `Match the real texts above — his length, his rhythm, his punctuation. No customer-service filler. Never invent a price, date or time he hasn't given; if a number would come next, stop the completion before it. Never add a greeting or sign-off he didn't start.\n\n` +
      (convo ? `Conversation so far:\n${convo}\n\n` : '') +
      `Mikey is typing: "${text}"\n\nJSON:`;
    const out = await aiGenerate(prompt, { surface: 'keyboard', tier: 'fast', json: true, temperature: 0.35, maxTokens: 220 });
    let parsed = {};
    try { parsed = JSON.parse(out); } catch { parsed = {}; }
    // Belt and braces: models echo the typed text back. Strip that overlap so we
    // only ever hand back a continuation.
    const trim = (s) => {
      let v = cleanCompletion(s).replace(/^["']|["']$/g, '');
      const low = v.toLowerCase(); const t = text.toLowerCase().trim();
      if (t && low.startsWith(t)) v = v.slice(t.length);
      // Or it repeated just the tail of what he typed (the last few words).
      const tail = t.split(/\s+/).slice(-4).join(' ');
      if (tail.length > 6 && v.toLowerCase().trim().startsWith(tail)) v = v.trim().slice(tail.length);
      return v;
    };
    let completion = trim(parsed.completion);
    // A stock AI phrase is worse than no suggestion — drop it rather than spend a
    // second call regenerating. This is a keyboard; the next keystroke is coming.
    if (findTell(completion)) completion = '';
    const options = (Array.isArray(parsed.options) ? parsed.options : [])
      .map(trim).map((s) => s.trim()).filter((s) => s && !findTell(s)).slice(0, 3);
    return json({ ok: true, completion, options, model: model ? model.n : 0 });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

// The scoreboard. "% sounds like me" from the trainer is the headline; the
// corpus counts tell him whether there's enough material to learn from.
// Everything the Train AI screen renders, in one request: how much material it has
// per situation, how it's scoring per situation, the measured style, and which model
// is actually writing. Also computes the ONE next action worth taking, so the screen
// can show a single obvious button instead of a row of equal-looking ones.
async function apiVoiceStats() {
  const v = await loadVoice();
  const s = await loadVoiceScores();
  const total = (s.match || 0) + (s.off || 0);
  const buckets = {};
  let samples = 0;
  if (v) for (const b of VOICE_BUCKETS) { const n = (v.buckets[b] || []).length; buckets[b] = n; samples += n; }

  // Per-situation scoreboard: rate plus how many rounds back it, so a 0% off one
  // round doesn't read like a crisis.
  const perBucket = {};
  for (const b of VOICE_BUCKETS) {
    const r = (s.byBucket && s.byBucket[b]) || null;
    const n = r ? (r.match || 0) + (r.off || 0) : 0;
    perBucket[b] = { samples: buckets[b] || 0, rounds: n, rate: n ? Math.round(((r.match || 0) / n) * 100) : null };
  }

  const provider = ENV.ANTHROPIC_API_KEY && !envFlag('CLAUDE_DISABLED') ? 'claude' : (ENV.GEMINI_API_KEY ? 'gemini' : 'none');

  // The single most useful next step, in priority order.
  let next = 'train';
  if (provider === 'none') next = 'no_ai';
  else if (samples < 12) next = 'build';                     // nothing to learn from yet
  else if (!(v && v.fingerprint)) next = 'build';            // never derived the style
  else if (samples < 60) next = 'import';                    // thin — more real texts help most
  else if (total < 10) next = 'train';                       // unmeasured
  else {
    // Weakest situation with enough evidence to trust, if any is clearly behind.
    let worst = null;
    for (const b of VOICE_BUCKETS) {
      const p = perBucket[b];
      if (p.rounds >= 3 && p.rate != null && p.rate < 70 && (!worst || p.rate < perBucket[worst].rate)) worst = b;
    }
    next = worst ? 'train' : 'good';
  }

  return json({
    ok: true,
    built: !!(v && v.builtAt), builtAt: (v && v.builtAt) || 0,
    fingerprint: (v && v.fingerprint) || '',
    style: (v && v.style) || null,
    samples, buckets, perBucket, scanned: (v && v.scanned) || 0,
    matchRate: total ? Math.round(((s.match || 0) / total) * 100) : null,
    rounds: total, match: s.match || 0, off: s.off || 0,
    recent: (s.rounds || []).slice(0, 20).map((r) => ({ verdict: r.verdict, at: r.at || 0, bucket: r.b || '' })),
    provider, next,
    perBucketCap: VOICE_PER_BUCKET,
  });
}

async function apiVoiceBuild() {
  if (!aiConfigured()) return json({ ok: false, error: 'ai_not_configured' }, 503);
  try {
    const v = await buildVoiceProfile();
    return json({ ok: true, samples: v.kept, scanned: v.scanned, buckets: v.counts, fingerprint: v.fingerprint });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, 502);
  }
}

// Proactively pre-draft a reply the instant a customer texts, so one is already
// waiting when Mikey opens the thread ("reply already waiting"). Best-effort: it
// never blocks or fails the inbound webhook, and only runs when the ball is in
// Mikey's court (last message is inbound, not opted out, not archived).
// Returns { text, verdict } — the drafted text (or '' when there's nothing to
// draft) so the caller can show it in the alert and ask for a yes/no, plus the
// reply-needed verdict it worked out on the way. The verdict is worth handing
// back rather than recomputing: the caller uses it to decide whether the inbound
// is even worth a triage call (see handleInboundSms), and that's one whole
// Gemini call saved on every "thanks!" that lands.
async function maybeSuggestReply(phone) {
  let drafted = '';
  let verdict = null;
  try {
    const cfg = await loadConfig();
    if (isOptedOut(cfg, phone)) return { text: '', verdict: null };
    const thread = await loadThread(phone);
    if (thread.archived) return { text: '', verdict: null };
    const last = thread.messages[thread.messages.length - 1];
    if (!last || last.dir !== 'in') return { text: '', verdict: null };
    // Decide first whether this message actually leaves anything open. Doing it
    // here (rather than waiting for the follow-up engine) means a "Thanks!" never
    // even appears in "Needs your attention".
    let changed = await ensureReplyCheck(thread, cfg);
    verdict = replyCheckFor(thread);
    if (replyOwed(thread)) {
      if (aiConfigured()) {
        const text = await generateReply(thread, cfg, '');
        if (text) { thread.suggested = { text, ts: Date.now(), forTs: last.ts }; changed = true; drafted = text; }
      }
    } else if (thread.suggested) {
      thread.suggested = null; changed = true;   // nothing owed — drop any stale draft
    }
    if (changed) { await saveThread(thread); await updateIndexEntry(thread); }
  } catch { /* suggestions are a bonus — swallow errors so inbound never breaks */ }
  return { text: drafted, verdict };
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
// AI router — which model writes what
// ===========================================================================
// Two tiers, because they want different things:
//   'voice' — writing a message a customer will read. Holding one specific
//             person's voice from example texts is the job, and Claude is
//             markedly better at it than Flash. Worth the call.
//   'fast'  — classification, triage, summaries, JSON. Gemini Flash is quick,
//             cheap and entirely good enough.
// Anything voice-tier falls back to Gemini automatically when ANTHROPIC_API_KEY
// isn't set or the call fails, so the dashboard never loses the ability to draft.
function aiConfigured() { return !!(ENV.GEMINI_API_KEY || ENV.ANTHROPIC_API_KEY); }

async function aiGenerate(prompt, opts = {}) {
  if (opts.tier === 'voice' && ENV.ANTHROPIC_API_KEY && !envFlag('CLAUDE_DISABLED')) {
    try { return await claudeGenerate(prompt, opts); }
    catch (err) {
      // Never let a provider outage stop him replying — fall through to Gemini.
      console.log('claude failed, falling back to gemini:', String((err && err.message) || err).slice(0, 200));
    }
  }
  return geminiGenerate(prompt, opts);
}

// ===========================================================================
// Claude (Anthropic Messages API)
// ===========================================================================
// Raw fetch rather than @anthropic-ai/sdk on purpose: this Worker has zero
// runtime dependencies today, ships on Cloudflare's free tier (hard bundle-size
// ceiling), and every other outbound API here — Twilio, Gemini, Resend — is a
// plain fetch. One POST to one endpoint doesn't justify changing that for a
// live business phone line.
//
// Opus 5 notes that bite if you get them wrong:
//   - temperature / top_p / top_k are REMOVED. Sending any of them is a 400.
//     Steering happens through the prompt and the effort level instead.
//   - thinking is ON by default, and max_tokens caps thinking + reply together,
//     so max_tokens needs headroom well past the length of the text itself.
//   - a request can come back 200 with stop_reason 'refusal' and no content;
//     check that before reading content[0].
async function claudeGenerate(prompt, opts = {}) {
  const key = ENV.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const body = {
    model: ENV.ANTHROPIC_MODEL || 'claude-opus-5',
    max_tokens: Math.max(1024, Math.min(8000, (opts.maxTokens || 800) + 1200)), // room for thinking
    // Low effort: these are short, well-specified writing tasks with the examples
    // already in the prompt. Thinking stays ON — disabling it on Opus 5 can leak
    // <thinking> tags into the visible text, which a customer would see.
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.json) body.messages[0].content += '\n\nReturn ONLY valid JSON. No prose, no code fences.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await noteAiUsage(opts.surface, 'claude', 0, 0, true);
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const cu = data.usage || {};
  await noteAiUsage(opts.surface, 'claude', cu.input_tokens, cu.output_tokens, false);
  if (data.stop_reason === 'refusal') throw new Error('anthropic_refusal');
  const text = (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('anthropic_empty');
  return text;
}

// ===========================================================================
// What the AI actually costs — measured, not modelled
// ===========================================================================
// Every Gemini and Claude response carries exact input/output token counts, and
// until now this app threw all of them away. docs/AI-COST.md had to *model* the
// bill from assumed daily volumes, which is a fine way to rank the big offenders
// and a useless way to tell whether a cut worked. So: one counter per surface
// per day, and the guessing stops.
//
// KV cost is the whole design constraint here. Counts accumulate in the isolate
// and only reach KV when there are enough of them to be worth a write (or when
// the buffer has been sitting a while), so a busy hour of texting costs a couple
// of writes rather than one per AI call. A crashed isolate loses at most a few
// counts — acceptable for a spend gauge, and never worth a write budget.
const AI_USAGE_DAYS = 45;              // how long a day's counters stick around in KV
const AI_USAGE_FLUSH_CALLS = 8;        // flush once this many calls are buffered
const AI_USAGE_FLUSH_MS = 10 * 60 * 1000;
let AI_USAGE_BUF = null;               // { date, by: { surface: {calls,in,out,errors} } }
let AI_USAGE_PENDING = 0;
let AI_USAGE_LAST_FLUSH = 0;

function aiUsageKey(date) { return `ai:usage:${date}`; }

function aiUsageRow(by, surface) {
  const k = surface || 'other';
  if (!by[k]) by[k] = { calls: 0, in: 0, out: 0, errors: 0 };
  return by[k];
}

// Fold one call into the buffer, then flush if it's grown enough to be worth it.
// Never throws: a counter must not be able to break a reply.
async function noteAiUsage(surface, provider, inTok, outTok, failed) {
  try {
    if (envFlag('AI_USAGE_OFF')) return;
    const date = localDateStr(Date.now(), (CFG_CACHE && CFG_CACHE.tz) || 'America/Los_Angeles');
    if (!AI_USAGE_BUF || AI_USAGE_BUF.date !== date) {
      // Day rolled over mid-buffer: get yesterday's tail into yesterday's key
      // before starting a new one, or the last few calls land on the wrong day.
      if (AI_USAGE_BUF && AI_USAGE_PENDING) await flushAiUsage();
      AI_USAGE_BUF = { date, by: {} };
    }
    const row = aiUsageRow(AI_USAGE_BUF.by, `${surface || 'other'}${provider === 'claude' ? ' (claude)' : ''}`);
    row.calls += 1;
    row.in += Math.max(0, inTok | 0);
    row.out += Math.max(0, outTok | 0);
    if (failed) row.errors += 1;
    AI_USAGE_PENDING += 1;
    if (AI_USAGE_PENDING >= AI_USAGE_FLUSH_CALLS ||
        Date.now() - AI_USAGE_LAST_FLUSH > AI_USAGE_FLUSH_MS) await flushAiUsage();
  } catch { /* counting is never worth an error */ }
}

// ⚠ KV WRITE — one per flush, not one per AI call. See the note above.
async function flushAiUsage() {
  const buf = AI_USAGE_BUF;
  if (!buf || !AI_USAGE_PENDING) return;
  AI_USAGE_PENDING = 0;
  AI_USAGE_LAST_FLUSH = Date.now();
  const pending = buf.by;
  AI_USAGE_BUF = { date: buf.date, by: {} };
  try {
    const doc = (await kv().get(aiUsageKey(buf.date), { type: 'json' })) || { date: buf.date, by: {} };
    for (const [k, v] of Object.entries(pending)) {
      const row = aiUsageRow(doc.by, k);
      row.calls += v.calls; row.in += v.in; row.out += v.out; row.errors += v.errors;
    }
    await kv().put(aiUsageKey(buf.date), JSON.stringify(doc), { expirationTtl: AI_USAGE_DAYS * 86400 });
  } catch {
    // Put the counts back rather than lose them; the next call retries the write.
    for (const [k, v] of Object.entries(pending)) {
      const row = aiUsageRow(AI_USAGE_BUF.by, k);
      row.calls += v.calls; row.in += v.in; row.out += v.out; row.errors += v.errors;
      AI_USAGE_PENDING += v.calls;
    }
  }
}

// GET /api/ai/usage?days=14 — the answer to "is this thing costing me anything?"
// Returns real counted tokens per surface, biggest first, so a cut can be judged
// by looking at the day after rather than by argument.
async function apiAiUsage(url) {
  await flushAiUsage();
  const cfg = await loadConfig();
  const days = Math.max(1, Math.min(45, Number(url.searchParams.get('days')) || 14));
  const today = localDateStr(Date.now(), cfg.tz);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = localDateStr(Date.now() - i * 86400000, cfg.tz);
    const doc = await kv().get(aiUsageKey(d), { type: 'json' });
    if (doc) out.push(doc);
  }
  const roll = {};
  let calls = 0, inTok = 0, outTok = 0;
  for (const doc of out) {
    for (const [k, v] of Object.entries(doc.by || {})) {
      const row = aiUsageRow(roll, k);
      row.calls += v.calls || 0; row.in += v.in || 0; row.out += v.out || 0; row.errors += v.errors || 0;
      calls += v.calls || 0; inTok += v.in || 0; outTok += v.out || 0;
    }
  }
  const bySurface = Object.entries(roll)
    .map(([surface, v]) => Object.assign({ surface }, v))
    .sort((a, b) => (b.in + b.out) - (a.in + a.out));
  const todayDoc = out.find((d) => d.date === today);
  return json({
    ok: true, days, today,
    model: ENV.GEMINI_MODEL || 'gemini-2.5-flash',
    total: { calls, in: inTok, out: outTok, days: out.length },
    bySurface,
    todayTotal: todayDoc
      ? Object.values(todayDoc.by || {}).reduce((a, v) => ({
        calls: a.calls + (v.calls || 0), in: a.in + (v.in || 0), out: a.out + (v.out || 0) }), { calls: 0, in: 0, out: 0 })
      : { calls: 0, in: 0, out: 0 },
  });
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
  if (!res.ok) {
    // A rejected call still costs him nothing in tokens, but it is exactly the
    // thing you want to see on the usage screen — a surface quietly erroring all
    // day looks identical to a surface nobody uses until you count both.
    await noteAiUsage(opts.surface, 'gemini', 0, 0, true);
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const um = data.usageMetadata || {};
  await noteAiUsage(opts.surface, 'gemini', um.promptTokenCount, um.candidatesTokenCount, false);
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
// `body` is either a plain string or { text, html } from a caller that built its
// own layout (the customer alerts do). Anything that stays a string still gets a
// readable HTML email — alertHtml() lays the text out — and the text version is
// what goes over SMS when email is off or fails, so no alert ever depends on the
// HTML existing.
// `attachments` (Resend's shape: { filename, content: base64 }) ride the email
// only — the promise reminders use it for a calendar invite. `sms` overrides what
// the fallback text says, because a text message can't carry an attachment and
// shouldn't point at one.
async function notifyMikey(subject, body) {
  const text = typeof body === 'string' ? body : String((body && body.text) || '');
  const html = (body && typeof body === 'object' && body.html) || '';
  const attachments = (body && typeof body === 'object' && body.attachments) || null;
  const smsText = (body && typeof body === 'object' && body.sms) || text;
  // Ring the phone too. Web push is free, instant, and doesn't wait on email or
  // Twilio — but it's a bonus channel, never the only one, so failures are silent.
  pushNotify().catch(() => {});
  if (ENV.RESEND_API_KEY && ENV.ALERT_EMAIL) {
    try { await sendEmail(subject, text, html, attachments); return true; }
    catch { /* fall through to SMS so the alert still reaches Mikey */ }
  }
  try { await sendSms(ENV.MIKEY_PHONE, smsText, { skipOptOut: true }); return true; }
  catch { return false; }
}

// Send an alert email via Resend (https://resend.com). Both parts go out: the
// HTML is what he sees, the text is the fallback every client keeps and the only
// thing a watch or a screen reader may show. ALERT_FROM must be a Resend-verified
// sender; until a domain is verified, Resend only allows onboarding@resend.dev ->
// your own account email, which is exactly the single-recipient case here.
async function sendEmail(subject, text, html, attachments) {
  const to = ENV.ALERT_EMAIL;
  const from = ENV.ALERT_FROM || 'Mikeys Dashboard <onboarding@resend.dev>';
  if (!to) throw new Error('ALERT_EMAIL not set');
  const payload = { from, to: [to], subject, text, html: html || alertHtml(subject, text) };
  if (attachments && attachments.length) payload.attachments = attachments.slice(0, 10);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ENV.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ===========================================================================
// The mail kit — how every alert email is put together
// ===========================================================================
// These emails are read on a phone, one-handed, usually while he's holding a
// pressure washer. So: one column, big type, the thing that matters loudest, and
// everything styled inline (Gmail strips <style> blocks). Colours are declared
// explicitly and the document opts out of automatic dark-mode inversion, because
// an inverted "here's what I'd send" card is unreadable.
const MAILC = {
  bg: '#eef1f5', card: '#ffffff', line: '#e2e8f0', ink: '#0f172a', mute: '#64748b',
  amber: '#f59e0b', amberBg: '#fffbeb', amberInk: '#92400e',
  green: '#16a34a', greenBg: '#f0fdf4', greenInk: '#166534',
  red: '#dc2626', redBg: '#fef2f2', redInk: '#991b1b',
  blue: '#2563eb', blueBg: '#eff6ff',
  purple: '#7c3aed', purpleBg: '#f5f3ff',
};
const MAILF = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// A run of prose, line breaks kept.
function mailLines(s) { return htmlEsc(s).replace(/\r?\n/g, '<br>'); }

// The outer document. `preheader` is the grey line Gmail shows next to the
// subject in the inbox list — putting the customer's actual words there means he
// can often answer without opening anything.
function mailShell(preheader, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">` +
    `</head><body style="margin:0;padding:0;background:${MAILC.bg};-webkit-text-size-adjust:100%;">` +
    `<div style="display:none;font-size:1px;color:${MAILC.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${htmlEsc(String(preheader || '').replace(/\s+/g, ' ').slice(0, 180))}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MAILC.bg};width:100%;">` +
    `<tr><td align="center" style="padding:14px 10px 26px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
    `<tr><td style="font-family:${MAILF};color:${MAILC.ink};">${inner}</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

// One rounded panel, with an optional coloured spine down the left edge.
function mailCard(inner, opts = {}) {
  const bg = opts.bg || MAILC.card;
  const border = opts.border || MAILC.line;
  const edge = opts.edge ? `border-left:6px solid ${opts.edge};` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">` +
    `<tr><td style="background:${bg};border:1px solid ${border};${edge}border-radius:14px;padding:${opts.pad || '16px'};">${inner}</td></tr>` +
    `</table><div style="height:12px;line-height:12px;font-size:12px;">&nbsp;</div>`;
}

// The small uppercase caption above a card's contents.
function mailLabel(text, color) {
  return `<div style="font:700 12px/1.4 ${MAILF};letter-spacing:.08em;text-transform:uppercase;color:${color};margin:0 0 10px;">${htmlEsc(text)}</div>`;
}

// The loud one: what the customer actually said. Runs of blank lines are
// collapsed — people pad texts with them, and at this size the gaps would push
// the second half of the message off the screen.
function mailShout(text) {
  return `<div style="font-family:${MAILF};font-size:25px;line-height:1.32;font-weight:800;color:${MAILC.ink};margin:0;">&ldquo;${mailLines(String(text).replace(/\n{2,}/g, '\n').trim())}&rdquo;</div>`;
}

// Body copy for a plain-text alert. Almost every alert in here is written as
// "Phone: +1360…" lines, so those get the label quietened and the value bolded —
// which is most of the difference between a wall of text and something skimmable
// at arm's length.
function mailBody(text, color) {
  const rows = String(text).split('\n').map((ln) => {
    const kv = ln.match(/^ {0,4}([A-Za-z][A-Za-z /'-]{1,18}):\s*(\S.*)$/);
    if (kv) return `<div style="margin:0 0 5px;"><span style="color:${MAILC.mute};">${htmlEsc(kv[1])}:</span> <b style="color:${MAILC.ink};">${htmlEsc(kv[2])}</b></div>`;
    const t = htmlEsc(ln.replace(/^ {2,}/, ''));
    return `<div style="margin:0 0 5px;">${t || '&nbsp;'}</div>`;
  }).join('');
  return `<div style="font:400 15px/1.55 ${MAILF};color:${color};">${rows}</div>`;
}

// Full-width tap target. Thumb-sized on purpose — these get pressed on a phone.
function mailBtn(href, label, bg, opts = {}) {
  const fg = opts.fg || '#ffffff';
  const border = opts.border || bg;
  return `<a href="${htmlEsc(href)}" style="display:block;box-sizing:border-box;width:100%;background:${bg};color:${fg};border:1px solid ${border};border-radius:12px;padding:14px 16px;font:700 16px/1.2 ${MAILF};text-align:center;text-decoration:none;">${label}</a>`;
}

// Every other alert — failed texts, voicemails, bookings, the weekly recap — is
// written as plain text and always will be, because it also has to work as an
// SMS. Rather than rewrite them all, this lays that text out: the opening line
// leads, anything the sender put in quotes becomes the loud block, and each
// "📱 HEADER"-style line starts a new section. Text stays the source of truth,
// so an alert that's never seen this function still looks right.
function alertHtml(subject, text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const blocks = [];
  let lead = true;
  let refLine = '';
  let cut = false;
  for (const para of src.split(/\n{2,}/)) {
    let p = para.trim();
    if (!p) continue;
    if (p.startsWith(ASSIST_CUT)) { cut = true; p = p.slice(ASSIST_CUT.length).trim(); if (!p) continue; }
    // Keep the routing line out of the flow; it goes back at the bottom.
    p = p.replace(/^\[ref:[^\]]*\]$/gm, (m) => { refLine = m; return ''; }).trim();
    if (!p) continue;
    // A paragraph that is nothing but a quoted string is the message itself.
    const q = p.match(/^"([\s\S]+)"$/);
    if (q) {
      blocks.push(mailCard(mailShout(q[1]), { bg: MAILC.amberBg, border: '#fde68a', edge: MAILC.amber, pad: '18px' }));
      lead = false;
      continue;
    }
    // "💡 SOMETHING" / "⚠️ Heads up" — an emoji-led first line is a heading.
    const lines = p.split('\n');
    const head = lines[0].match(/^([^\x00-\x7F]\S{0,3})\s+(\S[\s\S]*)$/);
    if (head && lines.length > 1) {
      blocks.push(mailCard(
        `<div style="font:700 15px/1.4 ${MAILF};color:${MAILC.ink};margin:0 0 8px;">${htmlEsc(head[1])} ${htmlEsc(head[2])}</div>` +
        mailBody(lines.slice(1).join('\n'), MAILC.mute)));
      lead = false;
      continue;
    }
    blocks.push(lead
      ? mailCard(`<div style="font:600 18px/1.55 ${MAILF};color:${MAILC.ink};">${mailLines(p)}</div>`)
      : mailCard(mailBody(p, MAILC.mute)));
    lead = false;
  }
  if (!blocks.length) blocks.push(mailCard(`<div style="font:600 18px/1.55 ${MAILF};color:${MAILC.ink};">${mailLines(src) || htmlEsc(subject)}</div>`));
  const base = publicBase();
  if (base) blocks.push(mailCard(mailBtn(base, 'Open the dashboard', MAILC.ink)));
  // The cut marker has to be the first thing in the email and the ref the last,
  // or a reply to this alert stops routing (see assistAlertHtml). An alert that
  // isn't part of the reply loop gets its subject repeated as a caption instead,
  // so the page still says what it is once the subject line scrolls away.
  const top = cut
    ? `<div style="font:400 11px/1.5 ${MAILF};color:#94a3b8;margin:0 0 10px;">${htmlEsc(ASSIST_CUT)}</div>`
    : `<div style="font:700 13px/1.4 ${MAILF};color:${MAILC.mute};margin:0 0 12px;padding:0 4px;">${htmlEsc(subject)}</div>`;
  const bottom = refLine ? `<div style="font:400 11px/1.5 ${MAILF};color:#94a3b8;padding:0 4px 8px;">${htmlEsc(refLine)}</div>` : '';
  // The inbox preview line is the alert's own words — never the plumbing.
  const peek = src.replace(ASSIST_CUT, '').replace(/\[ref:[^\]]*\]/g, '').trim();
  return mailShell(peek, top + blocks.join('') + bottom);
}

// ===========================================================================
// Twilio
// ===========================================================================
async function sendSms(to, body, opts = {}) {
  const sid = ENV.TWILIO_ACCOUNT_SID;
  const token = ENV.TWILIO_AUTH_TOKEN;
  const toNorm = normalizePhone(to) || to;
  // Practice guard. The fake customer used to rehearse the assist loop must never
  // be textable — not by the assist path (which stops earlier), and not by any
  // future code that stumbles onto the thread. Unconditional, before everything.
  if (isPracticePhone(toNorm)) throw new Error('practice_number');
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

// The handset that click-to-call rings. This is deliberately its OWN number and
// NOT MIKEY_PHONE: dashboard "Call" is the only thing that uses it. Inbound call
// forwarding, missed-call/voicemail alerts and every self-text still go to
// MIKEY_PHONE — changing this line does not touch any of them.
// Override without a deploy by setting the Worker var CALL_BRIDGE_PHONE.
const CALL_BRIDGE_PHONE = '+14252321355';
function callBridgePhone() {
  return normalizePhone(ENV.CALL_BRIDGE_PHONE) || CALL_BRIDGE_PHONE;
}

// Click-to-call: ring the call handset, then bridge the call to the customer.
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
    body: new URLSearchParams({ To: callBridgePhone(), From: from, Twiml: twimlXml }),
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
// Who a confirmation text is about. The number rides along with the name because
// the whole point is that he can act on it from the lock screen — tap to call, or
// open the thread — without going and looking the customer up first.
function threadWho(thread) {
  const name = (thread && thread.name) ? String(thread.name).trim() : '';
  const phone = (thread && thread.phone) || '';
  return name ? `${name} (${phone})` : (phone || 'a customer');
}

async function dispatchDueScheduled(now = Date.now()) {
  const index = await loadIndex();
  let sent = 0;
  const learn = []; // his own queued texts that went out — one corpus write at the end
  // Items queued with alertOnSend (the quote-form auto-reply) earn Mikey a text the
  // moment they actually reach the customer. Read the switch once per tick rather
  // than per item — most ticks send nothing at all.
  const alertOn = (await loadConfig()).autoReplyAlert !== false;
  for (const entry of index) {
    if (!entry.scheduledCount) continue;
    const thread = await loadThread(entry.phone);
    const due = (thread.scheduled || []).filter((s) => s.sendAt <= now);
    if (!due.length) continue;
    let mine = false;   // did any of this thread's due items carry his own words?
    const tell = [];    // confirmations owed to Mikey once this thread is saved
    // Reserve the due items FIRST — remove them and persist BEFORE sending. KV is
    // eventually consistent and the cron runs every minute, so if we sent first and
    // saved after, an overlapping/next run could read the stale queue and text the
    // customer twice. Reserving first makes it at-most-once (a rare crash drops a
    // message rather than double-sending it — the safer failure for customer texts).
    thread.scheduled = (thread.scheduled || []).filter((s) => s.sendAt > now);
    await saveThread(thread);
    for (const s of due) {
      // `kind` lets a queued item say what it is (a booking reminder, an assist
      // reply) so the thread history reads correctly; plain sends stay 'scheduled'.
      const kind = s.kind || 'scheduled';
      try {
        const r = await sendSms(thread.phone, s.body);
        // Carry src onto the stored message so a later rebuild can tell his own
        // queued text from the app's templated ones (see voiceUsable).
        const m = { id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind, status: 'sent', sid: (r && r.sid) || undefined };
        if (s.src === 'manual') m.src = 'manual';
        thread.messages.push(m);
        if (voiceUsable(m)) { learn.push(s.body); mine = true; }
        if (s.alertOnSend && alertOn) tell.push(`✅ Auto-reply sent — ${threadWho(thread)}. The quote text from your site just went out to them.`);
        sent++;
      } catch (err) {
        // Left unmarked on purpose: a text that never reached the customer stays out
        // of the voice corpus, so a rebuild can't mine a failed send.
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind, error: String(err.message || err) });
        // A failed auto-reply is the one he most needs in the same place as the
        // success — silence would otherwise read as "it went out fine".
        if (s.alertOnSend && alertOn) tell.push(`⚠️ Auto-reply did NOT send — ${threadWho(thread)}. ${String(err.message || err)}. They haven't heard from you — reach out yourself.`);
        else notifyMikey('⚠️ Scheduled text failed', `A scheduled message to ${thread.name || thread.phone} did not send: ${String(err.message || err)}`).catch(() => {});
      }
    }
    await saveThread(thread);
    await updateIndexEntry(thread);
    // After the save, so a Twilio hiccup on the confirmation can't cost us the
    // record of a customer text that already went out.
    for (const msg of tell) await ownerSay(msg);
    // A queued text is still him talking — an assist reply he approved by email,
    // or one he wrote and held for later — so it gets read for a promise too.
    // Templated booking reminders are excluded by the same voiceUsable() test
    // that keeps them out of the voice corpus: nothing there is his to promise.
    if (mine) await maybePromise(thread.phone).catch(() => {});
  }
  // Batched, so a tick that flushes ten of his texts still costs one KV write.
  if (learn.length) { try { await addVoiceSamples(learn, 'sent'); } catch { /* non-fatal */ } }
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

// ===========================================================================
// Booking + calendar  (customer page: /book.html · admin view: Bookings tab)
// ---------------------------------------------------------------------------
// Additive module. Bookings live in ONE KV value (bk:index) — a small array of
// full records — so a create is 1 write and an availability check is 1 read.
// Availability = work rules (Mon–Sat 7a–4p last start, 2 jobs/day, 60-min drive
// buffer, per-service durations) MINUS the day's pending/confirmed jobs. Every
// booking also mirrors into the SMS dashboard as a lead thread so Mikey can talk
// to the customer, and reminders reuse the existing scheduled-send cron.
// v1 ships with the owner's approval as the double-book gate; Google Calendar
// free/busy sync layers in next (busy times auto-hide from availability).
// ===========================================================================
// Editable settings live in KV (bk:config), merged over these defaults. The
// Settings tab writes them; the customer page + availability engine read them.
// Defaults hold Mikey's real menu so everything works before he edits anything.
const BK_CONFIG_KEY = 'bk:config';
function bookingDefaults() {
  return {
    tz: 'America/Los_Angeles',
    workDays: [1, 2, 3, 4, 5, 6],      // Mon–Sat (0 = Sun, off)
    dayStart: '07:00', lastStart: '16:00',
    stepMin: 30, bufferMin: 60, maxJobsPerDay: 2, minLeadMin: 120, windowDays: 30,
    sizes: [
      { id: 'sedan', label: 'Car / Sedan' },
      { id: 'suv',   label: 'SUV / Crossover' },
      { id: 'truck', label: 'Truck / Van / XL' },
    ],
    services: [
      { id: 'full', name: 'Full Detail — In & Out', enabled: true, popular: true,
        blurb: 'The works: deep interior + full exterior. First-timers ~3–4 hrs.',
        price: { sedan: 299, suv: 339, truck: 379 }, duration: { sedan: 180, suv: 210, truck: 240 } },
      { id: 'interior', name: 'Interior Detail', enabled: true, popular: false,
        blurb: 'Full vacuum, carpets & seats, all surfaces, windows, pet hair.',
        price: { sedan: 200, suv: 240, truck: 280 }, duration: { sedan: 90, suv: 110, truck: 120 } },
      { id: 'exterior', name: 'Exterior Detail', enabled: true, popular: false,
        blurb: 'Hand wash, wheels & tires, bug & tar, polish, spray wax.',
        price: { sedan: 160, suv: 200, truck: 240 }, duration: { sedan: 45, suv: 60, truck: 75 } },
    ],
    addons: [
      { id: 'carpet',   name: 'Carpet & upholstery shampoo', price: 60, enabled: true, popular: true,  blurb: 'Hot-water extraction — lifts deep stains' },
      { id: 'pethair',  name: 'Pet hair removal',            price: 40, enabled: true, popular: false, blurb: 'Special process for stubborn fur' },
      { id: 'wax',      name: 'Wax / paint sealant',         price: 40, enabled: true, popular: false, blurb: 'Extra shine & protection' },
      { id: 'steam',    name: 'Steam clean & sanitize',      price: 40, enabled: true, popular: false, blurb: 'Deep sanitize + odor knockdown' },
      { id: 'leather',  name: 'Leather conditioning',        price: 30, enabled: true, popular: false, blurb: 'Clean + condition leather seats' },
      { id: 'headlight',name: 'Headlight restoration',       price: 50, enabled: true, popular: false, blurb: 'Clear up foggy headlights' },
    ],
    cities: ['Everett', 'Bothell', 'Lake Stevens', 'Mill Creek', 'Monroe', 'Marysville', 'Duvall', 'Snohomish'],
    content: {
      businessName: "Mikey's Mobile Detailing", phoneDisplay: '(425) 600-7897', phone: '+14256007897',
      hook: 'First full detail? Your exterior wash & wax (a $160 value) is free.',
      guarantee: "You don't pay until you love it.",
      urgency: true, freeWax: true,
    },
    proof: { rating: '5.0', reviews: 39, cars: '300+' },
    calendar: { icalUrl: '', enabled: false },   // Google Calendar "secret iCal" URL
    blockedDates: [],                             // ['2026-08-01', …] days Mikey is off
    // Booking-lifecycle texts. Each is a fixed template filled in from the booking
    // record — no AI writes them, so none can invent a price or a time. Individually
    // switchable. (Day-of messages — on my way, I'm here, all finished — belong to
    // the Jobs run board, not here; see dayJobText().)
    autoTexts: {
      confirm:   true,   // "you're all set" the moment you confirm
      remind24:  true,   // day-before reminder
      remindAm:  true,   // morning-of reminder
      cancelled: true,   // courtesy note when a confirmed job is cancelled
      declined:  false,  // note when a request is declined (off — usually wants a personal reply)
    },
  };
}
// Merge saved overrides over the defaults (arrays replace, objects deep-merge).
async function loadBookingConfig() {
  const saved = (await kv().get(BK_CONFIG_KEY, { type: 'json' })) || {};
  const d = bookingDefaults();
  return Object.assign({}, d, saved, {
    content:  Object.assign({}, d.content,  saved.content  || {}),
    proof:    Object.assign({}, d.proof,    saved.proof    || {}),
    calendar: Object.assign({}, d.calendar, saved.calendar || {}),
    autoTexts: Object.assign({}, d.autoTexts, saved.autoTexts || {}),
    sizes:    saved.sizes    || d.sizes,
    services: saved.services || d.services,
    addons:   saved.addons   || d.addons,
    cities:   saved.cities   || d.cities,
    blockedDates: saved.blockedDates || d.blockedDates,
  });
}
// ⚠ KV WRITE — only when Mikey saves settings (rare). Cheap.
async function saveBookingConfig(cfg) { await kv().put(BK_CONFIG_KEY, JSON.stringify(cfg)); }
function bkSvc(cfg, id) { return (cfg.services || []).find((s) => s.id === id && s.enabled !== false); }

const BK_INDEX = 'bk:index';
async function loadBookings() { return (await kv().get(BK_INDEX, { type: 'json' })) || []; }
// ⚠ KV WRITE — one per booking create/confirm/cancel (user actions, not cron). Cheap.
async function saveBookings(list) { await kv().put(BK_INDEX, JSON.stringify(list)); }

// --- small time helpers (Pacific-aware, DST-correct) ---
function bkHm2min(hm) { const p = String(hm).split(':'); return (+p[0]) * 60 + (+(p[1] || 0)); }
function bkMin2hm(x) { return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
function bkFmt12(hm) { let [h, m] = String(hm).split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; let hr = h % 12; if (hr === 0) hr = 12; return `${hr}:${String(m || 0).padStart(2, '0')} ${ap}`; }
function bkNiceDate(date) { return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
// Minutes to add to a Pacific wall-clock (treated as UTC) to get the real UTC epoch.
function bkLaOffsetMin(ts) {
  const s = new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})[,\s]+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return -480;
  const asUTC = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
  return Math.round((asUTC - ts) / 60000);
}
function bkLaEpoch(dateStr, hhmm) {
  const naive = Date.parse(dateStr + 'T' + hhmm + ':00Z');   // wall clock treated as UTC
  return naive - bkLaOffsetMin(naive) * 60000;               // shift by the Pacific offset
}

// Open start-times for a date, given service + size. Read-only.
// Availability = work rules − existing jobs − Google Calendar busy − blocked dates.
async function bkAvailability(date, service, size) {
  const cfg = await loadBookingConfig();
  if ((cfg.blockedDates || []).includes(date)) return [];      // Mikey marked the day off
  const svc = bkSvc(cfg, service);
  if (!svc) return [];
  const dur = (svc.duration && svc.duration[size]) || (svc.duration && svc.duration.suv) || 180;
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  if (!(cfg.workDays || []).includes(dow)) return [];
  const now = Date.now();
  if (bkLaEpoch(date, cfg.dayStart) - now > cfg.windowDays * 86400000) return [];
  if (bkLaEpoch(date, cfg.lastStart) < now) return [];         // day already past
  const day = (await loadBookings()).filter((b) => b.date === date && (b.status === 'pending' || b.status === 'confirmed'));
  // A job agreed over text holds its slot too, even before Mikey taps to confirm
  // it — otherwise the website can sell a time he already promised in a
  // conversation. Dismissing the card releases the hold on the next request.
  const held = await detHeldSlots(date);
  if (held === 'all') return [];
  const holds = Array.isArray(held) ? held : [];
  if (day.length + holds.length >= cfg.maxJobsPerDay) return [];
  const occ = day.map((b) => ({ s: bkHm2min(b.slot), e: bkHm2min(b.slot) + (b.durationMin || dur) })).concat(holds);
  // Google Calendar busy times so Mikey is never offered a slot he's already booked.
  for (const iv of await bkCalBusy(cfg, date)) {
    if (iv.s <= 0 && iv.e >= 1440) return [];                  // all-day event → whole day off
    occ.push(iv);
  }
  const B = cfg.bufferMin, out = [];
  for (let t = bkHm2min(cfg.dayStart); t <= bkHm2min(cfg.lastStart); t += cfg.stepMin) {
    const start = t, end = t + dur;
    if (bkLaEpoch(date, bkMin2hm(t)) < now + cfg.minLeadMin * 60000) continue;   // too soon / past
    if (occ.some((o) => start < o.e + B && o.s < end + B)) continue;             // clashes w/ buffer
    out.push(bkMin2hm(t));
  }
  return out;
}

// Public config for the customer page. Never leak the secret iCal URL.
async function apiBookConfig() {
  const cfg = await loadBookingConfig();
  const pub = Object.assign({}, cfg, { calendar: { enabled: !!(cfg.calendar && cfg.calendar.enabled) }, blockedDates: undefined });
  return json({ ok: true, config: pub });
}

async function apiAvailability(url) {
  const date = url.searchParams.get('date') || '';
  const service = url.searchParams.get('service') || 'full';
  const size = url.searchParams.get('size') || 'suv';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: 'bad_date' }, 422);
  return json({ ok: true, date, slots: await bkAvailability(date, service, size) });
}

// Customer submits the booking wizard. Stores the booking (pending), mirrors it
// into the SMS dashboard as a lead, instant-texts the customer, alerts Mikey.
async function apiBook(request) {
  let b; try { b = await request.json(); } catch { return cors(json({ ok: false, error: 'bad_json' }, 400)); }
  if (b && (b.website || b._gotcha || b.hp)) return cors(json({ ok: true, id: 'skipped' }, 200)); // honeypot
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip) {
    const rk = 'rl:book:' + ip;
    const n = parseInt((await kv().get(rk)) || '0', 10);
    if (n >= 6) return cors(json({ ok: false, error: 'rate_limited' }, 429));
    await kv().put(rk, String(n + 1), { expirationTtl: 3600 });
  }
  const cfg = await loadBookingConfig();
  const service = String(b.service || ''), size = String(b.size || '');
  const date = String(b.date || ''), slot = String(b.slot || '');
  const name = String(b.name || '').trim();
  // Booked from a customer's own link: the token IS the identity, so the phone
  // comes from the token rather than from anything the page posted.
  const viaLink = b.fromLink ? await custResolve(String(b.fromLink).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)) : null;
  const phone = viaLink ? viaLink.phone : normalizePhone(b.phone);
  const address = String(b.address || '').trim(), city = String(b.city || '').trim();
  const svc = bkSvc(cfg, service);
  if (!svc) return cors(json({ ok: false, error: 'bad_service' }, 422));
  if (!(svc.price && svc.price[size])) return cors(json({ ok: false, error: 'bad_size' }, 422));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(slot)) return cors(json({ ok: false, error: 'bad_time' }, 422));
  if (!name || !phone) return cors(json({ ok: false, error: 'missing_contact' }, 422));
  if (!address || !city) return cors(json({ ok: false, error: 'missing_address' }, 422));
  // Re-check the slot so two customers can't grab the same time between load and submit.
  if (!(await bkAvailability(date, service, size)).includes(slot)) return cors(json({ ok: false, error: 'slot_taken' }, 409));

  const first = name.split(/\s+/)[0];
  const durationMin = svc.duration[size], base = svc.price[size];
  const addons = Array.isArray(b.addons) ? b.addons.map((x) => String(x)).slice(0, 12) : [];
  const estimate = Math.max(0, Math.round(Number(b.estimate) || base));
  const dateLabel = String(b.dateLabel || bkNiceDate(date));
  const rec = {
    id: genId(), status: 'pending', createdAt: Date.now(),
    service, serviceName: svc.name, size, sizeLabel: String(b.sizeLabel || size),
    vehicle: String(b.vehicle || '').trim(), addons, wantQuote: !!b.wantQuote,
    date, slot, dateLabel, apptAt: bkLaEpoch(date, slot), durationMin,
    estimate, base, name, phone, address, city, email: String(b.email || '').trim(),
    notes: String(b.notes || '').trim(), ackWaterPower: b.ackWaterPower !== false, smsConsent: b.smsConsent !== false,
  };
  const all = await loadBookings(); all.unshift(rec); await saveBookings(all);

  const detail = [
    `🗓 BOOKING REQUEST (pending)`,
    `${rec.serviceName} · ${rec.sizeLabel}${rec.vehicle ? ` · ${rec.vehicle}` : ''}`,
    rec.addons.length ? `Add-ons: ${rec.addons.join(', ')}` : null,
    rec.wantQuote ? `Also wants: ceramic / paint quote` : null,
    `When: ${dateLabel} at ${bkFmt12(slot)}`,
    `Where: ${address}, ${city}`,
    `Estimate: $${estimate}`,
    rec.email ? `Email: ${rec.email}` : null,
    `Water & power on site: ${rec.ackWaterPower ? 'yes' : 'NEEDS to sort out'}`,
    rec.notes ? `Notes: ${rec.notes}` : null,
  ].filter(Boolean).join('\n');

  const thread = await loadThread(phone);
  if (!thread.name) thread.name = name;
  if (!thread.status) { thread.status = 'new'; thread.statusAt = Date.now(); }
  markSource(thread, 'booking');
  if (!thread.tags.includes('booking')) thread.tags.push('booking');
  thread.appointmentAt = rec.apptAt;
  const stamp = new Date().toLocaleString('en-US', { timeZone: cfg.tz });
  thread.notes = (thread.notes ? thread.notes + '\n\n' : '') + `${detail}\n(received ${stamp})`;
  if (rec.smsConsent) {
    const msg = `Hey ${first}, it's Mikey! Got your request for ${dateLabel} at ${bkFmt12(slot)} (${rec.serviceName}). I'll text you shortly to confirm and lock it in. Talk soon! - Mikey`;
    try { await sendSms(phone, msg); thread.messages.push({ id: genId(), dir: 'out', body: msg, ts: Date.now(), kind: 'booking', status: 'sent' }); } catch (e) {}
  }
  await saveThread(thread);
  await updateIndexEntry(thread);
  notifyMikey(`🗓 New booking — ${name}`, `${detail}\n\nOpen your dashboard → Bookings to confirm.`).catch(() => {});

  return cors(json({ ok: true, id: rec.id }, 200));
}

async function apiBookings(url) {
  const status = url.searchParams.get('status') || '';
  let all = await loadBookings();
  if (status) all = all.filter((b) => b.status === status);
  const rank = { pending: 0, confirmed: 1, done: 2, declined: 3, cancelled: 4 };
  all.sort((a, b) => (rank[a.status] - rank[b.status]) || (a.apptAt - b.apptAt));
  return json({ ok: true, bookings: all });
}

// ---------------------------------------------------------------------------
// Booking-lifecycle texts (Tier 0 — deterministic, no AI anywhere near them)
// ---------------------------------------------------------------------------
// Every message a booking generates is built here, from fields that already exist
// on the booking record. Nothing is generated, so nothing can be invented: the
// time comes from bk.slot, the service from bk.serviceName. One place to read
// them all, one place to change the wording.
//
// Day-of messages (on my way / I'm here / all finished + review ask) are NOT
// here — those belong to the Jobs run board, which does them better because it
// also drives live ETA tracking. See dayJobText().
function bkAutoOn(bcfg, kind) { return ((bcfg && bcfg.autoTexts) || {})[kind] !== false; }

function bkMessage(kind, bk) {
  const first = (bk.name || '').split(/\s+/)[0] || 'there';
  const at = bkFmt12(bk.slot);
  const car = bk.vehicle || 'car';
  switch (kind) {
    case 'confirm':
      return `You're all set for ${bk.dateLabel} at ${at} — ${bk.serviceName}. I come to you; just have water & power within about 20 ft of the car. I'll text when I'm on my way. - Mikey`;
    case 'remind24':
      return `Quick reminder: I'm detailing your ${car} tomorrow at ${at}. Please have it accessible with water & power within ~20 ft. See you then! - Mikey`;
    case 'remindAm':
      return `Morning ${first}! I'm detailing your car today at ${at}. I'll text when I'm headed your way. - Mikey`;
    case 'cancelled':
      return `Hey ${first}, your detail on ${bk.dateLabel} at ${at} has been cancelled. No problem at all — just text me whenever you'd like to find another time. - Mikey`;
    case 'declined':
      return `Hey ${first}, I wasn't able to lock in ${bk.dateLabel} at ${at}. Text me and we'll find a time that works. - Mikey`;
    default:
      return '';
  }
}

// Drop any still-queued texts belonging to one booking. Without this, cancelling
// a confirmed job still texted the customer "see you tomorrow!" the next morning.
// Returns how many were removed.
function bkPurgeScheduled(thread, bkId) {
  const before = (thread.scheduled || []).length;
  thread.scheduled = (thread.scheduled || []).filter((s) => s.bkId !== bkId);
  return before - thread.scheduled.length;
}

// Confirm / decline / cancel / complete a booking. Confirm texts the customer and
// queues the 24h + morning-of reminders through the existing scheduled-send cron;
// cancel and complete pull any reminders that are no longer wanted.
async function apiBookingAction(request) {
  const d = await readJson(request);
  const id = String(d.id || ''), action = String(d.action || '');
  const all = await loadBookings();
  const bk = all.find((x) => x.id === id);
  if (!bk) return json({ ok: false, error: 'not_found' }, 404);
  const bcfg = await loadBookingConfig();
  const now = Date.now();
  let texted = false;

  if (action === 'confirm') {
    bk.status = 'confirmed'; bk.confirmedAt = now;
    const thread = await loadThread(bk.phone);
    markSource(thread, 'booking');
    if (!thread.tags.includes('booking')) thread.tags.push('booking');
    thread.appointmentAt = bk.apptAt;
    if (bk.smsConsent) {
      if (bkAutoOn(bcfg, 'confirm')) {
        const body = bkMessage('confirm', bk);
        try {
          const r = await sendSms(bk.phone, body);
          // Record it — this text used to go out without ever landing in the
          // conversation, so the thread read as if nothing was sent.
          thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'booking', status: 'sent', sid: (r && r.sid) || undefined });
          texted = true;
        } catch (e) { /* the booking is still confirmed even if the text fails */ }
      }
      // Reminders ride the existing reserve-then-send cron, so they're at-most-once
      // and opt-out aware for free. Tagged with bkId so a later cancel can pull them.
      const r24 = bk.apptAt - 86400000, rAm = bkLaEpoch(bk.date, '07:30');
      const add = [];
      if (bkAutoOn(bcfg, 'remind24') && r24 > now + 60000) add.push({ id: genId(), bkId: bk.id, kind: 'booking', body: bkMessage('remind24', bk), sendAt: r24 });
      if (bkAutoOn(bcfg, 'remindAm') && rAm > now + 60000 && rAm < bk.apptAt) add.push({ id: genId(), bkId: bk.id, kind: 'booking', body: bkMessage('remindAm', bk), sendAt: rAm });
      if (add.length) { thread.scheduled.push(...add); thread.scheduled.sort((a, b) => a.sendAt - b.sendAt); }
    }
    await saveThread(thread);
    await updateIndexEntry(thread);

  } else if (action === 'complete') {
    bk.status = 'done'; bk.doneAt = now;
    const thread = await loadThread(bk.phone);
    const purged = bkPurgeScheduled(thread, bk.id);   // the job happened — drop leftovers
    // Mark the lead Won so it lands in the right bucket everywhere else, and so
    // the follow-up engine's review-ask and rebook cadences start from today.
    // The review ask itself is left to that engine (or the Jobs board's
    // "all finished" text) — deliberately not duplicated here.
    const wasWon = thread.status === 'won';
    if (!wasWon) { thread.status = 'won'; thread.statusAt = now; }
    if (purged || !wasWon) { await saveThread(thread); await updateIndexEntry(thread); }

  } else if (action === 'decline' || action === 'cancel') {
    const kind = action === 'decline' ? 'declined' : 'cancelled';
    bk.status = kind;
    const thread = await loadThread(bk.phone);
    let changed = bkPurgeScheduled(thread, bk.id) > 0;   // no job → no reminders
    if (bk.smsConsent && bkAutoOn(bcfg, kind)) {
      const body = bkMessage(kind, bk);
      try {
        const r = await sendSms(bk.phone, body);
        thread.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'booking', status: 'sent', sid: (r && r.sid) || undefined });
        texted = true; changed = true;
      } catch (e) { /* status change stands even if the courtesy text fails */ }
    }
    if (changed) { await saveThread(thread); await updateIndexEntry(thread); }

  } else {
    return json({ ok: false, error: 'bad_action' }, 422);
  }

  await saveBookings(all);
  return json({ ok: true, booking: bk, texted });
}

// ===========================================================================
// Google Calendar sync (best-effort) — the "secret iCal address" from Google
// Calendar → Settings → your calendar → "Secret address in iCal format". We
// fetch + parse it and subtract busy times from availability. Setup is a paste,
// no OAuth. Google caches the feed (can lag a bit), and Mikey's approval is the
// final gate, so it augments — not replaces — his control. Blocked dates and
// manual settings give him instant, exact control alongside it.
// ===========================================================================
let CAL_CACHE = { url: '', at: 0, events: [] };
async function bkFetchCal(url) {
  const now = Date.now();
  if (CAL_CACHE.url === url && (now - CAL_CACHE.at) < 600000) return CAL_CACHE.events;
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error('ical ' + res.status);
  const events = bkParseIcs(await res.text());
  CAL_CACHE = { url, at: now, events };
  return events;
}
// Busy intervals (LA minutes-of-day) on `date`, from the iCal feed. Never throws.
async function bkCalBusy(cfg, date) {
  try {
    if (!(cfg.calendar && cfg.calendar.enabled && cfg.calendar.icalUrl)) return [];
    const events = await bkFetchCal(cfg.calendar.icalUrl);
    const out = [];
    for (const ev of events) { const iv = bkEventBusyOnDate(ev, date); if (iv) out.push(iv); }
    return out;
  } catch (e) { return []; }
}
// LA-local {date:'YYYY-MM-DD', min:minutesOfDay, dow:0-6} for an epoch.
function bkLocalParts(ms) {
  const s = new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const m = s.match(/(\w{3}),?\s*(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/);
  if (!m) return { date: '', min: 0, dow: 0 };
  const dm = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${m[4]}-${m[2]}-${m[3]}`, min: (+m[5]) * 60 + (+m[6]), dow: dm[m[1]] || 0 };
}
function bkIcsDate(val) {
  if (/^\d{8}$/.test(val)) return { allDay: true, date: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}` };
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  if (m[7]) return { allDay: false, ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
  return { allDay: false, ms: bkLaEpoch(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`) + (+m[6]) * 1000 };
}
function bkAddDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10); }
function bkParseRrule(s) {
  const o = {}; s.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); });
  const dm = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const byday = (o.BYDAY || '').split(',').map((x) => dm[x.trim().slice(-2)]).filter((x) => x != null);
  let untilMs = null;
  if (o.UNTIL) { const p = bkIcsDate(o.UNTIL); untilMs = p ? (p.allDay ? bkLaEpoch(p.date, '23:59') : p.ms) : null; }
  return { freq: o.FREQ, byday, untilMs };
}
// Parse VEVENTs into a shape bkEventBusyOnDate can evaluate against any date.
function bkParseIcs(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) { const ev = bkBuildEvent(cur); if (ev) events.push(ev); } cur = null; continue; }
    if (!cur) continue;
    const c = line.indexOf(':'); if (c < 0) continue;
    let key = line.slice(0, c); const val = line.slice(c + 1);
    const name = key.split(';')[0].toUpperCase();
    if (name === 'DTSTART') { cur.startRaw = val; cur.startName = key; }
    else if (name === 'DTEND') { cur.endRaw = val; }
    else if (name === 'RRULE') cur.rrule = val;
    else if (name === 'TRANSP') cur.transp = val;
    else if (name === 'STATUS') cur.status = val;
    else if (name === 'DURATION') cur.durationRaw = val;
  }
  return events;
}
function bkBuildEvent(c) {
  if (!c.startRaw) return null;
  if ((c.transp || '').toUpperCase() === 'TRANSPARENT') return null;   // marked "free"
  if ((c.status || '').toUpperCase() === 'CANCELLED') return null;
  const start = bkIcsDate(c.startRaw); if (!start) return null;
  const rrule = c.rrule ? bkParseRrule(c.rrule) : null;
  if (start.allDay) {
    const end = c.endRaw ? bkIcsDate(c.endRaw) : null;
    const endDate = (end && end.allDay) ? end.date : bkAddDays(start.date, 1);
    const p = { date: start.date, dow: new Date(start.date + 'T12:00:00Z').getUTCDay() };
    return { allDay: true, startDate: start.date, endDate, rrule, baseDayMs: bkLaEpoch(start.date, '00:00'), baseDow: p.dow };
  }
  let endMs;
  if (c.endRaw) { const e = bkIcsDate(c.endRaw); endMs = e && !e.allDay ? e.ms : start.ms + 3600000; }
  else endMs = start.ms + 3600000;
  const sp = bkLocalParts(start.ms);
  return { allDay: false, startMs: start.ms, endMs, rrule,
    baseDayMs: bkLaEpoch(sp.date, '00:00'), baseDow: sp.dow, baseStartMin: sp.min,
    durMin: Math.max(15, Math.round((endMs - start.ms) / 60000)) };
}
// Busy interval {s,e} (LA minutes) this event occupies on `date`, or null.
function bkEventBusyOnDate(ev, date) {
  const dayStartMs = bkLaEpoch(date, '00:00'), dayEndMs = dayStartMs + 86400000;
  const dow = new Date(date + 'T12:00:00Z').getUTCDay();
  if (ev.rrule) {
    const r = ev.rrule;
    if (dayStartMs < ev.baseDayMs) return null;
    if (r.untilMs && dayStartMs > r.untilMs) return null;
    let hit = false;
    if (r.freq === 'DAILY') hit = true;
    else if (r.freq === 'WEEKLY') hit = (r.byday.length ? r.byday : [ev.baseDow]).includes(dow);
    else return null; // MONTHLY / YEARLY not expanded (avoids over-blocking)
    if (!hit) return null;
    if (ev.allDay) return { s: 0, e: 1440 };
    return { s: Math.max(0, ev.baseStartMin), e: Math.min(1440, ev.baseStartMin + ev.durMin) };
  }
  if (ev.allDay) return (date >= ev.startDate && date < ev.endDate) ? { s: 0, e: 1440 } : null;
  if (ev.endMs <= dayStartMs || ev.startMs >= dayEndMs) return null;
  const s = Math.max(0, Math.round((ev.startMs - dayStartMs) / 60000));
  const e = Math.min(1440, Math.round((ev.endMs - dayStartMs) / 60000));
  return e > s ? { s, e } : null;
}

// ===========================================================================
// Booking settings API (authed) — powers the Settings tab
// ===========================================================================
async function apiBookingSettings() { return json({ ok: true, config: await loadBookingConfig() }); }
async function apiSaveBookingSettings(request) {
  const d = await readJson(request);
  const clean = bkSanitizeConfig(d && d.config ? d.config : d);
  await saveBookingConfig(clean);
  return json({ ok: true, config: clean });
}
async function apiCalTest(request) {
  const d = await readJson(request);
  let url = String((d && d.url) || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: 'Enter a valid https:// iCal URL' });
  try { CAL_CACHE = { url: '', at: 0, events: [] }; const evs = await bkFetchCal(url); return json({ ok: true, count: evs.length }); }
  catch (e) { return json({ ok: false, error: 'Could not read that calendar feed (' + String(e.message || e) + ')' }); }
}
function bkSanitizeConfig(input) {
  const d = bookingDefaults(), c = input || {};
  const num = (v, def) => { const n = Number(v); return isFinite(n) ? n : def; };
  const time = (v, def) => { const s = String(v || ''); if (!/^\d{1,2}:\d{2}$/.test(s)) return def; return s.length === 4 ? '0' + s : s; };
  const sizes = (Array.isArray(c.sizes) && c.sizes.length)
    ? c.sizes.map((s) => ({ id: (String(s.id || '').trim().replace(/\s+/g, '-').toLowerCase()) || 'size', label: String(s.label || '').trim() || 'Vehicle' })).slice(0, 6)
    : d.sizes;
  const sizeIds = sizes.map((z) => z.id);
  let ical = String((c.calendar && c.calendar.icalUrl) || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (ical && !/^https?:\/\//i.test(ical)) ical = '';
  return {
    tz: d.tz,
    workDays: Array.isArray(c.workDays) ? [...new Set(c.workDays.map(Number).filter((x) => x >= 0 && x <= 6))] : d.workDays,
    dayStart: time(c.dayStart, d.dayStart),
    lastStart: time(c.lastStart, d.lastStart),
    stepMin: Math.min(120, Math.max(15, num(c.stepMin, d.stepMin))),
    bufferMin: Math.min(240, Math.max(0, num(c.bufferMin, d.bufferMin))),
    maxJobsPerDay: Math.min(12, Math.max(1, num(c.maxJobsPerDay, d.maxJobsPerDay))),
    minLeadMin: Math.max(0, num(c.minLeadMin, d.minLeadMin)),
    windowDays: Math.min(180, Math.max(1, num(c.windowDays, d.windowDays))),
    sizes,
    services: (Array.isArray(c.services) && c.services.length ? c.services : d.services).map((s, i) => {
      const price = {}, duration = {};
      sizeIds.forEach((z) => {
        price[z] = Math.max(0, Math.round(num(s.price && s.price[z], (d.services[i] && d.services[i].price && d.services[i].price[z]) || 0)));
        duration[z] = Math.max(15, Math.round(num(s.duration && s.duration[z], (d.services[i] && d.services[i].duration && d.services[i].duration[z]) || 60)));
      });
      return { id: (String(s.id || ('svc' + i)).trim().replace(/\s+/g, '-').toLowerCase()) || ('svc' + i),
        name: String(s.name || 'Service').trim().slice(0, 60), enabled: s.enabled !== false, popular: !!s.popular,
        blurb: String(s.blurb || '').trim().slice(0, 160), price, duration };
    }).slice(0, 12),
    addons: (Array.isArray(c.addons) ? c.addons : d.addons).map((a, i) => ({
      id: (String(a.id || ('add' + i)).trim().replace(/\s+/g, '-').toLowerCase()) || ('add' + i),
      name: String(a.name || '').trim().slice(0, 60), price: Math.max(0, Math.round(num(a.price, 0))),
      enabled: a.enabled !== false, popular: !!a.popular, blurb: String(a.blurb || '').trim().slice(0, 120),
    })).filter((a) => a.name).slice(0, 30),
    cities: Array.isArray(c.cities) ? c.cities.map((x) => String(x).trim()).filter(Boolean).slice(0, 40) : d.cities,
    content: {
      businessName: String((c.content && c.content.businessName) || d.content.businessName).trim().slice(0, 80),
      phoneDisplay: String((c.content && c.content.phoneDisplay) || d.content.phoneDisplay).trim().slice(0, 40),
      phone: normalizePhone((c.content && c.content.phone) || d.content.phone) || d.content.phone,
      hook: String((c.content && c.content.hook) != null ? c.content.hook : d.content.hook).trim().slice(0, 200),
      guarantee: String((c.content && c.content.guarantee) != null ? c.content.guarantee : d.content.guarantee).trim().slice(0, 200),
      urgency: !(c.content && c.content.urgency === false),
      freeWax: !(c.content && c.content.freeWax === false),
    },
    proof: {
      rating: String((c.proof && c.proof.rating) || d.proof.rating).trim().slice(0, 8),
      reviews: Math.max(0, Math.round(num(c.proof && c.proof.reviews, d.proof.reviews))),
      cars: String((c.proof && c.proof.cars) || d.proof.cars).trim().slice(0, 12),
    },
    calendar: { enabled: !!(c.calendar && c.calendar.enabled) && !!ical, icalUrl: ical },
    blockedDates: Array.isArray(c.blockedDates) ? [...new Set(c.blockedDates.map((x) => String(x).trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].slice(0, 200) : [],
    // Booking texts: keep whatever the caller sent, fall back to the default for
    // any key it didn't send, so a settings save can never silently switch one
    // back on (this function rebuilds the whole config from scratch).
    autoTexts: Object.keys(d.autoTexts).reduce((o, k) => {
      const v = c.autoTexts && c.autoTexts[k];
      o[k] = (v === true || v === false) ? v : d.autoTexts[k];
      return o;
    }, {}),
  };
}

// ###########################################################################
// #  JOB DAY SUITE — the ten features that turn the dashboard into the app  #
// #  Mikey actually runs the day on. Everything below is additive: no        #
// #  existing route, storage key or cron step changes shape.                 #
// #                                                                          #
// #   1  Today's Run     — the day board (bookings + manual jobs + state)    #
// #   2  Live ETA        — a DoorDash-style tracking link for the customer   #
// #   3  Web Push        — real phone notifications, VAPID auto-generated    #
// #   4  Quote Builder   — priced quote in 3 taps, texted + tracked          #
// #   5  Get Paid        — payment requests, deposits, a public pay page     #
// #   6  Customer Garage — vehicles, gate codes, water/power, lifetime value #
// #   7  Neighborhood    — "I'll be in your area" blasts to nearby past jobs #
// #   8  Before / After  — job photos, stored + shown side by side           #
// #   9  (voice control is client-side; it rides on /api/ai/command)         #
// #  10  Daily Brief     — a 6am rundown pushed/emailed once a day           #
// #                                                                          #
// #  KV WRITE BUDGET: none of this writes on a plain GET. The only clock-    #
// #  driven writes are the daily brief (1/day) and the pay reminder sweep    #
// #  (only when an invoice is actually due). Live-ETA pings are throttled    #
// #  server-side to ~1 write/45s and only while a trip is running.           #
// ###########################################################################

const DAY_TTL_DAYS = 400;

// --- shared tiny helpers ----------------------------------------------------
function jdToday(cfg) { return localDateStr(Date.now(), cfg && cfg.tz); }
function jdIsDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function jdMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function jdStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
// URL-safe random token for the public tracker / pay pages. 22 chars ≈ 128 bits.
function jdToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return b64url(b).replace(/=+$/, '');
}
function b64url(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }
function jdEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function jdFirst(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
// Straight-line miles between two coordinates — good enough for an ETA sanity
// check and for "who lives near this job" without paying for a maps API.
function jdMiles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const la1 = a.lat * rad, la2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ===========================================================================
// 1 · TODAY'S RUN — the day board
// ===========================================================================
// Bookings stay the source of truth for *what* is scheduled; the day doc only
// stores what happened while running it (state, timestamps, notes) plus any
// job Mikey adds by hand. That keeps a GET free of writes and means the board
// can never drift from the booking record.
//
// day:<YYYY-MM-DD> = { date, manual:[job], state:{ jobId: run }, order:[jobId], updatedAt }
function dayKey(date) { return 'day:' + date; }
async function loadDay(date) {
  const raw = (await kv().get(dayKey(date), { type: 'json' })) || {};
  return { date, manual: raw.manual || [], state: raw.state || {}, order: raw.order || [], updatedAt: raw.updatedAt || 0 };
}
// ⚠ KV WRITE — only from an explicit tap on the day board (never on a read).
async function saveDay(doc) {
  doc.updatedAt = Date.now();
  await kv().put(dayKey(doc.date), JSON.stringify(doc), { expirationTtl: DAY_TTL_DAYS * 86400 });
}

const JOB_STATES = ['queued', 'enroute', 'onsite', 'done', 'skipped'];

// Merge bookings + appointments + manual jobs into one ordered run sheet.
async function buildDay(date) {
  const cfg = await loadConfig();
  const bcfg = await loadBookingConfig().catch(() => null);
  const doc = await loadDay(date);
  const jobs = [];

  for (const b of await loadBookings()) {
    if (b.date !== date) continue;
    if (b.status === 'declined' || b.status === 'cancelled') continue;
    jobs.push({
      id: 'b:' + b.id, source: 'booking', bookingId: b.id,
      name: b.name || '', phone: b.phone || '',
      address: b.address || '', city: b.city || '',
      service: b.serviceName || '', size: b.sizeLabel || '', vehicle: b.vehicle || '',
      slot: b.slot || '', at: b.apptAt || 0, durationMin: b.durationMin || 180,
      price: b.estimate || b.base || 0, notes: b.notes || '',
      pending: b.status === 'pending',
    });
  }

  // Threads with a saved appointment on this day that aren't already a booking
  // (a job Mikey locked in over text rather than through the booking page).
  const index = await loadIndex();
  for (const t of index) {
    if (!t.appointmentAt || t.archived) continue;
    if (localDateStr(t.appointmentAt, cfg.tz) !== date) continue;
    if (jobs.some((j) => j.phone === t.phone)) continue;
    const d = new Date(t.appointmentAt);
    jobs.push({
      id: 't:' + t.phone, source: 'thread', phone: t.phone, name: t.name || '',
      address: '', city: '', service: '', size: '', vehicle: '',
      slot: localTimeHm(t.appointmentAt, cfg.tz), at: t.appointmentAt, durationMin: 150,
      price: 0, notes: '', pending: false,
    });
  }

  for (const m of doc.manual) {
    jobs.push(Object.assign({ source: 'manual', pending: false, durationMin: 120, price: 0 }, m,
      { id: m.id, at: m.slot ? bkLaEpoch(date, m.slot) : 0 }));
  }

  // Where the job actually is. A job booked over text arrives carrying nothing
  // but a phone number, so the address, gate code and vehicle have to come from
  // that customer's garage — or, when he never filled one in, from the words of
  // the conversation itself. Doing it here is what puts the address on the run
  // board and in the brief instead of ten minutes of scrolling before he leaves.
  await attachPlace(jobs);

  // Attach the run state, then order: Mikey's manual order wins, else by time.
  for (const j of jobs) {
    const r = doc.state[j.id] || {};
    j.state = JOB_STATES.includes(r.state) ? r.state : 'queued';
    j.enrouteAt = r.enrouteAt || 0; j.startedAt = r.startedAt || 0; j.doneAt = r.doneAt || 0;
    j.runNote = r.note || ''; j.trackToken = r.trackToken || '';
    j.paidAmount = r.paid || 0; j.photos = r.photos || 0;
    j.mapQuery = [j.address || j.addressGuess, j.city, j.city ? 'WA' : ''].filter(Boolean).join(', ');
  }
  const pos = (id) => { const i = doc.order.indexOf(id); return i < 0 ? 9999 : i; };
  jobs.sort((a, b) => (pos(a.id) - pos(b.id)) || (a.at - b.at) || String(a.slot).localeCompare(String(b.slot)));

  const done = jobs.filter((j) => j.state === 'done');
  const money = jobs.reduce((s, j) => s + (j.state === 'done' ? (j.price || 0) : 0), 0);
  const drive = jobs.filter((j) => j.state !== 'skipped').length;
  return {
    date, jobs,
    summary: {
      total: jobs.length, done: done.length, remaining: jobs.filter((j) => j.state !== 'done' && j.state !== 'skipped').length,
      booked: jobs.reduce((s, j) => s + (j.state === 'skipped' ? 0 : (j.price || 0)), 0),
      earned: jdMoney(money), hours: Math.round(jobs.reduce((s, j) => s + (j.durationMin || 0), 0) / 6) / 10,
      stops: drive,
    },
    tz: cfg.tz,
    services: bcfg ? (bcfg.services || []).map((s) => ({ id: s.id, name: s.name })) : [],
  };
}
// One thread read per customer on the board — at his volume that's a handful of
// reads a day, and only when the day is actually opened. Threads are cached by
// phone so two stops for the same person don't pay twice. Nothing is written:
// a guessed address stays a guess until he taps save.
async function attachPlace(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    j.gate = j.gate || ''; j.parking = j.parking || '';
    j.prefs = j.prefs || ''; j.avoid = j.avoid || '';
    j.water = null; j.power = null;
    j.addressGuess = ''; j.placeFrom = j.address ? 'booking' : '';
    if (!j.phone) continue;
    let t = seen.get(j.phone);
    if (!t) { t = await loadThread(j.phone); seen.set(j.phone, t); }
    const g = t.garage || {};
    if (!j.address && g.address) { j.address = g.address; j.placeFrom = 'garage'; }
    if (!j.city && g.city) j.city = g.city;
    if (!j.vehicle) j.vehicle = garageVehicleLabel(g);
    if (!j.name && t.name) j.name = t.name;
    j.gate = g.gate || ''; j.parking = g.parking || '';
    j.prefs = g.prefs || ''; j.avoid = g.avoid || '';
    j.water = g.water === undefined ? null : g.water;
    j.power = g.power === undefined ? null : g.power;
    if (!j.address) {
      const found = findAddressInThread(t);
      if (found) { j.addressGuess = found.text; j.placeFrom = 'text'; }
    }
  }
}

function localTimeHm(ts, tz) {
  try {
    const s = new Date(ts).toLocaleTimeString('en-GB', { timeZone: tz || 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return s.slice(0, 5);
  } catch { return '09:00'; }
}

async function apiDay(url) {
  const cfg = await loadConfig();
  const date = jdIsDate(url.searchParams.get('date')) ? url.searchParams.get('date') : jdToday(cfg);
  return json(Object.assign({ ok: true }, await buildDay(date)));
}

// Advance a job through the run: queued → enroute → onsite → done. Side effects
// are opt-in from the client (`text:true` sends the customer the matching
// message) so a mis-tap never texts anyone by surprise.
async function apiDayState(request) {
  const d = await readJson(request);
  const cfg = await loadConfig();
  const date = jdIsDate(d.date) ? d.date : jdToday(cfg);
  const jobId = jdStr(d.jobId, 64);
  const state = JOB_STATES.includes(d.state) ? d.state : null;
  if (!jobId || !state) return json({ ok: false, error: 'bad_request' }, 422);

  const day = await buildDay(date);
  const job = day.jobs.find((j) => j.id === jobId);
  if (!job) return json({ ok: false, error: 'not_found' }, 404);

  const doc = await loadDay(date);
  const run = doc.state[jobId] || {};
  run.state = state;
  const now = Date.now();
  if (state === 'enroute' && !run.enrouteAt) run.enrouteAt = now;
  if (state === 'onsite' && !run.startedAt) run.startedAt = now;
  if (state === 'done' && !run.doneAt) run.doneAt = now;
  if (state === 'queued') { run.enrouteAt = 0; run.startedAt = 0; run.doneAt = 0; }
  if (typeof d.note === 'string') run.note = d.note.slice(0, 400);

  let track = null, texted = false;
  if (state === 'enroute' && d.track && job.phone) {
    track = await trackStart({ phone: job.phone, name: job.name, etaMin: Math.max(1, Math.min(180, Number(d.etaMin) || 20)),
      address: job.address, city: job.city, jobId, date });
    run.trackToken = track.token;
  }
  if (d.text && job.phone) {
    const body = dayJobText(state, job, d, track, cfg);
    if (body) {
      try {
        await sendSms(job.phone, body);
        await appendMessage(job.phone, { dir: 'out', body, kind: 'run', status: 'sent' }, { name: job.name });
        texted = true;
      } catch (e) { /* the state change still stands; the UI reports the text failed */ }
    }
  }
  doc.state[jobId] = run;
  await saveDay(doc);
  return json({ ok: true, day: await buildDay(date), texted, track });
}

function dayJobText(state, job, d, track, cfg) {
  const custom = jdStr(d.body, 600);
  if (custom) return custom;
  const first = jdFirst(job.name);
  const hi = first ? `Hey ${first}` : 'Hey';
  if (state === 'enroute') {
    const eta = Math.max(1, Math.min(180, Number(d.etaMin) || 20));
    return `${hi}, Mikey here — on my way now, about ${eta} minutes out.` +
      (track ? ` Track me live: ${track.url}` : '') +
      ` If you can, please have the car accessible with water & power nearby. See you soon!`;
  }
  if (state === 'onsite') return `${hi} — I'm here and getting started on your vehicle. I'll let you know the moment it's done. - Mikey`;
  if (state === 'done') {
    const rev = cfg && cfg.reviewUrl ? ` If you've got 2 minutes, a Google review means the world: ${cfg.reviewUrl}` : '';
    return `${hi}, all finished — your vehicle is done and looking great! Thanks for having me out.${rev} - Mikey`;
  }
  return '';
}

// Add / edit a hand-entered job (a cash job, a friend's truck, a re-do).
async function apiDayJob(request) {
  const d = await readJson(request);
  const cfg = await loadConfig();
  const date = jdIsDate(d.date) ? d.date : jdToday(cfg);
  const doc = await loadDay(date);
  const id = d.id && String(d.id).startsWith('m:') ? String(d.id) : 'm:' + genId();
  const job = {
    id,
    name: jdStr(d.name, 60), phone: normalizePhone(d.phone) || '',
    address: jdStr(d.address, 140), city: jdStr(d.city, 60),
    service: jdStr(d.service, 60), size: jdStr(d.size, 30), vehicle: jdStr(d.vehicle, 60),
    slot: /^\d{2}:\d{2}$/.test(String(d.slot || '')) ? d.slot : '09:00',
    durationMin: Math.max(15, Math.min(720, Number(d.durationMin) || 120)),
    price: jdMoney(d.price), notes: jdStr(d.notes, 400),
  };
  if (!job.name && !job.phone && !job.address) return json({ ok: false, error: 'need_name' }, 422);
  const i = doc.manual.findIndex((m) => m.id === id);
  if (i >= 0) doc.manual[i] = job; else doc.manual.push(job);
  if (doc.manual.length > 40) return json({ ok: false, error: 'day_full' }, 422);
  await saveDay(doc);
  return json({ ok: true, day: await buildDay(date) });
}

async function apiDayRemove(request) {
  const d = await readJson(request);
  const cfg = await loadConfig();
  const date = jdIsDate(d.date) ? d.date : jdToday(cfg);
  const id = jdStr(d.jobId, 64);
  const doc = await loadDay(date);
  doc.manual = doc.manual.filter((m) => m.id !== id);
  delete doc.state[id];
  doc.order = doc.order.filter((x) => x !== id);
  await saveDay(doc);
  return json({ ok: true, day: await buildDay(date) });
}

async function apiDayOrder(request) {
  const d = await readJson(request);
  const cfg = await loadConfig();
  const date = jdIsDate(d.date) ? d.date : jdToday(cfg);
  const doc = await loadDay(date);
  doc.order = (Array.isArray(d.order) ? d.order : []).map((x) => jdStr(x, 64)).filter(Boolean).slice(0, 60);
  await saveDay(doc);
  return json({ ok: true, day: await buildDay(date) });
}

// ===========================================================================
// 2 · LIVE ETA TRACKING — the customer-facing "he's on his way" page
// ===========================================================================
// trk:<token> holds one trip. It expires on its own (12h TTL) so nothing has to
// clean up, and the customer link dies with it. Position pings are throttled to
// one write per ~45s so a long drive costs ~20 writes, not 200.
const TRACK_TTL = 12 * 3600;
const TRACK_MIN_WRITE_MS = 40000;

async function trackStart({ phone, name, etaMin, address, city, jobId, date }) {
  const token = jdToken();
  const now = Date.now();
  const trip = {
    token, phone: normalizePhone(phone) || '', name: jdStr(name, 60),
    dest: [jdStr(address, 140), jdStr(city, 60)].filter(Boolean).join(', '),
    jobId: jdStr(jobId, 64), date: jdStr(date, 12),
    startedAt: now, etaAt: now + etaMin * 60000, etaMin,
    lat: null, lng: null, status: 'enroute', updatedAt: now,
  };
  await kv().put('trk:' + token, JSON.stringify(trip), { expirationTtl: TRACK_TTL });
  return { token, url: `${publicBase()}/t/${token}`, etaAt: trip.etaAt };
}

async function apiTrackStart(request) {
  const d = await readJson(request);
  const phone = normalizePhone(d.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const etaMin = Math.max(1, Math.min(180, Number(d.etaMin) || 20));
  const t = await trackStart({ phone, name: d.name, etaMin, address: d.address, city: d.city, jobId: d.jobId, date: d.date });
  if (d.text !== false) {
    const first = jdFirst(d.name);
    const body = jdStr(d.body, 600) ||
      `${first ? 'Hey ' + first : 'Hey'}, Mikey's on the way — about ${etaMin} minutes out. Watch me live here: ${t.url}`;
    try { await sendSms(phone, body); await appendMessage(phone, { dir: 'out', body, kind: 'run', status: 'sent' }, { name: d.name }); }
    catch (e) { return json({ ok: true, track: t, texted: false, error: String(e.message || e) }); }
  }
  return json({ ok: true, track: t, texted: d.text !== false });
}

// Position ping from Mikey's phone while driving. Cheap by design: we only
// persist when the clock or the distance says it's worth a write.
async function apiTrackPing(request) {
  const d = await readJson(request);
  const token = jdStr(d.token, 40);
  const raw = await kv().get('trk:' + token, { type: 'json' });
  if (!raw) return json({ ok: false, error: 'not_found' }, 404);
  if (raw.status === 'ended') return json({ ok: true, stale: true });
  const lat = Number(d.lat), lng = Number(d.lng);
  const now = Date.now();
  const moved = (raw.lat != null && Number.isFinite(lat))
    ? (jdMiles({ lat: raw.lat, lng: raw.lng }, { lat, lng }) || 0) : 99;
  const etaMin = d.etaMin != null ? Math.max(0, Math.min(240, Number(d.etaMin) || 0)) : null;
  const etaShift = etaMin != null && Math.abs((raw.etaAt - now) / 60000 - etaMin) > 3;
  if (!etaShift && moved < 0.12 && (now - raw.updatedAt) < TRACK_MIN_WRITE_MS) return json({ ok: true, skipped: true });
  if (Number.isFinite(lat) && Number.isFinite(lng)) { raw.lat = Math.round(lat * 1e5) / 1e5; raw.lng = Math.round(lng * 1e5) / 1e5; }
  if (etaMin != null) { raw.etaMin = etaMin; raw.etaAt = now + etaMin * 60000; }
  raw.updatedAt = now;
  const ttl = Math.max(120, TRACK_TTL - Math.round((now - raw.startedAt) / 1000));
  await kv().put('trk:' + token, JSON.stringify(raw), { expirationTtl: ttl });
  return json({ ok: true });
}

async function apiTrackStop(request) {
  const d = await readJson(request);
  const token = jdStr(d.token, 40);
  const raw = await kv().get('trk:' + token, { type: 'json' });
  if (!raw) return json({ ok: true });
  raw.status = d.status === 'arrived' ? 'arrived' : 'ended';
  raw.updatedAt = Date.now();
  await kv().put('trk:' + token, JSON.stringify(raw), { expirationTtl: 3600 });
  return json({ ok: true });
}

// PUBLIC — the customer's page polls this. Only ever exposes trip facts, never
// the phone number or anything else about the business's data.
async function apiTrackState(url) {
  const token = jdStr(url.searchParams.get('t'), 40);
  const raw = token ? await kv().get('trk:' + token, { type: 'json' }) : null;
  if (!raw) return cors(json({ ok: false, error: 'expired' }, 404));
  const cfg = await loadConfig();
  const minsOut = Math.max(0, Math.round((raw.etaAt - Date.now()) / 60000));
  return cors(json({
    ok: true, status: raw.status, name: jdFirst(raw.name), dest: raw.dest,
    etaAt: raw.etaAt, minsOut, startedAt: raw.startedAt,
    lat: raw.lat, lng: raw.lng, updatedAt: raw.updatedAt,
    business: 'Mikey\'s Mobile Detailing', phone: cfg.publicPhone || ENV.TWILIO_FROM || '',
  }));
}

// PUBLIC — the tracking page itself. Self-contained (no external assets), so it
// loads instantly on a customer's phone even on a bad connection.
function trackPage(token) {
  const t = jdEsc(token);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0c"><title>Mikey's on the way</title>
<link rel="icon" href="/favicon.svg"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#1d1f27,#0a0a0c 60%);color:#f2f4f8;
display:flex;align-items:center;justify-content:center;padding:22px}
.card{width:100%;max-width:460px;background:#121216;border:1px solid #26293244;border-radius:24px;
padding:26px 22px 22px;box-shadow:0 30px 80px -40px #000;text-align:center}
.brand{display:flex;align-items:center;justify-content:center;gap:9px;font-weight:800;letter-spacing:-.01em;font-size:15px;color:#ff8a93}
.brand svg{width:22px;height:22px}
.pulse{margin:20px auto 6px;width:104px;height:104px;border-radius:50%;display:flex;align-items:center;justify-content:center;
background:radial-gradient(circle,rgba(255,46,67,.22),transparent 70%);position:relative}
.pulse:before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #ff2e43;opacity:.55;animation:p 2.2s ease-out infinite}
.pulse:after{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid #ff2e43;opacity:.35;animation:p 2.2s ease-out .9s infinite}
@keyframes p{0%{transform:scale(.72);opacity:.7}100%{transform:scale(1.35);opacity:0}}
.pulse svg{width:44px;height:44px;color:#fff;position:relative}
h1{font-size:26px;margin:12px 0 4px;letter-spacing:-.02em}
.eta{font-size:56px;font-weight:800;letter-spacing:-.04em;line-height:1;margin:14px 0 2px;
background:linear-gradient(180deg,#fff,#ff8a93);-webkit-background-clip:text;background-clip:text;color:transparent}
.etal{font-size:13px;color:#9aa3b2;letter-spacing:.06em;text-transform:uppercase;font-weight:700}
.arrive{margin-top:14px;font-size:14px;color:#c9cfda}
.bar{height:8px;border-radius:99px;background:#23252d;margin:22px 0 6px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#ff2e43,#ff8a93);transition:width .8s ease}
.steps{display:flex;justify-content:space-between;font-size:11px;color:#6b7280;font-weight:600}
.steps b{color:#ff8a93}
.dest{margin-top:18px;padding:12px 14px;background:#1a1b21;border:1px solid #2a2d36;border-radius:14px;font-size:13.5px;color:#c9cfda;text-align:left;display:flex;gap:10px;align-items:flex-start}
.dest svg{width:17px;height:17px;color:#ff8a93;flex:none;margin-top:1px}
.acts{display:flex;gap:10px;margin-top:16px}
.acts a{flex:1;text-decoration:none;padding:13px 0;border-radius:14px;font-weight:700;font-size:14.5px;
background:#23252d;color:#f2f4f8;border:1px solid #2a2d36;display:flex;align-items:center;justify-content:center;gap:7px}
.acts a.p{background:linear-gradient(180deg,#ff2e43,#c81e30);border-color:#ff2e43;color:#fff}
.acts svg{width:17px;height:17px}
.tip{margin-top:16px;font-size:12px;color:#6b7280;line-height:1.5}
.done .pulse:before,.done .pulse:after{animation:none;opacity:0}
.steps span.on{color:#ff8a93;font-weight:800}
@media (prefers-color-scheme:light){
body{background:radial-gradient(1200px 600px at 50% -10%,#fff,#eef0f3 60%);color:#161820}
.card{background:#fff;border-color:#d7dbe2;box-shadow:0 30px 70px -45px rgba(20,22,30,.45)}
.brand{color:#c81e30}.eta{background:linear-gradient(180deg,#161820,#c81e30);-webkit-background-clip:text;background-clip:text}
.etal,.steps{color:#5a626f}.arrive{color:#404755}.bar{background:#e7eaef}
.dest{background:#f4f6f8;border-color:#d7dbe2;color:#404755}.dest svg{color:#c81e30}
.acts a{background:#f4f6f8;color:#161820;border-color:#d7dbe2}.acts a.p{color:#fff}.tip{color:#8a93a1}
/* white-on-white would vanish: the arrow takes the brand color on light. */
.pulse svg{color:#c81e30}}
</style></head><body>
<div class="card" id="card">
  <div class="brand">${carSvg()}Mikey's Mobile Detailing</div>
  <div class="pulse">${navSvg()}</div>
  <h1 id="ttl">On the way</h1>
  <div class="eta" id="eta">—</div>
  <div class="etal" id="etal">minutes away</div>
  <div class="arrive" id="arrive"></div>
  <div class="bar"><i id="bar" style="width:8%"></i></div>
  <div class="steps"><span class="on" id="s1">Heading out</span><span id="s2">Close by</span><span id="s3">Arrived</span></div>
  <div class="dest" id="destBox" style="display:none">${pinSvg()}<span id="dest"></span></div>
  <div class="acts" id="acts"></div>
  <div class="tip">Have the vehicle accessible with water &amp; power within about 20&nbsp;ft, and I'll take it from there.</div>
</div>
<script>
var TOK=${JSON.stringify(token)},ICO_CALL=${JSON.stringify(phoneSvgLite())},ICO_MSG=${JSON.stringify(msgSvgLite())};
var start=0,etaAt=0,phone="",finished=false;
function E(id){return document.getElementById(id)}
function pad(n){return n<10?"0"+n:""+n}
function paint(d){
  if(!d||!d.ok){finished=true;E("ttl").textContent="This link has expired";
    E("eta").textContent="";E("etal").textContent="Text Mikey for an update";return}
  start=d.startedAt;etaAt=d.etaAt;phone=d.phone||"";
  if(d.dest){E("destBox").style.display="";E("dest").textContent=d.dest}
  if(phone&&!E("acts").innerHTML){
    E("acts").innerHTML='<a class="p" href="tel:'+phone+'">'+ICO_CALL+'Call</a><a href="sms:'+phone+'">'+ICO_MSG+'Text</a>';
  }
  if(d.status==="arrived"||d.status==="ended"){
    finished=true;
    E("card").className="card done";
    E("ttl").textContent=d.status==="arrived"?"Mikey has arrived":"Trip complete";
    E("eta").textContent=d.status==="arrived"?"Here":"\\u2713";
    E("etal").textContent=d.status==="arrived"?"at your vehicle":"thanks for having me out";
    E("bar").style.width="100%";E("arrive").textContent="";
    E("s1").className="on";E("s2").className="on";E("s3").className="on";
    return}
  tick();
}
function tick(){
  if(finished||!etaAt)return;
  var mins=Math.max(0,Math.round((etaAt-Date.now())/60000));
  E("eta").textContent=mins<1?"Any minute":mins;
  E("etal").textContent=mins<1?"pulling up now":(mins===1?"minute away":"minutes away");
  var a=new Date(etaAt),h=a.getHours(),ap=h>=12?"PM":"AM";h=h%12||12;
  E("arrive").textContent="Arriving around "+h+":"+pad(a.getMinutes())+" "+ap;
  var total=Math.max(1,etaAt-start),pc=Math.max(6,Math.min(97,Math.round((Date.now()-start)/total*100)));
  E("bar").style.width=pc+"%";
  E("s2").className=pc>55?"on":"";
}
function poll(){fetch("/api/track/state?t="+encodeURIComponent(TOK)).then(function(r){return r.json()}).then(paint).catch(function(){})}
poll();setInterval(poll,20000);setInterval(tick,1000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)poll()});
</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function carSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>'; }
function navSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>'; }
function pinSvg() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>'; }
function phoneSvgLite() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>'; }
function msgSvgLite() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:17px;height:17px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'; }

// ===========================================================================
// 3 · WEB PUSH — instant phone notifications, zero setup
// ===========================================================================
// The VAPID keypair is generated inside the Worker on first use and stored in
// KV, so there is nothing for the owner to create, paste or configure. Pushes
// are sent WITHOUT a payload (no aes128gcm encryption needed): the service
// worker wakes and calls /api/push/peek for the headline, which keeps this
// small, dependency-free and impossible to leak message content through.
async function vapidKeys() {
  const cached = await kv().get('push:vapid', { type: 'json' });
  if (cached && cached.pub && cached.jwk) return cached;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const doc = { pub: b64url(raw), jwk, createdAt: Date.now() };
  await kv().put('push:vapid', JSON.stringify(doc));   // ⚠ one KV write, once ever
  return doc;
}

async function vapidJwt(audience, keys) {
  const header = b64urlStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const sub = ENV.ALERT_EMAIL ? 'mailto:' + ENV.ALERT_EMAIL : (publicBase() || 'https://example.com');
  const payload = b64urlStr(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43200, sub }));
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
    key, new TextEncoder().encode(header + '.' + payload)));
  return `${header}.${payload}.${b64url(sig)}`;   // WebCrypto already returns raw r||s — exactly what ES256 wants
}

async function loadPushSubs() { return (await kv().get('push:subs', { type: 'json' })) || []; }
async function savePushSubs(list) { await kv().put('push:subs', JSON.stringify(list.slice(0, 6))); }

// Fire a push at every registered device. Dead subscriptions (404/410) are
// pruned so a reinstalled phone doesn't leave a zombie behind.
async function pushNotify() {
  const subs = await loadPushSubs();
  if (!subs.length) return 0;
  let keys; try { keys = await vapidKeys(); } catch { return 0; }
  let sent = 0; const dead = [];
  for (const s of subs) {
    try {
      const jwt = await vapidJwt(new URL(s.endpoint).origin, keys);
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: { TTL: '600', Urgency: 'high', Authorization: `vapid t=${jwt},k=${keys.pub}` },
      });
      if (res.status === 404 || res.status === 410) dead.push(s.endpoint);
      else if (res.ok || res.status === 201 || res.status === 202) sent++;
    } catch { /* one bad endpoint must never break the others */ }
  }
  if (dead.length) await savePushSubs(subs.filter((s) => !dead.includes(s.endpoint)));
  return sent;
}

async function apiPushKey() {
  const keys = await vapidKeys();
  const subs = await loadPushSubs();
  return json({ ok: true, key: keys.pub, devices: subs.length });
}

async function apiPushSubscribe(request) {
  const d = await readJson(request);
  const endpoint = jdStr(d.endpoint, 500);
  if (!/^https:\/\//.test(endpoint)) return json({ ok: false, error: 'bad_subscription' }, 422);
  const subs = await loadPushSubs();
  const rec = { endpoint, label: jdStr(d.label, 40) || 'This device', at: Date.now() };
  const i = subs.findIndex((s) => s.endpoint === endpoint);
  if (i >= 0) { subs[i] = Object.assign(subs[i], rec); }
  else subs.unshift(rec);
  await savePushSubs(subs);
  return json({ ok: true, devices: subs.length });
}

async function apiPushUnsubscribe(request) {
  const d = await readJson(request);
  const endpoint = jdStr(d.endpoint, 500);
  const subs = await loadPushSubs();
  const left = endpoint ? subs.filter((s) => s.endpoint !== endpoint) : [];
  await savePushSubs(left);
  return json({ ok: true, devices: left.length });
}

async function apiPushTest() {
  const n = await pushNotify();
  return json({ ok: n > 0, sent: n, error: n ? '' : 'no_devices_or_send_failed' });
}

// What the service worker shows after a payload-less push. Read-only: it builds
// the headline from the thread index that's already in memory-cheap KV.
async function apiPushPeek() {
  const index = await loadIndex();
  const active = index.filter((t) => !t.archived);
  const unread = active.filter((t) => t.unread > 0).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const owed = active.filter(rowAwaitingReply);
  if (unread.length) {
    const t = unread[0];
    const who = t.name || t.phone;
    const more = unread.length > 1 ? ` (+${unread.length - 1} more waiting)` : '';
    return json({ ok: true, title: `New text from ${who}`, body: (t.lastBody || 'Tap to read.') + more, url: '/' });
  }
  const due = active.filter((t) => t.followupDue).length;
  if (due) return json({ ok: true, title: 'Follow-ups ready', body: `${due} customer${due > 1 ? 's are' : ' is'} due for a nudge.`, url: '/' });
  if (owed.length) return json({ ok: true, title: 'Someone is waiting', body: `${owed.length} conversation${owed.length > 1 ? 's need' : ' needs'} your reply.`, url: '/' });
  return json({ ok: true, title: "Mikey's Dashboard", body: 'New activity — tap to open.', url: '/' });
}

// ===========================================================================
// 4 · QUOTE BUILDER — a priced, branded quote in three taps
// ===========================================================================
// Prices come from the same booking service menu the public site uses, so a
// texted quote and the booking page can never disagree. Quotes are tracked so
// the follow-up engine has something concrete to chase.
const QUOTE_KEY = 'quotes';
const QUOTE_CONDITIONS = [
  { id: 'clean', label: 'Well kept', mult: 1, note: '' },
  { id: 'normal', label: 'Normal use', mult: 1.1, note: 'normal wear' },
  { id: 'rough', label: 'Rough', mult: 1.3, note: 'heavy soil' },
  { id: 'pets', label: 'Pet hair / stains', mult: 1.45, note: 'pet hair + stain treatment' },
];
async function loadQuotes() { return (await kv().get(QUOTE_KEY, { type: 'json' })) || []; }
async function saveQuotes(list) { await kv().put(QUOTE_KEY, JSON.stringify(list.slice(0, 200))); }

async function apiQuoteConfig() {
  const cfg = await loadBookingConfig();
  return json({
    ok: true,
    sizes: cfg.sizes || [], addons: cfg.addons || [],
    services: (cfg.services || []).filter((s) => s.enabled !== false)
      .map((s) => ({ id: s.id, name: s.name, price: s.price, duration: s.duration, blurb: s.blurb || '' })),
    conditions: QUOTE_CONDITIONS,
    quotes: (await loadQuotes()).slice(0, 60),
  });
}

function quoteTotal(cfg, q) {
  const svc = (cfg.services || []).find((s) => s.id === q.service);
  const base = svc && svc.price ? (svc.price[q.size] || svc.price.suv || 0) : 0;
  const cond = QUOTE_CONDITIONS.find((c) => c.id === q.condition) || QUOTE_CONDITIONS[0];
  const addons = (q.addons || []).map((id) => (cfg.addons || []).find((a) => a.id === id) || null).filter(Boolean);
  const addTotal = addons.reduce((s, a) => s + (Number(a.price) || 0), 0);
  const travel = Math.max(0, Number(q.travel) || 0);
  const discount = Math.max(0, Number(q.discount) || 0);
  const sub = Math.round(base * cond.mult) + addTotal + travel;
  return {
    base, condMult: cond.mult, condLabel: cond.label, addons: addons.map((a) => ({ id: a.id, name: a.name, price: a.price })),
    addTotal, travel, discount, subtotal: sub, total: Math.max(0, sub - discount),
    serviceName: svc ? svc.name : '', durationMin: svc && svc.duration ? (svc.duration[q.size] || 180) : 180,
  };
}

function quoteMessage(q, calc, cfg) {
  const first = jdFirst(q.name);
  const lines = [];
  lines.push(`${first ? 'Hey ' + first + '!' : 'Hey!'} Here's your quote from Mikey's Mobile Detailing:`);
  lines.push('');
  lines.push(`${calc.serviceName}${q.sizeLabel ? ' · ' + q.sizeLabel : ''}${q.vehicle ? ' · ' + q.vehicle : ''}`);
  for (const a of calc.addons) lines.push(`+ ${a.name}${a.price ? ' ($' + a.price + ')' : ''}`);
  if (calc.travel) lines.push(`+ Travel: $${calc.travel}`);
  if (calc.discount) lines.push(`- Discount: $${calc.discount}`);
  lines.push('');
  lines.push(`TOTAL: $${calc.total}  ·  about ${Math.round(calc.durationMin / 30) / 2} hrs`);
  lines.push('I come to you — I just need water & power within ~20 ft.');
  if (q.note) { lines.push(''); lines.push(q.note); }
  lines.push('');
  lines.push(`Want me to lock in a day? Just reply with what works.${q.expiresDays ? ` (Good for ${q.expiresDays} days.)` : ''}`);
  lines.push('- Mikey');
  return lines.join('\n');
}

async function apiQuoteCreate(request) {
  const d = await readJson(request);
  const bcfg = await loadBookingConfig();
  const phone = normalizePhone(d.phone);
  const q = {
    id: d.id && jdStr(d.id, 24) ? jdStr(d.id, 24) : genId(),
    createdAt: Date.now(), status: 'draft',
    phone: phone || '', name: jdStr(d.name, 60), vehicle: jdStr(d.vehicle, 60),
    service: jdStr(d.service, 40), size: jdStr(d.size, 30), sizeLabel: jdStr(d.sizeLabel, 40),
    addons: Array.isArray(d.addons) ? d.addons.map((x) => jdStr(x, 40)).slice(0, 12) : [],
    condition: jdStr(d.condition, 20) || 'clean',
    travel: jdMoney(d.travel), discount: jdMoney(d.discount),
    note: jdStr(d.note, 300), expiresDays: Math.max(0, Math.min(60, Number(d.expiresDays) || 14)),
  };
  const calc = quoteTotal(bcfg, q);
  if (!calc.serviceName) return json({ ok: false, error: 'bad_service' }, 422);
  q.total = calc.total; q.serviceName = calc.serviceName;
  const body = jdStr(d.body, 1200) || quoteMessage(q, calc, bcfg);
  if (d.preview) return json({ ok: true, calc, body, quote: q });
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);

  let texted = false, err = '';
  if (d.send !== false) {
    try {
      await sendSms(phone, body);
      await appendMessage(phone, { dir: 'out', body, kind: 'quote', status: 'sent' }, { name: q.name });
      texted = true; q.status = 'sent'; q.sentAt = Date.now();
    } catch (e) { err = String(e.message || e); }
  }
  q.body = body;

  // Mirror onto the conversation so the quote is visible where the work happens.
  const thread = await loadThread(phone);
  if (!thread.name && q.name) thread.name = q.name;
  if (!thread.status || thread.status === 'new') { thread.status = 'active'; thread.statusAt = Date.now(); }
  if (!thread.tags.includes('quoted')) thread.tags.push('quoted');
  thread.quote = { id: q.id, total: q.total, service: q.serviceName, at: Date.now() };
  await saveThread(thread);
  await updateIndexEntry(thread);

  const list = await loadQuotes();
  const i = list.findIndex((x) => x.id === q.id);
  if (i >= 0) list[i] = q; else list.unshift(q);
  await saveQuotes(list);
  return json({ ok: true, quote: q, calc, texted, error: err });
}

// Accept / decline / delete a quote. Accepting flips the lead to Won and, when
// asked, drops the job straight into the money ledger — no double entry.
async function apiQuoteAction(request) {
  const d = await readJson(request);
  const id = jdStr(d.id, 24), action = jdStr(d.action, 20);
  const list = await loadQuotes();
  const q = list.find((x) => x.id === id);
  if (!q) return json({ ok: false, error: 'not_found' }, 404);

  if (action === 'delete') {
    await saveQuotes(list.filter((x) => x.id !== id));
    return json({ ok: true, deleted: true });
  }
  if (action === 'accept') {
    q.status = 'accepted'; q.acceptedAt = Date.now();
    if (q.phone) {
      const t = await loadThread(q.phone);
      if (t.status !== 'won') { t.status = 'won'; t.statusAt = Date.now(); }
      await saveThread(t); await updateIndexEntry(t);
    }
  } else if (action === 'decline') {
    q.status = 'declined'; q.declinedAt = Date.now();
  } else if (action === 'resend' && q.phone && q.body) {
    try { await sendSms(q.phone, q.body); await appendMessage(q.phone, { dir: 'out', body: q.body, kind: 'quote', status: 'sent' }, { name: q.name }); q.status = 'sent'; q.sentAt = Date.now(); }
    catch (e) { return json({ ok: false, error: String(e.message || e) }, 502); }
  } else {
    return json({ ok: false, error: 'bad_action' }, 422);
  }
  await saveQuotes(list);
  return json({ ok: true, quote: q });
}

// ===========================================================================
// 5 · GET PAID — payment requests, deposits and a public pay page
// ===========================================================================
// No processor account required: the pay page deep-links to whatever the owner
// already uses (Venmo / Cash App / PayPal / Zelle) and can carry a Stripe or
// Square payment link when he has one. Every request is tracked so "who still
// owes me" is a list, not a memory.
const PAY_KEY = 'pay:index';
const PAY_CFG_KEY = 'pay:config';
function payDefaults() {
  return { venmo: '', cashapp: '', paypal: '', zelle: '', link: '', linkLabel: 'Card / Apple Pay',
    cash: true, cashLabel: 'Cash in person', depositPct: 25, remindDays: 3,
    businessName: "Mikey's Mobile Detailing",
    tagline: 'Mobile detailing — I come to you',
    terms: 'Thanks for choosing Mikey\'s Mobile Detailing!',
    // Free-form extra ways to pay (Apple Cash, Chime, a check…) so the page can
    // cover whatever he actually uses without a code change.
    extras: [] };
}
async function loadPayConfig() { return Object.assign(payDefaults(), (await kv().get(PAY_CFG_KEY, { type: 'json' })) || {}); }
async function loadInvoices() { return (await kv().get(PAY_KEY, { type: 'json' })) || []; }
async function saveInvoices(list) { await kv().put(PAY_KEY, JSON.stringify(list.slice(0, 300))); }

async function apiPay() {
  const list = await loadInvoices();
  const open = list.filter((i) => i.status === 'open');
  return json({
    ok: true, config: await loadPayConfig(), invoices: list.slice(0, 80),
    outstanding: jdMoney(open.reduce((s, i) => s + i.amount, 0)), openCount: open.length,
  });
}

async function apiPaySaveConfig(request) {
  const d = await readJson(request);
  const cur = await loadPayConfig();
  const next = Object.assign(cur, {
    venmo: jdStr(d.venmo, 40).replace(/^@/, ''), cashapp: jdStr(d.cashapp, 40).replace(/^\$/, ''),
    paypal: jdStr(d.paypal, 60), zelle: jdStr(d.zelle, 60),
    link: /^https?:\/\//.test(String(d.link || '')) ? jdStr(d.link, 300) : '',
    linkLabel: jdStr(d.linkLabel, 40) || 'Card / Apple Pay',
    cash: d.cash !== false,
    cashLabel: jdStr(d.cashLabel, 40) || 'Cash in person',
    businessName: jdStr(d.businessName, 60) || "Mikey's Mobile Detailing",
    tagline: jdStr(d.tagline, 80),
    depositPct: Math.max(0, Math.min(100, Number(d.depositPct) || 0)),
    remindDays: Math.max(0, Math.min(30, Number(d.remindDays) || 0)),
    terms: jdStr(d.terms, 300),
    extras: Array.isArray(d.extras) ? d.extras.map((x) => ({
      label: jdStr(x && x.label, 40), detail: jdStr(x && x.detail, 80),
    })).filter((x) => x.label).slice(0, 6) : (cur.extras || []),
  });
  await kv().put(PAY_CFG_KEY, JSON.stringify(next));
  return json({ ok: true, config: next });
}

async function apiPayRequest(request) {
  const d = await readJson(request);
  const phone = normalizePhone(d.phone);
  const itemTotal = Array.isArray(d.items)
    ? d.items.reduce((t, x) => t + jdMoney(x && x.price), 0) : 0;
  const amount = jdMoney(d.amount) || jdMoney(itemTotal);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  if (!(amount > 0)) return json({ ok: false, error: 'bad_amount' }, 422);
  const pcfg = await loadPayConfig();
  // Line items are what turn the page into a receipt instead of a bare number.
  const items = Array.isArray(d.items) ? d.items.map((x) => ({
    name: jdStr(x && x.name, 80), price: jdMoney(x && x.price),
  })).filter((x) => x.name).slice(0, 20) : [];
  const inv = {
    id: genId(), token: jdToken(), createdAt: Date.now(), status: 'open',
    phone, name: jdStr(d.name, 60), amount, memo: jdStr(d.memo, 120) || 'Mobile detailing',
    items,
    kind: d.deposit ? 'deposit' : 'invoice', jobId: jdStr(d.jobId, 64), date: jdStr(d.date, 12),
    remindedAt: 0,
  };
  const url = `${publicBase()}/p/${inv.token}`;
  // The text does one job: say what the link is so they tap it. The breakdown,
  // the total and every payment option live on the page — repeating them here
  // just makes a wall of text people skim past.
  // Plain hyphens, not em dashes: a single non-GSM-7 character flips the whole
  // message to UCS-2, which cuts the segment limit from 160 to 70 and quietly
  // doubles the Twilio cost of every payment request he sends.
  const body = jdStr(d.body, 600) || (inv.kind === 'deposit'
    ? `Here's the deposit to hold your spot - amount and payment options: ${url}`
    : `Here's your invoice - full breakdown and every way to pay: ${url}`);

  let texted = false, err = '';
  if (d.send !== false) {
    try { await sendSms(phone, body); await appendMessage(phone, { dir: 'out', body, kind: 'pay', status: 'sent' }, { name: inv.name }); texted = true; }
    catch (e) { err = String(e.message || e); }
  }
  inv.body = body; inv.url = url;
  const list = await loadInvoices(); list.unshift(inv); await saveInvoices(list);
  return json({ ok: true, invoice: inv, texted, error: err, config: pcfg });
}

async function apiPayAction(request) {
  const d = await readJson(request);
  const id = jdStr(d.id, 24), action = jdStr(d.action, 20);
  const list = await loadInvoices();
  const inv = list.find((x) => x.id === id);
  if (!inv) return json({ ok: false, error: 'not_found' }, 404);
  if (action === 'paid') {
    inv.status = 'paid'; inv.paidAt = Date.now(); inv.method = jdStr(d.method, 20) || 'unknown';
  } else if (action === 'void') {
    inv.status = 'void';
  } else if (action === 'remind') {
    const first = jdFirst(inv.name);
    const body = `${first ? 'Hey ' + first : 'Hey'} — quick nudge on the $${inv.amount} for ${inv.memo}. You can knock it out here: ${inv.url} Thanks! - Mikey`;
    try { await sendSms(inv.phone, body); await appendMessage(inv.phone, { dir: 'out', body, kind: 'pay', status: 'sent' }, { name: inv.name }); inv.remindedAt = Date.now(); }
    catch (e) { return json({ ok: false, error: String(e.message || e) }, 502); }
  } else if (action === 'delete') {
    await saveInvoices(list.filter((x) => x.id !== id));
    return json({ ok: true, deleted: true });
  } else {
    return json({ ok: false, error: 'bad_action' }, 422);
  }
  await saveInvoices(list);
  return json({ ok: true, invoice: inv });
}

// PUBLIC — the customer taps the texted link and lands here.
async function payPage(token) {
  const list = await loadInvoices();
  const inv = list.find((x) => x.token === token);
  const pcfg = await loadPayConfig();
  if (!inv || inv.status === 'void') {
    return new Response(payShell('<h1>This link is no longer active</h1><p class="sub">Text Mikey and he\'ll send a fresh one.</p>'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  const amt = inv.amount.toFixed(2).replace(/\.00$/, '');
  const note = encodeURIComponent(inv.memo || 'Mobile detailing');
  const opts = [];
  if (pcfg.link) opts.push(['card', pcfg.linkLabel || 'Card / Apple Pay', pcfg.link, '#635bff']);
  if (pcfg.venmo) opts.push(['venmo', 'Venmo', `https://venmo.com/${encodeURIComponent(pcfg.venmo)}?txn=pay&amount=${amt}&note=${note}`, '#008CFF']);
  if (pcfg.cashapp) opts.push(['cashapp', 'Cash App', `https://cash.app/$${encodeURIComponent(pcfg.cashapp)}/${amt}`, '#00D54B']);
  if (pcfg.paypal) opts.push(['paypal', 'PayPal', `https://paypal.me/${encodeURIComponent(pcfg.paypal)}/${amt}`, '#0070E0']);
  if (pcfg.zelle) opts.push(['zelle', 'Zelle', '', '#6D1ED4']);
  const paid = inv.status === 'paid';
  const money = (n) => Number(n || 0).toFixed(2).replace(/\.00$/, '');

  // The breakdown. Only shown when there's more to say than the total itself —
  // a single line item that just repeats the memo would be noise.
  const items = Array.isArray(inv.items) ? inv.items : [];
  const itemSum = items.reduce((t, x) => t + Number(x.price || 0), 0);
  const showItems = items.length > 0;
  const remainder = jdMoney(inv.amount - itemSum);
  const lines = showItems ? `
       <div class="rcpt">
         <div class="rcpt-h">What this is for</div>
         ${items.map((x) => `<div class="li"><span class="n">${jdEsc(x.name)}</span><span class="p">${x.price ? '$' + jdEsc(money(x.price)) : ''}</span></div>`).join('')}
         ${inv.kind === 'deposit'
           ? `<div class="li sub2"><span class="n">Deposit requested now</span><span class="p">$${jdEsc(amt)}</span></div>`
           : (Math.abs(remainder) >= 0.01 ? `<div class="li sub2"><span class="n">Adjustment</span><span class="p">$${jdEsc(money(remainder))}</span></div>` : '')}
         <div class="li tot"><span class="n">${inv.kind === 'deposit' ? 'Due now' : 'Total'}</span><span class="p">$${jdEsc(amt)}</span></div>
       </div>` : '';

  const body = paid
    ? `<div class="badge ok">Paid ✓</div><h1>You're all set</h1><p class="sub">$${jdEsc(amt)} received — thank you!</p>${lines}`
    : `<div class="badge">${inv.kind === 'deposit' ? 'Deposit' : 'Amount due'}</div>
       <div class="amt">$${jdEsc(amt)}</div>
       <p class="sub">${jdEsc(inv.memo)}${inv.name ? ' · ' + jdEsc(jdFirst(inv.name)) : ''}</p>
       ${lines}
       <div class="opts">${opts.map(([id, label, href, color]) => href
        ? `<a class="opt" href="${jdEsc(href)}" target="_blank" rel="noopener"><span class="dot" style="background:${color}"></span>${jdEsc(label)}<span class="go">Pay →</span></a>`
        : `<div class="opt static"><span class="dot" style="background:${color}"></span>${jdEsc(label)}<span class="go">${jdEsc(pcfg.zelle)}</span></div>`).join('')}
       ${(pcfg.extras || []).map((x) => `<div class="opt static"><span class="dot" style="background:#8a93a1"></span>${jdEsc(x.label)}<span class="go">${jdEsc(x.detail)}</span></div>`).join('')}
       ${pcfg.cash ? `<div class="opt static"><span class="dot" style="background:#22c55e"></span>${jdEsc(pcfg.cashLabel || 'Cash in person')}<span class="go">On the day</span></div>` : ''}</div>
       ${opts.length || pcfg.cash || (pcfg.extras || []).length ? '' : '<p class="sub">Text Mikey for payment details.</p>'}
       <p class="fine">${jdEsc(pcfg.terms || '')}</p>`;
  return new Response(payShell(body, pcfg), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function payShell(inner, pcfg) {
  const biz = jdEsc((pcfg && pcfg.businessName) || "Mikey's Mobile Detailing");
  const tag = jdEsc((pcfg && pcfg.tagline) || '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0c"><title>${biz} — invoice</title>
<link rel="icon" href="/favicon.svg"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#1d1f27,#0a0a0c 60%);color:#f2f4f8;
display:flex;align-items:center;justify-content:center;padding:22px}
.card{width:100%;max-width:430px;background:#121216;border:1px solid #26293244;border-radius:24px;padding:28px 22px;text-align:center;box-shadow:0 30px 80px -40px #000}
.brand{font-weight:800;font-size:14px;color:#ff8a93;letter-spacing:-.01em;margin-bottom:18px}
.badge{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#9aa3b2;background:#1a1b21;border:1px solid #2a2d36;border-radius:99px;padding:5px 12px}
.badge.ok{color:#22c55e;border-color:#22c55e55;background:#22c55e14}
.amt{font-size:62px;font-weight:800;letter-spacing:-.045em;margin:14px 0 2px;background:linear-gradient(180deg,#fff,#ff8a93);-webkit-background-clip:text;background-clip:text;color:transparent}
h1{font-size:24px;margin:12px 0 4px;letter-spacing:-.02em}
.sub{color:#9aa3b2;font-size:14px;margin:2px 0 0}
.opts{display:flex;flex-direction:column;gap:10px;margin:22px 0 4px}
.opt{display:flex;align-items:center;gap:11px;text-decoration:none;color:#f2f4f8;background:#1a1b21;border:1px solid #2a2d36;border-radius:15px;padding:15px 16px;font-weight:700;font-size:15px}
.opt .dot{width:11px;height:11px;border-radius:50%;flex:none}
.opt .go{margin-left:auto;font-size:13px;color:#9aa3b2;font-weight:600}
.opt.static{opacity:.85}
.fine{margin-top:18px;font-size:12px;color:#6b7280;line-height:1.5}
.brand .tag{display:block;font-weight:600;font-size:11.5px;color:#9aa3b2;margin-top:3px;letter-spacing:0}
.rcpt{margin:22px 0 4px;text-align:left;background:#16171c;border:1px solid #2a2d36;border-radius:16px;padding:14px 15px}
.rcpt-h{font-size:10.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:#6b7280;margin-bottom:9px}
.li{display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid #23252d;font-size:14.5px}
.li:last-child{border-bottom:none}
.li .n{flex:1;color:#c9cfda}
.li .p{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.li.sub2 .n,.li.sub2 .p{color:#9aa3b2;font-size:13px;font-weight:600}
.li.tot{border-top:1px solid #2a2d36;margin-top:4px;padding-top:11px;font-size:17px}
.li.tot .n{color:#f2f4f8;font-weight:800}
.li.tot .p{color:#ff8a93;font-size:19px;font-weight:800}
@media (prefers-color-scheme:light){
body{background:radial-gradient(1200px 600px at 50% -10%,#fff,#eef0f3 60%);color:#161820}
.card{background:#fff;border-color:#d7dbe2;box-shadow:0 30px 70px -45px rgba(20,22,30,.45)}
.brand{color:#c81e30}.badge{background:#f4f6f8;border-color:#d7dbe2;color:#5a626f}
.amt{background:linear-gradient(180deg,#161820,#c81e30);-webkit-background-clip:text;background-clip:text}
.sub{color:#5a626f}.opt{background:#f4f6f8;border-color:#d7dbe2;color:#161820}.opt .go{color:#5a626f}.fine{color:#8a93a1}
.brand .tag{color:#5a626f}
.rcpt{background:#f7f8fa;border-color:#d7dbe2}
.li{border-bottom-color:#e3e6eb}.li .n{color:#3d434e}
.li.tot{border-top-color:#d7dbe2}.li.tot .n{color:#161820}.li.tot .p{color:#c81e30}}
</style></head><body><div class="card"><div class="brand">${biz}${tag ? `<span class="tag">${tag}</span>` : ''}</div>${inner}</div></body></html>`;
}

// ===========================================================================
// 6 · CUSTOMER GARAGE — vehicles, access notes and lifetime value
// ===========================================================================
// Lives on the thread (thread.garage) so it travels with the conversation and
// costs no extra reads. The roster view joins it against the money ledger so
// "who is worth chasing" is a fact, not a hunch.
// One-line "2019 Silver Tacoma" style label for list rows and the index.
function garageVehicleLabel(g) {
  const v = (g && g.vehicles && g.vehicles[0]) || null;
  if (!v) return '';
  return [v.year, v.color, v.make, v.model].filter(Boolean).join(' ').slice(0, 48);
}

// A street address written in the middle of a normal text. Anchored on the
// house number and closed by a street suffix, which is what keeps "$150 for 2
// cars" and "be there in 20 minutes" out of it — a bare number is never enough.
// Free: pure regex over messages already in memory, no AI call, no extra read.
const ADDR_RE = new RegExp(
  '\\b\\d{1,6}\\s+' +                                   // house number
  '(?:[NSEW]\\.?\\s+)?' +                               // optional N/S/E/W prefix
  '[A-Za-z0-9][A-Za-z0-9.\'-]*(?:\\s+[A-Za-z0-9.\'-]+){0,4}?\\s+' +  // street name
  '(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|' +
  'blvd|boulevard|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|loop|trl|trail)\\b\\.?' +
  '(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?' +                         // trailing quadrant
  '(?:\\s*(?:#|apt\\.?|unit|ste\\.?|suite)\\s*[A-Za-z0-9-]{1,8})?',   // optional unit
  'i');

// Newest first, and the customer's own words beat Mikey's — he's the one who
// knows where he lives. Bounded to the last 40 messages so a long thread costs
// the same as a short one.
function findAddressInThread(thread) {
  const msgs = (thread.messages || []).slice(-40);
  for (const dir of ['in', 'out']) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.dir !== dir || !m.body) continue;
      const hit = String(m.body).match(ADDR_RE);
      if (hit) return { text: hit[0].trim().slice(0, 140), ts: m.ts || 0, from: dir };
    }
  }
  return null;
}

function sanitizeGarage(g) {
  if (!g || typeof g !== 'object') return null;
  const veh = (Array.isArray(g.vehicles) ? g.vehicles : []).slice(0, 8).map((v) => ({
    id: jdStr(v.id, 24) || genId(),
    year: jdStr(v.year, 4), make: jdStr(v.make, 24), model: jdStr(v.model, 30),
    color: jdStr(v.color, 20), size: jdStr(v.size, 20), plate: jdStr(v.plate, 12),
    notes: jdStr(v.notes, 200),
  })).filter((v) => v.make || v.model || v.year);
  return {
    vehicles: veh,
    address: jdStr(g.address, 140), city: jdStr(g.city, 60), zip: jdStr(g.zip, 10),
    gate: jdStr(g.gate, 60), parking: jdStr(g.parking, 160),
    water: g.water === null || g.water === undefined ? null : !!g.water,
    power: g.power === null || g.power === undefined ? null : !!g.power,
    prefs: jdStr(g.prefs, 300), avoid: jdStr(g.avoid, 200),
    lat: Number.isFinite(Number(g.lat)) ? Number(g.lat) : null,
    lng: Number.isFinite(Number(g.lng)) ? Number(g.lng) : null,
  };
}

async function apiGarage(url) {
  const phone = normalizePhone(url.searchParams.get('phone'));
  const cfg = await loadConfig();
  if (phone) {
    const t = await loadThread(phone);
    const spend = await moneySpendFor(phone, cfg);
    return json({ ok: true, phone, garage: t.garage || null, name: t.name || '', spend });
  }
  // Roster: everyone with a garage entry or a logged job, richest first.
  const index = await loadIndex();
  const spendMap = await moneySpendMap(cfg);
  const rows = [];
  for (const t of index) {
    if (t.archived) continue;
    const sp = spendMap[t.phone];
    if (!sp && !t.hasGarage) continue;
    rows.push({
      phone: t.phone, name: t.name || '', status: t.status || '', tags: t.tags || [],
      lastTs: t.lastTs || 0, vehicles: t.vehicleLabel || '', city: t.city || '',
      jobs: sp ? sp.jobs : 0, total: sp ? sp.total : 0, lastJob: sp ? sp.lastDate : '',
    });
  }
  rows.sort((a, b) => b.total - a.total || b.lastTs - a.lastTs);
  return json({ ok: true, customers: rows.slice(0, 200) });
}

// ===========================================================================
// 6b · MONEY ON THE TABLE — the customers going quiet
// ===========================================================================
// A detailing business loses far more to people who already said yes once than
// to people who never called. Three kinds of quiet, all of them winnable, all
// of them invisible until now: a quote nobody answered, a customer overdue for
// another detail, and someone who asked for a price and never booked.
//
// Everything here is derived at read time from the index and the money ledger —
// no new store, no writes, no AI. The only thing written is a skip list, and
// only when Mikey taps "not now" on somebody.
const COLD_SKIP_KEY = 'cold:skip';
const COLD_KINDS = ['plan', 'quote', 'rebook', 'never'];

async function loadColdSkip() { return (await kv().get(COLD_SKIP_KEY, { type: 'json' })) || {}; }
async function saveColdSkip(d) { await kv().put(COLD_SKIP_KEY, JSON.stringify(d)); }

function coldMonths(days) { return Math.max(6, Math.min(24, Math.ceil(days / 30) + 6)); }

// The text he'd have written himself. Fixed templates on purpose: these go to
// people who are already lukewarm, and an AI that invents a price or a date on
// a rebook text does real damage. {first} is the only thing filled in.
function coldDraft(kind, row, cfg) {
  const first = jdFirst(row.name) || 'there';
  if (kind === 'plan') return planDraft(row);
  if (kind === 'quote') {
    const what = row.service ? `that ${row.service} quote` : 'that quote I sent over';
    return `Hey ${first}, Mikey here — just circling back on ${what}. Still want me to get you on the schedule?`;
  }
  if (kind === 'rebook') {
    const veh = row.vehicle ? ` on your ${row.vehicle}` : '';
    const when = row.months >= 2 ? `It's been about ${row.months} months since I was out${veh}.` :
      `It's been a little while since I was out${veh}.`;
    return `Hey ${first}, Mikey here. ${when} Want me to get you back on the schedule?`;
  }
  return `Hey ${first}, Mikey here — you reached out a while back about a detail and I don't think we ever locked in a time. Still interested? Happy to get you a price.`;
}

// The whole list, grouped, most-winnable first. One index read plus the money
// ledger; the same read the garage roster already does.
async function buildCold(cfg) {
  const now = Date.now();
  const DAY = 86400000;
  const rebookDays = Math.max(14, Math.min(365, Number(cfg.rebookDays) || 90));
  const index = await loadIndex();
  const spendMap = await moneySpendMap(cfg, coldMonths(rebookDays));
  const skip = await loadColdSkip();

  // What a job is worth on average, so "asked and never booked" can be counted
  // as money rather than as a name. Falls back to nothing when there's no history.
  const all = Object.values(spendMap);
  const jobsTotal = all.reduce((s, v) => s + v.total, 0);
  const jobsCount = all.reduce((s, v) => s + v.jobs, 0);
  const avgTicket = jobsCount ? jdMoney(jobsTotal / jobsCount) : 0;

  const groups = { plan: [], quote: [], rebook: [], never: [] };
  for (const t of index) {
    if (t.archived || t.optedOut) continue;
    if (skip[t.phone] && skip[t.phone] > now) continue;
    // Anyone with a booked job ahead of them is not going cold.
    if (t.appointmentAt && t.appointmentAt > now - 6 * 3600000) continue;
    if (t.heldUntil && t.heldUntil > now) continue;

    const sp = spendMap[t.phone];
    const lastJobTs = sp && sp.lastDate ? Date.parse(sp.lastDate + 'T12:00:00Z') : 0;
    const base = {
      phone: t.phone, name: t.name || '', vehicle: t.vehicleLabel || '', city: t.city || '',
      lastTs: t.lastTs || 0, status: t.status || '', jobs: sp ? sp.jobs : 0,
      lifetime: sp ? sp.total : 0,
    };

    // 0. On a plan and the cycle has come round. Ranked above everything else:
    //    they already agreed to a rhythm, so this is the closest thing to money
    //    that has already said yes.
    if (t.plan) {
      const pd = planDue(t.plan, lastJobTs, now);
      if (pd && pd.due) {
        groups.plan.push(Object.assign({}, base, {
          kind: 'plan', every: t.plan.every,
          days: Math.floor((now - pd.anchor) / DAY),
          value: t.plan.price || (sp && sp.jobs ? jdMoney(sp.total / sp.jobs) : avgTicket),
          at: pd.dueAt,
        }));
      }
      continue;   // someone on a plan is never also "going cold"
    }

    // 1. A quote that was sent and never answered. The most winnable money there
    //    is — they asked for a price and got one.
    if (t.quoteAt && t.status !== 'won' && t.status !== 'lost') {
      // Under three days isn't "gone quiet", it's a customer thinking about it.
      // Either way they're in the quote pipeline, so they never fall through to
      // being counted as a lead who never got a price.
      if (now - t.quoteAt >= 3 * DAY) {
        groups.quote.push(Object.assign({}, base, {
          kind: 'quote', days: Math.floor((now - t.quoteAt) / DAY),
          value: t.quoteTotal || avgTicket, at: t.quoteAt, service: '',
        }));
      }
      continue;
    }

    // 2. Detailed before, and due again. Past ~18 months they've moved on, and
    //    chasing them reads as spam rather than service.
    if (lastJobTs) {
      const days = Math.floor((now - lastJobTs) / DAY);
      if (days >= rebookDays && days <= 540) {
        groups.rebook.push(Object.assign({}, base, {
          kind: 'rebook', days, months: Math.round(days / 30),
          value: sp.jobs ? jdMoney(sp.total / sp.jobs) : avgTicket, at: lastJobTs,
        }));
      }
      continue;
    }

    // 3. Asked once, never booked, never paid. Cold after ten days of silence.
    const quiet = now - (t.lastTs || 0);
    if (quiet >= 10 * DAY && quiet <= 400 * DAY && t.status !== 'lost' && t.status !== 'won') {
      groups.never.push(Object.assign({}, base, {
        kind: 'never', days: Math.floor(quiet / DAY), value: avgTicket, at: t.lastTs || 0,
      }));
    }
  }

  // Oldest first inside each group: the one that has been sitting longest is the
  // one most likely to be gone tomorrow.
  for (const k of COLD_KINDS) {
    groups[k].sort((a, b) => b.days - a.days);
    groups[k] = groups[k].slice(0, 60);
    for (const r of groups[k]) r.draft = coldDraft(k, r, cfg);
  }
  const value = COLD_KINDS.reduce((s, k) => s + groups[k].reduce((n, r) => n + (r.value || 0), 0), 0);
  const counts = { total: 0 };
  for (const k of COLD_KINDS) { counts[k] = groups[k].length; counts.total += groups[k].length; }
  return { groups, avgTicket, rebookDays, counts, value: jdMoney(value) };
}

// ===========================================================================
// 6c · MAINTENANCE PLANS — turning one-time customers into a schedule
// ===========================================================================
// The cheapest job in this business is the one from somebody who already knows
// you. A plan says "this person gets detailed every N weeks"; when the clock
// comes round, it puts a drafted rebook text in front of Mikey. It never texts
// on its own and it never books anything — same rule as everywhere else here.
//
// Lives on the thread (thread.plan) so it travels with the conversation and
// costs no extra read. Due-ness is derived, not stored, so a plan can't rot.
const PLAN_EVERY = [14, 21, 28, 42, 56, 84, 112, 168];   // 2 wks … 6 months

function sanitizePlan(p) {
  if (!p || typeof p !== 'object') return null;
  const every = PLAN_EVERY.includes(Number(p.every)) ? Number(p.every) : 42;
  return {
    every,
    startedAt: Number(p.startedAt) || Date.now(),
    // The clock runs from the last job actually done, not from when the plan was
    // created — otherwise setting one up on an old customer hides them for weeks.
    lastJobAt: Number(p.lastJobAt) || 0,
    service: jdStr(p.service, 40),
    price: jdMoney(p.price),
    // When Mikey last got asked about this one, so it nags once per cycle.
    askedAt: Number(p.askedAt) || 0,
    paused: !!p.paused,
    note: jdStr(p.note, 200),
  };
}

// When is this plan next due, and is it due now? Pure — the caller supplies the
// last job date it already has, so this never reads.
function planDue(plan, lastJobTs, now) {
  if (!plan || plan.paused) return null;
  const anchor = Math.max(plan.lastJobAt || 0, lastJobTs || 0, plan.startedAt || 0);
  const dueAt = anchor + plan.every * 86400000;
  // One ask per cycle: once he's been shown this, it stays quiet until the next
  // window opens or the customer actually books.
  const asked = plan.askedAt && plan.askedAt > anchor;
  return { dueAt, due: now >= dueAt && !asked, anchor, asked: !!asked };
}

async function apiPlan(request, url) {
  if (request.method === 'GET') {
    const phone = normalizePhone(url.searchParams.get('phone'));
    if (phone) {
      const t = await loadThread(phone);
      return json({ ok: true, phone, plan: t.plan || null, every: PLAN_EVERY });
    }
    return json(Object.assign({ ok: true, every: PLAN_EVERY }, await buildPlans()));
  }
  const d = await readJson(request);
  const phone = normalizePhone(d.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const t = await loadThread(phone);
  const action = jdStr(d.action, 12);

  if (action === 'off') t.plan = null;
  else if (action === 'asked') {
    if (!t.plan) return json({ ok: false, error: 'no_plan' }, 404);
    t.plan.askedAt = Date.now();
  } else {
    const prev = t.plan || {};
    t.plan = sanitizePlan(Object.assign({}, prev, d.plan || {}, {
      startedAt: prev.startedAt || Date.now(),
    }));
  }
  await saveThread(t);
  await updateIndexEntry(t);
  return json({ ok: true, phone, plan: t.plan || null });
}

// Everyone on a plan, soonest-due first. Index-only: the plan is mirrored there,
// so this is one index read plus the ledger — no per-customer thread loads.
async function buildPlans(cfg, spendMap) {
  cfg = cfg || await loadConfig();
  const now = Date.now();
  const index = await loadIndex();
  const spend = spendMap || await moneySpendMap(cfg, 24);
  const rows = [];
  for (const t of index) {
    if (!t.plan || t.archived) continue;
    const sp = spend[t.phone];
    const lastJobTs = sp && sp.lastDate ? Date.parse(sp.lastDate + 'T12:00:00Z') : 0;
    const d = planDue(t.plan, lastJobTs, now);
    const booked = !!(t.appointmentAt && t.appointmentAt > now);
    rows.push({
      phone: t.phone, name: t.name || '', vehicle: t.vehicleLabel || '',
      every: t.plan.every, paused: !!t.plan.paused, service: t.plan.service || '',
      price: t.plan.price || 0,
      lastJobAt: lastJobTs, dueAt: d ? d.dueAt : 0, due: !!(d && d.due && !booked),
      booked, jobs: sp ? sp.jobs : 0, lifetime: sp ? sp.total : 0,
    });
  }
  rows.sort((a, b) => (b.due - a.due) || (a.dueAt - b.dueAt));
  for (const r of rows) r.draft = planDraft(r);
  return { plans: rows, dueCount: rows.filter((r) => r.due).length };
}

function planDraft(row) {
  const first = jdFirst(row.name) || 'there';
  const veh = row.vehicle ? ` your ${row.vehicle}` : ' your vehicle';
  const wk = Math.round(row.every / 7);
  return `Hey ${first}, Mikey here — you're due for${veh} (you're on the every-${wk}-week plan). ` +
    `Want me to get you back on the schedule this week?`;
}

// ===========================================================================
// 6d · THE CUSTOMER'S OWN PAGE — /c/<token>
// ===========================================================================
// Most of the texting in this business isn't conversation, it's admin: what do
// you charge, when are you free, can we move it, what did you do last time.
// This is one permanent link per customer that answers all of it without a
// single text. It knows who they are, so nothing has to be typed twice.
//
// The token is the identity, so it is long, unguessable and per-customer — and
// deliberately never expires, because a link that dies is a link that produces
// a text asking for a new link. It exposes only that customer's own data.
const CUST_TOK_KEY = (t) => 'cust:' + t;
const CUST_PHONE_KEY = (p) => 'custfor:' + p;

async function custTokenFor(phone) {
  phone = normalizePhone(phone);
  if (!phone) return '';
  const existing = await kv().get(CUST_PHONE_KEY(phone));
  if (existing) return existing;
  const token = jdToken() + jdToken();          // 2× the trip-token entropy
  await kv().put(CUST_TOK_KEY(token), JSON.stringify({ phone, createdAt: Date.now() }));
  await kv().put(CUST_PHONE_KEY(phone), token);
  return token;
}
async function custResolve(token) {
  if (!token || token.length < 12) return null;
  const rec = await kv().get(CUST_TOK_KEY(token), { type: 'json' });
  return rec && rec.phone ? rec : null;
}
function custUrl(token) { return `${publicBase()}/c/${token}`; }

// Everything that customer is allowed to see about themselves.
async function custState(phone) {
  const cfg = await loadConfig();
  const bcfg = await loadBookingConfig();
  const now = Date.now();
  const t = await loadThread(phone);
  const g = t.garage || {};
  const bookings = (await loadBookings()).filter((b) => b.phone === phone);
  const upcoming = bookings
    .filter((b) => (b.apptAt || 0) > now && b.status !== 'cancelled' && b.status !== 'declined')
    .sort((a, b) => a.apptAt - b.apptAt)[0] || null;
  const spend = await moneySpendFor(phone, cfg);
  const history = bookings
    .filter((b) => b.status === 'done')
    .sort((a, b) => (b.apptAt || 0) - (a.apptAt || 0))
    .slice(0, 6)
    .map((b) => ({ date: b.date, service: b.serviceName || '', vehicle: b.vehicle || '', price: b.estimate || 0 }));
  return {
    name: t.name || '', first: jdFirst(t.name),
    vehicle: garageVehicleLabel(g), address: g.address || '', city: g.city || '',
    plan: t.plan && !t.plan.paused ? { every: t.plan.every } : null,
    upcoming: upcoming ? {
      id: upcoming.id, date: upcoming.date, slot: upcoming.slot, dateLabel: upcoming.dateLabel || bkNiceDate(upcoming.date),
      service: upcoming.serviceName || '', price: upcoming.estimate || 0, status: upcoming.status,
    } : null,
    history, jobs: spend.jobs, lifetime: spend.total, needsAddress: !(g.address && g.city),
    services: (bcfg.services || []).filter((s) => s.enabled !== false)
      .map((s) => ({ id: s.id, name: s.name, price: s.price, duration: s.duration })),
    sizes: bcfg.sizes || [],
    biz: (bcfg.bizName || "Mikey's Mobile Detailing"),
    phoneMikey: ENV.TWILIO_FROM || '',
  };
}

async function apiCustState(url) {
  const rec = await custResolve(url.searchParams.get('t') || '');
  if (!rec) return cors(json({ ok: false, error: 'bad_token' }, 404));
  return cors(json(Object.assign({ ok: true }, await custState(rec.phone))));
}

// The customer acting on their own booking. Cancelling is real — that's the
// point of handing them the link — but it always tells Mikey, and it pulls the
// reminders the job still had queued so nobody gets "see you tomorrow!" for a
// job that isn't happening.
async function apiCustAction(request, url) {
  const rec = await custResolve(url.searchParams.get('t') || '');
  if (!rec) return cors(json({ ok: false, error: 'bad_token' }, 404));
  let d; try { d = await request.json(); } catch { return cors(json({ ok: false, error: 'bad_json' }, 400)); }
  const action = jdStr(d.action, 12);
  const all = await loadBookings();
  const bk = all.find((x) => x.id === jdStr(d.id, 40) && x.phone === rec.phone);
  if (!bk) return cors(json({ ok: false, error: 'not_found' }, 404));

  if (action !== 'cancel') return cors(json({ ok: false, error: 'bad_action' }, 422));
  if (bk.status === 'cancelled') return cors(json(Object.assign({ ok: true }, await custState(rec.phone))));
  bk.status = 'cancelled'; bk.cancelledBy = 'customer'; bk.cancelledAt = Date.now();
  const t = await loadThread(rec.phone);
  const note = jdStr(d.note, 200);
  if (bkPurgeScheduled(t, bk.id) > 0 || t.appointmentAt) {
    if (t.appointmentAt && Math.abs(t.appointmentAt - bk.apptAt) < 3600000) t.appointmentAt = null;
    await saveThread(t); await updateIndexEntry(t);
  }
  await saveBookings(all);
  await notifyMikey(
    `❌ ${t.name || rec.phone} cancelled their own booking`,
    [`${bk.serviceName || 'Job'} · ${bk.dateLabel || bk.date} at ${bkFmt12(bk.slot)}`,
      note ? `They said: ${note}` : null,
      `Cancelled from their booking link — the slot is open again and their reminders are pulled.`]
      .filter(Boolean).join('\n'),
  );
  return cors(json(Object.assign({ ok: true, cancelled: true }, await custState(rec.phone))));
}

// Hand Mikey the link to send. Generated once and reused forever after.
async function apiCustLink(request) {
  const d = await readJson(request);
  const phone = normalizePhone(d.phone);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const token = await custTokenFor(phone);
  const url = custUrl(token);
  if (d.text) {
    const t = await loadThread(phone);
    const first = jdFirst(t.name) || 'there';
    const body = jdStr(d.body, 600) ||
      `Hey ${first}, here's your own booking link — check what's coming up, book a time or move one, and see what I've done before. Save it, it doesn't expire: ${url}`;
    try {
      await sendSms(phone, body);
      await appendMessage(phone, { dir: 'out', body, kind: 'link', status: 'sent' }, { name: t.name });
    } catch (e) { return json({ ok: false, error: String(e.message || e), url }, 502); }
    return json({ ok: true, url, texted: true });
  }
  return json({ ok: true, url, texted: false });
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// The page itself. Server-rendered identity (so it says their name before a
// single request lands), then it drives the SAME public booking endpoints the
// website already uses — /api/availability and /api/book — so a time booked
// here and a time booked on the website can never disagree about what's free.
async function custPage(token) {
  const rec = await custResolve(token);
  if (!rec) {
    return htmlResponse(custShell(`<div class="pad"><h1>Link not found</h1>
      <p class="sub">This link isn't valid any more. Text Mikey and he'll send you a new one.</p></div>`, ''), 404);
  }
  const s = await custState(rec.phone);
  const hi = s.first ? `Hi ${jdEsc(s.first)}` : 'Your detailing';
  const tel = String(s.phoneMikey || '').replace(/[^0-9+]/g, '');

  let up = '';
  if (s.upcoming) {
    const u = s.upcoming;
    up = `<div class="card next"><div class="lbl">You're booked</div>
      <div class="big">${jdEsc(u.dateLabel)}</div>
      <div class="sub">${jdEsc(bkFmt12(u.slot))}${u.service ? ' · ' + jdEsc(u.service) : ''}${u.price ? ' · $' + u.price : ''}</div>
      ${u.status === 'pending' ? '<div class="pill warn">Waiting on Mikey to confirm</div>' : '<div class="pill ok">Confirmed</div>'}
      <div class="row"><button class="btn ghost" id="moveBtn">Need a different time</button>
      <button class="btn ghost danger" id="cancelBtn">Cancel</button></div></div>`;
  } else {
    up = `<div class="card"><div class="lbl">Nothing on the books</div>
      <div class="sub">Pick a time below whenever you're ready — it comes straight to me.</div></div>`;
  }

  const yours = [s.vehicle, s.address ? s.address + (s.city ? ', ' + s.city : '') : ''].filter(Boolean);
  const mine = yours.length
    ? `<div class="card"><div class="lbl">What I've got on file</div>
       ${yours.map((v) => `<div class="line">${jdEsc(v)}</div>`).join('')}
       ${s.plan ? `<div class="pill ok">On a plan — every ${Math.round(s.plan.every / 7)} weeks</div>` : ''}
       <div class="sub tiny">Wrong? Text me and I'll fix it.</div></div>` : '';

  const hist = s.history.length
    ? `<div class="card"><div class="lbl">What I've done for you</div>
       ${s.history.map((h) => `<div class="hrow"><span>${jdEsc(bkNiceDate(h.date))}</span>
         <span class="hs">${jdEsc(h.service || 'Detail')}</span>${h.price ? `<b>$${h.price}</b>` : ''}</div>`).join('')}
       ${s.jobs > 1 ? `<div class="sub tiny">${s.jobs} details with me so far. Thank you — really.</div>` : ''}</div>`
    : '';

  const inner = `<div class="pad">
    <h1>${hi}</h1>
    <p class="sub">Everything about your detailing in one place. Save this link — it doesn't expire.</p>
    ${up}${mine}
    <div class="card" id="bookCard"><div class="lbl">Book a time</div>
      <div id="bookBody"><button class="btn" id="startBook">Pick a day</button></div></div>
    ${hist}
    <div class="card contact"><div class="lbl">Need me?</div>
      ${tel ? `<a class="btn ghost" href="sms:${jdEsc(tel)}">Text Mikey</a>
      <a class="btn ghost" href="tel:${jdEsc(tel)}">Call Mikey</a>` : '<div class="sub">Text me any time.</div>'}</div>
    <div class="foot">${jdEsc(s.biz)}</div>
  </div>`;
  return htmlResponse(custShell(inner, token));
}

function custShell(inner, token) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0c"><title>Your detailing</title>
<link rel="icon" href="/favicon.svg"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#1d1f27,#0a0a0c 60%);color:#f2f4f8;padding:0 0 40px}
.pad{max-width:460px;margin:0 auto;padding:26px 18px}
h1{font-size:28px;letter-spacing:-.03em;margin:0 0 6px}
.sub{color:#9aa3b2;font-size:14px;margin:0 0 18px;line-height:1.5}
.sub.tiny{font-size:12px;margin:10px 0 0}
.card{background:#121216;border:1px solid #26293a55;border-radius:18px;padding:16px 15px;margin-bottom:12px}
.card.next{background:linear-gradient(160deg,#1a1218,#121216 60%);border-color:#4d222955}
.lbl{font-size:10.5px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:#6b7280;margin-bottom:8px}
.big{font-size:22px;font-weight:800;letter-spacing:-.02em}
.line{font-size:15px;font-weight:600;padding:3px 0}
.pill{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:5px 11px;margin-top:10px}
.pill.ok{color:#22c55e;background:rgba(34,197,94,.13)}
.pill.warn{color:#f5b842;background:rgba(245,184,66,.13)}
.row{display:flex;gap:8px;margin-top:13px;flex-wrap:wrap}
.btn{flex:1;min-width:130px;display:block;text-align:center;background:#ff2e43;border:1px solid #ff2e43;color:#fff;
  border-radius:12px;padding:13px 14px;font-size:14.5px;font-weight:700;text-decoration:none;cursor:pointer;font-family:inherit}
.btn.ghost{background:#1a1b21;border-color:#2a2d36;color:#f2f4f8}
.btn.ghost.danger{color:#ff8a93}
.btn:disabled{opacity:.5}
.hrow{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid #23252d;font-size:14px}
.hrow:last-of-type{border-bottom:none}
.hrow .hs{flex:1;color:#9aa3b2;font-size:13px}
.contact{display:flex;flex-direction:column;gap:8px}
.contact .btn{flex:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:7px;margin-top:4px}
.grid button{background:#1a1b21;border:1px solid #2a2d36;color:#f2f4f8;border-radius:11px;padding:11px 6px;
  font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.grid button.on{background:#ff2e43;border-color:#ff2e43;color:#fff}
.fld{width:100%;background:#1a1b21;border:1px solid #2a2d36;color:#f2f4f8;border-radius:11px;
  padding:12px;font-size:15px;margin-top:7px;font-family:inherit}
.note{color:#9aa3b2;font-size:13px;margin:10px 0 0;line-height:1.5}
.foot{text-align:center;color:#6b7280;font-size:12px;margin-top:22px}
@media (prefers-color-scheme:light){
  body{background:radial-gradient(1200px 600px at 50% -10%,#fff,#eef0f3 60%);color:#161820}
  .card{background:#fff;border-color:#d7dbe2}
  .card.next{background:linear-gradient(160deg,#fff4f5,#fff 60%);border-color:#f0c4ca}
  .sub,.hrow .hs,.note{color:#5a626f}.lbl,.foot{color:#8a93a1}
  .btn.ghost{background:#f4f6f8;border-color:#d7dbe2;color:#161820}
  .btn.ghost.danger{color:#c81e30}
  .grid button{background:#f4f6f8;border-color:#d7dbe2;color:#161820}
  .grid button.on{background:#c81e30;border-color:#c81e30;color:#fff}
  .fld{background:#f4f6f8;border-color:#d7dbe2;color:#161820}
  .hrow{border-bottom-color:#e3e6eb}}
</style></head><body>${inner}
<script>
var TOK=${JSON.stringify(token || '')};
var S=null,pick={date:"",slot:"",service:"",size:""};
function $(i){return document.getElementById(i)}
function api(p,o){return fetch(p,o).then(function(r){return r.json()})}
function load(then){api("/api/cust/state?t="+encodeURIComponent(TOK)).then(function(d){if(d&&d.ok){S=d;if(then)then(d)}})}
load();
function days(){
  var out=[],d=new Date();
  for(var i=1;i<=14;i++){
    var x=new Date(d.getFullYear(),d.getMonth(),d.getDate()+i);
    out.push({v:x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0"),
      l:x.toLocaleDateString([],{weekday:"short"})+" "+(x.getMonth()+1)+"/"+x.getDate()});
  }
  return out;
}
function startBook(){
  if(!S)return;
  pick.service=(S.services[0]||{}).id||"full";
  pick.size=(S.sizes[0]||{}).id||"suv";
  // Only asked when it isn't already on file, which for a repeat customer is never.
  var addr=S.needsAddress
    ? '<div class="lbl" style="margin-top:14px">Where are you?</div>'+
      '<input class="fld" id="addrIn" placeholder="Street address" value="'+esc(S.address||"")+'">'+
      '<input class="fld" id="cityIn" placeholder="City" value="'+esc(S.city||"")+'">'
    : '';
  var h='<div class="lbl" style="margin-top:4px">What day works?</div><div class="grid" id="dayGrid">'+
    days().map(function(d){return '<button data-d="'+d.v+'">'+d.l+'</button>'}).join("")+'</div>'+
    '<div id="slotWrap"></div>'+addr+'<div id="bookNote" class="note"></div>';
  $("bookBody").innerHTML=h;
  Array.prototype.forEach.call($("dayGrid").querySelectorAll("[data-d]"),function(b){
    b.onclick=function(){
      pick.date=b.getAttribute("data-d");pick.slot="";
      Array.prototype.forEach.call($("dayGrid").querySelectorAll("[data-d]"),function(x){x.classList.toggle("on",x===b)});
      $("slotWrap").innerHTML='<div class="note">Checking what\\'s open…</div>';
      api("/api/availability?date="+pick.date+"&service="+encodeURIComponent(pick.service)+"&size="+encodeURIComponent(pick.size))
        .then(function(d){
          var s=(d&&d.slots)||[];
          if(!s.length){$("slotWrap").innerHTML='<div class="note">Nothing open that day — try another.</div>';return}
          $("slotWrap").innerHTML='<div class="lbl" style="margin-top:14px">What time?</div><div class="grid" id="slotGrid">'+
            s.map(function(x){return '<button data-s="'+x+'">'+fmt12(x)+'</button>'}).join("")+'</div>'+
            '<button class="btn" id="doBook" style="margin-top:13px" disabled>Request this time</button>';
          Array.prototype.forEach.call($("slotGrid").querySelectorAll("[data-s]"),function(sb){
            sb.onclick=function(){
              pick.slot=sb.getAttribute("data-s");
              Array.prototype.forEach.call($("slotGrid").querySelectorAll("[data-s]"),function(x){x.classList.toggle("on",x===sb)});
              $("doBook").disabled=false;
            }});
          $("doBook").onclick=submit;
        });
    }});
}
function fmt12(hm){var p=hm.split(":"),h=+p[0],ap=h>=12?"PM":"AM";h=h%12||12;return h+":"+p[1]+" "+ap}
function esc(v){return String(v==null?"":v).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})}
function submit(){
  var b=$("doBook");b.disabled=true;b.textContent="Sending…";
  var ai=$("addrIn"),ci=$("cityIn");
  var address=ai?ai.value.trim():S.address, city=ci?ci.value.trim():S.city;
  if(!address||!city){b.disabled=false;b.textContent="Request this time";
    $("bookNote").textContent="I need the address to come out to.";return}
  api("/api/book",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    service:pick.service,size:pick.size,date:pick.date,slot:pick.slot,
    name:S.name,address:address,city:city,vehicle:S.vehicle,fromLink:TOK
  })}).then(function(d){
    if(d&&d.ok){$("bookBody").innerHTML='<div class="big">Sent to Mikey</div>'+
      '<div class="note">He\\'ll confirm shortly and you\\'ll get a text. Nothing else needed from you.</div>'}
    else{b.disabled=false;b.textContent="Request this time";
      $("bookNote").textContent=d&&d.error==="slot_taken"?"Someone just took that one — pick another time.":"That didn't go through. Try again, or text me."}
  }).catch(function(){b.disabled=false;b.textContent="Request this time"});
}
document.addEventListener("click",function(e){
  if(e.target.id==="startBook"){startBook();return}
  if(e.target.id==="moveBtn"){startBook();$("bookCard").scrollIntoView({behavior:"smooth"});return}
  if(e.target.id==="cancelBtn"){
    if(!S||!S.upcoming)return;
    if(!confirm("Cancel your "+S.upcoming.dateLabel+" appointment?"))return;
    e.target.disabled=true;e.target.textContent="Cancelling…";
    api("/api/cust/action?t="+encodeURIComponent(TOK),{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"cancel",id:S.upcoming.id})}).then(function(d){
        if(d&&d.ok)location.reload();
        else{e.target.disabled=false;e.target.textContent="Cancel"}
      });
  }
});
</script></body></html>`;
}

// ===========================================================================
// 6e · PRICING — what you charge vs what actually gets accepted
// ===========================================================================
// "Am I leaving money on the table" is answerable from data already here: every
// quote sent, and every job paid. A quote counts as won when that phone paid for
// a job within 60 days of it. Then the only question that matters is whether the
// win rate falls as the price rises — and if it doesn't, the price is too low.
//
// Two sources, deliberately merged: the texted quote builder (which tracks
// accept/decline itself) and the website quote log (which doesn't, so it's
// joined against the money ledger). No AI — this is arithmetic, and arithmetic
// shouldn't cost a token or be able to hallucinate a number.
const PRICE_WIN_DAYS = 60;

function priceBandsFor(quotes) {
  if (!quotes.length) return [];
  const sorted = quotes.map((q) => q.total).filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length < 6) return [];
  // Terciles rather than fixed dollar bands, so this works whether he's a
  // $120 maintenance shop or a $900 correction shop.
  const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  const cuts = [at(1 / 3), at(2 / 3)];
  const defs = [
    { label: `Under $${cuts[0]}`, lo: 0, hi: cuts[0] },
    { label: `$${cuts[0]}–${cuts[1]}`, lo: cuts[0], hi: cuts[1] },
    { label: `Over $${cuts[1]}`, lo: cuts[1], hi: Infinity },
  ];
  return defs.map((d) => {
    // `>= lo` on the open-ended top band, not `> lo`: a quote sitting exactly on
    // the boundary belongs in it, and `>` silently dropped one from the totals.
    const inBand = quotes.filter((q) => q.total > 0 && q.total >= d.lo && (d.hi === Infinity || q.total < d.hi));
    const won = inBand.filter((q) => q.won);
    return {
      label: d.label, lo: d.lo, hi: d.hi === Infinity ? 0 : d.hi,
      quotes: inBand.length, won: won.length,
      winRate: inBand.length ? Math.round(won.length / inBand.length * 100) : 0,
      avgQuoted: inBand.length ? jdMoney(inBand.reduce((s, q) => s + q.total, 0) / inBand.length) : 0,
    };
  }).filter((b) => b.quotes > 0);
}

function priceGroup(rows, key) {
  const by = {};
  for (const q of rows) {
    const k = (q[key] || '').trim() || 'Other';
    (by[k] = by[k] || []).push(q);
  }
  return Object.keys(by).map((name) => {
    const list = by[name];
    const won = list.filter((q) => q.won);
    const priced = list.filter((q) => q.total > 0);
    return {
      name, quotes: list.length, won: won.length,
      winRate: list.length ? Math.round(won.length / list.length * 100) : 0,
      avgQuoted: priced.length ? jdMoney(priced.reduce((s, q) => s + q.total, 0) / priced.length) : 0,
      avgWon: won.length ? jdMoney(won.reduce((s, q) => s + q.total, 0) / won.length) : 0,
    };
  }).filter((g) => g.quotes >= 2).sort((a, b) => b.quotes - a.quotes).slice(0, 8);
}

// Plain-English, and deliberately conservative: it only speaks when there's
// enough history to mean something, and it never proposes a number it can't
// justify from the win rate it just measured.
function priceAdvice(overall, bands, services) {
  const out = [];
  if (overall.quotes < 8) {
    out.push(`Only ${overall.quotes} quote${overall.quotes === 1 ? '' : 's'} on record so far — send a few more and this gets useful. It needs about 10 to say anything worth acting on.`);
    return out;
  }
  if (overall.winRate >= 75) {
    const bump = Math.max(10, Math.round(overall.avgQuoted * 0.1 / 5) * 5);
    out.push(`You're winning ${overall.winRate}% of everything you quote. That is high enough to mean your prices are under the market — try adding about $${bump} to your next ten quotes and watch whether the win rate actually moves.`);
  } else if (overall.winRate <= 35) {
    out.push(`You're winning ${overall.winRate}% of what you quote. Before dropping prices, check how fast you're answering — a slow reply loses more jobs than a high number does.`);
  }
  const top = bands[bands.length - 1], bottom = bands[0];
  if (bands.length >= 2 && top && bottom && top.quotes >= 3 && bottom.quotes >= 3) {
    if (top.winRate >= bottom.winRate - 8) {
      out.push(`Your expensive quotes (${top.label}) close at ${top.winRate}% — about the same as your cheap ones at ${bottom.winRate}%. Price isn't what's losing you jobs, so charging less isn't what will win them.`);
    } else if (bottom.winRate - top.winRate >= 25) {
      out.push(`Win rate drops from ${bottom.winRate}% on ${bottom.label.toLowerCase()} quotes to ${top.winRate}% on ${top.label.toLowerCase()} ones. That's a real ceiling — above about $${top.lo} people start shopping around.`);
    }
  }
  const strong = services.filter((s) => s.quotes >= 4 && s.winRate >= 80)
    .sort((a, b) => b.winRate - a.winRate)[0];
  if (strong) {
    const bump = Math.max(10, Math.round(strong.avgWon * 0.12 / 5) * 5);
    out.push(`${strong.name}: ${strong.won} of ${strong.quotes} accepted (${strong.winRate}%) at about $${Math.round(strong.avgWon)}. Almost nobody says no to that one — it can carry $${bump} more.`);
  }
  const weak = services.filter((s) => s.quotes >= 4 && s.winRate <= 30)
    .sort((a, b) => a.winRate - b.winRate)[0];
  if (weak) {
    out.push(`${weak.name} only lands ${weak.winRate}% of the time across ${weak.quotes} quotes. Worth asking whether it's priced wrong or just explained badly.`);
  }
  if (!out.length) out.push(`Win rate is ${overall.winRate}% at an average of $${Math.round(overall.avgQuoted)}. Nothing here says you're priced wrong — keep quoting and check back in a month.`);
  return out;
}

async function buildPricing(months) {
  const cfg = await loadConfig();
  months = Math.max(3, Math.min(24, Number(months) || 12));

  // Every job payment, by phone, so a quote can be checked against real money.
  const paid = {};
  let m = localDateStr(Date.now(), cfg.tz).slice(0, 7);
  for (let i = 0; i < months + 2; i++) {
    const doc = await loadMonth(m);
    for (const e of (doc.entries || [])) {
      if (e.type !== 'job' || !e.phone) continue;
      (paid[e.phone] = paid[e.phone] || []).push(e.ts || Date.parse(e.date + 'T12:00:00Z'));
    }
    m = prevMonthKey(m);
  }
  const wonAfter = (phone, ts) => !!(paid[phone] || [])
    .some((p) => p >= ts - 2 * 86400000 && p <= ts + PRICE_WIN_DAYS * 86400000);

  const rows = [];
  // 1. Texted quotes — these carry their own verdict, which beats any inference.
  for (const q of await loadQuotes()) {
    const ts = q.sentAt || q.createdAt || 0;
    if (!ts) continue;
    rows.push({
      ts, total: Math.round(q.total || 0), service: q.serviceName || '', size: q.sizeLabel || '',
      won: q.status === 'accepted' || (q.status !== 'declined' && wonAfter(q.phone, ts)),
      src: 'text',
    });
  }
  // 2. Website quotes — no verdict, so it's inferred from whether they paid.
  for (const { entries } of await quoteWindow(months, cfg.tz)) {
    for (const e of entries) {
      if (!e.total) continue;
      rows.push({
        ts: e.ts, total: e.total, service: (e.services || '').split(',')[0].trim(), size: '',
        vehicle: e.vehicle || '', won: e.type === 'booking' || wonAfter(e.phone, e.ts), src: 'web',
      });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);

  const priced = rows.filter((r) => r.total > 0);
  const won = rows.filter((r) => r.won);
  const wonPriced = priced.filter((r) => r.won);
  const overall = {
    quotes: rows.length, won: won.length,
    winRate: rows.length ? Math.round(won.length / rows.length * 100) : 0,
    avgQuoted: priced.length ? jdMoney(priced.reduce((s, r) => s + r.total, 0) / priced.length) : 0,
    avgWon: wonPriced.length ? jdMoney(wonPriced.reduce((s, r) => s + r.total, 0) / wonPriced.length) : 0,
    lost: jdMoney(priced.filter((r) => !r.won).reduce((s, r) => s + r.total, 0)),
  };
  const bands = priceBandsFor(priced);
  const services = priceGroup(rows, 'service');
  return { months, overall, bands, services, advice: priceAdvice(overall, bands, services) };
}

async function apiPricing(url) {
  return json(Object.assign({ ok: true }, await buildPricing(url.searchParams.get('months'))));
}

async function apiCold() {
  const cfg = await loadConfig();
  return json(Object.assign({ ok: true }, await buildCold(cfg)));
}

// "Not now" (back in 30 days), "not ever" (marks the lead lost so it stops being
// a lead at all), or "clear" to undo a skip.
async function apiColdAction(request) {
  const d = await readJson(request);
  const phone = normalizePhone(d.phone);
  const action = jdStr(d.action, 12);
  if (!phone) return json({ ok: false, error: 'bad_phone' }, 422);
  const skip = await loadColdSkip();
  if (action === 'later') {
    const days = Math.max(1, Math.min(365, Number(d.days) || 30));
    skip[phone] = Date.now() + days * 86400000;
  } else if (action === 'never') {
    skip[phone] = Date.now() + 3650 * 86400000;
    const t = await loadThread(phone);
    if (t.status !== 'lost') { t.status = 'lost'; t.statusAt = Date.now(); await saveThread(t); await updateIndexEntry(t); }
  } else if (action === 'clear') {
    delete skip[phone];
  } else return json({ ok: false, error: 'bad_action' }, 422);
  // Expired entries are dropped on every write, so the doc can't grow forever.
  const now = Date.now();
  for (const k of Object.keys(skip)) if (skip[k] < now) delete skip[k];
  await saveColdSkip(skip);
  const cfg = await loadConfig();
  return json(Object.assign({ ok: true }, await buildCold(cfg)));
}

// Lifetime spend per phone, from the money ledger (last 18 months of docs).
async function moneySpendMap(cfg, months = 18) {
  let m = localDateStr(Date.now(), cfg.tz).slice(0, 7);
  const map = {};
  for (let i = 0; i < months; i++) {
    const doc = await loadMonth(m);
    for (const e of (doc.entries || [])) {
      if (e.type !== 'job' || !e.phone) continue;
      const r = map[e.phone] = map[e.phone] || { jobs: 0, total: 0, lastDate: '' };
      r.jobs++; r.total = jdMoney(r.total + e.amount);
      if (e.date > r.lastDate) r.lastDate = e.date;
    }
    m = prevMonthKey(m);
  }
  return map;
}
async function moneySpendFor(phone, cfg) {
  const map = await moneySpendMap(cfg);
  return map[phone] || { jobs: 0, total: 0, lastDate: '' };
}

// ===========================================================================
// 7 · NEIGHBORHOOD BLAST — "I'll be in your area" batching
// ===========================================================================
// A mobile business makes money by not driving. When a job is booked in a town,
// this finds past customers in the same place and offers them the same-day
// slot at a discount. Opt-out aware, capped, and throttled.
function jdArea(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}
function jdZip(s) { const m = String(s || '').match(/\b(\d{5})\b/); return m ? m[1] : ''; }

// Where does this customer live? Checked in order of trustworthiness:
// the garage record, then their bookings, then the quote-form notes.
function customerPlace(thread, bookings) {
  const g = thread.garage || {};
  if (g.city || g.zip) return { city: jdArea(g.city), zip: g.zip || jdZip(g.address), address: g.address || '', src: 'garage' };
  const b = bookings.find((x) => x.phone === thread.phone && x.city);
  if (b) return { city: jdArea(b.city), zip: jdZip(b.address), address: b.address || '', src: 'booking' };
  const m = String(thread.notes || '').match(/(?:Where|Address)\s*:\s*([^\n]+)/i);
  if (m) { const line = m[1]; const parts = line.split(','); return { city: jdArea(parts[parts.length - 1] || parts[0]), zip: jdZip(line), address: line.trim(), src: 'notes' }; }
  return { city: '', zip: '', address: '', src: '' };
}

async function apiBlastCandidates(url) {
  const city = jdArea(url.searchParams.get('city'));
  const zip = jdZip(url.searchParams.get('zip'));
  const exclude = normalizePhone(url.searchParams.get('exclude')) || '';
  const cfg = await loadConfig();
  const bookings = await loadBookings();
  const index = await loadIndex();
  const spend = await moneySpendMap(cfg);
  const out = [];
  const seen = new Set();
  for (const t of index) {
    if (t.optedOut || t.phone === exclude || seen.has(t.phone)) continue;
    seen.add(t.phone);
    const thread = (t.status === 'won' || spend[t.phone]) ? await loadThread(t.phone) : null;
    if (!thread) continue;                                   // only past/won customers get a blast
    const place = customerPlace(thread, bookings);
    if (!place.city && !place.zip) continue;
    const match = (city && place.city === city) || (zip && place.zip === zip);
    if (!match) continue;
    const sp = spend[t.phone] || { jobs: 0, total: 0, lastDate: '' };
    out.push({
      phone: t.phone, name: t.name || '', city: place.city, zip: place.zip, address: place.address,
      jobs: sp.jobs, total: sp.total, lastJob: sp.lastDate, lastTs: t.lastTs || 0,
      daysSince: sp.lastDate ? Math.round((Date.now() - Date.parse(sp.lastDate + 'T12:00:00Z')) / 86400000) : null,
    });
  }
  out.sort((a, b) => (b.daysSince || 0) - (a.daysSince || 0) || b.total - a.total);
  return json({ ok: true, city, zip, candidates: out.slice(0, 60) });
}

// Send the blast. Hard-capped at 25 recipients per run and never texts an
// opted-out number (sendSms enforces that too — this is the friendly check).
async function apiBlastSend(request) {
  const d = await readJson(request);
  const template = jdStr(d.body, 600);
  if (!template) return json({ ok: false, error: 'empty_message' }, 422);
  const phones = [...new Set((Array.isArray(d.phones) ? d.phones : []).map((p) => normalizePhone(p)).filter(Boolean))].slice(0, 25);
  if (!phones.length) return json({ ok: false, error: 'no_recipients' }, 422);
  const cfg = await loadConfig();
  const results = [];
  for (const phone of phones) {
    if (isOptedOut(cfg, phone)) { results.push({ phone, ok: false, error: 'opted_out' }); continue; }
    const t = await loadThread(phone);
    const body = template.replace(/\{first_name\}/g, jdFirst(t.name) || 'there').replace(/\{name\}/g, t.name || 'there');
    try {
      await sendSms(phone, body);
      t.messages.push({ id: genId(), dir: 'out', body, ts: Date.now(), kind: 'blast', status: 'sent' });
      if (!t.tags.includes('neighborhood')) t.tags.push('neighborhood');
      await saveThread(t); await updateIndexEntry(t);
      results.push({ phone, ok: true });
    } catch (e) { results.push({ phone, ok: false, error: String(e.message || e) }); }
  }
  const sent = results.filter((r) => r.ok).length;
  const log = (await kv().get('blast:log', { type: 'json' })) || [];
  log.unshift({ id: genId(), at: Date.now(), city: jdStr(d.city, 60), sent, total: phones.length, body: template.slice(0, 300) });
  await kv().put('blast:log', JSON.stringify(log.slice(0, 40)));
  return json({ ok: true, sent, results });
}

// ===========================================================================
// 8 · BEFORE / AFTER PHOTOS
// ===========================================================================
// Same proven shape as money receipts: one compressed JPEG per KV value, a tiny
// index per job. The client compresses before upload, so a full before/after
// pair costs two small writes and shows instantly.
function photoIdxKey(job) { return 'ph:idx:' + job; }
async function apiPhotosList(url) {
  const job = jdStr(url.searchParams.get('job'), 64);
  if (!job) return json({ ok: false, error: 'bad_request' }, 422);
  const idx = (await kv().get(photoIdxKey(job), { type: 'json' })) || [];
  return json({ ok: true, job, photos: idx });
}
async function apiPhotoUpload(request) {
  const d = await readJson(request);
  const job = jdStr(d.job, 64);
  const phase = d.phase === 'after' ? 'after' : 'before';
  const img = String(d.img || '');
  if (!job) return json({ ok: false, error: 'bad_request' }, 422);
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 900000) return json({ ok: false, error: 'bad_image' }, 422);
  const id = genId();
  await kv().put('ph:img:' + id, img, { expirationTtl: DAY_TTL_DAYS * 86400 });
  const idx = (await kv().get(photoIdxKey(job), { type: 'json' })) || [];
  idx.push({ id, phase, ts: Date.now(), caption: jdStr(d.caption, 80) });
  await kv().put(photoIdxKey(job), JSON.stringify(idx.slice(-24)), { expirationTtl: DAY_TTL_DAYS * 86400 });
  // Keep the day board's photo counter honest so the run sheet shows the badge.
  if (d.date && jdIsDate(d.date)) {
    const doc = await loadDay(d.date);
    const run = doc.state[job] || {};
    run.photos = idx.length;
    doc.state[job] = run;
    await saveDay(doc);
  }
  return json({ ok: true, id, photos: idx });
}
async function apiPhotoImg(url) {
  const id = jdStr(url.searchParams.get('id'), 24);
  const data = id ? await kv().get('ph:img:' + id) : null;
  if (!data) return json({ ok: false, error: 'not_found' }, 404);
  const m = String(data).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!m) return json({ ok: false, error: 'bad_data' }, 500);
  const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400' } });
}
async function apiPhotoDelete(request) {
  const d = await readJson(request);
  const job = jdStr(d.job, 64), id = jdStr(d.id, 24);
  if (!job || !id) return json({ ok: false, error: 'bad_request' }, 422);
  const idx = ((await kv().get(photoIdxKey(job), { type: 'json' })) || []).filter((p) => p.id !== id);
  await kv().put(photoIdxKey(job), JSON.stringify(idx), { expirationTtl: DAY_TTL_DAYS * 86400 });
  try { await kv().delete('ph:img:' + id); } catch { /* best effort */ }
  return json({ ok: true, photos: idx });
}

// ===========================================================================
// 10 · DAILY BRIEF — the 6am rundown
// ===========================================================================
// Everything the owner needs before he picks up a towel: today's run, the
// weather risk on it, who is waiting, what came in yesterday, and the single
// thing worth doing first. Weather is Open-Meteo (free, keyless).
async function fetchWeather(days = 3) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=47.913&longitude=-122.098' +
    '&current=temperature_2m,weather_code,precipitation_probability,wind_speed_10m' +
    '&hourly=precipitation_probability,temperature_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max' +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles&forecast_days=${days}`;
  const res = await fetch(url, { cf: { cacheTtl: 1800, cacheEverything: true } });
  if (!res.ok) throw new Error('weather ' + res.status);
  return res.json();
}
const WX_TEXT = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'heavy showers', 95: 'thunderstorms', 96: 'storms', 99: 'storms' };

// Rain risk over the window a job actually occupies — a 40% chance at 3pm does
// not matter for a 9am job, and the generic daily forecast can't tell you that.
function jobRainRisk(wx, date, slot, durationMin) {
  try {
    const hours = (wx.hourly && wx.hourly.time) || [];
    const pops = (wx.hourly && wx.hourly.precipitation_probability) || [];
    const startH = parseInt(String(slot || '09:00').slice(0, 2), 10);
    const endH = startH + Math.ceil((durationMin || 150) / 60);
    let worst = 0;
    for (let i = 0; i < hours.length; i++) {
      const t = hours[i];
      if (!String(t).startsWith(date)) continue;
      const h = parseInt(String(t).slice(11, 13), 10);
      if (h < startH || h > endH) continue;
      worst = Math.max(worst, pops[i] || 0);
    }
    return worst;
  } catch { return 0; }
}

async function buildBrief(kind = 'day') {
  const cfg = await loadConfig();
  const today = jdToday(cfg);
  const day = await buildDay(today);
  const index = await loadIndex();
  const active = index.filter((t) => !t.archived);
  const waiting = active.filter(rowAwaitingReply);
  const followups = active.filter((t) => t.followupDue);
  const reminders = active.filter((t) => t.reminderDue);
  const unread = active.reduce((s, t) => s + (t.unread || 0), 0);

  let wx = null, wxLine = '', risky = [];
  try {
    wx = await fetchWeather(kind === 'week' ? 7 : 3);
    const c = wx.current || {};
    wxLine = `${Math.round(c.temperature_2m)}°F, ${WX_TEXT[c.weather_code] || '—'}, ${c.precipitation_probability || 0}% rain, ${Math.round(c.wind_speed_10m || 0)} mph wind`;
    for (const j of day.jobs) {
      const risk = jobRainRisk(wx, today, j.slot, j.durationMin);
      if (risk >= 45) risky.push({ id: j.id, name: j.name, slot: j.slot, risk });
      j.rainRisk = risk;
    }
  } catch { /* the brief is still useful without weather */ }

  // Yesterday's money + this month so far.
  const yest = localDateStr(Date.now() - 86400000, cfg.tz);
  const mdoc = await loadMonth(today.slice(0, 7));
  const ydoc = yest.slice(0, 7) === today.slice(0, 7) ? mdoc : await loadMonth(yest.slice(0, 7));
  const yEntries = (ydoc.entries || []).filter((e) => e.date === yest);
  const yGross = jdMoney(yEntries.filter((e) => e.type === 'job').reduce((s, e) => s + e.amount, 0));
  const month = summarizeMonth(mdoc.entries || []);
  const invoices = (await loadInvoices()).filter((i) => i.status === 'open');
  const owedTotal = jdMoney(invoices.reduce((s, i) => s + i.amount, 0));

  const first = day.jobs.find((j) => j.state !== 'done' && j.state !== 'skipped');
  const priority = waiting.length
    ? `Reply to ${waiting[0].name || waiting[0].phone} — they've been waiting${waiting[0].lastTs ? ' since ' + new Date(waiting[0].lastTs).toLocaleString('en-US', { timeZone: cfg.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}.`
    : first ? `First stop: ${first.name || 'your ' + (first.slot || 'morning') + ' job'}${first.slot ? ' at ' + bkFmt12(first.slot) : ''}${first.city ? ' in ' + first.city : ''}.`
      : followups.length ? `${followups.length} follow-up${followups.length > 1 ? 's are' : ' is'} ready to send.`
        : invoices.length ? `Chase $${owedTotal} still owed across ${invoices.length} invoice${invoices.length > 1 ? 's' : ''}.`
          : 'Nothing on the board — good day to chase rebooks.';

  return {
    date: today, tz: cfg.tz,
    jobs: day.jobs.map((j) => ({ id: j.id, name: j.name, slot: j.slot, city: j.city, service: j.service, price: j.price, state: j.state, rainRisk: j.rainRisk || 0 })),
    summary: day.summary,
    weather: wx ? { line: wxLine, current: wx.current, daily: wx.daily } : null,
    risky,
    waiting: waiting.slice(0, 6).map((t) => ({ phone: t.phone, name: t.name || '', lastBody: t.lastBody, lastTs: t.lastTs })),
    counts: { unread, waiting: waiting.length, followups: followups.length, reminders: reminders.length },
    money: { yesterday: yGross, monthNet: month.net, monthGross: month.gross, monthJobs: month.jobs, owed: owedTotal, openInvoices: invoices.length },
    priority,
  };
}

function briefText(b) {
  const L = [];
  L.push(`☀️ Good morning Mikey — ${new Date(b.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}`);
  L.push('');
  L.push(`FIRST THING: ${b.priority}`);
  L.push('');
  if (b.jobs.length) {
    L.push(`TODAY — ${b.jobs.length} job${b.jobs.length > 1 ? 's' : ''}, $${b.summary.booked} booked`);
    for (const j of b.jobs) {
      L.push(`  ${j.slot ? bkFmt12(j.slot) : '—'}  ${j.name || 'Job'}${j.city ? ' · ' + j.city : ''}${j.price ? ' · $' + j.price : ''}${j.rainRisk >= 45 ? `  ⚠ ${j.rainRisk}% rain` : ''}`);
    }
  } else {
    L.push('TODAY — nothing booked.');
  }
  L.push('');
  if (b.weather) L.push(`WEATHER: ${b.weather.line}`);
  if (b.risky.length) L.push(`⚠ Rain risk on ${b.risky.length} job${b.risky.length > 1 ? 's' : ''} — consider a heads-up text.`);
  L.push('');
  L.push(`INBOX: ${b.counts.waiting} waiting on you · ${b.counts.followups} follow-ups ready · ${b.counts.unread} unread`);
  for (const w of b.waiting.slice(0, 3)) L.push(`  • ${w.name || w.phone}: ${String(w.lastBody || '').slice(0, 70)}`);
  L.push('');
  L.push(`MONEY: $${b.money.yesterday} yesterday · $${b.money.monthNet} net this month (${b.money.monthJobs} jobs)` +
    (b.money.openInvoices ? ` · $${b.money.owed} still owed` : ''));
  L.push('');
  L.push('Open your dashboard to run the day.');
  return L.join('\n');
}

async function apiBrief(url) {
  const kind = url.searchParams.get('kind') === 'week' ? 'week' : 'day';
  const b = await buildBrief(kind);
  return json({ ok: true, brief: b, text: briefText(b) });
}

// Cron hook. Exactly one KV write a day (the "already sent" stamp), and only
// inside the 6–9am local window so a cold start at 3am never fires it early.
async function maybeDailyBrief() {
  const cfg = await loadConfig();
  if (cfg.dailyEmailsPaused) return;   // both daily mails paused — see defaultConfig()
  if (cfg.briefEnabled === false) return;
  const now = Date.now();
  const today = localDateStr(now, cfg.tz);
  const hour = Number(new Date(now).toLocaleString('en-US', { timeZone: cfg.tz, hour: 'numeric', hour12: false }));
  const target = Math.max(4, Math.min(11, Number(cfg.briefHour) || 6));
  if (hour < target || hour > target + 3) return;
  const stamp = await kv().get('brief:last');
  if (stamp === today) return;
  await kv().put('brief:last', today, { expirationTtl: 3 * 86400 });   // ⚠ 1 write/day
  try {
    const b = await buildBrief('day');
    await notifyMikey(`☀️ Your day — ${b.jobs.length} job${b.jobs.length === 1 ? '' : 's'}, ${b.counts.waiting} waiting`, briefText(b));
  } catch { /* never let the brief break the cron */ }
  await pushNotify().catch(() => {});
}

// Sunday-evening recap. The weekly brief already existed (buildBrief('week'))
// and was only reachable by asking for it — nothing ever sent it. Same shape as
// the daily one: a 3-hour window so a cold start can't fire it early, and exactly
// one KV write a week.
async function maybeWeeklyRecap() {
  const cfg = await loadConfig();
  if (cfg.weeklyRecapEnabled === false) return;
  const now = Date.now();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, weekday: 'short', hour: 'numeric', hour12: false })
    .formatToParts(new Date(now));
  const dow = (parts.find((p) => p.type === 'weekday') || {}).value;
  const hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
  if (dow !== 'Sun') return;
  const target = Math.max(8, Math.min(21, Number(cfg.weeklyRecapHour) || 18));
  if (hour < target || hour > target + 2) return;
  const week = localDateStr(now, cfg.tz);
  const stamp = await kv().get('recap:last');
  if (stamp === week) return;
  await kv().put('recap:last', week, { expirationTtl: 14 * 86400 });   // ⚠ 1 write/week
  try {
    const b = await buildBrief('week');
    await notifyMikey(
      `🗓️ Week ahead — ${b.counts.waiting} waiting, ${b.counts.followups} follow-up${b.counts.followups === 1 ? '' : 's'} due`,
      briefText(b));
  } catch { /* never let the recap break the cron */ }
  await pushNotify().catch(() => {});
}

// Nudge open invoices once, after the configured grace period. Only writes when
// something is actually due, so quiet days cost nothing.
async function maybePayReminders() {
  const pcfg = await loadPayConfig();
  if (!pcfg.remindDays) return;
  const list = await loadInvoices();
  const now = Date.now(), cut = pcfg.remindDays * 86400000;
  const due = list.filter((i) => i.status === 'open' && !i.remindedAt && (now - i.createdAt) > cut);
  if (!due.length) return;
  for (const inv of due.slice(0, 5)) {
    const first = jdFirst(inv.name);
    const body = `${first ? 'Hey ' + first : 'Hey'} — just circling back on the $${inv.amount} for ${inv.memo}. Quick link: ${inv.url} Thanks! - Mikey`;
    try {
      await sendSms(inv.phone, body);
      await appendMessage(inv.phone, { dir: 'out', body, kind: 'pay', status: 'sent' }, { name: inv.name });
      inv.remindedAt = now;
    } catch { inv.remindedAt = now; /* don't retry a number that refuses */ }
  }
  await saveInvoices(list);
}

// ===========================================================================
// 11 · APPOINTMENT AUTO-DETECT — the job you never wrote down
// ===========================================================================
// Everything else in the Job Day suite assumes a job already exists: a booking
// came through the site, or Mikey typed it onto the board. In practice most
// jobs get agreed inside a normal text conversation and then live only in his
// head. This watches for that moment.
//
// It never books anything. A detection becomes a CARD; a tap turns it into a
// real job on the day board (and sets thread.appointmentAt, which buildDay and
// the reminder cadences already read). Cancels and reschedules raise cards too
// — the AI is never allowed to move or kill a job on its own.
//
// KV: one det:index value. A detection is 1 write; a message with no date in it
// is 0 writes and 0 AI calls (see the regex prefilter below).
// ===========================================================================
const DET_KEY = 'det:index';

async function loadDetections() { return (await kv().get(DET_KEY, { type: 'json' })) || []; }
// ⚠ KV WRITE — rewrites all open detections. Called once per detection, never in a loop.
async function saveDetections(list) { await kv().put(DET_KEY, JSON.stringify(list.slice(0, 60))); }

function detDefaults() {
  return {
    enabled: true,      // master switch for detection
    eager: true,        // fire on a bare day name with no time ("saturday works")
    holdSlots: true,    // an un-confirmed detection still blocks the booking page
    defaultDurationMin: 180,
  };
}
function detCfg(cfg) { return Object.assign(detDefaults(), (cfg && cfg.detect) || {}); }
function sanitizeDetect(input, current) {
  const d = Object.assign(detDefaults(), current || {});
  const i = input || {};
  ['enabled', 'eager', 'holdSlots'].forEach((k) => { if (typeof i[k] === 'boolean') d[k] = i[k]; });
  if (i.defaultDurationMin != null && !isNaN(+i.defaultDurationMin))
    d.defaultDurationMin = Math.max(15, Math.min(720, Math.round(+i.defaultDurationMin)));
  return d;
}

// --- Stage 1: the free prefilter ------------------------------------------
// Kills the ~95% of messages that mention no day and no time ("how much for an
// SUV?", "sounds good") before we ever pay for an AI call. Note the \w* on the
// cancel stems: "reschedule" and "cancelled" have no word boundary right after
// the stem, so a trailing \b there would never match them.
const DET_DAY_RE = /\b(mon|tue|tues|wed|weds|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?\b|\b(today|tonight|tomorrow|tmrw|tmw)\b|\bnext\s+(week|mon|tue|wed|thu|fri|sat|sun)/i;
const DET_MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{1,2}\b|\b\d{1,2}\s*\/\s*\d{1,2}\b/i;
const DET_TIME_RE = /\b\d{1,2}\s*(:\s*\d{2})?\s*(am|pm|a\.m\.|p\.m\.)\b|\b\d{1,2}:\d{2}\b|\b(noon|midnight|morning|afternoon|evening)\b|\bat\s+\d{1,2}\b/i;
const DET_CANCEL_RE = /\b(cancel|reschedul|resched|postpon)\w*|\bpush (it )?back\b|\bmove it\b|\brain ?check\b|\bcan'?t make it\b|\bcant make it\b|\bsomething came up\b|\b(another|different) day\b/i;

function detLooksSchedulish(text, eager) {
  const t = String(text || '');
  if (!t) return false;
  if (DET_CANCEL_RE.test(t)) return true;
  const hasDay = DET_DAY_RE.test(t) || DET_MONTH_RE.test(t);
  const hasTime = DET_TIME_RE.test(t);
  if (hasDay && (eager || hasTime)) return true;
  // "see you at 9" — a time plus a committing verb, with no day named.
  return hasTime && /\b(see you|works|good|ok|okay|book|schedule|come|be there|available|free|set|lock)\b/i.test(t);
}

// Runs once per message, straight after it lands. Best-effort throughout:
// detection must never break sending or receiving a text.
async function maybeDetectJob(phone) {
  try {
    if (envFlag('DETECT_DISABLED')) return;          // no-KV-write kill switch
    if (!ENV.GEMINI_API_KEY) return;
    const cfg = await loadConfig();
    const dc = detCfg(cfg);
    if (!dc.enabled) return;
    const thread = await loadThread(phone);
    const msgs = (thread.messages || []).filter((m) => m.body);
    const last = msgs[msgs.length - 1];
    if (!last || !detLooksSchedulish(last.body, dc.eager)) return;
    const found = await detAskAi(thread, msgs.slice(-14), cfg);
    if (found) await detApply(thread, found, dc, cfg);
  } catch { /* never let detection break a message */ }
}

async function detAskAi(thread, msgs, cfg) {
  const now = Date.now();
  const tz = cfg.tz || 'America/Los_Angeles';
  const todayStr = localDateStr(now, tz);
  const dow = new Date(now).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const nowHm = localTimeHm(now, tz);
  const convo = msgs.map((m) =>
    `[${localDateStr(m.ts, tz)} ${localTimeHm(m.ts, tz)}] ${m.dir === 'in' ? 'CUSTOMER' : 'MIKEY'}: ${jdStr(m.body, 400)}`).join('\n');

  const prompt =
    `You read text conversations for a mobile car-detailing business and pull out scheduled jobs.\n` +
    `RIGHT NOW it is ${dow}, ${todayStr}, ${nowHm} Pacific.\n` +
    `Resolve every relative date ("tomorrow", "this Saturday", "next week") against that.\n\n` +
    (thread.name ? `Name on file: ${thread.name}\n` : '') +
    (thread.notes ? `Notes on file: ${jdStr(thread.notes, 400)}\n` : '') +
    `\nCONVERSATION (most recent last):\n${convo}\n\n` +
    `Reply with ONLY this JSON:\n` +
    `{"intent":"set|reschedule|cancel|none",\n` +
    ` "date":"YYYY-MM-DD or empty","time":"HH:MM 24-hour, or empty if no specific time was given",\n` +
    ` "tentative":true if the day is agreed but the exact hour is NOT pinned down,\n` +
    ` "customerConfirmed":true only if the CUSTOMER clearly agreed to this day/time,\n` +
    ` "service":"","vehicle":"","address":"","city":"","price":0,"name":"",\n` +
    ` "notes":"gate code, parking, apartment number, pets, water/power access",\n` +
    ` "confidence":0.0-1.0,"evidence":"the exact short quote showing the date was agreed"}\n\n` +
    `RULES:\n` +
    `- "set" ONLY when a real appointment day is agreed. A question ("what days are you open?"), ` +
    `a quote with no date, or small talk is "none".\n` +
    `- "reschedule" when an EXISTING job is moving; put the NEW date/time in date/time.\n` +
    `- "cancel" when it's called off with no replacement date.\n` +
    `- Never invent a date nobody said. A date in the past means you resolved it wrong.\n` +
    `- Below 0.45 confidence, answer "none".`;

  let o;
  try { o = JSON.parse(await geminiGenerate(prompt, { surface: 'appointment detect', json: true, temperature: 0.1, maxTokens: 700 })); }
  catch { return null; }
  if (!o || !o.intent || o.intent === 'none') return null;
  if (Number(o.confidence || 0) < 0.45) return null;
  if (o.intent === 'cancel') return { intent: 'cancel', evidence: jdStr(o.evidence, 200), confidence: Number(o.confidence) };

  const date = jdStr(o.date, 12);
  if (!jdIsDate(date)) return null;
  const tentative = !!o.tentative || !/^\d{1,2}:\d{2}$/.test(jdStr(o.time, 6));
  const slot = tentative ? '09:00' : jdStr(o.time, 5).padStart(5, '0');
  const at = bkLaEpoch(date, slot);
  if (!at || isNaN(at)) return null;
  if (at < now - 12 * 3600000 || at > now + 400 * 86400000) return null;   // model got the year/day wrong

  return {
    intent: o.intent === 'reschedule' ? 'reschedule' : 'set',
    date, slot, at, tentative,
    customerConfirmed: !!o.customerConfirmed,
    service: jdStr(o.service, 60), vehicle: jdStr(o.vehicle, 60),
    address: jdStr(o.address, 140), city: jdStr(o.city, 60),
    price: jdMoney(o.price), name: jdStr(o.name, 60), notes: jdStr(o.notes, 300),
    confidence: Number(o.confidence) || 0, evidence: jdStr(o.evidence, 200),
  };
}

// One open card per customer at a time — a later message about the same job
// updates it in place instead of stacking up a pile of near-duplicates.
async function detApply(thread, f, dc, cfg) {
  const list = await loadDetections();
  const phone = thread.phone;
  const open = list.find((x) => x.phone === phone);

  if (f.intent === 'cancel' || f.intent === 'reschedule') {
    // Only meaningful against a job that already exists. Raise it as a card;
    // cancelling and moving are both on the never-without-a-tap list.
    if (!thread.appointmentAt) return;
    const rec = open || detBlank(phone);
    rec.kind = f.intent;
    rec.currentAt = thread.appointmentAt;
    rec.at = f.intent === 'reschedule' ? f.at : null;
    rec.date = f.date || ''; rec.slot = f.slot || '';
    rec.tentative = !!f.tentative;
    rec.name = thread.name || rec.name;
    rec.evidence = f.evidence; rec.confidence = f.confidence;
    rec.at_ = Date.now();
    if (!open) list.push(rec);
    await saveDetections(list);
    await notifyMikey(
      f.intent === 'cancel' ? `🚫 ${thread.name || phone} may be cancelling` : `🔄 ${thread.name || phone} wants to move`,
      `"${f.evidence}"\n\nNothing has changed. Open Jobs to accept or ignore it.`).catch(() => {});
    await pushNotify().catch(() => {});
    return;
  }

  // Already on the books at that time? Nothing to propose.
  if (thread.appointmentAt && Math.abs(thread.appointmentAt - f.at) < 30 * 60000) return;

  const rec = open || detBlank(phone);
  rec.kind = 'set';
  rec.at = f.at; rec.date = f.date; rec.slot = f.slot;
  rec.tentative = f.tentative;
  rec.customerConfirmed = f.customerConfirmed;
  rec.name = thread.name || f.name || rec.name;
  rec.confidence = f.confidence; rec.evidence = f.evidence;
  rec.at_ = Date.now();
  // Only fill blanks — never clobber something Mikey typed himself.
  if (f.service && !rec.service) rec.service = f.service;
  if (f.vehicle && !rec.vehicle) rec.vehicle = f.vehicle;
  if (f.address && !rec.address) rec.address = f.address;
  if (f.city && !rec.city) rec.city = f.city;
  if (f.price && !rec.price) rec.price = f.price;
  if (f.notes) rec.notes = f.notes;
  if (!rec.durationMin) rec.durationMin = dc.defaultDurationMin;
  if (!open) list.push(rec);
  await saveDetections(list);

  const who = rec.name || phone;
  await notifyMikey(`📅 Looks like you booked ${who} — ${bkNiceDate(rec.date)} at ${bkFmt12(rec.slot)}`,
    [
      `${who} · ${bkNiceDate(rec.date)} at ${bkFmt12(rec.slot)}${rec.tentative ? ' (time not pinned down)' : ''}`,
      rec.service ? `Service: ${rec.service}` : null,
      rec.vehicle ? `Vehicle: ${rec.vehicle}` : null,
      rec.address ? `Where: ${rec.address}${rec.city ? ', ' + rec.city : ''}` : null,
      rec.price ? `Quoted: $${rec.price}` : null,
      '', `From: "${rec.evidence}"`, '',
      `It is NOT on your day yet — open Jobs and tap Yes to add it.`,
    ].filter((x) => x !== null).join('\n')).catch(() => {});
  await pushNotify().catch(() => {});
}

function detBlank(phone) {
  return {
    id: genId(), phone, kind: 'set', name: '', at: null, date: '', slot: '',
    tentative: false, customerConfirmed: false, currentAt: null,
    service: '', vehicle: '', address: '', city: '', price: 0, notes: '',
    durationMin: 0, confidence: 0, evidence: '', at_: Date.now(),
  };
}

// Dates that a still-unconfirmed detection is holding, so the public booking
// page can't sell a slot Mikey already promised in a conversation. A loose
// "Saturday morning" holds the whole day, because he can't honour a stranger's
// 10am inside a window he already gave away.
async function detHeldSlots(date) {
  try {
    const cfg = await loadConfig();
    if (!detCfg(cfg).holdSlots) return null;
    const list = (await loadDetections()).filter((x) => x.kind === 'set' && x.date === date);
    if (!list.length) return [];
    if (list.some((x) => x.tentative)) return 'all';
    return list.map((x) => ({ s: bkHm2min(x.slot), e: bkHm2min(x.slot) + (x.durationMin || 180) }));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiDetections() {
  const cfg = await loadConfig();
  const list = (await loadDetections()).sort((a, b) => (a.at || a.currentAt || 0) - (b.at || b.currentAt || 0));
  return json({ ok: true, detections: list, config: detCfg(cfg) });
}

async function apiDetectionAction(request) {
  const d = await readJson(request);
  const action = jdStr(d.action, 20);
  const list = await loadDetections();
  const i = list.findIndex((x) => x.id === jdStr(d.id, 40));
  if (i < 0) return json({ ok: false, error: 'not_found' }, 404);
  const rec = list[i];
  const cfg = await loadConfig();

  if (action === 'dismiss') {
    list.splice(i, 1);
    await saveDetections(list);
    return json({ ok: true });
  }

  if (action === 'edit') {
    if (jdIsDate(d.date)) rec.date = d.date;
    if (/^\d{2}:\d{2}$/.test(String(d.slot || ''))) { rec.slot = d.slot; rec.tentative = false; }
    ['name', 'service', 'vehicle', 'address', 'city', 'notes'].forEach((k) => {
      if (typeof d[k] === 'string') rec[k] = jdStr(d[k], k === 'address' ? 140 : k === 'notes' ? 300 : 60);
    });
    if (d.price != null) rec.price = jdMoney(d.price);
    if (d.durationMin != null) rec.durationMin = Math.max(15, Math.min(720, Number(d.durationMin) || 180));
    rec.at = bkLaEpoch(rec.date, rec.slot);
    await saveDetections(list);
    return json({ ok: true, detection: rec });
  }

  if (action === 'confirm') {
    // Two things happen, both of which the rest of the app already understands:
    // the job goes on the day board, and the conversation gets its appointment.
    const date = rec.date;
    const doc = await loadDay(date);
    const job = {
      id: 'm:' + genId(),
      name: rec.name, phone: rec.phone,
      address: rec.address, city: rec.city,
      service: rec.service, size: '', vehicle: rec.vehicle,
      slot: rec.slot, durationMin: rec.durationMin || 180,
      price: jdMoney(rec.price), notes: rec.notes,
    };
    if (doc.manual.length >= 40) return json({ ok: false, error: 'day_full' }, 422);
    doc.manual.push(job);
    await saveDay(doc);

    const thread = await loadThread(rec.phone);
    thread.appointmentAt = rec.at;
    thread.dateRequest = null;
    if (!thread.name && rec.name) thread.name = rec.name;
    await saveThread(thread);
    await updateIndexEntry(thread);

    list.splice(i, 1);
    await saveDetections(list);
    return json({ ok: true, date, day: await buildDay(date), draft: await detConfirmDraft(rec, cfg) });
  }

  if (action === 'accept') {
    // Accept a proposed move or cancel against the existing appointment.
    const thread = await loadThread(rec.phone);
    if (rec.kind === 'cancel') {
      thread.appointmentAt = null;
    } else if (rec.kind === 'reschedule' && rec.at) {
      thread.appointmentAt = rec.at;
    }
    await saveThread(thread);
    await updateIndexEntry(thread);
    list.splice(i, 1);
    await saveDetections(list);
    return json({ ok: true, moved: rec.kind === 'reschedule' ? rec.at : null });
  }

  if (action === 'draft') return json({ ok: true, draft: await detConfirmDraft(rec, cfg, jdStr(d.kind, 12)) });

  return json({ ok: false, error: 'bad_action' }, 422);
}

// The text Mikey taps to send after confirming. AI-written in his voice when
// Gemini is available, with a solid template fallback — and never auto-sent.
async function detConfirmDraft(rec, cfg, kind) {
  const first = jdFirst(rec.name) || 'there';
  const when = `${bkNiceDate(rec.date)} at ${bkFmt12(rec.slot)}`;
  const tpl = rec.tentative || kind === 'pin'
    ? `Hey ${first}! Looking forward to ${bkNiceDate(rec.date)}. What time works best for you — morning or afternoon? I'll lock it in. - Mikey`
    : `Hey ${first}, you're all set for ${when}${rec.service ? ` — ${rec.service}` : ''}. ` +
      `${rec.address ? `I'll come to you at ${rec.address}. ` : ''}Just have the car accessible with water & power within about 20 ft. ` +
      `I'll text you when I'm on my way. - Mikey`;
  if (!ENV.GEMINI_API_KEY) return tpl;
  try {
    const out = await geminiGenerate(
      `You are Mikey, owner of Mikey's Mobile Detailing. Write ONE short, warm, professional text to a customer.\n` +
      `Goal: ${rec.tentative || kind === 'pin' ? 'ask what exact time works that day so it can be pinned down' : 'confirm the appointment is locked in'}.\n` +
      `Customer: ${first}. When: ${when}.${rec.service ? ` Service: ${rec.service}.` : ''}${rec.address ? ` Address: ${rec.address}.` : ''}\n` +
      ((cfg.playbook && cfg.playbook.rules) ? `Rules you follow:\n${jdStr(cfg.playbook.rules, 600)}\n` : '') +
      `Never invent a price. Sign off "- Mikey". 2 sentences max. Return only the message text.`,
      { surface: 'appointment draft', temperature: 0.5, maxTokens: 220 });
    const clean = jdStr(out, 600);
    // Only trust it if it reads like a sentence; a stray JSON blob falls back.
    if (clean.length < 15 || !/[a-z]{3}/i.test(clean) || /^[[{]/.test(clean)) return tpl;
    return clean;
  } catch { return tpl; }
}

// ===========================================================================
// Kept promises  ("I'll get back to you Monday")
// ===========================================================================
// The most expensive thing this business loses isn't a lead that never wrote in
// — it's the one Mikey personally told he'd follow up with, and then didn't. It
// happens mid-job, with wet hands, and the promise lives nowhere but in a text
// he sent two days ago.
//
// So: every text HE sends is read for a promise to come back to someone. When
// one is found, three things happen at once — a record he can see in the app, an
// email with a real calendar invite attached so the reminder lives in the
// calendar he actually looks at, and a nudge at the promised time.
//
// Design rules, learned from the appointment detector next door:
//   - a free regex kills every message with no promise-shaped words in it BEFORE
//     any AI call, so the common case costs nothing;
//   - nothing is ever texted to a customer from here — a promise only ever
//     produces a reminder to Mikey;
//   - the whole feature is one KV doc (`promises`), so the minute cron checks
//     every promise with a single read and writes only when one comes due.
// ===========================================================================
const PROM_KEY = 'promises';
async function loadPromises() { return (await kv().get(PROM_KEY, { type: 'json' })) || []; }
// ⚠ KV WRITE — rewrites the whole list. Called on a detection or an action,
// and at most once per cron tick (batched), never inside a per-thread loop.
async function savePromises(list) {
  const keep = list
    .slice()
    .sort((a, b) => (b.madeAt || 0) - (a.madeAt || 0))
    // Closed promises are kept for a week so "you already handled this" is
    // visible in the app, then dropped — this doc must never grow forever.
    .filter((p) => p.status === 'open' || (Date.now() - (p.closedAt || p.madeAt || 0)) < 7 * 86400000)
    .slice(0, 80);
  await kv().put(PROM_KEY, JSON.stringify(keep));
  return keep;
}

function promDefaults() {
  return {
    enabled: true,       // master switch for promise detection
    emailEach: true,     // email + calendar invite the moment a promise is made
    defaultHours: 24,    // when he promised no time ("I'll let you know"), how long to give it
    scanDepth: 3,        // how many recent messages a catch-up scan reads per conversation
  };
}
function promCfg(cfg) { return Object.assign(promDefaults(), (cfg && cfg.promise) || {}); }
function sanitizePromiseCfg(input, current) {
  const d = Object.assign(promDefaults(), current || {});
  if (typeof input.enabled === 'boolean') d.enabled = input.enabled;
  if (typeof input.emailEach === 'boolean') d.emailEach = input.emailEach;
  if (input.defaultHours != null && !isNaN(+input.defaultHours)) d.defaultHours = Math.max(1, Math.min(168, Math.round(+input.defaultHours)));
  if (input.scanDepth != null && !isNaN(+input.scanDepth)) d.scanDepth = Math.max(1, Math.min(10, Math.round(+input.scanDepth)));
  return d;
}

// The free gate. Two halves have to BOTH appear: him committing ("I'll", "let me")
// and the coming-back-to-you verb. That keeps "I'll be there at 9" (an
// appointment, which the job detector already owns) out of here, while catching
// the real thing in all the ways he actually types it.
const PROM_ME_RE = /\b(i'?l+|i will|imma|gon+a|gunna|i am going to|i'?m going to|let me|gimme|give me)\b/i;
const PROM_ACT_RE = /\b(follow(?:ing)? up|follow back|get back|getting back|circle back|touch base|keep (?:you|ya) posted|keep in touch|let (?:you|ya) know|reach out|check (?:on|with|in|back|that|it|my|the)|look into|look at (?:my|the|it)|see what i can do|figure (?:it|that) out|find out|confirm|double ?check|update (?:you|ya)|call (?:you|ya)|text (?:you|ya)|shoot (?:you|ya) a|send (?:you|ya) (?:a|the|over)|work on (?:it|that|getting)|price (?:it|that) out|put (?:you|ya) down)\b/i;
function promLooksLikePromise(text) {
  const t = String(text || '');
  if (t.length < 6) return false;
  if (!PROM_ME_RE.test(t)) return false;
  return PROM_ACT_RE.test(t);
}

// Ask the AI what was promised and by when. Returns null for anything that isn't
// a real commitment, so the expensive half of this feature is also the rare half.
async function promAskAi(thread, msgs, target, cfg) {
  const tz = cfg.tz || 'America/Los_Angeles';
  const now = Date.now();
  const dow = new Date(now).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
  const convo = msgs.map((m) =>
    `[${localDateStr(m.ts, tz)} ${localTimeHm(m.ts, tz)}] ${m.dir === 'in' ? 'CUSTOMER' : 'MIKEY'}: ${jdStr(m.body, 400)}`).join('\n');
  const prompt =
    `You read text conversations for a mobile car-detailing business owner (Mikey) and find the ` +
    `promises HE made to get back to a customer, so he can be reminded.\n` +
    `RIGHT NOW it is ${dow}, ${localDateStr(now, tz)}, ${localTimeHm(now, tz)} Pacific. ` +
    `Resolve every relative time ("tonight", "tomorrow", "Monday", "in a couple hours") against that.\n\n` +
    `CONVERSATION (most recent last):\n${convo}\n\n` +
    `THE MESSAGE TO JUDGE is Mikey's: "${jdStr(target.body, 400)}"\n\n` +
    `Reply with ONLY this JSON:\n` +
    `{"promise":true|false,\n` +
    ` "what":"what he owes them, in under 12 words, written to him ('send Desiree the Ram quote')",\n` +
    ` "date":"YYYY-MM-DD or empty if he named no day","time":"HH:MM 24-hour or empty if he named no time",\n` +
    ` "vague":true if he committed but named no time at all ("I'll let you know"),\n` +
    ` "quote":"his exact words that made the promise, verbatim, max 120 chars",\n` +
    ` "confidence":0.0-1.0}\n\n` +
    `RULES:\n` +
    `- A promise is Mikey owing the customer a FUTURE message or answer: a price he'll work out, ` +
    `an availability he'll check, a call he'll make, news he'll pass on.\n` +
    `- "promise":false for: an appointment time already agreed (that is not a promise to follow up), ` +
    `"I'll see you Saturday", "I'll be there at 9", "I'll text you when I'm on my way" about a job ` +
    `that is already booked, pleasantries ("let me know if you need anything"), ` +
    `anything the CUSTOMER said, and anything he has already answered later in this conversation.\n` +
    `- Only fill date/time with what he actually said. Never invent one.\n` +
    `- Below 0.55 confidence, answer "promise":false.`;
  let o;
  try { o = JSON.parse(await geminiGenerate(prompt, { surface: 'promise catch', json: true, temperature: 0.1, maxTokens: 400 })); }
  catch { return null; }
  if (!o || o.promise !== true) return null;
  if (Number(o.confidence || 0) < 0.55) return null;
  const what = jdStr(o.what, 120);
  const quote = jdStr(o.quote, 160) || jdStr(target.body, 160);
  const dueAt = promDueAt(o, cfg, target.ts || now);
  if (!dueAt) return null;
  return { what, quote, dueAt, vague: !!o.vague, confidence: Number(o.confidence) || 0 };
}

// Turn what he said into a moment to be reminded at.
//   "Monday at 9"      -> that
//   "Monday"           -> that morning at 9
//   "I'll let you know" -> defaultHours later, pulled into working hours
// Anything that lands in the past or absurdly far out is treated as no date at
// all rather than trusted — a reminder at the wrong time is worse than a default.
function promDueAt(o, cfg, madeAt) {
  const pc = promCfg(cfg);
  const now = Date.now();
  const date = jdStr(o && o.date, 12);
  const time = jdStr(o && o.time, 6);
  if (jdIsDate(date)) {
    const slot = /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '09:00';
    const at = bkLaEpoch(date, slot);
    if (at && !isNaN(at) && at > now - 3600000 && at < now + 400 * 86400000) return at;
  }
  return promWorkHours((madeAt || now) + pc.defaultHours * 3600000, cfg);
}

// Nudge a reminder into a time he'd actually act on it: before 8am local becomes
// 8am, after 7pm becomes 8am the next morning. A 2am buzz gets ignored, and an
// ignored reminder is the same as no reminder.
function promWorkHours(at, cfg) {
  const tz = (cfg && cfg.tz) || 'America/Los_Angeles';
  const hm = localTimeHm(at, tz);
  const hour = Number(String(hm).slice(0, 2));
  if (hour >= 8 && hour < 19) return at;
  const day = localDateStr(hour >= 19 ? at + 86400000 : at, tz);
  const moved = bkLaEpoch(day, '08:00');
  return (moved && !isNaN(moved)) ? moved : at;
}

// ---------------------------------------------------------------------------
// The calendar invite
// ---------------------------------------------------------------------------
// A reminder that lives only in this app is a reminder he has to remember to
// come looking for. So every promise ships as a real .ics file — one tap on the
// phone and it's in the calendar he already checks — plus a Google Calendar link
// for when tapping the attachment is more work than tapping a button.
function icsEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

// One VEVENT, 15 minutes long, with an alarm at the start. METHOD:PUBLISH on
// purpose: an invite (METHOD:REQUEST) from a sender that isn't his own calendar
// address gets treated as someone else's meeting, which is not what this is.
function promIcs(rec) {
  const start = rec.dueAt;
  const uid = `promise-${rec.id}@mikeys-dashboard`;
  const title = `Follow up with ${rec.name || rec.phone}`;
  const base = publicBase();
  const desc = [
    rec.what ? `You owe them: ${rec.what}` : '',
    rec.quote ? `You said: "${rec.quote}"` : '',
    base ? `Open the conversation: ${base}/?c=${rec.phone}` : '',
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mikeys Dashboard//Promises//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(start + 15 * 60000)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    'BEGIN:VALARM',
    'TRIGGER:PT0M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// "Add to Google Calendar" — the one-tap path on a phone.
function promGcalUrl(rec) {
  const base = publicBase();
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Follow up with ${rec.name || rec.phone}`,
    dates: `${icsStamp(rec.dueAt)}/${icsStamp(rec.dueAt + 15 * 60000)}`,
    details: [
      rec.what ? `You owe them: ${rec.what}` : '',
      rec.quote ? `You said: "${rec.quote}"` : '',
      base ? `${base}/?c=${rec.phone}` : '',
    ].filter(Boolean).join('\n'),
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// base64 for the .ics attachment. Worker runtime has btoa, but it is byte-wise —
// the quote can carry an emoji or a curly apostrophe, so encode UTF-8 first.
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function promIcsAttachment(rec) {
  return { filename: `follow-up-${(rec.name || rec.phone).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30) || 'customer'}.ics`, content: b64(promIcs(rec)) };
}

function promWhenLabel(at, cfg) {
  const tz = (cfg && cfg.tz) || 'America/Los_Angeles';
  try {
    return new Date(at).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return new Date(at).toISOString().slice(0, 16).replace('T', ' '); }
}

// The "you just promised something" email. Same mail kit as the customer alerts,
// so it reads like the rest of them: his own words loudest, then what happens
// next, then the buttons.
function promMadeEmail(rec, cfg) {
  const when = promWhenLabel(rec.dueAt, cfg);
  const base = publicBase();
  const text =
    `You told ${rec.name || rec.phone}:\n"${rec.quote}"\n\n` +
    (rec.what ? `So you owe them: ${rec.what}\n\n` : '') +
    `⏰ I'll remind you ${when}, and there's a calendar invite attached so it's in your calendar too.\n\n` +
    (base ? `Open the conversation: ${base}/?c=${rec.phone}\n` : '') +
    `Nothing was sent to them — this is just for you.`;
  const B = [];
  B.push(mailCard(
    mailLabel(`You told ${rec.name || rec.phone}`, MAILC.amberInk) + mailShout(rec.quote),
    { bg: MAILC.amberBg, border: '#fde68a', edge: MAILC.amber, pad: '18px' }));
  let plan = mailLabel('So you owe them', MAILC.blue);
  if (rec.what) plan += `<div style="font:600 17px/1.5 ${MAILF};color:${MAILC.ink};">${mailLines(rec.what)}</div>`;
  plan += `<div style="font:400 15px/1.6 ${MAILF};color:${MAILC.mute};margin-top:10px;">⏰ I'll nudge you <b>${htmlEsc(when)}</b>${rec.vague ? ' (you didn\'t say when, so that\'s my default)' : ''}.</div>` +
    `<div style="height:14px;line-height:14px;">&nbsp;</div>` +
    mailBtn(promGcalUrl(rec), '📅  Add to Google Calendar', MAILC.blue) +
    `<div style="font:400 13px/1.6 ${MAILF};color:${MAILC.mute};margin-top:10px;">Not on Google? The <b>.ics</b> attached to this email adds it to any calendar.</div>`;
  B.push(mailCard(plan, { bg: MAILC.blueBg, border: '#bfdbfe', edge: MAILC.blue }));
  if (base) B.push(mailCard(mailBtn(`${base}/?c=${rec.phone}`, 'Open the conversation', MAILC.ink) +
    `<div style="font:400 13px/1.6 ${MAILF};color:${MAILC.mute};margin-top:12px;">Nothing was sent to ${htmlEsc(rec.name || rec.phone)} — this one is just for you.</div>`));
  return { text, html: mailShell(rec.quote, B.join('')) };
}

// The nudge itself, when the promised time arrives.
function promDueEmail(rec, cfg) {
  const base = publicBase();
  const ago = humanAgo(Date.now() - (rec.madeAt || Date.now()));
  const text =
    `You said this to ${rec.name || rec.phone} ${ago} ago:\n"${rec.quote}"\n\n` +
    (rec.what ? `You owe them: ${rec.what}\n\n` : '') +
    (base ? `Open the conversation and answer them: ${base}/?c=${rec.phone}\n` : '');
  const B = [];
  B.push(mailCard(
    mailLabel(`You promised ${rec.name || rec.phone} — ${ago} ago`, MAILC.amberInk) + mailShout(rec.quote),
    { bg: MAILC.amberBg, border: '#fde68a', edge: MAILC.amber, pad: '18px' }));
  if (rec.what) {
    B.push(mailCard(mailLabel('What you owe them', MAILC.blue) +
      `<div style="font:600 17px/1.5 ${MAILF};color:${MAILC.ink};">${mailLines(rec.what)}</div>`,
      { bg: MAILC.blueBg, border: '#bfdbfe', edge: MAILC.blue }));
  }
  if (base) B.push(mailCard(mailBtn(`${base}/?c=${rec.phone}`, 'Open the conversation', MAILC.ink)));
  return { text, html: mailShell(rec.quote, B.join('')) };
}

// ---------------------------------------------------------------------------
// Raising, keeping and clearing promises
// ---------------------------------------------------------------------------
function promBlank(phone) {
  return {
    id: genId(), phone, name: '', quote: '', what: '', dueAt: 0, vague: false,
    madeAt: Date.now(), msgId: '', status: 'open', notified: false, notifiedAt: 0,
    source: 'live', confidence: 0, closedAt: 0, closedBy: '',
  };
}

// A promise he restates ("actually I'll call you tonight") should move the one
// reminder, not stack a second one on the same conversation. Anything already
// closed is left alone so re-opening is always his call.
function promOpenFor(list, phone) {
  return list.filter((p) => p.phone === phone && p.status === 'open')
    .sort((a, b) => (b.madeAt || 0) - (a.madeAt || 0))[0] || null;
}

async function promRaise(thread, found, cfg, source, target) {
  const list = await loadPromises();
  const existing = promOpenFor(list, thread.phone);
  // The same message coming back through a second path (a scan after the live
  // hook already caught it) must never create a duplicate.
  if (existing && target && existing.msgId && existing.msgId === (target.id || '')) return null;
  const rec = existing || promBlank(thread.phone);
  rec.name = thread.name || rec.name;
  rec.quote = found.quote;
  rec.what = found.what;
  rec.dueAt = found.dueAt;
  rec.vague = !!found.vague;
  rec.confidence = found.confidence;
  rec.madeAt = (target && target.ts) || Date.now();
  rec.msgId = (target && target.id) || '';
  rec.source = source;
  rec.status = 'open';
  rec.notified = false;
  rec.notifiedAt = 0;
  if (!existing) list.push(rec);
  await savePromises(list);
  return rec;
}

// Runs after a text HE sent lands. Best-effort throughout: a promise is a bonus,
// and it must never break sending a message.
async function maybePromise(phone) {
  try {
    if (envFlag('PROMISE_DISABLED')) return null;    // no-KV-write kill switch
    if (!ENV.GEMINI_API_KEY) return null;
    const cfg = await loadConfig();
    const pc = promCfg(cfg);
    if (!pc.enabled) return null;
    const thread = await loadThread(phone);
    if (isPracticePhone(thread.phone)) return null;  // the fake customer promises nothing
    const msgs = (thread.messages || []).filter((m) => m.body);
    const target = msgs.filter((m) => m.dir === 'out').slice(-1)[0];
    if (!target || !promLooksLikePromise(target.body)) return null;
    const list = await loadPromises();
    const open = promOpenFor(list, thread.phone);
    if (open && open.msgId && open.msgId === (target.id || '')) return null;   // already tracked
    const found = await promAskAi(thread, msgs.slice(-6), target, cfg);
    if (!found) return null;
    const rec = await promRaise(thread, found, cfg, 'live', target);
    if (rec && pc.emailEach) await promNotifyMade(rec, cfg);
    return rec;
  } catch { return null; }
}

// The email + calendar invite that goes out the moment a promise is made.
async function promNotifyMade(rec, cfg) {
  const mail = promMadeEmail(rec, cfg);
  const when = promWhenLabel(rec.dueAt, cfg);
  await notifyMikey(`📌 You told ${rec.name || rec.phone} you'd follow up — ${when}`, {
    text: mail.text,
    html: mail.html,
    attachments: [promIcsAttachment(rec)],
    // The SMS fallback can't carry an attachment, so it says so rather than
    // pointing at a calendar invite that isn't there.
    sms: `You told ${rec.name || rec.phone}: "${rec.quote}"\n\nI'll remind you ${when}.`,
  }).catch(() => {});
}

// Cron step. One KV read; one write only on a tick where something actually
// changed. Two things happen here: promises that came due get their nudge, and
// promises he has visibly already kept get closed without ever bothering him.
async function dispatchDuePromises(now = Date.now()) {
  const list = await loadPromises();
  if (!list.some((p) => p.status === 'open')) return 0;
  const index = await loadIndex();
  const cfg = await loadConfig();
  let dirty = false, fired = 0;
  for (const p of list) {
    if (p.status !== 'open') continue;
    // Already kept it? He texted them again more than ten minutes after the
    // promise — that gap is what separates "came back to them" from the rest of
    // the same burst of typing. Closed silently: a nudge for something already
    // done is exactly the noise that makes people stop reading reminders.
    const e = index.find((x) => x.phone === p.phone);
    if (e && e.lastDir === 'out' && (e.lastTs || 0) > (p.madeAt || 0) + 600000) {
      p.status = 'done'; p.closedAt = now; p.closedBy = 'texted-again'; dirty = true;
      continue;
    }
    if (p.notified || !(p.dueAt > 0) || p.dueAt > now) continue;
    p.notified = true; p.notifiedAt = now; dirty = true; fired++;
    const mail = promDueEmail(p, cfg);
    notifyMikey(`⏰ You said you'd get back to ${p.name || p.phone}`, {
      text: mail.text, html: mail.html,
      sms: `You told ${p.name || p.phone} you'd follow up: "${p.quote}"${p.what ? '\n\n' + p.what : ''}`,
    }).catch(() => {});
    pushNotify().catch(() => {});
  }
  if (dirty) await savePromises(list);
  return fired;
}

// ---------------------------------------------------------------------------
// The catch-up scan — "did I promise anyone anything and forget?"
// ---------------------------------------------------------------------------
// The live hook only sees messages sent from now on, and promises made before
// this feature existed are exactly the ones most likely to have been dropped. So
// this reads back over the last few messages of each open conversation and finds
// them. Deliberately bounded: it reads at most `depth` messages per conversation
// (3 by default — the last exchange), makes at most one AI call per conversation,
// and stops after `max` of them, so a scan is a known small cost, not a surprise.
async function promScan(opts = {}) {
  const cfg = await loadConfig();
  const pc = promCfg(cfg);
  const depth = Math.max(1, Math.min(10, Math.round(+opts.depth || pc.scanDepth)));
  const maxAi = Math.max(1, Math.min(40, Math.round(+opts.max || 12)));
  const out = { scanned: 0, looked: 0, found: [], asked: 0, depth, limited: false };
  if (!ENV.GEMINI_API_KEY) { out.error = 'ai_not_configured'; return out; }
  const index = (await loadIndex())
    .filter((e) => !e.archived && e.phone && !isPracticePhone(e.phone))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const list = await loadPromises();
  const now = Date.now();
  const raised = [];
  for (const e of index) {
    if (out.asked >= maxAi) { out.limited = true; break; }
    if (promOpenFor(list, e.phone)) continue;             // already tracked
    out.scanned++;
    const thread = await loadThread(e.phone);
    const msgs = (thread.messages || []).filter((m) => m.body);
    const recent = msgs.slice(-depth);
    // Newest first: the most recent promise is the one that still stands.
    const candidates = recent.filter((m) => m.dir === 'out' && promLooksLikePromise(m.body)).reverse();
    if (!candidates.length) continue;
    const target = candidates[0];
    // Already kept? He wrote to them again well after saying it.
    const later = msgs.filter((m) => m.dir === 'out' && (m.ts || 0) > (target.ts || 0) + 600000);
    if (later.length) continue;
    out.looked++;
    out.asked++;
    const found = await promAskAi(thread, msgs.slice(-Math.max(depth, 6)), target, cfg).catch(() => null);
    if (!found) continue;
    // A promise dug out of history is usually already overdue; that is the point,
    // so a past due time is pulled to the next working hour instead of dropped.
    if (found.dueAt < now) found.dueAt = promWorkHours(now + 60000, cfg);
    const rec = await promRaise(thread, found, cfg, 'scan', target);
    if (rec) { raised.push(rec); out.found.push(rec); list.push(rec); }
  }
  if (raised.length) await promNotifyScan(raised, cfg);
  return out;
}

// One email for the whole scan, with a calendar invite attached for each promise
// it turned up — a scan that found four things must not mean four emails.
async function promNotifyScan(recs, cfg) {
  const lines = recs.map((r, i) =>
    `${i + 1}. ${r.name || r.phone} — ${promWhenLabel(r.dueAt, cfg)}\n   You said: "${r.quote}"${r.what ? `\n   You owe them: ${r.what}` : ''}`);
  const base = publicBase();
  const text =
    `I read back through your recent messages and found ${recs.length} promise${recs.length === 1 ? '' : 's'} you made:\n\n` +
    lines.join('\n\n') + '\n\n' +
    `Each one has a calendar invite attached, and I'll nudge you at the time.\n` +
    (base ? `\nOpen the dashboard: ${base}\n` : '');
  const B = [];
  B.push(mailCard(
    mailLabel('Found in your recent messages', MAILC.amberInk) +
    `<div style="font-family:${MAILF};font-size:22px;line-height:1.35;font-weight:800;color:${MAILC.ink};">${recs.length} promise${recs.length === 1 ? '' : 's'} you made and haven't come back to</div>`,
    { bg: MAILC.amberBg, border: '#fde68a', edge: MAILC.amber, pad: '18px' }));
  for (const r of recs) {
    B.push(mailCard(
      mailLabel(`${r.name || r.phone} · ${promWhenLabel(r.dueAt, cfg)}`, MAILC.blue) +
      mailShout(r.quote) +
      (r.what ? `<div style="font:600 15px/1.5 ${MAILF};color:${MAILC.mute};margin-top:10px;">You owe them: ${htmlEsc(r.what)}</div>` : '') +
      `<div style="height:14px;line-height:14px;">&nbsp;</div>` +
      mailBtn(promGcalUrl(r), '📅  Add to Google Calendar', MAILC.blue) +
      (base ? `<div style="height:8px;line-height:8px;">&nbsp;</div>` + mailBtn(`${base}/?c=${r.phone}`, 'Open the conversation', MAILC.card, { fg: MAILC.ink, border: MAILC.line }) : ''),
      { bg: MAILC.blueBg, border: '#bfdbfe', edge: MAILC.blue }));
  }
  await notifyMikey(`📌 ${recs.length} promise${recs.length === 1 ? '' : 's'} you haven't kept yet`, {
    text, html: mailShell(text, B.join('')),
    attachments: recs.slice(0, 8).map(promIcsAttachment),
    sms: `I found ${recs.length} promise${recs.length === 1 ? '' : 's'} you made and haven't come back to: ` +
      recs.map((r) => r.name || r.phone).join(', ') + '. Open the dashboard to see them.',
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiPromises() {
  const list = await loadPromises();
  const cfg = await loadConfig();
  const now = Date.now();
  const promises = list.map((p) => Object.assign({}, p, {
    whenLabel: promWhenLabel(p.dueAt, cfg),
    due: p.status === 'open' && p.dueAt <= now,
    gcal: promGcalUrl(p),
  }));
  return json({ ok: true, promises, config: promCfg(cfg) });
}

async function apiPromiseAction(request) {
  const d = await readJson(request);
  const action = String(d.action || '');
  const list = await loadPromises();
  const rec = list.filter((p) => p.id === d.id)[0];
  if (!rec) return json({ ok: false, error: 'not_found' }, 404);
  const now = Date.now();
  if (action === 'done' || action === 'dismiss') {
    rec.status = action === 'done' ? 'done' : 'dismissed';
    rec.closedAt = now;
    rec.closedBy = 'you';
  } else if (action === 'reopen') {
    rec.status = 'open'; rec.closedAt = 0; rec.closedBy = ''; rec.notified = false;
  } else if (action === 'snooze') {
    const hours = Math.max(1, Math.min(720, Math.round(+d.hours || 24)));
    rec.dueAt = promWorkHours(now + hours * 3600000, await loadConfig());
    rec.notified = false; rec.status = 'open';
  } else if (action === 'at') {
    const at = Number(d.at);
    if (!at || isNaN(at)) return json({ ok: false, error: 'bad_time' }, 422);
    rec.dueAt = at; rec.notified = false; rec.status = 'open';
  } else {
    return json({ ok: false, error: 'bad_action' }, 422);
  }
  await savePromises(list);
  return apiPromises();
}

async function apiPromiseScan(request) {
  const d = await readJson(request);
  const out = await promScan(d || {});
  const listed = await apiPromises();
  const body = await listed.json();
  return json(Object.assign({ ok: !out.error, error: out.error }, body, {
    scan: { scanned: out.scanned, looked: out.looked, asked: out.asked, found: out.found.length, limited: out.limited, depth: out.depth },
  }));
}

// The .ics for one promise, so the dashboard can offer the same one-tap
// "add to my calendar" the email does.
async function apiPromiseIcs(url) {
  const id = String(url.searchParams.get('id') || '');
  const rec = (await loadPromises()).filter((p) => p.id === id)[0];
  if (!rec) return json({ ok: false, error: 'not_found' }, 404);
  return new Response(promIcs(rec), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="follow-up-${(rec.name || rec.phone).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 30) || 'customer'}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}
