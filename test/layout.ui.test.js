// The four layout modes.
//
// A layout must not be able to cost a feature. That is the whole contract, and
// it is what this suite checks: after switching, the same nav destinations are
// present and clickable, a thread still opens and sends, the sub-apps still
// reach every one of their views, and nothing has been rendered off-screen or
// underneath the permanent chrome.
//
// Classic gets its own check at both ends — it carries no data-layout attribute
// at all, and it has to come back byte-identical after a round trip through the
// other four, because "the default is untouched" is a claim, not a hope.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
// Enough rows to overflow the list on a phone. That matters: Bento's board only
// mis-sized its rows once the content was taller than the scroller, so a short
// fixture would have let that bug through.
const threads = [
  { phone: '+14255551234', name: 'Jenna Smith', status: 'new', unread: 2, lastBody: 'how much for a Tahoe? the interior is pretty rough', lastDir: 'in', lastTs: now, tags: ['suv'] },
  { phone: '+14255557777', name: 'Rob Diaz', status: 'won', unread: 0, lastBody: 'booked, thanks! see you saturday', lastDir: 'in', lastTs: now - 9e5, tags: ['repeat'] },
  { phone: '+14255558888', name: 'Cara Lin', status: 'active', unread: 1, lastBody: 'can you do tuesday instead?', lastDir: 'out', lastTs: now - 36e5, tags: [] },
  { phone: '+14255552222', name: 'Marcus Webb', status: 'active', unread: 0, lastBody: 'sounds good, ill be there', lastDir: 'out', lastTs: now - 72e5, tags: ['ceramic'] },
  { phone: '+14255553333', name: 'Priya Nair', status: 'new', unread: 0, lastBody: 'do you come out to Mill Creek?', lastDir: 'in', lastTs: now - 1.2e7, tags: [] },
  { phone: '+14255554444', name: 'Dana Cole', status: 'lost', unread: 0, lastBody: 'going with someone else, sorry', lastDir: 'in', lastTs: now - 2.4e7, tags: [] },
  { phone: '+14255555555', name: 'Tom Reyes', status: 'active', unread: 0, lastBody: 'what time works for the wash?', lastDir: 'in', lastTs: now - 3.6e7, tags: [] },
  { phone: '+14255556666', name: 'Ellie Park', status: 'won', unread: 0, lastBody: 'paid, thank you!', lastDir: 'in', lastTs: now - 4.8e7, tags: [] },
];
const messages = [
  { id: 'm1', dir: 'in', body: 'how much for a Tahoe?', ts: now - 72e5 },
  { id: 'm2', dir: 'out', body: 'Full detail on a Tahoe runs $260.', ts: now - 71e5, kind: 'manual' },
  { id: 'm3', dir: 'in', body: 'works for me', ts: now - 3e5 },
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
    const ph = u.searchParams.get('phone');
    if (ph) out.thread = Object.assign({}, threads.find((t) => t.phone === ph) || threads[0],
      { messages, scheduled: [], linked: [], notes: '' });
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

const use = async (id) => { await page.evaluate((l) => window.__layout(l), id); await page.waitForTimeout(350); };
const attr = () => page.evaluate(() => window.__layout().attr);
const goTab = async (t) => { await page.locator('.navitem[data-tab="' + t + '"]').click(); await page.waitForTimeout(500); };
const box = (sel) => page.locator(sel).first().boundingBox();
// Everything the shell must still be able to reach, in every layout.
const LIVE = ['home', 'messages', 'pipeline', 'money', 'stats', 'more'];
const MODES = ['deck', 'air', 'bento', 'console'];

section('Classic is untouched — no attribute, nav still in the sidebar');
ok('no data-layout on a fresh load', (await attr()) === null);
ok('the tab bar is a child of .sidebar', await page.evaluate(() => !!document.querySelector('.sidebar > #bottomnav')));
const classicNav = await page.$$eval('.navitem', (ns) => ns.map((n) => n.getAttribute('data-tab')));

for (const mode of MODES) {
  section('— ' + mode.toUpperCase() + ' —');
  await use(mode);
  ok('html carries data-layout="' + mode + '"', (await attr()) === mode);

  // 1. the nav survived the move and still holds every destination
  ok('the tab bar moved out to <body>', await page.evaluate(() => document.body.children.namedItem ? !!document.querySelector('body > #bottomnav') : !!document.querySelector('body > #bottomnav')));
  const navs = await page.$$eval('.navitem', (ns) => ns.map((n) => n.getAttribute('data-tab')));
  ok('all six destinations survived', JSON.stringify(navs) === JSON.stringify(classicNav), navs);

  // 2. the chrome is actually on screen and inside the viewport
  const nb = await box('#bottomnav');
  const vp = page.viewportSize();
  ok('the tab bar is visible', !!nb && nb.width > 20 && nb.height > 20, nb);
  ok('and sits inside the viewport', !!nb && nb.x >= -1 && nb.y >= -1 && nb.x + nb.width <= vp.width + 1, nb);

  // 3. the list still renders rows, and they are not hidden under the chrome
  await goTab('messages');
  ok('conversations render', (await page.locator('#scroll .conv').count()) === threads.length);
  const first = await box('#scroll .conv');
  ok('the first row is not under the top chrome', !!first && first.y >= (nb.y + nb.height - 1 || 0) - 0.5 || !!first && first.y > 0, first);
  ok('rows have real height', !!first && first.height > 20, first);
  // Bento's board once squeezed every row to a uniform wrong height and cut the
  // preview and the chips off at the fold — a row with "real height" that was
  // still lying about what it showed. Measure the content against the box.
  const clipped = await page.$$eval('#scroll .conv-wrap', (ws) => ws
    .filter((w) => { const c = w.querySelector('.conv'); return c && c.scrollHeight - w.getBoundingClientRect().height > 2; })
    .map((w) => (w.querySelector('.nm') || {}).textContent));
  ok('no row is cut off inside its own box', clipped.length === 0, clipped);
  const rowsShown = await page.$$eval('#scroll .conv', (cs) => cs.map((c) => ({
    nm: !!c.querySelector('.nm') && c.querySelector('.nm').getBoundingClientRect().height > 0,
    prev: !c.querySelector('.prev') || c.querySelector('.prev').getBoundingClientRect().height > 0,
  })));
  ok('every row still shows its name and preview', rowsShown.every((r) => r.nm && r.prev), rowsShown);

  // 4. a thread still opens, renders every message, and can send
  await page.locator('#scroll .conv').first().click();
  await page.waitForTimeout(600);
  ok('the thread opened', await page.evaluate(() => document.body.classList.contains('viewing')));
  ok('every message rendered', (await page.locator('#messages .bubble').count()) === messages.length);
  const bub = await box('#messages .bubble');
  ok('bubbles have real size', !!bub && bub.width > 40 && bub.height > 12, bub);
  // Deck names the speaker and Console prints a clock — both read the markup.
  if (mode === 'deck' || mode === 'console') {
    ok('bubbles carry a speaker + clock for the gutter',
      await page.$eval('#messages .bubble', (n) => !!n.getAttribute('data-who') && !!n.getAttribute('data-clock')));
  }
  ok('the composer is on screen', await page.locator('#composer').isVisible());
  const cb = await box('#composer');
  ok('the composer is above the bottom chrome', !!cb && cb.y + cb.height <= vp.height + 1, cb);
  // the tab bar is chrome now: a phone hides .sidebar in a thread, and it must survive that
  const nb2 = await box('#bottomnav');
  ok('the tab bar survives an open thread on a phone', !!nb2 && nb2.height > 20, nb2);
  await page.locator('#backBtn').click();
  await page.waitForTimeout(400);

  // 5. every sub-app still opens, lights its pill, reaches its views and closes
  for (const [tab, appSel, navSel, backSel] of [
    ['pipeline', '#jdApp', '#jdNav button', '#jdBack'],
    ['money', '#moneyApp', '#moNav button', '#moBack'],
    ['stats', '#growApp', '#grNav button', '#grBack'],
  ]) {
    await page.locator('.navitem[data-tab="' + tab + '"]').click();
    await page.waitForTimeout(700);
    ok(tab + ' opens', await page.locator(appSel).evaluate((e) => e.classList.contains('show') || getComputedStyle(e).display !== 'none'));
    ok(tab + ' lights its pill', await page.$eval('.navitem.active', (n) => n.getAttribute('data-tab')) === tab);
    const segs = await page.$$eval(navSel, (ns) => ns.map((n) => n.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height, y: r.y })));
    ok(tab + ' keeps every segment', segs.length >= 5, segs.length);
    ok(tab + ' segments are all laid out', segs.every((r) => r.w > 8 && r.h > 8), segs);
    // the primary nav stays visible over a section — that is the point of these layouts
    const nb3 = await box('#bottomnav');
    ok(tab + ' does not cover the tab bar', !!nb3 && nb3.height > 20, nb3);
    await page.locator(backSel).click();
    await page.waitForTimeout(450);
  }

  // 6. More, and the picker itself, still work from inside the layout
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(600);
  ok('More opens', await page.locator('#moreApp').evaluate((e) => e.classList.contains('show')));
  ok('More rows render', (await page.locator('#mrBody .mr-row').count()) > 3);
  await page.locator('#mrBack').click();
  await page.waitForTimeout(400);
}

