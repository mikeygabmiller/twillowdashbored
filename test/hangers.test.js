// Door hangers (Insights → Hangers). What has to hold:
//   - the QR's ?utm_source=doorhanger survives onto the visitor's journey, and
//     never gets mistaken for a paid ad (utm_medium=print);
//   - a drop is logged with a sane count and a GPS trail thinned to a cap;
//   - credits: first one wins, a hand credit needs a real phone, tagged
//     conversations count, and money is summed per phone from job entries;
//   - bookings get geocoded a few at a time, never all at once.
//
//   node test/hangers.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const m = new RegExp(`(async )?function ${name}\\(`).exec(SRC);
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

const STORE = new Map();
let WRITES = 0;
const KV = {
  async get(k, opt) { const v = STORE.get(k); if (v == null) return null; return opt && opt.type === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { WRITES++; STORE.set(k, v); },
};
let INDEX = [], BOOKINGS = [], MONTHS = {}, GEOCALLS = 0;
const ctx = {
  kv: () => KV,
  json: (o, status) => ({ __json: o, status: status || 200 }),
  loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
  loadIndex: async () => INDEX.slice(),
  loadBookings: async () => BOOKINGS.slice(),
  loadMonth: async (m) => MONTHS[m] || { entries: [] },
  localDateStr: (ts, z) => new Date(ts).toLocaleDateString('en-CA', { timeZone: z || 'America/Los_Angeles' }),
  prevMonthKey: (m) => { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0'); },
  money2: (n) => Math.round(Number(n) * 100) / 100,
  genId: (() => { let n = 0; return () => 'd' + (++n); })(),
  normalizePhone: (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : ''; },
  fetch: async (u) => { GEOCALLS++; return { ok: true, json: async () => ({ result: { addressMatches: [{ coordinates: { x: -122.18, y: 47.83 } }] } }) }; },
};
const CODE = [
  constant('AD_CLICK_IDS'), constant('AD_REF_HOSTS'), constant('AD_PAID_MEDIUM'), constant('AD_NAMES'),
  constant('journeyKey'),
  constant('HANGER_KEY'), constant('HANGER_SINCE'), constant('HANGER_TRACK_MAX'),
  lift('refHostOf'), lift('adFromLanding'), lift('stampJourneyInfo'), lift('cleanVid'),
  lift('loadHangers'), lift('saveHangers'), lift('hangerCredit'), lift('journeyUtm'), lift('geocodeUS'),
  lift('apiHangers'), lift('apiHangersPost'),
].join('\n\n');
const H = new Function(...Object.keys(ctx), CODE + `
  return { adFromLanding, stampJourneyInfo, hangerCredit, journeyUtm, apiHangers, apiHangersPost, journeyKey };`)(...Object.values(ctx));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (body) => ({ json: async () => body });

section('The QR landing is remembered, and is not an ad');
const land = H.adFromLanding('/?utm_source=doorhanger&utm_medium=print', '');
ok('utm_source comes through', land.utm === 'doorhanger', land);
ok('utm_medium=print is not a paid click', land.ad === '', land);
const doc = {};
H.stampJourneyInfo(doc, { utm: land.utm });
H.stampJourneyInfo(doc, { utm: 'google' });
ok('first source sticks on the journey', doc.utm === 'doorhanger', doc);
STORE.set(H.journeyKey('abc123abc123'), JSON.stringify({ utm: 'doorhanger' }));
ok('journeyUtm reads it back', (await H.journeyUtm('abc123abc123')) === 'doorhanger');
ok('no visitor id, no source', (await H.journeyUtm('')) === '');

section('Logging a drop');
let r = await H.apiHangersPost(req({ action: 'drop', drop: { zone: 'Z01', count: 0 } }));
ok('zero hung is refused', r.status === 422, r);
const track = Array.from({ length: 4000 }, (_, i) => [47.83 + i * 1e-5, -122.18]);
r = await H.apiHangersPost(req({ action: 'drop', drop: { zone: 'Z01', count: '240', minutes: '190', date: '2026-10-19', track } }));
ok('a drop saves', r.__json.ok && r.__json.drop.count === 240, r.__json);
ok('the trail is thinned to the cap', r.__json.drop.track.length === 1500, r.__json.drop.track.length);
const firstId = r.__json.drop.id;
await H.apiHangersPost(req({ action: 'drop', drop: { kind: 'job', count: 25, date: '2026-10-12' } }));
let saved = JSON.parse(STORE.get('hangers:v1'));
ok('drops are kept in date order', saved.drops.map((d) => d.date).join() === '2026-10-12,2026-10-19', saved.drops.map((d) => d.date));
ok('an around-the-job drop is marked so', saved.drops[0].kind === 'job');
r = await H.apiHangersPost(req({ action: 'delete-drop', id: 'nope' }));
ok('deleting a missing drop says so', r.status === 404);
r = await H.apiHangersPost(req({ action: 'delete-drop', id: firstId }));
ok('deleting a real drop works', r.__json.ok && JSON.parse(STORE.get('hangers:v1')).drops.length === 1);

section('Credits');
await H.hangerCredit('+14255550101', { how: 'qr', name: 'Dana', where: '98012' });
await H.hangerCredit('+14255550101', { how: 'said', zone: 'Z09' });
saved = JSON.parse(STORE.get('hangers:v1'));
ok('first credit wins', saved.leads['+14255550101'].how === 'qr' && !saved.leads['+14255550101'].zone, saved.leads);
r = await H.apiHangersPost(req({ action: 'credit', phone: 'call me', zone: 'Z02' }));
ok('a hand credit needs a real phone', r.status === 422);
r = await H.apiHangersPost(req({ action: 'credit', phone: '(425) 555-0102', zone: 'Z02', name: 'Lee' }));
ok('a hand credit is stored normalized', r.__json.ok && JSON.parse(STORE.get('hangers:v1')).leads['+14255550102'].zone === 'Z02');

section('What the screen gets');
const oct = Date.parse('2026-10-20T18:00:00Z');
INDEX = [
  { phone: '+14255550103', name: 'Tagged Tom', tags: ['Hanger'], status: 'won', sourceAt: oct },
  { phone: '+14255550104', name: 'Old Olive', tags: ['hanger'], status: 'won', sourceAt: Date.parse('2026-06-01') },
  { phone: '+14255550101', name: 'Dana', tags: ['hanger'], status: 'active', sourceAt: oct },
];
BOOKINGS = Array.from({ length: 6 }, (_, i) => ({ id: 'b' + i, phone: '+1425555020' + i, name: 'B' + i, address: '1 Main St', city: 'Mill Creek', createdAt: oct + i }));
BOOKINGS.push({ id: 'old', phone: '+14255550299', address: '2 Main St', city: 'Everett', createdAt: Date.parse('2026-05-01') });
// Money only counts from October 2026, when the hangers go out. Before then
// the window is empty on purpose; after, this month's jobs are in it.
const thisMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
const inWindow = thisMonth >= '2026-10';
MONTHS[inWindow ? thisMonth : '2026-10'] = { entries: [
  { type: 'job', phone: '+14255550103', amount: 409 },
  { type: 'job', phone: '+14255550103', amount: 125 },
  { type: 'expense', phone: '+14255550103', amount: 50 },
] };
r = (await H.apiHangers()).__json;
ok('a tagged conversation since the hangers counts', r.leads['+14255550103'] && r.leads['+14255550103'].how === 'tag', r.leads);
ok('a tag from before the hangers does not', !r.leads['+14255550104']);
ok('a QR credit is not overwritten by its tag', r.leads['+14255550101'].how === 'qr');
ok(inWindow ? 'money is job entries only, summed per phone' : 'no money counted before the hangers go out',
  inWindow ? r.revenue['+14255550103'] === 534 : !Object.keys(r.revenue).length, r.revenue);
ok('only bookings since the hangers are sent', r.bookings.length === 6 && !r.bookings.some((b) => b.id === 'old'));
ok('four geocoded per load, not all six', GEOCALLS === 4 && r.bookings.filter((b) => b.geo).length === 4, GEOCALLS);
r = (await H.apiHangers()).__json;
ok('the rest catch up on the next load', GEOCALLS === 6 && r.bookings.every((b) => b.geo && b.geo.lat === 47.83), GEOCALLS);
ok('names and status come along for credited phones', r.people['+14255550103'].status === 'won');

section('Money, with the window open');
// Same code with the start moved to this month, so the summing is exercised
// whatever today's date is.
const H2 = new Function(...Object.keys(ctx), CODE.replace(constant('HANGER_SINCE'), `const HANGER_SINCE = '${thisMonth}-01';`) + `
  return { apiHangers };`)(...Object.values(ctx));
MONTHS[thisMonth] = MONTHS[inWindow ? thisMonth : '2026-10'];
r = (await H2.apiHangers()).__json;
ok('job entries summed per phone, expenses left out', r.revenue['+14255550103'] === 534, r.revenue);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
