// The helper page in a real browser: one conversation list like a phone's,
// "needs reply" counted from the helper's start line,
// every reply gets an Auto Polish read before it can go out, and Undo is a real
// way back. Plus the one hop in Mikey's own app: the helper's PIN on his
// sign-in screen lands on the helper page, not in his dashboard.
//
//   node test/helper.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HELPER = fs.readFileSync(new URL('../public/helper.html', import.meta.url), 'utf8');
const APP = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }

const rows = [
  { phone: '+14255550001', name: 'Recent Waiter', lastBody: 'what time tomorrow?', lastDir: 'in', lastTs: now - 20 * 60000, awaitingReply: true, waitSince: now - 20 * 60000, unread: 1 },
  { phone: '+14255550002', name: 'Oldest Waiter', lastBody: 'are you available next tuesday?', lastDir: 'in', lastTs: now - 9 * 3600000, awaitingReply: true, waitSince: now - 9 * 3600000, unread: 1 },
  { phone: '+14255550003', name: 'Done Deal', lastBody: 'See you Friday', lastDir: 'out', lastTs: now - 3600000 },
  { phone: '+14255550004', name: 'Said Stop', lastBody: 'STOP', lastDir: 'in', lastTs: now - 60000, awaitingReply: true, optedOut: true },
  { phone: '+14255550005', name: 'Archived Person', lastBody: 'hi', lastDir: 'in', lastTs: now - 1000, archived: true },
];
const thread = {
  phone: '+14255550002', name: 'Oldest Waiter', notes: 'Quote request: 2019 RAV4, Full Detail',
  messages: [{ dir: 'in', body: 'are you available next tuesday?', ts: now - 9 * 3600000 }],
  suggested: { text: 'I might have an opening Tuesday, what part of town are you in?', forTs: now - 9 * 3600000 },
};
const guide = {
  ok: true, name: 'Jess', notes: 'Booked solid Thursday.', since: now - 2 * 3600000,
  guide: [{ title: 'Your job', points: ['Answer within 15 minutes.'] }, { title: 'How a booking goes', points: ['1. Year, make and model.'] }],
  quick: [{ label: 'Ask for the car', text: 'Could you send over the year, make, and model of the car?' }],
  prices: [{ name: 'Full Detail', price: { sedan: 299, suv: 339, truck: 379 } }], addons: [{ name: 'Pet hair removal', price: 30 }],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];
function watch(page) {
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
}

// ---------------------------------------------------------------- helper page
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
watch(page);
let authed = false;
const sends = [], polishes = [];
let polishReply = (text) => ({ ok: true, draft: text.replace(/^hey/i, 'Hey').replace(/tues\b/i, 'Tuesday') + '!', note: '' });
await page.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
  if (p === '/helper.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HELPER });
  if (p === '/api/login') { const b = body(); if (b.password === '5150') { authed = true; return json({ ok: true, role: 'helper' }); } return json({ ok: false, error: 'wrong_password' }, 401); }
  if (!authed && p.startsWith('/api/')) return json({ ok: false, error: 'unauthorized' }, 401);
  if (p === '/api/whoami') return json({ ok: true, role: 'helper', name: 'Jess' });
  if (p === '/api/helper/guide') return json(guide);
  if (p === '/api/threads') return json({ ok: true, threads: rows });
  if (p === '/api/thread') return json({ ok: true, thread });
  if (p === '/api/ai/draft') { const b = body(); polishes.push(b.text); return json(polishReply(b.text)); }
  if (p === '/api/send') { const b = body(); sends.push(b.body); return json({ ok: true, thread: Object.assign({}, thread, { messages: thread.messages.concat([{ dir: 'out', body: b.body, ts: Date.now(), by: 'Jess' }]) }) }); }
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 404, body: '' });
});

