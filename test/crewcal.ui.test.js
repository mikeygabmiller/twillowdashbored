// Bookings → Settings → "JP's calendar": he pastes the calendar id, copies the
// script with his key and that id in it, connects, and puts the jobs he
// already has on it. The steps have to say "untick Make available to public"
// and "See all event details", because those are the two settings that decide
// whether customers' addresses leak and whether JP sees anything at all.
//
//   node test/crewcal.ui.test.js
import fs from 'fs';
import { chromium } from 'playwright-core';

const HTML = fs.readFileSync(new URL('../public/bookings.html', import.meta.url), 'utf8');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const M = new Function('__env__', src + '\n; ENV = __env__; return { bookingDefaults };')({ MESSAGES: { get: async () => null } });
const CFG = JSON.parse(JSON.stringify(M.bookingDefaults()));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
const page = await ctx.newPage();
await page.addInitScript(() => { window.__copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
const CAL = 'abc123@group.calendar.google.com';
let st = { calId: '', url: '', connected: false };
const posts = [];
let syncFrom = [];
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname; const m = route.request().method();
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const view = () => ({ ok: true, who: 'JP', connected: st.connected, url: st.url, calId: st.calId, calendar: st.connected ? 'WORK' : '', owned: true,
    script: st.calId ? `var KEY = 'k123';\nvar CAL = '${st.calId}';\nfunction doPost(e){}` : '' });
  if (p === '/bookings.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/bookings') return json({ ok: true, bookings: [] });
  if (p === '/api/booking-settings') return json({ ok: true, config: CFG });
  if (p === '/api/gcal-setup') return json({ ok: true, connected: false, url: '', script: "var KEY = 'abc';" });
  if (p === '/api/gcal-crew' && m === 'GET') return json(view());
  if (p === '/api/gcal-crew') {
    const b = JSON.parse(route.request().postData() || '{}'); posts.push(b);
    if (b.calId !== undefined) {
      if (!/@/.test(b.calId)) return json({ ok: false, error: 'That isn\'t a calendar ID.' });
      st = { calId: b.calId.trim(), url: '', connected: false }; return json(view());
    }
    if (/public/.test(b.url)) return json({ ok: false, error: 'The calendar is public, so anyone online could read the customer\'s name, address and phone.' });
    st.url = b.url; st.connected = true; return json(view());
  }
  if (p === '/api/gcal-crew-sync-all') {
    const b = JSON.parse(route.request().postData() || '{}'); syncFrom.push(b.from);
    return json(b.from ? { ok: true, added: 3, updated: 0, failed: 0, more: 0, next: 0 } : { ok: true, added: 40, updated: 1, failed: 0, more: 3, next: 40 });
  }
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('http://x.test/bookings.html');
await page.click('.mbtn[data-m="settings"]');
await page.waitForSelector('#crewSave');

console.log('\nIt says what goes on it, and the settings that matter');
const box = await page.textContent('#crewSec');
ok('the section is named for his helper', /JP's calendar/.test(box), box.slice(0, 80));
ok('confirmed jobs only, and what JP gets', /Confirmed jobs/.test(box) && /customer's phone/.test(box) && /Not the price/.test(box));
ok('it promises an alert for each one', /alert every time/.test(box));
ok('step one switches the calendar off public', /untick Make available to public/.test(box));
ok('and shares it so JP sees the details', /See all event details/.test(box));
ok('the script is deployed from the account that made the calendar', /account that made this calendar/.test(box));
ok('it says not connected', /Not connected yet/.test(await page.textContent('#crewState')));
ok('no script to copy before there is a calendar', !(await page.isVisible('#crewCopy')));
ok('no catch-up button before it is connected', !(await page.isVisible('#crewSync')));
ok('JP is told reminders are his own to set', /Event notifications/.test(box));

console.log('\nCalendar, script, connect, catch up');
await page.fill('#crewCal', 'not an id');
await page.click('#crewSave');
await page.waitForFunction(() => /✕/.test(document.querySelector('#crewResult').textContent));
ok('a wrong id gets the reason in words', /calendar ID/.test(await page.textContent('#crewResult')));
await page.fill('#crewCal', CAL);
await page.click('#crewSave');
await page.waitForFunction(() => /Saved/.test(document.querySelector('#crewResult').textContent));
ok('saving shows the copy button', await page.isVisible('#crewCopy'));
await page.click('#crewCopy');
await page.waitForFunction(() => /Copied/.test(document.querySelector('#crewCopied').textContent));
const copied = await page.evaluate(() => window.__copied);
ok('the script on the clipboard has the key and this calendar', /var KEY = 'k123'/.test(copied) && copied.includes(`var CAL = '${CAL}'`), copied);

await page.fill('#crewUrl', 'https://script.google.com/macros/s/public/exec');
await page.click('#crewConnect');
await page.waitForFunction(() => /✕/.test(document.querySelector('#crewResult').textContent));
ok('a public calendar is refused, and it says why', /public/.test(await page.textContent('#crewResult')));
ok('still no catch-up button', !(await page.isVisible('#crewSync')));
await page.fill('#crewUrl', 'https://script.google.com/macros/s/AKfy/exec');
await page.click('#crewConnect');
await page.waitForFunction(() => /Connected to/.test(document.querySelector('#crewResult').textContent));
ok('connect names the calendar', /WORK/.test(await page.textContent('#crewResult')));
ok('the state line turns green', /✓ Connected to WORK/.test(await page.textContent('#crewState')));
ok('the catch-up button shows', await page.isVisible('#crewSync'));

await page.click('#crewSync');
await page.waitForFunction(() => /added/.test(document.querySelector('#crewResult').textContent));
let t = await page.textContent('#crewResult');
ok('it says how many went on, and that there are more', /40 jobs added, 1 already there\. 3 more further out: tap again/.test(t), t);
await page.click('#crewSync');
await page.waitForFunction(() => /3 jobs added/.test(document.querySelector('#crewResult').textContent));
ok('the second tap carries on where the first stopped', JSON.stringify(syncFrom) === '[0,40]', syncFrom);
t = await page.textContent('#crewResult');
ok('and reads plainly when it is done', /^✓ 3 jobs added$/.test(t), t);
ok('his own calendar section is still there', await page.isVisible('#gcalCopy'));
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
