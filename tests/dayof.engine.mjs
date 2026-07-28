import fs from 'fs';

// Load the Worker source, strip the `export default {...}` wrapper, and hand back
// the internal functions so we can exercise them directly.
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['jobLooksSchedulish', 'bkLaEpoch', 'bkLocalParts', 'bkMin2hm', 'bkFmt12', 'bkNiceDate',
  'driveMinutes', 'haversineMi', 'buildRun', 'dayOfCron', 'applyDetection', 'apiJobAction', 'apiRun',
  'sanitizeDayOf', 'gcalLink', 'defaultDayOf', 'dayOfCfg', 'loadJobs', 'saveJobs', 'blankJob',
  'fmtJobWhen', 'bkAvailability', 'confirmDraft', 'maybeDetectJob', 'jobsOnDate'];

const store = new Map();
const fakeKV = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); writes++; },
  async delete(k) { store.delete(k); writes++; },
};
let writes = 0;
const alerts = [];
const fetchLog = [];

globalThis.fetch = async (u, opts) => {
  const url = String(u);
  fetchLog.push(url);
  if (url.includes('open-meteo')) {
    return { ok: true, json: async () => ({ daily: { time: ['2026-08-01', '2026-08-02', '2026-08-03'],
      precipitation_probability_max: [70, 5, 5], temperature_2m_max: [74, 80, 80], temperature_2m_min: [55, 58, 58], weather_code: [61, 0, 0] } }) };
  }
  if (url.includes('nominatim')) {
    // Two distinct points so the route math has something real to chew on.
    const lat = url.includes('Everett') ? 47.9790 : url.includes('Monroe') ? 47.8554 : 47.9129;
    const lon = url.includes('Everett') ? -122.2021 : url.includes('Monroe') ? -121.9710 : -122.0982;
    return { ok: true, json: async () => [{ lat: String(lat), lon: String(lon) }] };
  }
  if (url.includes('generativelanguage')) {
    const isDraft = /Return only the message text/.test(String(opts.body));
    const txt = globalThis.__GEMINI__ || (isDraft ? "You're all set for Sunday at 11:00 AM. See you then! - Mikey" : '{}');
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: txt }] }, finishReason: 'STOP' }] }) };
  }
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) { alerts.push({ sms: true, body: String(opts.body) }); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  return { ok: false, status: 404, text: async () => 'nope' };
};

const factory = new Function('__KV__', '__setEnv__', src + '\n; ENV = __setEnv__; return Object.assign({' + EXPORTS.join(',') + '}, {__resetCfg(){ CFG_CACHE = null; }});');
const env = {
  MESSAGES: fakeKV, GEMINI_API_KEY: 'test-key', RESEND_API_KEY: 'rk', ALERT_EMAIL: 'a@b.c',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550000000', MIKEY_PHONE: '+15551112222',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
};
const M = factory(fakeKV, env);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); } };
const section = (s) => console.log('\n' + s);

// ---------------------------------------------------------------- prefilter
section('Prefilter — the free regex that decides whether to pay for an AI call');
const yes = ['saturday works for me', 'can you do tomorrow at 10?', 'How about Aug 3?',
  "see you at 9", 'lets do 8/14', 'sunday morning ok?', 'I need to reschedule', 'something came up cant make it',
  'thursday afternoon would be great', 'next week sometime?'];
const no = ['how much for an suv?', 'thanks!', 'sounds good', 'do you do ceramic coating?',
  'my car is a 2019 tacoma', 'whats your address', 'can you get pet hair out', '$300 is fine'];
yes.forEach((t) => ok(`fires: "${t}"`, M.jobLooksSchedulish(t) === true));
no.forEach((t) => ok(`skips: "${t}"`, M.jobLooksSchedulish(t) === false));

