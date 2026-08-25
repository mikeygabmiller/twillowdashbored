// The bank-scan confirm sheet, driven in a real browser.
//
// The server suite (scan.test.js) proves the rows are read and written
// correctly. This one exists for the promise the sheet makes to Mikey: that
// NOTHING is logged except what he ticked, exactly as he left it. So it checks
// the payload that actually leaves the phone — after he unticks a row, corrects
// a category the model got wrong, and picks between two customers the server
// refused to choose from.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SHOT = path.join(__dirname, '..', 'public', 'icon-192.png'); // stands in for a screenshot

// What the server proposes back: two charges, a matched deposit, an ambiguous
// deposit, one already in the ledger, and one still pending at the bank.
const ROWS = [
  { date: '2026-08-20', amount: 25.11, dir: 'out', desc: '76 Express, Snohomish', card: '1917',
    note: '76 Express, Snohomish · card 1917', type: 'exp', cat: 'fuel', on: true },
  { date: '2026-08-20', amount: 4.91, dir: 'out', desc: 'Shell, Snohomish', card: '1917',
    note: 'Shell, Snohomish · card 1917', type: 'exp', cat: 'fuel', on: true },
  { date: '2026-08-21', amount: 180, dir: 'in', desc: 'ZELLE FROM SARAH MILLER', payer: 'Sarah Miller',
    note: 'ZELLE FROM SARAH MILLER', type: 'job', phone: '+14255551234', name: 'Sarah Miller', matchScore: 1, on: true },
  { date: '2026-08-21', amount: 95, dir: 'in', desc: 'ZELLE FROM CHRIS B', payer: 'Chris B',
    note: 'ZELLE FROM CHRIS B', type: 'job', on: true,
    alts: [{ phone: '+14255559999', name: 'Chris Bell', score: 0.85 }, { phone: '+14255558888', name: 'Chris Boyd', score: 0.85 }] },
  { date: '2026-08-19', amount: 60, dir: 'out', desc: 'Already Logged', note: 'Already Logged',
    type: 'exp', cat: 'supplies', on: false, dupe: { id: 'x1', type: 'exp', amount: 60, note: 'by hand' } },
  { date: '2026-08-22', amount: 9.99, dir: 'out', desc: 'Pending Thing', note: 'Pending Thing',
    type: 'exp', cat: 'misc', on: false, pending: true },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

let committed = null, scanBody = null;
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  let post = {}; try { post = JSON.parse(route.request().postData() || '{}'); } catch { /* not json */ }
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/threads') {
    return json({ ok: true, config: {}, threads: [
      { phone: '+14255551234', name: 'Sarah Miller', status: 'active', unread: 0, lastBody: 'thanks!', lastTs: Date.now(), tags: [] },
      { phone: '+14255559999', name: 'Chris Bell', status: 'active', unread: 0, lastBody: 'ok', lastTs: Date.now(), tags: [] },
      { phone: '+14255558888', name: 'Chris Boyd', status: 'active', unread: 0, lastBody: 'ok', lastTs: Date.now(), tags: [] },
    ] });
  }
  if (p === '/api/money') {
    return json({ ok: true, month: '2026-08', today: '2026-08-25', entries: [], nudges: [], owed: [],
      summary: { net: 0, gross: 0, exp: 0, jp: 0, jobs: 0, byCat: {} }, allTime: { net: 0 }, config: {} });
  }
  if (p === '/api/money/scan') { scanBody = post; return json({ ok: true, today: '2026-08-25', rows: ROWS, count: ROWS.length }); }
  if (p === '/api/money/scan/commit') { committed = post; return json({ ok: true, logged: (post.rows || []).length, skipped: 0, months: ['2026-08'] }); }
  // Must be a real shape: the Log screen re-fetches this until it lands, and an
  // ok-but-empty answer keeps it repainting forever.
  if (p === '/api/money/report') return json({ ok: true, months: [
    { month: '2026-07', net: 900, gross: 1400, exp: 500, jp: 0, jobs: 6, byCat: {} },
    { month: '2026-08', net: 1200, gross: 1800, exp: 600, jp: 0, jobs: 8, byCat: {} },
  ] });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const rowN = (i) => page.locator('.sc-row').nth(i);

section('The scan starts from the Money screen');
await page.locator('.navitem[data-tab="money"]').click();
// The Log screen repaints once when the 6-month trend lands, so let that settle
// before tapping — a click on the pre-repaint button would hit a detached node.
await page.waitForTimeout(1500);
ok('the Scan button is on the Log screen', await page.locator('#moScanBtn').isVisible());

const chooser = page.waitForEvent('filechooser');
await page.locator('#moScanBtn').click();
await (await chooser).setFiles([SHOT]);
await page.waitForTimeout(1400);

ok('the screenshot was sent as an image', /^data:image\/jpeg;base64,/.test((scanBody && (scanBody.imgs || [])[0]) || ''), (scanBody || {}).imgs && 'not a jpeg data url');
ok('the confirm sheet opened', await page.locator('.mo-sheet').evaluate((e) => e.classList.contains('show')));
ok('every row is listed', (await page.locator('.sc-row').count()) === 6, await page.locator('.sc-row').count());
ok('the header counts them', /6 transactions found/.test(await page.locator('.mo-sheet .sh-hd b').textContent()));

section('Nothing is written just by scanning');
ok('no commit yet', committed === null);

