// Their before and after, in a real browser: on the customer's after page, and
// the Jobs board button that sends it.
//
// The after page is what a customer opens off his "thanks for having me out"
// text, on a phone, with a thumb. What's held here is that the pair actually
// works there, not just that the markup is present:
//   · both shots load through the customer's own photo route
//   · the divider follows a drag, jumps to a tap, and moves with the keyboard
//   · a thumb scrolling the page still scrolls it (pan-y), not the divider
//   · "Save the photos" hands the phone's share sheet both files, by name, and
//     downloads them where there's no share sheet for files
//   · on the Jobs board, a finished job's photos go out as the after link, into
//     the box, never sent
//
//   npm install && node test/afterpage.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// ---- the worker, in-process, the way prepost.test.js loads it --------------
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });
const M = new Function('__env__', src + '\n; ENV = __env__; return { custTokenFor, custSubPage, custPhoto, apiCustAction, apiRatePick, apiRateFeedback, loadThread, saveThread, updateIndexEntry,' +
  ' __reset(){ resetInvocationCaches(); BCFG_CACHE = null; } };')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c', DETECT_DISABLED: '1', PUBLIC_BASE_URL: 'https://texting.test' });
store.set('config', JSON.stringify({ reviewUrl: 'https://g.page/r/mikey-review' })); M.__reset();

const NOW = Date.now(), H = 3600000;
const PIA = '+14255550904';
// A real JPEG (the stock preview car), so the browser has something to decode.
const JPG = fs.readFileSync(new URL('../public/og-car.jpg', import.meta.url)).toString('base64');
{
  const t = await M.loadThread(PIA);
  t.name = 'Pia Hart'; t.messages = [{ id: 'm', dir: 'in', body: 'thanks!', ts: NOW - H }];
  t.garage = { vehicles: [], address: '1425 Cedar Ave', city: 'Everett' };
  t.lastJob = { at: NOW - 2 * H, service: 'Full Detail', jobId: 'b:bkPIA' };
  await M.saveThread(t); await M.updateIndexEntry(t);
  store.set('ph:img:piabefore01', 'data:image/jpeg;base64,' + JPG);
  store.set('ph:img:piaafter001', 'data:image/jpeg;base64,' + JPG);
  store.set('ph:idx:b:bkPIA', JSON.stringify([{ id: 'piabefore01', phase: 'before', ts: NOW - 5 * H }, { id: 'piaafter001', phase: 'after', ts: NOW - 2 * H }]));
}
const TOK = await M.custTokenFor(PIA);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];
const actions = [];
async function customerPage(init) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host !== 'texting.test') return route.fulfill({ status: 204, body: '' });   // fonts, the review link
    const m = /^\/(before|after|friend)\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
    const ph = /^\/ph\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)$/.exec(u.pathname);
    let res;
    if (m) res = await M.custSubPage(m[1], m[2]);
    else if (ph) res = await M.custPhoto(ph[1], ph[2]);
    else if (u.pathname === '/api/rate/pick' || u.pathname === '/api/rate/feedback') {
      const body = JSON.parse(route.request().postData() || '{}'); actions.push(Object.assign({ path: u.pathname }, body));
      const fn = u.pathname === '/api/rate/pick' ? M.apiRatePick : M.apiRateFeedback;
      res = await fn({ json: async () => body });
    } else if (u.pathname === '/api/cust/action') {
      const body = JSON.parse(route.request().postData() || '{}'); actions.push(body);
      res = await M.apiCustAction({ json: async () => body }, u);
    } else return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  await page.goto('https://texting.test/after/' + TOK);
  await page.waitForFunction(() => [...document.querySelectorAll('.ba img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  return { ctx, page };
}
const split = (page) => page.evaluate(() => parseFloat(document.getElementById('ba').style.getPropertyValue('--split')));

section('The after page: their before and after, working');
{
  const { ctx, page } = await customerPage(null);
  ok('both shots load through their own photo route', await page.evaluate(() => {
    const im = [...document.querySelectorAll('#ba img')];
    return im.length === 2 && im.every((i) => i.naturalWidth > 0 && /\/ph\//.test(i.src));
  }));
  ok('the frame takes the after shot\'s shape (a wide shot, held to 16:9)', await page.evaluate(() => {
    const r = document.getElementById('ba').getBoundingClientRect(); return Math.abs(r.width / r.height - 1.78) < 0.03;
  }), await page.evaluate(() => getComputedStyle(document.getElementById('ba')).aspectRatio));
  ok('a thumb scrolling the page still scrolls it', await page.evaluate(() => getComputedStyle(document.getElementById('ba')).touchAction) === 'pan-y');
  ok('it starts halfway', await split(page) === 50);

  const box = await page.locator('#ba').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.5, y); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, y, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 4 }); await page.mouse.up();
  let s = await split(page);
  ok('dragging moves the divider with the pointer', Math.abs(s - 20) < 2, s);
  const clip = await page.evaluate(() => getComputedStyle(document.querySelector('#ba .aft')).clipPath);
  ok('…the after shot is cut exactly there', Math.abs(parseFloat((/([\d.]+)%\)$/.exec(clip) || [])[1]) - s) < 0.01, clip);
  await page.mouse.click(box.x + box.width * 0.8, y);
  s = await split(page);
  ok('a tap jumps it there', Math.abs(s - 80) < 2, s);
  await page.locator('#baRange').focus();
  ok('the keyboard can reach it, and the frame shows focus', await page.evaluate(() => document.activeElement.id === 'baRange' && document.getElementById('ba').matches(':focus-within')));
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  s = await split(page);
  ok('arrow keys move it', s === 75, s);

  // No share sheet for files here (a desktop): they download instead, named.
  await page.evaluate(() => { try { Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); } catch (_) {} });
  const got = [];
  page.on('download', (d) => got.push(d.suggestedFilename()));
  await page.locator('#savePics').click();
  await page.waitForTimeout(1200);
  ok('with no share sheet, both photos download, named', got.sort().join(',') === 'detail-after.jpg,detail-before.jpg', got);
  ok('the tap is counted for Mikey', actions.some((a) => a.action === 'tap' && a.kind === 'after' && a.name === 'photos'), actions);
  ok('the page counted itself opened (script, never the GET)', actions.some((a) => a.action === 'seen' && a.kind === 'after'));
  await ctx.close();
}

