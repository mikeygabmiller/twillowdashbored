// Before / after / friend links, in the app.
//
// The rule being held: the app says WHICH link fits right now and puts the
// text in the box. It never sends one. So Home lists who's due one (and only
// them), the conversation offers the right one with "Put it in the box" and
// "Not now", and the Tools → "Send them a link" sheet has all four with the
// due one marked. Nothing in this suite may reach /api/send.
//
//   npm install && node test/links.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now(), D = 86400000, H = 3600000;
const P = (n) => '+1425555' + String(n).padStart(4, '0');
const ANA = P(101), BEN = P(102), CAL = P(103), DEE = P(104), EVE = P(105), FAY = P(106), GUS = P(107), HAL = P(108);
const base = { unread: 0, tags: [], lastDir: 'out', lastBody: 'see you then', status: 'won' };
const rows = [
  Object.assign({ phone: ANA, name: 'Ana Reyes', lastTs: now - 3 * D, appointmentAt: now + 2 * D }, base),            // before
  Object.assign({ phone: BEN, name: 'Ben Cho', lastTs: now - 2 * D, lastJobAt: now - 1 * D }, base),                  // after
  Object.assign({ phone: CAL, name: 'Cal Fry', lastTs: now - 9 * D, lastJobAt: now - 10 * D }, base),                 // friend
  Object.assign({ phone: DEE, name: 'Dee Moss', lastTs: now - H, appointmentAt: now + D, linkAt: { before: now - H } }, base), // already sent
  Object.assign({ phone: EVE, name: 'Eve Tran', lastTs: now - D, lastJobAt: now - D, linkSkip: { after: now - H } }, base),   // "not now"
  Object.assign({ phone: FAY, name: 'Fay Holt', lastTs: now - 9 * D, lastJobAt: now - 10 * D, issueAt: now - 9 * D }, base),  // complained
  Object.assign({ phone: GUS, name: 'Gus Lind', lastTs: now - D, appointmentAt: now + 10 * D }, base),                // too far out
  Object.assign({ phone: HAL, name: 'Hal Wu', lastTs: now - D, appointmentAt: now + D, optedOut: true }, base),       // do not text
];
const thread = (r, extra) => Object.assign({ phone: r.phone, name: r.name, status: 'won', tags: [], scheduled: [], linked: [], notes: '',
  appointmentAt: r.appointmentAt || null, lastJob: r.lastJobAt ? { at: r.lastJobAt, service: 'Full Detail' } : null,
  linkSent: r.linkAt || null, linkSkip: r.linkSkip || null,
  messages: [{ id: 'm1', dir: 'out', body: 'see you then', ts: r.lastTs }] }, extra || {});
