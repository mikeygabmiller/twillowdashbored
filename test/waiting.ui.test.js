// The dashboard half of "too many ppl going unresponded" (Mikey, 2026-10-06):
//   - chats the Worker filed come marked archived, so they leave the list and
//     the counts, and show on the Archived pile with why
//   - the app icon carries how many people are waiting on him
//   - "No reply needed" on the swipe-left card clears someone without opening
//     (and so reading) the conversation, and the counts follow
//   - the owed nudge offers it too
//   - a check-in push opens straight onto exactly the people waiting
//   - the settings for both: check-in hours, the switch, how long before a
//     chat files itself
//
//   node test/waiting.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const H = 3600000, DAY = 86400000;

let rows = [
  { phone: '+14255550101', name: 'Ruth Ames', status: 'new', unread: 0, tags: [], lastBody: "I'll let you know",
    lastDir: 'in', lastTs: now - 5 * H, waitSince: now - 5 * H, awaitingReply: true },
  { phone: '+14255550102', name: 'Dave Ortiz', status: 'active', unread: 1, tags: [], lastBody: 'How much for a Tahoe?',
    lastDir: 'in', lastTs: now - 26 * H, waitSince: now - 26 * H, awaitingReply: true },
  { phone: '+14255550103', name: 'Kim Lee', status: 'won', unread: 0, tags: [], lastBody: 'Thanks again!',
    lastDir: 'in', lastTs: now - 2 * DAY, awaitingReply: false, closedReason: 'Wrapped up' },
  // What the Worker sends for a chat it filed (see filedView).
  { phone: '+14255550104', name: 'Old Lead', status: 'new', unread: 0, tags: [], lastBody: 'how much?',
    lastDir: 'in', lastTs: now - 40 * DAY, waitSince: now - 40 * DAY, awaitingReply: true,
    archived: true, filed: 'unanswered', quietSince: now - 40 * DAY },
  { phone: '+14255550105', name: 'Done Dan', status: 'won', unread: 0, tags: [], lastBody: 'See you then',
    lastDir: 'out', lastTs: now - 20 * DAY, archived: true, filed: 'quiet', quietSince: Date.parse('2026-09-16T18:00:00Z') },
  { phone: '+14255550106', name: 'Archived Amy', status: 'lost', unread: 0, tags: [], lastBody: 'no thanks',
    lastDir: 'in', lastTs: now - 9 * DAY, archived: true },
];
let CONFIG = { autoFileDays: 14 };
const posts = [];
const savedConfigs = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });

