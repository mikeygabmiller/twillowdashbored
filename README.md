# Mikey's Detailing — SMS Dashboard

Your own private text-message dashboard for **Mikey's Mobile Detailing**. Read and
reply to customer texts from one screen, and let the backend do the busy work:

- A customer fills out the quote form on your website → they instantly get a
  confirmation text, **and** you get a lead alert.
- A customer texts your business number → it shows up here **and** gets forwarded
  to your cell.
- Someone calls your business number → it rings your cell, and if you miss it they
  can leave a voicemail (you get a text with the recording link).
- You reply right here in the dashboard — the text goes out from your business number.

Everything lives in this GitHub repo and runs on **Netlify**. No command line, no
Cloudflare. You can read and edit every file right here on github.com.

> **Note:** This is a fresh, standalone version. Your older conversation history
> stays available on the old Cloudflare dashboard
> (`https://mikeys-detailing-sms.mikeysdetailingsnohomish.workers.dev/`) — that one
> keeps running untouched. This new dashboard starts with a clean message history.

---

## What's in this repo

| File | What it is |
|------|------------|
| `index.html` | The dashboard you open in your browser. Has a password screen. **Safe to host** — it contains no secrets. |
| `netlify/functions/api.mjs` | The "engine." Handles the website form, incoming texts, calls, voicemail, and the dashboard's send/read actions. |
| `netlify.toml` | Tells Netlify how to build the site. |
| `package.json` | Lists the one library the engine needs. |

---

## One-time setup (about 15 minutes, all done in your browser)

### Step 1 — Connect this repo to Netlify
1. Go to **[netlify.com](https://www.netlify.com)** and log in (sign up free with your
   GitHub account if you don't have one).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub**, then pick this repository (`twillowdashbored`).
4. Leave the build settings as they are (Netlify reads `netlify.toml` automatically)
   and click **Deploy**.
5. After it finishes, Netlify gives your site a web address like
   `https://something-random-1234.netlify.app`. **Write this address down** — it's
   your dashboard. (You can rename it under **Site configuration → Change site name**.)

> Wherever you see `<site>` below, use that `.netlify.app` address.

### Step 2 — Add your 5 secret settings
In Netlify, open your site → **Site configuration → Environment variables → Add a
variable** (choose "Add a single variable" for each). Add these five:

| Variable name | What to paste |
|---------------|---------------|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID (from the Twilio Console dashboard) |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token (from the same page) |
| `TWILIO_FROM` | Your Twilio phone number, like `+13607975831` |
| `MIKEY_PHONE` | Your personal cell, like `+13607975831` |
| `DASHBOARD_PASSWORD` | Any password you choose — you'll type this to open the dashboard |

After adding them, go to **Deploys → Trigger deploy → Deploy site** so the new
settings take effect.

> Phone numbers must be in the `+1` format (a plus, then the 11 digits). No spaces
> or dashes.

### Step 3 — Point Twilio at your new dashboard
In the **[Twilio Console](https://console.twilio.com)** → **Phone Numbers → Manage →
Active numbers** → click your business number. Then:

**Messaging** (the "A message comes in" section):
- Set it to **Webhook**, method **HTTP POST**
- URL: `https://<site>.netlify.app/sms`

**Voice & Fax** (the "A call comes in" section):
- Set it to **Webhook**, method **HTTP POST**
- URL: `https://<site>.netlify.app/call`

Click **Save** at the bottom.

### Step 4 — Point your website's quote form at the new engine
On your marketing site (`mikeygabmiller/mikeysite`), find where the quote form
sends its data and change the address it posts to:

`https://<site>.netlify.app/submit`

(In the old setup this pointed at the Cloudflare `...workers.dev/submit` address —
just swap in your new Netlify address.)

### Step 5 — Open your dashboard
Go to `https://<site>.netlify.app`, type the `DASHBOARD_PASSWORD` you chose, and
you're in. Your password is remembered on that device, so you won't have to type it
every time.

---

## Using the dashboard
- **Left side:** every conversation, newest on top.
- **Click a conversation** to read it and reply. Press **Enter** to send (Shift+Enter
  for a new line).
- **+ New** starts a conversation by entering a customer's phone number.
- **Rename** gives a phone number a friendly name (e.g. "John – Tahoe").
- It checks for new messages every 20 seconds, and **pauses when the browser tab
  isn't visible** — so it comfortably stays within Netlify's free tier even if you
  leave it open all day.

---

## How the addresses map (reference)
Your one Netlify site answers at several addresses:

| Address | Who calls it |
|---------|--------------|
| `https://<site>.netlify.app/` | You — the dashboard |
| `https://<site>.netlify.app/submit` | Your website's quote form |
| `https://<site>.netlify.app/sms` | Twilio, when a text comes in |
| `https://<site>.netlify.app/call` | Twilio, when a call comes in |
| `/voicemail`, `/voicemail-done` | Twilio, automatically, during voicemail |

The `/sms`, `/call`, `/submit`, and voicemail addresses are open (Twilio and your
website need to reach them). Everything under `/api/...` that powers the dashboard
is locked behind your `DASHBOARD_PASSWORD`.

---

## Costs
- **Netlify** free tier: 125,000 function calls/month — far more than you'll use.
- **Twilio** texts: about a penny each. Phone number: ~$1.15/month.

---

## Want a friendlier repo name?
This repo is named `twillowdashbored`. If you'd prefer `mikeys-sms-dashboard`, open
the repo on github.com → **Settings → General → Rename**. Netlify keeps working after
a rename.
