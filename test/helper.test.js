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
