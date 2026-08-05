// Appointment auto-detect — the job you never wrote down.
//
// Loads the real Worker source, stubs KV / Twilio / Resend / Gemini, and asserts
// on behaviour rather than shape. The point of this module is that it NEVER acts
// on its own, so most of what's checked here is what it refuses to do.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
// The Worker imports the morning-rundown modules; `new Function` can't hold an
// import statement, so they're stripped and stubbed. Nothing in this file
// exercises the rundown — it has its own suite in digest.test.mjs.
src = src.replace(/^import[^\n]*\n/gm, '');
src = 'const digestRoute = async () => null, digestCron = async () => {}, ' +
      'digestIngest = async () => ({ ok: true, reply: "" });\n' + src;

const EXPORTS = ['detLooksSchedulish', 'detDefaults', 'sanitizeDetect', 'detApply', 'detHeldSlots',
  'loadDetections', 'saveDetections', 'apiDetections', 'apiDetectionAction', 'detConfirmDraft',
  'bkLaEpoch', 'bkAvailability', 'loadThread', 'saveThread', 'loadDay', 'buildDay', 'localDateStr'];

const store = new Map();
let writes = 0;
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); writes++; },
  async delete(k) { store.delete(k); writes++; },
};
const alerts = [], sms = [];
let GEMINI = '{}';
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI }] }, finishReason: 'STOP' }] }) };
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) { const p = new URLSearchParams(String(opts.body)); sms.push({ to: p.get('To'), body: p.get('Body') }); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  if (url.includes('open-meteo')) return { ok: true, json: async () => ({ daily: { time: [], precipitation_probability_max: [] } }) };
  return { ok: false, status: 404, text: async () => 'no' };
};

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ CFG_CACHE = null; }});')({
  MESSAGES: kv, GEMINI_API_KEY: 'k', RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b });
const act = async (b) => (await M.apiDetectionAction(req(b))).json();
const DC = M.detDefaults();

// --------------------------------------------------------------- prefilter
section('Prefilter — the free regex that decides whether to pay for an AI call');
[['saturday works for me', true], ['can you do tomorrow at 10?', true], ['How about Aug 3?', true],
 ['see you at 9', true], ['lets do 8/14', true], ['sunday morning ok?', true],
 ['I need to reschedule', true], ['something came up cant make it', true],
 ['thursday afternoon would be great', true], ['next week sometime?', true],
 ['how much for an suv?', false], ['thanks!', false], ['sounds good', false],
 ['do you do ceramic coating?', false], ['my car is a 2019 tacoma', false],
 ['whats your address', false], ['can you get pet hair out', false], ['$300 is fine', false],
].forEach(([t, want]) => ok(`${want ? 'fires' : 'skips'}: "${t}"`, M.detLooksSchedulish(t, true) === want));
ok('non-eager mode needs a time, not just a day', M.detLooksSchedulish('saturday works for me', false) === false);
ok('…but still catches a day with a time', M.detLooksSchedulish('saturday at 10 works', false) === true);

// ------------------------------------------------------------- a detection
section('A detection is a CARD, never a booking');
store.clear(); alerts.length = 0;
M.__resetCfg();
const at10 = M.bkLaEpoch('2026-08-02', '10:00');
const thread = { phone: '+14255551234', name: 'Jenna', notes: '', messages: [], appointmentAt: null };
await M.detApply(thread, {
  intent: 'set', date: '2026-08-02', slot: '10:00', at: at10, tentative: false, customerConfirmed: true,
  service: 'Full Detail', vehicle: '2019 Tahoe', address: '123 Main St', city: 'Everett',
  price: 339, name: 'Jenna', notes: 'gate code 4412', confidence: 0.92, evidence: 'yes 10am saturday works',
}, DC, {});
let list = await M.loadDetections();
ok('one card raised', list.length === 1, list.length);
ok('details captured off the conversation', list[0].address === '123 Main St' && list[0].price === 339 && list[0].vehicle === '2019 Tahoe');
ok('gate code captured', list[0].notes === 'gate code 4412');
ok('nothing landed on the day board', (await M.loadDay('2026-08-02')).manual.length === 0);
ok('the conversation has no appointment yet', !(await M.loadThread('+14255551234')).appointmentAt);
ok('Mikey was alerted', alerts.length === 1);
ok('…and told it is NOT on his day', /NOT on your day/.test(alerts[0].text), alerts[0] && alerts[0].text);
ok('the customer was NOT texted', sms.length === 0, sms);

