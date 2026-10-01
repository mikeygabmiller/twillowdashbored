// Yard signs (the Sign Crew app's Worker side). What has to hold:
//   - a crew link is the only way in for a helper, and turning it off stops them;
//   - a helper's device secret is theirs: a second phone can't claim their id;
//   - an upload is idempotent (a retry never doubles a sign), carries its
//     photos in one extra write, and never spends past the daily caps;
//   - the crew map hands helper docs back raw and never leaks phones or links;
//   - Mikey's switches clamp what they store; lead credit is first-wins.
//
//   node test/signs.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found in src/index.js`);
  const start = m.index;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
const constant = (decl) => {
  const m = SRC.match(new RegExp(`^const ${decl}[^\\n]*$`, 'm'));
  if (!m) throw new Error(`const ${decl} not found`);
  return m[0];
};

const STORE = new Map(), META = new Map(), TTL = new Map();
let WRITES = 0;
const KV = {
  async get(k, opt) { const v = STORE.get(k); if (v == null) return null; return opt && opt.type === 'json' ? JSON.parse(v) : v; },
  async put(k, v, opt) { WRITES++; STORE.set(k, v); if (opt && opt.metadata) META.set(k, opt.metadata); if (opt && opt.expirationTtl) TTL.set(k, opt.expirationTtl); },
  async list({ prefix }) { return { keys: [...STORE.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: META.get(name) })) }; },
};
let ROLE = '', ALERTS = [];
let N = 0;
const ctx = {
  kv: () => KV,
  json: (o, status) => ({ __json: o, status: status || 200 }),
  readJson: async (r) => r.__body,
  authRole: async () => ROLE,
  utcDayStr: (ts) => new Date(ts).toISOString().slice(0, 10),
  genId: () => 'b' + (++N).toString(36) + 'xxxxx',
  jdToken: () => 'tok' + (++N) + 'abcdefghijklmnop',
  normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; },
  notifyMikey: async (s, b) => { ALERTS.push(s); return true; },
  publicBase: () => 'https://x.example',
  money2: (n) => Math.round(Number(n) * 100) / 100,
};
const CODE = [
  'SIGN_KEY', 'SIGN_SINCE', 'SIGN_CAP_DEFAULT', 'SIGN_HELPER_CAP', 'SIGN_JOIN_CAP', 'SIGN_MAX_PLACED',
  'SIGN_PHOTO_TTL', 'SIGN_PHOTO_MAX', 'SIGN_STATUS', 'SIGN_SKIP',
].map(constant).concat([
  'loadSigns', 'saveSigns', 'sha256hex', 'signHid', 'signNum', 'signTxt', 'signNextUtcMidnight', 'signCredit',
  'signKeyEq', 'signOwner', 'signModelOk', 'signWho', 'signState', 'apiCrewHello', 'apiCrewJoin', 'apiCrewState', 'signCleanPlaced', 'signCleanEvent',
  'apiCrewSync', 'apiCrewPhoto', 'apiSignsPost', 'apiSignsManifest',
].map(lift)).join('\n\n');
const X = new Function(...Object.keys(ctx), CODE + `
  return { loadSigns, saveSigns, sha256hex, signCredit, apiCrewHello, apiCrewJoin, apiCrewState, apiCrewSync, apiCrewPhoto, apiSignsPost, apiSignsManifest };`)(...Object.values(ctx));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (body) => ({ __body: body });
const out = (r) => r.__json;
const now = Date.now();

section('Mikey makes a link');
ROLE = 'owner';
let r = out(await X.apiSignsPost(req({ action: 'link-new', label: 'Family' })));
ok('link made', r.ok && r.link && r.link.k.length > 10, r);
const K = r.link.k;
ROLE = '';

