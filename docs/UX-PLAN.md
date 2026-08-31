# Dashboard UX Plan — from 71 surfaces to 5 places

Goal: stop the scrolling. Every feature gets one home, the nav stays under five
choices, and the search bar finds *features*, not just messages.

---

## 1. The actual problem, in numbers

Counted from `public/index.html` (10,525 lines) as it ships live today:

| Surface | Count |
|---|---|
| Bottom-nav tabs | 6 |
| Drawer items | 25 |
| Money sub-views (`data-mv`) | 5 |
| Analytics sub-views (`GROW_VIEWS`) | 6 |
| Jobs sub-views (`data-jv`) | 4 |
| Customize panels (`CZ_TABS`) | 7 |
| **Navigable destinations** | **53** |
| Home widgets (`UI_HWIDGETS` + 5 pinned) | 18 |
| **Total surfaces competing for attention** | **71** |

Plus 24 full-screen `open*()` functions and 3 separate HTML pages.

Three structural faults make those 71 feel like 200:

**a) No navigation stack.** Zero `popstate` handlers in the file. Nothing
pushes history. On the installed PWA, hardware back exits the app instead of
closing the sheet you're in — so every screen is a one-way trip you must
manually reverse, and there are four different ways to reverse it
(`closeMoney`, `grBack`, scrim tap, `taHome`).

**b) The nav lies.** Six buttons look like tabs; only four are.

```js
if(tb==="money")return openMoney();
if(tb==="analytics")return openAnalytics();
setTab(tb)
```

Money and Analytics open overlays without setting `state.tab`, so the active
pill never lands on them.

**c) Duplicate entry points.** Four drawer items are already nav tabs, under
different names — "Money" / "Money tracker", "Analytics" / "Analytics —
website & business", "Leads" / "Leads pipeline", "Jobs" / "Today's Run". The
same door, labelled twice, reads as two different rooms.

And one dead switch: `UI.mode` ("Pro mode") is written in `czSafe` and read in
exactly two places — a label and a toggle. **Nothing in the app respects it.**
The progressive-disclosure mechanism already exists and is wired to nothing.

---

## 2. Principles this plan applies

- **Hick's Law** — decision time rises with the number of choices. 25 drawer
  items is a scan, not a choice.
- **Material 3 / Apple HIG** — bottom navigation holds 3–5 destinations. Six
  is over, and the sixth (Analytics) is the least-used and the only one
  without a badge.
- **Progressive disclosure** (Nielsen Norman) — show the daily 20%, keep the
  rest one deliberate tap away. This is what `UI.mode` was meant to do.
