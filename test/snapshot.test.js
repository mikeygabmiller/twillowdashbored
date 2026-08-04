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
  check('every section included', d.included.sort(), ['bookings', 'emails', 'leads', 'messages', 'money', 'settings']);
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
  check('all six sections', d.included.length, 6);

  console.log(`\n${FAIL ? 'FAILED' : 'OK'} — ${PASS} passed, ${FAIL} failed\n`);
  process.exit(FAIL ? 1 : 0);
})();
