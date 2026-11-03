// A third pass of papercuts, found by looking at the live dashboard on a 390px
// iPhone (2026-11-03) rather than by reading the code:
//
//   • his own avatar hung off the right edge of the top bar, and the search
//     hint was cut off at "— try"
//   • in light mode the conversation pane stayed near-black, so the name in
//     its header was dark grey on black, and the number broke over 3 lines
//   • the longest waits on Today were "Sure" and "Oh well. Thanks, anyway",
//     and clearing one meant Chats, find them, swipe, tap
//   • "4 more waiting on your reply" dropped him on all of Chats, and the
//     Chats card's "+5 more waiting" opened Insights
//   • the last thing on Today sat under the pencil button, untappable
//   • the Calls explainer was five lines on top of the list, every visit
//   • a text from Saturday said "Sat" under a "Saturday, Oct 31" divider
//   • "(425) 555-0001" or "555-0001" in search found nobody
//
//   node test/qol3.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

// Six waiting, so Today has to say "2 more". One of them texted STOP: still
// counted as waiting, but there's nothing for him to clear by text.
const rows = [
  { phone: '+14255550101', name: 'Don Granston', lastBody: 'Sure', lastDir: 'in', lastTs: now - 13 * DAY, awaitingReply: true, unread: 0, tags: [] },
  { phone: '+14255550102', name: 'Hannah Hill', lastBody: 'Oh well. Thanks, anyway', lastDir: 'in', lastTs: now - 11 * DAY, awaitingReply: true, unread: 0, tags: [] },
  { phone: '+14255550103', name: 'Pat Rowe', lastBody: 'how much for a van', lastDir: 'in', lastTs: now - 9 * DAY, awaitingReply: true, unread: 0, tags: [] },
  { phone: '+14255550104', name: 'Sam Ortiz', lastBody: 'saturday ok?', lastDir: 'in', lastTs: now - 7 * DAY, awaitingReply: true, unread: 0, tags: [] },
  { phone: '+14255550105', name: 'Lee Park', lastBody: 'still on?', lastDir: 'in', lastTs: now - 5 * DAY, awaitingReply: true, unread: 0, tags: [] },
  { phone: '+14255550106', name: 'Quinn Moss', lastBody: 'stop', lastDir: 'in', lastTs: now - 3 * DAY, awaitingReply: true, optedOut: true, unread: 0, tags: [] },
  { phone: '+14255550001', name: 'Dale Hobart', lastBody: 'see you then', lastDir: 'out', lastTs: now - 2 * HOUR, awaitingReply: false, unread: 0, tags: [],
    vehicleLabel: '2019 black Silverado', city: 'Monroe' },
];
for (let i = 10; i < 30; i++) rows.push({ phone: '+142555500' + i, name: 'Filler ' + i, lastBody: 'thanks!', lastDir: 'out', lastTs: now - (i + 20) * DAY, unread: 0, tags: [] });

// Dale's last text is from three days back, so its day gets a divider of its own.
const old = now - 3 * DAY;
const daleMsgs = [
  { id: 'd1', dir: 'out', body: 'full detail on the Silverado is $220', ts: old },
  { id: 'd2', dir: 'in', body: 'see you then', ts: old + 5 * MIN },
];
const thread = (phone) => {
  const r = rows.find((x) => x.phone === phone) || {};
  return { phone, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '', status: '', messages: phone === '+14255550001' ? daleMsgs : [] };
};

const posts = [];
const threadReads = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'light' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('dialog', (d) => d.accept());

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (req.method() === 'POST' && path.startsWith('/api/')) {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    posts.push(Object.assign({ path }, b));
    if (path === '/api/reply/none') {
      const r = rows.find((x) => x.phone === b.phone);
      if (r) r.awaitingReply = !!b.undo;
      return json({ ok: true, thread: thread(b.phone) });
    }
    return json({ ok: true });
  }
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    if (want) threadReads.push(want);
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/calls') return json({ ok: true, calls: [{ sid: 'c1', from: '+14255550103', ts: now - HOUR, status: 'no-answer', duration: 0 }], seenTs: now, unseen: 0, forwardTo: '+14252321355', screening: true, recording: true });
  if (path === '/api/money') return json({ ok: true, entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1000);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const box = (sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; });
