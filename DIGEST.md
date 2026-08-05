# Morning Rundown — the daily digest

Reddit + local news + your own business numbers → one email at 7am, plus a web
archive, an audio version, and a feedback loop that changes what tomorrow says.

**It no longer runs on Google Apps Script.** It runs inside this Cloudflare
Worker, next to the SMS dashboard, at
`https://texting.mikeysdetailingsnohomish.workers.dev/digest.html`.

## Why it moved off Apps Script

| It needed | Apps Script | Here |
|---|---|---|
| Your revenue, jobs, leads, bookings | Another product entirely | One KV read |
| One-tap Buy / Not for me / Remind me | No URLs to tap | Signed public routes |
| A web archive you can search | No hosting | `/digest.html` |
| Interrupts that don't wait for 7am | Hourly triggers, quota-limited | The minute cron already running |
| Text a note mid-job and have it count | Nothing to text | The Twilio number you already own |
| Long builds | 6-minute ceiling, quota roulette | No ceiling that matters |

Nothing was lost in the move: the per-topic summarization, the interleaving that
stops one subreddit filling a section, the seen-list, and the retry/backoff
fetching are all still here — see `src/digest-sources.js`.

## How it relates to the 6am daily brief

They are different things and both stay. The **daily brief** (menu → Settings,
`briefEnabled` / `briefHour`) is the business day ahead: push + email, first
thing. The **Morning Rundown** lands an hour later at 7am and is the long read —
your numbers, the weather over each job, and the outside world, filtered hard.
If you only want one, turn the other off in its own settings.

## Setup

Everything is already wired. Two things decide whether it can actually run:

| Secret | Needed for | Without it |
|---|---|---|
| `GEMINI_API_KEY` | Writing, cutting, the question of the day | No digest at all |
| `RESEND_API_KEY` + `ALERT_EMAIL` | Delivering it | Falls back to a text with a link |

Optional: connect the Google service account (Grow → Website, the same one GA4
uses) and you additionally get a Google Doc as the context doc, a Google Sheet as
the kit list, and real MP3 audio.

Then open **☰ → Morning rundown** and hit **Health → Run the check**. That tells
you, from the Worker's own network, whether Reddit, Google News, Open-Meteo,
Gemini and email are all reachable. Do that before waiting for a 7am that never
comes.

## What it does, feature by feature

### It knows you
- **Living context doc** — `About me`. Re-read fresh every morning; edit from
  your phone. Optionally pulled from a Google Doc instead (`googleDocId`).
- **Kit & opinions** — `My kit`. Deals are matched against gear you actually own,
  and a sale on something you own and hate is not news. Optional Google Sheet.
- **Standing orders** — `Rules`. Enforced as hard keyword filters *before* the
  model sees anything, so "never show me anything needing a compressor" stays
  true on days the model feels agreeable.
- **Don't-tell-me-again ledger** — a claim is fingerprinted as subject + its
  numbers. Same claim inside the cool-off window is suppressed; same subject with
  *different* numbers is promoted as news, tagged "Changed since …".
- **Question a day** — every issue ends with one. Answer by replying to the
  email, texting the business number, or in the app; it's appended to the context
  doc with the date.
- **Capture inbox** — text the business number from your own phone mid-job. It
  becomes tomorrow's context and is then folded permanently into the doc.
- **Per-topic context** — each topic carries its own briefing (your price list
  for detailing, your rank for Overwatch). Detailing can also be handed the
  business playbook automatically.
- **Voice calibration** — paste writing you like; it matches that register.
- **Behavioral context** — interests derived from the services you actually book
  and the money you actually log, not from a preferences screen.

### It doesn't lie to you
- **Verbatim number guard** — every price, percentage, measurement and model
  number in the write-up is checked back against the source text. Anything the
  source never said gets its whole sentence deleted, and an item that loses more
  than half of itself is dropped entirely. Every strip is logged in the run
  diagnostics.
- **Quote-backed claims** — each item carries an exact source sentence, verified
  by substring and then by in-order subsequence. Unverifiable quotes are removed.
- **Price-history verification** — "$79, but it hit $69 in March — $10 off the
  floor, so this isn't the bottom."
- **Contested rendering** — where sources disagree, both positions are shown side
  by side instead of being averaged into a fake consensus.
- **Absence detection** — recurring signals (the HF coupon drop, patch notes) are
  tracked, and a broken rhythm is reported: "nothing for 15 days (usually every
  ~7). First break in 2 weeks after 6 straight."
- **Source diversity quota** — no single subreddit may own more than N slots.

### It's readable
- **Editorial pass that only deletes** — a second model call whose sole job is
  cutting anything that won't change a decision this week. It is allowed to cut
  everything.
- **Hard length cap**, and "Nothing worth your time today" is a valid answer.
- **One hero + briefs** — the top item at full length, the rest short.
- **Same skeleton every day** — Your numbers → The plan → 30 seconds → One thing
  → Clock is running → Briefs → What didn't happen → Coming at you → Skill →
  Question. Sections never reorder and never vanish; empty ones say they're
  empty.
- **Reading time** at the top, **skim + full** in the same email.
- **Emoji headers off** → typography-led serif layout, for when you don't want it
  looking like a group chat.

