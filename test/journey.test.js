// Customer journeys. The whole feature turns on two claims: an anonymous path
// only ever gets a name when the customer hands over their number, and the
// merged timeline is genuinely in order. Both are tested here, plus the boring
// safety properties — the doc can't grow forever, a refresh isn't four steps,
// and a missing visitor id never breaks the lead.
//
// The journey functions are module-private in the Worker, so they're lifted out
// of the source by name and evaluated with a fake KV (same trick as
// snapshot.test.js) rather than exported purely for tests.
//
//   node test/journey.test.js
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

// --- fake KV -----------------------------------------------------------------
const STORE = new Map();   // key -> { value, metadata }
const KV = {
  async get(k, opt) {
    const row = STORE.get(k);
    if (!row) return null;
    return (opt && opt.type === 'json') ? JSON.parse(row.value) : row.value;
  },
  async put(k, v, opt) { STORE.set(k, { value: v, metadata: (opt && opt.metadata) || null }); },
  async list({ prefix, cursor }) {
    const keys = [...STORE.keys()].filter((k) => k.startsWith(prefix))
      .map((k) => ({ name: k, metadata: STORE.get(k).metadata }));
    return { keys, list_complete: true, cursor: null };
  },
};

const THREADS = {};
const ctx = {
  kv: () => KV,
  threadKey: (p) => 'thread:' + p,
  normalizePhone: (p) => {
    const d = String(p || '').replace(/\D/g, '').slice(-10);
    return d.length === 10 ? '+1' + d : '';
  },
  json: (o) => ({ __json: o }),
  loadConfig: async () => ({}),
  Response: class { constructor(b, i) { this.body = b; this.status = (i || {}).status; } },
};

const CODE = [
  constant('JOURNEY_TTL'), constant('JOURNEY_MAX_STEPS'),
  constant('journeyKey'), constant('journeyPhoneKey'),
  constant('PX_EVENT_KINDS'),
  // The beacon handler arms the "saw the price and never left a number" watch,
  // and a lead clears it — see quotewatch.test.js for that feature's own suite.
  constant('QUOTE_WATCH_KEY'), constant('QUOTE_WATCH_MAX'),
  lift('isQuoteRevealStep'), lift('quoteWatchPrice'),
  lift('loadQuoteWatch'), lift('saveQuoteWatch'),
  lift('armQuoteWatch'), lift('clearQuoteWatch'),
  lift('cleanVid'), lift('journeyMeta'), lift('journeyHotLabel'),
  // Paid-vs-organic rides along on the same steps — see adsource.test.js for
  // the feature's own suite; these are here because journeyStep stamps them.
  constant('AD_CLICK_IDS'), constant('AD_REF_HOSTS'), constant('AD_PAID_MEDIUM'), constant('AD_NAMES'),
  lift('refHostOf'), lift('adFromLanding'), lift('adLabel'), lift('visitorCity'), lift('stampJourneyInfo'),
  lift('blankJourney'), lift('appendStep'), lift('journeyStep'), lift('journeyLink'),
  lift('handlePixelEvents'), lift('pxOk'),
  lift('journeyPageTitle'), lift('journeyRefLabel'), lift('journeyReadStep'),
  lift('apiJourneys'), lift('apiJourney'), lift('journeyThreadSteps'),
].join('\n\n');

const factory = new Function(...Object.keys(ctx), CODE + `
  return { journeyStep, journeyLink, journeyPageTitle, journeyRefLabel, journeyReadStep,
           apiJourneys, apiJourney, journeyThreadSteps, handlePixelEvents,
           cleanVid, JOURNEY_MAX_STEPS };`);
const J = factory(...Object.values(ctx));

// The fake thread store the lifted apiJourney reads through kv().get(threadKey()).
const putThread = (t) => STORE.set('thread:' + t.phone, { value: JSON.stringify(t), metadata: null });

// --- harness -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const U = (q) => new URL('https://x.test/api/journey' + q);

const now = Date.now();
const min = 60000;

section('A visitor is nobody until they hand over their number');
await J.journeyStep('vis1', { t: now - 20 * min, p: '/', r: 'google.com' });
await J.journeyStep('vis1', { t: now - 18 * min, p: '/ceramic-coating-snohomish-county/', r: '' });
await J.journeyStep('vis1', { t: now - 15 * min, p: '/monroe/', r: '' });
let d = (await J.apiJourney(U('?vid=vis1'))).__json;
ok('their path is recorded', d.pages === 3, d.pages);
ok('but no phone is attached', d.phone === '', d.phone);
ok('no thread either', d.hasThread === false, d.hasThread);

