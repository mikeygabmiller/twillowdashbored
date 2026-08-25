// Snapshot-for-Claude export filtering. The whole point of the feature is that
// asking for "just my texts" produces a file with ONLY texts in it — so the
// tests here are mostly about what is ABSENT. apiSnapshot is module-private in
// the Worker, so it's lifted out of the source by name and evaluated with stubs
// (same trick as hold.test.js) rather than exported purely for tests.
//
//   node test/snapshot.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
const PARTS_DECL = SRC.match(/const SNAP_PARTS = \[[^\]]*\];/);
if (!PARTS_DECL) throw new Error('SNAP_PARTS not found in src/index.js');
// The screen table is lifted the same way. It names its handlers inside arrow
// bodies, so they only have to exist at call time — which is what lets the
// stubs below stand in for the real endpoints.
const SCREENS_DECL = SRC.match(/const SNAP_SCREENS = \{[\s\S]*?\n\};/);
if (!SCREENS_DECL) throw new Error('SNAP_SCREENS not found in src/index.js');
const SNAP_PART_COUNT = (PARTS_DECL[0].match(/'/g) || []).length / 2;

const now = Date.now();
const day = 86400000;
const dstr = (t) => new Date(t).toISOString().slice(0, 10);
const thisMonth = dstr(now).slice(0, 7);
const oldMonth = dstr(now - 400 * day).slice(0, 7);

// --- the fake account -------------------------------------------------------
const INDEX = [
  { phone: '+15551110000', name: 'Sarah Reed',  lastTs: now - 2 * day },
  { phone: '+15552220000', name: 'Dave Nguyen', lastTs: now - 10 * day },
  { phone: '+15553330000', name: 'Old Ghost',   lastTs: now - 300 * day },
];
const THREADS = {
  '+15551110000': { phone: '+15551110000', name: 'Sarah Reed', notes: 'blue CRV', messages: [
    { id: 'a1', dir: 'in',  body: 'old hello',   ts: now - 200 * day },
    { id: 'a2', dir: 'in',  body: 'how much?',   ts: now - 2 * day },
    { id: 'a3', dir: 'out', body: '$240 total',  ts: now - 2 * day + 1000 },
  ] },
  '+15552220000': { phone: '+15552220000', name: 'Dave Nguyen', messages: [
    { id: 'b1', dir: 'in', body: 'tuesday works', ts: now - 10 * day },
  ] },
  '+15553330000': { phone: '+15553330000', name: 'Old Ghost', messages: [
    { id: 'c1', dir: 'in', body: 'ancient', ts: now - 300 * day },
  ] },
};
const MONTHS = {
  [thisMonth]: { entries: [
    { date: dstr(now - 3 * day), type: 'job',     amount: 240 },
    { date: dstr(now - 1 * day), type: 'expense', amount: 30 },
  ] },
  [oldMonth]: { entries: [{ date: dstr(now - 400 * day), type: 'job', amount: 180 }] },
};
const BOOKINGS = [
  { id: 'bk1', name: 'Sarah Reed', apptAt: now + 2 * day, createdAt: now - 1 * day },
  { id: 'bk2', name: 'Long Gone',  apptAt: now - 200 * day, createdAt: now - 210 * day },
];
const EMAILS = [
  { id: 'e1', subject: 'New lead', ts: now - 5 * day },
  { id: 'e2', subject: 'Ancient',  ts: now - 300 * day },
];
const CONFIG = { bizName: "Mikey's", emailToken: 'ek_supersecret', playbook: { services: ['full detail'] } };

function kvStub() {
  return {
    list: async ({ prefix }) => ({ keys: Object.keys(MONTHS).map((m) => ({ name: prefix + m })) }),
    get: async (name) => {
      if (name.startsWith('money:m:')) return MONTHS[name.replace('money:m:', '')] || null;
      if (name === 'emails') return EMAILS;
      if (name === 'templates') return [['Hi', 'hello there']];
      return null;
    },
  };
}
const snapshot = new Function(`${PARTS_DECL[0]}
   ${SCREENS_DECL[0]}
   ${lift('apiSnapshot')}
   return apiSnapshot;`);
// The lifted body closes over these names; supply them as globals for the call.
const g = globalThis;
g.BUILD = 'test-build';
g.json = (o) => o;
g.kv = kvStub;
g.loadIndex = async () => JSON.parse(JSON.stringify(INDEX));
g.loadThread = async (phone) => JSON.parse(JSON.stringify(THREADS[phone] || { phone, messages: [] }));
g.loadBookings = async () => JSON.parse(JSON.stringify(BOOKINGS));
g.loadConfig = async () => JSON.parse(JSON.stringify(CONFIG));
g.loadMoneyConfig = async () => ({ split: { costs: 30, you: 50, savings: 20 } });
g.loadBookingConfig = async () => ({ services: [{ id: 's1', name: 'Full detail' }] });

// --- the other screens, stubbed at the same seam the real ones sit on --------
// Each records the query string it was handed, so the tests can prove the ?days=
// window actually reaches the screens that can narrow themselves.
const SEEN = {};
const screen = (name, body) => async (u) => {
  SEEN[name] = u.search.replace(/^\?/, '');
  return { json: async () => Object.assign({ ok: true }, body) };
};
g.apiQuotes     = screen('quotes',    { months: [{ month: '2026-08', count: 2 }], entries: [{ id: 'q1', total: 240 }] });
g.apiFollowups  = screen('followups', { followups: [{ phone: '+15551110000', due: 'today' }] });
g.apiPromises   = screen('promises',  { promises: [{ id: 'p1', what: 'send photos' }] });
g.apiCold       = screen('cold',      { cold: [{ phone: '+15553330000', days: 300 }] });
g.apiGarage     = screen('garage',    { rows: [{ phone: '+15551110000', veh: 'blue CRV' }] });
g.apiAnalytics  = screen('analytics', { days: [{ date: '2026-08-24', views: 12 }] });
g.apiJourneys   = screen('journeys',  { journeys: [{ vid: 'v1', pages: 4 }] });
g.apiGeogrid    = screen('geogrid',   { grids: [{ term: 'detailing near me' }] });
g.apiAiUsage    = screen('aiusage',   { total: { calls: 40 }, apiKey: 'sk_should_be_hidden' });
g.apiRulesGet   = screen('rules',     { rules: [{ id: 'r1', when: 'quote' }] });
g.apiVoiceStats = screen('voice',     { pairs: 120 });
g.apiInsights   = screen('insights',  { replyMinutes: 8 });
g.apiPricing    = screen('pricing',   { months: [{ month: '2026-08', avg: 240 }] });
g.apiDetections = screen('detect',    { found: [] });

const apiSnapshot = snapshot();

const run = (qs) => apiSnapshot(new URL('https://x.test/api/snapshot' + (qs ? '?' + qs : '')));

let PASS = 0, FAIL = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${ok ? '' : `\n     got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

(async () => {
  console.log('\n=== no params still means everything (old links keep working) ===');
  let d = await run('');
  check('every section included', d.included.sort(), ['ai', 'bookings', 'emails', 'followups', 'leads', 'messages', 'money', 'quotes', 'settings', 'trends', 'website', 'work']);
  check('conversations present', d.conversations.length, 3);
  check('leads present', d.leadsAndChats.length, 3);
  check('money present', d.money.length, 2);
  check('settings present', !!d.config && !!d.moneyConfig && !!d.bookingConfig, true);
  check('secrets scrubbed', d.config.emailToken, '[hidden]');

  console.log('\n=== "just my texts" — nothing else in the file ===');
  d = await run('parts=messages');
  check('conversations there', d.conversations.length, 3);
  check('no leads list', 'leadsAndChats' in d, false);
  check('no money', 'money' in d, false);
  check('no bookings', 'bookings' in d, false);
  check('no emails', 'emails' in d, false);
  check('no settings', 'config' in d, false);

  console.log('\n=== "just my money" ===');
  d = await run('parts=money');
  check('money there', d.money.length, 2);
  check('no conversations', 'conversations' in d, false);
  check('no leads list', 'leadsAndChats' in d, false);
  check('counts the entries', d.counts.moneyEntries, 3);

  console.log('\n=== how far back: days=30 ===');
  d = await run('parts=messages&days=30');
  check('the quiet 300-day chat is gone', d.conversations.map((c) => c.name), ['Sarah Reed', 'Dave Nguyen']);
  check('old texts inside a live chat are gone', d.conversations[0].messages.map((m) => m.id), ['a2', 'a3']);
  check('but the true total is still reported', d.conversations[0].msgTotal, 3);
  check('window recorded in the file', d.filters.days, 30);

  d = await run('parts=money&days=30');
  check('months that predate the window are dropped', d.money.map((m) => m.month), [thisMonth]);

  d = await run('parts=bookings,emails&days=30');
  check('only recent bookings', d.bookings.map((b) => b.id), ['bk1']);
  check('only recent emails', d.emails.map((e) => e.id), ['e1']);

  console.log('\n=== one person only ===');
  d = await run('parts=messages,leads&q=sarah');
  check('just her chat', d.conversations.map((c) => c.name), ['Sarah Reed']);
  check('and just her row', d.leadsAndChats.map((c) => c.name), ['Sarah Reed']);
  d = await run('parts=leads&q=5552220000');
  check('matches on number too', d.leadsAndChats.map((c) => c.name), ['Dave Nguyen']);

  console.log('\n=== how many texts per chat ===');
  d = await run('parts=messages&msgs=1');
  check('keeps the newest one', d.conversations[0].messages.map((m) => m.id), ['a3']);
  check('counts what was kept', d.counts.messages, 3);

  console.log('\n=== leads without the texts ===');
  d = await run('parts=leads');
  check('rows only', d.leadsAndChats.length, 3);
  check('no message bodies', 'conversations' in d, false);

  console.log('\n=== legacy ?messages=0 still drops the bodies ===');
  d = await run('messages=0');
  check('no conversations', 'conversations' in d, false);
  check('everything else survives', d.included.indexOf('money') >= 0 && d.included.indexOf('leads') >= 0, true);

  console.log('\n=== junk input falls back to everything, never to an empty file ===');
  d = await run('parts=banana');
  check('every section', d.included.length, SNAP_PART_COUNT);

  console.log('\n=== the rest of the screens ride along, read through their own endpoints ===');
  d = await run('');
  check('quotes', !!d.quotes, true);
  check('follow-ups, promises and who has gone quiet', [!!d.followUps, !!d.promises, !!d.goneQuiet], [true, true, true]);
  check('the garage', !!d.jobsAndCars, true);
  check('site visitors, their paths, the service area', [!!d.siteVisitors, !!d.whoWentWhere, !!d.serviceArea], [true, true, true]);
  check('the AI: spend, rules, voice training', [!!d.aiSpend, !!d.aiRules, !!d.voiceTraining], [true, true, true]);
  check('insights, price history, what changed', [!!d.insights, !!d.priceHistory, !!d.whatChanged], [true, true, true]);
  check("the endpoint's own ok flag is not left in the file", 'ok' in d.quotes, false);
  check('screens get scrubbed like everything else', d.aiSpend.apiKey, '[hidden]');
  check('and they are counted', d.counts.screens, 14);

  console.log('\n=== a screen you did not ask for is not in the file ===');
  d = await run('parts=messages');
  check('no quotes', 'quotes' in d, false);
  check('no garage', 'jobsAndCars' in d, false);
  check('no AI spend', 'aiSpend' in d, false);
  d = await run('parts=quotes');
  check('just the quotes', ['quotes' in d, 'conversations' in d, 'promises' in d], [true, false, false]);

  console.log('\n=== the window reaches the screens that can narrow themselves ===');
  await run('parts=quotes,website,ai&days=90');
  check('quotes asked in months', SEEN.quotes, 'months=3');
  check('visitors capped at the 60 days that endpoint allows', SEEN.analytics, 'days=60');
  check('AI spend capped at its 45', SEEN.aiusage, 'days=45');
  await run('parts=website&days=0');
  check('all time asks for no window at all', SEEN.analytics, '');

  console.log('\n=== one broken screen costs you that screen, not the whole file ===');
  const good = g.apiGarage;
  g.apiGarage = async () => { throw new Error('KV went away'); };
  d = await run('parts=work,quotes');
  check('the file still arrives', d.ok, true);
  check('the good screen is still in it', !!d.quotes, true);
  check('and the bad one is named', d.couldntRead.jobsAndCars, 'KV went away');
  g.apiGarage = async () => ({ json: async () => ({ ok: false, error: 'nope' }) });
  d = await run('parts=work');
  check("a screen that answers 'not ok' is named too", d.couldntRead.jobsAndCars, 'nope');
  check('and leaves nothing half-written behind', 'jobsAndCars' in d, false);
  g.apiGarage = good;

  console.log(`\n${FAIL ? 'FAILED' : 'OK'} — ${PASS} passed, ${FAIL} failed\n`);
  process.exit(FAIL ? 1 : 0);
})();
