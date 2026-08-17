// The Google Docs money notepad: the line parser in gdoc/Code.js.
//
// This one matters more than the Sheets suite. There, you pick "Fuel" from a
// dropdown. Here you say it into a phone in a moving truck and a regex decides
// whether $250 of income becomes income or an expense. Every wrong guess is a
// wrong number in the profit report, and nothing on screen looks broken.
//
//   node test/gdoc.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'gdoc', 'Code.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// eslint-disable-next-line no-new-func
const G = new Function('module', SRC + '\nreturn module.exports;')({ exports: {} });

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const TODAY = '2026-08-16';
const parse = (t, extra) => G.parseLine_(t, Object.assign({ today: TODAY, jpName: 'JP' }, extra || {}));

console.log('\n=== the lines you actually type ===');
check('a job',        parse('250 job Dana venmo').entry,
  { type: 'job', amount: 250, date: TODAY, name: 'Dana', method: 'Venmo' });
check('an expense',   parse('40 fuel').entry, { type: 'exp', amount: 40, date: TODAY, cat: 'fuel' });
check('paying the helper', parse('60 jp').entry, { type: 'jp', amount: 60, date: TODAY });
check('personal',     parse('35 personal groceries').entry,
  { type: 'personal', amount: 35, date: TODAY, note: 'groceries', cat: 'groceries' });
check('the works',    parse('300 job Mike full truck cash').entry,
  { type: 'job', amount: 300, date: TODAY, name: 'Mike', method: 'Cash', service: 'Full detail', veh: 'Truck' });
// "Full detail" is two words, and half of it is a service on its own. Eating the
// next word unconditionally is what loses the truck in the line above.
check('the second word goes with it when it is said',
  parse('300 job full detail Mike').entry, { type: 'job', amount: 300, date: TODAY, name: 'Mike', service: 'Full detail' });

console.log('\n=== dictation does not respect word order ===');
// "job Dana 250" and "250 job Dana" have to land identically, because whichever
// one comes out of the mic is a coin flip.
check('amount last',  parse('job Dana 250').entry, parse('250 job Dana').entry);
check('amount middle', parse('job 250 Dana').entry, parse('250 job Dana').entry);
check('a typed $',    parse('$250 job Dana').entry.amount, 250);
check('cents',        parse('43.56 fuel').entry.amount, 43.56);
check('trailing punctuation', parse('40 fuel.').entry.cat, 'fuel');

console.log('\n=== the words a person actually says ===');
const catOf = (s) => { const r = parse(s); return r.entry ? (r.entry.cat || r.entry.type) : r.error; };
check('gas is fuel',      catOf('40 gas'), 'fuel');
check('chems are supplies', catOf('80 chems'), 'supplies');
check('lunch is food',    catOf('14 lunch'), 'food');
check('a wash is a job',  catOf('90 wash Kelly'), 'job');
check('helper is labor',  catOf('75 helper'), 'jp');
check('the helper by name', G.parseLine_('75 marcus', { today: TODAY, jpName: 'Marcus' }).entry.type, 'jp');

console.log('\n=== a line it cannot read must not guess ===');
// Guessing "expense" on an unrecognised line would quietly bury income. The
// worker defaults an unknown type to an expense, which is exactly why the
// decision has to be refused here instead of sent.
check('no what',       parse('250 Dana venmo').error, 'what was it?');
check('no amount',     parse('job Dana venmo 2 cars').error, undefined); // "2" is an amount
check('truly no amount', parse('job Dana venmo').skip, true);
check('nothing numeric is left alone', parse('remember to call the shop').skip, true);
check('a blank line',  parse('').skip, true);
check('no entry escapes an error', parse('250 Dana venmo').entry, undefined);
check('zero is not an amount', parse('0 fuel').error, 'no amount');

