// Rain check, in the app — the forecast read against the jobs on the books.
//
// The feature is only worth having if it reaches him where he already looks and
// if it never, ever texts a customer by itself. So this suite pins down three
// things: the warning is on Home (not only inside a widget he has switched off),
// tapping it lands him in the conversation with the heads-up typed and NOTHING
// sent, and the planner's week says which days already have work on them.
//
// The fourth section is a regression: Home's repaint helper used to call itself
// instead of the renderer, so ticking a to-do blew the stack.
//
//   npm install && node test/rain.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const DRAFT = "Hey Marcus, it's Mikey. Heads up — they're calling for rain Friday around 10:00 AM (85% chance), " +
  "and it's hard to get a finish I'm happy with in the wet. Saturday is looking clear if you'd rather move it — " +
  "otherwise I'll plan on Friday as-is. Just let me know. - Mikey";

const AT_RISK = [{
  id: 'b:2', phone: '+14255559999', name: 'Marcus Webb', date: '2026-09-04', dow: 'Fri',
  slot: '10:00', rainRisk: 85, moveTo: '2026-09-05', moveToLabel: 'Saturday', draft: DRAFT,
}];

const OUTLOOK = {
  today: '2026-09-02', tz: 'America/Los_Angeles', place: 'Snohomish',
  current: { temp: 64, code: 1, desc: 'mostly clear', pop: 5, wind: 6, score: 3 },
  riskAt: 45, atRisk: AT_RISK,
  days: [
    { date: '2026-09-02', dow: 'Today', code: 1, desc: 'mostly clear', pop: 5, wind: 6, hi: 72, lo: 54, score: 3, jobs: [{ id: 'b:1', name: 'Jenna Ruiz', phone: '+14255551212', slot: '09:00', city: 'Everett', service: 'Full Detail', price: 240, pending: false, rainRisk: 0 }], booked: 240, atRisk: 0 },
    { date: '2026-09-03', dow: 'Thu', code: 3, desc: 'overcast', pop: 25, wind: 7, hi: 68, lo: 52, score: 2, jobs: [], booked: 0, atRisk: 0 },
    { date: '2026-09-04', dow: 'Fri', code: 63, desc: 'rain', pop: 85, wind: 9, hi: 61, lo: 50, score: 0, jobs: [{ id: 'b:2', name: 'Marcus Webb', phone: '+14255559999', slot: '10:00', city: 'Lynnwood', service: 'Full Detail', price: 320, pending: false, rainRisk: 85 }], booked: 320, atRisk: 1 },
    { date: '2026-09-05', dow: 'Sat', code: 0, desc: 'clear', pop: 5, wind: 5, hi: 74, lo: 55, score: 3, jobs: [], booked: 0, atRisk: 0 },
  ],
};

const BRIEF = {
  date: '2026-09-02', tz: 'America/Los_Angeles',
  jobs: [{ id: 'b:1', name: 'Jenna Ruiz', slot: '09:00', city: 'Everett', service: 'Full Detail', price: 240, state: 'queued', rainRisk: 0 }],
  summary: { total: 1, done: 0, remaining: 1, booked: 240, earned: 0, hours: 3, stops: 1 },
  weather: { line: '64°F, mostly clear, 5% rain, 6 mph wind', current: {}, daily: {} },
  risky: [], weekRisk: AT_RISK, riskAt: 45,
  waiting: [], counts: { unread: 0, waiting: 0, followups: 0, reminders: 0 },
  money: { yesterday: 0, monthNet: 0, monthGross: 0, monthJobs: 0, owed: 0, openInvoices: 0 },
  priority: 'First stop: Jenna Ruiz at 9:00 AM in Everett.',
};

const rows = [
  { phone: '+14255559999', name: 'Marcus Webb', unread: 0, tags: [], lastBody: 'sounds good', lastDir: 'in', lastTs: now - 90000 },
  { phone: '+14255551212', name: 'Jenna Ruiz', unread: 0, tags: [], lastBody: 'see you then', lastDir: 'in', lastTs: now - 200000 },
];
const THREADS = {
  '+14255559999': { phone: '+14255559999', name: 'Marcus Webb', tags: [], scheduled: [], linked: [], notes: '', messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: now - 90000 }] },
  '+14255551212': { phone: '+14255551212', name: 'Jenna Ruiz', tags: [], scheduled: [], linked: [], notes: '', messages: [{ id: 'm1', dir: 'in', body: 'see you then', ts: now - 200000 }] },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sent = [];          // POST /api/send — must stay empty for the whole run
