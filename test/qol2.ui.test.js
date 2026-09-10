// A second pass of papercuts, in the screens the first pass didn't reach: the
// leads board, the swipe peek, the money log, the calls list, the details panel
// and the day board.
//
// What each section is defending:
//   • a pipeline board with no dollars and no ages on it is half a pipeline
//   • the peek exists to triage WITHOUT reading a thread, and its only action
//     was Open — which clears unread, the exact thing peeking avoids
//   • a logged job carried the customer's number and never offered their texts
//   • "Delete this entry?" asked the same question of a $220 job and a $12 wash
//   • a voicemail transcript was the one text in the app you could only retype,
//     and an unknown caller stayed a phone number forever
//   • typing a tag blind is how you get "Ceramic" and "ceramic"
//   • the `is:` search grammar existed and nothing ever mentioned it
//   • the job card could text the customer you were driving to, but not call
//   • changing one word of a scheduled text meant cancel and retype it all
//   • finding the photo they sent meant thumbing up through a hundred texts
//
//   npm install && node test/qol2.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const rows = [
  // First in the list on purpose: the peek section archives whatever is on top,
  // and nothing later should depend on this one still being there.
  { phone: '+14255550009', name: 'Wes Okafor', unread: 0, tags: [], status: 'lost',
    statusAt: now - 20 * DAY, lastBody: 'went with someone else', lastDir: 'in', lastTs: now - 20 * DAY, awaitingReply: false },
  { phone: '+14255550001', name: 'Dale Hobart', unread: 0, tags: ['Truck', 'VIP'], status: 'new',
    statusAt: now - 9 * DAY, quoteTotal: 220, quoteAt: now - 9 * DAY,
    lastBody: 'you around thursday?', lastDir: 'in', lastTs: now - 3 * DAY, awaitingReply: true },
  { phone: '+14255550002', name: 'Ruth Alvarez', unread: 2, tags: ['Ceramic', 'Truck'], status: 'new',
    statusAt: now - 2 * HOUR, quoteTotal: 480,
    lastBody: 'what would the full detail run me', lastDir: 'in', lastTs: now - 2 * HOUR, awaitingReply: true },
  { phone: '+14255550003', name: 'Cam Whitley', unread: 0, tags: ['Ceramic', 'Boat'], status: 'won',
    statusAt: now - 30 * MIN,
    lastBody: 'thanks!', lastDir: 'out', lastTs: now - 30 * MIN, awaitingReply: false },
];

const daleMsgs = [
  { id: 'd1', dir: 'in', body: 'here she is', ts: now - 5 * DAY, media: [{ url: 'https://cdn.test/a.jpg', type: 'image/jpeg' }] },
  { id: 'd2', dir: 'out', body: 'after shot', ts: now - 4 * DAY, media: [{ url: 'https://cdn.test/b.jpg', type: 'image/jpeg' }] },
  { id: 'd3', dir: 'in', body: 'and the back seat', ts: now - 3.5 * DAY, media: [{ url: 'https://cdn.test/c.jpg', type: 'image/jpeg' }] },
  { id: 'd4', dir: 'in', body: 'you around thursday?', ts: now - 3 * DAY },
];
const scheduled = [{ id: 's1', body: 'morning! still good for thursday at 10?', sendAt: now + 2 * DAY }];

const threads = {
  '+14255550009': { messages: [{ id: 'w1', dir: 'in', body: 'went with someone else', ts: now - 20 * DAY }] },
  '+14255550001': { messages: daleMsgs, scheduled: scheduled },
  '+14255550002': { messages: [{ id: 'r1', dir: 'in', body: 'what would the full detail run me', ts: now - 2 * HOUR }] },
  '+14255550003': { messages: [{ id: 'c1', dir: 'out', body: 'thanks!', ts: now - 30 * MIN }] },
};
const thread = (phone) => {
  const r = rows.find((x) => x.phone === phone) || {};
  const extra = threads[phone] || { messages: [] };
  return Object.assign({ phone, name: r.name || '', tags: (r.tags || []).slice(), scheduled: [], linked: [], notes: '',
    status: r.status || '', messages: [] }, extra);
};

