# Where the AI money goes

Audit date: **2026-08-15** · revised **2026-08-25** · build `2026-08-25·ai-diet`

**The numbers below are the last modelled ones. Don't add to them — read the real
counters instead.** Every AI call now records the exact input and output tokens
the response reports, per surface, per day:

- In the app: ☰ → **Settings** → *What the AI is actually costing*.
- Raw: `GET /api/ai/usage?days=14` → `{ total, todayTotal, bySurface }`.

The counters buffer in the Worker isolate and flush to one KV key per day
(`ai:usage:<date>`, 45-day TTL), so counting a busy hour of texting costs a couple
of KV writes rather than one per call. `AI_USAGE_OFF=1` as a Worker var turns the
whole thing off without a deploy.

Failed calls are counted too, with no tokens. That distinction matters more than
it sounds: a surface erroring all day and a surface nobody uses both read zero
tokens, and only the error column tells them apart.

## What was cut on 2026-08-25, and why

| Cut | Was | Now |
|---|---|---|
| **Predictive keyboard, AI half** | fired on every typing pause, ~29% of spend | **off by default** (`predictiveAi`), own switch next to the free one |
| **Inbound triage (`assistAsk`)** | one call on **every** inbound, ungated | skipped when the reply check already ruled nothing is owed |
| **Classification context** | last 40 messages + full playbook | last **12** (`AI_CLASSIFY_TURNS`) for triage, reply-check and recap |

The keyboard was the big one and the easiest to give up: its free half — the word
chips learned from his own texts — runs in the browser off a downloaded n-gram
model and costs nothing, and that's the half he actually sees. What went away is
the dim ghost text finishing his sentence, one Gemini call per pause, at the top
of the bill. It's a switch, not a removal.

Drafting deliberately kept its full 40 messages. Holding one person's voice is
what that context is for; classifying "is this a question?" is not.

## The modelled picture, as of 2026-08-15 (superseded — see the counters)

Modelled at 20 inbound texts/day, 20 outbound, 15 messages composed, 10 manual
AI taps: **~131 calls/day → ~4.5M input + 0.43M output tokens a month → roughly
$1–3/month** on `gemini-2.5-flash`. Sources disagreed on the input price ($0.15
vs $0.30 per million); the range spanned both.

| Surface | Function | Trigger | Calls/day | Share |
|---|---|---|---|---|
| Predictive keyboard | `apiAiPredict` | ~~auto — every typing pause~~ **now opt-in** | 60 | 29% |
| Manual buttons (×11) | `apiAiDraft`, `apiAiSummary`, `apiAiCoach`, `apiAiTriage`, `apiAiAnalyze`, `apiAiAgent`, `apiAiMoney`, `apiAiPhotoQuote`, `apiAiGenerate`, `interpretCommand`, `apiWebstatsAi` | you tap | 10 | 20% |
| Inbound triage | `assistAsk` | ~~auto — **every** inbound, ungated~~ **now gated** | 20 | 18% |
| Pre-drafted reply | `generateReply` | gated — inbound needing an answer | 14 | 17% |
| Follow-up drafts | `buildFollowupDraft` | auto — cron, nudge due | 5 | 4.6% |
| Appointment detect | `detAskAi` | gated — `detLooksSchedulish` | 4 | 4.0% |
| Conversation recap | `ensureRecap` | gated — first peek per new message | 10 | 3.9% |
| "Do I owe a reply?" | `judgeReplyNeeded` | gated — ambiguous only | 6 | 2.9% |
| Promise capture | `promAskAi` | gated — `promLooksLikePromise` | 2 | 1.1% |
| Voice fingerprint | `deriveVoiceFingerprint` | you tap "Relearn how I text" | rare | — |
| Detection draft | `detConfirmDraft` | you confirm a job card | rare | — |

`generateReply` runs at `voice` tier: it goes to Claude instead, so its 17% lands
on a different bill. The counters keep that separate — a Claude call is filed as
`<surface> (claude)`.

