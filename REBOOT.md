# REBOOT SCRIPT — Mikey's Detailing Texting Dashboard

> **Read this first if you're a fresh session picking up this project.** It is the
> single source of truth for what this app is, how it's built, and — most
> importantly — **how and where changes actually go live**. If you only read one
> section, read **§2 Deploy model**: getting that wrong makes changes look shipped
> when they aren't.

Last updated at build `2026-07-27·jobday`.

---

## 1. What this is

A single-operator SMS/texting **command center** for **Mikey's Mobile Detailing**
(owner-operated mobile car detailing, Snohomish WA). It runs the business's texting,
calls, leads, follow-ups, and now email — from one mobile-first PWA.

- **Repo:** `mikeygabmiller/twillowdashbored`
- **Live URL:** https://texting.mikeysdetailingsnohomish.workers.dev
- **Platform:** a single **Cloudflare Worker** named **`texting`** (there is a second,
  **unused/old** worker on the account, `mikeys-detailing-sms`, last touched June 2026 —
  ignore it).
- **Stack:** vanilla JS Worker (`src/index.js`) + a single-file vanilla-JS SPA
  (`public/index.html`) served as Cloudflare static assets. No framework, no build step.
- **Storage:** Cloudflare **KV** (binding `MESSAGES`). **No database.**
- **External services:** Twilio (SMS + voice), Google **Gemini** (AI), **Resend** (email
  alerts out). Optional: a Google **Apps Script** feeds Gmail *in* to the Email tab.

The owner (Mikey / user) is non-technical. He values features he can **see and use**,
things that **capture leads / save phone time**, and a **premium "$10k" feel**. He is
*not* excited by back-office features (campaigns/reporting/referrals).

---

## 2. ⚠️ DEPLOY MODEL — how & where changes go live (CRITICAL)

**Cloudflare Workers Builds is connected to this GitHub repo ("Connect to Git").
It auto-deploys ONE branch — the production branch — to the live URL on every push.**

- **PRODUCTION BRANCH = `claude/qqc-submission-auto-text-cspjc3`.**
  Pushing/merging to this branch → Cloudflare builds it → live URL updates. This is the
  ONLY branch that goes live.
- **Any other branch = PREVIEW build only.** Cloudflare still builds it and the worker's
  "version"/`modified_on` still changes, so `workers_get_worker_code` will show your new
  code — **but the live URL keeps serving the last production build.** This mismatch
  burned us once: changes looked deployed for hours but the user saw nothing. **Do not
  trust "I pushed it" or the worker version list. Verify the live URL.**
- **The GitHub DEFAULT branch is STALE and WRONG.** It is `claude/exciting-babbage-up2gi4`
  (tip is an ancient `#2` commit, missing most live features). **Never target it.** PRs
  default to it — always change the base to the production branch.
- **My working branch:** `claude/texting-dashboard-audit-8tspms`. I develop here.

### The exact workflow I follow for EVERY change
1. Edit files on `claude/texting-dashboard-audit-8tspms`.
2. **Bump the build fingerprint** in BOTH files, kept identical (skip only for docs-only
   changes): `const BUILD` in `src/index.js` and `var APP_BUILD` in `public/index.html`.
3. `git add -A && git commit && git push origin claude/texting-dashboard-audit-8tspms`.
4. Open a PR with **base = `claude/qqc-submission-auto-text-cspjc3`**, then merge it
   (GitHub MCP: `create_pull_request` then `merge_pull_request`, method `merge`).
5. **Re-sync my branch to the production tip so they never diverge:**
   `git fetch origin && git merge --ff-only origin/claude/qqc-submission-auto-text-cspjc3
   && git push origin claude/texting-dashboard-audit-8tspms`.
   Confirm `git rev-list --left-right --count origin/claude/qqc-submission-auto-text-cspjc3...HEAD`
   prints `0 0` (identical).
6. **Verify it actually went live** (see §3).

### Verifying a deploy
- The sandbox **cannot fetch the live workers.dev URL** (the agent proxy blocks it —
  `curl` returns proxy 403 / HTTP 000). So you can't self-check the live HTML.
