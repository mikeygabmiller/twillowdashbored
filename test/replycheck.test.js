// Unit tests for the conversation-closure check — the thing that stops the
// follow-up engine nagging about a chat that ended with "Thanks!".
//
// The risky direction is a FALSE "no reply needed": that silently hides a real
// customer. So most of these assert that anything with an ask in it still keeps
// its nudge, and that an un-judged thread behaves exactly like it always did.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/replycheck.test.js
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
// Pull a top-level `const NAME = ...;` declaration out by name (the word lists
// and the timing table the lifted functions close over). Scans to the first
// semicolon that isn't inside brackets, so a Set literal, an object literal and
// a one-line regex all come out whole.
function liftConst(name) {
  const start = SRC.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`const ${name} not found in src/index.js`);
  let depth = 0;
  for (let j = SRC.indexOf('=', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`could not find end of const ${name}`);
}

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx',
  liftConst('REACTION_RE') + '\n' +
  liftConst('CLOSER_WORDS') + '\n' +
  liftConst('FOLLOWUP') + '\n' +
  lift('normText') + lift('looksLikeQuestion') + lift('isClosingRemark') +
  lift('replyCheckFor') + lift('replyOwed') + lift('rowAwaitingReply') +
  lift('trailingOutStreak') + lift('computeFollowupPlan') +
  'Object.assign(ctx, { looksLikeQuestion, isClosingRemark, replyOwed, rowAwaitingReply, computeFollowupPlan });',
)(ctx);
const { looksLikeQuestion, isClosingRemark, replyOwed, rowAwaitingReply, computeFollowupPlan } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const NOW = Date.parse('2026-07-28T12:00:00Z');
const ago = (h) => NOW - h * 3600000;
const cfg = { followupsEnabled: true, rebookDays: 90 };
const thread = (msgs, extra = {}) => Object.assign({ phone: '+15550001111', messages: msgs, followup: {} }, extra);
const judged = (ts, needed) => ({ replyCheck: { forTs: ts, at: ts, needed, reason: needed ? 'waiting on you' : 'wrapped up', via: 'ai' } });

console.log('\n=== an ask always keeps its reminder (no AI call needed) ===');
[
  'How much for a full detail on an F-150?',
  'how much',
  'what time works Saturday',
  'can you come tomorrow',
  "I'd like to book Saturday",
  'I need a quote for my truck',
  'let me know when you have an opening',
].forEach((s) => check(JSON.stringify(s), looksLikeQuestion(s), true));

console.log('\n=== a sign-off is not an ask ===');
['Thanks! 🙂', 'Thank you!', '👍', 'ok cool see ya', 'appreciate it man', 'no need, thanks!']
  .forEach((s) => check(JSON.stringify(s), looksLikeQuestion(s), false));

console.log('\n=== offline fallback: what reads as "conversation over" ===');
[
  ['Thanks! 🙂', true],
  ['Thank you!', true],
  ['👍', true],
  ['Liked "See you Saturday at 10"', true],
  ['ok sounds good see you then', true],
  ['perfect, thank you so much!', true],
  ['thanks, what time?', false],
  ["Yes that's fine", false],          // an agreement may still need confirming
  ['Can you come Saturday', false],
  ['My car is filthy, how much for a full detail', false],
].forEach(([s, want]) => check(JSON.stringify(s), isClosingRemark(s), want));

console.log('\n=== the planner honours the verdict ===');
const wrapped = thread(
  [{ dir: 'out', body: 'All finished — she looks great!', ts: ago(80) }, { dir: 'in', body: 'Thanks!', ts: ago(72) }],
  judged(ago(72), false),
);
check('"Thanks!" produces no follow-up at all', computeFollowupPlan(wrapped, NOW, cfg), null);

const unjudged = thread([{ dir: 'out', body: 'All done!', ts: ago(80) }, { dir: 'in', body: 'Thanks!', ts: ago(72) }]);
check('un-judged thread behaves exactly as before', (computeFollowupPlan(unjudged, NOW, cfg) || {}).stage, 'owed');

const asked = thread([{ dir: 'in', body: 'How much for a truck?', ts: ago(3) }], judged(ago(3), true));
check('a real question is still owed a reply', (computeFollowupPlan(asked, NOW, cfg) || {}).stage, 'owed');

const reopened = thread(
  [{ dir: 'in', body: 'Thanks!', ts: ago(72) }, { dir: 'in', body: 'Actually — can you come Friday?', ts: ago(1) }],
  judged(ago(72), false),   // verdict belongs to the OLD message
);
check('a new message invalidates an old verdict', (computeFollowupPlan(reopened, NOW, cfg) || {}).stage, 'owed');

const wonThread = thread(
  [{ dir: 'out', body: 'All done!', ts: ago(80) }, { dir: 'in', body: 'Thanks!', ts: ago(72) }],
  Object.assign({ status: 'won', statusAt: ago(72) }, judged(ago(72), false)),
);
check('a Won job still gets its review ask', (computeFollowupPlan(wonThread, NOW, cfg) || {}).stepKey, 'won:review');

const oldThumbsUp = thread([{ dir: 'in', body: '👍', ts: ago(500) }], judged(ago(500), false));
check('a wrapped-up thread never starts a chase', computeFollowupPlan(oldThumbsUp, NOW, cfg), null);

const unanswered = thread([{ dir: 'in', body: 'hi', ts: ago(60) }, { dir: 'out', body: 'Want a quote?', ts: ago(50) }]);
check('chasing your own unanswered text is unchanged', (computeFollowupPlan(unanswered, NOW, cfg) || {}).stage, 'nudge');

console.log('\n=== replyOwed / rowAwaitingReply defaults ===');
check('no verdict => owed (fail safe)', replyOwed(unjudged), true);
check('verdict false => not owed', replyOwed(wrapped), false);
check('index row without the flag counts as waiting', rowAwaitingReply({ lastDir: 'in' }), true);
check('index row flagged false does not', rowAwaitingReply({ lastDir: 'in', awaitingReply: false }), false);
check('you spoke last => never waiting', rowAwaitingReply({ lastDir: 'out' }), false);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
