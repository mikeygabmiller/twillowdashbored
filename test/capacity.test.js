// The Rain-Ready season, counted (Bookings → the card at the top). Runs the
// real worker. What has to hold:
//   · the count is the website's own engine: start times, before dark, his
//     bookings, held texts, days off. Checked against an independent count off
//     the same dusk math, day by day.
//   · November and December hold almost no Full Details without work lights,
//     and the lights number says how many more they'd give
//   · a booked Saturday morning comes off the count; a held text does too
//   · Rain-Ready bookings are counted by when they were booked and what
//   · counting a season never changes what a customer can book: the booking
//     window still applies to bkAvailability
//
//   node test/capacity.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const M = new Function('__env__', src + '\n; ENV = __env__; return { bkCapacity, apiBookingCapacity, bkAvailability, bkDuskMin, bkHm2min, bookingDefaults, localDateStr, saveDetections, __reset(){ resetInvocationCaches(); } };')({ MESSAGES: kv });

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const THROUGH = '2027-01-31';
const reset = () => { store.clear(); if (M.__reset) try { M.__reset(); } catch (e) {} };
const put = (k, v) => store.set(k, JSON.stringify(v));

// The independent count: every day from tomorrow (Pacific) to the end, every
// start time, kept if a Full Detail ends by dusk. No bookings, no holds.
const R = M.bookingDefaults().slotRules;
function independent(lights, from, to) {
  const out = {};
  const today = M.localDateStr(Date.now(), 'America/Los_Angeles');
  const here = new Date(Date.now()).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
  for (let t = Date.parse(today + 'T12:00:00Z') + 864e5; ; t += 864e5) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (date > to) break;
    if (from && date < from) continue;
    const dow = new Date(t).getUTCDay(), dusk = M.bkDuskMin(date);
    let n = 0;
    for (const hm of R.days[dow] || []) {
      const s = M.bkHm2min(hm);
      if ((lights ? s + R.outsideMin.full : s + R.jobMin.full) <= dusk) n++;
    }
    // Tomorrow closes at 9 PM tonight.
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    if (date === tomorrow && +here >= 21) n = 0;
    out[date.slice(0, 7)] = (out[date.slice(0, 7)] || 0) + n;
  }
  return out;
}

section('An empty calendar, counted');
reset();
let c = await M.bkCapacity('full', THROUGH);
const want = independent(false, null, THROUGH), wantLit = independent(true, null, THROUGH);
const got = Object.fromEntries(c.months.map((m) => [m.m, m.open]));
ok('it is on (fixed start times are the default)', c.on === true);
ok('each month matches the independent count', JSON.stringify(got) === JSON.stringify(want), { got, want });
ok('November holds 5 or fewer Full Details without lights', (got['2026-11'] || 0) <= 5, got['2026-11']);
ok('December too', (got['2026-12'] || 0) <= 5, got['2026-12']);
ok('the lights number is the independent one with lights', c.openLit === Object.values(wantLit).reduce((a, b) => a + b, 0), { openLit: c.openLit, wantLit });
ok('lights add a lot of winter Full Details', c.openLit - c.open >= 40, { open: c.open, openLit: c.openLit });
ok('it reads the lights switch as off', c.lights === false);

