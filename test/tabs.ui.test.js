// The bottom-nav structure. Every button here has to be a real destination that
// lights its own pill and hands it back on close — the old bar had buttons that
// only looked like tabs, opening overlays while the pill stayed somewhere else.
//
// Now: Today · Chats · Work · Money · More. The bar is named for moments in the
// day rather than for the tables behind them, and it is five wide, not six:
// Stats came out on the evidence. Across 90 days it was opened nine times,
// four of its nine reports were never opened at all, and all but one visit was
// a bounce — a weekly read sitting in a daily bar. It is an index screen inside
// More now, which is also where its nine nine-across segments went.
//
// Booked, Leads, Quotes, the Run, Pay and the Garage are stages of one job, so
// they share the Work board; the Chats lenses are the top row of a two-row
// filter bar, and they compose with the status row underneath instead of
// silently cancelling it.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const threads = [
  { phone: '+14255551234', name: 'Jenna Smith', status: 'new', unread: 2, lastBody: 'how much for a Tahoe?', lastTs: Date.now(), tags: [] },
  { phone: '+14255557777', name: 'Rob Diaz', status: 'won', unread: 0, lastBody: 'booked, thanks', lastTs: Date.now() - 900000, tags: [] },
];

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
    const out = { ok: true, threads, config: {} };
    if (u.searchParams.get('phone')) out.thread = Object.assign({ messages: [], scheduled: [], linked: [], notes: '' }, threads[0]);
    return json(out);
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-07', today: '2026-07-30', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-07-30', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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
// Label only — the icon and the badge count are children, so read the bare
// text nodes rather than textContent (which would give "0Today").
const visibleTabs = () => page.$$eval('.navitem', (ns) => ns
  .filter((n) => n.style.display !== 'none')
  .map((n) => Array.from(n.childNodes)
    .filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim()));
const activeTab = () => page.$eval('.navitem.active', (n) => n.getAttribute('data-tab')).catch(() => null);

section('The default bar, all real destinations');
const tabs = await visibleTabs();
ok('they are Today/Chats/Calls/Work/Money/More',
  JSON.stringify(tabs) === JSON.stringify(['Today', 'Chats', 'Calls', 'Work', 'Money', 'More']), tabs);
// Hidden, not removed: Stats is still a pill in Customize → Tabs, one tap from
// coming back. It is off by default on measurement — 9 opens in a quarter,
// four of its nine reports never opened at all — now that its nine reports
// have an index screen of their own inside More.
ok('Stats is off the default bar', !tabs.includes('Stats'), tabs);
const allPills = await page.$$eval('.navitem', (ns) => ns.map((n) => n.getAttribute('data-tab')));
ok('but it is still a real pill the bar can show', allPills.includes('stats'), allPills);

section('The nav bar says where you actually are');
ok('starts on Today', (await activeTab()) === 'home');
await page.locator('.navitem[data-tab="work"]').click();
await page.waitForTimeout(700);
ok('Work lights its own pill', (await activeTab()) === 'work');
await page.locator('#jdBack').click();
await page.waitForTimeout(500);
ok('and hands it back on close', (await activeTab()) === 'home');
await page.locator('.navitem[data-tab="money"]').click();
await page.waitForTimeout(700);
ok('Money lights its own pill', (await activeTab()) === 'money');
await page.locator('#moBack').click();
await page.waitForTimeout(500);
ok('and hands it back too', (await activeTab()) === 'home');

// Nine reports behind a nine-across segment bar gave each one 46px and no
// readable label, which is how four of them went a whole quarter unopened.
// The index is the fix: a card per report that says what it answers.
section('Insights is an index, not nine tabs');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(450);
await page.locator('#mrBody .mr-row', { hasText: 'Insights' }).first().click();
await page.waitForTimeout(700);
ok('Insights opened', await page.locator('#growApp').evaluate((e) => e.classList.contains('show')));
ok('lands on the index', await page.$eval('#grTitle', (n) => n.textContent.trim()) === 'Insights');
const ixCards = await page.$$eval('.ix-card', (ns) => ns.map((n) => n.getAttribute('data-ix')));
ok('nine reports, one card each', ixCards.length === 9, ixCards);
// The old collision: the quote builder in Work and the quote report in
// Insights were both called "Quotes" and both claimed the feature id "quotes",
// so fxById only ever found the second one.
const ixTitles = await page.$$eval('.ix-card .ix-t', (ns) => ns.map((n) => n.textContent.trim()));
ok('the quote report is named apart from the builder',
  ixTitles.includes('Quote results') && !ixTitles.includes('Quotes'), ixTitles);
