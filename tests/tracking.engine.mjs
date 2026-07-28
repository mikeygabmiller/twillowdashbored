import fs from 'fs';
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['bkLaEpoch', 'bkLocalParts', 'loadJobs', 'saveJobs', 'blankJob', 'apiJobAction', 'apiTrack',
  'defaultTracking', 'sanitizeTracking', 'trackToken', 'coarse', 'payLinks', 'trackMorningReminders',
  'defaultDayOf', 'apiJobPhoto', 'servePhoto', 'loadThread', 'lateBy', 'trackUrl', 'jobsOnDate'];

const store = new Map();
let writes = 0;
const fakeKV = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); writes++; },
  async delete(k) { store.delete(k); writes++; },
};
const smsLog = [], emailLog = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('nominatim')) return { ok: true, json: async () => [{ lat: '47.9790', lon: '-122.2021' }] };
  if (url.includes('open-meteo')) return { ok: true, json: async () => ({ daily: { time: [], precipitation_probability_max: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [] } }) };
  if (url.includes('generativelanguage')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }) };
  if (url.includes('api.resend.com')) { emailLog.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(opts.body));
    smsLog.push({ to: p.get('To'), body: p.get('Body') });
    return { ok: true, json: async () => ({ sid: 'SM' + smsLog.length }) };
  }
  return { ok: false, status: 404, text: async () => 'nope' };
};
// node 22 already exposes webcrypto as globalThis.crypto

const factory = new Function('__setEnv__', src + '\n; ENV = __setEnv__; return Object.assign({' + EXPORTS.join(',') + '}, {__resetCfg(){ CFG_CACHE = null; }});');
const M = factory({
  MESSAGES: fakeKV, GEMINI_API_KEY: '', RESEND_API_KEY: 'rk', ALERT_EMAIL: 'a@b.c',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b });
const act = async (b) => (await M.apiJobAction(req(b))).json();

// ------------------------------------------------------------------- setup
M.__resetCfg();
await fakeKV.put('config', JSON.stringify({
  reviewUrl: 'https://g.page/r/review',
  dayOf: M.defaultDayOf(),
  tracking: Object.assign(M.defaultTracking(), { venmo: '@mikeys-detailing', cashapp: '$mikeysdetail', zelle: '360-797-5831' }),
}));

section('Token quality');
const t1 = M.trackToken(), t2 = M.trackToken();
ok('32 hex chars (128 bits)', /^[a-f0-9]{32}$/.test(t1), t1);
ok('not guessable / not repeated', t1 !== t2);

section('Coarse location — "rough area, not my exact dot"');
const exact = 47.97903312, rough = M.coarse(exact);
ok('snapped to a grid', rough !== exact, { exact, rough });
const driftMi = Math.abs(rough - exact) * 69;
ok('moved less than half a mile (still useful)', driftMi < 0.5, driftMi);
ok('two nearby points collapse to the same cell', M.coarse(47.9790) === M.coarse(47.9791));

section('On my way → the customer gets a link, not a location dump');
await M.saveJobs([Object.assign(M.blankJob(), {
  id: 'JOB1', phone: '+14255551234', name: 'Jenna Smith', at: Date.now() + 3600000, status: 'scheduled',
  stage: 'scheduled', token: 'a'.repeat(32), service: 'Full Detail', vehicle: '2019 Tahoe',
  address: '123 Main St', city: 'Everett', price: 339, durationMin: 180, customerConfirmed: true,
})]);
smsLog.length = 0;
let r = await act({ action: 'onmyway', id: 'JOB1', lat: 47.9129, lon: -122.0982 });
ok('trip starts', r.ok === true && r.job.stage === 'enroute', r.job && r.job.stage);
ok('an ETA was computed', r.etaMin > 0 && r.etaMin < 60, r.etaMin);
ok('one text went out', smsLog.length === 1, smsLog);
ok('…to the customer', smsLog[0].to === '+14255551234');
ok('…containing the tracking link', smsLog[0].body.includes('/t/' + 'a'.repeat(32)), smsLog[0].body);
ok('…and the ETA in plain English', /\d+ min out/.test(smsLog[0].body), smsLog[0].body);
ok('…using his first name only', smsLog[0].body.includes('Jenna') && !smsLog[0].body.includes('Smith'));
let stored = (await M.loadJobs())[0];
ok('stored position is COARSE, not exact', stored.trip.lastPing.lat === M.coarse(47.9129), stored.trip.lastPing);