section('Bookings, holds and days off come off the count');
const nov = Object.keys(want).includes('2026-11') ? '2026-11' : null;
// The first Saturday in November.
let sat = '2026-11-01';
while (new Date(sat + 'T12:00:00Z').getUTCDay() !== 6) sat = new Date(Date.parse(sat + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
put('bk:index', [{ id: 'b1', service: 'interior', date: sat, slot: '07:00', status: 'confirmed', createdAt: Date.now() }]);
c = await M.bkCapacity('full', THROUGH);
ok('an interior booked on a November Saturday morning takes that Full Detail time away', c.months.find((m) => m.m === nov).open === want[nov] - 1, c.months.find((m) => m.m === nov));
reset();
await M.saveDetections([{ id: 'd1', kind: 'set', date: sat, slot: '07:00', durationMin: 270, tentative: true }]);
c = await M.bkCapacity('full', THROUGH);
ok('a loose "Saturday morning" agreed by text holds it too', c.months.find((m) => m.m === nov).open === want[nov] - 1);
reset();
const cfg = M.bookingDefaults(); cfg.blockedDates = [sat];
put('bk:config', cfg);
c = await M.bkCapacity('full', THROUGH);
ok('a day off is not counted', c.months.find((m) => m.m === nov).open === want[nov] - 1);

section('His Google Calendar');
reset();
let fetches = 0, feedUp = true;
globalThis.fetch = async (u) => { fetches++; if (!feedUp) return { ok: false, status: 500, text: async () => '' };
  const d = sat.replace(/-/g, ''), n = new Date(Date.parse(sat + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  return { ok: true, status: 200, text: async () => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${d}\r\nDTEND;VALUE=DATE:${n}\r\nSUMMARY:Off\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` }; };
const withCal = (url) => { const x = M.bookingDefaults(); x.calendar = { enabled: true, icalUrl: url }; return x; };
put('bk:config', withCal('https://cal.test/a.ics'));
c = await M.bkCapacity('full', THROUGH);
ok('an all-day event on his calendar takes that Saturday off the count', c.months.find((m) => m.m === nov).open === want[nov] - 1, c.months.find((m) => m.m === nov));
ok('and the calendar is read once for the whole season', fetches === 1, fetches);
reset(); fetches = 0; feedUp = false;
put('bk:config', withCal('https://cal.test/broken.ics'));
c = await M.bkCapacity('full', THROUGH);
ok('a calendar feed that errors is tried once, not once a day', fetches === 1, fetches);
ok('and the count still comes back', c.months.find((m) => m.m === nov).open === want[nov]);
delete globalThis.fetch;

section('Lights on');
reset();
const lit = M.bookingDefaults(); lit.slotRules.lights = true;
put('bk:config', lit);
c = await M.bkCapacity('full', THROUGH);
ok('with lights on, the count is the lit count', c.open === c.openLit && c.open === Object.values(wantLit).reduce((a, b) => a + b, 0), c.open);

section('Rain-Ready bookings');
reset();
const at = (d) => Date.parse(d + 'T20:00:00Z');
put('bk:index', [
  { id: 'r1', service: 'full', date: '2026-12-12', slot: '07:00', status: 'confirmed', createdAt: at('2026-10-05') },
  { id: 'r2', service: 'full', date: '2027-01-16', slot: '07:00', status: 'pending', createdAt: at('2026-12-31') },
  { id: 'r3', service: 'full', date: '2026-10-10', slot: '07:00', status: 'done', createdAt: at('2026-10-03') },
  { id: 'x1', service: 'full', date: '2026-12-19', slot: '07:00', status: 'cancelled', createdAt: at('2026-10-06') },
  { id: 'x2', service: 'interior', date: '2026-12-19', slot: '13:00', status: 'confirmed', createdAt: at('2026-10-06') },
  { id: 'x3', service: 'full', date: '2026-10-01', slot: '13:00', status: 'done', createdAt: at('2026-09-20') },
  { id: 'x4', service: 'full', date: '2027-01-23', slot: '07:00', status: 'confirmed', createdAt: at('2027-01-02') },
]);
c = await M.bkCapacity('full', THROUGH);
ok('three Rain-Ready Full Details (booked Sep 28 to Dec 31, not cancelled)', c.rrBooked === 3, c.rrBooked);
ok('two of them still to do', c.rrUpcoming === 2, c.rrUpcoming);

section('A customer still books inside the window');
reset();
let far = '2026-12-05';
const sixty = M.localDateStr(Date.now() + 60 * 864e5, 'America/Los_Angeles');
ok('a Saturday 60+ days out is counted for the season', (await M.bkCapacity('full', THROUGH)).months.some((m) => m.open > 0));
ok('but the website still won\'t offer it past the 30-day window', far > sixty ? (await M.bkAvailability(far, 'full', 'suv')).length === 0 : true);

section('The endpoint');
const r = await (await M.apiBookingCapacity(new URL('https://x/api/booking-capacity?service=full'))).json();
ok('it answers with the deadline and the season', r.ok && r.bookBy === '2026-12-31' && r.through === '2027-01-31' && Array.isArray(r.months), r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
