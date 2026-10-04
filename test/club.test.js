// The Clean Club, sold on a call (2026-10-03).
//
// Mikey texts the call page (mikeysdetailing.com/onbored) while he's on the
// phone. Joining makes the first visit a Full Detail at $270 off ($99 for a
// clean sedan, Mikey 2026-10-04), then $125 a visit every 4 or 8 weeks, and they
// keep their next 3 club visits or pay back $90 for each one skipped, on a card
// saved with Stripe. These checks hold the
// promises that deal makes: the server sets the price, the words they sign are
// the words stored, the first visit books like any website booking, he gets
// one alert and not two, a card is only "saved" when Stripe says so, and what
// they'd owe on leaving is never more than the $270 they got.
//
//   node test/club.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['apiClubOffer', 'apiClubJoin', 'apiClubState', 'apiClubCard', 'apiClubList', 'apiClubAction',
  'loadClub', 'saveClub', 'clubSite', 'clubTerms', 'stripeForm', 'loadBookings', 'saveBookings', 'loadThread',
  'saveMonth', 'loadIndex', 'apiBook'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const sms = [], alerts = [], stripe = [];
// What the fake Stripe answers. Each test section sets what it needs.
const S = { failSession: false, session: null };
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(opts.body));
    sms.push({ to: p.get('To'), body: p.get('Body') });
    return { ok: true, json: async () => ({ sid: 'SM1' }) };
  }
  if (url.startsWith('https://api.stripe.com/v1/')) {
    const path = url.slice('https://api.stripe.com/v1/'.length);
    const params = new URLSearchParams(opts.method === 'GET' ? (path.split('?')[1] || '') : String(opts.body || ''));
    const call = { method: opts.method, path: path.split('?')[0], params, headers: opts.headers };
    stripe.push(call);
    const ok = (j) => ({ ok: true, json: async () => j });
    if (opts.method === 'POST' && call.path === 'customers') {
      if (S.failCustomer) return { ok: false, status: 403, json: async () => ({ error: { message: 'This key needs Customers: Write' } }) };
      return ok({ id: 'cus_1' });
    }
    if (opts.method === 'POST' && call.path === 'checkout/sessions') {
      if (S.failSession) return { ok: false, status: 400, json: async () => ({ error: { message: 'The provided key does not have the required permissions' } }) };
      return ok({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    if (opts.method === 'GET' && call.path.startsWith('checkout/sessions/')) return ok(S.session);
    if (opts.method === 'POST' && call.path.startsWith('customers/')) return ok({ id: 'cus_1' });
    return { ok: false, status: 404, json: async () => ({ error: { message: 'no such route' } }) };
  }
  return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) };
};

const realNow = Date.now;
let NOW = realNow();
Date.now = () => NOW;
const at = (date, hm) => Date.parse(date + 'T' + hm + ':00Z') + (date >= '2026-11-01' ? 8 : 7) * 3600000;

const env = {
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1', PROMISE_DISABLED: '1',
  RESEND_API_KEY: 're_test', ALERT_EMAIL: 'm@example.com',
};
const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')(env);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const H = (h) => ({ get: (k) => h[k] || h[k.toLowerCase()] || '' });
const req = (b, h) => ({ json: async () => b, method: 'POST', headers: H(h || { 'CF-Connecting-IP': '1.2.3.' + Math.floor(Math.random() * 250) }) });
const get = async (fn, path) => (await fn(new URL('https://x.test' + path))).json();
const post = async (fn, b, h) => { const res = await fn(req(b, h)); return Object.assign({ _status: res.status }, await res.json()); };
const EM = /—|&mdash;/;

NOW = at('2026-10-10', '10:00');                      // a Saturday morning in October

