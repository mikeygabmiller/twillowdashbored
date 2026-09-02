// End-to-end test for reply-by-text (see handleOwnerCommand in src/index.js).
// Runs the real Worker fetch handler against a simulated Twilio /sms webhook with
// an in-memory KV and a stubbed Twilio/Gemini, so every outbound text is captured
// instead of sent. The thing worth guarding here is that a command can never text
// the WRONG customer, so most assertions check who did and did not get a message.
//
//   npm test
import worker from '../src/index.js';

// ---- in-memory KV ----
const store = new Map();
const KV = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [...store.keys()].map((name) => ({ name })) }; },
};

// ---- capture outbound Twilio sends instead of really sending ----
let sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.twilio.com')) {
    const b = new URLSearchParams(init.body);
    sent.push({ to: b.get('To'), body: b.get('Body') });
    return new Response(JSON.stringify({ sid: 'SM' + Math.random().toString(16).slice(2) }), { status: 201 });
  }
  if (u.includes('generativelanguage')) {
    // Pretend the AI picked Jake for a price question.
    const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ phone: '+14255553821', body: 'The total for the exterior detail will be $200', why: 'asked for total price' }) }] } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }
  if (u.includes('api.resend.com')) return new Response('{}', { status: 200 });
  return new Response('{}', { status: 200 });
};

const ENV = {
  MESSAGES: KV,
  TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550000000',
  MIKEY_PHONE: '+14255551111', GEMINI_API_KEY: 'k',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
};

// ---- seed two conversations ----
const mkThread = (phone, name, lastBody) => ({
  phone, name, messages: [{ id: '1', dir: 'in', body: lastBody, ts: Date.now() - 300000 }],
  unread: 1, status: 'new',
});
store.set('thread:+14255553821', JSON.stringify(mkThread('+14255553821', 'Jake', 'whats the total price for an exterior?')));
store.set('thread:+14255559999', JSON.stringify(mkThread('+14255559999', 'Dana', 'can you do saturday')));
store.set('threads-index', JSON.stringify([
  { phone: '+14255553821', name: 'Jake', lastBody: 'whats the total price for an exterior?', lastDir: 'in', lastTs: Date.now() - 300000, status: 'new' },
  { phone: '+14255559999', name: 'Dana', lastBody: 'can you do saturday', lastDir: 'in', lastTs: Date.now() - 900000, status: 'new' },
]));

async function sms(from, body) {
  sent = [];
  const req = new Request('https://texting.example.workers.dev/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, Body: body, NumMedia: '0', MessageSid: 'SM' + Date.now() }),
  });
  const res = await worker.fetch(req, ENV, { waitUntil() {} });
  const xml = await res.text();
  const m = xml.match(/<Message>([\s\S]*?)<\/Message>/);
  return { reply: m ? m[1] : '', sent: sent.slice() };
}

const OWNER = '+14255551111', GV = '+12065557777', CUSTOMER = '+14255553821';
let fails = 0;
const check = (label, cond, extra) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  << ' + JSON.stringify(extra))); if (!cond) fails++; };

console.log('\n--- exact path (last 4 digits) ---');
let r = await sms(OWNER, '3821 running about 20 min late');
check('relays to Jake only', r.sent.length === 1 && r.sent[0].to === CUSTOMER, r.sent);
check('sends the message verbatim', r.sent[0] && r.sent[0].body === 'running about 20 min late', r.sent);
check('confirms back to owner', /Sent to Jake/.test(r.reply), r.reply);

console.log('\n--- unknown / ambiguous ---');
r = await sms(OWNER, '0000 hello there');
check('unknown last-4 sends nothing', r.sent.length === 0, r.sent);
check('and says so', /No conversation ends in 0000/.test(r.reply), r.reply);

console.log('\n--- plain English needs confirmation ---');
r = await sms(OWNER, 'tell the person that asked for the total price "the total for the exterior detail will be $200"');
check('does NOT send yet', r.sent.length === 0, r.sent);
check('asks to confirm, naming Jake', /Send to Jake/.test(r.reply) && /Y to send/.test(r.reply), r.reply);
check('quotes the message back', /\$200/.test(r.reply), r.reply);

r = await sms(OWNER, 'Y');
check('Y actually sends it', r.sent.length === 1 && r.sent[0].to === CUSTOMER, r.sent);
check('with the right wording', /\$200/.test(r.sent[0].body), r.sent);

console.log('\n--- N cancels ---');
await sms(OWNER, 'tell the price guy its 200');
r = await sms(OWNER, 'N');
check('nothing sent', r.sent.length === 0, r.sent);
check('says cancelled', /Cancelled/.test(r.reply), r.reply);

console.log('\n--- a stranger is still a customer, not a commander ---');
r = await sms('+14255558888', '3821 you should not be able to do this');
check('no relay from a stranger', !r.sent.some((x) => x.to === CUSTOMER), r.sent);
const idx = JSON.parse(store.get('threads-index'));
check('stranger became a normal thread', idx.some((t) => t.phone === '+14255558888'), idx.map((t) => t.phone));

console.log('\n--- Google Voice number, before and after adding it ---');
r = await sms(GV, '3821 hey its mikey');
check('unknown number does NOT command', !r.sent.some((x) => x.to === CUSTOMER), r.sent);
const cfg = JSON.parse(store.get('config') || '{}');
cfg.ownerNumbers = [GV];
store.set('config', JSON.stringify(cfg));
r = await sms(GV, '3821 hey its mikey from google voice');
check('after adding, it commands', r.sent.length === 1 && r.sent[0].to === CUSTOMER, r.sent);

console.log('\n--- opted-out customer is protected ---');
const cfg2 = JSON.parse(store.get('config'));
cfg2.optedOut = [CUSTOMER];
store.set('config', JSON.stringify(cfg2));
r = await sms(OWNER, '3821 you asked me to stop but here I am');
check('refuses to text an opted-out number', r.sent.length === 0, r.sent);
check('and explains why', /STOP/.test(r.reply), r.reply);

console.log('\n' + (fails ? fails + ' FAILING' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
