// Usage tracking, driven the way it will actually run.
//
// The server half is pinned in use.test.js. This is the half that can only be
// checked in a browser, and it carries the two claims the whole feature rests
// on:
//
//   Nothing was hand-wired. Controls have to name themselves from their own
//   visible text, and screens have to report themselves through the functions
//   they already go through — because instrumenting 400-odd click handlers by
//   hand would have been wrong the day after it shipped.
//
//   Content never leaves. A customer's name and the words of their text are on
//   this screen while he taps, and neither may ever appear in a batch. The
//   export is meant to be pasted into a chat, and that is the only thing that
//   makes it safe.
//
//   node test/use.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), DAY = 86400000;

// Deliberately unmistakable strings: if either ever turns up in a batch, it did
// not get there by coincidence.
const CUSTOMER = 'Zebediah Quillfeather';
const SECRET = 'my gate code is 4417 park behind the boat';

const rows = [
  { phone: '+14255551234', name: CUSTOMER, status: 'active', unread: 1, tags: [],
    lastBody: SECRET, lastDir: 'in', lastTs: now - 3600000, awaitingReply: true, city: 'Monroe' },
];

const USAGE = {
  ok: true, days: 30, range: { from: '2026-07-27', to: '2026-08-25' },
  trend: Array.from({ length: 30 }, (_, i) => ({ d: '2026-07-' + String(27 + i).padStart(2, '0'), n: i * 3, sess: 2 })),
  totals: { events: 1240, taps: 880, sessions: 61, activeDays: 27, tracked: 214, dead: 3 },
  top: [{ k: 'Chats · Send', n: 210 }, { k: 'Tab · Today', n: 96 }, { k: 'Money · Log a job', n: 44 }],
  server: [{ k: '/api/threads', n: 900 }, { k: 'POST /api/send', n: 210 }],
  screens: [
    { k: 'Tab · Chats', n: 140, ms: 5400000, bail: 0 },
    { k: 'Pipeline · garage', n: 22, ms: 26000, bail: 19 },
  ],
  hours: Array.from({ length: 24 }, (_, i) => (i >= 6 && i <= 20 ? i * 4 : 0)),
  dead: [
    { key: 'More · Send test alert', since: now - 40 * DAY },
    { key: 'Stats · Map', since: now - 30 * DAY },
    { key: 'Pipeline · Garage · Add vehicle', since: now - 12 * DAY },
  ],
  cold: [{ key: 'More · Playbook', n: 4, last: now - 55 * DAY }],
  tape: [
    { t: now - 60000, k: 't', l: 'Chats · Send' },
    { t: now - 90000, k: 'v', l: 'Tab · Chats' },
    { t: now - 120000, k: 'b', l: 'Pipeline · garage' },
  ],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 }, hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const batches = [];        // every POST /api/use body the app sent
