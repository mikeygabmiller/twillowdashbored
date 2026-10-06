// "Too many ppl in my dashboard are going unresponded" (Mikey, 2026-10-06).
// The reminders that keep going, the list that files itself, and the archive
// that gives a customer back the moment they write again. What has to hold:
//   - a text, a voicemail, a quote or a booking from them un-archives the chat;
//     a quiet tapback, a STOP or a blocked number never does
//   - a chat files itself away after N days with nothing going on, never while
//     something is still coming up, and comes back on anything new
//   - filing is a VIEW: copies, never the cached index rows, no KV writes
//   - one list of "waiting on him" that the push, the icon badge, the check-ins
//     and the dashboard all agree on
//   - the push names who's waiting before it says "Follow-ups ready"
//   - check-ins go at his hours, once per slot, by push, email only as a
//     fallback, never the SMS one
//   - "No reply needed" clears them without opening (and so reading) the chat
//
//   node test/waiting.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
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
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = [\\s\\S]*?;[^\\n]*\\n`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', 'S',
  'const {loadConfig,loadIndex,loadThread,openThreadForRead,saveThread,updateIndexEntry,kv,pushNotify,sendEmail,publicBase,isPracticePhone,readJson,normalizePhone,json} = S;' +
  'const ENV = new Proxy({}, { get: (_, k) => S.env[k] });' +
  ['DAY_MS', 'QUIET_TAPBACKS', 'TZFMT', 'MAILC', 'MAILF', 'FILE_DAYS_DEFAULT', 'FILE_DAYS_MIN', 'FILE_DONE_DAYS', 'PEEK_FRESH_MS',
    'WAIT_CHECKIN_KEY', 'WAIT_CHECKIN_HOURS', 'WAIT_CHECKIN_MIN_MS', 'WAIT_CHECKIN_LATE_MIN'].map(liftConst).join('\n') +
  ['tzFmt', 'localDateStr', 'localHour', 'localMinute', 'humanAgo', 'jdFirst', 'htmlEsc', 'mailLines', 'mailShell', 'mailCard', 'mailLabel', 'mailBtn',
    'wakeFromArchive', 'lastTalkTs', 'autoFileDays', 'rowLastActivity', 'rowFriendLinkDue', 'rowFiledAway', 'rowInList', 'filedView',
    'filedThread', 'rowAwaitingReply', 'waitingOnHim', 'pushWho', 'pushHeadline', 'checkinHours', 'checkinSlot', 'checkinDue',
    'dispatchWaitCheckins', 'checkinMail', 'apiNoReplyNeeded'].map(lift).join('\n') +
  '\nObject.assign(ctx, { wakeFromArchive, lastTalkTs, autoFileDays, rowFiledAway, rowLastActivity, filedView, filedThread, waitingOnHim,' +
  ' pushHeadline, checkinSlot, checkinDue, dispatchWaitCheckins, checkinMail, apiNoReplyNeeded, pushWho });'
)(ctx, new Proxy({}, { get: (_, k) => (k === 'env' ? ctx.S.env : (...a) => ctx.S[k](...a)) }));

const H = 3600000, D = 24 * H;
// Tuesday 2026-10-06, noon Pacific (19:00Z).
const NOW = Date.parse('2026-10-06T19:00:00Z');
const PRACTICE = '+15555550100';
const CFG = { tz: 'America/Los_Angeles' };

function world({ rows = [], config = CFG, threads = {}, pushed = 1, env = { RESEND_API_KEY: 'k', ALERT_EMAIL: 'm@x.com' }, stored = {} } = {}) {
  const w = { kvStore: Object.assign({}, stored), puts: [], gets: 0, pushes: 0, emails: [], reads: [], saves: [], indexed: [] };
  w.stub = {
    env,
    loadConfig: async () => config,
    loadIndex: async () => rows,
    loadThread: async (p) => { w.reads.push('load:' + p); return threads[p] || { phone: p, messages: [] }; },
    openThreadForRead: async (p) => { w.reads.push('OPEN:' + p); return threads[p]; },
    saveThread: async (t) => { w.saves.push(JSON.parse(JSON.stringify(t))); },
    updateIndexEntry: async (t) => { w.indexed.push(t.phone); },
    kv: () => ({
      get: async (k) => { w.gets++; return w.kvStore[k] == null ? null : w.kvStore[k]; },
      put: async (k, v) => { w.puts.push(k); w.kvStore[k] = v; },
    }),
    pushNotify: async () => { w.pushes++; return pushed; },
    sendEmail: async (subject, text, html) => { w.emails.push({ subject, text, html }); },
    publicBase: () => 'https://dash.example',
    isPracticePhone: (p) => p === PRACTICE,
    readJson: async (r) => r,
    normalizePhone: (p) => p,
    json: (o, status = 200) => ({ status, body: o }),
  };
  return w;
}
const use = (w) => { ctx.S = w.stub; return w; };
use(world());

const row = (over = {}) => Object.assign({
  phone: '+14255550101', name: 'Ruth Ames', lastDir: 'out', awaitingReply: false, unread: 0,
  lastTs: NOW - 2 * D, talkTs: NOW - 2 * D, firstTs: NOW - 40 * D, status: 'active', statusAt: NOW - 30 * D,
  lastBody: 'See you then',
}, over);
const waiting = (over = {}) => row(Object.assign({ lastDir: 'in', awaitingReply: true, waitSince: NOW - 5 * H, lastTs: NOW - 5 * H, talkTs: NOW - 5 * H, lastBody: 'How much for a Tahoe?' }, over));

// ---------------------------------------------------------------------------
console.log('\n=== an archived chat comes back when THEY reach out ===');
{
  const t = () => ({ phone: '+14255550101', archived: true, messages: [] });
  let x = t();
  check('a text wakes it', ctx.wakeFromArchive(x, { dir: 'in', ts: 5 }, {}), true);
  check('…not archived any more', x.archived, false);
  check('…and remembers when, for the alert', x.unarchivedAt, 5);
  check('his own send never does', ctx.wakeFromArchive(t(), { dir: 'out', ts: 5 }, {}), false);
  check('a heart on "thanks!" stays filed', ctx.wakeFromArchive(t(), { dir: 'in', kind: 'reaction', reactLabel: 'loved' }, {}), false);
  check('a question mark tapback is them asking something', ctx.wakeFromArchive(t(), { dir: 'in', kind: 'reaction', reactLabel: 'questioned' }, {}), true);
  check('a STOP never does', ctx.wakeFromArchive(t(), { dir: 'in', kind: 'opt-out' }, {}), false);
  check('a START does', ctx.wakeFromArchive(t(), { dir: 'in', kind: 'opt-in' }, {}), true);
  check('a voicemail does', ctx.wakeFromArchive(t(), { dir: 'in', kind: 'voicemail' }, {}), true);
  check('a number he blocked never does', ctx.wakeFromArchive(t(), { dir: 'in' }, { blockedNumbers: ['+14255550101'] }), false);
  check('a chat that isn\'t archived is left alone', ctx.wakeFromArchive({ phone: 'x', archived: false }, { dir: 'in' }, {}), false);
  // Every path a customer reaches out by goes through it.
  const calls = (SRC.match(/wakeFromArchive\(/g) || []).length;
  check('text, two voicemail paths, two quote forms, the booking page', calls >= 7, true);
  check('the alert says the chat came back', /You'd archived this chat/.test(SRC), true);
}

console.log('\n=== the filing clock ===');
{
  check('blasts aren\'t a conversation', ctx.lastTalkTs([{ dir: 'in', ts: 10 }, { dir: 'out', kind: 'blast', ts: 50 }]), 10);
  check('anything else is', ctx.lastTalkTs([{ dir: 'in', ts: 10 }, { dir: 'out', kind: 'followup', ts: 50 }]), 50);
  check('nothing but a blast → 0', ctx.lastTalkTs([{ dir: 'out', kind: 'blast', ts: 50 }]), 0);
  check('default is 14 days', ctx.autoFileDays({}), 14);
  check('0 means never', ctx.autoFileDays({ autoFileDays: 0 }), 0);
  check('never shorter than 3 days', ctx.autoFileDays({ autoFileDays: 1 }), 3);
  check('30 is 30', ctx.autoFileDays({ autoFileDays: 30 }), 30);
}

console.log('\n=== what files, and why ===');
{
  const f = (r, cfg = CFG, now = NOW) => ctx.rowFiledAway(r, cfg, now);
  check('2 days quiet → stays', f(row()), '');
  check('15 days quiet → filed', f(row({ lastTs: NOW - 15 * D, talkTs: NOW - 15 * D })), 'quiet');
  check('…unless the setting is Never', f(row({ lastTs: NOW - 15 * D, talkTs: NOW - 15 * D }), { tz: CFG.tz, autoFileDays: 0 }), '');
  check('…at 30 days it waits', f(row({ lastTs: NOW - 15 * D, talkTs: NOW - 15 * D }), { tz: CFG.tz, autoFileDays: 30 }), '');
  const old = (over) => row(Object.assign({ lastTs: NOW - 40 * D, talkTs: NOW - 40 * D, statusAt: NOW - 40 * D }, over));
  check('never answered → says so', f(old({ lastDir: 'in', awaitingReply: true, waitSince: NOW - 40 * D })), 'unanswered');
  check('a "thanks!" that was never answered is just quiet', f(old({ lastDir: 'in', awaitingReply: false })), 'quiet');
  // What keeps a chat in the list, however old.
  check('pinned', f(old({ pinned: true })), '');
  check('a text he never opened, two weeks on → filed, and says so', f(old({ unread: 1, lastDir: 'in', awaitingReply: true })), 'unopened');
  check('…but not while it\'s recent', f(row({ unread: 1, lastDir: 'in', awaitingReply: true })), '');
  check('a job booked ahead', f(old({ appointmentAt: NOW + 3 * D })), '');
  check('a text queued to go', f(old({ scheduledCount: 1 })), '');
  check('a reminder he set', f(old({ reminderAt: NOW + 2 * D })), '');
  check('a reminder that came due and he hasn\'t cleared', f(old({ reminderAt: NOW - 5 * D, reminderDue: true })), '');
  check('parked until a date', f(old({ heldUntil: NOW + 10 * D })), '');
  check('a Clean Club plan', f(old({ plan: { every: 56, paused: false } })), '');
  check('…but not a paused one', f(old({ plan: { every: 56, paused: true } })), 'quiet');
  check('a helper follow-up still to come', f(old({ helperFollowAt: NOW + D, helperFollowSent: false })), '');
  check('already archived by him: not "filed"', f(old({ archived: true })), '');
  // What counts as something happening.
  check('his "keep this one" restarts the clock', f(old({ keptAt: NOW - 3 * D })), '');
  check('a follow-up the app surfaced', f(old({ followupDue: true, fu: { at: NOW - 2 * D, dueAt: NOW - 90 * D } })), '');
  check('…read from when it surfaced, not its old due date', f(old({ followupDue: true, fu: { at: 0, dueAt: NOW - 90 * D } })), 'quiet');
  check('the day of a job', f(old({ appointmentAt: NOW - 4 * D })), '');
  check('a hold that just ran out', f(old({ heldUntil: NOW - 2 * D })), '');
  check('marking it Won', f(old({ status: 'won', statusAt: NOW - 1 * D })), '');
  check('a blast doesn\'t wake an old chat', f(old({ lastTs: NOW - 1 * D })), 'quiet');
  check('a chat a blast started gets its days', f(row({ lastTs: NOW - 1 * D, talkTs: 0, firstTs: NOW - 1 * D, statusAt: 0 })), '');
  // Friend link: 5 to 30 days after a job.
  const job = (over) => old(Object.assign({ status: 'won', lastJobAt: NOW - 20 * D }, over));
  check('a friend link still to send keeps it', f(job()), '');
  check('…sent: files', f(job({ linkAt: { friend: NOW - 10 * D } })), 'quiet');
  check('…skipped: files', f(job({ linkSkip: { friend: NOW - 10 * D } })), 'quiet');
  check('…the job had a problem: files', f(job({ issueAt: NOW - 19 * D })), 'quiet');
  check('…31 days after the job: files', f(job({ lastJobAt: NOW - 31 * D })), 'quiet');
  // Done when he says so, or they do.
  check('Lost, 3 days ago → filed', f(row({ status: 'lost', statusAt: NOW - 3 * D, lastTs: NOW - 9 * D, talkTs: NOW - 9 * D })), 'lost');
  check('Lost an hour ago → still on screen', f(row({ status: 'lost', statusAt: NOW - H })), '');
  check('a Lost lead who writes again gets the full stretch',
    f(row({ status: 'lost', statusAt: NOW - 20 * D, lastDir: 'in', awaitingReply: true, lastTs: NOW - 3 * D, talkTs: NOW - 3 * D })), '');
  check('texted STOP 3 days ago → filed', f(row({ optedOut: true, lastDir: 'in', awaitingReply: false, lastTs: NOW - 3 * D, talkTs: NOW - 3 * D })), 'stopped');
}

console.log('\n=== filing is a view, never a write ===');
{
  const a = row(), b = row({ phone: '+14255550102', lastTs: NOW - 20 * D, talkTs: NOW - 20 * D });
  const idx = [a, b];
  const v = ctx.filedView(idx, CFG, NOW);
  check('the in-play one is passed through as is', v[0] === a, true);
  check('the filed one reads as archived', [v[1].archived, v[1].filed], [true, 'quiet']);
  check('…with when it went quiet', v[1].quietSince, NOW - 20 * D);
  check('…on a copy: the cached row is untouched', [b.archived, b.filed], [undefined, undefined]);
  check('the index array itself is not the one returned', v !== idx, true);
  check('Never: the very same list back', ctx.filedView(idx, { autoFileDays: 0 }, NOW) === idx, true);
  const thread = { phone: b.phone, archived: false, messages: [] };
  const ft = ctx.filedThread(thread, idx, CFG, NOW);
  check('an open filed conversation says Restore, not Archive', [ft.archived, ft.filed], [true, 'quiet']);
  check('…without touching the thread it was given', thread.archived, false);
  check('an in-play conversation is returned as is', ctx.filedThread({ phone: a.phone, messages: [] }, idx, CFG, NOW).filed, undefined);
  // No KV anywhere on the path that files.
  const src = ['rowFiledAway', 'filedView', 'filedThread', 'rowLastActivity'].map(lift).join('\n');
  check('no kv(), saveThread or saveIndex in the filing code', /kv\(\)|saveThread|saveIndex/.test(src), false);
}

console.log('\n=== one list of who is waiting ===');
{
  const rows = [
    waiting({ phone: '+1a', name: 'Newer', waitSince: NOW - 1 * H, lastTs: NOW - 1 * H, talkTs: NOW - 1 * H }),
    waiting({ phone: '+1b', name: 'Older', waitSince: NOW - 9 * H, lastTs: NOW - 9 * H, talkTs: NOW - 9 * H }),
    waiting({ phone: '+1c', name: 'Parked', heldUntil: NOW + 5 * D }),
    waiting({ phone: '+1d', name: 'Stopped', optedOut: true }),
    waiting({ phone: PRACTICE, name: 'Practice · Ruth' }),
    waiting({ phone: '+1e', name: 'Archived', archived: true }),
    waiting({ phone: '+1f', name: 'Ancient', waitSince: NOW - 30 * D, lastTs: NOW - 30 * D, talkTs: NOW - 30 * D, statusAt: NOW - 30 * D }),
    row({ phone: '+1g', name: 'Thanks', lastDir: 'in', awaitingReply: false }),
    row({ phone: '+1h', name: 'He spoke last' }),
  ];
  check('only the two really waiting, longest wait first', ctx.waitingOnHim(rows, CFG, NOW).map((e) => e.name), ['Older', 'Newer']);
  check('the same list the dashboard counts (waitingOnMe skips holds)', /function waitingOnMe\(t\)\{return awaitingReply\(t\)&&!\(t\.heldUntil&&t\.heldUntil>Date\.now\(\)\)\}/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')), true);
}

console.log('\n=== the push says who is waiting ===');
{
  const h = (rows, now = NOW, cfg = CFG) => ctx.pushHeadline(rows, cfg, now);
  const ruth = waiting({ name: 'Ruth Ames' });
  let r = h([ruth, row({ phone: '+1z', followupDue: true, fu: { at: NOW - H } })]);
  check('someone waiting beats "Follow-ups ready"', r.title, '⏳ Ruth Ames is waiting on you (5h)');
  check('…with what they said', r.body, 'How much for a Tahoe?');
  check('…and a tap opens their chat', r.url, '/?c=%2B14255550101');
  check('…and the icon says 1', r.badge, 1);
  r = h([ruth, waiting({ phone: '+1b', name: 'Dave Ortiz', waitSince: NOW - 26 * H, lastTs: NOW - 26 * H, talkTs: NOW - 26 * H })]);
  check('two or more: a roll-up', r.title, '⏳ 2 people are waiting on you');
  check('…first names and how long, longest first', r.body, 'Dave 1d · Ruth 5h');
  check('…and a tap opens the waiting list', r.url, '/?waiting=1');
  const many = [0, 1, 2, 3, 4, 5].map((i) => waiting({ phone: '+1' + i, name: 'P' + i, waitSince: NOW - (10 - i) * H, lastTs: NOW - (10 - i) * H }));
  check('more than four: "+2 more"', h(many).body.endsWith('· +2 more'), true);
  check('no name: a number he can read', ctx.pushWho({ phone: '+14255550101' }), '(425) 555-0101');
  // A text that just landed is what the push is about.
  const T = Date.parse('2026-10-06T21:30:00Z');   // 2:30pm, not a check-in
  const fresh = waiting({ phone: '+1n', name: 'Nina', unread: 1, waitSince: T - 2 * 60000, lastTs: T - 2 * 60000, lastBody: 'You free Sat?' });
  r = h([ruth, fresh], T);
  check('a text 2 min old → "New text from"', r.title, 'New text from Nina');
  check('…with how many are waiting', r.body, 'You free Sat? (2 waiting on you)');
  // …except in the first minutes of a check-in, when it IS the check-in.
  const atNoon = Date.parse('2026-10-06T19:01:00Z');   // 12:01pm Pacific
  const fresh2 = Object.assign({}, fresh, { lastTs: atNoon - 2 * 60000, waitSince: atNoon - 2 * 60000 });
  r = h([ruth, fresh2], atNoon);
  check('12:01, two waiting → the check-in roll-up', r.title, '⏳ 2 people are waiting on you');
  r = h([fresh2], atNoon);
  check('12:01, only the new one waiting → still "New text from"', r.title, 'New text from Nina');
  // An unread text from hours ago is not "new".
  const stale = row({ phone: '+1s', name: 'Sam', unread: 1, lastDir: 'in', awaitingReply: false, lastTs: NOW - 3 * H, lastBody: 'thanks!' });
  r = h([stale]);
  check('old unread, nobody waiting → "Unread text from", not "New"', r.title, 'Unread text from Sam');
  r = h([row({ followupDue: true, fu: { at: NOW - H } })]);
  check('nothing else → follow-ups', r.title, 'Follow-ups ready');
  check('…and the icon clears', r.badge, 0);
  // A filed chat says nothing, however long ago they were waiting.
  r = h([waiting({ waitSince: NOW - 30 * D, lastTs: NOW - 30 * D, talkTs: NOW - 30 * D, statusAt: NOW - 30 * D })]);
  check('filed "never answered" is not in the push', [r.title, r.badge], ["Mikey's Dashboard", 0]);
  check('the generic line has no em dash', /—/.test(r.body), false);
}

console.log('\n=== check-in slots ===');
{
  const at = (iso) => Date.parse(iso);
  check('noon Pacific is a slot', ctx.checkinSlot(CFG, at('2026-10-06T19:00:00Z')), '2026-10-06@12');
  check('12:44 still is (a missed tick)', ctx.checkinSlot(CFG, at('2026-10-06T19:44:00Z')), '2026-10-06@12');
  check('12:45 is not', ctx.checkinSlot(CFG, at('2026-10-06T19:45:00Z')), '');
  check('8am and 6pm are', [ctx.checkinSlot(CFG, at('2026-10-06T15:05:00Z')), ctx.checkinSlot(CFG, at('2026-10-07T01:05:00Z'))], ['2026-10-06@8', '2026-10-06@18']);
  check('2pm is not', ctx.checkinSlot(CFG, at('2026-10-06T21:00:00Z')), '');
  check('his own hours', ctx.checkinSlot({ tz: CFG.tz, waitCheckinHours: [14] }, at('2026-10-06T21:10:00Z')), '2026-10-06@14');
  check('switched off → never', ctx.checkinSlot({ tz: CFG.tz, waitCheckins: false }, at('2026-10-06T19:00:00Z')), '');
  check('no hours picked → never', ctx.checkinSlot({ tz: CFG.tz, waitCheckinHours: [] }, at('2026-10-06T19:00:00Z')), '');
  const rows = [waiting(), waiting({ phone: '+1x', name: 'Just texted', waitSince: NOW - 10 * 60000, lastTs: NOW - 10 * 60000 })];
  check('someone who texted 10 min ago just got their alert: not in it', ctx.checkinDue(rows, CFG, NOW).map((e) => e.name), ['Ruth Ames']);
}

console.log('\n=== check-ins go out ===');
{
  const NOON = Date.parse('2026-10-06T19:00:00Z');
  let w = use(world({ rows: [waiting()] }));
  check('noon, Ruth waiting 5h → one push', [await ctx.dispatchWaitCheckins(NOON), w.pushes], [1, 1]);
  check('…stamped for the slot, before the push', [w.puts, w.kvStore.waitcheckin], [['waitcheckin'], '2026-10-06@12']);
  check('…no email: the push went', w.emails.length, 0);
  check('next minute, same slot → nothing', [await ctx.dispatchWaitCheckins(NOON + 60000), w.pushes], [0, 1]);
  check('6pm → goes again (still waiting)', [await ctx.dispatchWaitCheckins(Date.parse('2026-10-07T01:00:00Z')), w.pushes], [1, 2]);

  w = use(world({ rows: [row()] }));
  check('nobody waiting → no push, no write', [await ctx.dispatchWaitCheckins(NOON), w.pushes, w.puts.length], [0, 0, 0]);
  w = use(world({ rows: [waiting()] }));
  check('outside a slot → nothing read at all', [await ctx.dispatchWaitCheckins(Date.parse('2026-10-06T21:00:00Z')), w.gets, w.pushes], [0, 0, 0]);
  w = use(world({ rows: [waiting()], config: { tz: CFG.tz, waitCheckins: false } }));
  check('switched off → nothing', [await ctx.dispatchWaitCheckins(NOON), w.pushes], [0, 0]);

  w = use(world({ rows: [waiting()], pushed: 0 }));
  await ctx.dispatchWaitCheckins(NOON);
  check('no phone has push → an email instead', w.emails.length, 1);
  check('…naming her', w.emails[0].subject, '⏳ Ruth Ames is still waiting on you (5h)');
  check('…with a link to exactly the waiting list', /\/\?waiting=1/.test(w.emails[0].text), true);
  w = use(world({ rows: [waiting()], pushed: 0, env: {} }));
  await ctx.dispatchWaitCheckins(NOON);
  check('no push and no email set up → nothing (never a text)', w.emails.length, 0);
  const body = lift('dispatchWaitCheckins');
  check('it never goes through notifyMikey (the SMS fallback)', /notifyMikey|sendSms/.test(body), false);
  const two = ctx.checkinMail([waiting(), waiting({ phone: '+1b', name: 'Dave' })], CFG, NOW);
  check('several → "2 people are"', two.subject, '⏳ 2 people are still waiting on you');
  check('the email says when it comes', /8am, 12pm, 6pm/.test(two.text), true);
}

console.log('\n=== "No reply needed" ===');
{
  const thread = () => ({
    phone: '+14255550101', messages: [{ dir: 'out', ts: 1 }, { dir: 'in', ts: 2, body: "I'll let you know" }],
    suggested: { text: 'draft' }, needsYou: { question: 'q' }, needsYouAnswers: ['a'],
    followup: { suggestion: { stage: 'owed', stepKey: 'owed:2' } },
  });
  let w = use(world({ threads: { '+14255550101': thread() } }));
  let r = await ctx.apiNoReplyNeeded({ phone: '+14255550101' });
  const saved = w.saves[0];
  check('ok', r.body.ok, true);
  check('the verdict is on their last text', [saved.replyCheck.forTs, saved.replyCheck.needed, saved.replyCheck.via], [2, false, 'owner']);
  check('the draft, the held question and the owed nudge are gone', [saved.suggested, saved.needsYou, saved.followup.suggestion], [null, null, null]);
  check('the list row is rebuilt', w.indexed, ['+14255550101']);
  check('loaded, never opened (opening marks it read)', w.reads, ['load:+14255550101']);
  const other = thread(); other.followup.suggestion = { stage: 'won', stepKey: 'won:review' };
  w = use(world({ threads: { '+14255550101': other } }));
  await ctx.apiNoReplyNeeded({ phone: '+14255550101' });
  check('a review-ask nudge is left alone', w.saves[0].followup.suggestion.stage, 'won');
  const his = thread(); his.messages.push({ dir: 'out', ts: 3 });
  w = use(world({ threads: { '+14255550101': his } }));
  r = await ctx.apiNoReplyNeeded({ phone: '+14255550101' });
  check('he spoke last → 409, nothing saved', [r.status, w.saves.length], [409, 0]);
  check('routed for Mikey', /pathname === '\/api\/reply\/none'\)\s*return apiNoReplyNeeded/.test(SRC), true);
}

console.log('\n=== the cron runs the check-ins ===');
{
  const cron = lift('runCron');
  check('dispatchWaitCheckins is on the minute cron', /dispatchWaitCheckins\(\)/.test(cron), true);
  check('…after the two-hour nudge', cron.indexOf('dispatchWaitNudges') < cron.indexOf('dispatchWaitCheckins'), true);
}

console.log(`\n${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
