// Unit tests for "one email thread per customer, no wait":
//   - every email about a customer shares one subject and points back at the
//     first one (In-Reply-To/References), so Gmail keeps them as one thread;
//   - each email draws the recent conversation as chat bubbles;
//   - an email answer is sent on the spot (flushThreadDue with an `extra` item),
//     never left in the stored queue for the cron to send a second time;
//   - "cancel" only when the whole reply is the word, and phone-app signatures
//     ("Sent from my iPhone") don't stop a YES being a YES.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name, like the other mail suites.
//
//   node test/emailthread.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  let p = SRC.indexOf('(', SRC.indexOf(`function ${name}(`, start)), pd = 0, bodyStart = -1;
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
  const m = SRC.match(new RegExp(`^const ${name} = ([\\s\\S]*?);\\n`, 'm'));
  if (!m) throw new Error(`const ${name} not found in src/index.js`);
  return `const ${name} = ${m[1]};`;
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// --- the world the lifted code runs in -------------------------------------
const W = { kv: {}, kvWrites: 0, fetches: [], sms: [], receipts: [], saves: 0, failSms: false };
const S = {
  ENV: { ALERT_EMAIL: 'mikey@example.com', ALERT_FROM: 'Mikeys Dashboard <alerts@example.com>', RESEND_API_KEY: 're_test', TWILIO_FROM: '+13605550000' },
  publicBase: () => 'https://dash.example.com',
  kv: () => ({
    get: async (k) => (k in W.kv ? JSON.parse(W.kv[k]) : null),
    put: async (k, v) => { W.kv[k] = v; W.kvWrites++; },
  }),
  fetch: async (url, init = {}) => {
    W.fetches.push({ url, init });
    if (init.method === 'POST') return { ok: true, json: async () => ({ id: 'em_' + W.fetches.length }) };
    return { ok: true, json: async () => ({ message_id: '<root-123@example.com>' }) };
  },
  alertHtml: (s, t) => `<p>${t}</p>`,
  sendSms: async (to, body) => { if (W.failSms) throw new Error('Twilio 21610: unsubscribed'); W.sms.push({ to, body }); return { sid: 'SM1' }; },
  saveThread: async () => { W.saves++; },
  updateIndexEntry: async () => {},
  ownerSay: async () => {},
  notifyMikey: async () => true,
  genId: () => 'id' + Math.random().toString(36).slice(2, 8),
  voiceUsable: () => true,
  maybePromise: async () => {},
  askedBefore: () => '',
  assistReceipt: async (thread, r) => { W.receipts.push(r); },
};
const NAMES = [
  'htmlEsc', 'mailLines', 'mailCard', 'mailLabel', 'mailShell', 'mailShout', 'mailBtn', 'emailAddr', 'normalizePhone',
  'mailChatWhen', 'mailChatMsgs', 'mailChatBody', 'mailChatHtml', 'mailChatText',
  'customerMailSubject', 'resendMessageId', 'customerMail', 'sendEmail', 'flushThreadDue',
  'assistStripQuoted', 'assistAlertBody', 'assistAlertHtml', 'assistAskBlock', 'assistMailto',
];
const ctx = {};
// eslint-disable-next-line no-new-func
new Function('ctx', 'S',
  'const {ENV,publicBase,kv,fetch,alertHtml,sendSms,saveThread,updateIndexEntry,ownerSay,notifyMikey,genId,voiceUsable,maybePromise,askedBefore,assistReceipt} = S;' +
  NAMES.map(lift).join('\n') + '\n' +
  ['ASSIST_CUT', 'ASSIST_ATTRIB', 'MAILC', 'MAILF', 'ASSIST_YES', 'ASSIST_NO', 'ASSIST_CANCEL', 'MAIL_CHAT_TURNS', 'MAIL_THREAD_PREFIX'].map(liftConst).join('\n') + '\n' +
  'ctx.ASSIST_YES = ASSIST_YES; ctx.ASSIST_CANCEL = ASSIST_CANCEL; ctx.ASSIST_CUT = ASSIST_CUT;' +
  NAMES.map((n) => `ctx.${n} = ${n};`).join(''),
)(ctx, S);

const PHONE = '+13605551234';
const T0 = Date.UTC(2026, 10, 20, 18, 0);   // a Friday, 10:00 in Seattle
const thread = (over = {}) => Object.assign({
  phone: PHONE, name: 'Ruth', scheduled: [],
  messages: [
    { dir: 'in', body: 'How much for a full detail on my 4Runner?', ts: T0 },
    { dir: 'out', body: 'Full detail is $375 <tax incl>', ts: T0 + 60e3 },
    { dir: 'in', body: 'Could you do Thursday?', ts: T0 + 120e3 },
  ],
}, over);

