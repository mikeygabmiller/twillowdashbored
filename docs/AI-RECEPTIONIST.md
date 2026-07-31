# AI Receptionist — should Mikey's Detailing do it?

**Written:** July 2026 · **Scope:** what it would take to have an AI answer the phone,
using the system already running at `texting.mikeysdetailingsnohomish.workers.dev`.

Plain-English throughout. Numbers are current as of July 2026 and cited at the bottom.

---

## 1. The short version

You are **further along than you think.** The expensive, slow part of building an AI
receptionist — the business brain, the booking engine, the CRM, the alerting, the
opt-out ledger — **is already built and running.** What's missing is only the *voice*
layer: turning speech into text, letting the AI talk back, and doing it fast enough
that it doesn't feel like a robot.

But there's a catch specific to *your* business: **detailing prices depend on seeing
the car.** Your own playbook says the photo is the quote. A voice AI can't see a car.
So the AI receptionist can't do the one thing that closes your deals — it can only
catch the lead and hand it to you. That's still valuable, just not as valuable as it
sounds on the sales pages.

**Bottom line up front:** worth doing, at low budget, **in stages** — and the
cheapest stage delivers most of the value.

---

## 2. What you already have (this matters a lot)

| Piece | Status | Where |
|---|---|---|
| Business phone number + carrier | ✅ Twilio, live | `TWILIO_FROM` |
| Inbound call webhook | ✅ Live | `/call` → `handleInboundCall()` |
| Spam gate (press-1 screening) | ✅ Live | `/call-screen` |
| Block list | ✅ Live | `cfg.blockedNumbers` |
| Voicemail + auto-transcription | ✅ Live | `/voicemail`, `/voicemail-tx` |
| **Missed-call instant text-back** | ✅ Live | `handleVoicemail()` |
| The AI "brain" (services, prices, area, FAQs, tone, scenarios) | ✅ Live, filled in | `defaultPlaybook()` |
| AI reply drafting, grounded in the brain | ✅ Live | `generateReply()`, `maybeSuggestReply()` |
| Booking engine with real availability | ✅ Live | `/api/availability`, `apiBook()` |
| Follow-up engine + autopilot | ✅ Live | `evaluateFollowups()` |
| Free owner alerts (email via Resend) | ✅ Live | `notifyMikey()` |
| STOP/START opt-out ledger | ✅ Live | `setOptOut()` |
| **A voice that talks to callers in real time** | ❌ **This is the whole project** | — |

Read that table again. A company selling you a $99/month AI receptionist is selling
you a knowledge base + a booking link + a voice. **You have two of the three, and
yours are better** — because your booking engine knows your actual Wed–Sat afternoon
schedule and your brain knows your actual pricing and how you talk.

---

## 3. What "AI receptionist" actually means — three very different products

People use one phrase for three things with wildly different prices and effort.

### Level 1 — "Smart text-back" (what you have, plus tuning)
Caller rings, you don't pick up, they instantly get a text, and your AI drafts your
reply. **Cost: $0 extra. Effort: 1–2 hours of tuning.** You have this today.

### Level 2 — "AI voicemail concierge"
Instead of "leave a message," the AI *listens* to their voicemail, pulls out the
vehicle, the city, and what they want, files it as a lead with a status, and texts
them back a personalized message that starts the real conversation. No live
back-and-forth — the caller talks, then the AI acts.
**Cost: pennies/month. Effort: a few hours.** ~85% of the value, ~5% of the risk.

### Level 3 — "True AI receptionist"
A real-time conversation. The AI answers, greets them, asks about the vehicle,
checks your actual calendar, offers "Thursday at 2 or Saturday at noon," books it,
and texts a confirmation — all while the caller is on the line.
**Cost: $5–$50/month. Effort: 1–3 weeks.** This is what the rest of this doc prices out.

> Most people who ask for Level 3 are actually happiest with Level 2. Keep that in mind.

---

## 4. Level 3 in detail: the three ways to build it

### Option A — DIY on Twilio ConversationRelay (cheapest per minute)
Twilio handles the hard real-time audio parts (speech-to-text, text-to-speech,
interrupting, latency) and opens a WebSocket to *your* Worker. Your Worker feeds the
conversation to Gemini using the playbook you already wrote, and can call your
existing `bkAvailability()` and `apiBook()` functions as tools.

