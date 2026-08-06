// The only three generated blocks: reflection, saint story, headline.
//
// Rules baked into every prompt:
//   * the model is handed the facts and may not add any of its own;
//   * no scripture text, no CCC text, no quotations, no citations;
//   * a reflection is a reflection, never binding teaching.
// Anything that slips past these still has to clear safety.js before it ships.
//
// Orthodoxy is safety.js's job. This file's other job is CRAFT: devotional
// prose has a strong gravitational pull toward the same dozen dead phrases,
// and a model left alone will find all of them. So each block is checked
// against a short list of tells and rewritten if it trips one — see `craft`.

import { llmText, parseJsonReply } from './llm.js';

const HOUSE_STYLE = `You write for a daily Catholic devotional email read at dawn by young working Catholics — tradespeople, nurses, teachers, people with kids and shifts and commutes. Plain, warm, unhurried language. Short sentences, but vary the length; three of the same length in a row reads like a machine. No exclamation marks, no hype, no clichés about "journeys" or "seasons of life", no rhetorical questions stacked in a row. Never address the reader as "friend". Never mention that you are an AI or that anything was generated.

Write the way a good homilist talks to one person, not the way a newsletter talks to a list. Concrete nouns over abstract ones: a truck, a night shift, a sink of dishes, a father-in-law, rather than "our daily lives" or "the challenges we face". Say the thing once and stop; do not summarise what you have just said.`;

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

Open in the concrete — a situation, an observation, a plain statement. Do NOT open with "In today's Gospel", "Today the Church", "The readings today", or any other throat-clearing about what day it is; the reader can already see the date and the readings above this. Name one specific ordinary situation rather than gesturing at "our daily lives". Do not tell the reader how they feel.

Return the reflection text only. No title, no preamble, no quotation marks around it.`;

  return attempt('reflection', async (note) => {
    const text = await llmText({ cfg, system: HOUSE_STYLE, prompt: prompt + note, maxTokens: 500, fetchImpl });
    const clean = stripWrapping(text);
    const words = clean.split(/\s+/).length;
    if (words < 25) throw new Error('reflection too short');
    if (words > 220) throw new Error('reflection too long');
    return { value: clean, craft: craft(clean, { opener: true }) };
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
Write two short paragraphs (3 to 5 sentences total) telling this life warmly and plainly, as you would tell a friend on a job site why this person is worth knowing. Say what kind of person they were and what it cost them. Do not open by restating their name and title — that is already the heading above your text.

Then give one concrete thing a working person can actually do today because of it. It must be a single specific action, doable before bed, no more than one sentence — something a reader could tell you at night whether or not they did. "Pray more", "reflect on his example", "be more patient" and the like are failures: name the actual act.

Return only JSON: {"life": "...", "oneActionToday": "..."}`;

  return attempt('saintStory', async (note) => {
    const text = await llmText({ cfg, system: `${HOUSE_STYLE} Return only JSON.`, prompt: prompt + note, maxTokens: 600, fetchImpl });
    const obj = parseJsonReply(text);
    const life = stripWrapping(String(obj.life || ''));
    const oneActionToday = stripWrapping(String(obj.oneActionToday || ''));
    if (!life || !oneActionToday) throw new Error('saint story missing a field');
    if (oneActionToday.split(/\s+/).length > 35) throw new Error('one action is not one sentence');
    return { value: { life, oneActionToday }, craft: [...craft(life), ...vagueAction(oneActionToday)] };
  });
}

