// "Saw the price, never left a number."
//
// This is the only alert in the app that fires for somebody who never became a
// customer, so the things worth pinning down are the ones that decide whether
// it's useful or just noise: it must not fire for a person who submitted, it
// must not fire while they're still on the page typing, it must fire exactly
// once, and the email has to say the price — "someone left" is not worth
// opening. The write budget matters too (a minute cron reads this every tick),
// so the no-op cases are asserted to cost nothing.
//
// Same lifting trick as journey.test.js: the functions are module-private in
// the Worker, so they're pulled out by name and run against a fake KV rather
// than exported purely for tests.
//
//   node test/quotewatch.test.js
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
const constant = (decl) => {
  const m = SRC.match(new RegExp(`^const ${decl}[^\\n]*$`, 'm'));
  if (!m) throw new Error(`const ${decl} not found`);
  return m[0];
};

// --- fake KV, counting every operation so "this costs nothing" is testable ---
const STORE = new Map();
let reads = 0, writes = 0;
const KV = {
  async get(k, opt) {
    reads++;
    const row = STORE.get(k);
    if (!row) return null;
    return (opt && opt.type === 'json') ? JSON.parse(row.value) : row.value;
  },
  async put(k, v, opt) { writes++; STORE.set(k, { value: v, metadata: (opt && opt.metadata) || null }); },
};

const SENT = [];
let CONFIG = {};
const ctx = {
  kv: () => KV,
  loadConfig: async () => CONFIG,
  notifyMikey: async (subject, body) => { SENT.push({ subject, body }); return true; },
  publicBase: () => 'https://texting.test',
  MAILC: { bg: '#eef1f5', card: '#fff', line: '#e2e8f0', ink: '#0f172a', mute: '#64748b',
    amber: '#f59e0b', amberBg: '#fffbeb', amberInk: '#92400e', blue: '#2563eb', blueBg: '#eff6ff' },
  MAILF: 'sans-serif',
  Response: class { constructor(b, i) { this.body = b; this.status = (i || {}).status; } },
};

const CODE = [
  constant('JOURNEY_TTL'), constant('JOURNEY_MAX_STEPS'),
  constant('journeyKey'), constant('journeyPhoneKey'), constant('PX_EVENT_KINDS'),
  constant('QUOTE_WATCH_KEY'), constant('QUOTE_WATCH_MAX'),
  constant('QUOTE_WATCH_GIVEUP_MS'), constant('QUOTE_WATCH_STALE_MS'),
  lift('cleanVid'), lift('journeyMeta'), lift('journeyHotLabel'),
  // The beacon stamps paid-vs-organic on the visitor as it lands — see
  // adsource.test.js for that feature; these are here because the handler
  // under test calls them.
  constant('AD_CLICK_IDS'), constant('AD_REF_HOSTS'), constant('AD_PAID_MEDIUM'), constant('AD_NAMES'),
  lift('refHostOf'), lift('adFromLanding'), lift('adLabel'), lift('visitorCity'), lift('stampJourneyInfo'),
  lift('blankJourney'), lift('appendStep'), lift('journeyLink'),
  lift('handlePixelEvents'), lift('pxOk'),
  lift('journeyPageTitle'), lift('journeyRefLabel'),
  lift('isQuoteRevealStep'), lift('quoteWatchWaitMs'), lift('quoteWatchPrice'),
  lift('loadQuoteWatch'), lift('saveQuoteWatch'), lift('armQuoteWatch'),
  lift('clearQuoteWatch'), lift('quoteAbandonCron'),
  lift('quoteAbandonSubject'), lift('quoteAbandonEmail'),
  lift('htmlEsc'), lift('mailLines'), lift('mailShell'), lift('mailCard'),
  lift('mailLabel'), lift('mailShout'), lift('mailBody'), lift('mailBtn'),
].join('\n\n');

const factory = new Function(...Object.keys(ctx), CODE + `
  return { handlePixelEvents, journeyLink, quoteAbandonCron, quoteAbandonEmail,
           quoteAbandonSubject, loadQuoteWatch, armQuoteWatch, clearQuoteWatch,
           isQuoteRevealStep, quoteWatchPrice, quoteWatchWaitMs, QUOTE_WATCH_MAX };`);
