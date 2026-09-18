// Google Ads offline conversion import.
//
// The feature rests on one thing that cannot be fixed after the fact: the raw
// click id has to be ON THE JOURNEY the moment somebody lands, because a gclid
// exists for one page load and Google's import window shuts 90 days after the
// click. So most of what's asserted here is capture and survival — the id is
// stamped first-touch, it isn't erased by page four, it isn't leaked into the
// page rows, and it's still there after the lead links a phone to the journey.
//
// The rest is the file itself: Google fails a row whose conversion action name
// it doesn't recognise, and a row dated before its own click, so the header,
// the exact action names and the timestamps are all worth a test.
//
//   node test/adsexport.test.js
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
const STORE = new Map();   // key -> { value, metadata }
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

let CFG = { tz: 'America/Los_Angeles' };
const ctx = {
  kv: () => KV,
  json: (o) => ({ __json: o }),
  loadConfig: async () => CFG,
  normalizePhone: (p) => {
    const d = String(p || '').replace(/\D/g, '').slice(-10);
    return d.length === 10 ? '+1' + d : '';
  },
  // Enough of a Response to read the CSV and the headers back off.
  Response: class {
    constructor(body, init) { this.body = body; this.status = (init || {}).status || 200; this.head = (init || {}).headers || {}; }
  },
};

const CODE = [
  constant('JOURNEY_TTL'), constant('JOURNEY_MAX_STEPS'),
  constant('journeyKey'), constant('journeyPhoneKey'),
  constant('QUOTE_WATCH_KEY'), constant('QUOTE_WATCH_MAX'), constant('PX_EVENT_KINDS'),
  constant('AD_CLICK_IDS'), constant('AD_REF_HOSTS'), constant('AD_PAID_MEDIUM'), constant('AD_NAMES'),
  constant('ADS_ACTION_FORM'), constant('ADS_ACTION_CALL'), constant('ADS_CURRENCY'), constant('ADS_JOB_WINDOW_MS'),
  constant('INTEL_MAX_MONTHS'), constant('TZFMT'),
  constant('quotesKey'), constant('moneyKey'),
  lift('refHostOf'), lift('adFromLanding'), lift('visitorCity'), lift('stampJourneyInfo'),
  lift('cleanVid'), lift('blankJourney'), lift('appendStep'),
  lift('journeyHotLabel'), lift('journeyMeta'), lift('journeyStep'), lift('journeyLink'),
  lift('loadQuoteWatch'), lift('saveQuoteWatch'), lift('armQuoteWatch'), lift('clearQuoteWatch'),
  lift('isQuoteRevealStep'), lift('quoteWatchPrice'),
  lift('handlePixelEvents'), lift('pxOk'),
  lift('money2'), lift('prevMonthKey'), lift('tzFmt'), lift('localDateStr'),
  lift('intelTs'), lift('intelJobs'), lift('intelLedger'),
  lift('loadQuoteMonth'), lift('quoteWindow'),
  lift('csvLine'), lift('adsConvTime'), lift('adsLeadValue'), lift('adsConversionRow'),
  lift('apiAdsConversions'),
].join('\n\n');

const factory = new Function(...Object.keys(ctx), CODE + `
  return { adFromLanding, stampJourneyInfo, journeyStep, journeyLink, journeyMeta, handlePixelEvents,
           csvLine, adsConvTime, adsLeadValue, adsConversionRow, apiAdsConversions,
           ADS_ACTION_FORM, ADS_ACTION_CALL };`);
const A = factory(...Object.values(ctx));

// --- harness -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const now = Date.now();
const min = 60000, day = 86400000;
// A real gclid: base64url, ~90 characters, which is the length the KV metadata
// budget has to survive.
const GCLID = 'EAIaIQobChMIz9v' + 'x'.repeat(60) + 'wQAvD_BwE';
const U = (q) => new URL('https://x.test/api/ads/conversions' + (q || ''));
const csv = (res) => String(res.body).trim().split('\n');

