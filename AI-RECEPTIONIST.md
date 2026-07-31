# AI Receptionist — feasibility, cost, and plan

An honest assessment of adding an AI that **answers the phone** for Mikey's Mobile
Detailing, given what this repo already does today. Written for a low budget.

---

## 1. What you already have (this matters more than you think)

Building a voice AI agent is normally 5 pieces of work. You have already done 4 of
them, for the *text* side, and they are all reusable:

| Piece | Status | Where |
|---|---|---|
| **The brain** — what the business does, prices, area, hours, FAQs, tone, real example texts, how to handle 7 tricky situations | ✅ Written and good | `defaultPlaybook()`, `src/index.js:3727` |
| **The memory** — every customer is a KV thread with history, notes, lead status, tags | ✅ Done | `loadThread` / `saveThread` |
| **The hands (booking)** — real availability engine with per-service, per-vehicle-size durations, buffers, max 2 jobs/day, Google Calendar busy-check, double-book protection | ✅ Done | `bkAvailability()`, `src/index.js:4446` |
| **The hands (everything else)** — send SMS, schedule a text for later, write notes, set lead status, email you an alert, auto follow-up engine | ✅ Done | `sendSms`, `notifyMikey`, follow-up engine |
| **The ears and mouth** — hearing the caller and talking back | ❌ Missing | this doc |

The expensive, tedious part of an AI receptionist project is #1 and #3 — teaching it
the business and giving it a real calendar to book against. Most people building this
from scratch spend weeks there. **You are only missing the phone-audio layer.** That
changes the math a lot and is the main reason this is worth considering at all.

Your current phone flow (`src/index.js:444-540`):

```
Call comes in  →  blocked number? → reject
               →  press-1 screening gate (kills robodialers)
               →  ring Mikey's cell for 20s
               →  no answer → missed-call text-back + voicemail + transcription
```

The AI would slot into exactly one place: **where voicemail is today.**

---

## 2. The three ways to build it

### Option A — "Ask-and-listen" agent inside your existing Worker  ⭐ recommended

Uses Twilio's `<Gather input="speech">`. The AI asks a question out loud, the caller
answers, Twilio transcribes it and POSTs the text to your Worker, Gemini decides what
to say next, the Worker replies with `<Say>`. Repeat 3–5 times, then hang up.

- **New services needed: none.** Twilio + Gemini + Cloudflare — all already wired up.
- **Feels like:** a good, natural IVR. There is a ~1.5–3 second pause after the caller
  stops talking. It does not feel like a human. It does feel competent.
- **Can it book?** Yes — it can call `bkAvailability()` and `apiBook()` directly,
  in-process. Same slots the website offers, same double-book protection.
- **Build:** ~8–14 hours of work. Realistically **1–2 weeks part-time**.
- **Cost:** roughly **$0.10–0.15 per call**, ~$6–12/month at 60 calls. No subscriptions.

### Option B — Real-time streaming via Twilio ConversationRelay

Twilio streams live audio over a WebSocket to your server; the AI can interrupt and
be interrupted. This is what "sounds like a real person" means.

- **Feels like:** a real conversation, ~600ms response, barge-in works.
- **Problem:** a Cloudflare Worker can't comfortably hold a live WebSocket for a
  whole call. You'd need **Durable Objects**, which is a genuinely different
  programming model, plus audio buffering, interruption handling, and reconnects.
- **Build:** 25–40 hours. **4–6 weeks part-time**, and it's the hardest code in the repo.
- **Cost:** ~$0.07/min ConversationRelay + $0.0085/min Twilio voice + LLM tokens
  + likely $5/mo Workers Paid → **$20–30/month** at 150 minutes.

### Option C — Buy it (Vapi / Retell / Synthflow / Bland)

Point your Twilio number at a third-party voice-agent platform. Paste your playbook
into their prompt box. At the end of the call, have them POST to your existing
`/submit` endpoint — which already creates the lead, writes the notes, alerts you, and
schedules the follow-up text. That integration is genuinely ~2 hours.

- **Feels like:** the best of the three. These are tuned for this.
- **Build:** **1–3 days**, mostly prompt tuning.
- **Cost:** $0.09–0.36/min all-in, and several charge a platform fee on top
  ($29–$299/mo). Realistically **$25–70/month**.