// ------------------------------------------------------------------ time math
section('Pacific time handling');
const aug = M.bkLaEpoch('2026-08-01', '10:00');
ok('10am PDT round-trips', M.bkLocalParts(aug).min === 600 && M.bkLocalParts(aug).date === '2026-08-01', M.bkLocalParts(aug));
const jan = M.bkLaEpoch('2026-01-15', '10:00');
ok('10am PST round-trips (DST boundary)', M.bkLocalParts(jan).min === 600 && M.bkLocalParts(jan).date === '2026-01-15', M.bkLocalParts(jan));
ok('formats as 10:00 AM', M.bkFmt12(M.bkMin2hm(M.bkLocalParts(aug).min)) === '10:00 AM');

// ------------------------------------------------------------------- driving
section('Drive estimates');
const home = { lat: 47.9129, lon: -122.0982 }, everett = { lat: 47.9790, lon: -122.2021 };
const mi = M.haversineMi(home, everett);
ok('Snohomish→Everett is a believable distance', mi > 4 && mi < 10, mi);
const dm = M.driveMinutes(home, everett, 30);
ok('…and a believable drive time', dm >= 10 && dm <= 30, dm);
ok('unknown location yields no estimate', M.driveMinutes(home, null, 30) === null);

// -------------------------------------------------------------- sanitizeDayOf
section('Settings clamping');
const s1 = M.sanitizeDayOf({ briefHour: 99, setupMin: -5, avgMph: 500, enabled: false, rainPct: 250 }, null);
ok('briefHour clamped to 23', s1.briefHour === 23, s1.briefHour);
ok('setupMin floored at 0', s1.setupMin === 0, s1.setupMin);
ok('avgMph capped at 70', s1.avgMph === 70, s1.avgMph);
ok('rainPct capped at 100', s1.rainPct === 100, s1.rainPct);
ok('booleans respected', s1.enabled === false);
ok('unspecified keys keep defaults', s1.briefHour !== undefined && s1.homeLat === 47.9129);

// ------------------------------------------------------------------ detection
section('Detection → a proposal card (never a booking)');
store.clear();
const thread = { phone: '+14255551234', name: 'Jenna', notes: '', messages: [] };
await M.applyDetection(thread, {
  intent: 'set', at: M.bkLaEpoch('2026-08-02', '10:00'), tentative: false, customerConfirmed: true,
  service: 'Full Detail', vehicle: '2019 Tahoe', address: '123 Main St', city: 'Everett',
  price: 339, name: 'Jenna', notes: 'gate code 4412', confidence: 0.9, evidence: 'yes 10am saturday works',
}, M.defaultDayOf());
let jobs = await M.loadJobs();
ok('one job created', jobs.length === 1, jobs.length);
ok('status is "proposed", NOT booked', jobs[0].status === 'proposed', jobs[0].status);
ok('details captured', jobs[0].address === '123 Main St' && jobs[0].price === 339 && jobs[0].vehicle === '2019 Tahoe');
ok('notes captured', jobs[0].notes === 'gate code 4412');
ok('Mikey was alerted', alerts.length === 1);
ok('alert says nothing is on the calendar yet', /tap Yes to add it/.test(alerts[0].text), alerts[0] && alerts[0].text);

// a second message about the same job must UPDATE the card, not stack a new one
await M.applyDetection(thread, {
  intent: 'set', at: M.bkLaEpoch('2026-08-02', '11:00'), tentative: false, customerConfirmed: true,
  service: '', vehicle: '', address: '', city: '', price: 0, name: 'Jenna', notes: '',
  confidence: 0.9, evidence: 'actually 11 is better',
}, M.defaultDayOf());
jobs = await M.loadJobs();
ok('still ONE card after a follow-up message', jobs.length === 1, jobs.length);
ok('time updated to 11am', M.bkLocalParts(jobs[0].at).min === 660, M.bkLocalParts(jobs[0].at));
ok('previously-captured address NOT wiped by the blank re-detect', jobs[0].address === '123 Main St');