ok('the segment bar is hidden on the index',
  (await page.$eval('#grNav', (n) => n.style.display)) === 'none');
ok('and it lights the More pill, not a Stats one', (await activeTab()) === 'more');

section('A card opens its report, and back returns to the index');
await page.locator('.ix-card[data-ix="analytics"]').click();
await page.waitForTimeout(700);
ok('opened the website report', await page.$eval('#grTitle', (n) => n.textContent.trim()) === 'Website');
ok('the segment bar is back for hopping between reports',
  (await page.$eval('#grNav', (n) => n.style.display)) !== 'none');
ok('and the segment bar agrees',
  await page.$eval('#grNav [data-gv].active', (n) => n.getAttribute('data-gv')) === 'analytics');
await page.locator('#grBack').click();
await page.waitForTimeout(500);
ok('back went up one level, not out',
  await page.$eval('#grTitle', (n) => n.textContent.trim()) === 'Insights');
ok('Insights is still open', await page.locator('#growApp').evaluate((e) => e.classList.contains('show')));
await page.locator('#grBack').click();
await page.waitForTimeout(500);
ok('back again closes Insights', !(await page.locator('#growApp').evaluate((e) => e.classList.contains('show'))));

section('Work is one flow, booking to garage');
await page.locator('.navitem[data-tab="work"]').click();
await page.waitForTimeout(700);
const segs = await page.$$eval('#jdNav button', (ns) => ns.map((n) => n.textContent.trim()));
ok('six stages in order',
  JSON.stringify(segs) === JSON.stringify(['Booked', 'Leads', 'Quotes', 'Run', 'Pay', 'Garage']), segs);
await page.locator('#jdNav [data-jv="leads"]').click();
await page.waitForTimeout(600);
ok('the leads board renders inside Pipeline', (await page.locator('#jdBody .lead-card').count()) > 0);
ok('grouped by stage', (await page.locator('#jdBody .lead-col').count()) > 0);

section('Opening a lead leaves the board for the conversation');
await page.locator('#jdBody .lead-card').first().click();
await page.waitForTimeout(800);
ok('board closed', !(await page.locator('#jdApp').evaluate((e) => e.classList.contains('show'))));
ok('conversation opened', await page.evaluate(() => document.body.classList.contains('viewing')));
await page.locator('#backBtn').click();
await page.waitForTimeout(500);

// Two rows, because these are two questions. The lens row says which pile;
// the status row filters inside it. They used to share one row of ten chips
// where picking a lens silently threw the status filter away.
section('Chats filters are two rows that compose');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(600);
const rowText = (sel) => page.$$eval(sel, (ns) => ns.map((n) => n.textContent.replace(/\d+$/, '').trim()));
ok('there are exactly two rows', (await page.locator('#filters .frow').count()) === 2);
const lenses = await rowText('#filters .frow.lens .chip');
ok('the lens row is the four piles',
  JSON.stringify(lenses) === JSON.stringify(['All chats', 'Follow-ups', 'Scheduled', 'Archived']), lenses);
const stats = await rowText('#filters .frow.stat .chip');
['All', 'Waiting on me', 'Unread', 'New', 'Won'].forEach((c) =>
  ok('"' + c + '" is a status chip', stats.includes(c), stats));
ok('no lens leaked into the status row', !stats.includes('Archived'), stats);

