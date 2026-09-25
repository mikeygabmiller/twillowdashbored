// The customer page editor, driven the way Mikey drives it: More → Settings →
// "Edit your customer pages", tap a line on the real page, change it, and the
// customer's own page says the new thing.
//
// The dashboard runs in Chromium; everything behind it (config, the preview,
// the customer's page) is the real Worker code on an in-memory store, so a
// pass here means the words he typed are the words a customer gets.
//
//   npm install && node test/pageeditor.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });
const M = new Function('__env__', src + '\n; ENV = __env__; return { apiGetConfig, apiSaveConfig, apiCustPreview, custSubPage, custTokenFor, loadThread, saveThread, updateIndexEntry,' +
  ' loadBookings, saveBookings, apiCustLink, genId, __reset(){ resetInvocationCaches(); BCFG_CACHE = null; } };')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c', DETECT_DISABLED: '1', PUBLIC_BASE_URL: 'https://texting.test' });
store.set('config', JSON.stringify({})); M.__reset();

// A real customer with a real booking, whose page we read back after each edit.
const NOW = Date.now(), DAY = 86400000;
const CUS = '+14255550950';
{
  const t = await M.loadThread(CUS); t.name = 'Cory Ames'; t.messages = [{ id: 'm', dir: 'in', body: 'hi', ts: NOW - DAY }];
  t.garage = { vehicles: [], address: '9 Elm St', city: 'Monroe' }; await M.saveThread(t); await M.updateIndexEntry(t);
  const all = await M.loadBookings();
  all.unshift({ id: M.genId(), phone: CUS, status: 'confirmed', serviceName: 'Full Detail', estimate: 299, date: new Date(NOW + 3 * DAY).toISOString().slice(0, 10),
    slot: '10:00', dateLabel: 'Saturday', apptAt: NOW + 3 * DAY, durationMin: 240 });
  await M.saveBookings(all);
}
const TOK = await M.custTokenFor(CUS);
const custPage = async (kind) => { M.__reset(); return (await M.custSubPage(kind, TOK)).text(); };

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const errs = [], sent = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
const call = async (fn, route) => {
  const res = await fn();
  return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
};
await page.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.host !== 'texting.test') return route.fulfill({ status: 204, body: '' });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/og-car.jpg') return route.fulfill({ path: new URL('../public/og-car.jpg', import.meta.url).pathname });
  if (p === '/api/config' && req.method() === 'GET') { M.__reset(); return call(() => M.apiGetConfig(), route); }
  if (p === '/api/config' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}'); M.__reset();
    return call(() => M.apiSaveConfig({ json: async () => body, method: 'POST', headers: { get: () => '' } }), route);
  }
  if (p === '/api/cust/preview') { M.__reset(); return call(() => M.apiCustPreview(u), route); }
  if (p === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (p === '/api/send') { sent.push(req.postData()); return json({ ok: true }); }
  if (p === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-25', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') return json({ ok: true, date: '2026-09-25', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1200);
const frame = page.frameLocator('#cpeFrame');
const settle = () => page.waitForTimeout(900);
const frameHas = async (sel) => (await frame.locator(sel).count()) > 0;

section('Getting there: More → Settings → Edit your customer pages');
await page.locator('.navitem[data-tab="more"]').click(); await page.waitForTimeout(400);
await page.locator('#mrBody .mr-row', { hasText: 'Settings' }).first().click(); await page.waitForTimeout(600);
ok('Settings has the editor button', await page.locator('#cfgPagesOpen').count() === 1);
ok('the old wall of wording boxes is gone', await page.locator('[data-cp]').count() === 0);
await page.locator('#cfgPagesOpen').click();
await settle();
ok('the editor opens full screen on the before page', await page.locator('#cpEd').isVisible() &&
  await page.locator('#cpeKind [data-k="before"].on').count() === 1);
ok('it shows the real page, lines outlined', await frameHas('[data-ed="prep_pay"]') && await frameHas('#prepCard'));

section('Tap a line, change it, and the customer\'s page says it');
await frame.locator('[data-ed="prep_pay"]').tap();
await page.waitForTimeout(300);
ok('the line\'s box opens with its words in it', await page.locator('#cpeSheet').isVisible() &&
  /^Paying\. After the work/.test(await page.locator('#cpeText').inputValue()));
ok('…telling him the first sentence is the bold heading', /first sentence shows in bold/.test(await page.locator('#cpeSheet').innerText()));
await page.locator('#cpeText').fill('Paying. After the work. Card, cash, check or Zelle.');
await page.locator('#cpeDo').tap();
await settle();
ok('the preview redraws with it', /Card, cash, check or Zelle/.test(await frame.locator('#prepCard').innerText()));
ok('the customer\'s own page says it', /<b>Paying\.<\/b> After the work\. Card, cash, check or Zelle\./.test(await custPage('before')));

await frame.locator('[data-ed="prep_long"]').tap(); await page.waitForTimeout(300);
ok('a line that fills itself in says what fills in', /\{length\} = how long/.test(await page.locator('#cpeSheet').innerText()));
await page.locator('#cpeCancel').tap(); await page.waitForTimeout(200);

section('Hide a line, bring it back');
await frame.locator('[data-ed="prep_water"]').tap(); await page.waitForTimeout(300);
await page.locator('#cpeHide').tap(); await settle();
ok('hidden: gone from the customer\'s page', !/spigot/.test(await custPage('before')));
ok('…but still in the editor, dimmed, to bring back', await frameHas('[data-ed="prep_water"][data-hid]'));
await frame.locator('[data-ed="prep_water"]').tap(); await page.waitForTimeout(300);
ok('its box says it is hidden and offers to show it', /Hidden/.test(await page.locator('#cpeSheet').innerText()) && /Show this/.test(await page.locator('#cpeHide').innerText()));
await page.locator('#cpeHide').tap(); await settle();
ok('shown again', /spigot/.test(await custPage('before')));

section('Put back the original');
await frame.locator('[data-ed="prep_pay"]').tap(); await page.waitForTimeout(300);
await page.locator('#cpeOrig').tap(); await settle();
ok('his original words are back', /Cash, check or Zelle\. No deposit\./.test(await custPage('before')) && !/Card, cash/.test(await custPage('before')));

section('Sections and colour');
await page.locator('#cpeSecs').tap(); await page.waitForTimeout(300);
const rows = await page.locator('#cpeSheet .cpe-row b').allInnerTexts();
ok('the before page\'s three sections, in order', rows.slice(0, 3).join('|') === 'The job card|How it goes|What I need from you', rows);
await page.locator('#cpeSheet [data-up="2"]').tap(); await settle();
let bh = await custPage('before');
ok('moving "What I need from you" up moves it on their page', bh.indexOf('id="prepCard"') < bh.indexOf('How it goes'));
await page.locator('#cpeSheet [data-sh="expect"]').tap(); await settle();
ok('hiding "How it goes" takes it off their page', !/How it goes/.test(await custPage('before')));
await page.locator('#cpeSheet [data-sh="expect"]').tap(); await settle();
ok('…and showing it puts it back', /How it goes/.test(await custPage('before')));
await page.locator('#cpeAccent').fill('#1e90ff'); await settle();
ok('a colour he picks goes on the page', /--red:#1e90ff/.test(await custPage('before')));
await page.locator('#cpeAccOff').tap(); await settle();
ok('"Use the site\'s red" takes it back off', !/--red:#1e90ff/.test(await custPage('before')));
await page.locator('#cpeSheet #cpeCancel').tap(); await page.waitForTimeout(200);

section('The after page, and the text that goes with the link');
await page.locator('#cpeKind [data-k="after"]').tap(); await settle();
ok('it switches to the after page, with the photo choices', await frameHas('[data-ed="review_btn"]') && await page.locator('#cpePics').isVisible());
ok('no review link yet: he is told the button is hidden, and can add it right there', /review button is hidden/.test(await page.locator('#cpeWarn').innerText()));
await page.locator('#cpeReview').fill('https://g.page/r/mikey-review'); await page.locator('#cpeReview').press('Enter');
await page.locator('#cpeReview').dispatchEvent('change'); await settle();
ok('…and once it is in, the warning goes', (await page.locator('#cpeWarn').innerText()).trim() === '');
await page.locator('#cpePics [data-p="one"]').tap(); await settle();
ok('"After only" shows the one-shot version', await frameHas('.ba.one'));
await frame.locator('[data-ed="draft_after"]').tap(); await page.waitForTimeout(300);
ok('the text he sends is editable in the same place', /Text with the after link/.test(await page.locator('#cpeSheet h3').innerText()));
ok('…with no "Hide this" (a text can\'t be hidden)', await page.locator('#cpeHide').count() === 0);
await page.locator('#cpeText').fill('Thanks {first}! Tips for keeping it clean: {link}');
await page.locator('#cpeDo').tap(); await settle();
const dr = (await (await M.apiCustLink({ json: async () => ({ phone: CUS }), method: 'POST', headers: { get: () => '' } })).json()).drafts;
ok('the text he gets in his box is the new one', /^Thanks Cory! Tips for keeping it clean: https:\/\/texting\.test\/after\//.test(dr.after), dr.after);

section('Done closes it; nothing was sent');
await page.locator('#cpeClose').tap(); await page.waitForTimeout(300);
ok('the editor closes', await page.locator('#cpEd').count() === 0);
ok('nothing was texted to anyone', sent.length === 0, sent);
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
