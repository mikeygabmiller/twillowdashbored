// Payment requests: line items, the receipt page, and the deliberately short text.
import fs from 'fs';
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['payDefaults', 'loadPayConfig', 'apiPaySaveConfig', 'apiPayRequest', 'payPage',
  'loadInvoices', 'saveInvoices', 'apiPayAction', 'apiPay'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
const sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.twilio.com')) { const p = new URLSearchParams(String(opts.body)); sms.push({ to: p.get('To'), body: p.get('Body') }); return { ok: true, json: async () => ({ sid: 'SM' + sms.length }) }; }
  if (url.includes('api.resend.com')) return { ok: true, json: async () => ({}) };
  return { ok: false, status: 404, text: async () => 'no' };
};

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ CFG_CACHE = null; }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897',
  MIKEY_PHONE: '+13607975831', PUBLIC_BASE_URL: 'https://pay.example.com',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b });

section('Setup — every payment method is his to configure');
let r = await (await M.apiPaySaveConfig(req({
  venmo: '@Mikey-Miller', cashapp: '$mikeysdetailing', paypal: 'mikeysdetailing',
  zelle: '360-555-0123', link: 'https://buy.stripe.com/abc', linkLabel: 'Card / Apple Pay',
  cash: true, cashLabel: 'Cash when I finish', businessName: "Mikey's Mobile Detailing",
  tagline: 'Mobile detailing — I come to you', terms: 'Thanks for the business!',
  depositPct: 25, remindDays: 3,
  extras: [{ label: 'Apple Cash', detail: '360-555-0123' }, { label: '', detail: 'dropped' }],
}))).json();
ok('config saves', r.ok === true);
ok('Venmo @ stripped for the link', r.config.venmo === 'Mikey-Miller');
ok('Cash App $ stripped', r.config.cashapp === 'mikeysdetailing');
ok('custom cash wording kept', r.config.cashLabel === 'Cash when I finish');
ok('business name kept', r.config.businessName === "Mikey's Mobile Detailing");
ok('extra payment methods kept', r.config.extras.length === 1 && r.config.extras[0].label === 'Apple Cash', r.config.extras);
ok('a blank extra is dropped', !r.config.extras.some((x) => !x.label));
let bad = await (await M.apiPaySaveConfig(req({ link: 'javascript:alert(1)' }))).json();
ok('a non-http card link is refused', bad.config.link === '', bad.config.link);
await M.apiPaySaveConfig(req({ link: 'https://buy.stripe.com/abc', venmo: 'Mikey-Miller', cashapp: 'mikeysdetailing', paypal: 'mikeysdetailing', zelle: '360-555-0123', cash: true, cashLabel: 'Cash when I finish', businessName: "Mikey's Mobile Detailing", tagline: 'Mobile detailing — I come to you', terms: 'Thanks for the business!', depositPct: 25, remindDays: 3, extras: [{ label: 'Apple Cash', detail: '360-555-0123' }] }));

section('Sending a request');
sms.length = 0;
r = await (await M.apiPayRequest(req({
  phone: '4255551234', name: 'Jenna Smith',
  items: [{ name: 'Full Detail — in & out', price: 339 }, { name: 'Pet hair removal', price: 60 }],
  memo: 'Full Detail — in & out',
}))).json();
ok('request created', r.ok === true);
ok('total added up from the line items', r.invoice.amount === 399, r.invoice.amount);
ok('line items stored', r.invoice.items.length === 2 && r.invoice.items[0].price === 339);
ok('one text went out', sms.length === 1, sms);
ok('…to the customer', sms[0].to === '+14255551234');
ok('…containing the link', /https:\/\/pay\.example\.com\/p\/[a-zA-Z0-9_-]+/.test(sms[0].body), sms[0].body);
const GSM7 = /^[@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-.\/0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà\n\r\f^{}\\\[~\]|€]*$/;
const oneSegment = (b) => GSM7.test(b) ? b.length <= 160 : b.length <= 70;
ok('the text fits in ONE Twilio segment', oneSegment(sms[0].body), { len: sms[0].body.length, gsm7: GSM7.test(sms[0].body), body: sms[0].body });
ok('…and just explains what the link is', /breakdown and every way to pay/i.test(sms[0].body), sms[0].body);
ok('…without repeating the total', !/399/.test(sms[0].body), sms[0].body);
const token = r.invoice.token;