section('The click id itself is kept, not just the platform name');
ok('a gclid comes back whole', A.adFromLanding('/?gclid=' + GCLID, '').clid === GCLID, A.adFromLanding('/?gclid=' + GCLID, ''));
ok('and says which parameter carried it', A.adFromLanding('/?gclid=abc', '').clidk === 'gclid');
ok('gbraid is captured too (iOS)', A.adFromLanding('/?gbraid=abc123', '').clidk === 'gbraid');
ok('so is wbraid', A.adFromLanding('/monroe/?wbraid=abc123', '').clidk === 'wbraid');
ok('gclid wins when Google sends both', A.adFromLanding('/?gbraid=b&gclid=g', '').clidk === 'gclid', A.adFromLanding('/?gbraid=b&gclid=g', ''));
ok('an organic landing carries no id', A.adFromLanding('/ceramic-coating/', 'google.com').clid === '');
ok('utm tagging alone is an ad with no id to upload', A.adFromLanding('/?utm_source=google&utm_medium=cpc', '').clid === '');
ok('a click id is clamped', A.adFromLanding('/?gclid=' + 'z'.repeat(400), '').clid.length === 200);
ok('and stripped of anything that is not base64url',
  A.adFromLanding('/?gclid=' + encodeURIComponent('ab,"c\nd'), '').clid === 'abcd',
  A.adFromLanding('/?gclid=' + encodeURIComponent('ab,"c\nd'), '').clid);

section('First touch wins, and page four must not erase it');
let r = await A.journeyStep('paid1', { t: now - 30 * min, p: '/?gclid=' + GCLID, r: 'googleadservices.com' },
  { ad: 'google', camp: 'Search 2026', city: 'Snohomish, WA', clid: GCLID, clidk: 'gclid' });
ok('the id lands on the visitor', r.doc.clid === GCLID, r.doc.clid);
r = await A.journeyStep('paid1', { t: now - 28 * min, p: '/ceramic-coating/', r: '' }, { ad: '', camp: '', city: '', clid: '', clidk: '' });
ok('a second page does not clear it', r.doc.clid === GCLID);
r = await A.journeyStep('paid1', { t: now - 26 * min, p: '/?gclid=LATER', r: '' }, { ad: 'google', camp: '', city: '', clid: 'LATER', clidk: 'gclid' });
ok('a later click does not overwrite the first', r.doc.clid === GCLID, r.doc.clid);
const pairOnly = A.stampJourneyInfo({}, { clid: 'abc' });
ok('a bare id still records a parameter name', pairOnly.clidk === 'gclid', pairOnly);

section('The export reads metadata, so the id has to physically be there');
const meta = STORE.get('journey:paid1').metadata;
ok('the click id is in the KV metadata', meta.clid === GCLID, meta.clid);
ok('so is the parameter it came from', meta.clidk === 'gclid');
ok('and the metadata still fits KV\'s 1KB ceiling', JSON.stringify(meta).length < 1024, JSON.stringify(meta).length);

section('The beacon captures the id and still throws the query away');
// The whole trick: site-stats.js sends the query string separately as `q`, the
// id is read off it, and the PAGE is stored bare. A gclid left on the path would
// turn one home page into a hundred rows in Top Pages.
await A.handlePixelEvents({
  async text() { return JSON.stringify({ v: 'beacon1', p: '/monroe/', q: '?gclid=BEACONID&utm_campaign=Search 2026',
    e: [{ k: 'v', t: now - 5 * min, d: 'googleadservices.com' }, { k: 'c', t: now - 4 * min, l: 'Tapped to CALL' }] }); },
  cf: { city: 'Monroe', regionCode: 'WA' },
});
const beacon = JSON.parse(STORE.get('journey:beacon1').value);
ok('the beacon\'s own click id is captured', beacon.clid === 'BEACONID', beacon.clid);
ok('and the campaign with it', beacon.camp === 'Search 2026', beacon.camp);
ok('no step carries the query string',
  beacon.steps.every((st) => !String(st.p || '').includes('gclid')), beacon.steps.map((st) => st.p));

