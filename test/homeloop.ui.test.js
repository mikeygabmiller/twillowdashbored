// Home must never be able to spin.
//
// Three of Home's cards ask for their data while they draw, and Home draws
// again every time any fetch lands. That is fine while every answer is one the
// card recognises — it stores it and stops asking. It is a catastrophe when one
// isn't: the card keeps drawing empty, keeps asking, and the screen turns into
// a fetch/render loop that fired ~240 requests a second, for as long as the
// dashboard was open, on a phone, against a Worker with a request budget.
//
// The shapes that trigger it are not hypothetical. loadCold's own comment names
// one — a rolling deploy answering `ok` from an older Worker that has never
// heard of the endpoint — and the service worker failing to register does it to
// the push nudge on any browser that blocks it.
//
// So this suite answers every single call with a bare `{ok:true}`: every card
// gets an answer it cannot use, which is the worst case, and pins that Home
// still settles. The guard is per-loader and time-based, so the numbers below
// are generous on purpose — they are there to catch a runaway, not to freeze
// today's exact call count.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

const calls = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path.startsWith('/api/')) {
    calls.push(path);
    // The whole point: an answer that is technically fine and useless.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  }
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

console.log('\nEvery card gets an answer it cannot use');
await page.goto('https://texting.test/');
await page.waitForTimeout(1500);

// Count Home's repaints and its requests over a settled window — the first
// second is legitimately busy with the initial load, so measure after it.
await page.evaluate(() => {
  window.__paints = 0;
  new MutationObserver(() => { window.__paints++; }).observe(document.getElementById('scroll'), { childList: true });
});
const before = calls.length;
await page.waitForTimeout(3000);
const during = calls.length - before;
const paints = await page.evaluate(() => window.__paints);

const worst = Object.entries(calls.reduce((m, p) => (m[p] = (m[p] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0];
ok('Home settles instead of repainting itself', paints < 20, paints);
ok('and stops asking for what it cannot use', during < 20, { during, worst });
ok('no single endpoint is being hammered', !worst || worst[1] < 25, worst);
ok('the screen is still drawn, not blank', (await page.locator('#scroll .home').count()) === 1);
ok('no page errors', errs.length === 0, errs.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