await page.goto('https://texting.test/helper.html');
console.log('\nSign in');
await page.waitForSelector('#pinIn', { state: 'visible' });
await page.fill('#pinIn', '0000'); await page.click('#pinGo');
await page.waitForFunction(() => document.getElementById('pinErr').textContent.length > 0);
ok(/Wrong PIN/.test(await page.textContent('#pinErr')), 'a wrong PIN says so');
await page.fill('#pinIn', '5150'); await page.click('#pinGo');
await page.waitForSelector('#listView:not(.hide) .row');

console.log('\nOne list, like Messages');
const names = await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent));
ok(names.join('|') === 'Said Stop|Recent Waiter|Done Deal|Oldest Waiter', 'every conversation, newest first: ' + names.join('|'));
ok(!names.includes('Archived Person'), 'archived ones are tucked away at the bottom');
ok(/Texting for Mikey · Jess/.test(await page.textContent('#whoami')), 'names the helper');
ok(await page.$$eval('#list .row .av', (n) => n.length) === 4, 'each row has a contact circle');

console.log('\n"Needs reply" starts from the helper\'s start line');
const pills = await page.$$eval('#list .row', (rows) => rows.map((r) => [r.querySelector('.who').textContent, !!r.querySelector('.pill.need')]));
const need = Object.fromEntries(pills);
ok(need['Recent Waiter'] === true, 'a text after the start line needs a reply');
ok(need['Oldest Waiter'] === false, 'the older backlog is cleared for the helper');
ok(need['Said Stop'] === false, 'someone who said STOP never needs a reply');
ok(/Needs reply \(1\)/.test(await page.textContent('#segNeed')), 'the filter counts one');
await page.click('#segNeed');
const needNames = await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent));
ok(needNames.join('|') === 'Recent Waiter', '"Needs reply" shows just that one');
await page.click('#segAll');
await page.click('#archBtn');
ok((await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent))).includes('Archived Person'), 'archived conversations can still be scrolled to');
await page.click('#archBtn');

console.log('\nConversation, quick reply, suggestion');
await page.click('#list .row[data-p="+14255550002"]');
await page.waitForSelector('#chatView:not(.hide) .b.in');
ok((await page.textContent('#chatName')) === 'Oldest Waiter', 'chat header names them');
ok(/2019 RAV4/.test(await page.textContent('#chatInfo')), 'quote notes shown');
ok(await page.isDisabled('#sendBtn'), 'send is grey while the box is empty');
ok(await page.isVisible('#useSugg'), 'the AI\'s draft is offered');
await page.click('#useSugg');
ok((await page.inputValue('#box')).startsWith('I might have an opening Tuesday'), 'using the draft fills the box');
ok(polishes.length === 0, 'the AI draft is already in his voice, so no polish call');
await page.click('#sendBtn');
await page.waitForFunction(() => document.getElementById('box').value === '');
ok(sends.length === 1 && sends[0].startsWith('I might have an opening'), 'the draft sends on one tap');
ok(/Sent by Jess/.test(await page.textContent('#msgs')), 'under the bubble: "Sent by Jess"');
ok(await page.$$eval('#msgs .b.out', (n) => n.length) === 1 && await page.$$eval('#msgs .b.in', (n) => n.length) === 1, 'their text on the left, the reply on the right');

console.log('\nAuto Polish');
await page.fill('#box', '');
await page.type('#box', 'hey I can do tues at 1pm');
await page.waitForFunction(() => /Polished/.test(document.getElementById('strip').textContent), null, { timeout: 8000 });
ok(await page.inputValue('#box') === 'Hey I can do Tuesday at 1pm!', 'after a pause the box is rewritten into his voice');
ok(polishes.length === 1, 'one polish call');
await page.click('#undoP');
ok(await page.inputValue('#box') === 'hey I can do tues at 1pm', 'Undo puts their exact words back');
await page.click('#sendBtn');
await page.waitForFunction((n) => window.__n = n, sends.length);
await page.waitForTimeout(300);
ok(sends[sends.length - 1] === 'hey I can do tues at 1pm', 'after Undo their own words send, without a second polish');
ok(polishes.length === 1, 'Undo is respected, no re-polish loop');

