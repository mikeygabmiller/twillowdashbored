// "Answer by email" — the loop that turns a reply to an alert into a text to a
// customer, end to end: the Gmail script that watches his sent mail, the sender
// matching that decides a reply is his, and the two gates that stand between an
// AI-worded sentence and a real person's phone.
//
// This suite exists because every one of those failed silently. The Gmail script
// aborted the run and logged a line nobody reads; a dead token was recorded as a
// successful send; a half-killed execution re-sent answers that had already gone;
// installing it answered two days of backlog at once. None of that shows up in a
// screenshot, and none of it throws — it just quietly stops answering customers,
// or answers the wrong one.
//
// The Gmail script is a string built by the Worker, so it's generated, evaluated
// against a fake Google, and driven for real. The Worker helpers are module-
// private, so they're lifted out by name the same way alertmail.test.js does it.
//
//   node test/assistmail.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
  const m = SRC.match(new RegExp(`^const ${name} = ([\\s\\S]*?);\\n`, 'm'));
  if (!m) throw new Error(`const ${name} not found in src/index.js`);
  return `const ${name} = ${m[1]};`;
}

const ctx = {};
const NAMES = [
  'assistAppsScript', 'emailAddr', 'emailKey', 'assistOwnerKeys', 'assistIsOwnerReply',
  'assistRefPhone', 'assistStripQuoted', 'normalizePhone',
  'assistOutboundBlocked', 'assistFactDrift', 'assistDraftStale', 'humanAgo',
];
// eslint-disable-next-line no-new-func
new Function('ctx', 'ENV',
  NAMES.map(lift).join('\n') + '\n' +
  ['ASSIST_CUT', 'ASSIST_DAYS', 'ASSIST_DRAFT_MAX_AGE_MS'].map(liftConst).join('\n') + '\n' +
  'ctx.ASSIST_CUT = ASSIST_CUT; ctx.ASSIST_DRAFT_MAX_AGE_MS = ASSIST_DRAFT_MAX_AGE_MS;' +
  NAMES.map((n) => `ctx.${n} = ${n};`).join(''),
)(ctx, { ALERT_EMAIL: 'Mikey <mikey@gmail.com>' });

const {
  ASSIST_CUT, ASSIST_DRAFT_MAX_AGE_MS, assistAppsScript, emailKey, assistIsOwnerReply,
  assistOutboundBlocked, assistFactDrift, assistDraftStale,
} = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const truthy = (name, got) => check(name, !!got, true);
const falsy = (name, got) => check(name, !!got, false);

// ===========================================================================
// A fake Google, just real enough to drive the script for real
// ===========================================================================
const DASH = 'https://dash.example.com/email-in';
const TOKEN = 'ek_test_token';
const ALERT_FROM = 'alerts@resend.dev';
const ME = 'mikey@gmail.com';

function msg(o) {
  return {
    getId: () => o.id,
    getFrom: () => o.from,
    getSubject: () => o.subject || 'Re: your customer',
    getPlainBody: () => o.body || '',
    getDate: () => new Date(o.at),
  };
}
const alertMsg = (id, at, phone) => msg({
  id, at, from: `Mikeys Dashboard <${ALERT_FROM}>`,
  body: `${ASSIST_CUT}\nRuth texted\n"how much for the truck"\n\n[ref:${phone}]`,
});
const replyMsg = (id, at, text, phone, from) => msg({
  id, at, from: from || `Mikey <${ME}>`,
  body: `${text}\n\nOn Tue, Mikey's Dashboard wrote:\n> ${ASSIST_CUT}\n> Ruth texted\n> [ref:${phone}]`,
});

