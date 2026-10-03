// The Clean Club from Mikey's side (2026-10-03). Someone who hasn't joined gets
// "Send the Clean Club page" in Tools, which writes the call page link (their
// name, car and town on it) into the box. Someone who joined on that page gets
// their club sheet: did the card save, how many club visits they've kept, what
// they'd owe if they left, the words they signed, and his buttons for the day
// they cancel. The /api/club calls are answered by the REAL worker code, lifted
// out of src/index.js, so the sheet and the server agree on shape.
//
// The one thing this suite exists to catch: nothing here sends a text or
// charges a card. Every text goes in the box for him to read and send.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function lift(name) {
  const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found`);
  let p = SRC.indexOf('(', m.index), pd = 0, b = -1;
  for (let j = p; j < SRC.length; j++) { if (SRC[j] === '(') pd++; else if (SRC[j] === ')') { pd--; if (!pd) { b = SRC.indexOf('{', j); break; } } }
  let d = 0;
  for (let j = b; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) return SRC.slice(m.index, j + 1); } }
  throw new Error('end of ' + name);
}
const constant = (decl) => SRC.match(new RegExp(`^const ${decl}[^\\n]*$`, 'm'))[0];

const STORE = new Map(), MONTHS = {}, THREADS = {};
const ENV = { STRIPE_SECRET_KEY: '' };
const ctx = {
  ENV,
  kv: () => ({ async get(k, o) { const v = STORE.get(k); return v == null ? null : o && o.type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { STORE.set(k, v); } }),
  json: (o, status) => ({ __json: o, status: status || 200 }),
  readJson: async (r) => r.__body,
  loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
  localDateStr: (ts, z) => new Date(ts).toLocaleDateString('en-CA', { timeZone: z || 'America/Los_Angeles' }),
  loadMonth: async (m) => (MONTHS[m] = MONTHS[m] || { entries: [] }),
  loadBookings: async () => JSON.parse(STORE.get('bk:index') || '[]'),
  loadThread: async (p) => THREADS[p],
  saveThread: async () => {},
  updateIndexEntry: async () => {},
  jdMoney: (n) => Math.round((Number(n) || 0) * 100) / 100,
  jdStr: (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200),
  normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; },
};
const C = new Function(...Object.keys(ctx), [
  constant('CLUB_KEY'), constant('CLUB_SITES'), constant('CLUB_PAGE'), constant('PLAN_EVERY'),
  ...['clubLink', 'clubStripeLink', 'clubBrand', 'clubCardPublic', 'clubStanding', 'clubAdmin', 'apiClubList', 'apiClubAction',
    'loadClub', 'saveClub', 'stripeOn', 'sanitizePlan', 'prevMonthKey'].map(lift),
].join('\n\n') + '\nreturn { apiClubList, apiClubAction };')(...Object.values(ctx));

const DAY = 86400000, now = Date.now();
const d10 = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const firstDate = d10(now + 5 * DAY);
const member = {
  id: 'c1', token: 'TOK1abcdefghijklmnopqrstuvwxyz12', site: 'https://mikeysdetailing.com', createdAt: now - DAY, status: 'active',
  name: 'Sarah Lane', phone: '+14255550142', email: '', city: 'Everett',
  every: 28, size: 'sedan', sizeLabel: 'Car / Sedan', vehicle: '2017 Honda Civic', condition: 'Pretty Clean',
  regular: 369, price: 219, off: 150, visit: 125, keep: 2, per: 75,
  bookingId: 'b1', date: firstDate, slot: '13:00', dateLabel: 'Thu, Oct 8', apptAt: now + 5 * DAY, rainReady: true, instant: true,
  terms: { v: '2026-10-03', signed: 'Sarah Lane', at: now - DAY, ip: '9.9.9.9', ua: 'x', page: '',
    lines: ['Your first visit is a Full Detail for $219.', 'Line two', 'Line three', 'Line four', 'Line five', 'Line six', 'Line seven'] },
  card: { status: 'off' }, kept: null,
};
STORE.set('club:index', JSON.stringify([member]));
STORE.set('bk:index', JSON.stringify([{ id: 'b1', phone: '+14255550142', status: 'confirmed', date: firstDate, slot: '13:00', service: 'full' }]));

THREADS['+14255550142'] = {
  phone: '+14255550142', name: 'Sarah Lane', tags: ['club', 'booking'], status: 'won', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'Thanks Mikey, see you Thursday', ts: now - 60000 }],
  scheduled: [], linked: [], notes: '', club: { token: member.token, at: now - DAY },
  plan: { every: 28, service: 'Clean Club', price: 125, startedAt: now - DAY },
};
THREADS['+14255550199'] = {
  phone: '+14255550199', name: 'Bob Stone', tags: [], status: 'new', unread: 0,
  messages: [{ id: 'm2', dir: 'in', body: 'How much for a full detail on my truck?', ts: now - 120000 }],
  scheduled: [], linked: [], notes: '',
  garage: { vehicles: [{ year: '2018', color: 'Silver', make: 'Ford', model: 'F-150' }], city: 'Monroe' },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [], acts = [], sends = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
page.on('popup', (p) => p.close().catch(() => {}));
const opened = [];
await page.exposeFunction('__opened', (u) => opened.push(u));
await page.addInitScript(() => { window.open = (u) => { window.__opened(String(u)); return null; }; });
page.on('dialog', (d) => d.accept());

await page.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname; const method = route.request().method();
  const json = (o, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/club/action' && method === 'POST') {
    const b = JSON.parse(route.request().postData() || '{}'); acts.push(b);
    const r = await C.apiClubAction({ __body: b }); return json(r.__json, r.status);
  }
  if (p === '/api/club') { const r = await C.apiClubList(u); return json(r.__json, r.status); }
  if (/^\/api\/(send|schedule|pay\/request|club\/card|club\/join)$/.test(p)) { sends.push(p); return json({ ok: true }); }
  if (p === '/api/threads') {
    const rows = Object.values(THREADS).map((t) => ({ phone: t.phone, name: t.name, status: t.status, unread: 0,
      lastBody: t.messages[0].body, lastTs: t.messages[0].ts, tags: t.tags, plan: t.plan || null }));
    const out = { ok: true, threads: rows, config: {} };
    if (u.searchParams.get('phone')) out.thread = THREADS[u.searchParams.get('phone')];
    return json(out);
  }
  if (p === '/api/thread') return json({ ok: true, thread: THREADS[u.searchParams.get('phone')] });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p === '/api/day') return json({ ok: true, date: d10(now), jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const shot = async (n) => { if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/' + n + '.png' }); };
const sheet = () => page.locator('#jdSheet');
const open = async (name) => {
  // Inside a conversation the phone layout hides the nav, so back out first.
  const tsh = page.locator('#toolsSheet');
  if (await tsh.isVisible().catch(() => false)) await page.locator('#toolsBtn').click();
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(300);
  }
  await page.locator('.navitem[data-tab="messages"]').click();
  await page.waitForTimeout(400);
  await page.locator('.conv', { hasText: name }).first().click();
  await page.waitForTimeout(900);
};
const tools = async () => { await page.locator('#toolsBtn').click(); await page.waitForTimeout(400); return page.locator('#toolsSheet').innerText(); };
const box = () => page.locator('#msgInput').inputValue();
const clearBox = () => page.locator('#msgInput').fill('');
const clubOpen = async () => { await tools(); await page.locator('#toolsSheet [data-act="club"]').click(); await page.waitForTimeout(600); return sheet().innerText(); };
const closeSheet = async () => { await page.locator('#jdScrim').click({ position: { x: 200, y: 20 } }); await page.waitForTimeout(400); };

section('Someone who hasn\'t joined: the call page, with their name on it, in the box');
await open('Bob Stone');
let tt = await tools();
ok('Tools offers "Send the Clean Club page"', /Send the Clean Club page/.test(tt), tt);
ok('...and not a club sheet, because Bob never joined', !/Their sign-up, the saved card/.test(tt));
await page.locator('#toolsSheet [data-act="clubpage"]').click();
await page.waitForTimeout(400);
let b = await box();
ok('the link goes in the box with his first name, truck and town', b === "Here's the page I'm walking you through: https://mikeysdetailing.com/onbored/?n=Bob&car=2018%20Silver%20Ford%20F-150&t=Monroe", b);
ok('no em dash in it', !/—/.test(b));
await shot('1-bob-link');
await clearBox();

section('A member: their club sheet');
await open('Sarah Lane');
tt = await tools();
ok('Tools offers "Clean Club"', /Clean Club/.test(tt) && /Their sign-up, the saved card/.test(tt), tt);
ok('...instead of sending the page again', !/Send the Clean Club page/.test(tt));
await page.locator('#toolsSheet [data-act="club"]').click();
await page.waitForTimeout(700);
let s = await sheet().innerText();
ok('it is Sarah\'s, every 4 weeks at $125', /Clean Club: Sarah/.test(s) && /Every 4 weeks, \$125 a visit/.test(s), s.slice(0, 300));
ok('no card yet, and it says why: Stripe isn\'t connected', /No card yet/.test(s) && /Stripe isn't connected/.test(s), s);
ok('the first visit and its price, against the regular one', /Full Detail \$219 \(regular \$369\) on Thu, Oct 8/.test(s), s);
ok('before the first visit, leaving costs nothing', /If they left today\s*Nothing/i.test(s) && /Nothing is owed before the first visit/.test(s), s);
ok('it offers their card link for the box', await sheet().locator('#clubCardPut').count() === 1);
ok('what they signed is there, folded away until he opens it', /What they signed/.test(s) && await sheet().locator('details.club-terms:not([open])').count() === 1);
await sheet().locator('.club-terms summary').click();
await page.waitForTimeout(150);
const terms = await sheet().locator('.club-terms').innerText();
ok('opened, it lists all seven lines and the signature', (terms.match(/Line|Your first visit/g) || []).length === 7 && /Signed “Sarah Lane”/.test(terms) && /9\.9\.9\.9/.test(terms), terms);
await shot('2-sheet');
await sheet().locator('#clubCardPut').click();
await page.waitForTimeout(400);
b = await box();
ok('"Card link in the box" writes their own link, nothing sent', b === "Here's the secure link to save your card for the Clean Club, like we talked about: https://mikeysdetailing.com/onbored/?club=" + member.token, b);
await clearBox();

section('After the first visit: what they\'d owe, and his count beats the records');
{ const all = JSON.parse(STORE.get('bk:index')); all[0].status = 'done'; STORE.set('bk:index', JSON.stringify(all)); }
s = await clubOpen();
ok('first visit done, no club visits yet: $150', /If they left today\s*\$150/.test(s) && /\$75 for each of the 2 club visits/.test(s), s);
await sheet().locator('[data-club-kept="1"]').click();
await page.waitForTimeout(500);
s = await sheet().innerText();
ok('tapping + saves his count: 1 of 2', acts.at(-1).action === 'kept' && acts.at(-1).kept === 1 && /1 of 2/.test(s), acts.at(-1));
ok('...and the payback drops to $75', /If they left today\s*\$75/.test(s), s);
ok('it says it\'s his count now, with a way back to the records', /Your count/.test(s) && await sheet().locator('#clubKeptAuto').count() === 1);
await shot('3-kept');

section('The day they cancel');
await sheet().locator('#clubCancel').click();
await page.waitForTimeout(600);
s = await sheet().innerText();
ok('marked cancelled, with what they owed written down', acts.at(-1).action === 'cancel' && /Cancelled/.test(s) && /They owed when they left\s*\$75/.test(s), s);
ok('it offers the heads-up text and "I charged it", not a charge button', await sheet().locator('#clubOweText').count() === 1 && await sheet().locator('#clubPaid').count() === 1);
ok('the visit count is locked once they\'ve left', await sheet().locator('[data-club-kept]').count() === 0 && /Club visits since their first one: 1 of 2/.test(s), s);
ok('...and it says what they skipped, in the past tense', /\$75 for each club visit they skipped/.test(s) && !/they'd skip/.test(s), s);
await sheet().locator('#clubOweText').click();
await page.waitForTimeout(400);
b = await box();
ok('the heads-up text says how many visits, the amount, and that they agreed', /^Hey Sarah, sorry to see you go\. We did 1 of the 2 club visits, so like we agreed when you joined I'll put \$75 on the card you saved\./.test(b), b);
ok('no em dash in it', !/—/.test(b));
await clearBox();
s = await clubOpen();
await sheet().locator('#clubPaid').click();
await page.waitForTimeout(500);
s = await sheet().innerText();
ok('"I charged it" marks it charged', acts.at(-1).action === 'paid' && /Charged/.test(s), s);
ok('...and stops telling him to charge it', !/charge it in Stripe/.test(s) && await sheet().locator('#clubPaid').count() === 0, s);
await shot('4-charged');
await sheet().locator('#clubReopen').click();
await page.waitForTimeout(500);
s = await sheet().innerText();
ok('Undo cancel puts them back', acts.at(-1).action === 'reopen' && !/Cancelled/.test(s) && await sheet().locator('#clubCancel').count() === 1, s);
ok('...back on their 4-week plan', THREADS['+14255550142'].plan && THREADS['+14255550142'].plan.every === 28);
await closeSheet();

section('With Stripe connected and the card saved');
ENV.STRIPE_SECRET_KEY = 'rk_live_x';
{ const all = JSON.parse(STORE.get('club:index'));
  all[0].card = { status: 'saved', customer: 'cus_9', brand: 'visa', last4: '4242', at: now - DAY, pm: 'pm_9' };
  STORE.set('club:index', JSON.stringify(all)); }
s = await clubOpen();
ok('it shows the card by brand and last four', /Visa ending 4242/.test(s), s);
ok('no card link to send, they already saved one', await sheet().locator('#clubCardPut').count() === 0);
await sheet().locator('#clubStripe').click();
await page.waitForTimeout(300);
ok('"Open in Stripe" opens their customer page', opened.at(-1) === 'https://dashboard.stripe.com/customers/cus_9', opened);
await shot('5-saved');

section('Nothing was ever sent or charged');
ok('no text, no schedule, no payment request, no card call', sends.length === 0, sends);
ok('no page errors', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
