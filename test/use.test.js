// Dashboard usage tracking. The feature only earns its place if three claims
// hold, so all three are pinned here:
//
//   1. It is CHEAP. A burst of taps has to cost one KV read and one write, not
//      one of each, or this becomes a bill instead of a report.
//   2. The dead list is REAL. "Never used" has to mean seen-on-screen-and-never
//      -pushed, not merely absent from the counts — otherwise every screen he
//      hasn't opened this month reads as dead and the list is worthless.
//   3. It never carries CONTENT. The export exists to be pasted into a chat,
//      and a customer's name must never be able to reach it.
//
// Same lifting trick as journey.test.js: the usage functions are private to the
// Worker, so they're pulled out of the source by name and run against a fake KV
// rather than exported purely for tests.
//
//   node test/use.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const re = new RegExp(`(async )?function ${name}\\(`);
  const m = re.exec(SRC);
  if (!m) throw new Error(`function ${name} not found in src/index.js`);
  const start = m.index;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
const constant = (decl) => {
  // The lookahead matters: USE_BUF and USE_BUF_MAX are both real, and a plain
  // prefix match lifts the wrong one (and then both, which won't parse).
  const m = SRC.match(new RegExp(`^(const|let) ${decl}(?![A-Za-z0-9_])[^\\n]*$`, 'm'));
  if (!m) throw new Error(`${decl} not found`);
  return m[0];
};

// --- fake KV, counting every call so the cost claims are testable ------------
const STORE = new Map();
const COUNT = { get: 0, put: 0 };
const KV = {
  async get(k, opt) {
    COUNT.get++;
    const row = STORE.get(k);
    if (!row) return null;
    return (opt && opt.type === 'json') ? JSON.parse(row.value) : row.value;
  },
  async put(k, v, opt) { COUNT.put++; STORE.set(k, { value: v, metadata: (opt && opt.metadata) || null }); },
  async list({ prefix }) {
    return { keys: [...STORE.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k })), list_complete: true };
  },
};

const ctx = {
  kv: () => KV,
  ENV: {},
  envFlag: (n) => { const v = String((ctx.ENV && ctx.ENV[n]) || '').toLowerCase(); return v === '1' || v === 'true'; },
  DAY_MS: 86400000,
  loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
  // The real ones go through Intl; the shapes are all this code cares about.
  localDateStr: (ts) => new Date(ts).toISOString().slice(0, 10),
  localHour: (ts) => new Date(ts).getUTCHours(),
  readJson: async (r) => r.__body || {},
  json: (o) => ({ __json: o }),
  geminiGenerate: async () => 'a read',
  Response: class { constructor(b, i) { this.body = b; this.status = (i || {}).status || 200; this.headers = (i || {}).headers; }
                    async text() { return this.body; } },
  URL,
};

const CODE = [
  constant('USE_TTL'), constant('USE_TAPE_PER_DAY'), constant('USE_TAPE_READ'),
  constant('USE_CATALOG_MAX'), constant('USE_CATALOG_STALE'),
  constant('USE_FLUSH_MS'), constant('USE_BUF_MAX'), constant('USE_BAIL_MS'),
  constant('useDayKey'), constant('USE_CATALOG_KEY'),
  constant('USE_BUF'), constant('USE_BUF_AT'), constant('USE_KINDS'),
  constant('useSortDesc'),
  lift('useLabel'), lift('useRoutePath'),
  lift('blankUseCatalog'), lift('useCatalogTouch'), lift('useCatalogTrim'),
  lift('blankUseDay'), lift('useApplyEvent'), lift('useFlush'),
  lift('noteApiUse'), lift('useBufDue'), lift('useTakeBuf'), lift('useMaybeFlush'),
  lift('apiUseIngest'), lift('useLoadDays'), lift('useGather'),
  lift('useDeadRows'), lift('useColdRows'), lift('useScreenRows'), lift('apiUse'),
  lift('useReadKind'), lift('useExportText'), lift('apiUseExport'), lift('apiUseAi'),
  constant('useDays'),
].join('\n\n');

