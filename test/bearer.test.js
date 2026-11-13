// "Authorization: Bearer <owner PIN>" — how Claude's cloud sessions sign in.
// The value sits in Mikey's Claude cloud settings and the network proxy adds it,
// so it is never in the repo. What matters here is that this door is no wider
// than the login screen: owner only, and the same wrong-guess lockout.
//
//   node test/bearer.test.js
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

const store = new Map();
const KV = {
  async get(k, o) { const v = store.has(k) ? store.get(k) : null; if (v == null) return null; return o && (o.type === 'json' || o === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { store.delete(k); },
  async list(o) { const p = (o && o.prefix) || ''; return { keys: [...store.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true }; },
};
globalThis.fetch = async () => new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
const ENV = {
  DASHBOARD_PASSWORD: '7777', TWILIO_AUTH_TOKEN: 'x', TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_FROM: '+14255550000', MIKEY_PHONE: '+14255550001', MESSAGES: KV,
};
const worker = (await import('../src/index.js')).default;

async function call(method, path, { auth, ip = '10.1.0.1', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (auth != null) headers.Authorization = auth;
  const res = await worker.fetch(new Request('https://dash.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), ENV, { waitUntil() {} });
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

console.log('\nThe owner PIN in a Bearer header signs in as owner');
ok((await call('GET', '/api/threads', { auth: 'Bearer 7777' })).status === 200, 'right PIN reaches the inbox');
ok((await call('GET', '/api/config', { auth: 'bearer 7777' })).status === 200, 'scheme is case-insensitive and reaches owner-only settings');
ok((await call('GET', '/api/whoami', { auth: 'Bearer 7777' })).data.role === 'owner', 'whoami says owner');
ok(!store.has('loginfail:10.1.0.1'), 'a right PIN writes nothing to KV');

console.log('\nAnything else is refused');
ok((await call('GET', '/api/threads', { auth: 'Bearer 1234', ip: '10.1.0.2' })).status === 401, 'wrong PIN is refused');
ok((await call('GET', '/api/threads', { auth: 'Bearer ', ip: '10.1.0.3' })).status === 401, 'empty Bearer is refused');
ok((await call('GET', '/api/threads', { auth: 'Basic 7777', ip: '10.1.0.4' })).status === 401, 'a non-Bearer scheme is not a password');
ok((await call('GET', '/api/version', { auth: 'Bearer nope', ip: '10.1.0.5' })).status === 200, 'public routes still answer with a bad header');

console.log('\nThe helper PIN never works here');
{
  await call('POST', '/api/config', { auth: 'Bearer 7777', body: { helperPassword: '5150', helperName: 'Jess' } });
  ok((await call('GET', '/api/threads', { auth: 'Bearer 5150', ip: '10.1.0.6' })).status === 401, 'helper PIN in a Bearer header is refused');
}

console.log('\nSame lockout as the login screen');
{
  const ip = '10.1.0.9';
  for (let i = 0; i < 6; i++) await call('GET', '/api/threads', { auth: 'Bearer 000' + i, ip });
  ok(store.get('loginfail:' + ip) && JSON.parse(store.get('loginfail:' + ip)).n === 6, 'each wrong guess is counted');
  ok((await call('GET', '/api/threads', { auth: 'Bearer 7777', ip })).status === 401, 'locked out: even the right PIN is refused');
  ok((await call('POST', '/api/login', { body: { password: '7777' }, ip })).status === 429, 'and the login screen sees the same lockout');
  ok((await call('GET', '/api/threads', { auth: 'Bearer 7777', ip: '10.1.0.10' })).status === 200, 'another address is unaffected');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
