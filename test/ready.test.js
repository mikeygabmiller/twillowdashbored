// Readiness — can the job actually happen the way it's booked?
//
// Every case below is a real one off the board on the night this shipped. The
// dashboard already held every fact needed to catch all of them and caught
// none, because nothing ever put two facts side by side. So the assertions are
// deliberately not "does the function run" — they are the six specific ways a
// mobile detail falls over, pinned with the real numbers:
//
//   Tahoe      · confirmed 2pm tomorrow, no address anywhere on the thread
//   Russell    · offered 1pm by a man who wrote "gotta be between 9-1:30"
//   Meghan     · 3 hours from 3:30pm in the third week of September
//   Martin     · nobody home all week, nowhere recording where the key is
//   Chris      · noon on a dry Saturday, and nothing wrong with it at all
//
// A false alarm is as expensive as a miss here: he has already stopped reading
// one list in this app because it cried wolf. Half of what follows is about the
// checks staying quiet.
//
//   node test/ready.test.js
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
const constOf = (n) => (SRC.match(new RegExp('^const ' + n + " = (.+);$", 'm')) || [])[1];

const ctx = {};
const NAMES = ['jrSun', 'jrMinOf', 'jrWindow', 'jrAccessNeed', 'jobBlockers', 'jrSlotMin', 'jrHm', 'jrIn',
  'bkLaOffsetMin', 'jobRainRisk', 'jdFirst', 'findWindowInThread', 'findAccessNeedInThread'];
const PRE = ['JR_STOP', 'JR_CHECK', 'JR_DUSK_BUFFER_MIN', 'JR_LAT', 'JR_LON', 'JR_T', 'JR_SCAN_BACK', 'WX_RISK_AT']
  .map((n) => `const ${n} = ${constOf(n)};`).join('\n') +
  '\nconst jrAmPm = ' + (SRC.match(/^const jrAmPm = (.+);$/m) || [])[1] + ';\n';
// eslint-disable-next-line no-new-func
new Function('ctx', PRE + NAMES.map(lift).join('\n') + '\n' + NAMES.map((n) => `ctx.${n} = ${n};`).join(''))(ctx);
const { jrSun, jrWindow, jrAccessNeed, jobBlockers, jrHm, findWindowInThread, findAccessNeedInThread } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
};
const near = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { PASS++; console.log(`  PASS  ${name} (${got}, within ${tol} of ${want})`); }
  else { FAIL++; console.log(`  FAIL  ${name}\n        got  ${got}\n        want ${want} ±${tol}`); }
};
const codes = (j) => (j.blockers || []).map((b) => b.code);
const stops = (j) => (j.blockers || []).filter((b) => b.level === 'stop').map((b) => b.code);
const textOf = (j, code) => ((j.blockers || []).find((b) => b.code === code) || {}).text || '';

// Pacific, so the epochs below are the wall-clock times he actually reads.
const at = (date, hm) => Date.parse(date + 'T' + hm + ':00-07:00');
const job = (o) => Object.assign({
  id: 'x', name: '', phone: '+15550000000', address: '123 Main St', addressGuess: '',
  slot: '09:00', durationMin: 150, state: 'queued', date: '2026-09-16', pending: false,
  gate: '', parking: '', prefs: '', window: null, access: null,
}, o, { at: o.at !== undefined ? o.at : at(o.date || '2026-09-16', o.slot || '09:00') });
const run = (jobs, now, wx) => jobBlockers(jobs.map(job), { now: now || at('2026-09-13', '19:45'), wx: wx || null });

