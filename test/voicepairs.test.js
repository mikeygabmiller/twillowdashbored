// The voice corpus in PAIRS: what the customer said, and what Mikey wrote back.
//
// A corpus of his texts alone can only ever teach style — rhythm, length, the
// habits. Style was never the hard part. What it cannot teach is judgement: that
// this kind of message gets a price and that kind gets a question back. That
// lives in the pairing, which the threads had all along and the profile threw
// away on the way in. These tests pin down the three places it now survives:
// going into the corpus, coming back out of retrieval, and reaching the model as
// real conversation turns rather than a bulleted list.
//
//   node test/voicepairs.test.js
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
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const ok = (n, c, x) => { if (c) { PASS++; console.log('  ✓', n); } else { FAIL++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// ---------------------------------------------------------------------------
// A stand-in world. KV is an object, so a sample really does have to survive a
// round trip through save/load the way it does in the Worker.
// ---------------------------------------------------------------------------
let STORE = {};
const env = new Function(
  'kv', 'VOICE_KEY', 'VOICE_PER_BUCKET', 'VOICE_SHOW', 'VOICE_TURNS', 'VOICE_BUCKETS', 'measureStyle',
  `${liftConst('VEHICLE_MAKES')}
   ${lift('mentionsVehicle')}
   ${lift('voiceBucket')}
   ${liftConst('VOICE_STOP')}
   ${lift('voiceTokens')}
   ${lift('voiceOverlap')}
   ${lift('pickVoiceExamples')}
   ${lift('voiceExchanges')}
   ${lift('emptyVoice')}
   ${lift('loadVoice')}
   ${lift('saveVoice')}
   ${lift('addVoiceSamples')}
   ${lift('recordVoiceSample')}
   ${lift('askedBefore')}
   ${lift('missingFacts')}
   ${lift('flattenForGemini')}
   return { addVoiceSamples, recordVoiceSample, askedBefore, pickVoiceExamples,
            voiceExchanges, loadVoice, voiceBucket, missingFacts, flattenForGemini };`,
)(
  () => ({
    get: async (k) => (STORE[k] === undefined ? null : JSON.parse(STORE[k])),
    put: async (k, v) => { STORE[k] = v; },
  }),
  'voice:profile', 120, 20, 8,
  ['price', 'offer', 'schedule', 'confirm', 'answer', 'apology', 'closing', 'quick', 'general'],
  () => null,
);

// ---------------------------------------------------------------------------
section('A sample remembers the message it was answering');
STORE = {};
await env.addVoiceSamples([{ t: 'Full detail on that runs $350 out the door.', q: 'How much for a 2019 Tahoe?' }], 'sent');
let v = await env.loadVoice();
let row = v.buckets.price[0];
ok('his reply is stored', row && /350 out the door/.test(row.t), row);
ok('and so is what he was answering', row && row.q === 'How much for a 2019 Tahoe?', row);

section('A plain string still works, because most of the corpus is one');
await env.addVoiceSamples(['Ready! Give it 20 and I will be there.'], 'sent');
v = await env.loadVoice();
ok('it goes in with no question attached', (v.buckets.offer || []).concat(v.buckets.quick || [], v.buckets.general || [], v.buckets.schedule || [])
  .some((x) => /Give it 20/.test(x.t) && !x.q));

section('An unpaired sample learned earlier gets upgraded, not dropped');
STORE = {};
await env.addVoiceSamples(['Full detail on that runs $350 out the door.'], 'sent');
let added = await env.addVoiceSamples([{ t: 'Full detail on that runs $350 out the door.', q: 'How much for a 2019 Tahoe?' }], 'sent');
v = await env.loadVoice();
ok('the duplicate counts as progress', added === 1, added);
ok('there is still only one copy of it', v.buckets.price.filter((x) => /350 out the door/.test(x.t)).length === 1, v.buckets.price.length);
ok('and it now knows the moment', v.buckets.price[0].q === 'How much for a 2019 Tahoe?', v.buckets.price[0]);
// Without this, an unpaired copy learned months ago would block the paired one
// forever and the corpus could never actually fill in.

section('askedBefore finds the last thing the customer said, not the last message');
const thread = {
  messages: [
    { dir: 'in', body: 'Hey do you do ceramic coating?', ts: 10 },
    { dir: 'out', body: 'I do!', ts: 20 },
    { dir: 'in', body: 'How much for a 2019 Tahoe?', ts: 30 },
    { dir: 'out', body: 'Full detail on that runs $350.', ts: 40 },
  ],
};
ok('the reply at 40 was answering the question at 30',
  env.askedBefore(thread, 40) === 'How much for a 2019 Tahoe?', env.askedBefore(thread, 40));
ok('the reply at 20 was answering the question at 10',
  env.askedBefore(thread, 20) === 'Hey do you do ceramic coating?', env.askedBefore(thread, 20));
ok('nothing before the first message', env.askedBefore(thread, 5) === '', env.askedBefore(thread, 5));

// ---------------------------------------------------------------------------
section('Retrieval matches the CUSTOMER side, which is the whole point');
STORE = {};
await env.addVoiceSamples([
  // The right answer: a different customer, the same moment.
  { t: 'That one runs $400. I can do it Saturday if that works.', q: 'What would you charge for a 2020 Silverado?' },
  // The decoy: talks about pricing constantly, but was answering something else.
  { t: 'No charge for that, happy to take a look at the price sheet.', q: 'Thanks for sending the invoice over' },
], 'sent');
let picked = env.pickVoiceExamples(await env.loadVoice(), 'price', 'How much to detail my 2018 Silverado?', 10);
ok('the reply to a near-identical question wins', /\$400/.test(picked[0].t), picked.map((p) => p.t));
// Matching the customer's words against his REPLIES is circular — ask about a
// price and you get back every text of his containing "price", which is how the
// decoy above used to win.

section('Paired samples become real turns; loose ones stay a style list');
STORE = {};
await env.addVoiceSamples([
  { t: 'That one runs $400.', q: 'What would you charge for a 2020 Silverado?' },
  'Ready! Be there in 20.',
], 'sent');
const ex = env.voiceExchanges(await env.loadVoice(), 'price', 'How much for a Silverado?');
ok('the pair is two turns', ex.turns.length === 2, ex.turns);
ok('the customer speaks first', ex.turns[0].role === 'user' && /Silverado/.test(ex.turns[0].content), ex.turns[0]);
ok('and he answers as the assistant', ex.turns[1].role === 'assistant' && ex.turns[1].content === 'That one runs $400.', ex.turns[1]);
ok('the unpaired one is offered as style only, never as a reply to anything',
  /copy the rhythm/.test(ex.text) && /Be there in 20/.test(ex.text), ex.text);

section('The Gemini fallback keeps the exchanges rather than losing them');
const flat = env.flattenForGemini('Reply:', { system: 'PLAYBOOK', turns: ex.turns });
ok('the system half survives', /^PLAYBOOK/.test(flat), flat.slice(0, 40));
ok('so does his side of the exchange', /Mikey replied: That one runs \$400\./.test(flat), flat);
ok('and the prompt still comes last', /Reply:$/.test(flat.trim()), flat.slice(-30));

// ---------------------------------------------------------------------------
section('What the conversation still does not know');
const bare = { messages: [{ dir: 'in', body: 'Hey, are you taking new customers?', ts: 1 }] };
let miss = env.missingFacts(bare, 'answer');
ok('a cold opener is missing all three', miss.length === 3, miss);

const known = { garage: { vehicles: [{ make: 'Ford' }], address: '123 Pine St' },
  messages: [{ dir: 'in', body: 'Can you come Thursday?', ts: 1 }] };
ok('nothing is missing once he has vehicle, place and a day',
  env.missingFacts(known, 'offer').length === 0, env.missingFacts(known, 'offer'));

const gaveIt = { messages: [
  { dir: 'in', body: "It's a 2019 Tahoe, I'm at 1420 Cedar Ave", ts: 1 },
] };
miss = env.missingFacts(gaveIt, 'price');
ok('what the customer already typed counts as known', !miss.some((m) => /drive|vehicle will be/.test(m)), miss);
// A draft that asks for the address two texts after they gave it reads as not
// listening, which is worse than never asking.

ok('a thank-you is never a moment to ask for anything',
  env.missingFacts(bare, 'closing').length === 0, env.missingFacts(bare, 'closing'));
ok('nor is an apology', env.missingFacts(bare, 'apology').length === 0);

// ---------------------------------------------------------------------------
section('What actually goes over the wire to Anthropic');
let sent = null;
const api = new Function(
  'ENV', 'claudeVia', 'claudeModel', 'noteAiUsage', 'noteClaudeSpend', 'fetch',
  `${lift('claudeGenerate')}\nreturn { claudeGenerate };`,
)(
  { ANTHROPIC_API_KEY: 'sk-test' },
  () => 'key',
  () => 'claude-opus-5',
  async () => {}, () => {},
  async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'drafted' }], usage: {} }) };
  },
);
const turns = [
  { role: 'user', content: 'A customer texted: "how much for a truck"' },
  { role: 'assistant', content: 'Runs about $400.' },
];
await api.claudeGenerate('Reply:', { system: 'THE PLAYBOOK', turns, effort: 'medium' });
ok('the stable half is a system block', sent.system && sent.system[0].text === 'THE PLAYBOOK', sent.system);
ok('behind a cache breakpoint, so he is not re-billed for it every draft',
  sent.system[0].cache_control && sent.system[0].cache_control.type === 'ephemeral', sent.system[0]);
