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

## It merged and nothing happened

Happened for real on 2026-09-10: #149 squash-merged to the production branch, the
branch head on GitHub was the merge commit, and a day later the live URL was still
serving the build from two days earlier. Nothing was wrong with the code. Work the
question in this order — each step rules out a different culprit, cheapest first.

**1. Is it actually on the production branch?**

```
git ls-remote origin claude/qqc-submission-auto-text-cspjc3
```

Compare to the merge commit. If they differ, the merge went somewhere else (the
stale default branch is the usual suspect) and nothing else below matters.

**2. Is something caching the answer?**

```
curl -sS -H 'Cache-Control: no-cache' \
  "https://texting.mikeysdetailingsnohomish.workers.dev/api/version?cb=$(date +%s)"
```

A query string and a no-cache header defeat any edge or browser cache. If the build
string changes, it was only ever a cache and the deploy was fine.

**3. Did NOTHING deploy, or did HALF of it?** These look identical from one endpoint
and have completely different causes, so ask both sides:

```
curl -sS https://texting.mikeysdetailingsnohomish.workers.dev/api/version
curl -sS https://texting.mikeysdetailingsnohomish.workers.dev/ | grep -o 'APP_BUILD="[^"]*"'
```

- **Both old** → no deploy ran at all. Go to step 4.
- **One old, one new** → a deploy ran and only half landed. That is the `⚠ mismatch`
  case above; re-deploy so the Worker script and the static assets come from the
  same build.

**4. Ask Cloudflare, because nothing else can answer it.** Dashboard → Workers &
Pages → `texting` → **Settings → Builds**. Look for, in this order: a build that
**failed**, a build still **queued**, or a **Production branch** that is no longer
`claude/qqc-submission-auto-text-cspjc3`. If there is no build listed for the merge
commit at all, the GitHub integration itself is disconnected — reconnect it there.

### What NOT to do about it

- **Do not `wrangler deploy` around it.** It puts a hand-uploaded version live, which
  is a second source of truth for a repo whose whole deploy contract is "the
  production branch is what's live". Fix the build, don't bypass it.
- **Do not push an empty commit to kick it.** If it built, it would have built. An
  empty commit costs you the ability to tell "the integration is dead" from "that
  one build failed".
- **Do not report it as shipped.** Merged is not live. Say "merged, not live yet,
  here is what to check" and hand over this section.