// ------------------------------------------------------------- confirm → run
section('Confirming a card puts it on the day');
const req = (body) => ({ json: async () => body });
let res = await M.apiJobAction(req({ action: 'confirm', id: jobs[0].id }));
let out = await res.json();
ok('confirm succeeds', out.ok === true);
ok('status now scheduled', out.job.status === 'scheduled', out.job.status);
ok('a draft text comes back for Mikey to send', typeof out.draft === 'string' && out.draft.length > 20, out.draft);
ok('draft was NOT auto-sent', alerts.filter((a) => a.sms).length === 0);
ok('one-tap Google Calendar link returned', /calendar\.google\.com/.test(out.gcal));
ok('calendar link carries the right start time', out.gcal.includes('20260802T18'), out.gcal);

const run = await M.buildRun('2026-08-02', { dayOf: M.defaultDayOf() });
ok('job appears on the run', run.jobs.length === 1);
ok('money totalled', run.total === 339, run.total);
ok('address geocoded', run.jobs[0].lat != null);
ok('leave-by time computed', run.jobs[0].leaveAt != null && run.jobs[0].leaveAt < run.jobs[0].at);
const lead = Math.round((run.jobs[0].at - run.jobs[0].leaveAt) / 60000);
ok('leave-by includes drive + 10 min setup', lead >= 20 && lead <= 45, lead);

// --------------------------------------------------------------- guardrails
section('Guardrails');
store.clear(); alerts.length = 0;
const t2 = { phone: '+14255559999', name: 'Rob', notes: '', messages: [] };
const at2 = M.bkLaEpoch('2026-08-05', '09:00');
await M.applyDetection(t2, { intent: 'set', at: at2, tentative: false, customerConfirmed: true, service: '', vehicle: '', address: '', city: '', price: 0, name: 'Rob', notes: '', confidence: 0.9, evidence: 'x' }, M.defaultDayOf());
let j2 = (await M.loadJobs())[0];
await M.apiJobAction(req({ action: 'confirm', id: j2.id }));
alerts.length = 0;
// customer now says they want to cancel
await M.applyDetection(t2, { intent: 'cancel', evidence: 'something came up, cant make it', confidence: 0.9 }, M.defaultDayOf());
j2 = (await M.loadJobs())[0];
ok('cancel does NOT cancel on its own', j2.status === 'scheduled', j2.status);
ok('…it raises a pending change for Mikey', j2.pendingChange && j2.pendingChange.kind === 'cancel');
ok('…and alerts him', alerts.length === 1 && /cancelling/.test(alerts[0].subject), alerts[0] && alerts[0].subject);
res = await M.apiJobAction(req({ action: 'accept-change', id: j2.id }));
out = await res.json();
ok('only Mikey accepting it actually cancels', out.job.status === 'cancelled');

// dismissing a false positive removes it entirely
store.clear();
await M.applyDetection(t2, { intent: 'set', at: at2, tentative: false, customerConfirmed: false, service: '', vehicle: '', address: '', city: '', price: 0, name: '', notes: '', confidence: 0.5, evidence: 'x' }, M.defaultDayOf());
const j3 = (await M.loadJobs())[0];
await M.apiJobAction(req({ action: 'dismiss', id: j3.id }));
ok('dismissed card is gone', (await M.loadJobs()).length === 0);

