// Gift cards (Get Paid → Gift cards, and the public card at /g/<token>).
// What has to hold, in the order it could go wrong for a real customer:
//   · a card nobody paid for can't be spent, and its page shows no number
//   · paying switches it on, and logs the money ONCE, as income but not a job
//   · spending it can't go past the balance, and undo puts it back
//   · a cancelled card says so; only a never-paid card can be deleted
//   · Washington's terms are on the card (no expiry, no fees, cash under $5)
//   · nothing they typed can break out of the page
//   · nothing in here ever texts anyone
//
//   node test/gift.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found in src/index.js`);
  const start = m.index;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
const constant = (decl) => {
  const m = SRC.match(new RegExp(`^const ${decl}[^\\n]*$`, 'm'));
  if (!m) throw new Error(`const ${decl} not found`);
  return m[0];
};

const STORE = new Map();
const KV = {
  async get(k, opt) { const v = STORE.get(k); if (v == null) return null; return opt && opt.type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { STORE.set(k, v); },
};
const MONTHS = {};
let SMS = 0;
const ctx = {
  kv: () => KV,
  json: (o, status) => ({ __json: o, status: status || 200 }),
  readJson: async (r) => r.__body,
  loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
  localDateStr: (ts, z) => new Date(ts).toLocaleDateString('en-CA', { timeZone: z || 'America/Los_Angeles' }),
  loadMonth: async (m) => (MONTHS[m] = MONTHS[m] || { entries: [] }),
  saveMonth: async (m, d) => { MONTHS[m] = d; },
  money2: (n) => Math.round(Number(n) * 100) / 100,
  jdMoney: (n) => Math.round((Number(n) || 0) * 100) / 100,
  jdStr: (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200),
  jdEsc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  jdToken: (() => { let n = 0; return () => 'tok' + (++n) + 'xxxxxxxxxxxxxxxx'; })(),
  genId: (() => { let n = 0; return () => 'g' + (++n); })(),
  normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; },
  publicBase: () => 'https://texting.test',
  sendSms: async () => { SMS++; },
  Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.headers = (init && init.headers) || {}; } },
};
const CODE = [
  constant('MONEY_TYPES'), constant('MONEY_CATS'),
  constant('GIFT_KEY'), constant('GIFT_ALPHA'), constant('GIFT_MAX'), constant('GIFT_MIN_AMOUNT'), constant('GIFT_MAX_AMOUNT'), constant('GIFT_METHODS'),
  lift('sanitizeMoneyEntry'), lift('summarizeMonth'), lift('summarizeWeek'),
  lift('loadGifts'), lift('saveGifts'), lift('giftCode'), lift('giftNorm'), lift('giftSpent'), lift('giftBalance'),
  lift('giftState'), lift('giftView'), lift('giftTotals'), lift('apiGifts'), lift('giftLogMoney'), lift('apiGiftsPost'),
  lift('giftPage'), lift('giftShell'),
].join('\n\n');
const G = new Function(...Object.keys(ctx), CODE + `
  return { giftCode, giftNorm, giftBalance, giftState, apiGifts, apiGiftsPost, giftPage, summarizeMonth, summarizeWeek, sanitizeMoneyEntry };`)(...Object.values(ctx));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const post = async (body) => G.apiGiftsPost({ __body: body });
const allEntries = () => Object.values(MONTHS).flatMap((m) => m.entries);

section('Card numbers');
const codes = new Set();
let shapeOk = true;
for (let i = 0; i < 400; i++) {
  const c = G.giftCode([...codes].map((code) => ({ code })));
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/.test(c)) shapeOk = false;
  codes.add(c);
}
ok('every number is ABCD-EFGH from the no-lookalikes alphabet', shapeOk);
ok('400 in a row, no repeats', codes.size === 400, codes.size);
ok('no I, L, O, 0 or 1 ever appears', ![...codes].some((c) => /[ILO01]/.test(c)));
ok('typing it lower case with spaces still finds it', G.giftNorm('abcd efgh') === 'ABCDEFGH');
ok('a number that happens to spell CARD is left alone', G.giftNorm('CARD-7XQM') === 'CARD7XQM', G.giftNorm('CARD-7XQM'));
ok('"Card number: ABCD-EFGH" pasted whole still finds it', G.giftNorm('Card number: ABCD-EFGH') === 'ABCDEFGH', G.giftNorm('Card number: ABCD-EFGH'));