const calls = [
  { id: 'c-vm', from: '+14255559999', fromNorm: '+14255559999', name: '', ts: now - 40 * MIN,
    outcome: 'voicemail', vmSec: 14, recording: 'https://cdn.test/vm.mp3',
    transcript: 'Hey this is Pete, I am at 908 Cedar Way, give me a call back at 425 555 9999.' },
];

const metaPosts = [], moneyEntries = [], unschedules = [], callPosts = [];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 820 }, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|cdn\.test|ERR_/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
// One dialog handler for the whole run — a second listener would race it and
// try to answer a dialog that is already handled.
let promptAnswer = '', confirmAnswer = true, lastDialog = '';
page.on('dialog', (d) => {
  lastDialog = d.message();
  if (d.type() === 'prompt') return d.accept(promptAnswer);
  return confirmAnswer ? d.accept() : d.dismiss();
});

await page.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url()); const path = u.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (u.hostname === 'cdn.test' || path === '/api/media') return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') });
  if (path === '/api/threads') {
    const want = u.searchParams.get('phone');
    const out = { ok: true, threads: rows, config: {} };
    if (want) out.thread = thread(want);
    return json(out);
  }
  if (path === '/api/meta') {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    metaPosts.push(b);
    const r = rows.find((x) => x.phone === b.phone);
    if (r) { if ('name' in b) r.name = b.name; if ('tags' in b) r.tags = b.tags; if ('archived' in b) r.archived = b.archived; }
    const t = thread(b.phone);
    if ('tags' in b) t.tags = b.tags;
    if ('name' in b) t.name = b.name;
    return json({ ok: true, thread: t });
  }
  if (path === '/api/unschedule') {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (_) {}
    unschedules.push(b);
    scheduled.length = 0;
    return json({ ok: true, thread: thread(b.phone) });
  }
  if (path === '/api/call') { callPosts.push(JSON.parse(req.postData() || '{}')); return json({ ok: true }); }
  if (path === '/api/calls') return json({ ok: true, calls, forwardTo: '+14255550000', screening: true });
  if (path === '/api/money/by-phone') return json({ ok: true, phone: u.searchParams.get('phone'), jobs: 0, total: 0, entries: [] });
  if (path === '/api/money') {
    return json({ ok: true, month: '2026-09', today: '2026-09-10', nudges: [], owed: [], summary: { gross: 220, net: 180 },
      config: { serviceTypes: ['Full detail'] },
      entries: moneyEntries.length ? moneyEntries : [
        { id: 'me1', type: 'job', amount: 220, date: '2026-09-10', method: 'Venmo', service: 'Full detail',
          phone: '+14255550001', name: 'Dale Hobart', ts: now - DAY },
        { id: 'me2', type: 'exp', cat: 'supplies', amount: 12, date: '2026-09-10', ts: now - DAY },
      ] });
  }
  if (path === '/api/day') return json({ ok: true, date: '2026-09-10', order: [], manual: [],
    jobs: [{ id: 'j1', slot: '10:00', name: 'Dale Hobart', phone: '+14255550001', service: 'Full detail',
      state: 'queued', price: 220, mapQuery: '148 Fir St, Monroe' }],
    summary: { total: 1, done: 0, remaining: 1, booked: 220, earned: 0, hours: 0 } });
  if (path === '/api/money/report') return json({ ok: true, months: [] });
  if (path === '/api/pricing') return json({ ok: true, overall: null });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/ai/draft') return json({ ok: false, error: 'off' });
  if (path === '/api/recap') return json({ ok: true, text: 'asked about a full detail' });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
