// Search has to find the app's own screens, not just conversations. The point
// is recognition over recall: you think "invoice", the app calls it "Get paid",
// and the keywords bridge that gap. That is what lets screens stay uncluttered
// — a feature you can name in two keystrokes doesn't need to be on display.
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

const type = async (q) => {
  await page.locator('#search').fill(q);
  await page.waitForTimeout(300);
};
const hits = () => page.locator('.fx-row .fx-t').allInnerTexts();
const topHit = async () => (await hits())[0];

section('It finds a feature by what you would call it');
await type('invoice');
ok('"invoice" surfaces Get paid', (await hits()).includes('Get paid'), await hits());
await type('estimate');
ok('"estimate" surfaces Quote builder', (await hits()).includes('Quote builder'), await hits());
await type('tax');
ok('"tax" surfaces the money report', (await hits()).includes('Money report'), await hits());
await type('dark mode');
await type('colour');
ok('"colour" surfaces Customize', (await hits()).includes('Customize everything'), await hits());
await type('traffic');
ok('"traffic" surfaces Website analytics', (await hits()).includes('Website analytics'), await hits());
await type('teach');
ok('"teach" surfaces Train AI', (await hits()).includes('Train AI'), await hits());

section('Ranking puts the obvious answer first');
await type('quote');
ok('"quote" ranks Quote builder top', (await topHit()) === 'Quote builder', await hits());
await type('archiv');
ok('"archiv" ranks Archived top', (await topHit()) === 'Archived', await hits());

section('It does not hijack the conversation search');
await type('status:won');
ok('field filters yield no feature rows', (await page.locator('.fx-row').count()) === 0);
await type('a');
ok('a single letter is not enough to match', (await page.locator('.fx-row').count()) === 0);
await type('Jenna');
ok('a person still reaches the conversation list', (await page.locator('.conv').count()) > 0);

section('Enter runs the top hit');
await type('money tracker');
await page.locator('#search').press('Enter');
await page.waitForTimeout(700);
ok('money opened', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) === 'flex');
ok('search cleared itself', (await page.locator('#search').inputValue()) === '');
await page.locator('#moBack').click();
await page.waitForTimeout(400);

section('Tapping a hit opens it');
await type('garage');
await page.locator('.fx-row').first().click();
await page.waitForTimeout(700);
ok('jobs board opened on the garage', await page.locator('#jdApp').evaluate((e) => e.classList.contains('show')));
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
ok('escape closed it again', !(await page.locator('#jdApp').evaluate((e) => e.classList.contains('show'))));

section('Keyboard shortcuts reach the box');
await page.locator('body').click({ position: { x: 5, y: 400 } });
await page.keyboard.press('/');
await page.waitForTimeout(250);
ok('"/" focused search', await page.evaluate(() => document.activeElement && document.activeElement.id === 'search'));
ok('"/" was not typed into the box', (await page.locator('#search').inputValue()) === '');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
await page.locator('body').click({ position: { x: 5, y: 400 } });
await page.keyboard.press('Control+k');
await page.waitForTimeout(250);
ok('Cmd/Ctrl-K focused search', await page.evaluate(() => document.activeElement && document.activeElement.id === 'search'));

section('An empty box offers somewhere to go');
await page.locator('#search').fill('');
await page.locator('#search').focus();
await page.waitForTimeout(350);
const sugg = await hits();
ok('suggestions shown when empty and focused', sugg.length > 0, sugg);
// textContent, not innerText — the heading is uppercased in CSS.
ok('headed "Jump to"', (await page.locator('.fx-hd').first().textContent()).trim() === 'Jump to');
ok('no false "enter" promise on suggestions', (await page.locator('.fx-row.top').count()) === 0);

section('Recently used bubbles up');
ok('Money tracker remembered from earlier', sugg.includes('Money tracker'), sugg);

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
