// Presentation and craft. These cover the things a reader would notice and a
// unit test otherwise would not: that a prayer keeps its lines all the way to
// both surfaces, that a permalink is not a dead end, and that the generator
// argues with a model that reaches for a dead phrase.

import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { renderEmail } from '../src/render/email.js';
import { renderIssuePage, renderArchivePage } from '../src/render/web.js';
import { stanzas, stanzasToText } from '../src/render/prayer.js';
import { normalizeRef } from '../src/lib/readings.js';
import { generateHeadline, generateReflection } from '../src/lib/generate.js';
import { PRAYERS } from '../src/content/prayers.js';
import { FORMS } from '../src/content/forms.js';
import { DRAFTS } from '../src/config.js';
import { makeStore } from '../src/lib/store.js';
import { pickForm, recentOpenings, rememberOpening, openingOf } from '../src/lib/rotation.js';
import { REFLECTIONS, reflectionFor, passageKey } from '../src/content/reflections.js';

const cfg = config({ LLM_PROVIDER: 'stub', SITE_URL: 'https://example.test/matins' });

const ISSUE = {
  date: '2026-08-05',
  liturgicalDay: {
    season: 'Ordinary Time',
    color: 'green',
    colorName: 'green',
    rank: 'weekday',
    feastOrSaint: 'Wednesday of the eighteenth week of Ordinary Time',
    isHolyDayOfObligation: false,
    optionalMemorials: [],
  },
  readings: {
    firstRef: 'Numbers 13:1–2',
    psalmRef: 'Psalm 106:6–7ab',
    secondRef: null,
    gospelRef: 'Matthew 15:21–28',
    usccbLink: 'https://bible.usccb.org/bible/readings/080526.cfm',
    unavailable: false,
  },
  verseOfDay: { ref: 'Matthew 15:21', text: 'And Jesus went from thence.', translation: 'Douay-Rheims' },
  reflection: 'A first paragraph.\n\nA second paragraph.',
  saintStory: {
    name: 'The Dedication of the Basilica of Saint Mary Major',
    isOptional: true,
    life: 'A short life.',
    oneActionToday: 'Say one Hail Mary before you start the engine.',
  },
  prayer: { id: 'our-father', title: 'The Our Father', text: 'Our Father, who art in heaven,\nhallowed be thy name;\nAmen.', note: 'A note.' },
  consider: { id: 'q', question: 'A question?', answer: 'An answer.', citation: 'Catechism of the Catholic Church, 1' },
  headline: 'a quiet line',
  headlineGenerated: true,
  status: 'ok',
  safetyReport: { blocks: [], dropped: [], degraded: [] },
  meta: {},
};

const INDEX = [
  { date: '2026-08-06', headline: 'newer', feastOrSaint: 'The Transfiguration of the Lord', color: 'white' },
  { date: '2026-08-05', headline: 'a quiet line', feastOrSaint: 'Wednesday of the eighteenth week', color: 'green' },
  { date: '2026-07-31', headline: 'older', feastOrSaint: 'Saint Ignatius of Loyola', color: 'white' },
];

test('every prayer in the bank is lineated, not a paragraph', () => {
  for (const p of PRAYERS) {
    const lines = stanzas(p.text).flat();
    assert.ok(lines.length >= 4, `${p.id} should be broken into lines, got ${lines.length}`);
    // A line is one breath. Anything much past this is a paragraph wearing a
    // line's clothes and will wrap into an unreadable block on a phone.
    for (const line of lines) {
      assert.ok(line.length <= 78, `${p.id} has a line of ${line.length} chars: ${line}`);
    }
  }
});

test('a prayer keeps its line breaks on both surfaces', () => {
  const email = renderEmail(ISSUE, { cfg });
  const page = renderIssuePage(ISSUE, { cfg, index: INDEX });
  for (const surface of [email.html, page]) {
    assert.ok(surface.includes('Our Father, who art in heaven,'));
    assert.ok(surface.includes('hallowed be thy name;'));
    // The two lines must be in separate blocks, not run together.
    assert.ok(!/heaven,\s*hallowed/.test(surface), 'lines were collapsed into a paragraph');
  }
  assert.match(email.text, /\n\s+hallowed be thy name;/);
});