### It closes the loop
- **Deadline + stakes chips**, sorted by expiry rather than excitement.
- **One-tap actions** — Buy / Not for me / Remind me Friday, straight from the
  email via signed, expiring links. Every tap is training data.
- **Reply in plain English** — "less Overwatch, more coatings" retunes tomorrow.
- **Feedback weights with decay** — a thumbs-down bends tomorrow hard and next
  month barely at all (14-day half-life), so one annoyed tap can't censor a topic
  forever.
- **Story continuity** — "Day 3 of the CQuartz price drop", tracked per entity.
- **Weekly rollup** — what mattered, what you acted on, and the actual scoreboard.

### It knows the business
- **Your numbers first** — month net, week gross, jobs today, booked tomorrow,
  unanswered leads, review pool. Above anything from the internet, every day.
- **Weather-conditional scheduling** — "2:00 PM · Full Detail — Dana · 82% rain,
  66°F, wind 7 mph · That is a wash-out for exterior work — move it or call them
  today." Judged per job, over that job's actual hours, and interior work isn't
  judged on weather at all.
- **Seasonal anticipation** — pollen, wildfire ash, rain, road salt, the spring
  rush and gift-card season, each warned about *before* it lands.
- **Sequenced skill drip** — one technique a day, in curriculum order.

### Delivery
- **Audio** — ~4 minutes, written for the ear. Your phone speaks it for free
  (offline, no data); a real MP3 is available if Cloud Text-to-Speech is enabled
  on the connected Google project.
- **Breaking interrupt** — checks hourly at :20, only topics you flag, only fresh
  posts, quiet overnight, capped per day.
- **Web archive + search** — every issue kept and searchable by product name.

## Talking to it from your phone

Texting your own business number already means something on this dashboard — it
runs the **assist loop**, where "375, thursday works" becomes a reply to whoever
texted you last. So the rundown only claims texts that start with a `#`, and
everything else goes to the assist loop exactly as before:

| You text | What happens |
|---|---|
| `#note ran out of drying towels` | Captured into tomorrow's context |
| `#answer $260 for a three-row interior` | Answers the question of the day, appended to the context doc with the date |
| `#tune less Overwatch, more coatings` | Retunes tomorrow's rundown |
| `375, thursday works` | Untouched — still the assist loop |

**Replying to the rundown email needs no prefix.** Those replies carry no
`[ref:…]` marker, so the assist loop ignores them and the rundown reads them
directly — it works out on its own whether you're answering the question,
retuning, or dropping a note. (Needs the Gmail → `/email-in` hookup that the
answer-by-email feature already uses.)

## Endpoints

Authed (dashboard password): `/api/digest/state` `/config` `/context` `/kit`
`/orders` `/capture` `/ingest` `/run` `/archive` `/doc` `/audio` `/feedback`
`/retune` `/selftest` `/reset` `/weekly` `/breaking`

Public: `/d/a/<signed token>` — the one-tap buttons. HMAC-SHA256 over the
payload with a per-install secret, 45-day expiry. Worst case a leaked link nudges
a topic weight.

## Cost and limits

- **KV writes:** ~8 on a normal day (the digest, its archive entry, and the five
  memory docs). Hourly breaking checks read but never write unless they fire.
  The Worker's shared free-tier budget is 1,000/day — see the banner at the top
  of `src/index.js`.
- **CPU:** measured at ~7 ms per build against the test fixture set; expect
  roughly 3–5× that against full live feeds. That is comfortable on **Workers
  Paid** (30 s per invocation) and will exceed **Workers Free** (10 ms). If you
  ever see "Exceeded CPU" in `wrangler tail`, turn down `perSub`,
  `commentPosts` and the number of enabled topics in Settings.
- **Gemini:** one call per enabled topic, plus the editorial pass, the question
  and the audio rewrite — roughly 10 calls a day.
- **Reddit:** no key, no OAuth. Three source tiers per subreddit
  (www RSS → old RSS → JSON), because Reddit refuses some datacenter ranges and
  a Worker is about as datacenter as it gets. The self-test tells you which tier
  is answering.

## Testing

```
npm test          # the whole repo suite, including 72 rundown tests
                  # (no network, no model, no deploy)
npm run build:check
```

The suite runs the real pipeline end to end against fake KV, fake fetch and a
fake model that deliberately invents a price and fabricates a quote, so the
verbatim guard and quote check are proven to catch them. Live source
reachability is the one thing it can't cover — that's what
**Health → Run the check** is for, and it runs from the Worker itself.

## Files

```
src/digest.js          config, context/kit/orders, business data, the build
                       pipeline, breaking interrupt, weekly rollup, cron,
                       signed action tokens
src/digest-sources.js  Reddit (3 tiers), RSS/Atom, Google News, Open-Meteo
src/digest-verify.js   number guard, quote check, ledger, entity/price memory,
                       absence detection, weights — all pure functions
src/digest-render.js   the email (HTML + text) and the audio script
src/digest-api.js      HTTP routes, one-tap action pages, self-test
public/digest.html     the console
test/                  fixtures, fakes, and the suite
```