// ------------------------------------------------------------------ soft hold
section('Soft hold — a job set over text blocks the public booking page');
store.clear();
await fakeKV.put('bk:config', JSON.stringify({
  tz: 'America/Los_Angeles', workDays: [0,1,2,3,4,5,6], dayStart: '07:00', lastStart: '16:00',
  stepMin: 30, bufferMin: 60, maxJobsPerDay: 2, minLeadMin: 120, windowDays: 3650,
  sizes: [{ id: 'suv', label: 'SUV' }],
  services: [{ id: 'full', name: 'Full', enabled: true, price: { suv: 339 }, duration: { suv: 180 } }],
  addons: [], cities: [], content: {}, proof: {}, calendar: { enabled: false }, blockedDates: [],
}));
const freeSlots = await M.bkAvailability('2026-08-02', 'full', 'suv');
ok('slots are open before any job exists', freeSlots.length > 0, freeSlots.length);
await M.saveJobs([Object.assign(M.blankJob(), { status: 'proposed', at: M.bkLaEpoch('2026-08-02', '10:00'), durationMin: 180, phone: '+1', tentative: false })]);
const heldSlots = await M.bkAvailability('2026-08-02', 'full', 'suv');
ok('an UNCONFIRMED card already holds its slot', heldSlots.length < freeSlots.length, { before: freeSlots.length, after: heldSlots.length });
ok('10:00 is no longer offered', !heldSlots.includes('10:00'));
await M.saveJobs([Object.assign(M.blankJob(), { status: 'proposed', at: M.bkLaEpoch('2026-08-02', '10:00'), durationMin: 180, phone: '+1', tentative: true })]);
ok('a loose "Saturday morning" hold blocks the whole day', (await M.bkAvailability('2026-08-02', 'full', 'suv')).length === 0);

// ---------------------------------------------------------------------- cron
section('Cron — brief fires once a day, and idle ticks cost no KV writes');
store.clear();
const cfg = { dayOf: Object.assign(M.defaultDayOf(), { briefHour: 7 }) };
M.__resetCfg(); await fakeKV.put('config', JSON.stringify(cfg));
await M.saveJobs([Object.assign(M.blankJob(), {
  status: 'scheduled', at: M.bkLaEpoch('2026-08-01', '10:00'), durationMin: 180,
  phone: '+14255551234', name: 'Jenna', address: '123 Main St', city: 'Everett', price: 339,
  service: 'Full Detail', customerConfirmed: false,
})]);
alerts.length = 0;
const at7 = M.bkLaEpoch('2026-08-01', '07:02');
writes = 0;
await M.dayOfCron(at7);
ok('brief sent at 7am', alerts.length === 1, alerts.map((a) => a.subject));
ok('subject names the job count and money', /1 job/.test(alerts[0].subject) && /\$339/.test(alerts[0].subject), alerts[0].subject);
ok('body flags the unconfirmed job', /NOT CONFIRMED/.test(alerts[0].text));
ok('body warns about rain (70%)', /WET/.test(alerts[0].text));
ok('body gives a leave-by time', /leave by/.test(alerts[0].text));
const w1 = writes;
alerts.length = 0; writes = 0;
await M.dayOfCron(at7 + 60000);
ok('does NOT re-send a minute later', alerts.length === 0);
ok('…and that idle tick did ZERO KV writes', writes === 0, writes);

// leave-now alert
alerts.length = 0;
const runToday = await M.buildRun('2026-08-01', cfg);
const leaveAt = runToday.jobs[0].leaveAt;
await M.dayOfCron(leaveAt + 30000);
ok('"leave now" alert fires at the computed time', alerts.some((a) => /Leave now/.test(a.subject)), alerts.map((a) => a.subject));
alerts.length = 0;
await M.dayOfCron(leaveAt + 90000);
ok('…and only once', alerts.length === 0);

// idle-day ping
store.clear();
M.__resetCfg(); await fakeKV.put('config', JSON.stringify(cfg));
await fakeKV.put('threads:index', JSON.stringify([{ phone: '+1425', name: 'Warm Lead', status: 'new', lastTs: Date.now(), lastBody: 'still thinking' }]));
alerts.length = 0;
await M.dayOfCron(at7);
ok('empty day still pings, with leads to chase', alerts.length === 1 && /No jobs today/.test(alerts[0].subject), alerts[0] && alerts[0].subject);

// master switch
store.clear();
M.__resetCfg(); await fakeKV.put('config', JSON.stringify({ dayOf: Object.assign(M.defaultDayOf(), { enabled: false }) }));
alerts.length = 0; writes = 0;
await M.dayOfCron(at7);
ok('pause-all switch silences everything', alerts.length === 0 && writes === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
