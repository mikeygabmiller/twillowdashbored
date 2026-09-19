// Does it sound like Mikey, or does it sound like software?
//
// Every template in here is a text that lands on a real customer's phone with
// his name on it. They were hand-written at different times by different people
// and had drifted a long way from how he actually talks: em dashes, "circling
// back", "would mean the world", "your vehicle is done and looking great", a 🚗
// on the end. The repo already had a list of phrases that give a machine away
// (AI_TELLS) but it only ever ran against AI-generated drafts, so the fixed
// templates, which are most of what actually gets sent, were never checked
// against it. This suite points that gate at them.
//
// It also holds the two structural things, which matter more than any single
// phrase:
//   - the same message must NOT be byte-identical for two different customers
//   - the same customer must get the SAME wording every time, or the scheduled
//     banner is showing him something other than what will send
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['sayOneOf', 'bkMessage', 'dayJobText', 'followupTemplate', 'coldDraft',
  'planDraft', 'wxHeadsUpDraft', 'quoteMessage', 'findTell', 'AI_TELLS'];

const kv = { async get() { return null; }, async put() {}, async delete() {}, async list() { return { keys: [] }; } };
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });

const M = new Function('__env__', src + '\n; ENV = __env__; return {' + EXPORTS.join(',') + '};')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// --- the corpus: every fixed text a customer can receive --------------------
const BK = { phone: '+14255550111', name: 'Dana Reed', slot: '10:00', dateLabel: 'Tue, Aug 4',
  serviceName: 'Full Detail', vehicle: '2019 Subaru Outback', id: 'bk1' };
const JOB = { phone: '+14255550111', name: 'Dana Reed', id: 'm:1' };
const CFG = { reviewUrl: 'https://g.page/r/xyz', rebookDays: 90 };

function corpus(phone) {
  const bk = { ...BK, phone }, job = { ...JOB, phone };
  const out = [];
  for (const k of ['confirm', 'remind24', 'remindAm', 'cancelled', 'declined']) out.push([`booking:${k}`, M.bkMessage(k, bk)]);
  out.push(['run:enroute', M.dayJobText('enroute', job, { etaMin: 20 }, { url: 'https://x.co/t/1' }, CFG)]);
  out.push(['run:onsite', M.dayJobText('onsite', job, {}, null, CFG)]);
  out.push(['run:done', M.dayJobText('done', job, {}, null, CFG)]);
  const thread = { phone, name: 'Dana Reed', messages: [] };
  const steps = [['owed', 0, 'owed:1'], ['nudge', 1, 'nudge:1'], ['nudge', 2, 'nudge:2'], ['nudge', 3, 'nudge:3'],
    ['won', 1, 'won:review'], ['won', 2, 'won:rebook'], ['lost', 1, 'lost:revival']];
  for (const [stage, step, stepKey] of steps) out.push([`followup:${stepKey}`, M.followupTemplate(thread, { stage, step, stepKey }, CFG)]);
  const row = { phone, name: 'Dana Reed', vehicle: '2019 Subaru Outback', service: 'Full Detail', months: 5, every: 42 };
  for (const k of ['quote', 'rebook', 'never']) out.push([`cold:${k}`, M.coldDraft(k, row, CFG)]);
  out.push(['plan', M.planDraft(row)]);
  out.push(['weather', M.wxHeadsUpDraft({ name: 'Dana Reed', slot: '10:00' }, '2026-09-20', 70, '2026-09-21', '2026-09-19')]);
  return out;
}

const TEXTS = corpus('+14255550111');

section('nothing a customer gets trips the repo\'s own tell-blocker');
for (const [label, text] of TEXTS) {
  const tell = M.findTell(text);
  ok(`${label} is clean`, !tell, tell ? `"${tell}" in: ${text}` : undefined);
}

section('no em dash, anywhere (it also flips the SMS to UCS-2 and doubles the bill)');
for (const [label, text] of TEXTS) ok(`${label}`, !/—/.test(text), text);

section('no emoji in a customer text (same segment cost, and he does not use them)');
// Matches the pictographic ranges; the playbook already says "no emoji graphics".
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const [label, text] of TEXTS) ok(`${label}`, !EMOJI.test(text), text);

section('he does not sign every single text');
const signed = TEXTS.filter(([, t]) => /-\s*Mikey\s*$/.test(t));
ok('some texts are signed', signed.length >= 1, signed.map((s) => s[0]));
ok('but nowhere near all of them', signed.length < TEXTS.length / 2, `${signed.length} of ${TEXTS.length}`);

section('nothing runs long enough to split into extra SMS segments');
for (const [label, text] of TEXTS) ok(`${label} under 320 chars`, text.length <= 320, text.length);

section('two customers do not get word-for-word identical texts');
// The point of sayOneOf. Across a realistic spread of numbers, at least one of
// the recurring messages has to come out differently for different people.
const PHONES = ['+14255550111', '+14255550222', '+14255550333', '+14255550444', '+14255550555'];
const byLabel = {};
for (const p of PHONES) for (const [label, text] of corpus(p)) (byLabel[label] = byLabel[label] || []).push(text);
let varied = 0;
for (const label of Object.keys(byLabel)) if (new Set(byLabel[label]).size > 1) varied++;
ok('most templates vary across recipients', varied >= Object.keys(byLabel).length * 0.6, `${varied}/${Object.keys(byLabel).length}`);

section('…but one customer always gets the same wording (so the preview is honest)');
const first = corpus('+14255550222');
const again = corpus('+14255550222');
ok('rebuilding is byte-identical', JSON.stringify(first) === JSON.stringify(again));

section('sayOneOf itself');
ok('empty list is safe', M.sayOneOf('x', []) === '');
ok('a single option is always that option', M.sayOneOf('anything', ['only']) === 'only');
ok('a null seed does not throw', typeof M.sayOneOf(null, ['a', 'b']) === 'string');
ok('it spreads across the options', new Set(PHONES.concat(['+14255550666', '+14255550777'])
  .map((p) => M.sayOneOf(p, ['a', 'b', 'c']))).size > 1);

section('the facts still survive the rewording');
const bk = M.bkMessage('confirm', BK);
ok('the confirm still names the date', /Aug 4/.test(bk), bk);
ok('…the time', /10:00 AM/.test(bk), bk);
ok('…and the service', /Full Detail/.test(bk), bk);
ok('…and still says he needs water and power', /spigot|faucet/i.test(bk) && /outlet|plug/i.test(bk), bk);
const done = M.dayJobText('done', JOB, {}, null, CFG);
ok('the review ask still carries the link', done.includes(CFG.reviewUrl), done);
ok('no review link configured means no review ask', !/review/i.test(M.dayJobText('done', JOB, {}, null, {})));
const plan = M.planDraft({ phone: '+1', name: 'Dana', vehicle: 'Subaru', every: 42 });
ok('the plan draft still states the interval', /every-6-week plan/.test(plan), plan);
ok('…and still names the car', /Subaru/.test(plan), plan);
const rebook = M.coldDraft('rebook', { phone: '+1', name: 'Dana', vehicle: 'Subaru', months: 5 });
ok('the rebook draft never invents a price or a day',
  !/\$|\bmonday\b|\btuesday\b|\bwednesday\b/i.test(rebook), rebook);

section('the tell-blocker learned the phrases that were in the old templates');
for (const phrase of ['circling back on that quote', 'it would mean the world', 'no pressure at all', 'just following up on your detail']) {
  ok(`"${phrase}" is now caught`, !!M.findTell(phrase), phrase);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
