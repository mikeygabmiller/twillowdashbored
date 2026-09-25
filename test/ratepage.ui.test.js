// The star page (/rate): five stars to Google, one to four to a private note.
//
// An idea he's trying out, knowing Google calls it review gating and bans it.
// What's held here is that it can't reach a customer by accident, and that it
// does what it says when he tries it:
//   · off (the default) the public link is a dead page, but his preview works
//   · five stars lands on his Google review link, by itself
//   · one to four gets the private note, and the note is saved where he reads it
//   · gate mode never shows them Google; open mode keeps it one tap away
//   · a preview is never counted and never emails him; a real note does
//   · the dashboard screen says Google's rule before anything else, and the
//     switch saves what the Worker reads
//
//   node test/ratepage.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// ---- the worker, in-process, the way afterpage.ui.test.js loads it ---------
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
};
const mails = [];
globalThis.fetch = async (u, o) => {
  if (String(u).includes('resend')) { mails.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => '{}', json: async () => ({ id: 'e1' }) }; }
  return { ok: false, status: 404, text: async () => 'no', json: async () => ({}) };
};
const M = new Function('__env__', src + '\n; ENV = __env__; return { handle, custTokenFor, loadThread, saveThread, updateIndexEntry,' +
  ' __reset(){ resetInvocationCaches(); BCFG_CACHE = null; } };')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c', DETECT_DISABLED: '1', PUBLIC_BASE_URL: 'https://texting.test' });
const REVIEW = 'https://g.page/r/mikey-review';
const setCfg = (c) => { store.set('config', JSON.stringify(Object.assign({ reviewUrl: REVIEW }, c))); M.__reset(); };
setCfg({});

const PIA = '+14255550904';
{
  const t = await M.loadThread(PIA);
  t.name = 'Pia Hart'; t.messages = [{ id: 'm', dir: 'in', body: 'thanks!', ts: Date.now() }];
  await M.saveThread(t); await M.updateIndexEntry(t);
}
const TOK = await M.custTokenFor(PIA);
const log = () => JSON.parse(store.get('rate:log') || '{"tally":{},"google":0,"fb":[]}');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];
let wentTo = '';
async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.host === 'g.page') { wentTo = u.href; return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>google</p>' }); }
    if (u.host !== 'texting.test') return route.fulfill({ status: 204, body: '' });   // fonts
    const r = route.request();
    M.__reset();
    const res = await M.handle(new Request(u.href, { method: r.method(), headers: { 'Content-Type': 'application/json' },
      body: r.method() === 'POST' ? r.postData() : undefined }));
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  const resp = await page.goto('https://texting.test' + path);
  await page.waitForTimeout(200);
  return { ctx, page, status: resp.status() };
}

section('Off by default: the public link is a dead page, his preview is not');
{
  const a = await open('/rate');
  ok('a stranger opening /rate gets a 404', a.status === 404, a.status);
  ok('with no stars on it', await a.page.locator('[data-star]').count() === 0);
  await a.ctx.close();
  const b = await open('/rate?preview=1');
  ok('his preview renders the five stars', b.status === 200 && await b.page.locator('[data-star]').count() === 5, b.status);
  ok('and says it is a preview', /Preview/.test(await b.page.locator('#rtPrev').textContent()));
  await b.ctx.close();
}

section('A preview is never counted and never emails him');
{
  const { ctx, page } = await open('/rate?preview=1&mode=gate');
  await page.locator('[data-star="2"]').click();
  await page.locator('#rtText').fill('Missed the door jambs');
  await page.locator('#rtSend').click();
  await page.waitForTimeout(300);
  ok('the thank-you shows', await page.locator('#rtDone').isVisible());
  const l = log();
  ok('the note is saved, marked test', l.fb.length === 1 && l.fb[0].test === true && l.fb[0].stars === 2, l.fb);
  ok('no tap was counted', !Object.values(l.tally || {}).some(Boolean), l.tally);
  ok('no email went out', mails.length === 0, mails.length);
  await ctx.close();
}

section('Switched on, gate mode: one to four stars only ever see the note');
setCfg({ ratePage: { on: true, mode: 'gate' } });
store.delete('rate:log');
{
  const { ctx, page, status } = await open('/rate/' + TOK);
  ok('the link works now', status === 200, status);
  ok('it greets them by first name', /How did I do, Pia\?/.test(await page.locator('h1').textContent()));
  await page.locator('[data-star="4"]').hover();
  ok('hovering lights the stars up to that one', await page.locator('.rt-stars button.lit').count() === 4);
  ok('and names it', (await page.locator('#rtWord').textContent()) === 'Good');
  await page.locator('[data-star="3"]').click();
  await page.waitForTimeout(150);
  ok('three stars opens the private note', await page.locator('#rtForm').isVisible());
  ok('with no Google link anywhere on it', await page.locator('#rtForm a').count() === 0 && await page.locator('[data-google]').count() === 0);
  ok('Google card stays hidden', !(await page.locator('#rtGoogle').isVisible()));
  ok('no name box: the link already knows who they are', await page.locator('#rtName').count() === 0);
  await page.locator('#rtSend').click();
  ok('sending it empty asks for words first', /Write a line/.test(await page.locator('#rtMsg').textContent()));
  await page.locator('#rtText').fill('Streaks on the windshield');
  await page.locator('#rtSend').click();
  await page.waitForTimeout(300);
  const l = log();
  ok('the note is saved against them', l.fb[0] && l.fb[0].name === 'Pia Hart' && l.fb[0].phone === PIA && !l.fb[0].test, l.fb[0]);
  ok('the three was counted', l.tally[3] === 1, l.tally);
  ok('and it emailed him', mails.length === 1 && /3★ private note from Pia Hart/.test(mails[0].subject), mails.map((m) => m.subject));
  ok('with their words in it', mails.length === 1 && /Streaks on the windshield/.test(mails[0].text || mails[0].html));
  await ctx.close();
}

