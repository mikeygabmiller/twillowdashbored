// The QQC quote log behind Analytics → Quotes. The risky parts are (a) the log
// must never cost a submission — logQuote is best-effort and swallows its own
// failures, (b) a quote belongs to Mikey's local calendar month, not UTC's, or a
// late-evening quote lands in tomorrow, and (c) the form posts to Web3Forms and
// here in parallel and customers re-tap submit, so the same quote arrives twice.
//
//   node test/quotes.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit tests — the Worker's functions are module-private,
// so they're pulled out by name rather than exported purely for tests.
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

// KV is a plain Map, so a test can also assert how MANY writes happened — the
// whole storage shape exists to keep a quote at one write and a month at one doc.
function world({ tz = 'America/Los_Angeles', now = Date.now() } = {}) {
  const store = new Map();
  const w = { store, writes: 0, reads: 0 };
  let n = 0;
  w.deps = {
    quotesKey: (m) => 'quotes:m:' + m,
    kv: () => ({
      get: async (k, opt) => {
        w.reads++;
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.writes++; store.set(k, v); },
    }),
    loadConfig: async () => ({ tz }),
    genId: () => 'id' + (++n),
    localDateStr: (ts, z) => new Date(ts).toLocaleDateString('en-CA', { timeZone: z || tz }),
    prevMonthKey: (m) => {
      const y = +m.slice(0, 4), mo = +m.slice(5, 7);
      return mo === 1 ? (y - 1) + '-12' : y + '-' + String(mo - 1).padStart(2, '0');
    },
    json: (obj, status = 200) => ({ _json: obj, status }),
    cors: (r) => r,
    Response: class { constructor(body, init) { this.body = body; this.init = init; } },
  };
  w.now = now;
  return w;
}

const NAMES = ['quotesKey', 'kv', 'loadConfig', 'genId', 'localDateStr', 'prevMonthKey', 'json', 'cors', 'Response'];
const BODY =
  lift('loadQuoteMonth') + '\n' + lift('saveQuoteMonth') + '\n' + lift('normalizeQuote') + '\n' +
  lift('logQuote') + '\n' + lift('quoteWindow') + '\n' + lift('quoteMonthsParam') + '\n' +
  lift('apiQuotes') + '\n' + lift('apiQuotesExport') + '\n' + lift('apiQuotesImport') + '\n' +
  'return { logQuote, apiQuotes, apiQuotesExport, apiQuotesImport, normalizeQuote, loadQuoteMonth };';
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

const req = (body) => ({ json: async () => body });
const url = (u) => new URL(u, 'https://x');
const quote = (over = {}) => Object.assign({
  name: 'Ruth Alvarez', phone: '+14255550101', total: 265,
  vehicle: 'Sedan', condition: 'Average', services: 'Interior Detail',
}, over);

console.log('\n=== a quote is shaped and priced before it is stored ===');
{
  const w = world(); const M = build(w);
  const e = M.normalizeQuote(quote({ ts: Date.parse('2026-07-04T18:00:00Z') }), 'America/Los_Angeles');
  check('keeps the dollar amount', e.total, 265);
  check('stamps the local date',   e.date, '2026-07-04');
  check('defaults to a quote',     e.type, 'quote');
  check('joins a services array',  M.normalizeQuote(quote({ services: ['Full Detail', 'Wax'] }), 'UTC').services, 'Full Detail, Wax');
  check('a nameless row is junk',  M.normalizeQuote({ total: 100 }, 'UTC'), null);
  check('a negative price is 0',   M.normalizeQuote(quote({ total: -50 }), 'UTC').total, 0);
}

console.log('\n=== a quote belongs to Mikey\'s calendar day, not UTC\'s ===');
{
  // The real case: an 02:46Z email on Aug 8 is a quote he took on the evening of
  // Aug 7. Bucketing it by UTC would file it in the wrong day — and, at a month
  // boundary, the wrong month entirely.
  const w = world(); const M = build(w);
  await M.logQuote(quote({ ts: Date.parse('2026-08-08T02:46:26Z') }));
  const d = (await M.apiQuotes(url('/api/quotes?months=3')))._json;
  check('filed on the local date', d.entries[0].date, '2026-08-07');
  check('and in the local month',  d.months.map((m) => m.month).includes('2026-08'), true);
}

console.log('\n=== the double-fire guard ===');
{
  const w = world(); const M = build(w);
  const ts = Date.parse('2026-07-04T18:00:00Z');
  await M.logQuote(quote({ ts }));
  await M.logQuote(quote({ ts: ts + 60000 }));           // re-tapped a minute later
  let d = (await M.apiQuotes(url('/api/quotes')))._json;
  check('the same quote lands once', d.summary.count, 1);

  await M.logQuote(quote({ ts: ts + 900000 }));           // 15 min later — a real second quote
  d = (await M.apiQuotes(url('/api/quotes')))._json;
  check('but a later one is kept',   d.summary.count, 2);

  await M.logQuote(quote({ ts: ts + 60000, total: 410 })); // same minute, different price
  d = (await M.apiQuotes(url('/api/quotes')))._json;
  check('a different price is kept', d.summary.count, 3);
}

console.log('\n=== logging can never cost a submission ===');
{
  // The lead alert and the customer's auto-text have already happened by the time
  // logQuote runs. If KV is throwing, the log is what gets dropped — not the call.
  const w = world(); w.deps.kv = () => ({ get: async () => { throw new Error('KV down'); }, put: async () => {} });
  const M = build(w);
  let threw = false;
  try { await M.logQuote(quote()); } catch { threw = true; }
  check('a KV failure is swallowed', threw, false);
}

