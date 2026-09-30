// The Sign Crew app (/signs.html), driven the way a helper uses it in a car:
// open Mikey's link, join with a name, ask for a town, get a spaced-out
// route, start it (the reservation goes up at once), pull up to the first
// stop, tap "Sign placed", skip one with a reason, finish, and check what
// reached the server. Then Mikey's view: the crew, the link, the results.
import { chromium } from 'playwright-core';
import fs from 'fs';
import { execFileSync } from 'child_process';

const HTML = fs.readFileSync(new URL('../public/signs.html', import.meta.url), 'utf8');
const SPOTS = fs.readFileSync(new URL('../public/sign-spots.json', import.meta.url), 'utf8');
const SJ = JSON.parse(SPOTS);
const LEAF = {};
for (const f of ['leaflet.min.js', 'leaflet.min.css']) {
  try { LEAF[f] = execFileSync('curl', ['-sfL', '--max-time', '20', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/' + f]).toString(); } catch (e) {}
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x).slice(0, 300) : ''); } };
const section = (s) => console.log('\n' + s);

// The spot data itself.
section('The spot list');
ok('has thousands of spots', SJ.spots.length > 2000, SJ.spots.length);
const ix = {}; SJ.cols.forEach((c, i) => { ix[c] = i; });
const towns = new Set(SJ.spots.map((r) => r[ix.town]));
ok('covers all twelve towns', towns.size === 12, [...towns]);
ok('never Lynnwood or Edmonds', ![...towns].some((t) => /Lynnwood|Edmonds/.test(t)));
ok('ids are unique', new Set(SJ.spots.map((r) => r[ix.id])).size === SJ.spots.length);
ok('scores are 1 to 100', SJ.spots.every((r) => r[ix.score] >= 1 && r[ix.score] <= 100));
ok('nothing on a 50 mph road', SJ.spots.every((r) => r[ix.spd] < 50));
ok('passing traffic only on counted roads with 10,000+ cars', SJ.spots.every((r) => r[ix.ctrl] !== 'thru' || (r[ix.aadt] >= 10000 && !/e/.test(r[ix.flags]))));
ok('at most two sides of any corner', Object.values(SJ.spots.reduce((a, r) => { a[r[ix.jx]] = (a[r[ix.jx]] || 0) + 1; return a; }, {})).every((n) => n <= 2));

// A tiny fake Worker.
const SERVER = { docs: {}, crew: {}, links: [{ k: 'LINKLINKLINK123', label: 'Family', at: 1, off: 0 }], cfg: { pay: 1.5, photo: 'ask', recheck: 7, cap: 150, cost: 3, stock: 200 }, nogo: [], marks: {}, leads: {} };
const syncs = [];
function stateFor(owner, hid) {
  const docs = Object.values(SERVER.docs);
  return Object.assign({ ok: true, now: Date.now(), me: { id: hid, name: owner ? 'Mikey' : (SERVER.crew[hid] || {}).name }, owner,
    cfg: SERVER.cfg, crew: SERVER.crew, nogo: SERVER.nogo, marks: SERVER.marks, docs },
  owner ? { links: SERVER.links, leads: SERVER.leads, people: {}, revenue: {}, today: '2026-10-03', since: '2026-09-29' } : {});
}
function handleSync(b, hid) {
  syncs.push(b);
  const d = SERVER.docs[hid] = SERVER.docs[hid] || { id: hid, name: (SERVER.crew[hid] || {}).name || 'Mikey', p: [], e: [], sk: [], plan: null };
  (b.p || []).forEach((r) => { if (!d.p.some((x) => x[0] === r[0])) d.p.push(r); });
  (b.e || []).forEach((r) => d.e.push(r));
  (b.sk || []).forEach((r) => d.sk.push(r));
  if (b.plan !== undefined) d.plan = b.plan;
  return { ok: true, ack: (b.p || []).map((r) => r[0]), events: (b.e || []).length, skips: (b.sk || []).length, photos: Object.keys(b.photos || {}).length };
}

