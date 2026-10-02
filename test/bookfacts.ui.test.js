// The booking page facts check, on screen: Bookings → Settings shows what the
// booking page says that the website doesn't, and one tap fixes it. Then the
// booking page itself (where a friend's referral link lands): today's prices
// even with no settings to read, no "2 jobs a day", the spigot and outlet as a
// real requirement, and an Everett customer no longer told they're out of area.
//
//   node test/bookfacts.ui.test.js
import fs from 'fs';
import { chromium } from 'playwright-core';

const SETTINGS = fs.readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8');
const BOOK = fs.readFileSync(new URL('../public/book.html', import.meta.url), 'utf8');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); return v === undefined ? null : (o && o.type === 'json') ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); } };
const M = new Function('__env__', src + '\n; ENV = __env__; return { apiBookingSettings, apiBookingFacts, apiSaveBookingSettings, apiBookConfig, bookingDefaults };')({ MESSAGES: kv });

// The stale settings, as they were live.
const stale = M.bookingDefaults();
stale.services[0].price = { sedan: 299, suv: 339, truck: 379 }; stale.services[0].blurb = 'The works. First-timers ~3–4 hrs.';
stale.services[1].price = { sedan: 200, suv: 240, truck: 280 };
stale.services[2].price = { sedan: 160, suv: 200, truck: 240 }; stale.services[2].blurb = 'Hand wash, polish, spray wax.';
stale.proof.reviews = 39; stale.cities = ['Everett', 'Snohomish', 'Monroe'];
stale.content.hook = 'First full detail? Your exterior wash & wax (a $160 value) is free.';
store.set('bk:config', JSON.stringify(stale));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [], posts = [];
let configDown = false;
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('dialog', (d) => d.dismiss());
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname; const method = route.request().method();
  const send = async (resp) => route.fulfill({ status: resp.status, contentType: 'application/json', body: await resp.text() });
  if (p === '/bookings.html') return route.fulfill({ status: 200, contentType: 'text/html', body: SETTINGS });
  if (p === '/book.html') return route.fulfill({ status: 200, contentType: 'text/html', body: BOOK });
  if (p === '/api/bookings') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"bookings":[]}' });
  if (p === '/api/booking-settings/facts') { posts.push(p); return send(await M.apiBookingFacts()); }
  if (p === '/api/booking-settings' && method === 'POST') return send(await M.apiSaveBookingSettings({ json: async () => JSON.parse(route.request().postData() || '{}') }));
  if (p === '/api/booking-settings') return send(await M.apiBookingSettings());
  if (p === '/api/book-config') return configDown ? route.fulfill({ status: 503, body: '' }) : send(await M.apiBookConfig());
  if (p === '/api/availability') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"slots":["13:00"]}' });
  return route.fulfill({ status: 404, body: '' });
});

section('Settings says the booking page is behind');
await page.goto('http://x.test/bookings.html');
await page.click('.mbtn[data-m="settings"]');
await page.waitForSelector('#factsCard');
let card = await page.innerText('#factsCard');
ok('the warning is at the top', /doesn't match your website/.test(card), card.slice(0, 120));
ok('it shows the old Full Detail price next to the website\'s', /Now: \$299 \/ \$339 \/ \$379/.test(card) && /Website: \$369 \/ \$409 \/ \$449/.test(card));
ok('it names the 3–4 hours', /3–4 hours/.test(card));
ok('it names the polish', /polish is included/i.test(card));
ok('it names the review count', /Review count[\s\S]*Now: 39[\s\S]*Website: 41/.test(card));
ok('it names the missing towns', /Mukilteo/.test(card) && /Arlington/.test(card));
ok('it names the old headline offer', /old offer/.test(card));
ok('the dead "booking fast" switch is gone', await page.locator('[data-f="content.urgency"]').count() === 0);
await page.click('#factsGo');
await page.waitForFunction(() => /matches your website/.test(document.querySelector('#factsCard').textContent));
ok('one tap, one request', posts.length === 1, posts);
card = await page.innerText('#factsCard');
ok('the card turns into a check mark', /✓ Your booking page matches your website/.test(card));
ok('the price boxes below now show $369', await page.inputValue('[data-svc="full"][data-price="sedan"]') === '369');
ok('the size names below follow the price book', await page.inputValue('[data-size="suv"]') === 'SUV / Pickup');

section('The booking page, even when it can\'t read the settings');
configDown = true;
await page.goto('http://x.test/book.html');
await page.waitForSelector('#serviceList .opt');
let txt = await page.innerText('body');
ok('Full Detail starts at $369', /Full Detail[\s\S]*\$369/.test(txt), txt.slice(0, 400));
ok('Interior $249, Exterior $199', /\$249/.test(txt) && /\$199/.test(txt));
ok('no 3–4 hours anywhere', !/3–4 h/.test(txt));
ok('41 reviews', /41 reviews/.test(txt) && !/39 reviews/.test(txt));
ok('no free-exterior headline', !/\$160 value/.test(txt) && !/free/i.test(await page.innerText('#hookLine')));
ok('no em dash in the page', !/—/.test(BOOK));
ok('no "2 jobs a day" anywhere in it', !/2 jobs a day/.test(BOOK));

section('The live page, after the fix');
configDown = false;
await page.goto('http://x.test/book.html');
await page.waitForSelector('#serviceList .opt');
await page.click('[data-svc="full"]'); await page.click('#nextBtn');
await page.click('[data-size="suv"]');
ok('an SUV Full Detail is $409', /\$409/.test(await page.innerText('#sizeList')));
ok('the sizes say Pickup and 3-row', /SUV \/ Pickup/.test(await page.innerText('#sizeList')) && /Van \/ 3-row/.test(await page.innerText('#sizeList')));
await page.click('#nextBtn');
const adds = await page.innerText('#addonList');
ok('the add-ons are the website\'s', /Carpet Shampoo[\s\S]*\+\$20/.test(adds) && /Exterior Polish[\s\S]*\+\$30/.test(adds) && /RainX Windows[\s\S]*\+\$10/.test(adds), adds);
await page.click('#nextBtn');
await page.click('#dayStrip .day:not(.off) >> nth=1');
await page.waitForSelector('#slotGrid .slot');
await page.click('#slotGrid .slot');
await page.click('#nextBtn');
const sp = await page.innerText('[data-panel="4"]');
ok('the spigot and outlet are a requirement, not "still book"', /outdoor spigot and a power outlet/.test(sp) && !/Still book/.test(sp));
await page.fill('#name', 'Erin Everett'); await page.fill('#phone', '4255550111'); await page.fill('#address', '1 Rucker Ave');
const towns = await page.$$eval('#city option', (o) => o.map((x) => x.textContent));
ok('all twelve towns are in the list', towns.includes('Mukilteo') && towns.includes('Granite Falls') && towns.includes('Arlington'), towns);
await page.selectOption('#city', 'Everett');
await page.click('#nextBtn');
ok('Everett is not told it\'s out of the way', !(await page.isVisible('#reviewDisclaimer')));
ok('the estimate is the price book\'s', /\$409/.test(await page.innerText('#reviewCard')));
await page.click('#backBtn');
await page.selectOption('#city', 'Other / nearby');
await page.click('#nextBtn');
ok('a town outside the twelve is told it\'s a request', /isn't one of the twelve towns/.test(await page.innerText('#reviewDisclaimer')));

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
