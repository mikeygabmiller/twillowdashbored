# Log money from Google Sheets

A Google Sheet that posts straight into the dashboard's money ledger. Same entries,
same totals, same reminders — you just don't have to open the dashboard to log a
job. In the cab: open Sheets, type three cells, tap a box.

The dashboard stays the source of truth. This sheet is a keypad pointed at it.

## Setup (once, on a computer — 5 minutes)

1. Make a new blank Google Sheet. Name it something like **Money log**.
2. **Extensions → Apps Script**. Delete whatever's in `Code.gs`.
3. Paste in everything from [`Code.js`](./Code.js). Save (the disk icon).
4. Back on the sheet, reload the tab. A **💵 Money sync** menu appears next to Help.
5. **💵 Money sync → Set it up**. It asks for two things:
   - the dashboard URL — `https://texting.mikeysdetailingsnohomish.workers.dev`
   - the dashboard password (leave blank if it never asks you for one)
6. Google will ask you to authorize the script. It's your own script in your own
   account — click through the "unverified app" warning via *Advanced → Go to…*.

That's it. It builds the tabs, the dropdowns and the checkbox column, installs the
triggers, and pulls your current numbers down.

The password is stored in the script's own private properties, **not in a cell** —
so if you ever share the sheet with someone, the password doesn't go with it.

### If the 💵 menu never shows up

Bound-script menus don't always appear — it happens. There's a way in that doesn't need the menu at all:

1. In the Apps Script editor, **⚙ Project Settings → Script properties → Add**:
   - `DASH_URL` → `https://texting.mikeysdetailingsnohomish.workers.dev`
   - `DASH_PW` → your dashboard password (skip this row if it never asks you for one)
2. Back on the **Editor** tab, pick **`setUpHere`** in the function dropdown at
   the top, and press **▶ Run**. Authorize when asked.

That does exactly what the menu item does.

### Never click Deploy

There is no deploy step, ever. These scripts aren't web apps — they run from the
container and from triggers. Clicking **Deploy** produces a
`script.google.com/macros/…/start?mid=…` link that can only ever show
*"Sorry, unable to open the file at this time"*, because there's nothing there to
open.

Also: if you're signed into more than one Google account, do all of this in the
account that owns the file. A `authuser=1` in the address bar means the browser
is using your *second* account, which is its own source of that same error.

## Using it in the cab

The **Log** tab. The first four columns are the whole job:

| Date | What | Amount | Log it |
|------|------|--------|--------|
| today, pre-filled | dropdown | 250 | ☐ → tap it |

Tap **Log it** and the row posts. A second later the box unticks itself and
**Status** reads `✓ logged 2:14 PM`. Green row = it's in the dashboard.

Everything to the right of Status — Customer, Phone, Service, Paid by, City,
Vehicle, Hours, JP cost, Materials, Still owed, Note — is the same optional detail
the dashboard hides behind "more". Fill it when it's worth filling, ignore it the
rest of the time. Those columns only apply to a Detail job; on an expense row
they're ignored.

The **What** dropdown is built from your live settings — your helper's real name,
your service types, and only the expense categories you've left switched on in the
dashboard. Turn a category off in the app and re-run *Set it up* to match.

### Fixing a row

Change the amount (or anything else) on an already-logged row and tick **Log it**
again. It updates the same entry rather than making a second one — even if you
change the date to a different month.

### Deleting

**Deleting a row here does nothing to the ledger.** That's deliberate: a row is one
accidental swipe from gone in the mobile Sheets app, and a swipe should never be
able to erase a day's income. Delete entries in the dashboard's Log screen.

*Tidy up synced rows* clears the rows that already posted, so the sheet doesn't
grow forever. It only removes rows marked `✓`, and only from the sheet.

### The other tabs

- **Today** — money you have now, this month's income / spend / profit, jobs, what
  customers still owe you, this week. Read-only; it's a mirror.
- **This month** — every entry in the current month as the dashboard has it.

Both refresh on *💵 Money sync → Pull today + this month*. Nothing you type on
those tabs goes anywhere.

## When it doesn't go through

Status shows `⚠ …` and the row goes pink. The tick **stays on** in that case, and a
background job re-tries every 10 minutes — so a dead spot with no signal costs you
a delay, not the entry.

- `⚠ needs an amount` / `⚠ pick a "What"` / `⚠ bad date` — the row isn't finished.
- `⚠ Login failed` — the dashboard password changed. Re-run *Set it up*.
- `⚠ Dashboard said 401` — same thing.

Offline entirely? Type the rows and tick them anyway. Sheets queues the edits and
they post themselves once you have signal again.

## How it works

No new endpoint, no new API key, nothing added to the worker. The script logs in at
`POST /api/login` with the dashboard password exactly like a browser does, caches
the session cookie, and then:

| What | Where it goes |
|------|---------------|
| Ticking **Log it** | `POST /api/money/entry` |
| *Pull today + this month* | `GET /api/money` |
| *Set it up* | `GET /api/money/config` |

Which means the sheet gets the ledger's validation for free — bad amounts bounce,
categories are checked against the real list, and entries land in the same month
docs the evening reminder, the weekly recap and the profit report all read.

`test/sheets.test.js` covers the row → entry mapping, including a check that the
sheet's category list still matches `MONEY_CATS` in `src/index.js`. If someone adds
a category to the app and not here, that test fails.
