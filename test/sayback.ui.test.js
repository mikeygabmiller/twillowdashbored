// "Say it back to them" — the chip, and everything that must be true before a
// word he never typed can land in a customer's text.
//
// Auto Polish is allowed to rewrite the box on its own because every change it
// makes is a subtraction with an undo. This one ADDS a method and a promise
// about a result, so the rules are stricter and this suite is about the rules,
// not the wording: it never lands on its own, you read the whole thing before
// you take it, your exact draft is one tap away afterwards, turning it down
// sticks, and nothing it produces is ever sent off to be polished again.
//
//   npm install && node test/sayback.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'back seat is trashed, my kid spilled juice everywhere', lastDir: 'in', lastTs: now - 60000 },
];
const thread = (phone) => ({
  phone, name: 'Dale Hobart', tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'back seat is trashed, my kid spilled juice everywhere', ts: now - 60000 }],
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

// The four beats, as the model would come back with them.
const SAID =
  "yea the juice on the back seat is one of the most common ones i get. " +
  "i'll hit it with a hot water extraction and go over the whole bench. " +
  "cant promise it all lifts but i'll get out as much as i can";
const asks = [];   // every polish request, so we can prove it never loops
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
    asks.push({ text: body.text, say: body.say });
    // The draft itself needs no fixing — this is the case the old polisher had
    // no answer for at all, and the one the chip exists for.
    return json({ ok: true, draft: body.text, note: '', sayBack: body.say === false ? '' : SAID });
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
const type = async (t) => { await page.locator('#msgInput').click(); await page.locator('#msgInput').fill(''); await page.locator('#msgInput').type(t, { delay: 10 }); };
const settle = () => page.waitForTimeout(3600);
const settleAfterOne = () => page.waitForTimeout(7200);

// Auto Polish ships OFF — nothing on this app calls the AI by itself unless he
// asked it to. Say it back rides that call, so the suite turns the engine on the
// way he would before testing what the passenger does.
await page.evaluate(() => window.__setAutoPolish(true));
await page.waitForTimeout(150);

await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(250);
await page.getByText('Dale Hobart', { exact: true }).first().click();
await page.waitForTimeout(600);

section('The flat reply gets an offer the old polisher had no answer for');
await type('yea i can clean that');
await settle();
let st = await P();
ok('the suggestion came back', st.say === SAID, st.say);
ok('but nothing touched the box', (await box()) === 'yea i can clean that', await box());
ok('and no rewrite was applied', st.applied === false);
ok('the chip is what you see first', await page.locator('#pbSayChip').count() === 1);
ok('it says what tapping it gets you',
  (await page.locator('#pbSayChip').innerText()).trim() === 'Say it back to them');

section('You read the whole thing before you can take it');
ok('there is no Use it button yet', await page.locator('#pbSayUse').count() === 0);
await page.locator('#pbSayChip').click();
await page.waitForTimeout(200);
const prev = await page.locator('#pbSayPrev').innerText();
ok('tapping the chip shows the message in full', prev.trim() === SAID, prev);
ok('now there is a Use it', await page.locator('#pbSayUse').count() === 1);
ok('…and a way to say no', await page.locator('#pbSayNo').count() === 1);
ok('the box is still untouched', (await box()) === 'yea i can clean that', await box());

section('Use it, and your words are still one tap away');
await page.locator('#pbSayUse').click();
await page.waitForTimeout(250);
ok('the fuller version is in the box', (await box()) === SAID, await box());
st = await P();
ok('your draft is remembered', st.sayBefore === 'yea i can clean that', st.sayBefore);
ok('undo is on the strip', await page.locator('#pbSayUndo').count() === 1);
const afterUse = asks.length;
await settleAfterOne();
ok('it never turns round and polishes what it just suggested', asks.length === afterUse, asks.map((a) => a.text));
await page.locator('#pbSayUndo').click();
await page.waitForTimeout(250);
ok('undo gives back your exact words', (await box()) === 'yea i can clean that', await box());
await settleAfterOne();
ok('…and that draft is left alone from then on', (await P()).say === '', await P());

