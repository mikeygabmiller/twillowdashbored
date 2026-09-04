// Auto Polish rewrites the message box for you when you stop typing — nobody
// taps "accept" any more. That trade only holds if the way back is real, so
// this suite is mostly about the way back: undo restores the exact words you
// typed, one tapped chip restores one spot and leaves the rest polished, pause
// stops the next rewrite dead, and — the thing that would make it unusable —
// nothing it produces can ever be sent off to be polished again.
//
//   npm install && node test/polish.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 60000 },
  { phone: '+14255557777', name: 'Rita Cole',   unread: 0, tags: [], lastBody: 'how much for a full detail', lastDir: 'in', lastTs: now - 90000 },
];
const thread = (phone) => ({
  phone, name: (rows.find((r) => r.phone === phone) || {}).name || '', tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'you around thursday?', ts: now - 60000 }],
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

// Every draft the polisher is asked about, in order. This is the list that
// proves it can't loop: its own output must never show up here.
const polishAsks = [];
// Deterministic stand-in for the model. Three shapes, because polish now has
// three answers rather than one: a small fix (swap a word, add a sign-off — a
// replacement and an insertion, so there are chips to tap), a rewrite so large
// it has to be offered instead of applied, and "this is fine, but look at this"
// — a note with no rewrite at all.
const BIG = 'Thursday morning works great for me. Want me to put you down?';
const fakePolish = (t) => {
  if (/^so basically/i.test(t)) return { draft: BIG, note: '' };
  if (/^cant do thurs/i.test(t)) return { draft: t, note: 'reads a little curt' };
  return { draft: t.replace(/\bthurs\b/i, 'Thursday').replace(/\byea\b/i, 'Yes') + ' Thanks!', note: '' };
};

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
  if (path === '/api/ai/draft') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    if (!body.text) return json({ ok: true, draft: 'Written for you.' });
    polishAsks.push(body.text);
    const out = fakePolish(body.text);
    return json({ ok: true, draft: out.draft, note: out.note });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const P = () => page.evaluate(() => window.__polish());
const box = () => page.inputValue('#msgInput');
// Type into the composer the way a person does — the debounce only ever sees
// real input events this way.
const type = async (t) => { await page.locator('#msgInput').click(); await page.locator('#msgInput').fill(''); await page.locator('#msgInput').type(t, { delay: 12 }); };
const openThread = async (name) => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(600);
};
// Long enough to cover the idle wait plus the request, short enough that a
// regression back to the old 1600ms would still pass — the wait itself is
// asserted separately, off the constant.
const settle = () => page.waitForTimeout(3600);
// Back-to-back rewrites are held apart by POLISH_COOLDOWN (6s), so a section
// that polishes right after another one has to outwait the cooldown, not just
// the idle pause.
const settleAfterOne = () => page.waitForTimeout(7200);

section('It waits noticeably longer than it did when it only offered');
const idle = (await P()).idle;
ok('the pause before a rewrite is 2400ms — half again the old 1600', idle === 2400, idle);

section('Stop typing and it just rewrites the box — no bar to tap, no sheet');
await openThread('Dale Hobart');
await type('yea thurs works for me, ill swing by around ten');
await page.waitForTimeout(1200);
ok('nothing has happened yet at 1.2s', !(await P()).applied);
ok('but it says what it is about to do', (await page.locator('#polishBar .pb-t').innerText()).includes('when you pause'));
await settle();
let st = await P();
ok('the rewrite landed on its own', st.applied === true);
ok('the box holds the polished words', (await box()).includes('Thursday') && (await box()).includes('Thanks!'), await box());
ok('your original is remembered', st.before === 'yea thurs works for me, ill swing by around ten', st.before);
ok('it asked about your draft exactly once', polishAsks.length === 1, polishAsks);

section('…and it never turns around and polishes its own output');
await page.waitForTimeout(3000);
ok('still just the one call', polishAsks.length === 1, polishAsks);

section('Every change it made is its own chip');
const chips = await page.locator('#polishBar .pb-w').allInnerTexts();
ok('there are chips to tap', chips.length >= 2, chips);
ok('one of them is the word it swapped', chips.some((c) => /Thursday/i.test(c)), chips);
ok('one of them is the words it added', chips.some((c) => /Thanks/i.test(c)), chips);

section('Tap one chip: your word comes back, the rest of the polish stays');
const thursChip = page.locator('#polishBar .pb-w').filter({ hasText: 'Thursday' }).first();
await thursChip.click();
await page.waitForTimeout(250);
let v = await box();
ok('your wording is back for that spot', /\bthurs\b/i.test(v) && !/Thursday/i.test(v), v);
ok('…and everything else it fixed is still fixed', v.includes('Thanks!'), v);
st = await P();
ok('the chip now reads as yours', st.changes.some((c) => c.mine && /thurs/i.test(c.from)), st.changes);
await page.waitForTimeout(3200);
ok('putting a word back does not trigger another rewrite', polishAsks.length === 1, polishAsks);

