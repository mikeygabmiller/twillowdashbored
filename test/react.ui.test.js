// Tapbacks in the thread: a heart a customer stuck on one of his texts is drawn
// ON that text, the way a phone draws it — not as a new message quoting him
// back at himself.
//
// The three things that matter, in order:
//   1. it collapses onto the right bubble
//   2. the months of tapbacks already in his history collapse too, untagged
//   3. one we CANNOT place is still shown — losing what a customer did is worse
//      than showing it plainly
//
//   npm install && node test/react.ui.test.js
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

const T0 = Date.parse('2026-09-19T17:00:00Z');
const at = (n) => T0 + n * 60000;
const THREADS = [
  {
    // A tapback the Worker already tagged on the way in.
    phone: '+15551110000', name: 'Dave Reyes', unread: 0, ts: at(9), optedOut: false,
    messages: [
      { id: 'd1', dir: 'out', body: 'Hey Dave, I can do Saturday at 10 if that still works for you', ts: at(1), status: 'delivered' },
      { id: 'd2', dir: 'in',  body: 'yes please', ts: at(2) },
      { id: 'd3', dir: 'out', body: 'See you Saturday at 10', ts: at(3), status: 'delivered' },
      { id: 'd4', dir: 'in',  body: 'Loved "See you Saturday at 10"', ts: at(4), kind: 'reaction', emoji: '❤️', reactLabel: 'loved', reactTo: 'd3' },
    ],
  },
  {
    // Tapbacks already sitting in his history, stored before any of this existed:
    // no kind, no reactTo, just the words. One of them is truncated.
    phone: '+15552220000', name: 'Ruth Alvarez', unread: 0, ts: at(9), optedOut: false,
    messages: [
      { id: 'r1', dir: 'out', body: 'All done, she looks great', ts: at(1), status: 'delivered' },
      { id: 'r2', dir: 'in',  body: 'Liked "All done, she looks great"', ts: at(2) },
      { id: 'r3', dir: 'out', body: 'Sanding grit builds up on the lower panels over a winter, so I clay the rockers too', ts: at(3), status: 'delivered' },
      { id: 'r4', dir: 'in',  body: 'Loved "Sanding grit builds up on the lower panels over a…"', ts: at(4) },
    ],
  },
  {
    // Nothing in the thread says these words, so it stays a message.
    phone: '+15553330000', name: 'Nina Park', unread: 0, ts: at(9), optedOut: false,
    messages: [
      { id: 'n1', dir: 'out', body: 'Booked you in for Friday', ts: at(1), status: 'delivered' },
      { id: 'n2', dir: 'in',  body: 'Loved "something he never actually said to her"', ts: at(2) },
    ],
  },
  {
    // She liked it, then took the like back off again.
    phone: '+15554440000', name: 'Sam Doyle', unread: 0, ts: at(9), optedOut: false,
    messages: [
      { id: 's1', dir: 'out', body: 'On my way, about fifteen minutes out', ts: at(1), status: 'delivered' },
      { id: 's2', dir: 'in',  body: 'Liked "On my way, about fifteen minutes out"', ts: at(2) },
      { id: 's3', dir: 'in',  body: 'Removed a like from "On my way, about fifteen minutes out"', ts: at(3) },
    ],
  },
];

(async () => {
  await new Promise(r => server.listen(8791, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ ...devices['Galaxy S9+'], viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/api/**', route => {
    const u = new URL(route.request().url());
    let posted = {}; try { posted = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    const phone = u.searchParams.get('phone') || posted.phone;
    const body = { ok: true, threads: THREADS };
    if (u.pathname === '/api/config') body.config = { members: [] };
    if (phone) body.thread = THREADS.find(t => t.phone === phone);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' });
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
  // What's actually on screen: one entry per bubble, with whatever badge it carries.
  const shown = () => page.evaluate(() => [...document.querySelectorAll('#messages .bubble')].map((b) => ({
    id: b.getAttribute('data-mid'),
    tap: (b.querySelector('.tapback') || {}).textContent || '',
  })));

  console.log('\n=== a heart lands on the text it was stuck to ===');
  await open('Dave Reyes');
  check('the tapback is not a message of its own', (await shown()).map(x => x.id), ['d1', 'd2', 'd3']);
  check('it is drawn on the text she tapped',      (await shown()).find(x => x.id === 'd3').tap, '❤️');
  check('and on nothing else',                     (await shown()).filter(x => x.tap).length, 1);
  check('the words are gone from the thread',      await page.evaluate(() => /Loved "/.test(document.getElementById('messages').textContent)), false);
  check('his delivery receipt survives it',        await page.evaluate(() => {
    const b = document.querySelector('#messages .bubble[data-mid="d3"]');
    return b ? (b.querySelector('.deliv') || {}).textContent || '' : 'no bubble';
  }), 'Delivered');
  check('screen readers get words, not an emoji',  await page.evaluate(() =>
    (document.querySelector('#messages .bubble[data-mid="d3"] .tapback') || {}).getAttribute?.('aria-label')), 'Dave Reyes loved this');

  console.log('\n=== the ones already in his history collapse too ===');
  await open('Ruth Alvarez');
  check('untagged tapbacks are not messages', (await shown()).map(x => x.id), ['r1', 'r3']);
  check('a plain one finds its text',         (await shown()).find(x => x.id === 'r1').tap, '👍');
  check('a truncated one finds its text',     (await shown()).find(x => x.id === 'r3').tap, '❤️');

  console.log('\n=== one we cannot place is still shown ===');
  await open('Nina Park');
  check('it stays a message',        (await shown()).map(x => x.id), ['n1', 'n2']);
  check('nothing got a badge',       (await shown()).filter(x => x.tap).length, 0);
  check('her words are still there', await page.evaluate(() => /something he never actually said/.test(document.getElementById('messages').textContent)), true);

  console.log('\n=== she took the like back off ===');
  await open('Sam Doyle');
  check('only his text is left',   (await shown()).map(x => x.id), ['s1']);
  check('and it carries no badge', (await shown()).filter(x => x.tap).length, 0);

  console.log('\njs errors: ' + (errs.length ? JSON.stringify(errs) : 'none'));
  check('no js errors', errs, []);
  console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
  await b.close(); server.close();
  process.exit(FAIL ? 1 : 0);
})();
