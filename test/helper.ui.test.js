// The helper's phone. Mikey's helper answers texts for him, and said two things:
// the AI kept rewriting what they typed with no way they could find to stop it,
// and what they actually needed was to know WHAT to say. So on a phone whose
// "You are" is a member marked Helper, Auto Polish can't run at all — even if
// the switch was saved on — and the Coach takes its place: ideas for what to say
// next and what to keep in mind, with an example behind a tap that never lands
// on top of their own words.
//
//   npm install && node test/helper.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();

const rows = [
  { phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'how much for a full detail on my tahoe?', lastDir: 'in', lastTs: now - 60000 },
];
const thread = (phone) => ({
  phone, name: 'Dale Hobart', tags: [], scheduled: [], linked: [], notes: '',
  messages: [{ id: 'm1', dir: 'in', body: 'how much for a full detail on my tahoe?', ts: now - 60000 }],
});
let config = {
  teamMode: true,
  team: [{ id: 'h1', name: 'Sam', role: 'Texts', helper: true }, { id: 'o1', name: 'Mikey', role: 'Owner', helper: false }],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
// Sam's phone, with Auto Polish saved ON — the state the complaint came from.
await ctx.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('mkd-me', 'h1');
    localStorage.setItem('mkd-ui', JSON.stringify({ autoPolish: true }));
  }
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const polishAsks = [], coachAsks = [], configPosts = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/config') {
    if (req.method() === 'POST') { configPosts.push(body); config = Object.assign({}, config, body); }
    return json({ ok: true, config });
  }
  if (path === '/api/ai/draft') {
    if (body.text) polishAsks.push(body.text);
    return json({ ok: true, draft: 'Rewritten by the AI.' });
  }
  if (path === '/api/ai/coach') {
    coachAsks.push(body);
    if (body.draft) return json({ ok: true, reply: '', points: ['Ask what year the Tahoe is'], watchouts: ['Don\'t promise a price before Mikey sees it'], tone: '' });
    return json({ ok: true, reply: 'Hey Dale! Happy to help with the Tahoe.', points: ['Ask what shape the inside is in', 'Ask for a couple photos'],
      watchouts: ['Never give a firm price over text'], tone: 'Friendly and quick' });
  }
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
const box = () => page.inputValue('#msgInput');
const type = async (t) => { await page.locator('#msgInput').click(); await page.locator('#msgInput').fill(''); await page.locator('#msgInput').type(t, { delay: 10 }); };
const panel = () => page.locator('#coachPanel');
const openThread = async () => {
  if (await page.evaluate(() => document.body.classList.contains('viewing'))) { await page.locator('#backBtn').click(); await page.waitForTimeout(250); }
  await page.locator('.navitem[data-tab="messages"]').click(); await page.waitForTimeout(250);
  await page.getByText('Dale Hobart', { exact: true }).first().click();
  await page.waitForTimeout(600);
};

section('On the helper\'s phone the ideas are the first thing above the box');
await openThread();
ok('the strip is showing', await panel().isVisible());
ok('and says what it is for', /ideas for your reply/i.test(await panel().innerText()), await panel().innerText());
ok('nothing was spent to show it', coachAsks.length === 0, coachAsks);

section('The AI never rewrites what they type, even with Auto Polish saved on');
await type('hey dale yea we can do that tahoe');
await page.waitForTimeout(3800);
ok('their words are still their words', (await box()) === 'hey dale yea we can do that tahoe', await box());
ok('and nothing was sent off to be rewritten', polishAsks.length === 0, polishAsks);
ok('no "polishes when you pause" strip either', !(await page.locator('#polishBar').isVisible()));

section('Tools says so plainly instead of offering a switch');
await page.locator('#toolsBtn').click(); await page.waitForTimeout(400);
ok('no Auto Polish switch', await page.locator('#tsAutoPolish').count() === 0);
ok('a line that says the AI leaves their words alone', /never changes your words/i.test(await page.locator('#toolsSheet').innerText()));
await page.locator('#toolsBtn').click(); await page.waitForTimeout(300);
ok('the thread is still open', await page.locator('#composer').isVisible());

