// The switch that decides who writes the quote form's first text.
//
// It matters more than a settings row usually does, because the message it
// governs is the one thing the app sends a real customer with nobody having read
// it first. So the test is not "the row renders" — it's: it starts OFF for a
// config that predates it, the tap is what turns it on, and the screen tells him
// the truth about what turning it on means, including the part where the text
// still sits in Scheduled where he can kill it.
//
//   npm install && node test/opener.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];
// Exactly where a config written before this change starts: the key is absent,
// so the switch has to fall to its default rather than to "undefined is truthy".
let config = { followupsEnabled: true };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const configPosts = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') return json({ ok: true, threads: rows, config });
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(body);
      config = Object.assign({}, config, body);
    }
    return json({ ok: true, config });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/ai/usage') return json({ ok: true, days: 14, today: '2026-08-25', total: { calls: 0, in: 0, out: 0, days: 0 }, todayTotal: { calls: 0, in: 0, out: 0 }, bySurface: [] });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const closeSettings = async () => {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#moreApp.show').count())) break;
    await page.locator('#mrBack').click();
    await page.waitForTimeout(300);
  }
};
// The real route in: ☰ → Settings. Reaching the switch through the sheet is the
// only way the test proves it is actually reachable.
const openSettings = async () => {
  await closeSettings();
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(300);
  }
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(400);
  await page.getByText('Settings', { exact: true }).first().click();
  await page.waitForTimeout(500);
};

section('The switch exists, and a config that has never seen it reads OFF');
await openSettings();
ok('the switch is on the settings screen', await page.locator('#cfgSmartOpener').count() === 1);
ok('and it is off', !(await page.locator('#cfgSmartOpener').evaluate((n) => n.classList.contains('on'))));
ok('nothing was saved just by looking at it', configPosts.length === 0, configPosts);

section('It says what it does, in both positions');
const hint = await page.locator('#cfgSmartOpener').evaluateHandle((n) => n.closest('.fu-row').nextElementSibling)
  .then((h) => h.evaluate((n) => n.innerText));
ok('it promises not to re-ask for the car or the name', /never asks for the car or the name they already gave/i.test(hint), hint);
ok('it says the AI half still ends on one question', /one question/i.test(hint), hint);
ok('it says an invented price or day cannot get out', /price you didn't quote/i.test(hint) && /day you haven't agreed to/i.test(hint), hint);
ok('and it says the text waits in Scheduled where he can kill it', /Scheduled/.test(hint) && /edit it, or kill it/.test(hint), hint);

section('Turning it on is his tap, and nothing else');
await page.locator('#cfgSmartOpener').click();
await page.waitForTimeout(500);
ok('the tap saved smartQuoteOpener:true', configPosts.some((p) => p.smartQuoteOpener === true), configPosts);
ok('and it saved nothing else with it', configPosts.every((p) => Object.keys(p).length === 1), configPosts);
await closeSettings();
await openSettings();
ok('it comes back on', await page.locator('#cfgSmartOpener').evaluate((n) => n.classList.contains('on')));

section('…and turning it back off puts the plain text back');
await page.locator('#cfgSmartOpener').click();
await page.waitForTimeout(500);
ok('saved smartQuoteOpener:false', configPosts.some((p) => p.smartQuoteOpener === false), configPosts);
await closeSettings();
await openSettings();
ok('it reads off again', !(await page.locator('#cfgSmartOpener').evaluate((n) => n.classList.contains('on'))));

section('No page errors');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
