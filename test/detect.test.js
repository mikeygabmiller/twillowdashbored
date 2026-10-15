// Appointment auto-detect — the job you never wrote down.
//
// Loads the real Worker source, stubs KV / Twilio / Resend / Gemini, and asserts
// on behaviour rather than shape. The point of this module is that it NEVER acts
// on its own, so most of what's checked here is what it refuses to do.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['detLooksSchedulish', 'detDefaults', 'sanitizeDetect', 'detApply', 'detHeldSlots',
  'detGuessSlot', 'detGuessDuration', 'dayBoardHolds', 'dayJobGcalEvent', 'detAskAi', 'apiDetectSweep', 'updateIndexEntry', 'saveDay',
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
  '}, {__resetCfg(){ resetInvocationCaches(); }});')({
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
// Computed from today, never hardcoded. bkAvailability() only offers slots in the
// future, so a fixed calendar date here starts returning an empty list the day it
// slides into the past — and then every check below passes vacuously, because
// "no slots held" and "no slots at all" look identical. That is exactly how this
// section rotted, silently, months after it was written.
//
// It rotted a second way on 2026-10-01: ten days out was a Sunday, and since
// 2026-09-29 his real week (fixed start times, never Sunday) is the default,
// so the day had no slots and the hold checks failed for a reason that had
// nothing to do with holds. So: never a Sunday, and this section tests the
// grid it was written for (fixed start times off), with the real start times
// checked on their own just below.
let holdTs = Date.now() + 10 * 86400000;
const pacific = (ts, o) => new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: 'America/Los_Angeles' }, o)).format(new Date(ts));
while (pacific(holdTs, { weekday: 'short' }) === 'Sun') holdTs += 86400000;
const HOLD_DAY = pacific(holdTs, { year: 'numeric', month: '2-digit', day: '2-digit' });
store.clear(); M.__resetCfg();
await kv.put('bk:config', JSON.stringify({
  tz: 'America/Los_Angeles', workDays: [0, 1, 2, 3, 4, 5, 6], dayStart: '07:00', lastStart: '16:00',
  stepMin: 30, bufferMin: 60, maxJobsPerDay: 2, minLeadMin: 120, windowDays: 3650,
  sizes: [{ id: 'suv', label: 'SUV' }],
  services: [{ id: 'full', name: 'Full', enabled: true, price: { suv: 339 }, duration: { suv: 180 } }],
  addons: [], cities: [], content: {}, proof: {}, calendar: { enabled: false }, blockedDates: [],
  slotRules: { on: false },
}));
const free = await M.bkAvailability(HOLD_DAY, 'full', 'suv');
ok('slots open before any detection', free.length > 0, free.length);
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DAY, slot: '10:00', durationMin: 180, tentative: false }]);
const held = await M.bkAvailability(HOLD_DAY, 'full', 'suv');
ok('an UNCONFIRMED card already holds its slot', held.length < free.length, { before: free.length, after: held.length });
ok('10:00 is no longer offered', !held.includes('10:00'));
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DAY, slot: '10:00', durationMin: 180, tentative: true }]);
ok('a loose "Saturday morning" hold blocks the whole day', (await M.bkAvailability(HOLD_DAY, 'full', 'suv')).length === 0);
await M.saveDetections([]);
ok('dismissing releases the hold immediately', (await M.bkAvailability(HOLD_DAY, 'full', 'suv')).length === free.length);
M.__resetCfg();
await kv.put('config', JSON.stringify({ detect: Object.assign(M.detDefaults(), { holdSlots: false }) }));
await M.saveDetections([{ id: 'd1', phone: '+1', kind: 'set', date: HOLD_DAY, slot: '10:00', durationMin: 180, tentative: true }]);
ok('holds can be turned off', (await M.bkAvailability(HOLD_DAY, 'full', 'suv')).length === free.length);

