// The payment composer, driven from inside a conversation — the "on the fly"
// path that matters: open a chat, tap Tools, type an amount, send.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
let config = { venmo: 'Mikey-Miller', cashapp: 'mikeysdetailing', paypal: '', zelle: '360-555-0123',
  link: '', linkLabel: 'Card / Apple Pay', cash: true, cashLabel: 'Cash in person',
  businessName: "Mikey's Mobile Detailing", tagline: '', terms: 'Thanks!', depositPct: 25, remindDays: 3, extras: [] };
const posts = [];
const thread = {
  phone: '+14255551234', name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: Date.now() - 60000 }],
  scheduled: [], linked: [], notes: '',
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/pay' ) return json({ ok: true, config, invoices: [], outstanding: 0, openCount: 0 });
  if (path === '/api/pay/config') { const b = JSON.parse(route.request().postData() || '{}'); posts.push({ cfg: b }); config = Object.assign({}, config, b); return json({ ok: true, config }); }
  if (path === '/api/pay/request') { const b = JSON.parse(route.request().postData() || '{}'); posts.push({ req: b }); return json({ ok: true, invoice: { id: 'i1', token: 'tok', amount: b.amount, kind: b.deposit ? 'deposit' : 'invoice' }, texted: true, config }); }
  if (path === '/api/threads') {
    // The app opens a conversation through the COMBINED endpoint: the list and
    // the thread come back together when ?phone= is present.
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: 'sounds good', lastTs: Date.now(), tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path === '/api/day') return json({ ok: true, date: '2026-07-28', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('Reaching it from a conversation');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(600);
await page.locator('.conv').first().click();
await page.waitForTimeout(900);
await page.locator('#toolsBtn').click();
await page.waitForTimeout(500);
const toolsTxt = await page.locator('#toolsSheet').innerText();
ok('Tools lists it by name', /Send a payment request/i.test(toolsTxt), toolsTxt.slice(0, 200));

await page.locator('#toolsSheet [data-act="pay"]').click();
await page.waitForTimeout(700);
ok('composer opens straight from the conversation', await page.locator('#payPop').isVisible());
ok('customer name prefilled', (await page.locator('#ppName').inputValue()).includes('Jenna'));
ok('phone prefilled', (await page.locator('#ppPhone').inputValue()) === '+14255551234');
ok('one line ready to type into', await page.locator('.pp-n').count() === 1);

section('Building the breakdown');
await page.locator('.pp-p').first().fill('240');
await page.waitForTimeout(300);
ok('total updates as you type', (await page.locator('#ppTot').textContent()) === '$240', await page.locator('#ppTot').textContent());
await page.locator('#ppAdd').click();
await page.waitForTimeout(300);
await page.locator('.pp-n').nth(1).fill('Pet hair removal');
await page.locator('.pp-p').nth(1).fill('60');
await page.waitForTimeout(300);
ok('adding a line adds to the total', (await page.locator('#ppTot').textContent()) === '$300');
await page.locator('.pp-line').nth(1).locator('.pp-x').click();
await page.waitForTimeout(300);
ok('removing a line takes it back off', (await page.locator('#ppTot').textContent()) === '$240');

section('Deposit mode');
await page.locator('[data-k="deposit"]').click();
await page.waitForTimeout(300);
ok('deposit shows 25% of the total', (await page.locator('#ppTot').textContent()) === '$60', await page.locator('#ppTot').textContent());
ok('…and the label changes to "Due now"', (await page.locator('.pp-tot span').textContent()).toLowerCase().includes('due now'));
await page.locator('[data-k="invoice"]').click();
await page.waitForTimeout(300);
ok('back to the full amount', (await page.locator('#ppTot').textContent()) === '$240');

section('Sending');
await page.locator('.pp-n').first().fill('Interior Detail');
await page.locator('#ppSend').click();
await page.waitForTimeout(800);
const sent = posts.filter((p) => p.req).pop();
ok('request posted', !!sent);
ok('…with the phone', sent.req.phone === '+14255551234');
ok('…the total', sent.req.amount === 240, sent.req.amount);
ok('…and the line items for the receipt', sent.req.items.length === 1 && sent.req.items[0].name === 'Interior Detail', sent.req.items);
ok('no custom text sent, so the short default is used', sent.req.body === undefined, sent.req.body);
ok('composer closes after sending', !(await page.locator('#payPop').isVisible()));

section('Guards');
await page.locator('#toolsBtn').click(); await page.waitForTimeout(400);
await page.locator('#toolsSheet [data-act="pay"]').click(); await page.waitForTimeout(600);
await page.locator('#ppPhone').fill('');
await page.locator('#ppSend').click();
await page.waitForTimeout(500);
ok('refuses to send with no phone', await page.locator('#payPop').isVisible());
await page.locator('#ppPhone').fill('+14255551234');
await page.locator('.pp-p').first().fill('0');
await page.locator('#ppSend').click();
await page.waitForTimeout(500);
ok('refuses to send with no amount', await page.locator('#payPop').isVisible());
await page.locator('#ppCancel').click();
await page.waitForTimeout(400);
ok('cancel closes it', !(await page.locator('#payPop').isVisible()));

section('Setup from the menu');
// The menu button is hidden while a conversation is open on a phone — leave the
// conversation the way a real user would before reaching for it.
await page.locator('#backBtn').click();
await page.waitForTimeout(600);
await page.locator('#menuBtn').click();
await page.waitForTimeout(500);
ok('menu has a Payment setup entry', await page.locator('#paySetupItem').count() === 1);
await page.locator('#paySetupItem').click();
await page.waitForTimeout(800);
ok('setup opens', await page.locator('#payPop').isVisible());
ok('existing Venmo shown', (await page.locator('#pcVenmo').inputValue()) === 'Mikey-Miller');
ok('business name editable', await page.locator('#pcBiz').count() === 1);
ok('cash wording editable', await page.locator('#pcCashLabel').count() === 1);
await page.locator('#ppAddExtra').click();
await page.waitForTimeout(400);
ok('can add another way to pay', await page.locator('.pp-xl').count() === 1);
await page.locator('.pp-xl').first().fill('Apple Cash');
await page.locator('.pp-xd').first().fill('360-555-0123');
await page.locator('#pcBiz').fill("Mikey's Detailing");
await page.locator('#pcSave').click();
await page.waitForTimeout(800);
const saved = posts.filter((p) => p.cfg).pop();
ok('settings posted', !!saved);
ok('…including the extra method', saved.cfg.extras.length === 1 && saved.cfg.extras[0].label === 'Apple Cash', saved.cfg.extras);
ok('…and the business name', saved.cfg.businessName === "Mikey's Detailing");
ok('setup closes on save', !(await page.locator('#payPop').isVisible()));

console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
