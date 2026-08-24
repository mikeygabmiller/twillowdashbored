// CPU budget: the second free-tier limit, and the one that actually fired.
//
// Cloudflare caps CPU at ~10ms PER INVOCATION and kills anything that runs over
// mid-task — a dropped alert, a follow-up that never fires. The KV WRITE BUDGET
// box in src/index.js guards a different limit (writes/day) and explicitly says
// "reads are far cheaper", which is true of the quota and false of CPU: a
// `{type:'json'}` read parses the whole doc on our clock.
//
// The index is the biggest doc we own and the minute cron used to load it in four
// separate sub-jobs, so every tick paid for four full parses of every
// conversation. This suite is the thing that stops that coming back.
//
//   node test/cpu.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit suites — the Worker's functions are module-private,
// so they're pulled out by name rather than exported purely for tests.
function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) throw new Error(`could not find body of ${name}`);
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
function liftDecl(name) {
  const m = SRC.match(new RegExp(`^(?:const|let) ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`declaration ${name} not found in src/index.js`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// KV as a plain Map that counts reads — the whole claim here is about reads, and
// specifically about how many times we pay to parse the index.
function world(seed = {}) {
  const store = new Map();
  const w = { store, written: [], read: [] };
  for (const k of Object.keys(seed)) store.set(k, JSON.stringify(seed[k]));
  w.deps = {
    kv: () => ({
      get: async (k, opt) => {
        w.read.push(k);
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.written.push(k); store.set(k, v); },
    }),
  };
  return w;
}

const NAMES = ['kv'];
const BODY =
  liftDecl('INDEX_KEY') + '\n' +
  'let IDX_CACHE = null;\n' +
  lift('loadIndex') + '\n' + lift('saveIndex') + '\n' +
  lift('applyIndexSummary') + '\n' +
  'return { loadIndex, saveIndex, applyIndexSummary, newInvocation: () => { IDX_CACHE = null; } };';
// Each build() is a fresh isolate; newInvocation() is what the fetch/scheduled
// entry points do at the top of every request and every tick.
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

const IDX = [
  { phone: '+15551110000', name: 'Dave', lastTs: 300, status: 'active' },
  { phone: '+15552220000', name: 'Ruth', lastTs: 100, status: 'won' },
  { phone: '+15553330000', name: 'Sabine', lastTs: 200, status: 'new' },
];
const seeded = () => world({ 'threads-index': IDX });

console.log('\n=== one tick pays for the index once ===');
{
  const w = seeded(); const M = build(w);
  // Standing in for a cron tick: dispatchDueScheduled, dispatchDueReminders,
  // dispatchDuePromises and evaluateFollowups each ask for the index.
  await M.loadIndex(); await M.loadIndex(); await M.loadIndex(); await M.loadIndex();
  check('four callers, one read', w.read.filter((k) => k === 'threads-index').length, 1);
  check('and no writes for reading', w.written.length, 0);
}

console.log('\n=== every caller still gets its own array ===');
{
  const w = seeded(); const M = build(w);
  const a = await M.loadIndex();
  a.sort((x, y) => (y.lastTs || 0) - (x.lastTs || 0));   // apiSnapshot does exactly this
  const b = await M.loadIndex();
  check('sorting one copy does not reorder the next',
    b.map((t) => t.name), ['Dave', 'Ruth', 'Sabine']);

  const c = await M.loadIndex();
  M.applyIndexSummary(c, { phone: '+15552220000', name: 'Ruth', lastTs: 999, status: 'lost' });
  const d = await M.loadIndex();
  check('an unsaved entry swap does not leak',
    d.find((t) => t.phone === '+15552220000').status, 'won');
  check('and the array length is untouched', d.length, 3);
}

console.log('\n=== a save is visible to the rest of the tick ===');
{
  // KV is eventually consistent, so a sub-job re-reading after another sub-job's
  // write could get the version from BEFORE it and undo it on its own save.
  const w = seeded(); const M = build(w);
  const a = await M.loadIndex();
  M.applyIndexSummary(a, { phone: '+15551110000', name: 'Dave', lastTs: 500, status: 'won' });
  await M.saveIndex(a);
  const readsAfterSave = w.read.filter((k) => k === 'threads-index').length;

  const b = await M.loadIndex();
  check('the later caller sees the write',
    b.find((t) => t.phone === '+15551110000').status, 'won');
  check('without going back to KV for it',
    w.read.filter((k) => k === 'threads-index').length, readsAfterSave);
  check('exactly one index write', w.written.filter((k) => k === 'threads-index').length, 1);
}

console.log('\n=== a new invocation starts clean ===');
{
  const w = seeded(); const M = build(w);
  await M.loadIndex();
  M.newInvocation();                       // next request / next cron tick
  const b = await M.loadIndex();
  check('it re-reads rather than serving a stale tick',
    w.read.filter((k) => k === 'threads-index').length, 2);
  check('and gets what KV actually holds', b.map((t) => t.name), ['Dave', 'Ruth', 'Sabine']);

  const fresh = build(w);                  // a cold isolate
  await fresh.loadIndex();
  check('a cold isolate reads too', w.read.filter((k) => k === 'threads-index').length, 3);
}

console.log('\n=== an empty index is still cached ===');
{
  const w = world(); const M = build(w);   // nothing in KV at all
  const a = await M.loadIndex();
  const b = await M.loadIndex();
  check('it reads as empty', a, []);
  check('and does not re-read on every miss', w.read.filter((k) => k === 'threads-index').length, 1);
  check('the empty copies are separate objects', a === b, false);
}

// ---------------------------------------------------------------------------
// Timezone formatters — the other per-item CPU cost.
// ---------------------------------------------------------------------------
const TZBODY =
  liftDecl('TZFMT') + '\n' + lift('tzFmt') + '\n' +
  lift('localDateStr') + '\n' + lift('localDow') + '\n' + lift('localHour') + '\n' +
  'return { tzFmt, localDateStr, localDow, localHour, TZFMT };';
// eslint-disable-next-line no-new-func
const TZ = new Function(TZBODY)();

console.log('\n=== the clock still reads the same ===');
{
  const PT = 'America/Los_Angeles';
  // 2026-08-24T02:30:00Z = 7:30pm on the 23rd in Snohomish. The date has to be
  // his, not UTC's — that is the whole reason these helpers exist.
  const evening = Date.parse('2026-08-24T02:30:00Z');
  check('the local date is yesterday, not UTC today', TZ.localDateStr(evening, PT), '2026-08-23');
  check('the local hour is 7pm',                      TZ.localHour(evening, PT), 19);
  check('the local weekday is Sunday',                TZ.localDow(evening, PT), 0);

  const midday = Date.parse('2026-08-24T19:00:00Z');
  check('midday date',    TZ.localDateStr(midday, PT), '2026-08-24');
  check('midday hour',    TZ.localHour(midday, PT), 12);
  check('midday weekday', TZ.localDow(midday, PT), 1);

  // Matches what the old bare toLocale* calls produced, for every helper.
  check('date matches toLocaleDateString',
    TZ.localDateStr(evening, PT), new Date(evening).toLocaleDateString('en-CA', { timeZone: PT }));
  check('weekday matches toLocaleDateString',
    TZ.localDow(evening, PT),
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .indexOf(new Date(evening).toLocaleDateString('en-US', { timeZone: PT, weekday: 'short' }).slice(0, 3)));
  check('hour matches toLocaleString',
    TZ.localHour(evening, PT),
    parseInt(new Date(evening).toLocaleString('en-US', { timeZone: PT, hour12: false, hour: '2-digit' }), 10) % 24);

  check('midnight does not come back as 24',
    TZ.localHour(Date.parse('2026-08-24T07:30:00Z'), PT), 0);
  check('a missing timezone falls back to his',
    TZ.localDateStr(midday, ''), TZ.localDateStr(midday, PT));
}

console.log('\n=== the formatter is built once, not per call ===');
{
  TZ.TZFMT.clear();
  const PT = 'America/Los_Angeles';
  for (let i = 0; i < 500; i++) TZ.localDateStr(Date.parse('2026-08-24T19:00:00Z') + i * 86400000, PT);
  check('500 dates share one formatter', TZ.TZFMT.size, 1);

  for (let i = 0; i < 50; i++) { TZ.localHour(i * 3600000, PT); TZ.localDow(i * 86400000, PT); }
  check('one per kind, still not per call', TZ.TZFMT.size, 3);

  TZ.localDateStr(0, 'America/New_York');
  check('a second timezone gets its own', TZ.TZFMT.size, 4);
  check('and it is actually a different clock',
    TZ.localDateStr(Date.parse('2026-08-24T04:00:00Z'), 'America/New_York'), '2026-08-24');
  check('vs his',
    TZ.localDateStr(Date.parse('2026-08-24T04:00:00Z'), PT), '2026-08-23');

  // A junk timezone must not throw, and must not cost a failed construction on
  // every call either — the miss is remembered like any other.
  const before = TZ.TZFMT.size;
  check('a bad timezone falls back to ISO', TZ.localDateStr(Date.parse('2026-08-24T19:00:00Z'), 'Not/AZone'), '2026-08-24');
  check('the failure is remembered once', TZ.TZFMT.size, before + 1);
  for (let i = 0; i < 20; i++) TZ.localDateStr(0, 'Not/AZone');
  check('and not retried per call', TZ.TZFMT.size, before + 1);
  check('the other helpers fall back too', [
    TZ.localHour(Date.parse('2026-08-24T19:00:00Z'), 'Not/AZone'),
    TZ.localDow(Date.parse('2026-08-24T19:00:00Z'), 'Not/AZone'),
  ], [19, 1]);

  // The old helpers wrapped the whole conversion in try/catch, so a missing
  // dependency came back as a believable UTC date rather than a crash. That is
  // what put a promise on the wrong day and passed CI anyway.
  check('no blanket catch left in the date helpers',
    /function localDateStr[\s\S]*?\n\}/.exec(SRC)[0].includes('catch'), false);
  check('nor in the weekday helper',
    /function localDow[\s\S]*?\n\}/.exec(SRC)[0].includes('catch'), false);
  check('nor in the hour helper',
    /function localHour[\s\S]*?\n\}/.exec(SRC)[0].includes('catch'), false);
}

console.log('\n=== the rules say so, so the next change knows ===');
{
  check('the CPU limit is written down',    /CPU TIME — A SEPARATE LIMIT/.test(SRC), true);
  check('it says the limit is per-invocation', /PER INVOCATION/.test(SRC), true);
  check('it corrects the "reads are cheap" line',
    /true of the\s+\*\s*\|\s*daily QUOTA and FALSE of CPU/.test(SRC.replace(/\s+/g, ' ')) ||
    /daily QUOTA and FALSE of CPU/.test(SRC), true);
  check('loadIndex is memoized',            /if \(!IDX_CACHE\) IDX_CACHE =/.test(SRC), true);
  check('saveIndex refreshes the cache',    /IDX_CACHE = index\.slice\(\)/.test(SRC), true);
  check('one place frees every per-invocation cache',
    /function resetInvocationCaches\(\) \{ CFG_CACHE = null; IDX_CACHE = null; \}/.test(SRC), true);
  check('both entry points call it',
    (SRC.match(/ENV = env; resetInvocationCaches\(\);/g) || []).length, 2);
  check('no bare toLocale with a timeZone in the local helpers',
    /function localDateStr[\s\S]{0,240}toLocaleDateString/.test(SRC), false);
  check('build fingerprints match',
    (SRC.match(/^const BUILD = '(.+)';$/m) || [])[1],
    (fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').match(/var APP_BUILD="(.+)";/) || [])[1]);
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
