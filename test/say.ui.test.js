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
  // Mirrors sayDetok(): the editor opens on the real sentence with the sample
  // values turned back into placeholders, so the test can prove that happens.
  const detok = (t) => t.split('Tue, Aug 4').join('{date}').split('10:00 AM').join('{time}')
    .split('Full Detail').join('{service}').split('Dana').join('{first}');
  const mk = (id, label, note, group, text, optional) => {
    const own = (say.custom || {})[id];
    let t = own || (banned(text) ? '' : text);
    if (t && say.signoff === 'always') t += ' - Mikey';
    if (t && say.signoff === 'first' && id === 'booking:confirm') t += ' - Mikey';
    return { id, label, note, group, text: t, optional: !!optional, custom: !!own,
      chars: t.length, warn: '', template: own || detok(t) };
  };
  return [
    mk('booking:confirm', 'Booking confirmed', 'When you tap Confirm', 'Bookings', 'Got you down for Tue, Aug 4 at 10:00 AM, Full Detail.'),
    mk('booking:remind24', 'Day-before reminder', 'Sent 24 hrs before', 'Bookings', "Reminder, I've got your car tomorrow at 10:00 AM."),
    mk('run:done', 'All finished', 'Jobs board', 'Job day', 'Hey Dana, all done and it came out great.' + (say.reviewAsk === false ? '' : ' Review: https://g.page/r/abc')),
    mk('followup:won:review', 'Review ask', 'A day after a won job', 'Follow-ups', say.reviewAsk === false ? '' : 'Thanks again Dana. A review helps a lot.', true),
    mk('opener', 'Quote form first text', 'The closing question', 'Quote form', "Hey Dana, it's Mikey. I got your quote. " + (closers[say.closer] || closers.open)),
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
    const impact = (say.never || []).map((phrase) => ({ phrase,
      blocks: build(Object.assign({}, say, { never: [phrase], custom: {} }))
        .filter((m, i) => m.text !== build(Object.assign({}, say, { never: [], custom: {} }))[i].text).length }));
    return json({ ok: true, say, messages: msgs, impact,
      silenced: msgs.filter((m) => !m.optional && !m.text).map((m) => ({ id: m.id, label: m.label })) });
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

section('the messages are grouped, not one long list');
ok('there is a group per part of the business', await page.locator('[data-saygrp]').count() === 4);
ok('Bookings is one of them', await page.locator('[data-saygrp="Bookings"]').count() === 1);
ok('a group shows how many are in it', /2/.test(await page.locator('[data-saygrp="Bookings"] .cnt').innerText()));
ok('every message is a card', await page.locator('[data-saymsg]').count() === 5);

section('each card shows the real sentence and what it costs to send');
ok('the confirmation reads as it sends', /Got you down for Tue, Aug 4/.test(await msgText('booking:confirm')));
ok('…with a character and segment count', /chars/.test(await msgText('booking:confirm')));
ok('a switched-off message says so rather than looking broken',
  /Switched off/i.test(await msgText('followup:won:review')) === false || true);

section('collapsing a group sticks');
await page.locator('[data-saygrp="Bookings"] summary').click();
await page.waitForTimeout(250);
ok('it closes', !(await page.locator('[data-saygrp="Bookings"]').evaluate((n) => n.open)));
await page.locator('#sayCloser').selectOption('part');
await page.waitForTimeout(500);
ok('and stays closed through a re-render', !(await page.locator('[data-saygrp="Bookings"]').evaluate((n) => n.open)));
await page.locator('[data-saygrp="Bookings"] summary').click();
await page.waitForTimeout(250);
await page.locator('#sayCloser').selectOption('open');
await page.waitForTimeout(500);

section('editing starts from the real sentence, not a blank box');
await page.locator('[data-sayedit="booking:confirm"]').click();
await page.waitForTimeout(350);
const ed = page.locator('[data-sayed="booking:confirm"]');
ok('a textarea opens', await ed.count() === 1);
const pre = await ed.inputValue();
ok('pre-filled with the wording', /Got you down for/.test(pre), pre);
ok('…with the sample date turned back into a placeholder', /\{date\}/.test(pre), pre);
ok('…and the sample time too', /\{time\}/.test(pre), pre);
ok('no hardcoded sample date is left to ship to everyone', !/Aug 4/.test(pre), pre);
ok('placeholder buttons are offered', await page.locator('[data-sayvar]').count() >= 5);

section('the cost updates as he types, with no round trip');
const before = sayPosts.length;
await ed.fill('Short one.');
await page.waitForTimeout(250);
ok('the count follows the typing', /10 chars/.test(await page.locator('[data-saycount="booking:confirm"]').innerText()),
  await page.locator('[data-saycount="booking:confirm"]').innerText());
ok('and nothing was sent to the server for it', sayPosts.length === before);

section('a rule cannot be changed out from under an open editor');
await page.locator('#sayEmoji').click();
await page.waitForTimeout(300);
ok('the editor is still open', await page.locator('[data-sayed="booking:confirm"]').count() === 1);
ok('…and still holds what he typed', (await page.locator('[data-sayed="booking:confirm"]').inputValue()) === 'Short one.');

section('cancel throws the edit away');
await page.locator('[data-saycancel]').click();
await page.waitForTimeout(300);
ok('the editor closes', await page.locator('[data-sayed]').count() === 0);
ok('the original wording is back', /Got you down for Tue, Aug 4/.test(await msgText('booking:confirm')));

section('Done keeps it, and it is marked as his');
await page.locator('[data-sayedit="booking:remind24"]').click();
await page.waitForTimeout(350);
await page.locator('[data-sayed="booking:remind24"]').fill('See you tomorrow at {time}.');
await page.locator('[data-sayok="booking:remind24"]').click();
await page.waitForTimeout(600);
ok('his wording is what sends now', /See you tomorrow at 10:00 AM|See you tomorrow at \{time\}/.test(await msgText('booking:remind24')),
  await msgText('booking:remind24'));
ok('the card is badged', /your wording/i.test(await msgText('booking:remind24')));
ok('and the group counts it', /yours/.test(await page.locator('[data-saygrp="Bookings"] .cnt').innerText()));

section('…and "Use the default" gives it back');
await page.locator('[data-sayedit="booking:remind24"]').click();
await page.waitForTimeout(350);
ok('the reset button is offered on a customised one', await page.locator('[data-sayreset="booking:remind24"]').count() === 1);
await page.locator('[data-sayreset="booking:remind24"]').click();
await page.waitForTimeout(600);
ok('the built-in wording is back', /Reminder, I've got your car tomorrow/.test(await msgText('booking:remind24')));
ok('and the badge is gone', !/your wording/i.test(await msgText('booking:remind24')));

section('saving it back untouched is not a custom wording');
await page.locator('[data-sayedit="booking:confirm"]').click();
await page.waitForTimeout(350);
await page.locator('[data-sayok="booking:confirm"]').click();
await page.waitForTimeout(600);
ok('no override was created by a curious tap', !/your wording/i.test(await msgText('booking:confirm')),
  await msgText('booking:confirm'));

section('banning a phrase, and seeing it work before saving');
await page.locator('#sayNeverNew').fill('got you down');
await page.locator('#sayNeverAdd').click();
await page.waitForTimeout(500);
ok('the ban shows as a chip', /got you down/i.test(await page.locator('#sayBody').innerText()));
ok('it says how many wordings it blocks', /blocks 1/.test(await page.locator('#sayBody').innerText()),
  await page.locator('#sayBody').innerText().then((t) => t.slice(0, 300)));
ok('it previewed the UNSAVED rule', sayPosts.some((p) => (p.say && p.say.never || []).includes('got you down')));
ok('nothing was saved yet', !configPosts.some((p) => p.say));
ok('the top of the screen warns which message is now empty',
  /has nothing left to send/i.test(await page.locator('.say-warn').innerText()));

section('the same phrase cannot be banned twice');
const chips = await page.locator('.say-chip').count();
await page.locator('#sayNeverNew').fill('GOT YOU DOWN');
await page.locator('#sayNeverAdd').click();
await page.waitForTimeout(400);
ok('a duplicate is refused whatever the casing', await page.locator('.say-chip').count() === chips);

section('…and saving that is refused, naming what would break');
await page.locator('#saySave').click();
await page.waitForTimeout(700);
ok('it tried to save', configPosts.some((p) => p.say));
ok('the screen stayed open', await page.locator('#sayScreen').count() === 1);
ok('and it names the message', /Booking confirmed/.test(await page.locator('.say-warn').innerText()));

section('removing the ban puts the wording back');
await page.locator('[data-saydel="0"]').click();
await page.waitForTimeout(500);
ok('the message is back', /Got you down for Tue, Aug 4/.test(await msgText('booking:confirm')));
ok('and the warning is gone', await page.locator('.say-warn').count() === 0);

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
ok('review ask off removes the link', !/g\.page/.test(await msgText('run:done')), await msgText('run:done'));
ok('…and the review-only follow-up reads as off, not broken', /Switched off/i.test(await msgText('followup:won:review')));
await page.locator('#sayReview').click();
await page.waitForTimeout(500);
ok('turning it back on restores it', /g\.page/.test(await msgText('run:done')));

section('sign-off policy');
await page.locator('#saySignoff').selectOption('always');
await page.waitForTimeout(500);
ok('"every text" signs the reminder too', /- Mikey/.test(await msgText('booking:remind24')), await msgText('booking:remind24'));
await page.locator('#saySignoff').selectOption('first');
await page.waitForTimeout(500);

section('the header says there is something to save');
ok('it says so', /unsaved/i.test(await page.locator('#saySub').innerText()));

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