section('Selling one that isn\'t paid for yet');
let r = await post({ action: 'create', amount: 369, to: 'Sarah', from: 'Mom & Dad', message: 'Merry Christmas', buyerName: 'Linda Park', buyerPhone: '(425) 555-0144' });
let card = r.__json.card;
ok('it is made', r.__json.ok && card && card.code, r.__json);
ok('it starts unpaid', card.state === 'unpaid', card.state);
ok('the whole amount is on it', card.balance === 369);
ok('the buyer\'s phone is normalized', card.buyer.phone === '+14255550144', card.buyer);
ok('nothing logged in Money yet', allEntries().length === 0);
ok('its link is the public /g/ page', card.url === 'https://texting.test/g/' + card.token, card.url);
let page = await G.giftPage(card.token);
ok('the page says it switches on once paid', /switches on as soon as it's paid/.test(page.body));
ok('the page shows no card number before it is paid', !page.body.includes(card.code));
ok('the page is kept out of search engines', page.headers['X-Robots-Tag'] === 'noindex' && /noindex/.test(page.body));
r = await post({ action: 'redeem', id: card.id, amount: 50 });
ok('an unpaid card cannot be spent', r.status === 409 && r.__json.error === 'unpaid', r);

section('Paying switches it on and logs the money once');
r = await post({ action: 'paid', id: card.id, method: 'venmo', logMoney: true });
card = r.__json.card;
ok('it is active', card.state === 'active', card.state);
ok('it remembers how it was paid', card.method === 'venmo');
let entries = allEntries();
ok('one income entry in Money', entries.length === 1, entries);
const e = entries[0];
ok('it is the card amount', e.amount === 369);
ok('it says Gift card and which one', e.service === 'Gift card' && e.note.includes(card.code) && e.note.includes('Sarah'), e);
ok('it is flagged as a gift sale', e.gift === 1);
ok('the card points at its money entry', card.moneyId === e.id);
r = await post({ action: 'paid', id: card.id, method: 'cash', logMoney: true });
ok('marking it paid again is harmless', r.__json.already === true && allEntries().length === 1, allEntries().length);
const s = G.summarizeMonth(allEntries().concat([{ type: 'job', amount: 409, date: e.date }]));
ok('a gift sale counts toward gross', s.gross === 778, s);
ok('...but not toward the job count', s.jobs === 1, s);
const w = G.summarizeWeek(allEntries(), '2000-01-01', '2100-01-01');
ok('same in the weekly numbers', w.jobs === 0 && w.gross === 369, w);
ok('a gift flag on an expense is dropped', !G.sanitizeMoneyEntry({ type: 'exp', amount: 5, date: '2026-10-02', gift: 1 }).gift);

page = await G.giftPage(card.token);
ok('the page now shows the card number', page.body.includes(card.code));
ok('...the amount', page.body.includes('$369'));
ok('...who it is for and from', page.body.includes('Sarah') && page.body.includes('Mom &amp; Dad'));
ok('...and how to use it, with the phone number', /text me at \(425\) 600-7897 with the card number/.test(page.body));
ok('Washington terms: never expires, no fees', /Never expires, no fees/.test(page.body));
ok('Washington terms: the rest stays on it, under $5 in cash', /rest stays on it/.test(page.body) && /under \$5 is yours in cash/.test(page.body));
ok('it can be printed', /window\.print\(\)/.test(page.body) && /@media print/.test(page.body));
ok('a link preview names it', /og:title" content="A \$369 gift card for Sarah"/.test(page.body));
ok('no em dashes in what the customer reads', !/—/.test(page.body));

section('Spending it');
r = await post({ action: 'redeem', code: card.code.toLowerCase().replace('-', ' '), amount: 100, note: 'Interior, Sat', phone: '4255550199' });
card = r.__json.card;
ok('found by the number as typed', r.__json.ok, r.__json);
ok('$269 left', card.balance === 269, card.balance);
ok('the use is recorded with its note', card.redemptions.length === 1 && card.redemptions[0].note === 'Interior, Sat');
page = await G.giftPage(card.token);
ok('the page shows what\'s left', page.body.includes('$269 left on this card'));
r = await post({ action: 'redeem', id: card.id, amount: 300 });
ok('more than the balance is refused, with the balance', r.status === 422 && r.__json.error === 'over_balance' && r.__json.balance === 269, r);
r = await post({ action: 'redeem', id: card.id, amount: 0 });
ok('zero is refused', r.status === 422);
r = await post({ action: 'redeem', id: card.id, amount: 269 });
card = r.__json.card;
ok('using the rest uses it up', card.state === 'used' && card.balance === 0, card);
page = await G.giftPage(card.token);
ok('a used-up card says so', /All used/.test(page.body));
r = await post({ action: 'redeem', id: card.id, amount: 1 });
ok('a used-up card cannot be spent', r.status === 409 && r.__json.error === 'used');
r = await post({ action: 'undo', id: card.id, rid: card.redemptions[1].id });
card = r.__json.card;
ok('undo puts it back and the card is live again', card.state === 'active' && card.balance === 269, card);
ok('spending never logs money or texts anyone', allEntries().length === 1 && SMS === 0);

section('Totals');
let g = await G.apiGifts();
ok('outstanding is what is still on live cards', g.__json.totals.outstanding === 269, g.__json.totals);
ok('sold this year counts the paid card', g.__json.totals.soldYear === 369 && g.__json.totals.soldYearCount === 1, g.__json.totals);

section('Cancelling and deleting');
r = await post({ action: 'delete', id: card.id });
ok('a paid card cannot be deleted', r.status === 409 && r.__json.error === 'not_deletable');
r = await post({ action: 'void', id: card.id });
ok('it can be cancelled', r.__json.card.state === 'void');
page = await G.giftPage(card.token);
ok('a cancelled card\'s page says it isn\'t active', /isn't active/.test(page.body) && !page.body.includes(card.code));
r = await post({ action: 'redeem', id: card.id, amount: 5 });
ok('a cancelled card cannot be spent', r.status === 409 && r.__json.error === 'void');
r = await post({ action: 'paid', id: card.id });
ok('a cancelled card cannot be marked paid', r.status === 409);
g = await G.apiGifts();
ok('cancelled money is not outstanding', g.__json.totals.outstanding === 0, g.__json.totals);
r = await post({ action: 'create', amount: 50, to: 'Typo' });
const typo = r.__json.card;
r = await post({ action: 'delete', id: typo.id });
ok('a never-paid card can be deleted', r.__json.deleted === true);
g = await G.apiGifts();
ok('...and it is gone', !g.__json.cards.some((c) => c.id === typo.id));

section('Paid at the counter, no money entry');
r = await post({ action: 'create', amount: 100, to: 'Jo', paid: true, method: 'cash', logMoney: false });
ok('it is live straight away', r.__json.card.state === 'active' && r.__json.card.method === 'cash');
ok('no money entry when he said no', allEntries().length === 1);
r = await post({ action: 'create', amount: 199, paid: true, method: 'nonsense', logMoney: true });
ok('an unknown pay method is stored as other, and not written into Money', r.__json.card.method === 'other' && !allEntries().at(-1).method, allEntries().at(-1));

section('Limits and nonsense');
ok('under $5 is refused', (await post({ action: 'create', amount: 4 })).status === 422);
ok('over $2,000 is refused', (await post({ action: 'create', amount: 2001 })).status === 422);
ok('an unknown card is not found', (await post({ action: 'redeem', code: 'ZZZZ-ZZZZ', amount: 5 })).status === 404);
ok('an unknown action is refused', (await post({ action: 'explode', id: r.__json.card.id })).status === 422);
page = await G.giftPage('nope');
ok('an unknown link is a 404 that says it isn\'t active', page.status === 404 && /isn't active/.test(page.body));

section('Nothing they typed can break the page');
r = await post({ action: 'create', amount: 60, to: '<script>alert(1)</script>', from: '"><img src=x onerror=alert(1)>', message: '</style><b>hi</b>', paid: true, method: 'cash' });
page = await G.giftPage(r.__json.card.token);
ok('no raw script tag', !page.body.includes('<script>alert(1)'));
ok('no raw img tag', !page.body.includes('<img src=x'));
ok('no early </style>', page.body.indexOf('</style>') === page.body.lastIndexOf('</style>'));
ok('the text is still there, escaped', page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

section('Edits');
r = await post({ action: 'edit', id: r.__json.card.id, to: 'Sam', message: 'Happy birthday', buyerPhone: '425 555 0100' });
ok('names, message and phone change', r.__json.card.to === 'Sam' && r.__json.card.message === 'Happy birthday' && r.__json.card.buyer.phone === '+14255550100', r.__json.card);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
