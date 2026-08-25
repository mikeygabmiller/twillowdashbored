# Letting Claude see what you see

Two ways. The first is a setting you change once and never think about again; the
second needs no setting at all and works from your phone.

---

## Way 1 — let Claude reach the live dashboard itself (the good one)

Claude's sandbox has **no outbound internet by default** beyond a fixed allowlist
(GitHub, package registries). `texting.mikeysdetailingsnohomish.workers.dev` is not
on that list, so every request Claude makes to the live app dies at the proxy with
a `403` before it ever leaves the box. That is not a bug to work around — it is the
sandbox doing its job, and the only honest fix is to widen the list on purpose.

### Steps

1. Go to **[claude.ai/code](https://claude.ai/code)**.
2. In the row just above the message box, click the **cloud icon** showing the
   current environment name (probably `Default`). There is no settings page for
   this — the cloud icon is the only way in.
3. Hover the environment you use and click the **gear** on the right.
   (Or **Add cloud environment** to make a separate one just for this app — a good
   idea, since it keeps the wider network access off everything else you do.)
4. Set **Network access** to **Custom**.
5. In **Allowed domains**, one per line:

   ```
   texting.mikeysdetailingsnohomish.workers.dev
   ```

   Tick **"Also include default list of common package managers"** — without it
   `npm install` stops working and the test suites won't run.
6. In the same dialog, under **Environment variables**, add the dashboard password
   so Claude can get past the login gate:

   ```
   DASH_PASS=your-dashboard-password
   ```

7. Save, then **start a new session**. The network policy is fixed when a session
   boots, so the session you are in right now will not pick it up.

### What Claude does with it

```bash
# log in once — the cookie is good for 90 days
curl -sc /tmp/mkd.jar -X POST https://texting.mikeysdetailingsnohomish.workers.dev/api/login \
     -H 'Content-Type: application/json' -d "{\"password\":\"$DASH_PASS\"}"

# then read any screen you can read
curl -sb /tmp/mkd.jar https://texting.mikeysdetailingsnohomish.workers.dev/api/snapshot
curl -sb /tmp/mkd.jar https://texting.mikeysdetailingsnohomish.workers.dev/api/threads
```

That is genuinely everything: the same endpoints, the same password, the same data
the dashboard draws from. It also means Claude can finally do the thing `DEPLOY.md`
insists on and **check `/api/version` after a merge** instead of saying "I pushed it
and I hope".

### Read this before you do it

- The password sits in the environment dialog in plain text, and anyone who can use
  that environment can use it. It is not a secrets store.
- Claude will be able to **send texts**, not just read them — `/api/send` is behind
  the same password. `CLAUDE.md` already forbids sending to real customers without
  asking, but the ability is real once the gate is open.
- Narrow it later by pointing this at a second Worker with a copy of the data, or by
  taking the env var out and pasting the password only when you want a live look.

---

## Way 2 — hand Claude a file (no settings, works today)

The dashboard builds the file for you.

1. **☰ → Snapshot for Claude** (or type `snapshot` in search).
2. Tick what your question is actually about, or type it — *"just my texts from last
   month"*, *"quotes and follow-ups"*, *"the whole app"*.
3. **Make the file.** It saves to your phone **and** copies to your clipboard.
4. Paste it to Claude, or attach the file.

Pick narrowly. A file that is only the texts gets a far better answer about texts
than a dump of the whole app does, and *"The whole app · all time"* can run to
megabytes — too big to paste, and mostly noise for any one question.

### What is in it

Everything the dashboard can show, each section read through the very same endpoint
the screen itself reads, so the file cannot drift out of step with the app:

| Section | What it is |
| --- | --- |
| Text messages | Every conversation, word for word |
| Leads & customers | The list — names, status, tags, last contact |
| Money | Income, expenses and what you're owed |
| Bookings | Booked jobs and the schedule |
| Emails | Anything forwarded into the app |
| Settings & AI training | Playbook, prices, templates, preferences |
| Quotes | Every quote given and what it was worth |
| Follow-ups & promises | Who you owe a shout, what you promised, who's gone quiet |
| Jobs & vehicles | The garage — whose car is what, and what they've spent |
| Website visitors | Where leads came from and what they read first |
| What the AI's been doing | Its spend, the rules it follows, how well it sounds like you |
| Numbers & trends | Insights, price history, what's changed lately |
| App look & layout | How you've set this device up (this phone only) |

Anything that looks like a key, token or password is replaced with `[hidden]` on the
way out — including inside the screens that ride along.

Two things are deliberately **not** in it:

- **Website analytics from Google and Clarity** (`/api/webstats`). Those go out over
  the network to Google every time, so a snapshot that included them would be slow
  and would fail outright on an account that never connected them. The app's own
  visitor counts *are* included.
- **Job photos.** They are base64 images; a handful would outweigh the entire rest
  of the file. Send an individual photo if a question turns on one.

If one screen fails to read, it is named under `couldntRead` and the rest of the file
still arrives. You never lose the whole export to one bad section.
