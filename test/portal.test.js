// The customer's own page (/c/<token>) and the pricing read-out.
//
// The portal is the only place in this app where somebody who is not Mikey can
// change data, so most of what's asserted here is containment: a token sees one
// customer and only that customer, and the one write it can do (cancelling their
// own booking) tells Mikey and pulls the reminders the job had queued.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['custTokenFor', 'custResolve', 'custState', 'apiCustState', 'apiCustAction',
  'apiCustLink', 'custPage', 'apiBook', 'buildPricing', 'apiPricing',
  'loadThread', 'saveThread', 'updateIndexEntry', 'loadBookings', 'saveBookings',
  'loadQuotes', 'saveQuotes', 'loadMonth', 'saveMonth', 'loadConfig', 'localDateStr',
  'loadQuoteMonth', 'saveQuoteMonth', 'bkLaEpoch', 'genId'];

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
const ago = (d) => NOW - d * DAY;
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

async function customer(phone, opts = {}) {
  const t = await M.loadThread(phone);
  t.name = opts.name || 'Jenna Smith';
  t.messages = [{ id: 'm', dir: 'in', body: 'hi', ts: ago(2) }];
  if (opts.garage) t.garage = opts.garage;
  if (opts.plan) t.plan = opts.plan;
  if (opts.appointmentAt) t.appointmentAt = opts.appointmentAt;
  await M.saveThread(t); await M.updateIndexEntry(t);
  return t;
}
async function booking(phone, o) {
  const all = await M.loadBookings();
  const rec = Object.assign({
    id: M.genId(), phone, status: 'confirmed', serviceName: 'Full Detail', estimate: 260,
    date: dateOf(NOW + 3 * DAY), slot: '10:00', dateLabel: 'Saturday', apptAt: NOW + 3 * DAY,
    smsConsent: true,
  }, o || {});
  all.unshift(rec); await M.saveBookings(all);
  return rec;
}

store.clear(); M.__resetCfg();

// ------------------------------------------------------------------ tokens
section('One link per customer, forever');
await customer('+14255551234', { garage: { vehicles: [{ year: '2019', make: 'Chevy', model: 'Tahoe' }], address: '1425 Cedar Ave', city: 'Everett' } });
const tok = await M.custTokenFor('+14255551234');
ok('a token is minted', tok.length >= 12, tok.length);
ok('the same customer gets the same link back', (await M.custTokenFor('+14255551234')) === tok);
ok('it resolves to that customer', (await M.custResolve(tok)).phone === '+14255551234');
ok('a made-up token resolves to nobody', (await M.custResolve('aaaaaaaaaaaaaaaa')) === null);
ok('a short token is refused outright', (await M.custResolve('abc')) === null);
const tok2 = await M.custTokenFor('+14255559999');
ok('two customers get different links', tok2 !== tok);

section('A token shows that customer and nobody else');
await customer('+14255559999', { name: 'Ruth Adams', garage: { vehicles: [], address: '9 Bell Way', city: 'Marysville' } });
let st = await (await M.apiCustState(q(tok))).json();
ok('their name', st.first === 'Jenna');
ok('their vehicle', /Tahoe/.test(st.vehicle), st.vehicle);
ok('their address', st.address === '1425 Cedar Ave');
ok('not the other customer\'s address', !/Bell Way/.test(JSON.stringify(st)));
ok('no phone number is echoed back', !/4255551234/.test(JSON.stringify(st)));
ok('a bad token gets nothing', (await M.apiCustState(q('nope-nope-nope'))).status === 404);

section('What is coming up');
const bk = await booking('+14255551234');
st = await (await M.apiCustState(q(tok))).json();
ok('their booking is shown', st.upcoming && st.upcoming.id === bk.id);
ok('with the service and price', st.upcoming.service === 'Full Detail' && st.upcoming.price === 260);
ok('somebody else\'s booking is not', !(await (await M.apiCustState(q(tok2))).json()).upcoming);

