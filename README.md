# Mikey's Detailing — SMS Dashboard

A self-hosted, Google Voice–style texting dashboard for **Mikey's Mobile Detailing**,
running as a **Cloudflare Worker**. Everything lives in this GitHub repo and edits
auto-deploy to Cloudflare. Live at **https://texting.mikeysdetailingsnohomish.workers.dev**.

> Migrated off Netlify → Cloudflare Workers. See **CLOUDFLARE-SETUP.md** for the
> full deploy walkthrough (browser-only, no terminal needed).

## Features
- **Mobile-first UI** (red & black): conversation list, search, unread badges,
  message bubbles, mark-read-on-open, Enter to send. Installs to the home screen
  as a PWA (app icon, full-screen, offline shell via `public/sw.js`).
- **PIN / password login** (set the `DASHBOARD_PASSWORD` secret).
- **Lead pipeline:** mark each conversation **New / Active / Won / Lost**, add custom
  **tags**, and filter the list by status, unread, or scheduled.
- **Private notes** per customer (vehicle, address, preferences…). Quote-form
  submissions are auto-saved into the notes.
- **Scheduled send & appointment reminders:** pick a date/time (or a preset) and the
  message goes out automatically — handled by a **Cron Trigger** every minute.
- **Auto follow-up engine:** every conversation is watched for context — who spoke
  last, how long ago, and its lead status — and a **suggested nudge (what to say +
  when)** surfaces in a dedicated Follow-ups tab, on the conversation, and as a badge.
  Cadences: a reply you owe a waiting customer; an escalating chase on unanswered
  outreach (≈1d → 3d → 7d, then it stops); a review ask after a **Won** job; a rebook
  reminder months later; and a revival for a **Lost** lead. Drafts are AI-written
  (Gemini) with template fallbacks. One tap to Send / Edit / Snooze / Skip, or flip on
  **Autopilot** to have the safe nudges send themselves (quiet-hours aware; replies you
  owe a customer always wait for your approval). All tunable per-contact and globally
  in the menu.
