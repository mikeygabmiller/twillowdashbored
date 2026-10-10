// Fixed slots: the calendar Mikey actually works (2026-09-29).
//
// School until noon, so a weekday is one job at 1:00; Saturday is 7:00 and
// 1:00; never Sunday. A slot is only offered for a service if that job, at his
// longest honest time, finishes before dark. Towns he serves book instantly.
//
// Every check here pins the clock, because "is it before dark" and "is it
// tomorrow" are questions about a date, and a test that passes in October and
// fails in December is not a test.
//
//   node test/slots.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['bkAvailability', 'bkDuskMin', 'bkServedTown', 'apiBook', 'apiNextOpenings', 'apiBookConfig',
  'loadBookingConfig', 'saveBookingConfig', 'bkSanitizeConfig', 'loadBookings', 'saveBookings', 'loadThread', 'bkLaEpoch', 'loadQuoteMonth', 'localDateStr'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const sms = [], alerts = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(opts.body));
    sms.push({ to: p.get('To'), body: p.get('Body') });
    return { ok: true, json: async () => ({ sid: 'SM1' }) };
  }
  return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) };
};

const realNow = Date.now;
let NOW = realNow();
Date.now = () => NOW;
// A Pacific wall-clock time, as the epoch the worker sees.
// (Summer time until the clocks go back on Nov 1, 2026.)
const at = (date, hm) => Date.parse(date + 'T' + hm + ':00Z') + (date >= '2026-11-01' ? 8 : 7) * 3600000;

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1', PROMISE_DISABLED: '1',
  RESEND_API_KEY: 're_test', ALERT_EMAIL: 'm@example.com',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b, method: 'POST', headers: { get: () => '' } });
