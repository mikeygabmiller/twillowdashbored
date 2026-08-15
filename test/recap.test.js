// The conversation recap's cache key. A recap is a sentence about a moment in a
// conversation, so the dangerous failure is silent and one-directional: a line
// that outlives the state it described. "you said you'd price it Thursday" is
// worse than useless once he's already sent the price — it actively misinforms
// the glance the whole feature exists to serve.
//
// So the only thing worth pinning down is the invalidation, and every assertion
// below is a way of asking "does a new message retire the old story?"
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/recap.test.js
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

const ctx = {};
const NAMES = ['recapFor'];
// eslint-disable-next-line no-new-func
new Function('ctx', NAMES.map(lift).join('\n') + '\n' + NAMES.map((n) => `ctx.${n} = ${n};`).join(''))(ctx);
const { recapFor } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const T0 = 1_700_000_000_000;
const line = "asked about ceramic on his Tahoe, you said you'd price it Thursday";
const thread = (msgs, recap) => ({ phone: '+14255551234', messages: msgs, recap });
const inbound = (ts) => ({ id: 'i' + ts, dir: 'in', body: 'how much?', ts });
const outbound = (ts) => ({ id: 'o' + ts, dir: 'out', body: 'about $240', ts });

console.log('\n=== a recap is only good for the conversation it described ===');

check('fresh recap is served',
  (recapFor(thread([inbound(T0)], { forTs: T0, at: T0, text: line })) || {}).text, line);

check('THEY reply → the old story is retired',
  recapFor(thread([inbound(T0), inbound(T0 + 60000)], { forTs: T0, at: T0, text: line })), null);

check('YOU reply → also retired (his own answer changes where it stands)',
  recapFor(thread([inbound(T0), outbound(T0 + 60000)], { forTs: T0, at: T0, text: line })), null);

check('a recap written for the newest message survives',
  (recapFor(thread([inbound(T0), outbound(T0 + 60000)],
    { forTs: T0 + 60000, at: T0 + 60000, text: line })) || {}).text, line);

console.log('\n=== and it never serves something it does not have ===');

check('no recap at all', recapFor(thread([inbound(T0)], null)), null);
check('recap present but empty text is not served',
  recapFor(thread([inbound(T0)], { forTs: T0, at: T0, text: '' })), null);
check('empty conversation', recapFor(thread([], { forTs: T0, at: T0, text: line })), null);
check('missing messages array', recapFor({ phone: '+1', recap: { forTs: T0, text: line } }), null);
check('a recap stamped for a message that is not the last one',
  recapFor(thread([inbound(T0), inbound(T0 + 1)], { forTs: T0 + 999, at: T0, text: line })), null);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