await J.journeyLink('vis1', '+14255550123', 'Sarah Reed');
d = (await J.apiJourney(U('?vid=vis1'))).__json;
ok('linking attaches the number', d.phone === '+14255550123', d.phone);
ok('and the name', d.name === 'Sarah Reed', d.name);
ok('a "left their number" step lands on the line', d.steps.some((s) => s.kind === 'lead'), d.steps.map((s) => s.kind));

section('The link is by phone, both directions');
d = (await J.apiJourney(U('?phone=(425) 555-0123'))).__json;
ok('a loose phone finds the journey', d.pages === 3, d.pages);
ok('even though only the vid was ever stored', d.vid === 'vis1', d.vid);
d = (await J.apiJourney(U('?phone=+14259999999'))).__json;
ok('an unknown number is empty, not an error', d.ok === true && d.pages === 0 && d.steps.length === 0, d);

section('The website path and the conversation merge into one ordered story');
putThread({
  phone: '+14255550123', name: 'Sarah Reed', status: 'won', statusAt: now - 2 * min,
  appointmentAt: now - 4 * min,
  quote: { at: now - 6 * min, total: 240, service: 'Full Detail' },
  messages: [
    { id: 'a', dir: 'in',  body: 'hey is that price for an SUV?', ts: now - 12 * min },
    { id: 'b', dir: 'in',  body: 'its a 2019 pilot',             ts: now - 11 * min },
    { id: 'c', dir: 'out', body: 'Hey Sarah — yes, $240 covers it.', ts: now - 10 * min },
  ],
});
d = (await J.apiJourney(U('?phone=+14255550123'))).__json;
const ts = d.steps.map((s) => s.t);
ok('every step is in time order', ts.every((v, i) => i === 0 || ts[i - 1] <= v), ts);
ok('the story starts on the website, not the text', d.steps[0].kind === 'found', d.steps[0]);
ok('pages come before the texts', d.steps.findIndex((s) => s.kind === 'page') < d.steps.findIndex((s) => s.kind === 'them'), d.steps.map((s) => s.kind));
ok('the quote is on the line', d.steps.some((s) => s.kind === 'quote' && /240/.test(s.detail)), d.steps.filter((s) => s.kind === 'quote'));
ok('so is the booking and the win', d.steps.some((s) => s.kind === 'booked') && d.steps.some((s) => s.kind === 'won'));

section('A run of texts is one step, not a transcript');
const them = d.steps.filter((s) => s.kind === 'them');
ok('two texts in a row collapse to one step', them.length === 1, them);
ok('and it says how many', /2 times/.test(them[0].title), them[0].title);
ok('your reply is its own step', d.steps.filter((s) => s.kind === 'you').length === 1);

section('It never grows without bound');
for (let i = 0; i < J.JOURNEY_MAX_STEPS + 25; i++) {
  await J.journeyStep('vis2', { t: now + i * 5 * min, p: '/page-' + i, r: '' });
}
const big = await KV.get('journey:vis2', { type: 'json' });
ok('steps are capped', big.steps.length === J.JOURNEY_MAX_STEPS, big.steps.length);
ok('the cap keeps the NEWEST steps', big.steps[big.steps.length - 1].p === '/page-' + (J.JOURNEY_MAX_STEPS + 24), big.steps[big.steps.length - 1].p);

section('A refresh is not four visits');
await J.journeyStep('vis3', { t: now, p: '/', r: '' });
await J.journeyStep('vis3', { t: now + 900, p: '/', r: '' });
await J.journeyStep('vis3', { t: now + 2000, p: '/', r: '' });
let v3 = await KV.get('journey:vis3', { type: 'json' });
ok('same page inside a minute stays one step', v3.steps.length === 1, v3.steps.length);
await J.journeyStep('vis3', { t: now + 5 * min, p: '/', r: '' });
v3 = await KV.get('journey:vis3', { type: 'json' });
ok('coming back later is a real second step', v3.steps.length === 2, v3.steps.length);