- Use the **Cloudflare MCP** (`workers_list` → `texting.modified_on` moves after a
  production merge; `workers_get_worker_code` to grep the script — but remember this can
  return a *preview* version, so it is NOT proof of production).
- **The real source of truth is the live footer / endpoint**, which the user can read:
  - `GET /api/version` → `{ "build": "<current>" }`
  - Drawer footer shows `app <APP_BUILD> · server <BUILD> ✓ live` (or `⚠ mismatch` if the
    assets and worker script came from different deploys).
- Builds take ~1–3 min. `modified_on` updates when the deploy completes.

`DEPLOY.md` in the repo documents this for humans too.

---

## 3. Architecture

### Worker — `src/index.js` (~2k lines, one file)
- `export default { fetch, scheduled }`. `fetch` → `handle(request)` router.
- Module globals set per-invocation: `ENV` (bindings/secrets), `CFG_CACHE` (per-request
  config cache), `BASE_URL` (origin, for building absolute Twilio callback URLs).
- `const BUILD` near the top is the deploy fingerprint.

### Frontend — `public/index.html` (single file, ~2.6k lines)
- Inline `<style>` + inline `<script>` (one big IIFE). No external JS.
- `var APP_BUILD` must match `BUILD`.
- PWA: `manifest.webmanifest`, `sw.js` (service worker, cache name `mkd-shell-vN` — bump N
  to force installed clients to refresh; currently `v4`). SW is **network-first for
  navigations** so online users get fresh HTML, but installed home-screen PWAs cache the
  shell and may need a reopen/reinstall after a deploy.
- Served by Cloudflare's asset layer (`[assets] directory = "./public"` in wrangler.toml).

### Storage — Cloudflare KV, binding `MESSAGES`
Keys:
- `threads-index` — array of lightweight per-conversation summaries (name, status, last
  message, unread, followupDue, optedOut, reminderAt/Due/Note, scheduledCount, etc.). This
  is what the list/Home/badges read. **Hot object, read-modify-write** — a known race risk
  at scale (audit item SCALE-01: migrate to D1 eventually).
- `thread:<E164phone>` — full conversation: `{ phone, name, tags, status, statusAt, notes,
  pinned, archived, unread, appointmentAt, reminderAt, reminderNote, reminderNotified,
  assignedTo, linked, messages[], scheduled[], followup{}, createdAt, updatedAt }`.
  Messages: `{ id, dir:'in'|'out', body, ts, kind, media[], sid, status, error }`.
- `config` — the settings/brain doc (see §5).
- `emails` — array (cap ~60) of `{ id, from, fromName, subject, snippet, body, date,
  unread, mid }` for the Email tab.
- `templates` — quick-reply array `[[label, body], …]`.
- `rl:submit:<ip>` — short-TTL submit rate-limit counter.

### ⚠️ KV WRITE BUDGET (free tier ~1,000 writes/day)
Writes are the scarce resource (~0.7/min). The **minute cron touches every conversation**,
so any unnecessary `put()` inside a loop can blow the budget and 429 the whole app until
midnight UTC. Rules (enforced in code, see the big comment block atop `src/index.js`):
never write on a tick where nothing changed; skip idle threads BEFORE loading them; batch
the index to ONE `saveIndex()` per tick. `FOLLOWUPS_DISABLED=1` (a var, no KV write) is the
emergency kill switch for the follow-up engine.

### Cron — every minute (`crons = ["* * * * *"]`)
`scheduled()` → `runCron()`:
1. `dispatchDueScheduled()` — sends due scheduled messages (reserve-then-send = at-most-once).
2. `dispatchDueReminders()` — fires private follow-up reminders (alerts Mikey once).
3. `evaluateFollowups()` — advances the auto follow-up state machine (surfaces nudges,
   auto-sends safe ones on autopilot, respects quiet hours).

---

## 4. Endpoint map

**Public webhooks (no dashboard auth):** `POST /submit` (quote form; honeypot + rate limit),
`POST /sms`, `POST /call`, `POST /call-screen`, `POST /voicemail`, `POST /voicemail-done`,
`POST /voicemail-tx` (transcription), `POST /status` (Twilio delivery callback),
`POST /email-in` (email ingest; token-guarded), `GET /api/version` (build).

