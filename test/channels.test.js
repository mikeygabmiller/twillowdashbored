// Insights → Channels: where each lead came from, what each channel cost, and
// what one paying customer cost. Runs the real worker (the whole file, like
// name.test.js) against an in-memory KV.
//
// What has to hold:
//   · a quote that started on a hanger QR, a Google ad or a Google search is
//     stamped with that channel at the moment it arrives, and never re-stamped
//   · a paid click beats a free-looking utm; the site's own pages are not a referrer
//   · older leads with no stamp fall back to hanger/sign credits, the journey
//     board, the tags, a referral, then "Not sure yet"
//   · spend comes only from marketing expenses with a kind; nothing is guessed
//   · gift card sales are not revenue here, a text from mom is not a lead
//   · setting a lead's source by hand doesn't mark it read, and sticks
//   · nothing in here texts anyone
//
//   node test/channels.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const EXPORTS = ['originChannel', 'journeyFirstTouch', 'markOrigin', 'apiChannels', 'apiChannelsPost', 'handleSubmit',
  'loadThread', 'saveThread', 'updateIndexEntry', 'loadIndex', 'journeyMeta', 'saveMonth', 'loadMonth', 'MARKETING_SUBS', 'CHANNELS'];

const store = new Map(), meta = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v, o) { store.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); },
  async delete(k) { store.delete(k); meta.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name, metadata: meta.get(name) })), list_complete: true };
  },
};
const sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.twilio.com')) { sms.push(String(opts.body)); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  if (url.includes('api.resend.com')) return { ok: true, json: async () => ({}) };
  return { ok: false, status: 404, text: async () => 'no' };
};
const M = new Function('__env__', src + '\n; ENV = __env__; return {' + EXPORTS.join(',') + '};')({
  MESSAGES: kv, RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const jsonReq = (body) => ({
  url: 'https://texting.example.workers.dev/submit',
  headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});
const body = async (r) => (r && typeof r.json === 'function' ? r.json() : r);
const journey = async (vid, doc) => {
  const d = Object.assign({ firstAt: Date.now() - 3600e3, lastAt: Date.now() - 600e3, steps: [] }, doc);
  await kv.put('journey:' + vid, JSON.stringify(d), { metadata: M.journeyMeta(d) });
};
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const month = today.slice(0, 7);

section('Which channel a first touch belongs to');
const oc = M.originChannel;
ok('a hanger QR', oc({ utm: 'doorhanger' }) === 'hanger');
ok('a yard sign QR', oc({ utm: 'yardsign' }) === 'sign');
ok('the solo and the shared postcard', oc({ utm: 'postcard' }) === 'postcard' && oc({ utm: 'sharedcard' }) === 'postcard');
ok('a business card', oc({ utm: 'card' }) === 'card');
ok('a gift card', oc({ utm: 'giftcard' }) === 'giftcard');
ok('a Google ad click', oc({ ad: 'google', ref: 'google.com' }) === 'google_ads');
ok('a Facebook ad beats utm_source=facebook', oc({ ad: 'facebook', utm: 'facebook' }) === 'meta_ads');
ok('the Instagram bio link is free social', oc({ utm: 'instagram' }) === 'social');
ok('a Google search with no ad is search', oc({ ref: 'https://www.google.com/' }) === 'search');
ok('Bing too', oc({ ref: 'bing.com' }) === 'search');
ok('Nextdoor is social', oc({ ref: 'nextdoor.com' }) === 'social');
ok('the site\'s own page is not a referrer', oc({ ref: 'mikeysdetailing.com' }) === 'direct');
ok('no referrer at all', oc({}) === 'direct');
ok('some other website', oc({ ref: 'reddit-ish.example.org' }) === 'web');
ok('nothing to go on', oc(null) === 'unknown');

section('A quote from a hanger QR is stamped when it arrives');
await journey('vHANG', { utm: 'doorhanger', steps: [{ t: Date.now() - 3600e3, p: '/', r: '' }] });
await M.handleSubmit(jsonReq({ phone: '4255550101', name: 'Hana Gerber', total: '369', smsConsent: false, vid: 'vHANG' }));
let t = await M.loadThread('+14255550101');
ok('origin is the door hanger', t.origin && t.origin.ch === 'hanger', t.origin);
ok('it keeps the tag it came with', t.origin.utm === 'doorhanger');
let idx = await M.loadIndex();
ok('the index row carries it', idx.find((r) => r.phone === '+14255550101').origin === 'hanger');

section('A Google ad click and a Google search');
await journey('vAD', { ad: 'google', clid: 'abc', clidk: 'gclid', steps: [{ t: Date.now() - 3600e3, p: '/', r: 'https://www.google.com/' }] });
await M.handleSubmit(jsonReq({ phone: '4255550102', name: 'Ada Price', total: '409', smsConsent: false, vid: 'vAD' }));
await journey('vSEO', { steps: [{ t: Date.now() - 3600e3, p: '/monroe/', r: 'https://www.google.com/' }, { t: Date.now() - 3500e3, k: 'c', l: 'quote' }] });
await M.handleSubmit(jsonReq({ phone: '4255550103', name: 'Sam Oak', total: '249', smsConsent: false, vid: 'vSEO' }));
ok('the ad click is Google Ads', (await M.loadThread('+14255550102')).origin.ch === 'google_ads');
ok('the search is Google search & Maps', (await M.loadThread('+14255550103')).origin.ch === 'search');

section('First touch is never overwritten');
await journey('vLATER', { utm: 'yardsign', steps: [{ t: Date.now(), p: '/', r: '' }] });
await M.handleSubmit(jsonReq({ phone: '4255550101', name: 'Hana Gerber', total: '409', smsConsent: false, vid: 'vLATER' }));
ok('a second quote from a sign leaves the hanger stamp alone', (await M.loadThread('+14255550101')).origin.ch === 'hanger');
await M.handleSubmit(jsonReq({ phone: '4255550104', name: 'No Visit', total: '199', smsConsent: false }));
ok('a quote with no website visit gets no stamp at all', !(await M.loadThread('+14255550104')).origin);

section('Older leads fall back, best evidence first');
// A lead from before stamping, whose journey board metadata says yard sign.
await journey('vOLD', { phone: '+14255550105', utm: 'yardsign', steps: [{ t: Date.now() - 86400e3, p: '/', r: '' }] });
const old = await M.loadThread('+14255550105'); old.status = 'active'; old.name = 'Old Sign'; old.createdAt = Date.now() - 5 * 86400e3;
old.messages.push({ id: 'm1', dir: 'in', body: 'hi', ts: old.createdAt }); await M.saveThread(old); await M.updateIndexEntry(old);
// A text-in lead somebody referred.
const ref = await M.loadThread('+14255550106'); ref.status = 'new'; ref.name = 'Ref Rita'; ref.createdAt = Date.now() - 2 * 86400e3;
ref.referredBy = { phone: '+14255550101', name: 'Hana', at: Date.now(), how: 'link' };
ref.messages.push({ id: 'm1', dir: 'in', body: 'Hana sent me', ts: ref.createdAt }); await M.saveThread(ref); await M.updateIndexEntry(ref);
// A call-in lead with nothing to go on.
const unk = await M.loadThread('+14255550107'); unk.status = 'new'; unk.name = 'Una Known'; unk.createdAt = Date.now() - 86400e3;
unk.messages.push({ id: 'm1', dir: 'in', body: 'how much for a full detail', ts: unk.createdAt }); await M.saveThread(unk); await M.updateIndexEntry(unk);
// Mom. No status, no form: not a lead.
const mom = await M.loadThread('+14255550199'); mom.name = 'Mom'; mom.createdAt = Date.now() - 86400e3;
mom.messages.push({ id: 'm1', dir: 'in', body: 'dinner sunday?', ts: mom.createdAt }); await M.saveThread(mom); await M.updateIndexEntry(mom);

section('Money: revenue, spend, and what is left out');
await M.saveMonth(month, { entries: [
  { id: 'e1', date: today, ts: Date.now(), type: 'job', amount: 369, phone: '+14255550101' },
  { id: 'e2', date: today, ts: Date.now(), type: 'job', amount: 409, phone: '+14255550102' },
  { id: 'e3', date: today, ts: Date.now(), type: 'job', amount: 100, phone: '+14255550102', service: 'Gift card', gift: 1 },
  { id: 'e4', date: today, ts: Date.now(), type: 'exp', cat: 'marketing', sub: 'Google Ads', amount: 220 },
  { id: 'e5', date: today, ts: Date.now(), type: 'exp', cat: 'marketing', sub: 'Door hangers', amount: 240 },
  { id: 'e6', date: today, ts: Date.now(), type: 'exp', cat: 'marketing', amount: 85, note: 'Vistaprint' },
  { id: 'e7', date: today, ts: Date.now(), type: 'exp', cat: 'supplies', amount: 60 },
] });

let r = await body(await M.apiChannels(new URL('https://x/api/channels?days=90')));
const ch = (id) => (r.channels || []).find((c) => c.id === id) || {};
ok('it answers', r.ok, r);
ok('seven leads, mom left out', r.totals.leads === 7, r.totals);
ok('hanger: 1 lead, 1 paid, $369', ch('hanger').leads === 1 && ch('hanger').customers === 1 && ch('hanger').revenue === 369, ch('hanger'));
ok('hanger spend $240 → $240 per paying customer', ch('hanger').spend === 240 && ch('hanger').perCustomer === 240, ch('hanger'));
ok('Google Ads: $409 back on $220, gift card sale left out', ch('google_ads').revenue === 409 && ch('google_ads').spend === 220, ch('google_ads'));
ok('...which is $186 back per $100', Math.round(ch('google_ads').back * 100) === 186, ch('google_ads'));
ok('search: a lead, nobody paid yet, and it\'s free', ch('search').leads === 1 && ch('search').customers === 0 && !ch('search').paid, ch('search'));
ok('the old lead found through the journey board is a yard sign', ch('sign').leads === 1, ch('sign'));
ok('the referred one is word of mouth', ch('referral').leads === 1, ch('referral'));
ok('the call-in lead and the no-visit quote are Not sure yet', ch('unknown').leads === 2 && r.unknownCount === 2, ch('unknown'));
ok('Not sure yet sorts last', r.channels[r.channels.length - 1].id === 'unknown');
ok('marketing spend total includes the unsplit $85, not supplies', r.totals.spend === 545, r.totals);
ok('the unsplit expense is listed to fix', r.unsplit.length === 1 && r.unsplit[0].id === 'e6' && r.unsplitTotal === 85, r.unsplit);
ok('blended cost per paying customer', r.totals.perCustomer === Math.round(545 / 2 * 100) / 100, r.totals);
ok('the kinds offered match the Money chips', JSON.stringify(r.subs) === JSON.stringify(['Google Ads', 'Facebook ads', 'Door hangers', 'Yard signs', 'Postcards', 'Business cards', 'Other']), r.subs);
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
ok('...and the Money screen offers the same kinds', ui.includes('marketing:["Google Ads","Facebook ads","Door hangers","Yard signs","Postcards","Business cards","Other"]'));

section('Fixing it by hand');
const unread0 = (await M.loadThread('+14255550107')).unread || 0;
const req = (b) => ({ json: async () => b });
let p = await body(await M.apiChannelsPost(req({ action: 'origin', phone: '425-555-0107', ch: 'sign' })));
ok('"they said a yard sign" is saved', p.ok, p);
t = await M.loadThread('+14255550107');
ok('it sticks on the thread, marked as his answer', t.origin.ch === 'sign' && t.origin.by === 'hand', t.origin);
ok('it did not mark the conversation read', (t.unread || 0) === unread0);
p = await body(await M.apiChannelsPost(req({ action: 'origin', phone: '4255550107', ch: 'nonsense' })));
ok('a channel that doesn\'t exist is refused', p.ok === false);
p = await body(await M.apiChannelsPost(req({ action: 'spend', id: 'e6', date: today, sub: 'Postcards' })));
ok('the $85 is moved to Postcards', p.ok && (await M.loadMonth(month)).entries.find((e) => e.id === 'e6').sub === 'Postcards', p);
p = await body(await M.apiChannelsPost(req({ action: 'spend', id: 'e7', date: today, sub: 'Postcards' })));
ok('a supplies expense can\'t be turned into marketing', p.ok === false);
r = await body(await M.apiChannels(new URL('https://x/api/channels?days=90')));
ok('the report moves with it: sign now has 2, Not sure yet 1', (r.channels.find((c) => c.id === 'sign') || {}).leads === 2 && r.unknownCount === 1, r.channels);
ok('postcards now carry the $85', (r.channels.find((c) => c.id === 'postcard') || {}).spend === 85 && r.unsplit.length === 0);

section('Nothing was texted');
ok('no SMS went out (consent was off on every quote)', sms.length === 0, sms.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
