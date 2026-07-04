# Deploying — how this app goes live (read this first)

**Production branch:** `claude/qqc-submission-auto-text-cspjc3`

Cloudflare Workers Builds is connected to this repo and **auto-deploys the production
branch above** to the live Worker `texting`
(https://texting.mikeysdetailingsnohomish.workers.dev). No manual `wrangler deploy`.

## The one rule that matters

**A change is LIVE only when it is on the production branch.** Pushing to any other
branch creates a **preview** build — Cloudflare uploads a new version (so the worker's
"modified" time changes and the new code shows up if you read the script), but the
**live URL keeps serving the last production build.** This is exactly what once made
changes look "deployed" when the live site hadn't changed.

So: **never trust "I pushed it" or the worker version list. Verify the live URL.**

## Ship checklist

1. Do the work on a feature branch.
2. **Bump the build fingerprint in BOTH files (keep them identical):**
   - `src/index.js` → `const BUILD = '…'`
   - `public/index.html` → `var APP_BUILD = '…'`
3. Open a PR **into the production branch** (`claude/qqc-submission-auto-text-cspjc3`)
   and merge it. (The repo's GitHub *default* branch is stale — see below — so PRs may
   default to the wrong base. Set the base to the production branch.)
4. **Verify it's actually live** (not a preview):
   - Open the live URL → open the ☰ menu → the footer shows
     `app <build> · server <build> ✓ live`.
   - Or hit the endpoint: `GET /api/version` → `{ "build": "<current>" }`.
   - `⚠ mismatch` in the footer means the front-end assets and the Worker script came
     from **different deploys** — re-deploy so both match.
5. Installed as a PWA? After a production deploy, fully close and reopen it (or delete
   and re-add to the home screen) so the service worker drops the old cached shell.

## Gotchas baked into this repo

- **The GitHub default branch (`claude/exciting-babbage-up2gi4`) is STALE** (missing
  live features). Do not target it. Base every PR on the production branch.
- **Two Workers exist** on the account: the live one is **`texting`**; the other
  (`mikeys-detailing-sms`, last touched June 2026) is unused/old — ignore it.
- If the live footer/`/api/version` doesn't move after a merge, the Cloudflare
  **production branch** setting isn't what this doc says. Check it at:
  Cloudflare dashboard → Workers & Pages → `texting` → **Settings → Builds →
  Production branch** — that setting is the single source of truth for what goes live.