console.log('\n=== sunset, computed rather than fetched ===');
// Published times for Snohomish, the week this shipped. Three minutes is the
// documented tolerance and sits well inside the 30-minute dusk buffer.
[['2026-09-13', 6 * 60 + 43, 19 * 60 + 24], ['2026-09-15', 6 * 60 + 45, 19 * 60 + 20],
 ['2026-09-19', 6 * 60 + 51, 19 * 60 + 11]].forEach(([d, rise, set]) => {
  near(`${d} sunrise`, jrSun(d).rise, rise, 3);
  near(`${d} sunset`, jrSun(d).set, set, 3);
});
near('midwinter is still short', jrSun('2026-12-21').set, 16 * 60 + 20, 5);
near('midsummer is still long', jrSun('2026-06-21').set, 21 * 60 + 11, 5);
check('a date that is not a date does not throw', jrSun('nonsense'), null);

console.log('\n=== reading a cutoff out of what they actually typed ===');
// The line that started all of this, verbatim off the thread.
check("Russell's own words", jrWindow("It's gotta be between 9-1:30 when you do it. My wife has to get my kids at 2 or so each day"),
  { start: 9 * 60, end: 13 * 60 + 30, quote: 'between 9-1:30' });
check('"between 9 and 1:30"', (jrWindow('can you come between 9 and 1:30') || {}).end, 13 * 60 + 30);
check('"anytime before 2"', jrWindow('anytime before 2 works'), { start: null, end: 14 * 60, quote: 'before 2' });
check('"after 3"', jrWindow('after 3 is best for me'), { start: 15 * 60, end: null, quote: 'after 3' });
check('"done by noon"', (jrWindow('needs to be done by noon') || {}).end, 12 * 60);
check('"no later than 4:15"', (jrWindow('no later than 4:15 please') || {}).end, 16 * 60 + 15);
check('an explicit am is believed over the house rule', (jrWindow('has to be by 11 am') || {}).end, 11 * 60);
check('a pm on the far end pulls the near end into the morning', jrWindow('9 to 1:30pm'), { start: 9 * 60, end: 13 * 60 + 30, quote: '9 to 1:30pm' });

console.log('\n=== ...and staying quiet about everything that is not a cutoff ===');
check('a price is not a time', jrWindow('I can do the whole thing for $320'), null);
check('a date is not a time', jrWindow("The 19th is fine. 18030 124th st. SE"), null);
check('a phone number is not a time', jrWindow('call me on 425-503-4731'), null);
check('a zip code is not a time', jrWindow('5830 95th Dr SE, Snohomish, WA 98290'), null);
check('a year is not a time', jrWindow('I have a 2012 Toyota Tundra'), null);
check('a bare thanks is not a time', jrWindow('Sure.. no problem'), null);
check('nothing at all is not a time', jrWindow(''), null);
check('a backwards range is not a window', jrWindow('between 3 and 2'), null);
check('a five-minute window is not a window', jrWindow('between 9:00 and 9:10'), null);

console.log('\n=== nobody home ===');
check("Martin's own words", !!jrAccessNeed('Let me know what day works best so that I can have my wife place them out since I will be gone'), true);
check('hidden keys count', jrAccessNeed('If I put my truck keys somewhere hidden around the house should be decent on weather').keys, true);
check('"I won\'t be home" counts', !!jrAccessNeed("I won't be home but my wife will let you in"), true);
check('"leave it unlocked" counts', !!jrAccessNeed("I'll go ahead and leave the car unlocked w the keys in it"), true);
check('an ordinary message does not', jrAccessNeed('Sounds good, see you then'), null);
check('talking about a key fob scratch does not', jrAccessNeed('there is a scratch near the door handle'), null);

console.log('\n=== the Tahoe: confirmed, tomorrow, nowhere to drive ===');
const tahoe = run([{ id: 'tahoe', name: 'Tahoe', address: '', addressGuess: '', date: '2026-09-14', slot: '14:00', durationMin: 180 }])[0];
check('it stops the day', stops(tahoe), ['no_address']);
check('and says why in his language', textOf(tahoe, 'no_address'), 'No address, and this is in 18 hours');
check('with the thing to do about it', tahoe.blockers[0].fix, 'Ask them where to go');
check('so the job is not ready', tahoe.ready, false);
// The same job three weeks out is a note, not an emergency.
const later = run([{ id: 'later', address: '', addressGuess: '', date: '2026-10-05', slot: '14:00' }])[0];
check('a missing address weeks out is only a check', codes(later), ['no_address']);
check('and does not stop anything', later.ready, true);
check('an address guessed off the thread counts as knowing', run([{ address: '', addressGuess: '16659 pinnacle rd se' }])[0].ready, true);

