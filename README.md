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

## Twilio webhooks (your business number)
- **Messaging** → "A message comes in" → **POST** `https://texting.mikeysdetailingsnohomish.workers.dev/sms`
- **Voice** → "A call comes in" → **POST** `https://texting.mikeysdetailingsnohomish.workers.dev/call`

## Website quote form
Point the form's submit URL to: `https://texting.mikeysdetailingsnohomish.workers.dev/submit`

## Endpoints (reference)
Public: `/submit` `/sms` `/call` `/voicemail` `/voicemail-done`
Auth: `/api/login` `/api/logout`
Dashboard API: `/api/health` `/api/threads` `/api/thread` `/api/send` `/api/meta`
`/api/schedule` `/api/unschedule` `/api/call` `/api/read` `/api/insights`
`/api/alert-test` `/api/templates` `/api/migrate`
`/api/followups` `/api/followup` `/api/config`
AI (Gemini): `/api/ai/summary` `/api/ai/draft` `/api/ai/triage`
