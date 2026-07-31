# Morning Digest (Google Apps Script)

A personal daily briefing: Reddit RSS → Gemini → email. Standalone Apps Script,
unrelated to the Cloudflare Worker in this repo — it lives here so it is
version-controlled and so the updater below has a URL to pull from.

## Files

| File | What it is |
| --- | --- |
| `MorningDigest.gs` | The digest itself. Runs on a daily trigger, emails the rundown. |
| `DigestUpdater.gs` | A separate tiny project that pulls `MorningDigest.gs` from this repo into the digest project, so the code never has to be pasted by hand. |

## Deploying without a terminal

`DigestUpdater.gs` is the only file ever pasted manually, and only once. It
calls the Apps Script API with its own OAuth token (`ScriptApp.getOAuthToken()`)
to rewrite the digest project's source — no `clasp`, no service account, no
stored refresh token.

Full setup lives in the header comment of `DigestUpdater.gs`. The short version:

1. Enable the Apps Script API at <https://script.google.com/home/usersettings>.
2. New Apps Script project → paste `DigestUpdater.gs`.
3. Add the `script.projects` and `script.external_request` scopes to its
   `appsscript.json` (they are not auto-detected).
4. Set `TARGET_SCRIPT_ID` and `SOURCE_URL` in Script Properties.
5. Run `pullNow`.

`SOURCE_URL` is the raw URL of `MorningDigest.gs` on whichever branch you treat
as current — update it if that branch changes.

The updater refuses to push anything that is under 4 KB or missing the
`function sendMorningDigest` sentinel, so a 404 page or a truncated download
cannot overwrite a working digest.

## Digest configuration

Set in `MorningDigest.gs`:

- `SEND_HOUR` — local hour for the daily trigger (respects the script timezone).
- `TOPICS` — subreddit groups, each with a `hint` that steers the summary and an
  optional `max` item count.
- `POSTS_PER_SUB`, `ITEMS_PER_TOPIC`, `COMMENT_POSTS` — collection budgets.

Secrets go in Script Properties, never in the file: `GEMINI_API_KEY` for the
digest, and `GITHUB_TOKEN` for the updater only if this repo is private.

Run `previewToLog` to build the whole digest without sending mail; the log ends
with a per-subreddit source report.
