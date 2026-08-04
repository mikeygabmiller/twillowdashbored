// Detection cards inside the Jobs board — driven in a real browser against a
// mocked API, so this catches the things a unit test cannot: that the card
// actually renders, that a tap posts the right thing, and that confirming
// surfaces the draft instead of quietly texting the customer.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const today = new Date();
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

let detections = [
  { id: 'd1', phone: '+14255551234', kind: 'set', name: 'Jenna', date: iso(today), slot: '10:00',
    at: Date.now() + 3600000, tentative: false, customerConfirmed: true, service: 'Full Detail',
    vehicle: '2019 Tahoe', address: '123 Main St', city: 'Everett', price: 339, notes: 'gate 4412',
    confidence: 0.92, evidence: 'yes 10am saturday works' },
  { id: 'd2', phone: '+14255557777', kind: 'reschedule', name: 'Rob', date: iso(today), slot: '16:00',
    at: Date.now() + 7200000, currentAt: Date.now() + 3600000, evidence: 'can we push to 4?' },
];
const posts = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const emptyDay = (date) => ({
  ok: true, date, jobs: [], manual: [], order: [],
  summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 },
});

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/detections') return json({ ok: true, detections, config: { enabled: true, eager: true } });
  if (path === '/api/detection') {
    const b = JSON.parse(route.request().postData() || '{}');
    posts.push(b);
    if (b.action === 'dismiss' || b.action === 'accept') { detections = detections.filter((d) => d.id !== b.id); return json({ ok: true }); }
    if (b.action === 'confirm') {
      const rec = detections.find((d) => d.id === b.id);
      detections = detections.filter((d) => d.id !== b.id);
      return json({ ok: true, date: rec.date, day: emptyDay(rec.date), draft: "Hey Jenna, you're all set for Sat at 10:00 AM. - Mikey" });
    }
    if (b.action === 'edit') {
      const rec = detections.find((d) => d.id === b.id);
      Object.assign(rec, { slot: b.slot, address: b.address, price: +b.price });
      return json({ ok: true, detection: rec });
    }
    return json({ ok: true });
  }
  if (path === '/api/send') { posts.push({ sent: JSON.parse(route.request().postData() || '{}') }); return json({ ok: true, thread: {} }); }
  if (path === '/api/day') return json(emptyDay(u.searchParams.get('date') || iso(today)));
  if (path === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// Jobs is the "Run" stage of the Pipeline tab since the five-tab rework.
await page.locator('.navitem[data-tab="pipeline"]').click();
await page.waitForTimeout(900);

section('Cards render on the Jobs board');
const body = await page.locator('body').innerText();
ok('both cards shown', await page.locator('.jd-det').count() === 2, await page.locator('.jd-det').count());
ok('"Looks like you booked this"', /looks like you booked this/i.test(body));
ok('the quoted evidence is shown', body.includes('yes 10am saturday works'));
ok('captured details shown', body.includes('Full Detail') && body.includes('2019 Tahoe') && body.includes('$339'));
ok('address shown', body.includes('123 Main St'));
ok('a reschedule reads as a move, not a new job', /wants to move this/i.test(body));
ok('…showing old → new', await page.locator('.jd-det.warn .dt-bits b').count() === 1);
ok('nav badge counts the cards', (await page.locator('#navJobs').textContent()).trim() === '2');

section('Editing before accepting');
await page.locator('.jd-det').first().locator('[data-da="edit"]').click();
await page.waitForTimeout(500);
ok('edit sheet opens', await page.locator('#dEdAddress').count() === 1);
ok('prefilled from the detection', (await page.locator('#dEdAddress').inputValue()) === '123 Main St');
await page.locator('#dEdAddress').fill('900 Pine St');
await page.locator('#dEdSlot').fill('13:30');
await page.locator('#dEdSave').click();
await page.waitForTimeout(700);
const edit = posts.find((p) => p.action === 'edit');
ok('edit posted', !!edit);
ok('…with the new address', edit.address === '900 Pine St', edit);
ok('…and the new time', edit.slot === '13:30');

section('Confirming surfaces the draft — it does not text');
await page.locator('.jd-det').first().locator('[data-da="confirm"]').click();
await page.waitForTimeout(900);
ok('confirm posted', posts.some((p) => p.action === 'confirm'));
ok('nothing was texted on confirm', !posts.some((p) => p.sent));
ok('draft sheet opened', await page.locator('#jdDetText').count() === 1);
ok('draft is editable', (await page.locator('#jdDetText').inputValue()).includes("you're all set"));

await page.locator('#jdDetText').fill('My own wording. - Mikey');
await page.locator('#jdDetSend').click();
await page.waitForTimeout(700);
const sent = posts.find((p) => p.sent);
ok('sending uses the EDITED text', sent && sent.sent.body === 'My own wording. - Mikey', sent);
ok('…to the right number', sent.sent.phone === '+14255551234');
ok('confirmed card disappears', await page.locator('.jd-det').count() === 1);

section('Dismissing and accepting');
await page.locator('.jd-det').first().locator('[data-da="accept"]').click();
await page.waitForTimeout(700);
ok('accept posted for the reschedule', posts.some((p) => p.action === 'accept' && p.id === 'd2'));
ok('board is clear of cards', await page.locator('.jd-det').count() === 0);

console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