**Changed 2026-09-20.** That bill is now Cloudflare's, not Anthropic's. Claude is
reached through the Worker's `AI` binding on Cloudflare AI Gateway with Unified
Billing, which means no API key is stored anywhere and the drafts are paid for out
of the account's prepaid credits (Cloudflare adds 5% on a credit purchase; the
inference itself is at Anthropic's normal rates). The model moved with it:
**Haiku 4.5 at $1/$5 per million**, down from Opus 5 at $5/$25,
so a typical draft went from about 2.3¢ to about 0.45¢ and the $1/day ceiling now
buys roughly five times as many drafts. The one thing given up is the prompt-cache
breakpoint on the system block, which the catalog schema has no field for — at a
fifth of the input rate that is a smaller loss than the cache was a win.

**Amended the same day.** The credits turned out to be on the *Anthropic* account,
not the Cloudflare one, so there are now two ways to pay and the router takes
whichever is funded: a key pasted into **☰ → Settings → Who pays for the AI**
(spends Anthropic credits, needs no Cloudflare dashboard at all) is tried first,
the binding second, `ANTHROPIC_API_KEY` last. Both routes default to Haiku 4.5 —
deliberately the same model, because the day's spend is priced with one model's
rates and a draft could have come from either route. A key in Settings lives in
the config doc in KV rather than in a Worker secret. That is a real step down in
storage, taken because the alternative was no Claude at all for an owner who
can't reach the Cloudflare dashboard; it is never served back to a browser
(`publicConfig()` strips it), the snapshot scrubber hides it on the field name,
and the $1/day ceiling caps what a leaked one could spend.

**One thing the old table got wrong:** `apiAiDraft` was filed under "you tap", but
Auto Polish calls the same endpoint **by itself** every time you stop typing for
2.4s while composing. It is now counted separately as `auto polish`, so the
counters will show what it really costs. It has not been switched off — unlike the
keyboard's ghost text, a rewritten message box is something you'd notice missing.

## The deadline that matters more than the cost

`gemini-2.5-flash` — the hard-coded default in `geminiGenerate()` — **retires
2026-10-16**. Google names `gemini-3.6-flash` as the replacement, reportedly
$1.50/$7.50 per million vs 2.5 Flash's $0.30/$2.50. Same usage on 3.6 Flash is
roughly **$10/month** — still small, but ~8×.

When the date passes every AI feature stops at once, and it will look like the app
is broken rather than like a model was switched off. `GEMINI_MODEL` already
overrides the default, so the switch itself is one environment variable — but note
what happened to Matins, which is already on `gemini-3.6-flash` and has been
getting `400 INVALID_ARGUMENT` back from it every single day since 2026-08-06
(see the README in the `matins` repo). Test the swap on one surface before the
deadline forces it, and watch the error column afterwards.

## What's left worth doing

1. ~~**Log real usage.**~~ Done — see the top of this file.
2. ~~**Gate `assistAsk`.**~~ Done.
3. ~~**Send less context.**~~ Done for the three classification prompts.
4. **Finish the two-tier router.** `aiGenerate()` already splits `voice` from
   `fast`, but only 4 of 23 call sites use it; the other 19 call `geminiGenerate()`
   directly and can't be routed or repriced centrally. Pointing them at
   `aiGenerate({ tier: 'fast' })` makes the October migration — and any future
   "cheap model on boring jobs" call — a one-line change. Every call site now
   carries a `surface`, so the counters will show exactly what each one moves.
5. **Then re-read the counters.** Whatever is top of `bySurface` after a fortnight
   is the next cut, and this time it'll be a fact rather than an estimate.

## Already done right (don't undo these)

- `thinkingConfig: { thinkingBudget: 0 }` for 2.5 models. Thinking tokens bill as
  output and were truncating replies; turning them off saves money *and* fixed a
  bug.
- Free regex prefilters in front of `detAskAi` and `promAskAi`.
- Rule shortcuts in `ensureReplyCheck` (opt-out, media, question detection) that
  skip the AI entirely for the easy cases.
- `ensureRecap` and `replyCheck` both cache against the last message's timestamp,
  so a conversation is only ever paid for once per new message.
- The keyboard's local n-gram half. It is the part he sees, and it is free.