ok('his real exchanges are message turns, not quoted strings in a blob',
  sent.messages.length === 3 && sent.messages[1].role === 'assistant', sent.messages.map((m) => m.role));
ok('and the live question comes last', /Reply:/.test(sent.messages[2].content), sent.messages[2]);
ok('drafting thinks harder than the mechanical surfaces', sent.output_config.effort === 'medium', sent.output_config);

// ---------------------------------------------------------------------------
section('And what goes over the wire through the AI binding instead');
// Same function, same draft, a different shape on the wire. The catalog schema
// behind the binding takes messages, max_tokens and a STRING system — Opus's
// output_config and a system block carrying cache_control are both 400s there,
// and a 400 on every draft would read as "the AI broke", not as "wrong field".
let bound = null;
const api2 = new Function(
  'ENV', 'claudeVia', 'claudeModel', 'noteAiUsage', 'noteClaudeSpend', 'fetch',
  `${lift('claudeGenerate')}\nreturn { claudeGenerate };`,
)(
  { AI: { run: async (model, input, opts) => { bound = { model, input, opts }; return { content: [{ type: 'text', text: 'drafted' }], usage: {} }; } } },
  () => 'binding',
  () => 'anthropic/claude-haiku-4.5',
  async () => {}, () => {},
  async () => { throw new Error('the binding route must never reach out to api.anthropic.com'); },
);
await api2.claudeGenerate('Reply:', { system: 'THE PLAYBOOK', turns, effort: 'medium' });
ok('the model is the binding\'s own first argument, not a body field',
  bound.model === 'anthropic/claude-haiku-4.5' && bound.input.model === undefined, bound.model);
ok('the system prompt goes as a plain string', bound.input.system === 'THE PLAYBOOK', bound.input.system);
ok('with no cache_control block to be rejected for', typeof bound.input.system === 'string');
ok('and no effort dial, which Haiku does not have', bound.input.output_config === undefined, bound.input.output_config);
ok('his real exchanges still ride as message turns',
  bound.input.messages.length === 3 && bound.input.messages[1].role === 'assistant',
  bound.input.messages.map((m) => m.role));
ok('and the call is tagged with a gateway so the logs land somewhere findable',
  bound.opts.gateway.id === 'default', bound.opts);
// Prefilling the assistant turn would be stronger still and is a 400 on this
// model family, so the turns above are the supported way to do this.
ok('there is no trailing assistant prefill to get rejected',
  sent.messages[sent.messages.length - 1].role === 'user', sent.messages);

sent = null;
await api.claudeGenerate('Classify:', {});
ok('a surface with no examples still sends a plain single-turn request',
  sent.messages.length === 1 && !sent.system, sent);
ok('and stays on low effort', sent.output_config.effort === 'low', sent.output_config);

console.log(`\n${FAIL ? '✗' : '✓'} voicepairs — ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
