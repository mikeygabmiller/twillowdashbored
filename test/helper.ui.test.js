// The helper page in a real browser: one conversation list like a phone's,
// "needs reply" counted from the helper's start line,
// the AI never rewrites what the helper types (it gives ideas for what to say
// instead), and Send sends their words on the first tap. Plus the one hop in Mikey's own app: the helper's PIN on his
// sign-in screen lands on the helper page, not in his dashboard.
//
//   node test/helper.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HELPER = fs.readFileSync(new URL('../public/helper.html', import.meta.url), 'utf8');
const APP = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }

const rows = [
  { phone: '+14255550001', name: 'Recent Waiter', lastBody: 'what time tomorrow?', lastDir: 'in', lastTs: now - 20 * 60000, awaitingReply: true, waitSince: now - 20 * 60000, unread: 1 },
  { phone: '+14255550002', name: 'Oldest Waiter', lastBody: 'are you available next tuesday?', lastDir: 'in', lastTs: now - 9 * 3600000, awaitingReply: true, waitSince: now - 9 * 3600000, unread: 1, helperAskAt: now - 3600000, helperAnsweredAt: now - 600000 },
  { phone: '+14255550003', name: 'Done Deal', lastBody: 'See you Friday', lastDir: 'out', lastTs: now - 3600000 },
  { phone: '+14255550004', name: 'Said Stop', lastBody: 'STOP', lastDir: 'in', lastTs: now - 60000, awaitingReply: true, optedOut: true },
  { phone: '+14255550005', name: 'Archived Person', lastBody: 'hi', lastDir: 'in', lastTs: now - 1000, archived: true },
];
const thread = {
  phone: '+14255550002', name: 'Oldest Waiter', notes: 'Quote request: 2019 RAV4, Full Detail',
  messages: [
    { dir: 'in', body: '', ts: now - 10 * 3600000, media: [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM1/Media/ME1', type: 'image/jpeg' }] },
    { dir: 'in', body: 'are you available next tuesday?', ts: now - 9 * 3600000 },
  ],
  garage: { address: '', city: 'Snohomish', vehicles: [{ year: '2019', make: 'Toyota', model: 'RAV4' }] },
  helperAsk: { at: now - 3600000, by: 'Jess', question: 'Can I offer $280 each?', answer: 'Yes, $280 each is fine.', answeredAt: now - 600000 },
  suggested: { text: 'I might have an opening Tuesday, what part of town are you in?', forTs: now - 9 * 3600000 },
};
const guide = {
  ok: true, name: 'Jess', notes: 'Booked solid Thursday.', since: now - 2 * 3600000, labels: ['Two+ cars', 'Pet hair', 'Returning'],
  guide: [{ title: 'Your job', points: ['Answer within 15 minutes.'] }, { title: 'How a booking goes', points: ['1. Year, make and model.'] }],
  quick: [{ label: 'Ask for the car', text: 'Could you send over the year, make, and model of the car?' }],
  prices: [{ name: 'Full Detail', price: { sedan: 299, suv: 339, truck: 379 } }], addons: [{ name: 'Pet hair removal', price: 30 }],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];
function watch(page) {
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|Failed to load resource/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
}

// ---------------------------------------------------------------- helper page
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
watch(page);
let authed = false;
const sends = [], polishes = [], coaches = [], contacts = [], dones = [], organizes = [];
let coachReply = (b) => b.draft
  ? { ok: true, reply: '', points: ['Ask what year the car is'], watchouts: ['Don\'t promise Tuesday until Mikey says so'], tone: '' }
  : { ok: true, reply: 'Hey! Tuesday might work, let me check with Mikey.', points: ['Say Tuesday might work', 'Ask what car it is'], watchouts: ['Never promise a day, Mikey picks'], tone: 'Quick and friendly' };
await page.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
  if (p === '/helper.html') return route.fulfill({ status: 200, contentType: 'text/html', body: HELPER });
  if (p === '/api/login') { const b = body(); if (b.password === '5150') { authed = true; return json({ ok: true, role: 'helper' }); } return json({ ok: false, error: 'wrong_password' }, 401); }
  if (!authed && p.startsWith('/api/')) return json({ ok: false, error: 'unauthorized' }, 401);
  if (p === '/api/whoami') return json({ ok: true, role: 'helper', name: 'Jess' });
  if (p === '/api/helper/guide') return json(guide);
  if (p === '/api/threads') return json({ ok: true, threads: rows });
  if (p === '/api/thread') return json({ ok: true, thread });
  if (p === '/api/helper/media') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  if (p === '/api/helper/week') return json({ ok: true, maxPerDay: 2, days: [
    { date: '2026-09-26', dow: 6, work: true, room: 1, jobs: [{ date: '2026-09-26', at: now + 864e5, name: 'Booked Betty', phone: '+14255550009', city: 'Monroe', car: '2021 Tacoma' }] },
    { date: '2026-09-27', dow: 0, work: false, room: 2, jobs: [] }] });
  if (p === '/api/helper/contact') { const b = body(); contacts.push(b); return json({ ok: true, thread: Object.assign({}, thread, { name: b.name, messages: thread.messages.concat([{ dir: 'out', body: 'Got it, thanks!', ts: now - 1000 }]) }) }); }
  if (p === '/api/helper/organize') {
    const b = body(); organizes.push(b);
    if ('stage' in b) thread.helperStage = b.stage;
    if (b.addLabel) thread.tags = (thread.tags || []).concat([b.addLabel]);
    if (b.removeLabel) thread.tags = (thread.tags || []).filter((x) => x !== b.removeLabel);
    if (b.note) thread.helperNotes = (thread.helperNotes || []).concat([{ id: 'n' + organizes.length, at: Date.now(), by: 'Jess', text: b.note }]);
    if ('follow' in b) thread.helperFollow = b.follow ? Object.assign({ by: 'Jess' }, b.follow) : null;
    if (b.check) thread.helperChecks = Object.assign({}, thread.helperChecks, { [b.check.key]: b.check.on });
    Object.assign(rows[1], { helperStage: thread.helperStage || '', tags: thread.tags || [], helperFollowAt: (thread.helperFollow && thread.helperFollow.at) || 0 });
    return json({ ok: true, thread, labels: guide.labels });
  }
  if (p === '/api/helper/done') { dones.push(body()); return json({ ok: true, thread }); }
  if (p === '/api/ai/draft') { const b = body(); polishes.push(b.text); return json({ ok: true, draft: 'REWRITTEN' }); }
  if (p === '/api/helper/coach') { const b = body(); coaches.push(b); return json(coachReply(b)); }
  if (p === '/api/send') { const b = body(); sends.push(b.body); return json({ ok: true, thread: Object.assign({}, thread, { messages: thread.messages.concat([{ dir: 'out', body: b.body, ts: Date.now(), by: 'Jess' }]) }) }); }
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 404, body: '' });
});

