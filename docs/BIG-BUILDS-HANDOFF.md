# Big builds: handoff (2026-11-16, stopped at Mikey's 12:00 PM hard stop)

No app code changed in this branch. This file is the whole deliverable.

## Where things stand

- The earlier audit/design session (session_01VBLgm46vnsZox66HzLhcTX) **pushed nothing**:
  no branch, no PR, no design file in the repo. Its designs are lost unless they are in
  that session's transcript. Don't go looking for them on GitHub.
- This session started at 11:42 AM Pacific with a 11:55 cutoff. A new screen plus the
  required `npm ci` + `npm run test:all` (~3 min) + merge + live check doesn't fit in
  13 minutes, so nothing was built or merged. Live build is unchanged:
  `2026-11-15·drafts-box`.

## Before building any "new" screen: these already partly exist

| Planned build | What's already there |
|---|---|
| Home: what needs him now | **Today** tab (`data-tab="home"`, `public/index.html` ~4302). Extend it; don't add a second home. |
| Waiting-on-you counting | `isAwaiting(e)`-style helper near `src/index.js:10883`: use it, don't recount. |
| Win-back list | "win-back radar" in customer analytics, `src/index.js:8092` (`winback` array, returned ~8198). Already computed; only needs a screen with one-tap open-thread. |
| Money views | **Money** tab exists. Check what made / owed / booked it already shows. |
| One-tap drafted replies | The Reply-ready box (#241, merged 2026-11-15) already holds a draft per conversation. Build on it. |
| Customer record / due back | Not checked yet. |

## Recommended next build (one, done properly)

**Win-back list screen.** The data already exists server-side, so it's mostly UI plus a
test, which makes it the build most likely to be finished in one sitting. Each row: name,
last job, how long ago, lifetime spend, and a tap that opens the thread with a *drafted*
text in the Reply-ready box that he sends himself. **Nothing sends on its own.**

Rules that apply (CLAUDE.md): read rows from `buildIndexSummary()` fields, not by
loading threads (`openThreadForRead()` clears unread). Any drafted text follows the
customer-text rules: no em dashes, `bkTextService()` not `bk.serviceName`, plain words,
leave the door open. Add a `test/*.ui.test.js`. Bump BUILD + APP_BUILD, `npm ci`,
`npm run test:all`, squash merge into `claude/qqc-submission-auto-text-cspjc3`, check
`/api/version`.

## Needs your yes (open PRs already waiting on Mikey, found while checking)

- **#235**: review ask once per customer after the job, plus the AI playbook rewritten to
  the website price book. It changes when a customer text can fire and rewrites stored
  playbook data, so it needs your yes. Also note: live has `say.reviewAsk: false`.
- **#144**: reply to customers by texting your own business number (sends real texts).
- #80, #83 and #78 are old drafts against stale bases. They likely need closing or redoing,
  not merging.
