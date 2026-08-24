// Money on the table — the customers going quiet — and the maintenance plans
// that keep them from going quiet in the first place.
//
// The old "Rebook radar" was a client-side filter for "last job 45+ days ago"
// run against the CURRENT month's ledger only, so the condition was very nearly
// unsatisfiable and the widget showed nothing for months. The tests here are
// written against the thing that actually matters: given a history, WHO shows up
// and WHY — and, just as important, who must not (booked, opted out, held, on a
// plan that isn't due yet).
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['buildCold', 'apiCold', 'apiColdAction', 'loadColdSkip', 'coldDraft',
  'sanitizePlan', 'planDue', 'buildPlans', 'apiPlan', 'planDraft',
  'loadThread', 'saveThread', 'updateIndexEntry', 'loadIndex', 'loadConfig',
  'loadMonth', 'saveMonth', 'localDateStr', 'moneySpendMap'];

const store = new Map();
let writes = 0;
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); writes++; },
  async delete(k) { store.delete(k); writes++; },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (b) => ({ json: async () => b, method: 'POST' });

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => NOW - d * DAY;
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---------------------------------------------------------------- fixtures
async function customer(phone, opts = {}) {
  const t = await M.loadThread(phone);
  t.name = opts.name || 'Customer';
  t.status = opts.status || 'active';
  t.messages = [{ id: 'm' + phone, dir: opts.lastDir || 'in', body: 'ok', ts: opts.lastTs || ago(30) }];
  if (opts.quote) t.quote = opts.quote;
  if (opts.plan) t.plan = M.sanitizePlan(opts.plan);
  if (opts.appointmentAt) t.appointmentAt = opts.appointmentAt;
  if (opts.garage) t.garage = opts.garage;
  if (opts.archived) t.archived = true;
  await M.saveThread(t);
  await M.updateIndexEntry(t);
  return t;
}
async function job(phone, ts, amount, name) {
  const m = dateOf(ts).slice(0, 7);
  const doc = await M.loadMonth(m);
  doc.entries.push({ id: 'e' + Math.random().toString(36).slice(2), type: 'job', phone,
    name: name || '', amount, date: dateOf(ts), ts });
  await M.saveMonth(m, doc);
}
const find = (cold, phone) => {
  for (const k of Object.keys(cold.groups)) {
    const r = cold.groups[k].find((x) => x.phone === phone);
    if (r) return r;
  }
  return null;
};

async function reset() { store.clear(); writes = 0; M.__resetCfg(); }

// ================================================================ the list
section('Who shows up on the list, and under which heading');
await reset();
await customer('+14255550001', { name: 'Quote Quinn', quote: { id: 'q1', total: 340, service: 'Full Detail', at: ago(9) } });
await customer('+14255550002', { name: 'Rebook Ruth', lastTs: ago(120) });
await job('+14255550002', ago(120), 260, 'Rebook Ruth');
await customer('+14255550003', { name: 'Never Nate', lastTs: ago(40) });
await customer('+14255550004', { name: 'Fresh Fred', lastTs: ago(2) });
await job('+14255550004', ago(2), 200, 'Fresh Fred');

let cold = await M.buildCold(await M.loadConfig());
ok('a quote nobody answered is listed', find(cold, '+14255550001').kind === 'quote');
ok('…at the quoted amount', find(cold, '+14255550001').value === 340);
ok('a customer overdue for another detail is listed', find(cold, '+14255550002').kind === 'rebook');
ok('…valued at what they actually pay', find(cold, '+14255550002').value === 260);
ok('…and told in months, not days', find(cold, '+14255550002').months === 4, find(cold, '+14255550002').months);
ok('someone who asked and never booked is listed', find(cold, '+14255550003').kind === 'never');
ok('a customer detailed two days ago is NOT chased', !find(cold, '+14255550004'));
ok('the total is real money, not a count', cold.value === 340 + 260 + cold.avgTicket, cold.value);
ok('every row carries a written text', Object.keys(cold.groups)
  .every((k) => cold.groups[k].every((r) => r.draft && r.draft.length > 20)));
ok('the draft opens with their first name',
  find(cold, '+14255550002').draft.startsWith('Hey Rebook,'), find(cold, '+14255550002').draft);
ok('the rebook draft never invents a price or a date',
  !/\$|\bmonday\b|\btuesday\b/i.test(find(cold, '+14255550002').draft));