console.log('\n=== backdating ===');
check('8/14',          parse('8/14 120 job Mike').entry.date, '2026-08-14');
check('8/14/25',       parse('8/14/25 120 job Mike').entry.date, '2025-08-14');
check('yesterday',     parse('yesterday 120 job Mike').entry.date, '2026-08-15');
check('today',         parse('today 120 job Mike').entry.date, TODAY);
check('a date with a colon', parse('8/14: 120 job Mike').entry.date, '2026-08-14');
// A bare m/d that is still ahead of us is last year's — logging December's fuel
// on the 2nd of January is a real thing that happens.
check('December, logged in January',
  G.parseLine_('12/28 90 fuel', { today: '2027-01-02', jpName: 'JP' }).entry.date, '2026-12-28');
check('a date is not mistaken for the amount', parse('8/14 120 job Mike').entry.amount, 120);
check('nonsense date is just words', parse('99/99 120 fuel').entry.date, TODAY);

console.log('\n=== which lines are safe to send ===');
const pick = (lines, last) => G.pickLines_(lines, last).lines.map((l) => l.text);
check('the line still under the cursor waits',
  pick(['40 fuel', '250 job Da'], ''), ['40 fuel']);
check('...and goes once it stops changing',
  pick(['40 fuel', '250 job Dana'], '250 job Dana'), ['40 fuel', '250 job Dana']);
check('already logged is skipped',
  pick(['40 fuel   ✓ Fuel $40', '60 jp'], '60 jp'), ['60 jp']);
check('already flagged is skipped',
  pick(['250 Dana   ⚠ what was it?', '60 jp'], '60 jp'), ['60 jp']);
check('our own numbers line is not an entry',
  pick(['— You have $6,140 · this month in $4,210', '60 jp'], '60 jp'), ['60 jp']);
check('blank lines are not lines', pick(['', '  ', '60 jp'], '60 jp'), ['60 jp']);
check('it remembers the last line for next time',
  G.pickLines_(['40 fuel', '250 job Da'], '').finalText, '250 job Da');
check('an empty doc', G.pickLines_([''], ''), { lines: [], finalText: '' });

console.log('\n=== marks ===');
check('a ✓ counts',  G.isMarked_('40 fuel   ✓ Fuel $40'), true);
check('a ⚠ counts',  G.isMarked_('250 Dana   ⚠ what was it?'), true);
check('plain text',  G.isMarked_('40 fuel'), false);

console.log('\n=== the notepad and the worker agree ===');
const workerCats = WORKER.match(/const MONEY_CATS = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('every category the parser can produce is a real one',
  G.WORDS.map((w) => w[1].cat).filter((c) => c && workerCats.indexOf(c) < 0), []);
check('every category has a spoken word for it',
  workerCats.filter((c) => !G.WORDS.some((w) => w[1].cat === c)), []);
check('every category has a label', workerCats.filter((c) => !G.CAT_LABEL[c]), []);
const workerTypes = WORKER.match(/const MONEY_TYPES = \[([^\]]+)\]/)[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
check('every type it can send is one the worker knows',
  G.WORDS.map((w) => w[1].type).filter((t) => workerTypes.indexOf(t) < 0), []);

console.log('\n=== a deleted line is not a deleted entry ===');
check('nothing here calls the delete endpoint', /api\/money\/delete/.test(SRC), false);

console.log('\n=== staying logged in ===');
check('one Set-Cookie', G.parseSetCookie_('mkd_auth=tok1; HttpOnly'), 'mkd_auth=tok1');
check('several',       G.parseSetCookie_(['a=1', 'mkd_auth=tok2; Secure']), 'mkd_auth=tok2');
check('none',          G.parseSetCookie_(undefined), '');

console.log('\n=== how the ✓ reads back ===');
check('job',      G.labelFor_({ type: 'job' }, 'JP'), 'Detail job');
check('labor',    G.labelFor_({ type: 'jp' }, 'Marcus'), 'Pay Marcus');
check('expense',  G.labelFor_({ type: 'exp', cat: 'supplies' }), 'Supplies');
check('personal', G.labelFor_({ type: 'personal' }), 'Personal');

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
