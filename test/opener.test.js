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
  liftConst('DAY_PHRASE') + liftConst('PART_OF_DAY') + liftConst('CLOCK_TIME') +
  liftConst('SIZE_CLASS_RE') + liftConst('STREET_RE') + liftConst('VEHICLE_MAKES') + liftConst('MARQUE_RE') + liftConst('ASKS_VEHICLE') +
  liftConst('ASKS_NAME') + liftConst('HARD_TIME') + liftConst('normTime') +
  liftBlock('const DAY_FULL = {', '};') +
  liftBlock('const AI_TELLS = [', '];') +
  lift('tidyDayWord') + lift('matchPhrase') + lift('tidyName') + lift('greetName') +
  lift('tidyVehicleCase') + lift('readVehicle') + lift('missingVehiclePart') + lift('hasStreetAddress') +
  lift('quoteFacts') + lift('quoteWhen') + lift('quoteOpener') + lift('quoteCloser') +
  // findTell now also checks the owner's own "never say this" list, so the
  // say-rule helpers come with it.
  lift('sayDefaults') + lift('sayRules') + lift('sayNorm') + lift('sayBanned') + 
  lift('findTell') + lift('priceFigures') + lift('backedAmounts') + lift('findInventedPrice') +
  lift('agreedTimes') + lift('findInventedTime') + lift('openerFault') +
  'ctx.readVehicle = readVehicle; ctx.hasStreetAddress = hasStreetAddress;' +
  'ctx.quoteFacts = quoteFacts; ctx.quoteOpener = quoteOpener; ctx.quoteWhen = quoteWhen;' +
  'ctx.openerFault = openerFault; ctx.findInventedTime = findInventedTime; ctx.tidyDayWord = tidyDayWord;')(ctx);
const { quoteFacts, quoteOpener, quoteWhen, openerFault, findInventedTime, tidyDayWord, readVehicle, hasStreetAddress } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
// The opener is a sentence, so most assertions are about what is and isn't in it.
const open = (o) => quoteOpener(quoteFacts(o));
// The same submission with an explicit closing question. Which question the
// opener ends on is Mikey's setting now ("How I talk" → closer), so a test that
// wants a particular ending has to say which one it means.
const openWith = (o, closer) => quoteOpener(quoteFacts(o), { closer });
// The same submission with the reworded generic opener switched on.
const openAsk = (o) => quoteOpener(quoteFacts(o), { ask: true });
const asksForCar = (t) => /year, make, and model/i.test(t);
const questions = (t) => (t.match(/\?/g) || []).length;
// Real submissions, copied verbatim out of the quote-form notification emails.
const REAL = [
  ['Ben Di Qual', { name: 'Ben Di Qual', location: '98077', total: '349', vehicle: 'SUV / Truck',
    condition: 'Needs Work', services: 'Full Detail',
    notes: 'Also wants: 2025 Mazda CX-30. Mobile detail at 16218 223rd Ave NE, Woodinville. Friday Sep 18 morning preferred.' }],
  ['Scott Beebe', { name: 'Scott Beebe', location: '98296', total: '339', vehicle: '2023 jeep wrangler (SUV / Truck)',
    condition: 'Pretty Clean', services: 'Full Detail, Ceramic Wax',
    notes: 'Just got it back after five months after I was in an accident and I would like to get it clean.' }],
  ['Alison Bailey', { name: 'Alison Bailey', location: '98258', total: '399', vehicle: 'Acura RDX (SUV / Truck)',
    condition: 'War Zone', services: 'Full Detail, Carpet Shampoo',
    notes: 'Just purchased, great car but quite messy, even the seatbelts are stained' }],
  ['Ted Basrak', { name: 'Ted Basrak', location: '98290', total: '300', vehicle: '2013 Jeep Wrangler (SUV / Truck)',
    condition: 'War Zone', services: 'Interior Detail, Carpet Shampoo',
    notes: 'Seats need most work, cloth not looking for perfect just clean' }],
  ['noelle benepe', { name: 'noelle benepe', location: 'Snohomish', total: '349', vehicle: 'Ford bronco (SUV / Truck)',
    condition: 'Needs Work', services: 'Full Detail', notes: 'Some stains on seats and dog hair' }],
  ['Merlyn Wilson', { name: 'Merlyn Wilson', location: '98252', total: '300', vehicle: '2005 subaru outback (SUV / Truck)',
    condition: 'War Zone', services: 'Interior Detail, Carpet Shampoo' }],
  ['Meghan Watson', { name: 'Meghan Watson', location: '98290', total: '319', vehicle: '2022 ford bronco (SUV / Truck)',
    condition: 'Pretty Clean', services: 'Full Detail', notes: 'Pet hair' }],
  ['LINDA M.', { name: 'LINDA M.', location: '98133', total: '490', vehicle: 'SUV / Truck',
    condition: 'Needs Work', services: 'Interior Detail, Exterior Detail, Carpet Shampoo, Exterior Polish' }],
  ['Joju Eruppanal', { name: 'Joju Eruppanal', location: '98004', total: '290', vehicle: '2017 (Van / XL SUV)',
    condition: 'Needs Work', services: 'Interior Detail, Carpet Shampoo' }],
  ['Simon Chavez', { name: 'Simon Chavez', location: '98294', total: '230', vehicle: 'BMW (Sedan / Compact)',
    condition: 'Needs Work', services: 'Interior Detail' }],
  ['Shana Hainzinger', { name: 'Shana Hainzinger', location: 'Snohomish, 98290', total: '299',
    vehicle: '2023 Toyota RAV 4 XLE (Sedan / Compact)', condition: 'Pretty Clean', services: 'Full Detail' }],
];

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