const factory = new Function(...Object.keys(ctx), CODE + `
  return { useFlush, noteApiUse, useMaybeFlush, useBufDue, apiUseIngest, apiUse,
           apiUseExport, apiUseAi, useRoutePath, useLabel, useApplyEvent,
           blankUseDay, useCatalogTouch, useCatalogTrim, blankUseCatalog,
           bufLen: () => USE_BUF.length, USE_TAPE_PER_DAY, USE_CATALOG_MAX };`);
const U = factory(...Object.values(ctx));

// --- harness -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const reset = () => { COUNT.get = 0; COUNT.put = 0; };
const day = (ts) => JSON.parse(STORE.get('use:day:' + new Date(ts).toISOString().slice(0, 10)).value);
const cat = () => JSON.parse(STORE.get('use:catalog').value);
// The tape lives inside the day doc now — one KV write per flush, not two.
const tape = (ts) => day(ts || now).tape;

// Anchored to the clock, not to a date on the calendar. apiUseIngest deliberately
// rejects the phone's own timestamp when it is more than a day off the server's
// and files the event under "now" instead — so a hard-coded `now` here doesn't
// age gracefully, it turns half this suite red the day after it is written, for
// a reason that has nothing to do with the code under test. Three hours back on
// the half hour keeps a burst of events comfortably inside the gate's window and
// well clear of a midnight rollover, which would scatter one flush across two
// day docs and break the counts.
const now = (() => { const d = new Date(Date.now() - 3 * 3600000); d.setUTCMinutes(30, 0, 0); return d.getTime(); })();
const min = 60000;

// The app gets ~1,000 KV writes a DAY in total (see the budget warning at the
// top of src/index.js) and going over 429s everything until midnight. So the
// write count per flush is not a nicety here, it is the feature's licence to
// exist, and it is pinned hard.
section('A whole session of tapping costs ONE write');
reset();
await U.useFlush(Array.from({ length: 200 }, (_, i) => ({ t: now + i * 100, k: 't', l: 'Chats · Send' })), []);
ok('two hundred taps landed', day(now).f['Chats · Send'] === 200, day(now).f['Chats · Send']);
ok('the first flush writes the day doc and the catalog', COUNT.put === 2, COUNT.put);
reset();
await U.useFlush(Array.from({ length: 200 }, (_, i) => ({ t: now + i * 100, k: 't', l: 'Chats · Send' })), []);
ok('and every flush after that is ONE write, whatever the batch size', COUNT.put === 1, COUNT.put);
ok('the tape rode along inside the day doc rather than costing its own write',
  tape().length > 0 && !STORE.has('use:tape'), [...STORE.keys()]);

section('The catalog is only written when the dead list would read differently');
reset();
await U.useFlush([{ t: now, k: 't', l: 'Chats · Send' }], ['Chats · Send']);
ok('nothing new to say means no catalog write', COUNT.put === 1, COUNT.put);
reset();
await U.useFlush([{ t: now, k: 't', l: 'Chats · Send' }], ['Money · A brand new button']);
ok('a control seen for the first time is worth a write', COUNT.put === 2, COUNT.put);
reset();
await U.useFlush([{ t: now, k: 't', l: 'Money · A brand new button' }], []);
ok('so is one used for the first time — that is it leaving the dead list', COUNT.put === 2, COUNT.put);
reset();
await U.useFlush([{ t: now, k: 't', l: 'Money · A brand new button' }], []);
ok('the second use is just a counter, and pays for nothing', COUNT.put === 1, COUNT.put);

section('A flush that straddles midnight lands on both days, not one');
reset();
const midnight = Date.UTC(2026, 7, 26, 0, 0, 0);
await U.useFlush([
  { t: midnight - 5 * min, k: 't', l: 'Money · Log a job' },
  { t: midnight + 5 * min, k: 't', l: 'Money · Log a job' },
], []);
ok('the evening stayed on the 25th', day(midnight - 5 * min).f['Money · Log a job'] === 1);
ok('the small hours went to the 26th', day(midnight + 5 * min).f['Money · Log a job'] === 1);

