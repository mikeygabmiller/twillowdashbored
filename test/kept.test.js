// The one number that isn't a proxy: of the drafts he sent, how many went out
// word for word.
//
// Everything else the trainer reports is a judgement he made sitting still —
// "does this sound like me" — which is not the same thing as a text that left
// his phone untouched. A draft sent as written saved him writing one. A draft he
// rewrote cost him reading it first. The app has recorded which is which on
// every send for months and never once added them up.
//
// Split by provider, because "is the paid model worth it" is a question only
// this comparison can answer, and getting it wrong costs real money every month.
//
//   node test/kept.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  const p = SRC.indexOf('(', start);
  let pd = 0, bodyStart = -1;
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
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const ok = (n, c, x) => { if (c) { PASS++; console.log('  ✓', n); } else { FAIL++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

let STORE = {};
let edits = [];
const env = new Function(
  'kv', 'recordVoiceSample', 'loadEdits', 'EDITS_KEY', 'EDITS_KEEP',
  `${liftConst('DRAFT_VERDICT_KEY')}
   ${liftConst('DRAFT_VERDICTS_KEEP')}
   ${liftConst('DRAFT_VERDICT_MIN')}
   ${lift('loadDraftVerdicts')}
   ${lift('noteDraftVerdict')}
   ${lift('rollUpDraftVerdicts')}
   ${lift('recordEdit')}
   return { loadDraftVerdicts, noteDraftVerdict, rollUpDraftVerdicts, recordEdit };`,
)(
  () => ({
    get: async (k) => (STORE[k] === undefined ? null : JSON.parse(STORE[k])),
    put: async (k, v) => { STORE[k] = v; },
  }),
  async () => {},
  async () => edits,
  'voice:edits', 100,
);

const reset = () => { STORE = {}; edits = []; };
const rate = async (days) => env.rollUpDraftVerdicts(await env.loadDraftVerdicts(), days);

// ---------------------------------------------------------------------------
section('Sending a draft word for word is what counts as saved time');
reset();
await env.recordEdit('Runs about $400.', 'Runs about $400.', '', 'claude');
let r = await rate(30);
ok('a draft sent untouched is kept', r.kept === 1 && r.sent === 1, r);

section('Rewriting it counts too — as the other half of the same number');
await env.recordEdit('Runs about $400.', 'That one is $375, can do Saturday.', '', 'claude');
r = await rate(30);
ok('the rewrite is recorded, not ignored', r.sent === 2 && r.kept === 1, r);
// A rate built only from the ones he kept would read 100% forever.

section('Whitespace is not an edit');
reset();
await env.recordEdit('Runs about $400.', '  Runs about $400.  ', '', 'claude');
r = await rate(30);
ok('trimming does not count as rewriting it', r.kept === 1, r);

section('Too few sends reports nothing rather than a number he might act on');
reset();
for (let i = 0; i < 4; i++) await env.recordEdit(`draft ${i}`, `draft ${i}`, '', 'claude');
r = await rate(30);
ok('four sends is not evidence', r.rate === null, r);
ok('but the raw counts are still there', r.sent === 4 && r.kept === 4, r);
await env.recordEdit('draft 5', 'draft 5', '', 'claude');
r = await rate(30);
ok('five is enough to say something', r.rate === 100, r);
// Three sends is not evidence about anything, and a 100% on a sample of two is
// exactly the kind of number that would talk him into a monthly bill.

section('The comparison that decides whether the paid model is worth it');
reset();
// Eight kept out of ten on Claude, three out of ten on the free model.
for (let i = 0; i < 10; i++) await env.recordEdit(`c${i}`, i < 8 ? `c${i}` : `c${i} rewritten`, '', 'claude');
for (let i = 0; i < 10; i++) await env.recordEdit(`g${i}`, i < 3 ? `g${i}` : `g${i} rewritten`, '', 'gemini');
r = await rate(30);
ok('each provider is scored on its own drafts', r.byProvider.claude.rate === 80 && r.byProvider.gemini.rate === 30, r.byProvider);
ok('and the overall number is both together', r.sent === 20 && r.kept === 11, r);

section('A provider with barely any drafts is not called either way');
reset();
for (let i = 0; i < 9; i++) await env.recordEdit(`c${i}`, `c${i}`, '', 'claude');
await env.recordEdit('g1', 'g1', '', 'gemini');
r = await rate(30);
ok('nine drafts scores', r.byProvider.claude.rate === 100, r.byProvider.claude);
ok('one draft does not', r.byProvider.gemini.rate === null, r.byProvider.gemini);

section('The window is what makes two stretches comparable');
reset();
const d = await env.loadDraftVerdicts();
const old = Date.now() - 45 * 86400000;
STORE['voice:kept'] = JSON.stringify({ rounds: [
  { at: old, kept: true, by: 'gemini' }, { at: old, kept: true, by: 'gemini' },
  { at: old, kept: true, by: 'gemini' }, { at: old, kept: true, by: 'gemini' },
  { at: old, kept: true, by: 'gemini' }, { at: old, kept: true, by: 'gemini' },
] });
r = await rate(30);
ok('drafts from six weeks ago are out of a 30-day window', r.sent === 0, r);
r = await rate(60);
ok('and back in a 60-day one', r.sent === 6 && r.rate === 100, r);

section('A send with no provider recorded still counts toward the total');
reset();
for (let i = 0; i < 6; i++) await env.recordEdit(`x${i}`, `x${i}`, '', '');
r = await rate(30);
ok('it lands in the overall rate', r.rate === 100 && r.sent === 6, r);
ok('but is not attributed to either model', r.byProvider.claude.sent === 0 && r.byProvider.gemini.sent === 0, r.byProvider);
// Drafts predating this change have no provider. They should not silently
// become evidence for whichever model happens to be running today.

section('The log cannot grow without bound');
reset();
const many = [];
for (let i = 0; i < 400; i++) many.push({ at: Date.now(), kept: true, by: 'claude' });
STORE['voice:kept'] = JSON.stringify({ rounds: many });
await env.noteDraftVerdict(true, 'claude');
ok('it stays capped', JSON.parse(STORE['voice:kept']).rounds.length === 300,
  JSON.parse(STORE['voice:kept']).rounds.length);

section('A broken counter never costs him a text');
reset();
const brittle = new Function('kv', 'recordVoiceSample', 'loadEdits', 'EDITS_KEY', 'EDITS_KEEP',
  `${liftConst('DRAFT_VERDICT_KEY')}\n${liftConst('DRAFT_VERDICTS_KEEP')}\n${lift('loadDraftVerdicts')}\n${lift('noteDraftVerdict')}\nreturn { noteDraftVerdict };`,
)(() => ({ get: async () => { throw new Error('KV down'); }, put: async () => {} }), async () => {}, async () => [], 'k', 10);
let threw = false;
try { await brittle.noteDraftVerdict(true, 'claude'); } catch { threw = true; }
ok('a KV outage is swallowed, not thrown at the send', !threw);

console.log(`\n${FAIL ? '✗' : '✓'} kept — ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