// Stand a helper somewhere in Lake Stevens, then move them to the first stop.
const start = { latitude: 48.0151, longitude: -122.0637 };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 400, height: 860 }, geolocation: Object.assign({ accuracy: 6 }, start), permissions: ['geolocation'] });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('dialog', (d) => d.accept(d.defaultValue() || 'Neighbors'));

await context.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.hostname === 'cdnjs.cloudflare.com') {
    const f = p.split('/').pop();
    if (LEAF[f]) return route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css' : 'application/javascript', body: LEAF[f] });
    return route.fulfill({ status: 503, body: '' });
  }
  if (u.hostname.endsWith('openstreetmap.org') || u.hostname.endsWith('arcgisonline.com')) return route.fulfill({ status: 204, body: '' });
  if (p === '/signs.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/sign-spots.json') return route.fulfill({ status: 200, contentType: 'application/json', body: SPOTS });
  const b = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : {};
  if (p === '/api/crew/hello') return json({ ok: true, valid: b.k === 'LINKLINKLINK123', pay: 1.5 });
  if (p === '/api/crew/join') { SERVER.crew[b.h] = { name: b.name, at: Date.now(), link: b.k }; SERVER.secret = b.s; return json({ ok: true, name: b.name }); }
  if (p === '/api/crew/state') {
    if (b.asOwner) return json(stateFor(true, 'mikey'));
    if (!SERVER.crew[b.h] || b.s !== SERVER.secret) return json({ ok: false, error: 'who' }, 403);
    return json(stateFor(false, b.h));
  }
  if (p === '/api/crew/sync') return json(handleSync(b, b.asOwner ? 'mikey' : b.h));
  if (p === '/api/signs' && req.method() === 'GET') return json(stateFor(true, 'mikey'));
  if (p === '/api/signs') {
    if (b.action === 'link-new') { const l = { k: 'NEWLINKNEWLINK99', label: b.label, at: Date.now(), off: 0 }; SERVER.links.push(l); return json({ ok: true, link: l }); }
    if (b.action === 'settings') { Object.assign(SERVER.cfg, b.cfg); return json({ ok: true }); }
    return json({ ok: true });
  }
  return route.fulfill({ status: 404, body: '' });
});

section('Joining from the link');
await page.goto('https://crew.test/signs.html#k=LINKLINKLINK123');
await page.waitForSelector('#jName', { timeout: 8000 });
ok('the join screen says what they will be paid', /\$1\.50/.test(await page.textContent('#app')));
ok('the link is taken out of the address bar', !(await page.evaluate(() => location.hash)));
await page.fill('#jName', 'Jess');
await page.click('#jGo');
await page.waitForSelector('#cN', { timeout: 10000 });
ok('joined and on the Go tab', Object.values(SERVER.crew).some((c) => c.name === 'Jess'));
const idStored = await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-crew-id')));
ok('the phone remembers who they are', idStored && idStored.name === 'Jess' && idStored.s.length >= 32, idStored);

section('Planning a town');
await page.click('#cMinus'); await page.click('#cMinus'); await page.click('#cMinus'); await page.click('#cMinus'); await page.click('#cMinus');
ok('the count moves', (await page.inputValue('#cN')) === '5');
await page.click('[data-where="town"]');
await page.click('.chips [data-town="Lake Stevens"]');
await page.waitForSelector('#planGo');
const stops = await page.$$eval('.item .n', (n) => n.length);
ok('five stops planned', stops === 5, stops);
const plan = await page.evaluate(() => window.__signs.S.plan.stops.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, jx: s.jx, town: s.town })));
ok('all in Lake Stevens', plan.every((s) => s.town === 'Lake Stevens'), plan);
const m = (a, b) => { const dy = (a.lat - b.lat) * 111320, dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180); return Math.sqrt(dx * dx + dy * dy); };
let spaced = true;
for (let i = 0; i < plan.length; i++) for (let j = i + 1; j < plan.length; j++) if (plan[i].jx !== plan[j].jx && m(plan[i], plan[j]) < 500) spaced = false;
ok('stops are at least 500 m apart (or the same corner)', spaced);

