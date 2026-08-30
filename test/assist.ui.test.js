// "Is Answer by email actually working?" — the one line in Settings that stands
// between him trusting this feature and testing it by hand every time.
//
// The reason this is a UI test and not a unit test: the failure it guards against
// is silence. When the Gmail trigger stops — a revoked permission, a paused
// project, a quota — nothing throws anywhere. He keeps replying to alerts,
// customers keep not hearing back, and the first sign is a phone call. So the
// thing worth proving in a browser is that a stale check-in reads as a WARNING
// with what to do about it, and a fresh one reads as working, in his words.
//
//   npm install && node test/assist.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];
let config = { followupsEnabled: true, assistEmail: true };
// Swapped between sections to play out each state the card has to describe.
let setup = {
  ok: true, url: 'https://dash.test/email-in', token: 'ek_x', connected: true, count: 0,
  script: '// script', assistReady: true, alertEmail: 'mikey@gmail.com', assistFrom: [],
  health: {},
};

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
      if (body.assistFrom) setup = Object.assign({}, setup, { assistFrom: body.assistFrom });
    }
    return json({ ok: true, config });
  }
  if (path === '/api/email-setup') return json(setup);
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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
const openSettings = async () => {
  await closeSettings();
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(300);
  }
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(400);
  await page.getByText('Settings', { exact: true }).first().click();
  await page.waitForTimeout(700);
};
const healthText = async () => {
  await page.locator('#cfgAssistRecheck').click();   // drops the cache, refetches
  await page.waitForTimeout(500);
  return (await page.locator('#cfgAssistHealth').innerText()).replace(/\s+/g, ' ');
};

section('Never set up: it says what to do, not "unknown"');
await openSettings();
ok('the card is on screen', await page.locator('#cfgAssistHealth').count() === 1);
let t = await healthText();
ok('it says it is not connected', /Not connected yet/i.test(t), t);
ok('and names the one thing to run', /mikeyAssistSetUp/.test(t), t);

section('Still on the old script: answering, but blind — and it says which');
setup = Object.assign({}, setup, { health: { replyAt: Date.now() - 30 * 60000, at: Date.now() } });
t = await healthText();
ok('it does not claim to be disconnected', !/Not connected yet/.test(t), t);
ok('it says it is answering', /Answering/.test(t), t);
ok('and why the light is worth having', /no way to tell you when it stops/.test(t), t);

section('Checked in a minute ago: working, and it says so');
setup = Object.assign({}, setup, { health: { pingAt: Date.now() - 60000, at: Date.now() } });
t = await healthText();
ok('it reads as working', /Working/.test(t), t);
ok('with when it last checked', /last checked/.test(t), t);
ok('and no warning', !/hasn't checked in/.test(t), t);

section('Gone quiet for hours: a warning he can act on');
setup = Object.assign({}, setup, { health: { pingAt: Date.now() - 5 * 3600 * 1000, at: Date.now() } });
t = await healthText();
ok('it warns', /hasn't checked in/.test(t), t);
ok('it says replies are NOT reaching customers', /not.{0,3} reaching your customers/i.test(t), t);
ok('and names the self-check to run', /mikeyAssistCheck/.test(t), t);

section('It reports what it deliberately did not send');
setup = Object.assign({}, setup, { health: {
  pingAt: Date.now() - 60000, at: Date.now(),
  sentAt: Date.now() - 20 * 60000, sentWho: 'Ruth Alvarez',
  skippedAt: Date.now() - 10 * 60000, skippedWhy: 'a reply to Dale was held — it quotes $425, and you didn\'t say that',
} });
t = await healthText();
ok('the last answer sent is named', /Ruth Alvarez/.test(t), t);
ok('so is the last one held back', /\$425/.test(t), t);
ok("and it's framed as a decision, not an error", /did not send|did <b>not<\/b> send|deliberately/i.test(t), t);

section('A reply from an address it does not know is offered, not swallowed');
setup = Object.assign({}, setup, { assistFrom: [], health: {
  pingAt: Date.now() - 60000, at: Date.now(),
  strangerAt: Date.now() - 3 * 60000, strangerFrom: 'mikey@mikeysdetailing.com',
} });
t = await healthText();
ok('it names the address', /mikey@mikeysdetailing\.com/.test(t), t);
ok('and offers to trust it', await page.locator('#cfgAssistAddFrom').count() === 1);
await page.locator('#cfgAssistAddFrom').click();
await page.waitForTimeout(700);
ok('one tap saves it as one of his', configPosts.some((p) => Array.isArray(p.assistFrom) && p.assistFrom.includes('mikey@mikeysdetailing.com')), configPosts);
t = (await page.locator('#cfgAssistHealth').innerText()).replace(/\s+/g, ' ');
ok('and the offer goes away once it is trusted', !/That's me too/.test(t), t);

section('The "hold it if it says something I did not" switch');
await openSettings();
ok('it exists', await page.locator('#cfgAssistFacts').count() === 1);
ok('and is ON for a config that has never seen it', await page.locator('#cfgAssistFacts').evaluate((n) => n.classList.contains('on')));
await page.locator('#cfgAssistFacts').click();
await page.waitForTimeout(500);
ok('turning it off is saved, and is his choice', configPosts.some((p) => p.assistFactCheck === false), configPosts);

ok('no page errors along the way', errs.length === 0, errs);

console.log(`\n  ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