const Q = factory(...Object.values(ctx));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const min = 60000;
const reset = () => { STORE.clear(); SENT.length = 0; CONFIG = {}; reads = 0; writes = 0; };
// One beacon flush, exactly as site-stats.js sends it.
const beacon = (vid, page, events) =>
  Q.handlePixelEvents({ text: async () => JSON.stringify({ v: vid, p: page, e: events }) });
// What the quote form sends the moment the price lands on their screen — the
// priced event and the plain "reached step 4" one, in the same batch.
const sawQuote = (vid, t, money, what, page = '/') => beacon(vid, page, [
  { t, k: 'f', l: 'Saw their quote', d: '$' + money + ' · ' + what },
  { t, k: 'f', l: 'Quote form — step 4', d: 'Your estimate' },
]);
const watched = async () => (await Q.loadQuoteWatch()).list;

section('Someone sees a price, goes quiet, and you hear about it')
// The beacons land in real time (that's what the browser sends); the clock is
// moved forward by handing the cron a later `now`, the same way the minute cron
// arrives later than the visit did.
reset();
let T = Date.now();
await beacon('v1', '/', [{ t: T - min, k: 'v', l: 'Landed on the page', d: 'google.com' }]);
await sawQuote('v1', T, 420, 'Full-size truck · Full Detail');
ok('the price arms a watch', (await watched()).length === 1, await watched());
await Q.quoteAbandonCron(T + 30000);
ok('30 seconds later he is not told anything', SENT.length === 0, SENT);
await Q.quoteAbandonCron(T + 3 * min);
ok('two minutes of silence and the email goes out', SENT.length === 1, SENT.map((s) => s.subject));
ok('the subject leads with the money they walked away from', /\$420/.test(SENT[0].subject), SENT[0].subject);
ok('the watch is spent — he is never told twice', (await watched()).length === 0);
await Q.quoteAbandonCron(T + 8 * min);
ok('and the next tick says nothing more', SENT.length === 1);

section('The email is worth opening');
const body = SENT[0].body;
ok('it says what they picked', /Full Detail/.test(body.text), body.text);
ok('and the vehicle', /Full-size truck/.test(body.text), body.text);
ok('it says how they found the site', /Google/.test(body.text), body.text);
ok('it links straight to their replay', /\/\?journey=v1/.test(body.text), body.text);
ok('the HTML carries the price big', /\$420/.test(body.html));
ok('the text fallback fits a text message', body.sms.length < 160 && /\$420/.test(body.sms), body.sms);
ok('it says plainly there is nobody to text back', /nobody to text back/i.test(body.text), body.text);

section('Nobody who left their number gets reported as lost');
reset();
T = Date.now();
await sawQuote('v2', T, 299, 'Sedan · Interior Detail');
await Q.journeyLink('v2', '+14255550123', 'Sarah Reed');
ok('submitting drops the watch on the spot', (await watched()).length === 0);
await Q.quoteAbandonCron(T + 3 * min);
ok('so no email is sent', SENT.length === 0, SENT);

section('…even if the watch was somehow never cleared');
reset();
T = Date.now();
await sawQuote('v3', T, 260, 'SUV · Exterior Detail');
const doc3 = JSON.parse(STORE.get('journey:v3').value);
doc3.phone = '+14255550124';                      // a lead landed, the clear didn't
STORE.set('journey:v3', { value: JSON.stringify(doc3), metadata: null });
await Q.quoteAbandonCron(T + 3 * min);
ok('the phone on their journey still stops the email', SENT.length === 0, SENT);
ok('and the watch is dropped', (await watched()).length === 0);

section('Two minutes of SILENCE, not two minutes of clock');
reset();
T = Date.now();
await sawQuote('v4', T, 380, 'Truck · Full Detail');
await beacon('v4', '/', [{ t: T + 100000, k: 'c', l: 'Pushed "Text me my quote"' }]);
await Q.quoteAbandonCron(T + 150000);
ok('still tapping around means still deciding — no email', SENT.length === 0, SENT);
ok('the watch is kept', (await watched()).length === 1);
await Q.quoteAbandonCron(T + 5 * min);
ok('once they really do go quiet, it fires', SENT.length === 1, SENT.map((s) => s.subject));