- **Per minute:** $0.07 (ConversationRelay) + $0.0085 (inbound call) + ~$0.005 (Gemini) ≈ **$0.084/min**
- **Pros:** cheapest at any volume; the AI uses *your* brain and *your* real calendar
  with no syncing; transcripts land straight in the customer's existing thread; you own it forever.
- **Cons:** most work; you maintain it; needs a WebSocket handler + Durable Object,
  which likely pushes you onto the **Workers Paid plan ($5/mo)**.

### Option B — Vapi or Retell (fastest to a working phone AI)
A hosted voice-agent platform. You paste your playbook in, point your Twilio number
at them, and add a webhook back into your Worker to create the lead and the booking.

- **Per minute:** roughly **$0.10–$0.15 all-in** at sane model/voice choices
  (both bill modularly: platform + speech-to-text + LLM + voice + telephony).
- **Pros:** working in an afternoon; better out-of-the-box voice quality and
  interruption handling; no infrastructure to babysit.
- **Cons:** ~50–75% more per minute; your business brain now lives in two places and
  can drift; booking requires webhook glue; you're renting, not owning.

### Option C — Turnkey receptionist service (Rosie, Goodcall, Smith.ai)
Buy it off the shelf.

- **Price:** Rosie from **$49/mo** flat with unlimited minutes; Goodcall **$59–79/mo**;
  Smith.ai AI-only **$97.50/mo** (human backup $292.50/mo).
- **Pros:** zero engineering; someone else's problem when it breaks.
- **Cons:** most expensive; **won't touch your booking engine or your dashboard**,
  so leads land in *their* system and you're back to copying things over — which
  undoes the main reason your dashboard exists.

---

## 5. Real cost math for *your* volume

Nobody quotes AI receptionists honestly because it all depends on minutes. So here
are three scenarios. A detailing call that the AI actually handles runs **2–3 minutes**.

| Monthly volume | DIY (Option A) | Vapi/Retell (Option B) | Rosie flat (Option C) |
|---|---|---|---|
| **Light** — 20 calls, ~50 min | **$4.20** | $6.50 | $49 |
| **Realistic** — 50 calls, ~150 min | **$12.60** | $19.50 | $49 |
| **Busy season** — 120 calls, ~360 min | **$30.24** | $46.80 | $49 |

**Add to any row (things you already pay or would start paying):**

| Line item | Cost |
|---|---|
| Twilio phone number | ~$1.15/mo (already paying) |
| Cloudflare Workers Paid — needed for Option A's WebSocket/Durable Object | **$5/mo** |
| Gemini API — text LLM only, tiny at this volume | ~$0–1/mo (free tier may cover it) |
| Resend email alerts | $0 (free tier, already using) |
| SMS confirmations the AI sends | ~$0.008 each, pennies |

### So, realistically:
- **Option A, realistic volume: ~$18/month all in** ($12.60 usage + $5 Workers + number).
- **Option B, realistic volume: ~$21/month all in**, and you skip ~15–20 hours of work.
- **Option C: $49–79/month**, and it doesn't talk to your dashboard.

**That $3/month gap between A and B is the single most important number in this
document.** Building it yourself saves you about **$36 a year** and costs you weeks.
Unless you *want* to own it (which is a legitimate reason), **Option B is the rational
low-budget choice** — right up until you're doing 500+ minutes a month, where DIY
starts pulling meaningfully ahead.

---

## 6. How long it takes

Honest estimates, including your testing time — not just coding.

| Stage | Build time | Your time | Calendar time |
|---|---|---|---|
| **Level 1** — tune missed-call text + playbook | 1–2 hrs | 1 hr | Same day |
| **Level 2** — AI voicemail concierge | 4–8 hrs | 1–2 hrs testing | 2–3 days |
| **Level 3 via Vapi/Retell** (Option B) | 3–6 hrs setup + 4–6 hrs webhook glue | 3–5 hrs of test calls | **~1 week** |
| **Level 3 DIY** (Option A) | 15–25 hrs | 5–8 hrs of test calls | **2–3 weeks** |
| Tuning after it's live (any option) | ongoing | ~1 hr/week for a month | first month |

**Don't skip the tuning month.** The first version of any voice AI mishears city
names, talks too long, and says something slightly wrong about pricing. You find that
by listening to real calls, not by planning.