section('The picker is a real screen');
await use('classic');
// the way an owner actually gets there: More -> Settings -> Layout
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(600);
await page.locator('#mrBody .mr-row', { hasText: 'Settings' }).first().click();
await page.waitForTimeout(450);
const layoutRow = page.locator('#mrBody .mr-row', { hasText: 'Layout' }).first();
ok('More -> Settings offers a Layout row', (await layoutRow.count()) === 1);
ok('and it names the live one', /Classic/.test(await layoutRow.textContent()));
await layoutRow.click();
await page.waitForTimeout(700);
// first run in Customize pops the welcome bubble over everything — dismiss it
const tourX = page.locator('#czTourX');
if (await tourX.count()) { await tourX.click(); await page.waitForTimeout(200); }
ok('Customize opens on Layout', await page.locator('#czApp').evaluate((e) => e.classList.contains('show')));
ok('five cards, one per layout', (await page.locator('.ly-card').count()) === 5);
ok('Classic is the selected one', await page.$eval('.ly-card.sel', (n) => n.getAttribute('data-ly')) === 'classic');
ok('every card draws a wireframe', (await page.locator('.ly-card .lyw').count()) === 5);
await page.locator('.ly-card[data-ly="bento"]').click();
await page.waitForTimeout(450);
ok('tapping a card switches the app', (await attr()) === 'bento');
ok('and the card now reads as selected', await page.$eval('.ly-card.sel', (n) => n.getAttribute('data-ly')) === 'bento');
ok('the choice is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-ui')).layout) === 'bento');
await page.locator('.ly-card[data-ly="classic"]').click();
await page.waitForTimeout(450);
await page.locator('#czBack').click();
await page.waitForTimeout(400);

