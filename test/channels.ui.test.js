// Insights → Channels, the way Mikey reads it on a Sunday night: open it from
// search, see which channel brought paying customers and what each one cost,
// tag the lead nobody knows the source of, split an old marketing expense, and
// change the window. Plus the Money side: a marketing expense now asks which
// kind, so new spend lands in a channel without a trip back here.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), day = 864e5;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const DATA = (days) => ({
  ok: true, days, startDate: '2026-07-04', today,
  totals: { leads: 9, customers: 4, revenue: 1596, spend: 545, perCustomer: 136.25 },
  channels: [
    { id: 'google_ads', label: 'Google Ads', leads: 4, customers: 2, revenue: 818, spend: 220, paid: true, perLead: 55, perCustomer: 110, back: 3.72 },
    { id: 'hanger', label: 'Door hangers', leads: 2, customers: 1, revenue: 369, spend: 240, paid: true, perLead: 120, perCustomer: 240, back: 1.54 },
    { id: 'search', label: 'Google search & Maps', leads: 1, customers: 1, revenue: 409, spend: 0, paid: false, perLead: 0, perCustomer: 0, back: 0 },
    { id: 'sign', label: 'Yard signs', leads: 1, customers: 0, revenue: 0, spend: 0, paid: true, perLead: 0, perCustomer: 0, back: 0 },
    { id: 'unknown', label: 'Not sure yet', leads: 1, customers: 0, revenue: 0, spend: 0, paid: false, perLead: 0, perCustomer: 0, back: 0 },
  ],
  unknown: [{ phone: '+14255550107', name: 'Una Known', at: now - day, status: 'new', rev: 0 }], unknownCount: 1,
  unsplit: [{ id: 'e6', date: today, amount: 85, note: 'Vistaprint', sub: '' }], unsplitTotal: 85,
  choices: [['google_ads', 'Google Ads'], ['meta_ads', 'Facebook & Instagram ads'], ['hanger', 'Door hangers'], ['sign', 'Yard signs'], ['postcard', 'Postcards'], ['referral', 'Word of mouth']],
  subs: ['Google Ads', 'Facebook ads', 'Door hangers', 'Yard signs', 'Postcards', 'Business cards', 'Other'],
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [], posts = [], gets = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/channels' && route.request().method() === 'POST') { posts.push(JSON.parse(route.request().postData() || '{}')); return json({ ok: true }); }
  if (p === '/api/channels') { gets.push(+u.searchParams.get('days')); return json(DATA(+u.searchParams.get('days'))); }
  if (p === '/api/money/entry') { posts.push({ money: JSON.parse(route.request().postData() || '{}') }); return json({ ok: true, entry: {}, month: today.slice(0, 7), summary: {} }); }
  if (p === '/api/money') return json({ ok: true, month: today.slice(0, 7), today, entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const shot = async (n) => { if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/' + n + '.png', fullPage: false }); };

section('Finding it');
await page.locator('#search').fill('cost per customer');
await page.waitForTimeout(300);
const hits = await page.locator('.fx-row').allInnerTexts();
ok('search finds Channels', hits.some((t) => /Channels/.test(t)), hits);
await page.locator('#search').fill('marketing spend');
await page.waitForTimeout(300);
await page.locator('.fx-row', { hasText: 'Channels' }).first().click();
await page.waitForTimeout(1200);
ok('Channels is open', (await page.$eval('#grTitle', (n) => n.textContent.trim())) === 'Channels');
ok('it asked for 90 days first', gets[0] === 90, gets);
await shot('1-open');

section('Reading it');
const txt = await page.locator('#grBody').innerText();
ok('the headline: spent, leads, paid, cost per paying customer', /\$545[\s\S]*Spent on marketing/i.test(txt) && /\$136[\s\S]*Cost per paying customer/i.test(txt), txt.slice(0, 300));
const names = await page.locator('.ch-row .ch-name').allInnerTexts();
ok('channels in the order the server ranked them', names.join('|') === 'Google Ads|Door hangers|Google search & Maps|Yard signs|Not sure yet', names);
const ads = await page.locator('.ch-row').first().innerText();
ok('Google Ads says what one paying customer cost', /\$110 per paying customer/.test(ads), ads);
ok('...and what came back per $100', /\$372 back per \$100/.test(ads), ads);
ok('a free channel says Free', /Free/.test(await page.locator('.ch-row').nth(2).innerText()));
ok('each row leads with who paid and what they paid', /^2 paid · \$818/.test(await page.locator('.ch-row .ch-money').first().innerText()));
ok('Not sure yet points at the fix, not "Free"', /Say where these came from/.test(await page.locator('.ch-row.dim').innerText()));
ok('a paid channel with nothing logged says so, not $0', /No spend logged for this yet/.test(await page.locator('.ch-row').nth(3).innerText()));
const widths = await page.$$eval('.ch-bar i', (ns) => ns.map((n) => n.style.width));
ok('bars are scaled to the biggest channel', widths[0] === '100%' && widths[1] === '50%', widths);
ok('Not sure yet is dimmed', await page.locator('.ch-row.dim').count() === 1);

section('Fixing what it can\'t tell');
ok('the unknown lead is listed by name', /Una Known/.test(txt));
await page.locator('[data-chorigin="+14255550107"]').selectOption('sign');
await page.waitForTimeout(500);
let last = posts.at(-1);
ok('picking Yard signs saves the lead\'s source', last && last.action === 'origin' && last.phone === '+14255550107' && last.ch === 'sign', last);
ok('the unsplit $85 is listed', /\$85[\s\S]*Vistaprint/.test(await page.locator('#grBody').innerText()));
await page.locator('[data-chspend="e6"]').selectOption('Postcards');
await page.waitForTimeout(500);
last = posts.at(-1);
ok('picking Postcards splits that expense', last && last.action === 'spend' && last.id === 'e6' && last.sub === 'Postcards' && last.date === today, last);
ok('each fix reloads the report', gets.length >= 3, gets);

section('Changing the window');
await page.locator('[data-chr="365"]').click();
await page.waitForTimeout(700);
ok('12 months asks for 365 days', gets.at(-1) === 365, gets);
ok('the pill lights', (await page.locator('.qv-range.on').innerText()) === '12 months');
await shot('2-year');

section('Insights index');
await page.locator('#grBack').click();
await page.waitForTimeout(400);
ok('Channels has a card on the index', await page.locator('.ix-card[data-ix="channels"]').count() === 1);

section('Money asks which kind of marketing');
await page.locator('#grBack').click();
await page.waitForTimeout(400);
await page.locator('#search').fill('money tracker');
await page.waitForTimeout(300);
await page.locator('.fx-row', { hasText: 'Money tracker' }).first().click();
await page.waitForTimeout(900);
await page.locator('[data-mo="marketing"]').first().click();
await page.waitForTimeout(600);
const chips = await page.locator('#moSubChips [data-sub]').allInnerTexts();
ok('the marketing expense sheet offers the channels', chips.join('|') === 'Google Ads|Facebook ads|Door hangers|Yard signs|Postcards|Business cards|Other', chips);
await shot('3-money');

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
