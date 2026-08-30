// The quote reply — the text Mikey sends the moment a customer answers the intro
// message with their vehicle. Replaying six real moments through the live app
// showed three separate ways it was going wrong, and each one has a check here:
//
//   (a) the moment wasn't recognised. "2024 Ram 3500 crew cab diesel." scored as
//       `quick`, so the model was shown "Ready!" and "Be there in 20!" as the
//       texts to imitate and wrote a one-liner for the most important message of
//       the sale.
//   (b) prices were invented. It produced $490 where he charged $450, $399 where
//       he charged $380, and $429 for a truck whose condition it had never been
//       told. A quoted customer is a quoted customer.
//   (c) the shape gate fought his real writing. His quote replies run 3-5
//       sentences and 171-313 characters; the length rule was measured against a
//       median dragged down by "Ready!", and the tell-blocker banned "feel free
//       to" — his own phrase, in his own fingerprint, in his own sent texts.
//
//   node test/quotereply.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let p = SRC.indexOf('(', SRC.indexOf(`function ${name}(`)), pd = 0, bodyStart = -1;
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
const grab = (re, what) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find ${what} in src/index.js`);
  return m[0];
};

const ctx = {};
new Function('ctx',
  grab(/const VEHICLE_MAKES = .*;/, 'VEHICLE_MAKES') +
  grab(/const AI_TELLS = \[[\s\S]*?\n\];/, 'AI_TELLS') +
  lift('mentionsVehicle') + lift('voiceBucket') +
  lift('priceFigures') + lift('backedAmounts') + lift('findInventedPrice') +
  lift('findTell') + lift('styleViolation') + lift('defaultPlaybook') +
  'ctx.voiceBucket=voiceBucket;ctx.findInventedPrice=findInventedPrice;ctx.findTell=findTell;' +
  'ctx.styleViolation=styleViolation;ctx.defaultPlaybook=defaultPlaybook;')(ctx);
const { voiceBucket, findInventedPrice, findTell, styleViolation, defaultPlaybook } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// ---------------------------------------------------------------------------
console.log('\n-- the quote moment is recognised as one --');
// Every one of these is a real customer message from a real thread; every one of
// them used to bucket as `quick` or `general`.
check('year + make + model',      voiceBucket('2024 Ram 3500 crew cab diesel.'), 'price');
check('model buried in a sentence', voiceBucket('Son in laws 2013 Jeep Wrangler. Looking for interior detail with focus on cloth seats'), 'price');
check('year after a greeting',    voiceBucket("Hello! It's a 2009 Acura RDX"), 'price');
check('a bare body type',         voiceBucket('Truck'), 'price');
check('thanks first, vehicle after', voiceBucket("Thanks! It's a 2009 Acura RDX"), 'price');

console.log('\n-- and the buckets around it still hold --');
// "my truck" inside a goodbye is a goodbye. This is the case that decides where
// the vehicle check sits in the chain, so it is the one most worth pinning down.
check('a goodbye that mentions a truck', voiceBucket('Thank you so much for replying. I ended up getting scheduled with someone else. However, I appreciate you making the effort to try to fit my truck in.'), 'closing');
check('a day and time still schedules', voiceBucket('How does Friday morning sound? 10ish?'), 'schedule');
check('a bare yes still confirms',      voiceBucket('Perfect!'), 'confirm');
check('a street address is not a car',  voiceBucket('2117 8th Pl Snohomish Stephen and Kayla Buerger'), 'general');
check('nor is a 5-digit house number',  voiceBucket('Susan Rich 18740 Mountain View Rd NE Duvall WA.'), 'general');

// ---------------------------------------------------------------------------
console.log('\n-- invented prices are caught --');
const pb = ['Interior Detail starts at $200, exterior at $130, full in-and-out $260. Carpet Shampoo +$20.'];
// The three numbers the live model actually produced at these moments.
check('$490 where he charged $450', findInventedPrice('an Interior Detail, Exterior Detail and Ceramic Wax will be $490', pb), '$490');
check('$399 where he charged $380', findInventedPrice('a full detail with carpet shampoo will be $399', pb), '$399');
check('$429 for an unseen truck',   findInventedPrice('a full detail on your F450 would start at $429', pb), '$429');

console.log('\n-- and honest ones are left alone --');
check('a price straight from the playbook', findInventedPrice("Interior details start at $200", pb), '');
check('a package plus its add-on',          findInventedPrice("that'll be $280", pb), '');   // 260 + 20
check('a number Mikey typed as the goal',   findInventedPrice("it'll be $450", pb.concat(['quote him $450'])), '');
check('a number already agreed in-thread',  findInventedPrice("still $300 like I said", pb.concat(['I can do that for $300'])), '');
check('no price at all is not a price',     findInventedPrice('Could you let me know the general condition?', pb), '');
check('the year of a car is not a price',   findInventedPrice('Happy to detail the 2013 Wrangler', pb), '');

// ---------------------------------------------------------------------------
console.log('\n-- the shape gate matches how he really writes --');
// His measured style, from the live voice profile: the median is 104 because most
// of his texts are "Sounds good!". A quote reply is not most of his texts.
const st = { medLen: 104, p90Len: 282, maxLen: 399, medSentences: 2, emojiPct: 1, greetPct: 23 };
const ted = "Sounds good! I can do a full interior detail and carpet shampoo for you. I can't guarantee how much of the stains I can get out, but I'll go over all the surfaces and get out as much as I can. I can do that for $300. If you send over your address or general street area, I can let you know how soon I can come by.";
const linda = "Awesome! So for your Ram, an Interior Detail, Exterior Detail, Carpet Shampoo, Exterior Polish, and Ceramic Wax will be $450. Feel free to send over your address or general street location, and I'll get you a spot on my schedule.";
check("his own 313-char quote passes as a quote", styleViolation(ted, st, 'price'), '');
check('...and used to be rejected as too long', styleViolation(ted, st) !== '', true);
check('5 sentences is normal in a quote',       styleViolation(linda + ' Thanks!', st, 'price'), '');
check('but real bloat is still caught',         styleViolation(ted + ' ' + ted, st, 'price') !== '', true);
check('short texts are unaffected',             styleViolation('Be there in 20!', st, 'quick'), '');

console.log('\n-- his own phrases are not treated as machine tells --');
check('"feel free to" is his, not a robot\'s', findTell(linda), '');
check('real tells still trip the gate',        findTell("Certainly! I'd be happy to assist."), 'Certainly!');
check('and so does an em-dash',                findTell('Sounds good — see you then'), '—');

// ---------------------------------------------------------------------------
console.log('\n-- the playbook says the same thing the code enforces --');
const p = defaultPlaybook();
check('there is a quote-reply section',     !!(p.quoting && p.quoting.length > 500), true);
check('it tells him to ask for the address', /send over your address/.test(p.quoting), true);
check('it gates on condition before pricing', /condition/i.test(p.quoting), true);
check('it carries the real worked quotes',   ['$450', '$400', '$380', '$300'].every((n) => p.quoting.includes(n)), true);
// The old golden rule told the AI to never give a firm price — the exact opposite
// of what he does at this moment, in the same prompt as the examples showing him
// doing it. A contradiction the model resolved by inventing a number.
check('the rules no longer forbid a firm price', /Never promise an exact price/.test(p.rules), false);
check('they forbid inventing one instead',      /isn't in this playbook/.test(p.rules), true);
check('and one voice, not a team "we"',         /never \\?"we\\?"/i.test(p.rules) || /never "we"/.test(p.rules), true);
// $160 / $180 / $200 for the same service, across code and live config, all fed
// to the model at once.
check('one interior price everywhere', (p.services.match(/Interior Detail — starts at \$(\d+)/) || [])[1], '200');
check('and the FAQ agrees with it',    (p.faqs.match(/Interior details start at \$(\d+)/) || [])[1], '200');
check('every field fits the save cap',  Object.values(p).every((v) => String(v).length <= 6000), true);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
