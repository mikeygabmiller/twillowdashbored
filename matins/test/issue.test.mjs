import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { buildIssue, SEEDED_BAD_REFLECTION } from '../src/lib/issue.js';
import { makeStore, readOnly } from '../src/lib/store.js';
import { renderEmail } from '../src/render/email.js';
import { renderIssuePage } from '../src/render/web.js';
import { firstVerseOf } from '../src/lib/scripture.js';
import { usccbLinkFor } from '../src/lib/readings.js';
import { pick } from '../src/lib/rotation.js';
import { PRAYERS } from '../src/content/prayers.js';
import { QA_BANK } from '../src/content/qa.js';
import { fixtureFetch } from './fixture-fetch.mjs';

const cfg = config({ LLM_PROVIDER: 'stub', SITE_URL: 'https://example.test/matins' });
const build = (opts = {}) =>
  buildIssue({ date: '2026-08-05', cfg, store: readOnly(makeStore(null)), dryRun: true, fetchImpl: fixtureFetch(), ...opts });

test('preview builds a complete issue from real calendar + readings', async () => {
  const issue = await build();
  assert.equal(issue.date, '2026-08-05');
  assert.equal(issue.liturgicalDay.season, 'Ordinary Time');
  assert.equal(issue.liturgicalDay.color, 'green');
  assert.match(issue.liturgicalDay.feastOrSaint, /Ordinary Time/);
  assert.equal(issue.readings.gospelRef, 'Matthew 15:21–28', 'verse ranges are normalised to an en dash');
  assert.equal(issue.readings.usccbLink, 'https://bible.usccb.org/bible/readings/080526.cfm');
  assert.equal(issue.verseOfDay.translation, 'Douay-Rheims');
  assert.ok(issue.reflection && issue.saintStory && issue.prayer.text && issue.consider.answer);
  assert.equal(issue.status, 'ok');
});

test('the safety pass drops a bad block and the rest of the issue survives', async () => {
  const issue = await build({ seedBadBlock: true });
  assert.equal(issue.reflection, null, 'the flagged reflection must not survive');
  assert.ok(!JSON.stringify(issue).includes('guaranteed to make you rich'));
  const verdict = issue.safetyReport.blocks.find((b) => b.block === 'reflection');
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reason.length > 10);
  assert.equal(issue.safetyReport.dropped[0].section, 'reflection');
  // Everything else still ships.
  assert.ok(issue.saintStory && issue.prayer.text && issue.consider.answer && issue.headline);
  const email = renderEmail(issue, { cfg });
  assert.ok(!email.html.includes('SEEDED_BAD_BLOCK'));
  assert.ok(!email.text.includes(SEEDED_BAD_REFLECTION));
  assert.ok(email.html.includes('Prayer'));
});

test('a dead readings API degrades to a USCCB link instead of crashing', async () => {
  const issue = await build({ fetchImpl: fixtureFetch({ fail: [/cpbjr\.github\.io/] }) });
  assert.equal(issue.readings.unavailable, true);
  assert.equal(issue.readings.gospelRef, null);
  assert.equal(issue.readings.usccbLink, 'https://bible.usccb.org/bible/readings/080526.cfm');
  assert.equal(issue.verseOfDay, null);
  assert.ok(issue.reflection, 'the rest of the issue is still built');
  assert.equal(issue.status, 'partial');
  assert.ok(renderEmail(issue, { cfg }).html.includes('usccb.org'));
});

test('a dead verse source drops the verse text, never the reference', async () => {
  const issue = await build({ fetchImpl: fixtureFetch({ fail: [/bible-api/] }) });
  assert.equal(issue.verseOfDay.ref, 'Matthew 15:21');
  assert.equal(issue.verseOfDay.text, null);
});

test('non-Douay-Rheims verse text is refused', async () => {
  const nabre = async () =>
    new Response(JSON.stringify({ text: 'some copyrighted rendering', translation_id: 'nabre', translation_name: 'NABRE' }), { status: 200 });
  const issue = await build({
    fetchImpl: async (url) => (/bible-api/.test(String(url)) ? nabre() : fixtureFetch()(url)),
  });
  assert.equal(issue.verseOfDay.text, null);
});

test('no copyrighted scripture or Catechism text reaches either surface', async () => {
  const issue = await build();
  const surfaces = renderEmail(issue, { cfg }).html + renderEmail(issue, { cfg }).text + renderIssuePage(issue, { cfg });
  assert.ok(!/NABRE|New American Bible|Revised Standard Version/i.test(surfaces));
  // Catechism appears only as a bare reference in the pre-vetted Q&A bank.
  for (const m of surfaces.matchAll(/Catechism[^<\n]{0,80}/g)) {
    assert.match(m[0], /Catechism of the Catholic Church,\s[\d–, ]+/);
  }
  assert.ok(surfaces.includes('bible.usccb.org'));
});

