// Paid or organic — which of this morning's clicks did he actually buy.
//
// The whole feature rests on one claim: a click Google BILLED him for and a
// free click out of the same search results can be told apart, and are told
// apart everywhere he might look — the Journey board, the timeline, the
// "saw the price and left" email, and the new "somebody just landed" alert.
// That claim is only true if the landing URL's query string survives the trip,
// so most of what's tested here is the parsing of it, plus the two rules that
// keep the label honest: first touch wins, and nothing is guessed from a bare
// google.com referrer.
//
//   node test/adsource.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lifting trick as journey.test.js — these are module-private in the
// Worker and are not going to be exported purely so a test can see them.
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
const STORE = new Map();
const KV = {
  async get(k, opt) {
    const row = STORE.get(k);
    if (!row) return null;
    return (opt && opt.type === 'json') ? JSON.parse(row.value) : row.value;
  },
  async put(k, v, opt) { STORE.set(k, { value: v, metadata: (opt && opt.metadata) || null }); },
  async list({ prefix }) {
    const keys = [...STORE.keys()].filter((k) => k.startsWith(prefix))
      .map((k) => ({ name: k, metadata: STORE.get(k).metadata }));
    return { keys, list_complete: true, cursor: null };
  },
};

// What went out, so the alert can be asserted on without sending anything.
const SENT = [];
let CFG = {};

const ctx = {
  kv: () => KV,
  json: (o) => ({ __json: o }),
  loadConfig: async () => CFG,
  notifyMikey: async (subject, body) => { SENT.push({ subject, body }); return true; },
  publicBase: () => 'https://dash.test',
  htmlEsc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  // The mail kit, stubbed down to something assertable. What matters here is
  // which FACTS reach the email, not the inline CSS around them.
  MAILF: 'sans-serif',
  MAILC: { ink: '#0f172a', mute: '#64748b', blue: '#2563eb', blueBg: '#eff6ff', amber: '#f59e0b', amberBg: '#fffbeb', amberInk: '#b45309', card: '#fff' },
  mailCard: (inner) => `<card>${inner}</card>`,
  mailLabel: (t) => `<label>${t}</label>`,
  mailBody: (t) => `<body>${t}</body>`,
  mailBtn: (href, t) => `<btn href="${href}">${t}</btn>`,
  mailShell: (title, inner) => `<shell title="${title}">${inner}</shell>`,
  BASE_URL: 'https://mikeysdetailing.com',
};

const CODE = [
  constant('AD_CLICK_IDS'), constant('AD_REF_HOSTS'), constant('AD_PAID_MEDIUM'), constant('AD_NAMES'),
  constant('CLICK_ALERT_MAX'),
  constant('JOURNEY_TTL'), constant('JOURNEY_MAX_STEPS'), constant('journeyKey'), constant('journeyPhoneKey'),
  lift('analyticsDayKey'),
  lift('refHostOf'), lift('adFromLanding'), lift('adLabel'), lift('visitorCity'),
  lift('clickAlertMode'), lift('alertNewClick'), lift('newClickSubject'), lift('newClickEmail'),
  lift('cleanVid'), lift('journeyMeta'), lift('journeyHotLabel'), lift('blankJourney'),
  lift('appendStep'), lift('stampJourneyInfo'), lift('journeyStep'),
  lift('journeyPageTitle'), lift('journeyRefLabel'), lift('apiJourneys'),
  lift('trimCountMap'), lift('pixelRollup'), lift('utcDayStr'),
].join('\n\n');

const factory = new Function(...Object.keys(ctx), CODE + `
  return { refHostOf, adFromLanding, adLabel, visitorCity, clickAlertMode, alertNewClick,
           newClickSubject, newClickEmail, journeyStep, journeyRefLabel, apiJourneys,
           pixelRollup, journeyMeta, CLICK_ALERT_MAX };`);
const A = factory(...Object.values(ctx));

// --- harness -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const now = Date.now();

section('A click id in the landing URL is the proof, and the only proof');
ok('gclid is a Google ad', A.adFromLanding('/?gclid=EAIaIQobChMI', '').ad === 'google', A.adFromLanding('/?gclid=x', ''));
ok('so is gbraid (iOS app campaigns)', A.adFromLanding('/?gbraid=abc', '').ad === 'google');
ok('so is wbraid (web-to-app)', A.adFromLanding('/monroe/?wbraid=abc', '').ad === 'google');
ok('msclkid is Microsoft', A.adFromLanding('/?msclkid=abc', '').ad === 'bing');
ok('fbclid is Facebook', A.adFromLanding('/?fbclid=abc', '').ad === 'facebook');
ok('a click id anywhere in the query still counts', A.adFromLanding('/?utm_source=google&gclid=abc', '').ad === 'google');
ok('a bare path is nothing', A.adFromLanding('/ceramic-coating/', '').ad === '', A.adFromLanding('/ceramic-coating/', ''));
ok('an EMPTY gclid is not a click', A.adFromLanding('/?gclid=', '').ad === '', A.adFromLanding('/?gclid=', ''));

