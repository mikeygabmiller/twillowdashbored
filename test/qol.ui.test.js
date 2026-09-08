// Ten small things that were each a papercut, covered here in one suite because
// they share a fixture: a list you scroll, a thread you read back up, and a
// conversation you were half way through replying to.
//
// What each section is defending, and why it is worth a test:
//   • search only ever looked at the name, the number and the last text, so the
//     vehicle and the city sitting right there on the row found nobody
//   • a half-written reply was invisible until you happened to reopen the thread
//   • a bubble was the one thing in the app you could not act on
//   • a poll landing while you read back up a thread threw you to the bottom
//   • clearing the pile meant back → find → tap, three moves per reply
//   • the list went back to the top every single render
//   • a mis-tapped stage silently moved a lead off the board
//   • templates could say the name but never the vehicle or the price
//   • an unnamed conversation printed its phone number twice and asked for nothing
//   • a repeat customer's job got retyped from scratch every time
//
//   npm install && node test/qol.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

// Enough rows that the list actually scrolls, and three of them genuinely
// waiting on a reply so "next waiting" has an order to get right.
const rows = [
  { phone: '+14255550001', name: 'Dale Hobart', unread: 0, tags: [], status: 'active',
    vehicleLabel: '2019 black Silverado', city: 'Monroe', address: '148 Fir St',
    lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 3 * DAY, awaitingReply: true },
  { phone: '+14255550002', name: 'Ruth Alvarez', unread: 2, tags: [], status: 'new',
    vehicleLabel: '2021 white Odyssey', city: 'Snohomish',
    lastBody: 'what would the full detail run me', lastDir: 'in', lastTs: now - 2 * HOUR, awaitingReply: true },
  { phone: '+14255550003', name: 'Cam Whitley', unread: 0, tags: [], status: 'active',
    recap: 'asked about ceramic coating on the boat',
    lastBody: 'sounds good', lastDir: 'in', lastTs: now - 20 * MIN, awaitingReply: true },
  { phone: '+14255550004', name: '', unread: 0, tags: [],
    lastBody: 'hey is this mikey', lastDir: 'out', lastTs: now - 5 * DAY, awaitingReply: false },
];
for (let i = 5; i < 26; i++) {
  rows.push({ phone: '+142555500' + String(i).padStart(2, '0'), name: 'Filler ' + i, unread: 0, tags: [],
    lastBody: 'thanks!', lastDir: 'out', lastTs: now - (i + 6) * DAY, awaitingReply: false });
}

// Dale's thread is long on purpose — the jump-to-newest pill only means anything
// in a conversation you can actually scroll back up through.
const daleMsgs = [];
for (let i = 0; i < 40; i++) {
  daleMsgs.push({ id: 'd' + i, dir: i % 2 ? 'out' : 'in', body: 'line number ' + i + ' of the back and forth', ts: now - (60 - i) * MIN });
}
daleMsgs.push({ id: 'dq', dir: 'out', body: 'full detail on the Silverado is $220 out the door', ts: now - 4 * MIN, kind: 'manual', status: 'delivered' });
daleMsgs.push({ id: 'dlast', dir: 'in', body: 'you around thursday?', ts: now - 3 * DAY });

const threads = {
  '+14255550001': { messages: daleMsgs, garage: { address: '148 Fir St', city: 'Monroe', vehicles: [{ year: 2019, color: 'black', make: 'Chevy', model: 'Silverado' }] }, quote: { total: 220, at: now - 4 * MIN, service: 'Full detail' } },
  '+14255550002': { messages: [{ id: 'r1', dir: 'in', body: 'what would the full detail run me', ts: now - 2 * HOUR }] },
  '+14255550003': { messages: [{ id: 'c1', dir: 'in', body: 'sounds good', ts: now - 20 * MIN }] },
  '+14255550004': { messages: [{ id: 'u1', dir: 'out', body: 'hey is this mikey', ts: now - 5 * DAY }] },
};
const thread = (phone) => {
  const r = rows.find((x) => x.phone === phone) || {};
  const extra = threads[phone] || { messages: [] };
  return Object.assign({ phone, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '', status: r.status || '', messages: [] }, extra);
};

