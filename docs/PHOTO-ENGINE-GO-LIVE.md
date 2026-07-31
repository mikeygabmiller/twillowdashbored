# Photo Engine — go live without a terminal

Every step here is a click in a web dashboard. No command line anywhere.

Work top to bottom. **Step 1 must happen before Step 2** — the deploy fails if the
bucket doesn't exist yet.

---

## Step 1 — Create the photo bucket (Cloudflare, ~1 min)

The Worker is configured to store job photos in an R2 bucket called
`mikeys-photos`. It doesn't exist yet, and **a deploy will fail while it's
missing** — the binding in `wrangler.toml` points at a bucket that isn't there.

1. Go to **dash.cloudflare.com** → sign in.
2. Left sidebar → **R2 Object Storage**.
3. If you've never used R2: click **Purchase R2** / **Enable**. It asks for a card
   but the free tier is 10 GB stored and 1M writes/month — this feature uses a
   rounding error of that. You will not be billed at this volume.
4. Click **Create bucket**.
5. Name it exactly: `mikeys-photos`
6. Location: **Automatic**. Storage class: **Standard**.
7. Click **Create bucket**.

Leave "Public access" **off**. The Worker serves photos itself at `/p/<key>` — the
bucket never needs to be public.

---

## Step 2 — Merge the two pull requests (GitHub, ~2 min)

**First, confirm where "live" is.** Cloudflare dashboard → **Workers & Pages** →
`texting` → **Settings** → **Builds** → look at **Production branch**.

- If it says `main` → merge both PRs normally (they already target `main`).
- If it says something else → change it to `main` and **Save**. (`DEPLOY.md` used to
  name a branch that's now stale; recent work all merged to `main`.)

Then:

1. Open **github.com/mikeygabmiller/twillowdashbored/pull/78** → **Ready for review**
   → **Merge pull request**.
2. Open **github.com/mikeygabmiller/mikeysite/pull/49** → **Ready for review** →
   **Merge pull request**.

Cloudflare Workers Builds is already connected to this repo, so merging #78 deploys
the Worker on its own. Merging #49 publishes the website change via GitHub Pages.

---

## Step 3 — Confirm it actually deployed (~1 min)

Deploys can silently produce a *preview* instead of going live, so check rather
than assume.

1. Open the dashboard: **texting.mikeysdetailingsnohomish.workers.dev**
2. Open the **☰** menu and look at the footer. It should read:
   `app 2026-07-31·photo-engine · server 2026-07-31·photo-engine ✓ live`
3. If it shows **⚠ mismatch**, the front-end and Worker came from different
   deploys — re-run the build from Cloudflare → Workers & Pages → `texting` →
   **Deployments**.
4. If the build **failed**, open the log. `bucket not found` means Step 1 was
   skipped or the bucket name is misspelled.

Already added the dashboard to your home screen? Fully close and reopen it after
the deploy so the old cached version is dropped.

---

## Step 4 — Run the built-in setup check (~30 sec)

1. In the dashboard, open **☰** → **Photo Engine**.
2. The top of the panel runs real checks — it actually writes a test file to R2 and
   reads it back, rather than just looking at settings.

You want: **"✓ Everything is set up."**

Anything with a **○** tells you what's wrong and exactly where to click to fix it.
The first four checks are required; the rest are optional.

---

## Step 5 — Send yourself a real job (~2 min)

From **your own phone**, text your business number:

1. A photo of a dirty car, with the message: `before — Snohomish`
   → you get back: *"📸 Saved 1 photo for Snohomish…"*
2. A photo of the finished car, with the message: `after`
   → you get back: *"📸 Saved 2 photos — Snohomish post is written and ready."*

Open **☰ → Photo Engine**. The job is there with a Google post, an Instagram
caption and a review-request text, all written in your voice.

**That's live.** Tap **Copy post**, tap **Download photo**, open the Google
Business Profile app, paste. ~15 seconds.

---

## Step 6 (optional) — Hands-off publishing

Steps 1–5 give you a working system. This step removes the copy-paste.

### About your Make.com account

Read this before signing up for anything:

- Your Make Free plan allows **2 scenarios** and you already have 2:
  *"Dashboard Text → SMS to my phone"* and *"Mikey QQC Auto-Text"*.
- The Gmail-watch scenario has used **1,969 operations** against a **1,000/month**
  allowance, which is why the organization currently shows as paused.

So there is no free slot for a publishing scenario right now. Three ways forward:

**(a) Retire the Gmail scenario.** *"Dashboard Text → SMS to my phone"* polls Gmail
every 15 minutes — that poll is what's eating the quota. The Worker now sends owner
alerts by email directly through Resend (that was PR #56), so this scenario may be
doing a job the dashboard already does. Check whether you still need it; deleting it
frees both a slot and the operations.

**(b) Upgrade Make** to Core (~$9/month) for more scenarios and 10,000 operations.

**(c) Skip automation.** Two posts a week by hand is about a minute a week total.
This is a completely legitimate end state.

### If you free up a slot, build the scenario

1. Make → **Create a new scenario**.
2. Add **Webhooks → Custom webhook** → **Add** → name it `Photo Engine` → **Save** →
   **Copy address to clipboard**.
3. Add a second module: **Google My Business → Create a Post**.
4. Click **Create a connection**, sign in with the Google account that owns the
   business profile, allow access.
5. Fill the module in:

   | Field | Value |
   |---|---|
   | Enter a Location Name | Select from the list |
   | Account / Location | pick **Mikey's Mobile Detailing - Snohomish** |
   | Post type | **Call to action** |
   | Title | `{{1.city}}` |
   | Summary | `{{1.gbp.summary}}` |
   | Action type | **Book** |
   | URL | `{{1.gbp.cta_url}}` |
   | Media → Add item → Media format | **Photo** |
   | Media → Source URL | `{{1.gbp.photo_url}}` |

6. **Save**, then turn the scenario **ON** (bottom-left toggle).
7. Back in the dashboard: **☰ → Photo Engine** → paste the webhook URL into
   **Publish webhook** → **Save settings**.
8. On a ready job, tap **Publish now**. Check your Google profile.
9. Only once a real post has appeared: turn on **Auto-post ready jobs**.

Auto-post is capped at 2/day and fires from the Worker's cron. Nothing publishes
until you turn that switch on.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Deploy fails, log says bucket not found | Step 1 skipped | Create `mikeys-photos` in R2, re-run the build |
| Texting photos does nothing | production branch mismatch — the old code is still live | Check Cloudflare → `texting` → Settings → Builds → Production branch |
| "Photo engine is not set up yet" reply | bucket missing or misnamed | Step 1 |
| Photos save but no post is written | no Gemini key | Setup check → "Caption writer" row tells you where to click |
| Instagram warning on a job | portrait photo (3:4) is outside Instagram's 4:5–1.91:1 | Crop it, or post that one to Google only. Shoot landscape when you can. |
| Nothing publishes with auto-post on | webhook never proven | Use **Publish now** on one job first and read the error |

Nothing here can hurt your texting. The Photo Engine only ever touches messages
from **your own number**, and the cron is wrapped so a failure can't break SMS.