section('Screens are measured by time on them, and by walking straight back out');
await U.useFlush([
  { t: now, k: 'v', l: 'Stats · usage' },
  { t: now + 30000, k: 'x', l: 'Stats · usage', d: 30000 },
  { t: now + 31000, k: 'v', l: 'Pipeline · garage' },
  { t: now + 32000, k: 'b', l: 'Pipeline · garage', d: 900 },
], []);
let d0 = day(now);
ok('an open is counted', d0.s['Stats · usage'] === 1, d0.s);
ok('so is the time actually spent on it', d0.ms['Stats · usage'] === 30000, d0.ms);
ok('a screen opened and abandoned is recorded as a bail', d0.b['Pipeline · garage'] === 1, d0.b);
ok('and a bail is NOT counted as time on the screen', !d0.ms['Pipeline · garage'], d0.ms);
// The hour comes off `now`, which moves with the clock — asserting a literal
// hour here is the same trap as asserting a literal date.
const nowHour = new Date(now).getUTCHours();
ok('the hour of the day is kept, so "when is he in here" is answerable', d0.h[nowHour] > 0, d0.h);

section('A screen-exit can never inflate the clock');
await U.useFlush([{ t: now, k: 'x', l: 'Bogus', d: 99 * 3600000 }], []);
ok('an absurd dwell is clamped to an hour', day(now).ms.Bogus === 3600000, day(now).ms.Bogus);
await U.useFlush([{ t: now, k: 'x', l: 'Bogus2', d: -5000 }], []);
ok('a negative one is floored at zero', day(now).ms.Bogus2 === 0, day(now).ms.Bogus2);

section('The dead list means SEEN and never pushed — not merely absent');
STORE.clear();
await U.useFlush(
  [{ t: now, k: 't', l: 'More · Sign out' }],
  ['More · Sign out', 'More · Send test alert', 'More · Snapshot for Claude'],
);
const c = cat();
ok('everything drawn on screen is in the catalog', Object.keys(c.keys).length === 3, Object.keys(c.keys));
ok('the one he pushed has a count', c.keys['More · Sign out'].n === 1, c.keys['More · Sign out']);
ok('the ones he only saw have zero', c.keys['More · Send test alert'].n === 0);
let r = (await U.apiUse(new URL('https://x/api/use?days=7'))).__json;
const deadKeys = r.dead.map((x) => x.key);
ok('so the dead list names exactly the two he never touched',
  deadKeys.length === 2 && deadKeys.includes('More · Send test alert') && deadKeys.includes('More · Snapshot for Claude'), deadKeys);
ok('and never the one he did', !deadKeys.includes('More · Sign out'), deadKeys);
ok('the totals agree with the list', r.totals.dead === 2 && r.totals.tracked === 3, r.totals);

section('Once used, it leaves the dead list for good');
await U.useFlush([{ t: now, k: 't', l: 'More · Send test alert' }], []);
r = (await U.apiUse(new URL('https://x/api/use?days=7'))).__json;
ok('a first push takes it off the list', !r.dead.map((x) => x.key).includes('More · Send test alert'), r.dead);

section('Something used once and then dropped is a different finding');
await U.useFlush([{ t: now - 60 * 86400000, k: 't', l: 'More · Playbook' }], []);
r = (await U.apiUse(new URL('https://x/api/use?days=7'))).__json;
const coldKeys = r.cold.map((x) => x.key);
ok('two months of silence reads as cold, not dead', coldKeys.includes('More · Playbook'), coldKeys);
ok('and it is NOT on the dead list, because it was used', !r.dead.map((x) => x.key).includes('More · Playbook'));

