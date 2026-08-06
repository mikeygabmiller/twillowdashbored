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

// --- craft -----------------------------------------------------------------

// A fake provider that hands back a scripted sequence of replies, so the
// retry-on-a-dead-phrase behaviour can be exercised for real.
function scripted(replies) {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body).messages[0].content);
    const text = replies[Math.min(seen.length - 1, replies.length - 1)];
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  };
  return { fetchImpl, seen };
}

const genCfg = config({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'test', SITE_URL: 'https://example.test' });
const DAY = { date: '2026-08-05', season: 'Ordinary Time', rank: 'weekday', colorName: 'green', feastOrSaint: 'A Wednesday' };

test('a headline in title case is sent back, and the second try is kept', async () => {
  const { fetchImpl, seen } = scripted(['The Woman Who Would Not Stop', 'the woman who would not stop']);
  const res = await generateHeadline({ cfg: genCfg, day: DAY, reflection: null, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.value, 'the woman who would not stop');
  assert.equal(seen.length, 2, 'it should have argued once');
  assert.match(seen[1], /REJECTED for title case/);
});

test('a reflection that will not drop a dead phrase still ships, and says so', async () => {
  const stale =
    'At the end of the day, the work is the work. There are mornings when the alarm is an enemy. You put the boots on anyway. That counts for more than it feels like.';
  const { fetchImpl, seen } = scripted([stale]);
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, fetchImpl });
  assert.equal(res.ok, true, 'a tired phrase is not worth losing the section over');
  assert.equal(res.value, stale);
  assert.deepEqual(res.craft, ['"at the end of the day"']);
  assert.equal(seen.length, 3, 'it should have tried three times first');
});

test('a structurally unusable block is dropped, not shipped', async () => {
  const { fetchImpl } = scripted(['too short']);
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /too short/);
});

test('clean prose is accepted on the first try', async () => {
  const good =
    'A woman asks twice and is put off twice. Most of us go quiet after the first no. She does not, and it turns out that is what faith looks like from the outside. Ask again today.';
  const { fetchImpl, seen } = scripted([good]);
  const res = await generateReflection({ cfg: genCfg, day: DAY, readings: null, fetchImpl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.craft, []);
  assert.equal(seen.length, 1);
});