section('The stars: open, never gated');
{
  const { ctx, page } = await customerPage(null);
  ok('five stars on the job card, nothing else open yet', await page.locator('[data-star]').count() === 5 &&
    !(await page.locator('#rtGoogle').isVisible()) && !(await page.locator('#rtForm').isVisible()));
  await page.locator('[data-star="3"]').click(); await page.waitForTimeout(400);
  ok('three stars: "Tell me straight" opens, ready to type', await page.locator('#rtForm').isVisible() && await page.evaluate(() => document.activeElement.id === 'rtText'));
  ok('…with the Google link right there too (nobody kept from Google)', await page.locator('#rtForm a[href="https://g.page/r/mikey-review"]').isVisible());
  ok('…and three stars lit', await page.locator('[data-star].lit').count() === 3);
  ok('the tap is counted on his star page', actions.some((a) => a.path === '/api/rate/pick' && a.stars === 3 && a.from === 'after' && a.token === TOK));
  await page.locator('#rtSend').click(); await page.waitForTimeout(300);
  ok('an empty note asks for a line first', /Write a line or two/.test(await page.locator('#rtMsg').innerText()));
  await page.locator('#rtText').fill('Water spots on the hood');
  await page.locator('#rtSend').click(); await page.waitForTimeout(600);
  ok('sent: the thanks shows, the form goes', await page.locator('#rtDone').isVisible() && !(await page.locator('#rtForm').isVisible()));
  ok('…still offering Google after', await page.locator('#rtDone a[href="https://g.page/r/mikey-review"]').isVisible());
  ok('…and it reached him, on their conversation notes', /3★ from their after page: Water spots on the hood/.test((await M.loadThread(PIA)).notes || ''));
  await page.locator('[data-star="5"]').click(); await page.waitForTimeout(400);
  ok('five stars: the thank-you and the Google button', await page.locator('#rtGoogle').isVisible() &&
    /Post it on Google/.test(await page.locator('#rtGoogle').innerText()) && await page.locator('#rtGoogle a[href="https://g.page/r/mikey-review"]').count() === 1);
  await ctx.close();
}

section('"Save the photos" on a phone: the share sheet, with both files in it');
{
  // A phone's share sheet, recorded rather than opened.
  const { ctx, page } = await customerPage(() => {
    window.__shared = null;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!(d && d.files && d.files.length) });
    Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => {
      window.__shared = (d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })); return Promise.resolve(); } });
  });
  await page.waitForFunction(() => typeof PICS !== 'undefined' && PICS && PICS.length === 2, null, { timeout: 5000 }).catch(() => {});
  await page.locator('#savePics').click();
  await page.waitForTimeout(300);
  const sh = await page.evaluate(() => window.__shared);
  ok('both photos, before first, as real JPEG files', !!sh && sh.length === 2 && sh[0].name === 'detail-before.jpg' && sh[1].name === 'detail-after.jpg' &&
    sh.every((f) => f.type === 'image/jpeg' && f.size > 1000), sh);
  await ctx.close();
}

