// Word of mouth — who sent them.
//
// The feature is one claim: when a new lead says who sent them, the app notices,
// asks, and remembers, and then shows Mikey who sends him business in dollars.
// Most of what can go wrong is the noticing. A detector that fires on "I'll
// recommend you to my friends" or "Google recommended you" puts a false question
// in front of him; one that fires on an old customer's fortieth text is noise.
// So the reading is tested against real-shaped texts first, then the store,
// then the numbers, then the guards (nobody refers themselves, no loops, and
// nothing here ever sends a text).
//
//   node test/referral.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['referralFromText', 'noteReferral', 'referralThanks', 'buildReferrals', 'apiReferrals',
  'apiReferralAction', 'appendMessage', 'loadThread', 'saveThread', 'updateIndexEntry', 'loadIndex',
  'loadConfig', 'loadMonth', 'saveMonth', 'REF_READ_FIRST'];

const store = new Map();
let sends = 0;
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
// Any network call at all is a text or an alert leaving the building. Count them.
globalThis.fetch = async (u) => { sends++; return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) }; };

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1', PROMISE_DISABLED: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b, method: 'POST' });
const call = async (b) => (await M.apiReferralAction(req(b))).json();

const DAY = 86400000;
const NOW = Date.now();
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);
async function reset() { store.clear(); sends = 0; M.__resetCfg(); }
async function customer(phone, name, opts = {}) {
  const t = await M.loadThread(phone);
  t.name = name; t.status = opts.status || 'active';
  t.messages = [{ id: 'm' + phone, dir: 'in', body: 'hi', ts: NOW - 5 * DAY }];
  await M.saveThread(t); await M.updateIndexEntry(t);
  return t;
}
async function job(phone, amount, daysAgo = 10) {
  const ts = NOW - daysAgo * DAY, m = dateOf(ts).slice(0, 7);
  const doc = await M.loadMonth(m);
  doc.entries.push({ id: 'e' + Math.random().toString(36).slice(2), type: 'job', phone, amount, date: dateOf(ts), ts });
  await M.saveMonth(m, doc);
}

// ================================================================ reading
section('Reading who sent them out of a text');
const R = M.referralFromText;
const said = [
  ['Hi, Dave told me about you', 'Dave', ''],
  ['hey my buddy dave recommended you, need a full detail', 'Dave', 'buddy'],
  ['referred by my coworker Jenna', 'Jenna', 'coworker'],
  ['got your number from Sarah! looking for interior', 'Sarah', ''],
  ['my neighbor recommended you', '', 'neighbor'],
  ['a friend gave me your number', '', 'friend'],
  ['you did my neighbours truck last week and it looked great', '', 'neighbor'],
];
for (const [text, name, rel] of said) {
  const got = R(text);
  ok(`"${text}" → ${name || '(no name)'}${rel ? ' / ' + rel : ''}`, got && got.name === name && got.rel === rel, got);
}
ok('the line they said is kept to show back', R('Hi, Dave told me about you').line === 'Hi, Dave told me about you');

const notSaid = [
  'Google recommended you',
  'someone recommended you',
  'I found your number from Nextdoor',
  "I'll recommend you to my friends",
  'my wife said you were great',
  'can you come saturday',
  'thanks for recommending the coating',
  'saw your ad on facebook',
];
for (const text of notSaid) ok(`"${text}" → nothing`, R(text) === null, R(text));

// ================================================================ storing
section('Only a new lead\'s first texts are read, and only as a question');
await reset();
await M.appendMessage('+14255550101', { dir: 'in', body: 'Hi! Jenna told me about you, do you do ceramic?' });
let t = await M.loadThread('+14255550101');
ok('the guess lands on the thread', t.refGuess && t.refGuess.name === 'Jenna', t.refGuess);
ok('…and is NOT treated as an answer', !t.referredBy);
let idx = (await M.loadIndex()).find((r) => r.phone === '+14255550101');
ok('the list row carries the guess', idx.refGuess === 'Jenna' && /Jenna told me/.test(idx.refGuessLine), idx);

await reset();
const OLD = '+14255550102';
for (let i = 0; i < M.REF_READ_FIRST; i++) await M.appendMessage(OLD, { dir: 'in', body: 'text ' + i });
await M.appendMessage(OLD, { dir: 'in', body: 'my buddy Dave recommended you years ago lol' });
ok(`text number ${M.REF_READ_FIRST + 1} is not read for it`, !(await M.loadThread(OLD)).refGuess);

await reset();
await M.appendMessage('+14255550103', { dir: 'out', body: 'Did somebody send you my way?' });
await M.appendMessage('+14255550103', { dir: 'in', body: 'a friend gave me your number' });
t = await M.loadThread('+14255550103');
ok('a relation with no name still asks', t.refGuess && t.refGuess.rel === 'friend' && t.refGuess.name === '', t.refGuess);
idx = (await M.loadIndex()).find((r) => r.phone === '+14255550103');
ok('…and the row says so without a name', idx.refGuess === 'friend', idx.refGuess);