section('A fresh quote is left alone for a few days');
await reset();
await customer('+14255550010', { name: 'New Nina', lastTs: ago(30), quote: { id: 'q', total: 300, at: ago(1) } });
cold = await M.buildCold(await M.loadConfig());
ok('a quote sent yesterday is not "gone quiet"', !find(cold, '+14255550010'));
ok('…and an open quote is never miscounted as a lead who never got a price',
  cold.counts.never === 0, cold.counts);

section('Who is deliberately kept off it');
await reset();
await customer('+14255550020', { name: 'Booked Bea', quote: { id: 'q', total: 300, at: ago(20) }, appointmentAt: NOW + 3 * DAY });
await customer('+14255550021', { name: 'Won Wanda', status: 'won', quote: { id: 'q', total: 300, at: ago(20) } });
await customer('+14255550022', { name: 'Lost Lou', status: 'lost', quote: { id: 'q', total: 300, at: ago(20) } });
await customer('+14255550023', { name: 'Archie', quote: { id: 'q', total: 300, at: ago(20) }, archived: true });
await customer('+14255550024', { name: 'Ancient Ann', lastTs: ago(700) });
await job('+14255550024', ago(700), 200, 'Ancient Ann');
cold = await M.buildCold(await M.loadConfig());
ok('someone with a job already booked is left alone', !find(cold, '+14255550020'));
ok('a won lead is not chased about its quote', !find(cold, '+14255550021'));
ok('a lost lead is not chased', !find(cold, '+14255550022'));
ok('an archived conversation is not chased', !find(cold, '+14255550023'));
ok('a customer from two years ago is let go', !find(cold, '+14255550024'));

section('Opted out means opted out');
await reset();
const cfg = await M.loadConfig();
cfg.optedOut = ['+14255550030'];
await kv.put('config', JSON.stringify(cfg));
M.__resetCfg();
await customer('+14255550030', { name: 'Stop Sam', quote: { id: 'q', total: 300, at: ago(20) } });
cold = await M.buildCold(await M.loadConfig());
ok('someone who texted STOP never appears', !find(cold, '+14255550030'));

section('Later, and not-ever');
await reset();
await customer('+14255550040', { name: 'Later Lisa', quote: { id: 'q', total: 300, at: ago(20) } });
ok('on the list to begin with', !!find(await M.buildCold(await M.loadConfig()), '+14255550040'));
let res = await (await M.apiColdAction(req({ phone: '+14255550040', action: 'later' }))).json();
ok('"later" takes them off', !find(res, '+14255550040'));
ok('…and hands back the fresh list', res.ok && res.counts.total === 0, res.counts);
res = await (await M.apiColdAction(req({ phone: '+14255550040', action: 'clear' }))).json();
ok('clearing puts them back', !!find(res, '+14255550040'));
res = await (await M.apiColdAction(req({ phone: '+14255550040', action: 'never' }))).json();
ok('"not interested" takes them off', !find(res, '+14255550040'));
ok('…and marks the lead lost, so it stops being a lead',
  (await M.loadThread('+14255550040')).status === 'lost');
ok('a bad action is refused', (await M.apiColdAction(req({ phone: '+14255550040', action: 'nope' }))).status === 422);

section('Reading the list writes nothing');
await reset();
await customer('+14255550050', { name: 'Quiet Quinn', quote: { id: 'q', total: 300, at: ago(20) } });
writes = 0;
await M.buildCold(await M.loadConfig());
await M.buildCold(await M.loadConfig());
ok('two reads, zero writes', writes === 0, writes);

// =============================================================== the plans
section('A plan is a rhythm, not a subscription');
ok('an unknown interval falls back to six weeks', M.sanitizePlan({ every: 999 }).every === 42);
ok('a known one is kept', M.sanitizePlan({ every: 84 }).every === 84);
ok('junk is not a plan', M.sanitizePlan(null) === null && M.sanitizePlan('x') === null);
ok('a price is money, not a string', M.sanitizePlan({ every: 42, price: '220.4' }).price === 220.4);

section('When a plan comes due');
const p = M.sanitizePlan({ every: 42, startedAt: ago(100) });
ok('not due the day after a job', !M.planDue(p, ago(1), NOW).due);
ok('due once the interval has passed', M.planDue(p, ago(50), NOW).due);
ok('the clock runs from the last job, not from when the plan started',
  M.planDue(p, ago(10), NOW).dueAt > NOW);