---

## 7. The honest case FOR doing it

1. **You genuinely can't answer.** You're solo, elbow-deep in someone's back seat,
   Wed–Sat afternoons. Calls to a detailer *do* go unanswered — that's not a
   hypothetical inefficiency, it's your Tuesday.
2. **A missed lead costs $130–$260+.** If the AI saves even **one job a month**, it
   pays for itself ~10x over at $18/month. The math is not close.
3. **Nights and weekends are free money.** Someone calling at 9pm currently gets
   voicemail. An AI can book them into Thursday afternoon while you're asleep.
4. **Your brain is already written.** The playbook, FAQs, and scenarios in
   `defaultPlaybook()` are unusually good and specific. Most of the work people pay
   for is exactly this, and you already did it.
5. **It plugs into a real calendar.** Options A and B can read `bkAvailability()`
   and write through `apiBook()` — so the AI books a slot that's *actually* open,
   into the system you already look at. Off-the-shelf services can't do that.
6. **It kills the last of the spam problem.** Your press-1 gate already stops
   robodialers; an AI that handles the humans means your phone only rings for calls
   worth interrupting a detail for.

## 8. The honest case AGAINST

1. **⚠️ Voice can't quote your work.** This is the big one. Your pricing depends on
   the vehicle's condition, which is why photos drive your quotes. On a call, the AI
   has to say "I'll confirm the exact price once Mikey sees a photo" — which means
   **every AI call still ends with a text conversation you handle.** The AI shortens
   the path; it doesn't remove you from it.
2. **You already capture most missed calls.** Your missed-call text-back plus AI
   drafts already converts a missed call into a live text thread. The AI receptionist
   is competing against *that*, not against nothing. The honest incremental gain is
   smaller than the marketing implies.
3. **Personal service is your actual product.** Your playbook's whole pitch is
   "it's always Mikey himself." A customer who calls and gets a bot has been told
   something about your business that you may not want to say. This risk is real but
   manageable — an AI that opens with *"Hi, this is Mikey's AI assistant — Mikey's
   under a car right now, but I can get you booked"* reads as competent, not cold.
   An AI pretending to be Mikey reads as a lie the moment they meet you.
4. **⚖️ Washington is an all-party consent state** (RCW 9.73.030). If you record or
   transcribe calls — and every voice AI does — **you must announce it at the start of
   the call, on the recording.** This is a genuine legal exposure and a one-line fix.
   Do not skip it. Separately, AI-disclosure rules for automated callers are
   tightening in several states; disclosing that it's an AI is both honest and the
   safe side of where the law is heading.
5. **It's a new thing that can break at 9pm on a Saturday.** Today, if the AI layer
   dies you get voicemail. That's a fine failure mode — but only if you *build* that
   fallback deliberately. (See §9.)
6. **Your KV write budget is already tight.** Your own audit flags a ~1,000
   writes/day discipline on the free tier. Live call transcripts are chatty. If you
   write every AI turn to KV, you will blow through it. Write **once at the end of
   the call**, not per turn.
7. **Low volume undercuts the ROI story.** At 20 calls a month, you're automating
   something that takes you maybe 40 minutes total. Do this because it catches leads
   you're *losing*, not because it saves you time — the time savings are small.

---

## 9. If you do it: the guardrails that make it safe

These are non-negotiable, and they're cheap:

1. **Never let the AI confirm a price.** Your playbook already has this golden rule.
   Carry it into the voice prompt verbatim: *starting at* prices only, exact price
   after Mikey sees the car.
2. **Never let the AI confirm a booking as final.** Have it hold a slot as
   `pending` — exactly what `apiBook()` already does — and text you for approval.
   Your existing booking flow already works this way. Don't change it.
3. **Announce recording, and announce it's an AI.** First sentence. Legally required
   in WA, and it defuses the "you got a robot" reaction.
4. **Keep a bail-out.** Any confusion, any frustration, any "can I just talk to
   Mikey" → the AI says "let me get him a message right now," takes a voicemail, and
   texts you. A receptionist that knows when to quit beats a clever one that doesn't.
5. **Fail back to what works.** If the AI layer errors or times out, the TwiML must
   fall through to your current voicemail flow. Never a dead line.
