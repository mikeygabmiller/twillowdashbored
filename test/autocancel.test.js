// Automatic cancel / postpone / move — the customer says it, the schedule follows.
//
// Same harness as detect.test.js: the real Worker source with KV, Twilio,
// Resend and Gemini stubbed. What matters here is that a STATED cancel takes
// the job off every place it lives (board, booking list, reminder texts), that
// a QUESTION never does, that nothing is texted to the customer, and that Undo
// puts every one of those back.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['detLooksSchedulish', 'detDefaults', 'detApply', 'detAskAi', 'detUndoChange', 'apiDetectUndo',
  'apiDetectionAction', 'loadDetections', 'loadBookings', 'saveBookings', 'loadThread', 'saveThread',
  'loadDay', 'saveDay', 'bkLaEpoch', 'localDateStr'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
const alerts = [], sms = [];
let GEMINI = '{}';
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: GEMINI }] }, finishReason: 'STOP' }] }) };
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) { const p = new URLSearchParams(String(opts.body)); sms.push({ to: p.get('To'), body: p.get('Body') }); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) };
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
const DC = M.detDefaults();
const TZ = 'America/Los_Angeles';
const day = (n) => M.localDateStr(Date.now() + n * 86400000, TZ);
const D5 = day(5), D6 = day(6);
const AT = M.bkLaEpoch(D5, '13:00');
const PHONE = '+14255550101';
const blank = (x) => Object.assign({ messages: [], scheduled: [], tags: [], linked: [], notes: '' }, x);

async function seedBoard() {
  store.clear(); alerts.length = 0; sms.length = 0; M.__resetCfg();
  await M.saveThread(blank({ phone: PHONE, name: 'Dana', appointmentAt: AT }));
  const doc = await M.loadDay(D5);
  doc.manual.push({ id: 'm:1', name: 'Dana', phone: PHONE, slot: '13:00', durationMin: 180, service: 'Full Detail' });
  await M.saveDay(doc);
}
async function seedBooking() {
  store.clear(); alerts.length = 0; sms.length = 0; M.__resetCfg();
  await M.saveBookings([{ id: 'bk1', status: 'confirmed', phone: PHONE, name: 'Dana', date: D5, slot: '13:00',
    dateLabel: 'x', apptAt: AT, durationMin: 180, serviceName: 'Full Detail', smsConsent: true }]);
  await M.saveThread(blank({ phone: PHONE, name: 'Dana', appointmentAt: AT, scheduled: [
    { id: 's1', bkId: 'bk1', kind: 'booking', body: 'Reminder, see you tomorrow', sendAt: AT - 86400000 },
    { id: 's2', body: 'his own scheduled text', sendAt: AT - 3600000 },
  ] }));
}
const cancel = (x) => Object.assign({ intent: 'cancel', evidence: 'we need to cancel saturday, sorry', confidence: 0.92, definite: true, saidBy: 'customer' }, x);

// ---------------------------------------------------------------- prefilter
section('Prefilter catches how people actually call a job off');
['can we push it back a week', 'we have to call it off', 'lets hold off for now', "I won't be able to make it",
 'something came up', 'can we do a different time'].forEach((t) => ok(`fires: "${t}"`, M.detLooksSchedulish(t, true)));

// ------------------------------------------------------------- the AI read
section('The AI read carries definite / saidBy and knows "postpone"');
M.__resetCfg();
GEMINI = JSON.stringify({ intent: 'postpone', confidence: 0.9, definite: true, saidBy: 'customer', evidence: 'can we push it, I will text you' });
let f = await M.detAskAi(blank({ phone: PHONE, appointmentAt: AT }), [{ dir: 'in', body: 'can we push it', ts: Date.now() }], {});
ok('postpone comes back as postpone', f && f.intent === 'postpone', f);
ok('…definite', f && f.definite === true);
GEMINI = JSON.stringify({ intent: 'cancel', confidence: 0.9, definite: false, evidence: 'might need to cancel' });
f = await M.detAskAi(blank({ phone: PHONE, appointmentAt: AT }), [{ dir: 'in', body: 'might need to cancel', ts: Date.now() }], {});
ok('a maybe-cancel is not definite', f && f.definite === false, f);

// ------------------------------------------------------- board job, cancel
section('A stated cancel takes a board job off by itself');
await seedBoard();
let out = await M.detApply(await M.loadThread(PHONE), cancel(), DC, {});
let th = await M.loadThread(PHONE);
ok('returns cancelled', out === 'cancelled', out);
ok('appointment cleared', th.appointmentAt === null);
ok('job gone from the board', (await M.loadDay(D5)).manual.length === 0);
ok('no card left to tap', (await M.loadDetections()).length === 0);
ok('change recorded with the quote', th.apptChange && th.apptChange.kind === 'cancel' && /cancel saturday/.test(th.apptChange.evidence));
ok('Mikey told it was taken off', alerts.length === 1 && /taken off/.test(alerts[0].subject), alerts[0] && alerts[0].subject);
ok('customer NOT texted', sms.length === 0, sms);
let u = await M.detUndoChange(PHONE, {});
th = await M.loadThread(PHONE);
ok('undo works', u.ok === true, u);
ok('…appointment back', th.appointmentAt === AT);
ok('…job back on the board', (await M.loadDay(D5)).manual.length === 1);
ok('a second undo refuses', (await M.detUndoChange(PHONE, {})).ok === false);

