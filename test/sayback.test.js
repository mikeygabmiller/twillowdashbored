// "Say it back to them" — the suggestion that proves Mikey heard the customer.
//
// Everything else polish does subtracts: a comma splice goes, a typo goes, a
// warning appears. This one ADDS — a method, and an honest limit about a result.
// That is a claim landing on a real person's phone, so the gates below are not
// belt-and-braces, they are the feature. A suggestion that quotes a price he
// never said, or promises a seat will come out perfect, is worse than no
// suggestion at all — so every one of these drops the whole thing rather than
// trying to repair it.
//
//   node test/sayback.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
const constant = (name) => {
  const m = SRC.match(new RegExp(`const ${name} =[\\s\\S]*?;\\n`));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
};

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// The gates run against the real source, lifted the same way the polish suite
// lifts parsePolishOut — a copy of the regex in the test would prove nothing.
const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx',
  constant('AI_TELLS') + lift('sayDefaults') + lift('sayRules') + lift('sayNorm') + lift('sayBanned') + lift('findTell') +
  constant('VEHICLE_MAKES') + lift('mentionsVehicle') + constant('VOICE_BUCKETS') + lift('voiceBucket') +
  constant('SAY_BACK_MONEY') + lift('cleanSayBack') +
  constant('SAY_BACK_SKIP_BUCKETS') + constant('SAY_BACK_SETTLED') + lift('sayBackSource') +
  'ctx.cleanSayBack = cleanSayBack; ctx.sayBackSource = sayBackSource; ctx.voiceBucket = voiceBucket;'
)(ctx);
const { cleanSayBack, sayBackSource } = ctx;

const inbound = (body) => ({ messages: [{ dir: 'in', body }] });
const DRAFT = 'yea i can clean that';
const GOOD =
  "yea the juice on the back seat is one of the most common ones i get. " +
  "i'll hit that seat with a hot water extraction and go over the whole bench. " +
  "cant guarantee it all lifts but i'll get out as much as i can";

console.log('\n=== there has to be something to say back ===');
check('a customer who named a problem is worth answering properly',
  !!sayBackSource(inbound('my kid dumped juice all over the back seat'), DRAFT), true);
check('"k" names nothing',
  sayBackSource(inbound('k'), DRAFT), '');
check('"thanks!" names nothing either',
  sayBackSource(inbound('thanks!'), DRAFT), '');
// Inbound only. He asked for this on replies, and there is nothing to hear in a
// text he started himself.
check('his own last word means there is nothing to hear',
  sayBackSource({ messages: [{ dir: 'out', body: 'heading your way now, see you in 20' }] }, DRAFT), '');
check('an empty thread is not a conversation',
  sayBackSource({ messages: [] }, DRAFT), '');

console.log('\n=== it stays out of the texts where warmth would be strange ===');
// Nobody wants their booking confirmation to open with how common juice stains
// are. quick / schedule / confirm are the three he asked to be left alone.
const CONCERN = 'the back seat is trashed, my kid spilled juice everywhere';
check('a confirmation is left alone', sayBackSource(inbound(CONCERN), "you're all set for tuesday"), '');
check('a customer who already agreed has nothing left to hear',
  sayBackSource(inbound('sounds good, see you at 2'), 'omw'), '');
// The bug this feature was nearly shipped with: voiceBucket calls anything under
// 40 characters `quick`, and the flat reply is always short. Skipping on that
// would have skipped the only message worth fixing.
check('a short flat reply is the POINT, not a reason to skip',
  !!sayBackSource(inbound(CONCERN), 'yea i can clean that'), true);
check('but a real answer gets the offer', !!sayBackSource(inbound(CONCERN), DRAFT), true);

console.log('\n=== no money, ever — he said no upsell and this is how that holds ===');
check('a price is refused outright', cleanSayBack(GOOD + ". that's $40", DRAFT), '');
check('"add-on" is an upsell even without a number', cleanSayBack(GOOD + ', its an add-on', DRAFT), '');
check('so is "a little extra"', cleanSayBack(GOOD + ', costs a little extra', DRAFT), '');
check('and so is a discount', cleanSayBack(GOOD + " i'll do you a discount", DRAFT), '');

console.log('\n=== it cannot invent a fact he did not write ===');
// A method is the model's to supply. A time is not.
check('a time he never said is refused', cleanSayBack(GOOD + " i'll be there at 9", DRAFT), '');
check('a number he DID write is fine',
  !!cleanSayBack('ill be there at 9 and ' + GOOD, 'ill be there at 9'), true);

console.log('\n=== it has to sound like him ===');
check('corporate filler is dropped, not repaired',
  cleanSayBack('I understand your concern. ' + GOOD, DRAFT), '');
check('an em-dash is a tell too', cleanSayBack('yea — ' + GOOD, DRAFT), '');
check('an email-length answer is not a text', cleanSayBack(GOOD.repeat(4), DRAFT), '');
check('handing back his own draft is not a suggestion', cleanSayBack(DRAFT, DRAFT), '');
check('nothing to say is a real answer', cleanSayBack('', DRAFT), '');

console.log('\n=== his own ban list outranks anything the model likes ===');
// A phrase he banned by hand is banned in a suggestion too — this is a message
// he would send, not an internal draft.
const banned = { say: { never: ['brand new'] } };
check('a phrase on his never-say list kills it',
  cleanSayBack(GOOD.replace('cant guarantee it all lifts', 'itll look brand new'), DRAFT, banned), '');
check('…and the same text is fine when he never banned it',
  !!cleanSayBack(GOOD.replace('cant guarantee it all lifts', 'itll look brand new'), DRAFT, {}), true);

console.log('\n=== and the good one gets through ===');
check('the four-beat version survives every gate', cleanSayBack(GOOD, DRAFT), GOOD);

console.log('\n=== the playbook asks for the four beats, in order ===');
const PB = SRC.slice(SRC.indexOf('const SAY_BACK_PLAYBOOK'), SRC.indexOf('const SAY_BACK_SKIP_BUCKETS'));
check('1. name the thing back, never a pronoun', /Name the exact thing back[\s\S]*Never "that"/.test(PB), true);
check('2. tell them it is normal', /it is normal and he has seen it before/.test(PB), true);
check('3. say what he will actually do', /what he will actually DO/.test(PB), true);
check('4. end on the honest limit', /honest limit[\s\S]*Under-promise/.test(PB), true);
check('it is forbidden to promise a result', /NEVER promise a result/.test(PB), true);
check('it must still say everything his draft said', /still say everything his draft said/.test(PB), true);
// The prompt spends two paragraphs telling the model to add nothing, and then
// this section asks it to add four things. Without saying which field each rule
// governs, that is a contradiction — and a model handed a contradiction either
// refuses the say-back or lets it bleed into the polished text.
check('it says which field the no-adding rule governs', /governs "text"/.test(PB), true);
check('…and that it may not touch the polished text', /nothing in it may change "text"/.test(PB), true);

console.log('\n=== it rides the polish call, it does not add one ===');
const draftFn = lift('apiAiDraft');
check('one request, one model call', (draftFn.match(/aiGenerate\(/g) || []).length, 1);
check('the block is only built when there is something to say back', /saySrc\s*\?\s*SAY_BACK_PLAYBOOK/.test(draftFn), true);
check('switched off, it is not even in the prompt', /data\.say === false \? '' : sayBackSource/.test(draftFn), true);
check('and an ineligible draft returns no suggestion', /sayBack: saySrc \?/.test(draftFn), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
