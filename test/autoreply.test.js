// The quote-form auto-reply confirmation: when the customer's held reach-out
// actually reaches them ~3.5 min after they submit the form, Mikey gets a text
// saying so. The risky parts are (a) it must be a TEXT, not the email-preferring
// notifyMikey, and (b) it must fire on the send, not on the queueing — a
// confirmation that goes out before the message does is worse than none.
//
//   node test/autoreply.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit tests — the Worker's functions are module-private,
// so they're pulled out by name rather than exported purely for tests. This one
// also carries the `async ` prefix along, or an awaiting body won't parse.
function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) throw new Error(`could not find body of ${name}`);
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// A whole fake world for the dispatcher: KV is a plain object, Twilio is an
// array of calls, and any number in `failFor` throws the way a Twilio error would.
function world({ threads, config = {}, failFor = [] }) {
  const store = {};
  for (const t of threads) store[t.phone] = t;
  const w = {
    store,
    smsToCustomers: [],   // sendSms() calls
    texts: [],            // ownerSay() — what lands on Mikey's cell
    emails: [],           // notifyMikey() — the email-preferring path
    saves: [],            // saveThread() order, to prove the send is recorded first
    stub: {},
  };
  let n = 0;
  w.stub = {
    loadIndex: async () => threads.map((t) => ({
      phone: t.phone, archived: false, scheduledCount: (t.scheduled || []).length,
    })),
    loadThread: async (phone) => store[phone],
    saveThread: async (t) => { store[t.phone] = t; w.saves.push('save:' + t.phone); },
    updateIndexEntry: async () => {},
    sendSms: async (to, body) => {
      if (failFor.includes(to)) throw new Error('Twilio 21610: unsubscribed recipient');
      w.smsToCustomers.push({ to, body });
      return { sid: 'SM' + (++n) };
    },
    ownerSay: async (msg) => { w.texts.push(msg); w.saves.push('text'); },
    notifyMikey: async (subject) => { w.emails.push(subject); return true; },
    genId: () => 'id' + (++n),
    voiceUsable: () => false,          // templated auto-replies are never his voice
    maybePromise: async () => {},
    addVoiceSamples: async () => {},
    loadConfig: async () => config,
  };
  return w;
}

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', 'S',
  'const {loadIndex,loadThread,saveThread,updateIndexEntry,sendSms,ownerSay,notifyMikey,' +
  'genId,voiceUsable,maybePromise,addVoiceSamples,loadConfig} = S;' +
  lift('threadWho') + '\n' + lift('dispatchDueScheduled') + '\n' +
  'ctx.run = dispatchDueScheduled; ctx.threadWho = threadWho;'
)(ctx, new Proxy({}, { get: (_, k) => (...a) => ctx.S[k](...a) }));
// The stubs are swapped per-scenario through ctx.S, so one lifted copy serves
// every test instead of re-evaluating the source each time.
const run = async (w, now) => { ctx.S = w.stub; return ctx.run(now); };
const { threadWho } = ctx;

const NOW = Date.parse('2026-08-08T15:00:00Z');
const lead = (over = {}) => Object.assign({
  phone: '+14255550101', name: 'Ruth Alvarez', messages: [],
  scheduled: [{ id: 'q1', body: "Hey Ruth, it's Mikey. I got your quote submission on my site.", sendAt: NOW - 1000, alertOnSend: true }],
}, over);

console.log('\n=== the confirmation names the customer so he can act on it ===');
check('name and number together', threadWho({ name: 'Ruth Alvarez', phone: '+14255550101' }), 'Ruth Alvarez (+14255550101)');
check('falls back to the number',  threadWho({ phone: '+14255550101' }), '+14255550101');
check('never renders "undefined"', threadWho({}), 'a customer');

console.log('\n=== he gets a text when the auto-reply actually lands ===');
{
  const w = world({ threads: [lead()] });
  const sent = await run(w, NOW);
  check('the customer got their text',   w.smsToCustomers.length, 1);
  check('the auto-reply was counted',    sent, 1);
  check('exactly one text to Mikey',     w.texts.length, 1);
  check('it says the reply went out',    /^✅ Auto-reply sent/.test(w.texts[0]), true);
  check('it names who',                  /Ruth Alvarez \(\+14255550101\)/.test(w.texts[0]), true);
  check('it is a text, not an email',    w.emails.length, 0);
}

console.log('\n=== a failed auto-reply is told the same way, not left silent ===');
{
  const w = world({ threads: [lead()], failFor: ['+14255550101'] });
  await run(w, NOW);
  check('the customer got nothing',      w.smsToCustomers.length, 0);
  check('Mikey still got a text',        w.texts.length, 1);
  check('it says it did NOT send',       /did NOT send/.test(w.texts[0]), true);
  check('it carries the Twilio reason',  /21610/.test(w.texts[0]), true);
  check('no duplicate email alert',      w.emails.length, 0);
}

console.log('\n=== the customer text is recorded before the confirmation goes out ===');
{
  // If Twilio choked on Mikey's confirmation *before* the thread was saved, the
  // customer's text would vanish from the history even though they received it.
  const w = world({ threads: [lead()] });
  await run(w, NOW);
  check('save happens first', w.saves.indexOf('save:+14255550101') < w.saves.indexOf('text'), true);
}

console.log('\n=== everything else about the cron is untouched ===');
{
  // A plain queued text (no alertOnSend) must not start texting him.
  const plain = lead({ scheduled: [{ id: 'p1', body: 'on my way', sendAt: NOW - 1000, src: 'manual' }] });
  const w = world({ threads: [plain] });
  await run(w, NOW);
  check('customer still gets it',       w.smsToCustomers.length, 1);
  check('no confirmation text',         w.texts.length, 0);
}
{
  // …and a plain one that fails still uses the old email-first alert.
  const plain = lead({ scheduled: [{ id: 'p1', body: 'on my way', sendAt: NOW - 1000 }] });
  const w = world({ threads: [plain], failFor: ['+14255550101'] });
  await run(w, NOW);
  check('old failure alert survives',   w.emails, ['⚠️ Scheduled text failed']);
  check('and it is not doubled up',     w.texts.length, 0);
}
{
  // Nothing due yet: the auto-reply is still in its 3.5-minute hold.
  const held = lead({ scheduled: [{ id: 'q1', body: 'hi', sendAt: NOW + 200000, alertOnSend: true }] });
  const w = world({ threads: [held] });
  const sent = await run(w, NOW);
  check('nothing sent while held',      sent, 0);
  check('and no premature confirmation', w.texts.length, 0);
}

console.log('\n=== the switch turns it off without touching the customer text ===');
{
  const w = world({ threads: [lead()], config: { autoReplyAlert: false } });
  await run(w, NOW);
  check('customer still gets their text', w.smsToCustomers.length, 1);
  check('but Mikey is not texted',        w.texts.length, 0);
}

console.log('\n=== both quote endpoints tag the reach-out for a confirmation ===');
// The site posts to /submit; /qqc-text is the ported Make scenario. A lead
// arriving through either one has to behave the same.
const liftSrc = (n) => lift(n);
check('/submit marks its auto-reply',   /alertOnSend: true/.test(liftSrc('handleSubmit')), true);
check('/qqc-text marks its auto-reply', /alertOnSend: true/.test(liftSrc('handleQqcText')), true);
check('the switch is a real config key', /autoReplyAlert/.test(liftSrc('defaultConfig')), true);
check('and it can be saved',             /autoReplyAlert/.test(liftSrc('apiSaveConfig')), true);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