// ---- the Jobs board: the button that sends it ------------------------------
section('The Jobs board: a finished job\'s photos go out as the after link');
{
  const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  const JOBS = [
    { id: 'b:bkPIA', source: 'booking', phone: PIA, name: 'Pia Hart', service: 'Full Detail', slot: '09:00', at: NOW - 6 * H, durationMin: 240,
      price: 339, state: 'done', startedAt: NOW - 6 * H, doneAt: NOW - 2 * H, photos: 2, address: '1425 Cedar Ave', city: 'Everett', mapQuery: '1425 Cedar Ave, Everett, WA' },
    { id: 'b:bkRAY', source: 'booking', phone: '+14255550911', name: 'Ray Stone', service: 'Exterior Detail', slot: '14:00', at: NOW + 2 * H, durationMin: 150,
      price: 160, state: 'onsite', startedAt: NOW - H, photos: 2, address: '9 Elm St', city: 'Monroe', mapQuery: '9 Elm St, Monroe, WA' },
  ];
  const PHOTOS = { 'b:bkPIA': [{ id: 'p1', phase: 'before', ts: NOW - 5 * H }, { id: 'p2', phase: 'after', ts: NOW - 2 * H }],
    'b:bkRAY': [{ id: 'p3', phase: 'before', ts: NOW - H }, { id: 'p4', phase: 'after', ts: NOW - 0.5 * H }] };
  const AFTER = 'Thanks for having me out, Pia. Your before and after is up, and how to look after it: https://texting.test/after/tokPIA';
  const thread = (phone, name) => ({ phone, name, status: 'won', tags: [], scheduled: [], linked: [], notes: '',
    messages: [{ id: 'm1', dir: 'in', body: 'thanks!', ts: NOW - H }] });
  const THREADS = { [PIA]: thread(PIA, 'Pia Hart'), '+14255550911': thread('+14255550911', 'Ray Stone') };
  const rows = Object.values(THREADS).map((t) => ({ phone: t.phone, name: t.name, lastTs: NOW - H, unread: 0, tags: [], lastDir: 'in', lastBody: 'thanks!', status: 'won' }));
  const sent = [], linkAsks = [];
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR (dashboard): ' + e.message));
  await page.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (_) { return {}; } };
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (p === '/api/threads') { const w = u.searchParams.get('phone'); const o = { ok: true, threads: rows, config: {} }; if (w) o.thread = THREADS[w]; return json(o); }
    if (p === '/api/thread') return json({ ok: true, thread: THREADS[u.searchParams.get('phone')] });
    if (p === '/api/day') return json({ ok: true, date: today, jobs: JOBS, manual: [], order: [],
      summary: { total: 2, done: 1, remaining: 1, booked: 499, earned: 339, hours: 6.5 } });
    if (p === '/api/photos') return json({ ok: true, job: u.searchParams.get('job'), photos: PHOTOS[u.searchParams.get('job')] || [] });
    if (p === '/api/photos/img') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(JPG, 'base64') });
    if (p === '/api/cust/link') { const b = body(); linkAsks.push(b); if (b.text) sent.push(b);
      return json({ ok: true, url: 'https://texting.test/c/tokPIA', links: {}, drafts: { after: AFTER, before: 'b', friend: 'f', book: 'c' }, saved: {}, texted: false }); }
    if (p === '/api/send') { sent.push(body()); return json({ ok: true }); }
    if (p === '/api/money') return json({ ok: true, month: '2026-09', today, entries: [], nudges: [], owed: [], summary: {}, config: {} });
    if (p === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
    if (p === '/api/version') return json({ ok: true, build: 'test' });
    if (p.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto('https://texting.test/');
  await page.waitForTimeout(1200);
  await page.locator('.navitem[data-tab="work"]').click();
  await page.waitForTimeout(900);

  await page.locator('[data-jdmore="b:bkRAY"]').click();
  await page.waitForTimeout(700);
  let sheet = await page.locator('#jdSheet').innerText();
  ok('a job still going: text them, and a note on what marking it done does', /Text these to the customer/.test(sheet) && /Mark the job done and these go on their after page/.test(sheet), sheet.slice(0, 400));
  await page.locator('#jdSheet [data-jsact="close"]').click();
  await page.waitForTimeout(400);

  await page.locator('[data-jdmore="b:bkPIA"]').click();
  await page.waitForTimeout(700);
  sheet = await page.locator('#jdSheet').innerText();
  ok('a finished job: send their after link, which has these on it', /Send their after link \(these are on it\)/.test(sheet) && !/Mark the job done/.test(sheet), sheet.slice(0, 400));
  await page.locator('#jdSheet [data-basend="link"]').click();
  await page.waitForTimeout(1200);
  ok('it opens Pia\'s conversation', await page.evaluate(() => document.body.classList.contains('viewing')));
  ok('…with the after text in the box', (await page.locator('#msgInput').inputValue()) === AFTER, await page.locator('#msgInput').inputValue());
  ok('…asked for Pia\'s links, not someone else\'s', linkAsks.length === 1 && linkAsks[0].phone === PIA && !linkAsks[0].text, linkAsks);
  ok('NOTHING was sent', sent.length === 0, sent);
  ok('the "Job done" banner stands down: it is already in the box', !(await page.locator('#linkBanner').isVisible()));
  await page.close();
}

section('nothing threw');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
