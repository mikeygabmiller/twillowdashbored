# Log money from a Google Doc

A doc you type — or **talk** — into. One line per thing:

```
250 job Dana venmo
40 fuel
60 jp
8/14 120 job Mike full detail cash
```

A few minutes later each line grows a mark:

```
250 job Dana venmo   ✓ Detail job $250
40 fuel              ✓ Fuel $40
```

Same ledger as the dashboard, same `/api/money/entry`, same totals and reminders.

## Read this before you pick Docs over Sheets

**Google Docs has no edit trigger.** Not a simple one, not an installable one —
Sheets gets `onEdit`, Docs gets nothing, and menus don't exist in the mobile Docs
app at all. So a doc physically cannot sync the moment you type. The only way is a
clock that reads the doc on a schedule.

What that means in practice:

|  | Sheets | Docs |
|---|---|---|
| Confirmation | ~1 second | up to 5 minutes |
| Entry | tap cells, pick from a dropdown | type or dictate a line |
| Wrong-category risk | near zero — you picked it | a parser reads your words |
| Hands busy | no | **yes — this is the reason to use it** |

The mic is the trade. If you want to say *"two-fifty job Dana venmo"* while your
hands are wet and check it later, this is better. If you want to see `✓` before you
put the phone down, use the sheet.

You can run both. They write to the same ledger and don't know about each other.

## Setup (once, on a computer — 5 minutes)

1. New blank Google Doc. Name it **Money**.
2. **Extensions → Apps Script**, delete what's there, paste in [`Code.js`](./Code.js), save.
3. Reload the doc. A **💵 Money** menu appears.
4. **💵 Money → Set it up** — dashboard URL, then the dashboard password.
5. Authorize when Google asks (your own script, your own account — *Advanced → Go to…*).

It installs a background check every 5 minutes and drops your current numbers at
the top of the doc.

The password is stored in the script's private properties, **not in the doc**, so
it doesn't travel with the doc if you ever share it.

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

## Writing a line

Order doesn't matter — `250 job Dana` and `job Dana 250` both work, because
whichever one comes out of the mic is a coin flip.

- **Amount** — `250`, `$250`, `43.56`
- **What it was** — one of:
  - job · detail · wash
  - jp · labor · helper *(or your helper's actual name)*
  - fuel · gas
  - supplies · soap · chems · chemicals
  - equipment · tools
  - food · lunch
  - bills · rent
  - marketing · ads
  - insurance
  - phone · internet
  - misc
  - personal
- **On a job, optionally** — cash / venmo / zelle / check, a service (interior,
  exterior, full, add-on), a vehicle (sedan, suv, truck, van, boat, rv). Anything
  left over becomes the customer's name.
- **Backdating** — start the line with `8/14`, `8/14/25`, `yesterday` or `today`.
  A bare `12/28` typed in January means last December, not next.

## What it won't do

- **A line it can't read gets `⚠ what was it?` and is never sent.** It will not
  guess. Guessing "expense" on a line it didn't understand would quietly bury
  $250 of income in the fuel column, and nothing on screen would look wrong.
- **Deleting a line does nothing to the ledger.** The doc is an inbox, not the
  books. Delete entries in the dashboard.
- **Lines with no numbers are left completely alone** — headings, notes to
  yourself, a shopping list. No marks, no warnings.

## When it doesn't go through

- `⚠ no amount` / `⚠ what was it?` — the line is missing one of the two things it
  needs. Fix the line, then delete the `⚠ …` text so it gets picked up again.
- **No mark at all after a while** — usually no signal. Network failures are left
  unmarked on purpose so the next sweep retries them; a parse problem needs you,
  a dead spot just needs a minute.
- **The line you're still typing waits.** It only goes once it reads the same on
  two sweeps in a row, so a half-finished line never posts as a real entry.
- **Voice wrote "two fifty" instead of "250"** — no digits means no entry, and the
  line is silently skipped. Worth glancing for missing `✓`s at the end of the day.

*Show my numbers* refreshes the grey line at the top. That line starts with an em
dash, which is how the parser knows it isn't an entry — don't start your own lines
with one.

## Speed vs. Google's quota

Default is every 5 minutes. **💵 Money → Check every minute instead of every 5**
speeds it up. A free Google account gets 90 minutes of background script time per
day, which a 1-minute check could get close to — so each sweep asks Drive whether
the doc changed at all and stops right there if it didn't. Idle checks cost
almost nothing, and it's only your real edits that spend the budget.

## How it works

No new endpoint, no new key, nothing added to the worker — same as the Sheets
version. The script logs in at `POST /api/login` with the dashboard password like
a browser does and caches the session cookie.

| What | Where it goes |
|------|---------------|
| A finished line | `POST /api/money/entry` |
| *Show my numbers* | `GET /api/money` |
| Setup, and each sweep | `GET /api/money/config` |

`test/gdoc.test.js` covers the parser — word order, spoken synonyms, backdating,
which lines are safe to send, and a check that every category it can produce is a
real one in `MONEY_CATS`.