- **Auto-detected jobs + Today's Run (`Today` tab):** you never have to write an
  appointment down. Every message is read as it arrives; when you and a customer
  land on a day and time, the job shows up as a **one-tap card** ("Looks like you
  booked Jenna — Sat at 10"), quoting the line it came from. Tap **Yes** and it
  lands on your day; tap **Not a job** and it's gone. It also pulls the address,
  vehicle, service, quoted price and gate/parking notes out of the conversation,
  and catches **reschedules and cancellations** the same way — as cards, never as
  silent changes. Vague ones ("Saturday morning") become a tentative hold that
  blocks the day until you pin the hour down. Confirming hands you a **drafted
  confirmation text you tap to send** (nothing is ever texted automatically) plus
  a one-tap *Add to Google Calendar* link. On the day: a **7am brief** (jobs in
  drive order, money on the table, unconfirmed ones flagged, rain warning, and
  what time to leave), a **"leave now"** alert per job computed from real drive
  time, and a **night-before recap**. Empty days ping you with the warmest leads
  to chase instead. Everything is behind one **master pause switch** in the menu.
- **Click-to-call:** rings your cell, then bridges the call to the customer through
  your Twilio number (keeps your personal number private).
- **Instant email alerts (optional, Resend):** get emailed the moment a text,
  call, missed call, voicemail, or quote comes in — free, instead of paying Twilio
  to text your own phone. Falls back to SMS automatically if email isn't set up.
- **AI helpers (optional, Gemini):** conversation summary, draft/polish a reply,
  and an inbox triage briefing.
- **Editable quick-reply templates**, contact rename, pin, and archive.
- **Free-tier friendly:** adaptive polling that backs off and pauses when idle/hidden.

## How it's built
```
public/index.html      the dashboard UI (static, served via Workers static assets)
public/sw.js           service worker (installable PWA / offline shell)
public/manifest.webmanifest, icon-*.png, favicon.svg   PWA icons + manifest
src/index.js           the Worker: API + Twilio webhooks + scheduled() cron handler
wrangler.toml          Worker config: name, KV binding, static assets, cron trigger
package.json           dependencies
```
Conversations are stored in **Cloudflare KV** (the `MESSAGES` namespace) — no
database. All secrets come from **Worker secrets** — never in the code.

## Secrets (Cloudflare → Worker → Settings → Variables and Secrets, type = Secret)
| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | your Twilio Account SID (`AC…`) |
| `TWILIO_AUTH_TOKEN` | your Twilio Auth Token |
| `TWILIO_FROM` | your Twilio number, e.g. `+14256007897` |
| `MIKEY_PHONE` | your cell, e.g. `+13607975831` |
| `DASHBOARD_PASSWORD` | *(optional)* PIN/password to lock the dashboard. If unset, the dashboard is open to anyone with the link. |
| `GEMINI_API_KEY` | *(optional)* Google AI Studio key — powers AI summary / draft / briefing |
| `GEMINI_MODEL` | *(optional)* model id, defaults to `gemini-2.5-flash` |
| `RESEND_API_KEY` | *(optional)* [Resend](https://resend.com) API key — turns on **email alerts** for new texts/calls/voicemails/quotes instead of paying Twilio to text yourself |
| `ALERT_EMAIL` | *(optional)* where alerts are sent, e.g. `mikeysdetailing4u@gmail.com`. Required for email alerts. If unset, alerts fall back to SMS to `MIKEY_PHONE` |
| `ALERT_FROM` | *(optional)* verified sender, e.g. `Mikeys Dashboard <alerts@yourdomain.com>`. Defaults to Resend's `onboarding@resend.dev` (which can only send to your own Resend account email until you verify a domain) |

### Email alerts (Resend)
Set `RESEND_API_KEY` + `ALERT_EMAIL` and every inbound text, call, missed call,
voicemail, and new quote emails you **instantly and for free** instead of
sending an SMS to your cell (which cost a Twilio segment each). SMS is kept as an
automatic fallback if the email send fails or the keys aren't set. To confirm
it's working, POST `/api/alert-test` (or check `alerts.channel` in `/api/health`).

**Free-tier note:** Resend's free plan sends 100 emails/day. Until you verify a
sending domain, keep `ALERT_FROM` unset — Resend then sends from
`onboarding@resend.dev` to the email address on your Resend account (set
`ALERT_EMAIL` to that same address). To send from your own domain, add and
verify it in Resend, then set `ALERT_FROM` to an address on it.

## Website analytics command center (Grow → Website)
The Website tab is an all-in-one analytics dashboard that pulls **Google
Analytics 4**, **Microsoft Clarity**, the built-in first-party pixel, and your
job/revenue data into one scannable view: live "people on your site right now",
KPI tiles with vs-prior-period deltas, plain-English insights, a
visit→call→job→revenue funnel, a Clarity UX-health grade (dead/rage clicks,
scroll depth, JS errors), top pages / sources / cities / devices / busiest
hours, and an **AI deep read** (Gemini) that tells you what to do this week.

**Connecting (one-time, in the app — no terminal):** open Grow → Website and
paste two things:
1. **Google Analytics** — the service-account JSON file (the same one the
   daily-email function uses; the service account must be a *Viewer* on the GA4
   property). Property ID defaults to Mikey's.
2. **Clarity** — an API token from Clarity → Settings → **Data Export** →
   Generate new API token.

Both are stored in Worker KV, never in this repo, and are never echoed back by
the API. Alternatively set them as Worker secrets (these win over pasted
values): `GOOGLE_SERVICE_ACCOUNT_JSON`, `CLARITY_API_TOKEN`, `GA4_PROPERTY_ID`.

**Caching / limits:** GA responses cache ~30 min per range (10 min for Today);
GA realtime is fetched live. Clarity's export API allows only **10 calls per
project per day**, so responses cache 6 h and a budget counter stops at 8
calls/day (stale data is served after that — the UI labels it).

## Twilio webhooks (your business number)
- **Messaging** → "A message comes in" → **POST** `https://texting.mikeysdetailingsnohomish.workers.dev/sms`
- **Voice** → "A call comes in" → **POST** `https://texting.mikeysdetailingsnohomish.workers.dev/call`

## Website quote form
Point the form's submit URL to: `https://texting.mikeysdetailingsnohomish.workers.dev/submit`

## Spam-call screening
Inbound calls are gated before they ever forward to your phone, so robocall
auto-dialers stop flooding your voicemail:
- **Press-1 screening** (on by default): callers hear "press 1 to reach Mikey."
  Bots don't press a key, so they're hung up on and never ring you or leave a
  voicemail. Real customers press 1 and connect as usual. Toggle it in the menu
  under **Call screening**.
- **Block list:** paste a number under **Block a number** in the menu (or POST
  `/api/block` with `{phone, action:'block'|'unblock'}`) to reject that caller
  instantly — no ring, no voicemail, no alert.

You're only alerted once a caller clears the gate, so the notification flood
stops too. No Twilio Console changes are needed — the existing `/call` webhook
drives everything.

## Endpoints (reference)
Public: `/submit` `/sms` `/call` `/call-screen` `/voicemail` `/voicemail-done`
Auth: `/api/login` `/api/logout`
Dashboard API: `/api/health` `/api/threads` `/api/thread` `/api/send` `/api/meta`
`/api/schedule` `/api/unschedule` `/api/call` `/api/read` `/api/insights`
`/api/alert-test` `/api/templates` `/api/migrate`
`/api/followups` `/api/followup` `/api/config` `/api/block`
Day-of-service: `/api/run` (Today's Run + detected job cards) `/api/job` (confirm /
edit / dismiss / cancel / done / accept-change)
Website analytics: `/api/analytics` (pixel) `/api/webstats` `/api/webstats/status`
`/api/webstats/connect` `/api/webstats/disconnect` `/api/webstats/ai`
AI (Gemini): `/api/ai/summary` `/api/ai/draft` `/api/ai/triage`
