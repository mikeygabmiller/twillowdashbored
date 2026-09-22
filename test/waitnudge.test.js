// The two-hour nudge: a customer texted, the alert went out, and nobody answered.
// What has to hold:
//   - it fires once per unanswered run, counted from their FIRST text, never again
//   - never for the practice customer, someone who opted out, or an archived thread
//   - never during quiet hours, and three or more at once come as one email
//   - the email carries the one-tap answers (draft, choices, "buy me time") and
//     the ref line, so a reply to it routes like a reply to the first alert
//   - it never opens a thread through the read path (that clears unread)
//
//   node test/waitnudge.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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
  'const {loadConfig,loadIndex,loadThread,openThreadForRead,notifyMikey,kv,inQuietHours,publicBase,isPracticePhone} = S;' +
  'const ENV = { ALERT_EMAIL: "mikey@example.com" };' +
  ['ASSIST_CUT', 'MAILC', 'MAILF', 'WAIT_NUDGE_KEY', 'WAIT_NUDGE_MAX_AGE_MS', 'WAIT_NUDGE_DIGEST_AT', 'WAIT_STALL_TEXT'].map(liftConst).join('\n') +
  ['htmlEsc', 'mailLines', 'mailShell', 'mailCard', 'mailLabel', 'mailShout', 'mailBtn', 'humanAgo', 'emailAddr',
    'assistMailto', 'rowAwaitingReply', 'waitingSinceTs', 'waitNudgeMs', 'waitNudgeDue', 'dispatchWaitNudges',
    'waitNudgeParts', 'waitNudgeMail', 'waitDigestMail'].map(lift).join('\n') +
  '\nctx.run = dispatchWaitNudges; ctx.due = waitNudgeDue; ctx.since = waitingSinceTs; ctx.STALL = WAIT_STALL_TEXT;'
)(ctx, new Proxy({}, { get: (_, k) => (...a) => ctx.S[k](...a) }));

const H = 3600000;
const NOW = Date.parse('2026-09-22T19:00:00Z');   // noon Pacific
const PRACTICE = '+10000000000';

function world({ rows, threads = {}, config = {}, quiet = false, stored = null }) {
  const w = { kvStore: { waitnudge: stored }, mails: [], reads: [], puts: 0 };
  w.stub = {
    loadConfig: async () => config,
    loadIndex: async () => rows,
    loadThread: async (p) => { w.reads.push('load:' + p); return threads[p] || { phone: p, messages: [] }; },
    openThreadForRead: async (p) => { w.reads.push('OPEN:' + p); return threads[p]; },
    notifyMikey: async (subject, body) => { w.mails.push({ subject, body }); return true; },
    kv: () => ({
      get: async (k) => w.kvStore[k] || null,
      put: async (k, v) => { w.puts++; w.kvStore[k] = JSON.parse(v); },
    }),
    inQuietHours: () => quiet,
    publicBase: () => 'https://dash.example',
    isPracticePhone: (p) => p === PRACTICE,
  };
  return w;
}
const run = async (w, now = NOW) => { ctx.S = w.stub; return ctx.run(now); };
const row = (over = {}) => Object.assign({
  phone: '+14255550101', name: 'Ruth', lastDir: 'in', awaitingReply: true,
  lastTs: NOW - 2.5 * H, waitSince: NOW - 2.5 * H, lastBody: 'How much for a Tahoe?',
}, over);

ctx.S = world({ rows: [] }).stub;   // the pure checks below still ask isPracticePhone

console.log('\n=== the clock starts at their FIRST unanswered text ===');
check('run of three inbound → first of them', ctx.since([
  { dir: 'out', ts: 1 }, { dir: 'in', ts: 10 }, { dir: 'in', ts: 20 }, { dir: 'in', ts: 30 }]), 10);
check('his reply resets it', ctx.since([{ dir: 'in', ts: 10 }, { dir: 'out', ts: 20 }]), 0);
check('a double-text an hour in does not push it back',
  ctx.due([row({ lastTs: NOW - 1 * H, waitSince: NOW - 2.5 * H })], {}, {}, NOW).length, 1);

console.log('\n=== who gets nudged ===');
check('2.5h waiting → due', ctx.due([row()], {}, {}, NOW).length, 1);
check('1h waiting → not yet', ctx.due([row({ waitSince: NOW - H, lastTs: NOW - H })], {}, {}, NOW).length, 0);
check('custom 3h setting respected', ctx.due([row()], { waitNudgeHours: 3 }, {}, NOW).length, 0);
check('switched off → nothing', ctx.due([row()], { waitNudge: false }, {}, NOW).length, 0);
check('he answered last → nothing', ctx.due([row({ lastDir: 'out' })], {}, {}, NOW).length, 0);
check('"Thanks!" (nothing owed) → nothing', ctx.due([row({ awaitingReply: false })], {}, {}, NOW).length, 0);
check('opted out → nothing', ctx.due([row({ optedOut: true })], {}, {}, NOW).length, 0);
check('archived → nothing', ctx.due([row({ archived: true })], {}, {}, NOW).length, 0);
check('practice customer → nothing', ctx.due([row({ phone: PRACTICE })], {}, {}, NOW).length, 0);
check('older than a day → left to Home and the brief',
  ctx.due([row({ waitSince: NOW - 30 * H, lastTs: NOW - 30 * H })], {}, {}, NOW).length, 0);
