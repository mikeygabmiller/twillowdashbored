// Bookings → Settings → "My start times": Mikey can change his slots, job
// lengths, the lights switch and instant confirm himself, and a save sends
// exactly what he typed (one box per day, "07:00, 13:00").
//
//   node test/slots.ui.test.js
import fs from 'fs';
import { chromium } from 'playwright-core';

const HTML = fs.readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const M = new Function('__env__', src + '\n; ENV = __env__; return { bookingDefaults, bkSanitizeConfig };')({ MESSAGES: { get: async () => null } });
const CFG = JSON.parse(JSON.stringify(M.bookingDefaults()));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
const saved = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/bookings.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/bookings') return json({ ok: true, bookings: [] });
  if (p === '/api/booking-settings') {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      saved.push(body.config);
      return json({ ok: true, config: M.bkSanitizeConfig(body.config) });
    }
    return json({ ok: true, config: CFG });
  }
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://x.test/bookings.html');
await page.click('.mbtn[data-m="settings"]');
await page.waitForSelector('[data-slotday="1"]');

console.log('\nIt shows his week as it ships');
ok('Monday reads 13:00', await page.inputValue('[data-slotday="1"]') === '13:00');
ok('Saturday reads 07:00, 13:00', await page.inputValue('[data-slotday="6"]') === '07:00, 13:00');
ok('Sunday is empty (off)', await page.inputValue('[data-slotday="0"]') === '');
ok('Full Detail is 270 min', await page.inputValue('[data-f="slotRules.jobMin.full"]') === '270');
ok('lights start off', !(await page.isChecked('[data-f="slotRules.lights"]')));
ok('instant confirm starts on', await page.isChecked('[data-f="slotRules.autoConfirm"]'));
ok('the old grid says it is not in charge', /Only used if fixed start times are off/.test(await page.textContent('#settingsView')));

console.log('\nA save sends what he typed');
await page.fill('[data-slotday="3"]', '');
await page.fill('[data-slotday="0"]', '9:00');
await page.fill('[data-f="slotRules.jobMin.full"]', '240');
await page.check('[data-f="slotRules.lights"]');
await page.click('#saveBtn');
await page.waitForFunction(() => /Saved/.test(document.querySelector('#saveStatus').textContent));
const s = saved[0] && saved[0].slotRules;
ok('Wednesday taken off', s && Array.isArray(s.days[3]) && s.days[3].length === 0, s && s.days);
ok('Sunday gets 9:00', s && JSON.stringify(s.days[0]) === '["9:00"]', s && s.days[0]);
ok('Saturday untouched', s && JSON.stringify(s.days[6]) === '["07:00","13:00"]', s && s.days[6]);
ok('Full Detail is now 240', s && s.jobMin.full === 240, s && s.jobMin);
ok('lights on', s && s.lights === true);
ok('it re-renders from the cleaned config (9:00 → 09:00)', await page.inputValue('[data-slotday="0"]') === '09:00');
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
