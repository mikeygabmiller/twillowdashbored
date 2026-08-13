# Matins — a daily Catholic devotional

One build a day, two surfaces: an email to subscribers and a public web archive
with a shareable permalink. Everything is anchored to the real Roman Catholic
liturgical calendar.

Working name is **Matins** — change `APP_NAME` in `wrangler.toml` and it changes
everywhere (email, wordmark, pages, subject lines).

```
romcal (offline)  ─┐
readings API      ─┼─► grounded facts ─► LLM (retell/reflect only) ─► safety pass ─┐
Douay-Rheims      ─┘                                                               │
                                                     PRAYERS[] / QA_BANK[] ────────┼─► issue JSON ─┬─► email (Resend)
                                                     (hardcoded, pre-vetted)       ┘   (KV)        └─► GitHub Pages
```

## Start here

```bash
npm install
npm run preview                     # today, dry run
npm run preview 2026-12-25          # any date
npm run preview 2026-12-25 --offline    # readings/verse from test fixtures
npm run preview --seed-bad-block    # watch the safety pass drop a block
npm test
```

`preview` builds a complete issue, writes `email.html`, `email.txt`,
`page.html` and `issue.json` to `preview-out/<date>/`, prints the whole issue to
the terminal, and **sends nothing, marks nothing as seen, writes no KV**.

Without `LLM_API_KEY` it falls back to a `stub` provider that produces obviously
labelled placeholder text, so the pipeline, rotation, safety pass and both
renderers can be exercised with no key and no network.

## The rules this app is built around

1. **No LLM memory is ever a source of fact.** The calendar comes from `romcal`
   (offline), the readings from the readings API, the verse text from a
   Douay-Rheims lookup that is *verified to be Douay-Rheims* before it is used.
   The model is handed those facts and may only retell and reflect on them.
2. **Nothing generated sends unchecked.** Every generated block goes through
   `src/lib/safety.js` — deterministic tripwires plus a second LLM call at
   temperature 0 against a strict rubric. A flagged block is dropped and the
   rest of the issue still sends. The check **fails closed**: if the checker
   itself errors, the block is dropped.

   Separately, the generator judges **craft** — see below. Craft is not safety
   and does **not** fail closed.
3. **No copyrighted scripture or Catechism text.** Readings appear as
   references plus a link to the USCCB. The only scripture text that can ever
   appear is a single Douay-Rheims verse. Catechism references appear as bare
   citations in the pre-vetted Q&A bank, never as quoted text.
4. **Prayers and Q&A are never generated.** `src/content/prayers.js` (15
   traditional, public domain) and `src/content/qa.js` (20 pre-written, orthodox)
   are hardcoded and chosen by rotation. They are pre-vetted and skip the safety
   pass by design.
5. **Never mail an unconfirmed or unsubscribed address.**
   `activeSubscribers()` is the only source of recipients and it only returns
   `status: "active"`.

## Setup

### 1. KV

```bash
npx wrangler kv namespace create DEVOTIONAL
```

Put the returned id in `wrangler.toml` under `[[kv_namespaces]]`.

Keys used:

| key | value |
| --- | --- |
| `sub:<email>` | `{ email, status: pending\|active\|unsubscribed, createdAt, confirmedAt, unsubscribedAt }` |
| `issue:<YYYY-MM-DD>` | the full issue JSON — this is the archive record |
| `issues:index` | `[{ date, headline, feastOrSaint, color }]`, newest first, capped at 400 |
| `rot:prayer` / `rot:qa` | recently-used ids, most recent first |
| `sent:<YYYY-MM-DD>` | `{ at, sent, failed }` — presence is the send lock |

No migration is needed: keys are created on first write, and every read has a
default.

### 2. Secrets

```bash
npx wrangler secret put LLM_API_KEY      # Anthropic or Gemini, per LLM_PROVIDER (currently gemini)
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TOKEN_SECRET     # any long random string
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT, Contents: read/write on SITE_REPO
npx wrangler secret put ADMIN_TOKEN      # bearer token for /admin/*
```