// a follow-up message updates the same card rather than stacking a new one
await M.detApply(thread, {
  intent: 'set', date: '2026-08-02', slot: '11:00', at: M.bkLaEpoch('2026-08-02', '11:00'),
  tentative: false, customerConfirmed: true, service: '', vehicle: '', address: '', city: '',
  price: 0, name: 'Jenna', notes: '', confidence: 0.9, evidence: 'actually 11 is better',
}, DC, {});
list = await M.loadDetections();
ok('still ONE card after a follow-up', list.length === 1, list.length);
ok('time updated to 11:00', list[0].slot === '11:00');
ok('previously captured address not wiped by the blank re-detect', list[0].address === '123 Main St');

// ----------------------------------------------------------------- confirm
section('Confirming hands the job to the existing day board');
let r = await act({ action: 'confirm', id: list[0].id });
ok('confirm succeeds', r.ok === true, r);
const day = await M.loadDay('2026-08-02');
ok('job is now on the day board', day.manual.length === 1, day.manual);
ok('…carrying the address', day.manual[0].address === '123 Main St');
ok('…the price', day.manual[0].price === 339);
ok('…and the slot', day.manual[0].slot === '11:00');
const th = await M.loadThread('+14255551234');
ok('conversation appointment set (what reminders + buildDay read)', th.appointmentAt === M.bkLaEpoch('2026-08-02', '11:00'), th.appointmentAt);
ok('card cleared once acted on', (await M.loadDetections()).length === 0);
ok('a draft text comes back for Mikey to send', typeof r.draft === 'string' && r.draft.length > 20, r.draft);
ok('…but nothing was sent', sms.length === 0, sms);

// --------------------------------------------------------------- guardrails
section('Guardrails — it may never move or kill a job on its own');
store.clear(); alerts.length = 0;
const booked = { phone: '+14255559999', name: 'Rob', notes: '', messages: [], appointmentAt: M.bkLaEpoch('2026-08-05', '09:00') };
await M.saveThread(Object.assign({ messages: [], scheduled: [], tags: [], linked: [] }, booked));
await M.detApply(booked, { intent: 'cancel', evidence: 'something came up, cant make it', confidence: 0.9 }, DC, {});
let rec = (await M.loadDetections())[0];
ok('a cancel raises a card', rec && rec.kind === 'cancel', rec);
ok('…and does NOT clear the appointment', (await M.loadThread('+14255559999')).appointmentAt === M.bkLaEpoch('2026-08-05', '09:00'));
ok('…Mikey is told nothing changed', /Nothing has changed/.test(alerts[alerts.length - 1].text));
await act({ action: 'accept', id: rec.id });
ok('only Mikey accepting actually cancels it', (await M.loadThread('+14255559999')).appointmentAt === null);

