# Where the AI money goes

Audit date: **2026-08-15** · build `2026-08-15·peek-recap`

Every number here is **modelled, not measured** — the app records no token counts
anywhere. `usageMetadata` comes back on every Gemini response and is discarded.
Treat the shape as trustworthy and the decimals as guesses, and see fix #1.

Modelled at 20 inbound texts/day, 20 outbound, 15 messages composed, 10 manual
AI taps. That works out to **~131 calls/day → ~4.5M input + 0.43M output tokens
a month → roughly $1–3/month** on `gemini-2.5-flash`. Sources disagree on the
input price ($0.15 vs $0.30 per million); the range spans both. Google's own
pricing page was unreachable from the sandbox this was written in.

## The 23 call sites

Sorted by modelled share of spend. "Gated" means a free check (regex or rule)
runs first and usually avoids the call.

| Surface | Function | Trigger | Calls/day | Share |
|---|---|---|---|---|
| Predictive keyboard | `apiAiPredict` | auto — every typing pause | 60 | 29% |
| Manual buttons (×11) | `apiAiDraft`, `apiAiSummary`, `apiAiCoach`, `apiAiTriage`, `apiAiAnalyze`, `apiAiAgent`, `apiAiMoney`, `apiAiPhotoQuote`, `apiAiGenerate`, `interpretCommand`, `apiWebstatsAi` | you tap | 10 | 20% |
| Inbound triage | `assistAsk` | auto — **every** inbound, ungated | 20 | 18% |
| Pre-drafted reply | `generateReply` | gated — inbound needing an answer | 14 | 17% |
| Follow-up drafts | `buildFollowupDraft` | auto — cron, nudge due | 5 | 4.6% |
| Appointment detect | `detAskAi` | gated — `detLooksSchedulish` | 4 | 4.0% |
| Conversation recap | `ensureRecap` | gated — first peek per new message | 10 | 3.9% |
| "Do I owe a reply?" | `judgeReplyNeeded` | gated — ambiguous only | 6 | 2.9% |
| Promise capture | `promAskAi` | gated — `promLooksLikePromise` | 2 | 1.1% |
| Voice fingerprint | `deriveVoiceFingerprint` | you tap "Relearn how I text" | rare | — |
| Detection draft | `detConfirmDraft` | you confirm a job card | rare | — |

`generateReply` runs at `voice` tier: with `ANTHROPIC_API_KEY` set it goes to
Claude instead, so its 17% lands on a different (pricier) bill.

## The deadline that matters more than the cost

`gemini-2.5-flash` — the hard-coded default in `geminiGenerate()` — **retires
2026-10-16**. Google names `gemini-3.6-flash` as the replacement, reportedly
$1.50/$7.50 per million vs 2.5 Flash's $0.30/$2.50. Same usage on 3.6 Flash is
roughly **$10/month** — still small, but ~8×.

When the date passes every AI feature stops at once, and it will look like the
app is broken rather than like a model was switched off. `GEMINI_MODEL` already
overrides the default, so the switch itself is one environment variable.

## Fixes, in order of payoff

1. **Log real usage.** `usageMetadata` on every response carries exact input and
   output counts. One daily KV counter per surface replaces this whole document
   with fact. ~20 lines. Do this before optimising anything, or you're tuning
   against a model instead of a bill.

2. **Gate `assistAsk`** (~18% of spend). It fires on every inbound with no
   prefilter — including "👍" and "thanks!" — and has a `chitchat` category,
   i.e. it pays to discover the message needed nothing. `ensureReplyCheck` has
   already produced a verdict moments earlier in the same request, often from
   rules for free. Skip the call when nothing is owed.

3. **Send less context** (~15–25%). `transcript()` defaults to the last **40
   messages** and nearly every prompt also prepends the full playbook. Right for
   drafting in his voice; heavy for classification, where input tokens dominate.
   Ten messages would do for `assistAsk`, `judgeReplyNeeded`, `ensureRecap`.
   Separately, the predictive keyboard (`PK_DEBOUNCE` 600ms, `PK_MIN_GAP` 1100ms
   in `public/index.html`) is the largest single consumer — widening the gap or
   requiring 4 words instead of 2 halves it.

4. **Finish the two-tier router.** `aiGenerate()` already splits `voice` from
   `fast`, but only 4 of 22 call sites use it; the other 18 call
   `geminiGenerate()` directly and can't be routed or repriced centrally.
   Pointing them at `aiGenerate({ tier: 'fast' })` makes the October migration —
   and any future "cheap model on boring jobs" call — a one-line change.

## Already done right (don't undo these)

- `thinkingConfig: { thinkingBudget: 0 }` for 2.5 models. Thinking tokens bill as
  output and were truncating replies; turning them off saves money *and* fixed a
  bug.
- Free regex prefilters in front of `detAskAi` and `promAskAi`.
- Rule shortcuts in `ensureReplyCheck` (opt-out, media, question detection) that
  skip the AI entirely for the easy cases.
- `ensureRecap` and `replyCheck` both cache against the last message's timestamp,
  so a conversation is only ever paid for once per new message.