test('the saint section is headed by the name the Church uses today', () => {
  const email = renderEmail(ISSUE, { cfg });
  const page = renderIssuePage(ISSUE, { cfg, index: INDEX });
  for (const surface of [email.html, email.text, page]) {
    assert.ok(
      surface.includes('The Dedication of the Basilica of Saint Mary Major') ||
        surface.includes('THE DEDICATION OF THE BASILICA OF SAINT MARY MAJOR'),
      'the saint heading should name the celebration, not say "Today"'
    );
  }
  assert.ok(page.includes('Optional memorial'));
});

test('a saint story with no name falls back rather than heading with nothing', () => {
  const issue = { ...ISSUE, saintStory: { ...ISSUE.saintStory, name: null, isOptional: false } };
  assert.ok(renderIssuePage(issue, { cfg }).includes('Saint of the day'));
  assert.ok(renderEmail(issue, { cfg }).html.includes('Saint of the day'));
});

test('an issue page carries the reader onward', () => {
  const page = renderIssuePage(ISSUE, { cfg, index: INDEX });
  assert.ok(page.includes('https://example.test/matins/2026-07-31/'), 'links to the older issue');
  assert.ok(page.includes('https://example.test/matins/2026-08-06/'), 'links to the newer issue');
  assert.ok(page.includes('/today/') && page.includes('/archive/'));
});

test('the newest and oldest issues simply lose the link they cannot have', () => {
  const newest = renderIssuePage({ ...ISSUE, date: '2026-08-06' }, { cfg, index: INDEX });
  assert.ok(!newest.includes('rel="next"'), 'nothing is newer than the newest issue');
  assert.ok(newest.includes('rel="prev"'));
  // No index at all (the preview CLI) still renders.
  assert.ok(renderIssuePage(ISSUE, { cfg }).includes('<h1>'));
});

test('the archive groups by month and names the celebration', () => {
  const page = renderArchivePage(INDEX, { cfg });
  assert.ok(page.includes('August 2026') && page.includes('July 2026'));
  assert.ok(page.includes('The Transfiguration of the Lord'));
  assert.ok(page.includes('3 issues, newest first'));
  assert.ok(renderArchivePage([], { cfg }).includes('has not gone out yet'));
});

test('the web page offers a dark palette and the email does not', () => {
  const page = renderIssuePage(ISSUE, { cfg, index: INDEX });
  assert.ok(page.includes('prefers-color-scheme: dark'));
  assert.ok(page.includes('@media print'));
  const email = renderEmail(ISSUE, { cfg }).html;
  assert.ok(!email.includes('prefers-color-scheme'), 'mail client dark-mode support is too uneven to attempt');
  assert.ok(email.includes('content="light"'));
});

test('the inbox preview line says more than the subject already does', () => {
  const { subject, preheader } = renderEmail(ISSUE, { cfg });
  assert.notEqual(preheader, subject);
  assert.ok(preheader.includes('Matthew 15:21–28'));
  assert.ok(preheader.includes('The Our Father'));
});