ok('a paused plan is never due', !M.planDue(M.sanitizePlan({ every: 42, paused: true }), ago(90), NOW));
ok('asking once silences it for that cycle',
  !M.planDue(M.sanitizePlan({ every: 42, startedAt: ago(100), askedAt: ago(1) }), ago(50), NOW).due);
ok('…but the next cycle asks again',
  M.planDue(M.sanitizePlan({ every: 42, startedAt: ago(200), askedAt: ago(90) }), ago(50), NOW).due);

section('A due plan is the top of the list');
await reset();
await customer('+14255550060', { name: 'Plan Pam', lastTs: ago(60),
  plan: { every: 42, startedAt: ago(200) }, garage: { vehicles: [{ year: '2020', make: 'Subaru', model: 'Outback' }] } });
await job('+14255550060', ago(60), 240, 'Plan Pam');
cold = await M.buildCold(await M.loadConfig());
let row = find(cold, '+14255550060');
ok('they show up as a plan, not as a plain rebook', row && row.kind === 'plan', row && row.kind);
ok('plans are ranked above everything else', Object.keys(cold.groups)[0] === 'plan');
ok('the draft says it is their plan', /every-6-week plan/.test(row.draft), row.draft);
ok('…and names the vehicle', /Subaru/.test(row.draft), row.draft);
ok('valued at what they usually pay', row.value === 240, row.value);

section('A plan that is not due yet stays quiet');
await reset();
await customer('+14255550061', { name: 'Early Earl', lastTs: ago(10), plan: { every: 42, startedAt: ago(200) } });
await job('+14255550061', ago(10), 240, 'Early Earl');
cold = await M.buildCold(await M.loadConfig());
ok('nothing on the list', !find(cold, '+14255550061'));
ok('…and they are not double-counted as a cold rebook either', cold.counts.total === 0, cold.counts);

section('The plan board');
await reset();
await customer('+14255550070', { name: 'Due Dana', lastTs: ago(90), plan: { every: 42, startedAt: ago(300) } });
await job('+14255550070', ago(90), 200, 'Due Dana');
await customer('+14255550071', { name: 'Soon Sue', lastTs: ago(5), plan: { every: 42, startedAt: ago(300) } });
await job('+14255550071', ago(5), 200, 'Soon Sue');
await customer('+14255550072', { name: 'Booked Bob', lastTs: ago(90),
  plan: { every: 42, startedAt: ago(300) }, appointmentAt: NOW + 2 * DAY });
await job('+14255550072', ago(90), 200, 'Booked Bob');
const board = await M.buildPlans();
ok('everyone on a plan is listed', board.plans.length === 3, board.plans.length);
ok('the due one is first', board.plans[0].phone === '+14255550070');
ok('one is counted as due', board.dueCount === 1, board.dueCount);
ok('someone already booked is not due', board.plans.find((x) => x.phone === '+14255550072').due === false);
ok('every row carries its text', board.plans.every((r) => !!r.draft));

section('Turning a plan on and off through the API');
await reset();
await customer('+14255550080', { name: 'Toggle Tom', lastTs: ago(90) });
await job('+14255550080', ago(90), 200, 'Toggle Tom');
let r = await (await M.apiPlan(req({ phone: '+14255550080', plan: { every: 84, service: 'Full detail', price: 300 } }))).json();
ok('a plan can be started', r.ok && r.plan.every === 84 && r.plan.price === 300, r.plan);
ok('it lands on the thread', (await M.loadThread('+14255550080')).plan.every === 84);
ok('and on the index, so the list never loads threads',
  (await M.loadIndex()).find((x) => x.phone === '+14255550080').plan.every === 84);
r = await (await M.apiPlan(req({ phone: '+14255550080', action: 'asked' }))).json();
ok('being asked is recorded', r.plan.askedAt > 0);
r = await (await M.apiPlan(req({ phone: '+14255550080', plan: { paused: true } }))).json();
ok('pausing keeps the interval', r.plan.paused === true && r.plan.every === 84, r.plan);
r = await (await M.apiPlan(req({ phone: '+14255550080', action: 'off' }))).json();
ok('it can be taken off entirely', r.plan === null);
ok('…and off the index too', !(await M.loadIndex()).find((x) => x.phone === '+14255550080').plan);
ok('a missing phone is refused', (await M.apiPlan(req({ action: 'off' }))).status === 422);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