- **Downsides:** a second dashboard and a second vendor; booking against your real
  availability requires exposing a webhook they can call (doable, more plumbing);
  you're renting, not owning; prices on these platforms move.

---

## 3. The money, in detail

Twilio's US rates (verify on your own pricing page — the speech-recognition line is
the one that actually drives your bill):

| Line item | Rate | Notes |
|---|---|---|
| Phone number | $1.15/mo | already paying |
| Inbound voice | ~$0.0085/min | already paying |
| **Speech recognition** (`<Gather input="speech">`) | **~$0.02 per gather** | the big one for Option A |
| Neural TTS (`<Say>` Polly neural) | ~$0.0032 / 100 chars | basic voices are free but sound worse |
| Recording transcription (voicemail) | ~$0.05/min | you **stop paying this** if AI replaces voicemail |
| Gemini 2.5 Flash | fractions of a cent per call | negligible at your volume |
| Cloudflare Workers + KV | $0 | free tier, you're nowhere near it |

**Option A, one 2-minute call with 4 questions:**

```
4 speech gathers        4 × $0.020  = $0.080
TTS, ~600 characters                = $0.019
Inbound voice, 2 min                = $0.017
Gemini                              = $0.002
                                     -------
                                      $0.118  per call
```

| Calls/month | Option A | Option B | Option C |
|---|---|---|---|
| 30 | **~$4** | ~$12 | ~$30–45 |
| 60 | **~$8** | ~$18 | ~$40–60 |
| 120 | **~$15** | ~$30 | ~$60–100 |

Subtract what you already spend on voicemail transcription (~$0.05/min) — at 60
missed calls a month that's ~$3 back. **Option A's true added cost is roughly $5/month.**

---

## 4. Pros

1. **You stop losing after-hours and hands-busy leads.** Most people who reach
   voicemail hang up without leaving one. Your missed-call text-back already
   recovers some of that — an AI that actually *answers* recovers more.
2. **Structured intake, free.** Your own playbook lists exactly what a new customer
   needs to be asked: year/make/model, address or zip, interior/exterior/full,
   condition, timeframe. The AI can get all five and write them into the thread notes
   before you ever look at your phone.
3. **It can genuinely book** — you have a real availability engine, not a fake one.
   That's the difference between an AI receptionist and an expensive answering machine.
4. **Everything downstream already works.** A voice-created lead lands in the same
   KV thread, gets the same status, the same notes, the same email alert, the same
   auto follow-up nudges. You're adding a door to a house that's already built.
5. **Cheap to try and cheap to undo.** Option A is one function in `src/index.js` and
   a config toggle. If you hate it, flip it off and voicemail comes right back.
6. **Works Sundays.** You don't work Sundays. It does.

## 5. Cons — read these carefully

1. **It fights your brand.** Your playbook's first line is *"It's always Mikey
   himself: personal, friendly work that's tailored to you."* An AI picking up the
   phone is the single most literal contradiction of that sentence. For a national
   chain nobody cares. For a local owner-operator whose whole edge is that you get
   *Mikey* — some customers will hold it against you.
2. **A bad AI text is private; a bad AI call is not.** Today, Gemini drafts your
   replies and *you* approve them before they send. On a phone call there is no
   approval step. Whatever it says is said, live, to a stranger, in your name.
3. **Your own rules make it less useful.** The playbook says *"Never promise an exact
   price or exact appointment time on your own."* If you hold the AI to that, it can
   only take a message — which is nearly what voicemail already does. To get real
   value you have to **let it quote from the booking price table and book real slots**,
   which means loosening the rule you wrote for good reasons.
4. **Speech recognition is the wildcard.** Somebody calling from a driveway, next to a
   highway, with a Bluetooth mic, saying "twenty-nineteen Silverado fifteen-hundred" —
   transcription will get this wrong sometimes. Every wrong transcription is a wrong
   price or a wrong booking.
5. **Option A sounds like a phone tree.** Manage your expectations. If you want it to
   sound human, that's Option B or C, and 3–10× the cost and effort.
6. **Volume may not justify it.** A solo mobile detailer booking a week out gets a
   handful of calls a day. If the AI handles 40 calls a month and 30 of those would
   have texted you anyway, you built a lot for 10 leads.