section('Nothing here can break a lead');
ok('no visitor id is a silent no-op', (await J.journeyLink('', '+14255550123', 'X')) === undefined);
ok('an unknown visitor id is too', (await J.journeyLink('ghost', '+14255550123', 'X')) === undefined);
ok('a junk id is rejected before it touches KV', J.cleanVid('../../evil key') === 'evilkey', J.cleanVid('../../evil key'));
ok('nothing was written for the ghost', !STORE.has('journey:ghost'));

section('The board reads from metadata alone');
const board = (await J.apiJourneys(new URL('https://x.test/api/journeys?limit=30'))).__json;
ok('every visitor is listed', board.total === 3, board.total);
ok('newest first', board.journeys[0].at >= board.journeys[1].at, board.journeys.map((r) => r.at));
ok('the known one carries its phone', board.journeys.some((r) => r.phone === '+14255550123'), board.journeys);
ok('and the count of who converted', board.named === 1, board.named);
ok('a row knows how many steps without opening the doc', board.journeys.every((r) => r.steps > 0), board.journeys);

section('Pages and referrers read like English');
ok('a slug becomes a title', J.journeyPageTitle('/ceramic-coating-snohomish-county/') === 'Ceramic Coating Snohomish County', J.journeyPageTitle('/ceramic-coating-snohomish-county/'));
ok('the root is the home page', J.journeyPageTitle('/') === 'Home page');
ok('a query string is dropped', J.journeyPageTitle('/monroe/?utm_source=x') === 'Monroe', J.journeyPageTitle('/monroe/?utm_source=x'));
ok('Google is named', /Google/.test(J.journeyRefLabel('google.com')), J.journeyRefLabel('google.com'));
ok('no referrer is not blank', J.journeyRefLabel('') === 'Came straight to you', J.journeyRefLabel(''));

section('Looking at a journey never marks a conversation read');
ok('apiJourney reads the thread through kv(), not openThreadForRead',
  !/openThreadForRead/.test(lift('apiJourney')));

section('Every action they take lands on the line');
const beacon = (v, p, e) => J.handlePixelEvents({ text: async () => JSON.stringify({ v, p, e }) });
const T = now - 30 * min;   // a real session, not the future — see the clock-skew test below
await beacon('act1', '/', [
  { t: T,          k: 'v', l: 'Landed on the page', d: 'google.com' },
  { t: T + 4000,   k: 's', l: 'Quick Quote Calculator' },
  { t: T + 9000,   k: 'c', l: 'Get My Instant Quote' },
  { t: T + 15000,  k: 'f', l: 'Quote form — step 2', d: 'Your vehicle' },
  { t: T + 40000,  k: 'c', l: 'Tapped to CALL', d: '(425) 600-7897' },
  { t: T + 50000,  k: 'x', l: 'Left the page', d: '92s · 78% down' },
]);
d = (await J.apiJourney(U('?vid=act1'))).__json;
const kinds = d.steps.map((x) => x.kind);
ok('the landing is a page step, not a duplicate', kinds.filter((k) => k === 'page').length === 1, kinds);
ok('a section they scrolled to is recorded', d.steps.some((x) => x.kind === 'section' && /Quick Quote/.test(x.title)), d.steps);
ok('a button they pushed is recorded', d.steps.some((x) => /Pushed "Get My Instant Quote"/.test(x.title)), d.steps.map((x) => x.title));
ok('a form step is recorded', d.steps.some((x) => x.kind === 'form' && /step 2/.test(x.title)));
ok('a tap-to-call is called out as its own thing', d.steps.some((x) => x.kind === 'contact' && /CALL/.test(x.title)));
ok('the exit carries time and scroll depth', d.steps.some((x) => x.kind === 'exit' && /78% down/.test(x.detail)), d.steps.filter((x) => x.kind === 'exit'));
ok('actions are counted apart from pages', d.pages === 1 && d.acts === 5, { pages: d.pages, acts: d.acts });
ok('every action knows which page it happened on', d.steps.filter((x) => x.kind !== 'found').every((x) => x.page !== undefined));

