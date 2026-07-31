# Photo Engine

Text your before/after photos to your own business number from the driveway.
The post writes itself.

Closes **SCALE-02** (inbound photos discarded) and automates **SEO-ROADMAP Tier 1
§1** — weekly GBP photos and weekly GBP posts, the two highest-leverage tasks in
the whole roadmap and the two nobody does 52 weeks a year.

---

## How it works

```
  you text photos                    ┌── Google Business Profile post
  to your own number                 │
        │                            ├── Google Business Profile gallery photo
        ▼                            │
   /sms webhook  →  R2  →  Gemini  →─┼── Instagram caption + image
   (Twilio MMS)     /p/<key>  caption │
                    public URL        ├── review-request text (g.page link)
                                      │
                                      └── city-page gallery entry for mikeysite
```

**Why the R2 hop matters.** Every publisher downstream — Google Business
Profile, the Instagram Graph API, Make, Zapier — fetches the image itself,
anonymously. Twilio's media URLs require Basic auth (that is what `/api/media`
is for), so they cannot be handed to any of them. Mirroring to R2 and serving at
`/p/<key>` is the entire reason this pipeline works.

`/p/<key>` is deliberately public and unauthenticated. The key carries 128 bits
of randomness and nothing can list the bucket, so the key *is* the access
control — the same model as an unlisted share link.

---

## Setup

> **No terminal? See [PHOTO-ENGINE-GO-LIVE.md](./PHOTO-ENGINE-GO-LIVE.md)** — the
> same setup done entirely through the Cloudflare and GitHub web dashboards.

### 1. Create the bucket, deploy

```sh
npx wrangler r2 bucket create mikeys-photos
npx wrangler deploy
```

The `PHOTOS` binding is already in `wrangler.toml`. **Create the bucket first** —
a deploy fails while the binding points at a bucket that doesn't exist. Until then
the Photo Engine panel's setup check shows exactly what's missing, and intake
refuses cleanly; nothing else in the dashboard is affected.

The panel's setup check does a real R2 write-and-read round trip rather than just
testing whether the binding is present, so it can't report success on a broken
bucket.

### 2. Use it

Text a photo to your business number from **your own phone**:

| You text | What happens |
|---|---|
| photo + `before — Lake Stevens` | starts a job, sets the city |
| photo + `after` | pairs into the same job, writes the post |
| photo + `done` | closes the job out even without the word "after" |
| a plain text, no photo | ignored, exactly as before |

Photos from the same number inside a 4-hour window are one job. No clever
pairing heuristic — just "the photos from this visit". Anything it gets wrong is
a dropdown in the dashboard.

You get a text back confirming the post is written. Open **☰ → Photo Engine** to
review, edit, and publish.

> **Note:** this was previously dead. Texts from your own number were dropped on
> the floor by a `that's me, ignore` guard in `handleInboundSms`. An MMS from the
> owner is now a Photo Engine submission; a plain text from the owner is still
> ignored.

---

## Publishing: three paths

The dashboard works with none of this configured — every asset has a Copy button
and the photo has a Download button. That is v1 and it is already ~15 seconds
instead of 15 minutes. The two automated paths just remove the tapping.

### Path A — webhook (recommended; no Claude usage)

Make.com or Zapier both have native Google Business Profile modules and run
entirely on their own infrastructure.

1. In Make: **Webhooks → Custom webhook** → copy the URL.
2. Paste it into **Photo Engine → Publish webhook**, Save.
3. Add a **Google My Business → Create a Post** module, mapped from the payload:

   | Module field | Payload field |
   |---|---|
   | Summary | `gbp.summary` |
   | Photo URL | `gbp.photo_url` |
   | CTA type | `gbp.cta_type` |
   | CTA URL | `gbp.cta_url` |

4. Test it with **Publish now** on a job. Once a real post appears on your
   profile, turn on **Auto-post ready jobs**.

Field names in the payload mirror the GBP and Instagram APIs exactly, so the
mapping is field-to-field with no transformation step.

Auto-post is capped at `maxPerDay` (default 2) so a busy Saturday can't spam the
profile, and it stays off until you turn it on — a misconfigured hook should
never quietly publish nothing forty times.

### Path B — pull API (for anything that can make an HTTP request)

```sh
npx wrangler secret put PHOTO_ENGINE_TOKEN   # any long random string
```

```
GET  /api/photo-queue?target=gbp&limit=1     Authorization: Bearer <token>
POST /api/photo-posted  {"id":"<job id>","target":"gbp"}
```

`photo-queue` returns ready jobs already shaped for the publisher APIs.
`photo-posted` is the acknowledgement — without it the same job is handed out on
every poll. The token is separate from the dashboard password and can be rotated
without logging you out.

### Path C — manual

Copy the caption, download the photo, paste into the GBP app. No setup, no
dependencies, works today.

---

## Instagram

The Instagram Graph API can publish to a **Business or Creator** account linked
to a Facebook Page. Its constraints are stricter than Google's, and the engine
measures every photo at intake so the dashboard warns you *before* a post fails:

- JPEG only
- ≤ 8 MB
- aspect ratio between **4:5 and 1.91:1**

That last one bites: a portrait phone photo is 3:4 (0.75), which is **outside**
the allowed range and will be rejected. Landscape 4:3 is fine. When a photo
can't go to Instagram as-is, the card says so and `instagram.ok` is `false` in
the payload — crop before posting.

---

## On geotagging

SEO-ROADMAP Tier 1 says "upload geotagged photos weekly". Worth knowing before
you build habits around it: there is no evidence Google reads EXIF GPS from GBP
photo uploads, and MMS pipelines frequently strip EXIF anyway. It is one of the
stickiest pieces of local-SEO folklore.

What actually moves the Map Pack is what the rest of that section says — photo
and post **velocity**, and review flow. This engine delivers those whether or not
the EXIF survives.

---

## Cost

| | |
|---|---|
| Cloudflare R2 | free tier: 10 GB, 1M writes/mo, 10M reads/mo. A few jobs a week is a rounding error. Posted jobs are pruned after 90 days and their objects deleted. |
| Gemini | one vision call per job (~1 image + ~1k tokens). Flash pricing, effectively pennies a month. |
| Twilio | one inbound MMS per photo + one confirmation SMS per batch. Turn the confirmation off in settings if you'd rather not. |
| KV writes | the whole queue is **one** value (`pe:index`), so a change is 1 write. `peCron` is gated to every 5th minute and only writes on a real state change. |

The KV write budget note at the top of `src/index.js` is not decorative — the
free tier allows ~1,000 writes/day and the minute cron touches every
conversation. The Photo Engine was built to that constraint.

---

## Files

| | |
|---|---|
| `src/index.js` | `// Photo Engine` section — intake, R2 mirroring, captioning, payload, cron, routes |
| `public/index.html` | `openPhotos()` / `peRender()` — the ☰ → Photo Engine panel |
| `wrangler.toml` | `[[r2_buckets]]` binding + the `PHOTO_ENGINE_TOKEN` note |
