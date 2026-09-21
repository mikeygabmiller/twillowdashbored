// The AI self test: the one surface that says WHY the AI isn't working.
//
// It exists because every other surface lies by omission. A draft that fails on
// Claude falls back to Gemini, and if Gemini fails too the error that reaches
// the screen is GEMINI's — so a dead Anthropic key reads as a Google problem.
// The usage counters are no better: a failed call is a number, not a reason.
// That combination cost a full day of a broken AI with nothing to point at.
//
// Two things are pinned here. Every route gets reported, pass or fail, with the
// provider's own words; and no credential ever reaches the output, because this
// is the one screen built to be screenshotted and pasted to somebody for help.
//
//   node test/selftest.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  const p = SRC.indexOf('(', start);
  let pd = 0, bodyStart = -1;
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

let PASS = 0, FAIL = 0;
const ok = (n, c, x) => { if (c) { PASS++; console.log('  ✓', n); } else { FAIL++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

// Build the endpoint with both providers stubbed, so a test can decide exactly
// which route fails and check what comes back out.
function build({ routes, claude, gemini, env }) {
  const mod = new Function('ENV', 'claudeRoutes', 'claudeModel', 'claudeAttempt', 'geminiGenerate', 'json',
    `${lift('apiAiSelfTest')}\n${lift('scrubKeys')}\nreturn { apiAiSelfTest, scrubKeys };`,
  )(
    env || { GEMINI_API_KEY: 'g-test' },
    () => routes,
    (route) => (route === 'binding' ? 'anthropic/claude-haiku-4.5' : 'claude-haiku-4-5'),
    claude,
    gemini,
    (o) => o,
  );
  return mod;
}

const okClaude = async () => 'ok';
const okGemini = async () => 'ok';

section('Both routes working');
let m = build({ routes: ['key', 'binding'], claude: okClaude, gemini: okGemini });
let r = await m.apiAiSelfTest();
ok('every route is reported, not just the first', r.routes.length === 2, r.routes.map((x) => x.route));
ok('and each says which model it used', r.routes.every((x) => x.ok && x.model), r.routes);
ok('the backup is checked too', r.gemini.ok === true, r.gemini);

section('The case this was built for: the key is dead and Gemini is dead');
// The real failure of 2026-09-20. Before this endpoint, the only thing on screen
// was Gemini's 403, and the Anthropic error — the one that actually mattered —
// was written to a log nobody could reach.
m = build({
  routes: ['key'],
  claude: async () => { throw new Error('Anthropic 401: {"error":{"message":"invalid x-api-key"}}'); },
  gemini: async () => { throw new Error('Gemini 403: PERMISSION_DENIED'); },
});
r = await m.apiAiSelfTest();
ok('the Anthropic error survives instead of being swallowed',
  /401/.test(r.routes[0].error) && r.routes[0].ok === false, r.routes[0]);
ok('and Gemini is reported separately, as the backup it is',
  r.gemini.ok === false && /403/.test(r.gemini.error), r.gemini);

section('One route up, one down — the whole point of listing both');
m = build({
  routes: ['key', 'binding'],
  claude: async (route) => { if (route === 'binding') throw new Error('AI binding: no credits'); return 'ok'; },
  gemini: okGemini,
});
r = await m.apiAiSelfTest();
ok('the working one is marked working', r.routes[0].ok === true, r.routes[0]);
ok('the broken one is marked broken, with its reason', r.routes[1].ok === false && /credits/.test(r.routes[1].error), r.routes[1]);

section('Nothing set up at all');
m = build({ routes: [], claude: okClaude, gemini: okGemini, env: {} });
r = await m.apiAiSelfTest();
ok('says so in words rather than showing an empty list', /No Claude route/.test(r.note || ''), r.note);
ok('and names the missing Gemini key too', r.gemini.ok === false && /GEMINI_API_KEY/.test(r.gemini.error), r.gemini);

section('No credential ever reaches the screen');
// This screen is built to be screenshotted and pasted to somebody for help, and
// providers do echo the credential back inside their own error text.
m = build({
  routes: ['key'],
  claude: async () => { throw new Error('Anthropic 401: invalid x-api-key sk-ant-api03-REALSECRETVALUE1234'); },
  gemini: async () => { throw new Error('Gemini 403 https://x/v1beta?key=AIzaSyREALSECRET123 denied'); },
});
r = await m.apiAiSelfTest();
ok('an Anthropic key echoed back in an error is hidden',
  r.routes[0].error.indexOf('REALSECRET') < 0 && /sk-ant-\[hidden\]/.test(r.routes[0].error), r.routes[0].error);
ok('and a Google key in a URL is hidden',
  r.gemini.error.indexOf('AIzaSyREALSECRET') < 0, r.gemini.error);
ok('the rest of the message is left intact, or it would be useless',
  /401/.test(r.routes[0].error) && /403/.test(r.gemini.error));

console.log(`\n${FAIL ? '✗' : '✓'} selftest — ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