Nothing secret goes in `wrangler.toml`.

### 3. Resend

Verify the sending domain in Resend, then set `FROM_EMAIL` in `wrangler.toml`
(the from-line is the app name, e.g. `Matins <matins@yourdomain.com>`).

### 4. The Pages site

Create the public repo named in `SITE_REPO` (e.g. `mikeygabmiller/matins`) —
initialised with a README so it has a branch — and enable GitHub Pages on it
(Settings → Pages → deploy from `main`, root).

**That is the whole job. The Worker fills the repo in.** On its first publish it
writes the landing page, `mark.svg` and `.nojekyll` into an empty repo, and from
then on commits each day's issue: `/<YYYY-MM-DD>/index.html` (the permalink),
`/archive/index.html`, `/today/index.html`, and `/issues/<date>.json`. The
issue pages and archive are rewritten daily; the landing page and mark are
written **once and never overwritten**, so anything you hand-edit there
survives.

The signup form it writes points at `WORKER_URL` — set that in `wrangler.toml`
to the deployed Worker URL, since the cron has no incoming request to infer it
from.

`npm run site` renders the same static files locally if you would rather commit
them yourself:

```bash
WORKER_URL=https://matins.<your-subdomain>.workers.dev npm run site
```

The copy committed in `site/` is built for
`https://matins.mikeysdetailingsnohomish.workers.dev`.

### 5. Deploy

```bash
npx wrangler deploy
curl https://matins.<your-subdomain>.workers.dev/api/version
```

Bump `BUILD` in `src/build.js` on every deploy so `/api/version` tells you what
is actually live.

### 6. Turn sending on

`SEND_PAUSED = "1"` ships as the default: the cron builds and publishes but does
not email. Work through the build order — preview, then a test send, then web
publish, then signup — and flip it to `"0"` when you are ready.

Two crons are configured (12:00 and 13:00 UTC) so the 5am local send survives
the daylight-saving shift; the handler ignores any run whose local hour is not
`SEND_HOUR`, and `sent:<date>` prevents a double send regardless.

## Routes

| route | what it does |
| --- | --- |
| `POST /subscribe` | form or JSON `{email}` → `pending`, sends the confirmation email |
| `GET /confirm?t=` | token → `active` |
| `GET/POST /unsubscribe?t=` | token → `unsubscribed`; POST is the `List-Unsubscribe` one-click endpoint |
| `GET /api/issue/<date>` | the stored issue JSON |
| `GET /api/archive` | the archive index |
| `GET /api/version` | build fingerprint |
| `GET /admin/preview?date=&format=html&seedBad=1` | dry run in production — builds and renders, sends and stores nothing |
| `POST /admin/run?date=&force=1&send=0` | run the daily job by hand |
| `GET /admin/status` | build, send lock, subscriber counts |

`/admin/*` requires `Authorization: Bearer $ADMIN_TOKEN`. The two **read-only
GET** routes also accept `?token=$ADMIN_TOKEN`, so a preview can be opened from
a phone browser, which cannot set headers. That puts the token in URLs and
request logs — `POST /admin/run`, the only route that builds and sends, never
accepts it. Rotate `ADMIN_TOKEN` whenever you want; nothing else depends on it.

`GET /admin/status` also reports the last publish (`diag:lastPublish`), whether
an alert address is configured, and how many forms and openings the rotation has
actually recorded — the fastest way to tell that generation is working without
reading an issue.

Confirm and unsubscribe links are HMAC-SHA256 tokens over `purpose:email`, so a
link cannot be forged, guessed, or reused for the other purpose.

## Degrading instead of failing

