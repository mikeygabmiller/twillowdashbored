// The only three generated blocks: reflection, saint story, headline.
//
// Rules baked into every prompt:
//   * the model is handed the facts and may not add any of its own;
//   * no scripture text, no CCC text, no quotations, no citations;
//   * a reflection is a reflection, never binding teaching.
// Anything that slips past these still has to clear safety.js before it ships.
//
// HOW CONSISTENCY IS ACTUALLY GOT. Orthodoxy is safety.js's job. This file's
// job is that the writing be good on a Tuesday in August, not just on Easter.
// Four things do that work, in descending order of how much they matter:
//
//   1. EXEMPLARS. Every block is shown a worked example in the house voice
//      (content/forms.js). Few-shot holds register better than any amount of
//      adjectives in an instruction. If the prose drifts, fix the exemplars.
//   2. A NAMED SHAPE, ROTATED. "Four to six sentences" is a length, and a
//      model given only a length writes the same paragraph daily. The shape is
//      chosen by rotation and changes under it (content/forms.js).
//   3. DRAFTS AND A JUDGE. Each block is written more than once and compared
//      (lib/judge.js). One draft is a coin flip on tone.
//   4. TRIPWIRES. A short list of phrases that mark writing as machine-made.
//      Tripping one sends the block back with the fault named.
//
// Craft never fails closed. If the model cannot shake a tired phrase, the best
// draft still ships — losing the whole reflection over "at the end of the day"
// is the worse trade. What tripped is reported for tuning.

import { llmText, parseJsonReply } from './llm.js';
import { pickBest } from './judge.js';
import { voicePrompt } from '../content/voice.js';
import { FORMS, SAINT_EXEMPLAR, HEADLINE_EXEMPLARS } from '../content/forms.js';
import { DRAFTS, TEMPERATURE } from '../config.js';

const HARD_RULES = `ABSOLUTE RULES — a violation means the block is thrown away:
1. Use ONLY the facts given to you below. Do not add dates, places, numbers, names, miracles, quotations, or biographical details that are not in the facts.
2. Quote no scripture. Do not retell or paraphrase what happens in a reading. You may name a reading by its reference and say what it is about in the broadest terms, nothing more.
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

// Ground already covered. Without this the opening sentence converges — every
// other Tuesday starts with an alarm going off.
function avoidBlock(openings) {
  if (!openings?.length) return '';
  return `\n\nRECENT OPENINGS, ALREADY USED. Do not open like any of these, and do not use the same image:\n${openings
    .slice(0, 12)
    .map((o) => `- ${o}…`)
    .join('\n')}`;
}

export async function generateReflection({ cfg, day, readings, form, avoidOpenings = [], fetchImpl }) {
  const shape = form || FORMS[0];
  const prompt = `${HARD_RULES}

${voicePrompt()}

TODAY'S GROUNDED FACTS
${factSheet(day, readings)}

TODAY'S FORM — ${shape.name.toUpperCase()}
${shape.brief}

AN EXAMPLE OF THIS FORM, WRITTEN FOR A DIFFERENT DAY
Study its texture, not its subject. Do not reuse its situation, its images, or its sentences.
"""
${shape.exemplar}
"""

TASK — REFLECTION
Write 4 to 6 sentences for today, in the form above. Anchor it in the celebration, and in what the Church is putting in front of people today if readings are listed — but you may only name a reading, never retell it. Tie it to ordinary working life: patience with people, honest dealing, doing work well when nobody is checking, carrying a hard day.${avoidBlock(avoidOpenings)}

Return the reflection text only. No title, no preamble, no quotation marks around it.`;

  const res = await produce({
    name: 'reflection',
    cfg,
    count: DRAFTS.reflection,
    fetchImpl,
    make: async ({ temperature, note }) => {
      const text = stripWrapping(await llmText({ cfg, system: SYSTEM, prompt: prompt + note, maxTokens: 500, temperature, fetchImpl }));
      const words = text.split(/\s+/).length;
      if (words < 25) throw new Error('reflection too short');
      if (words > 220) throw new Error('reflection too long');
      return { value: text, text, craft: craft(text, { opener: true }) };
    },
  });
  return res.ok ? { ...res, form: shape.id } : res;
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
6. This is a SAINT block. Beyond the facts listed below you may retell only what is universally attested and uncontested about this figure — the broad shape of the life. If you are not certain of something, leave it out. No invented dates, no invented places, no invented quotations, no legends presented as fact. If you know very little, write less. A short true paragraph beats a long decorated one.

${voicePrompt()}

GROUNDED FACTS ABOUT TODAY'S SAINT OR FEAST
${facts}

AN EXAMPLE, WRITTEN ABOUT SOMEBODY ELSE
Study how little it claims and how much it still says. Note that it names no place and no date, and that the second paragraph is about the unglamorous part. Do not reuse its subject or its sentences.
"""
${SAINT_EXEMPLAR.life}

One thing today: ${SAINT_EXEMPLAR.oneActionToday}
"""

TASK — SAINT STORY
Write two short paragraphs (3 to 5 sentences total) telling this life warmly and plainly, as you would tell a friend on a job site why this person is worth knowing. Say what kind of person they were and what it cost them. Prefer the ordinary, sustained part of the life over the dramatic part. Do not open by restating their name and title — that is already the heading above your text.

Then give one concrete thing a working person can actually do today because of it. A single specific action, doable before bed, no more than one sentence — something the reader could tell you at night whether or not they did. "Pray more", "reflect on his example", "be more patient" are failures: name the actual act.

Return only JSON: {"life": "...", "oneActionToday": "..."}`;

  return produce({
    name: 'saintStory',
    cfg,
    count: DRAFTS.saintStory,
    fetchImpl,
    make: async ({ temperature, note }) => {
      const raw = await llmText({ cfg, system: `${SYSTEM} Return only JSON.`, prompt: prompt + note, maxTokens: 600, temperature, fetchImpl });
      const obj = parseJsonReply(raw);
      const life = stripWrapping(String(obj.life || ''));
      const oneActionToday = stripWrapping(String(obj.oneActionToday || ''));
      if (!life || !oneActionToday) throw new Error('saint story missing a field');
      if (oneActionToday.split(/\s+/).length > 35) throw new Error('one action is not one sentence');
      return {
        value: { life, oneActionToday },
        text: `${life}\n\nOne thing today: ${oneActionToday}`,
        craft: [...craft(life), ...vagueAction(oneActionToday)],
      };
    },
  });
}