// --- 1. cancel / signatures ------------------------------------------------
console.log('\n=== "cancel" only when that is the whole reply ===');
for (const w of ['cancel', 'Cancel.', 'wait', 'undo!', 'never mind', 'nvm']) check(`"${w}" cancels`, ctx.ASSIST_CANCEL.test(w.toLowerCase()), true);
for (const w of ['Wait, is it the white truck?', 'Cancel is fine, we can rebook', 'undo the wax, just the interior']) {
  check(`"${w}" goes to the customer, not cancel`, ctx.ASSIST_CANCEL.test(w.toLowerCase()), false);
}

console.log('\n=== a YES from a phone mail app is still a YES ===');
const strip = ctx.assistStripQuoted;
check('iPhone signature removed', strip('yes\n\nSent from my iPhone'), 'yes');
check('…and it reads as a bare YES', ctx.ASSIST_YES.test(strip('yes\n\nSent from my iPhone').toLowerCase()), true);
check('Outlook signature removed', strip('375, thursday works\n\nGet Outlook for Android'), '375, thursday works');
check('Samsung signature removed', strip('on my way\n\nSent from my Galaxy'), 'on my way');
check('signature above the quoted alert removed too', strip(`ok\n\nSent from my iPhone\n\nOn Thu, Nov 19, 2026 Ruth wrote:\n> ${ctx.ASSIST_CUT}`), 'ok');
check('words that merely mention a phone stay', strip('I sent from my phone earlier, check it'), 'I sent from my phone earlier, check it');

// --- 2. one thread per customer -------------------------------------------
console.log('\n=== every email about one customer shares a subject ===');
const subj = ctx.customerMailSubject;
check('named customer', subj(thread()), '💬 Ruth (…1234)');
check('same customer, same subject, whatever the message', subj(thread({ messages: [] })), subj(thread()));
check('two customers called Ruth stay apart', subj(thread()) !== subj(thread({ phone: '+13605559999' })), true);
check('no name yet → the number', subj(thread({ name: '' })), '💬 (360) 555-1234');

console.log('\n=== the first email starts the thread, later ones point back at it ===');
W.kv = {}; W.kvWrites = 0; W.fetches = [];
let cm = await ctx.customerMail(thread());
check('first email: no reply headers yet', cm.mail.headers, {});
check('sender shows the customer', cm.mail.fromName, 'Ruth · Texts');
await cm.mail.onSent({ id: 'em_first' });
check('looks up the Message-ID Resend gave it', W.fetches.some((f) => /\/emails\/em_first$/.test(f.url)), true);
check('…and remembers it', JSON.parse(W.kv['mailthr:' + PHONE]).root, '<root-123@example.com>');
const writesAfterFirst = W.kvWrites;
cm = await ctx.customerMail(thread());
check('second email replies to the first', cm.mail.headers, { 'In-Reply-To': '<root-123@example.com>', References: '<root-123@example.com>' });
await cm.mail.onSent({ id: 'em_second' });
check('…and costs no KV write once the thread is known', W.kvWrites, writesAfterFirst);
cm = await ctx.customerMail(thread({ name: 'Ruth Callahan' }));
check('a new name is a new subject, so a fresh thread (no stale headers)', cm.mail.headers, {});

console.log('\n=== sendEmail carries the threading ===');
W.fetches = [];
await ctx.sendEmail('💬 Ruth (…1234)', 'hi', '<p>hi</p>', null, { headers: { 'In-Reply-To': '<a@b>' }, fromName: 'Ruth "R" <x> · Texts' });
const payload = JSON.parse(W.fetches[0].init.body);
check('headers ride along', payload.headers, { 'In-Reply-To': '<a@b>' });
check('display name changes, the verified address does not', payload.from, '"Ruth R x · Texts" <alerts@example.com>');
W.fetches = [];
await ctx.sendEmail('Weekly recap', 'hi', '<p>hi</p>');
const plain = JSON.parse(W.fetches[0].init.body);
check('other alerts are untouched', [plain.from, 'headers' in plain], ['Mikeys Dashboard <alerts@example.com>', false]);

