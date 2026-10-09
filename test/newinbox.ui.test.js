// The new Inbox (/inbox, 2026-10-08) — the first page of the rebuild.
//
// What it has to get right is what Mikey asked for in the pivot questions:
//   - the people waiting on him at the top, the longest wait first
//   - opening a chat does NOT mark it read; answering or filing it does
//   - calls and voicemails in the same timeline as the texts
//   - "Fix spelling only" as its own button, Next 3 times off the real calendar
// Driven in a real browser because every claim is about what renders and what
// a tap sends.
import { chromium } from 'playwright-core';
import fs from 'fs';

const read = (p) => fs.readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const now = Date.now();
const H = 3600000, D = 24 * H;

const ROWS = [
  { phone: '+14255550101', name: 'Dana Fresh', unread: 1, lastDir: 'in', lastBody: 'Can you do Saturday?', lastTs: now - 5 * 60000, awaitingReply: true, waitSince: now - 5 * 60000 },
  { phone: '+14255550102', name: 'Forgot Frank', unread: 0, lastDir: 'in', lastBody: 'Still interested, what times?', lastTs: now - 3 * D, awaitingReply: true, waitSince: now - 3 * D, vehicleLabel: '2019 Tacoma', city: 'Monroe' },
  { phone: '+14255550103', name: 'Booked Beth', unread: 0, lastDir: 'out', lastBody: 'See you then!', lastTs: now - 2 * H, appointmentAt: now + D },
  { phone: '+14255550104', name: 'Filed Fiona', unread: 0, lastDir: 'out', lastBody: 'Thanks!', lastTs: now - 9 * D, archived: true },
];
const THREAD = {
  phone: '+14255550102', name: 'Forgot Frank', unread: 0, notes: '', garage: { vehicles: [{ year: 2019, make: 'Toyota', model: 'Tacoma' }], address: '1 Main St', city: 'Monroe' },
  messages: [
    { id: 'a', dir: 'in', body: 'Hi, how much for a full detail?', ts: now - 3 * D - 2 * H },
    { id: 'b', dir: 'out', kind: 'manual', body: 'Full Detail on your Tacoma is $409.', ts: now - 3 * D - H, status: 'sent' },
    { id: 'c', dir: 'out', kind: 'followup', body: 'Just checking in!', ts: now - 3 * D - 30 * 60000, status: 'sent' },
    { id: 'v', dir: 'in', kind: 'voicemail', body: '🎙️ Voicemail (12s)', ts: now - 3 * D - 10 * 60000, transcript: 'Hey Mikey, call me back about the Tacoma.' },
    { id: 'd', dir: 'in', body: 'Still interested, what times?', ts: now - 3 * D },
  ],
  scheduled: [],
};
const CALLS = [{ id: 'k1', fromNorm: '+14255550102', ts: now - 3 * D - 20 * 60000, outcome: 'answered', talkSec: 61, transcript: 'Talked about Saturday.' }];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 412, height: 880 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const posted = [], gets = [];
let authed = true;
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (/fonts\.(googleapis|gstatic)/.test(u.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* */ } posted.push({ path, body: b }); }
  else gets.push(path + u.search);
  if (path === '/favicon.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
  if (path === '/inbox') return route.fulfill({ status: 200, contentType: 'text/html', body: read('inbox.html') });
  if (path === '/app/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: read('app/app.js') });
  if (path === '/app/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: read('app/app.css') });
  if (path.startsWith('/api/') && !authed && path !== '/api/login') return json({ ok: false, error: 'unauthorized' }, 401);
  if (path === '/api/threads') return json({ ok: true, threads: ROWS });
  if (path === '/api/thread') return json({ ok: true, thread: u.searchParams.get('phone') === THREAD.phone ? THREAD : { phone: u.searchParams.get('phone'), messages: [] } });
  if (path === '/api/calls') return json({ ok: true, calls: CALLS });
  if (path === '/api/config') return json({ ok: true, config: { reviewUrl: 'https://g.page/r/TEST/review' } });
  if (path === '/api/money/by-phone') return json({ ok: true, jobs: 2, total: 778 });
  if (path === '/api/next-openings') return json({ ok: true, openings: [
    { label: 'Thu, Oct 9', time: '1:00 PM' }, { label: 'Sat, Oct 11', time: '7:00 AM' }, { label: 'Sat, Oct 11', time: '1:00 PM' }] });
  if (path === '/api/ai/draft') {
    const b = JSON.parse(req.postData() || '{}');
    if (b.spell) return json({ ok: true, draft: 'I can do Saturday.' });
    return json({ ok: true, draft: 'Sounds good! I can do Saturday at 1pm.' });
  }
  if (path === '/api/send') return json({ ok: true, thread: THREAD });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

await page.goto('https://texting.test/inbox');
await page.waitForTimeout(700);

section('The list');
const names = await page.locator('#list .row .name').allInnerTexts();
ok('the longest wait is first', names[0] === 'Forgot Frank', names);
ok('the fresh lead is second, still in Needs you', names[1] === 'Dana Fresh', names);
ok('someone not waiting sits under Everyone else', names.indexOf('Booked Beth') === 2, names);
ok('filed chats are not in the main list', names.indexOf('Filed Fiona') < 0, names);
ok('the wait is shown on the row', /Waiting 3d/.test(await page.locator('#list .row').first().innerText()));
ok('the Inbox badge counts the people waiting', (await page.locator('#dot-inbox').innerText()).trim() === '2');
await page.locator('#filters [data-f="done"]').click();
ok('Done shows the filed chat', (await page.locator('#list .row .name').allInnerTexts()).join() === 'Filed Fiona');
await page.locator('#filters [data-f="all"]').click();
await page.fill('#q', 'tacoma');
ok('search finds by car', (await page.locator('#list .row .name').allInnerTexts()).join() === 'Forgot Frank');
await page.fill('#q', '');
await page.waitForTimeout(100);

section('Opening a chat');
await page.locator('#list .row', { hasText: 'Forgot Frank' }).click();
await page.waitForTimeout(400);
ok('it reads the chat with peek=1', gets.some((g) => g.startsWith('/api/thread?peek=1')), gets.filter((g) => g.startsWith('/api/thread')));
ok('opening it marked nothing read', !posted.some((p) => p.path === '/api/read'));
ok('the chat panel is open', await page.locator('#chat.on').count() === 1);
ok('the header has the car and town', /Tacoma.*Monroe/.test(await page.locator('#chatMeta').innerText()));
const tl = await page.locator('#tl').innerText();
ok('texts both ways are in the timeline', /how much for a full detail/.test(tl) && /\$409/.test(tl));
ok('an automatic text is marked Auto', await page.locator('#tl .b.auto').count() === 1 && /Auto/.test(tl));
ok('the voicemail is in the timeline with its transcript', /Voicemail/.test(tl) && /call me back about the Tacoma/.test(tl));
ok('the answered call is in the timeline too', /Talked about Saturday/.test(tl));
ok('the URL names the chat, so back works', /\/inbox\?c=/.test(page.url()), page.url());

section('Writing and sending');
await page.fill('#msg', 'i can do saterday');
await page.locator('#quick [data-q="spell"]').click();
await page.waitForTimeout(250);
const sp = posted.find((p) => p.path === '/api/ai/draft');
ok('Spelling sends spell:true with his text', sp && sp.body.spell === true && sp.body.text === 'i can do saterday', sp);
ok('the fix lands in the box', (await page.inputValue('#msg')) === 'I can do Saturday.');
await page.fill('#msg', '');
await page.locator('#quick [data-q="times"]').click();
await page.waitForTimeout(350);
await page.locator('#useTimes').click();
const times = await page.inputValue('#msg');
ok('Next 3 times writes the real openings into the text', /Thu, Oct 9 at 1:00 PM, Sat, Oct 11 at 7:00 AM, or Sat, Oct 11 at 1:00 PM/.test(times), times);
ok('it asked the calendar for a pickup-size Full Detail', gets.some((g) => /next-openings.*service=full.*size=suv/.test(g)), gets.filter((g) => /openings/.test(g)));
await page.locator('#sendBtn').click();
await page.waitForTimeout(300);
const sent = posted.find((p) => p.path === '/api/send');
ok('Send posts the text to this number', sent && sent.body.phone === '+14255550102' && /Thu, Oct 9/.test(sent.body.body), sent);
ok('answering is what marks it read', posted.some((p) => p.path === '/api/read' && p.body.phone === '+14255550102'));
ok('the box empties after sending', (await page.inputValue('#msg')) === '');

section('On my way and the review link');
await page.locator('#quick [data-q="omw"]').click();
await page.waitForTimeout(250);
await page.locator('.sheet .btn', { hasText: 'Be there in 15!' }).click();
ok('On my way uses his words', (await page.inputValue('#msg')) === 'Be there in 15!');
await page.fill('#msg', '');
await page.locator('#quick [data-q="review"]').click();
ok('Review link uses the saved link', /g\.page\/r\/TEST\/review/.test(await page.inputValue('#msg')));
await page.fill('#msg', '');

section('The customer card');
await page.locator('#whoBtn').click();
await page.waitForTimeout(350);
const card = await page.locator('#sheet').innerText();
ok('the card shows the car, address and what they paid', /Tacoma/.test(card) && /1 Main St/.test(card) && /\$778 over 2 jobs/.test(card), card.slice(0, 300));
await page.fill('#cuNotes', 'Spigot behind the gate');
await page.locator('#cuSave').click();
await page.waitForTimeout(250);
const meta = posted.find((p) => p.path === '/api/meta' && 'notes' in p.body);
ok('Save writes the notes to this customer', meta && meta.body.notes === 'Spigot behind the gate' && meta.body.phone === '+14255550102', meta);

section('Done');
const before = posted.length;
await page.locator('#doneBtn').click();
await page.waitForTimeout(300);
const after = posted.slice(before);
ok('Done files the chat', after.some((p) => p.path === '/api/meta' && p.body.archived === true));
ok('and marks it read', after.some((p) => p.path === '/api/read'));
ok('and goes back to the list', await page.locator('#chat.on').count() === 0);

section('Signed out');
const errsBefore = errs.length;
authed = false;
await page.goto('https://texting.test/inbox');
await page.waitForTimeout(500);
ok('a 401 shows the sign-in screen', await page.locator('#login #loginPw').count() === 1);
// The browser logs every 401 as a failed resource. Those are the point of this
// section, so only errors from before it count below.
errs.splice(errsBefore);

section('Page health');
ok('no errors in the console', errs.length === 0, errs);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