section('The gate counts server features without a single client call');
STORE.clear();
U.noteApiUse('/api/send', 'POST');
U.noteApiUse('/api/threads', 'GET');
U.noteApiUse('/api/threads', 'GET');
ok('three calls are buffered', U.bufLen() === 3, U.bufLen());
ok('and nothing has been written yet', !STORE.size, STORE.size);
await U.useMaybeFlush(true);
ok('the buffer empties on flush', U.bufLen() === 0, U.bufLen());
const dd = day(Date.now());
ok('a repeated route is counted, not duplicated', dd.api['/api/threads'] === 2, dd.api);
ok('a write route keeps its method, because POST /api/send is the feature', dd.api['POST /api/send'] === 1, dd.api);
ok('server calls never land in the taps map — they are a separate surface', !Object.keys(dd.f || {}).length, dd.f);

section('The tracker never counts itself');
U.noteApiUse('/api/use', 'POST');
U.noteApiUse('/api/use/export', 'GET');
ok('its own endpoints are ignored outright', U.bufLen() === 0, U.bufLen());

section('A route with an id in it is still one feature');
ok('a token path collapses', U.useRoutePath('/api/track/a1b2c3d4e5f6a7b8c9d0e1f2') === '/api/track/:id', U.useRoutePath('/api/track/a1b2c3d4e5f6a7b8c9d0e1f2'));
ok('so does a numeric one', U.useRoutePath('/api/month/12345') === '/api/month/:id');
ok('a plain route is left alone', U.useRoutePath('/api/threads') === '/api/threads');
ok('the query string is never part of the feature', U.useRoutePath('/api/thread?phone=%2B14255550123') === '/api/thread');

section('The browser batch is clamped, and can never forge a server count');
STORE.clear();
let res = await U.apiUseIngest({ __body: { e: [
  { t: now, k: 'a', l: '/api/send' },                        // the gate's alone
  { t: now, k: 'nonsense', l: 'whatever' },
  { t: now, k: 't', l: 'x'.repeat(400) },
  { t: now + 99 * 86400000, k: 't', l: 'Clock is wrong' },
], c: [] } });
ok('a client-claimed server call is dropped', !Object.keys(day(now).api || {}).length, day(now).api);
ok('an unknown kind is dropped', res.__json.n === 2, res.__json);
ok('a runaway label is clamped to 60', Object.keys(day(now).f).some((k) => k.length === 60), Object.keys(day(now).f).map((k) => k.length));
const wrongClock = Object.values(STORE.keys()).length;
ok('a phone whose clock is months out lands on today, not in the future',
  !STORE.has('use:day:' + new Date(now + 99 * 86400000).toISOString().slice(0, 10)), [...STORE.keys()]);

section('One request writes both halves — the beacon pays for the gate too');
STORE.clear();
// Warm the catalog first: a control's first-ever sighting legitimately costs a
// write of its own, and that would mask what this section is measuring.
await U.useFlush([{ t: now, k: 't', l: 'Today · Refresh' }, { t: now, k: 'a', l: '/api/day' }], []);
U.noteApiUse('/api/day', 'GET');
reset();
await U.apiUseIngest({ __body: { e: [{ t: now, k: 't', l: 'Today · Refresh' }], c: [] } });
ok('the buffered server call rode along', day(now).api['/api/day'] === 2, day(now).api);
ok('and the tap landed in the same doc', day(now).f['Today · Refresh'] === 2, day(now).f);
ok('for one write, not one for each half', COUNT.put === 1, COUNT.put);

section('The tape keeps the order, because the order is where the shortcut is');
STORE.clear();
await U.useFlush([
  { t: now + 3000, k: 't', l: 'Chats · Send' },
  { t: now + 1000, k: 'v', l: 'Tab · Chats' },
  { t: now + 5000, k: 'v', l: 'Screen · money' },
  { t: now + 4000, k: 'x', l: 'Tab · Chats', d: 3000 },
], []);
const steps = tape().map((s) => s.l);
ok('it is sorted by time even when the batch was not',
  JSON.stringify(steps) === JSON.stringify(['Tab · Chats', 'Chats · Send', 'Screen · money']), steps);
ok('bookkeeping events stay off it', tape().length === 3, tape());
let read = (await U.apiUse(new URL('https://x/api/use?days=7'))).__json;
ok('reading it back costs no extra fetch — it came out of the day docs',
  read.tape.length === 3 && read.tape[0].l === 'Screen · money', read.tape);

