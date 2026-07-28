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

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
