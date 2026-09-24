// Word of mouth, in the app.
//
// Three places, one rule each. The conversation asks "Sent by Dave?" when a new
// lead says so, and answering it takes one tap on the right Dave. Details always
// has a "Who sent them" row, so a referral nobody typed can still go on file.
// And the Word of mouth sheet opens the thank-you in the referrer's box — typed,
// never sent. Nothing in this suite may reach /api/send.
//
//   npm install && node test/referral.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const NEW = '+14255550202', DAVE = '+14255550201', DAVE2 = '+14255550209', SAM = '+14255550301';

const rows = [
  { phone: NEW, name: 'Kim Nguyen', unread: 1, tags: [], lastBody: 'Dave told me about you!', lastDir: 'in', lastTs: now - 60000,
    refGuess: 'Dave', refGuessLine: 'Dave told me about you! need a full detail' },
  { phone: DAVE, name: 'Dave Park', status: 'won', unread: 0, tags: [], lastBody: 'thanks man', lastDir: 'in', lastTs: now - 9 * 86400000 },
  { phone: DAVE2, name: 'Dave Ruiz', status: 'lost', unread: 0, tags: [], lastBody: 'no thanks', lastDir: 'in', lastTs: now - 40 * 86400000 },
  { phone: SAM, name: 'Sam Ortiz', status: 'won', unread: 0, tags: [], lastBody: 'see ya', lastDir: 'in', lastTs: now - 20 * 86400000 },
];
const THREADS = {
  [NEW]: { phone: NEW, name: 'Kim Nguyen', tags: [], scheduled: [], linked: [], notes: '',
    refGuess: { name: 'Dave', rel: '', line: 'Dave told me about you! need a full detail', at: now - 60000 },
    messages: [{ id: 'm1', dir: 'in', body: 'Dave told me about you! need a full detail', ts: now - 60000 }] },
  [DAVE]: { phone: DAVE, name: 'Dave Park', status: 'won', tags: [], scheduled: [], linked: [], notes: '',
    messages: [{ id: 'm1', dir: 'in', body: 'thanks man', ts: now - 9 * 86400000 }] },
  [SAM]: { phone: SAM, name: 'Sam Ortiz', status: 'won', tags: [], scheduled: [], linked: [], notes: '',
    messages: [{ id: 'm1', dir: 'in', body: 'see ya', ts: now - 20 * 86400000 }] },
};
const THANKS = "Hey Dave, it's Mikey. Just wanted to say thanks for sending Kim my way. That means a lot.";
const REPORT = () => ({
  ok: true,
  referrers: [{ phone: DAVE, name: 'Dave Park', people: [{ phone: NEW, name: 'Kim Nguyen', at: now, jobs: 1, total: 299, thankedAt: 0 }],
    dollars: 299, jobs: 1, unthanked: thanked ? 0 : 1, draft: thanked ? '' : THANKS, optedOut: false }],
  guesses: [], totals: { people: 1, dollars: 299, referrers: 1, paying: 3, payingReferred: 1, unthanked: thanked ? 0 : 1 },
  reward: '',
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sent = [];
const refPosts = [];
let thanked = false;
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (_) { return {}; } };
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = THREADS[want];
    return json(out);
  }
  if (path === '/api/thread') return json({ ok: true, thread: THREADS[u.searchParams.get('phone')] });
  if (path === '/api/referrals') return json(REPORT());
  if (path === '/api/referral') {
    const b = body(); refPosts.push(b);
    if (b.action === 'thanked') { thanked = true; return json(REPORT()); }
    const t = THREADS[b.phone];
    if (b.action === 'set') { t.referredBy = { phone: b.by, name: rows.find((r) => r.phone === b.by).name, at: Date.now(), thankedAt: 0, how: 'said' }; t.refGuess = null; }
    if (b.action === 'no' || b.action === 'clear') { t.refGuess = null; t.referredBy = null; t.refNo = true; }
    return json({ ok: true, thread: t });
  }
  if (path === '/api/send') { sent.push(body()); return json({ ok: true }); }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-02', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-02', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1200);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const openConvo = async (name) => {
  if (await page.evaluate(() => document.getElementById('details').classList.contains('open'))) {
    await page.locator('#detailsClose').click(); await page.waitForTimeout(350);
  }
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(800);
};

section('The conversation asks who sent them');
await openConvo('Kim Nguyen');
const banner = page.locator('#refBanner');
ok('the question is on screen', await banner.isVisible());
const bt = await banner.innerText();
ok('it asks about the name they said', /Sent by Dave\?/.test(bt), bt);
ok('it shows what they actually said', /Dave told me about you/.test(bt), bt);
ok('it offers both Daves by full name', /Dave Park/.test(bt) && /Dave Ruiz/.test(bt), bt);
const order = await banner.locator('[data-ref-yes]').evaluateAll((b) => b.map((x) => x.textContent));
ok('the Dave who is a customer comes first', order[0] === 'Dave Park', order);
ok('it never offers Sam, whose name isn\'t Dave', !/Sam/.test(bt));

