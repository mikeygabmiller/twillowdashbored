// Ledger seeds: card charges that arrive as a bank screenshot and have to land
// in the ledger without Mikey typing them (#118).
//
// The interesting half isn't the write — it's everything that must NOT happen on
// the ticks after it. The cron runs every minute, so a seed that appends
// unconditionally would put five expenses in the ledger sixty times an hour, and
// one that ignores the stamp would resurrect an entry the moment he deleted it.
//
//   node test/seed.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit suites — the Worker's functions are module-private,
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
// A one-line `const x = …;` / `let x = …;`.
function liftDecl(name) {
  const m = SRC.match(new RegExp(`^(?:const|let) ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`declaration ${name} not found in src/index.js`);
  return m[0];
}
// A multi-line `const x = [ … ];`.
function liftArray(name) {
  const start = SRC.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`array ${name} not found in src/index.js`);
  const end = SRC.indexOf('\n];', start);
  if (end < 0) throw new Error(`could not find end of ${name}`);
  return SRC.slice(start, end + 3);
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// KV as a plain Map, counting reads as well as writes: "it stops looking" is a
// claim about reads, and "it doesn't run again" is a claim about writes.
function world(seed = {}) {
  const store = new Map();
  const w = { store, written: [], read: [] };
  for (const k of Object.keys(seed)) store.set(k, JSON.stringify(seed[k]));
  w.deps = {
    kv: () => ({
      get: async (k, opt) => {
        w.read.push(k);
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.written.push(k); store.set(k, v); },
    }),
  };
  return w;
}

const NAMES = ['kv'];
const BODY =
  liftDecl('MONEY_CATS') + '\n' + liftDecl('MONEY_TYPES') + '\n' + liftDecl('moneyKey') + '\n' +
  lift('money2') + '\n' + lift('genId') + '\n' + lift('normalizePhone') + '\n' +
  lift('sanitizeMoneyEntry') + '\n' + lift('summarizeMonth') + '\n' +
  lift('loadMonth') + '\n' + lift('saveMonth') + '\n' +
  liftDecl('LEDGER_SEED_VERSION') + '\n' + liftDecl('LEDGER_SEED_KEY') + '\n' + liftArray('LEDGER_SEEDS') + '\n' +
  liftDecl('LEDGER_SEEDS_DONE') + '\n' + lift('applyLedgerSeeds') + '\n' +
  'return { applyLedgerSeeds, LEDGER_SEEDS, LEDGER_SEED_VERSION, LEDGER_SEED_KEY, summarizeMonth, loadMonth };';
// Each build() is a fresh isolate: same KV, module state (the "already done"
// flag) reset — which is exactly what a new Worker instance sees.
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

const entriesOf = (w, m) => JSON.parse(w.store.get('money:m:' + m) || '{"entries":[]}').entries;

console.log('\n=== the charges land in the ledger ===');
{
  const w = world(); const M = build(w);
  await M.applyLedgerSeeds();
  const got = entriesOf(w, '2026-08');
  check('all five are logged', got.length, 5);
  check('every one is a business expense', got.every((e) => e.type === 'exp'), true);
  check('dated the day of the charge', [...new Set(got.map((e) => e.date))], ['2026-08-20']);
  check('the fill-up is fuel', got.filter((e) => e.cat === 'fuel').map((e) => e.amount), [25.11]);
  check('the rest is food', got.filter((e) => e.cat === 'food').map((e) => e.amount), [7.61, 4.91, 5.48, 1.19]);
  check('the day totals what the statement did', M.summarizeMonth(got).exp, 44.3);
  check('the note says where it was spent', got[0].note, '76 Express, Snohomish · card 1917');
  check('one write for the month, one for the stamp', w.written, ['money:m:2026-08', 'money:seed']);
}

console.log('\n=== the next tick does nothing ===');
{
  // The cron fires every minute. Without a stamp this is 300 phantom expenses a
  // day — the failure this suite exists for.
  const w = world(); const M = build(w);
  await M.applyLedgerSeeds();
  const after = w.written.length;
  await M.applyLedgerSeeds();
  check('same isolate: no second write', w.written.length, after);
  check('same isolate stops reading too', w.read.filter((k) => k === 'money:seed').length, 1);

  const fresh = build(w);            // a cold isolate: module state gone, KV kept
  await fresh.applyLedgerSeeds();
  check('cold isolate: no second write', w.written.length, after);
  check('still exactly five entries',    entriesOf(w, '2026-08').length, 5);
}

console.log('\n=== a deleted entry stays deleted ===');
{
  const w = world(); const M = build(w);
  await M.applyLedgerSeeds();
  const doc = JSON.parse(w.store.get('money:m:2026-08'));
  doc.entries = doc.entries.filter((e) => e.id !== 'sd1-safeway');   // Mikey deletes one
  w.store.set('money:m:2026-08', JSON.stringify(doc));

  await build(w).applyLedgerSeeds();
  check('the seed does not bring it back', entriesOf(w, '2026-08').length, 4);
  check('and it is the right one missing', entriesOf(w, '2026-08').some((e) => e.id === 'sd1-safeway'), false);
}

console.log('\n=== an edited entry is his, not the seed\'s ===');
{
  // Half-written state: the month landed, the stamp didn't. The next tick must
  // recognise its own ids rather than appending a second copy — and must not
  // overwrite a category he has since changed.
  const w = world(); const M = build(w);
  await M.applyLedgerSeeds();
  const doc = JSON.parse(w.store.get('money:m:2026-08'));
  doc.entries.find((e) => e.id === 'sd1-chickfila').cat = 'supplies';
  w.store.set('money:m:2026-08', JSON.stringify(doc));
  w.store.delete('money:seed');

  await build(w).applyLedgerSeeds();
  const got = entriesOf(w, '2026-08');
  check('no duplicates', got.length, 5);
  check('his category survives', got.find((e) => e.id === 'sd1-chickfila').cat, 'supplies');
}

console.log('\n=== existing history is left alone ===');
{
  const w = world({ 'money:m:2026-08': { entries: [{ id: 'job1', type: 'job', date: '2026-08-19', amount: 260, ts: 1 }] } });
  await build(w).applyLedgerSeeds();
  const got = entriesOf(w, '2026-08');
  check('the job is still there', got.filter((e) => e.type === 'job').length, 1);
  check('with the seeds added around it', got.length, 6);
}

console.log('\n=== the batch is well-formed ===');
{
  const w = world(); const M = build(w);
  check('ids are unique',       new Set(M.LEDGER_SEEDS.map((s) => s.id)).size, M.LEDGER_SEEDS.length);
  check('ids fit the 24-char field', M.LEDGER_SEEDS.every((s) => s.id.length <= 24), true);
  check('every row carries a batch', M.LEDGER_SEEDS.every((s) => s.v >= 1), true);
  check('the stamp covers every row', Math.max(...M.LEDGER_SEEDS.map((s) => s.v)), M.LEDGER_SEED_VERSION);
  check('a newer batch would still be pending', M.LEDGER_SEEDS.some((s) => s.v > M.LEDGER_SEED_VERSION), false);
}

console.log('\n=== the cron runs it ===');
{
  check('wired into runCron',            /await applyLedgerSeeds\(\)\.catch/.test(SRC), true);
  check('a seed failure cannot kill the cron', /applyLedgerSeeds\(\)\.catch\(\(\) => \{\}\)/.test(SRC), true);
  check('only newer batches apply',      /\(s\.v \|\| 1\) > applied/.test(SRC), true);
  check('the stamp is written last',     SRC.indexOf('kv().put(LEDGER_SEED_KEY') > SRC.indexOf('await saveMonth(month, doc)'), true);
  check('build fingerprints match',
    (SRC.match(/^const BUILD = '(.+)';$/m) || [])[1],
    (fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').match(/var APP_BUILD="(.+)";/) || [])[1]);
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
