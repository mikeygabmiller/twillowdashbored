// Train AI → "Check the quote text", driven the way he'd drive it.
//
// The screen exists to answer one question — "is this good enough to switch on?"
// — so the tests that earn their keep are: it shows what sends TODAY next to what
// the AI would write, it shows a blocked draft AS blocked rather than quietly
// hiding it, his rewrite goes back as a correction, and nothing anywhere on it
// sends a text or flips a switch.
//
//   npm install && node test/preview.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

let config = { followupsEnabled: true };

// Three cards covering the three things he needs to see: a clean draft, a draft
// the gate refused, and a submission where the reworded opener changes the text.
const CARDS = [
  {
    id: 'q1', ts: now - 3600000, name: 'Ruth Callahan',
    summary: '2014 Honda CR-V · $280 · Full Interior',
    notes: 'any chance you could do Saturday? car is pretty rough inside',
    appointment: '', bucket: 'price',
    live: "Hey Ruth, it's Mikey. I got your quote for the 2014 Honda CR-V - $280. I saw you were hoping for Saturday - let me check what I've got open. Is morning or afternoon better for you?",
    plain: "Hey Ruth, it's Mikey. I got your quote for the 2014 Honda CR-V - $280. I saw you were hoping for Saturday - let me check what I've got open. Is morning or afternoon better for you?",
    alt: '', altCap: '',
    smart: "Hey Ruth, it's Mikey. Got your quote for the CR-V at $280, and I saw you asked about Saturday - rough inside is no problem, that's what the full interior is for. Let me check my book: is morning or afternoon better?",
    fault: '', refused: false, error: '',
  },
  {
    id: 'q2', ts: now - 7200000, name: 'Dale Hobart',
    summary: '2019 Toyota Tacoma · $349', notes: '', appointment: '', bucket: 'price',
    live: "Hey Dale, it's Mikey. I got your quote for the 2019 Toyota Tacoma - $349. What day were you looking to get it done?",
    plain: "Hey Dale, it's Mikey. I got your quote for the 2019 Toyota Tacoma - $349. What day were you looking to get it done?",
    alt: '', altCap: '',
    smart: "Hey Dale, it's Mikey. Got your quote for the Tacoma at $349. I've got Tuesday at 10 open, want it?",
    fault: 'says "Tuesday", which is a day Mikey has not agreed to and has not looked at his calendar for',
    refused: true, error: '',
  },
  {
    id: 'q3', ts: now - 9000000, name: '',
    summary: 'no vehicle given · $200', notes: '', appointment: '', bucket: 'offer',
    live: "Hey there, it's Mikey. I got your quote submission on my site. Whenever you have a minute, feel free to send over your name and the year, make, and model of the car you'd like detailed, and I'll confirm that price. Talk soon!",
    plain: "Hey there, it's Mikey. I got your quote submission on my site. Whenever you have a minute, feel free to send over your name and the year, make, and model of the car you'd like detailed, and I'll confirm that price. Talk soon!",
    alt: "Hey there, it's Mikey. I got your quote submission on my site, and I can confirm that price as soon as I know the car. What's your name, and what's the year, make and model?",
    altCap: 'The reworded version (switch is off)',
    smart: "Hey there, it's Mikey. Got your quote submission on my site - I can lock that price in as soon as I know what you're driving. What's your name and the year, make and model?",
    fault: '', refused: false, error: '',
  },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const previewPosts = [];
const teachPosts = [];
const configPosts = [];
const sendAttempts = [];

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') return json({ ok: true, threads: [], config });
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(b); config = Object.assign({}, config, b);
    }
    return json({ ok: true, config });
  }
  if (path === '/api/quote-preview') {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    previewPosts.push(b);
    if (b.made) {
      return json({ ok: true, made: true, cards: [Object.assign({}, CARDS[0], { id: 'made:1', name: b.made.name || '', summary: (b.made.vehicle || 'no vehicle given') + ' · $' + (b.made.total || '0') })] });
    }
    const seen = new Set(b.seen || []);
    const left = CARDS.filter((c) => !seen.has(c.id));
    return json({ ok: true, cards: left.slice(0, b.count || 3), remaining: Math.max(0, left.length - (b.count || 3)) });
  }
  if (path === '/api/quote-preview/teach') {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    teachPosts.push(b);
    return json({ ok: true, scores: { match: 1, off: 0 } });
  }
  if (path === '/api/voice/stats') {
    return json({ ok: true, samples: 400, buckets: { price: 40, offer: 20, general: 30 }, scores: { match: 8, off: 2 },
      perBucket: {}, style: { medLen: 104, medSentences: 2, emojiPct: 1, greetPct: 4, exclaimPct: 30 },
      provider: 'claude', next: 'train' });
  }
  // Nothing on this screen may ever reach these.
  if (/\/api\/(send|messages|sms|schedule)/.test(path)) { sendAttempts.push(path); return json({ ok: true }); }
  if (path === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-09-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const openTrainAI = async () => {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#moreApp.show').count())) break;
    await page.locator('#mrBack').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(400);
  await page.getByText('Train AI', { exact: true }).first().click();
  await page.waitForTimeout(700);
};

section('It is reachable from Train AI, next to the other trainer');
await openTrainAI();
ok('the action is on the screen', await page.locator('#taiQuote').count() === 1);
const label = await page.locator('#taiQuote').innerText();
ok('and it says what it is for', /before you switch it on/i.test(label), label);

section('A real submission shows both versions side by side');
await page.locator('#taiQuote').click();
await page.waitForTimeout(800);
let card = await page.locator('#taiCardBox').innerText();
ok('it shows what they submitted',      /2014 Honda CR-V/.test(card), card.slice(0, 200));
ok('including what they typed',         /any chance you could do Saturday/.test(card), card.slice(0, 300));
ok('it labels what sends today',        /What sends today/i.test(card), card.slice(0, 300));
ok('and shows the AI version',          /What the AI would write/i.test(card), card.slice(0, 400));
ok('both texts are actually rendered',  /hoping for Saturday/.test(card) && /rough inside is no problem/.test(card), card.slice(0, 600));
ok('it says plainly that nothing sent', /Nothing here has been sent to anybody/i.test(card), card);
ok('no send endpoint was touched',      sendAttempts.length === 0, sendAttempts);

section('A blocked draft is shown as blocked — that is the whole safety story');
await page.locator('#qpYes').click();
await page.waitForTimeout(400);
card = await page.locator('#taiCardBox').innerText();
ok('the refusal is called out',   /Refused/i.test(card), card.slice(0, 400));
ok('it says the plain text wins', /plain text would have gone instead/i.test(card), card.slice(0, 400));
ok('and names the actual reason', /Tuesday/.test(card), card.slice(0, 500));
ok('the blocked draft is still visible so he can judge it', /I've got Tuesday at 10 open/.test(card), card.slice(0, 600));

section('The reworded opener appears only where it changes something');
await page.locator('#qpYes').click();
await page.waitForTimeout(400);
card = await page.locator('#taiCardBox').innerText();
ok('the reworded version is shown',  /reworded version/i.test(card), card.slice(0, 400));
ok('it says the switch is off',      /switch is off/i.test(card), card.slice(0, 400));
ok('old text still ends on Talk soon', /Talk soon!/.test(card), card.slice(0, 600));
ok('new text ends on a question',    /year, make and model\?/.test(card), card.slice(0, 700));

section('Rewriting it is what trains it');
await page.locator('#qpRw').click();
await page.waitForTimeout(300);
ok('the box is seeded with the AI draft', (await page.locator('#qpText').inputValue()).length > 20);
await page.locator('#qpText').fill("Hey, it's Mikey - saw your quote come through. What's the year, make and model?");
await page.locator('#qpSave').click();
await page.waitForTimeout(500);
const t = teachPosts[teachPosts.length - 1];
ok('the rewrite posted as a miss',        t && t.verdict === 'off', t);
ok('with his wording as the target',      t && /saw your quote come through/.test(t.mine || ''), t);
ok('and the AI draft as the before',      t && (t.ai || '').length > 20, t);
ok('paired with what they submitted',     t && /no vehicle given/.test(t.asked || ''), t);
ok('a tick earlier posted as a match',    teachPosts.some((x) => x.verdict === 'match'), teachPosts.map((x) => x.verdict));

section('Nothing on the screen flipped a live switch');
ok('no config was written', configPosts.length === 0, configPosts);
ok('still no send attempts', sendAttempts.length === 0, sendAttempts);

section('Make one up, for a case his history has not thrown up yet');
await page.waitForTimeout(300);
card = await page.locator('#taiBody').innerText();
if (/Make one up/i.test(card)) {
  await page.getByText('Make one up', { exact: true }).first().click();
  await page.waitForTimeout(400);
  ok('the form is there', await page.locator('#qpmNotes').count() === 1);
  await page.locator('#qpmVehicle').fill('2022 Ram 3500');
  await page.locator('#qpmTotal').fill('409');
  await page.locator('#qpmNotes').fill('it is covered in dog hair, can you still do it?');
  await page.locator('#qpmGo').click();
  await page.waitForTimeout(700);
  const made = previewPosts[previewPosts.length - 1];
  ok('it sent the made-up submission', made && made.made && made.made.vehicle === '2022 Ram 3500', made);
  ok('including the notes box',        made && /dog hair/.test(made.made.notes || ''), made);
  ok('and it still sent nothing',      sendAttempts.length === 0, sendAttempts);
} else {
  ok('reached the end of the queue with a way to make one up', false, card.slice(0, 300));
}

section('No page errors');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