// ================================================================ answering
section('Answering the question');
await reset();
const DAVE = '+14255550201', NEW = '+14255550202', NEW2 = '+14255550203';
await customer(DAVE, 'Dave Park', { status: 'won' });
await M.appendMessage(NEW, { dir: 'in', body: 'Dave told me about you! need a full detail' });
let r = await call({ phone: NEW, action: 'set', by: DAVE });
ok('set saves who sent them', r.ok && r.thread.referredBy.phone === DAVE && r.thread.referredBy.name === 'Dave Park', r);
ok('…clears the question', !r.thread.refGuess);
ok('…and remembers it came from what they said', r.thread.referredBy.how === 'said');
idx = (await M.loadIndex()).find((x) => x.phone === NEW);
ok('the list row carries who sent them', idx.refBy === DAVE && idx.refByName === 'Dave Park' && !idx.refGuess, idx);

r = await call({ phone: DAVE, action: 'set', by: DAVE });
ok('nobody refers themselves', !r.ok && r.error === 'self', r);
r = await call({ phone: DAVE, action: 'set', by: NEW });
ok('two people can\'t have sent each other', !r.ok && r.error === 'loop', r);

await M.appendMessage(NEW2, { dir: 'in', body: 'my neighbor recommended you' });
r = await call({ phone: NEW2, action: 'no' });
ok('"not a referral" drops the question', r.ok && !r.thread.refGuess && r.thread.refNo === true, r.thread);
await M.appendMessage(NEW2, { dir: 'in', body: 'oh and Dave told me about you too' });
ok('…and it is never asked again', !(await M.loadThread(NEW2)).refGuess);

// ================================================================ the numbers
section('Who sends him business, in dollars');
await reset();
const SAM = '+14255550301', A = '+14255550302', B = '+14255550303', C = '+14255550304', LONE = '+14255550305';
await customer(DAVE, 'Dave Park', { status: 'won' });
await customer(SAM, 'Sam Ortiz', { status: 'won' });
await customer(A, 'Ana Lee'); await customer(B, 'Ben Cho'); await customer(C, 'Cara Diaz'); await customer(LONE, 'Lone Wolf');
await job(A, 240); await job(A, 280, 40); await job(B, 199); await job(LONE, 300); await job(DAVE, 250, 100);
await call({ phone: A, action: 'set', by: SAM });
await call({ phone: B, action: 'set', by: DAVE });
await call({ phone: C, action: 'set', by: DAVE });
let rep = await M.buildReferrals(await M.loadConfig());
ok('two referrers', rep.referrers.length === 2, rep.referrers.map((x) => x.name));
ok('ranked by dollars, not by head count: Sam\'s one regular beats Dave\'s two', rep.referrers[0].phone === SAM, rep.referrers.map((x) => [x.name, x.dollars]));
ok('Sam: 1 sent, $520 paid', rep.referrers[0].people.length === 1 && rep.referrers[0].dollars === 520, rep.referrers[0]);
ok('Dave: 2 sent, $199 paid', rep.referrers[1].people.length === 2 && rep.referrers[1].dollars === 199, rep.referrers[1]);
ok('totals: 3 people, $719', rep.totals.people === 3 && rep.totals.dollars === 719, rep.totals);
ok('paying customers: 2 of 4 came from somebody', rep.totals.paying === 4 && rep.totals.payingReferred === 2, rep.totals);
ok('everyone starts un-thanked', rep.totals.unthanked === 3, rep.totals);

section('The thank-you');
const dave = rep.referrers[1];
ok('one text names everyone they sent', /Dave/.test(dave.draft) && /Ben and Cara/.test(dave.draft), dave.draft);
ok('no reward is offered unless he wrote one', !/\$|off/.test(dave.draft), dave.draft);
ok('no em dash in it', !/—/.test(dave.draft), dave.draft);
r = await call({ action: 'reward', reward: 'Your next detail is $20 off, on me.' });
ok('his reward sentence goes on the end', r.ok && /\$20 off, on me\.$/.test(r.referrers[1].draft), r.referrers && r.referrers[1].draft);

r = await call({ action: 'thanked', by: DAVE });
const dv = r.referrers.find((x) => x.phone === DAVE);
ok('thanked stamps every one Dave sent', dv.unthanked === 0 && dv.people.every((p) => p.thankedAt > 0), dv);
ok('…and the thank-you goes quiet', !dv.draft);
ok('Sam still owed one', r.referrers.find((x) => x.phone === SAM).unthanked === 1);

await call({ phone: C, action: 'set', by: SAM });
rep = await M.buildReferrals(await M.loadConfig());
ok('moving Cara to Sam is a new person to thank', rep.referrers.find((x) => x.phone === SAM).unthanked === 2, rep.referrers);

await call({ phone: B, action: 'clear' });
rep = await M.buildReferrals(await M.loadConfig());
ok('"Nobody" takes Ben off Dave\'s list', !rep.referrers.find((x) => x.phone === DAVE), rep.referrers.map((x) => x.name));

section('Guesses waiting on him');
await M.appendMessage('+14255550399', { dir: 'in', body: 'Sam gave me your number' });
rep = await M.buildReferrals(await M.loadConfig());
ok('an unanswered guess is listed', rep.guesses.length === 1 && rep.guesses[0].guess === 'Sam', rep.guesses);

section('Nothing here texts anybody');
ok('no network call was made by any of it', sends === 0, sends);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