await banner.locator(`[data-ref-yes="${DAVE}"]`).click();
await page.waitForTimeout(600);
ok('one tap saves Dave Park as who sent them', refPosts.some((p) => p.action === 'set' && p.phone === NEW && p.by === DAVE), refPosts);
const bt2 = await banner.innerText();
ok('the banner turns into the thank-you prompt', /Dave sent them/.test(bt2) && /Thank Dave/.test(bt2), bt2);

section('Details always has the row');
await page.locator('#detailsBtn').click();
await page.waitForTimeout(400);
const dt = await page.locator('#dtRef').innerText();
ok('Details says who sent them', /Dave Park/.test(dt), dt);
ok('…and that he hasn\'t been thanked', /Not thanked yet/.test(dt), dt);
ok('…with a way to change it', await page.locator('#dtRef [data-ref-change]').count() === 1);
await page.locator('#dtRef [data-ref-change]').click();
await page.waitForTimeout(500);
const pick = await page.locator('#jdSheet').innerText();
ok('the picker lists people to choose from', /Sam Ortiz/.test(pick) && /Dave Ruiz/.test(pick), pick.slice(0, 300));
ok('…but never the customer themselves', !/Kim Nguyen/.test(pick.split('\n').slice(2).join('\n')), pick.slice(0, 300));
await page.locator('#refPickQ').fill('sam');
await page.waitForTimeout(200);
ok('typing filters it', await page.locator('#refPickList [data-ref-choose]').count() === 1);
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
ok('Escape closes the picker', !(await page.evaluate(() => document.getElementById('jdSheet').classList.contains('show'))));
if (await page.evaluate(() => document.getElementById('details').classList.contains('open'))) {
  await page.locator('#detailsClose').click(); await page.waitForTimeout(350);
}
if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
  await page.locator('#backBtn').click(); await page.waitForTimeout(250);
}

section('The Word of mouth sheet, from More — no Home card needed');
await page.locator('.navitem[data-tab="more"]').click(); await page.waitForTimeout(400);
await page.getByText('Word of mouth', { exact: true }).first().click();
await page.waitForTimeout(900);
const sh = await page.locator('#jdSheet').innerText();
ok('it is open', /Word of mouth/.test(sh), sh.slice(0, 200));
ok('it counts the people and the money', /1 person came from 1 customer/.test(sh) && /\$299/.test(sh), sh.slice(0, 300));
ok('it says what share of paying customers that is', /1 of your 3 paying customers/.test(sh), sh.slice(0, 300));
ok('it shows the thank-you before he opens it', sh.indexOf(THANKS) >= 0, sh);
await page.locator(`[data-ref-thanks="${DAVE}"]`).click();
await page.waitForTimeout(1000);
ok('it lands in Dave\'s conversation', /Dave Park/.test(await page.locator('#chatHead').innerText()));
const boxed = await page.locator('#msgInput').inputValue();
ok('the thank-you is waiting in the box', boxed === THANKS, boxed);
ok('opening it marks Dave thanked', refPosts.some((p) => p.action === 'thanked' && p.by === DAVE), refPosts);
ok('NOTHING was texted', sent.length === 0, sent);
// Regression: the sheet used to open inside the fetch callback, after More had
// already started rewinding its history entry, and Back then left the app.
await page.locator('#backBtn').click(); await page.waitForTimeout(400);
ok('Back from there stays in the app', await page.evaluate(() => typeof window.__nav === 'function' && !document.body.classList.contains('viewing')));

section('"Not a referral" asks nothing further');
THREADS[NEW].referredBy = null; THREADS[NEW].refGuess = { name: '', rel: 'neighbor', line: 'my neighbor recommended you', at: now };
await openConvo('Kim Nguyen');
const bt3 = await page.locator('#refBanner').innerText();
ok('a relation with no name asks who', /A neighbor sent them/.test(bt3) && /Who was it\?/.test(bt3), bt3);
await page.locator('#refBanner [data-ref-no]').click();
await page.waitForTimeout(500);
ok('"Not a referral" is saved', refPosts.some((p) => p.action === 'no' && p.phone === NEW), refPosts);
ok('and the banner goes away', !(await page.locator('#refBanner').isVisible()));

section('nothing threw');
ok('no page errors', errs.length === 0, errs);
ok('still nothing texted', sent.length === 0, sent);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
