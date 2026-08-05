# Ember — a daily Catholic app your friends will actually open

A plan for replacing the Reddit-scraping prayer app with something people use every
day and text to their friends unprompted.

---

## 0. The honest diagnosis

Pulling from Reddit was never going to work, for three reasons worth naming so we
don't rebuild them in a new shape:

1. **No authority.** Nobody forwards a Reddit comment to their mom. Catholic content
   earns trust from *provenance* — a saint's name, a date, a century, a source.
2. **No rhythm.** A feed is infinite and therefore never finished. The Church already
   solved this: the liturgical calendar gives every single day its own identity.
   That's a free, 1,700-year-old content structure and we should use it.
3. **No reason to return.** A feed you can scroll forever has no "done." An app you
   finish in five minutes and feel good about closing is the one that survives.

So: **kill the feed. Ship a day.**

---

## 1. The core idea

**One page. One day. Five minutes. Then you're done.**

Ember opens directly to today — no menu, no home screen, no "browse." The date is the
app. You read it, you pray it, you sit with one question, you close it. If you come
back at 9pm, it offers a 60-second examen and goes to sleep.

The entire product is the quality of that one page, repeated 365 times.

### Why "Ember"

*Ember Days* (Quatuor Tempora) are the Church's four ancient seasonal fasts — so the
name is quietly, correctly Catholic. It also means the small live coal you keep
overnight to start tomorrow's fire, which is exactly what a daily prayer habit is.
Alternates if it doesn't land: **Vigil**, **Sub Tuum** (from the oldest known Marian
prayer), **Kindling**, **The Ninth Hour**.

---

## 2. The shape of a day

Six blocks, always in this order, always on one scrolling page.

### ① The Date Line
> **Wednesday, August 5** · Dedication of the Basilica of St. Mary Major
> *Ordinary Time · Week 18 · White*

Small, but it does enormous work: it tells you the day is *particular*. And the
liturgical color tints the whole page (see §4) — the app visibly changes with the
Church year. This is the first thing people screenshot.

### ② A Line to Carry
One sentence in large type. Scripture, or a saint. The thing you still have in your
head at 3pm.

> *"Late have I loved you, beauty so old and so new."*
> — Augustine, *Confessions* X.27, c. 398

### ③ The Story — 250–400 words
Not a homily. A **story**, with a hook, a turn, and a landing. This is the engine of
the whole app, because Church history is genuinely wild and almost nobody knows it.

Real examples, one per day:

- **Aug 5** — On a August night in 358, snow fell on the Esquiline Hill in the middle
  of a Roman summer, tracing the exact floor plan of a church. A childless couple and
  the Pope had dreamt it the same night. They built on the snow's footprint. The
  basilica is still standing. Every August 5, they drop white rose petals from the
  ceiling.
- **Aug 9** — Edith Stein, Jewish philosopher and atheist, picked up Teresa of Ávila's
  autobiography at a friend's house and read it straight through the night. At dawn
  she closed it and said, *"This is the truth."* She died at Auschwitz in 1942.
- **Aug 14** — Maximilian Kolbe stepped out of the line at Auschwitz to take a
  stranger's place in the starvation bunker. The stranger, Franciszek Gajowniczek,
  lived to 93 — and stood in St. Peter's Square in 1982 to watch Kolbe canonized.
- **Nov 23** — Pascal's "Night of Fire." After he died, a servant found a parchment
  sewn into the lining of his coat: *"FIRE. God of Abraham, God of Isaac, God of
  Jacob — not of the philosophers and scholars."* He'd carried it, stitched into
  whatever he was wearing, for eight years.

**Editorial rule: every story carries a date and a source.** That's the whole
credibility model.

### ④ The Prayer
The "unique prayers" ask. Two kinds, alternating:

**(a) Old prayers nobody taught them.** Presented with a one-line provenance note,
because the note is what makes people care:

| Prayer | The hook |
|---|---|
| *Sub Tuum Praesidium* | Oldest known prayer to Mary — found on an Egyptian papyrus, c. 250 AD. Christians were still being fed to lions when someone wrote this down. |
| The Litany of Humility | Written by a cardinal in the Vatican. Brutal. *"That others may be preferred to me in everything…"* |
| The Suscipe | Ignatius: *"Take, Lord, and receive all my liberty."* |
| St. Patrick's Breastplate | 8th century Irish war-armor, as a prayer. |
| Anima Christi | Prayed by Ignatius daily; older than he is. |
| Thomas More's prayer for good humor | Written awaiting execution in the Tower of London. It asks for a sense of humor. |
| Newman's *Radiating Christ* | The one Mother Teresa's sisters say every morning. |

**(b) Original short prayers**, written for the day's theme — 4–8 lines, plain
English, no thees and thous. These are what make Ember feel like *ours* rather than a
reprint.

Latin/English toggle on the traditional ones. People love this and it costs nothing.

### ⑤ The Question — private
One question to sit with. Free-text box, **stored on the device, never sent
anywhere.** Not a quiz, not a journal prompt. A question with teeth:

