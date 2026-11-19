// The Google Voice layout (/voice, 2026-11-19): Mikey's conversations drawn
// like voice.google.com, as a test of how that feels. Its rule is "nothing
// Voice doesn't have", so these checks guard both halves: that it behaves like
// Voice (open marks read, Enter sends, calls and voicemail on their own tabs,
// Archive in the menu) and that none of the dashboard's extras crept in.
import { chromium } from 'playwright-core';
import fs from 'fs';

const read = (p) => fs.readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const now = Date.now();
const M = 60000, H = 60 * M, D = 24 * H;

const ROWS = [
  { phone: '+14255550301', name: 'Dana Fox', lastTs: now - 10 * M, lastDir: 'in', lastBody: 'Can you do Saturday?', unread: 1, awaitingReply: true, quoteTotal: 409 },
  { phone: '+14255550302', name: '', lastTs: now - 2 * D, lastDir: 'out', lastBody: 'See you then' },
  { phone: '+14255550303', name: 'Old Archie', lastTs: now - 40 * D, lastDir: 'in', lastBody: 'thanks', archived: true },
];
const THREAD = {
  phone: '+14255550301', name: 'Dana Fox', unread: 1,
  messages: [
    { dir: 'out', body: 'Hi Dana, it is Mikey', ts: now - 2 * H, kind: 'auto', status: 'sent' },
    { dir: 'in', body: 'Hey!', ts: now - 12 * M },
    { dir: 'in', body: 'Can you do Saturday?', ts: now - 10 * M },
    { dir: 'in', body: '🎙️ Voicemail (12s)', ts: now - 3 * H, kind: 'voicemail', recording: 'https://x/rec.mp3' },
    { dir: 'in', body: '📞 Phone call', ts: now - 4 * H, kind: 'call' },
  ],
  scheduled: [{ sendAt: now + D, body: 'Reminder text' }],
};
const CALLS = [
  { id: 'c1', fromNorm: '+14255550301', ts: now - 3 * H, outcome: 'voicemail', transcript: 'Hi this is Dana about my truck', recording: 'https://x/rec.mp3', vmSec: 12 },
  { id: 'c2', fromNorm: '+14255550302', ts: now - 5 * H, outcome: 'missed' },
  { id: 'c3', fromNorm: '+14255550301', ts: now - 6 * H, outcome: 'answered', talkSec: 95 },
  { id: 'c4', fromNorm: '+14255550309', ts: now - 7 * H, outcome: 'screened' },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

async function open(viewport, path = '/voice') {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errs = [], posted = [], got = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|sw\.js|rec\.mp3|api\/media/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url()); const p = u.pathname;
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (/fonts\.(googleapis|gstatic)/.test(u.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* */ } posted.push({ path: p, body: b }); }
    else got.push(p + u.search);
    if (p === '/voice') return route.fulfill({ status: 200, contentType: 'text/html', body: read('voice.html') });
    if (p === '/app/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: read('app/app.js') });
    if (p === '/app/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: read('app/app.css') });
    if (p === '/api/threads') return json({ ok: true, threads: ROWS });
    if (p === '/api/thread') return json({ ok: true, thread: u.searchParams.get('phone') === THREAD.phone ? THREAD : { phone: u.searchParams.get('phone'), messages: [] } });
    if (p === '/api/calls') return json({ ok: true, calls: CALLS, seenTs: now - 4 * H });
    if (p === '/api/calls/seen') return json({ ok: true, seenTs: now });
    if (p === '/api/send') return json({ ok: true, thread: Object.assign({}, THREAD, { messages: THREAD.messages.concat([{ dir: 'out', body: 'Yes, 1 PM works', ts: Date.now() }]) }) });
    if (p.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto('https://texting.test' + path);
  await page.waitForTimeout(600);
  return { ctx, page, errs, posted, got };
}

section('Laptop: the Voice layout');
{
  const { ctx, page, errs, posted, got } = await open({ width: 1280, height: 800 });
  ok('the Voice top bar with its search', await page.locator('.gv-top .gv-logo').isVisible() && (await page.locator('#q').getAttribute('placeholder')) === 'Search Google Voice');
  const rail = await page.locator('.gv-rail .nv').allInnerTexts();
  ok('the rail is Calls, Messages, Voicemail', rail.map((s) => s.trim().replace(/\d+/g, '').trim()).join() === 'Calls,Messages,Voicemail', rail);
  ok('Messages is selected to start', await page.locator('.gv-rail [data-nav="messages"]').evaluate((b) => b.classList.contains('on')));
  const list = await page.locator('#list').innerText();
  ok('the list starts with Send new message', /^Send new message/.test(list.trim()), list.slice(0, 60));
  ok('an archived chat is not in Messages', !/Old Archie/.test(list));
  ok('a bare number shows as a formatted number', /\(425\) 555-0302/.test(list));
  ok('an unread chat is bold', await page.locator('[data-open="+14255550301"]').evaluate((b) => b.classList.contains('unread')));
  ok('no dashboard extras in the list (no quote, no Waiting tag)', !/\$409|Waiting|Needs you/.test(list));
  ok('the unread count is on the Messages tab', (await page.locator('.gv-rail [data-bdg="messages"]').innerText()) === '1');

  await page.locator('[data-open="+14255550301"]').click();
  await page.waitForTimeout(400);
  ok('opening a chat reads it, like Voice (no peek)', got.some((g) => g.startsWith('/api/thread?phone=')) && !got.some((g) => /\/api\/thread\?peek=1/.test(g)), got);
  ok('the bold goes once it is open', !(await page.locator('[data-open="+14255550301"]').evaluate((b) => b.classList.contains('unread'))));
  ok('the open chat row is highlighted', await page.locator('[data-open="+14255550301"]').evaluate((b) => b.classList.contains('sel')));
  const pane = await page.locator('#pane').innerText();
  ok('the header has their name and number', /Dana Fox/.test(pane) && /\(425\) 555-0301/.test(pane));
  ok('texts show, including an automatic one, with no Auto label', /Hi Dana, it is Mikey/.test(pane) && !/\bAuto\b/.test(pane));
  ok('voicemails and calls stay on their own tabs', !/Voicemail \(12s\)|Phone call/.test(pane));
  ok('scheduled texts are not shown (Voice has none)', !/Reminder text|Scheduled/.test(pane));
  ok('two texts close together share one time under them', (await page.locator('.gv-grp.in').count()) === 1 && (await page.locator('.gv-grp.in .gv-b').count()) === 2);
  ok('a day heading reads Today', /Today/.test(pane));
  ok('no AI or quick-reply chips', (await page.locator('#pane .chip, #pane [data-q]').count()) === 0 && !/Draft|Polish|Next 3 times|On my way/.test(pane));
  ok('the composer says Type a message', (await page.locator('#msg').getAttribute('placeholder')) === 'Type a message');
  ok('send is off until something is typed', await page.locator('#sendBtn').isDisabled());

  await page.locator('#msg').fill('Yes, 1 PM works');
  await page.locator('#msg').press('Enter');
  await page.waitForTimeout(400);
  const sent = posted.find((p) => p.path === '/api/send');
  ok('Enter sends it to that number', sent && sent.body.phone === '+14255550301' && sent.body.body === 'Yes, 1 PM works', sent);
  ok('the box clears after it sends', (await page.locator('#msg').inputValue()) === '');
  ok('the sent text shows in the chat', /Yes, 1 PM works/.test(await page.locator('#tl').innerText()));

  await page.locator('#paneMore').click();
  const items = await page.locator('#pop button').allInnerTexts();
  ok('the ⋮ menu has Archive and Mark as unread', items.join() === 'Archive,Mark as unread', items);
  await page.locator('#pop button', { hasText: 'Archive' }).click();
  await page.waitForTimeout(300);
  ok('Archive files the chat', posted.some((p) => p.path === '/api/meta' && p.body.phone === '+14255550301' && p.body.archived === true));

  section('Laptop: calls and voicemail');
  await page.locator('.gv-rail [data-nav="voicemail"]').click();
  await page.waitForTimeout(300);
  const vm = await page.locator('#list').innerText();
  ok('Voicemail lists the transcript', /Hi this is Dana about my truck/.test(vm));
  ok('opening Voicemail marks calls seen, like the Calls screen', posted.some((p) => p.path === '/api/calls/seen'));
  await page.locator('[data-call="c1"]').click();
  await page.waitForTimeout(300);
  ok('a voicemail opens with its transcript and a play button', /Hi this is Dana about my truck/.test(await page.locator('#pane').innerText()) && await page.locator('#pane .gv-play .pb').isVisible());
  await page.locator('.gv-rail [data-nav="calls"]').click();
  await page.waitForTimeout(300);
  const calls = await page.locator('#list').innerText();
  ok('Calls lists missed and answered calls', /Missed call/.test(calls) && /Incoming call/.test(calls));
  ok('a call the screen turned away is not listed', !/555-0309/.test(calls));
  await page.locator('[data-call="c3"]').click();
  await page.waitForTimeout(300);
  ok('a call opens that person\'s call history with its length', /Incoming call · 1:35/.test(await page.locator('#pane').innerText()));
  await page.locator('#paneCall').click();
  await page.waitForTimeout(300);
  ok('the call button rings his phone through /api/call', posted.some((p) => p.path === '/api/call' && p.body.phone === '+14255550301'));

  section('Laptop: menu, archive and a new message');
  await page.locator('#menuBtn').click();
  await page.waitForTimeout(250);
  const dr = await page.locator('#drawer').innerText();
  ok('the menu has Archive and a way back to the dashboard', /Archive/.test(dr) && /Back to my dashboard/.test(dr));
  await page.locator('#drawer [data-go="archive"]').click();
  await page.waitForTimeout(250);
  ok('Archive lists the archived chat', /Old Archie/.test(await page.locator('#list').innerText()));
  await page.locator('#menuBtn').click();
  await page.locator('#drawer [data-go="messages"]').click();
  await page.waitForTimeout(250);
  await page.locator('#newBtn').click();
  await page.locator('#to').fill('425 555 0399');
  await page.waitForTimeout(150);
  await page.locator('#to').press('Enter');
  await page.waitForTimeout(300);
  ok('typing a number opens a fresh chat with it', /\(425\) 555-0399/.test(await page.locator('#pane .gv-ph').innerText()));
  await page.locator('#q').fill('dana');
  await page.waitForTimeout(150);
  const found = await page.locator('#list .gv-row').count();
  ok('search narrows the list', found === 1, found);
  ok('no errors on the page', errs.length === 0, errs);
  await ctx.close();
}

section('Phone: the Voice app');
{
  const { ctx, page, errs } = await open({ width: 390, height: 844 });
  ok('no laptop top bar on a phone', !(await page.locator('.gv-top').isVisible()));
  ok('a search pill on top', await page.locator('.gv-msearch').isVisible());
  ok('bottom tabs are Calls, Messages, Voicemail', (await page.locator('.gv-bnav .nv').allInnerTexts()).map((s) => s.replace(/\d+/g, '').trim()).join() === 'Calls,Messages,Voicemail');
  ok('the Send message button floats over the list', await page.locator('#fab').isVisible() && /Send message/.test(await page.locator('#fab').innerText()));
  await page.locator('[data-open="+14255550301"]').click();
  await page.waitForTimeout(500);
  const box = await page.locator('#pane').boundingBox();
  ok('the chat slides over the whole screen', box && box.x === 0 && box.width === 390, box);
  await page.locator('#paneBack').click();
  await page.waitForTimeout(400);
  ok('back returns to the list', !(await page.evaluate(() => document.getElementById('gv').classList.contains('open'))));
  ok('no errors on the page', errs.length === 0, errs);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