// The production failure of 6–13 August 2026, in one test. Gemini reasoned
// inside the output budget, both prose blocks came back cut off, and because a
// truncated candidate was returned as if it were finished the issue reported
// two unrelated-looking faults — an incoherent reflection and an unparseable
// saint story — for eight days without either naming the cause.
test('truncated generation is dropped, and says it was truncated', async () => {
  const truncated = async (url) => {
    if (!/generativelanguage/.test(String(url))) return fixtureFetch()(url);
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'The shop stayed open all winter and he never once' }] }, finishReason: 'MAX_TOKENS' }],
      }),
      { status: 200 }
    );
  };
  const geminiCfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', SITE_URL: 'https://example.test/matins' });
  const issue = await build({ cfg: geminiCfg, fetchImpl: truncated });

  assert.equal(issue.reflection, null);
  assert.equal(issue.saintStory, null);
  const reasons = issue.safetyReport.degraded.map((d) => `${d.section}: ${d.reason}`).join('\n');
  assert.match(reasons, /reflection: .*truncated/, 'the reason names truncation, not incoherence');
  assert.match(reasons, /saintStory: .*truncated/, 'the reason names truncation, not a parse failure');
  // A fragment must never reach a reader, on either surface.
  assert.equal(issue.headlineGenerated, false, 'the fallback headline is the day itself');
  assert.ok(!renderEmail(issue, { cfg: geminiCfg }).html.includes('never once'));
  // And the rest of the issue still ships.
  assert.ok(issue.prayer.text && issue.consider.answer && issue.readings.usccbLink);
});

test('the thinking budget reaches the model when configured', async () => {
  const bodies = [];
  const seen = async (url, init) => {
    if (!/generativelanguage/.test(String(url))) return fixtureFetch()(url);
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }),
      { status: 200 }
    );
  };
  const geminiCfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', GEMINI_THINKING_BUDGET: '0' });
  await build({ cfg: geminiCfg, fetchImpl: seen });
  assert.ok(bodies.length > 0);
  for (const b of bodies) {
    assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.ok(b.generationConfig.maxOutputTokens >= 3072);
  }
});

test('rotation never repeats inside the cooldown window', () => {
  const recent = PRAYERS.slice(0, 10).map((p) => p.id);
  const chosen = pick(PRAYERS, { recent, cooldown: 10, seed: 'x' });
  assert.ok(!recent.includes(chosen.id));
  // Cooldown wider than the bank falls back to least-recently-used, not a crash.
  const fallback = pick(PRAYERS, { recent: PRAYERS.map((p) => p.id), cooldown: 99, seed: 'x' });
  assert.ok(fallback && fallback.id === PRAYERS[PRAYERS.length - 1].id);
});

test('rotation is deterministic for a date', async () => {
  const a = await build();
  const b = await build();
  assert.equal(a.prayer.id, b.prayer.id);
  assert.equal(a.consider.id, b.consider.id);
});

test('a dry run writes nothing', async () => {
  const backing = makeStore(null);
  await buildIssue({ date: '2026-08-05', cfg, store: readOnly(backing), dryRun: true, fetchImpl: fixtureFetch() });
  assert.deepEqual(await backing.listKeys(''), []);
});

test('content banks are seeded, unique, and complete', () => {
  assert.ok(PRAYERS.length >= 15);
  assert.ok(QA_BANK.length >= 20);
  assert.equal(new Set(PRAYERS.map((p) => p.id)).size, PRAYERS.length);
  assert.equal(new Set(QA_BANK.map((q) => q.id)).size, QA_BANK.length);
  for (const p of PRAYERS) assert.ok(p.id && p.title && p.note && p.text && p.tags?.length, `prayer ${p.id} incomplete`);
  for (const q of QA_BANK) assert.ok(q.id && q.question && q.answer, `qa ${q.id} incomplete`);
});

test('reference helpers', () => {
  assert.equal(firstVerseOf('Luke 14:25-33'), 'Luke 14:25');
  assert.equal(firstVerseOf('John 6:41, 51'), 'John 6:41');
  assert.equal(firstVerseOf('Luke 9:28b-36'), 'Luke 9:28');
  assert.equal(firstVerseOf('1 Corinthians 12:12-14'), '1 Corinthians 12:12');
  assert.equal(firstVerseOf(''), null);
  assert.equal(usccbLinkFor('2026-12-25'), 'https://bible.usccb.org/bible/readings/122526.cfm');
});