section('Five stars goes to his Google link by itself');
{
  wentTo = '';
  const { ctx, page } = await open('/rate');
  await page.locator('[data-star="5"]').click();
  ok('the thank-you card shows', await page.locator('#rtGoogle').isVisible());
  ok('the note does not', !(await page.locator('#rtForm').isVisible()));
  await page.waitForURL(/g\.page/, { timeout: 4000 }).catch(() => {});
  ok('then it lands on the review link', wentTo === REVIEW, wentTo);
  const l = log();
  ok('counted as a five, and as sent to Google', l.tally[5] === 1 && l.google === 1, l);
  await ctx.close();
}

section('Open mode: the note first, Google still one tap away');
setCfg({ ratePage: { on: true, mode: 'open' } });
{
  const { ctx, page } = await open('/rate');
  await page.locator('[data-star="2"]').click();
  ok('the note shows', await page.locator('#rtForm').isVisible());
  const also = page.locator('#rtAlso a');
  ok('with a Google link under it', await also.count() === 1 && (await also.getAttribute('href')) === REVIEW);
  ok('the bare link asks for a name and number', await page.locator('#rtName').count() === 1 && await page.locator('#rtPhone').count() === 1);
  await ctx.close();
}

section('The dashboard screen');
{
  const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  let config = { reviewUrl: REVIEW, ratePage: { on: false, mode: 'gate' } };
  const posts = [];
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  await page.route('**/*', async (route) => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (path === '/api/config') {
      if (req.method() === 'POST') { const b = JSON.parse(req.postData() || '{}'); posts.push(b); if (b.ratePage) config.ratePage = Object.assign({}, config.ratePage, b.ratePage); }
      return json({ ok: true, config });
    }
    if (path === '/api/rate') return json(Object.assign({ ok: true, url: 'https://texting.test/rate', reviewUrl: REVIEW,
      tally: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 3 }, google: 3,
      fb: [{ at: Date.now(), stars: 2, text: 'Missed a spot <b>here</b>', back: true, name: 'Pia Hart', phone: PIA, test: false }] }, config.ratePage));
    if (path === '/api/threads') return json({ ok: true, threads: [], config });
    if (path === '/api/version') return json({ ok: true, build: 'test' });
    if (path.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto('https://texting.test/');
  await page.waitForTimeout(800);
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(300);
  await page.getByText('Star page (idea)', { exact: true }).first().click();
  await page.waitForTimeout(600);
  const body = await page.locator('#mrBody').textContent();
  ok('it says Google does not allow it, up top', /Google doesn.t allow this/.test(body) && /review gating/.test(body), body.slice(0, 300));
  ok('the page reads off', /Page is off/.test(body));
  ok('both modes are offered to try', await page.locator('.rt-btns a[href="/rate?preview=1&mode=gate"]').count() === 1 &&
    await page.locator('.rt-btns a[href="/rate?preview=1&mode=open"]').count() === 1);
  ok('the tally shows', /3\s*sent to Google/.test(body), body);
  ok('the private note shows, escaped', /Missed a spot <b>here<\/b>/.test(await page.locator('.rt-tx').first().textContent()));
  ok('with a way to text them back', await page.locator('[data-rt-phone]').count() === 1);
  await page.locator('[data-rt="on"]').click();
  await page.waitForTimeout(500);
  ok('flipping it saves ratePage.on = true', posts.some((p) => p.ratePage && p.ratePage.on === true), posts);
  ok('and the row now reads on', /Page is on/.test(await page.locator('#mrBody').textContent()));
  await page.locator('[data-rt-mode="open"]').click();
  await page.waitForTimeout(500);
  ok('picking open saves the mode', posts.some((p) => p.ratePage && p.ratePage.mode === 'open'), posts);
}

section('The Worker keeps only what it should from a save');
{
  setCfg({});
  M.__reset();
  const res = await M.handle(new Request('https://texting.test/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ratePage: { on: 'yes', mode: 'everyone' } }) }));
  const cfg = JSON.parse(store.get('config') || '{}');
  ok('junk values leave it off and in gate', res.status !== 200 || (cfg.ratePage && cfg.ratePage.on === false && cfg.ratePage.mode === 'gate'), cfg.ratePage);
  const r2 = await M.handle(new Request('https://texting.test/api/rate/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stars: 5 }) }));
  store.delete('rate:log');
  ok('a tap on a switched-off page writes nothing', r2.status === 200 && !store.has('rate:log'));
}

section('No console noise');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