section('Nothing can grow forever');
STORE.clear();
await U.useFlush(Array.from({ length: U.USE_TAPE_PER_DAY + 120 }, (_, i) => ({ t: now + i, k: 't', l: 'Tap ' + i })), []);
ok('the tape is capped per day', tape().length === U.USE_TAPE_PER_DAY, tape().length);
ok('and it keeps the NEWEST, not the oldest', tape()[tape().length - 1].l === 'Tap ' + (U.USE_TAPE_PER_DAY + 119));
const big = U.blankUseCatalog();
for (let i = 0; i < U.USE_CATALOG_MAX + 200; i++) U.useCatalogTouch(big, 'seen ' + i, 't', now + i, false);
U.useCatalogTouch(big, 'actually used', 't', now, true);
U.useCatalogTrim(big);
ok('the catalog is capped too', Object.keys(big.keys).length <= U.USE_CATALOG_MAX, Object.keys(big.keys).length);
ok('and something actually used is never the thing dropped', !!big.keys['actually used']);

section('Nothing a customer said can reach the export');
STORE.clear();
await U.useFlush([
  { t: now, k: 't', l: 'Chats · Send' },
  { t: now, k: 'v', l: 'Screen · thread' },
], ['Chats · Send']);
U.noteApiUse('/api/send', 'POST');
await U.useMaybeFlush(true);
const txt = await (await U.apiUseExport(new URL('https://x/api/use/export?days=7'))).text();
ok('the export is plain text a person can read', /DASHBOARD USAGE/.test(txt));
ok('it says what he pushes', /Chats · Send/.test(txt), txt.slice(0, 200));
ok('it lists the server features', /\/api\/send/.test(txt));
ok('it has a never-used section even when empty', /NEVER ONCE USED/.test(txt));
ok('and the order of his last moves', /THE LAST FEW MOVES/.test(txt));
ok('no phone number is anywhere in it', !/\+?1?\d{10}/.test(txt.replace(/20\d\d-\d\d-\d\d/g, '')), (txt.match(/\+?1?\d{10}/) || [])[0]);
ok('it says out loud that it is safe to paste', /never content/i.test(txt) || /identifies a customer/i.test(txt));

section('The AI read refuses to invent a story out of nothing');
STORE.clear();
ctx.ENV.GEMINI_API_KEY = '';
let ai = await U.apiUseAi({ __body: {} });
ok('no key is an honest 503, not a fake answer', ai.__json.error === 'ai_not_configured', ai.__json);
ctx.ENV.GEMINI_API_KEY = 'k';
ai = await U.apiUseAi({ __body: { days: 30 } });
ok('an empty record reads as empty rather than a hallucination', ai.__json.ok === true && ai.__json.empty === true, ai.__json);
await U.useFlush([{ t: now, k: 't', l: 'Money · Log a job' }], []);
ai = await U.apiUseAi({ __body: { days: 30 } });
ok('with something recorded, it answers', ai.__json.ok === true && ai.__json.read === 'a read', ai.__json);

section('The kill switch works with the write budget already blown');
STORE.clear();
ctx.ENV.USAGE_OFF = '1';
U.noteApiUse('/api/send', 'POST');
ok('the gate stops buffering', U.bufLen() === 0, U.bufLen());
await U.useFlush([{ t: now, k: 't', l: 'Chats · Send' }], ['Chats · Send']);
ok('and nothing is written at all — which is the point, it is a var not a KV flag',
  STORE.size === 0, [...STORE.keys()]);
let off = await U.apiUseIngest({ __body: { e: [{ t: now, k: 't', l: 'Chats · Send' }], c: [] } });
ok('the browser is told to stop too, rather than posting into a bin', off.__json.off === true, off.__json);
ctx.ENV.USAGE_OFF = '';
await U.useFlush([{ t: now, k: 't', l: 'Chats · Send' }], []);
ok('unsetting it resumes', day(now).f['Chats · Send'] === 1, day(now).f);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
