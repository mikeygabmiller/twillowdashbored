// Rain check — the forecast read against the jobs already on the books.
//
// The dangerous failure here is not a wrong temperature, it is a heads-up text
// that is wrong about the customer's own appointment. So the assertions below
// are almost all about the two things the feature can get wrong in a way that
// costs him a job: which jobs the rain actually lands on (the hours a detail
// occupies, not the day's worst hour), and whether the drafted text says
// anything the booking record didn't say.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/rain.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
// The threshold is a const, not a function, and the whole point of it living in
// one place is that the brief and the planner read the same number.
const RISK_AT = Number((SRC.match(/const WX_RISK_AT = (\d+);/) || [])[1]);
const WX_TEXT_SRC = (SRC.match(/^const WX_TEXT = \{[^\n]*\};$/m) || [])[0];
// The weekday name tables the outlook reads instead of building a formatter per
// forecast day; lifted the same way, so a rename here fails loudly.
const DOW_SRC = (SRC.match(/^const WX_DOW_SHORT = \[[^\n]*\];$/m) || [])[0] + '\n' +
  (SRC.match(/^const WX_DOW_LONG = \[[^\n]*\];$/m) || [])[0];

const ctx = {};
const NAMES = ['wxDayScore', 'jobRainRisk', 'wxDow', 'wxNextDay', 'wxDayWord', 'wxHeadsUpDraft', 'outlookFrom', 'outlookRange', 'jdFirst', 'bkFmt12'];
// eslint-disable-next-line no-new-func
new Function('ctx', 'WX_RISK_AT',
  WX_TEXT_SRC + '\n' + DOW_SRC + '\n' + NAMES.map(lift).join('\n') + '\n' + NAMES.map((n) => `ctx.${n} = ${n};`).join(''))(ctx, RISK_AT);
const { wxDayScore, jobRainRisk, wxDayWord, wxHeadsUpDraft, outlookFrom, outlookRange } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const CFG = { tz: 'America/Los_Angeles' };
const TODAY = '2026-09-02';   // a Wednesday
const D = (n) => {
  const d = new Date(TODAY + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// A forecast shaped like Open-Meteo's: hourly precipitation probability for
// every hour of every day, plus the daily rollup the strip is drawn from.
function forecast(spec) {
  const time = [], pop = [], daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], wind_speed_10m_max: [] };
  spec.forEach((day, i) => {
    const date = D(i);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      pop.push(day.hours ? (day.hours[h] || 0) : (day.pop || 0));
    }
    daily.time.push(date);
    daily.weather_code.push(day.code == null ? 1 : day.code);
    daily.temperature_2m_max.push(day.hi == null ? 70 : day.hi);
    daily.temperature_2m_min.push(day.lo == null ? 52 : day.lo);
    daily.precipitation_probability_max.push(day.pop || (day.hours ? Math.max.apply(null, Object.values(day.hours)) : 0));
    daily.wind_speed_10m_max.push(day.wind || 4);
  });
  return { current: { temperature_2m: 64, weather_code: 1, precipitation_probability: 5, wind_speed_10m: 6 }, hourly: { time, precipitation_probability: pop }, daily };
}
const job = (o) => Object.assign({ id: 'b:1', date: TODAY, slot: '09:00', durationMin: 180, name: 'Jenna Ruiz', phone: '+14255551212', city: 'Everett', service: 'Full Detail', price: 240, pending: false }, o);

console.log('\n=== rain lands on the hours a job actually occupies ===');
// The day's headline number is 90%, but it all falls in the evening. A 9am
// three-hour detail is dry, and telling him otherwise trains him to ignore this.
const evening = {}; for (let h = 18; h < 23; h++) evening[h] = 90;
const wxEvening = forecast([{ hours: evening }]);
check('a 9am job under an evening downpour is not at risk', jobRainRisk(wxEvening, TODAY, '09:00', 180), 0);
check('a 6pm job under the same sky is', jobRainRisk(wxEvening, TODAY, '18:00', 120), 90);
const morning = {}; for (let h = 8; h < 12; h++) morning[h] = 80;
check('the window includes the hour it runs into', jobRainRisk(forecast([{ hours: morning }]), TODAY, '09:00', 180), 80);
check('a job with no time on it is read as a morning job', jobRainRisk(forecast([{ hours: morning }]), TODAY, '', 150), 80);
check('a day the forecast does not cover is not invented', jobRainRisk(wxEvening, '2027-01-01', '09:00', 180), 0);
check('a forecast that came back empty scores nothing', jobRainRisk({}, TODAY, '09:00', 180), 0);

console.log('\n=== which days are worth offering instead ===');
check('clear and still is a great day', wxDayScore(0, 5, 4), 3);
check('rain in the code is a no whatever the odds say', wxDayScore(63, 10, 4), 0);
check('a coin-flip of rain is poor', wxDayScore(3, 60, 5), 1);
check('so is wind that would blow the water off', wxDayScore(1, 5, 30), 1);
check('a bit of a chance is fair, not great', wxDayScore(2, 35, 5), 2);

