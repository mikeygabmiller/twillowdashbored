// The Journey screen. A timeline is only worth anything if it reads as one
// story, so this drives it the way Mikey would — open the tab, tap a visitor,
// read the line — and checks the things that make it a story rather than a log:
// the steps are in order, an anonymous visitor is named as one, and expanding a
// second card doesn't refetch the first.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), min = 60000;

const JOURNEYS = [
  { vid: 'v-sarah', at: now - 2 * min,  first: now - 30 * min, steps: 11, pages: 3, acts: 8,
    phone: '+14255550123', name: 'Sarah Reed', last: 'Tapped to CALL', ref: 'google.com', hot: 'Tapped to CALL' },
  { vid: 'v-ghost', at: now - 40 * min, first: now - 45 * min, steps: 3, pages: 2, acts: 1,
    phone: '', name: '', last: '/services/', ref: '', hot: '' },
];
const SARAH = {
  ok: true, vid: 'v-sarah', phone: '+14255550123', name: 'Sarah Reed',
  hasWeb: true, hasThread: true, pages: 3, acts: 6, firstAt: now - 30 * min, lastAt: now - 2 * min,
  steps: [
    { t: now - 30 * min, kind: 'found',   title: 'Found you on Google', detail: '' },
    { t: now - 30 * min, kind: 'page',    title: 'Home page', detail: '/', page: '/' },
    { t: now - 29 * min, kind: 'section', title: 'Scrolled to Quick Quote Calculator', detail: '', page: '/' },
    { t: now - 29 * min, kind: 'click',   title: 'Pushed "See all services"', detail: '#allservices', page: '/' },
    { t: now - 28 * min, kind: 'page',    title: 'Ceramic Coating Snohomish County', detail: '/ceramic-coating-snohomish-county/', page: '/ceramic-coating-snohomish-county/' },
    { t: now - 27 * min, kind: 'section', title: 'Scrolled to What it costs', detail: '', page: '/ceramic-coating-snohomish-county/' },
    { t: now - 26 * min, kind: 'form',    title: 'Quote form — step 2', detail: 'Your vehicle', page: '/' },
    { t: now - 26 * min, kind: 'contact', title: 'Tapped to CALL', detail: '(425) 600-7897', page: '/' },
    { t: now - 25 * min, kind: 'exit',    title: 'Left the page', detail: '184s · 86% down', page: '/' },
    { t: now - 25 * min, kind: 'lead',    title: 'Left their number', detail: 'Filled out the form on your site' },
    { t: now - 20 * min, kind: 'them',    title: 'They texted 2 times', detail: 'hey is that price for an SUV?' },
    { t: now - 18 * min, kind: 'you',     title: 'You replied', detail: 'Hey Sarah — yes, $240 covers it.' },
    { t: now - 10 * min, kind: 'quote',   title: 'You sent a quote', detail: '$240 · Full Detail' },
    { t: now - 2 * min,  kind: 'booked',  title: 'Booked in', detail: '' },
  ],
};
const GHOST = {
  ok: true, vid: 'v-ghost', phone: '', name: '', hasWeb: true, hasThread: false, pages: 3, acts: 0,
  firstAt: now - 45 * min, lastAt: now - 40 * min,
  steps: [
    { t: now - 45 * min, kind: 'found', title: 'Came straight to you', detail: '' },
    { t: now - 45 * min, kind: 'page',  title: 'Home page', detail: '/' },
    { t: now - 42 * min, kind: 'page',  title: 'Services', detail: '/services/' },
  ],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

let listCalls = 0;
const oneCalls = {};
const aiCalls = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/journeys') { listCalls++; return json({ ok: true, journeys: JOURNEYS, total: 2, named: 1 }); }
  if (p === '/api/journey') {
    const vid = u.searchParams.get('vid');
    oneCalls[vid] = (oneCalls[vid] || 0) + 1;
    return json(vid === 'v-sarah' ? SARAH : GHOST);
  }
  if (p === '/api/journey/ai') {
    aiCalls.push(JSON.parse(route.request().postData() || '{}'));
    return json({ ok: true, read: 'They came for ceramic and priced it twice before calling.', visitors: 2, scope: 'all' });
  }
  if (p === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (p === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-24', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') return json({ ok: true, date: '2026-08-24', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('It opens from the command bar, by name');
await page.locator('#search').fill('journey');
await page.waitForTimeout(300);
await page.locator('.fx-row').first().click();
await page.waitForTimeout(600);
ok('the Analytics shell is showing', await page.locator('#growApp.show').count() === 1);
ok('on the Journey segment', await page.locator('#grNav [data-gv="journey"].active').count() === 1);
ok('titled for what it is', (await page.locator('#grTitle').textContent()).trim() === 'Journey');
ok('it asked the server once', listCalls === 1, listCalls);

section('The board names a stranger like a person');
const cards = page.locator('.jn-card');
ok('both visitors are listed', await cards.count() === 2, await cards.count());
ok('the customer shows by name', (await cards.nth(0).locator('.jn-meta b').textContent()).trim() === 'Sarah Reed');
ok('the anonymous one is "Someone new", not a hex id',
  (await cards.nth(1).locator('.jn-meta b').textContent()).trim() === 'Someone new',
  await cards.nth(1).locator('.jn-meta b').textContent());
ok('the known one is marked as known', await cards.nth(0).evaluate((n) => n.classList.contains('known')));
ok('the stranger is not', await cards.nth(1).evaluate((n) => !n.classList.contains('known')));
ok('the tiles count who converted', /1/.test(await page.locator('.wa-tile').nth(1).locator('.t-v').textContent()));

section('Tapping a visitor replays what they did');
await cards.nth(0).locator('.jn-head').click();
await page.waitForTimeout(500);
const steps = page.locator('.jn-card.on .jn-step');
ok('every step is drawn', await steps.count() === 14, await steps.count());
const titles = await steps.locator('.jn-t').allTextContents();
ok('it starts with how they found you', /Google/.test(titles[0]), titles[0]);
ok('the browsing comes before the texting',
  titles.findIndex((t) => /Ceramic/.test(t)) < titles.findIndex((t) => /They texted/.test(t)), titles);
ok('the moment they became a lead is on the line', titles.some((t) => /Left their number/.test(t)), titles);
ok('so is the quote', titles.some((t) => /sent a quote/.test(t)), titles);
ok('a run of texts reads as one step', titles.filter((t) => /They texted/.test(t)).length === 1, titles);
ok('their words are shown, not just the count',
  (await steps.locator('.jn-d').allTextContents()).some((d) => /SUV/.test(d)));

section('The line is colour-coded by who was doing the work');
ok('their texts are marked as theirs', await page.locator('.jn-card.on .jn-step.jn-k-t').count() === 1);
ok('yours as yours', await page.locator('.jn-card.on .jn-step.jn-k-y').count() === 1);
ok('the kind class never collides with the title class',
  await page.locator('.jn-card.on .jn-step.jn-k-t .jn-t').count() === 1);

section('Every action shows, nested under the page it happened on');
const allTitles = await page.locator('.jn-card.on .jn-step .jn-t').allTextContents();
ok('a section they scrolled to is on the line', allTitles.some((t) => /Scrolled to Quick Quote/.test(t)), allTitles);
ok('a button they pushed is on the line', allTitles.some((t) => /Pushed "See all services"/.test(t)), allTitles);
ok('a form step is on the line', allTitles.some((t) => /Quote form — step 2/.test(t)), allTitles);
ok('so is how far down they got', (await page.locator('.jn-card.on .jn-step .jn-d').allTextContents()).some((d) => /86% down/.test(d)));
ok('in-page actions are indented', await page.locator('.jn-card.on .jn-step.jn-in').count() === 6, await page.locator('.jn-card.on .jn-step.jn-in').count());
ok('pages are NOT indented', await page.locator('.jn-card.on .jn-step.jn-k-p.jn-in').count() === 0);
ok('a tap-to-call is marked as the loud one', await page.locator('.jn-card.on .jn-step.jn-k-c').count() === 1);
ok('the headline counts pages, actions and minutes',
  /3 pages · 6 actions · \d+ min/.test(await page.locator('.jn-card.on .jn-sum').textContent()),
  await page.locator('.jn-card.on .jn-sum').textContent());

section('The board flags the loud ones from the list');
ok('a tap-to-call shows as a badge', (await page.locator('.jn-card').nth(0).locator('.jn-hot').textContent()).trim() === 'Tapped to CALL');
ok('a quiet visit has no badge', await page.locator('.jn-card').nth(1).locator('.jn-hot').count() === 0);
ok('rows say pages and actions', /2 pages · 1 action/.test(await page.locator('.jn-card').nth(1).locator('.jn-meta small').textContent()),
  await page.locator('.jn-card').nth(1).locator('.jn-meta small').textContent());

section('Re-opening a card does not re-fetch it');
await page.locator('.jn-card').nth(0).locator('.jn-head').click();   // collapse
await page.waitForTimeout(300);
ok('collapsing closes it', await page.locator('.jn-card.on').count() === 0);
await page.locator('.jn-card').nth(0).locator('.jn-head').click();   // re-open
await page.waitForTimeout(400);
ok('the replay was cached', oneCalls['v-sarah'] === 1, oneCalls);
ok('and it still draws from the cache', await page.locator('.jn-card.on .jn-step').count() === 14, await page.locator('.jn-card.on .jn-step').count());

section('A visitor who never texted is a journey too');
await page.locator('.jn-card').nth(1).locator('.jn-head').click();
await page.waitForTimeout(500);
ok('their pages are replayed', await page.locator('.jn-card.on .jn-step').count() === 3, await page.locator('.jn-card.on .jn-step').count());
ok('with no actions to show', await page.locator('.jn-card.on .jn-step.jn-in').count() === 0);
ok('fetched once', oneCalls['v-ghost'] === 1, oneCalls);
ok('only one card is open at a time', await page.locator('.jn-card.on').count() === 1);
ok('and there is no conversation to open', await page.locator('[data-jn-phone]').count() === 0);

section('It gets you back to the actual conversation');
await page.locator('.jn-card').nth(0).locator('.jn-head').click();
await page.waitForTimeout(400);

section('You can ask the AI what people are doing');
ok('there is a read-everyone button', await page.locator('#jnAiAll').count() === 1);
await page.locator('#jnAiAll').click();
await page.waitForTimeout(600);
ok('it asked for the whole board, not one visitor', aiCalls.length === 1 && aiCalls[0].vid === '', aiCalls);
ok('the answer is shown', /priced it twice/.test(await page.locator('.wa-ai').textContent()));
ok('one visitor can be read on their own', await page.locator('[data-jn-ai]').count() >= 1);
await page.locator('[data-jn-ai]').first().click();
await page.waitForTimeout(600);
ok('and that call carries the vid', aiCalls.length === 2 && aiCalls[1].vid === 'v-sarah', aiCalls);

ok('there is a way into the thread', await page.locator('[data-jn-phone]').count() === 1);
await page.locator('[data-jn-phone]').click();
await page.waitForTimeout(500);
ok('tapping it leaves Analytics', await page.locator('#growApp.show').count() === 0);

section('The "saw the price and left" email opens straight onto that visitor');
// There is no thread to jump to — they never left a number — so the link in
// that alert has to land on the one thing that exists: their path.
oneCalls['v-ghost'] = 0;
await page.goto('https://texting.test/?journey=v-ghost');
await page.waitForTimeout(900);
ok('Analytics opened on Journey', await page.locator('#growApp.show').count() === 1 &&
  await page.locator('#grNav [data-gv="journey"].active').count() === 1);
ok('their card is already expanded', await page.locator('.jn-card.on').count() === 1);
ok('and it is the right one', await page.locator('.jn-card.on [data-jn-ai]').first().getAttribute('data-jn-ai') === 'v-ghost');
ok('their steps were fetched', oneCalls['v-ghost'] === 1, oneCalls);
ok('the vid is scrubbed out of the address bar', !/journey=/.test(page.url()), page.url());

section('No console noise');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
