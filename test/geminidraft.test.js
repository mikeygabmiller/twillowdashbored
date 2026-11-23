// Gemini as the drafter (2026-11-23). Claude can't be paid for right now, so
// every reply draft is Gemini's. These check the knobs the replay test uses to
// compare setups, and the two fixes that came with them: the replay no longer
// hands the model its own answer, and a Claude that failed for money or a bad
// key is rested instead of costing every draft two dead round trips.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const EXPORTS = ['geminiGenerate', 'aiGenerate', 'voiceExchanges', 'GEMINI_DRAFT', 'resetInvocationCaches', 'findInventedReplyTime', 'recentTranscript'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
};
const calls = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('generativelanguage')) { calls.push({ to: 'gemini', url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sounds good, Friday at 1 works.' }] }, finishReason: 'STOP' }] }) }; }
  if (url.includes('api.anthropic.com')) { calls.push({ to: 'claude' }); return { ok: false, status: 401, text: async () => '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }; }
  return { ok: false, status: 404, text: async () => 'no' };
};
const M = new Function('__env__', src + '\n; ENV = __env__; return {' + EXPORTS.join(',') + '};')({
  MESSAGES: kv, GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'sk-ant-bad', AI_BINDING_OFF: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('Gemini, asked the old way (what every other AI feature still uses)');
calls.length = 0;
await M.geminiGenerate('PROMPT', { maxTokens: 800 });
let b = calls[0].body;
ok('one user turn with the prompt', b.contents.length === 1 && b.contents[0].parts[0].text === 'PROMPT');
ok('thinking off on 2.5 flash', b.generationConfig.thinkingConfig.thinkingBudget === 0 && b.generationConfig.maxOutputTokens === 800);
ok('no system instruction', !b.systemInstruction);

section('Gemini, asked natively: instructions as system, his exchanges as real turns');
calls.length = 0;
const turns = [
  { role: 'user', content: 'A customer texted: "how much for a civic"' }, { role: 'assistant', content: 'Interior for your Civic is $249.' },
  { role: 'user', content: 'A customer texted: "saturday?"' }, { role: 'assistant', content: 'Saturday at 7 works!' },
];
await M.geminiGenerate('NOW THIS ONE', { native: true, system: 'YOU ARE MIKEY', turns, maxTokens: 800, think: 512, model: 'gemini-2.5-flash' });
b = calls[0].body;
ok('system instruction carries the standing rules', b.systemInstruction && b.systemInstruction.parts[0].text === 'YOU ARE MIKEY');
ok('turns alternate customer then him', b.contents.map((c) => c.role).join() === 'user,model,user,model,user', b.contents.map((c) => c.role));
ok('his reply is the model\'s own turn', b.contents[1].parts[0].text === 'Interior for your Civic is $249.');
ok('the real ask comes last', b.contents[4].parts[0].text === 'NOW THIS ONE');
ok('a thinking budget is added on top of the reply room', b.generationConfig.thinkingConfig.thinkingBudget === 512 && b.generationConfig.maxOutputTokens === 1312, b.generationConfig);
calls.length = 0;
await M.geminiGenerate('X', { native: true, system: 'S', turns: [], model: 'gemini-2.5-pro' });
ok('a model can be named for drafts only', /models\/gemini-2\.5-pro:/.test(calls[0].url));
ok('pro never gets thinking 0 (it refuses it)', calls[0].body.generationConfig.thinkingConfig.thinkingBudget > 0);

section('The replay no longer hands the model its own answer');
const voice = { buckets: { schedule: [
  { t: 'Saturday at 7 works for me!', q: 'can you do saturday', s: 'sent' },
  { t: 'Friday at 1 works', q: 'friday?', s: 'sent' },
], price: [], offer: [], confirm: [], answer: [], apology: [], closing: [], quick: [], general: [] } };
const all = M.voiceExchanges(voice, 'schedule', 'can you do saturday');
ok('normally his matching reply is an example', JSON.stringify(all).includes('Saturday at 7 works for me!'));
const hid = M.voiceExchanges(voice, 'schedule', 'can you do saturday', 'Saturday at 7  works for me!');
ok('with it excluded, it is gone (spacing and case ignored)', !JSON.stringify(hid).toLowerCase().includes('saturday at 7 works for me'));
ok('…and the rest are still there', JSON.stringify(hid).includes('Friday at 1 works'));

section('A Claude with a bad key is rested, not retried on every draft');
calls.length = 0;
await M.aiGenerate('P', { tier: 'voice', surface: 'reply draft' });
ok('first draft tries Claude, then lands on Gemini', calls.map((c) => c.to).join() === 'claude,gemini', calls.map((c) => c.to));
calls.length = 0;
await M.aiGenerate('P', { tier: 'voice', surface: 'reply draft' });
ok('the next one goes straight to Gemini', calls.map((c) => c.to).join() === 'gemini', calls.map((c) => c.to));
calls.length = 0;
const o = { tier: 'voice', surface: 'reply draft', system: 'S', turns, gemini: { native: true, think: 256 } };
await M.aiGenerate('P', o);
ok('a draft setup reaches Gemini natively', calls[0].body.systemInstruction && calls[0].body.contents.length === 5 && calls[0].body.generationConfig.thinkingConfig.thinkingBudget === 256);
ok('and still says Gemini wrote it', o.usedProvider === 'gemini');

section('Drafts are asked natively by default (the replay test, 2026-11-23)');
ok('GEMINI_DRAFT is native, no thinking, default model', M.GEMINI_DRAFT.native === true && M.GEMINI_DRAFT.think === 0 && !M.GEMINI_DRAFT.model);

section('A draft never offers a time or date nobody agreed');
const T = (d, conv) => M.findInventedReplyTime(d, ['', conv]);
ok('catches a made-up date and time (from the replay)', T('I can do the 24th at 2pm if that works for you.', 'Customer: how about either 23rd, or 24th.') === '2');
ok('catches a made-up time with minutes', T('Can we do 12:30?', 'Customer: That is fine what time?') === '12:30');
ok('catches "noon" out of nowhere', T('Be there around noon', 'Customer: ok') === '12');
ok('catches a made-up date on its own', T('Let\'s lock in the 23rd.', 'Customer: sometime next week?') === '23rd');
ok('a time the customer said is fine, even without pm', T('Perfect! Tuesday at 3pm works. What is your address?', 'Customer: I can be home at 3 on Tuesday.') === '');
ok('"after 3 pm" covers 3pm', T('I can do Wednesday after 3pm?', 'Customer: I arrive after 3 pm.') === '');
ok('a time Mikey already gave is fine', T('See you Tuesday at 3!', 'Mikey: Tuesday at 3 works!') === '');
ok('1:00 and 1pm are the same time', T('Sure, 1pm works', 'Customer: can you do 1:00?') === '');
ok('a date from 11/24 or Nov 24 counts', T('See you on the 24th', 'Customer: is 11/24 ok?') === '' && T('See you on the 24th', 'Customer: Nov 24 work?') === '');
ok('his answer to a "Needs you" question counts as given', M.findInventedReplyTime('I can do Friday at 2pm.', ['The owner has decided: Friday at 2pm', 'Customer: when?']) === '');
ok('no time at all passes', T('Yep, I can come by this week. What is your address?', 'Customer: still coming?') === '');
ok('"3 kids" is not a time', T('See you at 3pm', 'Customer: I have 3 kids') === '3');

section('Only the live part of a conversation can back a time');
{
  const D = 86400000, n = 1795400000000;
  const th = { messages: [
    { dir: 'out', body: 'See you the 24th at 2pm', ts: n - 30 * D },
    ...Array.from({ length: 3 }, (_, i) => ({ dir: 'in', body: 'ok ' + i, ts: n - 29 * D + i })),
    { dir: 'in', body: 'how about either 23rd, or 24th', ts: n },
  ] };
  const r = M.recentTranscript(th);
  ok('a time from a job a month ago is left out', !/2pm/.test(r) && /23rd, or 24th/.test(r), r);
  ok('so "the 24th at 2pm" is caught (the replay case)', M.findInventedReplyTime('I can do the 24th at 2pm if that works.', ['', r]) === '2');
  const many = { messages: Array.from({ length: 12 }, (_, i) => ({ dir: i % 2 ? 'out' : 'in', body: i === 0 ? 'at 5 works' : 'msg ' + i, ts: n + i })) };
  ok('only the last 8 texts count', !/at 5 works/.test(M.recentTranscript(many)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
