// Before the job and after it — three pages on the customer's own link, each
// its own URL (/before, /after, /friend + /<token>), answering the things every
// customer asks by text: "what do I need to do?", "what now?", and the share
// link that makes word of mouth countable. Plus the bare /before and /after he
// keeps saved, and the bookkeeping that decides when the dashboard suggests one.
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

const EXPORTS = ['custTokenFor', 'custState', 'apiCustState', 'apiCustAction', 'custPage', 'custSubPage', 'apiBook',
  'apiCustLink', 'apiCustLinkSkip', 'appendMessage', 'apiDayJob', 'apiDayState', 'buildIndexSummary',
  'refCodeFor', 'refResolve', 'refCredits', 'careKind', 'CARE_TIPS', 'REF_OFFER', 'buildReferrals', 'apiReferralAction',
  'loadThread', 'saveThread', 'updateIndexEntry', 'loadBookings', 'saveBookings', 'loadIndex',
  'loadMonth', 'saveMonth', 'loadConfig', 'localDateStr', 'bkAvailability', 'genId',
  'custCalendar', 'apiCustDid', 'apiSaveConfig', 'apiPushPeek'];

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
async function paid(phone, amount, ts) {
  const cfg = await M.loadConfig();
  const day = M.localDateStr(ts || NOW, cfg.tz);
  const m = day.slice(0, 7);
  const doc = await M.loadMonth(m);
  doc.entries.push({ id: M.genId(), type: 'job', phone, amount, date: day });
  await M.saveMonth(m, doc);
}
const html = async (tok) => (await M.custPage(tok)).text();
const page = async (kind, tok) => (await M.custSubPage(kind, tok || '')).text();

store.clear(); M.__resetCfg();
store.set('config', JSON.stringify({ reviewUrl: 'https://g.page/r/mikey-review' }));
M.__resetCfg();

// ------------------------------------------------------------------ before
section('Before the job: the page says what to have ready');
await customer(JENNA, 'Jenna Smith');
const tok = await M.custTokenFor(JENNA);
const bk = await booking(JENNA);
let h = await page('before', tok);
ok('/before/<token> is its own page', /<title>Before I get there<\/title>/.test(h) && /Hi Jenna/.test(h));
ok('it shows the job it is about', /Your detail/.test(h) && /Saturday/.test(h));
ok('…arriving morning or afternoon, never an exact time', /Morning · Full Detail/.test(h) && !/10:00 AM/.test(h));
ok('…with the address and a way to fix it', /1425 Cedar Ave, Everett/.test(h) && /id="addrBtn"/.test(h));
ok('…and an add-to-calendar link', h.includes(`href="/cal/${tok}.ics"`));
ok('the price is not on it (his call)', !/\$299/.test(h));
ok('"How it goes" in three steps', /How it goes/.test(h) && (h.match(/<li>/g) || []).length >= 3);
{ const p = h.slice(h.indexOf('id="prepCard"'));
  ok('water and power comes first', p.indexOf('Water and power') > 0 && p.indexOf('Water and power') < p.indexOf("don't need to be home")); }