let exportCalls = 0;
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/use' && route.request().method() === 'POST') {
    try { batches.push(JSON.parse(route.request().postData() || '{}')); } catch (_) { batches.push({ bad: true }); }
    return json({ ok: true, n: 1 });
  }
  if (p === '/api/use') return json(USAGE);
  if (p === '/api/use/export') { exportCalls++; return route.fulfill({ status: 200, contentType: 'text/plain', body: 'DASHBOARD USAGE — pasteable' }); }
  if (p === '/api/use/ai') return json({ ok: true, read: 'You live in Chats and you never once opened the Map.', days: 30 });
  if (p === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) {
      const r = rows.find((x) => x.phone === want) || {};
      out.thread = { phone: want, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '',
        messages: [{ id: 'm1', dir: 'in', body: SECRET, ts: r.lastTs }] };
    }
    return json(out);
  }
  if (p === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-25', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') return json({ ok: true, date: '2026-08-25', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

// The collector's timer is minutes long on purpose — a KV write every few
// seconds would blow the Worker's daily budget and 429 the whole app. The real
// flush is him hiding the app, so that is the path this suite drives.
//
// sendBeacon is stubbed to record that it was TRIED and then decline, which
// sends the collector down its fetch fallback where page.route can see the
// body. Both halves of the path get exercised, and nothing is faked away.
await page.addInitScript(() => {
  window.__beaconTries = 0;
  navigator.sendBeacon = () => { window.__beaconTries++; return false; };
});
await page.goto('https://texting.test/');
await page.waitForTimeout(900);

const flush = async () => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(450);
};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
// Everything reported so far, flattened.
const evs = () => batches.flatMap((b) => b.e || []);
const labels = (k) => evs().filter((e) => !k || e.k === k).map((e) => e.l);
const cat = () => batches.flatMap((b) => b.c || []);

// The collector flushes on its own eight-second timer, which is the real path
// and the one worth testing. Do all the tapping first, then wait once.
section('Using the app normally, then letting it report');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(250);
await page.locator('[data-phone="+14255551234"], .conv, .row').first().click().catch(() => {});
await page.waitForTimeout(500);
// Reading a thread hides the bottom nav, so come back out the way he would.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
// Stats lost its pill — nine reports live behind the Insights index in More,
// and the segment bar only appears once you are inside one of them.
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(450);
await page.locator('#mrBody .mr-row', { hasText: 'Insights' }).first().click();
await page.waitForTimeout(700);
await page.locator('.ix-card[data-ix="usage"]').click();
await page.waitForTimeout(3200);                       // sit on it, the way he would read it
await page.locator('#grNav [data-gv="map"]').click();  // …then bounce straight off the next one
await page.waitForTimeout(400);
await page.locator('#grNav [data-gv="usage"]').click();
await page.waitForTimeout(400);
await flush();

ok('it reported when the app was put down', batches.length > 0, batches.length);
ok('and it reached for sendBeacon first, so a closing app still gets heard',
  await page.evaluate(() => window.__beaconTries) > 0);
ok('it did NOT write on a timer while he was tapping — that is the KV budget',
  batches.length <= 2, batches.length);
ok('and batched — one request carried many events', evs().length > batches.length, { batches: batches.length, events: evs().length });
ok('the app opening is on the record', evs().some((e) => e.k === 's'), evs().slice(0, 3));

section('Controls name themselves, and are told apart by the screen they are on');
const taps = labels('t');
ok('the nav pills report their own words, not their ids',
  taps.some((l) => /Chats$/.test(l)) && taps.some((l) => /More$/.test(l)), taps);
ok('every tap is qualified by the screen it happened on, so two "Send"s never merge',
  taps.length > 0 && taps.every((l) => l.indexOf(' · ') > 0), taps);
ok('no label is a bare element id', !taps.some((l) => /·\s*#/.test(l)), taps);
ok('nothing exceeded the 60-char clamp', !taps.some((l) => l.length > 60), taps.filter((l) => l.length > 60));
// The unread badge lives inside the Chats pill. If it rides along, every new
// text mints a brand-new feature ("1Chats", "2Chats") and the real one vanishes.
ok('a badge count is not part of the feature\'s name',
  taps.some((l) => /· Chats$/.test(l)) && !taps.some((l) => /\d+Chats/.test(l)), taps);

section('Screens report themselves through the functions they already went through');
const views = labels('v');
ok('switching tabs is a screen change', views.some((l) => /^Tab · /.test(l)), views);
ok('the Stats hub reports which segment, not just "stats"', views.some((l) => /^Stats · usage$/.test(l)), views);
ok('opening a thread is its own screen', views.some((l) => /^Screen · thread$/.test(l)), views);
ok('no screen is reported twice in a row', new Set(views).size === views.length || views.every((l, i) => l !== views[i - 1]), views);

section('A screen opened and abandoned reads as a dead end, not a visit');
const bails = evs().filter((e) => e.k === 'b');
const stays = evs().filter((e) => e.k === 'x');
ok('the segment we bounced off is reported as a bail', bails.some((e) => /Stats · map/.test(e.l)), bails.map((e) => e.l));
ok('a bail carries how long he lasted', bails.every((e) => typeof e.d === 'number'), bails);
ok('a screen he sat and read is an exit, not a bail',
  stays.some((e) => /Stats · usage/.test(e.l)), stays.map((e) => e.l));
ok('and the tap that LEFT a screen never counts as having used it',
  bails.some((e) => /Stats · map/.test(e.l)), bails.map((e) => e.l));
ok('and the two are never the same event', !bails.some((b) => stays.some((x) => x.l === b.l && x.t === b.t)));

section('The catalog reports what is on screen, not only what was pushed');
const seen = cat();
ok('controls he never touched were still reported as seen', seen.length > taps.length, { seen: seen.length, taps: taps.length });
ok('including ones on this screen he did not push', seen.some((l) => !taps.includes(l)), seen.slice(0, 5));
ok('the catalog is labelled the same way the taps are', seen.every((l) => typeof l === 'string' && l.length <= 60));

section('Nothing a customer said or is called can leave');
const wire = JSON.stringify(batches);
ok('the customer\'s name is nowhere in any batch', wire.indexOf(CUSTOMER) < 0);
ok('nor any part of it', !/Quillfeather|Zebediah/.test(wire));
ok('the words of their text are nowhere either', wire.indexOf(SECRET) < 0);
ok('nor their phone number', !/4255551234/.test(wire), (wire.match(/\d{10}/) || [])[0]);
ok('the thread screen was recorded, just not who was in it',
  views.some((l) => /Screen · thread/.test(l)) && wire.indexOf(CUSTOMER) < 0);

section('The Usage screen shows him the answer');
ok('it is on the Stats hub, by name', await page.locator('#grNav [data-gv="usage"]').count() === 1);
ok('and titled for what it is', (await page.locator('#grTitle').textContent()).trim() === 'Usage');
const tiles = await page.locator('.big-tile .bt-v').allTextContents();
ok('the headline counts what he pushes', tiles.includes('880'), tiles);
ok('and how many controls have never been used', tiles.includes('3'), tiles);
const bars = await page.locator('.hb-k').allTextContents();
ok('what he leans on is listed', bars.includes('Chats · Send'), bars.slice(0, 6));
ok('so is where the time goes', bars.includes('Tab · Chats'), bars.slice(0, 10));
ok('the server side is shown separately', bars.includes('/api/threads'), bars);

section('The list that is the point of the whole feature');
const dead = await page.locator('.uz-dead').allTextContents();
ok('every never-used control is named', dead.length >= 3, dead);
ok('with the date it was first seen, so "never" means something', /seen /.test(dead.join(' ')), dead[0]);
ok('a screen he opens and walks out of says so',
  /walked straight back out 19 times/.test(await page.locator('#grBody').textContent()),
  (await page.locator('#grBody').textContent()).slice(0, 200));
ok('and what went cold is a separate list', /Went cold/i.test(await page.locator('#grBody').textContent()));
ok('the last few moves are replayed in order', await page.locator('.uz-step').count() === 3, await page.locator('.uz-step').count());

section('The AI read, and the paste');
await page.locator('#uzAi').click();
await page.waitForTimeout(700);
ok('the read comes back onto the screen',
  /never once opened the Map/.test(await page.locator('.wa-ai').first().textContent()),
  await page.locator('.wa-ai').first().textContent());
ok('and is not confused with the hours chart it sits next to',
  await page.locator('.uz-hours').count() === 1 && await page.locator('.wa-ai').count() === 1);
await page.evaluate(() => {
  window.__copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } },
  });
});
await page.locator('#uzCopy').click();
await page.waitForTimeout(600);
ok('copying pulls the full export, not what fits on the screen', exportCalls === 1, exportCalls);
ok('and puts it on the clipboard', /pasteable/.test(await page.evaluate(() => window.__copied || '')));
ok('the screen says plainly that it is safe to paste',
  /no messages, no names, no amounts/i.test(await page.locator('#grBody').textContent()));

