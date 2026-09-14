// Five quality-of-life features, in the two places the usage tracker says the
// time actually goes: inside a conversation, and on the way in and out of one.
//
//   1. "What's open?" — his own booking calendar, answered without leaving the
//      thread, written into the box rather than sent.
//   2. Reply straight from the swipe peek, which is the whole point of a peek:
//      answering without opening (opening clears unread).
//   3. The end-of-job wrap-up — the appointment passed, so log it, win it, ask
//      for the review. The review is a DRAFT. Nothing here texts anybody.
//   4. Quiet hours became a decision ("send it at 8am") instead of a warning.
//   5. Select several conversations and clear them in one move.
//
//   npm install && node test/five.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const DAY = 86400000;

// A booked job that happened yesterday, so the wrap-up has something real to be
// about; the others are the pile.
const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 2, tags: [], lastBody: 'what time can you do saturday?', lastDir: 'in', lastTs: now - 60000 },
  { phone: '+14255559876', name: 'Ruth Keller', unread: 1, tags: [], lastBody: 'thanks!', lastDir: 'in', lastTs: now - 90000, appointmentAt: now - DAY },
  { phone: '+14255550000', name: 'Sam Ortiz', unread: 0, tags: [], lastBody: 'sounds good', lastDir: 'in', lastTs: now - 120000 },
];
const thread = (phone) => {
  const r = rows.find((x) => x.phone === phone) || {};
  return {
    phone, name: r.name || '', tags: [], scheduled: [], linked: [], notes: '',
    unread: r.unread || 0, appointmentAt: r.appointmentAt || null, status: '',
    messages: [{ id: 'm1', dir: 'in', body: r.lastBody, ts: r.lastTs }],
  };
};

const sends = [], scheduled = [], metas = [], reads = [];
// Quiet hours are read off the served config, and the app lives inside an IIFE
// the test can't reach into — so the SERVER decides, and the page is reloaded
// when it changes. 0→24 is "always quiet", 0→0 is "never".
let QUIET = false;
let OPENINGS = { ok: true, days: [
  { date: new Date(now + DAY).toISOString().slice(0, 10), slots: ['09:00', '13:00'] },
  { date: new Date(now + 2 * DAY).toISOString().slice(0, 10), slots: ['10:00'] },
] };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('dialog', (d) => d.accept());

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (_) { return {}; } };
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/openings') return json(OPENINGS);
  if (path === '/api/send') { const b = body(); sends.push(b); const t = thread(b.phone); t.messages.push({ id: 's' + sends.length, dir: 'out', body: b.body, ts: Date.now(), kind: 'manual', status: 'sent' }); return json({ ok: true, thread: t }); }
  if (path === '/api/schedule') { const b = body(); scheduled.push(b); return json({ ok: true, thread: thread(b.phone) }); }
  if (path === '/api/meta') { const b = body(); metas.push(b); return json({ ok: true, thread: Object.assign(thread(b.phone), b) }); }
  if (path === '/api/read') { reads.push(body()); return json({ ok: true }); }
  // Quiet hours and the review link live in the real config endpoint — which is
  // also why this suite works at any hour: the server, not the clock, decides.
  if (path === '/api/config') return json({ ok: true, config: { reviewUrl: 'https://g.page/r/mikey/review',
    quietStart: 0, quietEnd: QUIET ? 24 : 0 } });
  if (path === '/api/money/by-phone') return json({ ok: true, phone: u.searchParams.get('phone'), jobs: 0, total: 0, entries: [] });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/templates') return json({ ok: true, templates: [['On my way', "On my way — see you in about 20."], ['Price', 'A full detail on an SUV runs $250.']] });
  if (path === '/api/ai/draft') return json({ ok: false, error: 'off' });
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-14', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-14', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

// Escape closes any of these sheets (jdSheetOpen wires it), and it never has to
// fight the card for the click the way a tap on the scrim does.
const closeSheet = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#jdSheet.show').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
};
const toList = async () => {
  if (await page.evaluate(() => document.getElementById('details').classList.contains('open'))) {
    await page.locator('#detailsClose').click(); await page.waitForTimeout(300);
  }
  await closeSheet();
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(300);
};
const openThread = async (name) => { await toList(); await page.getByText(name, { exact: true }).first().click(); await page.waitForTimeout(600); };
const setQuiet = async (on) => { QUIET = on; await page.reload(); await page.waitForTimeout(900); };
// A real finger drag — the swipe that opens the peek. Same helper peek.ui uses.
const drag = async (sel, dx) => {
  const box = await page.locator(sel).first().boundingBox();
  const y = box.y + box.height / 2, x = box.x + box.width / 2;
  await page.evaluate(({ sel, dx, x, y }) => {
    const node = document.querySelectorAll(sel)[0];
    const t = (cx) => ({ touches: [{ clientX: cx, clientY: y }], changedTouches: [{ clientX: cx, clientY: y }] });
    const fire = (name, cx) => { const ev = new Event(name, { bubbles: true }); Object.assign(ev, t(cx)); node.dispatchEvent(ev); };
    fire('touchstart', x);
    for (let i = 1; i <= 6; i++) fire('touchmove', x + (dx * i) / 6);
    fire('touchend', x + dx);
  }, { sel, dx, x, y });
  await page.waitForTimeout(450);
};