console.log('\nSend never skips the read');
const nBefore = sends.length;
await page.fill('#box', 'could you send the year of the car');
await page.click('#sendBtn');   // straight to Send, no pause
await page.waitForFunction(() => /Polished/.test(document.getElementById('strip').textContent));
ok(sends.length === nBefore, 'first tap polishes instead of sending');
ok(await page.inputValue('#box') === 'could you send the year of the car!', 'and shows the version that will go out');
await page.click('#sendBtn');
await page.waitForFunction((n) => true, null);
await page.waitForTimeout(300);
ok(sends.length === nBefore + 1 && sends[sends.length - 1] === 'could you send the year of the car!', 'second tap sends what they read');

console.log('\nPolish down is not a dead end');
polishReply = () => ({ ok: false, error: 'ai_down' });
await page.fill('#box', 'running a little late today');
await page.click('#sendBtn');
await page.waitForFunction(() => /down right now/.test(document.getElementById('strip').textContent));
await page.click('#sendBtn');
await page.waitForTimeout(300);
ok(sends[sends.length - 1] === 'running a little late today', 'with polish down, the second tap still sends');

console.log('\nQuick replies and guide');
await page.fill('#box', '');
await page.click('.chip');
ok(/year, make, and model/.test(await page.inputValue('#box')), 'a quick reply lands in the box, not out the door');
await page.click('#plusBtn');
ok(await page.isVisible('#askDate') && await page.isVisible('#askQ'), 'the + button offers Ask Mikey for a date / Ask Mikey');
await page.click('#sheetGuide');
await page.waitForSelector('#guideView:not(.hide) table');
const g = await page.textContent('#guideView');
ok(/Booked solid Thursday/.test(g), 'Mikey\'s notes are on top');
ok(/\$299/.test(g) && /\$379/.test(g) && /Pet hair removal: \+\$30/.test(g), 'price list rendered');
ok(/Ceramic coating: from \$500/.test(g), 'ceramic "from $500" fact');
await page.click('#guideBack');
ok(await page.isVisible('#chatView'), 'Back from the guide returns to the conversation');

// ------------------------------------------------ Mikey's app: helper PIN hop
console.log('\nHelper PIN on Mikey\'s sign-in screen');
const app = await browser.newPage({ viewport: { width: 390, height: 844 } });
watch(app);
let landed = '';
await app.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: APP });
  if (p === '/helper.html') { landed = p; return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>helper</body></html>' }); }
  if (p === '/api/login') return json({ ok: true, role: 'helper' });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: false, error: 'unauthorized' }, 401);
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await app.goto('https://texting.test/');
await app.waitForSelector('#loginOverlay.show');
for (const d of '5150') await app.click(`#pinPad .pin-key >> text="${d}"`);
await app.click('#pinPad .pin-key.fn >> text="✓"');
await app.waitForFunction(() => location.pathname === '/helper.html', null, { timeout: 5000 }).catch(() => {});
ok(landed === '/helper.html', 'the helper PIN goes to the helper page, not the dashboard');

// A helper cookie opening the main app gets sent to their page too.
const app2 = await browser.newPage();
watch(app2);
let landed2 = '';
await app2.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: APP });
  if (p === '/helper.html') { landed2 = p; return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>helper</body></html>' }); }
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: false, error: 'helper_not_allowed' }, 403);
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await app2.goto('https://texting.test/');
await app2.waitForFunction(() => location.pathname === '/helper.html', null, { timeout: 5000 }).catch(() => {});
ok(landed2 === '/helper.html', 'a helper opening the main app is sent to their page');

const real = errs.filter((e) => !/helper_not_allowed|403|401/.test(e));
ok(real.length === 0, 'no page errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
