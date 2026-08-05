// The only three generated blocks: reflection, saint story, headline.
//
// Rules baked into every prompt:
//   * the model is handed the facts and may not add any of its own;
//   * no scripture text, no CCC text, no quotations, no citations;
//   * a reflection is a reflection, never binding teaching.
// Anything that slips past these still has to clear safety.js before it ships.

import { llmText, parseJsonReply } from './llm.js';

const HOUSE_STYLE = `You write for a daily Catholic devotional email read at dawn by young working Catholics — tradespeople, nurses, teachers, people with kids and shifts and commutes. Plain, warm, unhurried language. Short sentences. No exclamation marks, no hype, no clichés about "journeys" or "seasons of life", no rhetorical questions stacked in a row. Never address the reader as "friend". Never mention that you are an AI or that anything was generated.`;

const HARD_RULES = `ABSOLUTE RULES — a violation means the block is thrown away:
1. Use ONLY the facts given to you below. Do not add dates, places, numbers, names, miracles, quotations, or biographical details that are not in the facts.
2. Quote no scripture. Do not paraphrase a passage line by line. You may name a reading by its reference, nothing more.
3. Quote no Catechism, council, encyclical, pope, or saint. No citations of any kind.
4. Do not present your own reflection as the teaching of the Church. Where you touch on doctrine, keep to what the Church actually holds, and keep opinion plainly marked as one way of seeing it.
5. Nothing contrary to Catholic faith or morals.`;

function factSheet(day, readings) {
  const lines = [
    `Date: ${day.date}`,
    `Liturgical season: ${day.season}`,
    `Rank of the day: ${day.rank}`,
    `Liturgical colour: ${day.colorName}`,
    `Celebration: ${day.feastOrSaint}`,
  ];
  if (day.isHolyDayOfObligation) lines.push('This is a holy day of obligation.');
  if (readings?.firstRef) lines.push(`First reading: ${readings.firstRef}`);
  if (readings?.psalmRef) lines.push(`Responsorial psalm: ${readings.psalmRef}`);
  if (readings?.secondRef) lines.push(`Second reading: ${readings.secondRef}`);
  if (readings?.gospelRef) lines.push(`Gospel: ${readings.gospelRef}`);
  return lines.join('\n');
}

export async function generateReflection({ cfg, day, readings, fetchImpl }) {
  const prompt = `${HARD_RULES}

TODAY'S GROUNDED FACTS
${factSheet(day, readings)}

TASK — REFLECTION
Write 4 to 6 sentences of reflection for this day. Anchor it in the celebration above and, if readings are listed, in what the Church is putting in front of people today — but you may only refer to a reading by name, never by quoting it. Tie it to ordinary working life: patience with people, honest dealing, doing work well when nobody is checking, carrying a hard day. End on something a person can hold onto, not an instruction.

Return the reflection text only. No title, no preamble, no quotation marks around it.`;

  return attempt('reflection', async () => {
    const text = await llmText({ cfg, system: HOUSE_STYLE, prompt, maxTokens: 500, fetchImpl });
    const clean = stripWrapping(text);
    if (clean.split(/\s+/).length < 25) throw new Error('reflection too short');
    return clean;
  });
}

export async function generateSaintStory({ cfg, day, fetchImpl }) {
  if (!day.saint) return { ok: false, skipped: true, error: 'no saint or feast with martyrology data today' };
  const s = day.saint;
  const facts = [
    `Name as the Church gives it today: ${s.name}`,
    s.canonizationLevel ? `Canonization status: ${titleish(s.canonizationLevel)}` : null,
    s.titles?.length ? `Titles: ${s.titles.join(', ')}` : null,
    s.dateOfDeath != null ? `Year of death: ${s.dateOfDeath}${s.dateOfDeathIsApproximative ? ' (approximate)' : ''}` : null,
    s.dateOfBirth != null ? `Year of birth: ${s.dateOfBirth}` : null,
    `Rank of the observance: ${s.rank}${s.isOptional ? ' (optional memorial)' : ''}`,
  ].filter(Boolean).join('\n');

  const prompt = `${HARD_RULES}
6. This is a SAINT block. Beyond the facts listed below you may retell only what is universally attested and uncontested about this figure — the broad shape of the life. If you are not certain of something, leave it out. No invented dates, no invented places, no invented quotations, no legends presented as fact. If you know very little, write less.

GROUNDED FACTS ABOUT TODAY'S SAINT OR FEAST
${facts}

TASK — SAINT STORY
Write two short paragraphs (3 to 5 sentences total) telling this life warmly and plainly, as you would tell a friend on a job site why this person is worth knowing. Then give one concrete thing a working person can actually do today because of it — a single specific action, doable before bed, no more than one sentence.

Return only JSON: {"life": "...", "oneActionToday": "..."}`;

  return attempt('saintStory', async () => {
    const text = await llmText({ cfg, system: `${HOUSE_STYLE} Return only JSON.`, prompt, maxTokens: 600, fetchImpl });
    const obj = parseJsonReply(text);
    const life = stripWrapping(String(obj.life || ''));
    const oneActionToday = stripWrapping(String(obj.oneActionToday || ''));
    if (!life || !oneActionToday) throw new Error('saint story missing a field');
    return { life, oneActionToday };
  });
}

export async function generateHeadline({ cfg, day, reflection, fetchImpl }) {
  const prompt = `${HARD_RULES}

TODAY'S GROUNDED FACTS
${factSheet(day, null)}

${reflection ? `TODAY'S REFLECTION (for tone only — do not summarise it mechanically)\n${reflection}\n` : ''}
TASK — HEADLINE
Write ONE line, at most nine words, that will sit at the top of the email and in the inbox preview. Concrete and quiet. Not a slogan. No colon-and-subtitle construction. No title case — write it as a sentence without a full stop.

Return the line only.`;

  return attempt('headline', async () => {
    const text = stripWrapping(await llmText({ cfg, system: HOUSE_STYLE, prompt, maxTokens: 60, fetchImpl }));
    const line = text.split('\n')[0].replace(/\.$/, '').trim();
    if (!line || line.split(/\s+/).length > 14) throw new Error('headline unusable');
    return line;
  });
}

async function attempt(name, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: `${name}: ${String(err?.message || err)}` };
  }
}

function stripWrapping(s) {
  return String(s).trim().replace(/^["“”']+|["“”']+$/g, '').trim();
}

function titleish(s) {
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
