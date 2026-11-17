// Home, after the Nov 2026 review of what Mikey actually uses:
//   · "Today's money" read $0 made / -$185 for the month while ten booked jobs
//     sat unlogged. It now says how many finished jobs aren't logged, and the
//     tap goes to the Money list that has them.
//   · Money's list words an appointment that went by as "job is done", with
//     "Didn't happen" as the way out (a booking can fall through).
//   · Quick actions no longer repeat the nav (New text = the pencil button,
//     Money = the Money tab); Bookings and Quote builder took their places.
//   · The floating buttons tuck away while scrolling down a list (they sat on
//     top of the "No reply needed" ticks) and come back scrolling up.
//
//   node test/homemoney.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), H = 3600000, DAY = 24 * H;

const rows = [];
for (let i = 0; i < 30; i++) {
  rows.push({ phone: '+1425555' + String(1000 + i), name: 'Customer ' + i, status: 'new', unread: 0, tags: [],
    lastBody: 'when can you come by?', lastDir: 'in', lastTs: now - (i + 1) * H, waitSince: now - (i + 1) * H, awaitingReply: true });
}
const NUDGES = [
  { phone: '+14255550201', name: 'Greg Done', wonAt: now - 2 * DAY, kind: 'appt' },
  { phone: '+14255550202', name: 'Won Will', wonAt: now - 3 * DAY, kind: 'won' },
];
let nudges = NUDGES;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/threads') return json({ ok: true, threads: rows, config: {} });
  if (p === '/api/money') return json({ ok: true, month: '2026-11', today: '2026-11-17', entries: [], nudges, owed: [],
    summary: { gross: 0, exp: 185, net: -185, jobs: 0 }, week: {}, allTime: {}, config: { wonNudge: true, split: { tax: 30, biz: 30, mine: 40 } } });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

await page.goto('https://texting.test/');
await page.waitForTimeout(1800);

section('Today\'s money says the month is missing jobs');
const un = page.locator('.hm-unlogged');
ok('the line is there', await un.count() === 1);
ok('…and counts both', /2 finished jobs/.test(await un.innerText().catch(() => '')), await un.innerText().catch(() => ''));

section('Quick actions don\'t repeat the nav');
const qa = await page.locator('[data-qa]').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-qa')));
ok('no New text, no Money', !qa.includes('new') && !qa.includes('money'), qa);
ok('Bookings and Quote builder are there', qa.includes('bookings') && qa.includes('quote'), qa);

section('The floating buttons get out of the way');
const tucked = () => page.evaluate(() => document.body.classList.contains('fab-tuck'));
ok('on screen at the top', !(await tucked()));
await page.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = 300; s.dispatchEvent(new Event('scroll')); });
await page.waitForTimeout(150);
ok('tucked scrolling down', await tucked());
await page.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = 200; s.dispatchEvent(new Event('scroll')); });
await page.waitForTimeout(150);
ok('back scrolling up', !(await tucked()));

section('Money words a passed appointment as a finished job');
await un.click();
await page.waitForTimeout(1200);
const mn = await page.locator('.mo-nudge').allInnerTexts();
ok('both are listed', mn.length === 2, mn);
ok('the appointment one says the job is done', /Greg Done.*job .*is done/.test(mn.join('|')), mn);
ok('…with "Didn\'t happen" as the way out', /Didn’t happen/.test(mn.find((t) => /Greg/.test(t)) || ''), mn);
ok('the Won one reads as before', /Won Will was marked Won/.test(mn.join('|')) && /Dismiss/.test(mn.find((t) => /Will/.test(t)) || ''), mn);
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
