// The screen that decides what the app is allowed to spend on its own.
//
// The worker-side gate is pinned in autoai.test.js. This is the other half: that
// the switches are reachable from the phone, that they read OFF for a config
// that has never heard of them, and that flipping one sends the Worker the key
// it actually gates on. A switch that paints itself on without saving is worse
// than no switch, because he'd stop looking.
//
//   node test/autoai.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

// Deliberately his config, not a fresh one: every key it has had for months, and
// no autoAi anywhere in it. The Worker fills the defaults in on the way out, so
// this is what the browser really receives.
let config = { followupsEnabled: true, detect: { enabled: true }, promise: { enabled: true },
  autoAi: { triage: false, appointment: false, promise: false, replyCheck: false,
            draft: false, followupDraft: false, recap: false } };

const configPosts = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(body);
      if (body.autoAi) config = Object.assign({}, config, { autoAi: Object.assign({}, config.autoAi, body.autoAi) });
    }
    return json({ ok: true, config });
  }
  if (path === '/api/threads') return json({ ok: true, threads: [], config });
  if (path === '/api/ai/usage') {
    return json({ ok: true, days: 14, today: '2026-09-21', total: { calls: 0, in: 0, out: 0, days: 14 },
      todayTotal: { calls: 0, in: 0, out: 0 },
      bySurface: [
        { surface: 'reply draft (claude)', calls: 31, in: 90000, out: 8000, errors: 0 },
        { surface: 'inbound triage', calls: 18, in: 40000, out: 3000, errors: 0 },
      ] });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-21', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-21', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

section('He can get to it the way he would actually get to it');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(400);
await page.getByText('Settings', { exact: true }).first().click();
await page.waitForTimeout(500);
ok('the row is on the Settings screen', await page.getByText('AI that runs by itself', { exact: true }).count() >= 1);
ok('and says how much is on without opening it',
  /all off/.test(await page.locator('#autoAiState').textContent()), await page.locator('#autoAiState').textContent());

await page.getByText('AI that runs by itself', { exact: true }).first().click();
await page.waitForTimeout(600);

section('Everything that can spend on its own is on one screen, off');
const rows = page.locator('.aa-row');
ok('all seven are listed', await rows.count() === 7, await rows.count());
ok('none of them is on', await page.locator('.aa-row.on').count() === 0);
ok('the header says so in his words', /Everything here is off/.test(await page.locator('.aa-intro').textContent()),
  await page.locator('.aa-intro').textContent());

section('Each row says what happens with it OFF, which is the actual question');
const body = await page.locator('#mrBody').textContent();
ok('the reply check names its free fallback', /a question means yes/i.test(body));
ok('the follow-up says the nudge still comes', /nudge still comes/i.test(body));
ok('the recap points at the button that replaces it', /Sum it up button/i.test(body));

section('The counters are real, and the Claude half is counted with its surface');
// reply draft's calls are filed as "reply draft (claude)". A row that reads zero
// for the most expensive thing on the list would argue for leaving it on.
ok('the draft row shows its 31 calls', /31 calls in the last 14 days/.test(body), body.slice(0, 400));
ok('inbound triage shows its 18', /18 calls in the last 14 days/.test(body));
ok('one that has never run says so plainly', /No calls in the last 14 days/.test(body));

section('Flipping one saves the key the Worker gates on');
await page.locator('.aa-row[data-aa="appointment"]').click();
await page.waitForTimeout(600);
ok('it posted autoAi.appointment = true',
  configPosts.some((p) => p.autoAi && p.autoAi.appointment === true), configPosts);
ok('and only that key', configPosts.some((p) => p.autoAi && Object.keys(p.autoAi).length === 1), configPosts);
ok('the row now reads on', await page.locator('.aa-row[data-aa="appointment"].on').count() === 1);
ok('and the copy switched to what it does, not what you lose',
  /job card you tap once/i.test(await page.locator('.aa-row[data-aa="appointment"]').textContent()));
ok('the others stayed off', await page.locator('.aa-row.on').count() === 1);

section('And turning it back off saves that too');
await page.locator('.aa-row[data-aa="appointment"]').click();
await page.waitForTimeout(600);
ok('it posted false', configPosts.some((p) => p.autoAi && p.autoAi.appointment === false), configPosts);
ok('nothing is on again', await page.locator('.aa-row.on').count() === 0);

section('No console noise');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