// One harness = one Google account + one dashboard. Returns the globals object
// the generated script runs against, plus everything the test wants to inspect.
function makeGoogle({ threads = [], props = {}, respond } = {}) {
  const posts = [];
  const log = [];
  const store = Object.assign({}, props);
  let locked = false;
  const G = {
    posts, log, store,
    aliases: [],
    activeEmail: ME,
    effectiveEmail: ME,
    threads,
    lockHeld: false,
    triggers: [],
    Logger: { log: (s) => log.push(String(s)) },
    Session: {
      getActiveUser: () => ({ getEmail: () => G.activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => G.effectiveEmail }),
    },
    GmailApp: {
      searches: [],
      search(q) { G.GmailApp.searches.push(q); return G.threads; },
      getAliases: () => G.aliases,
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in store ? store[k] : null),
        setProperty: (k, v) => { store[k] = String(v); },
        deleteProperty: (k) => { delete store[k]; },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (G.lockHeld ? false : (locked = true)),
        releaseLock: () => { locked = false; },
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => G.triggers,
      deleteTrigger: (t) => { G.triggers = G.triggers.filter((x) => x !== t); },
      newTrigger: (fn) => ({
        timeBased: () => ({ everyMinutes: (n) => ({ create: () => G.triggers.push({ getHandlerFunction: () => fn, every: n }) }) }),
      }),
    },
    UrlFetchApp: {
      fetch(url, opts) {
        const payload = JSON.parse(opts.payload);
        posts.push({ url, payload, headers: opts.headers });
        const r = (respond || (() => ({ code: 200, text: '{"ok":true}' })))(payload, posts.length);
        return { getResponseCode: () => r.code, getContentText: () => r.text };
      },
    },
  };
  return G;
}

// Evaluate the generated script inside the fake Google and hand back its funcs.
function loadScript(G) {
  const code = assistAppsScript(DASH, TOKEN, ALERT_FROM);
  const names = ['Logger', 'Session', 'GmailApp', 'PropertiesService', 'LockService', 'ScriptApp', 'UrlFetchApp'];
  // eslint-disable-next-line no-new-func
  return new Function(...names, code + '\nreturn { mikeyAssistSync, mikeyAssistSetUp, mikeyAssistCheck, mikeyAssistReset };')(
    ...names.map((n) => G[n]),
  );
}
const mailPosts = (G) => G.posts.filter((p) => !p.payload.ping);
const pings = (G) => G.posts.filter((p) => p.payload.ping);

const T0 = Date.now();
const past = (mins) => T0 - mins * 60000;

console.log('\n=== the script is real JavaScript ===');
const generated = assistAppsScript(DASH, TOKEN, ALERT_FROM);
truthy('it parses', (() => { try { new Function(generated); return true; } catch { return false; } })());
truthy('the dashboard URL is baked in', generated.includes(JSON.stringify(DASH)));
truthy('the token is baked in', generated.includes(JSON.stringify(TOKEN)));
truthy('the alert sender is baked in, so a reply can be told from the alert', generated.includes(JSON.stringify(ALERT_FROM)));
truthy('it installs its own trigger — no hand-added clock to forget', /everyMinutes\(1\)/.test(generated));
truthy('there is a plain-English self-check to run when it goes quiet', generated.includes('function mikeyAssistCheck'));

console.log('\n=== installing it does not answer two days of backlog ===');
// The one that could actually text customers: a fresh install used to find every
// reply in the lookback window and send them all at once.
{
  const G = makeGoogle({ threads: [{ getMessages: () => [alertMsg('a1', past(200), '+13605551234'), replyMsg('r1', past(190), '375, thursday', '+13605551234')] }] });
  const S = loadScript(G);
  S.mikeyAssistSetUp();
  check('setting it up sends nothing', mailPosts(G).length, 0);
  S.mikeyAssistSync();
  check('and neither does the first run after it', mailPosts(G).length, 0);
  truthy('a starting line was drawn', Number(G.store.since) > 0);
  check('the trigger is installed exactly once', G.triggers.length, 1);
  S.mikeyAssistSetUp();
  check('running setup twice does not leave two triggers', G.triggers.length, 1);
}

console.log('\n=== a reply he sends now does get answered, exactly once ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), replyMsg('r1', past(5), '375, thursday works', '+13605551234')] }];
  S.mikeyAssistSync();
  check('it goes to the dashboard', mailPosts(G).length, 1);
  check('with his words', mailPosts(G)[0].payload.body.split('\n')[0], '375, thursday works');
  check('and the ingest token', mailPosts(G)[0].headers['X-Ingest-Token'], TOKEN);
  S.mikeyAssistSync();
  S.mikeyAssistSync();
  check('running again does not send it a second time', mailPosts(G).length, 1);
}

