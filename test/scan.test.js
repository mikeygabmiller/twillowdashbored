// Bank screenshot → ledger: what the model proposes, and what the code refuses
// to take its word for.
//
// The scan itself is one Gemini call, so it isn't the interesting part. The
// interesting part is everything wrapped around it: a charge already in the
// ledger must not be logged twice, "SARAH M" on a Zelle deposit has to find the
// right Sarah (and must NOT pick one when there are two), a transfer from
// savings is not a detail job, and nothing at all may be written until the
// separate commit call carries what Mikey actually ticked.
//
//   node test/scan.test.js
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
function liftDecl(name) {
  const m = SRC.match(new RegExp(`^(?:const|let) ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`declaration ${name} not found in src/index.js`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const TODAY = '2026-08-25';
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(64);

// KV as a Map, plus stubs for everything the scan leans on. `reply` is what
// Gemini "saw"; `contacts` is the text book; `months` seeds the ledger.
function world({ reply = { rows: [] }, contacts = [], months = {}, key = 'test-key' } = {}) {
  const store = new Map();
  for (const m of Object.keys(months)) store.set('money:m:' + m, JSON.stringify({ entries: months[m], rec: {} }));
  const w = { store, written: [], prompts: [], images: [] };
  w.deps = {
    kv: () => ({
      get: async (k, opt) => {
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.written.push(k); store.set(k, v); },
    }),
    ENV: { GEMINI_API_KEY: key },
    readJson: async (req) => req,
    json: (body, status) => ({ status: status || 200, body }),
    loadConfig: async () => ({ tz: 'America/Los_Angeles' }),
    localDateStr: () => TODAY,
    loadIndex: async () => contacts.slice(),
    geminiGenerate: async (prompt, opts) => {
      w.prompts.push(prompt);
      w.images.push((opts && opts.images) || []);
      if (reply instanceof Error) throw reply;
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
  return w;
}

const NAMES = ['kv', 'ENV', 'readJson', 'json', 'loadConfig', 'localDateStr', 'loadIndex', 'geminiGenerate'];
const BODY =
  liftDecl('MONEY_CATS') + '\n' + liftDecl('MONEY_TYPES') + '\n' + liftDecl('moneyKey') + '\n' +
  lift('money2') + '\n' + lift('genId') + '\n' + lift('normalizePhone') + '\n' +
  lift('sanitizeMoneyEntry') + '\n' + lift('summarizeMonth') + '\n' +
  lift('loadMonth') + '\n' + lift('saveMonth') + '\n' +
  liftDecl('SCAN_MAX_IMAGES') + '\n' + liftDecl('SCAN_MAX_IMG_CHARS') + '\n' +
  lift('scanLooksSelfTransfer') + '\n' + lift('scanNameTokens') + '\n' + lift('scanNameScore') + '\n' +
  lift('scanMatchCustomer') + '\n' + lift('scanMethodFrom') + '\n' + lift('scanPrompt') + '\n' +
  lift('apiMoneyScan') + '\n' + lift('apiMoneyScanCommit') + '\n' +
  'return { apiMoneyScan, apiMoneyScanCommit, scanMatchCustomer, scanNameScore, scanNameTokens, scanLooksSelfTransfer, scanMethodFrom, scanPrompt, loadMonth };';
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

const entriesOf = (w, m) => JSON.parse(w.store.get('money:m:' + m) || '{"entries":[]}').entries;
const scan = async (w, imgs = [IMG]) => (await build(w).apiMoneyScan({ imgs })).body;

const BOOK = [
  { phone: '+15551110001', name: 'Sarah Miller' },
  { phone: '+15551110002', name: 'Dave Nguyen' },
  { phone: '+15551110003', name: 'Tom Brady Jr' },
  { phone: '+15551110004', name: '' },
];

(async () => {

console.log('\n=== finding the customer behind a Zelle deposit ===');
{
  const M = build(world());
  const only = (payer, book) => { const r = M.scanMatchCustomer(payer, book); return r.match ? r.match.name : null; };

  check('a full name matches outright', only('Sarah Miller', BOOK), 'Sarah Miller');
  check('case and punctuation do not matter', only('SARAH MILLER.', BOOK), 'Sarah Miller');
  // Zelle very often prints the surname as a single initial.
  check('first name + last initial matches', only('Sarah M', BOOK), 'Sarah Miller');
  check('the initial has to be the right one', only('Sarah B', BOOK), null);
  check('a first name alone still matches when it is unique', only('Dave', BOOK), 'Dave Nguyen');
  check('a stranger matches nobody', only('Priya Raman', BOOK), null);
  check('an empty payer matches nobody', only('', BOOK), null);
  check('contacts with no name are not candidates', only('', [{ phone: '+1', name: '' }]), null);

  // The case that would quietly credit the wrong customer's account.
  const twoSarahs = BOOK.concat([{ phone: '+15551110005', name: 'Sarah Moore' }]);
  const amb = M.scanMatchCustomer('Sarah M', twoSarahs);
  check('two equally good Sarahs: nothing is picked', amb.match, null);
  check('both are offered instead', amb.alts.map((a) => a.name), ['Sarah Miller', 'Sarah Moore']);
  // …but a full name still beats the tie.
  check('a full name breaks the tie', (M.scanMatchCustomer('Sarah Moore', twoSarahs).match || {}).name, 'Sarah Moore');

  check('an archived contact is not offered', M.scanMatchCustomer('Sarah Miller',
    [{ phone: '+1', name: 'Sarah Miller', archived: true }]).match, null);
}

console.log('\n=== reading a statement ===');
{
  const w = world({ contacts: BOOK, reply: { rows: [
    { date: '2026-08-20', amount: 25.11, dir: 'out', desc: '76 Express, Snohomish', card: '1917', cat: 'fuel' },
    { date: '2026-08-20', amount: 7.61,  dir: 'out', desc: 'Chick-fil-A, Bothell',  card: '1917', cat: 'food' },
    { date: '2026-08-21', amount: 180,   dir: 'in',  desc: 'ZELLE FROM SARAH M ON 08/21', payer: 'Sarah M' },
    { date: '2026-08-22', amount: 42,    dir: 'out', desc: 'Mystery Shop',          cat: 'not-a-real-category' },
  ] } });
  const d = await scan(w);

  check('every row comes back', d.rows.length, 4);
  check('newest first', d.rows.map((r) => r.date), ['2026-08-22', '2026-08-21', '2026-08-20', '2026-08-20']);
  check('money out is an expense', d.rows.filter((r) => r.dir === 'out').every((r) => r.type === 'exp'), true);
  check('money in is income', d.rows.find((r) => r.dir === 'in').type, 'job');
  check('a category off the list falls back to misc', d.rows[0].cat, 'misc');
  check('a real category is kept', d.rows.find((r) => r.amount === 25.11).cat, 'fuel');
  check('the card rides along in the note', d.rows.find((r) => r.amount === 25.11).note, '76 Express, Snohomish · card 1917');
  check('the deposit found Sarah', d.rows.find((r) => r.dir === 'in').name, 'Sarah Miller');
  check('and carries her number', d.rows.find((r) => r.dir === 'in').phone, '+15551110001');
  check('everything is ticked by default', d.rows.every((r) => r.on), true);
  check('nothing was written', w.written, []);
  check('the prompt tells it today', /2026-08-25/.test(w.prompts[0]), true);
  check('and the real category list', /fuel, supplies, equipment/.test(w.prompts[0]), true);
  check('the image went to the model', w.images[0].length, 1);
}

console.log('\n=== how the money arrived ===');
{
  // A scanned Zelle has to land in the same byMethod bucket as one tapped in by
  // hand, or the "how do people pay me" breakdown quietly splits in two.
  const M = build(world());
  check('Zelle is recognised', M.scanMethodFrom('ZELLE FROM SARAH M ON 08/21'), 'Zelle');
  check('so is Venmo', M.scanMethodFrom('VENMO PAYMENT 1234'), 'Venmo');
  check('and a check', M.scanMethodFrom('MOBILE CHECK DEPOSIT'), 'Check');
  check('an unrecognised deposit claims no method', M.scanMethodFrom('DEPOSIT'), '');

  const w = world({ contacts: BOOK, reply: { rows: [
    { date: '2026-08-21', amount: 180, dir: 'in', desc: 'ZELLE FROM SARAH MILLER', payer: 'Sarah Miller' },
    { date: '2026-08-21', amount: 50,  dir: 'in', desc: 'COUNTER CREDIT', payer: 'Dave Nguyen' },
  ] } });
  const d = await scan(w);
  check('the method rides along', d.rows.find((r) => r.amount === 180).method, 'Zelle');
  check('and is blank when the row does not say', d.rows.find((r) => r.amount === 50).method, '');
}

console.log('\n=== rows that arrive switched off ===');
{
  const w = world({ contacts: BOOK, months: { '2026-08': [
    { id: 'x1', date: '2026-08-20', ts: 1, type: 'exp', cat: 'fuel', amount: 25.11, note: 'logged by hand' },
  ] }, reply: { rows: [
    { date: '2026-08-20', amount: 25.11, dir: 'out', desc: '76 Express', cat: 'fuel' },
    { date: '2026-08-23', amount: 9.99,  dir: 'out', desc: 'Pending Thing', cat: 'misc', pending: true },
    { date: '2026-08-23', amount: 500,   dir: 'in',  desc: 'TRANSFER FROM SAVINGS', payer: '' },
    { date: '2026-08-24', amount: 60,    dir: 'out', desc: 'Normal Charge', cat: 'supplies' },
  ] } });
  const d = await scan(w);
  const by = (a) => d.rows.find((r) => r.amount === a);

  check('a charge already logged is flagged', !!by(25.11).dupe, true);
  check('and points at the entry it clashes with', by(25.11).dupe.id, 'x1');
  check('duplicates start unticked', by(25.11).on, false);
  check('pending starts unticked', by(9.99).on, false);
  check('a transfer in is not a customer payment', by(500).self, true);
  check('and starts unticked', by(500).on, false);
  check('an ordinary charge is still ticked', by(60).on, true);
  check('still nothing written', w.written, []);
}

console.log('\n=== what the model says that cannot be true ===');
{
  const w = world({ reply: { rows: [
    { date: '2026-09-30', amount: 20, dir: 'out', desc: 'Next month', cat: 'misc' },   // future
    { date: 'sometime',   amount: 20, dir: 'out', desc: 'No date',    cat: 'misc' },
    { date: '2026-08-20', amount: 0,  dir: 'out', desc: 'Free',       cat: 'misc' },
    { date: '2026-08-20', amount: -8, dir: 'out', desc: 'Negative',   cat: 'misc' },
    { date: '2026-08-20', amount: 12, dir: 'out', desc: 'Real one',   cat: 'misc' },
  ] } });
  const d = await scan(w);
  check('only the row that could have happened survives', d.rows.map((r) => r.desc), ['Real one']);
}
{
  // Two screenshots of the same scroll position: the same charge, twice.
  const w = world({ reply: { rows: [
    { date: '2026-08-20', amount: 25.11, dir: 'out', desc: '76 Express', cat: 'fuel' },
    { date: '2026-08-20', amount: 25.11, dir: 'out', desc: '76 EXPRESS', cat: 'fuel' },
  ] } });
  check('a row repeated across screenshots collapses', (await scan(w, [IMG, IMG])).rows.length, 1);
}
{
  const w = world({ reply: 'sorry, I cannot read that' });
  check('unparseable output is an error, not an empty ledger', (await build(w).apiMoneyScan({ imgs: [IMG] })).status, 502);
}
{
  const w = world({ key: '' });
  check('no Gemini key says so plainly', (await build(w).apiMoneyScan({ imgs: [IMG] })).body.error, 'ai_not_configured');
}
{
  const w = world();
  check('a missing image is refused', (await build(w).apiMoneyScan({ imgs: [] })).body.error, 'no_image');
  check('a non-image is refused', (await build(w).apiMoneyScan({ imgs: ['data:text/html,hi'] })).body.error, 'bad_image');
  check('an oversized image is refused',
    (await build(w).apiMoneyScan({ imgs: ['data:image/jpeg;base64,' + 'A'.repeat(500000)] })).body.error, 'bad_image');
  check('nothing reached the model', w.prompts.length, 0);
}

console.log('\n=== committing what he ticked ===');
{
  const w = world();
  const M = build(w);
  const r = (await M.apiMoneyScanCommit({ rows: [
    { type: 'exp', cat: 'fuel', amount: 25.11, date: '2026-08-20', note: '76 Express · card 1917' },
    { type: 'exp', cat: 'food', amount: 7.61,  date: '2026-08-20', note: 'Chick-fil-A' },
    { type: 'job', amount: 180, date: '2026-08-21', note: 'Zelle', phone: '+15551110001', name: 'Sarah Miller', method: 'Bank' },
    { type: 'exp', cat: 'misc', amount: 15,   date: '2026-07-30', note: 'Last month' },
  ] })).body;

  check('all four logged', r.logged, 4);
  check('one write per month, not per row', w.written, ['money:m:2026-08', 'money:m:2026-07']);
  check('August got three', entriesOf(w, '2026-08').length, 3);
  check('July got the straggler', entriesOf(w, '2026-07').length, 1);
  check('each is stamped as read off a statement', entriesOf(w, '2026-08').every((e) => e.bk === 1), true);
  check('the deposit is a job for Sarah', entriesOf(w, '2026-08').find((e) => e.type === 'job').name, 'Sarah Miller');
  check('dated the day of the charge, not today', entriesOf(w, '2026-08').map((e) => e.date).sort(),
    ['2026-08-20', '2026-08-20', '2026-08-21']);
  check('the month totals what the statement did', (await M.loadMonth('2026-08')).entries
    .filter((e) => e.type === 'exp').reduce((a, e) => a + e.amount, 0), 32.72);
}
{
  // Between the scan and the tap, the same charge got logged another way.
  const w = world({ months: { '2026-08': [{ id: 'x1', date: '2026-08-20', ts: 1, type: 'exp', cat: 'fuel', amount: 25.11 }] } });
  const r = (await build(w).apiMoneyScanCommit({ rows: [
    { type: 'exp', cat: 'fuel', amount: 25.11, date: '2026-08-20', note: '76 Express' },
    { type: 'exp', cat: 'food', amount: 7.61,  date: '2026-08-20', note: 'Chick-fil-A' },
  ] })).body;
  check('the clash is skipped', r.skipped, 1);
  check('the new one still lands', r.logged, 1);
  check('the ledger has two, not three', entriesOf(w, '2026-08').length, 2);
}
{
  const w = world();
  check('an empty commit is refused', (await build(w).apiMoneyScanCommit({ rows: [] })).body.error, 'no_rows');
  check('and writes nothing', w.written, []);
  const bad = (await build(w).apiMoneyScanCommit({ rows: [{ type: 'exp', amount: 'abc', date: 'nope' }] })).body;
  check('a row that cannot be an entry is skipped', [bad.logged, bad.skipped], [0, 1]);
}

console.log(`\n${FAIL ? 'FAIL' : 'PASS'} — ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
})();
