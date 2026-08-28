// The hard rule: while the on-screen keyboard is up, the message box is on
// screen. He types with one thumb standing next to a car — a compose box behind
// the keys means writing a text blind.
//
// Two separate things hide it and both are checked here:
//   1. the keyboard covering the bottom of the screen (the --kb arithmetic), and
//   2. the chat column running out of room, where the banner stack above the
//      messages adds up to more than the visible screen and shoves the box —
//      the last child in the column — off the bottom edge.
// The second one is the sneaky one: it needs no keyboard bug at all, just a
// thread with a job, a hold, a quote and a reminder on it.
//
// A headless browser has no keyboard, so the measurement is tested through the
// exposed window.__kb() arithmetic, and the layout is tested by setting the same
// CSS custom properties the real watcher sets.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const thread = {
  phone: '+14255551234', name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: Date.now() - 60000 }],
  scheduled: [], linked: [], notes: '',
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
// A small phone on purpose — the squeeze only shows up when the screen is short.
const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: 'sounds good', lastTs: Date.now(), tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/money') {
    return json({ ok: true, month: '2026-08', today: '2026-08-28', entries: [], nudges: [], owed: [],
      summary: { net: 0, gross: 0, costs: 0, jobs: 0 }, config: {} });
  }
  if (path === '/api/day') return json({ ok: true, date: '2026-08-28', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

// Pretend a keyboard `px` tall just opened: exactly what the visualViewport
// watcher writes when it measures one.
const keyboard = (px, top) => page.evaluate(([kb, vt]) => {
  const d = document.documentElement;
  d.style.setProperty('--kb', kb + 'px');
  d.style.setProperty('--vv-top', (vt || 0) + 'px');
  d.style.setProperty('--vvh', (window.innerHeight - kb - (vt || 0)) + 'px');
  d.classList.toggle('kb-up', kb > 0);
}, [px, top || 0]);

// Where the box actually is, against where the screen actually ends.
const boxFits = () => page.evaluate(() => {
  const r = document.getElementById('msgInput').getBoundingClientRect();
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
  const send = document.getElementById('sendBtn').getBoundingClientRect();
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
    sendBottom: Math.round(send.bottom), floor: Math.round(window.innerHeight - kb),
  };
});

section('The arithmetic: what counts as a keyboard');
const kbFor = (h, vh, top, typing) => page.evaluate(([a, b, c, d]) => window.__kb(a, b, c, d), [h, vh, top, typing]);
ok('a full keyboard is measured', (await kbFor(800, 460, 0, true)) === 340, await kbFor(800, 460, 0, true));
ok('the URL bar sliding away is not a keyboard', (await kbFor(800, 740, 0, false)) === 0);
ok('a short keyboard counts once the caret is in a box', (await kbFor(800, 750, 0, true)) === 50);
ok('a short cover with nothing focused is still ignored', (await kbFor(800, 750, 0, false)) === 0);
// iOS answers a keyboard by sliding the visible window down inside the page, so
// only the part below it is actually covered.
ok('the iOS offset comes out of the covered height', (await kbFor(800, 460, 100, true)) === 240);
ok('never negative', (await kbFor(800, 900, 0, true)) === 0);

section('A keyboard over a plain conversation');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(500);
await page.locator('.conv').first().click();
await page.waitForTimeout(700);
ok('the composer is up', await page.locator('#composer').isVisible());
// autoGrow() runs before the composer is shown (it restores the saved draft) and
// a box that isn't on screen measures zero — stamping that as an inline height
// left the empty box a 26px sliver of padding for the rest of the session.
ok('the empty box is a whole box, not a sliver',
  (await page.locator('#msgInput').evaluate((e) => Math.round(e.getBoundingClientRect().height))) >= 44,
  await page.locator('#msgInput').evaluate((e) => Math.round(e.getBoundingClientRect().height)));

await keyboard(340);
await page.waitForTimeout(120);
let b = await boxFits();
ok('the box is above the keyboard', b.bottom <= b.floor + 1, b);
ok('so is the send button', b.sendBottom <= b.floor + 1, b);
ok('the box is on screen, not off the top', b.top >= 0 && b.height > 20, b);

section('A keyboard over a conversation with every banner on it');
// A real thread carries several of these at once. Together they are taller than
// the phone, which is exactly how the box used to get pushed out of sight.
await page.evaluate(() => {
  ['jobBanner', 'holdBanner', 'optOutBanner', 'logJobBanner', 'quoteBanner',
    'remindBanner', 'schedBanner', 'fuBanner', 'dateBanner', 'teamIdentityBar'].forEach((id) => {
    const e = document.getElementById(id);
    e.style.display = 'block';
    e.innerHTML = '<div style="height:64px">' + id + '</div>';
  });
  document.getElementById('planChipWrap').innerHTML = '<div style="height:64px">plan</div>';
});
await page.waitForTimeout(150);
b = await boxFits();
ok('the box survives a full banner stack', b.bottom <= b.floor + 1 && b.height > 20, b);
ok('and it is still a usable height', b.height >= 40, b);
ok('the banners stepped aside', !(await page.locator('#quoteBanner').isVisible()));
ok('the messages list is still there', await page.locator('#messages').isVisible());

section('The box itself can never be squeezed');
ok('the composer does not shrink', (await page.locator('#composer').evaluate((e) => getComputedStyle(e).flexShrink)) === '0');
const cap = await page.locator('#msgInput').evaluate((e) => getComputedStyle(e).maxHeight);
ok('a long draft is capped to a slice of the visible screen', parseFloat(cap) > 0 && parseFloat(cap) <= 140, cap);

section('iOS: the visible window slid down inside the page');
await keyboard(300, 60);
await page.waitForTimeout(120);
const shifted = await page.evaluate(() => Math.round(document.querySelector('.chat').getBoundingClientRect().top));
ok('the chat pane follows the visible window down', shifted === 60, shifted);
b = await boxFits();
ok('the box is still above the keyboard', b.bottom <= b.floor + 1, b);

section('Keyboard away, everything comes back');
// Back to what a busy thread really carries at once, rather than the stress pile.
await page.evaluate(() => {
  ['jobBanner', 'holdBanner', 'optOutBanner', 'logJobBanner', 'dateBanner', 'teamIdentityBar'].forEach((id) => {
    const e = document.getElementById(id); e.style.display = 'none'; e.innerHTML = '';
  });
  document.getElementById('planChipWrap').innerHTML = '';
});
await keyboard(0);
await page.waitForTimeout(150);
ok('the banners are back', await page.locator('#quoteBanner').isVisible());
ok('the chat pane is back at the top', (await page.evaluate(() => Math.round(document.querySelector('.chat').getBoundingClientRect().top))) === 0);
b = await boxFits();
ok('the box sits on the bottom of the screen', b.bottom <= 720 + 1 && b.bottom > 600, b);
ok('and it is back to full height', b.height >= 44, b);

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
