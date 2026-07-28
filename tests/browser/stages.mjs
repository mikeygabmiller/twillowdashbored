import { chromium } from 'playwright-core';
import fs from 'fs';
const HTML = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };

let job = {
  id: 'j1', phone: '+14255550001', name: 'Dana', at: at(14, 0), status: 'scheduled', stage: 'scheduled',
  token: 'a'.repeat(32), customerConfirmed: true, service: 'Interior Detail', vehicle: '2021 Civic',
  address: '900 Pine St', city: 'Monroe', price: 240, durationMin: 120, photos: [],
};
const calls = [];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 414, height: 896 }, permissions: ['geolocation'], geolocation: { latitude: 47.9129, longitude: -122.0982 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await p.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/run') return json({ ok: true, run: { jobs: [job], total: job.price }, weather: null, proposals: [], changes: [], upcoming: [], config: { enabled: true } });
  if (path === '/api/job') {
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    if (body.action === 'onmyway') { job.stage = 'enroute'; job.trip = { etaAt: Date.now() + 14 * 60000, etaMin: 14, lastPing: { lat: 47.91, lon: -122.09 } }; return json({ ok: true, job, etaMin: 14, sent: true, url: '/t/' + job.token }); }
    if (body.action === 'ping') return json({ ok: true, job, etaMin: 11, lateBy: 0 });
    if (body.action === 'arrived') { job.stage = 'arrived'; job.trip.lastPing = null; return json({ ok: true, job, sent: true }); }
    if (body.action === 'working') { job.stage = 'working'; return json({ ok: true, job }); }
    if (body.action === 'late') return json({ ok: true, job, sent: true });
    if (body.action === 'complete') { job.stage = 'done'; job.status = 'done'; return json({ ok: true, job, sent: true }); }
    return json({ ok: true, job });
  }
  if (path === '/api/job-photo') { const id = 'ph' + (job.photos.length + 1); job.photos.push({ id, kind: 'after' }); return json({ ok: true, photo: { id, kind: 'after' } }); }
  if (path.startsWith('/p/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from('x') });
  if (path === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (path === '/api/version') return json({ ok: true, build: '2026-07-28·tracking+receipt' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await p.goto('https://texting.test/');
await p.waitForTimeout(800);
await p.locator('.navitem[data-tab="run"]').click();
await p.waitForTimeout(700);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const txt = () => p.locator('#scroll').innerText();

section('Scheduled');
ok('"On my way" offered', await p.locator('[data-act="onmyway"]').count() === 1);
ok('no arrival button yet', await p.locator('[data-act="arrived"]').count() === 0);
ok('copy-link offered', await p.locator('[data-act="copylink"]').count() === 1);

section('Tapping "On my way"');
await p.locator('[data-act="onmyway"]').click();
await p.waitForTimeout(1200);
const omw = calls.find((c) => c.action === 'onmyway');
ok('server told to start the trip', !!omw);
ok('…with his real position attached', omw.lat && Math.abs(omw.lat - 47.9129) < 0.01, omw);
ok('card now shows what the customer sees', (await txt()).includes('Customer sees'), (await txt()).slice(0, 200));
ok('…including the ETA', /1[0-9] min away/.test(await txt()));
ok('"I\'ve arrived" now offered', await p.locator('[data-act="arrived"]').count() === 1);
ok('"Running behind" now offered', await p.locator('[data-act="late"]').count() === 1);
ok('"On my way" no longer offered', await p.locator('[data-act="onmyway"]').count() === 0);

section('Position pings while driving');
await p.waitForTimeout(600);
const pings = calls.filter((c) => c.action === 'ping');
ok('position is being pinged while en route', pings.length >= 1, pings.length);
ok('…with real coordinates, not placeholders', pings[0] && Math.abs(pings[0].lat - 47.9129) < 0.01, pings[0]);
ok('…tied to the en-route job', pings[0] && pings[0].id === 'j1');

section('Running behind');
await p.locator('[data-act="late"]').click();
await p.waitForTimeout(700);
ok('late text requested', calls.some((c) => c.action === 'late'));

section('Arrived → working');
await p.locator('[data-act="arrived"]').click();
await p.waitForTimeout(800);
ok('arrival sent', calls.some((c) => c.action === 'arrived'));
ok('"Start working" now offered', await p.locator('[data-act="working"]').count() === 1);
ok('trip line gone once arrived', !(await txt()).includes('Customer sees'));
await p.locator('[data-act="working"]').click();
await p.waitForTimeout(800);
ok('working started', calls.some((c) => c.action === 'working'));
ok('"Finish & send receipt" offered', await p.locator('[data-act="receipt"]').count() === 1);

section('The receipt composer');
await p.locator('[data-act="receipt"]').click();
await p.waitForTimeout(500);
ok('composer opens', await p.locator('#runReceipt').isVisible());
ok('prefilled from the job', (await p.locator('.rc-n').first().inputValue()) === 'Interior Detail');
ok('price prefilled', (await p.locator('.rc-p').first().inputValue()) === '240');
ok('total shown', (await p.locator('#rcTot').textContent()) === '$240');

await p.locator('[data-add]').click();
await p.waitForTimeout(300);
ok('can add a line', await p.locator('.rc-n').count() === 2);
await p.locator('.rc-n').nth(1).fill('Pet hair removal');
await p.locator('.rc-p').nth(1).fill('60');
await p.waitForTimeout(300);
ok('total recalculates live', (await p.locator('#rcTot').textContent()) === '$300', await p.locator('#rcTot').textContent());

await p.locator('#rcNote').fill('Extractor on the back seats.');
await p.locator('.rc-line').nth(1).locator('.rc-x').click();
await p.waitForTimeout(300);
ok('removing a line updates the total', (await p.locator('#rcTot').textContent()) === '$240');
ok('…and the note survived the re-render', (await p.locator('#rcNote').inputValue()) === 'Extractor on the back seats.');

await p.locator('.rc-n').nth(0).fill('Interior Detail — deep clean');
await p.locator('[data-rc="send"]').click();
await p.waitForTimeout(900);
const done = calls.find((c) => c.action === 'complete');
ok('receipt sent to the server', !!done);
ok('…with the edited line item', done.services[0].name === 'Interior Detail — deep clean', done.services);
ok('…the right total', done.total === 240, done.total);
ok('…and the note', done.note === 'Extractor on the back seats.');
ok('composer closes', !(await p.locator('#runReceipt').isVisible()));
ok('card now links to the receipt', await p.locator('a[href="/t/' + 'a'.repeat(32) + '"]').count() === 1);

console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
