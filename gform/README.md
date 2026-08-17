# Log money from a Google Form

The closest of the three to the dashboard's own Log screen — big tap targets for
what it was, a number pad for how much, Submit. And unlike the doc, Forms has a
real submit trigger, so it lands in about a second.

```
What was it?     ( ) Detail job   ( ) Pay JP   ( ) Fuel   ( ) Supplies …
How much?        [ 250 ]
Who / what for?  [ Dana ]                        ← optional
Anything else?   ( ) Nope — log it  ( ) Add detail →   ← optional
                 [ Submit ]
```

Three taps: pick, type, Submit. Everything else lives on a second page you only
see if you ask for it.

## Which one should you use?

|  | **Form** | Sheets | Docs |
|---|---|---|---|
| Confirmation | ~1 second | ~1 second | up to 5 min |
| Taps for a normal entry | **3** | 4 | — |
| Entry style | tap a button | type in cells | type or **dictate** |
| Wrong-category risk | none — you tapped it | none | a parser reads your words |
| See past entries | no | yes, in the sheet | no |
| Hands busy | no | no | **yes** |

Use the **Form** to log. Use the **Sheet** if you also want to see and fix what's
already in there. Use the **Doc** when your hands are wet and you want the mic.
All three write to the same ledger and none of them know about each other.

## Setup (once, on a computer — 5 minutes)

1. Make a new blank Google Form at [forms.new](https://forms.new). Name it **Money**.
2. **⋮ (top right) → Extensions → Apps Script**. Delete what's there.
3. Paste in [`Code.js`](./Code.js). Save.
4. Back on the form, reload the tab. A **💵 Money** menu appears.
5. **💵 Money → Set it up** — dashboard URL, then the dashboard password.
6. Authorize when Google asks (your own script, your own account — *Advanced → Go to…*).

It builds every question itself, wires the branching, installs the triggers, and
shows you the form's link.

**Put that link on your home screen.** On the phone: open it in Chrome or Safari →
share/menu → *Add to Home Screen*. Now it's a one-tap icon that opens straight to
"What was it?".

The password is stored in the script's private properties, **not in the form**, so
it doesn't travel with the form if you ever share the link.

### If the 💵 menu never shows up

Bound-script menus don't always appear, and Forms is the worst of the three for
it. There's a way in that doesn't need the menu at all:

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

## Using it

**Page 1** is the whole job most of the time:

- **What was it?** — the same buttons as the dashboard's Log screen, built from
  your live settings. Your helper's real name, and only the categories you've left
  switched on in the app.
- **How much?** — numbers only, which is what makes the phone show a number pad.
- **Who / what for?** — one box that means two things: on a **job** it's the
  customer's name; on anything else it's what the money went on. (That's on
  purpose — customer names on jobs are what the roster and per-customer spend read.)
- **Anything else?** — leave it alone and Submit is the next thing you touch.
  Tap *Add detail →* for page 2.

**Page 2**, all optional: paid by, service, vehicle, hours worked, labor cost,
materials, still owes you, a different date, and a longer note.

After Submit you get a "Log another" link, so three things in a row is three quick
passes rather than three trips to the home screen.

## What the confirmation page tells you

`✓ Logged`, plus your balance, this month's in/out/profit and job count.

**Those numbers are one entry behind, and the page says so** — it prints the time
they were true. Google serves the confirmation page before the trigger has finished
running, so the totals you see are from just before the thing you submitted. Log
three in a row and by the third it's caught up.

If anything is stuck, the confirmation says so: `⚠ 1 entry has not reached the
dashboard yet.`

## Nothing gets lost

Submitting during a dead spot still works. The form keeps the response no matter
what, each one is stamped once it reaches the ledger, and a background sweep
re-sends anything that didn't make it. **💵 Money → Re-send anything stuck** does
the same on demand, and running it twice is safe — a response that already landed
is never posted again.

## What it won't do

- **No editing and no deleting.** A form only ever adds. Fix or remove entries in
  the dashboard's Log screen.
- **You can't see past entries here.** That's what the Sheets version is for.
- **It will not guess.** A response it can't read is refused rather than filed as
  a "misc" expense — though the required fields mean you'd have to work at it.

## Re-running Set it up

Safe, and the right move after you rename your helper or turn a category on or off
in the dashboard — it rebuilds the questions to match. **Your existing responses
are untouched**; Forms keeps those separately from the questions.

## How it works

No new endpoint, no new key, nothing added to the worker — same as the other two.
The script logs in at `POST /api/login` with the dashboard password like a browser
does and caches the session cookie.

| What | Where it goes |
|------|---------------|
| A submitted response | `POST /api/money/entry` |
| The confirmation numbers | `GET /api/money` |
| Setup, and each send | `GET /api/money/config` |

`test/gform.test.js` covers the response → entry mapping, the double-submit guard,
the confirmation text, and asserts that every button the form can show maps to a
real type and category in `MONEY_CATS`.
