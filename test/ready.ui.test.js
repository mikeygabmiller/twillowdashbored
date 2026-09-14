// Readiness on the screen, plus the two surfaces it had to fix to be worth
// anything: the Home rundown, and the card you get from a long-press.
//
// The complaint this shipped against was specific. The rundown had become
// unreadable because the follow-up engine outnumbers real work roughly thirty
// to one, so he stopped looking at it — and the long-press card told him things
// but let him do nothing, so every path out of it went through "Open", which
// marks the thread read and loses his place.
//
// So the assertions are mostly about restraint: that follow-ups are counted and
// not listed, that a clean job says nothing at all, and that the new buttons
// never fire /api/thread. A board that cries wolf is the failure mode here, not
// a missing feature.
//
//   npm install && node test/ready.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const DAY = 86400000;
const dstr = (d) => new Date(d).getFullYear() + '-' + String(new Date(d).getMonth() + 1).padStart(2, '0') + '-' + String(new Date(d).getDate()).padStart(2, '0');
const TODAY = dstr(now), TOMORROW = dstr(now + DAY);

// The night this was written, scrubbed of anything identifying.
const rows = [
  { phone: '+12065550001', name: 'Tahoe', status: 'new', unread: 0, lastBody: 'I will have a check for you',
    lastDir: 'in', lastTs: now - 40 * 60000, awaitingReply: false, appointmentAt: now + 4 * 3600000 },
  { phone: '+14255550002', name: 'Russell McGinnis', status: 'new', unread: 1, awaitingReply: true,
    lastBody: "It's gotta be between 9-1:30 when you do it", lastDir: 'in', lastTs: now - 3 * 60000,
    address: '16659 pinnacle rd se', city: 'Monroe', appointmentAt: now + DAY },
  // Quoted, never got a date — the bucket that never had a name.
  { phone: '+12065550003', name: 'Meghan Watson', status: 'new', quoteAt: now - 2 * DAY, quoteTotal: 300,
    lastBody: 'Ok sounds good!', lastDir: 'in', lastTs: now - 2 * DAY, awaitingReply: false, address: '1624 23rd street' },
  { phone: '+12535550004', name: 'Shana Hainzinger', status: 'new', dateRequested: true,
    lastBody: 'Perfect, thank you!', lastDir: 'out', lastTs: now - DAY },
  // Six stale follow-up ideas, shaped the way the real ones are: a review link
  // he sent in July that nobody replied to, which the engine will keep offering
  // to chase forever. These are what buried the list.
  ...[5, 6, 7, 8, 9, 10].map((n) => ({
    phone: '+1425555000' + n, name: 'Old Lead ' + n, status: 'won', followupDue: true,
    awaitingReply: false,
    fu: { reason: 'Ask for a review', urgency: 'normal', draft: 'hey!' },
    lastBody: "Here's that review link: https://g.page/r/x/review", lastDir: 'out', lastTs: now - 50 * DAY,
  })),
];

// What the server hands back now: every job carries its own blockers.
const todayJobs = [{
  id: 'b:1', source: 'booking', name: 'Tahoe', phone: '+12065550001', address: '', addressGuess: '',
  city: '', slot: '14:00', at: now + 4 * 3600000, durationMin: 180, price: 0, state: 'queued',
  service: 'Full detail', vehicle: 'Tahoe', pending: false, mapQuery: '', date: TODAY,
  ready: false, blockers: [{ code: 'no_address', level: 'stop', text: 'No address, and this is in 4 hours', fix: 'Ask them where to go' }],
}];
const tomorrowJobs = [{
  id: 'b:2', source: 'booking', name: 'Russell McGinnis', phone: '+14255550002', address: '16659 pinnacle rd se',
  city: 'Monroe', slot: '13:00', at: now + DAY, durationMin: 210, price: 320, state: 'queued',
  service: 'Full detail', vehicle: 'Escalade', pending: false, mapQuery: '16659 pinnacle rd se, Monroe, WA', date: TOMORROW,
  ready: false, blockers: [{ code: 'window', level: 'stop', text: 'They need you done by 1:30pm — this runs to 4:30pm', fix: 'Start by 10am' }],
}];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 }, hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const threadHits = [], calls = [];
let emptyDay = false;   // flipped at the end, to prove a clean board is silent
const dayHits = [];     // which dates Home actually paid for
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/threads') {
    const want = u.searchParams.get('phone');
    if (want) threadHits.push(want);
    return json({ ok: true, threads: rows, config: {} });
  }
  if (p === '/api/thread') { threadHits.push(u.searchParams.get('phone')); return json({ ok: true, thread: {} }); }
  if (p === '/api/call') { calls.push(1); return json({ ok: true }); }
  if (p === '/api/ai/recap') return json({ ok: true, recap: '' });
  if (p === '/api/money') return json({ ok: true, month: TODAY.slice(0, 7), today: TODAY, entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') {
    const d = u.searchParams.get('date') || TODAY;
    dayHits.push(d);
    const jobs = emptyDay ? [] : (d === TOMORROW ? tomorrowJobs : todayJobs);
    return json({ ok: true, date: d, jobs, manual: [], order: [],
      summary: { total: jobs.length, done: 0, remaining: jobs.length, booked: 0, earned: 0, hours: 3, stops: jobs.length, notReady: jobs.length, checks: 0 } });
  }
  if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1400);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const homeText = () => page.locator('.home').innerText();