section('The public page — token is the only credential');
let pub = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'a'.repeat(32)))).json();
ok('page loads with the right token', pub.ok === true);
ok('stage is enroute', pub.stage === 'enroute');
ok('ETA exposed', pub.eta && pub.eta.min >= 0, pub.eta);
ok('coarse position exposed', pub.position && pub.position.lat === M.coarse(47.9129), pub.position);
ok('business identity shown', pub.business.owner === 'Mikey' && pub.business.rating === '5.0');
ok('prep instructions shown', /water & power/.test(pub.prep), pub.prep);
ok('customer sees only a first name', pub.customer.name === 'Jenna');
ok('no phone number of Mikey\'s cell leaks', JSON.stringify(pub).indexOf('3607975831') === -1);
ok('contact is the Twilio business line', pub.contact === '+14256007897');
const bad = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'b'.repeat(32)))).json();
ok('a wrong token gets nothing', bad.ok === false && bad.error === 'not_found');
const none = await (await M.apiTrack(new URL('https://x/api/track'))).json();
ok('no token gets nothing', none.ok === false);

section('Ping sharpens the ETA while driving');
r = await act({ action: 'ping', id: 'JOB1', lat: 47.9700, lon: -122.1900 });
ok('ping accepted', r.ok === true);
ok('ETA shrank as he got closer', r.etaMin < 20, r.etaMin);
stored = (await M.loadJobs())[0];
ok('ping position also coarse', stored.trip.lastPing.lat === M.coarse(47.97), stored.trip.lastPing);

section('Running late');
const jobs = await M.loadJobs();
jobs[0].trip.etaAt = jobs[0].trip.promisedEtaAt + 18 * 60000;   // 18 min slip
await M.saveJobs(jobs);
ok('slip detected past the 10-min threshold', M.lateBy(jobs[0], M.defaultTracking()) === 18, M.lateBy(jobs[0], M.defaultTracking()));
smsLog.length = 0;
r = await act({ action: 'late', id: 'JOB1', minutes: 18 });
ok('late text sent only when asked', smsLog.length === 1 && /18 min behind/.test(smsLog[0].body), smsLog[0]);
const notLate = Object.assign({}, jobs[0], { trip: Object.assign({}, jobs[0].trip, { etaAt: jobs[0].trip.promisedEtaAt + 4 * 60000 }) });
ok('a 4-min slip is NOT flagged', M.lateBy(notLate, M.defaultTracking()) === 0);

section('Arrival kills location sharing');
smsLog.length = 0;
r = await act({ action: 'arrived', id: 'JOB1' });
ok('stage is arrived', r.job.stage === 'arrived');
stored = (await M.loadJobs())[0];
ok('last position wiped from storage', stored.trip.lastPing === null, stored.trip);
pub = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'a'.repeat(32)))).json();
ok('public page exposes NO position', pub.position === null, pub.position);
ok('…and no ETA', pub.eta === null);
ok('arrival text sent', smsLog.length === 1 && /I'm here/.test(smsLog[0].body), smsLog[0]);

section('Working');
r = await act({ action: 'working', id: 'JOB1' });
ok('stage is working', r.job.stage === 'working');
ok('finish estimate set from the job duration', r.job.finishAt > Date.now(), r.job.finishAt);
pub = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'a'.repeat(32)))).json();
ok('customer sees a finish time', pub.finishAt > Date.now());

section('Photos');
const tinyJpeg = 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64');
let pr = await (await M.apiJobPhoto(req({ id: 'JOB1', kind: 'before', data: tinyJpeg }))).json();
ok('before photo accepted', pr.ok === true && pr.photo.kind === 'before');
pr = await (await M.apiJobPhoto(req({ id: 'JOB1', kind: 'after', data: tinyJpeg }))).json();
ok('after photo accepted', pr.ok === true && pr.photo.kind === 'after');
const huge = 'data:image/jpeg;base64,' + 'A'.repeat(600 * 1024);
pr = await (await M.apiJobPhoto(req({ id: 'JOB1', kind: 'after', data: huge }))).json();
ok('oversized photo rejected', pr.ok === false && pr.error === 'too_big');
pr = await (await M.apiJobPhoto(req({ id: 'JOB1', kind: 'after', data: 'javascript:alert(1)' }))).json();
ok('non-image payload rejected', pr.ok === false && pr.error === 'bad_image');
const served = await M.servePhoto((await M.loadJobs())[0].photos[0].id);
ok('photo serves with an image content-type', served.headers.get('Content-Type') === 'image/jpeg');
ok('missing photo 404s', (await M.servePhoto('nope')).status === 404);

section('Done → the receipt');
smsLog.length = 0;
r = await act({ action: 'complete', id: 'JOB1', total: 399,
  services: [{ name: 'Full Detail — in & out', price: 339 }, { name: 'Pet hair removal', price: 60 }],
  note: 'Used the extractor on the back seats.' });
