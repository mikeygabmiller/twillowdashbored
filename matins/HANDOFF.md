# MATINS — handoff

A daily Catholic devotional. One build a day feeds two surfaces: an email to
subscribers and a public web archive with a shareable permalink. Everything is
anchored to the real Roman Catholic liturgical calendar.

Read this whole file before touching anything. Most of it is knowledge that
cost an evening to get.

---

## 1. Where things are

| | |
| --- | --- |
| Repo | `mikeygabmiller/twillowdashbored`, everything under `matins/` |
| Working branch | `claude/matins-devotional-handoff-arw9t3` |
| Merged so far | PR #85–#90 (initial build), **#91** (merged at `matins-11`), **#92** (merged at `matins-15`) |
| Open | Whatever is on the branch above and not yet in a PR — currently `matins-16`…`matins-18` |
| Live Worker | `matins` → https://matins.mikeysdetailingsnohomish.workers.dev |
| KV namespace | `DEVOTIONAL` = `2469221591314033a84969f0f5815e69` |
| Tests | `cd matins && npm test` — **50 passing** |
| Dry run | `npm run preview 2026-12-25 -- --offline` (sends nothing, needs no key) |

`matins/` shares nothing with the detailing SMS Worker (`texting`) at the repo
root. Different Worker, different KV, different deploy. **Never touch the root
`wrangler.toml` or `src/index.js`.**

### Build fingerprint

`matins/src/build.js` exports `BUILD`, returned by `GET /api/version`.
Currently **`2026-08-06·matins-18`**. Bump it on every change — it is the only
way to tell what is actually live.

---

## 2. How deploys actually work — read this twice

Cloudflare **Workers Builds** is connected to the repo. Its settings:

- Production branch: **`main`** → runs `npx wrangler deploy` (builds **and** deploys)
- Builds for non-production branches: **Enabled** → runs `npx wrangler versions upload`
  (**uploads a version without deploying it**)
- Root directory: `/matins` — if this is ever set to `/` it deploys the
  detailing SMS app instead. That happened once and created a duplicate Worker
  running the minute cron against live customer data.
- Build command: `npm install`
- API token is named "texting build token" — shared with the other project.
  Rotating it there breaks builds here.

**Consequences that bit us repeatedly:**

1. Pushing to the working branch **does not deploy**. It only uploads a
   version. The live URL keeps serving whatever was last deployed.
2. So `main` and the live Worker routinely disagree. Check
   `GET /api/version` — never `modified_on`, never the version list, never
   "I pushed it".
3. **Merge the PR *after* the last push, not before.** PR #91 was merged while
   it still pointed at `matins-11`; four later commits were stranded and needed
   a rebase and a new PR. This happened twice.
4. A version snapshots its bindings at upload time. A secret added *after* an
   upload is not in that version — which is why secrets appeared to vanish.

---

## 3. Configuration

### `matins/wrangler.toml` `[vars]` — edit in the file, not the dashboard

`wrangler deploy` overwrites dashboard plain-text Variables on every deploy.
Secrets survive; plain-text vars do not.

```
LLM_PROVIDER  = "gemini"
LLM_MODEL     = ""                        # blank → gemini-3.6-flash (confirmed to exist)
FROM_EMAIL    = "Matins <onboarding@resend.dev>"
REPLY_TO      = "mikeysdetailing4u@gmail.com"
SEND_PAUSED   = "0"                       # sending is ARMED
SEND_HOUR     = "5"   SEND_TZ = "America/Los_Angeles"
SITE_URL      = https://mikeygabmiller.github.io/matins
WORKER_URL    = https://matins.mikeysdetailingsnohomish.workers.dev
SITE_REPO     = mikeygabmiller/matins     SITE_BRANCH = main
```

### Secrets — Worker → Settings → **Variables and Secrets** (not Settings → Build)

`ADMIN_TOKEN`, `RESEND_API_KEY`, `LLM_API_KEY`, `TOKEN_SECRET`, `GITHUB_TOKEN`.

**State at last check:** the first four reach the Worker. **`GITHUB_TOKEN` does
not** — so the GitHub Pages archive cannot publish. Email still sends and the
issue is still readable on the Worker itself. The token may have been revoked
after being leaked into a URL earlier in the project's life.

### Two configuration bugs already fixed in code, but worth knowing