section('The GIF ping and the event POST do not double-count a landing');
await J.journeyStep('act2', { t: T, p: '/monroe/', r: 'google.com' });
await beacon('act2', '/monroe/', [{ t: T + 500, k: 'v', l: 'Landed on the page', d: 'google.com' }]);
let a2 = await KV.get('journey:act2', { type: 'json' });
ok('one landing, not two', a2.steps.length === 1, a2.steps);
await beacon('act2', '/monroe/', [{ t: T + 400000, k: 'v', l: 'Landed on the page', d: '' }]);
a2 = await KV.get('journey:act2', { type: 'json' });
ok('but coming back later is a real second visit', a2.steps.length === 2, a2.steps.length);

section('A batch is one write, whatever is in it');
let writes = 0;
const realPut = KV.put.bind(KV);
KV.put = async (...a) => { writes++; return realPut(...a); };
await beacon('act3', '/', Array.from({ length: 20 }, (_, i) => ({ t: T + i * 1000, k: 'c', l: 'Button ' + i })));
KV.put = realPut;
ok('twenty events cost one KV write', writes === 1, writes);
ok('and all twenty are there', (await KV.get('journey:act3', { type: 'json' })).steps.length === 20);

section('A public endpoint takes nothing on faith');
await beacon('act4', '/', [{ t: T, k: 'evil', l: 'not a real kind' }]);
ok('an unknown event kind is dropped', !STORE.has('journey:act4') || (await KV.get('journey:act4', { type: 'json' })).steps.length === 0);
await beacon('act5', '/', [{ t: T, k: 'c', l: 'x'.repeat(500), d: 'y'.repeat(500) }]);
const a5 = (await KV.get('journey:act5', { type: 'json' })).steps[0];
ok('an oversized label is clamped', a5.l.length === 60, a5.l.length);
ok('so is the detail', a5.d.length === 80, a5.d.length);
await beacon('act6', '/', Array.from({ length: 300 }, (_, i) => ({ t: T + i, k: 'c', l: 'spam' + i })));
ok('a flood is capped at 80 per batch', (await KV.get('journey:act6', { type: 'json' })).steps.length === 80,
  (await KV.get('journey:act6', { type: 'json' })).steps.length);
await beacon('act7', '/', [{ t: now + 400 * 86400000, k: 'c', l: 'from the future' }]);
const a7 = (await KV.get('journey:act7', { type: 'json' })).steps[0];
ok('a skewed clock is pulled back to now', Math.abs(a7.t - Date.now()) < 60000, new Date(a7.t).toISOString());
ok('a missing visitor id writes nothing', await (async () => {
  const before = STORE.size;
  await beacon('', '/', [{ t: T, k: 'c', l: 'x' }]);
  return STORE.size === before;
})());
ok('junk that is not JSON is survivable', await (async () => {
  try { await J.handlePixelEvents({ text: async () => 'not json at all' }); return true; } catch (e) { return false; }
})());

section('The board can describe a path without opening it');
const board2 = (await J.apiJourneys(new URL('https://x.test/api/journeys?limit=60'))).__json;
const act1 = board2.journeys.find((r) => r.vid === 'act1');
ok('it knows pages and actions separately', act1.pages === 1 && act1.acts === 5, act1);
ok('and surfaces the loudest thing that happened', /Tapped to CALL/.test(act1.hot), act1.hot);
const plain = board2.journeys.find((r) => r.vid === 'vis2');
ok('a path with nothing loud on it has no badge', !plain.hot, plain.hot);

section('An ad click does not turn one page into two');
// The tracker snippet now sends location.search, so an ad click arrives as
// "/?gclid=…" on the GIF ping and as plain "/" on the event beacon. If the
// query survived, those two reports of ONE page load would stop collapsing —
// every replay of a paid visit would print "Home page" twice — and Top Pages
// would grow a new row per click, because no two gclids are alike.
const AT = now - 90 * min;
await J.journeyStep('adv1', { t: AT, p: '/', r: 'google.com' }, { ad: 'google', camp: '', city: '' });
await beacon('adv1', '/?gclid=EAIaIQobChMI', [{ t: AT + 500, k: 'v', l: 'Landed on the page', d: 'google.com' }]);
const adDoc = await KV.get('journey:adv1', { type: 'json' });
ok('the two reports of one landing stay one step', adDoc.steps.length === 1, adDoc.steps);
ok('and the click id is not stored as part of the page', adDoc.steps[0].p === '/', adDoc.steps[0].p);
ok('the ad it came from is still on the visitor', adDoc.ad === 'google', adDoc.ad);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