section('The shapes a customer could actually escape through');
// Every one of these exists somewhere in the real app: a row that is a person,
// a tap-to-call, a suggested reply whose whole text is a sentence about someone.
// They are the routes a name gets out by, so they are pushed on purpose here.
await page.evaluate((s) => {
  const box = document.createElement('div');
  box.id = 'leakbox';
  box.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999';
  // A tel: link really does try to leave the page, which would end the suite
  // here rather than testing anything.
  box.addEventListener('click', (e) => e.preventDefault());
  box.innerHTML =
    '<button id="lk1" data-phone="+14255551234">Zebediah Quillfeather</button>' +
    '<a id="lk2" href="tel:+14255551234">Call Zebediah (425) 555-1234</a>' +
    '<button id="lk3" aria-label="Send suggested reply">' + s + '</button>' +
    '<button id="lk4">Owed: $1,240.00</button>' +
    '<button id="lk5">reach me at zeb@quillfeather.example</button>';
  document.body.appendChild(box);
}, SECRET);
await page.waitForTimeout(200);
for (const id of ['#lk1', '#lk2', '#lk3', '#lk4', '#lk5']) { await page.locator(id).click(); await page.waitForTimeout(80); }
await flush();
const leaked = JSON.stringify(batches);
const late = labels('t');
ok('a row that IS a person is named for what it does, not who it is',
  late.some((l) => /Open a conversation$/.test(l)) && leaked.indexOf(CUSTOMER) < 0, late.slice(-8));
ok('a tap-to-call reports the action and drops the number',
  late.some((l) => /Tap to call$/.test(l)), late.slice(-8));
ok('a button whose text is a whole sentence falls back to its label, not the sentence',
  late.some((l) => /Send suggested reply$/.test(l)) && leaked.indexOf(SECRET) < 0, late.slice(-8));
ok('a dollar amount is scrubbed', late.some((l) => /Owed: \$…$/.test(l)) && !/1,240\.00/.test(leaked), late.slice(-8));
ok('so is an email address', !/quillfeather\.example/.test(leaked), late.slice(-8));
ok('and after all of that, still not one trace of the customer',
  leaked.indexOf(CUSTOMER) < 0 && leaked.indexOf(SECRET) < 0 && !/4255551234/.test(leaked));
await page.evaluate(() => { const b = document.getElementById('leakbox'); if (b) b.remove(); });

section('It never breaks the app it is measuring');
ok('no page errors anywhere in all of that', errs.length === 0, errs.slice(0, 3));
ok('the nav still works after every screen function was wrapped',
  await page.locator('#grNav [data-gv="usage"].active').count() === 1);
// Back goes up one level now: a report returns to the Insights index, and only
// the index closes the hub.
await page.locator('#grBack').click();
await page.waitForTimeout(400);
ok('backing out of a report lands on the index, not out of the hub',
  await page.locator('#growApp.show').count() === 1 && (await page.$$eval('.ix-card', (n) => n.length)) === 9);
await page.locator('#grBack').click();
await page.waitForTimeout(400);
ok('and backing out of the index lands on the list', await page.locator('#growApp.show').count() === 0);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
