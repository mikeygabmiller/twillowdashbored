// Correcting the balance (#100): the headline said one thing, the pocket said
// $5,000. The fix has to land the number exactly AND leave every logged job,
// expense and pay-out untouched — so the tests below check both halves: the
// arithmetic that solves for the offset, and that not one month doc is rewritten.
//
//   node test/balance.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const UI  = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in src/index.js`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// KV is a plain Map so the tests can assert exactly which keys were written —
// "keep all my history" is a claim about writes, not about the returned number.
function world(months = {}) {
  const store = new Map();
  const w = { store, written: [] };
  for (const m of Object.keys(months)) store.set('money:m:' + m, JSON.stringify({ entries: months[m] }));
  w.deps = {
    MONEY_CFG_KEY: 'money:cfg',
    kv: () => ({
      get: async (k, opt) => {
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.written.push(k); store.set(k, v); },
      list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    }),
    json: (obj, status = 200) => ({ _json: obj, status }),
  };
  return w;
}

const NAMES = ['MONEY_CFG_KEY', 'kv', 'json'];
const BODY =
  liftConst('HERO_METRICS') + '\n' + lift('money2') + '\n' + lift('summarizeMonth') + '\n' + lift('allTimeSummary') + '\n' +
  lift('defaultHero') + '\n' + lift('sanitizeHero') + '\n' + lift('defaultMoneyConfig') + '\n' +
  lift('loadMoneyConfig') + '\n' + lift('apiMoneySetBalance') + '\n' + lift('readJson') + '\n' +
  'return { apiMoneySetBalance, allTimeSummary, sanitizeHero, defaultHero, loadMoneyConfig };';
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

const req = (body) => ({ json: async () => body });
const job = (amount, over = {}) => Object.assign({ id: 'j' + amount, type: 'job', amount, date: '2026-07-04' }, over);
const exp = (amount, over = {}) => Object.assign({ id: 'e' + amount, type: 'fuel', cat: 'fuel', amount, date: '2026-07-04' }, over);

// A ledger that nets $1,200: $2,000 of jobs, $500 of expenses, $300 of labor.
const LEDGER = {
  '2026-06': [job(1200), exp(300)],
  '2026-07': [job(800), exp(200), { id: 'p1', type: 'jp', amount: 300, date: '2026-07-10' }],
};

console.log('\n=== the ledger nets what it nets ===');
{
  const w = world(LEDGER); const M = build(w);
  const at = await M.allTimeSummary();
  check('all-time net across months', at.net, 1200);
  check('all-time gross', at.gross, 2000);
}

console.log('\n=== "I actually have $5,000" ===');
{
  const w = world(LEDGER); const M = build(w);
  const d = (await M.apiMoneySetBalance(req({ balance: 5000 })))._json;
  check('balance lands exactly on the number', d.balance, 5000);
  check('offset is the gap, not the number',   d.adjustment, 3800);
  check('reports what the ledger nets',        d.ledgerNet, 1200);
  check('remembers what it was set to',        d.config.hero.balanceSetTo, 5000);
  check('stamps when it was set',              d.config.hero.balanceSetAt > 0, true);
  check('only the config was written',         w.written, ['money:cfg']);
  check('June is untouched',  JSON.parse(w.store.get('money:m:2026-06')).entries.length, 2);
  check('July is untouched',  JSON.parse(w.store.get('money:m:2026-07')).entries.length, 3);
  check('the ledger still nets the same', (await M.allTimeSummary()).net, 1200);
}

console.log('\n=== the balance keeps moving after the correction ===');
{
  // The whole point of an offset rather than a hard-coded number: log another
  // $450 detail and the headline reads $5,450 without touching the correction.
  const w = world(LEDGER); const M = build(w);
  await M.apiMoneySetBalance(req({ balance: 5000 }));
  const cfg = await M.loadMoneyConfig();
  w.store.set('money:m:2026-08', JSON.stringify({ entries: [job(450, { date: '2026-08-13' })] }));
  const at = await M.allTimeSummary();
  check('new work moves the balance', at.net + cfg.hero.startingBalance, 5450);
  check('the correction itself did not change', cfg.hero.startingBalance, 3800);
}

console.log('\n=== corrections downward, and undoing one ===');
{
  const w = world(LEDGER); const M = build(w);
  const down = (await M.apiMoneySetBalance(req({ balance: 400 })))._json;
  check('a negative offset is allowed', down.adjustment, -800);
  check('and still lands on the number', down.balance, 400);

  const cleared = (await M.apiMoneySetBalance(req({ clear: true })))._json;
  check('clearing drops the offset',    cleared.config.hero.startingBalance, 0);
  check('clearing forgets the stamp',   cleared.config.hero.balanceSetTo, null);
  check('back to the raw ledger net',   cleared.balance, 1200);
}

console.log('\n=== bad input never silently rewrites the balance ===');
{
  const w = world(LEDGER); const M = build(w);
  const bad = await M.apiMoneySetBalance(req({ balance: 'lots' }));
  check('rejected', bad.status, 400);
  check('nothing written', w.written, []);
  const zero = (await M.apiMoneySetBalance(req({ balance: 0 })))._json;
  check('zero is a real answer, not a missing one', zero.balance, 0);
}

console.log('\n=== typing the offset by hand supersedes the correction ===');
{
  const w = world(LEDGER); const M = build(w);
  const set = (await M.apiMoneySetBalance(req({ balance: 5000 })))._json;
  const edited = M.sanitizeHero({ startingBalance: 50 }, set.config.hero);
  check('the new offset sticks',      edited.startingBalance, 50);
  check('the stale "set to" is gone', edited.balanceSetTo, null);
  const untouched = M.sanitizeHero({ title: 'In the bank' }, set.config.hero);
  check('editing something else keeps it', untouched.balanceSetTo, 5000);
}

console.log('\n=== the app wires it up ===');
{
  check('route exists',            /pathname === '\/api\/money\/balance'/.test(SRC), true);
  check('offset = actual − net',   /money2\(target - at\.net\)/.test(SRC), true);
  check('tapping the balance opens the sheet', /heroBal[\s\S]{0,400}?openBalanceSheet\(\)/.test(UI), true);
  check('the customizer offers it too',        /hsFix"\)\.onclick=openBalanceSheet/.test(UI), true);
  check('the sheet posts the real amount',     /post\("\/api\/money\/balance",\{balance:want\}\)/.test(UI), true);
  check('it can be removed',                   /post\("\/api\/money\/balance",\{clear:true\}\)/.test(UI), true);
  check('the sheet promises history is safe',  /Nothing in your history changes/.test(UI), true);
  check('the headline shows what it was set to', /"set to "\+fmtMoney\(hero\.balanceSetTo\)/.test(UI), true);
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
