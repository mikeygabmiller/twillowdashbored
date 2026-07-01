# Mikey's Detailing — SMS Dashboard

A self-hosted, Google Voice–style texting dashboard for **Mikey's Mobile Detailing**,
running on Netlify (no Cloudflare). Everything lives in this GitHub repo and edits
auto-deploy. Live at **https://mikeysms.netlify.app**.

## Features
- **Google Voice–style UI** (red & black): conversation list, search, unread badges,
  message bubbles, mark-read-on-open, Enter to send.
- **Lead pipeline:** mark each conversation **New / Active / Won / Lost**, add custom
  **tags**, and filter the list by status, unread, or scheduled.
- **Private notes** per customer (vehicle, address, preferences…). Quote-form
  submissions are auto-saved into the notes.
- **Scheduled send:** pick a date/time (or a quick preset) and the message goes out
  automatically — handled by a cron function that runs every 5 minutes.
- **Click-to-call:** rings your cell, then bridges the call to the customer through
  your Twilio number (keeps your personal number private).
- **Quick-reply templates**, contact rename, pin, and archive.
- **Free-tier friendly:** polls every 20s and pauses when the browser tab is hidden.

## How it's built
```
public/index.html                    the dashboard (static, editable in GitHub)
netlify/functions/api.mjs            API + Twilio webhooks (Netlify Function v2)
netlify/functions/dispatch-scheduled.mjs  cron: sends due scheduled messages (every 5 min)
netlify/lib/core.mjs                 shared storage + Twilio logic (Netlify Blobs)
netlify.toml                         publish = "public", functions dir, esbuild
package.json                         @netlify/blobs dependency
```
Conversations are stored in **Netlify Blobs** (no database). All secrets come from
environment variables — never in the code.

## Environment variables (Netlify → Site configuration → Environment variables)
| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | your Twilio Account SID (`AC…`) |
| `TWILIO_AUTH_TOKEN` | your Twilio Auth Token |
| `TWILIO_FROM` | your Twilio number, e.g. `+14256007897` |
| `MIKEY_PHONE` | your cell, e.g. `+13607975831` |
| `GEMINI_API_KEY` | Google AI Studio key — powers AI summary / draft / briefing |
| `GEMINI_MODEL` | *(optional)* model id, defaults to `gemini-2.0-flash` |

## Twilio webhooks (your business number)
- **Messaging** → "A message comes in" → **POST** `https://mikeysms.netlify.app/sms`
- **Voice** → "A call comes in" → **POST** `https://mikeysms.netlify.app/call`

## Website quote form
Point the form's submit URL to: `https://mikeysms.netlify.app/submit`

## Endpoints (reference)
Public: `/submit` `/sms` `/call` `/voicemail` `/voicemail-done`
Dashboard API: `/api/health` `/api/threads` `/api/thread` `/api/send` `/api/meta`
`/api/schedule` `/api/unschedule` `/api/call` `/api/read` `/api/insights`
AI (Gemini): `/api/ai/summary` `/api/ai/draft` `/api/ai/polish` `/api/ai/triage`

> Note: there is no password — the dashboard is open to anyone with the link. To add
> a lock back later, re-enable the `x-dashboard-pass` check in `api.mjs` and a login
> screen in `index.html`.
