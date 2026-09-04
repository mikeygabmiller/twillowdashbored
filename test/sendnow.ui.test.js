// The ten-second hold behind a send is a safety net, not a delivery delay — but
// until now the only way out of it was to wait. This suite covers the strip that
// pops up while a text is parked:
//
//   "Sending…"   [Send now]   [Undo]
//
// The three things that matter: nothing reaches Twilio during the hold, "Send
// now" puts it on the wire immediately, and Undo still hands the words back and
// never sends. A regression in the last one is a text a customer can't unread.
//
//   npm install && node test/sendnow.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
];
const thread = (phone) => ({
  phone, name: (rows.find((r) => r.phone === phone) || {}).name || '', tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'you around thursday?', ts: now - 60000 }],
});

// Every /api/send the page actually made, with the moment it arrived.
const sends = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
// Quiet hours depend on the clock the test happens to run on, and a duplicate
// body prompts too — accept whatever it asks so neither one hangs the suite.
page.on('dialog', (d) => d.accept());

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/send') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    sends.push({ body: body.body, at: Date.now() });
    const t = thread(body.phone);
    t.messages.push({ id: 's' + sends.length, dir: 'out', body: body.body, ts: Date.now(), kind: 'manual', status: 'sent' });
    return json({ ok: true, thread: t });
  }
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  // Keep the auto-polisher from rewriting the box mid-test.
  if (path === '/api/ai/draft') return json({ ok: false, error: 'off' });
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-04', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-04', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const openThread = async (name) => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(600);
};
const compose = async (t) => {
  await page.locator('#msgInput').click();
  await page.locator('#msgInput').fill(t);
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(200);
};

section('A parked text really is parked');
await openThread('Dale Hobart');
await compose('on my way, about twenty minutes out');
ok('the bubble is already in the thread', (await page.locator('.bubble.out').count()) >= 1);
ok('but nothing has gone to Twilio yet', sends.length === 0, sends);
ok('the strip says what is happening', (await page.locator('#toast').innerText()).includes('Sending'));

section('The strip offers both ways out');
ok('there is a Send now button', await page.locator('#toast .now').isVisible());
ok('…labelled in plain words', (await page.locator('#toast .now').innerText()).trim() === 'Send now');
ok('and Undo is still there', await page.locator('#toast .undo').isVisible());
// Muscle memory: Undo has always been the rightmost thing on the strip.
const order = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#toast button'), (b) => b.className));
ok('Send now sits before Undo, not after it', JSON.stringify(order) === JSON.stringify(['now', 'undo']), order);

section('Tap Send now and it goes immediately — no waiting out the ten seconds');
const tapped = Date.now();
await page.locator('#toast .now').click();
await page.waitForTimeout(300);
ok('it sent', sends.length === 1, sends);
ok('with the words you typed', sends[0] && sends[0].body === 'on my way, about twenty minutes out', sends);
ok('within a moment, not after the hold', sends[0] && sends[0].at - tapped < 2000, sends[0] && sends[0].at - tapped);
ok('and the strip went away', !(await page.locator('#toast').evaluate((t) => t.classList.contains('show'))));

section('Sending now once does not send it twice');
await page.waitForTimeout(1200);
ok('still exactly one send after the old timer would have fired', sends.length === 1, sends);

section('Undo still wins — the way back is untouched');
await compose('scratch that, tomorrow instead');
ok('parked again, nothing sent', sends.length === 1, sends);
await page.locator('#toast .undo').click();
await page.waitForTimeout(300);
ok('the words are back in your box', (await page.inputValue('#msgInput')) === 'scratch that, tomorrow instead', await page.inputValue('#msgInput'));
await page.waitForTimeout(1500);
ok('and it never reached Twilio', sends.length === 1, sends);

section('An ordinary toast is still an ordinary toast');
// The strip Undo leaves behind ("Held — put back in your box") has nothing to
// offer, so it must carry no buttons at all.
const plain = await page.evaluate(() => document.querySelectorAll('#toast button').length);
ok('no buttons on a toast that has nothing to offer', plain === 0, plain);

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
