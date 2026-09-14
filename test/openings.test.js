// "What's open?" — the booking calendar, answered inside a conversation.
//
// The rule this endpoint exists to keep: it must give the SAME answer the public
// booking page gives. Two sources of truth for "when am I free" is how you
// double-book yourself, so everything here is really one question — does
// /api/openings agree with bkAvailability, including the days it refuses?
//
//   node test/openings.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['apiOpenings', 'bkAvailability', 'loadBookingConfig', 'saveBookingConfig',
  'loadBookings', 'saveBookings', 'localDateStr', 'loadConfig'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no' });

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const call = async (qs) => (await M.apiOpenings(new URL('https://x.test/api/openings' + (qs || '')))).json();

// The calendar as it ships, with every day a work day so the test is about the
// endpoint and not about which days happen to be off in the defaults.
const cfg = await M.loadBookingConfig();
cfg.workDays = [0, 1, 2, 3, 4, 5, 6];
cfg.blockedDates = [];
await M.saveBookingConfig(cfg);
M.__reset();

const today = M.localDateStr(Date.now(), (await M.loadConfig()).tz);

section('It answers with real days, in order, and stops when it has enough');
let r = await call('?want=3');
ok('ok', r.ok === true, r);
ok('at most the number asked for', r.days.length <= 3, r.days.length);
ok('every day it names has room', r.days.every((d) => d.slots.length > 0), r.days);
ok('days come back in date order', r.days.every((d, i) => i === 0 || d.date > r.days[i - 1].date), r.days.map((d) => d.date));
ok('never more than four times on a day', r.days.every((d) => d.slots.length <= 4), r.days);
ok('nothing in the past', r.days.every((d) => d.date >= today), [today, r.days.map((d) => d.date)]);

section('It agrees with the page the customer books from');
for (const d of r.days) {
  const real = await M.bkAvailability(d.date, 'full', 'suv');
  ok(`${d.date} matches bkAvailability`, JSON.stringify(d.slots) === JSON.stringify(real.slice(0, 4)), { got: d.slots, want: real.slice(0, 4) });
}

section('A day he marked off is not offered');
const first = r.days[0];
const cfg2 = await M.loadBookingConfig();
cfg2.blockedDates = [first.date];
await M.saveBookingConfig(cfg2);
M.__reset();
let r2 = await call('?want=3');
ok('the blocked day is gone', !r2.days.some((d) => d.date === first.date), r2.days.map((d) => d.date));
ok('…and it found others instead', r2.days.length > 0, r2.days);

section('Days he does not work are not offered');
const cfg3 = await M.loadBookingConfig();
cfg3.blockedDates = [];
cfg3.workDays = [];                       // nobody works today
await M.saveBookingConfig(cfg3);
M.__reset();
let r3 = await call('');
ok('no work days → no openings, and it still answers ok', r3.ok === true && r3.days.length === 0, r3);

section('A booked day fills up');
const cfg4 = await M.loadBookingConfig();
cfg4.workDays = [0, 1, 2, 3, 4, 5, 6];
await M.saveBookingConfig(cfg4);
M.__reset();
const open = (await call('?want=1')).days[0];
const full = [];
for (let i = 0; i < cfg4.maxJobsPerDay; i++) {
  full.push({ id: 'b' + i, date: open.date, slot: open.slots[0], status: 'confirmed', durationMin: 180 });
}
await M.saveBookings(full);
M.__reset();
const r4 = await call('?want=3');
ok('a day at its job limit drops out', !r4.days.some((d) => d.date === open.date), r4.days.map((d) => d.date));
await M.saveBookings([]);
M.__reset();

section('The knobs are clamped, not trusted');
ok('want is capped at six', (await call('?want=99')).days.length <= 6);
ok('a junk window still answers', (await call('?days=abc&want=abc')).ok === true);
ok('days cannot be negative', (await call('?days=-5')).ok === true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
