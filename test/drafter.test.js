// The hourly drafter's key, through the Worker's real front door.
//
// A Claude Code task on Mikey's own plan uses this key once an hour to see who
// is waiting on him and leave a draft (see DRAFTER_ROUTES). It reads customer
// texts, and a customer can type anything, so the key is only safe if it opens
// those two routes and nothing else. That is the first thing proved here, route
// by route, against the same fetch handler the live Worker runs. After that:
// the key is only ever stored as a hash; the queue lists exactly the
// conversations waiting on him and never a phone number; and a draft only lands
// when it is still an answer to the message it was written for.
//
//   node test/drafter.test.js
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const store = new Map();
const KV = {
  async get(k, o) { const v = store.has(k) ? store.get(k) : null; if (v == null) return null; return o && (o.type === 'json' || o === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { store.delete(k); },
  async list(o) { const p = (o && o.prefix) || ''; return { keys: [...store.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true }; },
};
// Anything that reaches Twilio is a text sent to a real phone. Counted, so the
// test can prove the drafter's key never caused one.
let twilioCalls = 0;
globalThis.fetch = async (url) => {
  if (/twilio\.com/.test(String(url))) twilioCalls++;
  return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
};
const ENV = {
  DASHBOARD_PASSWORD: '7777', TWILIO_AUTH_TOKEN: 'x', TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_FROM: '+14255550000', MIKEY_PHONE: '+14255550001', MESSAGES: KV, DETECT_DISABLED: '1',
};
const worker = (await import('../src/index.js')).default;
const OWNER = 'Bearer 7777';
let ipN = 0;
async function call(method, path, { auth, body } = {}) {
  // A fresh address per call, so the wrong-guess counter on one check can't
  // lock out the next.
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.9.0.' + (++ipN % 250) };
  if (auth != null) headers.Authorization = auth;
  const res = await worker.fetch(new Request('https://dash.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), ENV, { waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// ---- a small inbox --------------------------------------------------------
const NOW = Date.now(), MIN = 60000, DAY = 86400000;
const P = {
  waiting: '+14255550101',   // texted last, an hour ago: the one that should be drafted
  answered: '+14255550102',  // Mikey texted last
  stale: '+14255550103',     // texted last, ten days ago
  optout: '+14255550104',    // texted STOP at some point
  asked: '+14255550105',     // the instant drafter hung a "Needs you" question on it
  manual: '+14255550106',    // a draft somebody asked for by hand is waiting
  tapback: '+14255550107',   // the last thing is a tapback on his text
  practice: '+15555550100',  // the fake customer the app uses for practice
  waiting2: '+14255550108',  // a second waiting one, for the gates
};
const msg = (dir, body, ago, extra) => Object.assign({ id: 'm' + Math.random().toString(36).slice(2), dir, body, ts: NOW - ago }, extra || {});
const threads = {
  [P.waiting]: { name: 'Ted Basrak', messages: [
    msg('out', 'Hey Ted, any chance I come by this Wednesday?', 3 * 60 * MIN),
    msg('in', 'How much for an interior on my 2018 Sierra? Pretty dirty, dog hair everywhere', 60 * MIN),
  ] },
  [P.answered]: { name: 'Kara Lee', messages: [msg('in', 'Thursday works', 3 * 60 * MIN), msg('out', 'Great, see you then.', 2 * 60 * MIN)] },
  [P.stale]: { name: 'Old Lead', messages: [msg('in', 'Do you do boats?', 10 * DAY)] },
  [P.optout]: { name: 'Gone Away', messages: [msg('in', 'How much for a full detail?', 30 * MIN)] },
  [P.asked]: { name: 'Needs You', messages: [msg('in', 'What time can you come Thursday?', 20 * MIN)] },
  [P.manual]: { name: 'By Hand', messages: [msg('in', 'Still on for tomorrow?', 25 * MIN)] },
  [P.tapback]: { name: 'Tap Back', messages: [msg('out', 'Be there in 10.', 50 * MIN), msg('in', 'Liked "Be there in 10."', 49 * MIN, { kind: 'reaction', emoji: '👍' })] },
  [P.practice]: { name: 'Practice · Sam', messages: [msg('in', 'Perfect, Thursday works. What time?', 10 * MIN)] },
  [P.waiting2]: { name: 'Shana Hainz', messages: [msg('in', 'Can you do a full detail on my RAV4 next week?', 2 * 60 * MIN)] },
};
threads[P.asked].needsYou = { question: 'What time Thursday?', options: ['1pm', '3pm'], ts: NOW, forTs: threads[P.asked].messages[0].ts };
threads[P.manual].suggested = { text: 'Yes, still on!', ts: NOW, forTs: threads[P.manual].messages[0].ts, by: 'claude', manual: true };
const index = [];
for (const [phone, t] of Object.entries(threads)) {
  const doc = Object.assign({ phone, status: 'active', tags: [], notes: '', unread: 0 }, t);
  store.set('thread:' + phone, JSON.stringify(doc));
  const last = doc.messages[doc.messages.length - 1];
  index.push({ phone, name: doc.name, lastDir: last.dir, lastTs: last.ts, lastBody: last.body });
}
store.set('threads-index', JSON.stringify(index));
store.set('config', JSON.stringify({ optedOut: [P.optout] }));

section('Before a key exists');
ok('a made-up drafter key gets nothing', (await call('GET', '/api/drafter/queue', { auth: 'Bearer mkd_draft_madeup' })).status === 401);
ok('Settings says there is none', (await call('GET', '/api/config', { auth: OWNER })).data.config.drafterKey.set === false);

section('Making the key');
const made = await call('POST', '/api/drafter/key', { auth: OWNER, body: {} });
const KEY = made.data && made.data.key;
ok('only Mikey can make one, and he gets it back once', made.status === 200 && /^mkd_draft_[A-Za-z0-9_-]{30,}$/.test(KEY || ''), made.data);
const stored = JSON.parse(store.get('config'));
ok('only its hash is stored', /^[0-9a-f]{64}$/.test(stored.drafterKeyHash) && !store.get('config').includes(KEY));
const pub = (await call('GET', '/api/config', { auth: OWNER })).data.config;
ok('Settings learns it is set, and when', pub.drafterKey.set === true && pub.drafterKey.at > 0, pub.drafterKey);
ok('but never the hash', !('drafterKeyHash' in pub) && !JSON.stringify(pub).includes(stored.drafterKeyHash));
// The two screens that used to hand back the raw config doc. Owner-only, but the
// raw doc is also where his Anthropic key lives, and the promise on that key is
// that it never comes back down to a browser at all.
const fu = await call('GET', '/api/followups', { auth: OWNER });
ok('the follow-ups screen gets the filtered config too', fu.status === 200 && !JSON.stringify(fu.data).includes(stored.drafterKeyHash) && !('drafterKeyHash' in (fu.data.config || {})));
store.set('config', JSON.stringify(Object.assign(JSON.parse(store.get('config')), { anthropicApiKey: 'sk-ant-api03-SECRETSECRETSECRET0000' })));
const blk = await call('POST', '/api/block', { auth: OWNER, body: { phone: '+14255559999', action: 'block' } });
ok('and so does Block a number, with neither key in it',
  blk.status === 200 && !JSON.stringify(blk.data).includes('SECRETSECRET') && !JSON.stringify(blk.data).includes(stored.drafterKeyHash), blk.data && Object.keys(blk.data));
store.set('config', JSON.stringify(Object.assign(JSON.parse(store.get('config')), { anthropicApiKey: '' })));
const DRAFTER = 'Bearer ' + KEY;

section('The key opens its two routes and nothing else');
ok('it can read who is waiting', (await call('GET', '/api/drafter/queue', { auth: DRAFTER })).status === 200);
for (const [method, path, body] of [
  ['GET', '/api/threads'], ['GET', '/api/thread?phone=' + encodeURIComponent(P.waiting)],
  ['POST', '/api/send', { phone: P.waiting, body: 'sent by the drafter' }],
  ['POST', '/api/meta', { phone: P.waiting, draft: 'snuck in' }],
  ['GET', '/api/config'], ['POST', '/api/config', { autopilot: true }],
  ['GET', '/api/money'], ['GET', '/api/whoami'], ['POST', '/api/schedule', { phone: P.waiting, body: 'later', at: NOW + DAY }],
  ['POST', '/api/drafter/key', {}], ['POST', '/api/drafter/key', { revoke: true }],
]) {
  const r = await call(method, path, { auth: DRAFTER, body });
  ok(`${method} ${path.split('?')[0]} is closed to it (${r.status})`, r.status === 403 && r.data && r.data.error === 'drafter_not_allowed', r);
}
ok('and nothing it tried sent a text', twilioCalls === 0, twilioCalls);
ok('Mikey\'s own key still works on the same routes', (await call('GET', '/api/drafter/queue', { auth: OWNER })).status === 200);

section('The queue');
const q = (await call('GET', '/api/drafter/queue', { auth: DRAFTER })).data;
const convos = q.conversations || [];
ok('it carries his writing-style guide', typeof q.guide === 'string' && q.guide.startsWith('## Start here'));
ok('and his playbook', typeof q.playbook === 'string' && q.playbook.length > 200);
ok('exactly the two conversations waiting on him', convos.length === 2, convos.map((c) => c.firstName));
ok('longest wait first', convos[0] && convos[0].firstName === 'Shana' && convos[1].firstName === 'Ted', convos.map((c) => c.firstName));
const wire = JSON.stringify(q);
ok('no phone number anywhere in what it gets', !Object.values(P).some((p) => wire.includes(p) || wire.includes(p.slice(2))));
const ted = convos.find((c) => c.firstName === 'Ted') || {};
ok('each conversation has an opaque id', /^[0-9a-f]{16}$/.test(ted.id || ''), ted.id);
ok('first name only', ted.firstName === 'Ted' && !wire.includes('Basrak'));
ok('the conversation, in order, his and theirs', Array.isArray(ted.messages) && ted.messages.length === 2
  && ted.messages[0].from === 'mikey' && ted.messages[1].from === 'customer' && /Sierra/.test(ted.messages[1].text), ted.messages);
ok('and the message it is answering', ted.forTs === threads[P.waiting].messages[1].ts);
for (const [who, why] of [['Kara', 'he answered last'], ['Old', 'ten days quiet'], ['Gone', 'opted out'], ['Needs', 'a "Needs you" question is on it'],
  ['By', 'a hand-asked draft is waiting'], ['Tap', 'a tapback is not a message'], ['Practice', 'the practice customer']]) {
  ok(`left out: ${why}`, !convos.some((c) => c.firstName === who));
}

section('Leaving a draft');
const draft = (body) => call('POST', '/api/drafter/draft', { auth: DRAFTER, body });
ok('an unknown id is not found', (await draft({ id: '0123456789abcdef', forTs: ted.forTs, text: 'Hi' })).status === 404);
ok('a draft for an older message is refused as stale',
  (await draft({ id: ted.id, forTs: ted.forTs - 1, text: 'Sounds good!' })).data.error === 'stale');
// The gate lets through any sum of up to three written-down figures (a package
// plus add-ons is a real total), so the made-up price has to be one that no
// combination of his price book reaches. $999 isn't: it's $449 + $500 + $50.
const madeUp = await draft({ id: ted.id, forTs: ted.forTs, text: 'Great! An interior on your Sierra will be $7,777.' });
ok('a price that is written down nowhere is refused', madeUp.status === 422 && madeUp.data.error === 'invented_price', madeUp.data);
const madeTime = await draft({ id: ted.id, forTs: ted.forTs, text: 'Can we shoot for 3:45 on Friday?' });
ok('so is a time nobody agreed', madeTime.status === 422 && madeTime.data.error === 'invented_time', madeTime.data);
const good = await draft({ id: ted.id, forTs: ted.forTs,
  text: 'Sounds good! An interior detail on your Sierra is $289 — I can\'t guarantee every hair comes out, but I can sure as heck try.' });
ok('a draft that holds up is saved', good.status === 200 && good.data.ok, good.data);
const saved = JSON.parse(store.get('thread:' + P.waiting)).suggested;
ok('into the "Drafted for you" box, marked as the hourly drafter\'s', saved && saved.by === 'opus' && saved.forTs === ted.forTs, saved);
ok('with the em dash taken out on the way in', saved && !/[—–]/.test(saved.text), saved && saved.text);
ok('nothing was sent: it is only a draft', twilioCalls === 0, twilioCalls);
const q2 = (await call('GET', '/api/drafter/queue', { auth: DRAFTER })).data.conversations;
ok('the next run does not draft it again', !q2.some((c) => c.firstName === 'Ted'), q2.map((c) => c.firstName));

section('Passing on one');
const shana = convos.find((c) => c.firstName === 'Shana');
ok('a skip is accepted', (await draft({ id: shana.id, forTs: shana.forTs, skip: true, reason: 'needs his calendar' })).data.skipped === true);
ok('and it stops coming back', (await call('GET', '/api/drafter/queue', { auth: DRAFTER })).data.conversations.length === 0);

section('A draft lands only while he still owes the reply');
// Mikey answers Ted by hand: the queue's id still resolves, but the draft is no
// longer an answer to anything.
const tedDoc = JSON.parse(store.get('thread:' + P.waiting));
tedDoc.messages.push(msg('out', 'Hey Ted, $289 for the interior. When works?', 0));
store.set('thread:' + P.waiting, JSON.stringify(tedDoc));
ok('after he answers, a late draft is refused',
  ['stale', 'answered'].includes((await draft({ id: ted.id, forTs: ted.forTs, text: 'Sounds good!' })).data.error));

section('Retiring the key');
const remade = await call('POST', '/api/drafter/key', { auth: OWNER, body: {} });
ok('a new key works', (await call('GET', '/api/drafter/queue', { auth: 'Bearer ' + remade.data.key })).status === 200);
ok('and the old one stopped right then', (await call('GET', '/api/drafter/queue', { auth: DRAFTER })).status === 401);
const off = await call('POST', '/api/drafter/key', { auth: OWNER, body: { revoke: true } });
ok('Turn it off clears it', off.data.drafterKey.set === false && !JSON.parse(store.get('config')).drafterKeyHash);
ok('and no key works after', (await call('GET', '/api/drafter/queue', { auth: 'Bearer ' + remade.data.key })).status === 401);
ok('Mikey can still read the queue himself', (await call('GET', '/api/drafter/queue', { auth: OWNER })).status === 200);

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
