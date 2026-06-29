# Mikey's SMS Dashboard — Cloudflare Worker

This app moved off Netlify (whose credit limits paused production deploys) onto
a **Cloudflare Worker**. Same dashboard, same features, same API — Cloudflare's
free tier is request-based (100k/day) and does **not** pause your deploys.

What changed under the hood:
- Storage: Netlify Blobs → **Cloudflare KV** (`MESSAGES` namespace, already on your account)
- Cron: Netlify scheduled function → **Cloudflare Cron Trigger** (every 5 min)
- Secrets: `process.env.*` → **Worker secrets**
- Dashboard UI (`public/index.html`) → served via **Workers static assets**
- The inbound auto-reply ("Got it! Mikey will get back to you soon") is removed —
  customers no longer get an automatic text; Mikey replies personally.

The old Netlify files have been removed — this repo now deploys only to Cloudflare.

## Deploy with NO terminal — Cloudflare dashboard (browser only)

1. Go to **dash.cloudflare.com → Workers & Pages → Create → Workers → Connect to Git**.
2. Pick the **`twillowdashbored`** repo and the branch you merged this into.
   Cloudflare reads `wrangler.toml` automatically (KV binding, static assets, cron).
   Leave build command blank; deploy command `npx wrangler deploy` (default).
3. Click **Create / Deploy**. You'll get a URL like
   `https://mikeys-sms-dashboard.<your-subdomain>.workers.dev`.
4. In the new Worker → **Settings → Variables and Secrets**, add (type = Secret):
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM`   (e.g. `+14256007897`)
   - `MIKEY_PHONE`   (your cell, e.g. `+13607975831`)
   - `GEMINI_API_KEY`  (optional — only the AI buttons need it)
   Then **Deploy** again so the secrets take effect.

## Bring your existing conversations over (one click)

Once the Worker is deployed, open this in your browser **one time**:

```
https://<worker-url>/api/migrate
```

The Worker fetches every conversation from `mikeysms.netlify.app` and copies it
into KV with full history. It returns a JSON summary (`imported`, `skipped`).
Safe to run again if needed. (Optional: `?from=https://<other-netlify-url>`.)

## After deploy — point things at the Worker

1. **Twilio number → Messaging** "A message comes in": `POST  https://<worker-url>/sms`
2. **Twilio number → Voice** "A call comes in": `POST  https://<worker-url>/call`
3. **Website quote form** (`mikeysite/index.html`) — set `WORKER_URL` to
   `https://<worker-url>/submit`

Pointing Twilio's Messaging webhook at the new `/sms` is also what stops the old
"Got it!…" auto-reply for good (the live Netlify version can't be redeployed
while its credits are paused).

## Notes
- KV is eventually consistent — the dashboard polls every few seconds, so a new
  message can take a second or two to appear. Fine for this use.
- Free-tier headroom: KV allows 1,000 writes/day; each message is ~2 writes, so
  you'd need ~500 messages/day to get close. The 5-minute cron only writes when
  a scheduled message is actually due.