// ---------------------------------------------------------------- 1. openings
section('1 · What\'s open — the calendar, inside the conversation');
await openThread('Dale Hobart');
ok('they asked about timing, so the chip is right there', await page.locator('.qreply .qr-open').isVisible());
await page.locator('.qreply .qr-open').click();
await page.waitForTimeout(500);
ok('the sheet lists the days that have room', (await page.locator('.op-day').count()) === 2, await page.locator('.op-day').count());
ok('with his real times on them', (await page.locator('.op-slot').count()) === 3);
ok('and nothing is picked yet', (await page.locator('.op-prev.empty').count()) === 1);
await page.locator('.op-slot').first().click();
await page.locator('.op-slot').nth(1).click();
await page.waitForTimeout(200);
const prev = await page.locator('.op-prev').innerText();
ok('two times read as one sentence', /I could do tomorrow at 9am or 1pm/.test(prev), prev);
await page.locator('#opGo').click();
await page.waitForTimeout(400);
const boxTxt = await page.inputValue('#msgInput');
ok('it lands in the box', /I could do tomorrow at 9am or 1pm/.test(boxTxt), boxTxt);
ok('and nothing was sent', sends.length === 0, sends);
await page.locator('#msgInput').fill('');

section('…and it never offers more than three times');
OPENINGS = { ok: true, days: [{ date: new Date(now + DAY).toISOString().slice(0, 10), slots: ['09:00', '10:00', '11:00', '13:00'] }] };
await page.locator('.qreply .qr-open').click();
await page.waitForTimeout(500);
for (const i of [0, 1, 2, 3]) { await page.locator('.op-slot').nth(i).click(); await page.waitForTimeout(120); }
ok('the fourth tap is refused', (await page.locator('.op-slot.on').count()) === 3, await page.locator('.op-slot.on').count());
await closeSheet();

// ------------------------------------------------------------ 2. peek reply
section('2 · Answering from the peek, without opening the thread');
await toList();
await drag('.conv', -120);   // left swipe on the top row = peek
ok('the peek has a reply box now', await page.locator('#pkBox').isVisible());
ok('and his own quick replies under it', (await page.locator('.pk-qrb').count()) === 2);
await page.locator('.pk-qrb').first().click();
await page.waitForTimeout(150);
ok('a quick reply fills the box', (await page.inputValue('#pkBox')).includes('On my way'), await page.inputValue('#pkBox'));
await page.locator('#pkBox').fill('perfect, see you saturday');
await page.locator('#pkSend').click();
await page.waitForTimeout(300);
ok('it goes out through the same ten-second hold', await page.locator('#toast .undo').isVisible());
await page.locator('#toast .now').click();
await page.waitForTimeout(400);
ok('sent to the person whose row was swiped', sends.length === 1 && sends[0].phone === rows[0].phone, sends);
ok('with the right words', sends[0] && sends[0].body === 'perfect, see you saturday', sends);
ok('and the thread was never opened — unread is untouched', !(await page.evaluate(() => document.body.classList.contains('viewing'))));
await closeSheet();

// --------------------------------------------------------- 3. the wrap-up
section('3 · The job is done — wrap it up');
await openThread('Ruth Keller');
ok('the banner says which job', /job is done/i.test(await page.locator('#logJobBanner').innerText()), await page.locator('#logJobBanner').innerText());
ok('it offers the money', (await page.locator('[data-wrap="money"]').count()) === 1);
ok('it offers the stage', (await page.locator('[data-wrap="won"]').count()) === 1);
ok('it offers the review', (await page.locator('[data-wrap="review"]').count()) === 1);
await page.locator('[data-wrap="review"]').click();
await page.waitForTimeout(300);
const rev = await page.inputValue('#msgInput');
ok('the review ask is written into the box', /review/i.test(rev) && rev.includes('https://g.page/r/mikey/review'), rev);
ok('it is a draft — nothing was sent', sends.length === 1, sends);
await page.locator('#msgInput').fill('');
await page.locator('[data-wrap="skip"]').click();
await page.waitForTimeout(300);
ok('waving it off puts it away', !(await page.locator('#logJobBanner').isVisible()));
await page.reload(); await page.waitForTimeout(900);
await openThread('Ruth Keller');
ok('and it stays away after a reload', !(await page.locator('#logJobBanner').isVisible()));

