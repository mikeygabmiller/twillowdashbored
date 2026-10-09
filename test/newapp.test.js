// The three server changes the new app (2026-10-08) leans on.
//
//   1. GET /api/thread?peek=1 reads a chat WITHOUT clearing unread. Mikey's
//      rule: a chat stays unread until he answers it or files it.
//   2. "Fix spelling only" never hands back anything but a spelling fix: a
//      moved number, an added dash or a rewrite gets his own words back.
//   3. The booking action "start" stamps startedAt and texts nobody, so the
//      Schedule page can show how long a job really took.
//
//   node test/newapp.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
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

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// ---- 1. peek ---------------------------------------------------------------
{
  const calls = [];
  const make = new Function('calls', `
    const json = (o, s) => ({ body: o, status: s || 200 });
    const normalizePhone = (p) => p;
    const loadThread = async (p) => { calls.push('load'); return { phone: p, unread: 2 }; };
    const openThreadForRead = async (p) => { calls.push('openForRead'); return { phone: p, unread: 0 }; };
    const filedThread = (t) => t;
    const loadIndex = async () => [];
    const loadConfig = async () => ({});
    ${lift('apiThread')}
    return apiThread;`);
  const apiThread = make(calls);
  const r1 = await apiThread(new URL('https://x/api/thread?peek=1&phone=%2B1425'));
  check('peek=1 loads without the read side effect', calls, ['load']);
  check('peek=1 leaves the unread count as it was', r1.body.thread.unread, 2);
  calls.length = 0;
  await apiThread(new URL('https://x/api/thread?phone=%2B1425'));
  check('without peek it still marks read, as the classic app expects', calls, ['openForRead']);
}

// ---- 2. spelling only ----------------------------------------------------------
{
  const spellOut = new Function(`${lift('polishNumbers')}\n${lift('spellOut')}\nreturn spellOut;`)();
  const orig = 'i can do saterday at 1pm for $409';
  check('a spelling fix comes through', spellOut(JSON.stringify({ text: 'I can do Saturday at 1pm for $409' }), orig), 'I can do Saturday at 1pm for $409');
  check('a moved price gets his words back', spellOut(JSON.stringify({ text: 'I can do Saturday at 1pm for $400' }), orig), orig);
  check('an added dash gets his words back', spellOut(JSON.stringify({ text: 'I can do Saturday — 1pm for $409' }), orig), orig);
  check('a rewrite twice the length gets his words back', spellOut(JSON.stringify({ text: orig + ' and I will bring everything I need, see you then, thanks so much!' }), orig), orig);
  check('garbage gets his words back', spellOut('not json', orig), orig);
  const p = new Function(`${lift('spellPrompt')}\nreturn spellPrompt;`)()('hi');
  check('the prompt forbids changing anything but spelling', /Fix ONLY the spelling/.test(p) && /Never change a number/.test(p), true);
}

// ---- 3. start a job ---------------------------------------------------------------
{
  const all = [{ id: 'b1', status: 'confirmed', phone: '+1425' }, { id: 'b2', status: 'done', phone: '+1426' }];
  const texts = [];
  const make = new Function('all', 'texts', `
    const json = (o, s) => ({ body: o, status: s || 200 });
    let BODY = {};
    const readJson = async () => BODY;
    const loadBookings = async () => all;
    const saveBookings = async () => {};
    const loadBookingConfig = async () => ({});
    const loadConfig = async () => ({});
    const background = () => {};
    const bkGcalSync = () => {};
    const sendSms = async () => { texts.push(1); };
    const loadThread = async () => { throw new Error('start must not touch the thread'); };
    ${lift('apiBookingAction')}
    return async (b) => { BODY = b; return apiBookingAction({}); };`);
  const act = make(all, texts);
  const before = Date.now();
  const r = await act({ id: 'b1', action: 'start' });
  check('start answers ok', r.body.ok, true);
  check('start stamps startedAt', all[0].startedAt >= before, true);
  check('start leaves the booking confirmed', all[0].status, 'confirmed');
  check('start texts nobody', r.body.texted === false && texts.length === 0, true);
  const r2 = await act({ id: 'b2', action: 'start' });
  check('a finished job cannot be started again', r2.status, 409);
}

// ---- 4. reply speed and price-leavers (the Grow page's numbers) --------------
{
  const f = new Function(`${lift('replyDelays')}\n${lift('medianMs')}\n${lift('priceLeftSummary')}\nreturn { replyDelays, medianMs, priceLeftSummary };`)();
  const t0 = 1e12, M = 60000;
  const msgs = [
    { dir: 'in', ts: t0 }, { dir: 'out', kind: 'auto', ts: t0 + 1 * M }, { dir: 'out', kind: 'manual', ts: t0 + 30 * M },
    { dir: 'in', ts: t0 + 100 * M }, { dir: 'in', ts: t0 + 110 * M }, { dir: 'out', kind: 'manual', ts: t0 + 160 * M },
    { dir: 'out', kind: 'manual', ts: t0 + 200 * M },
    { dir: 'in', kind: 'voicemail', ts: t0 + 300 * M }, { dir: 'out', kind: 'scheduled', ts: t0 + 301 * M },
  ];
  const d = f.replyDelays(msgs).map((x) => x.ms / M);
  check('an auto-reply is not his reply; his own is', d[0], 30);
  check('the wait counts from their first unanswered text', d[1], 60);
  check('a second text from him answers nothing new', d.length, 2);
  check('a voicemail still waiting has no reply yet', f.replyDelays(msgs).length, 2);
  check('median of an odd list', f.medianMs([5, 1, 9]), 5);
  check('median of an even list', f.medianMs([1, 3, 5, 7]), 4);
  check('median of nothing', f.medianMs([]), null);
  const now = 2e12, D = 86400000;
  const rows = [
    { at: now - D, hot: 'Quote form \u2014 step 4 · price shown', phone: '' },
    { at: now - 2 * D, hot: 'Quote form - step 4', phone: '' },
    { at: now - 3 * D, hot: 'Quote form step 2', phone: '' },
    { at: now - D, hot: 'Quote form step 5', phone: '+1425' },
    { at: now - D, hot: 'BOOKED Full Detail', phone: '' },
    { at: now - D, hot: '', phone: '' },
    { at: now - 9 * D, hot: 'Quote form step 3', phone: '' },
    { at: now - 20 * D, hot: 'Quote form step 3', phone: '' },
  ];
  const pl = f.priceLeftSummary(rows, now);
  check('counts this week\'s quote-form leavers, not the ones who left a number', pl.n7, 3);
  check('and last week\'s', pl.nPrev, 1);
  check('stops are grouped by step, most first, whatever dash the site sends', pl.stops, [{ k: 'Step 4', n: 2 }, { k: 'Step 2', n: 1 }]);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