const toHome = async () => { await page.locator('.navitem[data-tab="home"]').click(); await page.waitForTimeout(400); };
const toChats = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) { await page.locator('#backBtn').click(); await page.waitForTimeout(250); }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(350);
};
const names = () => page.$$eval('.conv .nm', (n) => n.map((x) => x.textContent.trim()));

// ─────────────────────────────────────────────────────────────────────────────
section('The top bar fits a 390px phone');
const av = await box('#myAvatar');
ok('his avatar is all the way on screen', av.r <= 390, av);
const ph = await page.locator('#search').getAttribute('placeholder');
ok('the search hint is short enough to read whole', ph.length <= 26 && !/—/.test(ph), ph);

// ─────────────────────────────────────────────────────────────────────────────
section('Today: clear a "Sure" without opening the chat');
await toHome();
const waitRows = page.locator('.nd-row', { has: page.locator('.nd-done') });
ok('waiting rows carry a No reply needed check', (await waitRows.count()) >= 4, await waitRows.count());
const quinn = page.locator('.nd-row', { hasText: 'Quinn Moss' });
ok('someone who texted STOP gets none', (await quinn.count()) === 0 || (await quinn.locator('.nd-done').count()) === 0);
const before = threadReads.length;
await page.locator('.nd-row', { hasText: 'Don Granston' }).locator('.nd-done').click();
await page.waitForTimeout(500);
ok('it told the Worker, for Don', posts.some((p) => p.path === '/api/reply/none' && p.phone === '+14255550101' && !p.undo), posts);
ok('and never opened his chat (that marks it read)', threadReads.length === before && !(await page.evaluate(() => document.body.classList.contains('viewing'))), threadReads);
ok('he is off the waiting list', (await page.locator('.nd-row', { hasText: 'Don Granston' }).count()) === 0);
const undo = page.locator('.toast button', { hasText: /undo/i });
ok('the toast offers Undo', (await undo.count()) >= 1);
if (await undo.count()) {
  await undo.first().click();
  await page.waitForTimeout(600);
  ok('Undo puts him back as owed', posts.some((p) => p.path === '/api/reply/none' && p.phone === '+14255550101' && p.undo === true), posts);
}

section('Today: "N more waiting" opens the waiting list');
await toHome();
const more = page.locator('.nd-more[data-nd-more="wait"]');
ok('there is a "more waiting" line', (await more.count()) === 1);
await more.click();
await page.waitForTimeout(500);
ok('it lands on Chats', await page.evaluate(() => document.querySelector('.navitem[data-tab="messages"]').classList.contains('active')));
const listed = await names();
ok('filtered to the people waiting, not everyone', listed.length > 0 && !listed.some((n) => /Filler|Dale/.test(n)), listed);

section('Chats: "+N more waiting" shows the people, not Insights');
await page.evaluate(() => { localStorage.setItem('mkd-sum', '1'); });
await page.locator('.navitem[data-tab="home"]').click(); await page.waitForTimeout(300);
await toChats();
const sumMore = page.locator('#sumMore');
ok('the Chats card says how many more', (await sumMore.count()) === 1 && /show them/.test(await sumMore.innerText()), (await sumMore.count()) && await sumMore.innerText());
if (await sumMore.count()) {
  await sumMore.click(); await page.waitForTimeout(500);
  ok('Insights did not open', !(await page.locator('#growApp.open, .grow-app.open').count()));
  const l2 = await names();
  ok('and the list is the waiting people', l2.length > 0 && !l2.some((n) => /Filler|Dale/.test(n)), l2);
}