**Twilio webhooks are signature-validated** by `verifyTwilio()` — **OFF by default**,
enabled only when var `TWILIO_SIGNATURE_ENFORCE=1` (safe rollout so a deploy can't silently
403 real inbound texts).

**Dashboard API (require auth cookie once `DASHBOARD_PASSWORD` is set):**
`/api/login /logout /health /threads /thread /send /meta /schedule /unschedule /call /read
/insights /media /media-backfill /emails /email-read /email-setup /alert-test /followups
/followup /config /block /migrate /templates /ai/summary /ai/draft /ai/triage /ai/coach
/ai/photo-quote`.

Key ones: `/api/meta` patches thread fields (status, tags, notes, pinned, archived,
assignedTo, appointmentAt, **reminderAt/reminderNote**, linked). `/api/media` is an
auth'd proxy that fetches Twilio media with account creds (Twilio media needs auth, so the
browser can't load it directly; locked to Twilio hosts). `/api/email-setup` generates +
stores the ingest token in `config` and returns the ready-to-use Apps Script params.

---

## 5. Secrets & vars

Set via `wrangler secret put` or the Cloudflare dashboard (Worker → Settings → Variables).
`PUBLIC_BASE_URL` is a plain var in `wrangler.toml`; the rest are secrets/vars.

**Required:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `MIKEY_PHONE`.
**AI:** `GEMINI_API_KEY` (all AI features), `GEMINI_MODEL` (default `gemini-2.5-flash`).
**Email alerts out:** `RESEND_API_KEY`, `ALERT_EMAIL`, `ALERT_FROM` (else falls back to
texting Mikey — costs money).
**Toggles/flags:** `FOLLOWUPS_DISABLED` (kill follow-up cron, no KV write),
`TWILIO_SIGNATURE_ENFORCE` (turn on webhook signature checks), `EMAIL_INGEST_TOKEN`
(optional — the in-app `config.emailToken` is preferred so no Cloudflare secret is needed),
`DASHBOARD_PASSWORD` (dashboard PIN/password gate), `PUBLIC_BASE_URL` (var).

`config` (KV) holds the non-secret settings/brain: `followupsEnabled, autopilot, reviewUrl,
rebookDays, quietStart/End, tz, callScreening, missedCallTextback, missedCallText,
autoReplyAlert, blockedNumbers[], optedOut[], emailToken, teamMode, team[],
playbook{about,services,area,booking,tone,faqs,rules}`. The **playbook** grounds every
AI output. `autoReplyAlert` (default on) texts Mikey when the quote-form auto-reply
actually reaches the customer ~3.5 min after they submit — see `dispatchDueScheduled`,
which acts on the `alertOnSend` flag both `/submit` and `/qqc-text` put on the queued
reach-out.

---

## 6. Completed work (all LIVE at build `·m`)

