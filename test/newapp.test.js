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

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