section('It survives the lead — the whole point of capturing it');
await A.journeyLink('paid1', '+14255550123', 'Sarah Reed');
const linked = JSON.parse(STORE.get('journey:paid1').value);
ok('the id is still on the doc after the phone is attached', linked.clid === GCLID, linked.clid);
ok('and the moment they became a lead is stamped', linked.leadAt > 0, linked.leadAt);
ok('the metadata carries that moment too', STORE.get('journey:paid1').metadata.lead === linked.leadAt);
const firstLead = linked.leadAt;
await A.journeyLink('paid1', '+14255550123', 'Sarah Reed');
ok('a second submission does not move the conversion time',
  JSON.parse(STORE.get('journey:paid1').value).leadAt === firstLead);

section('Which visitors become a row');
const row = (m) => A.adsConversionRow('v', m, 0);
ok('a lead with a gclid is a row', row({ phone: '+14255550123', clid: 'g', clidk: 'gclid', lead: now }).name === A.ADS_ACTION_FORM);
ok('a tap-to-call with no number is still a conversion',
  row({ hot: 'Tapped to CALL', clid: 'g', clidk: 'gclid', at: now }).name === A.ADS_ACTION_CALL);
ok('a lead who also tapped CALL is ONE row, the form one',
  row({ phone: '+14255550123', hot: 'Tapped to CALL', clid: 'g', clidk: 'gclid', lead: now }).name === A.ADS_ACTION_FORM);
ok('somebody who just read four pages is nothing', row({ clid: 'g', clidk: 'gclid', at: now }) === null);
ok('a lead with no click id is skipped, and counted', row({ phone: '+1425', lead: now }).skip === 'noClick');
ok('a gbraid lead is skipped — the CSV has no column for it',
  row({ phone: '+1425', clid: 'b', clidk: 'gbraid', lead: now }).skip === 'braid');
ok('a row is never dated before its own click',
  row({ phone: '+1425', clid: 'g', clidk: 'gclid', lead: now - 10 * day, first: now }).at === now);
ok('and a lead older than the window is left out',
  A.adsConversionRow('v', { phone: '+1425', clid: 'g', clidk: 'gclid', lead: now - 60 * day }, now - 45 * day) === null);

section('What the lead was worth: the booked job beats the estimate');
const JOBS = [
  { type: 'job', phone: '+14255550123', amount: 379, date: new Date(now).toISOString().slice(0, 10) },
  { type: 'job', phone: '+14255550999', amount: 200, date: new Date(now - 300 * day).toISOString().slice(0, 10) },
];
const QUOTES = [
  { phone: '+14255550123', total: 299, ts: now - 30 * min },
  { phone: '+14255550777', total: 160, ts: now - 30 * min },
];
ok('a job he actually got paid for is the value',
  A.adsLeadValue('+14255550123', now, JOBS, QUOTES).value === 379, A.adsLeadValue('+14255550123', now, JOBS, QUOTES));
ok('and it says the number came from a job',
  A.adsLeadValue('+14255550123', now, JOBS, QUOTES).from === 'job');
ok('no job yet falls back to the quote he sent',
  A.adsLeadValue('+14255550777', now, JOBS, QUOTES).value === 160);
ok('a job from LAST year is not this click\'s work',
  A.adsLeadValue('+14255550999', now, JOBS, QUOTES).value === 0, A.adsLeadValue('+14255550999', now, JOBS, QUOTES));
ok('a stranger with neither is worth nothing stated', A.adsLeadValue('+14255551111', now, JOBS, QUOTES).value === 0);
ok('a tap-to-call has no phone, so no value', A.adsLeadValue('', now, JOBS, QUOTES).value === 0);

section('The file Google will actually accept');
// The ledger and the quote log the export reads, in the shape it reads them.
const thisMonth = new Date(now).toISOString().slice(0, 7);
STORE.set('money:m:' + thisMonth, { value: JSON.stringify({ entries: [JOBS[0]] }), metadata: null });
STORE.set('quotes:m:' + thisMonth, { value: JSON.stringify({ entries: [{ phone: '+14255550123', total: 299, ts: now - 30 * min }] }), metadata: null });
// A second visitor: tapped to call off a paid click, never left a number.
await A.journeyStep('paid2', { t: now - 10 * min, p: '/?gclid=CALLCLICK', r: '' },
  { ad: 'google', camp: '', city: 'Everett, WA', clid: 'CALLCLICK', clidk: 'gclid' });
