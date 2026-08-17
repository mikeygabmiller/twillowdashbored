// The Google Form money logger: turning a submitted response into a ledger entry.
//
// The form's required fields catch most bad input before it ever gets here, which
// is exactly why this suite matters — the failure mode left is the quiet one. A
// response that maps to the wrong type doesn't error, it just books income as an
// expense and the profit report goes wrong with nothing on screen looking broken.
//
//   node test/gform.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gform', 'Code.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// eslint-disable-next-line no-new-func
const F = new Function('module', SRC + '\nreturn module.exports;')({ exports: {} });
const Q = F.Q;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const TODAY = '2026-08-16';
const submit = (a, opts) => F.answersToEntry_(a, Object.assign({ today: TODAY, jpName: 'JP' }, opts || {}));

console.log('\n=== the three-tap case ===');
check('a job', submit({ [Q.WHAT]: 'Detail job', [Q.AMOUNT]: '250' }).entry,
  { type: 'job', amount: 250, date: TODAY });
check('an expense', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40' }).entry,
  { type: 'exp', amount: 40, date: TODAY, cat: 'fuel' });
check('paying the helper', submit({ [Q.WHAT]: 'Pay JP', [Q.AMOUNT]: '60' }).entry,
  { type: 'jp', amount: 60, date: TODAY });
check('a renamed helper still means labor',
  submit({ [Q.WHAT]: 'Pay Marcus', [Q.AMOUNT]: '60' }, { jpName: 'Marcus' }).entry.type, 'jp');
check('the odd category out', submit({ [Q.WHAT]: 'Phone/net', [Q.AMOUNT]: '80' }).entry.cat, 'phone');

console.log('\n=== the free-text box means different things ===');
// One box, two jobs: on a job it is the customer, on anything else it is what the
// money went on. Putting "Dana" in a note field would lose the per-customer
// spend the roster view joins against.
check('on a job it is the customer',
  submit({ [Q.WHAT]: 'Detail job', [Q.AMOUNT]: '250', [Q.WHO]: 'Dana' }).entry.name, 'Dana');
check('on a job it is not also the note',
  submit({ [Q.WHAT]: 'Detail job', [Q.AMOUNT]: '250', [Q.WHO]: 'Dana' }).entry.note, undefined);
check('on an expense it is the note',
  submit({ [Q.WHAT]: 'Supplies', [Q.AMOUNT]: '80', [Q.WHO]: 'ceramic spray' }).entry.note, 'ceramic spray');
check('on an expense it is not a customer',
  submit({ [Q.WHAT]: 'Supplies', [Q.AMOUNT]: '80', [Q.WHO]: 'ceramic spray' }).entry.name, undefined);
check('personal labels itself',
  submit({ [Q.WHAT]: 'Personal', [Q.AMOUNT]: '35', [Q.WHO]: 'groceries' }).entry.cat, 'groceries');
check('both boxes on an expense join up',
  submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.WHO]: 'Arco', [Q.NOTE]: 'topped off' }).entry.note,
  'Arco — topped off');

console.log('\n=== page two ===');
check('everything filled in', submit({
  [Q.WHAT]: 'Detail job', [Q.AMOUNT]: '300', [Q.WHO]: 'Mike', [Q.MORE]: 'Add detail →',
  [Q.METHOD]: 'Venmo', [Q.SERVICE]: 'Full detail', [Q.VEHICLE]: 'Truck',
  [Q.HOURS]: '3', [Q.LABOR]: '60', [Q.MAT]: '12', [Q.OWED]: '50',
  [Q.DATE]: '2026-08-14', [Q.NOTE]: 'second car next week',
}).entry, {
  type: 'job', amount: 300, date: '2026-08-14', name: 'Mike', method: 'Venmo',
  service: 'Full detail', veh: 'Truck', hours: 3, jp: 60, mat: 12, owed: 50,
  note: 'second car next week',
});
check('a blank date is today', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.DATE]: '' }).entry.date, TODAY);
check('a real date wins', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.DATE]: '2026-07-02' }).entry.date, '2026-07-02');
check('a junk date falls back to today', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.DATE]: 'tuesday' }).entry.date, TODAY);
check('the branching answer is not data',
  Object.keys(submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.MORE]: 'Nope — log it' }).entry).sort(),
  ['amount', 'cat', 'date', 'type']);
check('job-only detail stays off an expense',
  Object.keys(submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '40', [Q.HOURS]: '3', [Q.VEHICLE]: 'Truck', [Q.OWED]: '50' }).entry).sort(),
  ['amount', 'cat', 'date', 'type']);
check('hours are capped', submit({ [Q.WHAT]: 'Detail job', [Q.AMOUNT]: '250', [Q.HOURS]: '500' }).entry.hours, 99);

console.log('\n=== amounts ===');
check('plain', F.num_('250'), 250);
check('typed with a $', F.num_('$250.50'), 250.5);
check('rounds to cents', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '43.456' }).entry.amount, 43.46);
check('empty', F.num_(''), 0);
// The confirmation page is a sentence a person reads, so these get separators.
check('under a thousand',  F.money_(940), '$940');
check('thousands',         F.money_(6140), '$6,140');
check('millions',          F.money_(1234567.5), '$1,234,567.50');
check('cents survive',     F.money_(43.5), '$43.50');
check('exactly a thousand', F.money_(1000), '$1,000');
check('negative',          F.money_(-1500), '-$1,500');
check('zero',              F.money_(0), '$0');

