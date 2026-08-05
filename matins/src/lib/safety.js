// Orthodoxy / safety pass. This app sends itself, so nothing generated goes
// out unchecked.
//
// Two layers per block:
//   1. deterministic checks (cheap, no network) — citation shapes, quotation
//      marks around what looks like scripture, Catechism references;
//   2. a second LLM call at temperature 0 with a strict rubric.
//
// It FAILS CLOSED: if the checker itself errors out, the block is dropped.
// A missing section is a small loss; an unchecked section is the one thing
// this app must never do.

import { llmText, parseJsonReply } from './llm.js';
import { TEMPERATURE } from '../config.js';

const RUBRIC = `You are the orthodoxy and accuracy check for a Catholic devotional that sends automatically, with no human between you and the reader. You are the last gate. Judge the BLOCK below against the FACTS it was allowed to use.

Fail the block if ANY of these is true:
A. It contains anything contrary to Catholic faith or morals, or anything a well-formed Catholic reader would find heterodox.
B. It presents something as binding Church teaching that the Church does not bind — blurring defined doctrine, theological opinion, devotional practice, or personal advice.
C. It asserts a fact, date, place, number, name, event, or biographical detail that is not in the FACTS and is not universally uncontested about the subject.
D. It contains a quotation or a citation of any kind — scripture, Catechism, council, encyclical, pope, saint, hymn — or scripture text beyond a single short Douay-Rheims line.
E. It promises something God has not promised (health, money, success), or shames or pressures the reader.
F. It is incoherent, off-topic for the day, or not in English.

Pass the block if none of those is true. Ordinary devotional reflection, warmth, and encouragement are fine. Naming a reading by its reference (for example "Luke 14:25-33") is fine and is not a citation.

Return only JSON: {"pass": true|false, "reason": "<one sentence>"}`;

// Deterministic tripwires. Deliberately narrow — these only catch shapes that
// are unambiguous, so the LLM rubric stays the judgement call.
const TRIPWIRES = [
  [/\bCCC\b|\bCatechism\s+(?:of the Catholic Church\s*)?(?:§|no\.?|paragraph|\d)/i, 'cites the Catechism'],
  [/§\s*\d+/, 'contains a paragraph citation'],
  [/["“][^"”]{60,}["”]/, 'contains a long verbatim quotation'],
  [/\((?:cf\.|see)\s+[A-Z][a-z]+\s+\d+:\d+/i, 'contains a scripture citation in parentheses'],
  [/\b(?:NABRE|New American Bible|Revised Standard Version|RSV-?CE)\b/i, 'references a copyrighted translation'],
];

export async function checkBlock({ cfg, name, text, facts, fetchImpl }) {
  const body = String(text || '').trim();
  if (!body) return { pass: false, reason: 'empty block' };

  for (const [re, why] of TRIPWIRES) {
    if (re.test(body)) return { pass: false, reason: `automatic check: ${why}` };
  }

  const prompt = `FACTS THE BLOCK WAS ALLOWED TO USE
${facts}

BLOCK NAME: ${name}
BLOCK
"""
${body}
"""`;

  try {
    const reply = await llmText({
      cfg,
      system: `${RUBRIC}\nReturn only JSON with keys pass and verdict reason.`,
      prompt,
      maxTokens: 200,
      temperature: TEMPERATURE.safety,
      fetchImpl,
    });
    const obj = parseJsonReply(reply);
    const pass = obj.pass === true;
    return { pass, reason: String(obj.reason || (pass ? 'passed' : 'no reason given')) };
  } catch (err) {
    // Fail closed.
    return { pass: false, reason: `safety check unavailable, dropped for safety: ${String(err?.message || err)}` };
  }
}
