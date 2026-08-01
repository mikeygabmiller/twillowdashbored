// The snapshot picker. "Send Claude my messages" should produce a file with the
// messages in it — not the whole app — so this drives the sheet the way Mikey
// would and checks the request that actually goes out.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const thread = {
  phone: '+14255551234', name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: Date.now() - 60000 }],
  scheduled: [], linked: [], notes: '',
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 }, acceptDownloads: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

let snapUrl = null;                       // the last /api/snapshot request the app made
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/snapshot') {
    snapUrl = u;
    return json({ ok: true, kind: 'mikeys-app-snapshot', included: ['messages'], conversations: [thread], counts: { conversations: 1, messages: 1 } });
  }
  if (path === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: 'sounds good', lastTs: Date.now(), tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-07', today: '2026-07-30', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-07-30', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const openPicker = async () => {
  await page.locator('#search').fill('snapshot');
  await page.waitForTimeout(300);
  await page.locator('.fx-row').first().click();
  await page.waitForTimeout(500);
};
const ticked = () => page.$$eval('.snap-row.on', (ns) => ns.map((n) => n.dataset.part));
const rangeDays = () => page.locator('#snapDays').inputValue();

section('The picker opens instead of dumping the whole app');
await openPicker();
ok('sheet is showing', await page.locator('#jdSheet').evaluate((e) => e.classList.contains('show')));
ok('it is the snapshot sheet', (await page.locator('#jdSheet .jd-sh-title').innerText()).includes('Snapshot for Claude'));
ok('every piece of the app is offered', (await page.locator('.snap-row').count()) === 7);
ok('nothing downloaded on open', snapUrl === null);
ok('texts are the sensible default', JSON.stringify(await ticked()) === JSON.stringify(['messages']), await ticked());

section('You can just say what you need');
await page.locator('#snapSay').fill('just my money from the last year');
await page.locator('#snapSay').press('Enter');
await page.waitForTimeout(350);
ok('money only', JSON.stringify(await ticked()) === JSON.stringify(['money']), await ticked());
ok('and it heard the year', (await rangeDays()) === '365');
await page.locator('#snapSay').fill('texts and bookings this month');
await page.locator('#snapSay').press('Enter');
await page.waitForTimeout(350);
ok('two things at once', JSON.stringify((await ticked()).sort()) === JSON.stringify(['bookings', 'messages']), await ticked());
ok('and the month', (await rangeDays()) === '30');

section('Tapping works too');
await page.locator('.snap-row[data-part="bookings"]').click();
await page.waitForTimeout(300);
ok('untick removes it', JSON.stringify(await ticked()) === JSON.stringify(['messages']), await ticked());
await page.locator('.snap-row[data-part="money"]').click();
await page.waitForTimeout(300);
ok('tick adds it', JSON.stringify((await ticked()).sort()) === JSON.stringify(['messages', 'money']), await ticked());

section('The presets are one tap');
await page.locator('[data-preset="0"]').click();
await page.waitForTimeout(300);
ok('"Just my texts" means just texts', JSON.stringify(await ticked()) === JSON.stringify(['messages']), await ticked());
ok('with a 30-day window', (await rangeDays()) === '30');
ok('text options appear with texts picked', await page.locator('#snapMsgs').isVisible());
await page.locator('[data-preset="2"]').click();
await page.waitForTimeout(300);
ok('"Just my money" hides the text options', (await page.locator('#snapMsgs').count()) === 0);

section('Only what was asked for is fetched');
await page.locator('[data-preset="0"]').click();
await page.waitForTimeout(250);
await page.locator('#snapDays').selectOption('90');
await page.locator('#snapMsgs').selectOption('150');
await page.locator('#snapWho').fill('Jenna');
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await page.locator('#snapGo').click();
await page.waitForTimeout(1200);
ok('the app asked for a snapshot', !!snapUrl);
ok('only the texts', snapUrl && snapUrl.searchParams.get('parts') === 'messages', snapUrl && snapUrl.search);
ok('with the window it was given', snapUrl && snapUrl.searchParams.get('days') === '90');
ok('and the per-chat cap', snapUrl && snapUrl.searchParams.get('msgs') === '150');
ok('and the person', snapUrl && snapUrl.searchParams.get('q') === 'Jenna');
const file = await dl;
ok('a file came out, named for what is in it', !!file && /messages/.test(file.suggestedFilename()), file && file.suggestedFilename());
ok('sheet closed itself when done', !(await page.locator('#jdSheet').evaluate((e) => e.classList.contains('show'))));

section('It remembers the last pick');
snapUrl = null;
await openPicker();
ok('reopens on texts + 90 days', JSON.stringify(await ticked()) === JSON.stringify(['messages']) && (await rangeDays()) === '90', await ticked());

section('It never builds an empty file');
await page.locator('.snap-row[data-part="messages"]').click();
await page.waitForTimeout(250);
await page.locator('#snapGo').click();
await page.waitForTimeout(500);
ok('nothing fetched with nothing ticked', snapUrl === null);
ok('and it says so', /at least one/i.test(await page.locator('#toast').innerText()));

console.log('\n' + (errs.length ? 'JS ERRORS:\n' + errs.join('\n') : 'no JS errors'));
console.log(`\n${fail || errs.length ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail || errs.length ? 1 : 0);