- **Trailing spaces in binding names.** `ADMIN_TOKEN ` and `RESEND_API_KEY `
  had a trailing space. Invisible in the dashboard table; matches nothing.
  `config.js` now trims binding names and reports any it had to trim as
  `bindingNameWarnings` in `/admin/status`.
- **Values pasted with their quotes.** `LLM_MODEL` was literally `"3.5"`.
  `config.js` now strips matching surrounding quotes from every env value.

### Crons

`wrangler.toml` declares **two**: `0 12 * * *` and `0 13 * * *` UTC. Both are
needed — the handler ignores any run whose local hour is not `SEND_HOUR`, and
the pair covers the daylight-saving shift. **Only `0 13` was visible in the
dashboard at last check.** In summer 13:00 UTC is 06:00 Pacific, `SEND_HOUR` is
5, so the handler skips and nothing sends until November. Verify both exist.

---

## 4. Non-negotiable rules baked into the code

1. **No fact from LLM memory.** Calendar from `romcal` (offline, pinned
   `3.0.0-dev.125`), readings from `cpbjr.github.io/catholic-readings-api`,
   scripture text only from a Douay-Rheims lookup **verified to be
   Douay-Rheims** before use.
2. **No NABRE / RSV-CE / Catechism text.** Readings appear as references plus a
   USCCB link. Catechism appears only as bare citations in the pre-vetted Q&A.
3. **Nothing generated ships unchecked.** `lib/safety.js` — deterministic
   tripwires plus a temperature-0 orthodoxy rubric. Flagged → dropped, the rest
   of the issue still sends. **Fails closed**: a checker error drops the block.
4. **Prayers and Q&A are never generated.** Hardcoded, pre-vetted, chosen by
   rotation, skip the safety pass by design.
5. **Only confirmed subscribers are ever emailed.** `activeSubscribers()` is the
   only recipient source. One-click unsubscribe plus `List-Unsubscribe`
   headers, HMAC-signed tokens.

### The one place scripture text is used

`lib/scripture.js` fetches the **full Douay-Rheims passage** (public domain) for
the epistle and the Gospel. That text is **never printed to a reader**. It goes
into the prompt so the reading summary — and now the reflection — can say what
happens without working from the model's memory, and it goes into the FACTS the
safety pass judges against so "asserts something not in the facts" is a real
test. **No passage text fetched → no retelling.** `hardRules({ mayRetell })` in
`lib/generate.js` has two forms and the loose one is unreachable otherwise.

---

## 5. How the writing is kept good

Orthodoxy is `safety.js`. Craft is `generate.js`, and it **fails soft** — a
tired phrase never costs the whole section.

1. **Exemplars** (`content/forms.js`) — few-shot holds register better than any
   adjective. **These are the product.** If the writing drifts, fix them before
   touching `lib/`.
2. **A named shape, rotated** — five forms, chosen by `pickForm` with a
   cooldown, deterministic by date.
3. **Drafts and a judge** (`lib/judge.js`) — each block written 2–3 times and
   compared. A comparison, not a score, so it needs no recalibration when the
   model changes. Fails soft.
4. **Tripwires** — dead phrases, throat-clearing openers, title-case headlines.
   A whole round tripping one is sent back with the fault named.

Recent opening sentences live in `rot:openings` and are fed back as ground
already covered. `npm run preview` prints the whole record: form, draft count,
the judge's reason, anything tired.

**The voice lives in one file**: `content/voice.js`. A change of editorial
direction is an edit there plus the exemplars — not a rewrite of the generator.

---

## 6. The owner's answers — `blueprint.html`, 53 of 59, 2026-08-07

These are decisions, not suggestions. Where the code already matches, it says so.

### The reader
- **18–24**, works with his hands.
- **Practice 5/5** — daily Mass when the shift allows, confession about monthly.
- **Catechesis: solid** — reads, knows the arguments. Do not define terms for him.
- **Written for men.**

### Voice *(all applied in `content/voice.js`, `matins-18`)*
- **Observed, not accusing** — "most men have…" beat "you have…". Pointing at
  the reader scored **2/5**. Third person is the default; a direct "you" is
  rationed.
- **Blunt about confession**, with a deadline.
- **Ordinary imagery, not trade imagery** — "before you start the day" beat
  "before the engine turns over". The old rule *demanded* trucks; the new rule
  forbids reaching for them.
