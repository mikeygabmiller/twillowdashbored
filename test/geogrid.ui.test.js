// Browser test for the "20+ everywhere" diagnostic in Analytics → Map → Map rank.
//
// A scan where nothing matched used to render as a wall of red pins and three
// dead stats — indistinguishable from genuinely ranking nowhere, and the owner
// had paid Google for every one of those points. These assert that a fully
// missed scan now explains itself, offers the one-call check against Google,
// and lets the owner pin their real listing from the result list.
//
//   npm install && node test/geogrid.ui.test.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium, devices;
try { ({ chromium, devices } = await import('playwright-core')); }
catch { console.error('playwright-core is missing — run `npm install` first.'); process.exit(2); }

const ROOT = path.join(__dirname, '..', 'public');
const server = http.createServer((q, r) => {
  let p = q.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript' });
  r.end(fs.readFileSync(f));
});

const CENTER = { lat: 47.9129, lng: -122.0982 };
// A 5x5 scan where every point came back 20+ — but Google DID return 20 results
// at each one, which is the "we didn't recognise you" case, not "you rank last".
const results = [];
for (let i = 0; i < 25; i++) results.push({ lat: CENTER.lat + i * 0.001, lng: CENTER.lng, rank: 21, total: 20 });
const SCAN = {
  id: 's1', ts: Date.now(), keyword: 'mobile detailing', size: 5, radiusMi: 5,
  centerLat: CENTER.lat, centerLng: CENTER.lng, results,
  stats: { points: 25, arp: null, atrp: 21, solv: 0, top3: 0, top10: 0, missing: 25, empty: 0 },
};
const GEOGRID = {
  ok: true, connected: true, via: 'saved', maxBatch: 25, scans: [SCAN],
  config: { bizName: "Mikey's Detailing Snohomish", placeId: '', keyword: 'mobile detailing',
    centerLat: CENTER.lat, centerLng: CENTER.lng },
};
const PREVIEW = {
  ok: true, keyword: 'mobile detailing', lat: CENTER.lat, lng: CENTER.lng,
  lookingFor: "Mikey's Detailing Snohomish", placeId: '',
  results: [
    { rank: 1, id: 'ChIJ_mikey', name: "Mikey's Mobile Detailing", address: 'Snohomish, WA', match: false },
    { rank: 2, id: 'ChIJ_other', name: 'Precision Auto Detailing', address: 'Everett, WA', match: false },
  ],
};

let PASS = 0, FAIL = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${ok ? '' : `\n     got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

(async () => {
  await new Promise((r) => server.listen(8791, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ ...devices['Galaxy S9+'], viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  let connectBody = null, previewBody = null;

  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    let po = {}; try { po = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    let body = { ok: true };
    if (u.pathname === '/api/geogrid') body = GEOGRID;
    else if (u.pathname === '/api/geogrid/preview') { previewBody = po; body = PREVIEW; }
    else if (u.pathname === '/api/geogrid/connect') { connectBody = po; body = { ok: true }; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // The map tiles are a third-party image host — not part of this test.
  await page.route('**://*/**.png*', (route) => route.abort());

  // Open the dashboard and land on Analytics → Map → Map rank. The scan list is
  // fetched once and cached, so each scenario starts from a fresh load.
  const openRank = async () => {
    await page.goto('http://127.0.0.1:8791/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    if (await page.locator('.pin-pad').isVisible().catch(() => false)) {
      await page.keyboard.type('1234'); await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
    }
    await page.locator('.navitem[data-tab="analytics"]').click();
    await page.waitForTimeout(500);
    await page.locator('#grNav [data-gv="map"]').click();
    await page.waitForTimeout(500);
    await page.locator('[data-gm="rank"]').click();
    await page.waitForTimeout(700);
  };

  console.log('\n=== Map rank: a scan that matched nothing explains itself ===');
  await openRank();

  const txt = () => page.locator('#ggBody').innerText();
  const body1 = await txt();
  check('calls out that nothing matched', /Not matched at any of the 25 points/i.test(body1), true);
  check('names what it is matching on', body1.includes("Mikey's Detailing Snohomish"), true);
  check('says Google did return businesses', /did.*return businesses/i.test(body1), true);
  check('offers the one-call check', await page.locator('#ggProbe').isVisible(), true);

  await page.locator('#ggProbe').click();
  await page.waitForTimeout(500);
  check('preview asked for the scan keyword', previewBody && previewBody.keyword, 'mobile detailing');
  check('preview asked at the scan centre', previewBody && +(+previewBody.lat).toFixed(4), 47.9129);
  const body2 = await txt();
  check('shows what Google actually returned', body2.includes("Mikey's Mobile Detailing"), true);
  check('invites the owner to pin their listing', /this is me/i.test(body2), true);

  await page.locator('[data-gg-use="ChIJ_mikey"]').click();
  await page.waitForTimeout(400);
  check('pins that exact Place ID', connectBody && connectBody.placeId, 'ChIJ_mikey');
  check('and adopts the listing name Google uses', connectBody && connectBody.bizName, "Mikey's Mobile Detailing");
  check('never re-sends a key it was not given', connectBody && connectBody.key, '');

  console.log('\n=== a healthy scan stays clean ===');
  const good = JSON.parse(JSON.stringify(SCAN));
  good.results = good.results.map((r, i) => ({ ...r, rank: (i % 3) + 1 }));
  good.stats = { points: 25, arp: 2, atrp: 2, solv: 36, top3: 25, top10: 25, missing: 0, empty: 0 };
  good.matchedName = "Mikey's Mobile Detailing";
  GEOGRID.scans = [good];
  await openRank();
  const body3 = await txt();
  check('no diagnostic when points matched', /Not matched at any/i.test(body3), false);
  check('says which listing the ranks belong to', body3.includes("Ranks are for the listing Google calls"), true);

  check('no page errors', errs, []);
  await b.close(); server.close();
  console.log(`\n${FAIL ? 'FAILED' : 'OK'} — ${PASS} passed, ${FAIL} failed\n`);
  process.exit(FAIL ? 1 : 0);
})();