> *Who have you not forgiven, because forgiving them would mean admitting the wound
> was real?*

> *Kolbe stepped out of a line. What line are you standing in, quietly hoping nobody
> calls your name?*

**The retention mechanic:** on the same date next year, the app shows you what you
wrote. That's a reason to still have the app in 12 months.

### ⑥ The Hard Question — the sleeper feature
A real apologetics question, answered honestly in ~150 words, charitably, with
sources.

> *"Why do you confess to a priest instead of straight to God?"*
> *"Isn't Purgatory made up? It's not in the Bible."*
> *"Jesus said call no man father. So why do you?"*
> *"Why do you pray to Mary?"*

This is the differentiator. **Every practicing Catholic gets asked these at work and
at Thanksgiving and freezes.** Nobody delivers the answers in a calm daily bite. This
is the block that makes someone say *"dude, download this"* — it makes them feel
equipped, not just edified. Rules: steel-man the objection first, never sneer, always
cite (Catechism paragraph + scripture).

### Evening (optional) — The Examen
60 seconds, five taps, Ignatian: *Where was there light today? Where did I look away?*
Fires as an 8:30pm notification only if you've turned it on.

---

## 3. Why they'll tell their friends

Content alone doesn't spread. Three mechanics do:

### The Prayer Circle — the killer feature
A small private group (cap it at ~12; intimacy is the point). You post an intention:

> *"My mom's surgery is Thursday morning."*

Friends tap **Praying** — one tap, no comment box, no obligation to be eloquent. You
get: *"4 people prayed for this."*

That notification is the most emotionally loaded thing this app can send, and it costs
the sender one tap. And it is **structurally viral**: the feature does not work unless
you invite your actual friends. That's the growth engine — not a share button.

No DMs, no comment threads. One button. That's deliberate: it makes moderation nearly
free and keeps the group from turning into a group chat people mute.

### Candles
Tapping *Praying* lights a candle on the intention that visibly burns for 24 hours,
then goes out. Tactile, beautiful, and it makes the screen feel alive. An intention
with nine candles on it says something no counter does.

### The Share Card
One tap renders the day's Line + story hook as a genuinely beautiful image — sized for
an iMessage or an Instagram story, with the liturgical color and a small `ember.app`
mark. This is how it leaves the app.

### Streaks — but Catholic about it
Show **"37 days walked."** Never *"Don't lose your streak!"* Missing a day shows:
*"Yesterday's still there when you want it."* Guilt-driven gamification is exactly
wrong for this audience and will make it feel like Duolingo. A missed day is not a
lost state of grace and the app shouldn't imply it is.

---

## 4. The design — the thing that makes it feel expensive

**The liturgical color is the app's entire theme system, and it changes itself.**

| Season / day | Color | Hex (deep + tint) |
|---|---|---|
| Ordinary Time | Green | `#1F5741` / `#E8F0EA` |
| Advent, Lent | Violet | `#4A2A63` / `#EDE7F2` |
| Gaudete, Laetare | Rose | `#B3627A` / `#FBEDF1` |
| Christmas, Easter, feasts | White/Gold | `#8A6D2F` / `#FBF7EC` |
| Martyrs, apostles, Pentecost, Palm & Good Friday | Red | `#8C1D25` / `#F7EAEA` |

You open the app in Lent and it's violet. Third Sunday of Advent it's *rose for one
day* — and the people who notice that will absolutely text a screenshot to someone.
Nobody has to configure anything.

Rest of the system:
- **Serif for prose** (Crimson / Lora), **sans for chrome**. Long-form reading, not a dashboard.
- **Generous margins, ~62 characters per line.** It should read like a well-set book.
- **Real dark mode**, warm-toned — this gets used at 11pm in bed.
- **Zero chrome on open.** No nav bar, no tabs, no logo. Just the day.
- Gold leaf and an illuminated drop-cap on the story's first letter. One flourish, used consistently, does more than a hundred icons.

---

## 5. Where the content comes from (the part that kills projects like this)

### 5a. The liturgical calendar — compute it, don't fetch it
Easter is computable (Gauss/Computus, ~40 lines). Every moveable feast keys off it:
Ash Wednesday −46, Pentecost +49, Advent from Christmas backward. Fixed feasts are a
table. **~300 lines of JS, zero API dependencies, works offline forever, never breaks
because someone else's server went down.** Worth building properly on day one — it is
the spine of the whole app.

### 5b. Copyright — read this before writing a line of content
This is the real landmine and it's better to know now:

- **Traditional prayers** — public domain. Free and clear.
- **Saints' lives** — Butler's *Lives of the Saints* (1866) is public domain and is a
  fantastic source mine. We *rewrite* from it, we don't paste it.
- **Scripture** — ⚠️ the NAB (what the US lectionary uses) is **copyrighted by the
  USCCB/CCD** and you need permission. So: use the **Douay-Rheims** (public domain) or
  the **World English Bible Catholic Edition** (public domain), and *link out* to the
  USCCB site for the day's official Mass readings rather than reproducing them.
