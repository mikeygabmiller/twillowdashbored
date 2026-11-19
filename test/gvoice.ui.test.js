// The Google Voice layout (/voice, 2026-11-19): Mikey's conversations drawn
// like voice.google.com, as a test of how that feels. Its rule is "nothing
// Voice doesn't have", so these checks guard both halves: that it behaves like
// Voice (open marks read, Enter sends, calls and voicemail on their own tabs,
// voicemail also in the chat since he asked for it, plus the second batch he
// picked: photo viewer, openers, calls in the chat, tapbacks, drafts, names,
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
    { dir: 'in', body: '🎙️ Voicemail: "Hi this is Dana about my truck"', ts: now - 3 * H, kind: 'voicemail', recording: 'https://x/rec.mp3', transcript: 'Hi this is Dana about my truck' },
    { dir: 'in', body: '📞 Phone call, 1:35\n"Talked about the truck"', ts: now - 6 * H + 5 * M, kind: 'call', callDir: 'in', transcript: 'Talked about the truck', recording: 'https://x/call.mp3' },
    { dir: 'in', body: 'Loved \u201cHi Dana, it is Mikey\u201d', ts: now - 90 * M },
    { dir: 'in', body: '', media: [{ url: '/i/abc123', type: 'image/jpeg' }], ts: now - 80 * M },
  ],
  nameAuto: 'said',
  scheduled: [{ id: 's1', sendAt: now + D, body: 'Reminder text' }],
  addressGuess: '123 Maple St, Snohomish',
};
const CALLS = [
  { id: 'c1', fromNorm: '+14255550301', ts: now - 3 * H, outcome: 'voicemail', transcript: 'Hi this is Dana about my truck', recording: 'https://x/rec.mp3', vmSec: 12 },
  { id: 'c2', fromNorm: '+14255550302', ts: now - 5 * H, outcome: 'missed' },
  { id: 'c3', fromNorm: '+14255550301', ts: now - 6 * H, outcome: 'answered', talkSec: 95 },
  { id: 'c4', fromNorm: '+14255550309', ts: now - 7 * H, outcome: 'screened' },
  { id: 'c5', fromNorm: '+14255550301', ts: now - 8 * H, outcome: 'missed' },
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
    if (p === '/api/ai/style') return json({ ok: true, style: { start: ['Hey', 'Sounds good'] } });
    if (p === '/voice') return route.fulfill({ status: 200, contentType: 'text/html', body: read('voice.html') });
    if (p === '/app/app.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: read('app/app.js') });
    if (p === '/app/app.css') return route.fulfill({ status: 200, contentType: 'text/css', body: read('app/app.css') });
    if (p === '/api/threads') return json({ ok: true, threads: ROWS });
    if (p === '/api/thread') return json({ ok: true, thread: u.searchParams.get('phone') === THREAD.phone ? THREAD : { phone: u.searchParams.get('phone'), messages: [] } });
    if (p === '/api/calls') return json({ ok: true, calls: CALLS, seenTs: now - 4 * H });
    if (p === '/api/calls/seen') return json({ ok: true, seenTs: now });
    if (p === '/api/ai/draft') return json({ ok: true, draft: 'Yes, Saturday at 7 AM works. See you then!' });
    if (p === '/api/schedule') { const b = JSON.parse(req.postData()); return json({ ok: true, thread: Object.assign({}, THREAD, { scheduled: THREAD.scheduled.concat([{ id: 's2', sendAt: b.sendAt, body: b.body }]) }) }); }
    if (p === '/api/unschedule') return json({ ok: true, thread: Object.assign({}, THREAD, { scheduled: [] }) });
    if (p === '/api/garage') return json({ ok: true, garage: { vehicles: [{ make: 'Toyota', model: 'RAV4' }] } });
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
  const vmc = page.locator('#tl .gv-vm', { hasText: 'Voicemail' });
  ok('a voicemail shows in the chat with its transcript and a play button (added back)', (await vmc.count()) === 1 && /Hi this is Dana about my truck/.test(await vmc.innerText()) && await vmc.locator('.pb').isVisible());
  ok('its length comes from the call log', /0:12/.test(await vmc.locator('.tt').innerText()));
  ok('a recorded call shows in the chat with its transcript (added back)', /Phone call · 1:35/.test(pane) && /Talked about the truck/.test(pane));
  ok('a missed call shows as a line in the chat', /Missed call/.test(await page.locator('#tl .gv-call').allInnerTexts().then((a) => a.join('|'))));
  ok('the answered call it covers is not listed twice', (await page.locator('#tl .gv-call', { hasText: 'Incoming call' }).count()) === 0);
  ok('a scheduled text waits at the bottom with its time (added back)', /Reminder text/.test(pane) && /Scheduled for tomorrow/.test(pane), pane.slice(-200));
  ok('the address found in the texts is offered (added back)', /123 Maple St, Snohomish/.test(pane) && /Found in your texts/.test(pane));
  ok('two texts close together share one time under them', (await page.locator('.gv-grp.in', { hasText: 'Can you do Saturday?' }).locator('.gv-b').count()) === 2);
  ok('a day heading reads Today', /Today/.test(pane));
  ok('no AI chips or quick replies beyond what was added back', (await page.locator('#pane .chip, #pane [data-q]').count()) === 0 && !/Draft|Next 3 times|On my way/.test(pane));
  ok('Polish and Schedule stay hidden until there are words', !(await page.locator('#polBtn').isVisible()) && !(await page.locator('#schBtn').isVisible()));
  ok('the composer says Type a message', (await page.locator('#msg').getAttribute('placeholder')) === 'Type a message');
  ok('send is off until something is typed', await page.locator('#sendBtn').isDisabled());

  section('Laptop: what was added back');
  await page.locator('#addrSave').click();
  await page.waitForTimeout(300);
  const g = posted.find((p) => p.path === '/api/meta' && p.body.garage);
  ok('Save puts the address on file and keeps the car', g && g.body.garage.address === '123 Maple St, Snohomish' && g.body.garage.vehicles.length === 1, g);
  ok('a saved address turns into Directions', /Directions/.test(await page.locator('#addr').innerText()) && /google\.com\/maps\/dir/.test(await page.locator('#addr a').getAttribute('href')));

  await page.locator('#msg').fill('ya sat 7 works');
  ok('typing shows Polish and Schedule', await page.locator('#polBtn').isVisible() && await page.locator('#schBtn').isVisible());
  await page.locator('#polBtn').click();
  await page.waitForTimeout(300);
  const pol = posted.find((p) => p.path === '/api/ai/draft');
  ok('Polish sends his words for that chat', pol && pol.body.text === 'ya sat 7 works' && pol.body.phone === '+14255550301', pol);
  ok('the polished text replaces his', (await page.locator('#msg').inputValue()) === 'Yes, Saturday at 7 AM works. See you then!');
  await page.locator('#snackAct').click();
  ok('Undo puts his words back', (await page.locator('#msg').inputValue()) === 'ya sat 7 works');

  await page.locator('#schBtn').click();
  const opts = await page.locator('#pop button').allInnerTexts();
  ok('schedule offers the quick times and a picker', opts[0] === 'In 1 hour' && opts.includes('Tomorrow, 9:00 AM') && opts[opts.length - 1] === 'Pick date & time', opts);
  await page.locator('#pop button', { hasText: 'Tomorrow, 9:00 AM' }).click();
  await page.waitForTimeout(300);
  const sch = posted.find((p) => p.path === '/api/schedule');
  const t9 = new Date(now + D); t9.setHours(9, 0, 0, 0);
  ok('it schedules that text for tomorrow at 9', sch && sch.body.body === 'ya sat 7 works' && sch.body.sendAt === t9.getTime(), sch);
  ok('the box clears and nothing was sent', (await page.locator('#msg').inputValue()) === '' && !posted.some((p) => p.path === '/api/send'));
  await page.locator('[data-sch="s1"]').click();
  await page.locator('#pop button', { hasText: 'Cancel scheduled message' }).click();
  await page.waitForTimeout(300);
  ok('a scheduled text can be canceled', posted.some((p) => p.path === '/api/unschedule' && p.body.id === 's1'));

  await page.locator('#msg').fill('Yes, 1 PM works');
  await page.locator('#msg').press('Enter');
  await page.waitForTimeout(400);
  const sent = posted.find((p) => p.path === '/api/send');
  ok('Enter sends it to that number', sent && sent.body.phone === '+14255550301' && sent.body.body === 'Yes, 1 PM works', sent);
  ok('the box clears after it sends', (await page.locator('#msg').inputValue()) === '');
  ok('the sent text shows in the chat', /Yes, 1 PM works/.test(await page.locator('#tl').innerText()));

  await page.locator('#paneMore').click();
  const items = await page.locator('#pop button').allInnerTexts();
  ok('the ⋮ menu has Archive, Edit name and Mark as unread', items.join() === 'Archive,Edit name,Mark as unread', items);
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
  ok('the menu has Archive and a way back to the dashboard', /Archive/.test(dr) && /Dashboard/.test(dr));
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

section('Laptop: the second batch he picked');
{
  const { ctx, page, errs, posted } = await open({ width: 1280, height: 800 });
  await page.locator('[data-open="+14255550301"]').click();
  await page.waitForTimeout(500);
  const heart = page.locator('#tl .gv-b.tapped', { hasText: 'Hi Dana, it is Mikey' });
  ok('a tapback is drawn on the text it was for', (await heart.count()) === 1 && /❤️/.test(await heart.locator('.gv-tap').innerText()));
  ok('and is not a bubble of its own', (await page.locator('#tl .gv-b', { hasText: 'Loved' }).count()) === 0);

  await page.locator('#tl img.gv-img').click();
  await page.waitForTimeout(150);
  ok('a photo opens full screen', await page.locator('#lightbox').isVisible() && (await page.locator('#lightbox img').getAttribute('src')) === '/i/abc123');
  await page.keyboard.press('Escape');
  ok('Escape closes it', (await page.locator('#lightbox').count()) === 0);

  const ops = await page.locator('#ops button').allInnerTexts();
  ok('his usual openers sit over an empty box', ops.join() === 'Hey,Sounds good', ops);
  await page.locator('#ops button', { hasText: 'Hey' }).click();
  ok('tapping one starts the text with it', (await page.locator('#msg').inputValue()) === 'Hey ');
  await page.locator('#msg').fill('Hey there');
  await page.waitForTimeout(50);
  ok('they get out of the way mid-sentence', (await page.locator('#ops button').count()) === 0);

  ok('a picked-up name says where it came from', /Name picked up from their texts/.test(await page.locator('#nameNote').innerText()));
  await page.locator('#nameOk').click();
  await page.waitForTimeout(250);
  ok('Looks right saves it as his', posted.some((p) => p.path === '/api/meta' && p.body.phone === '+14255550301' && p.body.name === 'Dana Fox'));

  await page.locator('#msg').fill('half typed');
  await page.locator('#msg').dispatchEvent('input');
  await page.locator('[data-open="+14255550302"]').click();
  await page.waitForTimeout(400);
  const drRow = await page.locator('[data-open="+14255550301"]').innerText();
  ok('the half-typed text shows as a Draft on its row', /Draft:\s*half typed/.test(drRow), [drRow, await page.evaluate(() => localStorage.getItem('gv-drafts'))]);
  ok('a chat with no name offers Add a name', await page.locator('#addName').isVisible());
  page.once('dialog', (d) => d.accept('Pat Lee'));
  await page.locator('#addName').click();
  await page.waitForTimeout(300);
  ok('Add a name saves it', posted.some((p) => p.path === '/api/meta' && p.body.phone === '+14255550302' && p.body.name === 'Pat Lee') && (await page.locator('#whoName').innerText()) === 'Pat Lee');
  await page.locator('[data-open="+14255550301"]').click();
  await page.waitForTimeout(400);
  ok('going back to the chat brings the draft back', (await page.locator('#msg').inputValue()) === 'half typed');
  ok('no errors on the page', errs.length === 0, errs);
  await ctx.close();
}

section('The dashboard opens on this screen (index.html)');
{
  const idx = read('index.html');
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 } });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: idx });
    if (u.pathname === '/voice') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>voice</title><p>voice</p>' });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  const go = async (path) => { await page.goto('https://dash.example' + path); await page.waitForTimeout(400); return new URL(page.url()); };
  ok('opening the dashboard lands on the Google Voice screen', (await go('/')).pathname === '/voice');
  const c = await go('/?c=%2B14255550301');
  ok('a text alert opens that chat there', c.pathname === '/voice' && c.search === '?c=%2B14255550301', c.href);
  ok('the "people waiting" link stays on the dashboard', (await go('/?waiting=1')).pathname === '/');
  ok('so does a money link', (await go('/?money=1')).pathname === '/');
  ok('?classic=1 (the Dashboard row) stays on the dashboard', (await go('/?classic=1')).pathname === '/');
  await page.evaluate(() => document.querySelector('.navitem[data-tab="messages"]').click());
  await page.waitForTimeout(400);
  ok('tapping Chats there goes to the Google Voice screen', new URL(page.url()).pathname === '/voice', page.url());
  ok('a test host never moves (the other suites load index.html on *.test)', /\.test\$/.test(idx) && /mkd-voice-home/.test(idx));
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 412, height: 880 } });
  const p2 = await ctx2.newPage();
  await p2.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: idx });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await p2.goto('https://dash.example/?classic=1');
  await p2.evaluate(() => { localStorage.setItem('mkd-voice-home', '0'); sessionStorage.clear(); });
  await p2.goto('https://dash.example/');
  await p2.waitForTimeout(400);
  ok('switched off in Settings, the dashboard opens as before', new URL(p2.url()).pathname === '/', p2.url());
  await ctx2.close();
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
