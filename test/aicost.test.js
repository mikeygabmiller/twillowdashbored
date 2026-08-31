// The AI diet: what stops calling Gemini on its own, and the counters that let
// you tell whether a cut worked.
//
// Two things are being protected here.
//
// The counters are the more delicate half. They exist to answer "what is this
// costing me?", so a counter that silently loses calls is worse than no counter
// at all — you'd be reading a number and trusting it. The KV-write budget is the
// other constraint (see the box at the top of src/index.js): counting must not
// turn one AI call into one write, so the flush threshold is part of the
// contract, not an implementation detail.
//
// The off-switches are the simpler half, but the failure mode is nasty: a
// default that flips the wrong way quietly starts spending again, or keeps
// mailing him twice a day after he asked for it to stop.
//
//   node test/aicost.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
// Everything from a marker line down to the closing brace of a named function —
// the usage counters are a block of module state plus the functions that touch
// it, and lifting them apart would leave the state behind.
function liftSpan(startMarker, endFunction) {
  const start = SRC.indexOf(startMarker);
  if (start < 0) throw new Error(`marker ${startMarker} not found`);
  const tail = lift(endFunction);
  const end = SRC.indexOf(tail) + tail.length;
  if (end < start) throw new Error(`${endFunction} is before ${startMarker}`);
  return SRC.slice(start, end);
}
function liftConst(name) {
  const start = SRC.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`const ${name} not found in src/index.js`);
  let depth = 0;
  for (let j = SRC.indexOf('=', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`could not find end of const ${name}`);
}

// A stand-in for KV that records every write, so a test can assert on how MANY
// writes a run cost as well as what ended up stored.
const STORE = new Map();
let WRITES = 0;
const fakeKv = () => ({
  get: async (k, o) => {
    const raw = STORE.get(k);
    if (raw == null) return null;
    return (o && o.type === 'json') ? JSON.parse(raw) : raw;
  },
  put: async (k, v) => { WRITES++; STORE.set(k, v); },
});

// The counters read the clock in two places (which day a call belongs to, and
// how long the buffer has been sitting), so the tests own the clock — `Date` goes
// in as a parameter rather than the real one. Day-rollover behaviour is otherwise
// only testable by waiting until midnight.
const REAL_DATE = Date;
let CLOCK = REAL_DATE.parse('2026-08-25T18:00:00Z');   // 11am Pacific
const fakeDate = { now: () => CLOCK };
const localDateStr = (t, tz) => new REAL_DATE(t).toLocaleDateString('en-CA', { timeZone: tz });

// Build a fresh, isolated copy of the counter module — its own buffer, its own
// KV. The retry test needs a second one whose store can be broken independently.
function makeCounters(kvImpl) {
  const c = {};
  // eslint-disable-next-line no-new-func
  new Function('ctx', 'kv', 'envFlag', 'localDateStr', 'Date',
    'let CFG_CACHE = { tz: "America/Los_Angeles" };\n' +
    liftSpan('const AI_USAGE_DAYS', 'flushAiUsage') + '\n' +
    'Object.assign(ctx, { noteAiUsage, flushAiUsage, aiUsageKey,\n' +
    '  pending: () => AI_USAGE_PENDING,\n' +
    '  resetBuffer: () => { AI_USAGE_BUF = null; AI_USAGE_PENDING = 0; AI_USAGE_LAST_FLUSH = Date.now(); } });',
  )(c, kvImpl, () => false, localDateStr, fakeDate);
  return c;
}

const ctx = makeCounters(fakeKv);
const { noteAiUsage, flushAiUsage, aiUsageKey } = ctx;

const tctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', liftConst('AI_CLASSIFY_TURNS') + '\n' + lift('transcript') +
  'Object.assign(ctx, { transcript, AI_CLASSIFY_TURNS });')(tctx);
const { transcript, AI_CLASSIFY_TURNS } = tctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const stored = (date) => JSON.parse(STORE.get(aiUsageKey(date)) || 'null');
const TODAY = '2026-08-25';