console.log('\n=== the alert itself is never mistaken for his answer ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234')] }];
  S.mikeyAssistSync();
  check('nothing posted', mailPosts(G).length, 0);
}
{
  // The nastiest version: Google refuses to say who we are (it does this inside
  // triggers) — which used to abort the whole run and kill the feature dead.
  const G = makeGoogle({ props: { since: String(past(60)) } });
  G.activeEmail = ''; G.effectiveEmail = '';
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), replyMsg('r1', past(5), 'yes', '+13605551234')] }];
  S.mikeyAssistSync();
  check('his reply still gets through', mailPosts(G).length, 1);
  check('and the alert still does not', mailPosts(G).filter((p) => p.payload.messageId === 'a1').length, 0);
}
{
  // Gmail sends from whichever send-as alias the thread was addressed to.
  const G = makeGoogle({ props: { since: String(past(60)) } });
  G.aliases = ['mikey@mikeysdetailing.com'];
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), replyMsg('r1', past(5), 'yes', '+13605551234', 'Mikey <mikey@mikeysdetailing.com>')] }];
  S.mikeyAssistSync();
  check('an alias counts as him', mailPosts(G).length, 1);
}

console.log('\n=== a dead token loses nothing ===');
{
  // The old script treated any HTTP response as success: a 401 marked the reply
  // handled and it was gone forever. He'd have no idea the customer never heard.
  let code = 401;
  const G = makeGoogle({ props: { since: String(past(60)) }, respond: () => ({ code, text: '{"error":"unauthorized"}' }) });
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), replyMsg('r1', past(5), '375', '+13605551234')] }];
  S.mikeyAssistSync();
  check('it tried', mailPosts(G).length, 1);
  falsy('and did NOT record it as handled', (JSON.parse(G.store.seen || '{}')).r1);
  code = 200;
  S.mikeyAssistSync();
  check('so the next run sends it for real', mailPosts(G).length, 2);
  truthy('and only then is it handled', (JSON.parse(G.store.seen || '{}')).r1);
  truthy('the failure was reported to the dashboard', pings(G).some((p) => /401/.test(String(p.payload.error || ''))));
}

console.log('\n=== a run that dies halfway does not re-text anyone ===');
{
  // Apps Script kills long executions. The old code saved the handled list once,
  // at the end, so everything already sent went out again on the next run.
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  // Kill the execution partway through, the way Google does when a run runs long:
  // the first answer has gone out, the second message blows up before the end of
  // the loop is ever reached.
  let boom = true;
  G.threads = [{ getMessages: () => [
    alertMsg('a1', past(10), '+13605551234'),
    replyMsg('r1', past(5), '375', '+13605551234'),
    Object.assign(replyMsg('r2', past(4), 'and saturday', '+13605551234'), {
      getPlainBody: () => { if (boom) throw new Error('execution killed'); return 'and saturday\n\n> [ref:+13605551234]'; },
    }),
  ] }];
  try { S.mikeyAssistSync(); } catch { /* exactly what Apps Script does to a long run */ }
  boom = false;
  check('the first answer is already recorded', Object.keys(JSON.parse(G.store.seen || '{}')).includes('r1'), true);
  S.mikeyAssistSync();
  check('so the retry only sends the one that never went', mailPosts(G).filter((p) => p.payload.messageId === 'r1').length, 1);
  check('and the second one does go', mailPosts(G).filter((p) => p.payload.messageId === 'r2').length, 1);
}

console.log('\n=== two overlapping runs cannot double-send ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), replyMsg('r1', past(5), '375', '+13605551234')] }];
  G.lockHeld = true;
  S.mikeyAssistSync();
  check('a run that cannot get the lock does nothing at all', G.posts.length, 0);
  G.lockHeld = false;
  S.mikeyAssistSync();
  check('and the one holding it does the work', mailPosts(G).length, 1);
}

