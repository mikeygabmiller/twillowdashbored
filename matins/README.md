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

Confirm and unsubscribe links are HMAC-SHA256 tokens over `purpose:email`, so a
link cannot be forged, guessed, or reused for the other purpose.

## Degrading instead of failing

| what breaks | what happens |
| --- | --- |
| readings API down / no entry for the date | references are dropped, the USCCB link is still built from the date, everything else sends |
| Douay-Rheims lookup down, or returns a non-DR translation | the verse reference stays, the text is dropped |
| LLM call fails | that block is omitted; a missing headline falls back to the day's own name from romcal |
| safety pass flags a block | the block is dropped, the reason is logged to `safetyReport`, the issue sends |
| safety pass itself errors | the block is dropped (fail closed) |
| GitHub publish fails | logged; the email still goes out |

Only the liturgical calendar can stop an issue, and it is computed offline.

`npm test` covers each of these, including the seeded bad block.

## Config

`wrangler.toml` `[vars]`: `APP_NAME`, `SEND_HOUR`, `SEND_TZ`, `LLM_PROVIDER`
(`anthropic` | `gemini` | `stub`), `LLM_MODEL`, `FROM_EMAIL`, `REPLY_TO`,
`SITE_URL`, `CALENDAR_LOCALE`, `READINGS_API_BASE`, `DR_API_BASE`, `SITE_REPO`,
`SITE_BRANCH`, `SEND_PAUSED`.

Set `DR_API_BASE` to an empty string to print references only and never any
verse text at all.

**On Gemini:** the 2.5 models reason before answering and those tokens come out
of `maxOutputTokens`. The calls here are short — a nine-word headline, a
two-field JSON verdict — so thinking could consume the whole budget and return
an empty candidate, which the safety pass would read as "checker failed" and
fail closed on, dropping every generated block. `thinkingConfig.thinkingBudget`
is therefore set to 0; none of this work needs deliberation. Leave `LLM_MODEL`
blank for the provider default, or set it if the API 404s on that model name.

## Design

Cream paper, dark ink, a serif for headings, generous line-height — and the
accent colour is the **liturgical colour of the day**, so the look moves through
the church year (green, violet, white/gold, red, rose). The wordmark is an arch
with the sun rising behind it, in that day's colour: a doorway at dawn, which is
what matins is. `src/render/brand.js` has the SVG.

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
