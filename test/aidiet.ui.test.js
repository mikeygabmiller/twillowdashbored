// The two switches that stopped the app spending money on its own, driven the
// way he'd drive them.
//
// The one that matters is the keyboard. Its AI half fired on every typing pause
// and was the largest single line on the AI bill, so the test that earns its keep
// is not "the switch renders" — it's "with the switch off, typing a whole
// sentence produces ZERO calls to /api/ai/predict". A default that silently
// reverts costs real money and nothing on screen would say so.
//
//   npm install && node test/aidiet.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];
const thread = (phone) => ({
  phone, name: 'Dale Hobart', tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'you around thursday?', ts: now - 60000 }],
});

// Starts exactly where a real config that predates this change starts: neither
// key stored, so both fall to their defaults.
let config = { followupsEnabled: true, predictive: true };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const predictCalls = [];
const polishCalls = [];
const configPosts = [];

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(body);
      config = Object.assign({}, config, body);
    }
    return json({ ok: true, config });
  }
  // The server refuses while the switch is off, exactly as the Worker does — so
  // a browser that asks anyway still shows up in predictCalls and fails the test.
  if (path === '/api/ai/predict') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    predictCalls.push(body.text || '');
    if (config.predictiveAi !== true) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'no_ai' }) });
    return json({ ok: true, completion: ' works for me', options: ['works', 'sounds good'] });
  }
  if (path === '/api/ai/style') return json({ ok: true, model: { n: 120, uni: { thursday: 3 }, bi: {}, tri: {} } });
  if (path === '/api/ai/draft') { polishCalls.push(1); return json({ ok: true, draft: 'Polished.' }); }
  if (path === '/api/ai/usage') {
    return json({ ok: true, days: 14, today: '2026-08-25', model: 'gemini-2.5-flash',
      total: { calls: 412, in: 1250000, out: 96000, days: 14 },
      todayTotal: { calls: 31, in: 88000, out: 6400 },
      bySurface: [
        { surface: 'keyboard', calls: 240, in: 900000, out: 40000, errors: 0 },
        { surface: 'inbound triage', calls: 90, in: 250000, out: 30000, errors: 0 },
        { surface: 'appointment detect', calls: 82, in: 100000, out: 26000, errors: 7 },
      ] });
  }
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

const openThread = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText('Dale Hobart', { exact: true }).first().click();
  await page.waitForTimeout(600);
};
// Type, then sit still well past the 600ms debounce and the 1100ms minimum gap,
// so a keyboard that was going to ask has had every chance to.
const typeAndWait = async (t) => {
  await page.locator('#msgInput').click();
  await page.locator('#msgInput').fill('');
  await page.locator('#msgInput').type(t, { delay: 25 });
  await page.waitForTimeout(2200);
};
// The real route in: ☰ → Settings. The switches live in the panel mrSettings()
// moves into that sheet, so reaching them through the sheet is the only way the
// test proves they're actually reachable.
const openSettings = async () => {
  await closeSettings();
  // The bottom nav is hidden while a conversation is open, so step out first.
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(300);
  }
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(400);
  await page.getByText('Settings', { exact: true }).first().click();
  await page.waitForTimeout(500);
};
// mrBack steps out of Settings and then out of More, so two taps always land
// back on the app whichever level the sheet was left at.
const closeSettings = async () => {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#moreApp.show').count())) break;
    await page.locator('#mrBack').click();
    await page.waitForTimeout(300);
  }
};

section('Out of the box, the keyboard costs nothing');
await openThread();
await typeAndWait('yeah thursday');
ok('typing a sentence made no AI keyboard calls at all', predictCalls.length === 0, predictCalls);
const chipsOff = await page.locator('#predBar').count();
ok('the free local strip is still in the page', chipsOff > 0);

section('The switch is there, off, next to the free one');
await openSettings();
ok('the paid half has its own switch', await page.locator('#cfgPredictAi').count() === 1);
ok('and it reads OFF', !(await page.locator('#cfgPredictAi').evaluate((n) => n.classList.contains('on'))));
ok('while the free word chips stay ON', await page.locator('#cfgPredict').evaluate((n) => n.classList.contains('on')));

section('Turning it on is what starts the spending — and it is his choice');
await page.locator('#cfgPredictAi').click();
await page.waitForTimeout(500);
await closeSettings();
ok('the tap saved predictiveAi:true', configPosts.some((p) => p.predictiveAi === true), configPosts);
await openThread();
await typeAndWait('yeah thursday');
ok('now typing does ask the AI', predictCalls.length > 0, predictCalls);

section('…and turning it back off stops it again');
await openSettings();
await page.locator('#cfgPredictAi').click();
await page.waitForTimeout(500);
await closeSettings();
ok('saved predictiveAi:false', configPosts.some((p) => p.predictiveAi === false), configPosts);
const before = predictCalls.length;
await openThread();
await typeAndWait('friday morning maybe');
ok('no further calls', predictCalls.length === before, predictCalls.slice(before));

section('The usage readout says where the money went');
await openSettings();
const card = await page.locator('#aiUseCard').innerText();
ok('it names the biggest spender first', card.indexOf('keyboard') < card.indexOf('inbound triage'), card.slice(0, 200));
ok('it shows counted calls, not a guess', /412 AI calls over 14 days/.test(card), card.slice(0, 120));
ok("it reports today separately", /Today so far: 31 calls/.test(card), card.slice(0, 200));
ok('a surface that keeps erroring is called out', /7 failed/.test(card), card);

section('Both daily emails: one switch, on the notifications sheet');
await openSettings();
await page.getByText('Phone notifications', { exact: true }).first().click();
await page.waitForTimeout(600);
ok('the pause switch is on the sheet', await page.locator('#pshDailyPause').count() === 1);
ok('it starts unticked for a config that has never seen it', !(await page.locator('#pshDailyPause').isChecked()));
let sheet = await page.locator('#jdSheet').innerText();
ok('it names both mails it holds back', /morning brief/i.test(sheet) && /log today/i.test(sheet), sheet.slice(0, 300));
ok('and says what still comes through', /Sunday recap/i.test(sheet), sheet.slice(0, 400));

await page.locator('#pshDailyPause').click();
await page.waitForTimeout(700);
ok('ticking it saves the pause', configPosts.some((p) => p.dailyEmailsPaused === true), configPosts);
sheet = await page.locator('#jdSheet').innerText();
ok('the sheet comes back with it ticked', await page.locator('#pshDailyPause').isChecked());
ok('and the brief row now admits it is paused', /paused below/i.test(sheet), sheet.slice(0, 400));
ok('the brief\'s own switch was not touched — the pause sits in front of it',
  !configPosts.some((p) => p.briefEnabled === false), configPosts);

section('No page errors');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