console.log('\n=== the week, with his jobs on it ===');
const wk = forecast([
  { code: 1, pop: 5 },                                  // today, clear
  { code: 3, pop: 25 },                                 // tomorrow, grey
  { code: 63, hours: Object.fromEntries([9, 10, 11, 12].map((h) => [h, 85])) }, // Friday, wet
  { code: 0, pop: 5 },                                  // Saturday, clear
]);
const jobs = [
  job({ id: 'b:1', date: TODAY, slot: '09:00' }),
  job({ id: 'b:2', date: D(2), slot: '10:00', name: 'Marcus Webb', phone: '+14255559999' }),
  job({ id: 'b:3', date: D(3), slot: '13:00', name: 'Quiet Day', phone: '+14255550000' }),
];
const o = outlookFrom(wk, CFG, jobs, TODAY);
check('every forecast day is a day on the board', o.days.length, 4);
check('today is called today', o.days[0].dow, 'Today');
check('a job sits on its own day', o.days[2].jobs.map((j) => j.name), ['Marcus Webb']);
check('and the money booked on it comes with it', o.days[2].booked, 240);
check('only the wet day counts a job at risk', o.days.map((d) => d.atRisk), [0, 0, 1, 0]);
check('exactly one customer needs telling', o.atRisk.map((r) => r.name), ['Marcus Webb']);
check('with the number that made it risky', o.atRisk[0].rainRisk, 85);
check('the threshold it was judged against is published', o.riskAt, RISK_AT);
check('and it is the same one the day rows used',
  o.days[2].jobs[0].rainRisk >= o.riskAt, true);

console.log('\n=== where to offer instead ===');
// Today is clear too, and is deliberately not the answer: a customer booked for
// Friday is being asked to move, not to drop everything and come in now.
check('the soonest clear day AFTER the wet one is offered', o.atRisk[0].moveTo, D(3));
check('an earlier dry day is not offered', o.atRisk[0].moveTo === D(0), false);
check('worded the way he would say it', o.atRisk[0].moveToLabel, 'Saturday');
// Nothing dry all week is the honest answer some weeks, and inventing a day
// would be worse than saying nothing.
const wet = forecast([{ code: 63, pop: 90 }, { code: 63, pop: 90 }]);
const o2 = outlookFrom(wet, CFG, [job({ date: TODAY, slot: '09:00' })], TODAY);
check('a wet job today is still flagged today', o2.atRisk[0].dow, 'Today');
check('a week with no dry day offers none', o2.atRisk[0].moveTo, '');
check('and says nothing about moving it', /looking clear/.test(o2.atRisk[0].draft), false);
check('but still asks the question', /Want to move it/.test(o2.atRisk[0].draft), true);

console.log('\n=== the days he would name them ===');
check('today', wxDayWord(TODAY, TODAY), 'today');
check('tomorrow', wxDayWord(D(1), TODAY), 'tomorrow');
check('and after that, the weekday', wxDayWord(D(2), TODAY), 'Friday');
check('a month out is still just the weekday', wxDayWord('2026-10-05', TODAY), 'Monday');

console.log('\n=== the heads-up says only what the booking says ===');
const draft = o.atRisk[0].draft;
console.log('     ' + draft);
check('it is his first name, not his whole name', /Hey Marcus,/.test(draft), true);
check('it says who is texting', /it's Mikey/.test(draft), true);
check('it names the day', /rain Friday/.test(draft), true);
check('and the time he is actually booked for', /around 10:00 AM/.test(draft), true);
check('and the odds it is quoting', /\(85% chance\)/.test(draft), true);
check('it offers the clear day by name', /Saturday is looking clear/.test(draft), true);
check('it leaves the decision with the customer', /Just let me know/.test(draft), true);
// A weather draft has no business quoting money, and it must never read as a
// cancellation he did not agree to.
check('it never quotes a price', /\$/.test(draft), false);
check('it never cancels anything', /cancel/i.test(draft), false);
check('it never claims the job is moved', /(I've moved|I moved|rescheduled you)/i.test(draft), false);
const noName = outlookFrom(wk, CFG, [job({ id: 'b:9', date: D(2), slot: '10:00', name: '' })], TODAY);
check('a nameless customer still gets a greeting', /^Hey there, it's Mikey\./.test(noName.atRisk[0].draft), true);
const noPhone = outlookFrom(wk, CFG, [job({ id: 'b:8', date: D(2), slot: '10:00', phone: '' })], TODAY);
check('nobody to text means no draft to send', noPhone.atRisk[0].draft, '');

console.log('\n=== what never reaches the board ===');
const skipped = outlookFrom(wk, CFG, [], TODAY);
check('no jobs is a quiet week, not an error', skipped.atRisk, []);
check('and the days still render', skipped.days.length, 4);
check('the range follows the forecast that came back', outlookRange(wk, TODAY), { from: TODAY, to: D(3) });
check('a forecast with no days does not walk off the end', outlookRange({}, TODAY), { from: TODAY, to: TODAY });

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