const THREADS = {};
for (const r of rows) THREADS[r.phone] = thread(r);
const tokOf = (ph) => 'tok' + ph.slice(-4) + 'abcdefghijkl';
const LINKS = (ph) => {
  const t = tokOf(ph), b = 'https://texting.test';
  return { book: `${b}/c/${t}`, before: `${b}/before/${t}`, after: `${b}/after/${t}`, friend: `${b}/friend/${t}` };
};
const DRAFTS = (ph) => {
  const L = LINKS(ph);
  return { book: 'Your page: ' + L.book, before: 'Everything for your detail: ' + L.before,
    after: 'How to look after it: ' + L.after, friend: 'Your friend link: ' + L.friend };
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sent = [], skips = [], linkAsks = [];
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
  if (path === '/api/cust/link') {
    const b = body(); linkAsks.push(b);
    if (b.text) sent.push(b);
    return json({ ok: true, url: LINKS(b.phone).book, links: LINKS(b.phone), drafts: DRAFTS(b.phone),
      saved: { before: 'https://texting.test/before', after: 'https://texting.test/after' }, texted: false });
  }
  if (path === '/api/cust/linkskip') {
    const b = body(); skips.push(b);
    const t = THREADS[b.phone]; t.linkSkip = Object.assign({}, t.linkSkip || {}, { [b.kind]: Date.now() });
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

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

await page.goto('https://texting.test/');
await page.waitForTimeout(1200);

async function home() {
  if (await page.evaluate(() => document.getElementById('details').classList.contains('open'))) {
    await page.locator('#detailsClose').click(); await page.waitForTimeout(350);
  }
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(300);
  }
  await page.locator('.navitem[data-tab="home"]').click(); await page.waitForTimeout(500);
}
async function openConvo(name) {
  await home();
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(800);
}

section('Home lists who is due a link, and only them');
await home();
const needs = (await page.locator('.needs').allInnerTexts()).join('\n');
const grp = needs.split(/Send them a link/i)[1] || '';
ok('there is a "Send them a link" group', /Send them a link/i.test(needs), needs.slice(0, 400));
ok('a link is a suggestion, not work: nobody waiting still reads "all caught up"', /all caught up/i.test(needs), needs.slice(0, 300));
ok('Ana: a detail in two days, so the before link', /Ana Reyes[\s\S]*?send the before-job link/.test(grp), grp);
ok('Ben: finished yesterday, so the after link', /Ben Cho[\s\S]*?send the after-job link/.test(grp), grp);
ok('Cal: ten days on, so the friend link', /Cal Fry[\s\S]*?friend link/.test(grp), grp);
ok('not Dee, whose before link already went out', !/Dee Moss/.test(grp));
ok('not Eve, who got a "Not now"', !/Eve Tran/.test(grp));
ok('not Fay, who said something wasn\'t right', !/Fay Holt/.test(grp));
ok('not Gus, whose detail is ten days out', !/Gus Lind/.test(grp));
ok('never Hal, who is on Do not text', !/Hal Wu/.test(needs));

section('The conversation offers the right one, into the box');
await openConvo('Ana Reyes');
const bn = page.locator('#linkBanner');
ok('the banner is up', await bn.isVisible());
const bt = await bn.innerText();
ok('it names the before link and the day', /send the before-job link\?/.test(bt) && /Detail (in|on )?\w+/.test(bt), bt);
await bn.locator('[data-link-put]').click();
await page.waitForTimeout(700);
const boxed = await page.locator('#msgInput').inputValue();
ok('"Put it in the box" writes the before text', boxed === DRAFTS(ANA).before, boxed);
ok('…with Ana\'s own before link in it', boxed.includes('/before/' + tokOf(ANA)));
ok('the banner steps aside once it\'s in the box', !(await bn.isVisible()));
ok('NOTHING was sent', sent.length === 0, sent);

section('"Not now" silences it for this job');
await page.locator('#msgInput').fill('');
await openConvo('Ben Cho');
ok('Ben gets the after-job banner', /after-job link/.test(await bn.innerText()));
await bn.locator('[data-link-skip]').click();
await page.waitForTimeout(600);
ok('the skip is saved against the after link', skips.some((s) => s.phone === BEN && s.kind === 'after'), skips);
ok('and the banner goes away', !(await bn.isVisible()));

section('No banner where none is due');
await openConvo('Dee Moss');
ok('Dee (already sent) has none', !(await bn.isVisible()));
await openConvo('Hal Wu');
ok('Hal (do not text) has none', !(await bn.isVisible()));

section('Tools → "Send them a link" has all four');
await openConvo('Ana Reyes');
await page.locator('#msgInput').fill('');
await page.locator('#toolsBtn').click(); await page.waitForTimeout(400);
await page.locator('#toolsSheet [data-act="link"]').click(); await page.waitForTimeout(900);
const sh = await page.locator('#jdSheet').innerText();
ok('it is open', /Ana’s links/.test(sh), sh.slice(0, 200));
ok('all four pages, each with its own link', ['Before the job', 'After the job', 'Send a friend', 'Booking page'].every((x) => sh.includes(x)) &&
  ['/before/', '/after/', '/friend/', '/c/'].every((x) => sh.includes(x)), sh);
ok('the due one is marked', /Before the job[\s\S]{0,40}Send this one now/.test(sh), sh.slice(0, 400));
ok('and the two bare links to keep saved', sh.includes('https://texting.test/before') && sh.includes('https://texting.test/after') && /Keep these saved/i.test(sh));
await page.locator('#jdSheet [data-lk-put="friend"]').click(); await page.waitForTimeout(500);
ok('"Put in the box" from the sheet writes that one', (await page.locator('#msgInput').inputValue()) === DRAFTS(ANA).friend);
ok('still nothing sent', sent.length === 0, sent);

section('nothing threw');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