section('The offer: priced on the server, from his own Full Detail price');
let o = await get(M.apiClubOffer, '/api/club/offer?every=28&size=suv&condition=Needs%20Work');
ok('an SUV that needs work: regular $439 ($409 + $30)', o.ok && o.regular === 439, o);
ok('joined, the first visit is $169 ($270 off)', o.price === 169, o);
ok('$125 a visit, keep 3, $90 each', o.visit === 125 && o.keep === 3 && o.per === 90 && o.off === 270, o);
ok('every 4 or every 8 weeks, nothing else', JSON.stringify(o.everyOptions) === '[28,56]', o.everyOptions);
ok('card saving is off until the Stripe key is set', o.card === false, o.card);
const words = o.lines.join(' ');
ok('the terms carry the real numbers', /\$169/.test(words) && /\$270 off my regular \$439/.test(words) && /every 4 weeks/.test(words) && /\$125 a visit/.test(words) && /next 3 club visits/.test(words) && /\$90 for each one you skip, never more than \$270/.test(words), o.lines);
ok('the terms promise a text before any charge', /text you before I charge/.test(words));
ok('the terms say cancelling before the first visit costs nothing', /before your first visit and you owe nothing/.test(words));
ok('no em dash anywhere in the terms', !EM.test(words));
o = await get(M.apiClubOffer, '/api/club/offer?every=56&size=sedan');
ok('a clean sedan every 8 weeks: $369 regular, $99 joined', o.regular === 369 && o.price === 99 && /every 8 weeks/.test(o.lines.join(' ')), o);
o = await get(M.apiClubOffer, '/api/club/offer?every=99&size=boat&condition=Spotless');
ok('junk in falls back to the defaults, never to a made-up price', o.every === 28 && o.size === 'sedan' && o.condition === 'Pretty Clean' && o.price === 99, o);

