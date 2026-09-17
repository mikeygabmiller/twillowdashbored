// The quote-text preview — "let me see it before I turn it on".
//
// The AI opener writes a text nobody reads before a customer does, so the switch
// that arms it is worth nothing unless he can watch it work first. This is that
// screen's contract, and the load-bearing half of it is negative: the preview
// must never send anything, never flip a switch, and never be able to make a
// real customer's phone buzz. A preview that could do any of those would be a
// worse feature than no preview at all.
//
//   node test/preview.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

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

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', lift('previewSummary') + lift('previewInterest') +
  'ctx.previewSummary = previewSummary; ctx.previewInterest = previewInterest;')(ctx);
const { previewSummary, previewInterest } = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const api = lift('apiQuotePreview');
const card = lift('previewCard');
const teach = lift('apiQuotePreviewTeach');
const whole = api + card + teach;

console.log('\n=== it cannot send, queue, or charge anybody ===');
// The whole point of a preview is that it is inert. These are the calls that
// would make a customer's phone buzz, and none of them may appear anywhere near it.
for (const bad of ['twilioSend', 'sendSms', 'notifyMikey', 'saveThread', 'updateIndexEntry', 'scheduled.push', 'composeQuoteOpener']) {
  check(`it never calls ${bad}`, whole.includes(bad), false);
}
check('it never writes a thread',         /loadThread\(/.test(whole), false);
check('it never touches the config',      /saveConfig|kv\(\)\.put\('config/.test(api + card), false);
check('and it only ever READS the log',   /saveQuoteMonth/.test(whole), false);

console.log('\n=== it previews the AI half while that half is switched off ===');
// Calling composeQuoteOpener would respect cfg.smartQuoteOpener and hand back the
// template — i.e. it would preview nothing. Going straight to the draft is what
// makes the screen able to answer "should I turn this on?".
check('it drafts directly rather than through the live path',
  /draftQuoteOpener\(f, cfg\)/.test(card), true);
check('it never consults the switch it exists to inform',
  /smartQuoteOpener/.test(api + card), false);
check('it shows what sends TODAY alongside it', /const plain = quoteOpener\(f, \{ ask: false \}\)/.test(card), true);
check('and the reworded version too',          /const ask = quoteOpener\(f, \{ ask: true \}\)/.test(card), true);
check('the comparison is hidden when it changes nothing', /alt: ask === plain \? '' :/.test(card), true);
check('the card always compares against the wording that is NOT live',
  /cfg\.quoteOpenerAsk === true \? plain : ask/.test(card), true);
check('and the label cannot go stale', /altCap:/.test(card), true);
check('"what sends today" follows the real switch', /cfg\.quoteOpenerAsk === true \? ask : plain/.test(card), true);

console.log('\n=== a refused draft is shown as refused, not hidden ===');
check('the refusal reason reaches the card', /out\.refused = !!drafted\.refused/.test(card), true);
check('a model outage degrades to the plain text', /catch \(err\)/.test(card), true);
check('one bad card cannot take down the batch', /Promise\.all/.test(api), true);

console.log('\n=== it costs a bounded number of AI calls ===');
check('the batch is capped', /Math\.min\(PREVIEW_MAX/.test(api), true);
check('the cap is small', Number((SRC.match(/const PREVIEW_MAX = (\d+)/) || [])[1]) <= 4, true);
check('it refuses to run with no AI configured', /!aiConfigured\(\)/.test(api), true);

console.log('\n=== which submissions are worth replaying ===');
// A name and a total with nothing else is the pre-log backfill: there is no
// submission left to answer, so drafting one would burn a call to show him the
// oldest line in the file.
check('a backfilled name+total is skipped', previewInterest({ total: '349' }) > 1, false);
check('a real submission is not',           previewInterest({ vehicle: 'Tacoma', total: '349' }) > 1, true);
check('a note outranks everything',         previewInterest({ notes: 'saturday?' }) > previewInterest({ vehicle: 'x', services: 'y', condition: 'z' }), true);
check('and the richest one sorts first',
  previewInterest({ vehicle: 'Tacoma', total: '349', notes: 'saturday?', condition: 'rough' }) >
  previewInterest({ vehicle: 'Tacoma', total: '349' }), true);
check('the filter is actually applied',     /previewInterest\(c\.f\) > 1/.test(api), true);

console.log('\n=== the summary line reads like a submission ===');
check('it names the car and the price',
  previewSummary({ vehicle: '2019 Toyota Tacoma', total: '349' }), '2019 Toyota Tacoma · $349');
check('a missing car says so rather than going blank',
  previewSummary({ total: '349' }), 'no vehicle given · $349');
check('a missing price too',
  previewSummary({ vehicle: 'Tacoma' }), 'Tacoma · no price');
check('condition is labelled so it cannot read as a service',
  previewSummary({ vehicle: 'Tacoma', total: '9', condition: 'pet hair' }), 'Tacoma · $9 · condition: pet hair');

console.log('\n=== his rewrite actually teaches it ===');
check('a miss is stored as a before/after pair', /recordEdit\(ai, mine, asked\)/.test(teach), true);
check('his words go into the corpus either way', /recordVoiceSample\(mine,/.test(teach), true);
check('paired with the submission, not with nothing', /recordVoiceSample\(mine, [^,]+, asked\)/.test(teach), true);
check('it scores against the same board as the other trainer', /VOICE_SCORE_KEY/.test(teach), true);
check('a bad bucket cannot corrupt the scoreboard', /VOICE_BUCKETS\.includes/.test(teach), true);
check('and it refuses a request with no card id', /error: 'bad_request'/.test(teach), true);

console.log('\n=== both switches still default to off ===');
const defaults = SRC.slice(SRC.indexOf('function defaultConfig()'));
check('the AI opener starts off',        /smartQuoteOpener: false,/.test(defaults), true);
check('the reworded opener starts off',  /quoteOpenerAsk: false,/.test(defaults), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