ok('job completed', r.ok === true && r.job.stage === 'done' && r.job.status === 'done');
ok('receipt stored', r.job.receipt.total === 399 && r.job.receipt.services.length === 2, r.job.receipt);
ok('receipt text sent', smsLog.length === 1, smsLog);
ok('…with the same link', smsLog[0].body.includes('/t/' + 'a'.repeat(32)));
ok('…and the review ask', smsLog[0].body.includes('https://g.page/r/review'), smsLog[0].body);

pub = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'a'.repeat(32)))).json();
ok('page is now the receipt', pub.stage === 'done' && !!pub.receipt);
ok('line items shown', pub.receipt.services.length === 2 && pub.receipt.services[0].price === 339);
ok('total shown', pub.receipt.total === 399);
ok('note shown', /extractor/.test(pub.receipt.note));
ok('photos shown', pub.photos.length === 2);
ok('review link on the page', pub.receipt.reviewUrl === 'https://g.page/r/review');
ok('receipt still reachable after the job (so they can pay)', pub.ok === true);

section('Payment links');
const pay = pub.receipt.pay;
ok('three methods offered', pay.length === 3, pay.map((p) => p.kind));
const venmo = pay.find((p) => p.kind === 'venmo');
ok('Venmo link carries the total', venmo.url.includes('amount=399'), venmo.url);
ok('Venmo strips the leading @', venmo.url.includes('/mikeys-detailing?'), venmo.url);
ok('Venmo still displays the @handle', venmo.handle === '@mikeys-detailing');
const cash = pay.find((p) => p.kind === 'cashapp');
ok('Cash App link carries the total', cash.url.endsWith('/399'), cash.url);
ok('Cash App strips the leading $ from the tag', cash.url.includes('/$mikeysdetail'), cash.url);
const zelle = pay.find((p) => p.kind === 'zelle');
ok('Zelle shows a handle with no fake link', zelle.url === '' && zelle.handle === '360-797-5831');
ok('tips stay off unless turned on', pub.receipt.tipPrompt === false);

section('Guardrails');
M.__resetCfg();
await fakeKV.put('config', JSON.stringify({ tracking: Object.assign(M.defaultTracking(), { enabled: false }) }));
pub = await (await M.apiTrack(new URL('https://x/api/track?t=' + 'a'.repeat(32)))).json();
ok('turning tracking off takes every page down', pub.ok === false && pub.error === 'disabled');
M.__resetCfg();
await fakeKV.put('config', JSON.stringify({ dayOf: M.defaultDayOf(), tracking: M.defaultTracking() }));
// a ping outside the drive must not resurrect location sharing
r = await act({ action: 'ping', id: 'JOB1', lat: 47.9, lon: -122.1 });
ok('pings ignored once the job is done', r.skipped === 'not_enroute', r);
stored = (await M.loadJobs())[0];
ok('…and nothing was written back', stored.trip.lastPing == null);

section('Settings clamping');
const st = M.sanitizeTracking({ lateAfterMin: 999, reviews: -5, ownerName: 'x'.repeat(200), enabled: false, tipPrompt: true }, null);
ok('late threshold capped at 60', st.lateAfterMin === 60, st.lateAfterMin);
ok('review count floored at 0', st.reviews === 0);
ok('owner name truncated', st.ownerName.length === 40);
ok('booleans respected', st.enabled === false && st.tipPrompt === true);

section('Morning-of reminder');
M.__resetCfg();
await fakeKV.put('config', JSON.stringify({ dayOf: M.defaultDayOf(), tracking: M.defaultTracking() }));
const today = M.bkLocalParts(Date.now()).date;
await M.saveJobs([Object.assign(M.blankJob(), {
  id: 'JOB2', phone: '+14255559999', name: 'Rob', at: M.bkLaEpoch(today, '23:30'), status: 'scheduled',
  stage: 'scheduled', vehicle: '2020 F-150', durationMin: 120,
})]);
smsLog.length = 0;
await M.trackMorningReminders(today, { dayOf: M.defaultDayOf(), tracking: M.defaultTracking() }, Date.now());
let th = await M.loadThread('+14255559999');
ok('reminder queued through the existing scheduled-send cron', th.scheduled.length === 1, th.scheduled);
ok('…names the vehicle and time', /F-150/.test(th.scheduled[0].body) && /11:30 PM/.test(th.scheduled[0].body), th.scheduled[0].body);
ok('…and nothing was texted directly', smsLog.length === 0);
await M.trackMorningReminders(today, { dayOf: M.defaultDayOf(), tracking: M.defaultTracking() }, Date.now());
th = await M.loadThread('+14255559999');
ok('running twice does not double-queue', th.scheduled.length === 1, th.scheduled.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