// The same promise on his real week: fixed start times (weekdays 1:00 PM). A
// card for 1:00 on a weekday takes that weekday's only time off the website.
let wkTs = Date.now() + 10 * 86400000;
// Mondays too: off "for now" since 2026-10-10, and a Monday here read as a
// broken calendar rather than a day off.
while (['Sat', 'Sun', 'Mon'].includes(pacific(wkTs, { weekday: 'short' }))) wkTs += 86400000;
const WK_DAY = pacific(wkTs, { year: 'numeric', month: '2-digit', day: '2-digit' });
M.__resetCfg();
await kv.put('config', JSON.stringify({}));
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
await M.saveDetections([]);
const wkFree = await M.bkAvailability(WK_DAY, 'interior', 'suv');
ok('his real weekday offers 1:00 PM', wkFree.includes('13:00'), wkFree);
await M.saveDetections([{ id: 'd2', phone: '+1', kind: 'set', date: WK_DAY, slot: '13:00', durationMin: 180, tentative: false }]);
ok('an unconfirmed 1:00 card takes 1:00 off the website', !(await M.bkAvailability(WK_DAY, 'interior', 'suv')).includes('13:00'));
await M.saveDetections([]);

// ------------------------------------------------------------------ maybes
section('Maybes: a day that was only talked about goes on the board, not a pile');
// Mikey, 2026-10-14: "if it seems even a little like a booking... put it on my
// calendar as a maybe. I would rather have it on there... rather than double
// book." Real weekdays ahead of today (never Sat/Sun/Mon), so this can't rot.
const nextWk = (fromTs) => { let x = fromTs; while (['Sat', 'Sun', 'Mon'].includes(pacific(x, { weekday: 'short' }))) x += 86400000; return x; };
const dstr = (ts) => pacific(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
const D1 = dstr(nextWk(Date.now() + 5 * 86400000));
const D2 = dstr(nextWk(Date.parse(D1 + 'T20:00:00Z') + 86400000));
store.clear(); alerts.length = 0; sms.length = 0; M.__resetCfg();
await kv.put('config', JSON.stringify({}));
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
const blank = (phone, name, extra) => Object.assign({ phone, name, notes: '', messages: [], scheduled: [], tags: [], linked: [], appointmentAt: null }, extra || {});
const find = (o) => Object.assign({ intent: 'set', maybe: false, tentative: false, customerConfirmed: false,
  service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', durationMin: 270, confidence: 0.5, evidence: 'x' }, o);

ok('the website offers 1:00 PM on that day to start with', (await M.bkAvailability(D1, 'interior', 'suv')).includes('13:00'));
await M.saveThread(blank('+14255550101', 'Pete'));
let did = await M.detApply(await M.loadThread('+14255550101'), find({ maybe: true, date: D1, slot: '13:00', at: M.bkLaEpoch(D1, '13:00'),
  tentative: true, confidence: 0.4, service: 'Full Detail', evidence: 'I can likely come Wednesday' }), DC, {});
let board = (await M.loadDay(D1)).manual;
ok('a maybe goes straight on the board', did === 'maybe' && board.length === 1, { did, board });
ok('…marked as a maybe', board[0] && board[0].maybe === true);
ok('…with no card left to tap', (await M.loadDetections()).length === 0);
let pete = await M.loadThread('+14255550101');
ok('it is NOT a booking: the conversation has no appointment', !pete.appointmentAt, pete.appointmentAt);
ok('…it remembers the maybe on its own field', pete.maybeAt === M.bkLaEpoch(D1, '13:00'));
ok('no alert for a maybe (the email lists them)', alerts.length === 0, alerts.length);
ok('and the customer was not texted', sms.length === 0);
ok('a maybe with no time agreed holds the whole day on the website', (await M.bkAvailability(D1, 'interior', 'suv')).length === 0);
ok('on his calendar it says MAYBE before anything else', /^❓ MAYBE: /.test(M.dayJobGcalEvent(board[0], D1).title), M.dayJobGcalEvent(board[0], D1).title);

did = await M.detApply(await M.loadThread('+14255550101'), find({ date: D1, slot: '13:00', at: M.bkLaEpoch(D1, '13:00'),
  customerConfirmed: true, confidence: 0.9, evidence: 'yes wednesday at 1 works' }), DC, {});
board = (await M.loadDay(D1)).manual;
pete = await M.loadThread('+14255550101');
ok('their yes turns the maybe into a job, not a second entry', did === 'added' && board.length === 1, { did, n: board.length });
ok('…no longer a maybe', board[0].maybe === false);
ok('…and now it IS the appointment', pete.appointmentAt === M.bkLaEpoch(D1, '13:00') && !pete.maybeAt);
ok('a booked job says so out loud', alerts.length === 1 && /Added to your day/.test(alerts[0].subject || ''), alerts.map((a) => a.subject));

store.clear(); alerts.length = 0; M.__resetCfg();
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
await M.saveThread(blank('+14255550102', 'Dee'));
await M.detApply(await M.loadThread('+14255550102'), find({ maybe: true, date: D1, slot: '13:00', at: M.bkLaEpoch(D1, '13:00') }), DC, {});
await M.detApply(await M.loadThread('+14255550102'), find({ maybe: true, date: D2, slot: '13:00', at: M.bkLaEpoch(D2, '13:00') }), DC, {});
ok('a different day floated moves the maybe, it does not add a second',
  (await M.loadDay(D1)).manual.length === 0 && (await M.loadDay(D2)).manual.length === 1);
ok('…and the day it left is open on the website again', (await M.bkAvailability(D1, 'interior', 'suv')).includes('13:00'));

section('Moves: a move they agreed to moves the job by itself');
store.clear(); alerts.length = 0; M.__resetCfg();
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
await M.saveThread(blank('+14255550103', 'Chris'));
await M.detApply(await M.loadThread('+14255550103'), find({ date: D1, slot: '13:00', at: M.bkLaEpoch(D1, '13:00'), customerConfirmed: true, confidence: 0.9 }), DC, {});
ok('a firm job is on the board', (await M.loadDay(D1)).manual.length === 1 && (await M.loadDay(D1)).manual[0].maybe === false);
ok('…and a firm job with a time holds that time', !(await M.bkAvailability(D1, 'interior', 'suv')).includes('13:00'));
alerts.length = 0;
did = await M.detApply(await M.loadThread('+14255550103'), find({ intent: 'reschedule', date: D2, slot: '13:00', at: M.bkLaEpoch(D2, '13:00'),
  customerConfirmed: true, confidence: 0.9, evidence: 'Yes I can do Thursday at 1' }), DC, {});
ok('an agreed move moves it', did === 'moved', did);
ok('…off the old day', (await M.loadDay(D1)).manual.length === 0);
ok('…onto the new one', (await M.loadDay(D2)).manual.length === 1);
ok('…the appointment follows', (await M.loadThread('+14255550103')).appointmentAt === M.bkLaEpoch(D2, '13:00'));
ok('…no card to tap', (await M.loadDetections()).length === 0);
ok('…Mikey is told what moved', alerts.length === 1 && /Moved/.test(alerts[0].subject || ''), alerts.map((a) => a.subject));
ok('…and the customer was not texted', sms.length === 0);

store.clear(); alerts.length = 0; M.__resetCfg();
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
await M.saveThread(blank('+14255550104', 'Sam'));
await M.detApply(await M.loadThread('+14255550104'), find({ date: D1, slot: '13:00', at: M.bkLaEpoch(D1, '13:00'), customerConfirmed: true, confidence: 0.9 }), DC, {});
did = await M.detApply(await M.loadThread('+14255550104'), find({ intent: 'reschedule', date: D2, slot: '13:00', at: M.bkLaEpoch(D2, '13:00'),
  customerConfirmed: false, confidence: 0.8, evidence: 'any chance we can pivot to Thursday?' }), DC, {});
ok('a move they have NOT agreed to keeps the old job', (await M.loadDay(D1)).manual.length === 1, (await M.loadDay(D1)).manual);
ok('…and holds the new day as a maybe', (await M.loadDay(D2)).manual.length === 1 && (await M.loadDay(D2)).manual[0].maybe === true);
ok('…the appointment stays where it was', (await M.loadThread('+14255550104')).appointmentAt === M.bkLaEpoch(D1, '13:00'));

const doneDoc = await M.loadDay(D1);
doneDoc.state[doneDoc.manual[0].id] = { state: 'done' };
await M.saveDay(doneDoc);
ok('a finished job stops holding the website', (await M.bkAvailability(D1, 'interior', 'suv')).includes('13:00'));

section('No time agreed: his own start time, and his longest time for the job');
const RR = { on: true, days: { 0: [], 1: [], 2: ['13:00'], 6: ['07:00', '13:00'] }, jobMin: { exterior: 120, interior: 180, full: 270 } };
ok('a weekday is 1:00 PM, never 9:00 when he is in class', M.detGuessSlot(RR, '2026-10-20', '') === '13:00');
ok('a Saturday is his first start', M.detGuessSlot(RR, '2026-10-24', '') === '07:00');
ok('"Saturday afternoon" is his afternoon start', M.detGuessSlot(RR, '2026-10-24', 'afternoon') === '13:00');
ok('a day off falls back to 1:00 PM', M.detGuessSlot(RR, '2026-10-25', '') === '13:00');
ok('Full Detail holds 4.5 hrs', M.detGuessDuration(RR, 'Full Detail') === 270);
ok('inside and a wash is a full job', M.detGuessDuration(RR, 'interior and an outside wash') === 270);
ok('interior holds 3 hrs', M.detGuessDuration(RR, 'Interior detail') === 180);
ok('a wash holds 2 hrs', M.detGuessDuration(RR, 'hand wash') === 120);
ok('nothing said: hold the longest', M.detGuessDuration(RR, '') === 270);

section('Phone calls are read like texts, all the way through');
store.clear(); alerts.length = 0; M.__resetCfg();
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
let satTs = Date.now() + 6 * 86400000;
while (pacific(satTs, { weekday: 'short' }) !== 'Sat') satTs += 86400000;
const SAT = dstr(satTs);
const longCall = 'Hey Pete, this is Mikey. ' + 'We talked about the car and the seats. '.repeat(20) + 'I would likely be able to come by on Saturday at the soonest.';
let sentPrompt = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { if (String(u).includes('generativelanguage')) sentPrompt = String(o && o.body); return realFetch(u, o); };
GEMINI = JSON.stringify({ intent: 'maybe', date: SAT, time: '', partOfDay: '', tentative: true, customerConfirmed: false,
  service: 'interior and exterior', confidence: 0.6, evidence: 'Saturday at the soonest' });
const callFound = await M.detAskAi({ phone: '+1', name: '', messages: [] },
  [{ dir: 'in', kind: 'call', ts: Date.now(), body: longCall }], {});
globalThis.fetch = realFetch;
ok('the whole transcript goes to the model, not the first 400 characters', sentPrompt.includes('Saturday at the soonest'));
ok('…labelled as a phone call', sentPrompt.includes('PHONE CALL'));
ok('a floated day comes back as a maybe', callFound && callFound.maybe === true, callFound);
ok('…on his Saturday start, not 9:00', callFound && callFound.slot === '07:00', callFound && callFound.slot);
ok('…holding a full job', callFound && callFound.durationMin === 270, callFound && callFound.durationMin);

section('The sweep reads back over recent conversations and reports, quietly');
store.clear(); alerts.length = 0; M.__resetCfg();
await kv.put('config', JSON.stringify({}));
await kv.put('bk:config', JSON.stringify({ windowDays: 3650, calendar: { enabled: false } }));
const sw = blank('+14255550105', 'Monroe 3 cars', { messages: [{ id: 'a', dir: 'out', ts: Date.now() - 3600000, body: 'I can most likely come out Wednesday next week' }] });
await M.saveThread(sw);
await M.updateIndexEntry(sw);
GEMINI = JSON.stringify({ intent: 'maybe', date: D2, time: '', partOfDay: '', tentative: true, customerConfirmed: false,
  service: 'interior', confidence: 0.6, evidence: 'most likely come out Wednesday next week' });
const swept = await (await M.apiDetectSweep(req({ days: 30 }))).json();
ok('the sweep ran', swept.ok === true && swept.total >= 1, swept);
ok('…found the promised day and put a maybe on', swept.results.some((x) => x.phone === '+14255550105' && x.did === 'maybe'), swept.results);
ok('…which is on the board', (await M.loadDay(D2)).manual.some((m) => m.phone === '+14255550105' && m.maybe));
ok('…without an alert per find', alerts.length === 0, alerts.length);
ok('…and without texting anyone', sms.length === 0);
GEMINI = '{}';

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
