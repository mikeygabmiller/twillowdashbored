// The craft judge. Picks between drafts of the same block.
//
// This is deliberately NOT safety.js. That one asks "is this orthodox and true"
// and fails closed. This one asks "is this any good" and fails soft: if the
// judge is unreachable or incoherent, the first draft ships. A devotional that
// goes out slightly worse is a bad day; a devotional that does not go out is a
// broken promise.
//
// It is a comparison, not a score. Models are unreliable at absolute quality
// ratings and much better at "which of these two is better, and why" — and a
// comparison needs no calibration to stay stable as models change.

import { llmText, parseJsonReply } from './llm.js';
import { TEMPERATURE } from '../config.js';

const RUBRIC = `You are the editor of a daily Catholic devotional read at dawn by young working Catholics. You are choosing between drafts of one block. You are not checking doctrine — that is somebody else's job and already done. You are judging whether this is any good.

Prefer the draft that:
1. IS CONCRETE. It names a real situation — a shift, a stairwell, a phone call — rather than gesturing at "our daily lives" or "the busyness of the world". Specific beats warm.
2. EARNS ITS TURN. The point is arrived at, not announced. A draft that states its conclusion in the first sentence and then decorates it is worse than one that gets there.
3. DOES NOT PREACH. It observes; it does not instruct, scold, or tell the reader how they feel. Warmth is fine. Being handled is not.
4. LANDS. The last sentence holds something. A draft that ends by summarising itself, or on an uplift the rest did not pay for, is worse.
5. SOUNDS LIKE A PERSON. Varied sentence length, plain words, no slogans, nothing that could go on a poster.

Reject flourish for its own sake. Between two drafts of equal substance, take the shorter one.

Return only JSON: {"choice": <number>, "reason": "<one sentence saying what decided it>"}`;

export async function pickBest({ cfg, name, drafts, fetchImpl }) {
  const usable = drafts.filter((d) => String(d.text || '').trim());
  if (usable.length <= 1) return { index: 0, reason: 'only one draft', judged: false };

  const body = usable.map((d, i) => `DRAFT ${i + 1}\n"""\n${d.text}\n"""`).join('\n\n');

  try {
    const reply = await llmText({
      cfg,
      system: `${RUBRIC}\nReturn only JSON.`,
      prompt: `BLOCK NAME: ${name}\nThere are ${usable.length} drafts. Choose one.\n\n${body}`,
      maxTokens: 200,
      temperature: TEMPERATURE.safety,
      fetchImpl,
    });
    const obj = parseJsonReply(reply);
    const choice = Number(obj.choice);
    if (!Number.isInteger(choice) || choice < 1 || choice > usable.length) {
      return { index: 0, reason: 'judge returned no usable choice', judged: false };
    }
    // Map back to the caller's array, which may include the blanks we dropped.
    const picked = usable[choice - 1];
    return {
      index: drafts.indexOf(picked),
      reason: String(obj.reason || 'no reason given').slice(0, 240),
      judged: true,
    };
  } catch (err) {
    // Fails soft, unlike safety.js.
    return { index: 0, reason: `judge unavailable: ${String(err?.message || err)}`, judged: false };
  }
}