// Every write the page made, so a test can say what actually left the browser.
const metaPosts = [], tplPosts = [];
const byPhone = {};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 820 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
// prompt() is the naming flow; answer whatever the current test wants.
let promptAnswer = '';
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(promptAnswer) : d.accept()));

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/meta') {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    metaPosts.push(b);
    const r = rows.find((x) => x.phone === b.phone);
    if (r) { if ('status' in b) r.status = b.status; if ('name' in b) r.name = b.name; }
    const t = thread(b.phone);
    if ('status' in b) t.status = b.status;
    if ('name' in b) t.name = b.name;
    return json({ ok: true, thread: t });
  }
  if (path === '/api/templates') {
    if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {} tplPosts.push(b); return json({ ok: true }); }
    return json({ ok: true, templates: [
      ['Intro', "Hey {name}! It's Mikey — when works for a detail?"],
      ['Pitch', 'Hey {first_name}, still want the {vehicle} done? {price}, and I can be at {address} on {day}.'],
    ] });
  }
  if (path === '/api/money/by-phone') {
    const who = u.searchParams.get('phone');
    byPhone[who] = (byPhone[who] || 0) + 1;
    return json({ ok: true, phone: u.searchParams.get('phone'), jobs: 1, total: 240,
      entries: [{ id: 'e1', type: 'job', amount: 240, date: '2026-09-01', method: 'Venmo', service: 'Full detail', veh: 'Truck', city: 'Monroe', ts: now - 7 * DAY }] });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-08', entries: [], nudges: [], owed: [], summary: {}, config: { serviceTypes: ['Full detail', 'Maintenance'] } });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-08', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/ai/draft') return json({ ok: false, error: 'off' });
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
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(300);
};
const openThread = async (name) => {
  await toChats();
  await page.locator('.conv .nm', { hasText: name }).first().click();
  await page.waitForTimeout(600);
};
const search = async (q) => {
  await toChats();
  await page.locator('#search').fill(q);
  await page.waitForTimeout(300);
};
const names = () => page.$$eval('.conv .nm', (n) => n.map((x) => x.textContent.trim()));
// The desktop half of the long-press: both paths land in the same menu.
const rightClick = (sel) => page.locator(sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect();
  e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 12), clientY: Math.round(r.top + 12) }));
});

// ─────────────────────────────────────────────────────────────────────────────
section('Search finds what the row already knows');
await search('silverado');
ok('a vehicle nobody ever typed in the chat finds its customer', (await names()).includes('Dale Hobart'), await names());
await search('snohomish');
ok('so does a city', (await names()).includes('Ruth Alvarez'), await names());
await search('ceramic coating');
ok('and the one-line recap', (await names()).includes('Cam Whitley'), await names());
await search('fir st');
ok('and the street on file', (await names()).includes('Dale Hobart'), await names());
await search('hobart');
ok('the name still works', (await names()).includes('Dale Hobart'), await names());
ok('and it is not matching everybody', (await names()).length === 1, await names());
await search('');

// ─────────────────────────────────────────────────────────────────────────────
section('A half-written reply says so');
await openThread('Ruth Alvarez');
await page.locator('#msgInput').fill('for a van like yours it runs');
await page.waitForTimeout(200);
await toChats();
const draftRow = () => page.locator('.conv', { has: page.locator('.nm', { hasText: 'Ruth Alvarez' }) }).locator('.draft-flag');
ok('her row is flagged as a draft', (await draftRow().count()) === 1);
ok('nobody else is', (await page.locator('.draft-flag').count()) === 1, await page.locator('.draft-flag').count());
ok('the Today bar counts it', /1 draft/.test(await page.locator('#sumHead').innerText()), await page.locator('#sumHead').innerText());

await page.locator('.sum-pill[data-sum="is:draft"]').click();
await page.waitForTimeout(350);
ok('tapping the pill searches for it', (await page.locator('#search').inputValue()) === 'is:draft');
ok('and the list is only the draft', (await names()).length === 1 && (await names())[0] === 'Ruth Alvarez', await names());
await search('');

// ─────────────────────────────────────────────────────────────────────────────
section('A text is something you can act on');
await openThread('Dale Hobart');
await rightClick('.bubble[data-mid="dq"]');
await page.waitForTimeout(200);
const items = () => page.$$eval('.ctx-menu [data-m]', (n) => n.map((x) => x.getAttribute('data-m')));
ok('the menu opened on the bubble', (await page.locator('.ctx-menu').count()) === 1);
ok('you can copy it', (await items()).includes('copy'), await items());
ok('you can reuse it', (await items()).includes('reuse'), await items());
ok('an outgoing line can become a quick reply', (await items()).includes('tpl'), await items());
ok('and the $220 in it is offered to the tracker', (await items()).includes('money'), await items());
ok('the menu is headed with when it was sent', /\d:\d\d/.test(await page.locator('.ctx-name small').innerText()), await page.locator('.ctx-name small').innerText());

await page.locator('#msgInput').fill('sounds good —');
await page.locator('.ctx-menu [data-m="reuse"]').click();
await page.waitForTimeout(250);
ok('"put it in the box" appends rather than wiping your draft',
  (await page.locator('#msgInput').inputValue()) === 'sounds good — full detail on the Silverado is $220 out the door',
  await page.locator('#msgInput').inputValue());

