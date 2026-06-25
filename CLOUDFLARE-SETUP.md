# Mikey's SMS Dashboard — Cloudflare Worker

This app moved off Netlify (whose credit limits paused production deploys) onto
a **Cloudflare Worker**. Same dashboard, same features, same API — Cloudflare's
free tier is request-based (100k/day) and does **not** pause your deploys.

What changed under the hood:
- Storage: Netlify Blobs → **Cloudflare KV** (`MESSAGES` namespace, already on your account)
- Cron: Netlify scheduled function → **Cloudflare Cron Trigger** (every 5 min)
- Secrets: `process.env.*` → **Worker secrets**
- Dashboard UI (`public/index.html`) → served via **Workers static assets**

The Netlify files (`netlify/`, `netlify.toml`) are left in place for reference
but are no longer used.

## One-time deploy (~10 min)

```bash
npm install
npx wrangler login            # opens browser, sign in to Cloudflare

# Set your secrets (stored encrypted in Cloudflare, never in the repo):
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM      # e.g. +14256007897
npx wrangler secret put MIKEY_PHONE      # your cell, e.g. +13607975831
npx wrangler secret put GEMINI_API_KEY   # optional — only the AI buttons need it

npx wrangler deploy
```

`wrangler deploy` prints your URL, e.g.
`https://mikeys-sms-dashboard.<your-subdomain>.workers.dev`

## After deploy — point things at the Worker

1. **Twilio number → Messaging** "A message comes in": `POST  https://<worker-url>/sms`
2. **Twilio number → Voice** "A call comes in": `POST  https://<worker-url>/call`
3. **Website quote form** (`mikeysite/index.html`) — set `WORKER_URL` to
   `https://<worker-url>/submit`

That's it. The dashboard is at the Worker root (`/`).

## Notes
- KV is eventually consistent — the dashboard polls every few seconds, so a new
  message can take a second or two to appear. Fine for this use.
- Existing Netlify conversation history is **not** carried over automatically
  (it lived in Netlify Blobs). Threads repopulate as customers text in. If you
  want the old history migrated, export it from Netlify and we can import to KV.
- Free-tier headroom: KV allows 1,000 writes/day; each message is ~2 writes, so
  you'd need ~500 messages/day to get close. The 5-minute cron only writes when
  a scheduled message is actually due.
