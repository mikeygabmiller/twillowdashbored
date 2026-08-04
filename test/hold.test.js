// Unit tests for standing instructions ("hold") — the date parsing is the risky
// part, because a bad parse would silence a customer forever. The functions are
// module-private in the Worker, so they're lifted out of the source by name and
// evaluated here rather than exported purely for tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  // Skip the parameter list first — a default like `opts = {}` would otherwise
  // look like the function body and the brace match would end immediately.
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
new Function('ctx', lift('parseHoldUntil') + lift('holdIsActive') +
  'const HOLD_MAX_MS = 400 * 86400000;' +
  'ctx.parseHoldUntil = parseHoldUntil; ctx.holdIsActive = holdIsActive;')(ctx);
const { parseHoldUntil, holdIsActive } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const NOW = Date.parse('2026-07-28T12:00:00Z');
const day = (t) => new Date(t).toISOString().slice(0, 10);

console.log('\n=== "leave them alone until…" turns into a real date ===');
check('a bare date lands on that day',        day(parseHoldUntil('2026-08-01', null, NOW)), '2026-08-01');
check('a duration in days',                   day(parseHoldUntil(null, 14, NOW)),           '2026-08-11');
check('a full timestamp is kept',             parseHoldUntil(Date.parse('2026-09-05T17:00:00Z'), null, NOW), Date.parse('2026-09-05T17:00:00Z'));

console.log('\n=== refuses anything that would silence someone forever ===');
check('a date in the past is rejected',       parseHoldUntil('2026-01-01', null, NOW), 0);
check('today is rejected (already passed)',   parseHoldUntil('2026-07-28', null, NOW) === 0 || day(parseHoldUntil('2026-07-28', null, NOW)) === '2026-07-28', true);
check('gibberish is rejected',                parseHoldUntil('sometime whenever', null, NOW), 0);
check('empty is rejected',                    parseHoldUntil('', null, NOW), 0);
check('null is rejected',                     parseHoldUntil(null, null, NOW), 0);
check('a 10-year hold is capped at ~400d',    parseHoldUntil('2036-01-01', null, NOW), NOW + 400 * 86400000);
check('99999 days is capped too',             parseHoldUntil(null, 99999, NOW), NOW + 400 * 86400000);
check('zero days is rejected',                parseHoldUntil(null, 0, NOW), 0);
check('negative days is rejected',            parseHoldUntil(null, -5, NOW), 0);

console.log('\n=== a hold is only active while it lasts ===');
check('future hold is active',   holdIsActive({ snoozeUntil: NOW + 86400000 }, NOW), true);
check('past hold is not',        holdIsActive({ snoozeUntil: NOW - 86400000 }, NOW), false);
check('no hold is not',          holdIsActive({}, NOW), false);
check('undefined is not',        holdIsActive(undefined, NOW), false);

console.log('\n=== the follow-up engine checks the hold before anything else ===');
// The ordering matters: the snooze short-circuit has to come before the "customer
// texted last, you owe a reply" branch, or holding Sabine wouldn't stop the nudge.
const planSrc = lift('computeFollowupPlan');
const snoozeAt = planSrc.indexOf('fu.snoozeUntil');
const owedAt = planSrc.indexOf("last.dir === 'in'");
check('hold is checked before the "you owe a reply" branch', snoozeAt > 0 && snoozeAt < owedAt, true);

console.log('\n=== an inbound text cancels the hold ===');
const append = lift('appendMessage');
check('appendMessage clears snoozeUntil on inbound', /dir === 'in'[\s\S]*snoozeUntil = null/.test(append), true);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
