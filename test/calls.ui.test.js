// The Calls screen — the phone half of the business, which until now lived in
// Google Voice because this app had nowhere to put it.
//
// What's actually being guarded here is that a missed call is RECOVERABLE in one
// tap. Google Ads sends people who ring once and never ring again; if the row
// doesn't show who it was, what they said, and a button to call them back, the
// screen has failed at the only job it has.
//
// Driven in a real browser because every claim below is about rendered rows and
// what happens when you tap them.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const CALLS = [
  { id: 'c1', sid: 'CA1', from: '+14255551234', fromNorm: '+14255551234', name: 'Jenna Smith',
    ts: now - 5 * 60000, outcome: 'voicemail', vmSec: 22,
    recording: 'https://api.twilio.com/rec1.mp3', recordingSid: 'RE1',
    transcript: 'Hey Mikey, saw your ad — looking for a full detail on my truck this weekend.' },
  { id: 'c2', sid: 'CA2', from: '+14255559999', fromNorm: '+14255559999', name: '',
    ts: now - 30 * 60000, outcome: 'missed', dialStatus: 'no-answer' },
  { id: 'c3', sid: 'CA3', from: '+14255558888', fromNorm: '+14255558888', name: 'Dave Reyes',
    ts: now - 3 * 3600000, outcome: 'answered', talkSec: 134 },
  { id: 'c4', sid: 'CA4', from: '+18005551212', fromNorm: '+18005551212', name: '',
    ts: now - 5 * 3600000, outcome: 'screened' },
  { id: 'c5', sid: 'CA5', from: '+14255557777', fromNorm: '+14255557777', name: '',
    ts: now - 20 * 3600000, outcome: 'voicemail', vmSec: 9,
    recording: 'https://api.twilio.com/rec5.mp3', recordingSid: 'RE5', transcriptFailed: true },
];

const thread = {
  phone: '+14255551234', name: 'Jenna Smith', tags: [], status: 'active', unread: 0,
  messages: [{ id: 'm1', dir: 'in', body: 'sounds good', ts: now - 60000 }],
  scheduled: [], linked: [], notes: '',
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const posted = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (req.method() === 'POST') { let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* form post */ } posted.push({ path, body: b }); }
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/calls') return json({ ok: true, calls: CALLS, seenTs: now - 60 * 60000, unseen: 2, forwardTo: '+14252321355', screening: true });
  if (path === '/api/threads') {
    const row = { phone: thread.phone, name: thread.name, status: 'active', unread: 0, lastBody: 'sounds good', lastTs: now, tags: [] };
    const out = { ok: true, threads: [row], config: {} };
    if (u.searchParams.get('phone')) out.thread = thread;
    return json(out);
  }
  if (path === '/api/money') {
    return json({ ok: true, month: '2026-08', today: '2026-08-30', entries: [], nudges: [], owed: [],
      summary: { net: 0, gross: 0, costs: 0, jobs: 0 }, config: {} });
  }
  if (path === '/api/day') return json({ ok: true, date: '2026-08-30', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
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
const rows = () => page.locator('#scroll .callrow');
const rowText = async (i) => (await rows().nth(i).innerText()).replace(/\s+/g, ' ');
const filter = async (name) => { await page.locator('#scroll .callfilters .cf', { hasText: name }).first().click(); await page.waitForTimeout(300); };

section('Calls is one tap away, and it says where the phone rings');
ok('the tab is in the bottom nav', await page.locator('.navitem[data-tab="calls"]').isVisible());
// The badge is the whole reason it can be a background screen: two things need
// you (a voicemail and a missed call) and it says so before you open anything.
ok('unheard calls badge the tab', (await page.locator('#navCalls').textContent()) === '2');
await page.locator('.navitem[data-tab="calls"]').click();
await page.waitForTimeout(700);
const head = (await page.locator('#scroll .callhead').innerText()).replace(/\s+/g, ' ');
ok('the header names the handset that rings', /\(425\) 232-1355/.test(head), head);
ok('and explains what happens when you miss it', /voicemail/i.test(head), head);
ok('opening the screen marks it read', posted.some((p) => p.path === '/api/calls/seen'));
ok('and the badge clears', (await page.locator('#navCalls').getAttribute('class')) === 'ndot');

section('Every call is a row you can read at arm’s length');
ok('all five calls are listed', (await rows().count()) === 5, await rows().count());
const r0 = await rowText(0);
ok('a voicemail is named as one', /VOICEMAIL/i.test(r0), r0);
ok('the caller is a person, not a +1', /Jenna Smith/.test(r0), r0);
// The transcript is the thing Google Voice did better. It is the point.
ok('the transcript is on the row, unopened', /full detail on my truck/.test(r0), r0);
ok('and the recording is playable right there', (await rows().nth(0).locator('audio').count()) === 1);
ok('the player goes through the authed media proxy',
  /\/api\/media\?u=/.test(await rows().nth(0).locator('audio').getAttribute('src')));
ok('a missed call says missed', /MISSED/i.test(await rowText(1)), await rowText(1));
ok('an unknown caller still shows a readable number', /\(425\) 555-9999/.test(await rowText(1)));
ok('an answered call reports how long you talked', /2:14/.test(await rowText(2)), await rowText(2));
// A transcript that never came must not sit there implying it still might.
ok('a failed transcript says so instead of spinning forever',
  /No transcript/i.test(await rowText(4)), await rowText(4));

section('Filters get you to the one thing you care about');
await filter('Voicemail');
ok('voicemail only', (await rows().count()) === 2, await rows().count());
await filter('Missed');
ok('missed only', (await rows().count()) === 1, await rows().count());
await filter('Needs you');
ok('“needs you” is the missed ones and the voicemails', (await rows().count()) === 3, await rows().count());
await filter('Screened');
ok('and the robo-dialers are filed separately', (await rows().count()) === 1, await rows().count());
const spam = await rowText(0);
ok('a screened call is labelled, not hidden', /SCREENED/i.test(spam), spam);
// Nothing on this screen should make it easy to ring a robo-dialer back.
ok('and it is never offered a call-back button',
  (await rows().nth(0).locator('button[data-act="call"]').count()) === 0);
await filter('All');

section('A missed lead is recoverable in one tap');
page.on('dialog', (d) => d.accept());
await rows().nth(1).locator('button[data-act="call"]').click();
await page.waitForTimeout(400);
const call = posted.filter((p) => p.path === '/api/call').pop();
ok('call back rings your phone and bridges', !!call);
ok('and it dials the person who actually rang', call && call.body.phone === '+14255559999', call && call.body.phone);

await rows().nth(0).locator('button[data-act="text"]').click();
await page.waitForTimeout(800);
ok('texting back lands in that person’s conversation',
  (await page.locator('#chatHead').isVisible()) && /Jenna/.test(await page.locator('#chatHead').innerText()));

section('No page errors anywhere in that');
ok('clean console', errs.length === 0, errs.slice(0, 3));

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
await browser.close();
process.exit(fail ? 1 : 0);
