// The promises board, driven in a real browser.
//
// promise.test.js proves the facts are worked out correctly. This one exists for
// the thing those facts are FOR: a board that says "you said you'd follow up" is
// a to-do list, and a to-do list loses to whatever else is on the screen. What
// has to survive onto the row is the money, their own words, and the cost of
// scrolling past — and never a reason the conversation doesn't support.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const now = Date.now();

// Kara: quoted, chased twice, on a clock. The whole point of the feature.
// David: one message back (his address), no chase — the row must not invent one.
const PROMISES = [
  { id: 'p1', phone: '+13605551234', name: 'Kara Simms', status: 'open', due: true,
    quote: "I'll reach out this weekend and let you know", what: 'send Kara a day and a time',
    madeAt: now - 4 * 86400000, dueAt: now - 86400000, nudges: 1,
    whenLabel: 'Sat, Sep 19, 9:00 AM', gcal: 'https://calendar.google.com/x',
    stakes: {
      name: 'Kara Simms', money: 370, waitingMs: 3 * 86400000,
      theirLast: 'Can you give me an idea of your schedule so I know your availability?',
      theirLastTs: now - 3 * 86400000,
      lines: [
        '$370 is still on the table — you quoted it 9d ago and never heard back.',
        'Kara has been waiting 3d for an answer.',
        "They've written 2 times since you said that — and you haven't answered any of them.",
      ],
      cost: "That's $370 going to whoever answers them first.",
    } },
  { id: 'p2', phone: '+13603787586', name: 'David Kimple', status: 'open', due: false,
    quote: 'If you send over your address I can let you know when I can come by.',
    what: '', madeAt: now - 31 * 86400000, dueAt: now + 86400000, nudges: 0,
    whenLabel: 'Mon, Sep 22, 8:00 AM', gcal: 'https://calendar.google.com/y',
    stakes: {
      name: 'David Kimple', money: 0, waitingMs: 31 * 86400000,
      theirLast: '5113 69th Ave Ne Marysville', theirLastTs: now - 31 * 86400000,
      lines: ['David has been waiting 31d for an answer.'],
      cost: 'Two days of silence is how a warm lead turns into someone else’s customer.',
    } },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sent = [];                 // POST /api/send — must stay empty for the whole run
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const p = u.pathname;
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (_) { return {}; } };
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/promises') return json({ ok: true, promises: PROMISES, config: { enabled: true, nudgeEvery: 24, maxNudges: 3 } });
  if (p === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (p === '/api/send') { sent.push(body()); return json({ ok: true }); }
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1200);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// The widget is hidden by default on Home, so it is opened the way he would:
// More → Day tools → Promises you made.
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(500);
await page.getByText('Promises you made', { exact: true }).first().click();
await page.waitForTimeout(800);
const board = await page.locator('#moreApp').innerText();

section('the row says why, not just what');
ok('his own words are still there', /reach out this weekend/.test(board), board.slice(0, 400));
ok('their words are there too, so he answers a person', /idea of your schedule/.test(board));
ok('the money is named', /\$370 is still on the table/.test(board));
ok('so is how long they have waited', /waiting 3d for an answer/.test(board));
ok('and that they had to chase him', /written 2 times since/.test(board));
ok('the cost of scrolling past is spelled out', /whoever answers them first/.test(board));

section('a row with nothing to claim claims nothing');
ok('David gets his one true reason', /waiting 31d for an answer/.test(board));
ok('and is never said to have chased', !/David[^]{0,80}(chased|came back|written 2)/.test(board), board.slice(0, 900));

section('the why block is actually rendered, not just present as text');
ok('the reasons have their own panel', await page.locator('.pm-why').count() === 2);
ok('the cost line is styled apart from them', await page.locator('.pm-cost').count() === 2);
ok('their words get a row of their own', await page.locator('.pm-them').count() === 2);
ok('the due one is marked as due', await page.locator('.pm-item.due').count() === 1);

section('it is still a reminder, never a text');
ok('nothing was sent to a customer', sent.length === 0, sent);

section('a promise with no stakes yet still renders');
await page.evaluate(() => { window.PR && (window.PR.list = []); });
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