- **Recognition over recall** (Nielsen heuristic #6) — you shouldn't have to
  remember that invoicing lives under "Get paid". Search should surface it.
- **Jakob's Law** — the app should behave like the apps already on the phone:
  back goes back, Cmd+K/`/` opens search, Esc closes.
- **Fitts's Law** — five thumb targets across a phone bottom bar are
  comfortable; six are cramped.
- **Task-based grouping over feature-based** — group by *what you're doing*,
  not by *what built it*.

---

## 3. Target architecture — five tabs

```
Today  ·  Chats  ·  Work  ·  Money  ·  More
```

> **Shipped 2026-08-31 (`2026-08-31·reorg`).** "Pipeline" shipped as **Work** —
> the plan's own rule is task-based grouping in the customer's language, and he
> calls all of it the work. Analytics left the bar as planned, came back as
> "Stats" in navV3 on a hunch, and has now left again on measurement rather
> than argument — see §10.

The insight behind the biggest merge: for a detailing business,
**lead → quote → booked job → done → paid** is *one* pipeline, not four
features. Today it's split across a Leads tab, a Jobs tab, a Bookings page and
a Quotes drawer item. Merging them isn't just tab-count reduction — it matches
how the work actually flows.

| Tab | Holds | Answers |
|---|---|---|
| **Today** | The prioritized rundown, today's schedule, today's money | "What do I do next?" |
| **Chats** | All conversations + filter chips | "Who needs a reply?" |
| **Work** | Booked → Leads → Quotes → Run → Pay → Garage | "What work is coming?" |
| **Money** | Log, Owed, Report, Goals, Get paid | "Where do I stand?" |
| **More** | AI, Insights, Day tools, Settings, Account, Everything A–Z | Everything weekly-or-rarer |

Analytics leaves the nav bar because it's a weekly/monthly review, not a daily
action — it stays one tap away in More and reachable instantly by search.

---

## 4. Where every existing feature goes

Nothing is deleted. This is the full relocation map.

### → Today (was Home)
`brief` · `money` · `schedule` · `quickactions` · pinned `needs` rundown

The `needs` rundown already merges waiting + follow-ups + reminders and
de-dupes them — it's the best thing on the screen. It absorbs **today's jobs**
and **unpaid invoices** too, so Today becomes *one prioritized list* instead of
a stack of cards. Remaining widgets (`goal`, `rebook`, `sla`, `tasks`, `trend`,
`funnel`, `vip`, `weather`, `stats`) move to a collapsed "More on today"
section — header visible, body tucked.

### → Chats
All messages · Unread · Follow-ups · Scheduled texts · Archived

These four are currently separate `state.tab` values (`followups`,
`scheduled`, `archived`) and drawer items. They become **filter chips** in the
existing `#filters` bar. Same code path (`renderList`), one screen.

### → Pipeline (Leads + Jobs merged)
Leads board · Quote builder · Bookings · Today's Run · Customer garage

Stages of one flow, as a segmented control. `bookings.html` stops being a
`location.href` page load and becomes a view here.

### → Money
Log · History · Report · Goals · Get paid · Payment setup · Money settings

Already has `data-mv` segments for log/history/report/goals/settings. "Get
paid" (`openPayRequest`) and "Payment setup" (`openPaySetup`) join as
segments instead of floating drawer items.

### → More
**AI** — Command AI · Train AI · Talk to your dashboard · Business playbook
**Insights** — Analytics (all 6 `GROW_VIEWS`)
**Settings** — Customize · Follow-ups & calls · Team · Appearance · Phone notifications
**Account** — Connection · Refresh · Test alert · Snapshot for Claude · Sign out

The `Settings` drawer group currently inlines whole panels (`fuSettings`,
`teamPanel`, `themeSeg`, `accentRow`) — that's why the drawer scrolls forever.
Those become links to a real settings screen.

**Result: 25 drawer items → 0.** The drawer disappears entirely; More replaces
it with a scannable, grouped screen.

---

## 5. Search that finds features

This is the piece that makes 71 surfaces stop mattering: if you can *name* it,
you can reach it in two keystrokes, so it doesn't need to be visible.

Today `state.search` only feeds `renderMain()` → thread lists. The placeholder
already promises `status:won, tag:ceramic, is:unread`. We keep all of that and
add a feature index.

**A feature registry** — every destination declared once:

```js
var FEATURES=[
  {id:"pay",      title:"Get paid",       group:"Money",
   keywords:["invoice","charge","stripe","payment","bill","send invoice"],
   run:function(){openMoney("pay")}},
  {id:"quotes",   title:"Quote builder",  group:"Pipeline",
   keywords:["estimate","bid","proposal","price"],
   run:function(){openPipeline("quotes")}},
  {id:"trainai",  title:"Train AI",       group:"AI",
   keywords:["teach","voice","tone","style","learn"],
   run:openTrainAI},
  // …one entry per destination
];
```

Keywords matter more than titles: you think "invoice", the app says "Get paid".
Recognition over recall means the *search* bridges that gap, not your memory.

**Grouped results**, best-match first:

```
┌─────────────────────────────────────┐
│ 🔍 invoice                          │
├─────────────────────────────────────┤
│ FEATURES                            │
│  💳 Get paid            Money    ↵  │
│  📄 Quote builder       Pipeline    │
│  💰 Payment setup       Money       │
├─────────────────────────────────────┤
│ PEOPLE                              │
│  👤 Dave K.   "sent the invoice…"   │
├─────────────────────────────────────┤
│ MONEY                               │
│  $340  Ceramic — Dave K.   Jul 12   │
└─────────────────────────────────────┘
```

**Empty state does work too** — recent destinations + 4 suggested actions, so
the search bar is useful before you type anything.

**Open with `/` or Cmd/Ctrl+K, close with Esc, Enter runs the top hit.** Same
gesture as every other tool on the phone and laptop (Jakob's Law).

---

## 6. One navigation model

A single stack, and every screen uses it:

- Opening any screen or sheet does `history.pushState`.
- A `popstate` handler pops the top layer — hardware back, browser back and
  the on-screen back chevron all do the same thing.
- **One** back affordance: a chevron top-left of every screen header. Retire
  `closeMoney` / `grBack` / `taHome` / scrim-tap as four separate idioms.
- Esc closes the top layer everywhere, not just the context menu and Train AI.

This is ~40 lines and it is the difference between "an app" and "a pile of
overlays".

---

## 7. Make `UI.mode` real

`UI.mode` already exists and does nothing. Wire it:

- **Simple** (default) — 5 tabs, Today shows the rundown + 3 widgets, More
  shows 4 groups. Everything else exists and is reachable *by search*.
- **Pro** — advanced widgets on by default, extra segments visible, power
  filters exposed.

Progressive disclosure with an escape hatch: nothing is hidden from search,
ever. Hiding a feature from the *screen* is safe precisely because search
finds it.

---

## 8. Phases

Each phase ships on its own and is independently useful.

| Phase | Work | Status |
|---|---|---|
| **1. Spine** | History stack + `popstate`, one back idiom, Esc-to-close | ✅ shipped |
| **2. Search** | Feature registry, keyword synonyms, `/` + Cmd+K, empty state | ✅ shipped |
| **3. Five tabs** | Merge Leads+Jobs → Pipeline, Analytics → More, chat filters as chips | ✅ shipped |
| **4. Kill the drawer** | More screen, 25 drawer items retired, settings one level down | ✅ shipped |
| **5. Today** | Rundown absorbs jobs + unpaid, rest collapses | not started |
| **6. Simple/Pro** | Wire `UI.mode` to real behaviour | not started |

Two things named above were **not** done and are still open:

- **Bookings is still a separate page.** `public/bookings.html` is a standalone
  388-line page; making it an in-app Pipeline view means porting its logic, not
  moving a link. It stays a `location.href` from More, and search finds it.
- **`UI.mode` is still wired to nothing** (phase 6).

**Ship order note:** `public/index.html` is 468K in one file. Phase 1 and 2 are
additive and low-risk. Before Phase 3, split Money, Analytics and Pipeline into
separate modules — otherwise the tab merge is a large edit in a file where
every change is risky.

---

## 9. Before / after

| | Now | After |
|---|---|---|
| Nav tabs | 6 (2 fake) | 5 (all real) |
| Drawer items | 25 | 0 |
| Ways to go back | 4 idioms, no hardware back | 1 idiom + hardware back |
| Top-level destinations | 53 | 5 |
| Find a feature by name | ✗ | ✓ two keystrokes |
| Separate page loads | 1 (`bookings.html`) | 0 |

---

## 10. What the usage tracker said (90 days, measured 2026-08-31)

Everything above was reasoned from heuristics. This section is the first time
the plan was checked against what actually happened, via `/api/use/export`.
Where the two disagree, this section wins.

**Where the time goes.** Of roughly 76 tracked minutes on screen, 59 were in a
single conversation — **78%**. Nothing else is close. Every other screen in
this app is a place he passes through on the way to a thread.

| Screen | Opens | Minutes | Walked straight out |
|---|---|---|---|
| a conversation | 82 | 59 | 11 |
| Tab · Today | 101 | 6 | **68** |
| Tab · Chats | 118 | 4 | **92** |
| Screen · money | 12 | 0 | **11** |
| Stats (all 9 reports) | 9 | 2 | 7 |

**The single most-pushed control in the whole app** was the Chats pill *on the
Today tab* — 45 presses. He opens Today to find out who needs him, and then
leaves to go and find them. That is why the "Needs your attention" rundown moved
above the AI command center: Today was answering a question he wasn't asking
first.

**Stats.** Nine reports, opened nine times in a quarter between them. Four —
Customers, Profit, Pulse, Map — were **never opened at all**. A nine-across
segment bar on a 414px phone gives each report 46px, which is not a label
anyone can read. This is what §2's Fitts's Law point predicted, and the fix is
the same one the plan prescribes for the drawer: an index screen where each
report says what it answers and shows the number it last read.

**624 controls had never once been pushed.** A share of that is simply not
knowing a screen exists, which is what "Everything, A–Z" is for — `FEATURES`
was already a complete map of the app, but it only rendered as search results,
and you have to know to search.

**What the tracker did *not* justify.** Money bounces 92% (12 opens, 0 minutes,
11 immediate exits), which reads as either a glance that succeeds or a trip
that fails, and the data cannot tell those apart. It kept its pill. Worth
watching, not worth acting on yet.

**One caveat on all of the above:** the tracker started recording on
2026-08-25, so this is 7 active days of data, not 90. It is enough to retire a
hunch that was never measured at all; it is not enough to be precious about.

### A note on the tracker's own keys

The usage tracker still records `Stats · <view>` and `Pipeline · <view>`, not
`Insights ·` and `Work ·`. That is deliberate. It is a measuring instrument
with history in it, and renaming the keys would split every report into a
before-row and an after-row and quietly end the comparison this whole
reorganisation was argued from. The screen names in the export are not the
screen names in the app, and `USE_OWNED` in `public/index.html` is where that
is kept honest.
