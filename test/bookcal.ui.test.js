// Bookings → Settings → "Put bookings on my Google Calendar": he can copy the
// script with his key in it, paste the link Google gives him, connect, and put
// the bookings he already has on the calendar, with a plain answer each time.
//
//   node test/bookcal.ui.test.js
import fs from 'fs';
import { chromium } from 'playwright-core';

const HTML = fs.readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const M = new Function('__env__', src + '\n; ENV = __env__; return { bookingDefaults };')({ MESSAGES: { get: async () => null } });
const CFG = JSON.parse(JSON.stringify(M.bookingDefaults()));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
const page = await ctx.newPage();
// A headless browser won't grant the real clipboard, so the copy lands here.
await page.addInitScript(() => { window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
let connected = false; const posts = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname; const m = route.request().method();
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/bookings.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/bookings') return json({ ok: true, bookings: [] });
  if (p === '/api/booking-settings') return json({ ok: true, config: CFG });
  if (p === '/api/gcal-setup' && m === 'GET') return json({ ok: true, connected, url: '', script: "var KEY = 'abc123';\nfunction doPost(e){}" });
  if (p === '/api/gcal-setup') {
    const b = JSON.parse(route.request().postData() || '{}'); posts.push(b);
    if (!/\/exec$/.test(b.url)) return json({ ok: false, error: 'That isn\'t a web app link.' });
    connected = true; return json({ ok: true, connected: true, calendar: 'Mikey Miller' });
  }
  if (p === '/api/gcal-sync-all') return json({ ok: true, added: 2, failed: 0 });
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://x.test/bookings.html');
await page.click('.mbtn[data-m="settings"]');
await page.waitForSelector('#gcalCopy');

console.log('\nIt says what it does and that it is not set up');
const box = await page.textContent('#settingsView');
ok('the section is there', /Put bookings on my Google Calendar/.test(box));
ok('it promises the reminders he asked for', /a week, 3 days, a day/.test(box));
ok('it says not connected', /Not connected yet/.test(await page.textContent('#gcalState')));
ok('the steps name Execute as Me and Anyone', /Execute as: Me/.test(box) && /Who has access: Anyone/.test(box));
ok('the "add my bookings" button waits for a connection', !(await page.isVisible('#gcalSync')));

console.log('\nCopy, connect, add');
await page.click('#gcalCopy');
await page.waitForFunction(() => /Copied/.test(document.querySelector('#gcalCopied').textContent));
ok('copy puts the script with his key on the clipboard', /var KEY = 'abc123'/.test(await page.evaluate(() => window.__copied)));
await page.fill('#gcalUrl', 'https://example.com/nope');
await page.click('#gcalConnect');
await page.waitForFunction(() => /✕/.test(document.querySelector('#gcalResult').textContent));
ok('a wrong link gets the reason in words', /web app link/.test(await page.textContent('#gcalResult')));
await page.fill('#gcalUrl', 'https://script.google.com/macros/s/AKfy/exec');
await page.click('#gcalConnect');
await page.waitForFunction(() => /Connected to/.test(document.querySelector('#gcalResult').textContent));
ok('connect names his calendar', /Mikey Miller/.test(await page.textContent('#gcalResult')));
ok('the state line turns green', /✓ Connected/.test(await page.textContent('#gcalState')));
ok('it sent the link he pasted', posts.length === 2 && posts[1].url === 'https://script.google.com/macros/s/AKfy/exec', posts);
ok('now the add button shows', await page.isVisible('#gcalSync'));
await page.click('#gcalSync');
await page.waitForFunction(() => /on your calendar/.test(document.querySelector('#gcalResult').textContent));
ok('it says how many went on', /2 bookings on your calendar/.test(await page.textContent('#gcalResult')));
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