section('An explicit amount still wins over the items');
r = await (await M.apiPayRequest(req({ phone: '4255551234', amount: 100, items: [{ name: 'Detail', price: 339 }], send: false }))).json();
ok('typed amount used', r.invoice.amount === 100, r.invoice.amount);
r = await (await M.apiPayRequest(req({ phone: '4255551234', send: false }))).json();
ok('no amount and no items is refused', r.ok === false && r.error === 'bad_amount');
r = await (await M.apiPayRequest(req({ phone: 'nope', amount: 50, send: false }))).json();
ok('a junk phone is refused', r.ok === false && r.error === 'bad_phone');

section('The customer page reads like a receipt');
let html = await (await M.payPage(token)).text();
ok('shows the total', html.includes('$399'));
ok('lists the first line item', html.includes('Full Detail — in &amp; out') || html.includes('Full Detail — in & out'), html.match(/Full Detail[^<]*/));
ok('lists the second', html.includes('Pet hair removal'));
ok('shows each line price', html.includes('$339') && html.includes('$60'));
ok('labels the breakdown', /What this is for/.test(html));
ok('has a Total row', /class="li tot"/.test(html));
ok('Venmo button carries the amount', /venmo\.com\/Mikey-Miller\?txn=pay&(amp;)?amount=399/.test(html), html.match(/venmo[^"]*/));
ok('Cash App button carries the amount', /cash\.app\/\$mikeysdetailing\/399/.test(html));
ok('PayPal button carries the amount', /paypal\.me\/mikeysdetailing\/399/.test(html));
ok('card link present', html.includes('https://buy.stripe.com/abc'));
ok('Zelle shown as a handle, not a fake link', html.includes('360-555-0123'));
ok('his custom cash wording used', html.includes('Cash when I finish'));
ok('his extra method shown', html.includes('Apple Cash'));
ok('business name in the header', html.includes("Mikey&#39;s Mobile Detailing") || html.includes("Mikey's Mobile Detailing"));
ok('tagline shown', html.includes('I come to you'));
ok('footer note shown', html.includes('Thanks for the business!'));

section('Deposits');
sms.length = 0;
r = await (await M.apiPayRequest(req({
  phone: '4255559999', name: 'Rob', deposit: true, amount: 85,
  items: [{ name: 'Full Detail', price: 339 }], memo: 'Full Detail',
}))).json();
ok('deposit request created', r.ok === true && r.invoice.kind === 'deposit');
ok('deposit amount is what was asked for', r.invoice.amount === 85, r.invoice.amount);
html = await (await M.payPage(r.invoice.token)).text();
ok('page says Deposit', /Deposit/.test(html));
ok('…shows what the full job is', html.includes('Full Detail'));
ok('…and what is due now', /Due now/.test(html) && html.includes('$85'));
ok('deposit text is one segment too', oneSegment(sms[0].body), { len: sms[0].body.length, gsm7: GSM7.test(sms[0].body), body: sms[0].body });
ok('…and says it holds the spot', /hold your spot/i.test(sms[0].body), sms[0].body);

section('Paid and dead links');
r = await (await M.apiPayAction(req({ id: (await M.loadInvoices()).find((i) => i.token === token).id, action: 'paid', method: 'venmo' }))).json();
ok('marking paid works', r.ok === true);
html = await (await M.payPage(token)).text();
ok('page flips to Paid', /Paid ✓/.test(html));
ok('…still shows the breakdown as a record', html.includes('Pet hair removal'));
const gone = await M.payPage('nope-not-a-token');
ok('an unknown token 404s', gone.status === 404);
ok('…with a human explanation', (await gone.text()).includes('no longer active'));

section('No payment methods configured yet');
store.delete('pay:config');
M.__resetCfg();
await M.apiPaySaveConfig(req({ cash: false }));
r = await (await M.apiPayRequest(req({ phone: '4255551234', amount: 50, send: false }))).json();
html = await (await M.payPage(r.invoice.token)).text();
ok('page tells them to text instead of showing nothing', /Text Mikey for payment details/.test(html));

section('XSS on the customer page');
await M.apiPaySaveConfig(req({ businessName: '<img src=x onerror=alert(1)>', terms: '<script>alert(2)</script>', cash: true }));
r = await (await M.apiPayRequest(req({ phone: '4255551234', amount: 50, items: [{ name: '<b>bold</b>', price: 50 }], send: false }))).json();
html = await (await M.payPage(r.invoice.token)).text();
ok('business name escaped', !/<img src=x/.test(html));
ok('line item escaped', !/<b>bold<\/b>/.test(html));
ok('footer escaped', !/<script>alert\(2\)/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