section('A plain Google referrer is never guessed into an ad — the whole bug');
ok('google.com alone is organic', A.adFromLanding('/', 'google.com').ad === '', A.adFromLanding('/', 'google.com'));
ok('and still reads as a free find', A.journeyRefLabel('google.com', '') === 'Found you on Google', A.journeyRefLabel('google.com', ''));
ok('bing.com alone is organic too', A.adFromLanding('/', 'bing.com').ad === '');
ok('but googleadservices only ever appears on a paid click', A.adFromLanding('/', 'googleadservices.com').ad === 'google');
ok('doubleclick too', A.adFromLanding('/', 'ad.doubleclick.net').ad === 'google');

section('utm tagging he wrote himself');
ok('utm_medium=cpc is paid', A.adFromLanding('/?utm_source=google&utm_medium=cpc', '').ad === 'google');
ok('an unknown paid source is still an ad', A.adFromLanding('/?utm_source=weeklyflyer&utm_medium=ppc', '').ad === 'ads');
ok('a newsletter is NOT an ad', A.adFromLanding('/?utm_source=newsletter&utm_medium=email', '').ad === '', A.adFromLanding('/?utm_source=newsletter&utm_medium=email', ''));
ok('the campaign name comes across', A.adFromLanding('/?gclid=x&utm_campaign=Snohomish Detailing - Search - 2026', '').camp === 'Snohomish Detailing - Search - 2026');
ok('a campaign name is clamped', A.adFromLanding('/?utm_campaign=' + 'x'.repeat(90), '').camp.length === 40);

section('It reads the query string wherever the site can put it');
ok('riding on the path', A.adFromLanding('/monroe/?gclid=abc', '').ad === 'google');
ok('as a bare query on its own', A.adFromLanding('gclid=abc', '').ad === 'google');
ok('with a leading ?', A.adFromLanding('?gclid=abc', '').ad === 'google');
ok('junk never throws', A.adFromLanding('/%%%?%%%', '').ad === '', A.adFromLanding('/%%%?%%%', ''));

section('Said the way Mikey would say it');
ok('a Google ad says so', A.journeyRefLabel('google.com', 'google') === 'Clicked your Google ad', A.journeyRefLabel('google.com', 'google'));
ok('Microsoft is not called Bing', /Microsoft/.test(A.journeyRefLabel('', 'bing')), A.journeyRefLabel('', 'bing'));
ok('the campaign rides along when there is one', A.journeyRefLabel('', 'google', 'Search 2026') === 'Clicked your Google ad · Search 2026');
ok('no referrer and no ad is unchanged', A.journeyRefLabel('', '') === 'Came straight to you');

section('Where they were, straight off the edge — no lookup, no key');
ok('city and state', A.visitorCity({ cf: { city: 'Snohomish', regionCode: 'WA' } }) === 'Snohomish, WA');
ok('city alone when the region is a long name', A.visitorCity({ cf: { city: 'Seattle', region: 'Washington' } }) === 'Seattle');
ok('no cf object is silent', A.visitorCity({}) === '');
ok('a request with nothing on it is silent', A.visitorCity(null) === '');

section('First touch wins — page four must not erase the ad that paid for page one');
let r = await A.journeyStep('paid1', { t: now, p: '/?gclid=abc', r: 'google.com' },
  { ad: 'google', camp: 'Search 2026', city: 'Snohomish, WA' });
ok('a brand-new id reports itself as new', r.isNew === true, r.isNew);
ok('the ad is stamped on the visitor', r.doc.ad === 'google', r.doc);
r = await A.journeyStep('paid1', { t: now + 120000, p: '/ceramic-coating/', r: '' }, { ad: '', camp: '', city: '' });
ok('a second page does not clear it', r.doc.ad === 'google', r.doc.ad);
ok('and the id is no longer new', r.isNew === false, r.isNew);
ok('the city survives too', r.doc.city === 'Snohomish, WA', r.doc.city);
r = await A.journeyStep('paid1', { t: now + 240000, p: '/?fbclid=zzz', r: '' }, { ad: 'facebook', camp: '', city: '' });
ok('a LATER ad click does not overwrite the first one', r.doc.ad === 'google', r.doc.ad);