// Work / Money / Stats are full-screen overlays; escape out of whatever is on
// top before reaching for the nav underneath it.
const clearLayers = async () => {
  for (let i = 0; i < 4; i++) {
    const layered = await page.evaluate(() =>
      document.querySelector('#jdApp').classList.contains('show') ||
      document.querySelector('#growApp').classList.contains('show') ||
      document.querySelector('#moneyApp').style.display === 'flex' ||
      document.body.classList.contains('viewing'));
    if (!layered) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
};
const tab = async (t) => {
  await clearLayers();
  await page.locator('.navitem[data-tab="' + t + '"]').click(); await page.waitForTimeout(400);
};
// The leads board lives inside the Work app now, on its own segment.
const toLeads = async () => {
  await tab('work'); await page.waitForTimeout(300);
  await page.locator('#jdNav [data-jv="leads"]').click(); await page.waitForTimeout(500);
};
const openThread = async (name) => {
  await tab('messages');
  await page.locator('.conv .nm', { hasText: name }).first().click();
  await page.waitForTimeout(650);
};

// ─────────────────────────────────────────────────────────────────────────────
section('The leads board says what the pipeline is worth');
await toLeads();
const newCol = page.locator('.lead-col', { has: page.locator('.lbl', { hasText: 'New' }) });
ok('the New column totals the open quotes', /\$700/.test(await newCol.locator('.lc-money').innerText()),
  await newCol.locator('.lc-money').innerText());
ok('and says how many are waiting on him', /2 waiting on you/.test(await newCol.locator('.lc-owed').innerText()),
  await newCol.locator('.lc-owed').innerText());
const daleCard = page.locator('.lead-card', { has: page.locator('.nm', { hasText: 'Dale Hobart' }) });
ok('a card carries its quote', /\$220/.test(await daleCard.locator('.lm-q').innerText()), await daleCard.innerText());
ok('and how long they have been waiting', /waiting 3d/.test(await daleCard.locator('.lm-w').innerText()), await daleCard.innerText());
const camCard = page.locator('.lead-card', { has: page.locator('.nm', { hasText: 'Cam Whitley' }) });
ok('one nobody is waiting on shows its age in the stage instead', /in won/.test(await camCard.locator('.lm').first().innerText()),
  await camCard.innerText());
ok('a column with no quotes on it says no dollars',
  (await page.locator('.lead-col', { has: page.locator('.lbl', { hasText: 'Won' }) }).locator('.lc-money').count()) === 0);
ok('a stage nobody has moved out of for weeks reads as old',
  (await page.locator('.lead-card', { has: page.locator('.nm', { hasText: 'Wes Okafor' }) }).locator('.lm-old').count()) === 1);

// ─────────────────────────────────────────────────────────────────────────────
section('The peek can decide, not just look');
await tab('messages');
await page.locator('.conv').first().evaluate((e) => {
  const r = e.getBoundingClientRect();
  e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 12), clientY: Math.round(r.top + 12) }));
});
await page.waitForTimeout(200);
await page.locator('.ctx-item[data-a="peek"]').click();
await page.waitForTimeout(500);
ok('the peek is up', (await page.locator('#pkCard').count()) === 1);
const verbs = () => page.$$eval('.pk-d', (n) => n.map((x) => x.textContent.trim()));
ok('it offers a call', (await verbs()).some((v) => /Call/.test(v)), await verbs());
ok('a reminder', (await verbs()).some((v) => /Remind me/.test(v)), await verbs());
ok('and an archive', (await verbs()).some((v) => /Archive/.test(v)), await verbs());
ok('Open is still the primary', await page.locator('#pkOpen').isVisible());

const peekWho = await page.locator('.pk-who b').innerText();
metaPosts.length = 0;
await page.locator('.pk-d[data-pk="archive"]').click();
await page.waitForTimeout(600);
ok('archiving from the peek actually archived', metaPosts.some((m) => m.archived === true), metaPosts);
ok('and nothing was read to do it — the thread never opened',
  !(await page.evaluate(() => document.body.classList.contains('viewing'))));
const peekWho2 = await page.locator('.pk-who b').count() ? await page.locator('.pk-who b').innerText() : '';
ok('it stepped on to the next one in the pile', peekWho2 && peekWho2 !== peekWho, { peekWho, peekWho2 });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ─────────────────────────────────────────────────────────────────────────────
section('A logged job knows whose it is');
await tab('money');
await page.waitForTimeout(600);
const jobRow = page.locator('.mo-row', { hasText: 'Dale Hobart' }).first();
ok('the job row offers their texts', (await jobRow.locator('[data-mochat]').count()) === 1);
ok('an expense with no customer does not', (await page.locator('.mo-row', { hasText: 'Supplies' }).first().locator('[data-mochat]').count()) === 0);
await jobRow.locator('[data-mochat]').click();
await page.waitForTimeout(700);
ok('tapping it lands in their conversation', (await page.locator('#hName').innerText()) === 'Dale Hobart',
  await page.locator('#hName').innerText());
