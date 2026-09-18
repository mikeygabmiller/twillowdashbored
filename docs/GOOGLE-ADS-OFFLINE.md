# Telling Google about the leads its tag never saw

Google Ads reported **2 conversions** in a month this dashboard recorded **27
leads** in. Four of those 27 were traced, through the Journeys board, to clicks
Google itself had billed for. Google counted almost none of them.

The tag on the site is not broken. It is installed, it is intercepting, and both
of its conversion labels decode to the right actions in the account
(`7745314558` "Site tap-to-call" and `7760469729` "Submit lead form", under
`AW-16856115492`). It still cannot count these leads:

- **~94% of the ad traffic is mobile.** Safari's tracking prevention expires the
  `_gcl_aw` cookie after 7 days, and people take longer than a week to book.
- **An ad blocker replaces `gtag.js` with a do-nothing stub.** It reports
  nothing and looks perfectly healthy doing it.
- **No browser tag can see a phone call or a text.** Nothing happens in a
  browser when somebody dials. Calls and texts were **11 of the 27**.

Offline conversion import goes around all three. Instead of a cookie in a
browser, you hand Google the **click id** and it matches the conversion to the
click it charged you for.

---

## The one thing that can't be fixed later

The click id (`gclid`) is in the URL for exactly one page load. The worker now
stamps it onto the visitor's journey the moment they land, first touch only, and
it rides along to the lead when they leave their number.

**Leads from before this shipped cannot be recovered** — their click ids were
read for "was this paid?" and thrown away. And Google's import window closes
**90 days after the click**, so a month not uploaded is a month gone.

## Getting the file

Signed in to the dashboard, open:

```
/api/ads/conversions
```

That downloads `google-ads-conversions.csv`. It covers the last 45 days by
default (`?days=90` for the widest window Google will accept, though journeys
self-delete at 45). `?format=json` gives the same scan as numbers — row count,
how many carry a real booked amount, what got skipped — for a look before you
upload.

It sits behind the dashboard password, like everything else under `/api/`,
because a click id identifies one person's click. That also means Google's own
**scheduled** import can't fetch it: Google requests the URL with no
credentials. This is a download-and-upload, on purpose.

## Uploading it

1. **Goals** icon → **Conversions** → **Uploads**
2. **+**, pick the file, choose **unhashed**
3. **Preview** first. It reports rows accepted and rows rejected with a reason.
4. **Apply**

Then wait. Google takes a few hours to fold uploaded conversions into the
campaign columns, and it backdates them to the click, so the numbers appear
against the day of the click and not the day you uploaded.

## What's in a row

| Column | What goes in it |
|---|---|
| Google Click ID | the `gclid` captured when they landed |
| Conversion Name | `Submit lead form`, or `Site tap-to-call` for a tap with no form |
| Conversion Time | the moment they became a lead, in Pacific |
| Conversion Value | the **booked job amount** if one is logged, otherwise the quote |
| Conversion Currency | `USD`, only when there is a value |
| Order ID | `<visitor id>-form` / `-call` |

**The value is the point.** Smart bidding optimises for the number you give it.
"A lead is a lead" teaches it to find more form-fillers; the $379 truck detail
you actually got paid for teaches it to find more trucks. So the export prefers
the job you logged in Money over the calculator's estimate, and matches on phone
number within 120 days of the lead.

**The Order ID makes re-uploading safe.** Google de-duplicates on conversion
action + time + order id, so the same visitor in next month's file lands on the
row it already has instead of doubling it. Overlapping windows are fine.

## What it deliberately leaves out

- **One row per visitor, not one per event.** Somebody who tapped CALL and then
  filled the form is one lead, and the form row is the one that can carry money.
- **`gbraid` and `wbraid`** (Google's iOS click ids) are captured on the journey
  but not exported. The CSV importer has one click-id column and it is the
  gclid; those two can only go up through the API. `?format=json` counts them
  under `skipped.braid` so you can see if it is ever more than a trickle.
- **Organic leads.** No click, nothing to match, nothing to upload.

## One thing to decide

The site tag and this file feed the **same two conversion actions**. When the tag
does manage to fire, that lead can be counted twice — once by the tag, once by
the upload, because the two timestamps differ by a few seconds and Google only
de-duplicates on an exact match. Given the tag is delivering roughly 2 of 27,
the overlap is small. If it starts to matter, the fix is a second pair of
conversion actions used only for uploads, and the two names at the top of the
offline-import section in `src/index.js` change to match.
