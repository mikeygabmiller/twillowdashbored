// Win-back list on a phone: Insights → Customers → "Draft a text".
//
// What has to hold:
//   · every overdue customer has one clear action under their row
//   · "Draft a text" saves the draft to that chat, then opens the chat with the
//     draft in the box above the keyboard, and sends nothing
//   · "Do not text" has no button at all
//   · a chat that already has a reply waiting gets "Open chat", and the draft
//     is NOT saved over it
//   · tapping the row itself still just opens the chat, like before
//   · if the save fails he still lands in the chat and is told
//
//   node test/winback.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

const SARAH = '+14255550101', STOP = '+14255550103', READY = '+14255550104', TEXTED = '+14255550106';
const DRAFT = "Hey Sarah, it's Mikey with Mikey's Mobile Detailing. It's been about 5 months since I last detailed your car, so I wanted to check in. If you want to get it done again, just text me what days work for you and I'll get you on the schedule.";
const row = (o) => Object.assign({ rev: 600, n: 3, avgTicket: 200, daysSince: 150, due: 60, over: 90, lapsed: false,
  doNotText: false, waiting: false, replyReady: false, onPlan: false, textedDays: null, draft: 'Hey there' }, o);
const CUSTOMERS = {
  ok: true,
  totals: { customers: 4, repeatCustomers: 4, repeatRate: 100, revenue: 2520, ltv: 630, repeatLtv: 630, oneTimeLtv: 0, avgTicket: 210, typicalGap: 60, anonJobs: 0, top20Share: 30 },
  top: [], cohorts: [], attribution: { sources: [] },
  winback: [
    row({ phone: SARAH, name: 'Sarah Johnson', rev: 920, draft: DRAFT }),
    row({ phone: STOP, name: 'Stan Stop', doNotText: true, draft: '' }),
    row({ phone: READY, name: 'Rae Ready', replyReady: true }),
    row({ phone: TEXTED, name: 'Tess Texted', textedDays: 9, onPlan: true }),
  ],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

const metaPosts = [], sends = [];
const drafts = {};          // what the fake server has saved per chat
let failMeta = false;
await page.route('**/*', async (route) => {
  const req = route.request(), u = new URL(req.url()), p = u.pathname;
  const json = (o, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (p === '/api/intel/customers') return json(CUSTOMERS);
  if (p === '/api/meta' && req.method() === 'POST') {
    const b = JSON.parse(req.postData() || '{}'); metaPosts.push(b);
    if (failMeta) return json({ ok: false, error: 'kv' }, 500);
    if (typeof b.draft === 'string') drafts[b.phone] = b.draft;
    return json({ ok: true });
  }
  if (p === '/api/send' || p === '/api/schedule') { sends.push(req.postData()); return json({ ok: true }); }
  if (p === '/api/threads') {
    const phone = u.searchParams.get('phone');
    if (!phone) return json({ ok: true, threads: [] });
    const name = (CUSTOMERS.winback.find((w) => w.phone === phone) || {}).name || '';
    const messages = [{ dir: 'out', body: 'Thanks again!', ts: Date.now() - 150 * 86400000 }];
    return json({ ok: true, threads: [], thread: { phone, name, messages, tags: [],
      suggested: drafts[phone] ? { text: drafts[phone], ts: Date.now(), forTs: messages[0].ts, by: 'winback', manual: true } : null } });
  }
  if (p === '/api/insights') return json({ ok: true, needsReply: [], avgReplyMs: null, byStatus: {}, total: 0 });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

const openList = async () => {
  await page.goto('https://texting.test/');
  await page.waitForTimeout(1200);
  // Insights is reached by name from the search bar (the Stats tab is one he
  // can hide), the same way journey.ui.test.js gets there.
  await page.locator('#search').fill('who your customers');
  await page.waitForTimeout(300);
  await page.locator('.fx-row').first().click();
  await page.waitForSelector('.iv-wb', { timeout: 5000 });
};
const act = (phone) => page.locator(`.iv-wb-btn[data-wb-phone="${phone}"]`);

console.log('\nThe list');
await openList();
ok('four overdue customers listed', (await page.locator('.iv-row[data-iv-phone]').count()) === 4);
ok('a normal row offers Draft a text', /Draft a text/.test(await act(SARAH).innerText()));
ok('Do not text has no button', (await act(STOP).count()) === 0);
ok('and says so in his words', /Do not text/.test(await page.locator('#grBody').innerText()));
ok('a chat with a reply waiting offers Open chat instead', /Open chat/.test(await act(READY).innerText()));
ok('says when he already texted them', /You texted 9d ago/.test(await page.locator('#grBody').innerText()));
ok('says who is On a plan', /On a plan/.test(await page.locator('#grBody').innerText()));
ok('promises nothing sends by itself', /Nothing is sent until you tap Send/.test(await page.locator('#grBody').innerText()));
const box = await act(SARAH).boundingBox();
ok('the button is a real thumb target', box && box.height >= 34 && box.width >= 100, box);
const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok('nothing spills off the side of the phone', !over);
await page.screenshot({ path: process.env.WINBACK_SHOT || '/dev/null' }).catch(() => {});

console.log('\nDraft a text');
await act(SARAH).click();
await page.waitForTimeout(900);
const saved = metaPosts.find((b) => b.phone === SARAH && typeof b.draft === 'string');
ok('saves the draft to that chat', !!saved && saved.draft === DRAFT, metaPosts);
ok('marked as a win-back draft', saved && saved.draftBy === 'winback');
ok('Insights closes and the chat opens', !(await page.locator('#growApp.show').count()) &&
  await page.evaluate(() => document.body.classList.contains('viewing')));
ok('the draft is waiting above the keyboard', (await page.locator('#suggestBox .air-text').innerText().catch(() => '')) === DRAFT);
ok('with Send, Edit first and Dismiss', (await page.locator('#suggestBox .air-send').count()) === 1 &&
  (await page.locator('#suggestBox .air-edit').count()) === 1);
ok('nothing was sent', sends.length === 0, sends);
ok('the typing box is still empty', (await page.locator('#msgInput').inputValue()) === '');
if (process.env.WINBACK_SHOT) await page.screenshot({ path: process.env.WINBACK_SHOT.replace('.png', '-chat.png') });

console.log('\nA chat that already has a reply waiting');
metaPosts.length = 0;
await openList();
await act(READY).click();
await page.waitForTimeout(700);
ok('opens the chat', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('and saves no draft over the one that is there', !metaPosts.some((b) => typeof b.draft === 'string'), metaPosts);

console.log('\nTapping the row itself');
metaPosts.length = 0;
await openList();
await page.locator(`.iv-row[data-iv-phone="${TEXTED}"]`).click();
await page.waitForTimeout(700);
ok('still just opens the chat', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('without saving a draft', !metaPosts.some((b) => typeof b.draft === 'string'), metaPosts);

console.log('\nIf the save fails');
metaPosts.length = 0; failMeta = true;
await openList();
await act(TEXTED).click();
await page.waitForTimeout(900);
ok('he still lands in the chat', await page.evaluate(() => document.body.classList.contains('viewing')));
ok('and is told the draft did not save', /Couldn't save the draft/.test(await page.locator('#toast').innerText().catch(() => '')));
ok('nothing was sent', sends.length === 0);

ok('no page errors', errs.length === 0, errs.slice(0, 3));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
