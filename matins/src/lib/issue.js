// One build per day powers both surfaces. Everything that can fail is allowed
// to fail: a dead API or a flagged block costs its own section and nothing
// else. The only thing that can stop an issue is the liturgical calendar
// itself, which is computed offline and has no network to lose.

import { getLiturgicalDay } from './calendar.js';
import { getReadings } from './readings.js';
import { getVerseOfDay } from './scripture.js';
import { generateReflection, generateSaintStory, generateHeadline } from './generate.js';
import { checkBlock } from './safety.js';
import { PRAYERS } from '../content/prayers.js';
import { QA_BANK } from '../content/qa.js';
import { pickPrayer, pickQa } from './rotation.js';

// The block that proves the safety pass works. `preview --seed-bad-block` (or
// buildIssue({ seedBadBlock: true })) swaps this in for the real reflection;
// it must never survive to a rendered issue.
export const SEEDED_BAD_REFLECTION =
  'SEEDED_BAD_BLOCK. The Church teaches that money given to God is guaranteed to make you rich, and the Catechism §1324 says so plainly: "give and it shall be given to you, pressed down and running over" (cf. Luke 6:38). Any Catholic who doubts this is in mortal sin.';

export async function buildIssue({ date, cfg, store, dryRun = false, seedBadBlock = false, fetchImpl } = {}) {
  const startedAt = new Date().toISOString();
  const degraded = [];
  const dropped = [];

  const day = await getLiturgicalDay(date, cfg);

  const readings = await getReadings(date, cfg, { fetchImpl });
  if (readings.degraded) degraded.push({ section: 'readings', reason: readings.error || 'no readings for this date' });

  const verse = await getVerseOfDay(readings.gospelRef, cfg, { fetchImpl });
  if (verse?.error) degraded.push({ section: 'verseOfDay', reason: verse.error });

  // Generation. Reflection first because the headline is written against it.
  const reflectionRes = seedBadBlock
    ? { ok: true, value: SEEDED_BAD_REFLECTION }
    : await generateReflection({ cfg, day, readings, fetchImpl });
  if (!reflectionRes.ok) degraded.push({ section: 'reflection', reason: reflectionRes.error });

  const [saintRes, headlineRes] = await Promise.all([
    generateSaintStory({ cfg, day, fetchImpl }),
    generateHeadline({ cfg, day, reflection: reflectionRes.ok ? reflectionRes.value : null, fetchImpl }),
  ]);
  if (!saintRes.ok && !saintRes.skipped) degraded.push({ section: 'saintStory', reason: saintRes.error });
  if (!headlineRes.ok) degraded.push({ section: 'headline', reason: headlineRes.error });

  // Safety. Prayers and the Q&A bank are pre-vetted and skip it by design.
  const facts = factsFor(day, readings);
  const checks = [];
  const [reflectionCheck, saintCheck, headlineCheck] = await Promise.all([
    reflectionRes.ok ? checkBlock({ cfg, name: 'reflection', text: reflectionRes.value, facts, fetchImpl }) : null,
    saintRes.ok ? checkBlock({ cfg, name: 'saintStory', text: `${saintRes.value.life}\n\nOne thing today: ${saintRes.value.oneActionToday}`, facts, fetchImpl }) : null,
    headlineRes.ok ? checkBlock({ cfg, name: 'headline', text: headlineRes.value, facts, fetchImpl }) : null,
  ]);

  const keep = (name, res, check) => {
    if (!res?.ok) return null;
    checks.push({ block: name, pass: check.pass, reason: check.reason });
    if (check.pass) return res.value;
    dropped.push({ section: name, reason: check.reason });
    return null;
  };

  const reflection = keep('reflection', reflectionRes, reflectionCheck);
  const saintStory = keep('saintStory', saintRes, saintCheck);
  const headline = keep('headline', headlineRes, headlineCheck);

  // Hardcoded banks, chosen by rotation.
  const tags = [day.season?.toLowerCase(), 'daily', 'work'].filter(Boolean);
  const prayerPick = await pickPrayer(store, { prayers: PRAYERS, date, tags });
  const qaPick = await pickQa(store, { bank: QA_BANK, date, tags: [day.season?.toLowerCase()] });
  if (!dryRun) {
    await prayerPick.commit();
    await qaPick.commit();
  }

  const p = prayerPick.chosen;
  const q = qaPick.chosen;

  const issue = {
    date,
    liturgicalDay: {
      season: day.season,
      color: day.color,
      colorName: day.colorName,
      rank: day.rank,
      feastOrSaint: day.feastOrSaint,
      isHolyDayOfObligation: day.isHolyDayOfObligation,
      optionalMemorials: day.optionalMemorials,
    },
    readings: {
      firstRef: readings.firstRef,
      psalmRef: readings.psalmRef,
      secondRef: readings.secondRef,
      gospelRef: readings.gospelRef,
      usccbLink: readings.usccbLink,
      unavailable: !!readings.degraded,
    },
    verseOfDay: verse ? { ref: verse.ref, text: verse.text || null, translation: verse.translation || null } : null,
    reflection,
    saintStory,
    prayer: { id: p.id, title: p.title, text: p.text, note: p.note },
    consider: { id: q.id, question: q.question, answer: q.answer, citation: q.citation || null },
    headline: headline || fallbackHeadline(day),
    headlineGenerated: !!headline,
    status: dropped.length || degraded.length ? 'partial' : 'ok',
    safetyReport: {
      checkedAt: new Date().toISOString(),
      provider: cfg.llmProvider,
      model: cfg.llmModel || null,
      blocks: checks,
      dropped,
      degraded,
    },
    meta: { builtAt: startedAt, dryRun, appName: cfg.appName, readingsSource: readings.source || null },
  };

  return issue;
}

function fallbackHeadline(day) {
  // Never generated, never wrong: the day as the Church names it.
  return day.feastOrSaint;
}

function factsFor(day, readings) {
  return [
    `Date: ${day.date}`,
    `Season: ${day.season}`,
    `Rank: ${day.rank}`,
    `Colour: ${day.colorName}`,
    `Celebration: ${day.feastOrSaint}`,
    day.saint?.canonizationLevel ? `Canonization status: ${day.saint.canonizationLevel}` : null,
    day.saint?.titles?.length ? `Titles: ${day.saint.titles.join(', ')}` : null,
    day.saint?.dateOfDeath != null ? `Year of death: ${day.saint.dateOfDeath}` : null,
    readings?.firstRef ? `First reading: ${readings.firstRef}` : null,
    readings?.psalmRef ? `Psalm: ${readings.psalmRef}` : null,
    readings?.secondRef ? `Second reading: ${readings.secondRef}` : null,
    readings?.gospelRef ? `Gospel: ${readings.gospelRef}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
