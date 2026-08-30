// Which of these clicks did I pay for?
//
// The Worker can now tell a Google ad click from a free Google search click
// (adsource.test.js proves that half). This drives the three screens where that
// answer has to actually show up, because a label nobody can see is the same as
// no label: the Journey board, the Website tab's paid-vs-free tiles, and the
// switch that decides whether a landing emails him at all.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), min = 60000;

// Two visitors, one bought and one free — the exact comparison he asked for.
const JOURNEYS = [
  { vid: 'v-paid', at: now - 3 * min, first: now - 20 * min, steps: 7, pages: 2, acts: 4,
    phone: '', name: '', last: '/monroe/', ref: 'google.com', hot: '',
    ad: 'google', camp: 'Snohomish Detailing - Search - 2026', city: 'Seattle, WA',
    found: 'Clicked your Google ad · Snohomish Detailing - Search - 2026' },
  { vid: 'v-free', at: now - 30 * min, first: now - 35 * min, steps: 4, pages: 3, acts: 1,
    phone: '', name: '', last: '/services/', ref: 'google.com', hot: '',
    ad: '', camp: '', city: 'Snohomish, WA', found: 'Found you on Google' },
];
const PAID = {
  ok: true, vid: 'v-paid', phone: '', name: '', hasWeb: true, hasThread: false,
  pages: 2, acts: 4, firstAt: now - 20 * min, lastAt: now - 3 * min,
  ad: 'google', camp: 'Snohomish Detailing - Search - 2026', city: 'Seattle, WA',
  steps: [
    { t: now - 20 * min, kind: 'found', title: 'Clicked your Google ad · Snohomish Detailing - Search - 2026', detail: 'Their phone was in Seattle, WA' },
    { t: now - 20 * min, kind: 'page',  title: 'Home page', detail: '/' },
    { t: now - 18 * min, kind: 'page',  title: 'Monroe', detail: '/monroe/' },
  ],
};
const FREE = {
  ok: true, vid: 'v-free', phone: '', name: '', hasWeb: true, hasThread: false,
  pages: 3, acts: 1, firstAt: now - 35 * min, lastAt: now - 30 * min,
  ad: '', camp: '', city: 'Snohomish, WA',
  steps: [
    { t: now - 35 * min, kind: 'found', title: 'Found you on Google', detail: 'Their phone was in Snohomish, WA' },
    { t: now - 35 * min, kind: 'page',  title: 'Home page', detail: '/' },
  ],
};
const ANALYTICS = {
  ok: true, days: 14, totalViews: 34, totalVisitors: 21, adClicks: 8, freeVisits: 26,
  topAds: [{ k: 'Google', n: 8 }],
  series: [{ day: '2026-08-29', views: 16, visitors: 10, ads: 4 }, { day: '2026-08-30', views: 18, visitors: 11, ads: 4 }],
  topPaths: [{ k: '/', n: 20 }], topRefs: [{ k: 'google.com', n: 12 }], origin: 'https://mikeysdetailing.com',
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

let CONFIG = { clickAlert: 'all', quoteAbandon: true };
const savedConfigs = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/journeys') return json({ ok: true, journeys: JOURNEYS, total: 2, named: 0 });
  if (p === '/api/journey') return json(u.searchParams.get('vid') === 'v-paid' ? PAID : FREE);
  if (p === '/api/analytics') return json(ANALYTICS);
  if (p === '/api/webstats/status') return json({ ok: true, connected: { ga: false, clarity: false } });
  if (p === '/api/webstats') return json({ ok: true, connected: { ga: false, clarity: false }, pixel: ANALYTICS });
  if (p === '/api/config') {
    if (route.request().method() === 'POST') {
      const patch = JSON.parse(route.request().postData() || '{}');
      savedConfigs.push(patch);
      CONFIG = Object.assign({}, CONFIG, patch);
    }
    return json({ ok: true, config: CONFIG });
  }
  if (p === '/api/threads') return json({ ok: true, threads: [], config: CONFIG });
  if (p === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-30', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') return json({ ok: true, date: '2026-08-30', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const closeMore = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#moreApp.show').count())) break;
    await page.locator('#mrBack').click();
    await page.waitForTimeout(250);
  }
};
const openSettings = async () => {
  await closeMore();
  // The Analytics shell sits over the bottom nav; leave it before reaching for
  // a tab, or the click lands on a chart.
  if (await page.locator('#growApp.show').count()) {
    await page.locator('#grBack').click();
    await page.waitForTimeout(400);
  }
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(400);
  await page.getByText('Settings', { exact: true }).first().click();
  await page.waitForTimeout(700);
};

section('The board says which click he paid for');
await page.locator('#search').fill('journey');
await page.waitForTimeout(300);
await page.locator('.fx-row').first().click();
await page.waitForTimeout(700);
const cards = page.locator('.jn-card');
ok('both visitors are listed', await cards.count() === 2, await cards.count());
ok('the paid one is badged', (await cards.nth(0).locator('.jn-paid').textContent()).trim() === 'Google ad',
  await cards.nth(0).locator('.jn-paid').count() ? await cards.nth(0).locator('.jn-paid').textContent() : 'no badge');
ok('the free one is NOT badged', await cards.nth(1).locator('.jn-paid').count() === 0);
ok('the free one is not silently blamed on the ad either',
  /Found you on Google/.test(await cards.nth(1).locator('.jn-meta').innerText()),
  await cards.nth(1).locator('.jn-meta').innerText());
ok('the paid row names the campaign',
  /Snohomish Detailing - Search - 2026/.test(await cards.nth(0).locator('.jn-meta').innerText()),
  await cards.nth(0).locator('.jn-meta').innerText());

section('And where the person actually was — the Seattle question');
ok('the out-of-area click shows its city', /Seattle, WA/.test(await cards.nth(0).locator('.jn-meta').innerText()),
  await cards.nth(0).locator('.jn-meta').innerText());
ok('so does the local one', /Snohomish, WA/.test(await cards.nth(1).locator('.jn-meta').innerText()));
ok('the tiles count what he bought', (await page.locator('.wa-tile').nth(2).innerText()).replace(/\s+/g, ' ').includes('1'),
  await page.locator('.wa-tile').nth(2).innerText());

section('Opening the paid visit keeps saying so');
await cards.nth(0).locator('.jn-head').click();
await page.waitForTimeout(500);
const sum = await page.locator('.jn-card.on .jn-sum').textContent();
ok('the summary line carries the city', /Seattle, WA/.test(sum), sum);
ok('and that it was an ad', /Google ad/.test(sum), sum);
const first = await page.locator('.jn-card.on .jn-step .jn-t').first().textContent();
ok('the story opens with the ad, not "Found you on Google"', /Clicked your Google ad/.test(first), first);

section('The Website tab splits paid from free');
await page.locator('#grNav [data-gv="analytics"]').click();
await page.waitForTimeout(900);
const webText = (await page.locator('#grBody').innerText()).replace(/\s+/g, ' ');
ok('clicks he paid for are their own tile', /Clicks you paid for/.test(webText), webText.slice(0, 400));
ok('with the platform named', /Google/.test(webText));
ok('and the free ones counted apart', /Came in free/.test(webText), webText.slice(0, 400));

section('The tracker snippet passes the ad click id through');
// ?gclid=… lives in location.search. A snippet that sends the pathname alone
// can never label a paid click, which is exactly the bug this fixes.
// waPixelSnippet lives inside the app's IIFE, so this reads the source it is
// built from rather than pretending to call it.
const snipLine = (HTML.match(/function waPixelSnippet\(\)\{[\s\S]*?\}/) || [''])[0];
ok('the snippet builder exists', snipLine.length > 0);
ok('it sends the query string, not just the path',
  /location\.pathname\+location\.search/.test(snipLine), snipLine);
ok('and still sends the referrer and the visit', /document\.referrer/.test(snipLine) && /\/px\?p=/.test(snipLine), snipLine);

section('The switch that decides whether a landing emails him');
await openSettings();
const sel = page.locator('#cfgClickAlert');
ok('the setting is on the follow-up screen', await sel.count() === 1);
ok('it shows what the config says', await sel.inputValue() === 'all', await sel.inputValue());
ok('all three choices are offered', (await sel.locator('option').allTextContents()).length === 3,
  await sel.locator('option').allTextContents());
ok('one of them is ads-only', (await sel.locator('option').allTextContents()).some((t) => /paid for/i.test(t)),
  await sel.locator('option').allTextContents());
await sel.selectOption('ads');
await page.waitForTimeout(500);
ok('choosing one saves it', savedConfigs.some((c) => c.clickAlert === 'ads'), savedConfigs);
ok('and it sticks', await page.locator('#cfgClickAlert').inputValue() === 'ads', await page.locator('#cfgClickAlert').inputValue());
await page.locator('#cfgClickAlert').selectOption('off');
await page.waitForTimeout(500);
ok('turning it off saves too', savedConfigs.some((c) => c.clickAlert === 'off'), savedConfigs);
ok('nothing else was changed along the way',
  savedConfigs.every((c) => Object.keys(c).length === 1 && 'clickAlert' in c), savedConfigs);

section('No console noise');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
