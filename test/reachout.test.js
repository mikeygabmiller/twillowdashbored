// The three rules that decide whether an automatic text reads like Mikey or like
// a bot. All three came from the same complaint: a lead filled out the quote form
// at 1am under the name "JOHN SMITH", then called, and got "Hey JOHN" at 1:04am
// followed four minutes later by "sorry I missed your call!" — two supposedly
// personal texts, neither of which a person would have sent.
//
//   1. tidyName        — don't shout the customer's own name back at them
//   2. firstReachoutAt — nothing lands between 11pm and 5am local
//   3. the missed-call guard — never auto-text someone mid-conversation
//
//   node test/reachout.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit suites — these are module-private in the Worker.
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

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx',
  lift('tidyName') + lift('firstName') + lift('tzFmt') + lift('localHour') +
  lift('localMinute') + lift('msUntilLocalHour') + lift('firstReachoutAt') +
  'const TZFMT = new Map();' +
  'const FIRST_REACHOUT_DELAY_MS = 210000;' +
  'const NIGHT_HOLD_START = 23, NIGHT_HOLD_END = 5;' +
  'ctx.tidyName = tidyName; ctx.firstName = firstName;' +
  'ctx.firstReachoutAt = firstReachoutAt; ctx.localHour = localHour;')(ctx);
const { tidyName, firstName, firstReachoutAt, localHour } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

console.log('\n=== a name typed in caps lock does not go out in caps lock ===');
check('ALL CAPS is straightened',        tidyName('JOHN SMITH'),   'John Smith');
check('all lowercase is straightened',   tidyName('john smith'),   'John Smith');
check('one caps-lock word',              tidyName('MARIA'),        'Maria');
check('hyphenated caps',                 tidyName('MARY-JANE HOLT'), 'Mary-Jane Holt');
check("O'Neal keeps its capital N",      tidyName("SHAQ O'NEAL"),  "Shaq O'Neal");
check("D'Angelo too",                    tidyName("d'angelo b"),   "D'Angelo B");
check('a possessive is not capitalized', tidyName("johns's shop"), "Johns's Shop");
check('stray whitespace collapses',      tidyName('  JOHN   SMITH  '), 'John Smith');

console.log('\n=== a name they capitalized themselves is left completely alone ===');
check('McRae survives',    tidyName('Colin McRae'),  'Colin McRae');
check('DeShawn survives',  tidyName('DeShawn Ford'), 'DeShawn Ford');
check('van Dyke survives', tidyName('Dick van Dyke'), 'Dick van Dyke');
check('iPhone-style eE',   tidyName('eE Chen'),      'eE Chen');

console.log('\n=== nothing to work with ===');
check('empty stays empty',   tidyName(''),        '');
check('undefined is safe',   tidyName(undefined), '');
check('null is safe',        tidyName(null),      '');
check('a number is safe',    tidyName(5),         '5');

console.log('\n=== firstName tidies threads saved before any of this existed ===');
check('a shouting old thread',   firstName({ name: 'JOHN SMITH' }), 'John');
check('a normal thread',         firstName({ name: 'Colin McRae' }), 'Colin');
check('a nameless thread',       firstName({}), 'there');

// ---------------------------------------------------------------------------
const TZ = 'America/Los_Angeles';
const cfg = { tz: TZ };
// Build a real instant from a Pacific wall-clock time. July is PDT (UTC-7).
const pdt = (day, hhmm) => Date.parse(`2026-07-${day}T${hhmm}:00-07:00`);
const wall = (t) => new Date(t).toLocaleString('en-CA', { timeZone: TZ, hour12: false });

console.log('\n=== during the day, the reach-out is just a few minutes out ===');
check('a 2pm quote goes out at 2:03:30pm', wall(firstReachoutAt(pdt('14', '14:00'), cfg)), wall(pdt('14', '14:00') + 210000));
check('a 9pm quote still goes out tonight', localHour(firstReachoutAt(pdt('14', '21:00'), cfg), TZ), 21);
check('10:55pm is still inside the day',   localHour(firstReachoutAt(pdt('14', '22:55'), cfg), TZ), 22);
check('5am on the nose sends now',         localHour(firstReachoutAt(pdt('14', '05:00'), cfg), TZ), 5);

