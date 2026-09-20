// The "How I talk" screen — where he decides what his automatic texts may say.
//
// The reason this screen exists is a sentence: "I don't want it to ever say
// what day are you thinking." So the test is not "the form renders". It is the
// journey that sentence implies: get to the screen, ban the phrase, watch the
// preview change BEFORE saving, be stopped when a ban would leave a message
// with nothing to send, and be able to write the message yourself instead.
//
//   npm install && node test/say.ui.test.js
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const rows = [{ phone: '+14255551234', name: 'Dale Hobart', unread: 0, tags: [], lastBody: 'hi', lastDir: 'in', lastTs: now - 60000 }];
let config = { followupsEnabled: true, say: { never: [], signoff: 'first', closer: 'open', emoji: false, reviewAsk: true, waterPower: true, custom: {} } };

// A stand-in for the Worker's sayPreview: enough shape for the screen to drive,
// and it honours the rules the screen sends so the preview can be seen to move.
const build = (say) => {
  const banned = (t) => (say.never || []).some((n) => n.length >= 3 &&
    t.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').includes(n.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim()));
  const closers = { open: "Want me to send over what I've got open?", day: 'What day were you looking to get it done?',
    part: 'Is morning or afternoon better for you?', address: "What's the address I'd be coming to?", none: "Let me know when you'd like it done." };
  const mk = (id, label, note, text, optional) => {
    const own = (say.custom || {})[id];
    let t = own || (banned(text) ? '' : text);
    if (t && say.signoff === 'always') t += ' - Mikey';
    if (t && say.signoff === 'first' && id === 'booking:confirm') t += ' - Mikey';
    return { id, label, note, text: t, optional: !!optional, custom: !!own, chars: t.length };
  };
  return [
    mk('booking:confirm', 'Booking confirmed', 'When you tap Confirm', 'Got you down for Tue, Aug 4 at 10:00 AM, Full Detail.'),
    mk('booking:remind24', 'Day-before reminder', 'Sent 24 hrs before', "Reminder, I've got your car tomorrow at 10:00 AM."),
    mk('run:done', 'All finished', 'Jobs board', 'Hey Dana, all done and it came out great.' + (say.reviewAsk === false ? '' : ' Review: https://g.page/r/abc')),
    mk('followup:won:review', 'Review ask', 'A day after a won job', say.reviewAsk === false ? '' : 'Thanks again Dana. A review helps a lot.', true),
    mk('opener', 'Quote form first text', 'The closing question', "Hey Dana, it's Mikey. I got your quote. " + (closers[say.closer] || closers.open)),
  ];
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { // The would_silence refusal is a deliberate 422 and shows up here as a
  // failed resource load. It is the feature working, not a fault.
  if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script|422 \(Unprocessable/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

const sayPosts = [], configPosts = [];
await page.route('**/*', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/threads') return json({ ok: true, threads: rows, config });
  if (path === '/api/say') {
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
    sayPosts.push(body);
    const say = Object.assign({}, config.say, body.say || {});
    const msgs = build(say);
    return json({ ok: true, say, messages: msgs, silenced: msgs.filter((m) => !m.optional && !m.text).map((m) => ({ id: m.id, label: m.label })) });
  }
  if (path === '/api/config') {
    if (req.method() === 'POST') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      configPosts.push(body);
      if (body.say) {
        const silenced = build(Object.assign({}, config.say, body.say)).filter((m) => !m.optional && !m.text);
        // The server's one refusal, mirrored: a ban that empties a message.
        if (silenced.length) return route.fulfill({ status: 422, contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'would_silence', silenced: silenced.map((m) => ({ id: m.id, label: m.label })) }) });
      }
      config = Object.assign({}, config, body);
    }
    return json({ ok: true, config });
  }
  if (path === '/api/money') return json({ ok: true, month: '2026-08', today: '2026-08-15', entries: [], nudges: [], owed: [], summary: {}, config: {} });
  if (path === '/api/day') return json({ ok: true, date: '2026-08-15', jobs: [], manual: [], order: [], summary: { total: 0, done: 0, remaining: 0, booked: 0, earned: 0, hours: 0 } });
  if (path === '/api/detections') return json({ ok: true, detections: [], config: { enabled: true } });
  if (path === '/api/ai/usage') return json({ ok: true, days: 14, today: '2026-08-25', total: { calls: 0, in: 0, out: 0, days: 0 }, todayTotal: { calls: 0, in: 0, out: 0 }, bySurface: [] });
  if (path === '/api/version') return json({ ok: true, build: 'test' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await page.goto('https://texting.test/');
await page.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const bodyText = () => page.locator('#sayBody').innerText();
// One message's rendered block. Scoped, because the whole-body text also
// carries the option labels of the dropdowns, and "What day..." is one of them.
const msgText = (id) => page.locator('[data-saymsg="' + id + '"]').innerText();

section('he can actually get to it: ☰ → Settings → How I talk');
await page.locator('.navitem[data-tab="more"]').click();
await page.waitForTimeout(400);
await page.getByText('Settings', { exact: true }).first().click();
await page.waitForTimeout(500);
ok('the settings sheet offers it', await page.locator('#cfgSayOpen').count() === 1);
await page.locator('#cfgSayOpen').click();
await page.waitForTimeout(600);
ok('the screen opens', await page.locator('#sayScreen').count() === 1);
ok('and it asked the server to render the messages', sayPosts.length >= 1);

section('it shows every message as it would actually send');
let txt = await bodyText();
ok('the booking confirmation is shown', /Booking confirmed/.test(txt));
ok('…with its real wording', /Got you down for Tue, Aug 4/.test(txt));
ok('the quote text is shown', /Quote form first text/.test(txt));
ok('…ending on the current closing question', /what I've got open\?/i.test(await msgText('opener')));

section('banning a phrase, and seeing it work before saving');
await page.locator('#sayNeverNew').fill('got you down');
await page.locator('#sayNeverAdd').click();
await page.waitForTimeout(500);
txt = await bodyText();
ok('the ban is listed back to him', /got you down/i.test(txt));
ok('it previewed the UNSAVED rule', sayPosts.some((p) => (p.say && p.say.never || []).includes('got you down')));
ok('nothing was saved yet', !configPosts.some((p) => p.say));
ok('the screen says that message has nothing left', /Nothing left to send|would have nothing/i.test(txt), txt.slice(0, 400));

section('…and saving that is refused, naming what would break');
await page.locator('#saySave').click();
await page.waitForTimeout(600);
ok('it tried to save', configPosts.some((p) => p.say));
ok('the screen stayed open rather than closing on a failure', await page.locator('#sayScreen').count() === 1);
ok('and it names the message', /Booking confirmed/.test(await bodyText()));

section('removing the ban puts the wording back');
await page.locator('[data-saydel="0"]').click();
await page.waitForTimeout(500);
txt = await bodyText();
ok('the message is back', /Got you down for Tue, Aug 4/.test(txt));
ok('nothing is flagged silenced', !/would have nothing/i.test(txt));

section('the closing question is a real choice');
await page.locator('#sayCloser').selectOption('day');
await page.waitForTimeout(500);
ok('picking "what day" shows it', /What day were you looking/i.test(await msgText('opener')));
await page.locator('#sayCloser').selectOption('none');
await page.waitForTimeout(500);
ok('picking "nothing" drops the question', !/What day were you looking/i.test(await msgText('opener')), await msgText('opener'));
ok('…and the text still says something', (await msgText('opener')).length > 40);
await page.locator('#sayCloser').selectOption('open');
await page.waitForTimeout(500);

section('the switches move the preview');
await page.locator('#sayReview').click();
await page.waitForTimeout(500);
txt = await bodyText();
ok('review ask off removes the link', !/g\.page/.test(txt), txt.slice(0, 300));
ok('…and the review-only follow-up reads as switched off, not broken', /Switched off/i.test(txt));
await page.locator('#sayReview').click();
await page.waitForTimeout(500);
ok('turning it back on restores it', /g\.page/.test(await bodyText()));

section('sign-off policy');
await page.locator('#saySignoff').selectOption('always');
await page.waitForTimeout(500);
ok('"every text" signs the reminder too', /tomorrow at 10:00 AM\. - Mikey/.test(await bodyText()), (await bodyText()).slice(0, 400));
await page.locator('#saySignoff').selectOption('first');
await page.waitForTimeout(500);

section('he can write any message himself');
await page.locator('[data-saycustom="booking:remind24"]').fill('See you tomorrow at {time}.');
await page.locator('[data-saycustom="booking:remind24"]').blur();
await page.waitForTimeout(600);
txt = await bodyText();
ok('his wording is what the preview shows', /See you tomorrow at \{time\}\./.test(txt));
ok('and it is marked as his', /your wording/i.test(txt));
ok('a Clear button appears for it', await page.locator('[data-sayclear="booking:remind24"]').count() === 1);
await page.locator('[data-sayclear="booking:remind24"]').click();
await page.waitForTimeout(500);
ok('clearing puts the built-in back', /Reminder, I've got your car tomorrow/.test(await bodyText()));

section('saving a legal set of rules works and closes');
await page.locator('#sayCloser').selectOption('part');
await page.waitForTimeout(500);
await page.locator('#saySave').click();
await page.waitForTimeout(700);
const saved = configPosts.filter((p) => p.say).pop();
ok('it saved the rules', !!saved && saved.say.closer === 'part', saved);
ok('and the screen closed', await page.locator('#sayScreen').count() === 0);

section('No page errors');
ok('no page errors', errs.length === 0, errs);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