section('The book wins over a stale saved booking config');
{
  // How production looked on 2026-10-03: Bookings → Settings saved before the
  // price raise, "Match the website" never tapped, Full Detail still $299.
  const stale = { services: [{ id: 'full', name: 'Full Detail', enabled: true, price: { sedan: 299, suv: 339, truck: 379 }, duration: { sedan: 180, suv: 210, truck: 240 } },
    { id: 'interior', name: 'Interior Detail', enabled: true, price: { sedan: 200, suv: 240, truck: 280 }, duration: { sedan: 90, suv: 110, truck: 120 } },
    { id: 'exterior', name: 'Exterior Detail', enabled: true, price: { sedan: 160, suv: 200, truck: 240 }, duration: { sedan: 45, suv: 60, truck: 75 } }] };
  await kv.put('bk:config', JSON.stringify(stale));
  M.__reset();
  const so = await get(M.apiClubOffer, '/api/club/offer?every=28&size=sedan');
  ok('a stale $299 in Settings still quotes the book: $369 regular, $99 joined', so.ok && so.regular === 369 && so.price === 99, so);
  ok('...and the words they would sign say the same', /Full Detail for \$99\. That's \$270 off my regular \$369/.test(so.lines[0]), so.lines[0]);
  const sv = await get(M.apiClubOffer, '/api/club/offer?every=28&size=truck&condition=War%20Zone');
  ok('a war-zone van: $449 + $60 = $509 regular, $239 joined', sv.regular === 509 && sv.price === 239, sv);
  const off = JSON.parse(JSON.stringify(stale)); off.services[0].enabled = false;
  await kv.put('bk:config', JSON.stringify(off));
  M.__reset();
  const so2 = await get(M.apiClubOffer, '/api/club/offer?every=28&size=sedan');
  ok('if he switches Full Details off, there is no club offer to sign', !so2.ok && so2.error === 'no_full_detail', so2);
  store.delete('bk:config');
  M.__reset();
}

section('Where Stripe may send them back to');
ok('the live site is allowed', M.clubSite({ headers: H({ Origin: 'https://mikeysdetailing.com' }) }) === 'https://mikeysdetailing.com');
ok('localhost is allowed for testing', M.clubSite({ headers: H({ Origin: 'http://localhost:8080' }) }) === 'http://localhost:8080');
ok('anywhere else falls back to the live site', M.clubSite({ headers: H({ Origin: 'https://evil.example' }) }) === 'https://mikeysdetailing.com');

section('Joining checks the signature and the deal before it books anything');
const base = {
  every: 28, terms: '2026-10-04', agree: true, signed: 'Sarah Lane', size: 'suv', condition: 'Needs Work',
  vehicle: '2019 Honda Pilot', date: '2026-10-13', slot: '13:00', dateLabel: 'Tue, Oct 13',
  name: 'Sarah Lane', phone: '4255550142', address: '1425 Cedar Ave', city: 'Everett', email: 'sarah@example.com',
  smsConsent: true, page: 'https://mikeysdetailing.com/onbored/',
};
let r = await post(M.apiClubJoin, Object.assign({}, base, { every: 42 }));
ok('every 6 weeks is not on the call page', !r.ok && r.error === 'bad_every' && r._status === 422, r);
r = await post(M.apiClubJoin, Object.assign({}, base, { terms: '2026-01-01' }));
ok('an old copy of the terms is refused, so the page re-reads them', !r.ok && r.error === 'terms_changed' && r._status === 409, r);
r = await post(M.apiClubJoin, Object.assign({}, base, { agree: false }));
ok('no tick, no join', !r.ok && r.error === 'not_signed', r);
r = await post(M.apiClubJoin, Object.assign({}, base, { signed: ' ' }));
ok('no typed name, no join', !r.ok && r.error === 'not_signed', r);
r = await post(M.apiClubJoin, Object.assign({}, base, { size: 'boat' }));
ok('a size that isn\'t on the menu is refused', !r.ok && r.error === 'bad_size', r);
ok('none of those booked anything', (await M.loadBookings()).length === 0 && (await M.loadClub()).length === 0);

section('A sign-up with Stripe not connected yet: books, stores, one alert');
sms.length = 0; alerts.length = 0;
r = await post(M.apiClubJoin, Object.assign({}, base, { estimate: 1, price: 1 }), { 'CF-Connecting-IP': '9.9.9.9', 'User-Agent': 'TestPhone', Origin: 'https://mikeysdetailing.com' });
ok('it joins', r.ok && r.token && r.token.length >= 30, r);
ok('Everett is one of his towns, so the first visit is confirmed', r.status === 'confirmed', r);
ok('no Stripe page to go to', r.card === 'off' && !r.cardUrl, r);
let bk = (await M.loadBookings())[0];
ok('the first visit is a Full Detail on Tue Oct 13 at 1:00', bk.service === 'full' && bk.date === '2026-10-13' && bk.slot === '13:00', bk);
ok('at the server\'s price ($169), not the $1 the page sent', bk.estimate === 169, bk.estimate);
ok('the booking knows it is a club sign-up', bk.club === r.token);
ok('a Full Detail booked in October is Rain-Ready', bk.rainReady === true);
let th = await M.loadThread('+14255550142');
ok('they are on a plan: every 4 weeks, Clean Club, $125', th.plan && th.plan.every === 28 && th.plan.service === 'Clean Club' && th.plan.price === 125, th.plan);
ok('the thread points at the sign-up and is tagged club', th.club && th.club.token === r.token && th.tags.includes('club'), th.club);
ok('his notes on the thread spell out the deal', /CLEAN CLUB/.test(th.notes) && /\$169 \(regular \$439, \$270 off/.test(th.notes) && /keeps the next 3 club visits or pays back \$90 each/.test(th.notes), th.notes);
ok('the customer got the normal confirm text', sms.length === 1 && /Full Detail/.test(sms[0].body), sms);
ok('the reminders are queued like any booking', th.scheduled.filter((x) => x.kind === 'booking').length === 2);
ok('Mikey gets ONE alert, the club one, not a booking alert as well', alerts.length === 1 && /Clean Club sign-up: Sarah Lane/.test(alerts[0].subject), alerts.map((a) => a.subject));
ok('the alert says the card is missing and why', /STRIPE_SECRET_KEY isn't set/.test(alerts[0].text) && /onbored\/\?club=/.test(alerts[0].text), alerts[0] && alerts[0].text);
ok('no em dash in his alert', !EM.test(alerts[0].subject + alerts[0].text));
let club = (await M.loadClub())[0];
ok('the signed agreement is stored: words, name, time, address, phone', club.terms.v === '2026-10-04' && club.terms.signed === 'Sarah Lane' &&
  club.terms.lines.length === 7 && club.terms.ip === '9.9.9.9' && club.terms.ua === 'TestPhone' && club.terms.at === NOW, club.terms);
ok('the stored words are exactly what the offer showed for that car', JSON.stringify(club.terms.lines) ===
  JSON.stringify((await get(M.apiClubOffer, '/api/club/offer?every=28&size=suv&condition=Needs%20Work')).lines));
ok('the deal is stored with it', club.price === 169 && club.regular === 439 && club.off === 270 && club.keep === 3 && club.per === 90 && club.card.status === 'off', club);

section('The customer\'s own link shows what they signed');
let st = await get(M.apiClubState, '/api/club/state?token=' + encodeURIComponent(r.token));
ok('it answers with their first name, the visit and the deal', st.ok && st.club.first === 'Sarah' && st.club.dateLabel === 'Tue, Oct 13' && st.club.time === '1:00 PM' && st.club.price === 169, st);
ok('and the words they signed, with their name', st.club.terms.length === 7 && st.club.signed === 'Sarah Lane');
ok('it does not hand out the phone, the address or the signing details', !('phone' in st.club) && !JSON.stringify(st).includes('Cedar') && !JSON.stringify(st).includes('9.9.9.9'));
st = await get(M.apiClubState, '/api/club/state?token=nope');
ok('a made-up token gets nothing', !st.ok && st.error === 'not_found', st);
r = await post(M.apiClubCard, { token: club.token });
ok('asking for a card page with Stripe off says so', !r.ok && r.error === 'card_off', r);

section('Two people can\'t sign up for the same time');
r = await post(M.apiClubJoin, Object.assign({}, base, { name: 'Late Lou', signed: 'Late Lou', phone: '4255550143' }));
ok('the second is told the slot is gone', !r.ok && r.error === 'slot_taken' && r._status === 409, r);
ok('and no half sign-up is left behind', (await M.loadClub()).length === 1);

section('With Stripe connected: a card page, then saved only when Stripe says so');
env.STRIPE_SECRET_KEY = 'rk_test_abc';
stripe.length = 0; alerts.length = 0;
o = await get(M.apiClubOffer, '/api/club/offer?every=56&size=sedan');
ok('the offer now says a card is part of it, in test mode', o.card === true && o.test === true, o);
r = await post(M.apiClubJoin, Object.assign({}, base, { every: 56, size: 'sedan', condition: 'Pretty Clean', date: '2026-10-14',
  name: 'Dee Park', signed: 'Dee Park', phone: '4255550150', city: 'Snohomish', address: '88 Second St' }), { Origin: 'https://mikeysdetailing.com' });
ok('it joins and hands back Stripe\'s page', r.ok && r.card === 'pending' && r.cardUrl === 'https://checkout.stripe.com/c/pay/cs_test_1', r);
const cus = stripe.find((c) => c.path === 'customers');
ok('a Stripe customer is made with their name and phone', cus && cus.params.get('name') === 'Dee Park' && cus.params.get('phone') === '+14255550150', cus && [...cus.params]);
ok('...once per sign-up, even on a retry (idempotency key)', cus && cus.headers['Idempotency-Key'] === 'club-cus-' + r.token + '-0', cus && cus.headers);
const ses = stripe.find((c) => c.path === 'checkout/sessions');
const sp = ses ? Object.fromEntries(ses.params) : {};
ok('a setup session: save the card, charge nothing, cards only', sp.mode === 'setup' && !('currency' in sp) && sp['payment_method_types[0]'] === 'card' && sp.customer === 'cus_1', sp);
ok('tied to this sign-up', sp.client_reference_id === r.token && sp['metadata[club]'] === r.token, sp);
ok('Stripe sends them back to the call page with the session', sp.success_url === 'https://mikeysdetailing.com/onbored/?club=' + r.token + '&sid={CHECKOUT_SESSION_ID}', sp.success_url);
ok('or back to it if they back out', sp.cancel_url === 'https://mikeysdetailing.com/onbored/?club=' + r.token + '&card=later', sp.cancel_url);
ok('Stripe\'s page says when the card gets charged', /only charged if you cancel before your 3 club visits are done \(\$90 for each one skipped\)/.test(sp['custom_text[submit][message]'] || '') && !EM.test(sp['custom_text[submit][message]'] || ''), sp['custom_text[submit][message]']);
ok('his alert says they are saving it now', alerts.length === 1 && /saving it now/.test(alerts[0].text), alerts.map((a) => a.text));
const dee = r.token;

alerts.length = 0;
S.session = { id: 'cs_test_1', status: 'open', client_reference_id: dee, customer: 'cus_1', setup_intent: { status: 'requires_payment_method', payment_method: null } };
r = await post(M.apiClubCard, { token: dee, sid: 'cs_test_1' });
ok('back without finishing: still pending, nothing saved', r.ok && r.pending && r.card.status === 'pending', r);
S.session = { id: 'cs_test_1', status: 'complete', client_reference_id: 'someone_else', customer: 'cus_1',
  setup_intent: { status: 'succeeded', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } } } };
r = await post(M.apiClubCard, { token: dee, sid: 'cs_test_1' });
ok('a session made for someone else is refused', !r.ok && r.error === 'mismatch', r);
S.session.client_reference_id = dee;
r = await post(M.apiClubCard, { token: dee, sid: 'cs_test_1' });
ok('finished on Stripe: saved, Visa ending 4242', r.ok && r.card.status === 'saved' && r.card.brand === 'Visa' && r.card.last4 === '4242', r);
const getSes = stripe.find((c) => c.method === 'GET');
ok('the answer came from Stripe, with the card details expanded', getSes && getSes.params.get('expand[0]') === 'setup_intent.payment_method', getSes && [...getSes.params]);
ok('the card is made their default in Stripe', stripe.some((c) => c.path === 'customers/cus_1' && c.params.get('invoice_settings[default_payment_method]') === 'pm_1'));
ok('Mikey hears the card is saved, with a link to them in Stripe (test mode)', alerts.length === 1 && /Card saved: Dee Park/.test(alerts[0].subject) &&
  /dashboard\.stripe\.com\/test\/customers\/cus_1/.test(alerts[0].text), alerts.map((a) => a.subject + ' | ' + a.text));
const nAlerts = alerts.length;
r = await post(M.apiClubCard, { token: dee, sid: 'cs_test_1' });
ok('a reload of the return page is fine and doesn\'t alert him twice', r.ok && r.card.status === 'saved' && alerts.length === nAlerts, r);
st = await get(M.apiClubState, '/api/club/state?token=' + dee);
ok('their link shows the card, by brand and last four only', st.club.card.status === 'saved' && st.club.card.last4 === '4242' && !JSON.stringify(st).includes('pm_1') && !JSON.stringify(st).includes('cus_1'), st.club.card);

section('If Stripe won\'t open, they are still booked and he is told what to fix');
S.failSession = true; alerts.length = 0;
r = await post(M.apiClubJoin, Object.assign({}, base, { date: '2026-10-15', name: 'Kim Ro', signed: 'Kim Ro', phone: '4255550160' }));
ok('the sign-up still goes through', r.ok && r.card === 'error' && !r.cardUrl, r);
ok('his alert says Stripe didn\'t open, with Stripe\'s reason', /Stripe didn't open \(The provided key does not have the required permissions\)/.test(alerts[0].text), alerts[0] && alerts[0].text);
S.failSession = false;
const kim = r.token;
ok('the failed try is counted, so the next one uses a new idempotency key', (await M.loadClub()).find((x) => x.token === kim).card.tries === 1);
stripe.length = 0;
r = await post(M.apiClubCard, { token: kim });
ok('once Stripe works, their link makes a fresh card page', r.ok && /checkout\.stripe\.com/.test(r.url), r);
{
  // A key missing the Customers permission fails at the first step. After he
  // fixes it, the retry must not reuse the failed key: Stripe would replay the
  // same error for a day.
  S.failCustomer = true; stripe.length = 0;
  r = await post(M.apiClubJoin, Object.assign({}, base, { date: '2026-10-16', name: 'Ray Tam', signed: 'Ray Tam', phone: '4255550165' }));
  const ray = r.token;
  ok('a failed customer step still signs them up, card marked error', r.ok && r.card === 'error', r);
  ok('the first try used key -0', stripe.filter((x) => x.path === 'customers').map((x) => x.headers['Idempotency-Key']).join() === 'club-cus-' + ray + '-0');
  S.failCustomer = false; stripe.length = 0;
  r = await post(M.apiClubCard, { token: ray });
  ok('the retry works and uses key -1', r.ok && stripe.filter((x) => x.path === 'customers').map((x) => x.headers['Idempotency-Key']).join() === 'club-cus-' + ray + '-1', stripe.map((x) => x.path + ' ' + x.headers['Idempotency-Key']));
  const all = (await M.loadBookings()).filter((b) => b.name !== 'Ray Tam');
  await M.saveBookings(all);
  await M.saveClub((await M.loadClub()).filter((x) => x.token !== ray));
}

section('What a member owes if they leave: never before the first visit, never more than $270');
const view = async (phone) => (await (await M.apiClubList(new URL('https://x.test/api/club?phone=' + phone))).json()).club;
let c = await view('4255550142');
ok('before the first visit: owes nothing', c && c.standing.firstDone === false && c.standing.owed === 0, c && c.standing);
ok('his view links their page and their card status', /onbored\/\?club=/.test(c.link) && c.card.label.status === 'off', c && c.card);
let all = await M.loadBookings();
all.find((b) => b.phone === '+14255550142').status = 'done';
await M.saveBookings(all);
c = await view('4255550142');
ok('first visit done, no club visits yet: all $270', c.standing.firstDone && c.standing.kept === 0 && c.standing.owed === 270, c.standing);
await M.saveMonth('2026-11', { entries: [{ type: 'job', phone: '+14255550142', date: '2026-11-10', amount: 125 }], rec: {} });
await M.saveMonth('2026-10', { entries: [{ type: 'job', phone: '+14255550142', date: '2026-10-13', amount: 169 }], rec: {} });
NOW = at('2026-11-20', '10:00');
c = await view('4255550142');
ok('one club visit in the money log: $180 (two skipped at $90)', c.standing.auto === 1 && c.standing.owed === 180, c.standing);
await M.saveMonth('2026-11', { entries: [{ type: 'job', phone: '+14255550142', date: '2026-11-10', amount: 125 },
  { type: 'job', phone: '+14255550142', date: '2026-11-10', amount: 0 }], rec: {} });
c = await view('4255550142');
ok('the same day logged twice is still one visit', c.standing.auto === 1, c.standing);
r = await (await M.apiClubAction(req({ token: c.token, action: 'kept', kept: 2 }))).json();
ok('his own count wins: 2 visits kept, owes $90', r.ok && r.club.standing.kept === 2 && r.club.standing.owed === 90 && !r.club.standing.done, r.club && r.club.standing);
r = await (await M.apiClubAction(req({ token: c.token, action: 'kept', kept: 3 }))).json();
ok('all 3 kept: owes nothing, free to leave', r.ok && r.club.standing.kept === 3 && r.club.standing.owed === 0 && r.club.standing.done, r.club && r.club.standing);
r = await (await M.apiClubAction(req({ token: c.token, action: 'kept', kept: 9 }))).json();
ok('a count past 3 is held at 3', r.club.standing.kept === 3);
r = await (await M.apiClubAction(req({ token: c.token, action: 'kept', kept: null }))).json();
ok('clearing his count goes back to the records', r.club.standing.kept === 1 && r.club.standing.owed === 180, r.club.standing);
r = await (await M.apiClubAction(req({ token: c.token, action: 'cancel' }))).json();
ok('cancelling writes down the $180 and stops the plan', r.ok && r.club.status === 'cancelled' && r.club.owedAtCancel === 180 && !(await M.loadThread('+14255550142')).plan, r.club);
r = await (await M.apiClubAction(req({ token: c.token, action: 'paid' }))).json();
ok('he can mark the payback charged', r.ok && r.club.paidAt === NOW);
r = await (await M.apiClubAction(req({ token: c.token, action: 'reopen' }))).json();
th = await M.loadThread('+14255550142');
ok('reopening puts them back on the 4-week plan', r.ok && r.club.status === 'active' && th.plan && th.plan.every === 28 && th.plan.service === 'Clean Club', th.plan);
{
  const kimNow = (await M.loadClub()).find((x) => x.token === kim);
  await M.apiClubAction(req({ token: kim, action: 'cancel' }));
  r = await post(M.apiClubCard, { token: kim });
  ok('a cancelled member can\'t be sent a card page', !r.ok && r.error === 'cancelled' && r._status === 409, r);
  await M.apiClubAction(req({ token: kim, action: 'reopen' }));
  ok('(and Kim is back to active for the rest of this)', kimNow && (await M.loadClub()).find((x) => x.token === kim).status === 'active');
}
all = await M.loadBookings();
all.find((b) => b.phone === '+14255550160').status = 'cancelled';
await M.saveBookings(all);
await M.saveMonth('2026-10', { entries: [{ type: 'job', phone: '+14255550160', date: '2026-10-15', amount: 169 }], rec: {} });
c = await view('4255550160');
ok('a first visit that was cancelled owes nothing, whatever the log says', c.standing.firstGone && c.standing.owed === 0, c.standing);
{
  // Someone who signed the launch deal ($150 off, keep 2, $75 each) keeps it:
  // their record carries the numbers they agreed to, not today's.
  const old = { id: 'old1', token: 'OLDtokenOLDtokenOLDtokenOLDtoken1', site: 'https://mikeysdetailing.com', createdAt: at('2026-10-03', '12:00'),
    status: 'active', name: 'Early Bird', phone: '+14255550190', every: 28, size: 'sedan', price: 219, regular: 369,
    off: 150, visit: 125, keep: 2, per: 75, bookingId: 'b-old', date: '2026-10-12', slot: '13:00', terms: { v: '2026-10-03', lines: [] }, card: { status: 'off' }, kept: null };
  await M.saveClub([old].concat(await M.loadClub()));
  const bks = await M.loadBookings();
  bks.unshift({ id: 'b-old', phone: '+14255550190', status: 'done', date: '2026-10-12', slot: '13:00', service: 'full' });
  await M.saveBookings(bks);
  const ov = await view('4255550190');
  ok('a launch-deal member still owes at most their $150, at $75 a visit', ov && ov.standing.owed === 150 && ov.keep === 2 && ov.per === 75, ov && ov.standing);
  await M.saveClub((await M.loadClub()).filter((x) => x.id !== 'old1'));
}
r = await (await M.apiClubAction(req({ token: c.token, action: 'fly' }))).json();
ok('an unknown action is refused', !r.ok && r.error === 'bad_action', r);
const list = await (await M.apiClubList(new URL('https://x.test/api/club'))).json();
ok('his list has all three members, newest first', list.ok && list.members.length === 3 && list.members[0].name === 'Kim Ro', list.members && list.members.map((m) => m.name));

section('Stripe\'s form encoding');
ok('nested objects and arrays become Stripe\'s brackets', M.stripeForm({ a: { b: 1 }, c: ['x', 'y'], d: undefined, e: '' }).toString() === 'a%5Bb%5D=1&c%5B0%5D=x&c%5B1%5D=y');

section('The booking page itself still works the old way');
NOW = at('2026-10-10', '10:00');
alerts.length = 0;
r = await (await M.apiBook(req({ service: 'exterior', size: 'suv', date: '2026-10-16', slot: '13:00', name: 'Plain Jane',
  phone: '4255550170', address: '3 Ash', city: 'Monroe', smsConsent: true, estimate: 239 }))).json();
ok('a website booking books', r.ok && r.status === 'confirmed', r);
ok('and still sends its own booking alert', alerts.length === 1 && /New booking/.test(alerts[0].subject), alerts.map((a) => a.subject));
ok('and is not a club sign-up', !(await M.loadBookings()).find((b) => b.name === 'Plain Jane').club && !(await M.loadThread('+14255550170')).plan);

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
