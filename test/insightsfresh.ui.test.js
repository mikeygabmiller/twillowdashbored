// Hopping back to Today must not re-read every conversation each time.
//
// /api/insights loads EVERY thread from KV, one read each, and Home used to ask
// for it on every visit to the tab. A few hundred conversations times a busy day
// of tab-hopping is a real share of the free tier's 100k reads, and when those
// run out every KV get() throws until midnight UTC (2026-10-21: the login, the
// inbox and inbound texts all down at once). So Home draws from the copy it
// already has and only re-fetches once that copy is two minutes old. Sign-in
// and reopening the app still fetch fresh: those paths are untouched.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

let insights = 0;
await page.route('**/*', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/insights') {
    insights++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, needsReply: [], avgReplyMs: null, byStatus: {}, total: 0 }) });
  }
  if (path.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

const hop = async (tab) => { await page.click(`.navitem[data-tab="${tab}"]`); await page.waitForTimeout(150); };

console.log('\nTab-hopping back to Today');
await page.clock.install();
await page.goto('https://texting.test/');
await page.waitForTimeout(1200);
ok('opening the app fetches insights', insights >= 1, insights);

const start = insights;
for (let i = 0; i < 5; i++) { await hop('messages'); await hop('home'); }
ok('five trips back to Today inside two minutes fetch nothing new', insights === start, { start, now: insights });
ok('and Today is still drawn', (await page.locator('#scroll .home').count()) === 1);

console.log('\nOnce the copy is stale');
await page.clock.fastForward(2 * 60 * 1000 + 5000);
const stale = insights;
await hop('messages'); await hop('home');
ok('the next visit to Today fetches it again', insights === stale + 1, { stale, now: insights });
await hop('messages'); await hop('home');
ok('and the one after that does not', insights === stale + 1, { stale, now: insights });

ok('no page errors', errs.length === 0, errs.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