await page.goto('https://texting.test/helper.html');
console.log('\nSign in');
await page.waitForSelector('#pinIn', { state: 'visible' });
await page.fill('#pinIn', '0000'); await page.click('#pinGo');
await page.waitForFunction(() => document.getElementById('pinErr').textContent.length > 0);
ok(/Wrong PIN/.test(await page.textContent('#pinErr')), 'a wrong PIN says so');
await page.fill('#pinIn', '5150'); await page.click('#pinGo');
await page.waitForSelector('#listView:not(.hide) .row');

console.log('\nOne list, like Messages');
const names = await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent));
ok(names.join('|') === 'Said Stop|Recent Waiter|Done Deal|Oldest Waiter', 'every conversation, newest first: ' + names.join('|'));
ok(!names.includes('Archived Person'), 'archived ones are tucked away at the bottom');
ok(/Texting for Mikey · Jess/.test(await page.textContent('#whoami')), 'names the helper');
ok(await page.$$eval('#list .row .av', (n) => n.length) === 4, 'each row has a contact circle');
ok(/Mikey answered/.test(await page.textContent('#list .row[data-p="+14255550002"]')), '"Mikey answered" shows on the row before it\'s opened');
ok((await page.title()) === '(2) Messages', 'the tab shows the unread count');
const card = await page.textContent('#alertCard');
ok(/buzz when a customer texts|blocked/i.test(card), 'offers phone alerts');
await page.click('#alertX');
ok((await page.textContent('#alertCard')) === '', 'and the offer can be dismissed');