| what breaks | what happens |
| --- | --- |
| readings API down / no entry for the date | references are dropped, the USCCB link is still built from the date, everything else sends |
| Douay-Rheims lookup down, or returns a non-DR translation | the verse reference stays, the text is dropped |
| LLM call fails | that block is omitted; a missing headline falls back to the day's own name from romcal |
| LLM reply is cut off mid-answer | treated as a failure, not an answer — the draft is retried, and a block that keeps truncating is dropped with `truncated` in its reason |
| safety pass flags a block | the block is dropped, the reason is logged to `safetyReport`, the issue sends |
| safety pass itself errors | the block is dropped (fail closed) |
| GitHub write hits a 409/429/5xx or a network error | retried twice with backoff, then reported; the email still goes out |
| GitHub publish fails anyway | recorded to `diag:lastPublish`, shown in `/admin/status`; the email still goes out |
| anything above actually happens | if `ALERT_EMAIL` is set, you get a mail that morning naming what was lost |

Only the liturgical calendar can stop an issue, and it is computed offline.

`npm test` covers each of these, including the seeded bad block and the
truncation that caused the 6–13 August outage.

**Degrading is not the same as being told.** Every failure above was already
recorded faithfully in `safetyReport` before any of this existed, and that is
exactly how the first eight issues went out without a reflection or a saint
story while nobody noticed: the record was written and nothing read it. If you
add a new fallback, give it a way to speak up too.

## Config

`wrangler.toml` `[vars]`: `APP_NAME`, `SEND_HOUR`, `SEND_TZ`, `LLM_PROVIDER`
(`anthropic` | `gemini` | `stub`), `LLM_MODEL`, `GEMINI_THINKING_BUDGET`,
`FROM_EMAIL`, `REPLY_TO`, `ALERT_EMAIL`, `SITE_URL`, `CALENDAR_LOCALE`,
`READINGS_API_BASE`, `DR_API_BASE`, `SITE_REPO`, `SITE_BRANCH`, `SEND_PAUSED`,
`ADMIN_DIAGNOSTICS`.

Set `DR_API_BASE` to an empty string to print references only and never any
verse text at all.

**`ALERT_EMAIL` is the one to set first.** It is not a subscriber and never goes
on the list — it is the address that gets told when an issue goes out
incomplete, naming every dropped and degraded block. Leave it empty and the app
goes back to failing silently, which is the failure mode that actually hurt it.

**`ADMIN_DIAGNOSTICS` ships off.** With it on *and* `?debug=1` on the request,
an unauthenticated `/admin/*` error explains itself: which binding names reached
this Worker, whether a supplied token is even the right length. That is worth an
evening while the Worker is being wired up and worth nothing afterwards, and the
route it guards can rebuild the site and mail every subscriber. Turn it on,
diagnose, turn it off. No value is ever revealed either way.

### Signup ceilings

`POST /subscribe` is unauthenticated and causes mail to be sent to an address
the caller picks, which makes it a way to point this Worker at somebody else's
inbox. Two ceilings, for two different abuses (`src/lib/ratelimit.js`,
`SIGNUP_LIMITS` in `src/config.js`):

- **One source, many addresses** — 5 signups per IP per hour, a fixed KV window.
- **Many sources, one address** — a pending address is not re-mailed for 15
  minutes, however many times the form is submitted. The reader sees the same
  "check your inbox" either way, which is true.

Neither is exact: KV is eventually consistent and a burst across colos can
overshoot. They exist to stop a script, not to be an accounting system. A
limiter that cannot reach KV **allows** the signup — breaking signup is worse
than the abuse.

**On Gemini — read this before changing any of it.** These models reason before
answering and those tokens come out of `maxOutputTokens`. The first attempt at
handling that was headroom alone: a 1024-token floor on every call, and no
thinking field, on the reasoning that an unrecognised field name is a 400 and a
400 loses the whole issue.

That was wrong, and it cost the first eight issues their reflection and their
saint story. 1024 is enough slack for a nine-word headline and not enough for a
reasoning pass *plus* six sentences, so the model thought, started writing, and
ran out — returning a reflection that stopped mid-sentence and a saint story
whose JSON had no closing brace. Both looked like different problems. Neither
was.

