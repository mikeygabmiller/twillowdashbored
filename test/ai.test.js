// What the AI is told before it writes: the customer it's writing to (#19) and
// the standing rules Mikey stated out loud (#18).
//
//   node test/ai.test.js
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

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', lift('customerContext') + 'ctx.customerContext = customerContext;')(ctx);
const { customerContext } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const thread = {
  phone: '+15551110000', name: 'Dave Reyes', status: 'active',
  notes: 'gate code 4412, dog in the yard',
  garage: { city: 'Snohomish', address: '1420 Maple St', vehicles: [{ year: 2019, color: 'black', make: 'Ford', model: 'F-150' }] },
};
const spend = { total: 540, jobs: 3, lastService: 'full detail', lastDate: '2026-05-02' };

console.log('\n=== the AI is told who it is writing to ===');
const out = customerContext(thread, spend);
check('names the vehicle',        /2019 black Ford F-150/.test(out), true);
check('knows where they are',     /Snohomish/.test(out), true);
check('carries the lead status',  /active/.test(out), true);
check('includes private notes',   /gate code 4412/.test(out), true);
check('marks notes as private',   /never quote these back/i.test(out), true);
check('knows what they have paid',/3 jobs paid, \$540 lifetime/.test(out), true);
check('knows the last service',   /full detail/.test(out), true);
check('tells it not to recite',   /never recite it back/i.test(out), true);

console.log('\n=== nothing to say means nothing is added ===');
check('empty thread adds nothing', customerContext({ phone: '+1555' }, null), '');
check('no spend section without jobs', /lifetime/.test(customerContext(thread, { total: 0, jobs: 0 })), false);

console.log('\n=== a held customer carries the reason into the prompt ===');
const heldOut = customerContext(
  Object.assign({}, thread, { followup: { snoozeUntil: Date.now() + 86400000, holdReason: 'doing her car in August' } }),
  null);
check('hold reason reaches the writer', /on hold — "doing her car in August"/.test(heldOut), true);
check('an expired hold does not', /on hold/.test(customerContext(
  Object.assign({}, thread, { followup: { snoozeUntil: Date.now() - 86400000, holdReason: 'old' } }), null)), false);

console.log('\n=== standing rules reach every place the AI writes for him ===');
// Each of these builds a prompt that goes out under Mikey's name.
const sites = {
  'drafting a reply': 'generateReply',
  'polishing his text': 'apiAiDraft',
  'coaching a team member': 'apiAiCoach',
  'quoting from a photo': 'apiAiPhotoQuote',
};
for (const [label, fn] of Object.entries(sites)) {
  check(label + ' applies the rules', /rulesContext\(\)/.test(lift(fn)), true);
}
check('the board advisor applies them', /rulesContext\(\)/.test(lift('apiAiAnalyze')), true);
check('the command centre applies them', /rulesContext\(\)/.test(lift('buildAgentContext')), true);

