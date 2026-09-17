// The first text a quote-form lead gets.
//
// It used to be one sentence for everybody — "send over the year, make, and model
// of the car you'd like detailed" — which was the right text for a submission
// carrying nothing but a phone number, and the wrong one for every other kind.
// Someone who picked their vehicle and typed "any chance you could do Saturday?"
// got asked for the car they had just named, and nothing back about Saturday.
//
// So the two things this suite holds down are the two things Mikey asked for:
//   1. never ask them for something they already sent
//   2. acknowledge what they did send, then finish on exactly ONE question
//
// The second half is the gate on the AI version of the same text. That draft goes
// to a real customer's real phone with nobody having read it, so the tests here
// are the ones that decide whether a draft is allowed out at all.
//
//   node test/opener.test.js
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
// The const declarations the lifted functions close over.
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [^\\n]*$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0] + '\n';
}
function liftBlock(startsWith, endsWith) {
  const a = SRC.indexOf(startsWith);
  if (a < 0) throw new Error(`block ${startsWith} not found`);
  const b = SRC.indexOf(endsWith, a);
  if (b < 0) throw new Error(`end of block ${startsWith} not found`);
  return SRC.slice(a, b + endsWith.length) + '\n';
}

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx',
  liftConst('DAY_PHRASE') + liftConst('PART_OF_DAY') + liftConst('CLOCK_TIME') + liftConst('ASKS_VEHICLE') +
  liftConst('ASKS_NAME') + liftConst('HARD_TIME') + liftConst('normTime') +
  liftBlock('const DAY_FULL = {', '};') +
  liftBlock('const AI_TELLS = [', '];') +
  lift('tidyDayWord') + lift('matchPhrase') + lift('tidyName') + lift('greetName') +
  lift('quoteFacts') + lift('quoteWhen') + lift('quoteOpener') +
  lift('findTell') + lift('priceFigures') + lift('backedAmounts') + lift('findInventedPrice') +
  lift('agreedTimes') + lift('findInventedTime') + lift('openerFault') +
  'ctx.quoteFacts = quoteFacts; ctx.quoteOpener = quoteOpener; ctx.quoteWhen = quoteWhen;' +
  'ctx.openerFault = openerFault; ctx.findInventedTime = findInventedTime; ctx.tidyDayWord = tidyDayWord;')(ctx);
const { quoteFacts, quoteOpener, quoteWhen, openerFault, findInventedTime, tidyDayWord } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
// The opener is a sentence, so most assertions are about what is and isn't in it.
const open = (o) => quoteOpener(quoteFacts(o));
// The same submission with the reworded generic opener switched on.
const openAsk = (o) => quoteOpener(quoteFacts(o), { ask: true });
const asksForCar = (t) => /year, make, and model/i.test(t);
const questions = (t) => (t.match(/\?/g) || []).length;