// The seeded threads are one 'new' and one 'won', neither archived.
const listCount = () => page.locator('#scroll .conv').count();
await page.locator('#filters .frow.stat .chip', { hasText: 'Won' }).first().click();
await page.waitForTimeout(500);
ok('a status filter narrows the list', (await listCount()) === 1, await listCount());
await page.locator('#filters .frow.lens .chip', { hasText: 'Archived' }).first().click();
await page.waitForTimeout(600);
ok('the Chats pill stays lit on a lens', (await activeTab()) === 'messages');
ok('the filter row is still there', await page.locator('#filters').isVisible());
// This is the whole point of the split: the status survived the lens change.
ok('the status filter survived switching lens',
  (await page.$eval('#filters .frow.stat .chip.active', (n) => n.textContent.replace(/\d+$/, '').trim())) === 'Won');
ok('and archived+won really is empty', (await listCount()) === 0, await listCount());

// Tapping the live chip is the way out of a filter — there has to be one.
await page.locator('#filters .frow.lens .chip', { hasText: 'All chats' }).first().click();
await page.waitForTimeout(500);
await page.locator('#filters .frow.stat .chip.active').first().click();
await page.waitForTimeout(500);
ok('tapping the live status chip clears it',
  (await page.$eval('#filters .frow.stat .chip.active', (n) => n.textContent.trim())) === 'All');
ok('and the whole pile is back', (await listCount()) === 2, await listCount());

section('More is a screen, not a 25-item drawer');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(500);
ok('More opened', await page.locator('#moreApp').evaluate((e) => e.classList.contains('show')));
ok('the old drawer is gone', (await page.locator('#drawer').count()) === 0);
const groups = await page.$$eval('#mrBody .mr-gh', (ns) => ns.map((n) => n.textContent.trim()));
// "Recently used" only appears once something has been jumped to, so match on
// the fixed groups rather than the whole list.
['AI', 'Phone', 'Insights', 'Day tools', 'Setup', 'Everything'].forEach((g) =>
  ok('"' + g + '" is a group', groups.includes(g), groups));
ok('the old "Pipeline" group is gone — Bookings went to the Work bar',
  !groups.includes('Pipeline'), groups);