console.log('\n"Needs reply" starts from the helper\'s start line');
const pills = await page.$$eval('#list .row', (rows) => rows.map((r) => [r.querySelector('.who').textContent, !!r.querySelector('.pill.need')]));
const need = Object.fromEntries(pills);
ok(need['Recent Waiter'] === true, 'a text after the start line needs a reply');
ok(need['Oldest Waiter'] === false, 'the older backlog is cleared for the helper');
ok(need['Said Stop'] === false, 'someone who said STOP never needs a reply');
ok(/Needs reply \(1\)/.test(await page.textContent('#segNeed')), 'the filter counts one');
await page.click('#segNeed');
const needNames = await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent));
ok(needNames.join('|') === 'Recent Waiter', '"Needs reply" shows just that one');
await page.click('#segAll');
await page.click('#archBtn');
ok((await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent))).includes('Archived Person'), 'archived conversations can still be scrolled to');
await page.click('#archBtn');

console.log('\nConversation, quick reply, suggestion');
await page.click('#list .row[data-p="+14255550002"]');
await page.waitForSelector('#chatView:not(.hide) .b.in');
ok((await page.textContent('#chatName')) === 'Oldest Waiter', 'chat header names them');
ok(/2019 RAV4/.test(await page.textContent('#chatInfo')), 'quote notes shown');
ok(await page.isDisabled('#sendBtn'), 'send is grey while the box is empty');
ok(await page.isVisible('#useSugg'), 'the AI\'s draft is offered');
await page.click('#useSugg');
ok((await page.inputValue('#box')).startsWith('I might have an opening Tuesday'), 'using the draft fills the box');
ok(polishes.length === 0, 'nothing is sent off to be rewritten');
await page.click('#sendBtn');
await page.waitForFunction(() => document.getElementById('box').value === '');
ok(sends.length === 1 && sends[0].startsWith('I might have an opening'), 'the draft sends on one tap');
ok(/Sent by Jess/.test(await page.textContent('#msgs')), 'under the bubble: "Sent by Jess"');
ok(await page.$$eval('#msgs .b.out', (n) => n.length) === 1 && await page.$$eval('#msgs .b.in', (n) => n.length) === 1, 'their text on the left, the reply on the right');

console.log('\nThe AI never touches what they type');
await page.fill('#box', '');
await page.type('#box', 'hey I can do tues at 1pm');
await page.waitForTimeout(3200);   // longer than the old 2.4s polish pause
ok(await page.inputValue('#box') === 'hey I can do tues at 1pm', 'after a pause their words are still their words');
ok(polishes.length === 0, 'and nothing was sent off to be rewritten');
const nBefore = sends.length;
await page.click('#sendBtn');
await page.waitForFunction(() => document.getElementById('box').value === '');
ok(sends.length === nBefore + 1 && sends[sends.length - 1] === 'hey I can do tues at 1pm', 'Send sends exactly what they wrote, on the first tap');
ok(polishes.length === 0, 'still no rewrite');