**Security/trust:** SEC-01 Twilio signature validation (opt-in) + honeypot + per-IP rate
limit on `/submit`; SEC-02 STOP/START opt-out ledger, `sendSms` refuses opted-out numbers,
`/status` delivery tracking + failure alerts.
**Lead capture:** #1 missed-call instant text-back (opt-out aware, throttled, toggleable).
**Reliability:** outbound messages capture Twilio SID + status; scheduled/auto-followup
failures alert instead of failing silently.
**UI/UX:** light theme (Auto/Light/Dark), accessibility (zoom, focus rings, reduced-motion),
search operators + in-thread find, delivery ticks + one-tap resend + "Do not text" badge,
Playbook onboarding nudge, optimistic send + skeleton loaders, right-click/long-press
**context menu** on conversations + leads.
**Photos:** inbound MMS captured + rendered inline + fullscreen lightbox; `/api/media`
proxy; `/api/media-backfill` recovers older photos from Twilio; multimodal **AI
quote-from-photo** (`/api/ai/photo-quote`) — *note: user said he doesn't need this one; fine
to hide/remove in a UI pass.*
**AI:** conservative **polish** (proofread only, keep meaning, temp 0.15); **draft & polish
show as an Accept / Redo / Keep-mine review card** (never silent overwrite); **summary** is
an actionable brief ending in `Next: <action>`.
**Composer polish:** template merge variables (`{first_name}/{appt}/{review}`),
natural-language scheduling ("tomorrow 9am"), voicemail transcription into the thread.
**Email tab (unified inbox):** list + reader + unread badge; `/email-in` ingest,
`/api/emails`, `/api/email-read`, `/api/email-setup`; in-app **Connect Email** dialog with a
pre-filled Google Apps Script (no Cloudflare needed — token stored in `config`).
**Home redesign:** new default **Home** tab ("who's waiting" hero + "waiting on you" +
"follow-ups ready" + "⏰ reminders" + calm week strip). Simplified 5-tab nav:
**Home · Chats · Leads · Email · Insights** (Follow-ups folded into Home + menu; Scheduled
in menu).
**Follow-up reminders:** private date-based "remind me to follow up" (no text to customer) —
set via context menu / in-thread banner, quick presets, `dispatchDueReminders` cron alert,
Home section + banner.
**Deploy guardrails:** `BUILD`/`APP_BUILD` fingerprint, `/api/version`, footer `✓ live`
indicator, `DEPLOY.md`.
**Docs:** `AUDIT.md` (original 10-feature audit), `AUDIT-2026-07.md` (full audit),
`DEPLOY.md`, this `REBOOT.md`.

---

## 7. Pending — needs the OWNER to do a small setup

- **Turn on webhook security:** add var `TWILIO_SIGNATURE_ENFORCE=1`, then send a test
  text/call to confirm webhooks still arrive.
- **Connect Gmail:** ☰ Menu → *Connect email* → paste the generated Apps Script into
  script.google.com + add a 15-min trigger. (Everything is built; just not connected.)
