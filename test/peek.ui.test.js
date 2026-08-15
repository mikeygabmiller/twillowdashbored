// Swipe left on a conversation → a summary of who this is and what they need,
// so going down a list of twenty doesn't mean opening twenty threads to find
// out. The hard constraint: peeking reads ONLY the list row already in memory,
// so it never fires /api/thread and never marks anything read.
//
//   npm install && node test/peek.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const DAY = 86400000;

// Thursday-ish: three days out, 2pm, so "Booked … in 3 days" is deterministic.
const appt = (() => { const d = new Date(now + 3 * DAY); d.setHours(14, 0, 0, 0); return d.getTime(); })();

const rows = [
  {
    phone: '+14255551234', name: 'Dale Hobart', status: 'active', unread: 2, tags: ['ceramic'],
    lastBody: 'yeah thursday works for me', lastDir: 'in', lastTs: now - 2 * 3600000, awaitingReply: true,
    appointmentAt: appt, city: 'Monroe', address: '812 Fern Ridge Rd', vehicleLabel: '2019 Tahoe',
    source: 'quote', firstTs: now - 9 * DAY, scheduledCount: 1, nextScheduledAt: now + 2 * DAY,
    plan: { every: 56, paused: false, service: 'Maintenance wash' }, hasMedia: true,
  },
  {
    phone: '+14255557777', name: 'Rita Cole', status: 'new', unread: 0, tags: [],
    lastBody: 'what would a full detail run me?', lastDir: 'in', lastTs: now - 6 * DAY,
    quoteAt: now - 6 * DAY, quoteTotal: 240, city: 'Snohomish', awaitingReply: true,
  },
  {
    phone: '+14255550000', name: 'Stopped Sam', status: 'lost', unread: 0, tags: [], optedOut: true,
    lastBody: 'STOP', lastDir: 'in', lastTs: now - 20 * DAY,
  },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 }, hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const threadHits = [];
const recapCalls = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    if (want) threadHits.push(want);
    const out = { ok: true, threads: rows, config: {} };
    if (want) {
      const r = rows.find((x) => x.phone === want) || {};
      out.thread = { phone: want, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '',
        messages: r.lastBody ? [{ id: 'm1', dir: r.lastDir || 'in', body: r.lastBody, ts: r.lastTs }] : [] };
    }
    return json(out);
  }
  if (path === '/api/thread') { threadHits.push(u.searchParams.get('phone')); return json({ ok: true, thread: {} }); }
  if (path === '/api/ai/recap') {
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    recapCalls.push(body.phone);
    const canned = {
      '+14255551234': "asked about ceramic on his Tahoe, you said you'd price it Thursday",
      '+14255557777': '',                              // AI came back empty for her
    };
    return json({ ok: true, recap: Object.prototype.hasOwnProperty.call(canned, body.phone)
      ? canned[body.phone] : 'they reached out, nothing settled yet' });
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

const toChats = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click();
  await page.waitForTimeout(350);
};
// A real finger drag: touchstart, several touchmoves, touchend.
const drag = async (sel, dx) => {
  const box = await page.locator(sel).first().boundingBox();
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.evaluate(({ sel, dx, x, y }) => {
    const node = document.querySelectorAll(sel)[0];
    const t = (cx) => ({ touches: [{ clientX: cx, clientY: y }], changedTouches: [{ clientX: cx, clientY: y }] });
    const fire = (name, cx) => {
      const ev = new Event(name, { bubbles: true });
      Object.assign(ev, t(cx));
      node.dispatchEvent(ev);
    };
    fire('touchstart', x);
    for (let i = 1; i <= 6; i++) fire('touchmove', x + (dx * i) / 6);
    fire('touchend', x + dx);
  }, { sel, dx, x, y });
  await page.waitForTimeout(450);
};
const peekText = () => page.locator('#pkCard').innerText();

await toChats();

section('A faded edge marks where the swipe lives');
ok('every row carries the hint', await page.locator('.conv .conv-hint').count() === rows.length);
ok('it is showing on a touch device', await page.locator('.conv .conv-hint').first().isVisible());
ok('it points the way you pull — left', await page.locator('.conv .conv-hint svg').first().count() === 1);
ok('it never eats a tap', await page.evaluate(() =>
  getComputedStyle(document.querySelector('.conv-hint')).pointerEvents === 'none'));