- **Formality 5/5** — "how a good homily is written down", not truck-cab talk.
- **Dry humour allowed**; jokes not.
- **Banned phrases added:** `lean in`, `on fire for the Lord` (plus `hustle and
  bustle` and `dear friend`, already banned).

### The reflection *(applied)*
- 4–6 sentences.
- **Two openings only**: the reasonable objection, or straight into the Gospel.
  Three forms that opened otherwise were **retired**.
- **Ends on a turn** toward the reader ("reflect today on…"). Not a closing
  prayer line — that was removed.
- **Generated always**; the bank is exemplar material only.
- **May retell the Gospel**, from the Douay-Rheims text only.
- Feelings: **hedged only** ("you may find…").

### Doctrine
- Sin, hell, judgement, confession: **often and by name**. The safety rubric was
  loosened to allow it — plain speech about sin is explicitly not a failure of
  the "do not shame the reader" test.
- **Disputed questions**: name that it is disputed, give both sides, take none.
- Liturgically **balanced** (3/5).
- Devotions wanted: **Rosary, Divine Mercy, fasting and mortification**.
- **Marian content 5/5** — a thread through most issues.
- **Review: just him.** Nothing hand-written gets another pair of eyes.

### Structure
- Blocks that earn their place: readings, reflection, saint + one thing, three questions.
- **Wants added**: *who is patron of what* (a line a day), and *what the Church
  asks of you today* (fast, feast, obligation).
- **Verse first** *(applied)*.
- **"One thing today" gets its own block, every day**, saint or not.
- Three questions a day, about **objections a Protestant or atheist would
  raise** and **practical practice** (fasting, obligation, confession).
- Three minutes total.

### Design
- Liturgical colour, warm cream, no imagery, web is an archive, nobody prints it.
- **Serif for scripture and prayers, sans for everything else** — currently
  serif throughout.
- Density **4/5 airier**.
- **Name and mark both open** — "Matins" and the arch are not settled.

### Rhythm
- Every day, **Sunday a bigger issue** (5/5 on differentiation).
- 5am is right.
- **Lent and Advent 5/5 different** — currently only the colour changes. This is
  the biggest single gap between what was asked for and what exists.
- **Triduum stripped back** — almost nothing but the day itself.
- No streaks, no catch-up, no guilt.

### Reach
- **Forty people he knows**, but build-for-growth **4/5**.
- Donation link eventually. **Anonymous.** **Readers are not to be told a model
  helps write it** — his call, made with the trade-off spelled out.
- Weak day → a shorter issue with a section missing.
- A year from now he wants a reader saying: *"I love getting something to think
  about each day and new prayers that I have never heard of. I also know what
  Saint is the patron of what so much better."*

### Two things he did NOT answer — do not assume
- Who this is **not** for.
- The first A/B pair (spare vs. fuller texture) — skipped.
- Words that **do** belong; a writer/priest whose register is close.
- Which block would go first if one had to.
- What would make him shut it down.

### One live contradiction, unresolved
He did **not** tick *Verse of the day* or *Prayer* as blocks that earn their
place — but he chose the verse to come **first**, and his year-from-now answer
is about **prayers he has never heard of**. Both were kept. Ask before cutting.

### One ambiguity, resolved conservatively
The word-bank question said "the first eleven are already banned; add or
confirm". He ticked four. Three previously-banned phrases (`journey`, `let us`,
`at the end of the day`) were **not** ticked. They were left banned, on the
reading that not re-confirming is not the same as unbanning. Worth checking.

---

## 7. What is still to build

In the order I would do it.

1. **Lent, Advent, and the Triduum.** Asked for at 5/5; currently only the
   accent colour changes. Needs season-aware forms, length, and probably a
   stripped Triduum issue.
2. **Sunday as a bigger issue.** Same answer, same gap.
3. **"One thing today" as its own daily block** — it currently lives inside the
   saint block and disappears on days with no saint.
4. **Two new blocks**: patron of the day, and what the Church asks today
   (fast / feast / obligation). Both need small hand-written data files.
5. **Grow the Q&A bank** — 20 entries, three go out a day. Tilt toward
   objections and practical practice. Needs ~60 to be sustainable.
6. **Grow the prayer bank toward the unfamiliar** — 15 entries, mostly ones
   everybody already knows. A `familiar: true` flag exists on all fifteen and
   **nothing reads it yet**; the intent was to bias rotation toward prayers he
   has never heard of, which is his stated year-one goal.