async function boot(url) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 }, hasTouch: true, isMobile: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  // The Badging API, recorded. Chromium headless has no home screen to put it on.
  await page.addInitScript(() => {
    window.__badges = [];
    navigator.setAppBadge = (n) => { window.__badges.push(n); return Promise.resolve(); };
    navigator.clearAppBadge = () => { window.__badges.push(0); return Promise.resolve(); };
  });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url()); const p = u.pathname;
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/threads') {
      const want = u.searchParams.get('phone');
      const out = { ok: true, threads: rows, config: CONFIG };
      if (want) {
        const r = rows.find((x) => x.phone === want) || {};
        out.thread = { phone: want, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '',
          archived: !!r.archived, filed: r.filed,
          followup: want === '+14255550101' ? { suggestion: { id: 's1', stage: 'owed', stepKey: 'owed:1', reason: 'Ruth is waiting on a reply', draft: 'Sounds good!', urgency: 'high' } } : {},
          messages: [{ id: 'm1', dir: r.lastDir || 'in', body: r.lastBody || '', ts: r.lastTs || now }] };
      }
      return json(out);
    }
    if (p === '/api/reply/none') {
      const d = JSON.parse(req.postData() || '{}');
      posts.push({ path: p, phone: d.phone });
      rows = rows.map((r) => (r.phone === d.phone ? Object.assign({}, r, { awaitingReply: false, closedReason: 'You said no reply needed' }) : r));
      return json({ ok: true });
    }
    if (p === '/api/meta') { posts.push({ path: p, body: JSON.parse(req.postData() || '{}') }); return json({ ok: true }); }
    if (p === '/api/config') {
      if (req.method() === 'POST') {
        const patch = JSON.parse(req.postData() || '{}');
        savedConfigs.push(patch);
        CONFIG = Object.assign({}, CONFIG, patch);
      }
      return json({ ok: true, config: CONFIG });
    }
    if (p === '/api/money') return json({ ok: true, month: '2026-10', today: '2026-10-06', entries: [], nudges: [], owed: [], summary: {}, config: {} });
    if (p === '/api/day') return json({ ok: true, date: '2026-10-06', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
    if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
    if (p === '/api/version') return json({ ok: true, build: 'test' });
    if (p.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto(url || 'https://texting.test/');
  await page.waitForTimeout(1000);
  return { page, errs };
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const allErrs = [];

const { page, errs } = await boot();
allErrs.push(errs);
const toChats = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click();
  await page.waitForTimeout(400);
};
const names = async () => (await page.locator('.conv .nm').allInnerTexts()).map((s) => s.trim());

section('Filed chats leave the list and every count');
await toChats();
let list = await names();
ok('the in-play chats are listed', ['Ruth Ames', 'Dave Ortiz', 'Kim Lee'].every((n) => list.includes(n)), list);
ok('the ones the Worker filed are not', !list.includes('Old Lead') && !list.includes('Done Dan'), list);
ok('waiting counts only the two really waiting', /2 waiting/.test(await page.locator('#sumbar').innerText()),
  await page.locator('#sumbar').innerText());

section('The app icon says how many are waiting');
let badges = await page.evaluate(() => window.__badges);
ok('the icon was set', badges.length > 0, badges);
ok('…to 2 (waiting on him, not unread)', badges[badges.length - 1] === 2, badges);

section('The Archived pile says what the app filed, and why');
await page.locator('#filters .chip', { hasText: 'Archived' }).first().click();
await page.waitForTimeout(400);
list = await names();
ok('his own archive and the filed ones are both there', ['Old Lead', 'Done Dan', 'Archived Amy'].every((n) => list.includes(n)), list);
const archText = await page.locator('#scroll').innerText();
ok('a note up top explains the filing', /filed after 14 days with nothing going on/.test(archText), archText.slice(0, 300));
ok('…and that a text brings one straight back', /comes straight back/.test(archText));
ok('never answered is called out', /filed: never answered/.test(archText), archText);
ok('quiet ones say since when', /filed: quiet since Sep 1[56]/.test(archText), archText);
ok('his own archive has no "filed" tag', await page.locator('.conv', { hasText: 'Archived Amy' }).locator('.filed-flag').count() === 0);
ok('never answered is the warning colour', await page.locator('.conv', { hasText: 'Old Lead' }).locator('.filed-flag.warn').count() === 1);
ok('no em dash in what it says', !/—/.test(await page.locator('.filed-note').innerText()));

section('Swipe left → "No reply needed"');
await toChats();
// A real finger drag on the row with that name: touchstart, moves, touchend.
const drag = async (name, dx) => {
  const i = await page.evaluate((name) => Array.prototype.findIndex.call(document.querySelectorAll('.conv'),
    (c) => (c.querySelector('.nm') || {}).textContent.trim() === name), name);
  if (i < 0) throw new Error('no row for ' + name);
  const box = await page.locator('.conv').nth(i).boundingBox();
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.evaluate(({ i, dx, x, y }) => {
    const node = document.querySelectorAll('.conv')[i];
    const t = (cx) => ({ touches: [{ clientX: cx, clientY: y }], changedTouches: [{ clientX: cx, clientY: y }] });
    const fire = (name, cx) => { const ev = new Event(name, { bubbles: true }); Object.assign(ev, t(cx)); node.dispatchEvent(ev); };
    fire('touchstart', x);
    for (let k = 1; k <= 6; k++) fire('touchmove', x + (dx * k) / 6);
    fire('touchend', x + dx);
  }, { i, dx, x, y });
  await page.waitForTimeout(450);
};
await drag('Ruth Ames', -140);
ok('the peek opened on Ruth', /Ruth Ames/.test(await page.locator('#pkCard').innerText()));
const nr = page.locator('#pkCard [data-pk="noreply"]');
ok('it offers "No reply needed"', await nr.count() === 1);
await nr.click();
await page.waitForTimeout(700);
ok('it told the Worker, for Ruth', posts.some((x) => x.path === '/api/reply/none' && x.phone === '+14255550101'), posts);
ok('without opening her conversation (that marks it read)',
  !(await page.evaluate(() => document.body.classList.contains('viewing'))));
await page.locator('#jdScrim').click({ position: { x: 10, y: 10 } }).catch(() => {});
await page.waitForTimeout(400);
ok('waiting drops to 1', /1 waiting/.test(await page.locator('#sumbar').innerText()), await page.locator('#sumbar').innerText());
badges = await page.evaluate(() => window.__badges);
ok('…and so does the icon', badges[badges.length - 1] === 1, badges);
ok('Dave, who is not done, offers it; Kim, who said thanks, does not', await (async () => {
  await drag('Kim Lee', -140);
  const kim = await page.locator('#pkCard [data-pk="noreply"]').count();
  await page.locator('#jdScrim').click({ position: { x: 10, y: 10 } }).catch(() => {});
  await page.waitForTimeout(400);
  await drag('Dave Ortiz', -140);
  const dave = await page.locator('#pkCard [data-pk="noreply"]').count();
  await page.locator('#jdScrim').click({ position: { x: 10, y: 10 } }).catch(() => {});
  await page.waitForTimeout(400);
  return kim === 0 && dave === 1;
})());

section('The "you owe a reply" nudge offers it too');
await page.locator('.conv', { hasText: 'Ruth Ames' }).first().click();
await page.waitForTimeout(800);
const fb = await page.locator('#fuBanner').innerText().catch(() => '');
ok('the owed nudge shows', /Ruth is waiting on a reply/.test(fb), fb);
ok('…with "No reply needed" next to Skip', await page.locator('#fuBanner [data-noreply]').count() === 1, fb);

section('Settings: check-ins and filing');
await page.locator('#backBtn').click().catch(() => {});
await page.waitForTimeout(300);
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(400);
await page.getByText('Settings', { exact: true }).first().click();
await page.waitForTimeout(700);
ok('the check-in switch is there, on', await page.locator('#cfgCheckins.on').count() === 1);
const chips = page.locator('#cfgCheckinHours .ci-h');
ok('6am to 9pm offered', await chips.count() === 16, await chips.count());
ok('8am, 12pm, 6pm picked by default', JSON.stringify(await page.locator('#cfgCheckinHours .ci-h.on').allInnerTexts()) === JSON.stringify(['8am', '12pm', '6pm']),
  await page.locator('#cfgCheckinHours .ci-h.on').allInnerTexts());
await page.locator('#cfgCheckinHours .ci-h', { hasText: /^3pm$/ }).click();
await page.waitForTimeout(500);
ok('tapping 3pm adds it', savedConfigs.some((c) => JSON.stringify(c.waitCheckinHours) === JSON.stringify([8, 12, 18, 15])), savedConfigs);
await page.locator('#cfgCheckinHours .ci-h', { hasText: /^8am$/ }).click();
await page.waitForTimeout(500);
ok('tapping 8am takes it off', savedConfigs.some((c) => Array.isArray(c.waitCheckinHours) && c.waitCheckinHours.indexOf(8) < 0), savedConfigs);
await page.locator('#cfgCheckins').click();
await page.waitForTimeout(500);
ok('the switch turns them off', savedConfigs.some((c) => c.waitCheckins === false), savedConfigs);
ok('it says whether this phone can ring', /notifications/i.test(await page.locator('#cfgCheckinPush').innerText()));
const af = page.locator('#cfgAutoFile');
ok('filing shows 14 days', await af.inputValue() === '14', await af.inputValue());
ok('Never is a choice', (await af.locator('option').allInnerTexts()).includes('Never'));
await af.selectOption('30');
await page.waitForTimeout(600);
ok('choosing 30 saves it', savedConfigs.some((c) => c.autoFileDays === 30), savedConfigs);
const setText = await page.locator('#fuSettings').innerText();
ok('the email hint hands over to the check-ins', /check-ins below keep reminding you/.test(setText));
ok('nothing new in settings uses an em dash', !/—/.test((setText.match(/Check in with me[\s\S]*Restore any of them[^.]*\./) || [''])[0]));

section('A check-in push opens on exactly the people waiting');
const second = await boot('https://texting.test/?waiting=1');
allErrs.push(second.errs);
const p2 = second.page;
const chip = await p2.locator('#filters .chip.active').allInnerTexts();
ok('the Waiting on me filter is on', chip.some((t) => /Waiting on me/.test(t)), chip);
const shown = (await p2.locator('.conv .nm').allInnerTexts()).map((s) => s.trim());
ok('only the people waiting are listed', shown.length >= 1 && shown.every((n) => ['Dave Ortiz', 'Ruth Ames'].includes(n)), shown);
ok('the query is cleaned off the address bar', !/waiting=1/.test(p2.url()), p2.url());

const errors = allErrs.flat();
console.log('\nJS errors: ' + (errors.length ? errors.join('\n') : 'none'));
if (errors.length) fail++;
console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
await browser.close();
process.exit(fail ? 1 : 0);
