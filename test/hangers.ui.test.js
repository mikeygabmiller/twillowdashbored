// Insights → Hangers, driven the way Mikey uses it on a sidewalk: open it,
// see what's next, tap a zone, start hanging with GPS on, tap +1 a few times,
// finish, and check the drop that reaches the server. Also: a QR lead and a
// booking inside a hung zone both show up as hanger leads.
import { chromium } from 'playwright-core';
import fs from 'fs';
import { execFileSync } from 'child_process';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ZONES = fs.readFileSync(new URL('../public/hanger-zones.json', import.meta.url), 'utf8');
const Z = JSON.parse(ZONES);
const z1 = Z.features.find((f) => f.properties.id === 'Z01');
// A point inside Z01: the middle of its first ring's first edge pulled inward is
// fiddly, so use the zone's own "park here" spot's neighbour search instead —
// any vertex average of the ring works for these compact zones.
const ring = z1.geometry.type === 'Polygon' ? z1.geometry.coordinates[0] : z1.geometry.coordinates[0][0];
const mid = ring.reduce((a, c) => [a[0] + c[0] / ring.length, a[1] + c[1] / ring.length], [0, 0]);

// Leaflet comes off cdnjs in the app. The test browser may have no route out,
// so fetch it once here (curl honours the proxy) and serve it; if that fails
// too, the map check is skipped rather than failed.
const LEAF = {};
for (const f of ['leaflet.min.js', 'leaflet.min.css']) {
  try { LEAF[f] = execFileSync('curl', ['-sfL', '--max-time', '20', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/' + f]).toString(); } catch (e) {}
}
const now = Date.now(), day = 864e5;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const dropDate = new Date(now - 10 * day).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const DATA = {
  ok: true, today, since: '2026-10-01',
  drops: [{ id: 'd1', zone: 'Z01', kind: 'zone', date: dropDate, count: 240, minutes: 180, note: '', track: [[mid[1], mid[0]], [mid[1] + 0.001, mid[0]]], at: now - 10 * day }],
  leads: { '+14255550101': { how: 'qr', at: now - 5 * day, zone: '', name: 'Dana', where: '98012' } },
  people: { '+14255550101': { name: 'Dana', status: 'active' }, '+14255550202': { name: 'Booked Bea', status: 'won' } },
  revenue: { '+14255550202': 409 },
  bookings: [{ id: 'b1', phone: '+14255550202', name: 'Booked Bea', city: 'Mill Creek', address: '1 Test St', createdAt: now - 3 * day,
    apptAt: now + 2 * day, dateLabel: 'Sat', estimate: 409, status: 'confirmed', geo: { lat: mid[1], lon: mid[0] } }],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 414, height: 896 }, geolocation: { latitude: mid[1], longitude: mid[0], accuracy: 8 }, permissions: ['geolocation'] });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message + (process.env.STACK ? ' ' + e.stack : '')));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const posts = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.hostname === 'cdnjs.cloudflare.com') {
    const f = p.split('/').pop();
    if (LEAF[f]) return route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript', body: LEAF[f] });
    return route.fulfill({ status: 503, body: '' });
  }
  if (u.hostname.endsWith('openstreetmap.org')) return route.fulfill({ status: 204, body: '' });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/hanger-zones.json') return route.fulfill({ status: 200, contentType: 'application/json', body: ZONES });
  if (p === '/api/hangers' && route.request().method() === 'POST') {
    const b = JSON.parse(route.request().postData() || '{}'); posts.push(b);
    if (b.action === 'drop') DATA.drops.push(Object.assign({ id: 'd' + (DATA.drops.length + 1), at: Date.now() }, b.drop, { count: +b.drop.count, minutes: +b.drop.minutes }));
    return json({ ok: true });
  }
  if (p === '/api/hangers') return json(DATA);
  if (p === '/api/threads') return json({ ok: true, threads: [{ phone: '+14255550303', name: 'Walk-up Wes', lastTs: now }], config: {} });
  if (p === '/api/money') return json({ ok: true, month: '2026-10', today, entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('It opens from the command bar');
await page.locator('#search').fill('door hanger');
await page.waitForTimeout(300);
await page.locator('.fx-row', { hasText: 'Door hangers' }).first().click();
await page.waitForTimeout(1500);
ok('the Hangers report is open', (await page.$eval('#grTitle', (n) => n.textContent.trim())) === 'Door hangers');
ok('every zone is listed', (await page.locator('.hg-row').count()) >= Z.features.length, await page.locator('.hg-row').count());
if (LEAF['leaflet.min.js']) ok('the map drew', (await page.locator('#hgMap .leaflet-interactive').count()) > 10, await page.locator('#hgMap .leaflet-interactive').count());
else console.log('  - map check skipped: no network to fetch Leaflet');

// SHOT=dir saves what the screen looks like, for a human to look at.
const shot = async (n) => { if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/' + n + '.png', fullPage: false }); };
await shot('1-open');
await page.locator('#grBody').evaluate((b) => { b.scrollTop = 520; });
await page.waitForTimeout(300);
await shot('2-numbers');
await page.locator('#grBody').evaluate((b) => { b.scrollTop = 0; });

section('Numbers and leads');
const stats = await page.$$eval('.hg .stat .v', (ns) => ns.map((n) => n.textContent.trim()));
ok('240 hung so far', stats[0] === '240', stats);
const leadText = await page.locator('.hg').innerText();
ok('the QR lead is listed', /Dana[\s\S]*scanned the QR/.test(leadText));
ok('the booking inside hung Z01 is credited to it', /Booked Bea[\s\S]*lives in the zone · Z01/.test(leadText), leadText.slice(0, 400));
ok('its job money shows', /\$409/.test(leadText));
ok('Z01 is not "up next" again, it is already hung', !(await page.locator('.hg-row', { hasText: 'this week' }).first().innerText()).includes('Z01'));
ok('the upcoming job gets an around-the-job prompt', /Hang 20 to 30 around these jobs[\s\S]*Booked Bea/.test(leadText));

section('Picking a zone');
await page.locator('.hg-row[data-hgsel="Z02"]').first().click();
await page.waitForTimeout(900);
const card = await page.locator('.hg-card').first().innerText();
ok('the zone card opens', /Z02/.test(card), card.slice(0, 120));
const nav = await page.locator('.hg-card a.btn').first().getAttribute('href');
await shot('3-zone');
ok('Navigate goes to Google Maps directions', /google\.com\/maps\/dir\/\?api=1&destination=/.test(nav), nav);

section('Hanging mode');
await page.locator('[data-hgstart="Z02"]').click();
await page.waitForTimeout(1500);
ok('the live panel shows', await page.locator('.hg-live').isVisible());
for (let i = 0; i < 3; i++) await page.locator('#hgPlus').click();
await page.locator('#hgMinus').click();
ok('the tap counter counts', (await page.locator('#hgTaps').innerText()) === '2');
await context.setGeolocation({ latitude: mid[1] + 0.0005, longitude: mid[0], accuracy: 6 });
await page.waitForTimeout(1500);
const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-hang-session') || 'null'));
ok('the session survives a reload (saved locally)', sess && sess.zone === 'Z02' && sess.taps === 2, sess);
ok('GPS points are being recorded', sess && sess.track.length >= 1, sess && sess.track.length);
await shot('4-hanging');
await page.locator('#hgFinish').click();
await page.waitForTimeout(500);
ok('finish asks for the count, prefilled with the taps', (await page.locator('#hgFCount').inputValue()) === '2');
await page.locator('#hgFCount').fill('180');
await page.locator('#hgFSave').click();
await page.waitForTimeout(1200);
const drop = posts.find((b) => b.action === 'drop');
ok('the drop reached the server', drop && drop.drop.zone === 'Z02' && drop.drop.count === '180', drop && drop.drop);
ok('with the GPS trail', drop && drop.drop.track.length >= 1);
ok('hanging mode ended', !(await page.locator('.hg-live').count()) && !(await page.evaluate(() => localStorage.getItem('mkd-hang-session'))));
ok('and the total moved', (await page.$$eval('.hg .stat .v', (ns) => ns[0].textContent.trim())) === '420');

section('Crediting someone who said so');
await page.locator('#hgCreditBtn').click();
await page.waitForTimeout(300);
await page.locator('#hgCZone').selectOption('Z02');
await page.locator('#hgCSave').click();
await page.waitForTimeout(600);
const cr = posts.find((b) => b.action === 'credit');
ok('credit posts the conversation and zone', cr && cr.phone === '+14255550303' && cr.zone === 'Z02', cr);

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