// ─────────────────────────────────────────────────────────────────────────────
section('The last thing on a list clears the pencil button');
await toHome();
await page.evaluate(() => { const s = document.getElementById('scroll'); s.scrollTop = s.scrollHeight; });
await page.waitForTimeout(300);
const fab = await box('#fab');
const last = await page.evaluate(() => {
  const s = document.getElementById('scroll');
  const kids = [...s.querySelectorAll('.home > *')].filter((e) => e.offsetParent);
  const r = kids[kids.length - 1].getBoundingClientRect(); return { t: r.top, b: r.bottom };
});
ok('scrolled to the end, the last item ends above the FAB', last.b <= fab.t + 1, { last, fab });

// ─────────────────────────────────────────────────────────────────────────────
section('Calls: the explainer is one line until asked');
await page.locator('.navitem[data-tab="calls"]').click(); await page.waitForTimeout(700);
const ch = await box('#scroll .callhead');
const chText = (await page.locator('#scroll .callhead').innerText()).replace(/\s+/g, ' ');
ok('it still names the phone that rings', /\(425\) 232-1355/.test(chText), chText);
ok('and is short', ch.h < 60, ch);
await page.locator('#scroll .callhead').screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
await page.locator('#clHow').click(); await page.waitForTimeout(300);
const chOpen = (await page.locator('#scroll .callhead').innerText()).replace(/\s+/g, ' ');
ok('"How" opens the whole explanation', /presses 1/.test(chOpen) && /transcribed/.test(chOpen), chOpen);
ok('with no em dash in it', !/—/.test(chOpen), chOpen);

// ─────────────────────────────────────────────────────────────────────────────
section('Search finds a number the way it is written');
const search = async (q) => { await toChats(); await page.locator('#search').fill(q); await page.waitForTimeout(300); };
// Back to everyone: the "more waiting" taps above left Chats on Waiting.
await toChats();
await page.locator('#filters .frow.stat .chip').filter({ hasText: /^All$/ }).first().click();
await page.waitForTimeout(300);
await search('(425) 555-0001'); ok('"(425) 555-0001"', (await names()).includes('Dale Hobart'), await names());
await search('555-0001'); ok('"555-0001"', (await names()).includes('Dale Hobart'), await names());
await search('425.555.0001'); ok('"425.555.0001"', (await names()).includes('Dale Hobart'), await names());
await search('hobart dale'); ok('words in any order', (await names()).includes('Dale Hobart'), await names());
await search('monroe silverado'); ok('row fields in any order', (await names()).includes('Dale Hobart'), await names());
await search('hobart zzz'); ok('but every word has to be there', !(await names()).includes('Dale Hobart'), await names());
await search('');

// ─────────────────────────────────────────────────────────────────────────────
section('A conversation, in light mode, on a phone');
await page.locator('.conv .nm', { hasText: 'Dale Hobart' }).first().click();
await page.waitForTimeout(700);
const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
const colors = await page.evaluate(() => ({
  head: getComputedStyle(document.getElementById('chatHead')).backgroundColor,
  pane: getComputedStyle(document.getElementById('chat')).backgroundColor,
  name: getComputedStyle(document.getElementById('hName')).color,
}));
ok('the header is light', lum(colors.head) > 0.8, colors);
ok('so is the pane behind the texts', lum(colors.pane) > 0.8, colors);
ok('and the name is dark on it', lum(colors.name) < 0.3, colors);
const num = await box('#hNum');
ok('the number is on one line', num.h < 20, num);
const nm = await box('#hName');
ok('the name gets real room', nm.r - nm.l >= 90, nm);
const stamp = await page.locator('.bubble[data-mid="d2"] .t').innerText();
ok('an older text shows its clock time, under its day divider', /\d:\d\d/.test(stamp), stamp);

await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
const darkHead = await page.evaluate(() => getComputedStyle(document.getElementById('chatHead')).backgroundColor);
ok('dark mode keeps its dark header', lum(darkHead) < 0.2, darkHead);

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