section('Joining');
ok('a dead link says so', out(await X.apiCrewHello(req({ k: 'nope' }))).valid === false);
ok('a live one says so', out(await X.apiCrewHello(req({ k: K }))).valid === true);
const A = { k: K, h: 'aaaaaaaaaaaa', s: 'secret-of-helper-a-123456' };
r = await X.apiCrewJoin(req({ k: 'nope', h: A.h, s: A.s, name: 'Ann' }));
ok('no link, no join', r.status === 403);
r = await X.apiCrewJoin(req({ k: K, h: A.h, s: A.s, name: '' }));
ok('a name is needed', r.status === 422);
r = out(await X.apiCrewJoin(req({ k: K, h: A.h, s: A.s, name: 'Ann', phone: '425-555-0101' })));
ok('Ann joins', r.ok && r.name === 'Ann', r);
ok('Mikey hears about it', ALERTS.some((a) => /Ann joined/.test(a)), ALERTS);
let doc = await X.loadSigns();
ok('she is on the crew with her phone', doc.crew[A.h] && doc.crew[A.h].phone === '+14255550101', doc.crew);
ok('the secret is stored hashed, never as-is', STORE.get('signs:ha:' + A.h) === await X.sha256hex(A.s) && !STORE.get('signs:ha:' + A.h).includes(A.s));
r = out(await X.apiCrewJoin(req({ k: K, h: A.h, s: A.s, name: 'Ann' })));
ok('the same phone joining twice is fine', r.ok);
r = await X.apiCrewJoin(req({ k: K, h: A.h, s: 'somebody-else-guessing-it', name: 'Mallory' }));
ok("another phone can't take her id", r.status === 403);
r = await X.apiCrewJoin(req({ k: K, h: 'mikey', s: 'x'.repeat(20), name: 'Fake' }));
ok("nobody can join as Mikey", r.status === 422);