console.log('\nIdeas for what to say');
ok(/What should I say/.test(await page.textContent('#strip')), 'the ideas button sits right above the box');
ok(await page.isDisabled('#ideaCheck'), '"Check my text" waits until something is typed');
ok(coaches.length === 0, 'nothing is asked of the AI until they tap');
await page.click('#ideaGo');
await page.waitForFunction(() => /What to say next/.test(document.getElementById('ideas').textContent));
ok(coaches.length === 1 && !coaches[0].draft, 'one call, on the tap');
const idea = await page.textContent('#ideas');
ok(/Ask what car it is/.test(idea), 'what to say next');
ok(/Keep in mind/.test(idea) && /Mikey picks/.test(idea) && /Quick and friendly/.test(idea), 'and what to keep in mind');
ok(!(await page.isVisible('#ideas .ex')), 'the example stays folded until they ask for it');
ok(await page.inputValue('#box') === '', 'the box is left empty');

console.log('\nAn example goes in only on a tap, and never over their words without asking');
await page.type('#box', 'hi there');
await page.click('#ideas summary');
page.once('dialog', (d) => d.dismiss());
await page.click('#ideaUse');
ok(await page.inputValue('#box') === 'hi there', 'said no, so what they typed stays');
page.once('dialog', (d) => d.accept());
await page.click('#ideaUse');
ok(/^Hey! Tuesday might work/.test(await page.inputValue('#box')), 'said yes, so the example is in');

console.log('\nCheck my text: what it still needs, without changing it');
await page.fill('#box', '');
await page.type('#box', 'tuesday works, see you then');
await page.click('#ideaCheck');
await page.waitForFunction(() => /Still to say/.test(document.getElementById('ideas').textContent));
ok(coaches.length === 2 && coaches[1].draft === 'tuesday works, see you then', 'their draft went along to be read');
ok(/what year/.test(await page.textContent('#ideas')) && /promise Tuesday/.test(await page.textContent('#ideas')), 'it says what\'s missing and what to watch');
ok(await page.inputValue('#box') === 'tuesday works, see you then', 'and the box is untouched');
await page.click('#ideasX');
ok((await page.textContent('#ideas')) === '', 'closes');
await page.fill('#box', '');
await page.click('#ideaGo');
await page.waitForFunction(() => /What to say next/.test(document.getElementById('ideas').textContent));
ok(coaches.length === 2, 'asking again about the same texts is free');

