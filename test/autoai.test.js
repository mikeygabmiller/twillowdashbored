// The switchboard: which AI is allowed to spend money without being asked.
//
// Every AI in this app is in one of two piles. One pile only runs because he
// pressed something, and a button he never presses costs nothing. The other
// pile runs on an inbound text or on the cron, while the phone is in his
// pocket, and that pile is the bill.
//
// This suite is about the second pile, and there is exactly one thing worth
// pinning: with a switch off, the surface makes NO call. Not a cheaper call, not
// a shorter prompt — zero. A default that quietly reverts costs real money every
// time a customer texts, and nothing on screen would say so.
//
// The second thing it pins is that off is not broken. Every one of these
// surfaces already had a no-API-key path, tested elsewhere; the switch routes
// into that same path, so off means the free answer rather than a hole. A gate
// that returned "" instead of falling back would pass a call-count test and
// still ruin the card, so the fallback's actual value is checked too.
//
//   node test/autoai.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const re = new RegExp(`(async )?function ${name}\\(`);
  const m = re.exec(SRC);
  if (!m) throw new Error(`function ${name} not found in src/index.js`);
  const start = m.index;
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

// Counted, not stubbed silently: the number of calls IS the assertion.
let CALLS = [];
const ctx = {
  ENV: { GEMINI_API_KEY: 'k' },
  AI_CLASSIFY_TURNS: 12,
  QUIET_TAPBACKS: new Set(['loved', 'liked']),
  geminiGenerate: async (prompt, opts) => { CALLS.push((opts || {}).surface || '?'); return 'a line about the conversation'; },
  transcript: () => 'them: how much?',
  businessContext: () => '',
  looksLikeQuestion: (b) => /\?\s*$/.test(String(b || '')),
  isClosingRemark: (b) => /^(thanks|thank you|ok|sounds good)\b/i.test(String(b || '').trim()),
  replyCheckFor: () => null,
  parseReaction: () => null,
  // The real one is its own prompt; what this suite cares about is only whether
  // ensureReplyCheck reaches for it at all.
  judgeReplyNeeded: async () => { CALLS.push('reply check'); return { needed: false, reason: 'They were just saying thanks' }; },
};

const NAMES = ['autoAiDefaults', 'autoAiCfg', 'autoAiOn', 'ensureRecap', 'ensureReplyCheck', 'recapFor'];
// eslint-disable-next-line no-new-func
new Function(...Object.keys(ctx), 'out',
  NAMES.map(lift).join('\n\n') + '\n' + NAMES.map((n) => `out.${n} = ${n};`).join('\n')
)(...Object.values(ctx), ctx);

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const section = (s) => console.log('\n=== ' + s + ' ===');

const T0 = 1_700_000_000_000;
const thread = () => ({ phone: '+14255551234', name: 'Dale', messages: [{ id: 'i1', dir: 'in', body: 'so is thursday still good', ts: T0 }] });
const reset = () => { CALLS = []; };

section('a config that has never heard of this screen spends nothing');
// This is the shape that matters most: his real config, saved for months, with
// no autoAi key in it at all. Defaults have to carry it, or shipping this does
// nothing for the person it was built for.
const STORED = { tz: 'America/Los_Angeles', followupsEnabled: true, detect: { enabled: true } };
check('every switch reads off', Object.values(ctx.autoAiCfg(STORED)).every((v) => v === false), true);
check('and there are seven of them', Object.keys(ctx.autoAiDefaults()).length, 7);
check('an unknown key is not suddenly on', ctx.autoAiOn(STORED, 'nonsense'), false);

section('recap: off makes no call, and leaves the card something to say');
reset();
let t = thread();
check('ensureRecap declines', await ctx.ensureRecap(t, STORED), false);
check('it called nothing at all', CALLS, []);
check('and wrote no recap onto the thread', t.recap, undefined);

section('recap: the button on the card still works while it is off');
reset();
t = thread();
check('asked directly, it runs', await ctx.ensureRecap(t, STORED, true), true);
check('one call, filed under recap', CALLS, ['recap']);
check('and the line landed', !!(t.recap && t.recap.text), true);

section('recap: on, the peek pays for itself again');
reset();
t = thread();
check('it runs unasked', await ctx.ensureRecap(t, Object.assign({}, STORED, { autoAi: { recap: true } })), true);
check('one call', CALLS.length, 1);

section('reply check: off falls back to the rule, not to nothing');
reset();
t = thread();
check('it still reaches a verdict', await ctx.ensureReplyCheck(t, STORED), true);
check('without calling the AI', CALLS, []);
check('the verdict came from a rule', t.replyCheck.via, 'rule');
check('and it says he is on the hook', t.replyCheck.needed, true);

section('reply check: on, it reads the conversation');
reset();
t = thread();
await ctx.ensureReplyCheck(t, Object.assign({}, STORED, { autoAi: { replyCheck: true } }));
check('the AI was asked', CALLS, ['reply check']);
check('and its ruling is what stuck', t.replyCheck.via, 'ai');
check('including the answer the rule would not have reached', t.replyCheck.needed, false);

section('a question is free either way — the rule catches it before any switch');
reset();
t = thread();
t.messages[0].body = 'how much for the truck?';
check('verdict reached', await ctx.ensureReplyCheck(t, Object.assign({}, STORED, { autoAi: { replyCheck: true } })), true);
check('no call was needed', CALLS, []);
check('by rule', t.replyCheck.via, 'rule');

console.log(`\n${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
