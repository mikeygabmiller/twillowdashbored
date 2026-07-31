// The five-tab structure. Six bottom-nav buttons was one over what a thumb
// comfortably reaches, and two of them only looked like tabs — Money and
// Analytics opened overlays without ever lighting their own pill.
//
// Now: Today · Chats · Pipeline · Money · More. Leads, Quotes, the Run, Pay and
// the Garage are stages of one job, so they share the Pipeline board; the
// Chats sub-lists are chips on one filter row instead of separate destinations.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const threads = [
  { phone: '+14255551234', name: 'Jenna Smith', status: 'new', unread: 2, lastBody: 'how much for a Tahoe?', lastTs: Date.now(), tags: [] },
  { phone: '+14255557777', name: 'Rob Diaz', status: 'won', unread: 0, lastBody: 'booked, thanks', lastTs: Date.now() - 900000, tags: [] },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const out = { ok: true, threads, config: {} };
    if (u.searchParams.get('phone')) out.thread = Object.assign({ messages: [], scheduled: [], linked: [], notes: '' }, threads[0]);
    return json(out);
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-07', today: '2026-07-30', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-07-30', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
// Label only — the icon and the badge count are children, so read the bare
// text nodes rather than textContent (which would give "0Today").
const visibleTabs = () => page.$$eval('.navitem', (ns) => ns
  .filter((n) => n.style.display !== 'none')
  .map((n) => Array.from(n.childNodes)
    .filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim()));
const activeTab = () => page.$eval('.navitem.active', (n) => n.getAttribute('data-tab')).catch(() => null);

section('Five destinations, all real');
const tabs = await visibleTabs();
ok('exactly five tabs', tabs.length === 5, tabs);
ok('they are Today/Chats/Pipeline/Money/More',
  JSON.stringify(tabs) === JSON.stringify(['Today', 'Chats', 'Pipeline', 'Money', 'More']), tabs);

section('The nav bar says where you actually are');
ok('starts on Today', (await activeTab()) === 'home');
await page.locator('.navitem[data-tab="pipeline"]').click();
await page.waitForTimeout(700);
ok('Pipeline lights its own pill', (await activeTab()) === 'pipeline');
await page.locator('#jdBack').click();
await page.waitForTimeout(500);
ok('and hands it back on close', (await activeTab()) === 'home');
await page.locator('.navitem[data-tab="money"]').click();
await page.waitForTimeout(700);
ok('Money lights its own pill', (await activeTab()) === 'money');
await page.locator('#moBack').click();
await page.waitForTimeout(500);
ok('and hands it back too', (await activeTab()) === 'home');

section('Pipeline is one flow, lead to garage');
await page.locator('.navitem[data-tab="pipeline"]').click();
await page.waitForTimeout(700);
const segs = await page.$$eval('#jdNav button', (ns) => ns.map((n) => n.textContent.trim()));
ok('five stages in order', JSON.stringify(segs) === JSON.stringify(['Leads', 'Quotes', 'Run', 'Pay', 'Garage']), segs);
await page.locator('#jdNav [data-jv="leads"]').click();
await page.waitForTimeout(600);
ok('the leads board renders inside Pipeline', (await page.locator('#jdBody .lead-card').count()) > 0);
ok('grouped by stage', (await page.locator('#jdBody .lead-col').count()) > 0);

section('Opening a lead leaves the board for the conversation');
await page.locator('#jdBody .lead-card').first().click();
await page.waitForTimeout(800);
ok('board closed', !(await page.locator('#jdApp').evaluate((e) => e.classList.contains('show'))));
ok('conversation opened', await page.evaluate(() => document.body.classList.contains('viewing')));
await page.locator('#backBtn').click();
await page.waitForTimeout(500);

section('Chats sub-lists are chips, not destinations');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(600);
const chips = await page.$$eval('#filters .chip', (ns) => ns.map((n) => n.textContent.replace(/\d+$/, '').trim()));
['Follow-ups', 'Scheduled', 'Archived'].forEach((c) => ok('"' + c + '" is a chip', chips.includes(c), chips));
await page.locator('#filters .chip', { hasText: 'Archived' }).first().click();
await page.waitForTimeout(600);
ok('the Chats pill stays lit on a sub-list', (await activeTab()) === 'messages');
ok('the filter row is still there', await page.locator('#filters').isVisible());

section('More opens the menu');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(500);
ok('menu opened', await page.locator('#drawer').evaluate((e) => e.classList.contains('open')));

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
