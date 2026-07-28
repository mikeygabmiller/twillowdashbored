// Thread rendering: tappable links/phones/addresses (and that linkifying can't
// be turned into HTML injection), the opted-out banner, and the "signing as"
// hint when team mode is on.
//
//   npm install && node test/thread.test.js
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

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const msg = (id, body) => ({ id, dir: 'in', body, ts: Date.now() });
const THREADS = [
  {
    phone: '+15551110000', name: 'Dave Reyes', unread: 0, ts: Date.now(), optedOut: false,
    messages: [
      msg('m1', 'come to 1420 Maple Street when you can'),
      msg('m2', 'my other number is (360) 555-8899'),
      msg('m3', 'pics here https://example.com/car?a=1&b=2'),
      msg('m4', '<img src=x onerror="window.__pwned=1"> and <b>bold</b>'),
      msg('m5', 'javascript:alert(1) not a link'),
    ],
  },
  { phone: '+15553330000', name: 'Nina Stop', unread: 0, ts: Date.now(), optedOut: true, messages: [msg('n1', 'STOP')] },
];

(async () => {
  await new Promise(r => server.listen(8787, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ ...devices['Galaxy S9+'], viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  let teamMode = false;
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    let posted = {}; try { posted = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    const phone = u.searchParams.get('phone') || posted.phone;
    const body = { ok: true, threads: THREADS };
    if (u.pathname === '/api/config') { body.config = { teamMode, members: [{ id: 'm1', name: 'Mikey' }] }; }
    if (phone) body.thread = THREADS.find(t => t.phone === phone);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.keyboard.type('1234'); await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const open = async (who) => {
    if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
      await page.locator('#backBtn').click(); await page.waitForTimeout(250);
    }
    await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(300);
    await page.getByText(who, { exact: true }).first().click(); await page.waitForTimeout(500);
  };

  console.log('\n=== the useful things in a text are tappable ===');
  await open('Dave Reyes');
  const hrefOf = (sub) => page.evaluate(s => {
    const a = [...document.querySelectorAll('#messages .msg-link')].find(x => x.textContent.includes(s));
    return a ? a.getAttribute('href') : null;
  }, sub);
  check('street address goes to Maps', await hrefOf('1420 Maple Street'), 'https://maps.google.com/?q=1420%20Maple%20Street');
  check('phone number dials',          await hrefOf('(360) 555-8899'),   'tel:+13605558899');
  check('link opens the link',         await hrefOf('example.com'),      'https://example.com/car?a=1&b=2');
  check('link opens in a new tab safely', await page.evaluate(() => {
    const a = [...document.querySelectorAll('#messages .msg-link')].find(x => x.textContent.includes('example.com'));
    return a ? a.getAttribute('rel') : null;
  }), 'noopener noreferrer');

  console.log('\n=== linkifying cannot be turned into HTML injection ===');
  check('no element was injected',  await page.evaluate(() => document.querySelectorAll('#messages img, #messages script').length), 0);
  check('nothing executed',         await page.evaluate(() => window.__pwned || false), false);
  check('the tags show as text',    await page.evaluate(() => {
    const b = [...document.querySelectorAll('#messages .bubble')].find(x => x.textContent.includes('onerror'));
    return b ? b.textContent.includes('<img src=x') && b.textContent.includes('<b>bold</b>') : false;
  }), true);
  check('javascript: is not linked', await page.evaluate(() => {
    const a = [...document.querySelectorAll('#messages .msg-link')].map(x => x.getAttribute('href') || '');
    return a.some(h => h.toLowerCase().startsWith('javascript:'));
  }), false);

  console.log('\n=== they texted STOP ===');
  await open('Nina Stop');
  check('banner is shown',        await page.locator('#optOutBanner').isVisible(), true);
  check('banner names them',      /texted STOP/i.test((await page.locator('#optOutBanner').textContent()) || ''), true);
  check('send button disabled',   await page.locator('#sendBtn').isDisabled(), true);
  check('compose box disabled',   await page.locator('#msgInput').isDisabled(), true);

  console.log('\n=== back to a normal conversation ===');
  await open('Dave Reyes');
  check('banner gone',            await page.locator('#optOutBanner').isVisible(), false);
  check('send button usable',     await page.locator('#sendBtn').isDisabled(), false);

  console.log('\n=== whose name goes on the text ===');
  check('hidden when team mode is off', await page.locator('#signAs').isVisible(), false);

  console.log('\njs errors: ' + (errs.length ? JSON.stringify(errs) : 'none'));
  console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  await b.close(); server.close();
  process.exit(FAIL ? 1 : 0);
})();