console.log('\n=== the rollup the Quotes view draws ===');
{
  const w = world(); const M = build(w);
  const at = (iso, over) => M.logQuote(quote(Object.assign({ ts: Date.parse(iso) }, over)));
  await at('2026-06-10T18:00:00Z', { total: 200, phone: '+1360555001' });
  await at('2026-06-20T18:00:00Z', { total: 300, phone: '+1360555002' });
  await at('2026-07-05T18:00:00Z', { total: 400, phone: '+1360555003' });
  const d = (await M.apiQuotes(url('/api/quotes?months=3')))._json;
  check('every quote comes back',   d.summary.count, 3);
  check('summed',                   d.summary.value, 900);
  check('averaged',                 d.summary.avg, 300);
  check('best one surfaced',        d.summary.best, 400);
  check('newest first',             d.entries.map((e) => e.total), [400, 300, 200]);
  const by = Object.fromEntries(d.months.map((m) => [m.month, m]));
  check('June bucketed',            [by['2026-06'].count, by['2026-06'].value], [2, 500]);
  check('July bucketed',            [by['2026-07'].count, by['2026-07'].value], [1, 400]);
  check('months plot oldest→newest', d.months[0].month < d.months[d.months.length - 1].month, true);
  check('a quiet month is a zero',  d.months.some((m) => m.count === 0), true);
}

console.log('\n=== a booking with no price must not drag the average down ===');
{
  const w = world(); const M = build(w);
  await M.logQuote(quote({ ts: Date.parse('2026-07-05T18:00:00Z'), total: 300, phone: '+1360555001' }));
  await M.logQuote(quote({ ts: Date.parse('2026-07-06T18:00:00Z'), total: 0, phone: '+1360555002', type: 'booking', appointment: 'Fri, Aug 7 at 3:30 PM' }));
  const d = (await M.apiQuotes(url('/api/quotes')))._json;
  check('both are listed',        d.summary.count, 2);
  check('average ignores the $0', d.summary.avg, 300);
  check('bookings tallied apart', d.summary.booked, 1);
}

console.log('\n=== the backfill import ===');
{
  const w = world(); const M = build(w);
  const entries = [
    { date: '2026-06-02T22:41:48Z', name: 'Surrey McEwen', total: 310 },
    { date: '2026-06-13T17:55:51Z', name: 'Maxine Rogalski', total: 290 },
    { date: '2026-07-06T23:14:28Z', name: 'Brian Richards', total: 449 },
    // No date: it would otherwise be filed under today, inventing a date.
    { name: 'undated row', total: 100 },
    // No name: nothing to show in the list.
    { date: '2026-06-05T18:00:00Z', total: 120 },
  ];
  const r = (await M.apiQuotesImport(req({ entries })))._json;
  check('the real rows store',      r.stored, 3);
  check('undated + nameless go',    r.skipped, 2);
  check('two months touched',       r.months, 2);
  check('one write per month',      w.writes, 2);
  check('today was not invented',   [...w.store.keys()].sort(), ['quotes:m:2026-06', 'quotes:m:2026-07']);

  const before = w.writes;
  const again = (await M.apiQuotesImport(req({ entries })))._json;
  check('re-import adds nothing',   again.skipped, 5);
  const d = (await M.apiQuotes(url('/api/quotes?months=6')))._json;
  check('and does not double',      d.summary.count, 3);
  check('rewrites are bounded',     w.writes - before <= 2, true);

  // A bare YYYY-MM-DD has to work too — that's what a spreadsheet paste looks like.
  const plain = (await M.apiQuotesImport(req({ entries: [{ date: '2026-05-08', name: 'adam hineline', total: 390 }] })))._json;
  check('a plain date imports',     plain.stored, 1);
}

console.log('\n=== import refuses junk instead of half-storing it ===');
{
  const w = world(); const M = build(w);
  check('no entries array',  (await M.apiQuotesImport(req({})))._json.error, 'entries_required');
  check('unparseable body',  (await M.apiQuotesImport({ json: async () => { throw new Error('nope'); } }))._json.error, 'bad_json');
  check('absurdly large',    (await M.apiQuotesImport(req({ entries: new Array(2001).fill({ name: 'x', total: 1 }) })))._json.error, 'too_many');
  check('nothing was stored', w.writes, 0);
}

console.log('\n=== the window is clamped so a URL cannot ask for 500 months ===');
{
  const w = world(); const M = build(w);
  check('default is 6',  (await M.apiQuotes(url('/api/quotes')))._json.months.length, 6);
  check('honours ?months', (await M.apiQuotes(url('/api/quotes?months=3')))._json.months.length, 3);
  check('capped at 24',  (await M.apiQuotes(url('/api/quotes?months=500')))._json.months.length, 24);
  check('junk falls back', (await M.apiQuotes(url('/api/quotes?months=abc')))._json.months.length, 6);
}

console.log('\n=== CSV export ===');
{
  const w = world(); const M = build(w);
  await M.logQuote(quote({ ts: Date.parse('2026-07-05T18:00:00Z'), name: 'Rogers, Maxine', services: 'Full Detail, Wax' }));
  const csv = (await M.apiQuotesExport(url('/api/quotes/export?months=3'))).body;
  const lines = csv.trim().split('\n');
  check('header + one row',       lines.length, 2);
  check('header names the columns', lines[0], 'date,time,name,phone,quote,type,vehicle,condition,services,location,appointment');
  check('commas are quoted',      /"Rogers, Maxine"/.test(lines[1]), true);
  check('so are the services',    /"Full Detail, Wax"/.test(lines[1]), true);
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
