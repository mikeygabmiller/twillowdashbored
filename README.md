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
- **Knows when a conversation is finished:** before flagging that you owe someone a
  reply, the AI reads the **whole thread** and decides whether anything is actually
  outstanding. A chat that ended on "Thanks!", a 👍 or a "Liked …" reaction stops
  showing up in *Needs your attention* and stops generating nudges — while a question,
  a photo, a voicemail, or a promise you haven't kept always keeps its reminder. The
  verdict is cached per message (one small AI call, at most, per customer text), and
  when in doubt it errs toward reminding you. The reason shows on the conversation's
  follow-up panel ("No reply needed — …").
- **Appointment auto-detect:** you never have to write a job down. Every message
  is read as it arrives; when you and a customer land on a day and time in a
  normal conversation, it shows up on the **Jobs** board as a **one-tap card**
  ("Looks like you booked Jenna — Sat at 10"), quoting the line it came from and
  carrying the address, vehicle, service, quoted price and gate/parking notes it
  pulled out of the thread. Tap **Yes** and it becomes a real job on your day (and
  sets the conversation's appointment, so reminders and follow-ups know about it);
  tap **Not a job** and it's gone. **Reschedules and cancellations raise cards
  too — the AI is never allowed to move or kill a job on its own.** Vague ones
  ("Saturday morning") become a tentative hold, and an un-confirmed card still
  blocks that slot on the public booking page so the website can't sell a time you
  already promised over text. Confirming hands you a **drafted confirmation text
  you tap to send** — nothing is ever texted automatically. Costs almost nothing to
  run: a free regex kills every message with no date in it before any AI call.
  Kill switches: the **detect** settings in the menu, or `DETECT_DISABLED=1`.
- **Payment requests, on the fly:** open a conversation → **Tools → Send a payment
  request**. The customer is already filled in; type what it's for and the price,
  tap **Add a line** for anything extra, and the total adds itself up. Deposits are
  one tap (a % you set). They get **one short text that only explains what the link
  is** — no wall of details to skim past — and the link opens a clean **receipt
  page**: the itemised breakdown, the total, and tap-to-pay **Venmo / Cash App /
  PayPal / card** buttons with the amount already filled in, plus your Zelle handle,
  cash, and any other method you add yourself. All of it is yours to configure under
  **menu → Payment setup**: business name, tagline, footer note, what to call cash,
  deposit %, auto-nudge, and free-form extra payment methods.
- **Booking texts:** confirming a booking texts the confirmation and queues the
  day-before and morning-of reminders; **cancelling or finishing a job pulls the
  reminders it still had queued**, so a cancelled customer never gets "see you
  tomorrow!"; and *Mark done* marks the lead **Won** so the review-ask and rebook
  cadences start from today. All fixed templates filled in from the booking record —
  no AI writes them, so none can invent a price or a time — and each is individually
  switchable in **Bookings → Settings → Booking texts**. (Day-of messages — on my
  way, I'm here, all finished — belong to the Jobs run board, which also drives live
  ETA tracking.)
- **Answer by email / by text (the assist loop):** the alert shows you the reply it
  would send and you answer **yes** or **no** — or send the bare facts and the AI
  writes it in your voice instead. Either way you supply every fact; it only does
  the wording.
  - **By email (free):** hit **reply** on a new-text alert and answer `yes` (sends
    the drafted reply word for word) or `no` (drops it) — or type `375, thursday
    works` to have it written differently. No Twilio message is used for your half
    of the exchange, and the reply is already threaded to that customer, so there's
    nothing to address. Needs the one-time Gmail hookup below.
  - **By text:** text your **own business number** the same thing. Costs one inbound
    + one outbound segment, but works anywhere.
  - Grammar either way: `yes`/`no` answers the drafted reply, `@ruth …` picks
    someone, `send: …` sends your exact words,
    `draft: …` holds it in the dashboard, `who` lists who's waiting, `cancel` pulls
    the last one back. You get the finished wording back before it goes out, with a
    configurable hold that is the cancel window (60s by text, 180s by email since a
    cancel has to make another trip through the inbox).
  - Guards: the text path only accepts `MIKEY_PHONE` over a Twilio-signed webhook;
    the email path only accepts mail from `ALERT_EMAIL` that carries the `[ref:…]`
    marker the dashboard plants in its own alerts, so ordinary mail is never read as
    a command. Both toggle in the menu.

  **Every alert shows the reply first.** Instead of just repeating what the customer
  said, each alert quotes the finished reply it would send and asks for a plain yes
  or no; underneath, it still names what it needs from you and shows literal example
  replies you can type verbatim ("375" · "375, thursday works"). Complaints, damage and
  refund requests are classified as **escalate** and get the opposite treatment —
  flagged *handle this one yourself*, with the quick-answer path and the reply
  marker deliberately withheld so a one-word reply can't fire an AI message at an
  angry customer.

  **Gmail hookup (one time, ~2 min):** menu → *Answer by email* → **Copy the Gmail
  setup script** → paste into a new project at script.google.com → add a 1-minute
  time-driven trigger on `mikeyAssistSync`. The script reads your **Sent** mail for
  replies carrying the `[ref:…]` marker and POSTs them to `/email-in`, so no custom
  domain, no inbound-mail service and no third-party automation is needed.

  **Practice mode:** menu → *Answer by email* → **Send me a practice question**
  emails you a realistic question from a fake customer. Replying runs the entire
  chain — Gmail script, routing, quote stripping, AI drafting, confirmation — and
  stops one step short of Twilio: you get the finished message back marked TEST and
  nothing is sent. Repeated taps rotate through a price question, a scheduling one,
  a service question and a complaint. The practice number lives in the 555-01xx
  range reserved for fiction, and `sendSms()` refuses it unconditionally, so no code
  path can text it even by accident.
- **Sounding like you (voice training):** the AI used to learn your voice from ten
  hand-written example texts while thousands of your real ones sat unread in KV.
  Now **Rebuild from my texts** mines the messages you actually typed (templates,
  follow-ups and AI-written replies are excluded — no training on itself), files
  them by situation (price / scheduling / apology / confirmation / …), derives a
  *measurable* style fingerprint from them, and shows the model your real texts
  from the matching situation on every draft. A **tell-blocker** catches stock AI
  phrasing ("Certainly!", "I'd be happy to", em-dashes) and regenerates once with
  that phrase banned by name. **Train the voice** replays past conversations — what
  the AI would write now, next to what you really sent — and one tap per card
  records the verdict; a miss feeds your real wording in as the target and the AI's
  attempt in as a thing to avoid. Sending a draft unedited is recorded as a
  positive example, which it previously threw away. The scoreboard is
  **% sounds like you**, from the trainer. **Paste an export** takes a phone
  transcript (Google Voice / Messages) and pulls out only your side — it reads the
  `Message from you, …` labels those exports carry, so the customer's half never
  enters the corpus; a plain list of your texts, one per line, works too. Bare
  links, phone numbers and payment URLs are dropped; payment methods mentioned
  inside a sentence are kept, because that's your voice.
- **Claude writes the customer-facing drafts** when `ANTHROPIC_API_KEY` is set —
  holding one specific person's voice from example texts is the one place the model
  itself is the ceiling. Everything else (classification, triage, summaries) stays
  on Gemini Flash, and drafting falls back to Gemini automatically if the key is
  missing or the call fails, so you never lose the ability to reply.
- **Click-to-call:** rings your cell, then bridges the call to the customer through
  your Twilio number (keeps your personal number private).
- **Instant email alerts (optional, Resend):** get emailed the moment a text,
  call, missed call, voicemail, or quote comes in — free, instead of paying Twilio
  to text your own phone. Falls back to SMS automatically if email isn't set up.
- **AI predictive keyboard:** a phone-keyboard-style suggestion strip above the
  message box that knows how *you* text. Two layers: the **voice corpus** (the
  same real texts Train AI learns from, imports included) is boiled down to a
  tiny typing model — your openers, which word follows which, your actual
  vocabulary — that runs **in the browser on every keystroke**, instant and free;
  and the **AI** reads the conversation a beat after you pause and finishes the
  sentence in your voice as dim ghost text behind the cursor. Tap the ✨ chip or
  press <kbd>Tab</kbd> to take it, tap a word chip to add just that word. It
  shares the row with the contextual quick replies — those answer *what do I
  send*, this answers *what's my next word*. Rebuilt twice a day, with a
  **Relearn how I text** button and an on/off switch in the menu; the local half
  keeps working even with no AI key configured.
- **AI helpers (optional, Gemini):** conversation summary, draft/polish a reply,
  and an inbox triage briefing.
- **Editable quick-reply templates**, contact rename, pin, and archive.
- **Free-tier friendly:** adaptive polling that backs off and pauses when idle/hidden.

## The Job Day suite (Jobs tab)
Ten features that turn the dashboard from "where the texting happens" into the
app the day actually runs on. All of it lives under the new **Jobs** tab
(Run · Quotes · Pay · Garage) plus a floating mic and a Home brief card.

1. **Today's Run** — the day board. Online bookings, texted appointments and
   hand-added cash jobs merge into one ordered run sheet with a hero showing
   stops left, dollars booked and hours on the clock. Each stop moves
   *queued → on my way → working → done*, with a live job timer, one-tap
   navigate (Apple Maps on iOS, Google Maps elsewhere) and one-tap text.
   Finishing a job logs the money, flags a balance owed and can fire the
   "all finished" + review-ask text in a single sheet.
2. **Live ETA tracking** — tapping *On my way* texts the customer a link to a
   DoorDash-style page that counts down, updates itself and offers call/text.
   Mikey's phone feeds it GPS while he drives. Links expire on their own (12 h)
   and never expose anything but the trip.
3. **Web push notifications** — real phone alerts for every inbound text,
   missed call, voicemail and the morning brief, instead of polling. **No setup
   at all:** the VAPID keypair is generated inside the Worker on first use.
   Pushes carry no payload — the service worker asks the backend for the
   headline — so message content never crosses the push service.
4. **Quote builder** — service × vehicle size × condition × add-ons, priced
   live off the *same* menu the public booking page uses, so a texted quote and
   the website can never disagree. Shows the exact message before it sends, and
   tracks sent → accepted/declined with a win rate. Accepting flips the lead to
   Won.
5. **Get paid** — payment requests and deposits by text, linking to a branded
   pay page with tap-to-pay buttons for Venmo / Cash App / PayPal / Zelle and an
   optional Stripe or Square link. No processor account required. Tracks what's
   outstanding and can auto-nudge an unpaid invoice once after N days.
6. **Customer garage** — vehicles (year/make/model/color/plate), address, gate
   code, where to park, whether there's water and power, preferences and
   "careful with" notes — joined against the money ledger for lifetime value,
   job count and last visit. Never ask the same question twice.
7. **Neighborhood blasts** — pick a booked job, find past customers in that town
   or ZIP, and offer them the same-day slot at a discount. Opt-out aware,
   `{first_name}` merged, capped at 25 per send, confirmation required.
8. **Before / after photos** — snap both from the job sheet; they compress in
   the browser (~120 KB) and render as a draggable before/after slider.
9. **Hands-free voice control** — the floating mic opens a push-to-talk screen
   that routes speech to the same AI agent the command bar uses and speaks the
   answer back. Anything that would change data still needs a deliberate tap.
10. **Daily brief** — a 6am rundown (push + email): today's stops, per-job rain
    risk from the hourly forecast, who's waiting, yesterday's money and the one
    thing to do first. Also inline on Home and on demand any time.

Cost discipline: none of this writes to KV on a read. The only clock-driven
writes are the brief (1/day) and the invoice sweep (only when something is
actually overdue); live-ETA pings are throttled server-side to ~1 write/45 s and
only while a trip is running.

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

## Map rank grid (Analytics → Map → Map rank) — and what it costs

A Local-Falcon-style grid: each point asks Google what ranks there for a search
term, and the pin shows where the listing came back (1–3 green … 20+ red).

**One grid point = one Google Places "Text Search" call.** 5×5 = 25 calls,
13×13 = 169.

**What Google charges.** Text Search is billed by the *most expensive field in
the request*, so the field mask picks the SKU — not the endpoint:

| What we ask for | SKU | Price | Free per month |
|---|---|---|---|
| `places.id` only | Text Search Essentials (IDs only) | free | 10,000 |
| `places.id,places.displayName` | Text Search Pro | **$32 / 1,000** | 5,000 |

So the app runs scans on the **free** SKU whenever a Place ID is pinned: the ID
alone is enough to spot the listing in the results. Matching by *name* is what
forces the paid SKU, because names are a paid field. Rates last checked
2026-07-28 and are editable in the app (Places setup → Spending) so a Google
price change doesn't need a deploy.

**The guard.** `freeOnly` is on by default. The Worker prices every batch
*before* calling Google (`geoBudget`) and returns HTTP 402 rather than make a
call that would land past the free allowance — the dashboard shows the cost of
the next scan, the month-to-date count, and refuses the button. Usage is
metered in KV (`geogrid:meter`, Pacific months, matching Google's quota reset).

The guard only covers calls made by this dashboard. For a hard stop that covers
everything using the key, also set a daily cap in **Google Cloud Console → APIs
& Services → Places API (New) → Quotas**.

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
`/t/<token>` (live ETA page) `/p/<token>` (pay page) `/api/track/state`
Auth: `/api/login` `/api/logout`
Dashboard API: `/api/health` `/api/threads` `/api/thread` `/api/send` `/api/meta`
`/api/schedule` `/api/unschedule` `/api/call` `/api/read` `/api/insights`
`/api/alert-test` `/api/templates` `/api/migrate`
`/api/followups` `/api/followup` `/api/config` `/api/block`
Website analytics: `/api/analytics` (pixel) `/api/webstats` `/api/webstats/status`
`/api/webstats/connect` `/api/webstats/disconnect` `/api/webstats/ai`
AI (Gemini): `/api/ai/summary` `/api/ai/draft` `/api/ai/triage` `/api/ai/agent`
Predictive keyboard: `/api/ai/style` (your typing model) `/api/ai/predict` (next phrase)
Job Day suite: `/api/day` `/api/day/state` `/api/day/job` `/api/day/remove`
`/api/day/order` · `/api/track/start` `/api/track/ping` `/api/track/stop` ·
`/api/push/key` `/api/push/subscribe` `/api/push/unsubscribe` `/api/push/test`
`/api/push/peek` · `/api/quote/config` `/api/quote` `/api/quote/action` ·
`/api/pay` `/api/pay/config` `/api/pay/request` `/api/pay/action` ·
`/api/garage` · `/api/blast/candidates` `/api/blast/send` ·
`/api/photos` `/api/photos/img` `/api/photos/delete` · `/api/brief`