section('Type past it and Undo retires — it never eats words you wrote after');
// The trap this avoids: take the say-back, add a sentence of your own, tap
// Undo, and lose the sentence. Auto Polish drops its chips the same way.
await type('yea ill sort the juice stain out for you');
await settleAfterOne();
await page.locator('#pbSayChip').click();
await page.waitForTimeout(150);
await page.locator('#pbSayUse').click();
await page.waitForTimeout(250);
ok('it landed and undo is there', await page.locator('#pbSayUndo').count() === 1);
// No click first — taking a suggestion by tapping a button has to hand the box
// back with the caret at the END, or the next word you type lands in the middle
// of the message you just accepted.
ok('the box has the focus back', await page.evaluate(() => document.activeElement.id) === 'msgInput');
await page.keyboard.type(' see you then', { delay: 10 });
await page.waitForTimeout(400);
ok('undo is gone once you type past it', await page.locator('#pbSayUndo').count() === 0);
ok('your added words are safe', (await box()).endsWith(' see you then'), await box());
ok('and it stopped calling it a way back', (await P()).sayBefore === '', await P());

section('Turning it down sticks');
await type('yea i can do that for you no problem');
await settleAfterOne();
ok('a new draft gets a new offer', !!(await P()).say);
await page.locator('#pbSayChip').click();
await page.waitForTimeout(150);
await page.locator('#pbSayNo').click();
await page.waitForTimeout(200);
ok('the suggestion is gone', (await P()).say === '');
ok('your wording is what is left', (await box()) === 'yea i can do that for you no problem', await box());
await settleAfterOne();
ok('and it is not offered again', (await P()).say === '', await P());

section('Its own switch, and off means off');
await page.evaluate(() => window.__setSayBack(false));
await page.waitForTimeout(150);
ok('the switch reads off', (await P()).sayOn === false);
await type('yea thats no trouble at all, happy to take a look');
await settleAfterOne();
ok('the request says not to bother', asks[asks.length - 1].say === false, asks[asks.length - 1]);
ok('nothing is offered', (await P()).say === '');
await page.evaluate(() => window.__setSayBack(true));
await page.waitForTimeout(150);
ok('and back on again', (await P()).sayOn === true);

section('Auto Polish is the engine and this is the passenger');
// The two switches are separate, but not symmetrical, and the asymmetry is the
// honest reading of "one AI call": the pause button means "I'm done, leave it",
// so it has to stop the spending too. Say it back decides what comes back on the
// call Auto Polish makes — it never makes one of its own.
await page.evaluate(() => window.__setAutoPolish(false));
await page.waitForTimeout(150);
const beforePause = asks.length;
await type('yea i can take care of that when im there');
await settleAfterOne();
ok('paused means no call at all', asks.length === beforePause, asks.map((a) => a.text));
ok('and so nothing is offered', (await P()).say === '');
ok('the box is untouched', (await box()) === 'yea i can take care of that when im there', await box());
await page.evaluate(() => window.__setAutoPolish(true));
await settleAfterOne();
ok('turning it back on brings the offer with it', (await P()).say === SAID, await P());
ok('…and the default it ships with is off', await page.evaluate(() => window.__defaultUI().autoPolish) === false);
ok('while the passenger ships on, because it never calls on its own',
  await page.evaluate(() => window.__defaultUI().sayBack) === true);

section('The switch he actually taps is in the Tools sheet');
await page.waitForTimeout(150);
await page.locator('#toolsBtn').click();
await page.waitForTimeout(350);
ok('the row is there', await page.locator('#tsSayBack').count() === 1);
ok('it is named in his language, not the schema\'s',
  (await page.locator('#tsSayBack b').innerText()).trim() === 'Say it back to them');
ok('and it reads as on', await page.locator('#tsSayBackSw.on').count() === 1);
await page.locator('#tsSayBack').click();
await page.waitForTimeout(250);
ok('tapping it turns it off', (await P()).sayOn === false);
await page.locator('#tsSayBack').click();
await page.waitForTimeout(250);
ok('and on again', (await P()).sayOn === true);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

section('Nothing broke');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