section('But it never waits forever');
reset();
T = Date.now();
await sawQuote('v5', T, 500, 'Van · Full Detail');
const doc5 = JSON.parse(STORE.get('journey:v5').value);
doc5.lastAt = T + 40 * min - 10000;               // a tab left open, still pinging
STORE.set('journey:v5', { value: JSON.stringify(doc5), metadata: null });
await Q.quoteAbandonCron(T + 40 * min);
ok('half an hour on one price is an answer by itself', SENT.length === 1, SENT);

section('An entry that outlived a cron outage is dropped, not mailed');
reset();
T = Date.now();
await sawQuote('v6', T, 275, 'Sedan · Interior Detail');
await Q.quoteAbandonCron(T + 9 * 3600000);
ok('no email about a visit from this morning', SENT.length === 0, SENT);
ok('but it is cleaned up', (await watched()).length === 0);

section('Fiddling with the quote does not cost a write per look');
reset();
T = Date.now();
await sawQuote('v7', T, 420, 'Truck · Full Detail');
let w0 = writes;
await sawQuote('v7', T, 420, 'Truck · Full Detail');
ok('the same price again writes only the journey, not the watch', writes === w0 + 1, writes - w0);
w0 = writes;
await sawQuote('v7', T, 560, 'Truck · Full Detail, Pet hair');
ok('a price they had not seen before does re-arm', writes === w0 + 2, writes - w0);
ok('and there is still only one watch for them', (await watched()).length === 1, await watched());
await Q.quoteAbandonCron(T + 3 * min);
ok('the email quotes the newest price', /\$560/.test(SENT[0].subject), SENT[0].subject);

section('A quiet minute costs one read and nothing else');
reset();
await Q.quoteAbandonCron(Date.now());
ok('nothing pending: one read, no write', reads === 1 && writes === 0, { reads, writes });
CONFIG = { quoteAbandon: false };
reads = 0;
await Q.quoteAbandonCron(Date.now());
ok('switched off: not even the read', reads === 0, reads);

section('The switch also stops it arming');
reset();
CONFIG = { quoteAbandon: false };
await sawQuote('v8', Date.now(), 420, 'Truck · Full Detail');
CONFIG = {};
ok('no watch was ever armed', (await watched()).length === 0);
await Q.quoteAbandonCron(Date.now() + 3 * min);
ok('so nothing to email', SENT.length === 0);

section('He can pick his own wait');
reset();
CONFIG = { quoteAbandonMin: 10 };
T = Date.now();
await sawQuote('v9', T, 420, 'Truck · Full Detail');
await Q.quoteAbandonCron(T + 5 * min);
ok('five minutes into a ten-minute wait, nothing', SENT.length === 0);
await Q.quoteAbandonCron(T + 11 * min);
ok('past it, the email goes', SENT.length === 1);
ok('a junk setting falls back to two minutes', Q.quoteWatchWaitMs({ quoteAbandonMin: 'nonsense' }) === 2 * min);
ok('and a silly one is clamped', Q.quoteWatchWaitMs({ quoteAbandonMin: 9999 }) === 60 * min);

section('The site as it stands today still trips it');
reset();
T = Date.now();
// Before the priced event ships, all the form sends on reaching step 4 is this.
await beacon('v10', '/', [{ t: T, k: 'f', l: 'Quote form — step 4', d: 'Your estimate' }]);
ok('the plain step-4 event arms a watch', (await watched()).length === 1);
await Q.quoteAbandonCron(T + 3 * min);
ok('and he still gets told', SENT.length === 1, SENT.map((s) => s.subject));
ok('it just cannot name a price', /Saw their quote and left/.test(SENT[0].subject), SENT[0].subject);
ok('and it does not invent one', !/\$/.test(SENT[0].body.text.split('\n')[0]), SENT[0].body.text);

section('Earlier steps of the form are not a price');
reset();
T = Date.now();
await beacon('v11', '/', [{ t: T, k: 'f', l: 'Quote form — step 3', d: 'Condition' }]);
ok('step 3 arms nothing', (await watched()).length === 0);
ok('nor does a plain button', !Q.isQuoteRevealStep({ l: 'Pushed "See all services"' }));

section('It never grows without bound');
reset();
T = Date.now();
for (let i = 0; i < Q.QUOTE_WATCH_MAX + 15; i++) {
  await sawQuote('flood' + i, T, 100 + i, 'Sedan · Interior Detail');
}
ok('the pending list is capped', (await watched()).length === Q.QUOTE_WATCH_MAX, (await watched()).length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
