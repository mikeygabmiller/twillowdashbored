// The server half of "Needs you": deciding when NOT to write the reply.
//
// Two failure modes matter here and they pull in opposite directions. Ask too
// rarely and the AI invents a time it can't know — a promise to a real person.
// Ask too often and every "thanks!" turns into a quiz, which is worse than
// useless because he'll stop reading them. So: a cheap regex decides what even
// costs an AI call, and the AI's answer is then held to a standard — a question
// with fewer than two tappable answers is just typing with extra steps.
//
//   node test/askme.test.js
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
// The gate is a const, not a function — pull the whole declaration line.
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const ok = (n, c, x) => { if (c) { PASS++; console.log('  ✓', n); } else { FAIL++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// A stand-in world: geminiGenerate returns whatever the test queued, and the
// prompt it was handed is captured so we can assert the playbook actually got
// in front of it (a question asked without the playbook would ask him things
// the playbook already answers).
let queued = null, prompts = [], calls = 0;
const build = () => new Function(
  'geminiGenerate', 'businessContext', 'transcript', 'AI_CLASSIFY_TURNS',
  `${liftConst('OWNER_DECISION_RE')}\n${lift('askOwnerChoices')}\nreturn { askOwnerChoices, OWNER_DECISION_RE };`,
)(
  async (prompt) => { calls++; prompts.push(prompt); if (queued instanceof Error) throw queued; return JSON.stringify(queued); },
  () => 'PLAYBOOK: full detail $250-$450. Serves Snohomish.\n\n',
  (t) => (t.messages || []).map((m) => `${m.dir === 'in' ? 'Customer' : 'You'}: ${m.body}`).join('\n'),
  6,
);
const { askOwnerChoices, OWNER_DECISION_RE } = build();
const thread = (body) => ({ phone: '+14255551234', messages: [{ dir: 'in', body, ts: Date.now() }] });
const reset = () => { calls = 0; prompts = []; };

section('The cheap gate: which messages are even worth an AI call');
const asks = [
  'What time can you come by?', 'when are you free thursday?', 'How much for a full detail?',
  'Do you have any openings Saturday?', 'can you come tomorrow morning?', 'does thursday work for you?',
  'How long does it take?', 'what day works best', 'Can I get scheduled for next week?',
  'I need to reschedule', 'whats the price on a truck', 'can you squeeze me in friday?',
];
for (const a of asks) ok(`asks him something: "${a}"`, OWNER_DECISION_RE.test(a), a);

const noAsks = [
  'Thanks!', 'Sounds good, see you then', 'Ok', 'That looks amazing, thank you so much',
  'Just pulled in', 'My car is the blue one', '👍', 'Perfect',
];
for (const n of noAsks) ok(`costs nothing: "${n}"`, !OWNER_DECISION_RE.test(n), n);

section('Nothing that reads like a plain remark ever reaches the AI');
reset();
ok('a thank-you makes no call at all', (await askOwnerChoices(thread('Thanks so much!'), {})) === null && calls === 0, calls);

section('A real scheduling question comes back as a question with answers');
reset();
queued = { needed: true, question: 'What time works Thursday?', options: ['9am', '11am', '2pm', "Can't Thursday"] };
let r = await askOwnerChoices(thread('Thursday works. What time can you come by?'), {});
ok('it asks him', r && r.question === 'What time works Thursday?', r);
ok('with all four answers ready to tap', r && r.options.length === 4, r);
ok('and it read the playbook before deciding', /PLAYBOOK: full detail/.test(prompts[0] || ''), (prompts[0] || '').slice(0, 60));
ok('and it saw the actual conversation', /Customer: Thursday works/.test(prompts[0] || ''));

section('When the playbook already answers it, the draft goes ahead as normal');
reset();
queued = { needed: false, question: '', options: [] };
ok('no question is raised', (await askOwnerChoices(thread('how much is a full detail?'), {})) === null);

section('A question with nothing to tap is not worth interrupting him for');
reset();
queued = { needed: true, question: 'What time?', options: ['9am'] };
ok('one lonely option is dropped', (await askOwnerChoices(thread('what time can you come?'), {})) === null);
queued = { needed: true, question: '', options: ['9am', '11am'] };
ok('answers with no question are dropped', (await askOwnerChoices(thread('what time can you come?'), {})) === null);

section('Junk from the model never becomes a half-broken card');
reset();
queued = { needed: true, question: 'What time?', options: ['9am', '', '  ', '11am', '2pm', '4pm', '6pm'] };
r = await askOwnerChoices(thread('what time can you come?'), {});
ok('blanks are thrown out', r && !r.options.some((o) => !o.trim()), r);
ok('and it never offers more than five', r && r.options.length <= 5, r);
queued = { needed: true, question: 'x'.repeat(400), options: ['9am', '11am'] };
r = await askOwnerChoices(thread('what time can you come?'), {});
ok('a runaway question is cut to fit the card', r && r.question.length <= 90, r && r.question.length);

section('It looks at the last thing the CUSTOMER said, not the last message');
reset();
queued = { needed: true, question: 'What time works?', options: ['9am', '11am'] };
const mixed = { phone: '+1', messages: [
  { dir: 'in', body: 'what time can you come?', ts: 1 },
  { dir: 'out', body: 'let me check', ts: 2 },
] };
ok('his own "let me check" does not close the gate', (await askOwnerChoices(mixed, {})) !== null);

console.log(`\n${FAIL ? '✗' : '✓'} askme — ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