6. **Hard budget cap.** Set a monthly spend alarm in Twilio (and in Vapi/Retell if
   you use them). A loop or an abusive caller shouldn't be able to run up a bill.
7. **Keep the press-1 gate in front of it.** Do not let robodialers talk to your AI
   and burn paid minutes. Your screening gate already solves this — keep it first.
8. **Quiet-hours awareness.** Your config already has `quietStart`/`quietEnd`. The
   AI shouldn't promise a callback at 11pm.

---

## 10. The recommended plan (low budget, staged)

Each stage is useful on its own. **Stop whenever it's good enough** — that's the point
of doing it this way.

**Stage 1 — This week. $0.**
Tune what's live. Rewrite the missed-call text to ask the three questions that
actually matter (vehicle year/make/model, city, and "send me a photo"). Make sure the
voicemail greeting tells people texting is faster. *Measure how many calls you're
actually missing* — the dashboard has the data. **You need this number before spending
anything.**

**Stage 2 — Next week. ~$0/month.**
AI voicemail concierge (Level 2). The AI reads the transcription you're already
getting, extracts the vehicle/city/service, files the lead with the right status and
tags, and sends a personalized text back instead of a generic one. Uses only things
you already pay for. **This is the best value in the whole document.**

**Stage 3 — Only if Stage 1's number justifies it.**
Live AI answering via **Vapi or Retell** (Option B), pointed at a webhook into your
Worker so leads and pending bookings land in your dashboard. Budget **~$20/month** and
one week. Start it **after-hours and weekends only** — that's where the free money is
and where a mistake costs you least. Expand to daytime overflow only once you've
listened to a few weeks of real calls.

**Stage 4 — Only at real volume.**
If you're consistently past ~500 AI minutes/month, port it to DIY ConversationRelay
(Option A) to cut the per-minute cost and pull the brain back into one place.

---

## 11. Overall rating

### Building a full AI receptionist right now: **6.5 / 10**
Good idea, oversold. The economics work and the infrastructure is 70% built, but for
a mobile detailer whose quotes require photos, voice AI can't close — it can only
catch. And you already catch most of it with missed-call text-back.

### Doing it in stages, starting with the voicemail concierge: **9 / 10**
This is the right move. Nearly all of the upside, almost none of the cost, none of the
brand risk, and it's built on parts you already own and understand. If Stage 1's
numbers show you're bleeding calls, Stage 3 at $20/month is an easy yes on top of it.

### What I'd actually do in your shoes
Do **Stage 1 and Stage 2 now.** They're cheap, fast, and low-risk. Then run for a
month and count: *how many real customers called and didn't end up in a text thread?*

- **Under ~5/month** → stop. You're not losing enough to justify a voice AI. Put the
  effort into the booking page and reviews instead.
- **Over ~10/month** → do Stage 3 with Vapi or Retell, after-hours only, for ~$20/month.
  At $130–$260 a job, catching three of those pays for the year.

**Don't build Option A from scratch first.** The $3/month it saves over Option B is
not worth weeks of your life. Build it later, if and when volume makes it worth it —
and by then you'll know exactly what your receptionist needs to say, which is the part
that's genuinely hard.

---

## Sources

- [Twilio Conversational AI pricing (ConversationRelay)](https://www.twilio.com/en-us/products/conversational-ai/pricing) — $0.07/min
- [Twilio Pricing](https://www.twilio.com/en-us/pricing) — inbound local voice $0.0085/min
- [Vapi vs Retell vs Bland: true cost per minute (2026)](https://medium.com/@automation.labs/vapi-vs-retell-vs-bland-in-2026-the-true-cost-per-minute-578f38af3523)
- [Retell AI pricing per minute (2026)](https://www.cekura.ai/blogs/retell-ai-pricing-per-minute)
- [AI voice agent cost per minute 2026](https://ainora.lt/blog/ai-voice-agent-cost-per-minute-2026)
- [AI receptionist pricing guide 2026](https://agentzap.ai/blog/ai-receptionist-pricing-complete-cost-guide-2025) — Rosie/Goodcall/Smith.ai
- [Best AI receptionists for small business 2026](https://www.vellum.ai/blog/best-ai-receptionist-for-small-business)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Washington all-party consent: RCW 9.73.030

*Prices verified July 2026 — re-check before committing, this market moves fast.*