let outlookCalls = 0;

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (_) { return {}; } };
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = THREADS[want];
    return json(out);
  }
  if (path === '/api/weather/outlook') { outlookCalls++; return json({ ok: true, outlook: OUTLOOK }); }
  if (path === '/api/brief') return json({ ok: true, brief: BRIEF, text: 'brief' });
  if (path === '/api/send') { sent.push(body()); return json({ ok: true }); }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-02', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-02', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(1200);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

section('The warning is on Home, not only inside a widget he switched off');
await page.locator('.navitem[data-tab="home"]').click();
await page.waitForTimeout(700);
const homeText = await page.locator('#scroll').innerText();
ok('the brief card names the rain', /Rain on 1 booked job/.test(homeText), homeText.slice(0, 600));
ok('and names the customer', /Marcus Webb/.test(homeText));
ok('and the day he is booked', /Fri/.test(homeText));
ok('and the odds that made it a problem', /85%/.test(homeText));
ok('it promises nothing goes out on its own', /Nothing sends on its own/.test(homeText));
ok('there is a button to do something about it', await page.locator('[data-wx-text]').count() > 0);
// Home's own card should not be paying for the planner's week — the brief it
// already fetches carries the same list.
ok('Home did not fetch the forecast to draw it', outlookCalls === 0, outlookCalls);

section('Tapping it lands in the conversation with the heads-up typed');
await page.locator('[data-wx-text="+14255559999"]').first().click();
await page.waitForTimeout(900);
ok('a conversation is open', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('it is his conversation', /Marcus Webb/.test(await page.locator('#chatHead').innerText()));
const boxed = await page.locator('#msgInput').inputValue();
ok('the heads-up is waiting in the box', boxed === DRAFT, boxed);
ok('it names the day and the odds', /rain Friday around 10:00 AM \(85% chance\)/.test(boxed));
ok('it offers the clear day', /Saturday is looking clear/.test(boxed));
ok('NOTHING was texted', sent.length === 0, sent);

section("The planner's week says which days already have work on them");
await page.locator('#backBtn').click(); await page.waitForTimeout(250);
await page.locator('.navitem[data-tab="more"]').click(); await page.waitForTimeout(400);
await page.getByText('Weather planner', { exact: true }).first().click();
await page.waitForTimeout(900);
ok('the planner fetched the week', outlookCalls === 1, outlookCalls);
const wxText = await page.locator('#moreApp').innerText();
ok('the day he is booked shows the job', /1 job/.test(wxText), wxText.slice(0, 500));
ok('an empty day says so rather than lying', /—/.test(wxText));
ok('the warning is on this card too', /Rain on 1 booked job/.test(wxText));
const strip = await page.evaluate(() => [...document.querySelectorAll('#moreApp .wx-day')].map((d) => ({ dow: d.querySelector('.wd-d').textContent, risk: d.classList.contains('atrisk'), jobs: d.querySelector('.wd-j').textContent })));
ok('every forecast day is on the strip', strip.length === 4, strip);
ok('exactly one day is ringed', strip.filter((d) => d.risk).length === 1, strip);
ok('and it is Friday', !!strip.find((d) => d.risk && d.dow === 'Fri'), strip);
ok('today carries its job count', strip[0].jobs === '1 job', strip[0]);
ok('a free day carries no count', strip[1].jobs === '—', strip[1]);
ok('still nothing texted', sent.length === 0, sent);

section('Home repaints instead of blowing the stack (regression)');
// homeRepaint() called itself rather than renderHome(), so every caller — the
// to-do checkboxes, the delete button, the promises finishing their load —
// recursed until the stack gave out and the screen never repainted.
await page.locator('#mrBack').click();          // back to the More index
await page.waitForTimeout(400);
await page.getByText('To-do list', { exact: true }).first().click();
await page.waitForTimeout(500);
await page.locator('#tkInput').fill('Restock the drying towels');
await page.locator('#tkAdd').click();
await page.waitForTimeout(400);
ok('the to-do landed', /Restock the drying towels/.test(await page.locator('#moreApp').innerText()));
await page.locator('[data-tk-toggle="0"]').first().click();
await page.waitForTimeout(400);
ok('ticking it repainted', await page.locator('.tk-item.done').count() === 1);
ok('and nothing overflowed the stack', !errs.some((e) => /call stack|Maximum call/i.test(e)), errs);

section('nothing threw');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