section('Tap it: what to say next and what to keep in mind, the example last');
await page.locator('#coachStripGo').click(); await page.waitForTimeout(600);
ok('one coach call, on the tap', coachAsks.length === 1, coachAsks);
ok('asked for ideas, not a check of the draft', !coachAsks[0].draft, coachAsks[0]);
const txt = await panel().innerText();
ok('"What to say next" with the points', /what to say next/i.test(txt) && /couple photos/.test(txt), txt);
ok('"Keep in mind" with the watch-outs and the tone', /keep in mind/i.test(txt) && /firm price/.test(txt) && /Friendly and quick/.test(txt), txt);
ok('the example is folded away until they ask', !(await page.locator('#coachReply').isVisible()));

section('The example never lands on top of their words without asking');
await page.locator('#coachEx summary').click(); await page.waitForTimeout(200);
page.once('dialog', (d) => d.dismiss());
await page.locator('#coachUse').click(); await page.waitForTimeout(300);
ok('said no, so the box is untouched', (await box()) === 'hey dale yea we can do that tahoe', await box());
page.once('dialog', (d) => d.accept());
await page.locator('#coachUse').click(); await page.waitForTimeout(300);
ok('said yes, so the example is in', (await box()) === 'Hey Dale! Happy to help with the Tahoe.', await box());

section('"Check what I wrote" reads their draft and says what is still missing');
await type('hey dale, send me a couple pics and ill get you a price');
await page.locator('#coachCheck').click(); await page.waitForTimeout(600);
ok('the draft went along', coachAsks.length === 2 && /couple pics/.test(coachAsks[1].draft || ''), coachAsks);
ok('it answers "Still to say"', /still to say/i.test(await panel().innerText()) && /what year/.test(await panel().innerText()), await panel().innerText());
ok('and the box was left alone', /couple pics/.test(await box()), await box());

section('Close it and it folds back to the strip; asking again is free');
await page.locator('#coachClose').click(); await page.waitForTimeout(300);
ok('closed', !(await panel().isVisible()) || /ideas for your reply/i.test(await panel().innerText()));
await openThread();
ok('the strip is back on reopen', /ideas for your reply/i.test(await panel().innerText()), await panel().innerText());
await page.locator('#coachStripGo').click(); await page.waitForTimeout(400);
ok('the answer comes back without another call', coachAsks.length === 2, coachAsks.length);
ok('same ideas', /what to say next/i.test(await panel().innerText()));

section('Mikey marks helpers in Settings, and it saves');
// The roster lives in More > Settings; its buttons are wired whether or not the
// sheet is open, so click them where they are.
const chip = (id) => page.evaluate((i) => { const b = document.querySelector('#teamPanel [data-helper="' + i + '"]'); return b ? { on: b.classList.contains('on'), txt: b.textContent } : null; }, id);
ok('Sam shows as a helper', (await chip('h1') || {}).on === true, await chip('h1'));
ok('Mikey does not', (await chip('o1') || {}).on === false, await chip('o1'));
ok('Edit and Remove still point at the right person', await page.evaluate(() =>
  !!document.querySelector('#teamPanel [data-edit="h1"]') && !!document.querySelector('#teamPanel [data-del="h1"]')));
await page.evaluate(() => document.querySelector('#teamPanel [data-helper="o1"]').click()); await page.waitForTimeout(300);
const last = configPosts[configPosts.length - 1] || {};
ok('tapping it saves the team with the mark', Array.isArray(last.team) && last.team.find((m) => m.id === 'o1').helper === true, last);
ok('and leaves the others as they were', last.team && last.team.find((m) => m.id === 'h1').helper === true, last);
await page.evaluate(() => document.querySelector('#teamPanel [data-helper="o1"]').click()); await page.waitForTimeout(300);
ok('tap again to take it off', configPosts[configPosts.length - 1].team.find((m) => m.id === 'o1').helper === false);

section('On Mikey\'s own phone nothing changed');
await page.evaluate(() => { localStorage.setItem('mkd-me', 'o1'); });
await page.goto('https://texting.test/'); await page.waitForTimeout(900);
await openThread();
ok('no ideas strip for the owner', !(await panel().isVisible()) || !/ideas for your reply/i.test(await panel().innerText()));
await type('yea thurs works for me ill swing by around ten');
await page.waitForTimeout(3800);
ok('Auto Polish runs for him, as he left it', polishAsks.length === 1, polishAsks);

ok('no page errors', errs.length === 0, errs);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
