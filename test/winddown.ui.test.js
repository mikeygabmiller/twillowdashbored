// "That's the day" — the wind-down card on Home.
//
// This is the one card in the app whose job is to say that nothing needs him,
// so the things worth pinning are the ways it could lie:
//
//   1. It must never appear while there is still a stop to make. It shares a
//      slot with the next-stop card, and two cards both claiming to own the
//      day would be worse than the blank space this replaces.
//   2. "Nobody is waiting on you" has to mean it. Follow-up nudges and rebook
//      suggestions are the app's own ideas and deliberately don't count — but
//      a customer who actually said something and hasn't been answered must
//      break that sentence, by name.
//   3. Tomorrow costs a second /api/day. A normal working day must not pay it.
//
// Driven in a real browser because all three are about what Home renders after
// two async fetches land in whatever order they land in.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const dstr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = dstr(new Date());
const TOMORROW = dstr(new Date(Date.now() + 86400000));
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };

const row = (over) => Object.assign({
  phone: '+14255551234', name: 'Jenna Smith', status: 'active', unread: 0,
  lastBody: 'sounds good', lastDir: 'out', lastTs: Date.now() - 3600000, tags: [],
}, over);

const job = (over) => Object.assign({
  id: 'b:1', source: 'booking', name: 'Sam Reed', phone: '+14255559090',
  address: '12 Pine St', city: 'Monroe', service: 'Full detail', vehicle: 'Tahoe',
  slot: '09:00', at: at(9, 0), durationMin: 150, price: 260, notes: '',
  state: 'queued', enrouteAt: 0, startedAt: 0, doneAt: 0, gate: '', parking: '',
  water: null, power: null, addressGuess: '', mapQuery: '12 Pine St, Monroe, WA',
}, over);