console.log('\n=== counting is cheap: many AI calls, few KV writes ===');
ctx.resetBuffer(); STORE.clear(); WRITES = 0;
for (let i = 0; i < 7; i++) await noteAiUsage('keyboard', 'gemini', 100, 20, false);
check('seven calls have not written yet', WRITES, 0);
check('...but they are buffered', ctx.pending(), 7);
await noteAiUsage('keyboard', 'gemini', 100, 20, false);
check('the eighth call triggers exactly one write', WRITES, 1);
check('and the buffer is empty again', ctx.pending(), 0);
check('all eight calls landed', stored(TODAY).by.keyboard, { calls: 8, in: 800, out: 160, errors: 0 });

console.log('\n=== a second batch adds to the day, it does not replace it ===');
for (let i = 0; i < 8; i++) await noteAiUsage('keyboard', 'gemini', 50, 10, false);
check('two writes for sixteen calls', WRITES, 2);
check('the day now holds both batches', stored(TODAY).by.keyboard, { calls: 16, in: 1200, out: 240, errors: 0 });

console.log('\n=== surfaces are counted apart, and providers are labelled ===');
ctx.resetBuffer(); STORE.clear(); WRITES = 0;
await noteAiUsage('recap', 'gemini', 900, 30, false);
await noteAiUsage('reply draft', 'claude', 1200, 90, false);
await noteAiUsage('reply draft', 'gemini', 1100, 80, false);
await flushAiUsage();
check('one write for the flush', WRITES, 1);
check('the gemini surface', stored(TODAY).by['reply draft'], { calls: 1, in: 1100, out: 80, errors: 0 });
check('the claude one is kept separate — it is a different bill',
  stored(TODAY).by['reply draft (claude)'], { calls: 1, in: 1200, out: 90, errors: 0 });
check('and the recap surface is its own row', stored(TODAY).by.recap.calls, 1);

console.log('\n=== a failing surface is counted, not swallowed ===');
// A feature erroring all day and a feature nobody uses both show zero tokens.
// Only the error count tells them apart, which is the whole reason it is here.
ctx.resetBuffer(); STORE.clear(); WRITES = 0;
for (let i = 0; i < 4; i++) await noteAiUsage('appointment detect', 'gemini', 0, 0, true);
await flushAiUsage();
check('four failures recorded', stored(TODAY).by['appointment detect'],
  { calls: 4, in: 0, out: 0, errors: 4 });

console.log('\n=== nothing buffered, nothing written ===');
WRITES = 0;
await flushAiUsage();
await flushAiUsage();
check('flushing an empty buffer is free', WRITES, 0);

console.log('\n=== a day boundary mid-buffer does not misfile the tail ===');
ctx.resetBuffer(); STORE.clear(); WRITES = 0;
await noteAiUsage('recap', 'gemini', 10, 5, false);
CLOCK = Date.parse('2026-08-26T18:00:00Z');
await noteAiUsage('recap', 'gemini', 20, 7, false);
await flushAiUsage();
check("yesterday's call stayed on yesterday", stored('2026-08-25').by.recap, { calls: 1, in: 10, out: 5, errors: 0 });
check("today's call is on today", stored('2026-08-26').by.recap, { calls: 1, in: 20, out: 7, errors: 0 });
CLOCK = Date.parse('2026-08-25T18:00:00Z');

console.log('\n=== a KV failure loses the write, never the counts ===');
STORE.clear(); WRITES = 0;
// Break the store, flush, then let it heal. Losing a write is fine; losing the
// counts behind it would mean the usage screen quietly under-reports forever.
let broken = true;
const flaky = makeCounters(() => broken
  ? { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } }
  : fakeKv());
await flaky.noteAiUsage('coach', 'gemini', 33, 3, false);
await flaky.flushAiUsage();
check('a failed write keeps the counts pending for the next try', flaky.pending() > 0, true);
check('and wrote nothing', WRITES, 0);
broken = false;
await flaky.flushAiUsage();
check('they land once KV comes back', stored(TODAY).by.coach, { calls: 1, in: 33, out: 3, errors: 0 });

console.log('\n=== classification prompts read a dozen turns, not forty ===');
const long = { messages: Array.from({ length: 60 }, (_, i) => ({ dir: i % 2 ? 'out' : 'in', body: 'm' + i })) };
check('the classify budget is 12', AI_CLASSIFY_TURNS, 12);
check('a classify prompt gets 12 lines', transcript(long, AI_CLASSIFY_TURNS).split('\n').length, 12);
check('and it is the RECENT 12 (the newest message is last)',
  transcript(long, AI_CLASSIFY_TURNS).split('\n').pop(), 'Mikey: m59');