// ------------------------------------------------------- questions don't act
section('A question or a low-confidence read stays a card');
await seedBoard();
await M.detApply(await M.loadThread(PHONE), cancel({ definite: false, evidence: 'could we maybe cancel?' }), DC, {});
ok('not definite → appointment kept', (await M.loadThread(PHONE)).appointmentAt === AT);
ok('…card raised', (await M.loadDetections())[0].kind === 'cancel');
await seedBoard();
await M.detApply(await M.loadThread(PHONE), cancel({ confidence: 0.7 }), DC, {});
ok('below 0.8 → appointment kept', (await M.loadThread(PHONE)).appointmentAt === AT);
await seedBoard();
await M.detApply(await M.loadThread(PHONE), cancel(), Object.assign({}, DC, { autoCancel: false }), {});
ok('switched off → appointment kept', (await M.loadThread(PHONE)).appointmentAt === AT);
store.clear(); M.__resetCfg();
const past = Date.now() - 2 * 86400000;
await M.saveThread(blank({ phone: PHONE, name: 'Dana', appointmentAt: past }));
await M.detApply(await M.loadThread(PHONE), cancel(), DC, {});
ok('a job already in the past is not auto-cancelled', (await M.loadThread(PHONE)).appointmentAt === past);

// ------------------------------------------------------ website booking
section('A website booking: status, reminders, undo');
await seedBooking();
await M.detApply(await M.loadThread(PHONE), cancel(), DC, {});
th = await M.loadThread(PHONE);
let bk = (await M.loadBookings())[0];
ok('booking marked cancelled', bk.status === 'cancelled', bk.status);
ok('…by the app', bk.cancelledBy === 'auto');
ok('its reminder text pulled', !th.scheduled.some((s) => s.bkId === 'bk1'));
ok('his own scheduled text left alone', th.scheduled.some((s) => s.id === 's2'));
ok('alert mentions the reminder', /reminder text/.test(alerts[0].text), alerts[0].text);
await M.apiDetectUndo(req({ phone: PHONE }));
th = await M.loadThread(PHONE); bk = (await M.loadBookings())[0];
ok('undo: booking confirmed again', bk.status === 'confirmed' && !bk.cancelledAt);
ok('undo: reminder back in the queue', th.scheduled.some((s) => s.bkId === 'bk1'));
ok('undo: appointment back', th.appointmentAt === AT);

// ------------------------------------------------------------- postpone
section('A postpone also tags it and reminds him to rebook');
await seedBoard();
out = await M.detApply(await M.loadThread(PHONE), cancel({ intent: 'postpone', evidence: 'something came up, can we push it? ill text you' }), DC, {});
th = await M.loadThread(PHONE);
ok('returns postponed', out === 'postponed', out);
ok('tagged postponed', th.tags.includes('postponed'));
ok('reminder ~3 days out', th.reminderAt > Date.now() + 2.9 * 86400000 && /rebook/.test(th.reminderNote));
await M.detUndoChange(PHONE, {});
th = await M.loadThread(PHONE);
ok('undo drops the tag and the reminder', !th.tags.includes('postponed') && !th.reminderAt);

// ----------------------------------------------------------- reschedule
section('A website booking moves when they clearly agreed to a free time');
await seedBooking();
const AT6 = M.bkLaEpoch(D6, '10:00');
const move = { intent: 'reschedule', date: D6, slot: '10:00', at: AT6, tentative: false, customerConfirmed: true, definite: true,
  service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', confidence: 0.9, evidence: 'can we do it the next day at 10 instead? that works' };
out = await M.detApply(await M.loadThread(PHONE), move, DC, {});
th = await M.loadThread(PHONE); bk = (await M.loadBookings())[0];
ok('returns moved', out === 'moved', out);
ok('booking on the new day and time', bk.date === D6 && bk.slot === '10:00' && bk.apptAt === AT6, bk);
ok('conversation follows', th.appointmentAt === AT6);
ok('old day\'s reminder gone', !th.scheduled.some((s) => s.bkId === 'bk1' && s.sendAt === AT - 86400000), th.scheduled);
ok('day-before reminder queued for the new day', th.scheduled.some((s) => s.bkId === 'bk1' && s.sendAt === AT6 - 86400000), th.scheduled);
await M.detUndoChange(PHONE, {});
bk = (await M.loadBookings())[0];
ok('undo puts the booking back', bk.date === D5 && bk.apptAt === AT);

await seedBooking();
const list = await M.loadBookings();
list.push({ id: 'bk2', status: 'confirmed', phone: '+14255550202', name: 'Other', date: D6, slot: '09:00', apptAt: M.bkLaEpoch(D6, '09:00'), durationMin: 180 });
await M.saveBookings(list);
out = await M.detApply(await M.loadThread(PHONE), move, DC, {});
ok('a clash is not moved', (await M.loadThread(PHONE)).appointmentAt === AT && out === 'card', out);
ok('…the card names who is in the way', (await M.loadDetections())[0].clash === 'Other');

await seedBooking();
await M.detApply(await M.loadThread(PHONE), Object.assign({}, move, { tentative: true }), DC, {});
ok('a guessed hour is not moved', (await M.loadThread(PHONE)).appointmentAt === AT);

// ------------------------------------------------ the card path fixed too
section('Tapping "Cancel it" on a card now cancels a website booking too');
await seedBooking();
await M.detApply(await M.loadThread(PHONE), cancel({ definite: false }), DC, {});
const card = (await M.loadDetections())[0];
await (await M.apiDetectionAction(req({ action: 'accept', id: card.id }))).json();
th = await M.loadThread(PHONE); bk = (await M.loadBookings())[0];
ok('booking cancelled', bk.status === 'cancelled' && bk.cancelledBy === 'mikey');
ok('reminder pulled', !th.scheduled.some((s) => s.bkId === 'bk1'));
ok('nothing texted', sms.length === 0, sms);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
