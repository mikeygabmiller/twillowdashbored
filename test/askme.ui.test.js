// "Needs you" — the questions the AI refuses to answer for him.
//
// A drafted reply is only worth a tap if it's right, and there is a whole class
// of customer message where it can't be: "what time can you come?" has exactly
// one correct answer and it lives in Mikey's head. Guessing 10:25 there is not
// a draft, it's a promise made to a real person by something that had no way of
// knowing. So the server holds the draft and asks him instead, with the likely
// answers as buttons, and writes the text from whichever one he taps.
//
// What this suite protects: the question shows INSTEAD of a draft, a tap sends
// the answer (not a text), the finished reply comes back for the normal last
// look, and — the one that would make it dangerous — a tap never sends anything
// to the customer on its own.
//
//   npm install && node test/askme.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

// Two threads: one the AI had to stop and ask about, one it could just answer.
// Both matter — the second is what proves "ask first" didn't swallow the old
// behaviour whole.
const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'Thursday works. What time can you come by?', lastDir: 'in', lastTs: now - 60000,
    needsYou: true, needsYouAsk: 'What time works Thursday?' },
  { phone: '+14255557777', name: 'Rita Cole', unread: 0, tags: [], lastBody: 'do you do ceramic coating?', lastDir: 'in', lastTs: now - 90000,
    replyReady: true },
];

const THREADS = {
  '+14255551234': {
    phone: '+14255551234', name: 'Dale Hobart', tags: [], scheduled: [], linked: [], notes: '',
    messages: [{ id: 'm1', dir: 'in', body: 'Thursday works. What time can you come by?', ts: now - 60000 }],
    needsYou: { question: 'What time works Thursday?', options: ['9am', '11am', '2pm', 'Not Thursday'], ts: now, forTs: now - 60000 },
  },
  '+14255557777': {
    phone: '+14255557777', name: 'Rita Cole', tags: [], scheduled: [], linked: [], notes: '',
    messages: [{ id: 'm1', dir: 'in', body: 'do you do ceramic coating?', ts: now - 90000 }],
    suggested: { text: 'Yep, I do ceramic. Takes a full day.', ts: now, forTs: now - 90000 },
  },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

// Everything the page asked the server to do, so the test can assert on what
// did NOT happen as easily as on what did.
const answered = [];   // POST /api/ai/answer
const sent = [];       // POST /api/send  — must stay empty
const metas = [];      // POST /api/meta
let answerFails = false;

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
  if (path === '/api/ai/answer') {
    const b = body(); answered.push(b);
    if (answerFails) return json({ ok: false, error: 'ai_down' });
    // The server hands back the whole thread, question cleared and the draft
    // moved into the normal suggested slot — that hand-off is the contract.
    const t = JSON.parse(JSON.stringify(THREADS[b.phone]));
    t.needsYou = null;
    t.suggested = { text: `Thursday at ${b.choice} works for me.`, ts: Date.now(), forTs: now - 60000 };
    return json({ ok: true, draft: t.suggested.text, thread: t });
  }
  if (path === '/api/send') { sent.push(body()); return json({ ok: true }); }
  if (path === '/api/meta') { metas.push(body()); return json({ ok: true, thread: THREADS[body().phone] }); }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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

const openThread = async (name) => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
    await page.locator('#backBtn').click(); await page.waitForTimeout(250);
  }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(700);
};

section('The list says which one is waiting on him, without opening it');
await page.locator('.navitem[data-tab="messages"]').click();
await page.waitForTimeout(400);
const listText = await page.locator('#scroll').innerText();
ok('the row is flagged "needs you"', /needs you/i.test(listText), listText.slice(0, 300));
ok('the other row still reads "reply ready"', /reply ready/i.test(listText), listText.slice(0, 300));

section('Open it and you get the question, not a made-up answer');
await openThread('Dale Hobart');
const boxText = await page.locator('#suggestBox').innerText();
ok('the box is showing', await page.locator('#suggestBox').isVisible());
ok('it is headed "Needs you"', /Needs you/i.test(boxText), boxText);
ok('it asks the actual question', /What time works Thursday\?/.test(boxText), boxText);
ok('it says why it did not guess', /only you know/i.test(boxText), boxText);
ok('no draft text was invented', !/works for me/i.test(boxText), boxText);

section('The answers are one tap each, plus a way out');
const chips = await page.locator('#suggestBox .ny-opt').allInnerTexts();
ok('every option from the server is a chip', ['9am', '11am', '2pm', 'Not Thursday'].every((o) => chips.some((c) => c.trim() === o)), chips);
ok('there is a "Something else" escape hatch', chips.some((c) => /Something else/i.test(c)), chips);

section('Tap one: it sends the ANSWER, never a text');
await page.locator('#suggestBox .ny-opt', { hasText: '11am' }).first().click();
await page.waitForTimeout(700);
ok('the answer went to the server exactly once', answered.length === 1, answered);
ok('it carried the tapped choice', answered[0] && answered[0].choice === '11am', answered[0]);
ok('it carried the right customer', answered[0] && answered[0].phone === '+14255551234', answered[0]);
ok('NOTHING was texted to the customer', sent.length === 0, sent);

section('…and the finished reply comes back for the normal last look');
const after = await page.locator('#suggestBox').innerText();
ok('it now reads as a ready reply', /Reply ready/i.test(after), after);
ok('the draft is built from his answer', /Thursday at 11am works for me\./.test(after), after);
ok('there is a Send button — he still has to press it', await page.locator('#suggestBox .air-send').isVisible());
ok('still nothing texted', sent.length === 0, sent);

section('A thread it COULD answer still drafts on its own — nothing regressed');
await openThread('Rita Cole');
const rita = await page.locator('#suggestBox').innerText();
ok('Rita gets a draft, not a question', /Reply ready/i.test(rita) && /ceramic/i.test(rita), rita);
ok('no extra answer call was made', answered.length === 1, answered);

section('"Something else" gets out of the way and lets him type');
await openThread('Dale Hobart');
await page.locator('#suggestBox .ny-opt.other').first().click();
await page.waitForTimeout(400);
ok('the box is gone', !(await page.locator('#suggestBox').isVisible()));
ok('the server was told to drop the question', metas.some((m) => m.clearNeedsYou && m.phone === '+14255551234'), metas);
ok('the cursor is in the message box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'msgInput'));

section('If the write fails, the tap still saved him the typing');
answerFails = true;
await openThread('Dale Hobart');
await page.locator('#suggestBox .ny-opt', { hasText: '2pm' }).first().click();
await page.waitForTimeout(700);
ok('his answer is sitting in the message box', (await page.inputValue('#msgInput')) === '2pm', await page.inputValue('#msgInput'));
ok('and still nothing was texted', sent.length === 0, sent);

section('No page errors');
ok('console is clean', errs.length === 0, errs);

console.log(`\n${fail ? '✗' : '✓'} askme.ui — ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
