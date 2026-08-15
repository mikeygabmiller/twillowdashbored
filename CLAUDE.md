# Working in this repo

## Ship your own work — don't wait to be asked

When a change is finished, **merge it**. Don't open a PR and stop for approval, and
don't ask "want me to merge?" — that question has a standing answer, and it is yes.

The full move, every time:

1. Work on a feature branch off the **production branch**
   (`claude/qqc-submission-auto-text-cspjc3` — see `DEPLOY.md`, and never off the
   GitHub default branch, which is stale).
2. Bump the build fingerprint in **both** files, kept identical:
   - `src/index.js` → `const BUILD = 'YYYY-MM-DD·label'`
   - `public/index.html` → `var APP_BUILD = 'YYYY-MM-DD·label'`
3. Run `npm test` **and** `npm run test:ui`.
4. Push, open a PR **into the production branch**, mark it ready, **squash merge it.**
5. Report what shipped, and say plainly whether you could verify it live.

## What "finished" has to mean before you merge

- **Both suites run.** Not "the one I touched" — all of it.
- **No new failures.** A test that fails identically on the base branch with your
  changes stashed is pre-existing and doesn't block the merge — but **verify that
  claim by actually stashing and running it**, and name the failure in the PR body.
  Never wave a red test through on the assumption it was already broken.
- **The fingerprint is bumped.** An unbumped build makes the live-verification step
  meaningless, because `/api/version` will read correct while serving old code.
- **New behavior has a test.** This app is one 12k-line HTML file and one 12k-line
  worker; the UI suite under `test/*.ui.test.js` is what keeps that honest.

If any of those fail, fix it or leave the PR unmerged and say why. "Tests were
failing so I merged anyway" is never the right call.

## Don't claim it's live when you can't see it

Merging is not shipping. Cloudflare deploys the production branch to the live URL,
and the **only** proof is the live URL itself:
`GET /api/version` matching the fingerprint you just set, or the ☰ footer reading
`✓ live`.

Some sandboxes block that host. If you can't reach it, **say so** — "merged, could
not verify live from here, please check `/api/version`" — and hand over what to look
for. Never substitute "I pushed it", the Worker's `modified_on`, the version list, or
code read back through the Cloudflare MCP. Those all move for preview builds off
non-production branches and say nothing about what the live URL serves.

Also: the dashboard is installed as a PWA. Mention closing and reopening it after a
deploy, or the service worker keeps serving the old cached shell and the change will
look broken.

## Still stop and ask about these

Shipping without approval covers the app's own behavior — screens, flows, styling,
copy, tests, refactors. It does not cover:

- Anything that **sends messages to real customers** on its own — new automatic
  texts, blasts, autopilot cadences, or widening when an existing automation fires.
  Real people get these on real phones.
- **Deleting or rewriting stored data** — threads, money entries, config, KV keys —
  including migrations that aren't reversible.
- **Secrets and billing** — Twilio, Cloudflare, Gemini, Resend keys, or anything that
  changes what an API call costs per use.
- Changing the **production branch** or the deploy wiring itself.

For those, do the work, then stop and lay out what it would do before it runs.

## House style

- **Match the file you're in.** Both big files are dense ES5-ish JS with comments that
  explain *why a decision was made*, not what the line does. Write those comments.
- **Names are the customer's language,** not the schema's: "Waiting on you", "Do not
  text", "On a plan" — not `awaitingReply`, `optedOut`, `plan.every`.
- **The list row is the cheap surface.** `buildIndexSummary()` in `src/index.js` is
  what every board, badge and peek reads. Prefer mirroring a field there over loading
  a thread — and note that reading a thread through `openThreadForRead()` **clears
  unread**, which is a real side effect, not a detail.
