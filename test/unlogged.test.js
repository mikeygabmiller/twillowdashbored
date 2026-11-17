// "Finished, but no money logged" (Money tab + Home's Today's money card).
//
// The list used to key on one thing: the chat marked Won. Mikey almost never
// marks chats Won (6 of 160, Nov 2026), so it sat empty while ten booked jobs
// went unlogged and Home read "$0 made, -$185 this month". Now a booked time
// going by counts too — the same trigger as the "job is done" banner in a chat.
//
// What has to hold:
//   · an appointment that's passed, with no job logged, is on the list
//   · …unless a job is logged for that customer since then
//   · a job still in its first hour isn't called finished
//   · past a month it's history, not a to-do
//   · Lost leads, and ones he waved off ("Didn't happen"), stay off
//   · Won still works on its own, the way it did
//
//   node test/unlogged.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
// The index comes from KV in the Worker; here it's whatever the test says.
const M = new Function('__env__', src + '\n; ENV = __env__; loadIndex = async () => globalThis.__IDX || []; return { moneyWonNudges };')({
  MESSAGES: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const H = 3600000, DAY = 24 * H, now = Date.now();

globalThis.__IDX = [
  { phone: '+1001', name: 'Greg Done', status: 'new', appointmentAt: now - 2 * DAY },
  { phone: '+1002', name: 'Paid Pat', status: 'new', appointmentAt: now - 3 * DAY },
  { phone: '+1003', name: 'Working Wes', status: 'new', appointmentAt: now - 20 * 60000 },
  { phone: '+1004', name: 'Old Olive', status: 'new', appointmentAt: now - 40 * DAY },
  { phone: '+1005', name: 'Lost Lou', status: 'lost', appointmentAt: now - 2 * DAY },
  { phone: '+1006', name: 'Waved Wanda', status: 'new', appointmentAt: now - 4 * DAY },
  { phone: '+1007', name: 'Won Will', status: 'won', statusAt: now - 1 * DAY },
  { phone: '+1008', name: 'Filed Fran', status: 'new', archived: true, appointmentAt: now - 9 * DAY },
  { phone: '+1009', name: 'Tomorrow Tim', status: 'new', appointmentAt: now + DAY },
];
const entries = [{ type: 'job', phone: '+1002', ts: now - 3 * DAY + 4 * H, amount: 300 }];
const cfg = { nudgeDismissed: { '+1006': now - DAY } };

const out = await M.moneyWonNudges(entries, cfg, now);
const has = (p) => out.some((x) => x.phone === p);
const kind = (p) => (out.find((x) => x.phone === p) || {}).kind;

ok('a passed appointment with nothing logged is on the list', has('+1001') && kind('+1001') === 'appt', out);
ok('…and one he already logged is not', !has('+1002'));
ok('a job still in its first hour is not "finished"', !has('+1003'));
ok('past a month it drops off', !has('+1004'));
ok('a Lost lead stays off', !has('+1005'));
ok('"Didn\'t happen" (dismissed after the time) keeps it off', !has('+1006'));
ok('Won on its own still counts, marked as Won', has('+1007') && kind('+1007') === 'won');
ok('a chat that filed itself after the job still counts — the work happened', has('+1008'));
ok('a future booking is not on it', !has('+1009'));
ok('newest first', out[0].phone === '+1007', out.map((x) => x.phone));

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
