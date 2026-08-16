// The Google Sheets money logger: the pure half of sheets/Code.js — the bit that
// turns a typed row into an entry the worker will accept. Everything else in that
// file is Apps Script plumbing that can only run inside Google.
//
// This suite matters because the sheet is a second front door to the real money
// ledger. A row that maps wrong doesn't throw — it silently books income as an
// expense, or files it on the wrong day.
//
//   node test/sheets.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sheets', 'Code.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// The file is written so nothing runs at load time — no Apps Script service is
// touched until a function is called, which is what makes this possible at all.
// eslint-disable-next-line no-new-func
const S = new Function('module', SRC + '\nreturn module.exports;')({ exports: {} });

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

console.log('\n=== what a row says it is ===');
check('a job',            S.whatToType_('Detail job'), { type: 'job' });
check('labor pay',        S.whatToType_('Pay JP'), { type: 'jp' });
check('a renamed helper', S.whatToType_('Pay Marcus'), { type: 'jp' });
check('an expense',       S.whatToType_('Fuel'), { type: 'exp', cat: 'fuel' });
check('the odd one out',  S.whatToType_('Phone/net'), { type: 'exp', cat: 'phone' });
check('typed, not picked', S.whatToType_('gas'), { type: 'exp', cat: 'fuel' });
check('personal',         S.whatToType_('Personal'), { type: 'personal' });
check('left blank',       S.whatToType_(''), null);
check('nonsense',         S.whatToType_('asdf'), null);

console.log('\n=== the date on the cell is the date on the entry ===');
// A Date from a sheet cell arrives already shifted into the sheet's timezone, so
// the local getters are correct and toISOString() would be a day early at night.
check('a real Date',      S.dateStr_(new Date(2026, 7, 16, 23, 30)), '2026-08-16');
check('already ISO',      S.dateStr_('2026-08-16'), '2026-08-16');
check('typed 8/16/26',    S.dateStr_('8/16/26'), '2026-08-16');
check('typed 8/16/2026',  S.dateStr_('8/16/2026'), '2026-08-16');
check('empty',            S.dateStr_(''), '');
check('garbage',          S.dateStr_('sometime tuesday'), '');

console.log('\n=== amounts ===');
check('plain number',     S.num_(120), 120);
check('typed with a $',   S.num_('$120.50'), 120.5);
check('blank is zero',    S.num_(''), 0);

console.log('\n=== a row becomes an entry ===');
const day = new Date(2026, 7, 16);
check('the three-column case', S.rowToEntry_({ date: day, what: 'Detail job', amount: 250 }).entry,
  { type: 'job', amount: 250, date: '2026-08-16' });
check('rounds to cents', S.rowToEntry_({ date: day, what: 'Fuel', amount: 43.456 }).entry,
  { type: 'exp', amount: 43.46, date: '2026-08-16', cat: 'fuel' });
check('job detail rides along', S.rowToEntry_({
  date: day, what: 'Detail job', amount: 300, customer: 'Dana', phone: '425-555-0100',
  service: 'Full detail', method: 'Venmo', city: 'Snohomish', vehicle: 'SUV',
  hours: 3, jpCost: 60, materials: 12, owed: 50, note: 'second car next week',
}).entry, {
  type: 'job', amount: 300, date: '2026-08-16', note: 'second car next week',
  name: 'Dana', phone: '425-555-0100', service: 'Full detail', method: 'Venmo',
  city: 'Snohomish', veh: 'SUV', hours: 3, jp: 60, mat: 12, owed: 50,
});
check('job-only fields stay off an expense',
  Object.keys(S.rowToEntry_({ date: day, what: 'Fuel', amount: 40, customer: 'Dana', hours: 3 }).entry).sort(),
  ['amount', 'cat', 'date', 'type']);
check('personal labels itself from the note',
  S.rowToEntry_({ date: day, what: 'Personal', amount: 60, note: 'groceries' }).entry.cat, 'groceries');

console.log('\n=== a row that is not ready says so instead of posting ===');
check('no amount',   S.rowToEntry_({ date: day, what: 'Fuel', amount: '' }).error, 'needs an amount');
check('zero',        S.rowToEntry_({ date: day, what: 'Fuel', amount: 0 }).error, 'needs an amount');
check('negative',    S.rowToEntry_({ date: day, what: 'Fuel', amount: -20 }).error, 'needs an amount');
check('no What',     S.rowToEntry_({ date: day, what: '', amount: 20 }).error, 'pick a "What"');
check('no date',     S.rowToEntry_({ date: '', what: 'Fuel', amount: 20 }).error, 'bad date');
check('nothing posts when it errors', S.rowToEntry_({ date: day, what: '', amount: 20 }).entry, undefined);

console.log('\n=== editing a synced row updates it, and can move months ===');
const moved = S.rowToEntry_({ date: new Date(2026, 8, 2), what: 'Fuel', amount: 55, id: 'abc123|2026-08-16' }).entry;
check('keeps the id',        moved.id, 'abc123');
check('remembers where it was filed', moved.origDate, '2026-08-16');
check('new date wins',       moved.date, '2026-09-02');
const fresh = S.rowToEntry_({ date: day, what: 'Fuel', amount: 55 }).entry;
check('an unsynced row has no id', fresh.id, undefined);

console.log('\n=== the sheet and the worker agree on the words ===');
// If MONEY_CATS ever grows a category, the dropdown has to grow with it or the
// new button exists in the app and nowhere here.
const workerCats = WORKER.match(/const MONEY_CATS = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('same categories, same order', S.CATS.map((c) => c[1]), workerCats);
const workerTypes = WORKER.match(/const MONEY_TYPES = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('every type the sheet can send is a type the worker knows',
  ['job', 'jp', 'exp', 'personal'].filter((t) => workerTypes.indexOf(t) < 0), []);

console.log('\n=== staying logged in ===');
check('one Set-Cookie',   S.parseSetCookie_('mkd_auth=tok123; HttpOnly; Secure; Path=/'), 'mkd_auth=tok123');
check('several',          S.parseSetCookie_(['other=1; Path=/', 'mkd_auth=tok9; HttpOnly']), 'mkd_auth=tok9');
check('none',             S.parseSetCookie_(undefined), '');
check('not ours',         S.parseSetCookie_('sessionid=abc'), '');

console.log('\n=== a swipe in the mobile app must not delete real money ===');
check('nothing here calls the delete endpoint', /api\/money\/delete/.test(SRC), false);
check('tidying up only touches rows already logged', /indexOf\('✓'\) === 0/.test(SRC), true);

console.log('\n=== how it reads back ===');
check('job',      S.entryLabel_({ type: 'job' }, {}), 'Detail job');
check('labor',    S.entryLabel_({ type: 'jp' }, { jpName: 'Marcus' }), 'Pay Marcus');
check('expense',  S.entryLabel_({ type: 'exp', cat: 'supplies' }, {}), 'Supplies');
check('unknown category falls back', S.entryLabel_({ type: 'exp', cat: 'nope' }, {}), 'Misc');

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
