// Before the job and after it — the customer's own page (/c/<token>) growing
// the two things every customer asks by text: "what do I need to do?" and
// "what now?". Plus the one share link that makes word of mouth countable.
//
// What's asserted, in the order it could go wrong for a real customer:
//   · the page says the right thing at the right time (before vs after)
//   · the two new buttons tell Mikey and nobody else, and can't be leaned on
//   · a share link credits the right person and can't be turned on its owner
//   · free exteriors are earned only when the friend's first detail is PAID
//   · nothing in here ever texts a customer
//
//   node test/prepost.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['custTokenFor', 'custState', 'apiCustState', 'apiCustAction', 'custPage', 'apiBook',
  'refCodeFor', 'refResolve', 'refCredits', 'careKind', 'CARE_TIPS', 'REF_OFFER', 'buildReferrals', 'apiReferralAction',
  'loadThread', 'saveThread', 'updateIndexEntry', 'loadBookings', 'saveBookings', 'loadIndex',
  'loadMonth', 'saveMonth', 'loadConfig', 'localDateStr', 'bkAvailability', 'genId'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
const alerts = [], sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(opts.body));
    sms.push({ to: p.get('To'), body: p.get('Body') });
    return { ok: true, json: async () => ({ sid: 'SM1' }) };
  }
  return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) };
};

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ resetInvocationCaches(); BCFG_CACHE = null; }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c', DETECT_DISABLED: '1',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b, method: 'POST', headers: { get: () => '' } });
const q = (t) => new URL('https://x/?t=' + encodeURIComponent(t));

const DAY = 86400000, NOW = Date.now();
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const JENNA = '+14255551234', RUTH = '+14255559999', FRIEND = '+14255550777';

async function customer(phone, name, garage) {
  const t = await M.loadThread(phone);
  t.name = name;
  t.messages = [{ id: 'm', dir: 'in', body: 'hi', ts: NOW - 2 * DAY }];
  t.garage = garage || { vehicles: [], address: '1425 Cedar Ave', city: 'Everett' };
  await M.saveThread(t); await M.updateIndexEntry(t);
  return t;
}
async function booking(phone, o) {
  const all = await M.loadBookings();
  const rec = Object.assign({
    id: M.genId(), phone, status: 'confirmed', serviceName: 'Full Detail', estimate: 299,
    date: dateOf(NOW + 3 * DAY), slot: '10:00', dateLabel: 'Saturday', apptAt: NOW + 3 * DAY,
    durationMin: 210, smsConsent: true,
  }, o || {});
  all.unshift(rec); await M.saveBookings(all);
  return rec;
}
// A paid job in the money ledger — the only "done" a referral credit counts.
async function paid(phone, amount) {
  const cfg = await M.loadConfig();
  const m = M.localDateStr(NOW, cfg.tz).slice(0, 7);
  const doc = await M.loadMonth(m);
  doc.entries.push({ id: M.genId(), type: 'job', phone, amount, date: M.localDateStr(NOW, cfg.tz) });
  await M.saveMonth(m, doc);
}
const html = async (tok) => (await M.custPage(tok)).text();

store.clear(); M.__resetCfg();
store.set('config', JSON.stringify({ reviewUrl: 'https://g.page/r/mikey-review' }));
M.__resetCfg();