check('already nudged for this run → nothing',
  ctx.due([row()], {}, { '+14255550101': NOW - 2.5 * H }, NOW).length, 0);
check('a NEW run after he answered → due again',
  ctx.due([row()], {}, { '+14255550101': NOW - 20 * H }, NOW).length, 1);

console.log('\n=== one email, once ===');
{
  const t = { phone: '+14255550101', name: 'Ruth', messages: [
    { dir: 'out', body: 'Hi Ruth', ts: NOW - 5 * H },
    { dir: 'in', body: 'How much for a Tahoe?', ts: NOW - 2.5 * H },
  ], suggested: { text: 'Full detail on a Tahoe is $339.', forTs: NOW - 2.5 * H } };
  const w = world({ rows: [row()], threads: { '+14255550101': t } });
  check('one nudge fired', await run(w), 1);
  check('one email', w.mails.length, 1);
  check('subject says who and how long', /^⏳ Ruth is still waiting \(3h\)/.test(w.mails[0].subject), true);
  check('subject carries their words', /Tahoe/.test(w.mails[0].subject), true);
  const { text, html } = w.mails[0].body;
  check('the draft is in it', /\$339/.test(text) && /\$339/.test(html), true);
  check('one-tap Send it', /Send it/.test(html) && /body=YES/.test(html), true);
  check('buy-me-time reply offered, sent verbatim', html.includes(encodeURIComponent('send: ' + ctx.STALL)), true);
  check('routes like the first alert (ref line)', /\[ref:\+14255550101\]/.test(text), true);
  check('never opened through the read path', w.reads.some((r) => r.startsWith('OPEN')), false);
  check('marked', w.kvStore.waitnudge['+14255550101'], NOW - 2.5 * H);
  check('next minute: silent', await run(w, NOW + 60000), 0);
  check('still one email', w.mails.length, 1);
}

console.log('\n=== choices go through "write:" so the customer gets a sentence ===');
{
  const t = { phone: '+14255550101', name: 'Ruth', messages: [{ dir: 'in', body: 'When can you come?', ts: NOW - 2.5 * H }],
    needsYou: { question: 'Which day works?', options: ['Thursday 9am', 'Friday 2pm'], forTs: NOW - 2.5 * H } };
  const w = world({ rows: [row()], threads: { '+14255550101': t } });
  await run(w);
  const { html } = w.mails[0].body;
  check('the question is shown', /Which day works\?/.test(html), true);
  check('each choice is a write: button', html.includes(encodeURIComponent('write: Thursday 9am')), true);
  check('no stale "Send it" without a draft', /body=YES/.test(html), false);
}

console.log('\n=== quiet hours and the pile-up ===');
{
  const w = world({ rows: [row()], quiet: true });
  check('quiet hours → nothing sent', await run(w), 0);
  check('and nothing marked, so it goes in the morning', w.puts, 0);
}
{
  const rows = [1, 2, 3].map((i) => row({ phone: '+1425555010' + i, name: 'C' + i, waitSince: NOW - (2 + i) * H }));
  const w = world({ rows });
  check('three due → all counted', await run(w), 3);
  check('…as ONE email', w.mails.length, 1);
  check('digest subject', w.mails[0].subject, '⏳ 3 people are still waiting on you');
  check('oldest first', w.mails[0].body.text.indexOf('C3') < w.mails[0].body.text.indexOf('C1'), true);
  check('no threads loaded for a digest', w.reads.length, 0);
}
{
  const w = world({ rows: [row({ waitSince: NOW - H, lastTs: NOW - H })] });
  await run(w);
  check('nobody due → no KV read or write', [w.puts, w.mails.length], [0, 0]);
}

console.log('\n=== wiring ===');
check('runs on the cron', /await dispatchWaitNudges\(\)/.test(lift('runCron')), true);
check('the list row carries waitSince', /waitSince:/.test(lift('buildIndexSummary')), true);
check('config default on, 2 hours', /waitNudge: true/.test(lift('defaultConfig')) && /waitNudgeHours: 2/.test(lift('defaultConfig')), true);
check('both keys can be saved', /data\.waitNudge\b/.test(lift('apiSaveConfig')) && /data\.waitNudgeHours/.test(lift('apiSaveConfig')), true);
check('Settings has the switch', /id="cfgWaitNudge"/.test(HTML) && /saveConfig\(\{waitNudge:/.test(HTML), true);
check('Settings has the hours box', /id="cfgWaitNudgeH"/.test(HTML) && /saveConfig\(\{waitNudgeHours:/.test(HTML), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
if (FAIL) process.exit(1);
