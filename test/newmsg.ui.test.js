// Starting a text is the move that has to be effortless, because it is the one
// that competes with just picking up your own phone. It used to be a browser
// prompt() demanding ten digits from memory. This covers the replacement: a
// person picker you search by name, a typed-in number that still works, and a
// brand-new conversation that offers openers instead of a blank box.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Jenna Smith',  unread: 0, lastBody: 'sounds good',  lastTs: now - 1000,   lastDir: 'in', tags: [] },
  { phone: '+14255557777', name: 'Carlos Reyes', unread: 0, lastBody: 'thanks!',      lastTs: now - 90000,  lastDir: 'in', tags: [] },
  { phone: '+12065558888', name: '',             unread: 0, lastBody: 'who is this',  lastTs: now - 200000, lastDir: 'in', tags: [] },
  { phone: '+14255550000', name: 'Stopped Sam',  unread: 0, lastBody: 'STOP',         lastTs: now - 300000, lastDir: 'in', tags: [], optedOut: true },
];
const threads = {
  '+14255551234': { phone: '+14255551234', name: 'Jenna Smith', tags: [], messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: now - 1000 }], scheduled: [], linked: [], notes: '' },
  '+14255557777': { phone: '+14255557777', name: 'Carlos Reyes', tags: [], messages: [{ id: 'm2', dir: 'in', body: 'thanks!', ts: now - 90000 }], scheduled: [], linked: [], notes: '' },
};
const blank = (phone) => ({ phone, name: '', tags: [], messages: [], scheduled: [], linked: [], notes: '' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sent = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = threads[want] || blank(want);
    return json(out);
  }
  if (path === '/api/send') { try { sent.push(JSON.parse(req.postData() || '{}')); } catch (_) {} return json({ ok: true }); }
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

const backToList = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click();
  await page.waitForTimeout(300);
};
const openPicker = async () => {
  await backToList();
  await page.locator('#fab').click();
  await page.waitForTimeout(400);
};
const npNames = () => page.locator('#npList .np-row .np-txt b').allInnerTexts();

section('The pencil opens a person picker, not a prompt for digits');
await openPicker();
ok('the sheet is showing', await page.locator('#npQ').isVisible());
let names = await npNames();
ok('everyone he has texted is listed', names.length >= 4, names);
ok('most recent first', names[0] === 'Jenna Smith', names);
ok('a nameless number still shows as a number', names.some((n) => /206\) 555-8888/.test(n)), names);
ok('someone who texted STOP is flagged, not hidden', await page.locator('#npList .np-dnt').count() > 0);

section('Search by name — the thing you actually remember');
await page.locator('#npQ').fill('carl');
await page.waitForTimeout(250);
names = await npNames();
ok('narrows to the match', names.length === 1 && names[0] === 'Carlos Reyes', names);

section('…and by digits, for when you have the number in front of you');
await page.locator('#npQ').fill('5557777');
await page.waitForTimeout(250);
names = await npNames();
ok('finds the person by their number', names.some((n) => /Carlos/.test(n)), names);

section('Tapping a person lands you in the conversation, cursor ready');
await page.locator('#npList .np-row').first().click();
await page.waitForTimeout(700);
ok('the conversation is open', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('…and it is the right one', (await page.locator('#hName').innerText()).includes('Carlos'));
ok('the sheet got out of the way', await page.locator('#jdScrim.show').count() === 0);
ok('the message box has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'msgInput'));

section('A number he has never texted is offered as its own row');
await openPicker();
await page.locator('#npQ').fill('(425) 555-9999');
await page.waitForTimeout(250);
names = await npNames();
ok('offers to text the new number', names.some((n) => /Text \(425\) 555-9999/.test(n)), names);
await page.locator('#npList .np-row').first().click();
await page.waitForTimeout(700);
ok('opens a conversation with that number', (await page.locator('#hName').innerText()).includes('555-9999'));

section('A brand-new conversation offers openers instead of a blank box');
ok('quick replies are showing', await page.locator('#qReply').isVisible());
const chips = await page.locator('#qReply button').allInnerTexts();
ok('at most three, and at least one', chips.length > 0 && chips.length <= 3, chips);
ok('one of them is an opening line', /intro|quote/i.test(chips.join(' ')), chips);
await page.locator('#qReply button').first().click();
await page.waitForTimeout(250);
ok('tapping one writes the text for you', (await page.inputValue('#msgInput')).length > 10);

section('An in-flight conversation is unchanged — no nagging when you spoke last');
await backToList();
await page.getByText('Jenna Smith', { exact: true }).first().click();
await page.waitForTimeout(600);
ok('they spoke last, so chips are offered', await page.locator('#qReply').isVisible());

section('Nothing broke');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
