// Win-back list: who is overdue for a detail, and the draft each one is offered.
// Runs the real worker (the whole file, like channels.test.js) against an
// in-memory KV.
//
// What has to hold:
//   · someone past their usual gap is on the list with a draft to start from
//   · someone with a job already on the calendar is NOT on it (they're coming back)
//   · "Do not text" stays on the list, flagged, and is never handed a draft
//   · a chat that already has a reply waiting is flagged so nothing overwrites it
//   · the draft follows his rules for customer texts: plain words, no em dash,
//     no price, no offer
//   · saving the draft only puts it in the Reply ready box. Nothing is texted.
//
//   node test/winback.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const EXPORTS = ['apiIntelCustomers', 'apiMeta', 'winbackDraft', 'winbackAgo', 'loadThread', 'saveThread',
  'updateIndexEntry', 'loadIndex', 'setOptOut'];

const store = new Map(), meta = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); },
  async delete(k) { store.delete(k); meta.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name, metadata: meta.get(name) })), list_complete: true };
  },
};
const sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.twilio.com')) { sms.push(String(opts.body)); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  return { ok: false, status: 404, text: async () => 'no' };
};
const M = new Function('__env__', src + '\n; ENV = __env__; return {' + EXPORTS.join(',') + '};')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const body = async (r) => (r && typeof r.json === 'function' ? r.json() : r);
const DAY = 86400000, now = Date.now();
const dayStr = (ago) => new Date(now - ago * DAY).toISOString().slice(0, 10);

// The ledger: one doc per month, the way the Money tracker stores it.
const months = new Map();
const job = (phone, name, ago, amount) => {
  const date = dayStr(ago), m = date.slice(0, 7);
  if (!months.has(m)) months.set(m, []);
  months.get(m).push({ type: 'job', phone, name, date, amount, ts: now - ago * DAY });
};
const SARAH = '+14255550101', BOOKED = '+14255550102', STOP = '+14255550103', READY = '+14255550104',
  FRESH = '+14255550105', TEXTED = '+14255550106';
// Sarah: every ~60 days, now 150 days quiet.
job(SARAH, 'SARAH JOHNSON', 270, 300); job(SARAH, 'SARAH JOHNSON', 210, 300); job(SARAH, 'SARAH JOHNSON', 150, 320);
// Same shape, but each has a reason the list should treat them differently.
for (const [p, n] of [[BOOKED, 'Bo Booked'], [STOP, 'Stan Stop'], [READY, 'Rae Ready'], [TEXTED, 'Tess Texted']]) {
  job(p, n, 270, 200); job(p, n, 210, 200); job(p, n, 150, 200);
}
// Fresh: same cadence, last job 20 days ago. Not overdue.
job(FRESH, 'Fran Fresh', 140, 250); job(FRESH, 'Fran Fresh', 80, 250); job(FRESH, 'Fran Fresh', 20, 250);
for (const [m, entries] of months) await kv.put('money:m:' + m, JSON.stringify({ entries }));

const mk = async (phone, name, patch, msgs) => {
  const t = await M.loadThread(phone);
  t.name = name;
  t.messages = msgs || [{ dir: 'out', body: 'Thanks again!', ts: now - 150 * DAY }];
  Object.assign(t, patch || {});
  await M.saveThread(t); await M.updateIndexEntry(t);
};
await mk(SARAH, 'Sarah Johnson');
await mk(BOOKED, 'Bo Booked', { appointmentAt: now + 5 * DAY });
await mk(STOP, 'Stan Stop');
await mk(READY, 'Rae Ready', { suggested: { text: 'Sure, Tuesday works.', ts: now, forTs: 0, by: 'ai' } });
await mk(TEXTED, 'Tess Texted', {}, [{ dir: 'out', body: 'Hey Tess, want to get on the schedule?', ts: now - 9 * DAY }]);
await M.setOptOut(STOP, true);
await M.updateIndexEntry(await M.loadThread(STOP));

section('Who is on the list');
const d = await body(await M.apiIntelCustomers());
const wb = d.winback || [], by = (p) => wb.find((w) => w.phone === p);
ok('the report loads', d.ok === true);
ok('someone 150 days quiet on a 60-day habit is on it', !!by(SARAH), wb.map((w) => w.phone));
ok('with how long it has been and their usual gap', by(SARAH) && by(SARAH).daysSince === 150 && by(SARAH).due === 60, by(SARAH));
ok('someone last seen 20 days ago is not', !by(FRESH));
ok('someone with a job already on the calendar is not', !by(BOOKED));
ok('richest-per-quiet-day first', wb[0] && wb[0].phone === SARAH, wb.map((w) => w.name));

section('What each row lets him do');
ok('a normal row carries a draft', by(SARAH) && by(SARAH).draft.length > 40);
ok('Do not text is still listed, flagged', by(STOP) && by(STOP).doNotText === true, by(STOP));
ok('and is never handed a draft', by(STOP) && by(STOP).draft === '');
ok('a chat with a reply already waiting is flagged', by(READY) && by(READY).replyReady === true, by(READY));
ok('a chat with nothing waiting is not', by(SARAH) && by(SARAH).replyReady === false && by(SARAH).waiting === false);
ok('says when he already texted them lately', by(TEXTED) && by(TEXTED).textedDays === 9, by(TEXTED));

section('The draft');
const dr = by(SARAH).draft;
ok('opens with their first name, not shouted', dr.startsWith("Hey Sarah, it's Mikey"), dr);
ok('says roughly how long it has been', dr.includes('about 5 months'), dr);
ok('no em or en dash', !/[—–]/.test(dr));
ok('no price, no percent, no offer', !/\$|\d\s*%|discount|off\b|free\b|deal/i.test(dr), dr);
ok('asks them to text back', /text me/i.test(dr));
ok('a dash in a saved name never reaches the text', !/[—–]/.test(M.winbackDraft('Sarah — Tahoe', 100)));
ok('a phone number where the name should be is left out', M.winbackDraft('(425) 555-0101', 100).startsWith("Hey, it's Mikey"));
ok('no name at all still reads right', M.winbackDraft('', 100).startsWith("Hey, it's Mikey"));
ok('time in plain words', M.winbackAgo(30) === 'a few weeks' && M.winbackAgo(60) === 'a couple months' &&
  M.winbackAgo(120) === 'about 4 months' && M.winbackAgo(370) === 'about a year' && M.winbackAgo(800) === 'over a year');

section('Saving the draft sends nothing');
const before = (await M.loadThread(SARAH)).messages.length;
const r = await body(await M.apiMeta({ json: async () => ({ phone: SARAH, draft: dr, draftBy: 'winback' }),
  headers: { get: () => 'application/json' }, url: 'https://texting.example.workers.dev/api/meta' }));
const after = await M.loadThread(SARAH);
ok('the save succeeds', r && r.ok !== false, r);
ok('the draft is in the Reply ready box', after.suggested && after.suggested.text === dr && after.suggested.manual === true, after.suggested);
ok('marked as a win-back draft', after.suggested && after.suggested.by === 'winback');
ok('no message was added to the conversation', after.messages.length === before);
ok('nothing was texted to anyone', sms.length === 0, sms);
const d2 = await body(await M.apiIntelCustomers());
const s2 = (d2.winback || []).find((w) => w.phone === SARAH);
ok('the list now shows that chat has a reply ready', s2 && s2.replyReady === true, s2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
