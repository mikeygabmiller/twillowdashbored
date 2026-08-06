// One build per day powers both surfaces. Everything that can fail is allowed
// to fail: a dead API or a flagged block costs its own section and nothing
// else. The only thing that can stop an issue is the liturgical calendar
// itself, which is computed offline and has no network to lose.

import { getLiturgicalDay } from './calendar.js';
import { getReadings } from './readings.js';
import { getVerseOfDay, getPassage, pickEpistle } from './scripture.js';
import { generateReflection, generateSaintStory, generateHeadline, generateReadingSummary } from './generate.js';
import { checkBlock } from './safety.js';
import { PRAYERS } from '../content/prayers.js';
import { QA_BANK } from '../content/qa.js';
import { FORMS } from '../content/forms.js';
import { QA_PER_ISSUE } from '../config.js';
import { pickPrayer, pickQaSet, pickForm, recentOpenings, rememberOpening } from './rotation.js';

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

  // The two readings the issue actually carries, and their Douay-Rheims text.
  // The text is never printed — it is the grounding that lets the summary say
  // what happens without the model working from memory. No text, no summary.
  const epistlePick = pickEpistle(readings);
  const [epistlePassage, gospelPassage] = await Promise.all([
    epistlePick ? getPassage(epistlePick.ref, cfg, { fetchImpl }) : null,
    readings.gospelRef ? getPassage(readings.gospelRef, cfg, { fetchImpl }) : null,
  ]);
  for (const [name, p] of [['epistleText', epistlePassage], ['gospelText', gospelPassage]]) {
    if (p?.error) degraded.push({ section: name, reason: p.error });
  }

  // Generation. Reflection first because the headline is written against it.
  // The form is rotated the same way the prayers are — a model asked only for
  // a length writes the same paragraph every day.
  const formPick = await pickForm(store, { forms: FORMS, date, tags: [day.season?.toLowerCase(), day.rank?.toLowerCase()] });
  const reflectionRes = seedBadBlock
    ? { ok: true, value: SEEDED_BAD_REFLECTION }
    : await generateReflection({
        cfg,
        day,
        readings,
        form: formPick.chosen,
        avoidOpenings: await recentOpenings(store),
        fetchImpl,
      });
  if (!reflectionRes.ok) degraded.push({ section: 'reflection', reason: reflectionRes.error });

  // The summary is generated before the headline, because the headline is
  // written against what today actually contains rather than against the date.
  const [saintRes, summaryRes] = await Promise.all([
    generateSaintStory({ cfg, day, fetchImpl }),
    generateReadingSummary({ cfg, day, epistle: epistlePassage, gospel: gospelPassage, fetchImpl }),
  ]);
  if (!saintRes.ok && !saintRes.skipped) degraded.push({ section: 'saintStory', reason: saintRes.error });
  if (!summaryRes.ok && !summaryRes.skipped) degraded.push({ section: 'readingSummary', reason: summaryRes.error });

  const headlineRes = await generateHeadline({
    cfg,
    day,
    reflection: reflectionRes.ok ? reflectionRes.value : null,
    readingSummary: summaryRes.ok ? summaryRes.value : null,
    fetchImpl,
  });
  if (!headlineRes.ok) degraded.push({ section: 'headline', reason: headlineRes.error });

  // Safety. Prayers and the Q&A bank are pre-vetted and skip it by design.
  const facts = factsFor(day, readings);
  const checks = [];
  const [reflectionCheck, saintCheck, headlineCheck, summaryCheck] = await Promise.all([
    reflectionRes.ok ? checkBlock({ cfg, name: 'reflection', text: reflectionRes.value, facts, fetchImpl }) : null,
    saintRes.ok ? checkBlock({ cfg, name: 'saintStory', text: `${saintRes.value.life}\n\nOne thing today: ${saintRes.value.oneActionToday}`, facts, fetchImpl }) : null,
    headlineRes.ok ? checkBlock({ cfg, name: 'headline', text: headlineRes.value, facts, fetchImpl }) : null,
    // The passage text goes in as FACTS: that is what makes 'asserts something
    // not in the facts' a real test for a retelling rather than a formality.
    summaryRes.ok
      ? checkBlock({
          cfg,
          name: 'readingSummary',
          text: summaryText(summaryRes.value),
          facts: `${facts}\n${passageFacts(epistlePassage, gospelPassage)}`,
          fetchImpl,
        })
      : null,
  ]);

  const keep = (name, res, check) => {
    if (!res?.ok) return null;
    // `craft` is a style note, not a safety verdict: the block ships either
    // way. It is reported so the admin preview shows which tired phrase the
    // model could not shake, which is the only way to tune the prompts.
    checks.push({
      block: name,
      pass: check.pass,
      reason: check.reason,
      craft: res.craft?.length ? res.craft : undefined,
      // How the block was arrived at: how many drafts were written, and what
      // decided between them. This is the record you read when the writing
      // starts drifting.
      drafts: res.drafts,
      judge: res.judge || undefined,
    });
    if (check.pass) return res.value;
    dropped.push({ section: name, reason: check.reason });
    return null;
  };

  const reflection = keep('reflection', reflectionRes, reflectionCheck);
  const saintStory = keep('saintStory', saintRes, saintCheck);
  const headline = keep('headline', headlineRes, headlineCheck);
  const readingSummary = keep('readingSummary', summaryRes, summaryCheck);

  // Hardcoded banks, chosen by rotation.
  const tags = [day.season?.toLowerCase(), 'daily', 'work'].filter(Boolean);
  const prayerPick = await pickPrayer(store, { prayers: PRAYERS, date, tags });
  const qaPick = await pickQaSet(store, { bank: QA_BANK, date, tags: [day.season?.toLowerCase()], count: QA_PER_ISSUE });
  if (!dryRun) {
    await prayerPick.commit();
    await qaPick.commit();
    // Only remember the form and the opening if the reflection actually
    // survived — a dropped block used neither.
    if (reflection) {
      await formPick.commit();
      await rememberOpening(store, reflection);
    }
  }

  const p = prayerPick.chosen;
  const questions = qaPick.chosen;

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
      // The two the issue actually carries. `summary` and `calledTo` are only
      // here when the Douay-Rheims text came back and the retelling cleared
      // safety; otherwise the reference stands on its own, as it always did.
      epistle: epistlePick
        ? { ref: epistlePick.ref, label: epistlePick.label, ...(readingSummary?.epistle || {}) }
        : null,
      gospel: readings.gospelRef
        ? { ref: readings.gospelRef, label: 'Gospel', ...(readingSummary?.gospel || {}) }
        : null,
    },
    verseOfDay: verse ? { ref: verse.ref, text: verse.text || null, translation: verse.translation || null } : null,
    reflection,
    // The name is romcal's, not the model's — it heads the section, so it has
    // to be the one the Church uses today, and it never goes through safety
    // because nothing generated it.
    saintStory: saintStory
      ? { ...saintStory, name: day.saint?.name || null, isOptional: !!day.saint?.isOptional }
      : null,
    prayer: { id: p.id, title: p.title, text: p.text, note: p.note },
    consider: questions.map((q) => ({ id: q.id, question: q.question, answer: q.answer, citation: q.citation || null })),
    headline: headline || fallbackHeadline(day),
    headlineGenerated: !!headline,
    status: dropped.length || degraded.length ? 'partial' : 'ok',
    safetyReport: {
      checkedAt: new Date().toISOString(),
      provider: cfg.llmProvider,
      model: cfg.llmModel || null,
      reflectionForm: formPick.chosen.id,
      blocks: checks,
      dropped,
      degraded,
    },
    meta: { builtAt: startedAt, dryRun, appName: cfg.appName, readingsSource: readings.source || null },
  };

  return issue;
}

// What the safety pass reads when it judges the retelling. Flattened so a
// dropped verdict costs both halves rather than leaving one unchecked.
function summaryText(summary) {
  return [summary?.epistle, summary?.gospel]
    .filter(Boolean)
    .map((p) => `${p.ref}\n${p.summary}\nCalled to: ${p.calledTo}`)
    .join('\n\n');
}

// The Douay-Rheims text is public domain, is never printed to a reader, and is
// handed to the checker only so "asserts something not in the facts" has real
// facts to test against.
function passageFacts(epistle, gospel) {
  return [epistle, gospel]
    .filter((p) => p?.text)
    .map((p) => `Full Douay-Rheims text of ${p.ref}:\n${p.text}`)
    .join('\n\n');
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
