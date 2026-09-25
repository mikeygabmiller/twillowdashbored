// The helper PIN, end to end through the real Worker.
//
// What this guards is a permission boundary, so it is tested the way an
// attacker or a confused helper would meet it: real requests into the real
// router, with a fake KV and a fake Twilio underneath. Lifting functions out
// (the way most unit suites here do) would test a copy of the gate, and the
// failure that matters is the gate itself — one route reachable that shouldn't
// be, or a cookie anyone can mint.
//
//   node test/helper.test.js
import crypto from 'node:crypto';

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

// ---- fakes ----
const store = new Map();
const KV = {
  async get(k, o) { const v = store.has(k) ? store.get(k) : null; if (v == null) return null; return o && (o.type === 'json' || o === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { store.delete(k); },
  async list(o) { const p = (o && o.prefix) || ''; return { keys: [...store.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true }; },
};
const outbound = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  outbound.push({ url: u, body: init && init.body ? String(init.body) : '' });
  if (u.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM' + outbound.length, status: 'queued' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const ENV = {
  DASHBOARD_PASSWORD: '7777', TWILIO_AUTH_TOKEN: 'server-only-secret', TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_FROM: '+14255550000', MIKEY_PHONE: '+14255550001', MESSAGES: KV,
};
const worker = (await import('../src/index.js')).default;

let ipN = 0;
async function call(method, path, { body, cookie, ip } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip || '10.0.0.' + (++ipN) };
  if (cookie) headers.Cookie = 'mkd_auth=' + cookie;
  const req = new Request('https://dash.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, ENV, { waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { data = null; }
  const sc = res.headers.get('Set-Cookie') || '';
  const m = sc.match(/mkd_auth=([^;]*)/);
  return { status: res.status, data, cookie: m ? m[1] : null };
}

// ---- a customer to text ----
const CUST = '+14255551234';
await KV.put('thread:' + CUST, JSON.stringify({ phone: CUST, name: 'Dale Hobart', messages: [{ dir: 'in', body: 'you around thursday?', ts: Date.now() - 3600000 }], unread: 1 }));

console.log('\nThe old cookie can no longer be minted from the public code');
{
  const naive = crypto.createHash('sha256').update('mkd:7777').digest('hex');
  ok((await call('GET', '/api/threads', { cookie: naive })).status === 401, 'sha256("mkd:"+PIN) — the old, guessable cookie — is refused');
  ok((await call('GET', '/api/threads')).status === 401, 'no cookie is refused');
}

console.log('\nMikey signs in as the owner');
const owner = await call('POST', '/api/login', { body: { password: '7777' } });
ok(owner.status === 200 && owner.data.role === 'owner' && owner.cookie, 'his PIN signs him in as owner');
ok((await call('GET', '/api/config', { cookie: owner.cookie })).status === 200, 'owner reaches settings');
ok((await call('GET', '/api/whoami', { cookie: owner.cookie })).data.role === 'owner', 'whoami says owner');

console.log('\nNo helper until he sets one up');
ok((await call('POST', '/api/login', { body: { password: '5150' } })).status === 401, 'an unset helper PIN signs nobody in');

console.log('\nSetting the helper PIN');
{
  const mine = await call('POST', '/api/config', { cookie: owner.cookie, body: { helperPassword: '7777' } });
  ok(mine.status === 422 && mine.data.error === 'helper_pin_is_yours', 'his own PIN is refused as the helper PIN');
  const short = await call('POST', '/api/config', { cookie: owner.cookie, body: { helperPassword: '12' } });
  ok(short.status === 422, 'a PIN under 4 characters is refused');
  const set = await call('POST', '/api/config', { cookie: owner.cookie, body: { helperPassword: '5150', helperName: 'Jess' } });
  ok(set.status === 200 && set.data.ok, 'a helper PIN and name save');
  ok(!('helperPassword' in set.data.config) && set.data.config.helperPinSet === true, 'the PIN never comes back out, only that one is set');
  const cfg = await call('GET', '/api/config', { cookie: owner.cookie });
  ok(!JSON.stringify(cfg.data).includes('5150'), 'GET /api/config never contains the PIN');
  ok(cfg.data.config.helperSince > Date.now() - 60000, 'a first helper PIN starts their "needs reply" from now');
}

console.log('\nThe helper signs in and gets the helper role');
const helper = await call('POST', '/api/login', { body: { password: '5150' } });
ok(helper.status === 200 && helper.data.role === 'helper' && helper.cookie, 'helper PIN signs in as helper');
ok(helper.cookie !== owner.cookie, 'helper cookie is not the owner cookie');
{
  const w = await call('GET', '/api/whoami', { cookie: helper.cookie });
  ok(w.data.role === 'helper' && w.data.name === 'Jess', 'whoami says helper, named Jess');
}

console.log('\nEverything outside the texting page is closed to the helper');
for (const [m, p] of [['GET', '/api/config'], ['POST', '/api/config'], ['GET', '/api/money'], ['GET', '/api/snapshot'],
  ['GET', '/api/bookings'], ['POST', '/api/booking-settings'], ['GET', '/api/insights'], ['POST', '/api/meta'],
  ['POST', '/api/schedule'], ['POST', '/api/call'], ['GET', '/api/ai/usage'], ['POST', '/api/templates'], ['GET', '/api/media?u=' + encodeURIComponent('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json')], ['GET', '/api/some-route-added-next-month']]) {
  const r = await call(m, p, { cookie: helper.cookie, body: m === 'POST' ? {} : undefined });
  ok(r.status === 403 && r.data.error === 'helper_not_allowed', `${m} ${p} → 403`);
}

console.log('\nWhat the texting page needs is open');
{
  const t = await call('GET', '/api/threads', { cookie: helper.cookie });
  ok(t.status === 200 && t.data.ok, 'inbox list');
  const th = await call('GET', '/api/thread?phone=' + encodeURIComponent(CUST), { cookie: helper.cookie });
  ok(th.status === 200 && th.data.thread && th.data.thread.name === 'Dale Hobart', 'a conversation');
  const g = await call('GET', '/api/helper/guide', { cookie: helper.cookie });
  ok(g.status === 200 && g.data.guide.length >= 5 && g.data.quick.length >= 5, 'the guide and quick replies');
  ok(Array.isArray(g.data.prices) && g.data.prices.length >= 3 && g.data.prices.some((p) => p.price && p.price.sedan === 299), 'live price list from booking settings ($299 full detail, sedan)');
  const txt = JSON.stringify(g.data.guide) + JSON.stringify(g.data.quick);
  ok(!/licensed|insured/i.test(txt.replace(/Never say he's licensed or insured/, '')), 'the guide never asserts licensed/insured');
  ok(/Lynnwood and Edmonds are a no/.test(txt), 'the guide keeps Lynnwood and Edmonds out');
  // "Sorry we couldn't work it out" is him and the customer, and it's his own
  // wording. The business "we" (we come to you, we offer) is what's banned.
  ok(!/\bwe(?:'ll| will| can| come| do| offer| bring| are| have)\b/i.test(JSON.stringify(g.data.quick)), 'quick replies are first person, no business "we"');
  ok(g.data.since > 0, 'the guide carries the start line');
  const fresh = await call('POST', '/api/config', { cookie: helper.cookie, body: { helperSince: 0 } });
  ok(fresh.status === 403, 'the helper can\'t move their own start line');
  const empty = await call('POST', '/api/ai/draft', { cookie: helper.cookie, body: { phone: CUST } });
  ok(empty.status === 422 && empty.data.error === 'helper_needs_text', '"write me one" without text is Mikey\'s, not the helper\'s');
}

console.log('\nA helper text goes out tagged with their name — and only their name');
{
  const before = outbound.length;
  const s = await call('POST', '/api/send', { cookie: helper.cookie, body: { phone: CUST, body: 'Thursday could work, what part of town are you in?', by: 'Mikey' } });
  ok(s.status === 200 && s.data.ok, 'send works');
  const tw = outbound.slice(before).find((o) => o.url.includes('api.twilio.com'));
  ok(tw && tw.body.includes('Thursday'), 'it reached Twilio');
  const last = s.data.thread.messages[s.data.thread.messages.length - 1];
  ok(last.dir === 'out' && last.by === 'Jess', 'tagged "Jess" even though the page claimed "Mikey"');
  // Anywhere but the conversation itself. Proven against a control: the same
  // kind of send from Mikey DOES land in the voice store, so this isn't passing
  // because nothing ever does.
  const outside = (phrase) => [...store.entries()].some(([k, v]) => k.startsWith('voice') && String(v).includes(phrase));
  ok(!outside('what part of town'), 'the helper\'s words are kept out of Mikey\'s voice samples');
  await call('POST', '/api/send', { cookie: owner.cookie, body: { phone: CUST, body: 'Friday around noon works great for me, see you then' } });
  ok(outside('Friday around noon works great'), 'control: Mikey\'s own send does train his voice');
}

console.log('\nAsk Mikey reaches Mikey and is marked on the thread');
{
  const before = outbound.length;
  const a = await call('POST', '/api/helper/ask', { cookie: helper.cookie, body: { phone: CUST, question: 'Two RAV4s, can I offer $280 each?' } });
  ok(a.status === 200 && a.data.ok && a.data.helperAsk && a.data.helperAsk.by === 'Jess', 'ask saved with who asked');
  ok(outbound.length > before, 'an alert went out to Mikey');
  const th = await call('GET', '/api/thread?phone=' + encodeURIComponent(CUST), { cookie: helper.cookie });
  ok(th.data.thread.helperAsk && /RAV4/.test(th.data.thread.helperAsk.question), 'the thread shows it was asked');
  const rd = await call('POST', '/api/request-date', { cookie: helper.cookie, body: { phone: CUST, note: 'Thu or Fri', by: 'Someone else' } });
  ok(rd.status === 200 && rd.data.thread.dateRequest.by === 'Jess', 'date request is signed Jess, not what the page sent');
}

console.log('\nPhotos: only what the customer actually sent');
{
  const PH = '+14255559876';
  const TS = Date.now() - 5000;
  const PIC = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1';
  await KV.put('thread:' + PH, JSON.stringify({ phone: PH, name: 'Photo Person', messages: [{ dir: 'in', body: '', ts: TS, media: [{ url: PIC, type: 'image/jpeg' }] }] }));
  const before = outbound.length;
  const r = await call('GET', `/api/helper/media?phone=${encodeURIComponent(PH)}&ts=${TS}&n=0`, { cookie: helper.cookie });
  ok(r.status === 200, 'their photo loads');
  ok(outbound.slice(before).some((o) => o.url === PIC), 'fetched from the URL stored on the thread');
  const sneaky = await call('GET', `/api/helper/media?phone=${encodeURIComponent(PH)}&ts=${TS}&n=0&u=${encodeURIComponent('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json')}`, { cookie: helper.cookie });
  ok(!outbound.slice(before).some((o) => /Messages\.json/.test(o.url)), 'a URL passed by the page is ignored');
  ok(sneaky.status === 200, '(and the real photo still loads)');
  ok((await call('GET', `/api/helper/media?phone=${encodeURIComponent(PH)}&ts=123&n=0`, { cookie: helper.cookie })).status === 404, 'a message that doesn\'t exist is a 404');
  ok((await call('GET', `/api/helper/media?phone=${encodeURIComponent(PH)}&ts=${TS}&n=5`, { cookie: helper.cookie })).status === 404, 'a photo slot that doesn\'t exist is a 404');
}

console.log('\nSchedule: what is already booked');
{
  const J = '+14255550777';
  const tomorrowNoon = Date.now() + 26 * 3600000;
  await KV.put('thread:' + J, JSON.stringify({ phone: J, name: 'Booked Betty', appointmentAt: tomorrowNoon, messages: [{ dir: 'out', body: 'see you then', ts: Date.now() - 1000 }] }));
  await call('POST', '/api/meta', { cookie: owner.cookie, body: { phone: J, appointmentAt: tomorrowNoon } });
  const w = await call('GET', '/api/helper/week', { cookie: helper.cookie });
  ok(w.status === 200 && w.data.days.length === 14, 'two weeks of days');
  const withJob = w.data.days.find((d) => d.jobs.some((j) => j.name === 'Booked Betty'));
  ok(!!withJob, 'the booked job shows up');
  ok(withJob && withJob.room === w.data.maxPerDay - withJob.jobs.length, 'room left = cars a day minus booked');
}

console.log('\nSaving a name, address and car');
{
  const c = await call('POST', '/api/helper/contact', { cookie: helper.cookie, body: { phone: CUST, name: 'Dale H.', address: '123 Main St, Snohomish', car: '2019 Toyota RAV4' } });
  ok(c.status === 200 && c.data.thread.name === 'Dale H.', 'name saved');
  ok(c.data.thread.garage.address === '123 Main St, Snohomish', 'address saved');
  const v = c.data.thread.garage.vehicles[0];
  ok(v && v.year === '2019' && v.make === 'Toyota' && v.model === 'RAV4', 'car saved as year / make / model');
  const again = await call('POST', '/api/helper/contact', { cookie: helper.cookie, body: { phone: CUST, car: '2019 Toyota RAV4' } });
  ok(again.data.thread.garage.vehicles.length === 1, 'the same car twice isn\'t added twice');
  const sneak = await call('POST', '/api/helper/contact', { cookie: helper.cookie, body: { phone: CUST, archived: true, status: 'lost', notes: 'x' } });
  ok(!sneak.data.thread.archived && sneak.data.thread.notes !== 'x', 'nothing else on the thread can be changed from here');
}

console.log('\nNo reply needed');
{
  const N = '+14255550888';
  await KV.put('thread:' + N, JSON.stringify({ phone: N, name: 'Thanks Tom', messages: [{ dir: 'out', body: 'all done!', ts: Date.now() - 9000 }, { dir: 'in', body: 'awesome', ts: Date.now() - 5000 }] }));
  const d = await call('POST', '/api/helper/done', { cookie: helper.cookie, body: { phone: N } });
  ok(d.status === 200 && d.data.thread.replyCheck.needed === false && /Jess/.test(d.data.thread.replyCheck.reason), 'marked, signed with who did it');
  const rows = (await call('GET', '/api/threads', { cookie: owner.cookie })).data.threads;
  ok(rows.find((r) => r.phone === N).awaitingReply === false, 'Mikey\'s list agrees: nobody waiting');
  await KV.put('thread:' + N, JSON.stringify({ phone: N, messages: [{ dir: 'out', body: 'hi', ts: Date.now() }] }));
  ok((await call('POST', '/api/helper/done', { cookie: helper.cookie, body: { phone: N } })).status === 409, 'nothing to mark when Mikey spoke last');
}

console.log('\nAsk → Mikey answers → the helper sees it');
{
  const rows0 = (await call('GET', '/api/threads', { cookie: helper.cookie })).data.threads;
  ok(rows0.find((r) => r.phone === CUST).helperAskAt > 0, 'the list row knows something was asked');
  ok((await call('POST', '/api/helper/answer', { cookie: helper.cookie, body: { phone: CUST, answer: 'yes' } })).status === 403, 'the helper can\'t answer their own question');
  const sub = await call('POST', '/api/helper/push', { cookie: helper.cookie, body: { endpoint: 'https://push.example.test/abc' } });
  ok(sub.status === 200 && sub.data.devices === 1, 'the helper\'s phone signs up for alerts');
  ok((await KV.get('push:subs', { type: 'json' })) === null, 'into their own list, not Mikey\'s');
  const before = outbound.length;
  const a = await call('POST', '/api/helper/answer', { cookie: owner.cookie, body: { phone: CUST, answer: 'Yes, $280 each is fine.' } });
  ok(a.status === 200 && a.data.thread.helperAsk.answer === 'Yes, $280 each is fine.', 'Mikey\'s answer is saved on the thread');
  ok(outbound.slice(before).some((o) => o.url === 'https://push.example.test/abc'), 'the helper\'s phone gets a buzz');
  ok(!outbound.slice(before).some((o) => o.url.includes('api.twilio.com')), 'nothing is texted to the customer');
  const peek = await call('GET', '/api/push/peek', { cookie: helper.cookie });
  ok(peek.status === 200 && /Mikey answered/.test(peek.data.title) && peek.data.url === '/helper?c=' + encodeURIComponent(CUST), 'the alert says Mikey answered and opens that conversation');
  const rows1 = (await call('GET', '/api/threads', { cookie: helper.cookie })).data.threads;
  ok(rows1.find((r) => r.phone === CUST).helperAnsweredAt > 0, 'the list row knows it was answered');
  const th = await call('GET', '/api/thread?phone=' + encodeURIComponent(CUST), { cookie: helper.cookie });
  ok(th.data.thread.helperAsk.answer === 'Yes, $280 each is fine.', 'the helper reads it on the thread');
  const off = await call('POST', '/api/helper/push', { cookie: helper.cookie, body: { endpoint: 'https://push.example.test/abc', off: true } });
  ok(off.data.devices === 0, 'alerts can be turned off again');
}

console.log('\nOrganizing: stages, labels, notes, follow-ups, checklist');
{
  const O = '+14255550999';
  await KV.put('thread:' + O, JSON.stringify({ phone: O, name: 'Org Olivia', status: 'active', tags: ['booking'], messages: [{ dir: 'in', body: 'hi, 2 cars', ts: Date.now() - 5000 }] }));
  const org = (body) => call('POST', '/api/helper/organize', { cookie: helper.cookie, body: Object.assign({ phone: O }, body) });
  const st = await org({ stage: 'done' });
  ok(st.status === 200 && st.data.thread.helperStage === 'done', 'stage set');
  ok(st.data.thread.status === 'active', 'Mikey\'s status (which fires review/win-back texts) is untouched');
  ok(!st.data.thread.followup || !/won|lost/.test(JSON.stringify(st.data.thread.followup)), 'no won/lost follow-up was started');
  ok((await org({ stage: 'won' })).status === 422, 'only the helper stages are accepted');
  const lb = await org({ addLabel: 'pet hair' });
  ok(lb.status === 200 && lb.data.thread.tags.includes('Pet hair'), 'a label is added in its proper spelling');
  ok(lb.data.thread.tags.includes('booking'), 'the app\'s own tags are kept');
  ok((await org({ removeLabel: 'booking' })).status === 422, 'the helper can\'t remove a system tag');
  ok((await org({ addLabel: 'practice' })).status === 422, 'or add one');
  ok((await org({ newLabel: 'Quoted' })).status === 422, 'or create a label with a system tag\'s name');
  const nl = await org({ newLabel: 'Needs pickup' });
  ok(nl.status === 200 && nl.data.labels.includes('Needs pickup') && nl.data.thread.tags.includes('Needs pickup'), 'a new label joins the set and goes on this customer');
  const g = await call('GET', '/api/helper/guide', { cookie: helper.cookie });
  ok(g.data.labels.includes('Needs pickup'), 'and is offered everywhere after');
  const n1 = await org({ note: 'Gate code 5232' });
  const note = n1.data.thread.helperNotes[0];
  ok(note && note.text === 'Gate code 5232' && note.by === 'Jess' && note.at > 0, 'note saved, signed and timed');
  ok((await org({ deleteNote: note.id })).data.thread.helperNotes.length === 0, 'note deleted');
  const due = Date.now() - 60000;
  const f = await org({ follow: { at: due, note: 'landlord ok?' } });
  ok(f.status === 200 && f.data.thread.helperFollow.note === 'landlord ok?', 'follow-up set');
  ok((await org({ follow: { at: Date.now() + 400 * 864e5 } })).status === 422, 'a follow-up a year+ out is refused');
  await org({ follow: { at: due, note: 'landlord ok?' } });
  const row = (await call('GET', '/api/threads', { cookie: helper.cookie })).data.threads.find((r) => r.phone === O);
  ok(row.helperStage === 'done' && row.helperFollowAt === due && row.tags.includes('Pet hair'), 'the list row carries stage, follow-up and labels');
  const ck = await org({ check: { key: 'days', on: true } });
  ok(ck.data.thread.helperChecks.days === true, 'a checklist box ticks');
  ok((await org({ check: { key: 'status', on: true } })).data.thread.helperChecks.status === undefined, 'only real checklist keys are stored');

  // The reminder buzzes the helper once, and only the helper.
  await call('POST', '/api/helper/push', { cookie: helper.cookie, body: { endpoint: 'https://push.example.test/fol' } });
  const before = outbound.length;
  await worker.scheduled({}, ENV, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 300));
  const hits = outbound.slice(before).filter((o) => o.url === 'https://push.example.test/fol').length;
  ok(hits === 1, 'a due follow-up buzzes the helper\'s phone (' + hits + ')');
  const peek = await call('GET', '/api/push/peek', { cookie: helper.cookie });
  ok(/Follow up: Org Olivia/.test(peek.data.title) && /landlord/.test(peek.data.body), 'the alert names who and why');
  const before2 = outbound.length;
  await worker.scheduled({}, ENV, { waitUntil: (p) => p });
  await new Promise((r) => setTimeout(r, 300));
  ok(!outbound.slice(before2).some((o) => o.url === 'https://push.example.test/fol'), 'and only once');
  ok(!outbound.slice(before).some((o) => /api\.twilio\.com.*Messages\.json/.test(o.url) && o.body.includes(encodeURIComponent(O))), 'nothing texted to the customer');
  await call('POST', '/api/helper/push', { cookie: helper.cookie, body: { endpoint: 'https://push.example.test/fol', off: true } });
  ok((await call('POST', '/api/helper/organize', { cookie: owner.cookie, body: { phone: O, note: 'from Mikey' } })).status === 200, 'Mikey can organize too');
}

console.log('\nMikey can start them fresh, without touching a thread');
{
  const before = (await KV.get('thread:' + CUST, { type: 'json' }));
  const r = await call('POST', '/api/config', { cookie: owner.cookie, body: { helperSince: Date.now() } });
  ok(r.status === 200 && r.data.config.helperSince > 0, 'owner resets the start line');
  const after = (await KV.get('thread:' + CUST, { type: 'json' }));
  ok(JSON.stringify(before) === JSON.stringify(after), 'no conversation is changed by it');
  const fut = await call('POST', '/api/config', { cookie: owner.cookie, body: { helperSince: Date.now() + 864e5 } });
  ok(fut.data.config.helperSince <= Date.now(), 'a start line in the future is pulled back to now');
}

console.log('\nChanging or clearing the PIN signs the helper out');
{
  await call('POST', '/api/config', { cookie: owner.cookie, body: { helperPassword: '2468' } });
  ok((await call('GET', '/api/threads', { cookie: helper.cookie })).status === 401, 'old helper cookie dies when the PIN changes');
  const h2 = await call('POST', '/api/login', { body: { password: '2468' } });
  ok(h2.data.role === 'helper', 'new PIN works');
  await call('POST', '/api/config', { cookie: owner.cookie, body: { helperPassword: '' } });
  ok((await call('GET', '/api/threads', { cookie: h2.cookie })).status === 401, 'clearing the PIN signs them out');
  ok((await call('POST', '/api/login', { body: { password: '2468' } })).status === 401, 'and the cleared PIN no longer signs in');
  ok((await call('GET', '/api/threads', { cookie: owner.cookie })).status === 200, 'Mikey stays signed in through all of it');
}

console.log('\nGuessing gets cut off');
{
  const ip = '203.0.113.9';
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/login', { ip, body: { password: String(1000 + i) } });
  ok(last.status === 401, 'six wrong tries are each just wrong');
  const seventh = await call('POST', '/api/login', { ip, body: { password: '7777' } });
  ok(seventh.status === 429 && seventh.data.error === 'locked' && seventh.data.minutes > 0, 'the seventh try is locked out, even with the right PIN');
  ok((await call('POST', '/api/login', { ip: '203.0.113.10', body: { password: '7777' } })).status === 200, 'another address is unaffected');
  const ip2 = '203.0.113.11';
  await call('POST', '/api/login', { ip: ip2, body: { password: '0000' } });
  const good = await call('POST', '/api/login', { ip: ip2, body: { password: '7777' } });
  ok(good.status === 200 && !store.has('loginfail:' + ip2), 'a right PIN clears the count');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