await page.locator('#msgInput').fill('');
await rightClick('.bubble[data-mid="dlast"]');
await page.waitForTimeout(200);
ok('an incoming text is not offered as a quick reply of yours', !(await items()).includes('tpl'), await items());
ok('and one with no money in it is not offered to the tracker', !(await items()).includes('money'), await items());
promptAnswer = 'Thursday check';
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('escape closes it', (await page.locator('.ctx-menu').count()) === 0);

await rightClick('.bubble[data-mid="dq"]');
await page.waitForTimeout(150);
await page.locator('.ctx-menu [data-m="tpl"]').click();
await page.waitForTimeout(300);
ok('saving it as a quick reply sent the whole list up',
  tplPosts.length === 1 && tplPosts[0].templates.some((t) => t[0] === 'Thursday check' && /\$220/.test(t[1])), tplPosts.slice(-1));

// ─────────────────────────────────────────────────────────────────────────────
section('Reading back up a thread is not punished');
await openThread('Dale Hobart');
await page.locator('#messages').evaluate((b) => { b.scrollTop = 0; });
await page.waitForTimeout(250);
ok('the way back down is offered', await page.locator('#jumpNew').isVisible());
const jumpTxt = () => page.locator('#jumpNew').innerText();
ok('and it says what it is', /Jump to newest/i.test(await jumpTxt()), await jumpTxt());

// A poll lands while you are up there — it used to yank you to the bottom.
const topBefore = await page.locator('#messages').evaluate((b) => b.scrollTop);
await page.locator('#threadRefresh').click();
await page.waitForTimeout(700);
const topAfter = await page.locator('#messages').evaluate((b) => b.scrollTop);
ok('a refresh does not throw you to the bottom', Math.abs(topAfter - topBefore) < 40, { topBefore, topAfter });
ok('and the pill is still there', await page.locator('#jumpNew').isVisible());

await page.locator('#jumpNew').click();
await page.waitForTimeout(1400);
ok('tapping it lands you on the newest message',
  await page.locator('#messages').evaluate((b) => b.scrollHeight - b.scrollTop - b.clientHeight < 60));
ok('and the pill gets out of the way', !(await page.locator('#jumpNew').isVisible()));

// ─────────────────────────────────────────────────────────────────────────────
section('The next person waiting is one tap, not three');
await openThread('Dale Hobart');
ok('the button is there', await page.locator('#nextWaitBtn').isVisible());
ok('and counts the others waiting, not this one', (await page.locator('#nextWaitBtn .nw-n').innerText()) === '2',
  await page.locator('#nextWaitBtn .nw-n').innerText());
ok('it names who is up next, in the strip itself', /Ruth Alvarez/.test(await page.locator('#nextWaitBtn').innerText()),
  await page.locator('#nextWaitBtn').innerText());
ok('it does not crowd the header, where the name already fights for room',
  (await page.locator('.head-actions #nextWaitBtn').count()) === 0);
await page.locator('#nextWaitBtn').click();
await page.waitForTimeout(650);
ok('longest wait first — Ruth, not the one who texted 20 minutes ago',
  (await page.locator('#hName').innerText()) === 'Ruth Alvarez', await page.locator('#hName').innerText());
ok('the one you are now in is off the count', (await page.locator('#nextWaitBtn .nw-n').innerText()) === '2',
  await page.locator('#nextWaitBtn .nw-n').innerText());
ok('and the next one up is the longest wait again', /Dale Hobart/.test(await page.locator('#nextWaitBtn').innerText()),
  await page.locator('#nextWaitBtn').innerText());

// ─────────────────────────────────────────────────────────────────────────────
section('The list stays where you left it');
await toChats();
await page.locator('#scroll').evaluate((s) => { s.scrollTop = 400; });
await page.waitForTimeout(200);
const listBefore = await page.locator('#scroll').evaluate((s) => s.scrollTop);
ok('the list actually scrolled', listBefore > 200, listBefore);
await page.locator('.conv').first().click();
await page.waitForTimeout(500);
await page.locator('#backBtn').click();
await page.waitForTimeout(500);
const listAfter = await page.locator('#scroll').evaluate((s) => s.scrollTop);
ok('coming back out of a conversation does not send you to the top', Math.abs(listAfter - listBefore) < 40, { listBefore, listAfter });
await page.locator('.navitem[data-tab="home"]').click(); await page.waitForTimeout(300);
await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(350);
ok('but deliberately going to the tab does start at the top',
  (await page.locator('#scroll').evaluate((s) => s.scrollTop)) === 0);