Three things hold it closed now, and all three matter:

- `GEMINI_THINKING_BUDGET = "0"` — set in `wrangler.toml`. None of this work
  needs deliberation.
- The floor is 3072, so even a model that ignores the budget has room for both.
- **`llm.js` throws on `finishReason: MAX_TOKENS` whether or not it got text.**
  This is the one that matters. A truncated candidate returned as though it were
  finished is how a config problem spends eight days impersonating bad writing.

If the API ever does reject `thinkingConfig`, the call retries once without it
rather than failing — so the original worry is handled without giving up the
fix. Leave `LLM_MODEL` blank for the provider default, or set it if the API 404s
on that model name.

## How the writing is kept good

Orthodoxy is `safety.js`. Everything here is about the other problem: that the
prose be worth reading on an ordinary Tuesday, not just on Easter. Four things
do that work, in descending order of how much they matter.

**1. Exemplars.** Every block is shown a worked example in the house voice
(`src/content/forms.js`). Few-shot holds register better than any quantity of
adjectives in an instruction. **The exemplars are the product** — if the writing
drifts, fix them before touching anything in `lib/`.

**2. A named shape, rotated.** "Four to six sentences" is a length, and a model
given only a length writes the same paragraph every day: observation, gentle
pivot, uplift. `FORMS` names six shapes — the objection, one scene, the hard
saying, the plain fact, the long middle, the cost — and `pickForm` rotates them
through the same cooldown machinery as the prayers. Which one a date gets is
deterministic, so a preview shows what that date would really receive.

**3. Drafts and a judge.** Each block is written more than once at spread
temperatures and the drafts are compared (`src/lib/judge.js`, counts in
`DRAFTS`). One draft is a coin flip on tone. The judge is a comparison, not a
score — models are unreliable at absolute quality ratings and much better at
"which of these two, and why", and a comparison needs no recalibration as models
change. It **fails soft**: an unreachable or incoherent judge means the first
draft ships.

**4. Tripwires.** A short list of phrases that mark writing as machine-made
("at the end of the day", "in our daily lives", an exclamation mark), plus
throat-clearing openers and title-case headlines. A whole round tripping one is
sent back with the fault named. If the model still cannot shake it, the best
draft **ships anyway** — losing the entire reflection over a tired phrase is the
worse trade. What tripped is recorded in `safetyReport.blocks[].craft`.

Recent opening sentences are kept in `rot:openings` and fed back as ground
already covered, so the first line does not converge.

**Two of those four have never actually run.** `buildIssue` commits the form
rotation and remembers the opening only `if (reflection)` — correct, since a
dropped block used neither — and no reflection survived between 6 and 13 August
2026. So `rot:form` and `rot:openings` were empty that whole time: the form
cooldown never engaged (the shape was pure date-hash) and the anti-convergence
list never held an entry. Both start cold. Give the first week after a
generation fix some slack on variety, and check
`/admin/status` → `formsSeen` / `openingsRemembered` are climbing before
concluding anything about the prompts. Zero on both means generation is still
broken, whatever else the issue looks like.

`npm run preview` prints the whole record: which form, how many drafts, what the
judge said, and anything that tripped.

**The voice lives in one file.** `src/content/voice.js` holds who is speaking,
who is listening, and the style rules. A change of editorial direction is an
edit to that file plus the exemplars — not a rewrite of the generator.

### Stories

There is a real tension here, and it is worth stating plainly rather than
discovering later. Rule 1 says the model may assert nothing that is not in its
grounded facts. For a saint, those facts are a name, a rank, and one or two
dates. **That is not enough material to build a scene from**, which is why the
saint block tends toward the general.

The options, and what each actually costs:

- **A hand-written saint fact bank** — the architecturally correct answer, and
  exactly how `prayers.js` and `qa.js` already work: human-written, pre-vetted,
  hardcoded. Costs writing time; costs no safety.