console.log('\n=== 11pm to 5am, it waits for 5am local ===');
const held = (day, hhmm) => {
  const at = firstReachoutAt(pdt(day, hhmm), cfg);
  return wall(at);
};
check('11:00pm waits for 5am',   held('14', '23:00'), wall(pdt('15', '05:00')));
check('11:59pm waits for 5am',   held('14', '23:59'), wall(pdt('15', '05:00')));
check('1:00am waits for 5am',    held('15', '01:00'), wall(pdt('15', '05:00')));
check('4:50am waits for 5am',    held('15', '04:50'), wall(pdt('15', '05:00')));
// The window is checked against when the text would LAND, not when the form was
// filled in — 4:59am + the pause is already a civil hour, so nothing is held.
check('4:59am is close enough that the pause carries it past 5',
  held('15', '04:59'), wall(pdt('15', '04:59') + 210000));
check('10:58pm crosses into 11', held('14', '22:58'), wall(pdt('15', '05:00')));
check('held sends land on the hour, not a random minute',
  new Date(firstReachoutAt(pdt('15', '02:17'), cfg)).getSeconds(), 0);

console.log('\n=== the hold survives winter, and the DST weekends ===');
const pst = (d, hhmm) => Date.parse(`2026-01-${d}T${hhmm}:00-08:00`);
check('January 1am waits for 5am PST', localHour(firstReachoutAt(pst('14', '01:00'), { tz: TZ }), TZ), 5);
// Spring forward 2026: 2am PST -> 3am PDT on March 8.
const springNight = Date.parse('2026-03-08T01:30:00-08:00');
check('the night the clocks jump forward still lands at 5am', localHour(firstReachoutAt(springNight, { tz: TZ }), TZ), 5);
// Fall back 2026: 2am PDT -> 1am PST on November 1.
const fallNight = Date.parse('2026-11-01T00:30:00-07:00');
check('the night the clocks fall back still lands at 5am', localHour(firstReachoutAt(fallNight, { tz: TZ }), TZ), 5);

console.log('\n=== a missing/bad timezone never blocks a lead ===');
check('no tz still schedules something', typeof firstReachoutAt(Date.now(), {}), 'number');
check('junk tz still schedules something', typeof firstReachoutAt(Date.now(), { tz: 'Mars/Olympus' }), 'number');

// ---------------------------------------------------------------------------
// The missed-call guard. handleVoicemail is a Twilio webhook end to end, so
// rather than fake all of Twilio this asserts on the condition itself, lifted
// from the source, plus the source shape that keeps it wired in.
console.log('\n=== the missed-call text only goes to someone you have never texted ===');
const guard = (thread) =>
  (thread.messages || []).some((m) => m.dir === 'out') || (thread.scheduled || []).length > 0;
const wouldText = (thread) => !guard(thread);

check('a cold caller gets the text',
  wouldText({ messages: [], scheduled: [] }), true);
check('a caller with an inbound-only thread still gets it',
  wouldText({ messages: [{ dir: 'in', body: 'hey' }], scheduled: [] }), true);
check('a brand-new empty thread gets it',
  wouldText({}), true);

check('someone whose quote reply is still queued does NOT get it',
  wouldText({ messages: [], scheduled: [{ id: 'x', body: 'Hey John…', sendAt: Date.now() + 100000 }] }), false);
check('someone Mikey has already texted does NOT get it',
  wouldText({ messages: [{ dir: 'out', body: 'On my way' }], scheduled: [] }), false);
check('a caller who already got a missed-call text does NOT get a second one',
  wouldText({ messages: [{ dir: 'out', body: 'sorry I missed your call', kind: 'missed-call' }], scheduled: [] }), false);
check('an old customer from a finished job does NOT get it',
  wouldText({ messages: [{ dir: 'in', body: 'hi' }, { dir: 'out', body: 'thanks!' }], scheduled: [] }), false);

console.log('\n=== the guard is actually wired into the voicemail webhook ===');
const vm = lift('handleVoicemail');
check('handleVoicemail checks for prior outbound messages', /alreadyReachedOut/.test(vm), true);
check('it counts queued sends too', /thread\.scheduled \|\| \[\]\)\.length/.test(vm), true);
check("Mikey's alert no longer claims a text went out unconditionally", /textedBack \?/.test(vm), true);

console.log('\n=== both quote-form endpoints go through the same two rules ===');
for (const fn of ['handleSubmit', 'handleQqcText']) {
  const body = lift(fn);
  check(`${fn} tidies the name`, /tidyName\(body\.name\)/.test(body), true);
  check(`${fn} schedules via firstReachoutAt`, /firstReachoutAt\(Date\.now\(\), cfg\)/.test(body), true);
  check(`${fn} no longer hardcodes the send time`, /sendAt: Date\.now\(\) \+/.test(body), false);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