const avail = async (d, svc) => { M.__reset(); return M.bkAvailability(d, svc, 'suv'); };
const setRules = async (patch) => {
  const c = await M.loadBookingConfig();
  c.slotRules = Object.assign({}, c.slotRules, patch);
  await M.saveBookingConfig(M.bkSanitizeConfig(c));
  M.__reset();
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

section('Dusk follows the season at his base (almanac: Oct 1 7:18 PM, Nov 2 5:21 PM, Dec 15 4:52 PM)');
ok('Oct 1 is about 7:18 PM', near(M.bkDuskMin('2026-10-01'), 19 * 60 + 18, 5), M.bkDuskMin('2026-10-01'));
ok('Nov 2, after the clocks go back, is about 5:21 PM', near(M.bkDuskMin('2026-11-02'), 17 * 60 + 21, 5), M.bkDuskMin('2026-11-02'));
ok('Dec 15 is about 4:52 PM', near(M.bkDuskMin('2026-12-15'), 16 * 60 + 52, 5), M.bkDuskMin('2026-12-15'));

section('His week: Tue to Fri at 1:00, Saturday at 7:00 and 1:00, never Sunday, Mondays off for now');
NOW = at('2026-10-10', '10:00');                     // a Saturday morning in October
const pub = await (await M.apiBookConfig()).json();
ok('the booking page is told the work days are Tue to Sat', JSON.stringify(pub.config.workDays) === '[2,3,4,5,6]', pub.config.workDays);
ok('Monday offers nothing, any job', (await avail('2026-10-12', 'exterior')).length === 0 && (await avail('2026-10-12', 'interior')).length === 0 && (await avail('2026-10-19', 'full')).length === 0);
ok('Tuesday offers 1:00 only', JSON.stringify(await avail('2026-10-13', 'exterior')) === '["13:00"]', await avail('2026-10-13', 'exterior'));
ok('Saturday offers 7:00 and 1:00', JSON.stringify(await avail('2026-10-17', 'exterior')) === '["07:00","13:00"]', await avail('2026-10-17', 'exterior'));
ok('Sunday offers nothing', (await avail('2026-10-18', 'exterior')).length === 0);

section('Never the same day, and tomorrow closes at 9 PM tonight');
ok('today offers nothing, even hours ahead', (await avail('2026-10-10', 'exterior')).length === 0);
NOW = at('2026-10-12', '20:30');
ok('at 8:30 PM Monday, Tuesday 1:00 is still open', (await avail('2026-10-13', 'exterior')).length === 1);
NOW = at('2026-10-12', '21:05');
ok('at 9:05 PM Monday, Tuesday has closed', (await avail('2026-10-13', 'exterior')).length === 0);
ok('…but Wednesday is still there', (await avail('2026-10-14', 'exterior')).length === 1);

section('A job has to finish before dark: 4.5 hr Full Detail fits a weekday in October, not in December');
NOW = at('2026-10-10', '10:00');
ok('Tue Oct 13 at 1:00 takes a Full Detail (done 5:30, dark ~6:55)', JSON.stringify(await avail('2026-10-13', 'full')) === '["13:00"]');
NOW = at('2026-12-01', '10:00');
ok('Tue Dec 8 at 1:00 does NOT take a Full Detail (dark ~4:50)', (await avail('2026-12-08', 'full')).length === 0, await avail('2026-12-08', 'full'));
ok('…but takes an Exterior (done 3:00)', (await avail('2026-12-08', 'exterior')).length === 1);
ok('…and an Interior (done 4:00)', (await avail('2026-12-08', 'interior')).length === 1);
ok('a December Saturday takes a Full Detail in the morning only', JSON.stringify(await avail('2026-12-12', 'full')) === '["07:00"]', await avail('2026-12-12', 'full'));

section('His lights switch: only the outside part (exterior first) has to beat dark');
await setRules({ lights: true });
ok('with lights on, Tue Dec 8 at 1:00 takes a Full Detail', JSON.stringify(await avail('2026-12-08', 'full')) === '["13:00"]', await avail('2026-12-08', 'full'));
ok('…and so does a December Saturday afternoon', JSON.stringify(await avail('2026-12-12', 'full')) === '["07:00","13:00"]', await avail('2026-12-12', 'full'));
await setRules({ lights: false });
ok('switched back off, it is gone again', (await avail('2026-12-08', 'full')).length === 0);

section('What he has booked blocks it; the Saturday morning job still leaves 1:00 open');
NOW = at('2026-10-10', '10:00');
await M.saveBookings([{ id: 'b1', status: 'confirmed', date: '2026-10-17', slot: '07:00', service: 'full', durationMin: 270 }]);
ok('a 7:00 Full Detail leaves the 1:00 slot (ends 11:30 + drive)', JSON.stringify(await avail('2026-10-17', 'exterior')) === '["13:00"]', await avail('2026-10-17', 'exterior'));
await M.saveBookings([{ id: 'b1', status: 'confirmed', date: '2026-10-17', slot: '07:00', service: 'full' },
  { id: 'b2', status: 'pending', date: '2026-10-17', slot: '13:00', service: 'exterior' }]);
ok('both taken, Saturday is full', (await avail('2026-10-17', 'exterior')).length === 0);
await M.saveBookings([{ id: 'b3', status: 'cancelled', date: '2026-10-13', slot: '13:00', service: 'full' }]);
ok('a cancelled job frees its slot', (await avail('2026-10-13', 'exterior')).length === 1);
await M.saveBookings([]);

section('Next openings: in order, and exactly what bkAvailability would allow');
const no = await (await M.apiNextOpenings(new URL('https://x.test/api/next-openings?service=full&n=3'))).json();
ok('three openings', no.ok && no.openings.length === 3, no);
ok('first is Tue Oct 13 at 1:00 (today, Sunday and Monday skipped)', no.openings[0].date === '2026-10-13' && no.openings[0].slot === '13:00', no.openings[0]);
ok('in date order', no.openings.every((o, i) => i === 0 || (o.date + o.slot) > (no.openings[i - 1].date + no.openings[i - 1].slot)));
for (const o of no.openings) ok(`${o.date} ${o.slot} is a real bkAvailability slot`, (await avail(o.date, 'full')).includes(o.slot));
ok('labels are human', /^Tue, Oct 13$/.test(no.openings[0].label) && no.openings[0].time === '1:00 PM', no.openings[0]);

section('Booking from a town he serves confirms on the spot');
ok('town matching forgives case and ", WA"', M.bkServedTown('mill creek, WA') && M.bkServedTown(' Everett ') && !M.bkServedTown('Lynnwood'));
sms.length = 0; alerts.length = 0;
let r = await (await M.apiBook(req({ service: 'exterior', size: 'suv', date: '2026-10-13', slot: '13:00', name: 'Sam Park',
  phone: '4255550101', address: '1425 Cedar Ave', city: 'Everett', smsConsent: true, estimate: 239 }))).json();
ok('it books', r.ok, r);
ok('as confirmed, not pending', r.status === 'confirmed', r);
ok('the customer gets the confirm text, with spigot and outlet', sms.length === 1 && /you're booked|got you down|see you/.test(sms[0].body) && /spigot|faucet/.test(sms[0].body), sms);
let th = await M.loadThread('+14255550101');
ok('the day-before and morning reminders are queued', th.scheduled.filter((x) => x.kind === 'booking').length === 2, th.scheduled);
ok('Mikey hears it is already on his schedule', alerts.length === 1 && /confirmed automatically/.test(alerts[0].text), alerts[0] && alerts[0].text);
ok('the slot is gone for the next person', (await avail('2026-10-13', 'exterior')).length === 0);
r = await (await M.apiBook(req({ service: 'exterior', size: 'suv', date: '2026-10-13', slot: '13:00', name: 'Late Larry',
  phone: '4255550199', address: '2 Elm', city: 'Everett', smsConsent: true }))).json();
ok('a second person asking for it is refused', !r.ok && r.error === 'slot_taken', r);

section('Anywhere else is a request he answers himself');
sms.length = 0; alerts.length = 0;
r = await (await M.apiBook(req({ service: 'exterior', size: 'suv', date: '2026-10-14', slot: '13:00', name: 'Lynn Wood',
  phone: '4255550102', address: '5 Oak St', city: 'Lynnwood', smsConsent: true }))).json();
ok('it books as pending', r.ok && r.status === 'pending', r);
ok('the customer gets "I\'ll text to confirm", not "you\'re all set"', sms.length === 1 && /confirm/.test(sms[0].body) && !/all set/.test(sms[0].body), sms);
ok('no reminders until he confirms', !(await M.loadThread('+14255550102')).scheduled.some((x) => x.kind === 'booking'));
await setRules({ autoConfirm: false });
r = await (await M.apiBook(req({ service: 'exterior', size: 'suv', date: '2026-10-15', slot: '13:00', name: 'Ev Rett',
  phone: '4255550103', address: '9 Pine', city: 'Everett', smsConsent: true }))).json();
ok('with instant confirm switched off, even Everett waits for him', r.ok && r.status === 'pending', r);
await setRules({ autoConfirm: true });

section('A general area is fine, and Mikey is told to get the house number');
alerts.length = 0;
r = await (await M.apiBook(req({ service: 'full', size: 'suv', date: '2026-10-16', slot: '13:00', name: 'Pat Q',
  phone: '4255550104', address: 'Off Bickford near the Safeway', city: 'Snohomish', smsConsent: true }))).json();
ok('it books', r.ok, r);
ok('his alert flags it as a general area', /general area only/.test(alerts[0] && alerts[0].text), alerts[0] && alerts[0].text);
ok('a street with a number is not flagged', !(await M.loadBookings()).find((b) => b.city === 'Everett' && b.name === 'Sam Park').areaOnly);

section('Rain-Ready rides on the booking date');
let bk = (await M.loadBookings()).find((b) => b.name === 'Pat Q');
ok('a Full Detail booked in October is Rain-Ready', bk.rainReady === true, bk);
ok('an Exterior is not', !(await M.loadBookings()).find((b) => b.name === 'Sam Park').rainReady);
ok('his alert says the extras are free', /Rain-Ready/.test(alerts[0].text));

section('Bookings land in the Quotes log as bookings');
{
  const month = await M.loadQuoteMonth(M.localDateStr(NOW, 'America/Los_Angeles').slice(0, 7));
  const sam = (month.entries || []).find((e) => e.name === 'Sam Park');
  ok('Sam\'s booking is logged, typed as a booking, with the price and time', sam && sam.type === 'booking' && sam.total === 239 && /Oct 13/.test(sam.appointment), sam || month);
}

section('A Settings save keeps the rules and drops junk');
const c = await M.loadBookingConfig();
c.slotRules.days[3] = ['13:00', 'noon', '9:30'];
const clean = M.bkSanitizeConfig(c);
ok('good times kept and sorted, junk dropped', JSON.stringify(clean.slotRules.days[3]) === '["09:30","13:00"]', clean.slotRules.days[3]);
ok('lights stay off unless set on', clean.slotRules.lights === false);
ok('instant confirm stays on unless set off', clean.slotRules.autoConfirm === true);

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