// ------------------------------------------------------- 4. quiet hours
section('4 · Quiet hours: a decision, not a warning');
await setQuiet(true);            // this reloads, so the thread is opened after it
await openThread('Dale Hobart');
await page.locator('#msgInput').fill('you around tomorrow?');
await page.locator('#sendBtn').click();
await page.waitForTimeout(500);
// A closed sheet keeps its markup, so "is it open" asks about the sheet itself.
const qhOpen = async () => (await page.locator('#jdSheet.show #qhCard').count()) > 0;
ok('it stops and says what time it is', await qhOpen());
ok('the words are shown, not thrown away', (await page.locator('.qh-msg').innerText()).includes('you around tomorrow?'));
ok('nothing was sent', sends.length === 1, sends);
ok('there is a one-tap morning option', /Send it .* at /.test(await page.locator('#qhLater').innerText()), await page.locator('#qhLater').innerText());
await page.locator('#qhLater').click();
await page.waitForTimeout(500);
ok('it scheduled instead', scheduled.length === 1 && scheduled[0].body === 'you around tomorrow?', scheduled);
const at = scheduled[0] && new Date(scheduled[0].sendAt);
ok('for the hour his quiet hours end', at && at.getHours() === 0, at && at.getHours());
ok('and the box is empty — it cannot go twice', (await page.inputValue('#msgInput')) === '', await page.inputValue('#msgInput'));

section('…and "send it now anyway" is still one tap');
await page.locator('#msgInput').fill('actually this cannot wait');
await page.locator('#sendBtn').click();
await page.waitForTimeout(400);
await page.locator('#qhNow').click();
await page.waitForTimeout(400);
if (await page.locator('#toast .now').isVisible()) await page.locator('#toast .now').click();
await page.waitForTimeout(400);
ok('it sent', sends.length === 2 && sends[1].body === 'actually this cannot wait', sends);
// Having said "now" once, the hour is settled for this sitting — the next text
// goes straight out instead of asking the same question again.
await page.locator('#msgInput').fill('and one more thing');
await page.locator('#sendBtn').click();
await page.waitForTimeout(400);
ok('and it does not ask again this sitting', (await page.locator('#jdSheet.show').count()) === 0);
if (await page.locator('#toast .now').isVisible()) await page.locator('#toast .now').click();
await page.waitForTimeout(400);
ok('the next one just goes', sends.length === 3, sends);
await setQuiet(false);           // back to ordinary hours for the list tests

// ---------------------------------------------------------- 5. select mode
section('5 · Clearing the pile ten rows at a time');
await toList();
ok('Select sits with the other Today pills', await page.locator('[data-sum="select"]').isVisible());
await page.locator('[data-sum="select"]').click();
await page.waitForTimeout(300);
ok('the bar appears', await page.locator('#selBar').isVisible());
ok('it says what to do', (await page.locator('.sb-n').innerText()).includes('Tap the ones'));
ok('and nothing can be acted on yet', await page.locator('[data-sb="archive"]').isDisabled());
await page.locator('.conv').first().click();
await page.locator('.conv').nth(1).click();
await page.waitForTimeout(250);
ok('two are picked', (await page.locator('.conv.picked').count()) === 2);
ok('the bar counts them', (await page.locator('.sb-n').innerText()).includes('2 selected'));
ok('tapping a row did not open it', !(await page.evaluate(() => document.body.classList.contains('viewing'))));
await page.locator('[data-sb="all"]').click();
await page.waitForTimeout(250);
ok('"All" takes the whole list', (await page.locator('.conv.picked').count()) === 3);
await page.locator('[data-sb="all"]').click();
await page.waitForTimeout(250);
ok('…and tapping it again lets them all go', (await page.locator('.conv.picked').count()) === 0);
await page.locator('.conv').first().click();
await page.locator('.conv').nth(1).click();
await page.waitForTimeout(200);
await page.locator('[data-sb="read"]').click();
await page.waitForTimeout(500);
ok('both were marked read in one move', reads.length === 2 && reads.every((r) => r.read === true), reads);
ok('and select mode got out of the way', (await page.locator('#selBar').count()) === 0);

section('Archiving several hands back an undo');
await page.locator('[data-sum="select"]').click();
await page.waitForTimeout(250);
await page.locator('.conv').first().click();
await page.locator('.conv').nth(1).click();
await page.waitForTimeout(200);
await page.locator('[data-sb="archive"]').click();
await page.waitForTimeout(500);
ok('two archived', metas.filter((m) => m.archived === true).length === 2, metas);
ok('with a way back', await page.locator('#toast .undo').isVisible());
await page.locator('#toast .undo').click();
await page.waitForTimeout(500);
ok('undo put them back', metas.filter((m) => m.archived === false).length === 2, metas);

console.log('\nJS errors:', errs.length ? errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;
console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