console.log('\n=== the routing line is found even when his client drops the quote ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  const bare = msg({ id: 'r1', at: past(5), from: `Mikey <${ME}>`, body: 'yes' });
  G.threads = [{ getMessages: () => [alertMsg('a1', past(10), '+13605551234'), bare] }];
  S.mikeyAssistSync();
  check('it still goes out', mailPosts(G).length, 1);
  check('carrying the ref read off the alert in the same thread', mailPosts(G)[0].payload.ref, '+13605551234');
}

console.log('\n=== it only reads what it has to ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  S.mikeyAssistSync();
  const q = G.GmailApp.searches[0];
  truthy('sent mail only', q.includes('in:sent'));
  truthy('only threads carrying a routing line', q.includes('"[ref:"'));
  truthy('never a half-typed draft', q.includes('-in:drafts'));
}

console.log('\n=== it says whether it is alive, without shouting every minute ===');
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  S.mikeyAssistSync();
  check('a quiet run checks in once', pings(G).length, 1);
  S.mikeyAssistSync(); S.mikeyAssistSync(); S.mikeyAssistSync();
  check('and then stays quiet', pings(G).length, 1);
  truthy('the check-in is authenticated like everything else', pings(G)[0].headers['X-Ingest-Token'] === TOKEN);
}
{
  const G = makeGoogle({ props: { since: String(past(60)) } });
  const S = loadScript(G);
  const out = String(S.mikeyAssistCheck());
  truthy('the self-check names the trigger', /Trigger:/.test(out));
  truthy('…whether Gmail will let it read', /Alert replies in your sent mail|CANNOT READ/.test(out));
  truthy('…and whether the dashboard answered', /Dashboard answered/.test(out));
}
{
  const G = makeGoogle({ props: { since: String(past(600)), seen: '{"old":1}' } });
  const S = loadScript(G);
  S.mikeyAssistReset();
  truthy('reset draws a new starting line', Number(G.store.since) > past(1));
  falsy('and forgets the old handled list', G.store.seen);
}

// ===========================================================================
// The Worker side
// ===========================================================================
console.log('\n=== his address is his address, however Gmail writes it ===');
check('a bare address', emailKey('Mikey <MIKEY@Gmail.com>'), 'mikey@gmail.com');
check('gmail ignores dots', emailKey('m.i.k.e.y@gmail.com'), 'mikey@gmail.com');
check('and everything after a plus', emailKey('mikey+dash@gmail.com'), 'mikey@gmail.com');
check('googlemail is gmail', emailKey('mikey@googlemail.com'), 'mikey@gmail.com');
check('other domains keep their dots', emailKey('m.ikey@mikeysdetailing.com'), 'm.ikey@mikeysdetailing.com');

const REF = '+13605551234';
const body = (t) => `${t}\n\nOn Tue wrote:\n> [ref:${REF}]`;
console.log('\n=== who is allowed to answer an alert ===');
check('himself', assistIsOwnerReply({}, { from: 'Mikey <mikey@gmail.com>', body: body('375') }), REF);
check('himself, dotted and plus-tagged', assistIsOwnerReply({}, { from: 'm.ikey+alerts@gmail.com', body: body('375') }), REF);
check('a send-as alias he added', assistIsOwnerReply({ assistFrom: ['mikey@mikeysdetailing.com'] }, { from: 'mikey@mikeysdetailing.com', body: body('375') }), REF);
check('not a customer, even one quoting the routing line', assistIsOwnerReply({}, { from: 'ruth@example.com', body: body('375') }), '');
check('not him, with the feature switched off', assistIsOwnerReply({ assistEmail: false }, { from: 'mikey@gmail.com', body: body('375') }), '');
check('a reply with no routing line falls back to the one the script found', assistIsOwnerReply({}, { from: 'mikey@gmail.com', body: 'yes' }, '3605551234'), REF);
check('but a stranger cannot use that fallback either', assistIsOwnerReply({}, { from: 'ruth@example.com', body: 'yes' }, '3605551234'), '');