console.log('\n=== nothing half-formed reaches the ledger ===');
check('no amount',   submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '' }).error, 'no amount');
check('zero',        submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '0' }).error, 'no amount');
check('negative',    submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '-20' }).error, 'no amount');
check('no what',     submit({ [Q.AMOUNT]: '20' }).error, 'no "what"');
check('an unknown what is refused, not guessed', submit({ [Q.WHAT]: 'Groceries?', [Q.AMOUNT]: '20' }).error, 'no "what"');
check('an error carries no entry', submit({ [Q.AMOUNT]: '20' }).entry, undefined);
check('no today and no date', submit({ [Q.WHAT]: 'Fuel', [Q.AMOUNT]: '20' }, { today: '' }).error, 'no date');

console.log('\n=== the choices are built from live settings ===');
check('the default set', F.whatChoices_({}),
  ['Detail job', 'Pay JP', 'Fuel', 'Supplies', 'Equipment', 'Food', 'Bills',
    'Marketing', 'Insurance', 'Phone/net', 'Misc', 'Personal']);
check('the helper by name', F.whatChoices_({ jpName: 'Marcus' })[1], 'Pay Marcus');
check('a category switched off in the app is gone here too',
  F.whatChoices_({ catsOff: ['food', 'marketing'] }).indexOf('Food'), -1);
check('...and the rest stay', F.whatChoices_({ catsOff: ['food'] }).length, 11);
check('personal switched off', F.whatChoices_({ personalEnabled: false }).indexOf('Personal'), -1);
// Whatever the form can offer, the parser has to be able to read back.
check('every choice maps to a kind',
  F.whatChoices_({ jpName: 'Marcus' }).filter((c) => !F.whatToKind_(c, 'Marcus')), []);

console.log('\n=== submitting twice must not log twice ===');
check('an id is remembered',      F.rememberSynced_([], 'r1'), ['r1']);
check('the same id once only',    F.rememberSynced_(['r1'], 'r1'), ['r1']);
check('newest last',              F.rememberSynced_(['r1'], 'r2'), ['r1', 'r2']);
check('the oldest falls off first', F.rememberSynced_(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
check('the cap holds',            F.rememberSynced_(['a', 'b', 'c'], 'd', 3).length, 3);

console.log('\n=== the page you see after Submit ===');
const NUMS = { summary: { gross: 4210, exp: 700, jp: 280, net: 3230, jobs: 14, owed: 0 },
  allTime: { net: 6000 }, config: { hero: { startingBalance: 140 } } };
check('it says when it was true', /As of Sun 2:14 PM:/.test(F.confirmationText_(NUMS, 'Sun 2:14 PM', 0)), true);
check('the balance adds the offset', /You have \$6,140/.test(F.confirmationText_(NUMS, 'x', 0)), true);
check('spend is expenses plus labor', /out \$980/.test(F.confirmationText_(NUMS, 'x', 0)), true);
check('no numbers is still a confirmation', F.confirmationText_(null, 'x', 0), '✓ Logged.');
check('stuck entries are surfaced', /2 entries have not reached the dashboard/.test(F.confirmationText_(null, 'x', 2)), true);
check('one stuck entry reads right', /1 entry has not reached/.test(F.confirmationText_(NUMS, 'x', 1)), true);
check('nothing stuck, nothing said', /not reached/.test(F.confirmationText_(NUMS, 'x', 0)), false);

console.log('\n=== the form and the worker agree ===');
const workerCats = WORKER.match(/const MONEY_CATS = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('same categories, same order', F.CATS.map((c) => c[1]), workerCats);
const workerTypes = WORKER.match(/const MONEY_TYPES = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('every type it can send is one the worker knows',
  ['job', 'jp', 'exp', 'personal'].filter((t) => workerTypes.indexOf(t) < 0), []);

console.log('\n=== the shape of the form is the design ===');
// Three taps means page 1 submits on its own. If the page break ever stops
// defaulting to SUBMIT, every entry silently grows a second screen.
check('page one submits by itself', /setGoToPage\(FormApp\.PageNavigationType\.SUBMIT\)/.test(SRC), true);
check('a second entry in one day is allowed', /setLimitOneResponsePerUser\(false\)/.test(SRC), true);
check('logging three things in a row stays one tap each', /setShowLinkToRespondAgain\(true\)/.test(SRC), true);
check('the amount box brings up a number pad', /requireNumberGreaterThan\(0\)/.test(SRC), true);
check('nothing here calls the delete endpoint', /api\/money\/delete/.test(SRC), false);

console.log('\n=== staying logged in ===');
check('one Set-Cookie', F.parseSetCookie_('mkd_auth=tok1; HttpOnly'), 'mkd_auth=tok1');
check('several',       F.parseSetCookie_(['a=1', 'mkd_auth=tok2; Secure']), 'mkd_auth=tok2');
check('none',          F.parseSetCookie_(undefined), '');

console.log('\n=== setup must not depend on a menu that may never appear ===');
// A bound script's custom menu can silently fail to turn up, and getUi() prompts
// throw when a function is run from the Apps Script editor — so the obvious
// fallback was broken too. setUpHere() is the path that works either way.
check('there is a setup that needs no UI', /function setUpHere\(/.test(SRC), true);
check('the real work has no prompts in it',
  /function finishSetup_\(\)[\s\S]*?\n\}/.exec(SRC)[0].indexOf('getUi()'), -1);
check('the menu version delegates instead of duplicating',
  /function setUp\(\)[\s\S]*?\n\}/.exec(SRC)[0].indexOf('finishSetup_()') > 0, true);
check('it says what to do when the URL is missing', /Script Properties/.test(SRC), true);
// There is no web app here. If a doGet ever appears, so does a Deploy step, and
// a deploy URL is exactly what a confused setup lands on.
check('this is not a web app', /function doGet\b/.test(SRC), false);

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
