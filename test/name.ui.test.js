// The dashboard side of auto-naming: a name the app worked out has to SAY that
// it worked it out, and be one tap from either "yes, that's them" or a fix.
//
// A guess nobody can confirm or correct in place is a guess nobody trusts — and
// the confirm matters for a second reason: saving the name back through
// /api/meta is what promotes it to a name Mikey stands behind, after which
// nothing the app learns later can quietly overwrite it.
//
//   npm install && node test/name.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale', unread: 0, tags: [], lastBody: "hey it's Dale", lastDir: 'in', lastTs: now - 60000 },
  { phone: '+14255559876', name: 'Ruth Callahan', unread: 0, tags: [], lastBody: 'quote request', lastDir: 'in', lastTs: now - 90000 },
  { phone: '+14255550000', name: 'Big Mike', unread: 0, tags: [], lastBody: 'thanks!', lastDir: 'in', lastTs: now - 120000 },
];
// nameAuto is the whole point: 'said' came out of their words, 'email' was
// guessed off the quote form, and a blank one was typed by a human.
const auto = { '+14255551234': 'said', '+14255559876': 'email', '+14255550000': '' };
const thread = (phone) => ({
  phone, name: (rows.find((r) => r.phone === phone) || {}).name || '', nameAuto: auto[phone] || '',
  tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: (rows.find((r) => r.phone === phone) || {}).lastBody, ts: now - 60000 }],
});

const metaPosts = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('dialog', (d) => d.accept('Dale Hobart'));

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/meta') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    metaPosts.push(body);
    const t = thread(body.phone);
    // The Worker clears the marker the moment a name is saved by hand — see apiMeta.
    if (typeof body.name === 'string') { t.name = body.name; t.nameAuto = ''; auto[body.phone] = ''; }
    return json({ ok: true, thread: t });
  }
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/ai/draft') return json({ ok: false, error: 'off' });
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-04', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-04', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const openDetails = async (name) => {
  // The details sheet lays a scrim over everything, so it has to be shut before
  // anything behind it can be clicked.
  if (await page.evaluate(() => document.getElementById('details').classList.contains('open'))) {
    await page.locator('#detailsClose').click(); await page.waitForTimeout(350);
  }
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.locator('#detailsBtn').click();
  await page.waitForTimeout(350);
};
const hint = () => page.evaluate(() => {
  const b = document.getElementById('dtNameAuto');
  return { shown: !!b && b.style.display !== 'none', text: b ? b.textContent : '' };
});

section('A name picked up from what they said');
await openDetails('Dale');
let h = await hint();
ok('the panel says where the name came from', h.shown && /Picked up from what they said/.test(h.text), h);
ok('with a one-tap confirm', await page.locator('#dtNameOk').count() === 1);
ok('and a way to fix it', await page.locator('#dtNameFix').count() === 1);

section('Confirming it saves the name for real');
await page.locator('#dtNameOk').click();
await page.waitForTimeout(500);
ok('the name went back through /api/meta', metaPosts.some((m) => m.phone === '+14255551234' && m.name === 'Dale'), metaPosts);
h = await hint();
ok('and the hint is gone — it is his name now', !h.shown, h);

section('A name guessed off the quote form email reads differently');
await openDetails('Ruth Callahan');
h = await hint();
ok('it says it was a guess from the email', h.shown && /Guessed from their email/.test(h.text), h);

section('Fixing a wrong guess');
await page.locator('#dtNameFix').click();
await page.waitForTimeout(500);
ok('the typed name is what gets saved', metaPosts.some((m) => m.phone === '+14255559876' && m.name === 'Dale Hobart'), metaPosts);

section('A name a human typed says nothing at all');
await openDetails('Big Mike');
h = await hint();
ok('no hint on a name nobody guessed', !h.shown, h);

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