ok('it sits under the unread pill, not over it', await page.evaluate(() => {
  const h = getComputedStyle(document.querySelector('.conv .conv-hint')).zIndex;
  const p = getComputedStyle(document.querySelector('.conv .unread-pill')).zIndex;
  return Number(p) > Number(h);
}));
ok('it is faded, not shouting', await page.evaluate(() => {
  const o = Number(getComputedStyle(document.querySelector('.conv-hint')).opacity);
  return o > 0.2 && o < 0.8;
}));

section('Swiping left brings up the summary — swiping right still archives');
await drag('.conv', -140);
ok('the peek opened', await page.locator('#pkCard').count() === 1);
let txt = await peekText();
ok('it names the person', /Dale Hobart/.test(txt), txt.slice(0, 120));
ok('…and their number', /\(425\) 555-1234/.test(txt));

section('The headline answers "which one was this?"');
ok('leads with the booking', /Booked/.test(txt), txt.split('\n').slice(0, 6));
ok('…in plain language', /in 3 days/.test(txt), txt.split('\n').slice(0, 6));

section('Where they are, and what they drive');
ok('street address', /812 Fern Ridge Rd/.test(txt));
ok('city', /Monroe/.test(txt));
ok('vehicle', /2019 Tahoe/.test(txt));

section('The rest of what is actually going on');
ok('the maintenance plan, in weeks not days', /Every 8 weeks/.test(txt), txt);
ok('a queued text is disclosed', /Queued to send/.test(txt));
ok('where the lead came from', /Website quote form/.test(txt));
ok('their own last words', /yeah thursday works for me/.test(txt));
ok('unread count is on show', /2 unread/.test(txt));
ok('photos flagged', /Sent photos/.test(txt));

section('"What happened" — the part the list row cannot know');
await page.waitForTimeout(350);
txt = await peekText();
ok('it asked for a recap', recapCalls.includes('+14255551234'), recapCalls);
ok('and shows it', /asked about ceramic on his Tahoe/.test(txt), txt);
ok('under its own heading', /WHAT HAPPENED/i.test(txt));
ok('the spinner is gone once it lands', await page.locator('#pkCard .pk-recap.loading').count() === 0);

section('Peeking must not mark anything read');
ok('no thread was fetched', threadHits.length === 0, threadHits);
ok('the unread badge survived', await page.locator('.conv .unread-pill').first().innerText() === '2');

section('Stepping through the list without closing');
await page.locator('#pkNext').click();
await page.waitForTimeout(300);
txt = await peekText();
ok('moves to the next person', /Rita Cole/.test(txt));
ok('her headline is that she is waiting', /Waiting on your reply/.test(txt), txt.split('\n').slice(0, 6));
ok('…and it carries the quote she is waiting on', /\$240, no answer/.test(txt), txt.split('\n').slice(0, 6));
ok('the quote is a fact row too', /Open quote/.test(txt));
ok('position is shown', /2 of 3/.test(txt));
await page.waitForTimeout(350);
ok('an empty recap renders nothing rather than an empty box',
  await page.locator('#pkCard .pk-recap').count() === 0);
ok('…and it does not spin forever', await page.locator('#pkCard .pk-recap.loading').count() === 0);
await page.locator('#pkNext').click();
await page.waitForTimeout(300);
txt = await peekText();
ok('and the next', /Stopped Sam/.test(txt));
ok('STOP is the headline, not a footnote', /They texted STOP/.test(txt));
ok('next is disabled at the end', await page.locator('#pkNext').isDisabled());
await page.locator('#pkPrev').click();
await page.waitForTimeout(300);
ok('back goes back', /Rita Cole/.test(await peekText()));
const callsBefore = recapCalls.length;
await page.locator('#pkPrev').click();
await page.waitForTimeout(400);
ok('stepping back to Dale reuses the recap', /asked about ceramic/.test(await peekText()));
ok('…without paying for a second AI call', recapCalls.length === callsBefore, recapCalls);

section('Easy to close');
await page.locator('#jdScrim').click({ position: { x: 10, y: 10 } });
await page.waitForTimeout(400);
ok('tapping outside closes it', await page.locator('#jdScrim.show').count() === 0);

section('Open is one tap from the summary');
await drag('.conv', -140);
await page.locator('#pkOpen').click();
await page.waitForTimeout(700);
ok('the conversation opened', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('…the one being peeked', (await page.locator('#hName').innerText()).includes('Dale'));

section('Nothing broke');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