console.log('\n=== plumbing never reaches a customer ===');
check('the cut marker', !!assistOutboundBlocked(`sure thing\n${ASSIST_CUT}\nRuth texted`), true);
check('the routing line', !!assistOutboundBlocked('sure thing [ref:+13605551234]'), true);
check('a quoted alert that survived the strip', !!assistOutboundBlocked('yes\n> Ruth texted\n> how much'), true);
check('an "On … wrote:" header', !!assistOutboundBlocked('yes\nOn Tuesday, Mikeys Dashboard wrote:'), true);
check('a whole email pasted in', !!assistOutboundBlocked('From: alerts@resend.dev\nSubject: hi'), true);
check('something far too long for a text', !!assistOutboundBlocked('x'.repeat(901)), true);
check('an ordinary reply goes through', assistOutboundBlocked("Yeah I can do Thursday morning, $375 for the truck."), '');

console.log('\n=== it cannot quote a price he never gave ===');
const thread = { messages: [{ dir: 'in', body: 'How much for a full detail on my 2019 4Runner?', ts: T0 - 60000 }] };
check('a price he typed is fine', assistFactDrift('Yeah, $375 for the 4Runner.', '375, thursday', thread), '');
check('a price the customer named is fine', assistFactDrift('Yeah, 2019 is no problem.', 'sounds good', thread), '');
truthy('a price out of nowhere is not', assistFactDrift('Full detail runs $425 for that one.', 'sounds good', thread));
truthy('…and it says which number', /425/.test(assistFactDrift('Full detail runs $425 for that one.', 'sounds good', thread)));
check('a day he named is fine', assistFactDrift('Thursday works, see you then.', 'thursday works', thread), '');
truthy('a day it made up is not', assistFactDrift('Saturday works, see you then.', 'thursday works', thread));
truthy('a leftover template blank is caught', assistFactDrift('Hi [name], see you then.', 'thursday', thread));
check('times are not treated as money', assistFactDrift('See you at 9am.', 'thursday 9am', thread), '');
check('and the check can be switched off in config, not hardcoded', /cfg\.assistFactCheck !== false/.test(SRC), true);

console.log('\n=== "yes" never answers the wrong message ===');
const draftAt = T0 - 5 * 60000;
const withDraft = (msgs) => ({ name: 'Ruth', phone: REF, suggested: { text: 'Thursday works', ts: draftAt, forTs: draftAt }, messages: msgs });
check('a fresh draft sends', assistDraftStale(withDraft([{ dir: 'in', body: 'when can you do it', ts: draftAt }])), '');
truthy('but not once she has texted again',
  assistDraftStale(withDraft([{ dir: 'in', body: 'when can you do it', ts: draftAt }, { dir: 'in', body: 'actually never mind', ts: T0 - 60000 }])));
truthy('…and it shows him what she said',
  /never mind/.test(assistDraftStale(withDraft([{ dir: 'in', body: 'q', ts: draftAt }, { dir: 'in', body: 'actually never mind', ts: T0 - 60000 }]))));
truthy('not once he has already answered her himself',
  assistDraftStale(withDraft([{ dir: 'in', body: 'q', ts: draftAt }, { dir: 'out', body: 'thursday works', ts: T0 - 60000 }])));
truthy('and not a draft that has been sitting all day', assistDraftStale({
  name: 'Ruth', phone: REF, messages: [{ dir: 'in', body: 'q', ts: T0 - ASSIST_DRAFT_MAX_AGE_MS - 60000 }],
  suggested: { text: 'x', ts: T0 - ASSIST_DRAFT_MAX_AGE_MS - 60000, forTs: T0 - ASSIST_DRAFT_MAX_AGE_MS - 60000 },
}));

console.log('\n=== the silences are gone ===');
truthy('a reply with no readable words gets told so', /couldn't find any words in it/.test(SRC));
truthy('a reply older than the age limit is never acted on', /ASSIST_MAX_AGE_MS/.test(SRC));
truthy('a routing line from an unknown address is remembered, not dropped', /strangerFrom/.test(SRC));
truthy('the dashboard records when the Gmail script last checked in', /pingAt/.test(SRC));

console.log(`\n${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