// ─────────────────────────────────────────────────────────────────────────────
section('A mis-tapped stage is takeable back');
await toChats();
metaPosts.length = 0;
await rightClick('.conv');
await page.waitForTimeout(250);
await page.locator('.ctx-chip[data-st="lost"]').click();
await page.waitForTimeout(450);
ok('the change went out', metaPosts.some((m) => m.status === 'lost'), metaPosts);
ok('and it says which way it moved', /Lost/.test(await page.locator('#toast').innerText()), await page.locator('#toast').innerText());
ok('with a way back', (await page.locator('#toast .undo').count()) === 1);
await page.locator('#toast .undo').click();
await page.waitForTimeout(450);
ok('undo puts the old stage back', metaPosts.some((m) => m.status === 'active'), metaPosts);

// ─────────────────────────────────────────────────────────────────────────────
section('A template can say more than the name');
await openThread('Dale Hobart');
await page.locator('#msgInput').fill('');
await page.locator('#toolsBtn').click();
await page.waitForTimeout(250);
await page.locator('#toolsSheet [data-act="tpl"]').click();
await page.waitForTimeout(300);
ok('the hint names the new fields', /\{vehicle\}/.test(await page.locator('.tpl-hint').innerText()),
  await page.locator('.tpl-hint').innerText());
await page.locator('#tplMenu .tpl-it', { has: page.locator('b', { hasText: 'Pitch' }) }).locator('.tpl-ins').click();
await page.waitForTimeout(300);
const filled = await page.locator('#msgInput').inputValue();
ok('the vehicle comes off the thread', /2019 black Chevy Silverado/.test(filled), filled);
ok('so does the price you already quoted', /\$220/.test(filled), filled);
ok('and the address', /148 Fir St/.test(filled), filled);
ok('the first name still works', /^Hey Dale,/.test(filled), filled);
ok('nothing was left as a raw placeholder', !/\{[a-z_]+\}/.test(filled), filled);

// ─────────────────────────────────────────────────────────────────────────────
section('An unnamed conversation asks to be named');
await openThread('(425) 555-0004');
ok('the header offers it instead of repeating the number', /Add a name/.test(await page.locator('#hNum').innerText()),
  await page.locator('#hNum').innerText());
metaPosts.length = 0;
promptAnswer = 'Jen Ortiz';
await page.locator('#hNum').click();
await page.waitForTimeout(450);
ok('the name was saved', metaPosts.some((m) => m.name === 'Jen Ortiz'), metaPosts);
ok('and the header stops asking', !/Add a name/.test(await page.locator('#hNum').innerText()),
  await page.locator('#hNum').innerText());
await openThread('Dale Hobart');
ok('a conversation that has a name shows the number, not the ask',
  /\(425\) 555-0001/.test(await page.locator('#hNum').innerText()), await page.locator('#hNum').innerText());

// ─────────────────────────────────────────────────────────────────────────────
section('A repeat customer is not retyped');
await rightClick('.bubble[data-mid="dq"]');
await page.waitForTimeout(200);
await page.locator('.ctx-menu [data-m="money"]').click();
await page.waitForTimeout(700);
ok('the money sheet opened', await page.locator('#moSheet').evaluate((e) => e.classList.contains('show')));
ok('with the amount out of the text already in it', /220/.test(await page.locator('#moAmt').innerText()),
  await page.locator('#moAmt').innerText());
ok('and the customer attached', /Dale/.test(await page.locator('#moCust').innerText()), await page.locator('#moCust').innerText());
ok('their history was fetched once for the whole session, not again for the sheet',
  (await page.evaluate(() => 1)) && byPhone['+14255550001'] === 1, byPhone);
ok('and offered as one chip', await page.locator('#moAgainBtn').isVisible());
ok('the chip says what it would fill in', /\$240/.test(await page.locator('#moAgainBtn').innerText()),
  await page.locator('#moAgainBtn').innerText());
await page.locator('#moAgainBtn').click();
await page.waitForTimeout(300);
ok('tapping it fills the amount', /240/.test(await page.locator('#moAmt').innerText()), await page.locator('#moAmt').innerText());
ok('the payment method', (await page.locator('#moMeth .mo-chip.on').innerText()).trim() === 'Venmo',
  await page.locator('#moMeth .mo-chip.on').innerText());
ok('the service', (await page.locator('#moSvc .mo-chip.on').innerText()).trim() === 'Full detail',
  await page.locator('#moSvc .mo-chip.on').innerText());
ok('the vehicle', (await page.locator('#moVeh .mo-chip.on').innerText()).trim() === 'Truck',
  await page.locator('#moVeh .mo-chip.on').innerText());
ok('and the city', (await page.locator('#moCity').inputValue()) === 'Monroe', await page.locator('#moCity').inputValue());

console.log('\nJS errors:', errs.length ? errs.join('\n') : 'none');
if (errs.length) fail += errs.length;
console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
await browser.close();
process.exit(fail ? 1 : 0);