check('drafting still gets the full 40', transcript(long).split('\n').length, 40);

console.log('\n=== the off-switches default the way he asked ===');
// Read straight out of the source: these are the values a fresh config inherits,
// and both were flipped deliberately. A stored config from before the change has
// neither key, so the default is what actually decides behaviour today.
const defaults = SRC.slice(SRC.indexOf('function defaultConfig()'));
check('both daily emails start paused', /dailyEmailsPaused: true,/.test(defaults), true);
check('the paid half of the keyboard starts off', /predictiveAi: false,/.test(defaults), true);
check('the free local keyboard is untouched', /predictive: true,/.test(defaults), true);

console.log('\n=== the pause is actually honoured by the cron ===');
check('the morning brief checks it',
  /async function maybeDailyBrief\(\)[\s\S]{0,300}?if \(cfg\.dailyEmailsPaused\) return;/.test(SRC), true);
check("the evening money nudge checks it too",
  /if \(!mainCfg\.dailyEmailsPaused &&\s*\n?\s*cfg\.reminderEnabled !== false/.test(SRC), true);
check('the weekly recap is NOT gated by it — only the daily pair was paused',
  /async function maybeWeeklyRecap\(\)[\s\S]{0,400}?dailyEmailsPaused/.test(SRC), false);

console.log('\n=== the ungated inbound triage call is gated now ===');
check('a settled conversation skips assistAsk entirely',
  /suggestion\.verdict && suggestion\.verdict\.needed === false[\s\S]{0,200}?: await assistAsk\(/.test(SRC), true);
check("and the alert still says 'nothing needed' for free",
  /kind: 'chitchat'/.test(SRC), true);
check('the keyboard refuses to spend while switched off',
  /preCfg\.predictiveAi !== true\) return json\(\{ ok: false, error: 'no_ai' \}/.test(SRC), true);

console.log('\n=== every AI call site says which surface it is ===');
// The counters are only useful if nothing lands in the "other" bucket. Any new
// geminiGenerate/aiGenerate call has to carry a surface, and this is what says so.
const callSites = SRC.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /\b(geminiGenerate|aiGenerate)\(/.test(l)
    && !/^\s*(async )?function /.test(l)
    && !/return geminiGenerate\(prompt, opts\);/.test(l));
// A multi-line call puts its options object a few lines below the call itself,
// so look down to the closing paren rather than at that one line.
const LINES = SRC.split('\n');
const untagged = callSites.filter(([i]) => !LINES.slice(i - 1, i + 8).join('\n').split(/\);/)[0].includes("surface: '"));
check(`all ${callSites.length} call sites are tagged`, untagged.map(([i]) => i), []);

console.log('\n=== the daily budget: a ceiling that degrades, never one that stops ===');
// Claude writes the texts a customer reads and is metered per token, so this is
// the guard between "the drafts got better" and "the bill got interesting". The
// behaviour being pinned down here is the one that matters most: going over
// budget must move drafting to the free model, NEVER leave him unable to reply.
let READS = 0;
const budgetKv = () => ({
  get: async (k, o) => {
    READS++;
    const raw = STORE.get(k);
    if (raw == null) return null;
    return (o && o.type === 'json') ? JSON.parse(raw) : raw;
  },
  put: async (k, v) => { WRITES++; STORE.set(k, v); },
});

// A fresh copy of the router with both providers stubbed, so a test can see
// which one actually wrote the text.
function makeRouter(env, opts = {}) {
  const r = { calls: [] };
  const claude = async (prompt, o) => {
    r.calls.push('claude');
    if (opts.claudeThrows) throw new Error('Anthropic 529: overloaded');
    return 'claude wrote this';
  };
  const gemini = async (prompt, o) => { r.calls.push('gemini'); return 'gemini wrote this'; };
  // eslint-disable-next-line no-new-func
  new Function('ctx', 'ENV', 'kv', 'envFlag', 'localDateStr', 'Date', 'aiUsageKey',
    'claudeGenerate', 'geminiGenerate',
    'let CFG_CACHE = { tz: "America/Los_Angeles" };\n' +
    liftSpan('const AI_PRICE_PER_M', 'aiGenerate') + '\n' +
    'Object.assign(ctx, { aiGenerate, claudeCost, aiDailyBudget, claudeModel,\n' +
    '  claudeSpentToday, noteClaudeSpend,\n' +
    '  resetSpend: () => { CLAUDE_SPEND = null; } });',
  )(r, env, budgetKv, () => !!env.CLAUDE_DISABLED, localDateStr, fakeDate, aiUsageKey, claude, gemini);
  return r;
}

const KEYED = { ANTHROPIC_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' };

// --- pricing ---------------------------------------------------------------
let R = makeRouter(KEYED);
check('a million tokens each way on Opus 5 is $30', R.claudeCost(1e6, 1e6), 30);
check('output is the expensive half', R.claudeCost(0, 1e6), 25);
check('a typical draft — 3k in, 300 out — is about two cents',
  Math.round(R.claudeCost(3000, 300) * 1000) / 1000, 0.023);
check('a negative count cannot credit the budget back', R.claudeCost(-5e6, 0), 0);

// --- the ceiling itself ----------------------------------------------------
check('the default ceiling is a dollar a day', R.aiDailyBudget(), 1);
check('a var overrides it without a deploy', makeRouter(Object.assign({}, KEYED, { ANTHROPIC_DAILY_BUDGET: '0.25' })).aiDailyBudget(), 0.25);
check('nonsense falls back to the default rather than to infinity',
  makeRouter(Object.assign({}, KEYED, { ANTHROPIC_DAILY_BUDGET: 'free' })).aiDailyBudget(), 1);
check('and the model is the one being priced', R.claudeModel(), 'claude-opus-5');

// --- routing ---------------------------------------------------------------
STORE.clear(); R = makeRouter(KEYED); R.resetSpend();
check('inside the budget, Claude writes the customer-facing text',
  await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' }), 'claude wrote this');

STORE.clear(); R = makeRouter(KEYED); R.resetSpend();
check('a fast-tier call never reaches Claude at all',
  await R.aiGenerate('classify this', { tier: 'fast', surface: 'keyboard' }), 'gemini wrote this');

// A day that already spent the ceiling, written the way noteAiUsage files it.
STORE.clear();
STORE.set(aiUsageKey(TODAY), JSON.stringify({ date: TODAY, by: {
  'reply draft (claude)': { calls: 60, in: 400000, out: 40000, errors: 0 },
} }));
R = makeRouter(KEYED); R.resetSpend();
const overBudget = await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' });
check('past the ceiling it keeps drafting — on Gemini', overBudget, 'gemini wrote this');
check('and it did not try Claude first', R.calls, ['gemini']);

// The whole point: spent budget must not read as a broken dashboard.
check('spending the budget never throws', typeof overBudget, 'string');

// --- the kill switches -----------------------------------------------------
STORE.clear();
R = makeRouter(Object.assign({}, KEYED, { ANTHROPIC_DAILY_BUDGET: '0' })); R.resetSpend();
check('a budget of zero is a full stop back to Gemini',
  await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' }), 'gemini wrote this');
R = makeRouter(Object.assign({}, KEYED, { CLAUDE_DISABLED: '1' })); R.resetSpend();
check('CLAUDE_DISABLED still wins outright',
  await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' }), 'gemini wrote this');

// --- an outage is not a budget problem -------------------------------------
STORE.clear(); R = makeRouter(KEYED, { claudeThrows: true }); R.resetSpend();
check('a provider outage falls through to Gemini rather than failing the draft',
  await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' }), 'gemini wrote this');
check('and it did try Claude first', R.calls, ['claude', 'gemini']);

// --- a burst inside one isolate is caught before KV hears about it ---------
STORE.clear(); R = makeRouter(KEYED); R.resetSpend();
await R.claudeSpentToday();               // seeds the day at $0
R.noteClaudeSpend(200000, 20000);         // $1.50 of drafting, none of it flushed yet
check('an in-flight burst counts against the budget immediately',
  await R.aiGenerate('draft this', { tier: 'voice', surface: 'reply draft' }), 'gemini wrote this');

// --- the gate must not cost a read per draft -------------------------------
STORE.clear(); R = makeRouter(KEYED); R.resetSpend();
READS = 0;
for (let i = 0; i < 12; i++) await R.aiGenerate('draft', { tier: 'voice', surface: 'reply draft' });
check('twelve drafts cost one KV read between them, not twelve', READS, 1);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
