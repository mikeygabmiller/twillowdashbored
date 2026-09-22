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
//   node test/expand.test.js
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
  constant('EXPAND_MONEY') + lift('cleanExpand') +
  constant('EXPAND_SETTLED') + lift('expandSource') +
  'ctx.cleanExpand = cleanExpand; ctx.expandSource = expandSource; ctx.voiceBucket = voiceBucket;'
)(ctx);
const { cleanExpand, expandSource } = ctx;

const inbound = (body) => ({ messages: [{ dir: 'in', body }] });
const DRAFT = 'yea i can clean that';
const THEIRS = 'my kid dumped juice all over the back seat';
const GOOD =
  "yea the juice on the back seat is one of the most common ones i get. " +
  "i'll hit that seat with a hot water extraction and go over the whole bench. " +
  "cant guarantee it all lifts but i'll get out as much as i can";

console.log('\n=== there has to be something to say back ===');
check('a customer who named a problem is worth answering properly',
  !!expandSource(inbound('my kid dumped juice all over the back seat'), DRAFT), true);
check('"k" names nothing',
  expandSource(inbound('k'), DRAFT), '');
check('"thanks!" names nothing either',
  expandSource(inbound('thanks!'), DRAFT), '');
// Inbound only. He asked for this on replies, and there is nothing to hear in a
// text he started himself.
check('his own last word means there is nothing to hear',
  expandSource({ messages: [{ dir: 'out', body: 'heading your way now, see you in 20' }] }, DRAFT), '');
check('an empty thread is not a conversation',
  expandSource({ messages: [] }, DRAFT), '');

console.log('\n=== it stays out of exchanges that are already finished ===');
// Judged from THEIR side. Nothing was asked and nothing was told, so there is
// nothing to expand on.
check('a customer who already agreed has nothing left to hear',
  expandSource(inbound('sounds good, see you at 2'), 'omw'), '');
check('nor does a thank-you at the end of a job',
  expandSource(inbound('thanks so much, it looks amazing'), 'glad you like it'), '');

console.log('\n=== the screenshot that sent this back for a rebuild ===');
// A real exchange. He had asked for year/make/model; they answered with three
// vehicles and "all just interior detail"; he drafted a correct, useful, THIN
// question. The chip never appeared.
//
// The cause was house style eating the feature. His own playbook tells him to
// open the quote reply with one beat of warmth — "Perfect!", "Sounds good!",
// "Awesome!" — and voiceBucket files anything starting that way as `confirm`,
// which the old draft-side skip list threw away. So the single most valuable
// text of the sale was the one message guaranteed never to get an offer.
const THREE_CARS = '2018 Toyota Highlander 2024 Honda HRV 2012 ford econoline E-350 All just interior detail';
const HIS_DRAFT = "Perfect. How's the condition of those cars?";
check('their message is something to work from',
  expandSource(inbound(THREE_CARS), HIS_DRAFT), THREE_CARS);
check('opening with "Perfect." no longer throws the offer away',
  !!expandSource(inbound(THREE_CARS), HIS_DRAFT), true);
// Every warmth opener his playbook recommends, since any of them would have hit
// the same bucket and the same bug.
for (const opener of ['Perfect.', 'Sounds good!', 'Awesome!', 'Great!', 'Yep,', 'Got it,']) {
  check(`"${opener}" still gets an offer`,
    !!expandSource(inbound(THREE_CARS), opener + ' how are they looking inside?'), true);
}
// And the fix that makes move 1 possible at all: saying "the E-350" back uses
// digits from THEIR message, not his draft. His draft has no digits whatsoever,
// so the first version of the number rule would have rejected the one sentence
// the whole feature exists to produce.
const EXPANDED = "Perfect, so that's the Highlander, the HRV and the E-350, all interiors. " +
  "The van's a big one inside so I'd give that its own chunk of time. How are they looking in there? " +
  "A photo or just a quick description is fine, doesn't have to be detailed, I just want to know if " +
  "there's anything out of the ordinary from normal use.";
check('their own model numbers can be said back to them',
  cleanExpand(EXPANDED, HIS_DRAFT, THREE_CARS), EXPANDED);
check('…but a number neither of them wrote is still refused',
  cleanExpand(EXPANDED + ' ill be there at 730', HIS_DRAFT, THREE_CARS), '');
// The money gate still holds over the widened number rule: a figure they
// mentioned cannot ride in as a price, because anything talking about cost is
// dropped before the digits are ever looked at.
check('a price they mentioned still cannot come back as one',
  cleanExpand('so thats the Highlander and the HRV, 300 dollars all in', HIS_DRAFT, 'quoted me 300 somewhere else'), '');

console.log('\n=== no money, ever — he said no upsell and this is how that holds ===');
check('a price is refused outright', cleanExpand(GOOD + ". that's $40", DRAFT, THEIRS), '');
check('"add-on" is an upsell even without a number', cleanExpand(GOOD + ', its an add-on', DRAFT, THEIRS), '');
check('so is "a little extra"', cleanExpand(GOOD + ', costs a little extra', DRAFT, THEIRS), '');
check('and so is a discount', cleanExpand(GOOD + " i'll do you a discount", DRAFT, THEIRS), '');

console.log('\n=== it cannot invent a fact he did not write ===');
// A method is the model's to supply. A time is not.
check('a time he never said is refused', cleanExpand(GOOD + " i'll be there at 9", DRAFT, THEIRS), '');
check('a number he DID write is fine',
  !!cleanExpand('ill be there at 9 and ' + GOOD, 'ill be there at 9', THEIRS), true);

console.log('\n=== it has to sound like him ===');
check('corporate filler is dropped, not repaired',
  cleanExpand('I understand your concern. ' + GOOD, DRAFT, THEIRS), '');