section('Not ready to roll — the block that would have caught both of them');
ok('the block is on Home', await page.locator('.rdy').count() === 1);
ok('it is headed by what it is', (await page.locator('.rdy .rd-head').innerText()).includes('Not ready to roll'));
ok('it counts the job in front of him', (await page.locator('.rdy .rd-n').innerText()).trim() === '1');
const rdy = await page.locator('.rdy').innerText();
ok('the Tahoe address is named as the problem', /No address, and this is in 4 hours/.test(rdy), rdy);
ok('with what to do about it', /Ask them where to go/.test(rdy));
ok('it is stamped with the day it falls on', /Today/.test(rdy));
ok('it reads as a stop, not a suggestion', await page.locator('.rdy .rd-b.stop').count() === 1);
// The wind-down card's rule, kept: a working day pays for one /api/day, not two.
ok("tomorrow is not fetched while there is still a stop to make", !dayHits.includes(TOMORROW), dayHits);
ok("so tomorrow's job is not on the board yet", !/Russell McGinnis/.test(rdy), rdy);
ok('a stop is not painted the same as a check', await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('.rd-b.stop')).color;
  const el = document.querySelector('.rd-b.check');
  return !el || getComputedStyle(el).color !== s;
}));
ok('tapping a job goes to that conversation', await page.locator('.rd-job[data-open="+12065550001"]').count() === 1);

section('...and it rides along on the stop he is about to drive to');
ok('the next-stop card carries the blocker', await page.locator('.next-card .nx-chip.stop').count() >= 1);
ok('in the same words', /No address, and this is in 4 hours/.test(await page.locator('.next-card').innerText()));