const day = (date, jobs, earned) => ({
  ok: true, date, jobs, tz: 'America/Los_Angeles', services: [],
  summary: {
    total: jobs.length, done: jobs.filter((j) => j.state === 'done').length,
    remaining: jobs.filter((j) => j.state !== 'done' && j.state !== 'skipped').length,
    booked: jobs.reduce((s, j) => s + (j.price || 0), 0), earned: earned || 0,
    hours: 2.5, stops: jobs.length,
  },
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];

// today / tomorrow are the two day-boards this card reads; `hits` counts the
// calls so the "a working day never fetches tomorrow" claim is testable.
async function openHome({ threads = [], today, tomorrow }) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  const hits = { day: [] };
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const path = u.pathname;
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (path === '/api/threads') return json({ ok: true, threads, config: {} });
    if (path === '/api/day') {
      const d = u.searchParams.get('date') || TODAY;
      hits.day.push(d);
      return json(d === TOMORROW ? tomorrow : today);
    }
    if (path === '/api/money') return json({ ok: true, month: '', today: TODAY, entries: [], nudges: [], owed: [], summary: { net: 0, gross: 0, costs: 0, jobs: 0 }, config: {} });
    if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
    if (path === '/api/version') return json({ ok: true, build: 'test' });
    if (path.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto('https://texting.test/');
  await page.waitForTimeout(1200);
  return { page, hits };
}
const cardText = (page) => page.locator('.done-card').first().textContent();

section('While there is still a stop to make, this card stays out of the way');
{
  const { page, hits } = await openHome({
    today: day(TODAY, [job(), job({ id: 'b:2', name: 'Dana Cruz', slot: '13:00', state: 'done', doneAt: at(12, 40) })], 260),
    tomorrow: day(TOMORROW, [job({ id: 'b:9' })], 0),
  });
  ok('the next-stop card owns the slot', (await page.locator('.next-card').count()) === 1);
  ok('the wind-down is not rendered', (await page.locator('.done-card').count()) === 0);
  ok('and tomorrow is never fetched on a working day', hits.day.every((d) => d !== TOMORROW), hits.day);
  await page.close();
}

section('When the board is finished, it says so and adds the day up');
{
  const { page } = await openHome({
    threads: [row()],
    today: day(TODAY, [
      job({ id: 'b:1', state: 'done', startedAt: at(9, 12), doneAt: at(11, 30), price: 260 }),
      job({ id: 'b:2', name: 'Dana Cruz', slot: '13:00', state: 'done', startedAt: at(13, 5), doneAt: at(16, 40), price: 280 }),
    ], 540),
    tomorrow: day(TOMORROW, [job({ id: 'b:9', name: 'Ruth Alvarez', slot: '09:30', city: 'Lake Stevens' })], 0),
  });
  const txt = await cardText(page);
  ok('the wind-down replaces the next-stop card', (await page.locator('.done-card').count()) === 1 && (await page.locator('.next-card').count()) === 0);
  ok('it names the day', /That's the day/.test(txt), txt);
  ok('it counts the stops he actually finished', /2 stops, finished/.test(txt), txt);
  ok('it says what the day came to', /\$540 in/.test(txt), txt);
  ok('and when he started and finished', /9:12/.test(txt) && /4:40/.test(txt), txt);
  ok('nobody waiting is said out loud', /Nobody is waiting on you/.test(txt), txt);
  ok('tomorrow is named, with its first stop', /Tomorrow: 1 stop, starting 9:30 AM with Ruth Alvarez in Lake Stevens/.test(txt), txt);
  await page.close();
}

section('One customer still waiting breaks the quiet — by name, and openable');
{
  const { page } = await openHome({
    threads: [
      row({ lastDir: 'in', lastBody: 'is Saturday still ok?' }),
      row({ phone: '+14255557777', name: 'Omar Diaz', lastDir: 'in', lastBody: 'how much for a truck' }),
      row({ phone: '+14255556666', name: 'Cold Lead', lastDir: 'out', followupDue: true, fu: { reason: 'Nudge ready', urgency: 'low' } }),
    ],
    today: day(TODAY, [job({ state: 'done', startedAt: at(10, 0), doneAt: at(12, 0) })], 260),
    tomorrow: day(TOMORROW, [], 0),
  });
  const txt = await cardText(page);
  ok('the first person waiting is named', /Jenna Smith/.test(txt), txt);
  ok('the rest are counted, not listed', /and 1 other\b/.test(txt), txt);
  ok('a follow-up suggestion is not counted as somebody waiting', !/2 others/.test(txt), txt);
  ok('the rest is still allowed to wait', /Everything else can keep till morning/.test(txt), txt);
  ok('an empty tomorrow is said plainly', /Tomorrow is clear/.test(txt), txt);
  await page.locator('.done-card .dn-quiet').click();
  await page.waitForTimeout(600);
  ok('tapping it opens that conversation', await page.evaluate(() => document.body.classList.contains('viewing')));
  await page.close();
}

section('A day with nothing on the board points at tomorrow instead');
{
  const { page } = await openHome({
    today: day(TODAY, [], 0),
    tomorrow: day(TOMORROW, [job({ id: 'b:9', name: 'Ruth Alvarez', slot: '08:00', city: 'Snohomish' })], 0),
  });
  const txt = await cardText(page);
  ok('it does not pretend a day happened', !/finished/.test(txt), txt);
  ok('it says the board was empty', /Nothing on the board today/.test(txt), txt);
  ok('and where tomorrow starts', /Ruth Alvarez, tomorrow at 8:00 AM/.test(txt), txt);
  ok('with the city, so he knows how far', /Snohomish/.test(txt), txt);

  // The one new control: tomorrow's board, on tomorrow's date — not today's.
  await page.locator('.done-card [data-wd-tom]').click();
  await page.waitForTimeout(700);
  ok('the Tomorrow button opens the run board', await page.locator('#jdApp').evaluate((e) => e.classList.contains('show')));
  // The board's own subtitle is the honest check: it renders JD.date, so it
  // reads "Tomorrow" only if the button actually moved the board off today.
  const sub = await page.locator('#jdSub').textContent();
  ok('on tomorrow, not today', /Tomorrow/.test(sub), sub);
  await page.close();
}

section('Nothing today and nothing tomorrow is not an occasion for a card');
{
  const { page } = await openHome({ today: day(TODAY, [], 0), tomorrow: day(TOMORROW, [], 0) });
  ok('Home is left exactly as it was', (await page.locator('.done-card').count()) === 0);
  ok('and so is the next-stop slot', (await page.locator('.next-card').count()) === 0);
  await page.close();
}

section('No console or page errors along the way');
ok('clean run', errs.length === 0, errs.slice(0, 4));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