console.log('\n=== Russell: the 1pm that could never have worked ===');
const russell = run([{ id: 'r', name: 'Russell McGinnis', date: '2026-09-17', slot: '13:00', durationMin: 210,
  window: { start: 9 * 60, end: 13 * 60 + 30, quote: '9-1:30' } }])[0];
check('it stops the day', stops(russell), ['window']);
check('and does the arithmetic he did not', textOf(russell, 'window'), 'They need you done by 1:30pm — this runs to 4:30pm');
check('and names the start that would fit', russell.blockers[0].fix, 'Start by 10am');
// Which is exactly what 9:00 does.
const fixed = run([{ id: 'r', date: '2026-09-17', slot: '09:00', durationMin: 210,
  window: { start: 9 * 60, end: 13 * 60 + 30, quote: '9-1:30' } }])[0];
check('9:00 clears it', fixed.blockers, []);
check('too early trips the other edge', textOf(run([{ date: '2026-09-17', slot: '07:00', durationMin: 60,
  window: { start: 9 * 60, end: null, quote: 'after 9' } }])[0], 'window'), 'They said not before 9am — this starts 7am');

console.log('\n=== Meghan: three hours from half three, in late September ===');
const meghan = run([{ id: 'm', name: 'Meghan Watson', date: '2026-09-15', slot: '15:30', durationMin: 180 }])[0];
check('not blocked — there is real light left', meghan.ready, true);
// 6:30pm against a 7:22pm sunset is 52 minutes of light, which is working
// light, so it says nothing at all. Worth pinning: the first instinct was to
// warn here, and a warning nobody needs is how the last list got ignored.
check('and not warned about either — 52 minutes is not a close call', codes(meghan), []);
// Half an hour later it genuinely is close, and that is where it speaks up.
const dusky = run([{ date: '2026-09-15', slot: '16:00', durationMin: 180 }])[0];
check('half an hour later is a close call', textOf(dusky, 'dark'), 'Finishes 7pm with 22 min of light left');
check('but still not a stop', dusky.ready, true);
// Push it an hour and it stops being a matter of opinion.
const dark = run([{ date: '2026-09-15', slot: '17:00', durationMin: 180 }])[0];
check('an hour later is a stop', stops(dark), ['dark']);
check('and says when the light goes', textOf(dark, 'dark'), 'Finishes 8pm, dark at 7:22pm');
check('with a start that would have fit', dark.blockers[0].fix, 'Start by 4:22pm');
check('a morning job says nothing about the dark', codes(run([{ date: '2026-09-15', slot: '09:00', durationMin: 180 }])[0]), []);
check('and neither does the same job in June', codes(run([{ date: '2026-06-21', slot: '17:00', durationMin: 180 }])[0]), []);

console.log('\n=== Martin: nobody home, and nowhere saying where the key is ===');
const martin = run([{ id: 'ma', name: 'Martin', date: '2026-09-18', slot: '13:00', durationMin: 240,
  access: { need: true, keys: true, quote: 'since I will be gone' } }])[0];
check('it is raised', codes(martin), ['access']);
check('in his language', textOf(martin, 'access'), 'Nobody home and no key spot written down');
check('but it never stops the day — he can still call', martin.ready, true);
check('a written gate note settles it', codes(run([{ date: '2026-09-18', slot: '13:00', durationMin: 240,
  gate: 'code 4417', access: { need: true, keys: true, quote: 'since I will be gone' } }])[0]), []);