section('The board answers "which of these did I pay for" without opening a doc');
await A.journeyStep('free1', { t: now + 1000, p: '/', r: 'google.com' }, { ad: '', camp: '', city: 'Everett, WA' });
const board = (await A.apiJourneys(new URL('https://x.test/api/journeys?limit=30'))).__json;
const paid = board.journeys.find((x) => x.vid === 'paid1');
const free = board.journeys.find((x) => x.vid === 'free1');
ok('the paid row carries the platform', paid.ad === 'google', paid);
ok('and the city', paid.city === 'Snohomish, WA', paid.city);
ok('and a ready-made sentence', paid.found === 'Clicked your Google ad · Search 2026', paid.found);
ok('the organic row says the free thing', free.found === 'Found you on Google', free.found);
ok('and carries no platform', free.ad === '', free.ad);
// The board is built from KV metadata alone — listing 500 visitors costs zero
// reads — so the ad and the city have to physically BE in the metadata, not
// just in the doc the board never opens.
const meta = STORE.get('journey:paid1').metadata;
ok('the platform is in the metadata itself', meta.ad === 'google', meta);
ok('so is the city', meta.city === 'Snohomish, WA', meta);
ok('and the metadata stays inside KV\'s 1KB ceiling', JSON.stringify(meta).length < 1024, JSON.stringify(meta).length);

section('"Somebody just landed" — who gets told, and how often');
const state = (over) => Object.assign({
  ad: { ad: 'google', camp: 'Search 2026' }, city: 'Seattle, WA', path: '/monroe/',
  refHost: 'google.com', day: '2026-08-30', doc: {},
}, over || {});

SENT.length = 0; CFG = {};
ok('the default is every new visitor', A.clickAlertMode({}) === 'all', A.clickAlertMode({}));
ok('a stored junk value falls back to the default', A.clickAlertMode({ clickAlert: 'yes please' }) === 'all');

SENT.length = 0; CFG = { clickAlert: 'off' };
await A.alertNewClick({ vid: 'paid1' }, state());
ok('off sends nothing', SENT.length === 0, SENT.length);

SENT.length = 0; CFG = { clickAlert: 'ads' };
await A.alertNewClick({ vid: 'free1' }, state({ ad: { ad: '', camp: '' } }));
ok('ads-only skips an organic visitor', SENT.length === 0, SENT.length);
await A.alertNewClick({ vid: 'paid1' }, state());
ok('but sends for a click he paid for', SENT.length === 1, SENT.length);
ok('the subject says it cost money', /ad click/i.test(SENT[0].subject), SENT[0].subject);
ok('and where they were', /Seattle, WA/.test(SENT[0].subject), SENT[0].subject);

SENT.length = 0; CFG = { clickAlert: 'all' };
await A.alertNewClick({ vid: 'free1' }, state({ ad: { ad: '', camp: '' }, city: 'Everett, WA' }));
ok('every-visitor sends for an organic one too', SENT.length === 1, SENT.length);
ok('and does not call it an ad', !/ad click/i.test(SENT[0].subject), SENT[0].subject);
ok('the email says how they got there', /Found you on Google/.test(SENT[0].body.text), SENT[0].body.text);
ok('and that nothing was sent to them', /Nothing has been sent to them/.test(SENT[0].body.text));
ok('and links to the replay', /dash\.test\/\?journey=free1/.test(SENT[0].body.text), SENT[0].body.text);
ok('the text fallback fits a text message', SENT[0].body.sms.length < 160, SENT[0].body.sms);

section('It cannot bury the alerts that matter');
SENT.length = 0; CFG = { clickAlert: 'all' };
const dayDoc = { alerts: 0 };
for (let i = 0; i < A.CLICK_ALERT_MAX + 12; i++) await A.alertNewClick({ vid: 'v' + i }, state({ doc: dayDoc }));
ok('it stops itself at the daily cap', SENT.length === A.CLICK_ALERT_MAX, SENT.length);
ok('and the counter rides in the day doc, costing no extra write', dayDoc.alerts === A.CLICK_ALERT_MAX, dayDoc.alerts);
ok('the cap is a number a person would pick', A.CLICK_ALERT_MAX >= 10 && A.CLICK_ALERT_MAX <= 50, A.CLICK_ALERT_MAX);

section('Paid and free are counted apart in the 14-day rollup');
STORE.clear();
const today = new Date().toISOString().slice(0, 10);
STORE.set('analytics:day:' + today, { value: JSON.stringify({ views: 10, visitors: 8, paths: {}, refs: {}, ads: { google: 4 } }), metadata: null });
const roll = await A.pixelRollup(3);
ok('paid clicks are totalled', roll.adClicks === 4, roll.adClicks);
ok('the rest are counted as free', roll.freeVisits === 6, roll.freeVisits);
ok('the platform is named in English', roll.topAds[0].k === 'Google', roll.topAds);
ok('a day with no ads is not an error', (await A.pixelRollup(1)).adClicks >= 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
