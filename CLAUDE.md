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
3. Run **`npm run test:all`** — one command, every suite, ~3 minutes. It runs four
   at a time and re-runs any failure alone before calling it a failure, so a suite
   reported FLAKY passed on its own and a suite reported ✗ really is broken.
   While iterating, filter to what you touched: `node test/run.mjs ui polish peek`.
   Don't go back to `npm test` + `npm run test:ui` as two serial commands — that's
   the same work in triple the wall clock.
4. Push, open a PR **into the production branch**, mark it ready, **squash merge it.**
5. Report what shipped, and say plainly whether you could verify it live.

## What "finished" has to mean before you merge

- **Both suites run.** Not "the one I touched" — all of it. `npm run test:all` is
  both, in one go.
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

## Ceramic coating jobs

Before recommending or ordering a coating, read `docs/CERAMIC-COATING.md`. It holds
what Mikey uses (CarPro CQuartz UK 3.0, DLUX, FlyBy Forte), why, and what was
turned down. A chat once switched him to another brand without knowing the reasons.

## Texts that go to customers

Mikey's rules for any automatic text (2026-10-10):

- **No em dashes**, in the template or in anything dropped into it. His saved
  service name has one ("Full Detail", a dash, "In & Out"), so texts use
  `bkTextService()`, never `bk.serviceName` raw.
- **Plain words he'd type himself.** Not app talk ("see what's coming up",
  "it doesn't expire", "all I need on your end").
- **Leave the door open.** He usually texts customers himself before a job to
  sort out details, so an automatic text shouldn't read like the last word.
  Say he'll probably be in touch, and ask them to reply with anything he
  should know.

**Sound like him.** Before writing or changing anything a customer reads (a
template, an AI prompt, a draft, a scripted reply), read
`docs/WRITING-STYLE.md`. It is measured from the 664 texts he typed himself
(built 2026-11-24) and holds his decisions on what a stand-in may decide.
Where it disagrees with the dashboard's auto-generated voice fingerprint, the
file wins.

## The Google Voice page (`/voice`): start simple, add back only what he uses

Mikey, 2026-11-19: he uses Google Voice for his personal texts and felt the
dashboard's features "got out of hand". `public/voice.html` is his
conversations laid out exactly like Google Voice, and the rule for it is
**nothing Voice doesn't have, except what he says he actually uses.**

- **Added back so far:** Polish (✨ in the message box, with Undo), scheduled
  send (🕒 beside send, the dashboard's quick times plus a picker; scheduled
  texts show outlined with Edit and Cancel), and the address found in the texts
  (a strip under the name: Save, then Directions). Voicemails show in the
  chat as a card with the transcript and a play button (they stay on the
  Voicemail tab too). Second batch, picked off the full list of what was left
  out: photo viewer (full screen), his usual openers (chips over an empty box,
  from `/api/ai/style`), calls in the chat (a recorded call is a card, other
  rings a one-line entry), tapbacks (drawn on the message, same parser as the
  main app), saved drafts (per phone in this browser, "Draft:" on the row) and
  names (the picked-up name gets "Looks right" / "Edit"; no name, "Add a name").
- **Third batch (Mikey, 2026-11-23):** the reply already written. With ☰ >
  AI that runs by itself > "Have a reply already written" on (switched on
  2026-11-23 at his word), the server drafts in his voice when they text and
  the draft goes **straight into the message box**, with one line above it
  ("Drafted for you", X to throw it away). It only fills an empty box, never
  over words he typed (he gets "Use it"), and each draft goes in once. A send
  carries `aiOriginal`/`aiBy` like the main app, so the drafter learns from
  his edits. A "Needs you" question (a fact only he has) shows in the same
  place with its answers as taps. And **ⓘ in the chat header** opens
  conversation info: their website bookings (status, time, car, add-ons,
  price, address, their notes), the quote, and what's on file. Read only.
- **All texting and conversation work goes here now** (Mikey, 2026-11-23:
  "all future changes that affect the texting and conversation screens need
  to go to the voice style screen, that's a normal screen now"). The classic
  conversation screen in `index.html` is the fallback, not where new things
  go. Build a texting change in `voice.html` and test it in
  `test/gvoice.ui.test.js`; only touch the classic screen when the change
  is shared server behavior or he asks. The "add back only what he names"
  rule still holds: him asking for it is the naming.
- **The look is the Google Voice Android app**, from his own screenshots
  (2026-11-23, dark mode): square icon-only button (plus, or the dial pad on
  Calls and Voicemail), no avatar beside their texts, a time header where a
  conversation picks back up ("Tuesday, Jun 23 • 6:29 PM") and one time under
  the newest text, plus and camera inside the box with a round SMS send
  button, a call-back button on every call row, voicemail rows with the length
  on the right, and New message with a To pill, Suggestions and Next. **No
  Contacts tab**, though Voice has one: he said he doesn't need it.
- **Sizes are Voice's, measured** (2026-11-23, off his screenshots: his
  phone is 384 wide). Rows 74 with a 40 picture at 24, search pill 48, square
  button 56, tabs 80, header 64, bubbles 16px on a 24 line with 16 padding and
  88 kept clear on the far side, composer 48. Voice's font (Google Sans) runs
  narrower than Roboto, so text sizes are set so a line holds the same words
  his Voice does; a bubble wraps at the same word. Check a layout change
  side by side against his screenshots before shipping it.
- **Hold to select** (his screenshot, 2026-11-23): hold a row (or right-click)
  and it becomes a card with a check; taps add more; the bar reads
  "N selected" with Archive (Unarchive in Archive) and Undo after. Voice's
  bar also has **Delete; it's left off**: the dashboard has no way to delete
  a conversation, and erasing customer history is his call. Ask before adding
  one. Unread rows carry Voice's blue dot.
- **It's his texting screen** (Mikey, 2026-11-19). `index.html` sends the
  front door and every `?c=` link to `/voice`, and in the main app `setTab
  ("messages")` and `openThread()` go there too. `?waiting=1`, money links and
  `?classic=1` (Voice's "Dashboard" row) stay put. Switch: More > Settings >
  Texting screen, stored per browser as `mkd-voice-home`. Never fires on
  `*.test` / `127.0.0.1`, which is where the other suites load the classic app.
- **Add a feature back only when he names it** as one he uses. Don't bring
  dashboard extras over because they'd be handy; that is the bloat he's
  getting away from. When one goes in, list it here and give it a check in
  `test/gvoice.ui.test.js`.
- Opening a chat there marks it read (as Voice does), unlike the classic app's
  peek. `awaitingReply` is separate, so "Waiting on you" still holds.