console.log('\nIdeas down is not a dead end');
coachReply = () => ({ ok: false, error: 'ai_down' });
await page.type('#box', 'running a little late today');
await page.click('#ideaCheck');
await page.waitForFunction(() => /Couldn't get ideas/.test(document.getElementById('ideas').textContent));
await page.click('#sendBtn');
await page.waitForTimeout(300);
ok(sends[sends.length - 1] === 'running a little late today', 'with the AI down, Send still sends');
ok((await page.textContent('#ideas')) === '', 'and sending clears the ideas, they were about the last text');

console.log('\nQuick replies and guide');
await page.fill('#box', '');
await page.click('.chip');
ok(/year, make, and model/.test(await page.inputValue('#box')), 'a quick reply lands in the box, not out the door');
await page.click('#plusBtn');
ok(await page.isVisible('#askDate') && await page.isVisible('#askQ'), 'the + button offers Ask Mikey for a date / Ask Mikey');
await page.click('#sheetGuide');
await page.waitForSelector('#guideView:not(.hide) table');
const g = await page.textContent('#guideView');
ok(/Booked solid Thursday/.test(g), 'Mikey\'s notes are on top');
ok(/\$299/.test(g) && /\$379/.test(g) && /Pet hair removal: \+\$30/.test(g), 'price list rendered');
ok(/Ceramic coating: from \$500/.test(g), 'ceramic "from $500" fact');
await page.click('#guideBack');
ok(await page.isVisible('#chatView'), 'Back from the guide returns to the conversation');

console.log('\nPhotos, Mikey\'s answer, the car');
ok(await page.$eval('#msgs .ph.in img', (i) => i.getAttribute('src')) === '/api/helper/media?phone=%2B14255550002&ts=' + (now - 10 * 3600000) + '&n=0', 'their photo shows, loaded by message and slot, never by URL');
const ans = await page.textContent('#answer');
ok(/Mikey says/.test(ans) && /\$280 each is fine/.test(ans), 'Mikey\'s answer sits in the chat');
ok(/2019 Toyota RAV4 · Snohomish/.test(await page.textContent('#chatSub')), 'header shows the car and town');
await page.click('#msgs .ph img');
ok(await page.isVisible('.lightbox'), 'tapping a photo opens it big');
await page.click('.lightbox');

console.log('\nPrice calculator');
await page.fill('#box', '');
await page.click('#plusBtn'); await page.click('#calcBtn');
await page.waitForSelector('#calcTotal');
ok((await page.textContent('#calcTotal')) === '$339', 'Full Detail, SUV: $339');
await page.click('[data-a="0"]');
ok((await page.textContent('#calcTotal')) === '$369', 'plus pet hair: $369');
await page.click('[data-z="truck"]');
ok((await page.textContent('#calcTotal')) === '$409', 'as a truck: $409');
await page.click('#calcUse');
ok((await page.inputValue('#box')) === "For a Full Detail on your truck with pet hair removal, it'll be $409.", 'the price goes in the box as a sentence');

console.log('\nSave their details');
await page.fill('#box', '');
await page.click('#plusBtn'); await page.click('#editBtn');
ok((await page.inputValue('#fCar')) === '2019 Toyota RAV4', 'the car is filled in');
await page.fill('#fName', 'Olive Waiters');
await page.fill('#fAddr', '9 Pine St, Snohomish');
await page.click('#fSave');
await page.waitForFunction(() => document.getElementById('chatName').textContent === 'Olive Waiters');
ok(contacts.length === 1 && contacts[0].name === 'Olive Waiters' && contacts[0].address === '9 Pine St, Snohomish', 'name and address saved');
ok(!('car' in contacts[0]), 'an unchanged car isn\'t re-sent');

console.log('\nNo reply needed, drafts, "seen"');
await page.click('#plusBtn');
ok(await page.isHidden('#doneBtn'), '"No reply needed" is hidden once the last text is ours');
await page.click('#sheetX');
await page.fill('#box', 'half written reply');
await page.click('#backBtn');
ok(!/Mikey answered/.test(await page.textContent('#list .row[data-p="+14255550002"]')), 'opening it cleared "Mikey answered"');
await page.click('#list .row[data-p="+14255550002"]');
await page.waitForSelector('#chatView:not(.hide) .b.in');
ok((await page.inputValue('#box')) === 'half written reply', 'the half-written reply was kept');
await page.fill('#box', '');
await page.click('#plusBtn');
ok(await page.isVisible('#doneBtn'), '"No reply needed" is offered when they spoke last');
await page.click('#doneBtn');
await page.waitForFunction(() => /no reply needed/i.test(document.body.textContent));
ok(dones.length === 1 && dones[0].phone === '+14255550002', 'marked done');

console.log('\nSchedule');
await page.click('#backBtn');
await page.click('#weekBtn');
await page.waitForSelector('#weekView:not(.hide) .day');
const wk = await page.textContent('#weekBody');
ok(/Booked Betty/.test(wk) && /2021 Tacoma · Monroe/.test(wk), 'booked job with car and town');
ok(/1 open/.test(wk), 'room left on a day');
ok(/No jobs set/.test(wk), 'a non-work day with nothing on it says so');
await page.click('#weekBack');
ok(await page.isVisible('#listView'), 'Back returns to Messages');

console.log('\nOrganize: stage, labels, checklist, notes, follow-up');
ok(/New \d/.test(await page.textContent('#filters')) && /Pet hair 0/.test(await page.textContent('#filters')), 'filter chips list every stage and label with counts');
await page.click('#list .row[data-p="+14255550002"]');
await page.waitForSelector('#org .org');
ok(await page.$eval('#org [data-stage="new"]', (b) => b.classList.contains('on')), 'no stage set yet: it suggests New');
const chk = await page.textContent('#org .chk');
ok(/Ready to book · 2 of 5/.test(await page.textContent('#org')), 'checklist counts what the chat already has (car + photo)');
ok(await page.$eval('#org [data-chk="car"]', (b) => b.classList.contains('done') && b.hasAttribute('data-auto')), 'the car ticked itself from the saved details');
ok(/Next: give the price/.test(await page.textContent('#org')), 'and says what to do next');
await page.click('#org [data-stage="quoted"]');
await page.waitForFunction(() => document.querySelector('#org [data-stage="quoted"]').classList.contains('on'));
ok(organizes.some((o) => o.stage === 'quoted'), 'stage moved to Quoted');
await page.click('#org [data-lbl="Pet hair"]');
await page.waitForFunction(() => document.querySelector('#org [data-lbl="Pet hair"]').classList.contains('on'));
ok(organizes.some((o) => o.addLabel === 'Pet hair'), 'label added');
await page.click('#org [data-chk="price"]');
await page.waitForFunction(() => /3 of 5/.test(document.getElementById('org').textContent));
ok(organizes.some((o) => o.check && o.check.key === 'price' && o.check.on === true), 'a box ticks by hand');
await page.fill('#noteIn', 'Gate code 5232');
await page.click('#noteAdd');
await page.waitForFunction(() => /Gate code 5232/.test(document.getElementById('org').textContent));
ok(/Jess/.test(await page.textContent('#org .note')), 'note shows who wrote it');
await page.click('#plusBtn'); await page.click('#folBtn');
await page.fill('#folNote', 'checking with landlord');
await page.click('#formBody [data-at]');
await page.click('#folSave');
await page.waitForFunction(() => /checking with landlord/.test(document.getElementById('org').textContent));
const fol = organizes.find((o) => o.follow);
ok(fol && fol.follow.note === 'checking with landlord' && fol.follow.at > Date.now(), 'follow-up reminder set');
await page.click('#backBtn');
await page.waitForSelector('#list .row[data-p="+14255550002"]');
const orow = await page.textContent('#list .row[data-p="+14255550002"]');
ok(/Quoted/.test(orow) && /Pet hair/.test(orow) && /Follow up/.test(orow), 'the row shows stage, label and follow-up');
await page.click('#filters [data-st="quoted"]');
ok((await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent))).join('|') === 'Oldest Waiter', 'tap a stage: only those customers');
await page.click('#filters [data-st="quoted"]');
await page.click('#filters [data-lb="Pet hair"]');
ok((await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent))).join('|') === 'Oldest Waiter', 'tap a label: only those customers');
await page.click('#filters [data-lb="Pet hair"]');
await page.click('#segFol');
ok((await page.$$eval('#list .row .who', (n) => n.map((x) => x.textContent))).join('|') === 'Oldest Waiter', 'Follow-ups tab: only customers with a reminder');
await page.click('#segAll');

