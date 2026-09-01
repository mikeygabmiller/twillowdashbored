// Sending a photo, driven through the real dashboard in a headless phone.
//
// The whole feature is a promise about effort: attaching a picture costs one tap
// and sending it costs the same tap Send always cost. Each check here is one way
// that promise used to be breakable —
//
//   - the camera is ON the compose row, not buried in a sheet;
//   - the photo uploads while he's still typing, so Send never waits;
//   - a photo with no words is a whole message (the send button used to no-op);
//   - the bubble shows the picture the instant it's queued, from the local copy;
//   - undo puts the photo back on the tray, not in the bin;
//   - attachments belong to the conversation — switching threads can't lose one.
//
//   npm install && node test/photo.ui.test.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let chromium, devices;
try { ({ chromium, devices } = await import('playwright-core')); }
catch { console.error('playwright-core is missing — run `npm install` first.'); process.exit(2); }

const ROOT = path.join(__dirname, '..', 'public');
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html' : 'text/javascript' });
  res.end(fs.readFileSync(f));
});

const THREADS = [
  { phone: '+15551110000', name: 'Dave',  messages: [{ id: 'd1', dir: 'in', body: 'what does the paint look like after?', ts: Date.now() }], unread: 0, ts: Date.now() },
  { phone: '+15552220000', name: 'Sarah', messages: [{ id: 's1', dir: 'in', body: 'how much for an SUV?', ts: Date.now() }], unread: 0, ts: Date.now() },
  // A text that went out with a photo on it and didn't land. Resend has to put
  // BOTH back on the wire.
  { phone: '+15553330000', name: 'Kev', unread: 0, ts: Date.now(), messages: [
    { id: 'k1', dir: 'out', body: 'one more angle', ts: Date.now(), kind: 'manual', status: 'failed',
      error: 'Not sent — tap Resend', media: [{ url: '/i/kevAAAAAAAAAAAAAAAAAAA', type: 'image/jpeg' }] },
  ] },
];

// A real 1x1 PNG, so the browser's decoder has something it will actually load.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

