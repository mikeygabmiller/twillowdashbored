// The refresh button inside a conversation.
//
// The poll starts at 30s and multiplies its interval by 1.6 every time nothing
// has changed, up to five minutes. That back-off is exactly backwards for the
// one thing this app is for: while you are waiting on a reply nothing IS
// changing, so the longer you wait the staler the screen gets — and sitting in
// a conversation is where 78% of the time in this app is spent.
//
// So the button has to do two things, not one. Fetching now is the obvious
// half. Resetting the back-off is the half that matters: asking for new
// messages is a statement that you are waiting for one, and the next automatic
// check should be 30 seconds out, not four minutes.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const PHONE = '+14255551234';
let inbound = [{ id: 'm1', dir: 'in', body: 'sounds good', ts: Date.now() - 60000 }];
let threadCalls = 0;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const last = inbound[inbound.length - 1];
    const row = { phone: PHONE, name: 'Jenna Smith', status: 'active', unread: 0, lastBody: last.body, lastTs: last.ts, tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) {
      threadCalls++;
      out.thread = { phone: PHONE, name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
        messages: inbound.slice(), scheduled: [], linked: [], notes: '' };
    }
    return json(out);
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-31', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-31', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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
const bodyText = () => page.locator('#messages').innerText();

section('The button is there, in the conversation, without being hunted for');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(500);
await page.locator('.conv').first().click();
await page.waitForTimeout(800);
ok('a conversation is open', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('the refresh button is visible in the header', await page.locator('#threadRefresh').isVisible());
ok('and it says what it does', (await page.locator('#threadRefresh').getAttribute('aria-label')) === 'Check for new messages now');

section('It shows a message that arrived a second ago, not in five minutes');
ok('the reply is not on screen yet', !(await bodyText()).includes('can you do Saturday'));
// A text lands while he is looking at the thread — the case the back-off is
// worst for, because nothing had changed for a while before it.
inbound.push({ id: 'm2', dir: 'in', body: 'can you do Saturday', ts: Date.now() });
const before = threadCalls;
await page.locator('#threadRefresh').click();
await page.waitForTimeout(900);
ok('one tap fetched the thread', threadCalls > before, { before, after: threadCalls });
ok('and the new message is on screen', (await bodyText()).includes('can you do Saturday'));

section('The back-off is reset, not just skipped once');
// Without this the button is a one-shot: you would see the message you asked
// for and then wait out the same four minutes for the next one.
const poll = await page.evaluate(() => window.__poll && window.__poll());
ok('the poll interval is back to its floor', poll && poll.interval === poll.min, poll);
ok('and polling is not parked as idle', poll && poll.paused === false, poll);

section('A tap you made is a tap you can see');
// A refresh that finds nothing looks identical to a tap that missed, so the
// button spins for at least a beat either way.
await page.locator('#threadRefresh').click();
await page.waitForTimeout(80);
ok('it spins while the fetch is out', await page.locator('#threadRefresh.spinning').count() === 1);
ok('and is disabled so a double tap cannot stack two fetches',
  await page.locator('#threadRefresh').isDisabled());
await page.waitForTimeout(900);
ok('the spin stops when the fetch lands', await page.locator('#threadRefresh.spinning').count() === 0);
ok('and the button is usable again', !(await page.locator('#threadRefresh').isDisabled()));

section('It never breaks the conversation it is refreshing');
await page.locator('#backBtn').click();
await page.waitForTimeout(500);
ok('back still leaves the conversation', !(await page.evaluate(() => document.body.classList.contains('viewing'))));

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