7. **Keep the press-1 gate in front of it.** Your screening gate is what stopped the
   robocall flood. If the AI answers *everything*, you will pay speech-recognition
   fees to talk to auto-dialers. This is a real, easy-to-make, expensive mistake.

---

## 6. The recommended build — "AI intake instead of voicemail"

Not a full receptionist. A narrow one. It **never** talks to anyone who could have
reached you live, so it cannot embarrass you on a call you would have taken.

```
Call comes in
  → blocked?                    reject          (unchanged)
  → press-1 screening gate                      (unchanged — keeps spam out)
  → ring Mikey's cell 20s                       (unchanged — you always get first shot)
  → you answered?               done            (unchanged)
  → you DIDN'T answer:
        ┌─────────────────────────────────────────────┐
        │  NEW: AI intake, instead of "leave a message"│
        └─────────────────────────────────────────────┘
  → still writes to the thread, alerts you, texts the caller  (unchanged)
```

### What it says

1. *"Hey, it's Mikey's Mobile Detailing — Mikey's under a car right now, but I can
   get you taken care of. What's the year, make and model?"*
2. *"Got it. Are you after interior, exterior, or the full in-and-out?"*
3. *"And what city are you in?"*
4. Reads the real price from the booking table + offers two real open slots from
   `bkAvailability()`.
5. *"I've got you down — Mikey will text you to confirm."* → creates a **pending**
   booking (you already have a pending/confirm workflow, so you approve every one).

If speech recognition fails twice, it falls straight back to today's voicemail.
No dead ends.

### Build order

| Step | Work | Time |
|---|---|---|
| 1 | `/voice-ai` route: `<Gather input="speech">` loop, 4 turns max, state in KV keyed by CallSid | 3–4 h |
| 2 | Gemini turn handler — reuse the playbook prompt builder that already exists | 2–3 h |
| 3 | Wire in `bkAvailability()` + create pending booking, reuse `apiBook`'s guts | 2–3 h |
| 4 | Fallback to voicemail on 2 failed gathers; hard 5-turn cap so no runaway bills | 1 h |
| 5 | Dashboard toggle (`aiReceptionist: false` in config, off by default) + transcript in the thread | 2 h |
| 6 | Test on your own phone, 20+ calls, tune wording | 3–4 h |
| | **Total** | **13–17 h → 1–2 weeks part-time** |

### Guardrails to build in from day one

- **Off by default**, one toggle in the ☰ menu, same as `callScreening`.
- **Hard cap of 5 turns per call** and a max call length — this is your spend limit.
- **Never confirms a booking** — only creates `pending`, which you approve. You
  already built that workflow; use it.
- **Only quotes prices that exist in the booking price table.** No AI-invented numbers.
- **Full transcript into the thread** so you can see exactly what it said.
- **Stays behind the press-1 gate.** Non-negotiable.

---

## 7. Verdict

**As a full AI receptionist that answers every call: 4/10.** Don't. It's expensive
relative to your volume, it undercuts the exact thing you sell, and your press-1 gate
+ missed-call text-back already solve most of the problem.

**As a narrow "AI intake agent that replaces voicemail": 8/10. Worth doing.**

The reason is specific to you and wouldn't apply to most businesses: **you already
built the hard 80%.** The playbook, the availability engine, the pricing table, the
lead pipeline, the follow-ups, the notifications — all done. Adding voice is one more
front door onto a house that's already furnished. For anyone else this is a
month-long project; for you it's a couple of weekends and about **five dollars a month**.

Two things make it a clear win instead of a toy:

1. It replaces a voicemail that most callers hang up on, so the bar it has to clear
   is very low.
2. It only ever runs when you *didn't* answer — so the personal-service brand promise
   stays intact for every call you actually take.

**Do it as Option A, scoped as above, toggled off by default. Skip Options B and C
until you've run Option A for two months and can see from real transcripts whether
the calls justify spending 5× more to make it sound human.**

### If your budget is truly $0

Do nothing to the phone. Instead spend two hours making the *missed-call text-back*
smarter — have it ask the three intake questions **by text**, and let the existing
Gemini reply-drafting handle the answers. Text costs $0.0083 a message instead of
$0.02 a question, you already own every piece of it, and for a business that books by
text anyway it may honestly convert better than a phone call.