console.log('\n=== Chris: a good booking, and nothing to say about it ===');
const chris = run([{ id: 'c', name: 'Chris S.', address: '18030 124th St SE', date: '2026-09-19', slot: '12:00', durationMin: 270 }])[0];
check('silence', chris.blockers, []);
check('and ready', chris.ready, true);

console.log('\n=== two stops in the same hours ===');
const day = run([
  { id: 'a', name: 'Meghan Watson', date: '2026-09-16', slot: '09:00', durationMin: 180 },
  { id: 'b', name: 'Shana Hainzinger', date: '2026-09-16', slot: '11:00', durationMin: 120 },
]);
check('the second one is told which one it lands on', textOf(day[1], 'overlap'), 'Overlaps Meghan by 60 min');
check('the first one is left alone', codes(day[0]), []);
check('back to back is not an overlap', codes(run([
  { id: 'a', name: 'A', date: '2026-09-16', slot: '09:00', durationMin: 120 },
  { id: 'b', name: 'B', date: '2026-09-16', slot: '11:00', durationMin: 120 },
])[1]), []);

console.log('\n=== rain, over the hours the job occupies ===');
const wx = { hourly: { time: [], precipitation_probability: [] } };
for (let h = 0; h < 24; h++) {
  wx.hourly.time.push('2026-09-16T' + String(h).padStart(2, '0') + ':00');
  wx.hourly.precipitation_probability.push(h >= 14 ? 80 : 5);
}
check('a morning job is dry', codes(run([{ date: '2026-09-16', slot: '09:00', durationMin: 120 }], null, wx)), []);
const wet = run([{ date: '2026-09-16', slot: '15:00', durationMin: 120 }], null, wx)[0];
check('an afternoon job is not', stops(wet).includes('rain'), true);
check('and is told the number', textOf(wet, 'rain'), '80% rain over these hours');

console.log('\n=== what readiness refuses to nag about ===');
check('a finished job is ready by definition', run([{ state: 'done', address: '', date: '2026-09-14', slot: '14:00' }])[0].ready, true);
check('and carries nothing', run([{ state: 'done', address: '', date: '2026-09-14', slot: '14:00' }])[0].blockers, []);
check('a skipped job the same', run([{ state: 'skipped', address: '' }])[0].blockers, []);
check('an unconfirmed job days out stays quiet', codes(run([{ pending: true, date: '2026-10-05', slot: '09:00' }])[0]), []);
check('an unconfirmed job tomorrow does not', codes(run([{ pending: true, date: '2026-09-14', slot: '09:00' }])[0]), ['unconfirmed']);
check('a job with no slot does not invent a window problem',
  codes(run([{ slot: '', at: 0, window: { start: 9 * 60, end: 13 * 60, quote: 'x' } }])[0]), []);
check('an empty board is an empty answer', jobBlockers([], { now: Date.now() }), []);
check('a board that is not a board does not throw', jobBlockers(null, { now: Date.now() }), []);

console.log('\n=== reading the thread, newest word wins ===');
const thread = { messages: [
  { dir: 'in', ts: 1, body: 'any time works honestly' },
  { dir: 'out', ts: 2, body: 'I could come between 8 and 10' },
  { dir: 'in', ts: 3, body: "actually it's gotta be between 9-1:30" },
] };
check('his own offer is not a constraint', findWindowInThread(thread).quote, 'between 9-1:30');
check('and it is marked as theirs', findWindowInThread(thread).from, 'them');
check('a thread with nothing stated has no window', findWindowInThread({ messages: [{ dir: 'in', ts: 1, body: 'ok' }] }), null);
check('an empty thread does not throw', findWindowInThread({}), null);
check('access is heard from either side',
  findAccessNeedInThread({ messages: [{ dir: 'out', ts: 1, body: "I'll grab the key from under the mat" }] }).keys, true);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