7. **Marian thread** — asked for at 5/5, currently only a voice instruction.
   Wants real content in the prayer and Q&A banks.
8. **Serif/sans split** across both renderers.
9. **A saint fact bank with patronages** — the fact sheet for a saint is a name,
   a rank and two dates, which is not enough to build a scene from. He asked for
   it seeded (~50) with him correcting.
10. `GITHUB_TOKEN`, the `mikeygabmiller/matins` repo, and Pages.
11. A verified sending domain in Resend, then update `FROM_EMAIL`. The shared
    `onboarding@resend.dev` sender **only delivers to the Resend account's own
    address** — that is why a test send to anywhere else fails.

---

## 8. Operating it — no terminal required

`matins/console.html` is a self-contained page. Open it from a file; it needs no
server. The token is kept in `localStorage` and sent only to his own Worker.

- **Diagnose** — no token needed. Reports the *names* of every binding the
  Worker received (never a value), which of the expected ones are missing, and
  any near-miss names.
- **Status / models / preview** — need the token.
- **Send it to me now** → `POST /admin/send-me?to=` — builds an issue and mails
  one copy. **Records nothing**: no KV write, no publish, no `sent:<date>` lock,
  and rotation reads through a store that discards writes. Fire it as often as
  you like without disturbing the real 5am send.
- **Build + publish + EMAIL** — the real thing, to every confirmed subscriber.

`/admin/*` needs `Authorization: Bearer $ADMIN_TOKEN`. Read-only GET routes also
accept `?token=`, so a preview opens on a phone; **`POST /admin/run` and
`/admin/send-me` never do**, because those send mail.

**The admin token is currently under 16 characters.** The Worker warns about it.
This route rebuilds the site and emails every subscriber, and on GET the token
travels in URLs.

Other pages: `direction.html` (the first 15-question form, superseded),
`blueprint.html` (the 61-question one — answers live in the reader's
`localStorage`, so re-opening it shows them again).

---

## 9. Gotchas, all of them earned

- **`/api/version` is the only source of truth for what is live.**
- **Merge PRs after the last push.** Stranded commits happened twice.
- **Non-production branches upload, they do not deploy.**
- **A 404 from an old build used to look like an outage** — the catch-all now
  returns JSON with CORS and the build fingerprint, so "route not in this build"
  is legible. Admin routes carry CORS so a `file://` page can read them.
- **`diag:lastEmailError` used to survive being fixed** and sent people hunting
  a solved problem. A successful send now clears it.
- **GitHub's web editor commits to whatever branch you were viewing.** Confirm
  `main` before editing there.
- **Model names go stale.** Never hardcode one from memory; `GET /admin/models`
  asks the key what it can reach.
- **Gemini reasoning tokens come out of `maxOutputTokens`** — `lib/llm.js` floors
  it at 1024 so a starved call cannot return an empty candidate and fail closed.
- **Never put a credential in a URL or a chat message.**
- **`render/compat.js` exists because the issue shape changed twice** — old
  issues in KV still render. Read the payload through it, not directly.

---

## 10. On other people's writing

He asked twice about pulling reflections from an existing devotional site
(`catholic-daily-reflections.com`), framed as private use. This was declined:
the app has a subscriber list and a public archive, so it is redistribution, and
systematically summarising someone's corpus is a derivative work regardless of
how the dates are handled.

What was done instead, and is fine: the **format** was taken as inspiration —
passage, a few angles, a turn toward the reader, a line of prayer — which is a
genre convention hundreds of devotionals share. Six original reflections were
written in that shape and became the exemplars. Nothing is adapted from another
devotional's text.

**The open door:** ask the site for permission. Publishers like that one
frequently grant non-commercial reuse with attribution. With a written yes, the
integration can be built properly.

---

## 11. First things a new session should do

1. `cd matins && npm install && npm test` — expect 50 passing.
2. `npm run preview 2026-08-05 -- --offline` — read the whole issue in the
   terminal. Note the WRITING block: form, drafts, judge, anything tired.
3. Check `GET /api/version` against `src/build.js`. If they differ, nothing you
   read in this repo is what is running.
4. Open `console.html`, press **Diagnose**. Confirm `GITHUB_TOKEN` and the crons
   before believing anything about publishing or the daily send.
5. Pick from §7. Ask before cutting the verse or the prayer (§6).