console.log('\n=== the customer reaches the writing paths too ===');
check('drafting knows the customer',  /customerContext\(/.test(lift('generateReply')), true);
check('coaching knows the customer',  /customerContext\(/.test(lift('apiAiCoach')), true);

console.log('\n=== every text a customer reads is written by the good model ===');
// The router has two tiers: 'voice' means a human is going to read it and judge
// whether Mikey wrote it, 'fast' means nobody but the app ever sees the output.
// Three of the four voice surfaces used to be hardcoded to the fast provider —
// including polish, where his own words are already on the page. Anything that
// ends up on a customer's phone belongs on the left of this list.
const voiceSurfaces = ['reply draft', 'auto polish', 'follow-up draft', 'appointment draft', 'voice training'];
const wrongTier = voiceSurfaces.filter((surface) => {
  const at = SRC.indexOf(`surface: '${surface}'`);
  if (at < 0) return true;                       // a surface that vanished is a failure too
  const opts = SRC.slice(at, SRC.indexOf('}', at));
  return !/tier: 'voice'/.test(opts);
});
check('all five customer-facing writers are on the voice tier', wrongTier, []);
// The other side of the same rule: a surface nobody reads must NOT be paying for
// the expensive model. The keyboard fires on every typing pause.
const kbAt = SRC.indexOf("surface: 'keyboard'");
check('the keyboard stays on the cheap tier', /tier: 'fast'/.test(SRC.slice(kbAt, SRC.indexOf('}', kbAt))), true);

console.log('\n=== polish is grounded in his voice, not just the tone paragraph ===');
const polish = lift('apiAiDraft');
check('polish uses the measured counts', /measuredStyleRules\(/.test(polish), true);
check('polish uses the derived fingerprint', /fingerprint/.test(polish), true);
check('polish still refuses to invent facts', /Do NOT add, remove, or change any facts/.test(polish), true);
// His own corrections are the strongest block in the prompt — "the AI wrote X,
// Mikey sent Y" — and polish was the last writing path not being shown them.
check('polish learns from how he edits', /editsContext\(/.test(polish), true);

console.log('\n=== the polish playbook names the defects instead of asking for "great" ===');
const PB = (SRC.match(/const POLISH_PLAYBOOK =[\s\S]*?;\n/) || [''])[0];
check('there is a playbook at all', PB.length > 400, true);
check('polish is handed it', /POLISH_PLAYBOOK/.test(polish), true);
// The old instruction was an adjective ("reads clearly and sounds great"), which
// guarantees a rewrite every time because there is always a better version.
check('the adjective is gone', /sounds great/.test(polish), false);
check('it is allowed to change nothing', /EXACTLY as written/.test(PB), true);
// The four lists, each doing a different job.
check('a fix list', /FIX SILENTLY/.test(PB), true);
check('a flag list it must not act on', /FLAG, NEVER FIX/.test(PB), true);
check('a tone list it must not act on', /TONE RISK/.test(PB), true);
check('a hands-off list', /NEVER TOUCH/.test(PB), true);
// The one that costs him a customer if it gets fixed: his signature opener is
// not a missing apostrophe, and a generic proofreader "corrects" it every time.
check('his opener is protected', /its Mikey/.test(PB), true);
check('lowercase starts are protected', /starts lowercase/.test(PB), true);
check('soft prices are protected', /never sharpen/.test(PB), true);
check('sounding like a company is a tone risk', /one guy with a van/.test(PB), true);
check('tone is never silently rewritten', /NEVER rewrite these, only mention/.test(PB), true);

console.log('\n=== the warning comes back as a note, not as a rewrite ===');
check('polish asks for text and note', /"text"[\s\S]{0,80}"note"/.test(polish), true);
check('the note is capped short', /60 characters/.test(polish), true);
check('the response carries it', /note: out\.note/.test(polish), true);

// lift() counts braces, which a function holding a "{" inside a string literal
// defeats. Both of these are top level, so their closing brace is the first one
// sitting in column zero.
const liftFlat = (name) => {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 2);
};
const pctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', liftFlat('parsePolishOut') + liftFlat('polishNumbers') +
  'ctx.parsePolishOut = parsePolishOut; ctx.polishNumbers = polishNumbers;')(pctx);
const { parsePolishOut, polishNumbers } = pctx;

check('plain JSON comes apart',
  parsePolishOut('{"text":"Thursday works. Ill see you then.","note":"reads a bit curt"}', 'x'),
  { text: 'Thursday works. Ill see you then.', note: 'reads a bit curt' });
check('a fenced reply still comes apart',
  parsePolishOut('```json\n{"text":"All good","note":""}\n```', 'x').text, 'All good');
check('an empty note stays empty',
  parsePolishOut('{"text":"All good","note":""}', 'x').note, '');
// A model that ignores the JSON instruction has still written him a message.
check('prose is treated as the message',
  parsePolishOut('Thursday works for me.', 'orig').text, 'Thursday works for me.');
check('quotes around it are stripped',
  parsePolishOut('"Thursday works for me."', 'orig').text, 'Thursday works for me.');
// The one that would be visible to a customer: never paste a JSON fragment into
// his message box because the reply got truncated.
check('broken JSON falls back to his own words',
  parsePolishOut('{"text":"Thursday wo', 'my original text').text, 'my original text');
check('a long note is trimmed',
  parsePolishOut(JSON.stringify({ text: 'a', note: 'x'.repeat(200) }), 'a').note.length, 70);

console.log('\n=== a rewrite is never allowed to move a number ===');
check('same numbers, any order', polishNumbers('be there at 9, $130') === polishNumbers('$130 at 9'), true);
check('a changed price is caught', polishNumbers('around $130') === polishNumbers('around $150'), false);
check('an added time is caught', polishNumbers('see you tomorrow') === polishNumbers('see you at 9'), false);
check('the refusal keeps his text', /out\.text = draftText/.test(polish), true);

console.log('\n=== offering a time and locking one in are different jobs ===');
// This was the worst-scoring situation on the Train AI board — 50% against 100%
// for pricing — on a bucket that was already FULL. More examples were never going
// to fix it: an offer has to leave room for a no, a booking has to leave none, and
// ranked together the draft copied whichever it happened to be shown.
const vctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx',
  (SRC.match(/const VEHICLE_MAKES = .*;/) || [''])[0] + '\n' +
  lift('mentionsVehicle') + lift('voiceBucket') +
  'ctx.voiceBucket = voiceBucket;')(vctx);
const { voiceBucket } = vctx;

const offers = [
  "I've got 10:45 open tomorrow if you want it",
  'Does Tuesday morning work for you?',
  'I could do Thursday afternoon, let me know',
  'I have an opening Saturday at 9',
];
for (const t of offers) check(`offer: "${t.slice(0, 34)}…"`, voiceBucket(t), 'offer');

const bookings = [
  "You're all set for Tuesday at 10",
  'See you Saturday morning!',
  'Got you down for 2pm Friday',
  "Perfect, you're booked for tomorrow at 8:30",
];
for (const t of bookings) check(`booking: "${t.slice(0, 34)}…"`, voiceBucket(t), 'schedule');

check('a price still beats a day', voiceBucket('Tuesday works, it would be $180 for the truck'), 'price');
check('bad news still beats its own subject', voiceBucket("Sorry, I can't make Tuesday after all"), 'apology');
check('an agreement with no time in it is not scheduling', voiceBucket('Sounds good, will do'), 'confirm');

console.log('\n=== it learns from more of his texts than it used to ===');
const perBucket = Number((SRC.match(/const VOICE_PER_BUCKET = (\d+)/) || [])[1]);
const show = Number((SRC.match(/const VOICE_SHOW = (\d+)/) || [])[1]);
check('the corpus keeps at least 120 per situation', perBucket >= 120, true);
check('and shows the model at least 20 of them', show >= 20, true);
check('it cannot show more than it keeps', show <= perBucket, true);

console.log('\n=== the fingerprint cannot recommend a phrase the gate bans ===');
// The live profile listed "Feel free to" among his recurring phrases while
// AI_TELLS banned it outright, so obeying the style guide cost a wasted rewrite
// on every draft that took the advice.
const derive = lift('deriveVoiceFingerprint');
check('every line is run past the tell-blocker', /findTell\(line\)/.test(derive), true);
check('and the surviving lines are what gets returned', /kept\.join/.test(derive), true);

console.log('\n=== the fingerprint keeps up with his writing on its own ===');
const refresh = lift('maybeRefreshVoice');
check('it only redoes it once the corpus has really moved', /VOICE_FP_DRIFT/.test(refresh), true);
check('at most once a day', /v\.fpDay === today/.test(refresh), true);
check('and not on every cron tick', /getUTCMinutes\(\) !== 7/.test(refresh), true);
check('it never runs the expensive full rebuild', /buildVoiceProfile|loadThread/.test(refresh), false);
check('the cron actually calls it', /await maybeRefreshVoice\(\)/.test(SRC), true);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