section('Suggestions');
await page.click('[data-where="suggest"]');
await page.waitForSelector('.sugg');
ok('three areas suggested', (await page.$$('.sugg')).length === 3);
ok('the first one is marked best', /Best right now/.test(await page.textContent('.sugg.best')));
await page.click('[data-where="town"]');
await page.click('.chips [data-town="Lake Stevens"]');
await page.waitForSelector('#planGo');

section('Driving the route');
await page.click('#planGo');
await page.waitForSelector('#drive');
await page.waitForTimeout(600);
ok('the reservation went up right away', syncs.some((s) => s.plan && s.plan.spots.length === 5), syncs.map((s) => s.plan));
ok('drive mode shows the first stop', /Stop 1 of 5/.test(await page.textContent('#drive')));
ok('it says which side and which way', /Right side of .+ facing cars heading/.test(await page.textContent('#drive')));
ok('directions give the checked distance back and past the curb', await page.evaluate(() => {
  const t = window.__signs.howTo({ road: 'Main St', head: 0, ctrl: 'sig', back: 37, side: 2.5 });
  return /About 120 ft before the light/.test(t) && /about 10 ft past the curb/.test(t) && /The pin is the spot/.test(t);
}));
ok('and an old list without them still reads', /About 100 ft before it/.test(await page.evaluate(() => window.__signs.howTo({ road: 'Main St', head: 0, ctrl: 'sig' }))));
ok('with a Street View look at the verge first', /map_action=pano&viewpoint=/.test(await page.getAttribute('#dSv', 'href')));
await context.setGeolocation({ latitude: plan[0].lat, longitude: plan[0].lon, accuracy: 5 });
await page.waitForFunction(() => /You're here/.test(document.querySelector('#drive').textContent), null, { timeout: 12000 }).catch(() => {});
ok('arriving is noticed', /You're here/.test(await page.textContent('#drive')));
await page.click('#dPlaced');
await page.waitForTimeout(300);
ok('the next stop comes up', /Stop 2 of 5/.test(await page.textContent('#drive')));
const q1 = await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-crew-q')));
ok('the sign is saved on the phone first', q1.p.length === 1 && q1.p[0][4] === plan[0].id, q1.p);
ok('with the GPS point where they stood', Math.abs(q1.p[0][1] - plan[0].lat) < 1e-4, q1.p[0]);
await page.click('#dSkip');
await page.click('[data-why="hoa"]');
ok('a skip moves on', /Stop 3 of 5/.test(await page.textContent('#drive')));
await page.click('#dEnd');           // the confirm is accepted by the page's dialog handler
await page.waitForTimeout(800);
const up = syncs.flatMap((s) => s.p || []);
ok('finishing uploads the sign', up.some((r) => r[0] === q1.p[0][0]), up);
ok('and the skip, with its reason', syncs.some((s) => (s.sk || []).some((r) => r[2] === 'hoa')));
ok('and lets the reservation go', syncs.some((s) => s.plan === null));
const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-crew-q')));
ok('nothing left waiting', q2.p.length === 0 && q2.sk.length === 0, q2);

section('Their signs');
await page.click('[data-tab="signs"]');
await page.waitForSelector('[data-ev="up"]');
await page.click('[data-ev="up"]');
ok('a check is queued', (await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-crew-q')).e.length)) === 1);
await page.click('[data-tab="how"]');
ok('the how-to is there', /Where a sign goes/.test(await page.textContent('#app')) && /Never/.test(await page.textContent('#app')));
await page.click('[data-tab="map"]');
await page.waitForTimeout(1200);
if (LEAF['leaflet.min.js']) {
  ok('the map draws spots', (await page.$$('.leaflet-interactive')).length > 5);
  ok('the map stays under the header when the page scrolls', await page.evaluate(() => { const c = getComputedStyle(document.getElementById('map')); return c.position === 'relative' && c.zIndex === '0' && c.isolation === 'isolate'; }));
  ok('a Satellite view to switch to', /Satellite/.test(await page.textContent('.leaflet-control-layers')));
  const dots = await page.evaluate(() => { const out = []; window.__signs.S.map.eachLayer((l) => { if (l.getPopup && l.getPopup() && l.getLatLng && /#E31924|#f97316|#facc15/.test(l.options.fillColor)) out.push(l.getLatLng()); }); return out; });
  const jxAt = await page.evaluate((d) => d.map((p) => { const s = window.__signs.S.spots.find((x) => x.lat === p.lat && x.lon === p.lng); return s ? s.jx : null; }).filter((x) => x !== null), dots);
  ok('one dot per corner', jxAt.length > 5 && new Set(jxAt).size === jxAt.length, jxAt.length);
  const two = await page.evaluate(() => { let hit = null; window.__signs.S.map.eachLayer((l) => { if (!hit && l.getPopup && l.getPopup() && /good sides/.test(l.getPopup().getContent())) hit = l; }); if (hit) hit.openPopup(); return !!hit; });
  if (two) {
    ok('a two-sided corner lists both sides', (await page.$$('.leaflet-popup [data-add]')).length === 2);
    ok('each with Street View', (await page.$$('.leaflet-popup a[href*="map_action=pano"]')).length === 2);
    const before = await page.evaluate(() => (window.__signs.S.plan && window.__signs.S.plan.stops.length) || 0);
    await page.click('.leaflet-popup [data-add] >> nth=1');
    ok('and either side can go on the route', (await page.evaluate(() => window.__signs.S.plan.stops.length)) === before + 1);
  } else console.log('  (no two-sided corner in view)');
  await page.click('.leaflet-control-layers-base label:has-text("Satellite")');
  ok('the choice is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('mkd-crew-pref')).sat === true));
} else console.log('  (map skipped: no route to cdnjs)');
ok('no page errors (helper)', !errs.length, errs);

section("Mikey's view");
const op = await context.newPage();
op.on('pageerror', (e) => errs.push('PAGEERROR(owner): ' + e.message));
op.on('dialog', (d) => d.accept(d.defaultValue() || 'Neighbors'));
await op.goto('https://crew.test/signs.html?owner=1');
await op.waitForSelector('[data-tab="crew"]', { timeout: 10000 });
await op.click('[data-tab="crew"]');
ok('Jess is on the crew list', /Jess/.test(await op.textContent('#app')));
ok('with what she is owed at $1.50 a sign', /\$1\.50/.test(await op.textContent('#app')));
ok('the link shows as a full URL', /signs#k=LINKLINKLINK123/.test(await op.textContent('#app')));
await op.click('#linkNew');
await op.waitForTimeout(500);
ok('a new link can be made', SERVER.links.length === 2 && /NEWLINKNEWLINK99/.test(await op.textContent('#app')));
await op.click('[data-tab="results"]');
ok('results show the count', /signs placed/.test(await op.textContent('#app')));
await op.click('[data-tab="settings"]');
await op.fill('#sPay', '2');
await op.click('#sSave');
await op.waitForTimeout(300);
ok('settings save', SERVER.cfg.pay === 2, SERVER.cfg);
if (LEAF['leaflet.min.js']) {
  const nogoPosts = [];
  op.on('request', (r) => { if (r.url().endsWith('/api/signs') && r.method() === 'POST') { const b = JSON.parse(r.postData() || '{}'); if (b.action === 'nogo-add') nogoPosts.push(b); } });
  await op.click('[data-tab="map"]');
  await op.waitForTimeout(1200);
  await op.evaluate(() => { let hit = null; window.__signs.S.map.eachLayer((l) => { if (!hit && l.getPopup && l.getPopup() && /hide this corner/.test(l.getPopup().getContent())) hit = l; }); if (hit) hit.openPopup(); });
  ok('Mikey can hide a corner he saw on Street View', !!(await op.$('.leaflet-popup [data-hide]')));
  await op.click('.leaflet-popup [data-hide]');
  await op.waitForTimeout(400);
  ok('as a small no-go circle, so it can be undone', nogoPosts.length === 1 && nogoPosts[0].r === 40 && /Not a good spot/.test(nogoPosts[0].note), nogoPosts);
}
ok('no page errors (owner)', !errs.length, errs);
ok('Mikey can get back to the dashboard', await op.isVisible('#hBack'));

section('When the server breaks, the page says so');
const bp = await context.newPage();
await bp.route('**/api/signs', (r) => r.fulfill({ status: 500, contentType: 'text/html', body: '<html>Error 1101</html>' }));
await bp.goto('https://crew.test/signs.html?owner=1');
await bp.waitForSelector('#retry', { timeout: 8000 }).catch(() => {});
ok('"That didn\'t load" with the reason, not an endless Loading', /didn't load/.test(await bp.textContent('#app')) && /500/.test(await bp.textContent('#app')), await bp.textContent('#app'));

section("Mikey's own link signs in by itself");
const lp = await context.newPage();
let authed = false;
await lp.route('**/api/signs', (r) => authed ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stateFor(true, 'mikey')) })
  : r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' }));
await lp.route('**/api/login', (r) => { const b = JSON.parse(r.request().postData() || '{}'); authed = b.password === 'right';
  r.fulfill({ status: authed ? 200 : 401, contentType: 'application/json', body: JSON.stringify(authed ? { ok: true, role: 'owner' } : { ok: false, error: 'wrong_password' }) }); });
await lp.goto('https://crew.test/signs.html?owner=1');
await lp.waitForSelector('#oPw', { timeout: 8000 });
ok('asks for the password instead of sending him back to the dashboard', /dashboard password/.test(await lp.textContent('#app')));
ok('installs as its own app', (await lp.getAttribute('#mf', 'href')) === '/signs-owner.webmanifest');
await lp.fill('#oPw', 'wrong'); await lp.click('#oGo'); await lp.waitForTimeout(300);
ok('a wrong password says so', /didn't work/.test(await lp.textContent('#oErr')));
await lp.fill('#oPw', 'right'); await lp.click('#oGo');
await lp.waitForSelector('[data-tab="crew"]', { timeout: 8000 }).catch(() => {});
ok('the right one opens his view', await lp.isVisible('[data-tab="crew"]'));
const YS = fs.readFileSync(new URL('../public/yardsigns.html', import.meta.url), 'utf8');
ok('/yardsigns opens his view', /location\.replace\("\/signs\?owner=1"\+/.test(YS));

section('His private link opens with no password');
const KEY1 = 'PRIVATEKEY1abcdefghijklmnopqrstuvwxyz0123', KEY2 = 'PRIVATEKEY2abcdefghijklmnopqrstuvwxyz0123';
let liveKey = KEY1;
const kc = await browser.newContext({ viewport: { width: 400, height: 860 } });
const kerrs = [];
await kc.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) });
  const key = req.headers()['x-signs-key'];
  if (u.hostname === 'cdnjs.cloudflare.com') return route.fulfill({ status: 503, body: '' });
  if (p === '/yardsigns') return route.fulfill({ status: 200, contentType: 'text/html', body: YS });
  if (p === '/signs' || p === '/signs.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/sign-spots.json') return route.fulfill({ status: 200, contentType: 'application/json', body: SPOTS });
  if (p === '/api/signs/manifest') return json({ start_url: '/signs?owner=1' });
  if (p === '/api/signs' && req.method() === 'GET') return key === liveKey ? json(Object.assign(stateFor(true, 'mikey'), { ownerKey: liveKey })) : json({ ok: false, error: 'unauthorized' }, 401);
  if (p === '/api/signs') { if (key !== liveKey) return json({ ok: false, error: 'unauthorized' }, 401); const b = JSON.parse(req.postData() || '{}'); if (b.action === 'key-new') { liveKey = KEY2; return json({ ok: true, ownerKey: KEY2 }); } return json({ ok: true }); }
  if (p === '/api/crew/state' || p === '/api/crew/sync') return key === liveKey ? json(p === '/api/crew/state' ? stateFor(true, 'mikey') : { ok: true, ack: [] }) : json({ ok: false, error: 'unauthorized' }, 403);
  return route.fulfill({ status: 404, body: '' });
});
const kp = await kc.newPage();
kp.on('pageerror', (e) => kerrs.push(e.message));
kp.on('dialog', (d) => d.accept());
await kp.goto('https://crew.test/yardsigns?o=' + KEY1);
await kp.waitForSelector('[data-tab="crew"]', { timeout: 10000 }).catch(() => {});
ok('/yardsigns?o=… opens his view', await kp.isVisible('[data-tab="crew"]'));
ok('no password asked', !(await kp.$('#oPw')));
ok('the installed app carries the key', (await kp.getAttribute('#mf', 'href')) === '/api/signs/manifest?o=' + KEY1);
ok('this phone keeps it', (await kp.evaluate(() => JSON.parse(localStorage.getItem('mkd-signs-owner')))) === KEY1);
const kp2 = await kc.newPage();
await kp2.goto('https://crew.test/signs?owner=1');
await kp2.waitForSelector('[data-tab="crew"]', { timeout: 10000 }).catch(() => {});
ok('next time the plain link opens straight in', await kp2.isVisible('[data-tab="crew"]') && !(await kp2.$('#oPw')));
await kp2.close();
await kp.click('[data-tab="settings"]');
ok('Settings shows the link to copy', (await kp.textContent('#okLink')) === 'https://crew.test/yardsigns?o=' + KEY1);
await kp.click('#okNew');
await kp.waitForFunction((k) => (document.querySelector('#okLink') || {}).textContent === 'https://crew.test/yardsigns?o=' + k, KEY2, { timeout: 5000 }).catch(() => {});
ok('a new link replaces it', (await kp.textContent('#okLink')) === 'https://crew.test/yardsigns?o=' + KEY2);
ok('and this phone switches to it', (await kp.evaluate(() => JSON.parse(localStorage.getItem('mkd-signs-owner')))) === KEY2);
const kc2 = await browser.newContext({ viewport: { width: 400, height: 860 } });
await kc2.route('**/*', (route) => { const u = new URL(route.request().url()); const p = u.pathname;
  if (p === '/yardsigns') return route.fulfill({ status: 200, contentType: 'text/html', body: YS });
  if (p === '/signs') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/sign-spots.json') return route.fulfill({ status: 200, contentType: 'application/json', body: SPOTS });
  if (p === '/api/signs') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' });
  return route.fulfill({ status: 404, body: '' }); });
const kp3 = await kc2.newPage();
await kp3.goto('https://crew.test/yardsigns?o=' + KEY1);
await kp3.waitForSelector('#oPw', { timeout: 8000 }).catch(() => {});
ok('the old link says it was replaced', /replaced by a newer one/.test(await kp3.textContent('#app')));
ok('and forgets the dead key', (await kp3.evaluate(() => localStorage.getItem('mkd-signs-owner'))) === null);
ok('no page errors (private link)', !kerrs.length, kerrs);
await kc.close(); await kc2.close();

section('The dashboard button goes straight to the page');
const IDX = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
ok('no redirect in between', (IDX.match(/location\.assign\("\/signs\?owner=1"\)/g) || []).length === 2 && !/signs\.html\?owner/.test(IDX));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