export async function generateHeadline({ cfg, day, reflection, fetchImpl }) {
  const prompt = `${HARD_RULES}

TODAY'S GROUNDED FACTS
${factSheet(day, null)}

${reflection ? `TODAY'S REFLECTION (for tone only — do not summarise it mechanically)\n${reflection}\n` : ''}
TASK — HEADLINE
Write ONE line, at most nine words, that will sit at the top of the email and in the inbox preview. Concrete and quiet. Not a slogan. No colon-and-subtitle construction. No title case — write it as a sentence without a full stop. Do not name the feast; it is printed directly underneath. Prefer a plain noun phrase or a short clause that would make someone slow down.

Return the line only.`;

  return attempt('headline', async (note) => {
    const text = stripWrapping(await llmText({ cfg, system: HOUSE_STYLE, prompt: prompt + note, maxTokens: 60, fetchImpl }));
    const line = text.split('\n')[0].replace(/\.$/, '').trim();
    if (!line || line.split(/\s+/).length > 14) throw new Error('headline unusable');
    return { value: line, craft: headlineCraft(line) };
  });
}

// --- craft -----------------------------------------------------------------

// Phrases that mark devotional writing as machine-made. Kept short and
// specific on purpose: every entry here has to be something a careful human
// writer would not have typed.
const TELLS = [
  [/\b(?:spiritual |faith )?journey\b/i, '"journey"'],
  [/\bseason of (?:life|change|waiting)\b/i, '"season of life"'],
  [/\bhustle and bustle\b/i, '"hustle and bustle"'],
  [/\bfast[- ]paced world\b/i, '"fast-paced world"'],
  [/\bin (?:our|your|today's) (?:busy )?(?:daily )?lives\b/i, '"in our daily lives"'],
  [/\bat the end of the day\b/i, '"at the end of the day"'],
  [/\bas Catholics,? we\b/i, '"as Catholics, we"'],
  [/\btake a moment to\b/i, '"take a moment to"'],
  [/\bGod has a plan\b/i, '"God has a plan"'],
  [/\blet us\b/i, '"let us"'],
  [/\bdear (?:friend|reader)\b/i, 'addressing the reader as "friend"'],
  [/!/, 'an exclamation mark'],
];

const OPENERS = [
  /^in today'?s\b/i,
  /^today,? the Church\b/i,
  /^the readings today\b/i,
  /^today'?s (?:readings|gospel|feast)\b/i,
  /^on this (?:day|feast)\b/i,
];

function craft(text, { opener = false } = {}) {
  const body = String(text);
  const found = TELLS.filter(([re]) => re.test(body)).map(([, why]) => why);
  if (opener && OPENERS.some((re) => re.test(body.trim()))) found.push('a throat-clearing opener');
  return found;
}

// A "one thing today" that cannot be answered yes or no at bedtime is not one.
const VAGUE = [
  [/^\s*(?:try to |make an effort to )?(?:pray more|be more|reflect|meditate|consider|think about|remember to be|spend time)\b/i, 'a vague action'],
  [/\bin some (?:small )?way\b/i, 'a vague action'],
];

function vagueAction(text) {
  return VAGUE.filter(([re]) => re.test(String(text))).map(([, why]) => why);
}

function headlineCraft(line) {
  const out = craft(line);
  if (/:/.test(line)) out.push('a colon-and-subtitle construction');
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 9) out.push('more than nine words');
  // Title case: three or more capitalised words that are not obviously names.
  if (words.filter((w) => /^[A-Z][a-z]/.test(w)).length >= 3) out.push('title case');
  return out;
}

// Three attempts. A structural failure (too short, missing field, unparseable)
// is fatal — the section is dropped and the issue goes out without it. A craft
// failure is not: if the model cannot shake a tired phrase in three tries, the
// last attempt still ships, because a reader losing the whole reflection over
// "at the end of the day" is the worse trade. What tripped is reported either
// way, so the admin preview shows it.
const ATTEMPTS = 3;

async function attempt(name, fn) {
  let last = null;
  let structural = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    const note = last?.craft?.length
      ? `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED for ${last.craft.join(', ')}. Write it again from scratch, without that. Do not simply reword around it.`
      : '';
    try {
      const res = await fn(note);
      if (!res.craft?.length) return { ok: true, value: res.value, craft: [] };
      last = res;
    } catch (err) {
      structural = String(err?.message || err);
      break;
    }
  }
  if (last) return { ok: true, value: last.value, craft: last.craft };
  return { ok: false, error: `${name}: ${structural || 'no usable output'}` };
}

function stripWrapping(s) {
  return String(s).trim().replace(/^["“”']+|["“”']+$/g, '').trim();
}

function titleish(s) {
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