- **Retelling the day's Gospel scene** — the highest reader value, and the only
  option that requires *relaxing* rule 2. It would need a narrative source the
  app trusts, not the model's memory.
- **Ordinary anonymous people** — technically free, but invented people
  presented as real is a line worth deciding on deliberately.

`direction.html` puts these to the owner as a decision rather than changing the
rule quietly. Until that is settled, the exemplars deliberately narrate no
reading.

## Design

Cream paper, dark ink, a serif for headings, generous line-height — and the
accent colour is the **liturgical colour of the day**, so the look moves through
the church year (green, violet, white/gold, red, rose). It appears as a band
across the top of every issue, as the section labels, and as the wordmark: an
arch with the sun rising behind it, a doorway at dawn, which is what matins is.
`src/render/brand.js` has the SVG, `src/render/theme.js` the palette.

Rules the renderers hold to, both surfaces:

- **A rule between sections, never inside one.** The hairlines are the only
  thing separating Reflection from the saint from the Prayer, and they are what
  make the issue scannable rather than one long column.
- **About 66 characters to the line.** That is what the gutters are for. Do not
  widen the sheet without narrowing something else.
- **Prayers keep their line breaks.** `src/content/prayers.js` stores the
  received wording already lineated — one breath per line, blank line between
  stanzas — and `src/render/prayer.js` turns that into stanzas both renderers
  lay out. A prayer is said, not skimmed. Only the line breaks are ours: never
  edit the words or the punctuation of a traditional text.
- **The saint section is headed by the name the Church uses today**, taken from
  romcal (`day.saint.name`), not from anything a model wrote.

Where they differ:

- **The web page honours `prefers-color-scheme`** — this is read before dawn —
  and prints cleanly. Every colour in `theme.js` has a dark value; the accents
  are lightened there because the light-mode green and violet fall below
  readable contrast on a near-black page.
- **Email stays light.** Dark-mode support across mail clients is uneven enough
  that a half-working palette is worse than none: Gmail ignores the media query
  and inverts on its own. `color-scheme: light` and be done.
- **Issue pages carry the reader onward** (previous / next / today / archive)
  so a shared permalink is not a dead end. Previous and next come from the
  archive index, and each publish also rewrites the *preceding* day's page so
  it gains the "next" link it could not have had when it was written.

## Assumptions worth knowing

- **The prayers came from this repo, not from the script referenced in the
  spec.** That file was not provided, so `PRAYERS[]` is seeded with the fifteen
  standard traditional prayers in their long-settled public-domain English. If
  the original list differs, replace the entries but keep the `id`s stable —
  rotation state remembers ids.
- **`CALENDAR_LOCALE` currently supports `en-US` only.** Other locales need the
  matching `@romcal/calendar.*` bundle added to `BUNDLES` in
  `src/lib/calendar.js`.
- **romcal is pinned to `3.0.0-dev.125`** (the beta `dev` line, matching the
  calendar bundle). Do not float this dependency; shapes have changed between
  betas.
- **The saint story is the one place a model writes about something it was not
  entirely handed.** romcal gives name, canonization status, titles, and year of
  death — a warm retelling needs more than that. The prompt forbids any date,
  place, number, or quotation not in the fact sheet and tells the model to write
  less when it knows less; the safety pass then checks specifically for asserted
  facts outside the sheet. If that is still more latitude than you want, drop
  `generateSaintStory` from `buildIssue` and the section simply disappears.
- **The readings API covers 2025–2026.** Outside that range the issue degrades
  to the USCCB link, which is correct for any date. `LitCal` is the upgrade path
  if a more authoritative source is wanted — it only needs a new module with the
  same shape as `src/lib/readings.js`.

## Moving to its own repo

This lives in a subdirectory only because that is where the work was done. It
shares nothing with the rest of this repository — no imports, no config, no
Worker, no deploy. To split it out, copy `matins/` into a new repo as the root
and everything works unchanged.