store.clear();
await M.saveThread(Object.assign({ messages: [], scheduled: [], tags: [], linked: [] }, booked, { appointmentAt: M.bkLaEpoch('2026-08-05', '09:00') }));
await M.detApply(booked, { intent: 'reschedule', date: '2026-08-06', slot: '14:00', at: M.bkLaEpoch('2026-08-06', '14:00'), tentative: false, customerConfirmed: true, service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', confidence: 0.9, evidence: 'can we move to thursday at 2' }, DC, {});
rec = (await M.loadDetections())[0];
ok('a reschedule raises a card', rec && rec.kind === 'reschedule');
ok('…and does NOT move the job', (await M.loadThread('+14255559999')).appointmentAt === M.bkLaEpoch('2026-08-05', '09:00'));
await act({ action: 'accept', id: rec.id });
ok('accepting moves it', (await M.loadThread('+14255559999')).appointmentAt === M.bkLaEpoch('2026-08-06', '14:00'));

store.clear();
await M.detApply({ phone: '+1425', name: '', notes: '', messages: [], appointmentAt: null },
  { intent: 'cancel', evidence: 'x', confidence: 0.9 }, DC, {});
ok('a cancel with no job on file raises nothing', (await M.loadDetections()).length === 0);

store.clear();
const t3 = { phone: '+14255551111', name: 'Sam', notes: '', messages: [], appointmentAt: at10 };
await M.detApply(t3, { intent: 'set', date: '2026-08-02', slot: '10:00', at: at10, tentative: false, customerConfirmed: true, service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', confidence: 0.9, evidence: 'x' }, DC, {});
ok('re-detecting a job already on the books raises nothing', (await M.loadDetections()).length === 0);

// dismissing is total
store.clear();
await M.detApply(thread, { intent: 'set', date: '2026-08-02', slot: '10:00', at: at10, tentative: false, customerConfirmed: false, service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', confidence: 0.5, evidence: 'x' }, DC, {});
await act({ action: 'dismiss', id: (await M.loadDetections())[0].id });
ok('dismissed card is gone for good', (await M.loadDetections()).length === 0);

// ------------------------------------------------------------------ edit
section('Editing a card before accepting it');
store.clear();
await M.detApply(thread, { intent: 'set', date: '2026-08-02', slot: '10:00', at: at10, tentative: true, customerConfirmed: false, service: '', vehicle: '', address: '', city: '', price: 0, name: 'Jenna', notes: '', confidence: 0.6, evidence: 'saturday morning' }, DC, {});
rec = (await M.loadDetections())[0];
ok('a vague time is flagged tentative', rec.tentative === true);
r = await act({ action: 'edit', id: rec.id, slot: '13:30', address: '77 Oak Ave', price: 250 });
ok('edit applies', r.ok === true && r.detection.slot === '13:30', r.detection);
ok('pinning the hour clears tentative', r.detection.tentative === false);
ok('address saved', r.detection.address === '77 Oak Ave');
ok('price saved', r.detection.price === 250);
ok('the epoch was recomputed from the new time', r.detection.at === M.bkLaEpoch('2026-08-02', '13:30'), r.detection.at);

// ------------------------------------------------------------- soft holds
section('Soft holds — the website cannot sell a slot promised over text');
store.clear(); M.__resetCfg();
await kv.put('bk:config', JSON.stringify({
  tz: 'America/Los_Angeles', workDays: [0, 1, 2, 3, 4, 5, 6], dayStart: '07:00', lastStart: '16:00',
  stepMin: 30, bufferMin: 60, maxJobsPerDay: 2, minLeadMin: 120, windowDays: 3650,
  sizes: [{ id: 'suv', label: 'SUV' }],
  services: [{ id: 'full', name: 'Full', enabled: true, price: { suv: 339 }, duration: { suv: 180 } }],
  addons: [], cities: [], content: {}, proof: {}, calendar: { enabled: false }, blockedDates: [],
}));
// A hard-coded date silently stops testing anything once it goes past — the
// availability lookup correctly refuses to offer slots in the past, so every
// assertion below degenerates to 0 === 0. Always ask about a day that is still
// in the future when the suite runs.
const HOLD_DATE = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
const free = await M.bkAvailability(HOLD_DATE, 'full', 'suv');
ok('slots open before any detection', free.length > 0, free.length);
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DATE, slot: '10:00', durationMin: 180, tentative: false }]);
const held = await M.bkAvailability(HOLD_DATE, 'full', 'suv');
ok('an UNCONFIRMED card already holds its slot', held.length < free.length, { before: free.length, after: held.length });
ok('10:00 is no longer offered', !held.includes('10:00'));
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DATE, slot: '10:00', durationMin: 180, tentative: true }]);
ok('a loose "Saturday morning" hold blocks the whole day', (await M.bkAvailability(HOLD_DATE, 'full', 'suv')).length === 0);
await M.saveDetections([]);
ok('dismissing releases the hold immediately', (await M.bkAvailability(HOLD_DATE, 'full', 'suv')).length === free.length);
M.__resetCfg();
await kv.put('config', JSON.stringify({ detect: Object.assign(M.detDefaults(), { holdSlots: false }) }));
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DATE, slot: '10:00', durationMin: 180, tentative: true }]);
ok('holds can be turned off', (await M.bkAvailability(HOLD_DATE, 'full', 'suv')).length === free.length);

// ---------------------------------------------------------------- drafting
section('The confirmation draft');
M.__resetCfg();
await kv.put('config', JSON.stringify({}));
GEMINI = '{"not":"a message"}';
let draft = await M.detConfirmDraft({ name: 'Jenna', date: '2026-08-02', slot: '10:00', service: 'Full Detail', address: '123 Main St', tentative: false }, {});
ok('a JSON blob from the model falls back to the template', /you're all set/i.test(draft), draft);
GEMINI = "You're locked in for Saturday at 10. See you then! - Mikey";
draft = await M.detConfirmDraft({ name: 'Jenna', date: '2026-08-02', slot: '10:00', service: '', address: '', tentative: false }, {});
ok('a real sentence is used', draft === GEMINI, draft);
draft = await M.detConfirmDraft({ name: 'Jenna', date: '2026-08-02', slot: '09:00', service: '', address: '', tentative: true }, { }, 'pin');
ok('a tentative card asks for the exact time instead', /what time/i.test(draft) || draft === GEMINI, draft);

// ---------------------------------------------------------------- settings
section('Settings clamping');
const sd = M.sanitizeDetect({ enabled: false, eager: false, defaultDurationMin: 99999 }, null);
ok('booleans respected', sd.enabled === false && sd.eager === false);
ok('duration capped', sd.defaultDurationMin === 720, sd.defaultDurationMin);
ok('unspecified keys keep defaults', sd.holdSlots === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
