// Schedule, Customers and Grow — the rest of the new app (2026-10-08) — plus the
// switch in index.html that will make /inbox the front door.
//
// Guarded here: a booking's buttons do what they say (Confirm, Start job,
// Finished), a job agreed by text shows up beside website bookings, the
// customer buckets come off the list row rather than hand-marked stages, the
// contacts export only includes named people, every Grow tile opens a real
// screen, and the switch leaves ?classic=1 and money links in the old app.
import { chromium } from 'playwright-core';
import fs from 'fs';

const read = (p) => fs.readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const now = Date.now();
const H = 3600000, D = 24 * H;
const tomorrow1pm = (() => { const d = new Date(now + D); d.setHours(13, 0, 0, 0); return d.getTime(); })();

const ROWS = [
  { phone: '+14255550201', name: 'Web Booker', lastTs: now - H, lastDir: 'in', lastBody: 'Booked!' },
  { phone: '+14255550202', name: 'Text Agreed', lastTs: now - 2 * H, lastDir: 'out', lastBody: 'See you Thursday', appointmentAt: tomorrow1pm + 2 * H, vehicleLabel: '2020 Civic', city: 'Everett' },
  { phone: '+14255550203', name: 'Quoted Quinn', lastTs: now - 3 * D, quoteTotal: 409 },
  { phone: '+14255550204', name: 'Club Carla', lastTs: now - 5 * D, plan: { every: 56, price: 125 } },
  { phone: '+14255550205', name: '', lastTs: now - 6 * D },
  { phone: '+14255550206', name: 'Lost Larry', lastTs: now - 30 * D, status: 'lost', closedReason: 'price' },
];
const BOOKINGS = [
  { id: 'b1', status: 'pending', phone: '+14255550201', name: 'Web Booker', apptAt: tomorrow1pm, serviceName: 'Full Detail', size: 'suv', vehicle: '2018 RAV4', address: '9 Elm St', city: 'Snohomish', estimate: 409 },
  { id: 'b2', status: 'confirmed', phone: '+14255550203', name: 'Quoted Quinn', apptAt: tomorrow1pm + D, serviceName: 'Interior Detail', size: 'sedan', estimate: 249, durationMin: 180 },
  { id: 'b3', status: 'done', phone: '+14255550204', name: 'Club Carla', apptAt: now - 2 * D, serviceName: 'Full Detail', size: 'sedan', estimate: 369, startedAt: now - 2 * D, doneAt: now - 2 * D + 220 * 60000, durationMin: 270 },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const posted = [];
let indexHtml = read('index.html');
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/fonts\.(googleapis|gstatic)/.test(u.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* */ } posted.push({ path, body: b }); }
  if (path === '/favicon.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  if (['/schedule', '/customers', '/grow', '/inbox'].includes(path)) return route.fulfill({ status: 200, contentType: 'text/html', body: path === '/inbox' ? '<!doctype html><title>inbox</title><p id="landed">inbox</p>' : read(path.slice(1) + '.html') });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: indexHtml });
  if (path === '/app/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: read('app/app.js') });
  if (path === '/app/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: read('app/app.css') });
  if (path === '/api/threads') return json({ ok: true, threads: ROWS });
  if (path === '/api/bookings') return json({ ok: true, bookings: BOOKINGS });
  if (path === '/api/next-openings') return json({ ok: true, openings: [{ label: 'Sat, Oct 11', time: '7:00 AM' }] });
  if (path === '/api/booking') return json({ ok: true, texted: true });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('Schedule');
await page.goto('https://texting.test/schedule');
await page.waitForTimeout(600);
const sched = await page.locator('#view').innerText();
ok('the next opening is shown', /Sat, Oct 11 at 7:00 AM/.test(sched));
ok('a website request waits for a confirm, at the top', /Waiting for you to confirm/i.test(sched) && sched.indexOf('Web Booker') < sched.indexOf('Quoted Quinn'), sched.slice(0, 200));
ok('a job agreed by text is on the list too', /Text Agreed/.test(sched) && /Agreed by text/.test(sched));
ok('the job shows the price and the address', /\$409/.test(sched) && /9 Elm St/.test(sched));
ok('a finished job shows how long it really took', /Took 3h 40m \(planned 4h 30m\)/.test(sched), sched.match(/Took[^\n]*/));
await page.locator('[data-act="confirm"][data-id="b1"]').click();
await page.waitForTimeout(250);
ok('Confirm sends the confirm action for that booking', posted.some((p) => p.path === '/api/booking' && p.body.id === 'b1' && p.body.action === 'confirm'));
await page.locator('[data-act="start"][data-id="b2"]').click();
await page.waitForTimeout(250);
ok('Start job starts the clock on that booking', posted.some((p) => p.path === '/api/booking' && p.body.id === 'b2' && p.body.action === 'start'));
const declineBtn = page.locator('[data-act="decline"][data-id="b1"]');
await declineBtn.click();
ok('Decline needs a second tap', !posted.some((p) => p.body && p.body.action === 'decline'));

section('Customers');
await page.goto('https://texting.test/customers');
await page.waitForTimeout(500);
const chip = async (f) => (await page.locator(`#filters [data-f="${f}"] .n`).innerText()).trim();
ok('Booked counts the job agreed by text', await chip('booked') === '1');
ok('Quoted counts the open quote', await chip('quoted') === '1');
ok('Clean Club counts the member', await chip('club') === '1');
await page.locator('#filters [data-f="lost"]').click();
ok('Lost shows why', /Lost: price/.test(await page.locator('#list').innerText()));
await page.locator('#filters [data-f="all"]').click();
ok('a person with no name says so instead of the number twice', /No name yet/.test(await page.locator('#list').innerText()));
const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#vcfBtn').click()]);
const vcf = fs.readFileSync(await dl.path(), 'utf8');
ok('the contacts file has one card per named person', (vcf.match(/BEGIN:VCARD/g) || []).length === 5, (vcf.match(/BEGIN:VCARD/g) || []).length);
ok('a nameless number is left out', !/\+14255550205/.test(vcf));
ok('a card carries the car and town', /NOTE:2020 Civic · Everett/.test(vcf));

section('Grow');
await page.goto('https://texting.test/grow');
await page.waitForTimeout(400);
const hrefs = await page.locator('.tile').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
ok('every tile links somewhere real', hrefs.length >= 12 && hrefs.every((h) => /^\/\?classic=1&open=[a-z]+$|^\/signs\?owner=1$/.test(h)), hrefs);
const ids = hrefs.filter((h) => /open=/.test(h)).map((h) => h.split('open=')[1]);
const featureIds = [...indexHtml.matchAll(/\{id:"([a-z0-9]+)",t:"/g)].map((m) => m[1]);
ok('every open= id is a screen the classic app knows', ids.every((i) => featureIds.includes(i)), ids.filter((i) => !featureIds.includes(i)));

section('The switch (index.html)');
// Switched on 2026-10-08: the new Inbox is the front door.
ok('the switch is on', /var NEW_APP_HOME = true;/.test(indexHtml));
await page.goto('https://switch.example/');
await page.waitForTimeout(400);
ok('switched on, the front door is the new Inbox', new URL(page.url()).pathname === '/inbox', page.url());
await page.goto('https://switch.example/?c=%2B14255550202');
await page.waitForTimeout(400);
ok('a link to a chat opens that chat in the new Inbox', page.url().endsWith('/inbox?c=%2B14255550202'), page.url());
await page.goto('https://switch.example/?money=1');
await page.waitForTimeout(300);
ok('a money link stays in the classic app', new URL(page.url()).pathname === '/', page.url());
await page.goto('https://switch.example/?classic=1');
await page.waitForTimeout(300);
await page.goto('https://switch.example/');
await page.waitForTimeout(300);
ok('?classic=1 keeps the classic app for the rest of the tab', new URL(page.url()).pathname === '/', page.url());

section('Page health');
ok('no errors in the console', errs.filter((e) => !/Failed to load resource/.test(e)).length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
