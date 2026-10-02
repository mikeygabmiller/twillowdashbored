// The Rain-Ready season card at the top of Bookings, on screen. Runs the real
// worker behind the page. What has to hold:
//   · it says how many Full Detail times are left before Jan 31, month by month,
//     and how many Rain-Ready Full Details are already booked
//   · with the lights off it says what the lights would add and where the
//     switch is; with them on it doesn't
//   · when the times left get close to what's owed, it says so
//   · if it can't count (endpoint down, start times off, season over) it is
//     simply not there, and the bookings list still loads
//
//   node test/capacity.ui.test.js
import fs from 'fs';
import { chromium } from 'playwright-core';

const PAGE = fs.readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); return v === undefined ? null : (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const M = new Function('__env__', src + '\n; ENV = __env__; return { apiBookingCapacity, bookingDefaults, __reset(){ resetInvocationCaches(); } };')({ MESSAGES: kv });
const reset = () => { store.clear(); try { M.__reset(); } catch (e) {} };

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];
let capMode = 'real', capCalls = 0, fake = null;

async function open(init) {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('dialog', (d) => d.dismiss());
  if (init) await page.addInitScript(init);
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname;
    if (p === '/bookings.html') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (p === '/api/bookings') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"bookings":[]}' });
    if (p === '/api/booking-capacity') {
      capCalls++;
      if (capMode === 'down') return route.fulfill({ status: 503, body: '' });
      if (capMode === 'fake') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) });
      const r = await M.apiBookingCapacity(u);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://x.test/bookings.html');
  await page.waitForSelector('#list .msg, #list .bk, #list .empty, #list > div:not(.spin)', { timeout: 8000 }).catch(() => {});
  return page;
}
const settle = (page) => page.waitForFunction(() => document.querySelector('#capCard').innerHTML !== '' || window.__capDone, null, { timeout: 8000 }).catch(() => {});

section('An empty season, lights off');
reset();
let page = await open();
await settle(page);
let card = await page.innerText('#capCard');
ok('it says how many Full Detail times are left before Jan 31', /^\d+\s*Full Detail times left before Jan 31/m.test(card), card);
ok('none booked yet', /0 Rain-Ready booked/.test(card));
ok('a chip for each month through January', ['Oct', 'Nov', 'Dec', 'Jan'].every((m) => card.includes(m)), card);
const chips = await page.$$eval('.cap-m', (els) => els.map((e) => e.textContent));
const nov = chips.find((t) => t.startsWith('Nov')), dec = chips.find((t) => t.startsWith('Dec'));
ok('November and December each show a handful at most', +nov.slice(3) <= 5 && +dec.slice(3) <= 5, chips);
ok('the lights note gives the bigger number and where the switch is', /With work lights it's \d+/.test(card) && /My start times/.test(card), card);
ok('the number with lights is bigger', +card.match(/With work lights it's (\d+)/)[1] > +card.match(/^(\d+)/m)[1]);
ok('not tight with an empty calendar', !(await page.$('.cap.tight')));
ok('no em dash in the card', !/—/.test(card));
ok('it fits a phone without scrolling sideways', await page.$eval('#capCard', (e) => e.scrollWidth <= e.clientWidth + 1));
ok('the bookings tabs are still right under it', await page.isVisible('.tabs'));
await page.close();

section('Lights on');
reset();
const lit = M.bookingDefaults(); lit.slotRules.lights = true;
store.set('bk:config', JSON.stringify(lit));
page = await open(); await settle(page);
card = await page.innerText('#capCard');
ok('still counts', /Full Detail times left/.test(card), card);
ok('no lights note', !/work lights/.test(card));
await page.close();

section('Running short');
capMode = 'fake';
fake = { ok: true, on: true, bookBy: '2026-12-31', service: 'full', through: '2027-01-31', lights: false, open: 3, openLit: 61,
  months: [{ m: '2026-10', open: 0, openLit: 0 }, { m: '2026-11', open: 1, openLit: 20 }, { m: '2026-12', open: 0, openLit: 21 }, { m: '2027-01', open: 2, openLit: 20 }],
  rrBooked: 7, rrUpcoming: 5 };
page = await open(); await settle(page);
card = await page.innerText('#capCard');
ok('the card turns amber', !!(await page.$('.cap.tight')));
ok('it says what to do about it', /say so before taking more/.test(card) && /late-January/.test(card), card);
ok('a month with nothing left is marked', (await page.$$('.cap-m.zero')).length === 2);
ok('7 Rain-Ready booked', /7 Rain-Ready booked/.test(card));
await page.close();
fake = Object.assign({}, fake, { open: 1, months: [{ m: '2027-01', open: 1, openLit: 1 }] });
page = await open(); await settle(page);
ok('one time left reads "time", not "times"', /1\s*Full Detail time left/.test(await page.innerText('#capCard')));
await page.close();

section('When it has nothing to say');
capMode = 'down';
page = await open();
await page.waitForTimeout(400);
ok('endpoint down: no card', (await page.innerHTML('#capCard')) === '');
ok('and the bookings list still loads', !(await page.$('#list .spin')));
await page.close();
capMode = 'fake'; fake = { ok: true, on: false };
page = await open(); await page.waitForTimeout(400);
ok('start times switched off: no card', (await page.innerHTML('#capCard')) === '');
await page.close();
capMode = 'real'; capCalls = 0;
page = await open(() => { const t = Date.parse('2027-02-02T18:00:00Z'), D = Date; Date.now = () => t; });
await page.waitForTimeout(400);
ok('after the season: no card', (await page.innerHTML('#capCard')) === '');
ok('and it doesn\'t even ask', capCalls === 0, capCalls);
await page.close();

ok('no page errors', errs.length === 0, errs);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