section('What arrives switched off, and why');
ok('the duplicate is unticked', !(await rowN(4).locator('.sc-tick').evaluate((e) => e.classList.contains('on'))));
ok('and says it is already in the ledger', /Already in the ledger/.test(await rowN(4).textContent()));
ok('the pending charge is unticked', !(await rowN(5).locator('.sc-tick').evaluate((e) => e.classList.contains('on'))));
ok('and says it is pending', /Pending at the bank/.test(await rowN(5).textContent()));
ok('the button counts only the ticked ones', /Log 4 entries/.test(await page.locator('#scSave').textContent()));

section('Money in reads differently from money out');
ok('a deposit is signed and green', /^\+\$180/.test((await rowN(2).locator('.sc-amt').textContent()).trim()));
ok('a charge is not signed', /^\$25\.11/.test((await rowN(0).locator('.sc-amt').textContent()).trim()));
ok('the matched customer is shown', /Sarah Miller/.test(await rowN(2).textContent()));
ok('an expense gets a category dropdown', await rowN(0).locator('select').isVisible());
ok('a deposit does not', (await rowN(2).locator('select').count()) === 0);

section('The customer the server would not guess at');
ok('neither Chris is picked', (await rowN(3).locator('.mo-chip.on').count()) === 0);
ok('both are offered', /Chris Bell/.test(await rowN(3).textContent()) && /Chris Boyd/.test(await rowN(3).textContent()));
await rowN(3).getByText('Chris Boyd', { exact: true }).click();
await page.waitForTimeout(300);
ok('picking one sticks', await rowN(3).locator('.mo-chip.on').isVisible());

section('Correcting what the model got wrong');
// A $4.91 charge at a gas station is a drink, not a fill-up.
await rowN(1).locator('select').selectOption('food');
await page.waitForTimeout(200);
await rowN(0).locator('.sc-tick').click();   // don't log the fuel one at all
await page.waitForTimeout(400);
ok('unticking updates the count', /Log 3 entries/.test(await page.locator('#scSave').textContent()));
ok('the unticked row dims', await page.locator('.sc-row').first().evaluate((e) => e.classList.contains('off')));

section('The sheet holds its place while he works down the list');
{
  // Replacing the whole sheet resets the scroll to 0, which on a twenty-row
  // statement means finding your place again after every single tick.
  const body = page.locator('.mo-sheet .sh-body');
  const state = () => body.evaluate((e) => ({ top: e.scrollTop, height: e.scrollHeight }));
  await body.evaluate((e) => { e.scrollTop = 180; });
  await page.waitForTimeout(200);
  const before = await state();
  await rowN(2).locator('.sc-tick').click();   // untick, then put it back
  await page.waitForTimeout(300);
  const after = await state();
  // Unticking collapses that row's controls, so the list legitimately gets
  // shorter — anything beyond that shrink is the sheet losing his place.
  ok('ticking does not throw the list back to the top',
    after.top > 0 && (before.top - after.top) <= (before.height - after.height) + 5, { before, after });
  await rowN(2).locator('.sc-tick').click();
  await page.waitForTimeout(300);
  ok('re-ticking brings the row\'s controls back', /Sarah Miller/.test(await rowN(2).textContent()));
}

section('Nothing ticked, nothing to press');
{
  for (const i of [1, 2, 3]) { await rowN(i).locator('.sc-tick').click(); await page.waitForTimeout(150); }
  ok('the button says so', /Nothing ticked/.test(await page.locator('#scSave').textContent()));
  ok('and cannot be pressed', await page.locator('#scSave').isDisabled());
  for (const i of [1, 2, 3]) { await rowN(i).locator('.sc-tick').click(); await page.waitForTimeout(150); }
  ok('ticking again re-enables it', !(await page.locator('#scSave').isDisabled()));
  ok('and the count is right', /Log 3 entries/.test(await page.locator('#scSave').textContent()),
    await page.locator('#scSave').textContent());
}

section('Only what he ticked leaves the phone');
await page.locator('#scSave').click();
await page.waitForTimeout(700);
const rows = (committed && committed.rows) || [];
ok('three entries committed', rows.length === 3, rows.length);
ok('the unticked fuel charge is not among them', !rows.some((r) => r.amount === 25.11));
ok('nor the duplicate', !rows.some((r) => r.amount === 60));
ok('nor the pending one', !rows.some((r) => r.amount === 9.99));
ok('the corrected category went with it', (rows.find((r) => r.amount === 4.91) || {}).cat === 'food',
  (rows.find((r) => r.amount === 4.91) || {}).cat);
ok('the matched deposit is a job', (rows.find((r) => r.amount === 180) || {}).type === 'job');
ok('and carries her number', (rows.find((r) => r.amount === 180) || {}).phone === '+14255551234');
ok('the customer he chose is on the other deposit', (rows.find((r) => r.amount === 95) || {}).name === 'Chris Boyd',
  (rows.find((r) => r.amount === 95) || {}).name);
ok('every row keeps its own date', rows.map((r) => r.date).sort().join(','), '2026-08-20,2026-08-21,2026-08-21');
ok('the sheet closed after saving', !(await page.locator('.mo-sheet').evaluate((e) => e.classList.contains('show'))));

section('No script errors');
ok('page stayed clean', errs.length === 0, errs.slice(0, 3));

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