// ------------------------------------------------ Mikey's app: helper PIN hop
console.log('\nHelper PIN on Mikey\'s sign-in screen');
const app = await browser.newPage({ viewport: { width: 390, height: 844 } });
watch(app);
let landed = '';
await app.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: APP });
  if (p === '/helper.html') { landed = p; return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>helper</body></html>' }); }
  if (p === '/api/login') return json({ ok: true, role: 'helper' });
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: false, error: 'unauthorized' }, 401);
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await app.goto('https://texting.test/');
await app.waitForSelector('#loginOverlay.show');
for (const d of '5150') await app.click(`#pinPad .pin-key >> text="${d}"`);
await app.click('#pinPad .pin-key.fn >> text="✓"');
await app.waitForFunction(() => location.pathname === '/helper.html', null, { timeout: 5000 }).catch(() => {});
ok(landed === '/helper.html', 'the helper PIN goes to the helper page, not the dashboard');

// A helper cookie opening the main app gets sent to their page too.
const app2 = await browser.newPage();
watch(app2);
let landed2 = '';
await app2.route('**/*', async (route) => {
  const u = new URL(route.request().url()); const p = u.pathname;
  const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: APP });
  if (p === '/helper.html') { landed2 = p; return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>helper</body></html>' }); }
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p.startsWith('/api/')) return json({ ok: false, error: 'helper_not_allowed' }, 403);
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await app2.goto('https://texting.test/');
await app2.waitForFunction(() => location.pathname === '/helper.html', null, { timeout: 5000 }).catch(() => {});
ok(landed2 === '/helper.html', 'a helper opening the main app is sent to their page');

