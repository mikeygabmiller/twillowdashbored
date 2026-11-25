// The hourly drafter's key, driven the way Mikey would: on a phone, in Settings.
//
// What has to hold: the key shows up once, right after it's made, so he can copy
// it into Claude; it is not in the page or the config the browser holds once he
// leaves the screen (the Worker only keeps its hash, so there is nothing to bring
// back); making a new one says the old one stops; and Turn it off is one tap and
// a confirm away.
//
//   npm install && node test/drafter.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];

let config = { followupsEnabled: true, predictive: true, aiKey: { set: false, hint: '' }, drafterKey: { set: false, at: 0 } };
const keyPosts = [];
let issued = 0;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
const dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

await page.route('**/*', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') return json({ ok: true, threads: rows, config });
  if (path === '/api/config') return json({ ok: true, config });
  // Stands in for apiDrafterKey: the key comes back in this one response only,
  // and the config the screen reloads from says whether one is set, never what.
  if (path === '/api/drafter/key') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    keyPosts.push(body);
    if (body.revoke) { config.drafterKey = { set: false, at: 0 }; return json({ ok: true, drafterKey: config.drafterKey }); }
    issued++;
    config.drafterKey = { set: true, at: now };
    return json({ ok: true, key: 'mkd_draft_TESTKEY' + issued + 'xxxxxxxxxxxxxxxxxxxxxxxx', drafterKey: config.drafterKey });
  }
  if (path === '/api/ai/usage') {
    return json({ ok: true, days: 14, today: '2026-11-24', model: 'claude-haiku-5-5',
      total: { calls: 0, in: 0, out: 0, days: 14 }, todayTotal: { calls: 0, in: 0, out: 0 }, bySurface: [] });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-11', today: '2026-11-24', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-11-24', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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
// The real route in, ☰ then Settings, so the test proves it's reachable on a phone.
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
const shown = (sel) => page.locator(sel).evaluate((n) => getComputedStyle(n).display !== 'none');

section('Before there is a key');
await openSettings();
ok('the card is in Settings', await page.getByText('Hourly drafts on my Claude plan').count() === 1);
ok('it says the drafter is off', /Off · no key yet/.test(await page.locator('#cfgDrafterMsg').textContent()));
ok('with nothing to turn off yet', !(await shown('#cfgDrafterOff')));
ok('and no key box showing', !(await shown('#cfgDrafterKeyRow')));
ok('the button offers to make the key', (await page.locator('#cfgDrafterMake').textContent()).trim() === 'Make the key');

section('Making it');
await page.locator('#cfgDrafterMake').click();
await page.waitForTimeout(500);
ok('no confirm the first time: there is nothing to replace', dialogs.length === 0, dialogs);
ok('it asked the Worker for a key', keyPosts.length === 1 && !keyPosts[0].revoke, keyPosts);
ok('the key is on screen, once, to copy', await shown('#cfgDrafterKeyRow')
  && (await page.locator('#cfgDrafterKey').inputValue()) === 'mkd_draft_TESTKEY1xxxxxxxxxxxxxxxxxxxxxxxx');
ok('in a read-only box', await page.locator('#cfgDrafterKey').getAttribute('readonly') !== null);
ok('and it says so', /won't be shown again/.test(await page.locator('#cfgDrafterMsg').textContent()));
ok('Turn it off appears', await shown('#cfgDrafterOff'));
await page.locator('#cfgDrafterCopy').click();
await page.waitForTimeout(300);
ok('Copy works without an error', errs.length === 0, errs);

section('Leave the screen and come back');
await openSettings();
// The box's value is a property, not an attribute, so page.content() would
// never show it: the box itself has to be read.
ok('the key box is empty again', (await page.locator('#cfgDrafterKey').inputValue()) === '');
ok('and hidden', !(await shown('#cfgDrafterKeyRow')));
const html = await page.content();
ok('the key is nowhere in the page any more', html.indexOf('TESTKEY1') < 0);
ok('nor in the config the browser holds',
  !JSON.stringify(await page.evaluate(() => (window.state && window.state.config) || {})).includes('TESTKEY'));
ok('it reads as on', /^On · key made/.test(await page.locator('#cfgDrafterMsg').textContent()));
ok('and offers a new key rather than "the" key', (await page.locator('#cfgDrafterMake').textContent()).trim() === 'Make a new key');

section('A new key retires the old one, and says so first');
await page.locator('#cfgDrafterMake').click();
await page.waitForTimeout(500);
ok('it asked before replacing it', dialogs.length === 1 && /old one stops working/.test(dialogs[0]), dialogs);
ok('and showed the new key', (await page.locator('#cfgDrafterKey').inputValue()).startsWith('mkd_draft_TESTKEY2'));

section('Turning it off');
await page.locator('#cfgDrafterOff').click();
await page.waitForTimeout(500);
ok('it confirmed first', dialogs.length === 2 && /Turn off the hourly drafter/.test(dialogs[1]), dialogs);
ok('and told the Worker to retire the key', keyPosts.some((p) => p.revoke === true), keyPosts);
ok('the card is back to off', /Off · no key yet/.test(await page.locator('#cfgDrafterMsg').textContent()));
ok('the key is gone from the screen', !(await shown('#cfgDrafterKeyRow')) && (await page.locator('#cfgDrafterKey').inputValue()) === '');
ok('and nothing went wrong on the page', errs.length === 0, errs);

await browser.close();
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
