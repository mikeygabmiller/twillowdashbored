// Gift cards, driven the way Mikey sells one at the end of a text thread in
// December: find it from search, sell a card, mark it paid, take part of it off
// a job, find another by the number off the paper, and put a card's link in the
// buyer's text box. The /api/gifts calls are answered by the REAL worker code
// (lifted out of src/index.js), so the screens and the server agree on shape.
//
// The one thing this suite exists to catch: nothing here sends a text.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function lift(name) {
  const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found`);
  let p = SRC.indexOf('(', m.index), pd = 0, b = -1;
  for (let j = p; j < SRC.length; j++) { if (SRC[j] === '(') pd++; else if (SRC[j] === ')') { pd--; if (!pd) { b = SRC.indexOf('{', j); break; } } }
  let d = 0;
  for (let j = b; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) return SRC.slice(m.index, j + 1); } }
  throw new Error('end of ' + name);
}
const constant = (decl) => SRC.match(new RegExp(`^const ${decl}[^\\n]*$`, 'm'))[0];
const STORE = new Map(), MONTHS = {};
const ctx = {
  kv: () => ({ async get(k, o) { const v = STORE.get(k); return v == null ? null : o && o.type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { STORE.set(k, v); } }),
  json: (o, status) => ({ __json: o, status: status || 200 }),
  readJson: async (r) => r.__body,
  loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
  localDateStr: (ts, z) => new Date(ts).toLocaleDateString('en-CA', { timeZone: z || 'America/Los_Angeles' }),
  loadMonth: async (m) => (MONTHS[m] = MONTHS[m] || { entries: [] }),
  saveMonth: async (m, d) => { MONTHS[m] = d; },
  money2: (n) => Math.round(Number(n) * 100) / 100,
  jdMoney: (n) => Math.round((Number(n) || 0) * 100) / 100,
  jdStr: (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200),
  jdEsc: (s) => String(s == null ? '' : s),
  jdToken: (() => { let n = 0; return () => 'tok' + (++n) + 'abcdefghijklmnop'; })(),
  genId: (() => { let n = 0; return () => 'g' + (++n); })(),
  normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; },
  publicBase: () => 'https://texting.test',
};
const G = new Function(...Object.keys(ctx), [
  constant('MONEY_TYPES'), constant('MONEY_CATS'), constant('GIFT_KEY'), constant('GIFT_ALPHA'), constant('GIFT_MAX'),
  constant('GIFT_MIN_AMOUNT'), constant('GIFT_MAX_AMOUNT'), constant('GIFT_METHODS'),
  ...['sanitizeMoneyEntry', 'loadGifts', 'saveGifts', 'giftCode', 'giftNorm', 'giftSpent', 'giftBalance', 'giftState', 'giftView',
    'giftTotals', 'apiGifts', 'giftLogMoney', 'apiGiftsPost'].map(lift),
].join('\n\n') + '\nreturn { apiGifts, apiGiftsPost };')(...Object.values(ctx));

// One card already sold and paid, so "Use a gift card" has something to find.
const seeded = (await G.apiGiftsPost({ __body: { action: 'create', amount: 249, to: 'Dave', buyerName: 'Ann', paid: true, method: 'cash' } })).__json.card;

const thread = {
  phone: '+14255551234', name: 'Linda Park', tags: [], status: 'active', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'Do you do gift cards? Want one for my daughter', ts: Date.now() - 60000 }],
  scheduled: [], linked: [], notes: '',
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [], posts = [], sends = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('popup', (p) => p.close().catch(() => {}));

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname; const method = route.request().method();
  const json = (o, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/gifts' && method === 'POST') {
    const b = JSON.parse(route.request().postData() || '{}'); posts.push(b);
    const r = await G.apiGiftsPost({ __body: b }); return json(r.__json, r.status);
  }
  if (p === '/api/gifts') { const r = await G.apiGifts(); return json(r.__json); }
  if (p === '/api/send' || p === '/api/pay/request' || p === '/api/schedule') { sends.push(p); return json({ ok: true }); }
  if (p === '/api/pay') return json({ ok: true, config: { venmo: 'Mikey-Miller' }, invoices: [], outstanding: 0, openCount: 0 });
  if (p === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: thread.messages[0].body, lastTs: Date.now(), tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p === '/api/day') return json({ ok: true, date: '2026-12-01', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const shot = async (n) => { if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/' + n + '.png' }); };
const sheet = () => page.locator('#jdSheet');

section('Finding it');
await page.locator('#search').fill('gift');
await page.waitForTimeout(300);
const hits = await page.locator('.fx-row').allInnerTexts();
ok('search offers Gift cards', hits.some((t) => /Gift cards/.test(t)), hits);
ok('...and Use a gift card', hits.some((t) => /Use a gift card/.test(t)), hits);
await page.locator('.fx-row', { hasText: 'Gift cards' }).first().click();
await page.waitForTimeout(1200);
ok('it opens Get Paid', (await page.locator('#jdTitle').textContent()) === 'Get Paid');
const secTxt = await page.locator('#jdBody').innerText();
ok('the Gift cards section is there', /GIFT CARDS/i.test(secTxt), secTxt.slice(0, 300));
ok('it shows what is still on cards', /\$249\s*still on 1 card/.test(secTxt), secTxt);
ok('the sold card is listed with its number', secTxt.includes(seeded.code));
await shot('1-section');

section('Selling one that isn\'t paid yet');
await page.locator('#gcSell').click();
await page.waitForTimeout(500);
ok('the sell sheet opens', /Sell a gift card/.test(await sheet().innerText()));
ok('it says SUVs pay the difference', /SUV, pickup or van pays the difference/.test(await sheet().innerText()));
await page.locator('[data-gcamt="369"]').click();
ok('tapping Full detail fills $369', (await page.locator('#gcAmt').inputValue()) === '369');
await page.locator('#gcTo').fill('Emma');
await page.locator('#gcFrom').fill('Mom');
await page.locator('#gcMsg').fill('For the Jetta. Love you!');
await page.locator('#gcBuyer').fill('Linda Park');
await page.locator('#gcPhone').fill('(425) 555-1234');
await shot('2-sell');
await page.locator('#gcGo').click();
await page.waitForTimeout(700);
let last = posts.at(-1);
ok('it asks the server to make a $369 card', last.action === 'create' && last.amount === 369 && last.to === 'Emma', last);
ok('not paid, so nothing goes into Money', last.paid === false && last.logMoney === false, last);
let txt = await sheet().innerText();
ok('the card opens straight after', /\$369 gift card for Emma/.test(txt), txt.slice(0, 200));
ok('it says it isn\'t paid yet', /not paid yet/.test(txt));
ok('it offers Mark paid', await sheet().locator('[data-gca="paid"]').count() === 1);
ok('it offers a payment request to the buyer', await sheet().locator('[data-gca="payreq"]').count() === 1);
ok('it cannot be used before it is paid', await sheet().locator('[data-gca="use"]').count() === 0);
await shot('3-made');

section('Marking it paid');
await sheet().locator('[data-gca="paid"]').click();
await page.waitForTimeout(400);
await sheet().locator('[data-gcm="venmo"]').click();
await sheet().locator('#gcPaidGo').click();
await page.waitForTimeout(700);
last = posts.at(-1);
ok('paid by Venmo, logged in Money', last.action === 'paid' && last.method === 'venmo' && last.logMoney === true, last);
ok('the money entry was written as a gift sale', Object.values(MONTHS).flatMap((m) => m.entries).some((e) => e.gift === 1 && e.amount === 369 && e.method === 'venmo'));
txt = await sheet().innerText();
ok('the card is live now', /active/.test(txt) && await sheet().locator('[data-gca="use"]').count() === 1, txt.slice(0, 240));
ok('it says it is logged in Money', /Logged in Money as income/.test(txt));
ok('the pay method reads like a word', /by Venmo/.test(txt), txt.slice(0, 240));

section('Taking some of it off a job');
await sheet().locator('[data-gca="use"]').click();
await page.waitForTimeout(400);
ok('the whole balance is offered', (await page.locator('#grAmt').inputValue()) === '369');
await page.locator('#grAmt').fill('500');
await page.waitForTimeout(150);
ok('more than is left is flagged as you type', /more than the \$369 left/.test(await page.locator('#grOwe').innerText()));
const before = posts.length;
await sheet().locator('#grGo').click();
await page.waitForTimeout(300);
ok('...and never sent to the server', posts.length === before);
await page.locator('#grAmt').fill('100');
await page.waitForTimeout(150);
ok('what stays on the card is spelled out', /\$269 stays on the card/.test(await page.locator('#grOwe').innerText()));
await page.locator('#grNote').fill('Interior, Sat Dec 12');
await sheet().locator('#grGo').click();
await page.waitForTimeout(700);
last = posts.at(-1);
ok('$100 is used', last.action === 'redeem' && last.amount === 100, last);
txt = await sheet().innerText();
ok('$269 left shows on the card', /\$269 left/.test(txt), txt.slice(0, 200));
ok('the use is listed with its note', /Interior, Sat Dec 12/.test(txt));
await shot('4-used');

section('Finding a card by the number off the paper');
await page.mouse.click(200, 30);
await page.waitForTimeout(300);
await page.locator('#gcUse').click();
await page.waitForTimeout(400);
const messy = seeded.code.toLowerCase().replace('-', ' ');
await page.locator('#gfCode').fill(messy);
await page.waitForTimeout(250);
ok('it finds the card typed lower case with a space', new RegExp('For Dave').test(await page.locator('#gfHit').innerText()), await page.locator('#gfHit').innerText());
await page.locator('#gfGo').click();
await page.waitForTimeout(400);
ok('it goes straight to taking it off a job', /Take .* off a job/.test(await sheet().innerText()));
await page.mouse.click(200, 30);
await page.waitForTimeout(300);
await page.locator('#gcUse').click();
await page.waitForTimeout(300);
await page.locator('#gfCode').fill('ZZZZ-ZZZZ');
await page.waitForTimeout(200);
ok('a number that isn\'t a card says so', /No card with that number/.test(await page.locator('#gfHit').innerText()));
await page.locator('#gfCode').fill('dav');
await page.waitForTimeout(250);
ok('a lost card is found by the name on it', /For Dave/.test(await page.locator('#gfHit').innerText()) && await page.locator('[data-gfpick]').count() === 1, await page.locator('#gfHit').innerText());
await page.locator('#gfCode').fill('ann');
await page.waitForTimeout(250);
ok('...or by who bought it', /bought by Ann/.test(await page.locator('#gfHit').innerText()), await page.locator('#gfHit').innerText());
await page.locator('[data-gfpick]').first().click();
await page.waitForTimeout(400);
ok('tapping it opens that card', /\$249 gift card for Dave/.test(await sheet().innerText()));
await page.mouse.click(200, 30);
await page.waitForTimeout(300);

section('Selling from a conversation, and the link only goes in the box');
await page.locator('#jdBack').click();
await page.waitForTimeout(400);
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(500);
await page.locator('.conv').first().click();
await page.waitForTimeout(900);
await page.locator('#toolsBtn').click();
await page.waitForTimeout(400);
ok('Tools lists Sell a gift card', /Sell a gift card/.test(await page.locator('#toolsSheet').innerText()));
await page.locator('#toolsSheet [data-act="gift"]').click();
await page.waitForTimeout(500);
ok('the buyer is filled in from the conversation', (await page.locator('#gcBuyer').inputValue()) === 'Linda Park', await page.locator('#gcBuyer').inputValue());
ok('...with their phone', (await page.locator('#gcPhone').inputValue()) === '(425) 555-1234', await page.locator('#gcPhone').inputValue());
await page.locator('[data-gcamt="100"]').click();
await page.locator('#gcTo').fill('Emma');
await page.locator('[data-gcpaid="1"]').click();
await page.waitForTimeout(150);
ok('Paid already shows how they paid', await page.locator('#gcPaidMore').isVisible());
await page.locator('#gcGo').click();
await page.waitForTimeout(700);
last = posts.at(-1);
ok('paid at the counter, logged', last.paid === true && last.method === 'cash' && last.logMoney === true, last);
await sheet().locator('[data-gca="text"]').click();
await page.waitForTimeout(800);
const box = await page.locator('#msgInput').inputValue();
ok('the link is written into the box', /gift card for Emma is on this link/.test(box) && /https:\/\/texting\.test\/g\/tok/.test(box), box);
ok('it greets the buyer by first name', /^Here you go, Linda!/.test(box), box);
ok('no em dash in it (keeps the text one GSM-7 segment)', !/—/.test(box));
await shot('5-box');

section('Nothing was ever sent');
ok('no text, no scheduled send, no payment request went out', sends.length === 0, sends);
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