console.log('\n=== a submission with nothing but a number still gets the old text ===');
{
  const t = open({ phone: '4255550100' });
  check('it asks for the car',              asksForCar(t), true);
  check('it asks for the name too',         /your name and /.test(t), true);
  check('it greets them like a person',     /^Hey there, it's Mikey\./.test(t), true);
}
{
  const t = open({ name: 'DALE HOBART' });
  check('a named lead is not asked their name', /your name and /.test(t), false);
  check('their name is straightened first',     /^Hey Dale, it's Mikey\./.test(t), true);
  check('it still asks for the car',            asksForCar(t), true);
}

console.log('\n=== they told us the car, so it never asks again ===');
{
  const t = open({ name: 'Dale Hobart', vehicle: '2019 Toyota Tacoma', total: '349' });
  check('the car is not asked for',    asksForCar(t), false);
  check('the car is read back',        /2019 Toyota Tacoma/.test(t), true);
  check('their price is read back',    /\$349/.test(t), true);
  check('exactly one question',        questions(t), 1);
  check('and it moves toward a day',   /what day/i.test(t), true);
}
{
  // Car but no name: the name still has to be asked for, and still inside the
  // single question, because two question marks is two things to answer.
  const t = open({ vehicle: '2019 Toyota Tacoma', total: '349' });
  check('a nameless lead is still asked',  /your name/i.test(t), true);
  check('but it is still one question',    questions(t), 1);
  check('and never asks for the car',      asksForCar(t), false);
}

console.log('\n=== short service lists are read back, long ones are not ===');
check('a short list is echoed',
  /for the Full Interior/.test(open({ name: 'Dale', vehicle: 'Tacoma', services: 'Full Interior', total: '200' })), true);
check('a five-item receipt is not',
  /Headlight Restoration/.test(open({
    name: 'Dale', vehicle: 'Tacoma', total: '200',
    services: ['Full Interior', 'Exterior Wash', 'Wax', 'Engine Bay', 'Headlight Restoration'],
  })), false);

console.log('\n=== if they mentioned a day, the text says so ===');
{
  const t = open({ name: 'Dale', vehicle: 'Tacoma', total: '349', notes: 'any chance you could do Saturday?' });
  check('Saturday comes back to them',      /hoping for Saturday/.test(t), true);
  check('nothing is promised about it',     /let me check what I've got open/.test(t), true);
  check('it does not claim to be free',     /(I have|I've got|I can do) Saturday/i.test(t), false);
  check('still exactly one question',       questions(t), 1);
  check('and it narrows the day',           /morning or afternoon/.test(t), true);
}
check('a shorthand day is spelled out',
  /hoping for Thursday/.test(open({ name: 'Dale', vehicle: 'Tacoma', notes: 'thurs would be ideal' })), true);
check('the appointment box counts as a day',
  /hoping for tomorrow/.test(open({ name: 'Dale', vehicle: 'Tacoma', appointment: 'tomorrow' })), true);
{
  // A time of day on its own is the opposite situation: they've told us WHEN in
  // the day, so the open question is which day.
  const t = open({ name: 'Dale', vehicle: 'Tacoma', notes: 'mornings work best for me' });
  check('the time of day is acknowledged', /mornings work better for you/.test(t), true);
  check('and the question becomes the day', /what day/i.test(t), true);
  check('one question',                    questions(t), 1);
}
check('a note about nothing timely does not invent a day',
  /hoping for/.test(open({ name: 'Dale', vehicle: 'Tacoma', notes: 'I have a golden retriever, lots of hair' })), false);

{
  // They named a slot outright. Narrowing it to morning-or-afternoon would be
  // asking about something they already answered, so the question moves on.
  const t = open({ name: 'Lucy', vehicle: 'Outback', total: '379', appointment: 'Thursday 10am' });
  check('both halves of the slot come back', /after Thursday at 10am/.test(t), true);
  check('it does not re-ask the time of day', /morning or afternoon/.test(t), false);
  check('it asks the thing the form never collects', /the address/.test(t), true);
  check('one question',                      questions(t), 1);
  check('and still promises nothing',        /let me check that against my day/.test(t), true);
}
check('a bare number is not a time',
  /after /.test(open({ name: 'Dale', vehicle: 'Tacoma', notes: 'I have 2 cars, both 2019' })), false);

console.log('\n=== the price reads like a price ===');
check('the dollar sign survives',
  /- \$349 for the Full Interior\./.test(open({ name: 'Dale', vehicle: 'Tacoma', total: '349', services: 'Full Interior' })), true);
check('the preposition is not doubled',
  /for the Tacoma for the/.test(open({ name: 'Dale', vehicle: 'Tacoma', total: '349', services: 'Full Interior' })), false);
check('services with no price still read right',
  /- Full Interior\./.test(open({ name: 'Dale', vehicle: 'Tacoma', services: 'Full Interior' })), true);

console.log('\n=== reading a day out of what they typed ===');
check('sat -> Saturday',          tidyDayWord('sat'), 'Saturday');
check('SATURDAY -> Saturday',     tidyDayWord('SATURDAY'), 'Saturday');
check('tomorrow is left alone',   tidyDayWord('Tomorrow'), 'tomorrow');
check('nothing stays nothing',    tidyDayWord(''), '');
check('a date is a day',          quoteWhen({ notes: 'how about 9/20', appointment: '' }).day, '9/20');
check('"satisfied" is not Saturday', quoteWhen({ notes: 'I want to be satisfied', appointment: '' }).day, '');
check('"sunroof" is not Sunday',     quoteWhen({ notes: 'it has a sunroof', appointment: '' }).day, '');
// The three abbreviations that are also ordinary words. Reading a day out of one
// of these sends somebody a text about a Saturday they never brought up.
check('a car that "sat outside" asked for nothing',
  quoteWhen({ notes: 'it sat outside all winter', appointment: '' }).day, '');
check('"bakes in the sun" is not Sunday',
  quoteWhen({ notes: 'the dash bakes in the sun', appointment: '' }).day, '');
check('but "sat." with a period is Saturday',
  quoteWhen({ notes: 'sat. or sun. works', appointment: '' }).day, 'Saturday');
check('and the unambiguous shorthand still works bare',
  quoteWhen({ notes: 'thurs works for me', appointment: '' }).day, 'Thursday');

console.log('\n=== the reworded generic opener (cfg.quoteOpenerAsk) ===');
// The one branch that did not end on a question. Everything about it is opt-in:
// with the flag off, not one character may move.
{
  const now = open({ phone: '4255550100' });
  check('off, the old text is untouched, word for word',
    now, "Hey there, it's Mikey. I got your quote submission on my site. Whenever you have a minute, " +
         "feel free to send over your name and the year, make, and model of the car you'd like detailed, " +
         "and I'll confirm that price. Talk soon!");
  check('off, it ends on the sign-off',   /Talk soon!$/.test(now), true);
  check('off, it asks no question',       questions(now), 0);
}
{
  const t = openAsk({ phone: '4255550100' });
  check('on, it ends on a real question',  /\?$/.test(t), true);
  check('on, exactly one question',        questions(t), 1);
  check('on, the sign-off is gone',        /Talk soon/.test(t), false);
  check('on, it still asks for the car',   asksForCar(t) || /year, make and model/.test(t), true);
  check('on, a nameless lead is still asked their name', /your name/i.test(t), true);
  check('on, it still says who is texting', /^Hey there, it's Mikey\./.test(t), true);
}
{
  const t = openAsk({ name: 'Dale Hobart' });
  check('on, a named lead is not asked their name', /your name/i.test(t), false);
  check('on, they are greeted by first name',       /^Hey Dale, it's Mikey\./.test(t), true);
  check('on, one question',                         questions(t), 1);
}
// The flag only ever touches the no-vehicle branch; every other version already
// ended on a question and must be byte-identical either way.
for (const sub of [
  { name: 'Dale', vehicle: 'Tacoma', total: '349' },
  { name: 'Ruth', vehicle: 'CR-V', total: '280', notes: 'could you do Saturday?' },
  { name: 'Lucy', vehicle: 'Outback', total: '379', appointment: 'Thursday 10am' },
  { vehicle: 'Model Y', total: '349' },
]) {
  check('the flag leaves "' + (sub.vehicle || '?') + '" alone', open(sub) === openAsk(sub), true);
}

console.log('\n=== the gate on the AI version ===');
// Everything below is a draft the model could plausibly return. The gate has to
// let the good one through and name the fault in every bad one.
const FACTS = quoteFacts({ name: 'Dale Hobart', vehicle: '2019 Toyota Tacoma', total: '349', notes: 'could you do Saturday?' });
const SRC_PRICES = ['$349'];
const good = "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma at $349, and I saw you asked about Saturday. Let me look at what I've got - is morning or afternoon better for you?";
check('a good draft passes clean', openerFault(good, FACTS, SRC_PRICES), '');

const faults = [
  ['empty', '', /empty/],
  ['too short', 'Hey Dale!', /too short/],
  ['too long', "Hey Dale, it's Mikey. " + 'x'.repeat(340) + '?', /characters/],
  ['anonymous', "Hey Dale, got your quote for the 2019 Tacoma at $349. What day works for you?", /who is texting/],
  ['an AI tell', "Hey Dale, it's Mikey. Thank you for reaching out about the 2019 Tacoma at $349. What day works?", /dead giveaway/],
  ['an invented price', "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma, should be about $425. What day works for you?", /\$425/],
  ['no question', "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma at $349. I'll get back to you soon.", /asks them nothing/],
  ['two questions', "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma at $349. What day works for you? And where are you parked?", /asks 2 questions/],
  ['asking for the car again', "Hey Dale, it's Mikey. Got your quote for $349. Send over the year, make, and model and I'll confirm it?", /already told you/],
  ['asking their name again', "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma at $349. Sorry, what's your name?", /already gave it/],
  ['promising a day he never agreed to', "Hey Dale, it's Mikey. Got your quote for the 2019 Tacoma at $349. I've got Tuesday at 10 open, want it?", /has not agreed to/],
];
for (const [label, draft, want] of faults) {
  check(`it refuses ${label}`, want.test(openerFault(draft, FACTS, SRC_PRICES)), true);
}
check('but the day THEY named is allowed straight back',
  openerFault(good, FACTS, SRC_PRICES), '');
check('a nameless lead may still be asked their name',
  openerFault("Hey there, it's Mikey. Got your quote for the 2019 Tacoma at $349. Who am I talking to, and what day were you thinking?",
    quoteFacts({ vehicle: '2019 Toyota Tacoma', total: '349' }), SRC_PRICES), '');
check('morning/afternoon is a question, not a promise',
  findInventedTime('is morning or afternoon better for you?', ['']), '');
check('a weekday they never mentioned is caught',
  findInventedTime('how does Tuesday look?', ['could you do saturday']), 'Tuesday');
check('a spacing difference is not an invented time',
  findInventedTime('I saw you were after 10am.', ['thursday at 10 am if possible']), '');
check('the weekday they DID mention is fine, even in shorthand',
  findInventedTime('I saw you asked about Thursday.', ['thurs would be great']), '');

console.log('\n=== both endpoints go through it, and it can never leave them textless ===');
const compose = lift('composeQuoteOpener');
check('the plain opener is built first, always',  /const plain = quoteOpener\(f, \{ ask:/.test(compose), true);
check('the AI half is off unless switched on',    /cfg\.smartQuoteOpener !== true/.test(compose), true);
check('and is skipped with no AI key at all',     /!aiConfigured\(\)/.test(compose), true);
check('a slow model loses to the template',       /Promise\.race/.test(compose), true);
check('so does a thrown one',                     /catch \(err\)/.test(compose), true);
check('an empty draft falls back',                /return smart \|\| plain;/.test(compose), true);
// The drafting moved into draftQuoteOpener so the preview screen can see the
// refusal reason; smartQuoteOpener is now the thin wrapper the live path uses.
const smart = lift('draftQuoteOpener');
const wrap = lift('smartQuoteOpener');
check('a faulty draft gets exactly one retry',    (smart.match(/aiGenerate\(/g) || []).length, 2);
check('the draft reports WHY it was refused',     /refused: true/.test(smart), true);
check('and the live path drops a refused draft',  /d\.refused \? '' :/.test(wrap), true);
check('the reach-out is still only ever queued, never sent here',
  /twilioSend|sendSms/.test(lift('composeQuoteOpener') + smart + wrap), false);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
