// The AI key field, driven the way he'd drive it: on a phone, in Settings, with
// no Cloudflare dashboard anywhere in reach.
//
// The test that earns its keep here is not "the box renders". It is that the key
// he types goes UP and never comes back DOWN. It lives in the config doc rather
// than in a Worker secret, which is the compromise that made it settable from a
// phone at all, and the one thing holding that compromise together is that the
// value is never served back to a browser. A regression there would look like
// nothing at all on screen.
//
//   npm install && node test/aikey.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const REAL_KEY = 'sk-ant-api03-ZZZZtestkeytestkeytestkey0000';
const HINT = 'sk-ant-…0000';

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];

// Starts where a real config starts before any of this existed: no key, and the
// aiKey block the Worker now sends in its place saying so.
let config = { followupsEnabled: true, predictive: true, aiKey: { set: false, hint: '' } };
let storedKey = '';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
// The 422 is this test's own doing — it deliberately saves "hunter2" to prove
// the Worker is what refuses a bad key, and the browser logs every non-2xx.
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|422/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const configPosts = [];

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') return json({ ok: true, threads: rows, config });
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(body);
      // Stands in for apiSaveConfig: the same three answers, and above all the
      // same refusal to put the stored value back in the response.
      if (typeof body.anthropicApiKey === 'string') {
        const k = body.anthropicApiKey.trim();
        if (!k) storedKey = '';
        else if (k.indexOf('…') >= 0) { /* the mask coming back — ignored */ }
        else if (/^sk-ant-\S{20,}$/.test(k)) storedKey = k;
        else return json({ ok: false, error: 'bad_ai_key' }, 422);
      }
      config = Object.assign({}, config, body);
      delete config.anthropicApiKey;
      config.aiKey = { set: !!storedKey, hint: storedKey ? HINT : '' };
    }
    return json({ ok: true, config });
  }
  if (path === '/api/ai/usage') {
    return json({ ok: true, days: 14, today: '2026-09-20', model: 'claude-haiku-4-5',
      total: { calls: 0, in: 0, out: 0, days: 14 }, todayTotal: { calls: 0, in: 0, out: 0 }, bySurface: [] });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-20', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-20', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const closeSettings = async () => {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#moreApp.show').count())) break;
    await page.locator('#mrBack').click();
    await page.waitForTimeout(300);
  }
};
// The real route in: ☰ → Settings. Reaching the field through the sheet is the
// only way the test proves it is actually reachable on a phone.
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

section('The field is there, on the phone, without a dashboard');
await openSettings();
ok('the key box is in Settings', await page.locator('#cfgAiKey').count() === 1);
ok('and it is a password box, so it is not shoulder-readable',
  await page.locator('#cfgAiKey').getAttribute('type') === 'password');
ok('with no Remove button until there is something to remove',
  await page.locator('#cfgAiKeyClear').count() === 0);

section('A key that is not a key gets refused, not stored');
await page.locator('#cfgAiKey').fill('hunter2');
await page.locator('#cfgAiKeySave').click();
await page.waitForTimeout(500);
ok('it still posted, so the Worker is the one deciding',
  configPosts.some((p) => p.anthropicApiKey === 'hunter2'), configPosts);
ok('and nothing was stored', storedKey === '', storedKey);

section('The real thing');
await page.locator('#cfgAiKey').fill(REAL_KEY);
await page.locator('#cfgAiKeySave').click();
await page.waitForTimeout(600);
ok('the key reached the Worker', storedKey === REAL_KEY, storedKey);
ok('the box is emptied on the way out', await page.locator('#cfgAiKey').inputValue() === '');
// The one that matters. Everything else here is convenience; this is the
// compromise holding.
const html = await page.content();
ok('and the key itself is nowhere in the page', html.indexOf(REAL_KEY) < 0);
ok('nor anywhere in the config the browser is holding',
  !JSON.stringify(await page.evaluate(() => window.state && window.state.config || {})).includes(REAL_KEY));

section('Once set, it says so without saying what');
await openSettings();
ok('the hint is shown', (await page.locator('#cfgAiKeyMsg').textContent()).indexOf(HINT) >= 0);
ok('and Remove has appeared', await page.locator('#cfgAiKeyClear').count() === 1);

section('And it can be taken back out');
await page.locator('#cfgAiKeyClear').click();
await page.waitForTimeout(600);
ok('an empty string clears it', storedKey === '', storedKey);

ok('no JS errors', errs.length === 0, errs);
console.log(`\n${fail ? '✗' : '✓'} aikey — ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
