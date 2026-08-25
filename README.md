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
- **Starting a text is a person, not a phone number.** The pencil opens a picker:
  everyone you've ever texted, most recent first, searchable by name *or* by digits.
  Tap a name and you're in the conversation with the cursor already in the box. Type
  a number nobody's texted yet and it's offered as its own row ("Text (425) 555-9999
  · Someone new"), so a first-time customer is the same two taps. Someone who texted
  STOP still shows up — flagged **Do not text** — so you learn that before you type.
  A conversation with nothing in it offers your own saved openers as chips, which
  makes the first text to a new customer three taps and no typing.
- **Swipe left on a conversation for "who is this again?"** Going down a list of
  twenty means asking that twenty times, and answering it used to mean opening the
  thread — which marks it read and loses your place. A left swipe pops a summary
  instead: the one line that matters (*Booked Thu, Aug 21 · 2:00 PM — in 3 days*,
  *Waiting on your reply — you quoted $240, no answer*, *They texted STOP*), an
  AI one-liner of **what actually happened** in your own shorthand (*"asked about
  ceramic on his Tahoe, you said you'd price it Thursday"*, *"job finished, he
  Venmo'd you $180"*), then
  where they are, what they drive, the open quote, the plan they're on, anything
  queued to send, where the lead came from, and their own last words. Arrows step
  to the next person without closing, so you can flick through the whole list.
  Swipe **right** still archives. Every row carries a faded red edge and a small
  chevron on its right side so the gesture is discoverable instead of secret — it
  fades out mid-swipe once the real label shows, and only appears on touch devices,
  where there's actually a thumb to pull with. Everything except the recap comes off
  the list row already in memory, and the recap is cached against the last message's
  timestamp — so it costs one Gemini call per conversation per new message, retires
  itself the moment either of you texts again, and is instant every time after.
  **Peeking never marks a conversation read** (`POST /api/ai/recap` deliberately uses
  `loadThread`, not `openThreadForRead`, which clears unread).
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
- **Kept promises — "I'll get back to you Monday":** the easiest money in this
  business to lose is a customer you personally told you'd follow up with, and
  then didn't. So every text **you** send is read for a promise to come back to
  someone ("I'll check and let you know", "let me price it out and text you
  tonight"). When one is found you get an **email with a real calendar invite
  attached** (.ics, plus a one-tap *Add to Google Calendar* button), the promise
  shows up on Home under **Promises you made**, and you get a **nudge at the time
  you promised** — pulled into working hours, so nothing buzzes at 3am. If you
  named a day it uses that day; if you just said "I'll let you know", it gives it
  24 hours (configurable). **Nothing is ever texted to the customer** — a promise
  only ever produces a reminder for you. One tap each to mark it **Done**, push it
  to **Later**, or say **Not a promise**; and it closes itself silently if you
  text them again more than ten minutes after making it, so you're never nudged
  about something you already did.
  - **Scan what you've already sent:** *Home → Promises you made → Scan my recent
    messages* (also in the menu) reads back over the **last 3 messages** of every
    open conversation — the depth is yours to set, 1–10 — and finds the promises
    you made before this existed, which are exactly the ones most likely already
    forgotten. One email for the whole scan with a calendar invite attached for
    each. Deliberately bounded: one AI call per conversation at most, and it stops
    after 12, so a scan is a known small cost rather than a surprise.
  - Costs almost nothing to run: a free regex kills every message with no
    promise-shaped words in it before any AI call, and the whole feature lives in
    one KV doc, so the minute cron checks every promise with a single read.
    Toggles (and the "if I didn't say when" gap) live in the menu; `PROMISE_DISABLED=1`
    is the no-KV-write kill switch.
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

  **The alerts are real HTML emails.** Their words come first and loudest — the
  customer's message in big bold type at the top of the email, in the subject line,
  and in the inbox preview line, so the notification banner alone usually tells you
  what was asked. Under it: the drafted reply in a card with **one-tap Send it /
  No — drop it** buttons (they're `mailto:` links that compose the same `yes`/`no`
  reply you'd type, so nothing new is trusted), the example answers as tappable
  chips, and a dashboard button. Every other alert — voicemails, failed texts,
  bookings, the weekly recap — is laid out by the same kit from its plain text, so
  they all read the same way. The plain-text part goes out alongside the HTML and is
  what's used when an alert falls back to SMS, so nothing depends on the HTML
  rendering. Two lines in it are load-bearing rather than decorative — the cut
  marker at the very top and `[ref:…]` at the bottom — and `test/alertmail.test.js`
  guards them.

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
- **Auto-polish:** you don't press anything. Stop typing for a beat and your draft
  is polished in the background — but nothing is ever swapped into the box behind
  your back and nothing covers the screen. A slim **"Polished version ready"** bar
  appears above the message box; tap it and a sheet slides up with what you wrote,
  the polished version in an editable box, and **Use this / Redo / Keep mine**. It
  only runs on a real pause, only on text long enough to be worth it, at most once
  every few seconds, and every result is cached so the same draft is never sent
  twice. **Tools → Polish as you type** switches it off (the Polish tool still
  works on demand), and **Tools → Polish my text now** skips the wait.
- **AI helpers (optional, Gemini):** conversation summary, draft a reply, and an
  inbox triage briefing.
- **Bank screenshot → ledger (optional, Gemini):** screenshot your Wells Fargo
  activity list and every charge and deposit comes back as a checklist —
  categories guessed, deposits matched to the customer who paid, anything
  already logged flagged. Nothing is written until you confirm.
- **Editable quick-reply templates**, contact rename, pin, and archive.
- **Free-tier friendly:** adaptive polling that backs off and pauses when idle/hidden.

## Money on the table (Home → the customers going quiet)
The cheapest job in this business comes from somebody who already knows you, and
four kinds of quiet were invisible: a **quote nobody answered**, a **customer
overdue for another detail**, a **lead who asked for a price and never booked**,
and a **maintenance plan whose cycle has come round**. All four now land on one
Home card with the total dollars attached, and a sheet that works the list one
person at a time — each row shows the text already written, and one tap opens
that conversation with it in the box. **Later** puts someone back for 30 days;
**Not interested** marks the lead lost so it stops being a lead.

Drafts are fixed templates, never AI: these go to people who are already
lukewarm, and a model that invents a price or a day on a rebook text does real
damage. Everything is derived at read time from the thread index and the money
ledger — no new store, no writes, and the only thing ever written is the skip
list, and only when Mikey taps a button.

> Replaces the old **Rebook radar** widget, which never showed anything: it
> filtered client-side for a last job 45+ days ago while reading only the
> *current month's* ledger, so the condition was very nearly unsatisfiable.

## Maintenance plans (conversation → Tools → Put them on a plan)
A plan says "this person gets detailed every N weeks" — 4 weeks through 6
months. When the cycle comes round they move to the top of *Money on the table*
with a rebook text ready. **Nothing is texted and nothing is booked by it**; it
is a promise to remind Mikey, not a subscription the customer signed. The clock
runs from the **last job actually done** (not from when the plan was created, so
setting one up on an old customer doesn't hide them for six weeks), it asks once
per cycle, and it goes quiet on its own the moment they book. Lives on the
thread and is mirrored onto the index, so "who is due" costs no extra reads.

## The customer's own page — `/c/<token>`
Most of what gets texted at a detailer is admin: what do you charge, when are
you free, can we move it, what did you do last time. This is one permanent link
per customer that answers all of it. It knows who they are, so nothing has to be
typed twice: their vehicle and address are already on it, they can **book a time
from real availability**, **move or cancel**, and see **every detail you've done
for them**. Send it from *conversation → Tools → Send their booking link*.

The token is the identity — long, unguessable, per-customer, and deliberately
non-expiring, because a link that dies is a link that produces a text asking for
a new one. It exposes only that customer's own data and can only act on that
customer's own bookings. Booking through it drives the **same** public
`/api/availability` + `/api/book` endpoints the website uses, so a time booked
here and a time booked on the website can never disagree about what's free, and
it lands as **pending** for Mikey to confirm exactly like a website booking. A
customer cancelling pulls the reminders that job still had queued (so nobody
gets "see you tomorrow!" for a job that isn't happening) and emails Mikey.

## Bank screenshot → ledger (Money → Log → Scan)
Screenshot the Wells Fargo activity list on your phone, tap **Scan a bank
screenshot** on the Money Log screen, and Gemini reads the rows straight off the
picture — up to three screenshots at a time. Every charge and deposit comes back
as a checklist. Nothing is written until you tap the button at the bottom.

The confirm step exists because three things are genuinely not safe to take the
model's word for, and all three are fixed right in the sheet:

- **The category.** A merchant name is bad evidence — two of the card charges
  that started this feature rang up at gas stations and were food, not fuel. The
  prompt says so explicitly (a few dollars at a pump is a drink; $15+ is a
  fill-up), and every expense row still gets a dropdown.
- **Which customer paid.** Deposits are matched against your text book by name,
  including the "SARAH M" form Zelle usually prints. A match has to be
  *unambiguous* — two Sarahs means nobody is picked and both are offered as
  chips instead. Unmatched income still logs; it just isn't tied to a customer.
- **Whether a row is new.** Each proposal is checked against what that month
  already holds — same day, same amount, same side of the books — however it got
  there. Anything already logged arrives unticked and labelled, so re-scanning an
  overlapping screenshot next week can't double-log it. The commit re-checks, in
  case the ledger moved while you were reading.

Also unticked on arrival: charges still **pending** at the bank (the amount can
change), and money in that plainly isn't a customer — a transfer from savings, a
refund, interest — which would otherwise inflate gross and every average built
on it.

Costs a fraction of a cent per screenshot on `gemini-2.5-flash` and needs no
setup beyond the `GEMINI_API_KEY` the other AI helpers already use. Entries land
stamped `bk` so the ledger knows which rows came off a statement. One KV write
per month touched, however many rows you tick.

## Are you charging enough? (Money → pricing)
Every quote sent, against every job actually paid. A quote counts as **won**
when that phone paid for a job within 60 days of it, which lets the website
quote log — which tracks no verdict of its own — be scored alongside the texted
quote builder, which does. Then the only question that matters: does the win
rate fall as the price rises? If it doesn't, the price is too low.

Shows overall win rate, average quoted vs average won, win rate across three
price bands (terciles, so it works at any price point), a per-service
breakdown, and plain-English advice. The advice is deliberately conservative:
it stays quiet under ~10 quotes, and it never proposes a number it can't
justify from the win rate it just measured. **No AI** — this is arithmetic, and
arithmetic shouldn't cost a token or be able to hallucinate a price.

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

## Quote history (Analytics → Quotes)
Every QQC submission that reaches `/submit` (or `/qqc-text`) is now also appended
to a **quote log**, so you can see what came in over time instead of digging
through Web3Forms emails. Open **Analytics → Quotes**: KPI tiles (quotes sent,
total quoted, average quote, how many booked a time), a quotes-per-month bar
chart carrying each month's dollar total, and the full list — over a 3 / 6 /
12-month window, plus **Export CSV**.

Why it's a separate log: a quote used to be recorded only in the customer's
thread notes, and only when those notes were still empty — so a repeat
customer's second quote left no trace anywhere but email. Storage mirrors the
money tracker (`quotes:m:YYYY-MM`, one doc per month), so a new quote costs a
single KV write and a year of history is 12 small reads.

**One-time backfill.** Quotes from before this log exist only as Web3Forms
emails. `docs/qqc-backfill-2026.json` reconstructs 2026-05-08 → 2026-08-08 (25
real quotes, $6,954 — tests and double-fires already stripped) from those
subject lines. Import it once, signed in to the dashboard:

```
curl -X POST https://texting.mikeysdetailingsnohomish.workers.dev/api/quotes/import \
     -H 'Content-Type: application/json' --data @docs/qqc-backfill-2026.json
```

Re-running it is safe — the same phone + total inside 10 minutes is skipped as a
duplicate. Backfilled rows carry the date, name and amount only; vehicle,
condition and services lived in the email body and are left blank.

## Saw the price and left (the email you get about a lead that never existed)
Someone builds a quote on the site, reaches the estimate, and closes the tab
without leaving a name or number. Nothing else in this app can tell you that
happened — there's no thread, no phone, no row on any board. This emails you
when it does: the price they walked away from, what they'd picked, how they
found the site, and a link straight to their replay in **Analytics → Journey**.

Nothing is ever sent to them. They never gave you a number — the email says so.

**How it knows.** The marketing site already reports what people do
(`site-stats.js` → `/px/e`). Reaching the estimate is one of those events, so
the moment a visitor's batch carries it a watch is armed for that visitor id.
Two minutes later the minute cron either finds a phone on their journey (they
submitted — dropped, silently, because the NEW QUOTE alert already told you) or
sends the email. Filling in the form clears the watch outright.

**Two minutes of *silence*, not two minutes of clock.** Someone still tapping
around the page hasn't abandoned anything, so the wait restarts while they're
active — you don't get told they left while they're typing their name. After 30
minutes on one price it fires regardless.

**Settings** (☰ → the follow-up settings screen): *Email me when a quote is seen
but not sent*, and how long to give them (1–60 min, default 2).

**Cost.** One KV key (`quote:watch`, one small doc), read once a minute and
written only when the pending set actually changes — arming, clearing, firing.
A day with no quote views is 1,440 reads and zero writes. Switched off, not even
the read.

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
`/t/<token>` (live ETA page) `/p/<token>` (pay page) `/c/<token>` (the customer's
own page) `/api/track/state` `/api/cust/state` `/api/cust/action`
Auth: `/api/login` `/api/logout`
Dashboard API: `/api/health` `/api/threads` `/api/thread` `/api/send` `/api/meta`
`/api/schedule` `/api/unschedule` `/api/call` `/api/read` `/api/insights`
`/api/alert-test` `/api/templates` `/api/migrate`
`/api/followups` `/api/followup` `/api/config` `/api/block`
Quotes: `/api/quotes` `/api/quotes/export` `/api/quotes/import`
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
Bank scan: `/api/money/scan` `/api/money/scan/commit` ·
Money on the table: `/api/cold` `/api/cold/action` · Plans: `/api/plan` ·
Customer page: `/api/cust/link` · Pricing: `/api/pricing` ·
`/api/photos` `/api/photos/img` `/api/photos/delete` · `/api/brief`
