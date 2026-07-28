// Drives the real dashboard in a headless phone-sized browser: SMS segment
// counting, per-conversation drafts, the send guards, undo send, and the
// keyboard not covering the compose box.
//
//   npm install && node test/compose.test.js
//
// CHROME_PATH overrides the browser binary.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let chromium, devices;
try { ({ chromium, devices } = await import('playwright-core')); }
catch { console.error('playwright-core is missing — run `npm install` first.'); process.exit(2); }
const ROOT = path.join(__dirname, '..', 'public');
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript' });
  res.end(fs.readFileSync(f));
});

const THREADS = [
  { phone: '+15551110000', name: 'Dave',  messages: [{ id: 'd1', dir: 'in', body: 'you free Tuesday?',  ts: Date.now() }], unread: 0, ts: Date.now() },
  { phone: '+15552220000', name: 'Sarah', messages: [{ id: 's1', dir: 'in', body: 'how much for an SUV?', ts: Date.now() }], unread: 0, ts: Date.now() },
];

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

(async () => {
  await new Promise(r => server.listen(8790, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ ...devices['Galaxy S9+'], viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  const sends = [];
  const errs = [];
  const dialogs = [];
  let dialogAnswer = true;
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => { dialogs.push(d.message()); dialogAnswer ? d.accept() : d.dismiss(); });
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    let posted = {};
    try { posted = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    if (u.pathname === '/api/send') { sends.push(posted); }
    // The real backend echoes the updated thread on every one of these — mirror
    // that, or the app has nothing to re-render against.
    const phone = u.searchParams.get('phone') || posted.phone;
    const body = { ok: true, threads: THREADS };
    if (phone) body.thread = THREADS.find(t => t.phone === phone);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('http://127.0.0.1:8790/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.keyboard.type('1234'); await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const openChat = async (who) => {
    if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
      await page.locator('#backBtn').click(); await page.waitForTimeout(250);
    }
    await page.locator('.navitem[data-tab="messages"]').click();
    await page.waitForTimeout(300);
    await page.getByText(who, { exact: true }).first().click();
    await page.waitForTimeout(500);
  };

  console.log('\n=== SMS segment counter (what Twilio actually bills) ===');
  await openChat('Dave');
  const seg = async (text) => {
    await page.evaluate(t => { const i = document.getElementById('msgInput'); i.value = t; i.dispatchEvent(new Event('input')); }, text);
    return (await page.textContent('#charCount')).trim();
  };
  check('plain 10 chars = 1 SMS',              await seg('a'.repeat(10)),  '10 · 1 SMS');
  check('plain 160 chars = 1 SMS',             await seg('a'.repeat(160)), '160 · 1 SMS');
  check('plain 161 chars = 2 SMS (153 split)', await seg('a'.repeat(161)), '161 · 2 SMS');
  check('plain 320 chars = 3 SMS (old said 2)',await seg('a'.repeat(320)), '320 · 3 SMS');
  check('150 chars + emoji = 3 SMS unicode',   await seg('a'.repeat(150) + '\u{1F44D}'), '151 · 3 SMS · unicode');
  check('curly apostrophe flips encoding',     await seg('I’ll be there at 2'), '18 · 1 SMS · unicode');

  console.log('\n=== drafts stay with their own conversation ===');
  await page.evaluate(() => { const i = document.getElementById('msgInput'); i.value = ''; i.dispatchEvent(new Event('input')); });
  await page.locator('#msgInput').click();
  await page.keyboard.type('Tuesday at 2 works, $180');
  await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  await openChat('Sarah');
  check('Sarah opens with an empty box', await page.inputValue('#msgInput'), '');
  await page.locator('#msgInput').click();
  await page.keyboard.type('SUV is $220');
  await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  await openChat('Dave');
  check('Dave still has his own draft', await page.inputValue('#msgInput'), 'Tuesday at 2 works, $180');
  await openChat('Sarah');
  check('Sarah still has hers',         await page.inputValue('#msgInput'), 'SUV is $220');

  console.log('\n=== drafts survive closing the app ===');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.keyboard.type('1234'); await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await openChat('Dave');
  check('draft came back after reload', await page.inputValue('#msgInput'), 'Tuesday at 2 works, $180');

  console.log('\n=== guards before it leaves ===');
  await openChat('Dave');
  const setBox = (t) => page.evaluate(v => { const i = document.getElementById('msgInput'); i.value = v; i.dispatchEvent(new Event('input')); }, t);
  // Quiet hours default to 20:00-08:00; whether it should fire depends on the clock.
  const hour = await page.evaluate(() => new Date().getHours());
  const expectQuiet = (hour >= 20 || hour < 8);
  console.log(`  (browser local hour is ${hour} — quiet-hours prompt expected: ${expectQuiet})`);

  dialogs.length = 0;
  await setBox('late night text');
  await page.locator('#sendBtn').click(); await page.waitForTimeout(300);
  check('quiet hours asks first, only when it is quiet hours', /quiet hours/i.test(dialogs.join(' ')), expectQuiet);

  dialogs.length = 0;
  await setBox('a different text');
  await page.locator('#sendBtn').click(); await page.waitForTimeout(300);
  check('does not nag about quiet hours twice', dialogs.filter(d => /quiet hours/i.test(d)).length, 0);

  dialogs.length = 0;
  await setBox('a different text');
  await page.locator('#sendBtn').click(); await page.waitForTimeout(300);
  check('duplicate text asks first', /exact text/i.test(dialogs.join(' ')), true);

  dialogAnswer = false;
  await setBox('a different text');
  await page.locator('#sendBtn').click(); await page.waitForTimeout(300);
  check('saying no keeps your words in the box', await page.inputValue('#msgInput'), 'a different text');
  dialogAnswer = true;
  await setBox('');
  await page.waitForTimeout(11000); // let the queued sends drain

  console.log('\n=== undo send ===');
  await page.evaluate(() => { const i = document.getElementById('msgInput'); i.value = ''; i.dispatchEvent(new Event('input')); });
  await page.locator('#msgInput').click();
  await page.keyboard.type('oops wrong person');
  const before = sends.length;
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(300);
  check('box cleared immediately',   await page.inputValue('#msgInput'), '');
  check('bubble shown optimistically', await page.locator('.bubble').filter({ hasText: 'oops wrong person' }).count(), 1);
  check('nothing sent yet',          sends.length, before);
  check('Undo is offered',           await page.locator('.toast.show .undo').count(), 1);
  await page.locator('.toast.show .undo').click();
  await page.waitForTimeout(300);
  check('bubble pulled back out',    await page.locator('.bubble').filter({ hasText: 'oops wrong person' }).count(), 0);
  check('words put back in the box', await page.inputValue('#msgInput'), 'oops wrong person');
  await page.waitForTimeout(1200);
  check('still never sent',          sends.length, before);

  console.log('\n=== a send left alone still goes ===');
  await page.evaluate(() => { const i = document.getElementById('msgInput'); i.value = 'this one is real'; i.dispatchEvent(new Event('input')); });
  await page.evaluate(() => { window.__t0 = Date.now(); });
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(11000);
  check('sent after the undo window', sends.length, before + 1);
  check('sent the right words',       sends[sends.length - 1] && sends[sends.length - 1].body, 'this one is real');

  console.log('\n=== backgrounding the app flushes a pending send ===');
  await page.evaluate(() => { const i = document.getElementById('msgInput'); i.value = 'flush me'; i.dispatchEvent(new Event('input')); });
  const b2 = sends.length;
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(200);
  check('still parked', sends.length, b2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(400);
  check('flushed on background, not lost', sends.length, b2 + 1);

  console.log('\n=== keyboard does not cover the composer ===');
  const kb = await page.evaluate(() => {
    document.documentElement.style.setProperty('--kb', '300px');
    const c = document.getElementById('composer').getBoundingClientRect();
    return { composerBottom: Math.round(c.bottom), keyboardTop: window.innerHeight - 300 };
  });
  check('composer sits above a 300px keyboard', kb.composerBottom <= kb.keyboardTop + 1, true);
  await page.evaluate(() => document.documentElement.style.setProperty('--kb', '0px'));

  console.log('\njs errors: ' + (errs.length ? JSON.stringify(errs) : 'none'));
  console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  await b.close(); server.close();
  process.exit(FAIL ? 1 : 0);
})();