// Mikey's side of "Ask Mikey": the question on the conversation, one Answer button.
console.log('\nMikey answers in his own app');
const app3 = await browser.newPage({ viewport: { width: 390, height: 844 } });
watch(app3);
const answers = [];
const askThread = { phone: '+14255550002', name: 'Oldest Waiter', messages: [{ dir: 'in', body: 'are you available next tuesday?', ts: now - 9 * 3600000 }],
  helperAsk: { at: now - 600000, by: 'Jess', question: 'Can I offer $280 each for two cars?' },
  helperStage: 'quoted', helperNotes: [{ id: 'n1', at: now - 300000, by: 'Jess', text: 'Gate code 5232' }], helperFollow: { at: now + 864e5, note: 'landlord ok?' } };
await app3.route('**/*', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
  const json = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: APP });
  if (p === '/api/threads') return json({ ok: true, threads: [rows[1]], thread: askThread });
  if (p === '/api/thread') return json({ ok: true, thread: askThread });
  if (p === '/api/helper/answer') { const b = JSON.parse(req.postData() || '{}'); answers.push(b); return json({ ok: true, thread: Object.assign({}, askThread, { helperAsk: Object.assign({}, askThread.helperAsk, { answer: b.answer, answeredAt: Date.now() }) }) }); }
  if (p === '/api/version') return json({ ok: true, build: 'test' });
  if (p === '/api/money') return json({ ok: true, month: '2026-09', today: '2026-09-25', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (p === '/api/day') return json({ ok: true, date: '2026-09-25', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (p.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});
await app3.goto('https://texting.test/?c=' + encodeURIComponent('+14255550002'));
await app3.waitForSelector('#helperAskBanner', { state: 'visible', timeout: 15000 }).catch(() => {});
const bannerTxt = (await app3.textContent('#helperAskBanner').catch(() => '')) || '';
ok(/Jess asked/.test(bannerTxt) && /\$280 each/.test(bannerTxt), 'the helper\'s question shows on the conversation');
const hcard = (await app3.textContent('#helperCard').catch(() => '')) || '';
ok(/stage: Quoted/.test(hcard) && /Gate code 5232/.test(hcard) && /landlord ok\?/.test(hcard), 'Mikey sees the helper\'s stage, notes and follow-up');
app3.once('dialog', (d) => d.accept('Yes, $280 each works.'));
await app3.click('#helperAskBanner .db-go').catch(() => {});
await app3.waitForFunction(() => document.getElementById('helperAskBanner').style.display === 'none', null, { timeout: 5000 }).catch(() => {});
ok(answers.length === 1 && answers[0].answer === 'Yes, $280 each works.' && answers[0].phone === '+14255550002', 'Answer sends it back to the helper');
ok(await app3.isHidden('#helperAskBanner'), 'and the banner goes away once answered');

const real = errs.filter((e) => !/helper_not_allowed|403|401/.test(e));
ok(real.length === 0, 'no page errors' + (real.length ? ': ' + real.slice(0, 3).join(' | ') : ''));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
