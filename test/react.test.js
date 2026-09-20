// Tapbacks — the hearts and thumbs customers stick on Mikey's texts.
//
// Over SMS a tapback arrives as plain words (`Loved "see you Saturday"`), so the
// whole feature rests on two questions: is this a tapback, and which of his
// messages is it stuck to? Both are answered here.
//
// The risky direction is a WRONG match: a heart drawn on the wrong text is worse
// than one shown as a plain message, so most of these assert that a loose or
// short quote refuses to guess.
//
//   node test/react.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lifting trick the other Worker suites use: these are module-private, and
// exporting them purely for tests would be a worse file.
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
  liftConst('TAPBACKS') + '\n' +
  liftConst('REACTION_RE') + '\n' +
  liftConst('REACTION_ANY_RE') + '\n' +
  liftConst('REACTION_REMOVED_RE') + '\n' +
  liftConst('QUIET_TAPBACKS') + '\n' +
  lift('normText') + lift('parseReaction') + lift('reactionTarget') +
  'Object.assign(ctx, { parseReaction, reactionTarget, QUIET_TAPBACKS });',
)(ctx);
const { parseReaction, reactionTarget, QUIET_TAPBACKS } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

console.log('\n=== what a tapback looks like coming off a phone ===');
[
  ['Liked "See you Saturday at 10"',            '👍', 'See you Saturday at 10'],
  ['Loved “See you Saturday at 10”',  '❤️',  'See you Saturday at 10'],
  ['Laughed at "that truck was rough"',         '😂', 'that truck was rough'],
  ['Emphasized "$299 out the door"',            '‼️',  '$299 out the door'],
  ['Emphasised "$299 out the door"',            '‼️',  '$299 out the door'],
  ['Disliked "I can\'t make Saturday"',         '👎', "I can't make Saturday"],
  ['Questioned "$379 for the truck"',           '❓',        '$379 for the truck'],
].forEach(([body, emoji, quote]) => {
  const r = parseReaction(body);
  check(JSON.stringify(body), r && [r.emoji, r.quote], [emoji, quote]);
});
check('iOS 18 picks any emoji it likes', (() => { const r = parseReaction('Reacted 🔥 to "she came up great"'); return r && [r.emoji, r.label, r.quote]; })(),
  ['🔥', 'reacted', 'she came up great']);
check('the phone truncates a long one', (parseReaction('Loved "Hey Dave, Saturday at 10 works…"') || {}).quote,
  'Hey Dave, Saturday at 10 works');
check('taking it back is a tapback too', (() => { const r = parseReaction('Removed a heart from "See you Saturday at 10"'); return r && [r.removed, r.quote]; })(),
  [true, 'See you Saturday at 10']);

console.log('\n=== an ordinary text is never mistaken for one ===');
[
  'I liked the last guy but he moved away',
  'Loved it, thank you!',                 // no quoted message after it
  'How much to do the inside?',
  'Removed the seats already',
  '',
].forEach((s) => check(JSON.stringify(s), parseReaction(s), null));

console.log('\n=== which message it landed on ===');
const msgs = [
  { id: 'a', dir: 'out', body: 'Hey Dave, I can do Saturday at 10 if that still works for you' },
  { id: 'b', dir: 'in',  body: 'yes please' },
  { id: 'c', dir: 'out', body: 'See you Saturday at 10' },
];
check('exact wording',      (reactionTarget(msgs, 'See you Saturday at 10') || {}).id, 'c');
check('truncated wording',  (reactionTarget(msgs, 'Hey Dave, I can do Saturday at 10 if that') || {}).id, 'a');
check('punctuation and case do not matter', (reactionTarget(msgs, 'see you saturday at 10!') || {}).id, 'c');
check('nothing like it stays unplaced',     reactionTarget(msgs, 'your ceramic coating quote'), null);
check('a short quote will not guess',       reactionTarget(msgs, 'Hey Dave'), null);
check('nor a half-remembered one',          reactionTarget(msgs, 'Hey Dave, I can'), null);

console.log('\n=== the newest matching message wins ===');
const twice = [
  { id: 'old', dir: 'out', body: 'On my way' },
  { id: 'mid', dir: 'in',  body: 'ok' },
  { id: 'new', dir: 'out', body: 'On my way' },
];
check('they tapped the one they just read', (reactionTarget(twice, 'On my way') || {}).id, 'new');

console.log('\n=== a tapback never points at another tapback ===');
const chain = [
  { id: 'x', dir: 'out', body: 'All done, she looks great' },
  { id: 'y', dir: 'in',  kind: 'reaction', body: 'Loved "All done, she looks great"' },
];
check('it finds his message, not the heart', (reactionTarget(chain, 'All done, she looks great') || {}).id, 'x');

console.log('\n=== which ones end a conversation ===');
check('a heart needs no reply',        QUIET_TAPBACKS.has('loved'), true);
check('a thumbs up needs no reply',    QUIET_TAPBACKS.has('liked'), true);
// A thumbs-down or a "?" on a price is a customer with a problem. The whole bias
// of the reply check is that a needless nudge beats a missed customer.
check('a thumbs DOWN still gets a nudge', QUIET_TAPBACKS.has('disliked'), false);
check('a "?" still gets a nudge',         QUIET_TAPBACKS.has('questioned'), false);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