await A.journeyStep('paid2', { t: now - 9 * min, p: '/', r: '' }, { ad: '', camp: '', city: '' });
let d2 = JSON.parse(STORE.get('journey:paid2').value);
d2.steps.push({ t: now - 9 * min, k: 'c', l: 'Tapped to CALL' });
STORE.set('journey:paid2', { value: JSON.stringify(d2), metadata: A.journeyMeta(d2) });
// A third: organic, left a number. Nothing to upload — there is no click to match.
await A.journeyStep('free1', { t: now - 8 * min, p: '/', r: 'google.com' }, { ad: '', camp: '', city: '' });
await A.journeyLink('free1', '+14255550777', 'Dave');

const out = await A.apiAdsConversions(U());
const L = csv(out);
ok('line one is Google\'s parameters row, not a header',
  L[0] === 'Parameters:TimeZone=America/Los_Angeles', L[0]);
ok('the header is the documented column set',
  L[1] === 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID', L[1]);
ok('it downloads as a CSV', /text\/csv/.test(out.head['Content-Type']), out.head['Content-Type']);
ok('and is never cached — a click id identifies a person', out.head['Cache-Control'] === 'no-store');

const rows = L.slice(2).map((l) => l.split(','));
ok('three paid conversions, and only the paid ones', rows.length === 3, L);
const form = rows.find((c) => c[1] === 'Submit lead form');
const call = rows.find((c) => c[1] === 'Site tap-to-call');
ok('the lead row carries the click id that brought them', form && form[0] === GCLID, form && form[0]);
ok('the conversion name is spelled exactly as Ads spells it', !!form, L);
ok('the value is the booked job, not the $299 estimate', form[3] === '379.00', form[3]);
ok('with a currency beside it', form[4] === 'USD', form[4]);
ok('an order id so a re-upload lands on the same row', form[5] === 'paid1-form', form[5]);
ok('the time is his clock, to the second', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(form[2]), form[2]);
ok('the tap-to-call is uploaded under the tap-to-call action', !!call, L);
ok('with no value invented for it', call[3] === '' && call[4] === '', call);
ok('the organic lead is not in the file', !L.join('\n').includes('free1'), L);

section('The same scan as numbers, for a look before he uploads');
const j = (await A.apiAdsConversions(U('?format=json'))).__json;
ok('it counts the rows', j.rows === 3, j);
ok('and says the organic lead had no click to match', j.skipped.noClick === 1, j.skipped);
ok('and what the upload is worth', j.value === 379, j.value);
ok('one of them off a real booked job', j.booked === 1, j.booked);
ok('it never hands back a click id', !JSON.stringify(j).includes(GCLID));
ok('the timezone it stamped is named', j.tz === 'America/Los_Angeles');

section('Times and quoting');
ok('a summer timestamp is PDT, not UTC',
  A.adsConvTime(Date.parse('2026-09-18T21:32:07Z'), 'America/Los_Angeles') === '2026-09-18 14:32:07',
  A.adsConvTime(Date.parse('2026-09-18T21:32:07Z'), 'America/Los_Angeles'));
ok('a winter one is PST',
  A.adsConvTime(Date.parse('2026-01-15T20:00:00Z'), 'America/Los_Angeles') === '2026-01-15 12:00:00',
  A.adsConvTime(Date.parse('2026-01-15T20:00:00Z'), 'America/Los_Angeles'));
ok('midnight is 00, never 24',
  /^\d{4}-\d{2}-\d{2} 00:/.test(A.adsConvTime(Date.parse('2026-06-01T07:00:00Z'), 'America/Los_Angeles')),
  A.adsConvTime(Date.parse('2026-06-01T07:00:00Z'), 'America/Los_Angeles'));
ok('a broken timezone says its offset instead of lying',
  /\+0000$/.test(A.adsConvTime(now, 'Not/AZone')), A.adsConvTime(now, 'Not/AZone'));
ok('a comma is quoted', A.csvLine(['a,b', 'c']) === '"a,b",c', A.csvLine(['a,b', 'c']));
ok('a quote is doubled', A.csvLine(['say "hi"']) === '"say ""hi"""', A.csvLine(['say "hi"']));
ok('and nothing plain is quoted needlessly', A.csvLine(['Submit lead form', '379.00']) === 'Submit lead form,379.00');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