ok('it says they need a spigot and an outlet, and that he cannot bring it', /spigot/.test(h) && /outlet/.test(h) && /can't bring/.test(h));
ok('they do not need to be home, just access to the car', /don't need to be home/.test(h) && /unlocked/.test(h));
ok('how long, from the booking (210 min → 3½ hours)', /About 3½ hours/.test(h), (h.match(/How long[^<]*<\/b>[^<]*/) || [])[0]);
ok('payment: after, cash, check or Zelle, no deposit', /Cash, check or Zelle/.test(h) && /No deposit/.test(h));
ok('rain: he texts and they figure it out', /If it rains/.test(h));
ok('it has the "I\'m all set" button, locked until every box is ticked', /id="readyBtn" type="button" disabled/.test(h));
ok('the checklist is the four things that waste a drive', ['water', 'power', 'keys', 'room'].every((c) => h.includes(`value="${c}"`)));
ok('no Text / Call Mikey card (his call)', !/Need me\?/.test(h) && !/href="tel:/.test(h));
ok('the stars and the website are at the bottom', /5\.0 across 40 Google reviews/.test(h) && /href="https:\/\/mikeysdetailing\.com"/.test(h));
ok('it draws a proper preview when texted', /og:image" content="https:\/\/texting\.example\.workers\.dev\/og-car\.jpg"/.test(h) && /og:title" content="Before your detail/.test(h));
ok('none of the booking code rides along', !/function startBook/.test(h) && /action:"seen"/.test(h));
ok('short jobs read in minutes', /About 90 minutes/.test(await (async () => {
  const all = await M.loadBookings(); all[0].durationMin = 90; await M.saveBookings(all); return page('before', tok);
})()));
let hub = await html(tok);
ok('the hub points at the before page', hub.includes(`href="/before/${tok}"`));
ok('…but not an after page before any job', !hub.includes('/after/'));
ok('…nor a friend page for someone who has not had a detail', !hub.includes('/friend/'));

section('"I\'ve got water and power" tells Mikey');
alerts.length = 0; sms.length = 0;
let res = await (await M.apiCustAction(req({ action: 'ready', note: 'Gate code 4412, car is in the garage' }), q(tok))).json();
ok('it goes through', res.ok, res);
const saved = (await M.loadThread(JENNA)).prepReady;
ok('it is remembered against this job', saved && saved.forAt === bk.apptAt && /4412/.test(saved.note), saved);
ok('Mikey is told, with the note', alerts.length === 1 && /is set for/.test(alerts[0].subject) && /4412/.test(alerts[0].text), alerts[0]);
ok('the customer is NOT texted', sms.length === 0, sms);
ok('the state now says they are set', res.ready && res.ready.at > 0);
h = await page('before', tok);
ok('the page shows it back instead of the form again', /You told me you're set/.test(h) && /prepForm" hidden/.test(h));
await M.apiCustAction(req({ action: 'ready' }), q(tok));
await M.apiCustAction(req({ action: 'ready' }), q(tok));
const r4 = await M.apiCustAction(req({ action: 'ready' }), q(tok));
ok('a public link cannot ring his phone forever (3 per job)', r4.status === 429, r4.status);

section('A token still only touches its own bookings');
await customer(RUTH, 'Ruth Adams');
const tokR = await M.custTokenFor(RUTH);
const rb = await booking(RUTH);
await M.apiCustAction(req({ action: 'ready', note: 'ruth here' }), q(tokR));
ok('Ruth\'s "ready" lands on Ruth, never on Jenna', (await M.loadThread(RUTH)).prepReady.note === 'ruth here' &&
  (await M.loadThread(JENNA)).prepReady.note !== 'ruth here');
ok('Ruth\'s link cannot cancel Jenna\'s booking', (await M.apiCustAction(req({ action: 'cancel', id: bk.id }), q(tokR))).status === 404);
ok('"not right" before any job has happened is refused', (await M.apiCustAction(req({ action: 'issue', note: 'x' }), q(tok))).status === 409);

section('A job agreed over text (no booking) still gets a before page');
const TEXTED = '+14255550444';
{
  const t = await customer(TEXTED, 'Omar Diaz');
  t.appointmentAt = NOW + 2 * DAY; await M.saveThread(t); await M.updateIndexEntry(t);
}
const tokT = await M.custTokenFor(TEXTED);
h = await page('before', tokT);
ok('it knows the day from the conversation', /Your detail/.test(h) && /id="readyBtn"/.test(h));
ok('with no booking it gives the usual times instead of guessing', /A full detail takes 3–5 hours/.test(h));
ok('"I\'m set" works without a booking', (await (await M.apiCustAction(req({ action: 'ready' }), q(tokT))).json()).ok);

// ------------------------------------------------------------------- after
section('After the job: how to look after it, and a way to say it isn\'t right');
{
  const all = await M.loadBookings();
  const j = all.find((x) => x.id === bk.id);
  j.status = 'done'; j.doneAt = NOW - 2 * DAY; j.apptAt = NOW - 2 * DAY; j.serviceName = 'Ceramic Coating';
  await M.saveBookings(all);
}
await paid(JENNA, 650, NOW - 30 * DAY);
h = await page('after', tok);
ok('/after/<token> is its own page', /<title>Looking after it<\/title>/.test(h));
ok('the after card is there', /Thanks for having me out/.test(h));
ok('ceramic gets the ceramic advice (no wash for 7 days)', /Don't wash it for 7 days/.test(h));
ok('the review link is offered', /g\.page\/r\/mikey-review/.test(h));
ok('…in its own "Happy with it?" card', /Happy with it\?/.test(h));
ok('no "something not right" box any more (his call: they reply to the text)', !/Something not right/.test(h) && !/id="issueBtn"/.test(h));
ok('the friend card sits near the top, above the care tips', h.indexOf('/friend/') > 0 && h.indexOf('/friend/') < h.indexOf("Don't wash it for 7 days"));
ok('it points at the next one, 6–8 weeks out', /every 6–8 weeks/.test(h) && h.includes(`href="/c/${tok}#book"`) && /id="planBtn"/.test(h));
hub = await html(tok);
ok('the hub now points at the after page', hub.includes(`href="/after/${tok}"`));
ok('…and no longer at the before page', !hub.includes('/before/'));
ok('no "nothing on the books" nag right after a job', !/Nothing on the books/.test(hub));
ok('the service kinds read right', M.careKind('Full Detail — In & Out') === 'full' && M.careKind('Interior Detail') === 'interior' &&
  M.careKind('Exterior Detail') === 'exterior' && M.careKind('Paint Correction (1-step)') === 'correction' && M.careKind('') === 'full');
ok('every kind has advice', ['ceramic', 'correction', 'interior', 'exterior', 'full'].every((k) => M.CARE_TIPS[k].length >= 3));

alerts.length = 0; sms.length = 0;
ok('an empty complaint is refused', (await M.apiCustAction(req({ action: 'issue', note: '  ' }), q(tok))).status === 422);
res = await (await M.apiCustAction(req({ action: 'issue', note: 'Water spots on the hood' }), q(tok))).json();
ok('a real one goes through', res.ok && res.after.issueAt > 0, res);
ok('Mikey is told what they said', alerts.length === 1 && /not right/.test(alerts[0].subject) && /Water spots/.test(alerts[0].text));
ok('it is on the conversation notes for when he opens it', /Water spots on the hood/.test((await M.loadThread(JENNA)).notes));
ok('nothing texts the customer back on its own', sms.length === 0, sms);
ok('(the old endpoint still records it if anything calls it)', res.after.issueAt > 0);

section('A month on, the after page still shows their last job; the hub moves on');
{
  const all = await M.loadBookings();
  const j = all.find((x) => x.id === bk.id); j.doneAt = NOW - 30 * DAY; j.apptAt = NOW - 30 * DAY;
  await M.saveBookings(all);
}
h = await page('after', tok);
ok('the after page still shows their last job a month later', /Your last detail/.test(h) && /Ceramic Coating/.test(h));
{
  const OLD = '+14255550321';
  const ot = await customer(OLD, 'Pat Old');
  ot.lastJob = { at: NOW - 70 * DAY, service: 'Exterior Detail', jobId: 'j-old' }; await M.saveThread(ot); await M.updateIndexEntry(ot);
  const oh = await page('after', await M.custTokenFor(OLD));
  ok('…and says they are due once 8 weeks have passed', /you're due/.test(oh) && /Exterior Detail/.test(oh));
}
h = await html(tok);
ok('the hub is back to "nothing on the books"', /Nothing on the books/.test(h));
ok('…and keeps pointing at the friend page', h.includes(`href="/friend/${tok}"`));

// ----------------------------------------------------------------- referral
section('Send a friend: the share link');
h = await page('friend', tok);
ok('/friend/<token> is its own page with a share button', /<title>Send a friend<\/title>/.test(h) && /Share my link/.test(h));
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
h = await page('friend', tok);
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

section('The saved links: bare /before, /after, /friend work for anybody');
h = await page('before');
ok('/before renders with no customer', /<title>Before I get there<\/title>/.test(h) && /spigot/.test(h));
ok('…with the usual times, not somebody\'s booking', /A full detail takes 3–5 hours/.test(h) && !/Jenna|Saturday/.test(h));
ok('…and a text-me button instead of one that needs to know who you are', !/id="readyBtn"/.test(h) && /id="smsSet" type="button" data-tel="\+14256007897"/.test(h));
ok('…with the same checklist', /value="water"/.test(h) && /value="room"/.test(h));
ok('…and no job card or calendar', !/Your detail/.test(h) && !/\/cal\//.test(h));
ok('…and no "opened" beacon, because the generic page is nobody\'s', /var TOK=""/.test(h));
h = await page('after');
ok('/after asks what was done and shows that one', /What did I do\?/.test(h) && /data-care="ceramic"/.test(h) && /data-care-list="ceramic" hidden/.test(h) && /After a paint correction/.test(h));
ok('…with booking pointed at the website', /Book the next one/.test(h) && /href="https:\/\/mikeysdetailing\.com" target/.test(h));
ok('…with the review link', /g\.page\/r\/mikey-review/.test(h));
ok('…and no complaint box that can\'t say who it\'s from', !/id="issueBtn"/.test(h));
h = await page('friend');
ok('/friend states the offer and asks them to text for their link', h.includes('you both get a free Exterior Detail') && /Text Mikey/.test(h));
ok('a made-up token is a dead link, not somebody else\'s page', (await M.custSubPage('before', 'zzzzzzzzzzzzzzzz')).status === 404);

section('Finished on the Jobs board: the after page sees it');
const BOARD = '+14255550555';
await customer(BOARD, 'Lena Park');
const today = M.localDateStr(NOW, cfg0.tz);
const dj = await (await M.apiDayJob(req({ date: today, name: 'Lena Park', phone: BOARD, service: 'Interior Detail', slot: '09:00' }))).json();
ok('(setup) the job is on the board', dj.ok, dj);
const jid = dj.day.jobs.find((j) => j.phone === BOARD).id;
await M.apiDayState(req({ date: today, jobId: jid, state: 'done' }));
let lt = await M.loadThread(BOARD);
ok('marking it done stamps the customer', lt.lastJob && lt.lastJob.jobId === jid && lt.lastJob.service === 'Interior Detail', lt.lastJob);
ok('the list row carries it, for Home\'s suggestion', (await M.loadIndex()).find((r) => r.phone === BOARD).lastJobAt === lt.lastJob.at);
const tokB = await M.custTokenFor(BOARD);
h = await page('after', tokB);
ok('the after page shows it, with interior advice', /Thanks for having me out/.test(h) && /Interior Detail/.test(h) && /crack the windows/.test(h));
await M.apiDayState(req({ date: today, jobId: jid, state: 'queued' }));
ok('re-queueing it (a mis-tap) takes it back off', !(await M.loadThread(BOARD)).lastJob);

section('The dashboard knows which link went out');
const lk = await (await M.apiCustLink(req({ phone: JENNA }))).json();
ok('it hands back all four links', ['book', 'before', 'after', 'friend'].every((k) => lk.links[k] && lk.links[k].includes(tok)), lk.links);
ok('…each on its own path', lk.links.before.endsWith('/before/' + tok) && lk.links.after.endsWith('/after/' + tok) && lk.links.friend.endsWith('/friend/' + tok));
ok('…plus the bare ones to keep saved', lk.saved.before.endsWith('/before') && lk.saved.after.endsWith('/after'));
ok('…and a draft for each, in his voice, containing its link', ['before', 'after', 'friend'].every((k) => lk.drafts[k].includes(lk.links[k])) && /^Hey Jenna/.test(lk.drafts.before));
ok('asking for the links texts nobody', sms.length === 0 || !sms.some((m) => m.to === JENNA));
await M.appendMessage(JENNA, { dir: 'out', body: lk.drafts.after, status: 'sent' });
let jt = await M.loadThread(JENNA);
ok('sending the after text marks the after link sent', jt.linkSent && jt.linkSent.after > 0 && !jt.linkSent.before, jt.linkSent);
await M.appendMessage(JENNA, { dir: 'out', body: 'Here you go ' + lk.saved.before, status: 'sent' });
jt = await M.loadThread(JENNA);
ok('pasting the bare saved link counts too', jt.linkSent.before > 0);
await M.appendMessage(JENNA, { dir: 'in', body: lk.links.friend, status: 'received' });
ok('a customer pasting a link back does not count as him sending it', !(await M.loadThread(JENNA)).linkSent.friend);
ok('the list row carries what was sent', (await M.loadIndex()).find((r) => r.phone === JENNA).linkAt.after > 0);
const sk = await (await M.apiCustLinkSkip(req({ phone: JENNA, kind: 'friend' }))).json();
ok('"Not now" is remembered per kind', sk.ok && sk.thread.linkSkip.friend > 0);
ok('…and on the list row', (await M.loadIndex()).find((r) => r.phone === JENNA).linkSkip.friend > 0);
ok('a made-up kind is refused', (await M.apiCustLinkSkip(req({ phone: JENNA, kind: 'spam' }))).status === 422);

section('The before-page checklist, the address fix and the calendar');
{
  const CK = '+14255550901';
  await customer(CK, 'Cara Kent');
  const tk = await M.custTokenFor(CK);
  const cb = await booking(CK, { serviceName: 'Exterior Detail', slot: '13:00', apptAt: NOW + 2 * DAY, date: dateOf(NOW + 2 * DAY), dateLabel: 'Friday' });
  let ph = await page('before', tk);
  ok('an exterior job does not ask for keys or car seats', !ph.includes('value="keys"') && !/Clear it out/.test(ph) && /all outside/.test(ph));
  ok('…and reads as an afternoon', /Afternoon · Exterior Detail/.test(ph));
  alerts.length = 0;
  let r = await (await M.apiCustAction(req({ action: 'ready', checks: ['water', 'power', 'room', 'bogus'], note: 'side gate' }), q(tk))).json();
  ok('ticking the boxes says they are set', r.ok && r.ready, r);
  ok('Mikey is told exactly what they ticked, and nothing made up', alerts.length === 1 && /They ticked: Outdoor water spigot, Power outlet you can reach, Room to work around the car\./.test(alerts[0].text) && !/bogus/.test(alerts[0].text), alerts[0] && alerts[0].text);

  alerts.length = 0;
  const before = JSON.stringify((await M.loadThread(CK)).garage);
  r = await (await M.apiCustAction(req({ action: 'address', address: '88 Birch Rd, Monroe' }), q(tk))).json();
  ok('"Wrong? Fix it" goes through', r.ok && r.addrFix && r.addrFix.address === '88 Birch Rd, Monroe', r);
  ok('…tells Mikey both addresses', alerts.length === 1 && /88 Birch Rd/.test(alerts[0].text) && /1425 Cedar Ave/.test(alerts[0].text));
  ok('…never overwrites what is on file', JSON.stringify((await M.loadThread(CK)).garage) === before);
  ok('…and lands on the notes', /88 Birch Rd, Monroe/.test((await M.loadThread(CK)).notes));
  ok('the page shows it back', /Sent to Mikey: 88 Birch Rd, Monroe/.test(await page('before', tk)));
  ok('an empty address is refused', (await M.apiCustAction(req({ action: 'address', address: ' ' }), q(tk))).status === 422);
  await M.apiCustAction(req({ action: 'address', address: 'b' }), q(tk));
  await M.apiCustAction(req({ action: 'address', address: 'c' }), q(tk));
  ok('…and it cannot be leaned on (3 per job)', (await M.apiCustAction(req({ action: 'address', address: 'd' }), q(tk))).status === 429);

  const cal = await M.custCalendar(tk);
  const ics = await cal.text();
  ok('/cal/<token>.ics is a calendar file', /text\/calendar/.test(cal.headers.get('Content-Type')) && /BEGIN:VEVENT/.test(ics));
  ok('…all-day on the job date, no made-up clock time', ics.includes('DTSTART;VALUE=DATE:' + cb.date.replace(/-/g, '')) && !/DTSTART:\d/.test(ics));
  ok('…that says afternoon and what he needs', /afternoon/.test(ics) && /water spigot/.test(ics) && /Exterior Detail/.test(ics));
  ok('a made-up token gets no calendar', (await M.custCalendar('zzzzzzzzzzzzzzzz')).status === 404);
}

section('After page: what I did, and "put me on a plan"');
{
  const DD = '+14255550902';
  const dt = await customer(DD, 'Dana Diaz');
  ok('"What I did" needs a finished job to hang off', (await M.apiCustDid(req({ phone: DD, did: ['Hand wash'] }))).status === 409);
  dt.lastJob = { at: NOW - DAY, service: 'Full Detail', jobId: 'j1' }; await M.saveThread(dt); await M.updateIndexEntry(dt);
  const dr = await (await M.apiCustDid(req({ phone: DD, did: ['Hand wash', 'Seats and carpets shampooed', 'Hand wash', ''] }))).json();
  ok('he ticks what he did, deduped', dr.ok && dr.lastJob.did.join('|') === 'Hand wash|Seats and carpets shampooed', dr);
  const td = await M.custTokenFor(DD);
  let ah = await page('after', td);
  ok('the after page lists it', /What I did/.test(ah) && /<li>Seats and carpets shampooed<\/li>/.test(ah));
  alerts.length = 0;
  let r = await (await M.apiCustAction(req({ action: 'plan' }), q(td))).json();
  ok('"Put me on a plan" tells Mikey', r.ok && r.planAskAt > 0 && alerts.length === 1 && /wants to go on a plan/.test(alerts[0].subject));
  ok('…and does not put them on one by itself', !(await M.loadThread(DD)).plan);
  await M.apiCustAction(req({ action: 'plan' }), q(td));
  ok('…once a day, however many taps', alerts.length === 1);
  ah = await page('after', td);
  ok('the page says he got it', /I'll text you about a plan/.test(ah) && !/id="planBtn"/.test(ah));
}

section('Opened and tapped: the dashboard hears about it, once');
{
  const OP = '+14255550903';
  await customer(OP, 'Owen Park');
  const to = await M.custTokenFor(OP);
  await M.appendMessage(OP, { dir: 'out', body: 'Here you go https://texting.example.workers.dev/before/' + to, status: 'sent' });
  store.delete('push:note');
  let r = await (await M.apiCustAction(req({ action: 'seen', kind: 'before' }), q(to))).json();
  ok('the first open is noted', r.ok && r.noted && (await M.loadThread(OP)).linkOpen.before > 0, r);
  ok('…mirrored onto the list row', (await M.loadIndex()).find((x) => x.phone === OP).linkOpen.before > 0);
  ok('…and the phone gets a headline that says who', /Owen Park opened their before-job link/.test(JSON.parse(store.get('push:note') || '{}').title || ''));
  const peek = await (await M.apiPushPeek()).json();
  ok('the push shows that headline once', /opened their before-job link/.test(peek.title));
  ok('…and not again', !/opened/.test((await (await M.apiPushPeek()).json()).title));
  r = await (await M.apiCustAction(req({ action: 'seen', kind: 'before' }), q(to))).json();
  ok('opening it again writes nothing', r.ok && r.noted === false);
  ok('a made-up page kind is refused', (await M.apiCustAction(req({ action: 'seen', kind: 'x' }), q(to))).status === 422);
  r = await (await M.apiCustAction(req({ action: 'tap', kind: 'before', name: 'calendar' }), q(to))).json();
  ok('a tap is counted', r.noted && (await M.loadThread(OP)).linkTaps['before:calendar'].n === 1);
  r = await (await M.apiCustAction(req({ action: 'tap', kind: 'before', name: 'calendar' }), q(to))).json();
  ok('…a double-tap is not', r.noted === false && (await M.loadThread(OP)).linkTaps['before:calendar'].n === 1);
  ok('an unknown button is refused', (await M.apiCustAction(req({ action: 'tap', kind: 'before', name: 'evil' }), q(to))).status === 422);
  await M.appendMessage(OP, { dir: 'out', body: 'Again https://texting.example.workers.dev/before/' + to, status: 'sent' });
  r = await (await M.apiCustAction(req({ action: 'seen', kind: 'before' }), q(to))).json();
  ok('sending the link again means the next open counts again', r.noted === true);
}

section('He can change the page wording from Settings');
{
  await M.apiSaveConfig(req({ custPages: { rain: 'Rain? I have a pop-up tent.', stars: '5.0 across 41 Google reviews', care_ceramic: 'Line one\nLine two' } }));
  M.__resetCfg();
  let gh = await page('before');
  ok('his rain line replaces mine', /Rain\? I have a pop-up tent\./.test(gh) && !/under cover if there's room/.test(gh));
  ok('the stars line updates', /41 Google reviews/.test(gh));
  ok('care tips are one per line', /<div class="tip">Line one<\/div><div class="tip">Line two<\/div>/.test(await page('after')));
  await M.apiSaveConfig(req({ custPages: { rain: '' } }));
  M.__resetCfg();
  gh = await page('before');
  ok('clearing a box puts the original words back', /under cover if there's room/.test(gh) && /41 Google reviews/.test(gh));
  ok('page text is escaped, never markup', await (async () => {
    await M.apiSaveConfig(req({ custPages: { beforeIntro: '<img src=x onerror=alert(1)>' } })); M.__resetCfg();
    const x = await page('before'); await M.apiSaveConfig(req({ custPages: { beforeIntro: '' } })); M.__resetCfg();
    return !x.includes('<img src=x') && x.includes('&lt;img');
  })());
}

section('Nothing here texted a customer');
ok('no SMS to any customer across the whole suite', !sms.some((m) => [JENNA, RUTH, FRIEND, TEXTED, BOARD, '+14255550901', '+14255550902', '+14255550903'].includes(m.to)), sms);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