section('Uploading signs');
const W0 = WRITES;
const place = (pid, extra) => [pid, 47.91, -122.09, now - 60000, 'abc1N', 'r', 8, '', extra || ''];
r = out(await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000001'), place('pid000002')], e: [], sk: [['abc2S', now, 'hoa']] }))));
ok('two signs acknowledged', r.ok && r.ack.length === 2, r);
ok('one write for an upload with no photos', WRITES - W0 === 1, WRITES - W0);
let h = JSON.parse(STORE.get('signs:h:' + A.h));
ok('both stored', h.p.length === 2 && h.p[0][0] === 'pid000001', h.p);
ok('the skip too', h.sk.length === 1 && h.sk[0][2] === 'hoa', h.sk);
ok('write count kept in metadata', META.get('signs:h:' + A.h).n === 1, META.get('signs:h:' + A.h));
r = out(await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000001')] }))));
h = JSON.parse(STORE.get('signs:h:' + A.h));
ok('a retry never doubles a sign', r.ok && h.p.length === 2, h.p.length);
const photo = Buffer.from('fake jpeg bytes for the test '.repeat(8)).toString('base64');
const W1 = WRITES;
r = out(await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000003')], photos: { pid000003: photo, pid000001: photo } }))));
ok('photos ride along', r.ok && r.photos === 2, r);
ok('two writes for an upload with photos, however many', WRITES - W1 === 2, WRITES - W1);
h = JSON.parse(STORE.get('signs:h:' + A.h));
const batch = h.p.find((x) => x[0] === 'pid000003')[7];
ok('the sign knows which batch holds its photo', batch && h.p.find((x) => x[0] === 'pid000001')[7] === batch, h.p);
ok('photos expire on their own', TTL.get('signs:ph:' + batch) > 86400 * 300);
r = await X.apiCrewSync(req(Object.assign({}, A, { p: [[ 'bad id!', 47, -122 ], ['pid000009', 10, 10, now]] })));
ok('junk and far-away points are dropped', out(r).ok && out(r).ack.length === 0, out(r));
r = out(await X.apiCrewSync(req(Object.assign({}, A, { e: [['pid000001', now, 'gone', 47.91, -122.09, 'mowed']] }))));
h = JSON.parse(STORE.get('signs:h:' + A.h));
ok('a check is stored', h.e.length === 1 && h.e[0][2] === 'gone', h.e);
r = out(await X.apiCrewSync(req(Object.assign({}, A, { plan: { spots: ['abc1N', 'abc3E'], until: now + 3600e3, area: 'Everett' } }))));
h = JSON.parse(STORE.get('signs:h:' + A.h));
ok('a route reservation is stored', h.plan && h.plan.spots.length === 2 && h.plan.area === 'Everett', h.plan);
r = await X.apiCrewSync(req(Object.assign({}, A, { s: 'wrong-secret-wrong-secret' })));
ok('the wrong secret is turned away', r.status === 403);

section('The photo');
let ph = await X.apiCrewPhoto({ }, new URL('https://x/api/crew/photo?b=' + batch + '&p=pid000003&k=' + K));
ok('served with the crew link', ph.status === 200 && ph.headers.get('Content-Type') === 'image/jpeg');
ok('the bytes are the JPEG, not base64', Buffer.from(await ph.arrayBuffer()).toString('base64') === photo);
ph = await X.apiCrewPhoto({}, new URL('https://x/api/crew/photo?b=' + batch + '&p=pid000003&k=wrong'));
ok('not without it', ph.status === 403);

section('The crew map');
const st = await X.apiCrewState(req(A));
const body = JSON.parse(await st.text());
ok('it parses', body.ok === true);
ok('helper docs come back', body.docs.length === 1 && body.docs[0].p.length === 3, body.docs.length);
ok("no phone numbers for the crew", !JSON.stringify(body.crew).includes('5550101'), body.crew);
ok('no links or leads for the crew', body.links === undefined && body.leads === undefined);
ok('only the settings a helper needs', Object.keys(body.cfg).sort().join() === 'pay,photo,recheck', body.cfg);
ok('no secret hashes anywhere', !JSON.stringify(body).includes(STORE.get('signs:ha:' + A.h)));

section('Caps');
h = JSON.parse(STORE.get('signs:h:' + A.h));
h.wn = 40; h.wd = new Date().toISOString().slice(0, 10);
STORE.set('signs:h:' + A.h, JSON.stringify(h));
r = await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000010')] })));
ok('one helper can not spend past their share', r.status === 429 && out(r).error === 'daily_cap' && out(r).resume > now, out(r));
const B = { k: K, h: 'bbbbbbbbbbbb', s: 'secret-of-helper-b-123456' };
await X.apiCrewJoin(req({ k: K, h: B.h, s: B.s, name: 'Ben' }));
META.set('signs:h:' + A.h, { d: new Date().toISOString().slice(0, 10), n: 150 });
r = await X.apiCrewSync(req(Object.assign({}, B, { p: [place('pid000011')] })));
ok('and the whole crew stops at the daily cap', r.status === 429, out(r));
ROLE = 'owner';
r = out(await X.apiCrewSync(req({ asOwner: 1, p: [place('pid000012')] })));
ok("Mikey's own signs never wait", r.ok);
ok('as the helper "mikey"', JSON.parse(STORE.get('signs:h:mikey')).p[0][0] === 'pid000012');
ROLE = '';
r = await X.apiCrewSync(req({ asOwner: 1, p: [place('pid000013')] }));
ok('asOwner without his login is refused', r.status === 403);
META.set('signs:h:' + A.h, { d: '2000-01-01', n: 150 });
r = out(await X.apiCrewSync(req(Object.assign({}, B, { p: [place('pid000011')] }))));
ok("yesterday's count doesn't block today", r.ok, r);

section('Joins are capped too');
doc = await X.loadSigns();
doc.joins = { d: new Date().toISOString().slice(0, 10), n: 15 };
await X.saveSigns(doc);
r = await X.apiCrewJoin(req({ k: K, h: 'cccccccccccc', s: 'secret-of-helper-c-123456', name: 'Cal' }));
ok('a leaked link can only add so many a day', r.status === 429);

section("Mikey's switches");
ROLE = 'owner';
await X.apiSignsPost(req({ action: 'settings', cfg: { pay: 1.5, photo: 'need', recheck: 500, cap: 5, stock: 1000 } }));
doc = await X.loadSigns();
ok('pay and stock saved', doc.cfg.pay === 1.5 && doc.cfg.stock === 1000, doc.cfg);
ok('out-of-range values are ignored, not stored', doc.cfg.recheck === 7 && doc.cfg.cap === 150, doc.cfg);
ok('photo rule saved', doc.cfg.photo === 'need');
await X.apiSignsPost(req({ action: 'crew-off', h: B.h }));
r = await X.apiCrewSync(req(Object.assign({}, B, { p: [place('pid000020')] })));
ok('a helper turned off is stopped', r.status === 403 && out(r).error === 'helper_off');
await X.apiSignsPost(req({ action: 'crew-paid', h: A.h, amount: 12 }));
doc = await X.loadSigns();
ok('paid adds up', doc.crew[A.h].paid === 12);
await X.apiSignsPost(req({ action: 'mark', pid: 'pid000001', st: 'bad' }));
ok('a sign can be not counted', (await X.loadSigns()).marks.pid000001[0] === 'bad');
await X.apiSignsPost(req({ action: 'nogo-add', lat: 47.86, lon: -122.2, r: 400, why: 'hoa', note: 'test' }));
ok('no-go circle saved', (await X.loadSigns()).nogo.length === 1);
r = await X.apiSignsPost(req({ action: 'credit', phone: 'nope' }));
ok('a credit needs a real phone', r.status === 422);
await X.apiSignsPost(req({ action: 'link-off', k: K }));
r = await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000021')] })));
ok('a link turned off stops everyone on it', r.status === 403 && out(r).error === 'link_off');
await X.apiSignsPost(req({ action: 'link-on', k: K }));

section('Registry heals itself');
doc = await X.loadSigns();
delete doc.crew[A.h];
await X.saveSigns(doc);
const hA = JSON.parse(STORE.get('signs:h:' + A.h)); hA.wn = 0; STORE.set('signs:h:' + A.h, JSON.stringify(hA));
r = out(await X.apiCrewSync(req(Object.assign({}, A, { p: [place('pid000030')] }))));
ok('a helper lost from the list by a race is put back by their own upload', r.ok && (await X.loadSigns()).crew[A.h], r);

section('Lead credit');
await X.signCredit('+14255550199', { how: 'qr', name: 'Q', where: 'Everett' });
await X.signCredit('+14255550199', { how: 'said', name: 'Q' });
ok('first credit wins', (await X.loadSigns()).leads['+14255550199'].how === 'qr');

section("Mikey's pin check");
ROLE = 'owner';
r = out(await X.apiSignsPost(req({ action: 'review', good: ['u6b59N', 'abc12NE'], bad: ['u6tyrW', '<script>'] })));
let d0 = await X.loadSigns();
ok('good and bad marks are stored in one write', r.ok && d0.rev.u6b59N === 1 && d0.rev.abc12NE === 1 && d0.rev.u6tyrW === 0, d0.rev);
ok('anything that is not a spot id is ignored', !('<script>' in d0.rev));
await X.apiSignsPost(req({ action: 'review', undo: ['abc12NE'] }));
ok('a mark can be undone', !('abc12NE' in (await X.loadSigns()).rev));
const crewSees = await (await X.apiCrewState(req({ k: K, h: A.h, s: A.s }))).text();
ok('the crew gets the marks, so a bad pin is off their map too', /"rev":\{[^}]*"u6tyrW":0/.test(crewSees), crewSees.slice(0, 200));
const tree = [3, 0.5, [7, 0.2, 0.1, -0.3], -0.2];
await X.apiSignsPost(req({ action: 'review', good: ['u6b59N'], model: { v: 'fx1', trees: [tree, tree], n: 40, acc: 0.81, on: true } }));
let mdl = (await X.loadSigns()).model;
ok('the learned trees ride along in the same write', mdl && mdl.trees.length === 2 && mdl.on === true && mdl.acc === 0.81, mdl);
for (const bad of [{ v: 'fx1', trees: [] }, { v: 'fx1', trees: [[0, 1, 'x', 2]] }, { v: 'fx1', trees: [[0, 1, [0, 1, [0, 1, [0, 1, 1, 1], 1], 1], 1]] },
  { v: 'fx1', trees: Array(101).fill(tree) }, { v: 'fx1', trees: [[0, 1, 1e9, 0]] }, { v: 'fx1', trees: [[-1, 1, 0, 0]] }]) {
  await X.apiSignsPost(req({ action: 'review', good: ['u6b59N'], model: Object.assign({ n: 1, on: true }, bad) }));
}
mdl = (await X.loadSigns()).model;
ok('malformed, deep, huge or empty models are refused and the last good one kept', mdl.trees.length === 2 && JSON.stringify(mdl.trees[0]) === JSON.stringify(tree));
ROLE = '';
r = await X.apiSignsPost(req({ action: 'review', good: ['zzz99N'] }));
ok('a helper cannot mark pins', r.status === 401 && !('zzz99N' in (await X.loadSigns()).rev));

section("Mikey's private link");
const hreq = (body, key) => ({ __body: body, headers: { get: (n) => (n === 'X-Signs-Key' ? key : null) } });
ROLE = '';
r = await X.apiSignsPost(hreq({ action: 'settings', cfg: { pay: 3 } }));
ok('no login and no key: refused', r.status === 401);
ROLE = 'owner';
const KEY1 = out(await X.apiSignsPost(req({ action: 'key-new' }))).ownerKey;
ok('signed in, he can make his private link', typeof KEY1 === 'string' && KEY1.length >= 20, KEY1);
ok('it is kept for next time', (await X.loadSigns()).okey === KEY1);
ROLE = '';
r = await X.apiSignsPost(hreq({ action: 'settings', cfg: { pay: 3 } }, KEY1));
ok('the key alone opens his switches, no password', r.__json && r.__json.ok && (await X.loadSigns()).cfg.pay === 3, r);
r = await X.apiSignsPost(hreq({ action: 'settings', cfg: { pay: 4 } }, KEY1.slice(0, -1) + 'Z'));
ok('a wrong key is refused', r.status === 401 && (await X.loadSigns()).cfg.pay === 3);
r = await X.apiSignsPost(hreq({ action: 'settings', cfg: { pay: 4 } }, ''));
ok('an empty key is refused', r.status === 401);
r = await X.apiCrewState(hreq({ asOwner: 1 }, KEY1));
ok('his own sign placing works with the key', r.status !== 403 && r.status !== 401);
ok('photos open with the key', (await X.apiCrewPhoto({}, new URL('https://x/api/crew/photo?b=' + batch + '&p=pid000003&o=' + KEY1))).status !== 403);
ok('and not with a wrong one', (await X.apiCrewPhoto({}, new URL('https://x/api/crew/photo?b=' + batch + '&p=pid000003&o=nope'))).status === 403);
let mf = JSON.parse(await (await X.apiSignsManifest(new URL('https://x/api/signs/manifest?o=' + KEY1))).text());
ok('the home-screen app starts with the key in it', mf.start_url === '/signs?owner=1&o=' + KEY1, mf.start_url);
mf = JSON.parse(await (await X.apiSignsManifest(new URL('https://x/api/signs/manifest?o=' + 'x'.repeat(40)))).text());
ok('a wrong key gets the plain app, not an echo', mf.start_url === '/signs?owner=1', mf.start_url);
const KEY2 = out(await X.apiSignsPost(hreq({ action: 'key-new' }, KEY1))).ownerKey;
ok('a new link can be made from the key', KEY2 && KEY2 !== KEY1);
r = await X.apiSignsPost(hreq({ action: 'settings', cfg: { pay: 5 } }, KEY1));
ok('and the old one stops working', r.status === 401);
const crewView = await (await X.apiCrewState(req({ k: K, h: A.h, s: A.s }))).text();
ok('the key never goes to the crew', /"ok":true/.test(crewView) && crewView.indexOf(KEY2) < 0 && !/okey|ownerKey/.test(crewView), crewView.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