console.log('\n=== the closing question is his to choose ===');
{
  const sub2 = { name: 'Dale Hobart', vehicle: '2019 Toyota Tacoma', total: '349' };
  const ends = (c) => openWith(sub2, c);
  check("'open' offers what he has free",  /Want me to send over what I've got open\?$/.test(ends('open')), true);
  check("'day' restores the old wording",  /What day were you looking to get it done\?$/.test(ends('day')), true);
  check("'part' asks morning or afternoon", /Is morning or afternoon better for you\?$/.test(ends('part')), true);
  check("'address' asks where to go",      /What's the address I'd be coming to\?$/.test(ends('address')), true);
  check("'none' asks nothing at all",      (ends('none').match(/\?/g) || []).length, 0);
  check("…and still ends on a full sentence", /\.$/.test(ends('none')), true);
  // Whatever he picks, the opener's own gate still has to pass it.
  for (const c of ['open', 'day', 'part', 'address', 'none']) {
    const t = ends(c);
    check(`'${c}' never asks for the car he gave`, asksForCar(t), false);
    check(`'${c}' asks at most one question`, questions(t) <= 1, true);
  }
  // A nameless lead still gets asked their name, whichever ending is chosen.
  for (const c of ['open', 'address', 'none']) {
    check(`'${c}' still asks a nameless lead their name`,
      /your name/i.test(openWith({ vehicle: '2019 Toyota Tacoma', total: '349' }, c)), true);
  }
}

console.log('\n=== they told us the car, so it never asks again ===');
{
  const t = open({ name: 'Dale Hobart', vehicle: '2019 Toyota Tacoma', total: '349' });
  check('the car is not asked for',    asksForCar(t), false);
  check('the car is read back',        /2019 Toyota Tacoma/.test(t), true);
  check('their price is read back',    /\$349/.test(t), true);
  check('exactly one question',        questions(t), 1);
  // Default closer is 'open'. It still moves toward getting a time booked, it
  // just no longer does it by asking "what day", which he asked never to send.
  check('and it moves toward booking', /what I've got open/i.test(t), true);
  check('…without asking what day',    /what day/i.test(t), false);
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
  /for the Full Interior/.test(open({ name: 'Dale', vehicle: '2019 Tacoma', services: 'Full Interior', total: '200' })), true);
check('a five-item receipt is not',
  /Headlight Restoration/.test(open({
    name: 'Dale', vehicle: '2019 Tacoma', total: '200',
    services: ['Full Interior', 'Exterior Wash', 'Wax', 'Engine Bay', 'Headlight Restoration'],
  })), false);

console.log('\n=== if they mentioned a day, the text says so ===');
{
  const t = open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', total: '349', notes: 'any chance you could do Saturday?' });
  check('Saturday comes back to them',      /hoping for Saturday/.test(t), true);
  check('nothing is promised about it',     /let me check what I've got open/.test(t), true);
  check('it does not claim to be free',     /(I have|I've got|I can do) Saturday/i.test(t), false);
  check('still exactly one question',       questions(t), 1);
  check('and it narrows the day',           /morning or afternoon/.test(t), true);
}
check('a shorthand day is spelled out',
  /hoping for Thursday/.test(open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', notes: 'thurs would be ideal' })), true);
check('the appointment box counts as a day',
  /hoping for tomorrow/.test(open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', appointment: 'tomorrow' })), true);
{
  // A time of day on its own is the opposite situation: they've told us WHEN in
  // the day, so the open question is which day.
  const t = open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', notes: 'mornings work best for me' });
  check('the time of day is acknowledged', /mornings work better for you/.test(t), true);
  check('and the question moves it forward', /what I've got open/i.test(t), true);
  check('one question',                    questions(t), 1);
}
check('a note about nothing timely does not invent a day',
  /hoping for/.test(open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', notes: 'I have a golden retriever, lots of hair' })), false);

{
  // They named a slot outright. Narrowing it to morning-or-afternoon would be
  // asking about something they already answered, so the question moves on.
  const t = open({ name: 'Lucy', vehicle: '2018 Subaru Outback', total: '379', appointment: 'Thursday 10am' });
  check('both halves of the slot come back', /down for Thursday at 10am/.test(t), true);
  check('it does not re-ask the time of day', /morning or afternoon/.test(t), false);
  check('it asks the thing the form never collects', /the address/.test(t), true);
  check('one question',                      questions(t), 1);
  check('and still promises nothing',        /let me check that against my week/.test(t), true);
}
check('a bare number is not a time',
  /down for /.test(open({ name: 'Dale', vehicle: '2019 Toyota Tacoma', notes: 'I have 2 cars' })), false);

console.log('\n=== the price reads like a price ===');
check('the dollar sign survives',
  /- \$349 for the Full Interior\./.test(open({ name: 'Dale', vehicle: '2019 Tacoma', total: '349', services: 'Full Interior' })), true);
check('the preposition is not doubled',
  /for the 2019 Tacoma for the/.test(open({ name: 'Dale', vehicle: '2019 Tacoma', total: '349', services: 'Full Interior' })), false);
check('services with no price still read right',
  /- Full Interior\./.test(open({ name: 'Dale', vehicle: '2019 Tacoma', services: 'Full Interior' })), true);

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
  { name: 'Dale', vehicle: '2019 Tacoma', total: '349' },
  { name: 'Ruth', vehicle: '2014 Honda CR-V', total: '280', notes: 'could you do Saturday?' },
  { name: 'Lucy', vehicle: '2018 Subaru Outback', total: '379', appointment: 'Thursday 10am' },
  { vehicle: 'Tesla Model Y', total: '349' },
]) {
  check('the flag leaves "' + (sub.vehicle || '?') + '" alone', open(sub) === openAsk(sub), true);
}

console.log('\n=== real submissions, taken off the quote form ===');
// Every case below is a REAL submission, copied out of the Web3Forms notification
// emails. They are here because four separate defects survived every invented
// test above and only showed up when the actual data was looked at - the form
// does not hand over "the car", it hands over a pricing bucket with whatever the
// customer typed glued to the front.

console.log('\n-- the size bucket is Mikey\'s, not the customer\'s --');
for (const [raw, want, full] of [
  ['2023 jeep wrangler (SUV / Truck)',        '2023 Jeep Wrangler', true],
  ['Acura RDX (SUV / Truck)',                 'Acura RDX',          true],
  ['2023 Toyota RAV 4 XLE (Sedan / Compact)', '2023 Toyota RAV 4 XLE', true],
  ['Ford bronco (SUV / Truck)',               'Ford Bronco',        true],
  ['2005 subaru outback (SUV / Truck)',       '2005 Subaru Outback', true],
  ['BMW (Sedan / Compact)',                   'BMW',                false],
  ['2017 (Van / XL SUV)',                     '2017',               false],
  ['SUV / Truck',                             '',                   false],
  ['Sedan / Compact',                         '',                   false],
  ['Van / XL SUV',                            '',                   false],
]) {
  const v = readVehicle(raw);
  check(`"${raw}" reads as "${want}"`, v.name, want);
  check(`  ...and is ${full ? 'enough' : 'NOT enough'} to price by`, v.full, full);
}
check('the bucket is kept, not thrown away', readVehicle('Acura RDX (SUV / Truck)').sizeClass, 'SUV / Truck');
check('a bare bucket is still kept as one',  readVehicle('SUV / Truck').sizeClass, 'SUV / Truck');
// The casing rule is per word, because the all-or-nothing one would wreck these.
check('BMW does not become Bmw',   readVehicle('BMW (Sedan / Compact)').name, 'BMW');
check('RAV 4 XLE survives intact', readVehicle('2023 Toyota RAV 4 XLE (Sedan / Compact)').name, '2023 Toyota RAV 4 XLE');

console.log('\n-- no bucket ever reaches a customer --');
for (const [who, sub] of REAL) {
  const t = open(sub);
  check(`${who}: no "(SUV / Truck)" in the text`, /\(?(SUV|Sedan|Van)\s*\/\s*(Truck|Compact|XL SUV)\)?/.test(t), false);
  check(`${who}: exactly one question`, questions(t), 1);
  check(`${who}: never quotes the condition label`, /war zone/i.test(t), false);
}

console.log('\n-- a bucket with no car still asks for the car --');
{
  // LINDA M. picked four services and got a $490 quote with vehicle = "SUV / Truck".
  const t = open({ name: 'LINDA M.', total: '490', vehicle: 'SUV / Truck',
    services: 'Interior Detail, Exterior Detail, Carpet Shampoo, Exterior Polish' });
  check('it asks what the car is',        /year, make and model\?$/.test(t), true);
  check('it does not pretend to know it', /for the SUV/.test(t), false);
  check('and her $490 is not thrown away', /\$490/.test(t), true);
}
{
  // Joju gave a year and nothing else.
  const t = open({ name: 'Joju Eruppanal', total: '290', vehicle: '2017 (Van / XL SUV)', services: 'Interior Detail, Carpet Shampoo' });
  check('the year is read back',       /for the 2017/.test(t), true);
  check('and only the rest is asked',  /the make and model\?$/.test(t), true);
}
{
  // Simon typed a marque on its own - so the model is missing, not the make.
  const t = open({ name: 'Simon Chavez', total: '230', vehicle: 'BMW (Sedan / Compact)', services: 'Interior Detail' });
  check('it never asks for the make he gave', /make/.test(t), false);
  check('it asks for what is missing',        /the year and model\?$/.test(t), true);
}
check('a model typed alone asks for the make, not the model',
  /the year and make\?$/.test(open({ name: 'Pat', vehicle: 'Tacoma', total: '200' })), true);

console.log('\n-- an empty vehicle box is not the same as a bucket --');
// The lead who never touched the box is the cold submission the legacy opener
// was written for, and cfg.quoteOpenerAsk still governs her wording. The lead
// whose entry came through as nothing but a bucket has a price and services that
// the legacy line would throw away.
{
  const cold = open({ total: '350' });
  check('an untouched box still gets the legacy text', /Talk soon!$/.test(cold), true);
  check('and still asks for name and car',             /your name and the year/.test(cold), true);
  const bucket = open({ total: '350', vehicle: 'SUV / Truck' });
  check('a bucket-only box does not',                  /Talk soon!/.test(bucket), false);
  check('it acknowledges the price instead',           /\$350/.test(bucket), true);
  check('and asks the one missing thing',              questions(bucket), 1);
}

console.log('\n-- Ben Di Qual: day, time of day, address and no car --');
{
  const ben = REAL.find(([w]) => w === 'Ben Di Qual')[1];
  const t = open(ben);
  check('it stops asking morning-or-afternoon when he said morning',
    /morning or afternoon/.test(t), false);
  check('it reads his slot back',        /down for Friday morning/.test(t), true);
  check('it knows he sent an address',   /at the address you sent/.test(t), true);
  check('it does not ask for that address', /What's the address/.test(t), false);
  check('it asks the one thing he never said', /the year, make and model\?$/.test(t), true);
  check('one question',                  questions(t), 1);
  check('and it still promises him nothing', /let me check that against my week/.test(t), true);
}
check('an address with a real car confirms instead of asking',
  /Have I got that right\?$/.test(open({ name: 'Ben', vehicle: '2025 Mazda CX-30', total: '349',
    notes: 'Mobile detail at 16218 223rd Ave NE, Woodinville. Friday Sep 18 morning preferred.' })), true);

console.log('\n-- the address reader is deliberately hard to fool --');
check('a real street address is found',  hasStreetAddress('16218 223rd Ave NE, Woodinville'), true);
check('so is a plain one',               hasStreetAddress('please come to 402 Maple Street'), true);
check('a zip code is not an address',    hasStreetAddress('98077'), false);
check('nor is a price',                  hasStreetAddress('quote was 349 dollars'), false);
check('nor is a year and a make',        hasStreetAddress('2019 Toyota Tacoma'), false);

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