test('plain text wraps and keeps its shape', () => {
  const { text } = renderEmail(ISSUE, { cfg });
  for (const line of text.split('\n')) {
    // URLs are allowed to run long; nothing else is.
    if (/https?:\/\//.test(line)) continue;
    assert.ok(line.length <= 74, `line of ${line.length} chars: ${line}`);
  }
});

test('lectionary shorthand is normalised without changing a number', () => {
  assert.equal(normalizeRef('Numbers 13:1-2, 25--14:1, 26-29a, 34-35'), 'Numbers 13:1–2, 25—14:1, 26–29a, 34–35');
  assert.equal(normalizeRef('  Matthew   15:21-28 '), 'Matthew 15:21–28');
  assert.equal(normalizeRef('1 John 4:7-10'), '1 John 4:7–10');
});

test('stanzas split on blank lines and survive a round trip to text', () => {
  const blocks = stanzas('one\ntwo\n\nthree');
  assert.deepEqual(blocks, [['one', 'two'], ['three']]);
  assert.equal(stanzasToText('one\ntwo\n\nthree', { indent: '  ' }), '  one\n  two\n\n  three');
  assert.deepEqual(stanzas(''), []);
});

// --- drafting, judging, and craft -------------------------------------------

// A fake provider. It answers generation calls from a scripted list and judge
// calls from a scripted verdict, and counts each kind separately, so the
// draft-and-compare behaviour can be exercised for real.
function provider({ drafts = [], judge = { choice: 1, reason: 'more concrete' } } = {}) {
  const gen = [];
  const judged = [];
  const fetchImpl = async (_url, init) => {
    const content = JSON.parse(init.body).messages[0].content;
    const isJudge = /There are \d+ drafts/.test(content);
    (isJudge ? judged : gen).push(content);
    const text = isJudge
      ? typeof judge === 'string' ? judge : JSON.stringify(judge)
      : drafts[Math.min(gen.length - 1, drafts.length - 1)];
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  };
  return { fetchImpl, gen, judged };
}

const genCfg = config({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'test', SITE_URL: 'https://example.test' });
const DAY = { date: '2026-08-05', season: 'Ordinary Time', rank: 'weekday', colorName: 'green', feastOrSaint: 'A Wednesday' };

const CLEAN_A =
  'A woman asks twice and is put off twice. Most of us go quiet after the first no. She does not, and it turns out that is what faith looks like from outside. Ask again today.';
const CLEAN_B =
  'The second refusal is the one that stops people. You have a thing you stopped asking for about a year ago. Nobody decided to stop; it just went quiet. Today is the day to say it out loud again.';

test('more than one draft is written, and the judge decides between them', async () => {
  const p = provider({ drafts: [CLEAN_A, CLEAN_B], judge: { choice: 2, reason: 'the second earns its turn' } });
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], fetchImpl: p.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.value, CLEAN_B, 'the judge picked the second draft');
  assert.equal(res.judge, 'the second earns its turn');
  assert.equal(p.gen.length, DRAFTS.reflection);
  assert.equal(p.judged.length, 1);
});

test('a judge that cannot answer still ships a draft', async () => {
  const p = provider({ drafts: [CLEAN_A, CLEAN_B], judge: 'not json at all' });
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], fetchImpl: p.fetchImpl });
  assert.equal(res.ok, true, 'craft failing soft is the whole point — unlike safety');
  assert.equal(res.value, CLEAN_A);
  assert.equal(res.judge, null);
});

test('a whole round of tired drafts is sent back with the fault named', async () => {
  const stale = 'At the end of the day, the work is the work. There are mornings when the alarm is an enemy. You put the boots on anyway. That counts for more than it feels like.';
  const p = provider({ drafts: [stale] });
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], fetchImpl: p.fetchImpl });
  assert.equal(res.ok, true, 'a tired phrase is not worth losing the section over');
  assert.deepEqual(res.craft, ['"at the end of the day"']);
  assert.equal(p.gen.length, DRAFTS.reflection * 2, 'a second round was written');
  assert.match(p.gen[DRAFTS.reflection], /REJECTED for "at the end of the day"/);
});

test('a structurally unusable block is dropped, not shipped', async () => {
  const p = provider({ drafts: ['too short'] });
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], fetchImpl: p.fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /too short/);
  assert.equal(p.judged.length, 0, 'nothing to judge');
});

test('the reflection prompt carries the form, its exemplar, and the ground already covered', async () => {
  const form = FORMS.find((f) => f.id === 'cost');
  const p = provider({ drafts: [CLEAN_A] });
  await generateReflection({
    cfg: genCfg, day: DAY, readings: null, form,
    avoidOpenings: ['There is a particular kind of tired'],
    fetchImpl: p.fetchImpl,
  });
  const prompt = p.gen[0];
  assert.ok(prompt.includes(form.brief), 'the form brief is in the prompt');
  assert.ok(prompt.includes(form.exemplar), 'the exemplar is in the prompt');
  assert.ok(prompt.includes('There is a particular kind of tired'), 'recent openings are ruled out');
  assert.ok(prompt.includes('WHO IS SPEAKING'), 'the voice is in the prompt');
});

