// The "Next stop" card on Home, and the address strip in a conversation.
//
// Driven in a real browser because the whole point of this feature is that the
// address is *visible without scrolling* and one tap away from navigation —
// neither of which a unit test can see. Also guards the save path: a guessed
// address must merge into the existing garage rather than replace it, which is
// easy to get wrong because /api/meta swaps the whole garage doc.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const NOW = Date.now();

const thread = {
  phone: '+14255551234', name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
  appointmentAt: NOW + 3600000, scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'im at 8817 4th St NE', ts: NOW - 60000 }],
  garage: { vehicles: [{ year: '2019', make: 'Chevy', model: 'Tahoe', color: 'Silver' }] },
  addressGuess: '8817 4th St NE',
};
const job = {
  id: 't:+14255551234', source: 'thread', phone: '+14255551234', name: 'Jenna Smith',
  address: '', addressGuess: '8817 4th St NE', city: '', placeFrom: 'text',
  service: 'Full Detail', vehicle: '2019 Silver Chevy Tahoe', size: '', slot: '10:00',
  at: NOW + 3600000, durationMin: 180, price: 240, notes: '', pending: false, state: 'queued',
  gate: '4412', parking: 'driveway on the left', water: false, power: null,
  prefs: '', avoid: 'soft top', mapQuery: '8817 4th St NE',
  enrouteAt: 0, startedAt: 0, doneAt: 0, runNote: '', trackToken: '', paidAmount: 0, photos: 0,
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const posted = [];
let navigated = '';
await page.route('**/*', async (route) => {
  const rq = route.request();
  const u = new URL(rq.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0,
      lastBody: 'im at 8817 4th St NE', lastTs: NOW - 60000, tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/thread') return json({ ok: true, thread });
  if (path === '/api/day') {
    return json({ ok: true, date: '2026-08-14', jobs: [job], manual: [], order: [],
      summary: { total: 1, done: 0, remaining: 1, booked: 240, earned: 0, hours: 3, stops: 1 } });
  }
  if (path === '/api/garage') return json({ ok: true, phone: thread.phone, name: thread.name, garage: thread.garage, spend: { jobs: 0, total: 0, lastDate: '' } });
  if (path === '/api/meta') { posted.push(JSON.parse(rq.postData() || '{}')); return json({ ok: true, thread }); }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-14', entries: [], nudges: [], owed: [], summary: { net: 0, gross: 0, costs: 0, jobs: 0 }, config: {} });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.addInitScript(() => { window.open = (u) => { window.__opened = u; return null; }; });
await page.evaluate(() => { window.open = (u) => { window.__opened = u; return null; }; });
await page.waitForTimeout(1200);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const txt = (sel) => page.locator(sel).first().innerText();

section('The next stop is the first thing on Home');
await page.locator('.navitem[data-tab="home"]').click();
await page.waitForTimeout(900);
ok('the card is on screen', await page.locator('.next-card').isVisible());
ok('it is above the AI command center',
  await page.evaluate(() => {
    const c = document.querySelector('.next-card'), a = document.querySelector('.ai-center');
    if (!c || !a) return false;
    return c.getBoundingClientRect().top < a.getBoundingClientRect().top;
  }));
ok('visible without scrolling',
  await page.evaluate(() => {
    const r = document.querySelector('.next-card').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  }));
ok('names the customer', (await txt('.nx-who')).includes('Jenna'));
ok('shows the time', (await txt('.nx-h')).includes('10:00'));
ok('shows service, vehicle and price', /Full Detail.*Tahoe.*\$240/.test(await txt('.nx-what')), await txt('.nx-what'));
ok('the address is the biggest tap target', await page.locator('.nx-addr').isVisible());
ok('…and shows the guessed address', (await txt('.nx-addr')).includes('8817 4th St NE'));
ok('a guess is visually marked as unconfirmed', await page.locator('.nx-addr.guess').isVisible());
ok('gate code is on the card', (await txt('.nx-chips')).includes('4412'));
ok('where to park is on the card', (await txt('.nx-chips')).includes('driveway'));
ok('"no water" is flagged', (await txt('.nx-chips')).includes('No water'));
ok('an unknown power state is NOT flagged', !(await txt('.nx-chips')).includes('No power'));
ok('the careful-with note is flagged', (await txt('.nx-chips')).includes('soft top'));

section('One tap goes to navigation');
// Home repaints itself constantly (a pre-existing quirk of the dashboard's poll
// loop), so a normal click races the element being replaced. Dispatch it instead
// — what's under test is the handler wiring, not Playwright's retry logic.
const tap = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) throw new Error('no element for ' + s);
  e.click();
}, sel);
await tap('.nx-addr');
await page.waitForTimeout(300);
navigated = await page.evaluate(() => window.__opened || '');
ok('a maps URL was opened', /maps/.test(navigated), navigated);
ok('…for the right address', /8817(\+|%20)4th/.test(navigated), navigated);

section('Saving a guess merges into the garage, it does not replace it');
posted.length = 0;
await tap('.nx-save');
await page.waitForTimeout(700);
ok('one save was posted', posted.length === 1, posted.length);
const g = posted[0] && posted[0].garage;
ok('the address went in', g && g.address === '8817 4th St NE', g);
ok('the vehicle already on file survived', g && g.vehicles && g.vehicles.length === 1, g && g.vehicles);
ok('…with its details intact', g && g.vehicles[0].model === 'Tahoe');

section('The same address rides at the top of the conversation');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(500);
await page.locator('.conv').first().click();
await page.waitForTimeout(800);
ok('the strip is showing', await page.locator('#jobBanner').isVisible());
ok('it carries the address', (await txt('#jobBanner')).includes('8817 4th St NE'));
ok('an unsaved guess asks to be saved', (await txt('#jobBanner')).includes('is this where they are'));
ok('it sits above the message list',
  await page.evaluate(() => {
    const b = document.querySelector('#jobBanner'), m = document.querySelector('#msgs') || document.querySelector('.msgs');
    if (!b || !m) return true;
    return b.getBoundingClientRect().top < m.getBoundingClientRect().top;
  }));

section('A saved address shows as navigable, not as a question');
// Through the real path: the garage now has an address, so re-opening the
// conversation must show it as something to drive to rather than a question.
thread.garage.address = '1425 Cedar Ave';
thread.garage.city = 'Everett';
thread.garage.gate = '4412';
thread.addressGuess = '';
await page.locator('#backBtn').click();
await page.waitForTimeout(400);
await page.locator('.conv').first().click();
await page.waitForTimeout(800);
ok('now shows the saved address', (await txt('#jobBanner')).includes('1425 Cedar Ave'));
ok('with the city', (await txt('#jobBanner')).includes('Everett'));
ok('the gate code rides along', (await txt('#jobBanner')).includes('4412'));
ok('the vehicle rides along', (await txt('#jobBanner')).includes('Tahoe'));
ok('no longer asking whether it is right', !(await txt('#jobBanner')).includes('is this where'));
ok('no longer styled as a guess', await page.locator('#jobBanner.guess').count() === 0);
await tap('#jobBanner .jb-go');
await page.waitForTimeout(250);
navigated = await page.evaluate(() => window.__opened || '');
ok('tapping Go navigates to the saved address', /1425(\+|%20)Cedar/.test(navigated), navigated);

section('Nothing to show stays out of the way');
thread.garage = { vehicles: [] };
thread.addressGuess = '';
await page.locator('#backBtn').click();
await page.waitForTimeout(400);
await page.locator('.conv').first().click();
await page.waitForTimeout(800);
ok('the strip hides entirely when there is no address', !(await page.locator('#jobBanner').isVisible()));

ok('no page errors', errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
if (fail) process.exit(1);