export async function generateHeadline({ cfg, day, reflection, fetchImpl }) {
  const prompt = `${HARD_RULES}

${voicePrompt()}

TODAY'S GROUNDED FACTS
${factSheet(day, null)}

${reflection ? `TODAY'S REFLECTION (for tone only — do not summarise it mechanically)\n${reflection}\n` : ''}
HEADLINES THAT WORKED, FOR OTHER DAYS
${HEADLINE_EXEMPLARS.map((h) => `- ${h}`).join('\n')}

TASK — HEADLINE
Write ONE line, at most nine words, to sit at the top of the email and in the inbox preview. Concrete and quiet. Not a slogan — nothing that could go on a poster. No colon-and-subtitle construction. All lower case except proper names, and no full stop. Do not name the feast; it is printed directly underneath. Lifting a striking phrase out of the reflection is the best move available to you.

Return the line only.`;

  return produce({
    name: 'headline',
    cfg,
    count: DRAFTS.headline,
    fetchImpl,
    make: async ({ temperature, note }) => {
      const raw = stripWrapping(await llmText({ cfg, system: SYSTEM, prompt: prompt + note, maxTokens: 60, temperature, fetchImpl }));
      const line = raw.split('\n')[0].replace(/\.$/, '').trim();
      if (!line || line.split(/\s+/).length > 14) throw new Error('headline unusable');
      return { value: line, text: line, craft: headlineCraft(line) };
    },
  });
}

const SYSTEM =
  'You write one block of a daily Catholic devotional. You are given the facts, the voice, the form, and an example. Follow them exactly. Never mention that you are an AI or that anything was generated.';

// --- drafting ---------------------------------------------------------------

// Drafts are spread across temperature so they are genuinely different attempts
// rather than the same sentence three times.
function temperatureFor(i) {
  return Math.min(0.9, TEMPERATURE.generate + i * 0.2);
}

async function once(make, temperature, note) {
  try {
    const r = await make({ temperature, note });
    return { ok: true, ...r, craft: r.craft || [] };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function produce({ name, cfg, count, make, fetchImpl }) {
  const round = (note) => Promise.all(Array.from({ length: count }, (_, i) => once(make, temperatureFor(i), note)));

  let all = await round('');
  let usable = all.filter((r) => r.ok);
  // Every draft failed structurally — too short, unparseable, missing a field.
  // That is not a matter of taste, so the block is dropped.
  if (!usable.length) return { ok: false, error: `${name}: ${all[0]?.error || 'no usable output'}` };

  let clean = usable.filter((r) => !r.craft.length);
  if (!clean.length) {
    const faults = [...new Set(usable.flatMap((r) => r.craft))];
    const retry = (await round(
      `\n\nA PREVIOUS ATTEMPT WAS REJECTED for ${faults.join(', ')}. Write it again from scratch without that. Do not simply reword around it.`
    )).filter((r) => r.ok);
    usable = [...usable, ...retry];
    clean = retry.filter((r) => !r.craft.length);
  }

  // Judge between the clean drafts; if none came back clean, judge between the
  // two least-tired ones rather than dropping the section.
  const pool = clean.length ? clean : [...usable].sort((a, b) => a.craft.length - b.craft.length).slice(0, 2);
  const { index, reason, judged } = await pickBest({ cfg, name, drafts: pool.map((p) => ({ text: p.text })), fetchImpl });
  const chosen = pool[index] || pool[0];

  return {
    ok: true,
    value: chosen.value,
    craft: chosen.craft,
    drafts: usable.length,
    judge: judged ? reason : null,
  };
}

// --- craft ------------------------------------------------------------------

// Phrases that mark devotional writing as machine-made. Kept short and
// specific on purpose: every entry here is something a careful human writer
// would not have typed.
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
  [/\bbrothers and sisters\b/i, 'addressing the readership as a group'],
  [/\bmay we all\b/i, '"may we all"'],
  [/!/, 'an exclamation mark'],
];

const OPENERS = [
  /^in today'?s\b/i,
  /^today,? the Church\b/i,
  /^the readings today\b/i,
  /^today'?s (?:readings|gospel|feast)\b/i,
  /^on this (?:day|feast)\b/i,
  /^as we (?:celebrate|mark|remember)\b/i,
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

function stripWrapping(s) {
  return String(s).trim().replace(/^["“”']+|["“”']+$/g, '').trim();
}

function titleish(s) {
  return String(s).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