test('a headline that reads like a poster is sent back', async () => {
  const p = provider({ drafts: ['The Woman Who Would Not Stop', 'a small refusal, repeated'] });
  const res = await generateHeadline({ cfg: genCfg, day: DAY, reflection: null, fetchImpl: p.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.value, 'a small refusal, repeated');
  assert.deepEqual(res.craft, []);
});

test('forms rotate rather than repeating', async () => {
  const store = makeStore(null);
  const seen = [];
  for (const date of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
    const picked = await pickForm(store, { forms: FORMS, date, tags: [] });
    await picked.commit();
    seen.push(picked.chosen.id);
  }
  assert.equal(new Set(seen).size, seen.length, `a form repeated inside its cooldown: ${seen.join(', ')}`);
  // Deterministic: the same date and state give the same form back.
  const again = await pickForm(makeStore(null), { forms: FORMS, date: '2026-08-01', tags: [] });
  assert.equal(again.chosen.id, seen[0]);
});

test('openings are remembered so tomorrow cannot reuse them', async () => {
  const store = makeStore(null);
  assert.equal(openingOf('There is a particular kind of tired that arrives at the end.'), 'There is a particular kind of tired that');
  await rememberOpening(store, 'There is a particular kind of tired that arrives.');
  await rememberOpening(store, 'Nobody warns you that the hard part is not the start.');
  const recent = await recentOpenings(store);
  assert.equal(recent.length, 2);
  assert.equal(recent[0], 'Nobody warns you that the hard part is', 'most recent first');
});

test('every form carries an exemplar that obeys the house rules', () => {
  for (const f of FORMS) {
    assert.ok(f.brief && f.exemplar, `${f.id} is missing a brief or an exemplar`);
    assert.ok(!/!/.test(f.exemplar), `${f.id}'s exemplar has an exclamation mark`);
    assert.ok(!/["“]/.test(f.exemplar), `${f.id}'s exemplar quotes something`);
    assert.ok(!/\b\d+:\d+\b/.test(f.exemplar), `${f.id}'s exemplar cites a verse`);
    const words = f.exemplar.split(/\s+/).length;
    // A three-angle exemplar is legitimately longer than a single-point one.
    assert.ok(words >= 40 && words <= 165, `${f.id}'s exemplar is ${words} words`);
  }
});

// --- configuration diagnostics ----------------------------------------------

test('a value pasted with its quotes still on it is cleaned up', async () => {
  const { config: cfgFn } = await import('../src/config.js');
  const c = cfgFn({ LLM_MODEL: '"3.5"', REPLY_TO: "'a@b.com'", FROM_EMAIL: 'Matins <x@y.dev>', ADMIN_TOKEN: '"abc123"' });
  assert.equal(c.llmModel, '3.5');
  assert.equal(c.replyTo, 'a@b.com');
  assert.equal(c.adminToken, 'abc123', 'a secret pasted with quotes would never match');
  assert.equal(c.fromEmail, 'Matins <x@y.dev>', 'an unquoted value is left exactly alone');
});

test('a binding name with a trailing space still works, and is reported', async () => {
  const { config: cfgFn } = await import('../src/config.js');
  const c = cfgFn({ 'ADMIN_TOKEN ': 'abc123', 'RESEND_API_KEY ': 're_x', LLM_API_KEY: 'k' });
  assert.equal(c.adminToken, 'abc123', 'a stray space must not cost an evening twice');
  assert.equal(c.resendKey, 're_x');
  assert.deepEqual(c.bindingNameWarnings, ['ADMIN_TOKEN ', 'RESEND_API_KEY '], 'but it is never fixed silently');
  // A correctly named binding always beats a malformed twin.
  assert.equal(cfgFn({ ADMIN_TOKEN: 'right', 'ADMIN_TOKEN ': 'wrong' }).adminToken, 'right');
  assert.deepEqual(cfgFn({ ADMIN_TOKEN: 'right' }).bindingNameWarnings, []);
});

// --- the hand-written reflection bank ---------------------------------------

test('a hand-written reflection is matched by passage, not by date', () => {
  // The lectionary writes the same reading differently from year to year.
  assert.equal(reflectionFor('Matthew 15:21-28')?.id, 'canaanite-woman');
  assert.equal(reflectionFor('Matthew 15:21–28')?.id, 'canaanite-woman', 'an en dash is the same passage');
  assert.equal(reflectionFor('Matthew 15:21-31')?.id, 'canaanite-woman', 'a longer cut is the same passage');
  assert.equal(reflectionFor('Matthew 16:21-28'), null, 'a different chapter is not');
  assert.equal(reflectionFor(null), null);
});

test('every reflection in the bank is complete and in the house voice', () => {
  assert.equal(new Set(REFLECTIONS.map((r) => r.id)).size, REFLECTIONS.length, 'ids are unique');
  for (const r of REFLECTIONS) {
    assert.ok(r.id && r.gospel && r.body && r.turn && r.closer, `${r.id} is missing a field`);
    assert.ok(passageKey(r.gospel), `${r.id} has an unparseable gospel reference`);
    // Nothing generated these, so they never see the safety pass. The tells
    // below are the only automatic check they get.
    assert.ok(!/!/.test(r.body + r.turn + r.closer), `${r.id} has an exclamation mark`);
    assert.ok(!/\bI\b/.test(r.body), `${r.id} speaks in the first person`);
    assert.ok(!/\blet us\b/i.test(r.body), `${r.id} says "let us"`);
    assert.ok(!/["“]/.test(r.body), `${r.id} quotes something`);
    const words = r.body.split(/\s+/).length;
    assert.ok(words >= 80 && words <= 260, `${r.id} is ${words} words`);
    assert.ok(r.body.includes('\n\n'), `${r.id} should be more than one paragraph`);
  }
});

test('the bank no longer overrides a generated reflection', async () => {
  // The owner chose generated-always, so 2026-08-05 — a Gospel that IS in the
  // bank — must still come back generated.
  const { buildIssue } = await import('../src/lib/issue.js');
  const { readOnly } = await import('../src/lib/store.js');
  const { fixtureFetch } = await import('./fixture-fetch.mjs');
  const issue = await buildIssue({
    date: '2026-08-05',
    cfg: config({ LLM_PROVIDER: 'stub', SITE_URL: 'https://example.test' }),
    store: readOnly(makeStore(null)),
    dryRun: true,
    fetchImpl: fixtureFetch(),
  });
  assert.ok(reflectionFor(issue.readings.gospelRef), 'this Gospel is in the bank');
  assert.ok(!issue.reflection.includes('She asks, and gets silence.'), 'and the bank did not win');
  const verdict = issue.safetyReport.blocks.find((b) => b.block === 'reflection');
  assert.equal(verdict.pass, true);
  assert.ok(verdict.drafts >= 1, 'it went through the generator and the safety pass');
});

test('the reflection may retell the Gospel only when the passage is in hand', async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    seen.push(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: CLEAN_A }] }), { status: 200 });
  };
  const withText = { ref: 'Matthew 15:21-28', text: 'And behold a woman of Canaan came out of those coasts and cried out.' };
  await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], gospelPassage: withText, fetchImpl });
  assert.match(seen[0], /You may say what happens in the Gospel/);
  assert.ok(seen[0].includes(withText.text), 'and the text it may retell is in the prompt');

  seen.length = 0;
  await generateReflection({ cfg: genCfg, day: DAY, readings: null, form: FORMS[0], fetchImpl });
  assert.match(seen[0], /Do not retell or paraphrase what happens in a reading/, 'no text, no retelling');
});