- **Catechism** — quoting short paragraphs with citation is normal practice; don't
  reproduce sections wholesale.

### 5c. The production pipeline
365 hand-written days is how this dies. Instead:

1. **Draft with an LLM against a strict brief** — one prompt per day, fed the day's
   saint/feast from the calendar engine, required to output the six blocks with a
   cited source for every factual claim.
2. **Human review in batches of ~30**, with a `reviewed: true` flag per day. Nothing
   ships unreviewed. Watch for: invented miracles, wrong dates, doctrinal slips, and
   the LLM's habit of making every saint sound identical.
3. **Store as flat JSON, one file per day**, in git: `content/08-05.json`. Editable by
   hand forever, diffable, no CMS, no database migration. Ships as static assets.
4. **Have a priest or a well-catechized friend read the Hard Question answers.** Those
   are the ones with real risk of being subtly wrong.

**Ship one season, not a year.** 40 well-made days beats 365 mediocre ones, and the
liturgical calendar gives you a natural unit to ship (Advent or Lent — both are
seasons where people are *actively looking* for exactly this app).

---

## 6. Tech — reuse what already works here

The detailing dashboard already proves out this exact stack, so there's no new
learning curve:

| Layer | Choice | Why |
|---|---|---|
| Host | Cloudflare Worker + `[assets]` | Same as `wrangler.toml` here. Free at this scale. |
| Content | Static JSON per day, served from assets | No DB, cacheable at the edge forever |
| Install | PWA — manifest + service worker | Adapt `public/sw.js`; shell-cache the same way |
| **Offline** | Cache 7 days ahead | Church, planes, basements. Non-negotiable. |
| Circles/intentions | **D1** (SQLite), not KV | Relational: users↔circles↔intentions↔prayers. KV is the wrong shape here. |
| Private answers | Device only (`localStorage`) | Never leaves the phone. Say so in the UI, loudly. |
| Notifications | Web Push + cron | Cron pattern already exists in this repo |
| Auth | Magic link by email | No passwords, no OAuth, no accounts until Phase 2 |

**Put it in its own repo and its own Worker.** Not this one — this repo has a live
production deploy contract, a minute-cron, and Twilio webhooks. Mixing a prayer app
into the detailing dashboard's deploy path is asking for a bad afternoon.

---

## 7. Build order

| Phase | What ships | Why this order |
|---|---|---|
| **0** | Liturgical calendar engine + **one perfect day**, hard-coded | Proves the feel. If one day isn't good, 365 won't be. Show it to 3 people. |
| **1** | 40 days of reviewed content, PWA, liturgical theming, share cards, local streak | A complete season. Give it to 5 friends. **No accounts yet.** |
| **2** | Magic-link auth, prayer circles, intentions, candles, push | The social engine. Only build this once Phase 1 retains. |
| **3** | Evening examen, "what you wrote last year," audio read-aloud | Depth for people who stayed |
| **4** | Latin/English toggle, full year of content, Advent/Lent special tracks | Scale |

**The gate between Phase 1 and 2:** give it to five friends and watch for two weeks.
If fewer than three are still opening it on day 10, the *content* isn't good enough
and no amount of social features will save it. Fix the day, not the app.

---

## 8. What we are deliberately not building

Saying no here is what keeps it shippable:

- ❌ **Full Liturgy of the Hours** — iBreviary and Universalis already do it well
- ❌ **A Bible reader** — huge scope, copyright swamp, and YouVersion won that
- ❌ **Rosary audio guide** — Hallow has a hundred-person team on this
- ❌ **Confession tracker / sin log** — genuine privacy landmine, and pastorally the wrong instinct for an app
- ❌ **Comments, DMs, or a feed of any kind** — the thing we're escaping
- ❌ **Subscriptions** — it's for your friends. Free, no ads, no account until Phase 2.

Ember competes on being **small, beautiful, and finishable** — the three things the
big Catholic apps structurally cannot be.

---

## 9. Open questions for you

1. **Audience** — cradle Catholics who already pray daily, or people drifting back who
   feel guilty about it? The Hard Question block gets *much* more prominent for the
   second group, and the tone shifts a lot.
2. **Latin Mass or Novus Ordo calendar?** They diverge on saints' days and season
   names. Defaulting to the Novus Ordo/USCCB calendar unless you say otherwise — but
   this needs deciding before the calendar engine is written.
3. **Where does the existing Reddit version live?** It's not in this repo. If you want
   anything carried over from it, point me at it — otherwise this is a clean build.
4. **Name.** Ember, Vigil, Sub Tuum, or something of yours.

---

## 10. My recommendation

Build **Phase 0 this week**: the calendar engine plus a single, genuinely beautiful
August 5th — snow in a Roman summer, the *Sub Tuum*, one question worth sitting with,
and "why do you pray to Mary?" answered well.

Send that one page to three Catholic friends. If they ask what tomorrow's is, you have
a product. If they don't, you've spent a week finding out — instead of a year.