// ------------------------------------------------------------------ before
section('Before the job: the page says what to have ready');
await customer(JENNA, 'Jenna Smith');
const tok = await M.custTokenFor(JENNA);
const bk = await booking(JENNA);
let h = await html(tok);
ok('there is a "Before I get there" card', /Before I get there/.test(h));
ok('water and power comes first', h.indexOf('Water and power') > 0 && h.indexOf('Water and power') < h.indexOf("don't need to be home"));
ok('it says they need a spigot and an outlet, and that he cannot bring it', /spigot/.test(h) && /outlet/.test(h) && /can't bring/.test(h));
ok('they do not need to be home, just access to the car', /don't need to be home/.test(h) && /unlocked/.test(h));
ok('how long, from the booking (210 min → 3½ hours)', /About 3½ hours/.test(h), (h.match(/How long[^<]*<\/b>[^<]*/) || [])[0]);
ok('payment: after, cash, check or Zelle, no deposit', /Cash, check or Zelle/.test(h) && /No deposit/.test(h));
ok('rain: he texts and they figure it out', /If it rains/.test(h));
ok('no after-job card while it has not happened', !/Thanks for having me out/.test(h));
ok('no share card for someone who has not had a detail', !/Send a friend/.test(h));
ok('short jobs read in minutes', /About 90 minutes/.test(await (async () => {
  const all = await M.loadBookings(); all[0].durationMin = 90; await M.saveBookings(all); return html(tok);
})()));

section('"I\'ve got water and power" tells Mikey');
alerts.length = 0; sms.length = 0;
let res = await (await M.apiCustAction(req({ action: 'ready', id: bk.id, note: 'Gate code 4412, car is in the garage' }), q(tok))).json();
ok('it goes through', res.ok, res);
const saved = (await M.loadBookings()).find((x) => x.id === bk.id);
ok('the booking remembers it', saved.readyAt > 0 && /4412/.test(saved.readyNote));
ok('Mikey is told, with the note', alerts.length === 1 && /is set for/.test(alerts[0].subject) && /4412/.test(alerts[0].text), alerts[0]);
ok('the customer is NOT texted', sms.length === 0, sms);
ok('the state now says they are set', res.upcoming.readyAt > 0);
h = await html(tok);
ok('the page shows it back instead of the form again', /You told me you're set/.test(h) && /prepForm" hidden/.test(h));
await M.apiCustAction(req({ action: 'ready', id: bk.id }), q(tok));
await M.apiCustAction(req({ action: 'ready', id: bk.id }), q(tok));
const r4 = await M.apiCustAction(req({ action: 'ready', id: bk.id }), q(tok));
ok('a public link cannot ring his phone forever (3 per booking)', r4.status === 429, r4.status);

section('A token still only touches its own bookings');
await customer(RUTH, 'Ruth Adams');
const tokR = await M.custTokenFor(RUTH);
const rb = await booking(RUTH);
ok('Ruth\'s link cannot mark Jenna ready', (await M.apiCustAction(req({ action: 'ready', id: bk.id }), q(tokR))).status === 404);
ok('Jenna\'s link cannot complain about Ruth\'s job', (await M.apiCustAction(req({ action: 'issue', id: rb.id, note: 'x' }), q(tok))).status === 404);
ok('"not right" on a job that has not happened is refused', (await M.apiCustAction(req({ action: 'issue', id: bk.id, note: 'x' }), q(tok))).status === 409);

// ------------------------------------------------------------------- after
section('After the job: how to look after it, and a way to say it isn\'t right');
{
  const all = await M.loadBookings();
  const j = all.find((x) => x.id === bk.id);
  j.status = 'done'; j.doneAt = NOW - 2 * DAY; j.apptAt = NOW - 2 * DAY; j.serviceName = 'Ceramic Coating';
  await M.saveBookings(all);
}
await paid(JENNA, 650);
h = await html(tok);
ok('the after card is there', /Thanks for having me out/.test(h));
ok('ceramic gets the ceramic advice (no wash for 7 days)', /Don't wash it for 7 days/.test(h));
ok('the review link is offered', /g\.page\/r\/mikey-review/.test(h));
ok('…and the "not right" box sits on the same card', /Something not right\?/.test(h) && h.indexOf('Something not right') < h.indexOf('Leave a review'));
ok('no "before" card once it is done', !/Before I get there/.test(h));
ok('no "nothing on the books" nag right after a job', !/Nothing on the books/.test(h));
ok('the service kinds read right', M.careKind('Full Detail — In & Out') === 'full' && M.careKind('Interior Detail') === 'interior' &&
  M.careKind('Exterior Detail') === 'exterior' && M.careKind('Paint Correction (1-step)') === 'correction' && M.careKind('') === 'full');
ok('every kind has advice', ['ceramic', 'correction', 'interior', 'exterior', 'full'].every((k) => M.CARE_TIPS[k].length >= 3));

alerts.length = 0; sms.length = 0;
ok('an empty complaint is refused', (await M.apiCustAction(req({ action: 'issue', id: bk.id, note: '  ' }), q(tok))).status === 422);
res = await (await M.apiCustAction(req({ action: 'issue', id: bk.id, note: 'Water spots on the hood' }), q(tok))).json();
ok('a real one goes through', res.ok && res.after.issueAt > 0, res);
ok('Mikey is told what they said', alerts.length === 1 && /not right/.test(alerts[0].subject) && /Water spots/.test(alerts[0].text));
ok('it is on the conversation notes for when he opens it', /Water spots on the hood/.test((await M.loadThread(JENNA)).notes));
ok('nothing texts the customer back on its own', sms.length === 0, sms);
ok('the page now says he got it', /I'll be in touch/.test(await html(tok)));

section('Three weeks on, the page gets out of the way');
{
  const all = await M.loadBookings();
  const j = all.find((x) => x.id === bk.id); j.doneAt = NOW - 30 * DAY; j.apptAt = NOW - 30 * DAY;
  await M.saveBookings(all);
}
h = await html(tok);
ok('no after card a month later', !/Thanks for having me out/.test(h));
ok('it is back to "nothing on the books"', /Nothing on the books/.test(h));

// ----------------------------------------------------------------- referral
section('Send a friend: the share link');
ok('someone who has had a detail gets the share card', /Send a friend/.test(h) && /Share my link/.test(h));
ok('it states the offer', h.includes('you both get a free Exterior Detail'));
const code = await M.refCodeFor(JENNA);
ok('the share link carries a code, not their page token', h.includes('book.html?ref=' + code) && !h.includes('ref=' + tok));
ok('the code is not the token at all', code !== tok && !tok.includes(code));
ok('the same person always gets the same code', (await M.refCodeFor(JENNA)) === code);
ok('the code resolves to them', (await M.refResolve(code)) === JENNA);
ok('a made-up code resolves to nobody', (await M.refResolve('zzzzzzzzzz')) === '');
ok('a short code is refused outright', (await M.refResolve('abc')) === '');

section('A friend books with the link');
const cfg0 = await M.loadConfig();
let date = '', slot = '';
for (let i = 2; i < 20 && !slot; i++) {
  const d = M.localDateStr(NOW + i * DAY, cfg0.tz);
  const s = await M.bkAvailability(d, 'full', 'suv');
  if (s.length) { date = d; slot = s[0]; }
}
ok('(test setup) found an open slot', !!slot);
alerts.length = 0; sms.length = 0;
const fb = await (await M.apiBook(req({
  service: 'full', size: 'suv', date, slot, name: 'Frank Lee', phone: FRIEND,
  address: '9 Pine St', city: 'Monroe', ref: code, smsConsent: false,
}))).json();
ok('the booking goes through', fb.ok, fb);
const ft = await M.loadThread(FRIEND);
ok('the friend is filed as sent by Jenna', ft.referredBy && ft.referredBy.phone === JENNA && ft.referredBy.how === 'link', ft.referredBy);
ok('Mikey\'s booking alert says who sent them', alerts.length === 1 && /Sent by: Jenna Smith/.test(alerts[0].text), alerts[0] && alerts[0].text);
ok('the referrer is NOT texted about it', !sms.some((m) => m.to === JENNA), sms);

let cr = M.refCredits(JENNA, await M.loadIndex(), {});
ok('nothing is earned while the friend has only booked', cr.earned === 0 && cr.friends === 1, cr);

section('Free exteriors unlock when the friend\'s first detail is paid');
await paid(FRIEND, 339);
const spend = { [JENNA]: { jobs: 1 }, [FRIEND]: { jobs: 1 } };
cr = M.refCredits(JENNA, await M.loadIndex(), spend);
ok('Jenna earns one', cr.earned === 1 && cr.owed === 1, cr);
const fcr = M.refCredits(FRIEND, await M.loadIndex(), spend);
ok('…and so does the friend', fcr.earned === 1 && fcr.owed === 1, fcr);
h = await html(tok);
ok('Jenna\'s page says she has one waiting', /1 free Exterior Detail waiting/.test(h), (h.match(/free Exterior Detail[^<]*/g) || []));
ok('…and that a friend booked', /1 friend booked with your link/.test(h));

M.__resetCfg();
let rep = await M.buildReferrals(await M.loadConfig());
ok('the Word of mouth report lists both as owed', rep.owed.length === 2 && rep.totals.extOwed === 2, rep.owed);
ok('Jenna shows as a referrer with one owed', rep.referrers[0].phone === JENNA && rep.referrers[0].extOwed === 1, rep.referrers[0]);

section('He marks one done');
let red = await (await M.apiReferralAction(req({ action: 'redeem', phone: JENNA }))).json();
ok('it saves', red.ok, red);
ok('Jenna is down to none owed', red.owed.find((o) => o.phone === JENNA).owed === 0);
ok('the friend still has theirs', red.owed.find((o) => o.phone === FRIEND).owed === 1);
red = await (await M.apiReferralAction(req({ action: 'redeem', phone: JENNA }))).json();
ok('a double-tap cannot bank more than was earned', (await M.loadThread(JENNA)).freeExtUsed === 1);
red = await (await M.apiReferralAction(req({ action: 'redeem', phone: JENNA, undo: true }))).json();
ok('undo puts it back', red.owed.find((o) => o.phone === JENNA).owed === 1);
red = await (await M.apiReferralAction(req({ action: 'redeem', phone: JENNA, undo: true }))).json();
ok('…and never below zero', (await M.loadThread(JENNA)).freeExtUsed === 0);

section('The link cannot be turned on its owner');
const selfBk = await (await M.apiBook(req({
  service: 'full', size: 'suv', date, slot: (await M.bkAvailability(date, 'full', 'suv'))[0] || slot,
  name: 'Jenna Smith', phone: JENNA, address: '1425 Cedar Ave', city: 'Everett', ref: code, smsConsent: false,
}))).json();
ok('(booking with your own code still books)', selfBk.ok || selfBk.error === 'slot_taken', selfBk);
ok('…but nobody refers themselves', !(await M.loadThread(JENNA)).referredBy);
{
  // Ruth already said Jenna sent her; a link from someone else doesn't overwrite that.
  const rt = await M.loadThread(RUTH);
  rt.referredBy = { phone: JENNA, name: 'Jenna Smith', at: NOW, thankedAt: 0, how: 'set' };
  await M.saveThread(rt); await M.updateIndexEntry(rt);
  const other = await M.refCodeFor(FRIEND);
  let d2 = '', s2 = '';
  for (let i = 2; i < 25 && !s2; i++) {
    const d = M.localDateStr(NOW + i * DAY, cfg0.tz);
    const s = await M.bkAvailability(d, 'full', 'suv');
    if (s.length) { d2 = d; s2 = s[s.length - 1]; }
  }
  await M.apiBook(req({ service: 'full', size: 'suv', date: d2, slot: s2, name: 'Ruth Adams', phone: RUTH,
    address: '9 Bell Way', city: 'Marysville', ref: other, smsConsent: false }));
  ok('a referral already on file is never overwritten by a link', (await M.loadThread(RUTH)).referredBy.phone === JENNA);
}

section('Nothing here texted a customer');
ok('no SMS to any customer across the whole suite', !sms.some((m) => [JENNA, RUTH, FRIEND].includes(m.to)), sms);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
