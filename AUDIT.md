# Dashboard Audit — Top 10 High-Impact Features

Audited: `src/index.js` (Worker API, webhooks, cron), `public/index.html` (UI),
`wrangler.toml` (KV, cron, assets). Date: July 2026.

## What you already have (and it's solid)

Conversation inbox with lead pipeline (New/Active/Won/Lost), tags, notes,
pinning, archiving; scheduled sends with a reserve-then-send cron; the 3.5-min
"human feel" first reach-out; click-to-call bridging; voicemail flow; quote-form
intake; Gemini summary/draft/polish/triage; quick-reply templates; PWA install;
PIN gate; a monthly cost estimate in Insights.

## Fix-first findings (not features — leaks and risks)

1. **You pay Twilio to text yourself.** Every inbound customer text and call
   fires `sendSms(MIKEY_PHONE, ...)`. At $0.0079/segment that roughly doubles
   your per-conversation cost, and long notification bodies split into multiple
   segments. Feature #2 below (web push) eliminates this entirely.
2. **Webhooks are unauthenticated.** `/sms`, `/call`, `/voicemail`,
   `/voicemail-done`, `/submit` accept any POST. Anyone who finds the URL can
   inject fake conversations, spam your cell (costing you money), or pollute
   KV. Fix: validate Twilio's `X-Twilio-Signature` header; add a honeypot
   field + rate limit on `/submit`.
3. **No delivery truth.** `sendSms` treats "Twilio accepted it" as "delivered."
   Carrier-filtered or failed messages vanish silently — you think you replied,
   the customer never got it. Fix: `StatusCallback` webhook (feature #9).
4. **No opt-out ledger.** Twilio blocks STOP'd numbers at the API (error 21610)
   but the app doesn't record it, so scheduled sends and follow-ups will keep
   erroring against opted-out numbers. Compliance + wasted-spend issue.
5. **Inbound photos are thrown away.** MMS arrives as `[2 attachment(s)]` —
   the media URLs are discarded. For a detailing business, customer photos of
   the vehicle are the quote.
6. **Login is brute-forceable.** The PIN pad + no rate limiting on
   `/api/login`, and the session cookie is a deterministic hash of the
   password (never rotates, 90-day life). Add attempt throttling in KV and a
   random session token.
7. **KV race conditions.** `threads-index` is read-modify-write on every
   message; a webhook and a dashboard action landing together can drop an
   index update. Fine at today's volume — but if you build the features below,
   migrate storage to **D1 (SQLite)**; it also fixes the next item.
8. **Insights is O(everything).** `/api/insights` re-reads every thread from KV
   on each open. Gets slower and burns KV reads as history grows.

## The Top 10 features (ranked by money-in vs effort)

### 1. Missed-call instant text-back
When `/voicemail` fires with a non-completed dial status, automatically text
the caller: "Hey, it's Mikey — sorry I missed you. Text me here and I'll get
right back to you." Missed calls are the #1 lead leak for a solo mobile
business; this converts them to texts you can answer from the driveway. You
already have the exact hook point (`handleVoicemail`) — this is ~10 lines plus
an opt-out check. **Highest ROI item on this list.**

### 2. Real-time web push notifications (and stop paying to text yourself)
The PWA + service worker already exist. Add the Web Push API: subscribe in
`sw.js`, store the subscription in KV, and have the Worker push on inbound
SMS/calls/voicemails instead of sending you an SMS. You get instant lock-screen
notifications with the message preview and a "Reply" deep link, the dashboard
stops polling, and your Twilio bill drops immediately. Needs a VAPID keypair as
Worker secrets.

### 3. Photo messaging (MMS both ways)
Inbound: store `MediaUrl0..N` from the webhook (proxy them into **R2** so links
don't expire) and render images in the thread. Outbound: attach photos via
`MediaUrl` on the send API. Unlocks: customers text pics for accurate quotes,
you send before/after shots (which sell the job and feed reviews), and Gemini
is multimodal — it can pre-assess vehicle condition from the photo and draft
the quote reply.

### 4. Automated follow-up sequences
A tiny per-thread state machine driven by the existing 1-minute cron:
- Quote sent, no reply in 48h → friendly nudge (auto-cancels if they reply).
- Still nothing in 5 days → "last call" with a small incentive.
- Marked **Lost** → one revival text 30 days later.
Each sequence is just scheduled sends that get cancelled on inbound reply —
your reserve-then-send dispatcher already handles delivery. Chasing quotes is
where solo operators lose the most winnable money.

### 5. Rebooking engine (recurring revenue)
Detailing is a repeat-purchase business but nothing brings customers back.
When a thread hits **Won**, auto-schedule a rebook text for +8–12 weeks:
"It's been about 3 months since your last detail — want me to swing by?"
Track `lastServiceAt` per thread, show "due for rebook" in Insights, and add a
one-tap "send rebook blast" to everyone overdue (throttled, opt-out aware).
This turns one-time jobs into a subscription-shaped revenue base.

### 6. Review + referral automation
1–2 days after **Won**: "Glad the truck came out great! If you have 30 seconds,
a Google review helps me a ton → [link]". Track ask/left per thread so nobody
gets double-asked, and follow with a referral hook ("$20 off when a friend
books"). Reviews are the growth engine for local search — automating the ask is
the single cheapest marketing you can do, and it rides entirely on the
scheduler you already built.

### 7. Appointment lifecycle automation + self-serve booking
`appointmentAt` exists but everything around it is manual. Make setting it
auto-schedule the whole arc: confirmation now, reminder day before, "on my way"
template the morning of (with your Google Maps ETA link). Sync each appointment
to **Google Calendar** via their REST API so your real calendar is the source
of truth. Phase 2: a public `/book` page showing open slots so customers
self-schedule from a text link — that's the "seamless" moment where the
dashboard starts running the business.

### 8. AI auto-responder with human handoff
You already pay for Gemini calls — put them on defense. After hours (or when
you haven't replied in ~10 min), let Gemini answer FAQs (pricing ranges,
service area, what's included) from a small business-facts note stored in KV,
collect vehicle year/make/model, and *always* tag the thread "AI answered" for
your review. Hard rules: never confirm a price or a time — it says "Mikey will
confirm shortly" and stops responding once you jump in. Keeps leads warm at
9pm without you living on your phone. Reuse the 3.5-minute delay trick so it
feels human.

### 9. Delivery tracking + opt-out compliance
Pass `StatusCallback` on every send; record queued → sent → delivered/failed
per message and show it in the bubble (like iMessage's "Delivered"). Alert you
(via #2's push) when a message fails so no reply silently dies. Same webhook
handles the opt-out ledger: record STOP/START, block sends and scheduled
messages to opted-out numbers, show a "Do not text" badge. This is the
trust layer every other automated feature above depends on.

### 10. Payments and deposits by text
Generate a **Square or Stripe payment link** per job from the thread's quote
amount and text it: deposits kill no-shows, and "pay by text" closes same-day.
Record paid status on the thread, then upgrade Insights from cost-only to a
real P&L: revenue collected vs Twilio spend, win rate by source, average job
value. That's when the dashboard stops being a texting app and becomes the
business's operating system.

## Suggested build order

| Phase | Items | Why first |
|---|---|---|
| 1 | #1, #2, fix-first 2/3/6 | Days of work; stops lead + money leaks immediately |
| 2 | #9, #3 | Trust layer + photos; #9 unblocks all automation |
| 3 | #4, #5, #6 | The revenue automations (need #9's opt-out ledger) |
| 4 | #7, #8, #10 (+ D1 migration) | The big "runs itself" pieces |