const rootRows = await page.locator('#mrBody .mr-row').count();
ok('root stays short (was 25 rows)', rootRows <= 14, rootRows);
ok('no duplicate of a tab on the root', !(await page.$$eval('#mrBody .mr-row .t', (ns) => ns.map((n) => n.textContent)))
  .some((t) => /^(Money tracker|All messages|Leads pipeline|Today's Run)$/.test(t)));

section('Settings is one level down, and its panels survive the trip');
await page.locator('#mrBody .mr-row', { hasText: 'Settings' }).first().click();
await page.waitForTimeout(500);
ok('settings view opened', (await page.locator('#mrTitle').textContent()).trim() === 'Settings');
// One settings door: Money kept its own Settings segment in its own bottom bar
// and Customize sat as a peer of the whole app, so a setting could be in any
// of three places and you had to remember which.
const setRows = await page.$$eval('#mrBody .mr-row .t', (ns) => ns.map((n) => n.textContent.trim()));
['Phone notifications', 'Customize everything', 'Money settings'].forEach((r) =>
  ok('"' + r + '" is on the one settings screen', setRows.includes(r), setRows));
ok('the follow-up panel came with it', await page.locator('#mrBody #fuSettings').count() === 1);
ok('the team panel too', await page.locator('#mrBody #teamPanel').count() === 1);
ok('and the accent picker', await page.locator('#mrBody #accentRow').count() === 1);
const accentSwatches = await page.locator('#mrBody #accentRow *').count();
ok('the accent picker kept its contents', accentSwatches > 0, accentSwatches);
await page.locator('#mrBack').click();
await page.waitForTimeout(450);
ok('back returns to the More root', (await page.locator('#mrTitle').textContent()).trim() === 'More');
await page.locator('#mrBack').click();
await page.waitForTimeout(450);
ok('back again closes More', !(await page.locator('#moreApp').evaluate((e) => e.classList.contains('show'))));
// We are on the Archived lens at this point, which has no pill of its own —
// it should light Chats rather than leaving the bar blank.
ok('and the pill returns to the lens you were on', (await activeTab()) === 'messages');

section('Re-entering Settings still has live panels (not a wiped shell)');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(400);
await page.locator('#mrBody .mr-row', { hasText: 'Settings' }).first().click();
await page.waitForTimeout(500);
ok('accent picker still populated second time', (await page.locator('#mrBody #accentRow *').count()) > 0);

// A widget used to be the only door to three features, so switching one off
// deleted the feature from the app. They are screens now, and the widget is a
// shortcut to the screen.
section('Day tools are real screens, not just Home widgets');
await page.locator('#mrBack').click();
await page.waitForTimeout(400);
await page.locator('#mrBody .mr-row', { hasText: 'To-do list' }).first().click();
await page.waitForTimeout(500);
ok('the to-do screen opened', (await page.locator('#mrTitle').textContent()).trim() === 'To-do list');
ok('and it rendered the widget', (await page.locator('#mrBody [data-hwidget="tasks"]').count()) === 1);
await page.locator('#mrBack').click();
await page.waitForTimeout(450);
ok('back returns to the More root', (await page.locator('#mrTitle').textContent()).trim() === 'More');

// FEATURES was already a complete map of every screen, but it only rendered as
// search results — which you have to know to search for.
section('Everything, A–Z is browsable');
await page.locator('#mrBody .mr-row', { hasText: 'Everything, A–Z' }).first().click();
await page.waitForTimeout(500);
ok('the index opened', (await page.locator('#mrTitle').textContent()).trim() === 'Everything, A–Z');
const idxRows = await page.$$eval('#mrBody .mr-row .t', (ns) => ns.map((n) => n.textContent.trim()));
ok('it lists a lot of screens', idxRows.length > 25, idxRows.length);
ok('no screen is listed twice', new Set(idxRows).size === idxRows.length,
  idxRows.filter((t, i) => idxRows.indexOf(t) !== i));
ok('the quote builder and the quote report are both in it',
  idxRows.includes('Quote builder') && idxRows.includes('Quote results'), idxRows);
await page.locator('#mrBack').click();
await page.waitForTimeout(450);
await page.locator('#mrBack').click();
await page.waitForTimeout(450);

// Simple mode used to be a label: it set a variable nothing read, so the switch
// promising "just the essentials" changed nothing on screen. These assertions
// exist so it can never quietly go back to being decorative.
section('Simple mode actually trims Home');
// The sections above left More closed on the root; go straight to the nav.
await page.locator('.navitem[data-tab="home"]').click();
await page.waitForTimeout(600);
const widgetKeys = () => page.$$eval('#scroll [data-hwidget]', (ns) => ns.map((n) => n.getAttribute('data-hwidget')));
const simpleWidgets = await widgetKeys();
ok('Home is down to the essentials',
  JSON.stringify(simpleWidgets) === JSON.stringify(['brief', 'money', 'quickactions']), simpleWidgets);
ok('the ask-anything box is a Pro surface', (await page.locator('.ai-center').count()) === 0);
ok('and Home says what trimmed it', (await page.locator('#homeModeBtn').count()) === 1);

// The way back has to be on the trimmed screen itself, not buried in settings.
// Home repaints itself whenever a poll lands, so a Playwright click can lose
// the node between resolving it and pressing it. Click it synchronously.
await page.$eval('#homeModeBtn', (n) => n.click());
await page.waitForTimeout(700);
const proWidgets = await widgetKeys();
ok('one tap restores the full layout', proWidgets.length > simpleWidgets.length, proWidgets);
ok('the AI center is back', (await page.locator('.ai-center').count()) === 1);
// Home repaints itself whenever a poll lands, so a Playwright click can lose
// the node between resolving it and pressing it. Click it synchronously.
await page.$eval('#homeModeBtn', (n) => n.click());
await page.waitForTimeout(700);
ok('and it toggles back to simple',
  JSON.stringify(await widgetKeys()) === JSON.stringify(['brief', 'money', 'quickactions']));

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;

console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