section('Tap it again and you get the polished word back — it is a toggle');
await page.locator('#polishBar .pb-w').filter({ hasText: 'thurs' }).first().click();
await page.waitForTimeout(250);
ok('the polished word returns', /Thursday/.test(await box()), await box());

section('Undo puts back exactly what you typed, character for character');
await page.locator('#pbUndo').click();
await page.waitForTimeout(250);
ok('your draft is back verbatim', (await box()) === 'yea thurs works for me, ill swing by around ten', await box());
ok('the undo state is cleared', (await P()).applied === false);
await page.waitForTimeout(3400);
ok('and it does not immediately re-polish what you just undid', polishAsks.length === 1, polishAsks);

section('Pause stops the next rewrite on the spot');
await page.locator('#pbPP').click();
await page.waitForTimeout(200);
ok('auto polish is off', (await P()).on === false);
ok('the strip says so', (await page.locator('#polishBar .pb-t').innerText()).includes('paused'));
await type('hey there, tomorrow morning is wide open if that works better');
await settle();
ok('nothing was sent while paused', polishAsks.length === 1, polishAsks);
ok('the box is untouched', (await box()).startsWith('hey there'), await box());

section('Play starts it again');
await page.locator('#pbPP').click();
await settle();
ok('it is back on', (await P()).on === true);
ok('and it rewrote the waiting draft', polishAsks.length === 2 && (await P()).applied === true, polishAsks);

section('Switching conversations never carries a rewrite across');
await openThread('Rita Cole');
st = await P();
ok('the applied state is wiped', st.applied === false);
ok('the strip is gone', await page.locator('#polishBar.show').count() === 0);
ok('the other draft did not follow', (await box()) === '', await box());

section('A short "ok" is not worth a call');
const beforeShort = polishAsks.length;
await type('ok');
await settle();
ok('two letters are left alone', polishAsks.length === beforeShort, polishAsks);

section('A message with nothing wrong gets a word about tone instead of a rewrite');
// 14 characters — under the old 15-char floor, which is the point: the texts
// most likely to land badly are the short blunt ones, and they were the ones
// polish never looked at.
await openThread('Dale Hobart');
const beforeNote = polishAsks.length;
await type('cant do thurs.');
await settleAfterOne();
st = await P();
ok('the short one was looked at now', polishAsks.length === beforeNote + 1, polishAsks);
ok('his words are untouched', (await box()) === 'cant do thurs.', await box());
ok('nothing was applied', st.applied === false);
ok('but it said the one thing', st.note === 'reads a little curt', st.note);
ok('and the strip shows it', (await page.locator('#polishBar .pb-note').innerText()).includes('curt'));
ok('the label says it reads fine', (await page.locator('#polishBar .pb-t').innerText()).includes('one thing to look at'));

section('A rewrite big enough to be a different message waits to be asked for');
const beforeBig = polishAsks.length;
await type('so basically i was thinking maybe thursday could work if your around');
await settleAfterOne();
st = await P();
ok('it did ask the model', polishAsks.length === beforeBig + 1, polishAsks);
ok('but your words are still in the box', (await box()).startsWith('so basically'), await box());
ok('nothing was applied behind your back', st.applied === false);
ok('it is holding a version for you', !!st.offer && st.offer.out === BIG, st.offer);
ok('the strip says whose call it is', (await page.locator('#polishBar .pb-t').innerText()).includes('your call'));
ok('and shows you the version before you take it', (await page.locator('#pbPrev').innerText()).includes('put you down'));
ok('the cap is 40% of the words', (await P()).cap === 0.4, (await P()).cap);

section('Take it and it behaves exactly like an ordinary polish');
await page.locator('#pbUse').click();
await page.waitForTimeout(300);
ok('the rewrite is in the box', (await box()) === BIG, await box());
st = await P();
ok('it is applied now', st.applied === true);
ok('your original is remembered', st.before.startsWith('so basically'), st.before);
ok('there are chips to put words back', (await page.locator('#polishBar .pb-w').count()) > 0);
await page.locator('#pbUndo').click();
await page.waitForTimeout(250);
ok('undo still gives you your exact draft', (await box()).startsWith('so basically'), await box());

section('Turn it down and it stays turned down');
await type('so basically thursday morning could work for me if your around then');
await settleAfterOne();
ok('it offered again on a new draft', !!(await P()).offer);
await page.locator('#pbNo').click();
await page.waitForTimeout(250);
ok('your words are what is left', (await box()).startsWith('so basically thursday morning'), await box());
ok('the offer is gone', (await P()).offer === null);
const afterNo = polishAsks.length;
await settleAfterOne();
ok('and it is never offered again', polishAsks.length === afterNo && (await P()).offer === null, polishAsks);
ok('the strip got out of the way', await page.locator('#polishBar.show').count() === 0);

section('Nothing broke');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