// --- 3. the conversation as bubbles ---------------------------------------
console.log('\n=== the email shows the conversation, both sides ===');
const html = ctx.mailChatHtml(thread(), { tz: 'America/Los_Angeles' });
check('their messages on the left, his on the right', [html.split('align="left"').length - 1, html.split('align="right"').length - 1], [2, 1]);
check('newest message is last', html.lastIndexOf('Could you do Thursday?') > html.lastIndexOf('Full detail is'), true);
check('newest message reads a size up', /font:600 17px[^>]*>Could you do Thursday\?/.test(html), true);
check('message text is escaped', html.includes('&lt;tax incl&gt;') && !html.includes('<tax incl>'), true);
check('says who and when', html.includes('Ruth · Fri 10:00 AM') && html.includes('You · Fri 10:01 AM'), true);
const failed = ctx.mailChatHtml(thread({ messages: [{ dir: 'out', body: 'See you Thursday', ts: T0, error: 'Twilio 21610' }] }), {});
check('a text that failed says so', failed.includes('NOT DELIVERED'), true);
const many = { phone: PHONE, messages: Array.from({ length: 20 }, (_, i) => ({ dir: i % 2 ? 'out' : 'in', body: 'm' + i, ts: T0 + i })) };
check(`only the last ${8} messages`, ctx.mailChatMsgs(many).map((m) => m.body), ['m12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19']);
const pic = ctx.mailChatHtml({ phone: PHONE, messages: [{ dir: 'in', body: '', media: [{ url: 'x' }, { url: 'y' }], ts: T0 }] }, {});
check('a photo shows as a photo, not an empty bubble', pic.includes('📷 2 photos'), true);
check('plain-text version reads in order', ctx.mailChatText(thread(), {}).split('\n').map((l) => l.split(' (')[0]), ['Ruth', 'You', 'Ruth']);

console.log('\n=== the alert itself ===');
const alert = ctx.assistAlertBody({}, { phone: PHONE, who: 'Ruth', msg: 'Could you do Thursday?', draft: 'Thursday works!', thread: thread() });
check('cut marker sits above the conversation', alert.html.indexOf(ctx.ASSIST_CUT) > -1 && alert.html.indexOf(ctx.ASSIST_CUT) < alert.html.indexOf('How much for a full detail'), true);
check('the conversation is in it', alert.html.includes('How much for a full detail'), true);
check('the routing ref still survives', alert.html.includes(`[ref:${PHONE}]`) && alert.text.includes(`[ref:${PHONE}]`), true);
check('plain text carries the conversation', alert.text.includes('Conversation with Ruth (newest last):'), true);
const old = ctx.assistAlertBody({}, { phone: PHONE, who: 'Ruth', msg: 'Could you do Thursday?' });
check('without a thread it falls back to the single quote', old.text.includes('Ruth texted:\n"Could you do Thursday?"'), true);

// --- 4. sent on the spot ----------------------------------------------------
console.log('\n=== an email answer goes out immediately, exactly once ===');
W.sms = []; W.receipts = [];
const th = thread();
const item = { id: 'a1', kind: 'assist', at: Date.now(), body: 'Thursday works, see you at 9!', sendAt: Date.now(), receipt: 'email' };
const learn = [];
const n = await ctx.flushThreadDue(th, Date.now(), { learn, alertOn: true }, [item]);
check('sent', n, 1);
check('the customer got his words', W.sms.map((x) => x.body), ['Thursday works, see you at 9!']);
check('never written to the stored queue (so the cron cannot send it again)', th.scheduled, []);
check('it is in the conversation', th.messages[th.messages.length - 1].body, 'Thursday works, see you at 9!');
check('one receipt email, saying it went', W.receipts, [{ ok: true, body: 'Thursday works, see you at 9!' }]);
W.failSms = true; W.receipts = [];
const th2 = thread();
await ctx.flushThreadDue(th2, Date.now(), { learn: [], alertOn: true }, [Object.assign({}, item, { id: 'a2' })]);
check('a failed send still tells him, with the reason', W.receipts.map((r) => [r.ok, /21610/.test(r.err)]), [[false, true]]);
check('…and the conversation marks it', !!th2.messages[th2.messages.length - 1].error, true);
W.failSms = false;
const queued = thread({ scheduled: [{ id: 'later', body: 'reminder', sendAt: Date.now() + 3600e3 }] });
await ctx.flushThreadDue(queued, Date.now(), { learn: [], alertOn: true }, [Object.assign({}, item, { id: 'a3' })]);
check('a later scheduled text is left alone', queued.scheduled.map((s) => s.id), ['later']);

console.log('\n=== the hold setting ===');
check('email answers default to no hold', /assistEmailHoldSec: 0,/.test(SRC), true);
check('the old 180s key is no longer read', /cfg\.assistEmailDelaySec/.test(SRC), false);

console.log(`\n${FAIL ? '✗' : '✓'} ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