- **Web push (#2):** needs a VAPID keypair (`npx web-push generate-vapid-keys` →
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` secrets). Code not written yet.
- **Send outbound photos (UX-05 / #3 outbound):** needs an R2 bucket
  (`wrangler r2 bucket create mikeys-media`) since Twilio needs a public image URL.

---

## 8. Not-yet-built roadmap + creative ideas (for direction)

**Audit roadmap remaining:** #2 web push, outbound photos, #6 broadcast campaigns,
#8 referral engine, #9 reporting suite, drag-drop leads pipeline. (User is lukewarm on
campaigns/reporting/referral.)

**Creative "over-the-top" ideas pitched (awaiting the user's pick):**
- 🌟 **"I'll be in your neighborhood" blasts** — when a job is booked, text past customers
  *near that address* to batch by location. Made for a mobile business.
- 🌟 **Live "on my way" ETA tracking link** (DoorDash-style).
- 🌟 **Talk to your dashboard** — voice commands ("text the Camaro guy I'm 15 late").
- Weather-aware scheduling; optimized daily route/map; Sunday AI business brief; cold-lead
  radar; writes-in-your-voice AI; branded book-Mikey page + deposit; auto before/after
  **Canva** social posts (Canva MCP is connected); digital customer "garage"; 2-way Google
  Calendar sync (Calendar MCP connected).

**Current goal:** push it "over the top" with premium UI/UX + a signature differentiator.
Next obvious no-setup wins: finish the pro-UI pass on the **conversation/chat screen**
(Home is done, chat isn't).

---

## 8b. The JOB DAY SUITE (build `·jobday`) — read this before touching Jobs

Ten features shipped as one coherent system. Code lives in a single marked block
at the **bottom of `src/index.js`** (`# JOB DAY SUITE #`) and a single block in
`public/index.html` (`// JOB DAY SUITE — Today's Run · Quotes · Get Paid · Garage`).
Nothing existing changed shape; every addition is additive.

**UI shape.** One new bottom-nav tab, **Jobs** (`#jdApp`, z-index 82), with four
segments: **Run · Quotes · Pay · Garage**. Everything else opens in one shared
bottom sheet (`#jdSheet` / `#jdScrim`, z-index 90–91, `jdSheetOpen(html)` /
`jdSheetClose()`). Plus a floating mic (`#vxFab` → `#vxApp`) and two Home pieces
(the brief card, the one-time push nudge).

**Storage (all new keys).**
- `day:<YYYY-MM-DD>` — run state only: `{ manual[], state{jobId:{state,…}}, order[] }`.
  Bookings stay the source of truth for *what* is scheduled; `buildDay()` merges
  bookings + `appointmentAt` threads + manual jobs **in memory**, so a GET never writes.
  Job ids: `b:<bookingId>` · `t:<phone>` · `m:<genId>`. 400-day TTL.
- `trk:<token>` — one live trip, 12 h TTL, self-expiring.
- `push:vapid` (keypair, written once ever) · `push:subs` (≤6 devices).
- `quotes` (≤200) · `pay:index` (≤300) · `pay:config` · `blast:log` (≤40).
- `ph:idx:<jobId>` + `ph:img:<id>` — before/after photos (same shape as `money:rc:`).
- `img:<token>` — a photo he **texted** a customer. Raw JPEG bytes (the browser
  shrinks to ~330KB first), content type in the KV metadata, 400-day TTL, one
  write per photo. Served at **`/i/<token>`, which is PUBLIC and above the `/api`
  password gate** — Twilio fetches the URL itself with no credentials, so the
  128-bit token *is* the permission. Only `resolveOutMedia()` decides what an
  outbound message may name, and it resolves every candidate back to a token we
  minted; nothing else can reach Twilio's `MediaUrl`.
- `brief:last` — the "already sent today" stamp (1 write/day).
- `thread.garage` — vehicles + access notes, patched through `/api/meta`.

**Index summary gained** `appointmentAt`, `hasGarage`, `vehicleLabel`, `city`.
(Adding fields means every row differs once → one `saveIndex()` after the deploy.)

**⚠ KV budget** — the reason this is safe: no write on any read path. Clock-driven
writes are the brief (1/day) and `maybePayReminders()` (only when an invoice is
actually overdue). Live-ETA pings are throttled *server-side* to ~1 write/45 s and
only while a trip runs (~20 writes per drive). Keep it that way.

**Web push has no setup.** `vapidKeys()` generates a P-256 keypair with WebCrypto
on first call and stores it in KV. Pushes are sent **without a payload** (so no
aes128gcm implementation is needed and no message content crosses the push
service); `sw.js` wakes and fetches `/api/push/peek` for the headline. `notifyMikey()`
fires `pushNotify()` alongside email/SMS. `sw.js` cache is now `mkd-shell-v5`.

**Public routes** (registered ABOVE the `/api/` auth gate — keep them there):
`GET /t/<token>` (ETA page), `GET /p/<token>` (pay page), `GET /api/track/state`.
Both pages are self-contained HTML strings in the Worker with their own light/dark CSS.

**Testing.** Two harnesses were used and are worth recreating if you change this:
a Node smoke test that runs `worker.fetch` against an in-memory KV (74 assertions),
and a Playwright run that drives the real UI against the real Worker (52 assertions,
including the customer-facing pages). Both were green at `·jobday`.

**Fixed along the way:** `.toast` had `opacity:0` but no `pointer-events:none`, so the
invisible toast silently swallowed taps on anything at the bottom of the screen.

---

## 9. Working agreements / gotchas

- **Never call something "live" until verified at the production URL** (footer `✓ live` /
  `/api/version`), not just pushed. Preview ≠ production.
- **Keep `BUILD` and `APP_BUILD` identical** and bump them on every app change.
- **Only the production branch deploys.** Merge there; re-sync the working branch to `0 0`.
- Available session MCPs include Cloudflare, GitHub, Gmail, Google Calendar, Canva, Twilio,
  Zapier, Make, Netlify, Semrush — usable for setup/automation ideas (they connect/drop
  intermittently; re-load via ToolSearch).
- The sandbox can't reach the live workers.dev host; rely on the Cloudflare MCP + the user's
  eyes on the footer.
- Tone with the owner: concrete, visible wins; explain setup steps simply; don't overwhelm
  with back-office features.
