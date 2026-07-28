import { chromium } from 'playwright-core';
import fs from 'fs';
const HTML = fs.readFileSync(new URL('../../public/track.html', import.meta.url), 'utf8');

let payload = null;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|unpkg|tile\.openstreetmap|ERR_/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await p.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/track.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (u.pathname === '/api/track') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  if (u.pathname.startsWith('/p/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from('x') });
  if (u.hostname.includes('unpkg') || u.hostname.includes('tile.openstreetmap')) return route.abort();  // prove the page works without the map
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const base = {
  ok: true,
  business: { name: "Mikey's Mobile Detailing", owner: 'Mikey', photo: '', rating: '5.0', reviews: 39 },
  customer: { name: 'Jenna' },
  job: { at: Date.now() + 3600000, service: 'Full Detail', vehicle: '2019 Tahoe', address: '123 Main St, Everett', lat: 47.979, lon: -122.2 },
  prep: 'Please have the car accessible, and water & power within about 20 ft.',
  contact: '+14256007897', photos: [],
};
const show = async (o) => { payload = o; await p.goto('https://texting.test/track.html?t=' + 'a'.repeat(32)); await p.waitForTimeout(700); };

section('En route');
await show(Object.assign({}, base, { stage: 'enroute', eta: { min: 12, at: Date.now() + 12 * 60000 }, position: { lat: 47.95, lon: -122.15, at: Date.now() } }));
let txt = await p.locator('body').innerText();
ok('shows the minutes big', (await p.locator('#etaBig').textContent()) === '12');
ok('says "minutes away"', txt.includes('minutes away'));
ok('names the destination', txt.includes('123 Main St'));
ok('shows arrival clock time', /arriving around/i.test(txt));
ok('shows the rating', txt.includes('5.0') && txt.includes('39 reviews'));
ok('shows prep instructions', txt.includes('water & power'));
ok('disclosure text is present in the page', (await p.evaluate(() =>
  (document.querySelector('.maphint')||{}).textContent||'')).toLowerCase().includes('approximate'));
ok('…and it hides together with the map, never alone', await p.evaluate(() => {
  const m=document.querySelector('#map'), h=document.querySelector('.maphint');
  if(!m||!h) return false;
  return (getComputedStyle(m).display==='none') === (getComputedStyle(h).display==='none');
}));
ok('offers a text button', await p.locator('a[href^="sms:"]').count() === 1);
ok('page still renders with the map library BLOCKED', await p.locator('.hero').count() === 1);
ok('…and the dead map box collapses instead of leaving a hole', !(await p.locator('#map').isVisible()));
ok('rating sits on one line with the stars', await p.evaluate(() =>
  getComputedStyle(document.querySelector('.stars')).display === 'inline'));
ok('no receipt yet', !txt.toLowerCase().includes('receipt'));

section('Arriving (under a minute)');
await show(Object.assign({}, base, { stage: 'enroute', eta: { min: 0, at: Date.now() + 20000 }, position: { lat: 47.97, lon: -122.19, at: Date.now() } }));
txt = await p.locator('body').innerText();
ok('reads "Any minute" instead of 0', txt.includes('Any minute'), txt.slice(0, 200));

section('Arrived');
await show(Object.assign({}, base, { stage: 'arrived', eta: null, position: null }));
txt = await p.locator('body').innerText();
ok('says he has arrived', txt.includes('Mikey has arrived'));
ok('no map when not driving', await p.locator('#map').count() === 0);
ok('no stale ETA', !/minutes away/.test(txt));

section('Working');
await show(Object.assign({}, base, { stage: 'working', eta: null, position: null, finishAt: Date.now() + 90 * 60000 }));
txt = await p.locator('body').innerText();
ok('says working on the vehicle', txt.includes('Working on your 2019 Tahoe'));
ok('gives a finish estimate', /Estimated finish around/.test(txt));

section('Done — the receipt');
await show(Object.assign({}, base, {
  stage: 'done', eta: null, position: null,
  photos: [{ id: 'ph1', kind: 'before' }, { id: 'ph2', kind: 'after' }],
  receipt: {
    services: [{ name: 'Full Detail — in & out', price: 339 }, { name: 'Pet hair removal', price: 60 }],
    total: 399, note: 'Used the extractor on the back seats.', at: Date.now(),
    pay: [
      { kind: 'venmo', label: 'Venmo', handle: '@mikeys-detailing', url: 'https://venmo.com/mikeys-detailing?txn=pay&amount=399' },
      { kind: 'cashapp', label: 'Cash App', handle: '$mikeysdetail', url: 'https://cash.app/$mikeysdetail/399' },
      { kind: 'zelle', label: 'Zelle', handle: '360-797-5831', url: '' },
    ],
    tipPrompt: false, reviewUrl: 'https://g.page/r/review',
  },
}));
txt = await p.locator('body').innerText();
ok('says all done', txt.includes('All done'));
ok('lists both line items', txt.includes('Full Detail — in & out') && txt.includes('Pet hair removal'));
ok('shows line prices', txt.includes('$339') && txt.includes('$60'));
ok('shows the total', txt.includes('$399'));
ok('shows the note', txt.includes('extractor'));
ok('shows before & after photos', await p.locator('.shots img').count() === 2);
ok('labels them before/after', txt.toLowerCase().includes('before') && txt.toLowerCase().includes('after'));
const venmo = p.locator('a.btn.pay.venmo');
ok('Venmo is a real tappable link', await venmo.count() === 1 && (await venmo.getAttribute('href')).includes('amount=399'));
ok('Cash App is tappable', (await p.locator('a.btn.pay.cashapp').getAttribute('href')).includes('/399'));
ok('Zelle shown but not a fake link', txt.includes('360-797-5831') && await p.locator('a.btn.pay').count() === 2);
ok('review button present', (await p.locator('a.btn.primary').getAttribute('href')) === 'https://g.page/r/review');
ok('tip line hidden when off', !txt.toLowerCase().includes('tips are never expected'));

section('Tips, when he turns them on');
const withTip = JSON.parse(JSON.stringify(payload));
withTip.receipt.tipPrompt = true;
await show(withTip);
ok('tip line appears', (await p.locator('body').innerText()).toLowerCase().includes('tips are never expected'));

section('Bad links');
await show({ ok: false, error: 'not_found' });
ok('expired link says so plainly', (await p.locator('body').innerText()).includes('This link has expired'));
await show({ ok: false, error: 'disabled' });
ok('disabled tracking degrades gracefully', (await p.locator('body').innerText()).includes("Can't load this right now"));

section('XSS safety');
await show(Object.assign({}, base, {
  stage: 'done', eta: null, position: null,
  business: { name: '<img src=x onerror=alert(1)>', owner: '<script>alert(2)</script>', photo: '', rating: '5.0', reviews: 1 },
  receipt: { services: [{ name: '<b>bold</b>', price: 10 }], total: 10, note: '<iframe src=x>', at: Date.now(), pay: [], tipPrompt: false, reviewUrl: '' },
}));
ok('no injected element rendered', await p.locator('img[src="x"], iframe, [onerror]').count() === 0);
ok('no injected script tag', await p.evaluate(() =>
  ![...document.querySelectorAll('script')].some(sc => /alert\(/.test(sc.textContent || ''))));
ok('receipt line item is text, not markup', await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.row .k')].map(e => e.innerHTML);
  return rows.some(h => h.includes('&lt;b&gt;bold&lt;/b&gt;'));
}));
ok('markup shown as literal text', (await p.locator('body').innerText()).includes('<b>bold</b>'));

console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
