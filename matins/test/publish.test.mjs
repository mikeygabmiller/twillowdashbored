import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { publishIssue } from '../src/lib/publish.js';

const cfg = config({ GITHUB_TOKEN: 'test-token', SITE_REPO: 'someone/matins', SITE_BRANCH: 'main', WORKER_URL: 'https://matins.test.workers.dev' });

const issue = {
  date: '2026-08-05',
  headline: 'a quiet start',
  liturgicalDay: { season: 'Ordinary Time', color: 'green', colorName: 'green', rank: 'weekday', feastOrSaint: 'Wednesday of the eighteenth week of Ordinary Time', isHolyDayOfObligation: false, optionalMemorials: [] },
  readings: { firstRef: null, psalmRef: null, secondRef: null, gospelRef: null, usccbLink: 'https://bible.usccb.org/bible/readings/080526.cfm', unavailable: true },
  verseOfDay: null,
  reflection: 'A short reflection.',
  saintStory: null,
  prayer: { id: 'our-father', title: 'The Our Father', text: 'Our Father…', note: 'note' },
  consider: { id: 'qa-grace', question: 'q', answer: 'a', citation: null },
};

// Records every write and lets a test decide which paths already exist.
function fakeGithub({ existing = new Set() } = {}) {
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    const path = decodeURIComponent(String(url).split('/contents/')[1].split('?')[0]);
    if (!init.method || init.method === 'GET') {
      return existing.has(path)
        ? new Response(JSON.stringify({ sha: 'abc123' }), { status: 200 })
        : new Response('not found', { status: 404 });
    }
    writes.push({ path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: { path } }), { status: 200 });
  };
  return { fetchImpl, writes };
}

test('publishing into an empty repo bootstraps the whole site', async () => {
  const gh = fakeGithub();
  const res = await publishIssue({ issue, index: [{ date: issue.date, headline: issue.headline, color: 'green' }], cfg, fetchImpl: gh.fetchImpl });
  assert.equal(res.ok, true, res.errors.join('; '));
  const paths = gh.writes.map((w) => w.path);
  assert.deepEqual(paths, [
    '2026-08-05/index.html',
    'archive/index.html',
    'today/index.html',
    'issues/2026-08-05.json',
    'index.html',
    'mark.svg',
    '.nojekyll',
  ]);
  // The landing page it writes must point back at the Worker, not the site.
  const landing = Buffer.from(gh.writes.find((w) => w.path === 'index.html').body.content, 'base64').toString('utf8');
  assert.ok(landing.includes('action="https://matins.test.workers.dev/subscribe"'));
});

test('a second publish rewrites the issue pages but never the landing page', async () => {
  const gh = fakeGithub({ existing: new Set(['index.html', 'mark.svg', '.nojekyll', 'archive/index.html', 'today/index.html']) });
  const res = await publishIssue({ issue, index: [], cfg, fetchImpl: gh.fetchImpl });
  assert.equal(res.ok, true);
  const paths = gh.writes.map((w) => w.path);
  assert.ok(paths.includes('archive/index.html'), 'the archive is rewritten every day');
  assert.ok(paths.includes('today/index.html'), 'the today redirect is rewritten every day');
  assert.ok(!paths.includes('index.html'), 'a hand-edited landing page survives');
  assert.ok(!paths.includes('mark.svg'));
  assert.deepEqual(res.skipped, ['index.html', 'mark.svg', '.nojekyll']);
  // Rewrites carry the existing blob sha, or GitHub rejects them.
  assert.equal(gh.writes.find((w) => w.path === 'archive/index.html').body.sha, 'abc123');
});

test('a publish failure is reported, not thrown', async () => {
  const fetchImpl = async (url, init = {}) =>
    !init.method || init.method === 'GET' ? new Response('nope', { status: 404 }) : new Response('bad credentials', { status: 401 });
  const res = await publishIssue({ issue, index: [], cfg, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 7);
  assert.match(res.errors[0], /write 401/);
});

// 2026-08-10 published a page and an archive entry with no issues/*.json
// behind it: one call in the middle of fourteen lost a race and nothing tried
// again. A 409 is GitHub saying the branch head moved, which is exactly what
// thirteen other writes in the same second would cause.
test('a transient failure is retried rather than left as a hole in the site', async () => {
  let attempts = 0;
  const writes = [];
  const fetchImpl = async (url, init = {}) => {
    const path = decodeURIComponent(String(url).split('/contents/')[1].split('?')[0]);
    if (!init.method || init.method === 'GET') return new Response('not found', { status: 404 });
    if (path === 'issues/2026-08-05.json' && attempts++ < 2) {
      return new Response('is at least conflicting', { status: 409 });
    }
    writes.push(path);
    return new Response('{}', { status: 200 });
  };
  const res = await publishIssue({ issue, index: [], cfg, fetchImpl });
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(attempts, 3, 'two 409s, then the write landed on the third attempt');
  assert.ok(writes.includes('issues/2026-08-05.json'), 'the JSON archive is not left behind');
});

test('a permanent failure is not retried', async () => {
  let puts = 0;
  const fetchImpl = async (url, init = {}) => {
    if (!init.method || init.method === 'GET') return new Response('not found', { status: 404 });
    puts += 1;
    return new Response('bad credentials', { status: 401 });
  };
  const res = await publishIssue({ issue, index: [], cfg, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(puts, 7, 'one attempt per file, no retries on a 401');
});

// The email is the promise; the site is the archive. A DNS failure reaching
// GitHub used to throw straight out of publishIssue and take the send with it.
test('a thrown network error is caught and reported, never propagated', async () => {
  const fetchImpl = async () => {
    throw new TypeError('network connection lost');
  };
  const res = await publishIssue({ issue, index: [], cfg, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 7);
  assert.match(res.errors[0], /network: network connection lost/);
  assert.match(res.errors[0], /after 3 attempts/);
});

test('no GitHub token means no publish, and no crash', async () => {
  const res = await publishIssue({ issue, index: [], cfg: config({}), fetchImpl: async () => new Response('', { status: 200 }) });
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, ['GITHUB_TOKEN is not set']);
});