check('an em-dash is a tell too', cleanExpand('yea — ' + GOOD, DRAFT, THEIRS), '');
check('an email-length answer is not a text', cleanExpand(GOOD.repeat(4), DRAFT, THEIRS), '');
check('handing back his own draft is not a suggestion', cleanExpand(DRAFT, DRAFT, THEIRS), '');
check('nothing to say is a real answer', cleanExpand('', DRAFT, THEIRS), '');

console.log('\n=== his own ban list outranks anything the model likes ===');
// A phrase he banned by hand is banned in a suggestion too — this is a message
// he would send, not an internal draft.
const banned = { say: { never: ['brand new'] } };
check('a phrase on his never-say list kills it',
  cleanExpand(GOOD.replace('cant guarantee it all lifts', 'itll look brand new'), DRAFT, THEIRS, banned), '');
check('…and the same text is fine when he never banned it',
  !!cleanExpand(GOOD.replace('cant guarantee it all lifts', 'itll look brand new'), DRAFT, THEIRS, {}), true);

console.log('\n=== and the good one gets through ===');
check('the four-beat version survives every gate', cleanExpand(GOOD, DRAFT, THEIRS), GOOD);

console.log('\n=== the playbook asks for the three moves, in order ===');
// The playbook is one long string built by concatenation, so a rule can land
// with a line break in the middle of it. Testing the raw source therefore tests
// the FILE'S WRAPPING as much as the prompt — an assertion can fail because an
// editor rewrapped a line. Rejoin the pieces first so every check below reads
// the prompt the model actually receives.
const PB = SRC.slice(SRC.indexOf('const EXPAND_PLAYBOOK'), SRC.indexOf('const EXPAND_SETTLED'))
  .replace(/'\s*\+\s*\n\s*'/g, '');
check('1. say back what he heard', /SAY BACK WHAT HE HEARD/.test(PB), true);
check('…and bans the pronoun that proves nobody read it', /never "that"/.test(PB), true);
check('2. one concrete thought that proves he pictured the job', /PROVES HE PICTURED THE JOB/.test(PB), true);
check('…branching on what they actually said', /They gave him details[\s\S]*what those details MEAN/.test(PB), true);
check('…and skipped rather than padded when nothing is true', /skip this move rather than pad it/.test(PB), true);
check('3. make the ask easy and say why', /MAKE HIS ASK EASY, AND SAY WHY/.test(PB), true);
check('the honest limit rides along when a result is in doubt', /RIDER[\s\S]*Under-promise/.test(PB), true);
check('it is forbidden to promise a result', /NEVER promise a result/.test(PB), true);
check('it must still do everything his draft did', /still do everything his draft did/.test(PB), true);
check('it says which field the no-adding rule governs', /governs "text"/.test(PB), true);
check('…and that it may not touch the polished text', /nothing in it may change "text"/.test(PB), true);
// The worked example is the screenshot that sent this back for a rebuild. A
// prompt that only describes a shape gets a different shape; one that shows the
// shape gets that one.
check('the shape is shown, not just described', PB.includes('the Highlander, the HRV and the E-350'), true);

console.log('\n=== how it is told to sound like him ===');
// The first version asserted "his lowercase, his casual rhythm". That was a
// guess, and the text he actually sent read "Not sure if it would be prudent to
// do them all in the same day, but I'm happy to tackle them nonetheless." The
// prompt already carries real counts from his real texts; a hardcoded guess
// sitting below them just overrode measured evidence with an assumption.
check('it defers to the measured counts', /measured style block[\s\S]*COUNTS FROM HIS REAL TEXTS/.test(PB), true);
check('it no longer asserts he writes lowercase', /his lowercase/.test(PB), false);
check('…and says so out loud, because the assumption is the common one',
  /Do not assume he writes in lowercase/.test(PB), true);
// The other half of that: the measured block caps length, and an expansion is
// longer than his median by definition. Both rules in one prompt with no
// ordering between them is a coin flip.
check('the length conflict is resolved explicitly', /LENGTH IS THE ONE EXCEPTION/.test(PB), true);
check('…and the cap is said to govern the polish, not this', /It does NOT govern this field/.test(PB), true);

console.log('\n=== and not to sound like a template ===');
check('it says the moves are not a running order', /not a running order to fill/.test(PB), true);
check('a move that does not earn its place is dropped', /Drop any move that does not earn its place/.test(PB), true);
check('filler is refused by name', /Filler is worse than the short draft/.test(PB), true);
check('there are two examples, not one', PB.includes('A. They listed details') && PB.includes('B. They named a problem'), true);
check('…deliberately different shapes', /does NOT open by listing anything back/.test(PB), true);
// The examples are a shape to copy, but HIS phrases are the target — "a photo or
// just a quick explanation is fine" is his own line out of his own playbook, and
// an earlier draft of this rule banned it as an example lift, which is backwards.
check('his own phrasing is protected from the anti-copy rule',
  /Phrases that appear in HIS real texts or his own playbook are a different matter/.test(PB), true);

console.log('\n=== it rides the polish call, it does not add one ===');
const draftFn = lift('apiAiDraft');
check('one request, one model call', (draftFn.match(/aiGenerate\(/g) || []).length, 1);
check('the block is only built when there is something to expand on', /expandBlock = expandSrc\s*\?\s*EXPAND_PLAYBOOK/.test(draftFn), true);
check('switched off, it is not even in the prompt', /data\.expand === false \? '' : expandSource/.test(draftFn), true);
check('and an ineligible draft returns no suggestion', /expand: expandSrc \?/.test(draftFn), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