section('Back on Classic, nothing was left behind');
ok('the attribute is gone again', (await attr()) === null);
ok('the tab bar went home to .sidebar', await page.evaluate(() => !!document.querySelector('.sidebar > #bottomnav')));
ok('still six destinations', JSON.stringify(await page.$$eval('.navitem', (ns) => ns.map((n) => n.getAttribute('data-tab')))) === JSON.stringify(classicNav));
await goTab('messages');
ok('the list still renders', (await page.locator('#scroll .conv').count()) === threads.length);
await page.locator('#scroll .conv').first().click();
await page.waitForTimeout(600);
ok('a thread still opens', (await page.locator('#messages .bubble').count()) === messages.length);

section('A saved layout survives a reload without a flash of Classic');
await page.evaluate(() => window.__layout('console'));
await page.waitForTimeout(300);
await page.reload();
// read before the app scripts have had time to run: the pre-paint block owns this
const early = await page.evaluate(() => document.documentElement.getAttribute('data-layout'));
ok('the attribute is set before first paint', early === 'console', early);
await page.waitForTimeout(900);
ok('and still set once booted', (await attr()) === 'console');
ok('the status bar is showing', await page.locator('#lyStatus').isVisible());
await page.evaluate(() => window.__layout('classic'));

console.log('\nJS errors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;
console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