(async () => {
  await new Promise(r => server.listen(8801, '127.0.0.1', r));
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ ...devices['Galaxy S9+'], viewport: { width: 360, height: 780 } });
  const page = await ctx.newPage();
  const sends = [], uploads = [];
  const errs = [];
  let uploadHold = null;          // set to a promise to stall the upload on purpose
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());

  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    let posted = {};
    try { posted = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    if (u.pathname === '/api/send-photo') {
      uploads.push({ type: posted.type, len: (posted.data || '').length });
      if (uploadHold) await uploadHold;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 'tok' + uploads.length + 'AAAAAAAAAAAAAAAAAA', url: '/i/tok' + uploads.length + 'AAAAAAAAAAAAAAAAAA', type: 'image/jpeg' }) });
    }
    if (u.pathname === '/api/send') {
      sends.push(posted);
      const t = THREADS.find(x => x.phone === posted.phone);
      t.messages.push({ id: 'm' + sends.length, dir: 'out', body: posted.body, ts: Date.now(),
        kind: 'manual', status: 'sent', media: (posted.media || []).map(url => ({ url, type: 'image/jpeg' })) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, thread: t }) });
    }
    const phone = u.searchParams.get('phone') || posted.phone;
    const body = { ok: true, threads: THREADS };
    if (phone) body.thread = THREADS.find(t => t.phone === phone);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // The photo bytes themselves are served by the Worker at /i/<id>; here they are
  // whatever the fake needs them to be.
  await page.route('**/i/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  await page.goto('http://127.0.0.1:8801/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.keyboard.type('1234'); await page.keyboard.press('Enter');
  await page.waitForTimeout(700);

  const open = async (who) => {
    if (await page.evaluate(() => document.body.classList.contains('viewing'))) {
      await page.locator('#backBtn').click(); await page.waitForTimeout(250);
    }
    await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(300);
    await page.getByText(who, { exact: true }).first().click(); await page.waitForTimeout(450);
  };
  const attach = async (n) => {
    await page.locator('#photoInput').setInputFiles(
      Array.from({ length: n || 1 }, (_, i) => ({ name: `shot${i}.png`, mimeType: 'image/png', buffer: PNG })));
  };
  const trayCount = () => page.locator('#attTray .att').count();

  // -------------------------------------------------------------------------
  console.log('\n=== the camera is on the compose row, not behind a menu ===');
  await open('Dave');
  check('one visible tap away', await page.locator('#photoBtn').isVisible(), true);
  check('it sits with the message box, left of Send', await page.evaluate(() => {
    const row = document.querySelector('.crow');
    return !!(row && row.querySelector('#photoBtn') && row.querySelector('#sendBtn'));
  }), true);

  // -------------------------------------------------------------------------
  console.log('\n=== attaching uploads it right away, before Send is ever pressed ===');
  await attach(1);
  await page.waitForTimeout(900);
  check('the photo is on the tray', await trayCount(), 1);
  check('and it already went up', uploads.length, 1);
  check('shrunk on the way — sent as a JPEG, not the original', uploads[0].type, 'image/jpeg');
  check('the counter says MMS, not a segment count',
    (await page.locator('#charCount').textContent()).trim(), '1 photo · MMS');
  check('no send happened yet', sends.length, 0);

  // -------------------------------------------------------------------------
  console.log('\n=== a photo with no words is a whole message ===');
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(300);
  check('the bubble is there before the round trip', await page.evaluate(() =>
    !!document.querySelector('#messages .bubble.out .msg-img')), true);
  check('drawn from the copy already in the browser', await page.evaluate(() => {
    const im = document.querySelector('#messages .bubble.out .msg-img');
    return im ? im.getAttribute('src').slice(0, 11) : '';
  }), 'data:image/');
  check('the tray is clear', await trayCount(), 0);
  await page.waitForTimeout(11000);  // the app holds a queued text for UNDO_MS (10s) so it can be taken back
  check('it sent', sends.length, 1);
  check('with no words at all', sends[0].body, '');
  check('and the photo named by URL, never by bytes', sends[0].media, ['/i/tok1AAAAAAAAAAAAAAAAAA']);
  check('the delivered bubble loads straight from /i/, no proxy', await page.evaluate(() => {
    const im = [...document.querySelectorAll('#messages .bubble.out .msg-img')].pop();
    return im ? new URL(im.src).pathname.slice(0, 3) : '';
  }), '/i/');

  // -------------------------------------------------------------------------
  console.log('\n=== words and a photo go out as one text ===');
  await page.locator('#msgInput').fill('here you go — same truck, after');
  await attach(1);
  await page.waitForTimeout(900);
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(11000);
  check('one message, not two', sends.length, 2);
  check('the words are on it', sends[1].body, 'here you go — same truck, after');
  check('so is the photo', sends[1].media.length, 1);
  check('the box is empty again', await page.locator('#msgInput').inputValue(), '');

  // -------------------------------------------------------------------------
  console.log('\n=== send waits for a slow upload rather than dropping it ===');
  let release;
  uploadHold = new Promise(r => { release = r; });
  await attach(1);
  await page.waitForTimeout(400);
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(500);
  check('nothing goes out while the photo is still climbing', sends.length, 2);
  release();
  await page.waitForTimeout(11500);
  check('and it goes the moment the photo lands', sends.length, 3);
  check('with the photo on it', sends[2].media.length, 1);
  uploadHold = null;

  // -------------------------------------------------------------------------
  console.log('\n=== undo hands the photo back, it does not bin it ===');
  await attach(1);
  await page.waitForTimeout(900);
  const upsAtUndo = uploads.length;
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(400);
  await page.locator('#toast .undo').click();
  await page.waitForTimeout(400);
  check('no fourth send', sends.length, 3);
  check('the photo is back on the tray', await trayCount(), 1);
  check('and it is not re-uploaded — it never left', uploads.length, upsAtUndo);

  // -------------------------------------------------------------------------
  console.log('\n=== an attachment belongs to the conversation ===');
  await open('Sarah');
  check("Sarah's tray is her own", await trayCount(), 0);
  await open('Dave');
  check("Dave's photo is still waiting where he left it", await trayCount(), 1);
  await page.locator('#attTray .att .x').first().click();
  await page.waitForTimeout(200);
  check('and the x takes it off', await trayCount(), 0);
  check('the counter goes quiet again', (await page.locator('#charCount').textContent()).trim(), '');

  // -------------------------------------------------------------------------
  console.log('\n=== a photo he has already sent goes out again with no upload ===');
  const before = uploads.length;
  // Right-click is the desktop way in; on a phone it's press-and-hold. Same sheet.
  await page.locator('#photoBtn').click({ button: 'right' });
  await page.waitForTimeout(350);
  check('the ones he sent before are offered', await page.locator('#jdSheet .rc-grid button').count() > 0, true);
  await page.locator('#jdSheet .rc-grid button').first().click();
  await page.waitForTimeout(300);
  check('it lands on the tray', await trayCount(), 1);
  check('with nothing uploaded — it is already up there', uploads.length, before);
  await page.locator('#sendBtn').click();
  await page.waitForTimeout(11000);
  check('and it sends by URL', (sends[3].media || []).length, 1);

  // -------------------------------------------------------------------------
  console.log('\n=== a failed send resends the photo, not just the words ===');
  // Resend used to take only the body. A text that failed WITH a photo on it
  // would go back out as bare words — the half that mattered silently dropped.
  await open('Kev');
  const failedAt = sends.length;
  check('the bubble offers a resend', await page.locator('#messages .resend').count() > 0, true);
  await page.locator('#messages .resend').last().click();
  await page.waitForTimeout(700);
  check('it went back out', sends.length, failedAt + 1);
  check('with the words', sends[failedAt].body, 'one more angle');
  check('and the photo still on it', sends[failedAt].media, ['/i/kevAAAAAAAAAAAAAAAAAAA']);

  console.log('\n=== nothing threw ===');
  check('no page errors', errs, []);

  await b.close(); server.close();
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
})();