section('Needs your attention, grouped by what the next move actually is');
const needs = await page.locator('.needs').innerText();
ok('"Waiting on your reply" is its own group', /WAITING ON YOUR REPLY/i.test(needs), needs);
ok('"Needs a date from you" finally has a name', /NEEDS A DATE FROM YOU/i.test(needs), needs);
ok('Russell is in the reply group', needs.indexOf('Russell McGinnis') < needs.indexOf('NEEDS A DATE'));
ok('the quoted lead is in the date group', /Meghan Watson/.test(needs));
ok('and is told why she is there', /Quoted \$300 · no date set/.test(needs), needs);
ok('so is the one who asked when you are free', /Asked when you're free/.test(needs));
ok('the count is real work only, not the follow-up pile', (await page.locator('.needs .nd-h-n').innerText()).trim() === '3');

section('Follow-ups: counted, kept, and no longer allowed to bury the list');
ok('none of the six are listed as rows', !/Old Lead/.test(needs), needs);
ok('they are summarised on one line', await page.locator('.nd-fu').count() === 1);
ok('with an honest count', /6 follow-up ideas from the app/.test(await page.locator('.nd-fu').innerText()));
ok('and it sits at the bottom, under the real work', await page.evaluate(() => {
  const fu = document.querySelector('.nd-fu').getBoundingClientRect().top;
  const rows = [...document.querySelectorAll('.needs .nd-row')];
  return rows.every((r) => r.getBoundingClientRect().top < fu);
}));
ok('it reads as quiet, not as an alert', await page.evaluate(() => {
  const c = getComputedStyle(document.querySelector('.nd-fu')).color;
  const h = getComputedStyle(document.querySelector('.needs .nd-h-n')).backgroundColor;
  return c !== h;
}));

section("Once today is finished, tomorrow comes into range — and catches Russell");
todayJobs[0].state = 'done';
await page.reload();
await page.waitForTimeout(1600);
ok('tomorrow is fetched now that the day is over', dayHits.includes(TOMORROW), dayHits);
const rdy2 = await page.locator('.rdy').innerText();
ok("Russell's arithmetic is spelled out", /done by 1:30pm — this runs to 4:30pm/.test(rdy2), rdy2);
ok('with the start that would fit', /Start by 10am/.test(rdy2));
ok('stamped tomorrow', /Tomorrow/.test(rdy2));
ok("and the finished job stops being nagged about", !/No address/.test(rdy2), rdy2);

section('The long-press card can now do the things it used to only describe');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(400);
const before = threadHits.length;
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.conv')].find((n) => n.innerText.includes('Russell'));
  const b = node.getBoundingClientRect();
  const t = (cx) => ({ touches: [{ clientX: cx, clientY: b.y + b.height / 2 }], changedTouches: [{ clientX: cx, clientY: b.y + b.height / 2 }] });
  const fire = (name, cx) => { const ev = new Event(name, { bubbles: true }); Object.assign(ev, t(cx)); node.dispatchEvent(ev); };
  const x = b.x + b.width / 2;
  fire('touchstart', x);
  for (let i = 1; i <= 6; i++) fire('touchmove', x - (90 * i) / 6);
  fire('touchend', x - 90);
});
await page.waitForTimeout(600);
ok('the card is up', await page.locator('#pkCard').count() === 1);
const pk = await page.locator('#pkCard').innerText();
ok('it shows his readiness problem', /done by 1:30pm/.test(pk), pk);
ok('stamped with when the job is', /Tomorrow/.test(pk));
ok('and the fix', /Start by 10am/.test(pk));
ok('four things he can do without opening anything', await page.locator('.pk-d').count() === 4);
ok('Navigate is live because there is an address', !(await page.locator('.pk-d[data-pk="nav"]').isDisabled()));
ok('Call is there', await page.locator('.pk-d[data-pk="call"]').count() === 1);
ok('Remind me is there', await page.locator('.pk-d[data-pk="remind"]').count() === 1);
ok('Archive is there', await page.locator('.pk-d[data-pk="archive"]').count() === 1);
ok('and none of it loaded the thread', threadHits.length === before, threadHits.slice(before));

section('Navigate stays dark when there is nowhere to go');
// Shana has no address on her row, so the button has nothing to point at.
await page.evaluate(() => {
  const node = [...document.querySelectorAll('.conv')].find((n) => n.innerText.includes('Shana'));
  const b = node.getBoundingClientRect();
  const t = (cx) => ({ touches: [{ clientX: cx, clientY: b.y + b.height / 2 }], changedTouches: [{ clientX: cx, clientY: b.y + b.height / 2 }] });
  const fire = (name, cx) => { const ev = new Event(name, { bubbles: true }); Object.assign(ev, t(cx)); node.dispatchEvent(ev); };
  const x = b.x + b.width / 2;
  fire('touchstart', x);
  for (let i = 1; i <= 6; i++) fire('touchmove', x - (90 * i) / 6);
  fire('touchend', x - 90);
});
await page.waitForTimeout(600);
ok('the card is showing her', /Shana/.test(await page.locator('#pkCard').innerText()));
ok('Navigate is disabled', await page.locator('.pk-d[data-pk="nav"]').isDisabled());
ok('but Call still works — you can always ring somebody', !(await page.locator('.pk-d[data-pk="call"]').isDisabled()));
ok('and she has no readiness problem to report', await page.locator('#pkCard .pk-blk').count() === 0);
ok('still nothing marked read', threadHits.length === before, threadHits.slice(before));

section('Call goes out without opening the thread');
page.once('dialog', (d) => d.accept());
await page.locator('.pk-d[data-pk="call"]').click();
await page.waitForTimeout(400);
ok('the call was placed', calls.length === 1, calls.length);
ok('and the thread was still never loaded', threadHits.length === before, threadHits.slice(before));

section('A clean board says nothing at all');
emptyDay = true;
await page.reload();
await page.waitForTimeout(1400);
ok('no readiness block when every job is fine', await page.locator('.rdy').count() === 0);
ok('Home did not break without one', await page.locator('.home').count() === 1);

ok('no page errors anywhere in that', errs.length === 0, errs);
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
await browser.close();
process.exit(fail ? 1 : 0);
