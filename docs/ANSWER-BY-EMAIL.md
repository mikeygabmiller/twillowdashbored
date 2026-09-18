# Answer by email

A customer texts. You get the alert on your phone. You hit **Reply**, type what
you want to say, and that is what they get. No app to open, no prefix to remember,
and no Twilio segment spent on your half of it — the only billable text is the one
the customer actually gets. A minute or two later you get a second email telling
you it really landed.

The whole promise is one sentence: **the words that reach the customer are yours.**
The AI fixes your spelling and punctuation on the way out and changes nothing else.

If you'd rather hand over the bare facts and have it written for you, that's still
there — start the line with `write:`.

---

## How it actually works

There is no inbound-mail server anywhere in this. The trick is that your reply
ends up in **your own Sent folder**, and a free Apps Script on your own Google
account reads it from there.

```
customer texts ──▶ Worker ──▶ alert email (Resend) ──▶ your phone
                                                          │ you hit Reply
                                                          ▼
                                        your Gmail "Sent" folder
                                                          │ 1-min trigger
                                   Apps Script ──POST──▶ /email-in
                                                          │
                            spelling fixed, words kept ───┤
                                                          ▼
                                  queued with a hold ──▶ the customer
                                                          │
                              "it landed" email ◀─────────┘
```

Two things in the alert are load-bearing and invisible:

- `--- reply above this line ---` sits at the **top** of the email. Your client
  quotes everything below it, so slicing there leaves exactly what you typed.
- `[ref:+1360…]` at the bottom is what says **which customer** the reply is
  about. That's why you never have to address anything.

## Setting it up

Settings → **Answer by email** → **1 · Copy the Gmail script**. Then:

1. [script.google.com](https://script.google.com) → **New project**
2. Delete what's there, paste, **Save**
3. Pick **`mikeyAssistSetUp`** in the function dropdown, press **Run**, approve
   the prompt (your own script, your own account — *Advanced → Go to…*)

It installs its own every-minute trigger. **There is no Deploy step, ever** — the
same rule as the money scripts in `sheets/`, `gdoc/` and `gform/`.

Then tap **2 · Send me a practice question**. That's a fake customer in the
555-0100 range; replying to it exercises the entire chain and stops one step short
of Twilio, showing you the finished message marked TEST.

## When it goes quiet

Settings → **Answer by email** → **Is it working?** is the answer, in words:

> ✓ Working. Gmail last checked 40 sec ago.

or

> ⚠ The Gmail script hasn't checked in for 5h 20m. Replies you send right now are
> **not** reaching your customers.

If it's stale, open the script and run **`mikeyAssistCheck`**. It prints, in
order: whether the token is set, whether the trigger is on, who Google thinks you
are, whether Gmail will let it read, and whether the dashboard answers. One of
those lines is the problem.

`mikeyAssistReset` draws a fresh starting line — everything before right now is
forgotten. It can only ever make it send **less**, so it's safe to run any time.

## What stops it saying the wrong thing

Six gates, in the order a message hits them:

| Gate | What it stops |
|---|---|
| **Starting line** | Installing the script answering two days of backlog at once. Only replies you send *after* setup count. |
| **Plumbing check** | A quoted alert, the cut marker, or a `[ref:…]` line reaching a customer verbatim. |
| **Drift check** | The spelling pass quietly becoming a rewrite. Your reply and the polished version are compared word by word; anything that isn't a spelling or punctuation fix throws the polish away and sends **your exact words** instead. A number it changed fails the whole thing. |
| **Fact check** | On the `write:` path only: a price or a day in the finished text that you never said and the conversation never mentioned. It holds the wording and waits — reply `yes` and it goes out as written. |
| **Stale-draft check** | `YES` answering a message the customer has already moved past, or one you've already replied to yourself. |
| **The hold** | 3 minutes by default. Reply `CANCEL`, or cancel it in the dashboard, which is faster. |

Nothing here is a silent drop. Every one of these tells you what it did and why,
by replying to the same email thread — because a reply that vanishes is
indistinguishable from a reply that worked.

## The grammar

| You reply | What happens |
|---|---|
| *anything you want to say* | Sent in your words, spelling and punctuation fixed |
| `yes` | Sends the reply the alert already showed you, as written |
| `no` | Drops it |
| `send: on my way` | Sent word for word, typos and all — no spelling pass |
| `write: 375, thursday works` | You give the facts, it does the wording |
| `draft: …` | Held in the dashboard instead of sent |
| `who` | Who's waiting on a reply |
| `cancel` | Pulls back the last queued one |

`@ruth on my way` picks who, when you want someone other than whoever the alert was
about. Everything above also works as a **text to your own business number** —
same grammar, same gates, except that one costs a text.

## Knowing it landed

The confirmation you get straight away says *"Sending in ~3 min"*, which is a
plan. Once the hold expires and Twilio actually takes the message, a second email
arrives with the exact words the customer got. If it **failed** — a dead key, an
opt-out, a bad number — that same email tells you so, because from an inbox a text
that never sent looks precisely like one that worked. Reply to either one to send
them something else.

## Escape hatches

- The whole feature: Settings → **Answer by email** switch.
- The spelling pass alone: **Fix my spelling on the way out**. Off means your
  keystrokes reach the customer exactly as typed.
- The landed/failed email: **Email me when it actually lands**.
- The fact check alone: **Stop it if the wording says something I didn't**.
- The hold length: **Hold before sending**, 0–900 seconds.
- An address that isn't your alert mailbox (a send-as alias): when a reply comes
  in from one, the health card names it and offers **"That's me too — use it"**.
