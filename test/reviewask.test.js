// The Google review ask: once per customer, after the job (2026-11-03).
//
// Reviews were coming in at about two a month. Reading the code turned up
// why some customers were never asked: a thread marked Won before the job (a
// quote accepted, or Won tapped when they booked) had its review ask come due
// the next day, before the car was touched. Skipping it then retired it for
// good, because completing the booking later saw "already won" and moved on to
// the rebook. And a customer who got the Jobs board's "all finished" text,
// which carries the review link, was asked again by the follow-up a day later.
//
// What has to hold:
//   - completing a booking for a customer who was won early and never sent the
//     link brings the review ask back, due a day after the job
//   - one who has been sent the link (by any text) is never asked again; the
//     next step is the rebook
//   - a plain first-time win still asks, a day after it, exactly as before
//
//   node test/reviewask.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['computeFollowupPlan', 'reviewAlreadyAsked', 'apiBookingAction', 'saveBookings', 'loadThread',
  'saveThread', 'loadConfig', 'defaultFollowup'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.twilio.com')) {
    const p = new URLSearchParams(String(opts.body));
    sms.push({ to: p.get('To'), body: p.get('Body') });
    return { ok: true, json: async () => ({ sid: 'SM1' }) };
  }
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
};

const DAY = 86400000;
let NOW = Date.parse('2026-11-03T20:00:00Z');
Date.now = () => NOW;

const env = {
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13600000000', DETECT_DISABLED: '1', PROMISE_DISABLED: '1',
};
const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')(env);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b, method: 'POST', headers: { get: () => '' } });

const REVIEW = 'https://g.page/r/TESTREVIEW/review';
store.set('config', JSON.stringify({ reviewUrl: REVIEW }));
M.__reset();

const PHONE = '+14255550100';
const cfg = await M.loadConfig();

section('a plain win asks a day later, as before');
{
  const t = { phone: PHONE, status: 'won', statusAt: NOW, followup: M.defaultFollowup(),
    messages: [{ dir: 'out', body: 'See you Thursday at 1', ts: NOW - DAY }] };
  const p = M.computeFollowupPlan(t, NOW, cfg);
  ok('review step', p && p.stepKey === 'won:review', p);
  ok('due a day after the win', p && p.dueAt === NOW + DAY, p && p.dueAt);
}

section('the link already went out ("all finished" text): no second ask');
{
  const t = { phone: PHONE, status: 'won', statusAt: NOW, followup: M.defaultFollowup(),
    messages: [{ dir: 'out', body: `Hey Sam, all done and it came out great. Thanks for having me out. If you get a second, a review on Google goes a long way for me: ${REVIEW}`, ts: NOW }] };
  ok('reviewAlreadyAsked sees it', M.reviewAlreadyAsked(t, cfg) === true);
  const p = M.computeFollowupPlan(t, NOW, cfg);
  ok('next step is the rebook, not a second review ask', p && p.stepKey === 'won:rebook', p);
  const inbound = { phone: PHONE, messages: [{ dir: 'in', body: REVIEW, ts: NOW }] };
  ok('a link the customer sent doesn\'t count as asking', M.reviewAlreadyAsked(inbound, cfg) === false);
  ok('no review link configured: never "asked"', M.reviewAlreadyAsked(t, { reviewUrl: '' }) === false);
}

section('won early, ask skipped before the job, then the job is completed');
{
  const t = await M.loadThread(PHONE);
  t.phone = PHONE; t.name = 'Sam';
  t.status = 'won'; t.statusAt = NOW - 6 * DAY;         // quote accepted six days ago
  t.messages = [{ dir: 'out', body: 'Got you down for Tuesday at 1', ts: NOW - 6 * DAY }];
  t.followup = M.defaultFollowup();
  t.followup.lastStepKey = 'won:review';                // he skipped it: the car wasn't done yet
  await M.saveThread(t);
  const before = M.computeFollowupPlan(t, NOW, cfg);
  ok('before the fix path: skipped ask is gone, only the rebook is left', before && before.stepKey === 'won:rebook', before);

  await M.saveBookings([{ id: 'bk1', phone: PHONE, name: 'Sam', status: 'confirmed', date: '2026-11-03', slot: '13:00',
    serviceName: 'Full Detail', smsConsent: true }]);
  const r = await (await M.apiBookingAction(req({ id: 'bk1', action: 'complete' }))).json();
  ok('complete answered ok', r && r.ok, r);
  const after = await M.loadThread(PHONE);
  ok('still won', after.status === 'won');
  ok('anchored on the job day', after.statusAt === NOW, after.statusAt);
  const p = M.computeFollowupPlan(after, NOW, cfg);
  ok('the review ask is back', p && p.stepKey === 'won:review', p);
  ok('due a day after the job', p && p.dueAt === NOW + DAY, p && p.dueAt);
  ok('nothing texted by completing', sms.length === 0, sms);
}

section('won early but already sent the link: completing changes nothing');
{
  const P2 = '+14255550101';
  const t = await M.loadThread(P2);
  t.phone = P2; t.status = 'won'; t.statusAt = NOW - 40 * DAY;
  t.messages = [{ dir: 'out', body: `Thanks again! ${REVIEW}`, ts: NOW - 39 * DAY }];
  t.followup = M.defaultFollowup(); t.followup.lastStepKey = 'won:review';
  await M.saveThread(t);
  await M.saveBookings([{ id: 'bk2', phone: P2, name: 'Pat', status: 'confirmed', date: '2026-11-03', slot: '13:00',
    serviceName: 'Full Detail', smsConsent: true }]);
  await M.apiBookingAction(req({ id: 'bk2', action: 'complete' }));
  const after = await M.loadThread(P2);
  ok('won date left where it was', after.statusAt === NOW - 40 * DAY, after.statusAt);
  const p = M.computeFollowupPlan(after, NOW, cfg);
  ok('a regular is not asked again', !p || p.stepKey !== 'won:review', p);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