ok('and closed the money tracker on the way', (await page.locator('#moneyApp').evaluate((e) => e.style.display)) !== 'flex');

// ─────────────────────────────────────────────────────────────────────────────
section('Deleting money says what is about to go');
await tab('money');
await page.waitForTimeout(600);
lastDialog = ''; confirmAnswer = false;
await page.locator('.mo-row', { hasText: 'Dale Hobart' }).first().locator('[data-edel]').click();
await page.waitForTimeout(400);
const asked = lastDialog;
confirmAnswer = true;
ok('it names the amount', /\$220/.test(asked), asked);
ok('and who it was', /Dale Hobart/.test(asked), asked);
ok('and when', /Today|Sep/.test(asked), asked);
ok('and warns it is one-way', /can't be undone/i.test(asked), asked);
ok('dismissing kept it', (await page.locator('.mo-row', { hasText: 'Dale Hobart' }).count()) > 0);

// ─────────────────────────────────────────────────────────────────────────────
section('A voicemail is text you can use');
await tab('calls');
await page.waitForTimeout(700);
ok('the transcript is on the row', /908 Cedar Way/.test(await page.locator('.callrow .ctx').first().innerText()),
  await page.locator('.callrow .ctx').first().innerText());
ok('and it can be copied', (await page.locator('[data-vmcopy]').count()) === 1);
ok('an unknown caller is offered a name', (await page.locator('[data-clname]').count()) === 1);
metaPosts.length = 0;
promptAnswer = 'Pete Sandoval';
await page.locator('[data-clname]').click();
await page.waitForTimeout(600);
ok('naming him saved it', metaPosts.some((m) => m.name === 'Pete Sandoval' && m.phone === '+14255559999'), metaPosts);
ok('the row uses the name now', /Pete Sandoval/.test(await page.locator('.callrow .nm').first().innerText()),
  await page.locator('.callrow .nm').first().innerText());
ok('and stops asking', (await page.locator('[data-clname]').count()) === 0);

// ─────────────────────────────────────────────────────────────────────────────
section('Tags come from the tags you already use');
await openThread('Ruth Alvarez');
await page.locator('#detailsBtn').click();
await page.waitForTimeout(450);
const sugg = () => page.$$eval('#dtTags .tag-sug', (n) => n.map((x) => x.textContent.replace('+', '').trim()));
ok('tags other conversations use are offered', (await sugg()).includes('VIP') && (await sugg()).includes('Boat'), await sugg());
ok('the ones she already has are not offered back',
  !(await sugg()).includes('Ceramic') && !(await sugg()).includes('Truck'), await sugg());
ok('typing a brand new one is still there', /New tag/.test(await page.locator('#dtTags .tagadd:not(.tag-sug)').innerText()));
metaPosts.length = 0;
await page.locator('#dtTags .tag-sug', { hasText: 'VIP' }).click();
await page.waitForTimeout(500);
ok('tapping a suggestion adds it', metaPosts.some((m) => (m.tags || []).includes('VIP')), metaPosts);
await page.locator('#detailsClose').click();
await page.waitForTimeout(300);

// A new tag that differs from an existing one only by case IS that tag.
await openThread('Dale Hobart');
await page.locator('#detailsBtn').click();
await page.waitForTimeout(450);
promptAnswer = 'ceramic';
metaPosts.length = 0;
await page.locator('#dtTags .tagadd:not(.tag-sug)').click();
await page.waitForTimeout(500);
ok('"ceramic" folds into the "Ceramic" already in use elsewhere',
  metaPosts.some((m) => (m.tags || []).includes('Ceramic') && !(m.tags || []).includes('ceramic')), metaPosts);
await page.locator('#detailsClose').click();
await page.waitForTimeout(300);

// ─────────────────────────────────────────────────────────────────────────────
section('Search says what it can do, and remembers');
await tab('messages');
await page.locator('#search').click();
await page.waitForTimeout(350);
const cuts = () => page.$$eval('.sx-chip', (n) => n.map((x) => x.getAttribute('data-sx')));
ok('the field grammar is offered instead of hidden', (await cuts()).includes('is:unread'), await cuts());
ok('including the drafts cut from the last pass', (await cuts()).includes('is:draft'), await cuts());
await page.locator('.sx-chip[data-sx="is:unread"]').click();
await page.waitForTimeout(450);
ok('tapping one runs it', (await page.locator('#search').inputValue()) === 'is:unread');
ok('and it really filters', (await page.locator('.conv').count()) === 1, await page.locator('.conv').count());
await page.locator('#search').fill('silverado');
await page.locator('#search').blur();
await page.waitForTimeout(300);
await page.locator('#searchClr').click();
await page.waitForTimeout(200);
await page.locator('#search').click();
await page.waitForTimeout(350);
ok('what you looked for last comes back', (await cuts()).includes('silverado'), await cuts());
ok('a ready-made cut is not duplicated by the recent list',
  (await cuts()).filter((c) => c === 'is:unread').length === 1, await cuts());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ─────────────────────────────────────────────────────────────────────────────
section('The job you are driving to can be called');
await tab('work');
await page.locator('#jdNav [data-jv="run"]').click();
await page.waitForTimeout(800);
ok('the card can text them', (await page.locator('[data-jdchat]').count()) >= 1);
ok('and now call them too', (await page.locator('[data-jdcall]').count()) >= 1);
callPosts.length = 0;
confirmAnswer = false;
await page.locator('[data-jdcall]').first().click();
await page.waitForTimeout(350);
ok('saying no to the confirm rings nobody', callPosts.length === 0, callPosts);
confirmAnswer = true;
await page.locator('[data-jdcall]').first().click();
await page.waitForTimeout(450);
ok('saying yes calls that customer', callPosts.length === 1 && callPosts[0].phone === '+14255550001', callPosts);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ─────────────────────────────────────────────────────────────────────────────
section('A scheduled text can be changed, not just killed');
await openThread('Dale Hobart');
ok('the scheduled text is shown', await page.locator('#schedBanner .sched-item').first().isVisible());
ok('with an edit, not just a cancel', (await page.locator('#schedBanner [data-edit]').count()) === 1);
unschedules.length = 0;
await page.locator('#schedBanner [data-edit]').click();
await page.waitForTimeout(700);
ok('it is pulled back off the queue first', unschedules.length === 1 && unschedules[0].id === 's1', unschedules);
ok('the words come back in the box',
  (await page.locator('#msgInput').inputValue()) === 'morning! still good for thursday at 10?',
  await page.locator('#msgInput').inputValue());
ok('the schedule picker is open on the time it had', await page.locator('#schedPop').isVisible());
ok('and pre-set, not blank', (await page.locator('#schedTime').inputValue()).length > 0,
  await page.locator('#schedTime').inputValue());
ok('and the queue banner is gone — it is in your hands now, not the cron\'s',
  !(await page.locator('#schedBanner').isVisible()));

// ─────────────────────────────────────────────────────────────────────────────
section('Every photo in the conversation, in one place');
await openThread('Dale Hobart');
await page.locator('#detailsBtn').click();
await page.waitForTimeout(500);
ok('the section shows up when there are photos', await page.locator('#dtPhotoSec').isVisible());
ok('all three are there', (await page.locator('.dtp').count()) === 3, await page.locator('.dtp').count());
ok('newest first', /and the back seat|Sep/.test(await page.locator('.dtp').first().getAttribute('title')),
  await page.locator('.dtp').first().getAttribute('title'));
ok('yours are marked as yours', (await page.locator('.dtp .dtp-you').count()) === 1);
ok('and theirs are not', (await page.locator('.dtp').count()) - (await page.locator('.dtp .dtp-you').count()) === 2);
await page.locator('.dtp').first().click();
await page.waitForTimeout(400);
ok('tapping one opens it full size', await page.locator('#lightbox, .lightbox').first().isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await openThread('Ruth Alvarez');
await page.locator('#detailsBtn').click();
await page.waitForTimeout(450);
ok('a conversation with no photos does not grow an empty section',
  !(await page.locator('#dtPhotoSec').isVisible()));

console.log('\nJS errors:', errs.length ? errs.join('\n') : 'none');
if (errs.length) fail += errs.length;
console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
await browser.close();
process.exit(fail ? 1 : 0);