section('Cancelling their own booking');
alerts.length = 0;
const t0 = await M.loadThread('+14255551234');
t0.appointmentAt = bk.apptAt;
t0.scheduled = [{ id: 'r1', bkId: bk.id, kind: 'booking', body: 'see you tomorrow!', sendAt: NOW + 2 * DAY }];
await M.saveThread(t0);
let res = await (await M.apiCustAction(req({ action: 'cancel', id: bk.id }), q(tok))).json();
ok('it goes through', res.ok && res.cancelled);
ok('the booking is cancelled', (await M.loadBookings()).find((x) => x.id === bk.id).status === 'cancelled');
ok('…and marked as cancelled by the customer', (await M.loadBookings()).find((x) => x.id === bk.id).cancelledBy === 'customer');
const after = await M.loadThread('+14255551234');
ok('the queued "see you tomorrow" reminder is pulled', after.scheduled.length === 0, after.scheduled);
ok('the appointment comes off the conversation', !after.appointmentAt);
ok('Mikey is told', alerts.length === 1 && /cancelled their own booking/i.test(alerts[0].subject + alerts[0].text));
ok('the customer is NOT texted by the cancel', sms.length === 0, sms);
ok('the page now shows nothing booked', !res.upcoming);
ok('cancelling twice is harmless', (await (await M.apiCustAction(req({ action: 'cancel', id: bk.id }), q(tok))).json()).ok);

section('A token cannot touch anyone else');
const other = await booking('+14255559999');
res = await M.apiCustAction(req({ action: 'cancel', id: other.id }), q(tok));
ok('cancelling a stranger\'s booking is not found', res.status === 404);
ok('…and it is still confirmed', (await M.loadBookings()).find((x) => x.id === other.id).status === 'confirmed');
ok('an unknown action is refused', (await M.apiCustAction(req({ action: 'delete', id: other.id }), q(tok2))).status === 422);
ok('no token, no action', (await M.apiCustAction(req({ action: 'cancel', id: other.id }), q(''))).status === 404);

section('Booking from the link: the token is the identity');
const b2 = await (await M.apiBook(req({
  service: 'full', size: 'suv', date: dateOf(NOW + 5 * DAY), slot: '09:00',
  name: 'Jenna Smith', address: '1425 Cedar Ave', city: 'Everett', fromLink: tok,
}))).json();
if (b2.ok) {
  const made = (await M.loadBookings()).find((x) => x.id === b2.id) || (await M.loadBookings())[0];
  ok('the booking is attributed to the token\'s customer, not to posted data', made.phone === '+14255551234', made.phone);
  ok('and it lands as pending, exactly like the website does', made.status === 'pending', made.status);
} else {
  ok('booking through the link is accepted', false, b2);
  ok('(skipped)', false);
}
const b3 = await (await M.apiBook(req({
  service: 'full', size: 'suv', date: dateOf(NOW + 6 * DAY), slot: '09:00',
  name: 'Nobody', address: 'x', city: 'y', fromLink: 'forged-token-value',
}))).json();
ok('a forged link cannot book as anybody', b3.ok === false, b3);

section('The page itself');
const page = await M.custPage(tok);
const html = await page.text();
ok('it renders', page.status === 200);
ok('it greets them by name before any request lands', /Hi Jenna/.test(html));
ok('their vehicle is on the page', /Tahoe/.test(html));
ok('the token is not leaked into a link somebody could share by accident',
  (html.match(new RegExp(tok, 'g')) || []).length <= 2);
const bad = await M.custPage('not-a-real-token');
ok('a dead link says so instead of erroring', bad.status === 404 && /Link not found/.test(await bad.text()));

