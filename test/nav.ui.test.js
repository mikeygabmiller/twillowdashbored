// The navigation stack — the phone's back gesture must close the top layer
// instead of dropping out of the app. Driven in a real browser because this is
// entirely about history behaviour, which no unit test can observe.
//
// The case worth guarding hardest is the menu one: the drawer closes itself
// *before* opening a screen ("closeDrawer(); openJobs()"), and history.back()
// is async, so a naive one-entry-per-layer stack desyncs right there.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
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
  if (path === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: 'sounds good', lastTs: Date.now(), tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/money') {
    return json({ ok: true, month: '2026-07', today: '2026-07-30', entries: [], nudges: [], owed: [],
      summary: { net: 0, gross: 0, costs: 0, jobs: 0 }, config: {} });
  }
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
const back = async () => { await page.goBack(); await page.waitForTimeout(450); };
const nav = () => page.evaluate(() => window.__nav());
const depth = async () => (await nav()).depth;
const shown = (sel) => page.locator(sel).isVisible();

section('A conversation is a layer you can back out of');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(500);
await page.locator('.conv').first().click();
await page.waitForTimeout(700);
ok('conversation opened', await page.evaluate(() => document.body.classList.contains('viewing')));
await back();
ok('back returned to the list', !(await page.evaluate(() => document.body.classList.contains('viewing'))));
ok('still inside the app', await shown('.sidebar'));

section('Money opens and backs out');
await page.locator('.navitem[data-tab="money"]').click();
await page.waitForTimeout(700);
ok('money opened', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) === 'flex');
await back();
ok('back closed money', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) === 'none');

section('Analytics opens and backs out');
// Analytics is reached by name now, not from the nav bar.
await page.locator('#search').fill('analytics');
await page.waitForTimeout(300);
await page.locator('#search').press('Enter');
await page.waitForTimeout(700);
ok('analytics opened', await page.locator('#growApp').evaluate((e) => e.classList.contains('show')));
await back();
ok('back closed analytics', !(await page.locator('#growApp').evaluate((e) => e.classList.contains('show'))));

section('The menu race: drawer closes itself, then opens a screen');
await page.locator('#menuBtn').click();
await page.waitForTimeout(400);
ok('drawer opened', await page.locator('#drawer').evaluate((e) => e.classList.contains('open')));
// Expand the group only if it is collapsed — "work" ships open, so an
// unconditional click would close it.
if (!(await page.locator('.dgrp[data-grp="work"]').evaluate((e) => e.classList.contains('open')))) {
  await page.locator('.dgrp[data-grp="work"] .dgh').click();
  await page.waitForTimeout(300);
}
await page.locator('#runItem').click();
await page.waitForTimeout(700);
ok('drawer closed', !(await page.locator('#drawer').evaluate((e) => e.classList.contains('open'))));
ok('jobs opened', await page.locator('#jdApp').evaluate((e) => e.classList.contains('show')));
await back();
ok('one back closed jobs (no desync)', !(await page.locator('#jdApp').evaluate((e) => e.classList.contains('show'))));
ok('and did NOT leave the app', await shown('.sidebar'));
ok('nothing left layered', (await depth()) === 0);

section('Bookkeeping agrees with the browser');
// The bug this guards: the stack thinking a sentinel is armed while the real
// history entry says otherwise, which makes the NEXT back press leave the app.
const agrees = () => page.evaluate(() => {
  const armed = !!(history.state && history.state.navGuard);
  return window.__nav().sentinel === armed;
});
ok('agrees while idle', await agrees());
await page.locator('#menuBtn').click(); await page.waitForTimeout(350);
ok('agrees with the drawer open', await agrees());
await page.locator('#runItem').click(); await page.waitForTimeout(700);
ok('agrees after close-then-open in one tap', await agrees(), await nav());
await back();
ok('agrees after backing out', await agrees(), await nav());

section('Escape closes the top layer too');
await page.locator('.navitem[data-tab="money"]').click();
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
ok('escape closed money', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) === 'none');

section('Back on a root tab is not trapped');
const beforeUrl = page.url();
ok('sitting on a root tab', (await depth()) === 0);
ok('app still alive', await shown('.sidebar'), beforeUrl);

section('Repeated open/close does not accumulate');
for (let i = 0; i < 3; i++) {
  await page.locator('.navitem[data-tab="money"]').click();
  await page.waitForTimeout(350);
  await page.locator('#moBack').click();
  await page.waitForTimeout(350);
}
ok('money is closed after 3 cycles', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) === 'none');
ok('stack is empty after 3 cycles', (await depth()) === 0);

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