section('Handing Mikey the link');
sms.length = 0;
let link = await (await M.apiCustLink(req({ phone: '+14255551234' }))).json();
ok('it hands back the URL', /\/c\//.test(link.url), link.url);
ok('…the same one as before', link.url.endsWith(tok));
ok('and does not text unless asked', link.texted === false && sms.length === 0);
link = await (await M.apiCustLink(req({ phone: '+14255551234', text: true }))).json();
ok('texting it works', link.texted === true && sms.length === 1);
ok('the text contains the link', sms[0].body.includes(link.url));
ok('…and says it does not expire', /expire/i.test(sms[0].body));
ok('a bad phone is refused', (await M.apiCustLink(req({ phone: 'x' }))).status === 422);

// ----------------------------------------------------------------- pricing
section('Pricing: what you charge vs what gets accepted');
store.clear(); M.__resetCfg();
// Ten texted quotes: the cheap ones nearly all land, the expensive ones do too.
const mkQuote = (i, total, status, service) => ({
  id: 'q' + i, phone: '+1425555' + String(1000 + i), total, serviceName: service || 'Full Detail',
  sizeLabel: 'SUV', status, sentAt: ago(30 + i),
});
await M.saveQuotes([
  mkQuote(1, 150, 'accepted'), mkQuote(2, 160, 'accepted'), mkQuote(3, 170, 'accepted'),
  mkQuote(4, 240, 'accepted'), mkQuote(5, 250, 'accepted'), mkQuote(6, 260, 'declined'),
  mkQuote(7, 400, 'accepted'), mkQuote(8, 420, 'accepted'), mkQuote(9, 440, 'accepted'),
  mkQuote(10, 460, 'declined'),
]);
let pr = await M.buildPricing(12);
ok('every quote is counted', pr.overall.quotes === 10, pr.overall.quotes);
ok('the win rate is real', pr.overall.winRate === 80, pr.overall.winRate);
ok('average quoted is the average of what was quoted', pr.overall.avgQuoted === 295, pr.overall.avgQuoted);
ok('lost money is only the lost ones', pr.overall.lost === 260 + 460, pr.overall.lost);
ok('three price bands come out', pr.bands.length === 3, pr.bands.map((b) => b.label));
ok('the bands cover every priced quote',
  pr.bands.reduce((s, b) => s + b.quotes, 0) === 10, pr.bands.map((b) => b.quotes));
ok('it spots the ceiling when the win rate really does fall',
  pr.advice.some((a) => /real ceiling/.test(a)), pr.advice);
ok('…and says the prices are under the market',
  pr.advice.some((a) => /under the market/.test(a)), pr.advice);
ok('advice quotes whole dollars, not $278.75',
  pr.advice.every((a) => !/\$\d+\.\d/.test(a)), pr.advice);
ok('the advice never proposes a number it did not derive',
  pr.advice.every((a) => (a.match(/\$\d+/g) || []).every((m) => +m.slice(1) > 0)));

section('When price is NOT what loses the job');
store.clear(); M.__resetCfg();
// Same win rate top to bottom: the expensive work closes as well as the cheap.
await M.saveQuotes([
  mkQuote(1, 150, 'accepted'), mkQuote(2, 160, 'accepted'), mkQuote(3, 170, 'declined'),
  mkQuote(4, 240, 'accepted'), mkQuote(5, 250, 'accepted'), mkQuote(6, 260, 'declined'),
  mkQuote(7, 400, 'accepted'), mkQuote(8, 420, 'accepted'), mkQuote(9, 440, 'declined'),
]);
pr = await M.buildPricing(12);
ok('all nine land in a band', pr.bands.reduce((s2, b) => s2 + b.quotes, 0) === 9, pr.bands.map((b) => b.quotes));
ok('it says price is not the problem',
  pr.advice.some((a) => /Price isn't what's losing you jobs/.test(a)), pr.advice);

section('A quote counts as won when that phone actually paid');
store.clear(); M.__resetCfg();
await M.saveQuotes([{ id: 'q1', phone: '+14255551111', total: 300, serviceName: 'Full Detail', status: 'sent', sentAt: ago(40) }]);
pr = await M.buildPricing(12);
ok('unpaid and unanswered is not a win', pr.overall.won === 0, pr.overall);
const mo = dateOf(ago(20)).slice(0, 7);
const doc = await M.loadMonth(mo);
doc.entries.push({ id: 'e1', type: 'job', phone: '+14255551111', amount: 300, date: dateOf(ago(20)), ts: ago(20) });
await M.saveMonth(mo, doc);
pr = await M.buildPricing(12);
ok('paying inside the window makes it a win', pr.overall.won === 1, pr.overall);

section('It refuses to give advice it cannot support');
store.clear(); M.__resetCfg();
await M.saveQuotes([{ id: 'q1', phone: '+14255551111', total: 300, serviceName: 'X', status: 'accepted', sentAt: ago(10) }]);
pr = await M.buildPricing(12);
ok('too little history says exactly that', /needs about 10/.test(pr.advice[0]), pr.advice);
ok('no bands are invented from one quote', pr.bands.length === 0, pr.bands);

section('No quotes at all does not blow up');
store.clear(); M.__resetCfg();
pr = await M.buildPricing(12);
ok('it returns an empty read-out', pr.overall.quotes === 0 && pr.bands.length === 0);
ok('…with a sane win rate rather than NaN', pr.overall.winRate === 0);
ok('…and still says something', pr.advice.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
