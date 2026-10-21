// KV READ budget: the third free-tier limit, and the one that took the whole
// dashboard down on 2026-10-21.
//
// The free tier allows ~100,000 KV reads a day. When they run out, EVERY get()
// throws "KV get() limit exceeded for the day" until midnight UTC: the PIN login,
// the inbox, the customer pages, inbound texts. The WRITE box in src/index.js
// called reads "far cheaper", which made it easy to stop counting them.
//
// What spent them: evaluateFollowups re-read every conversation with a nudge
// already surfaced, every minute, though nothing about it had changed. 70 nudges
// left sitting × 1,440 ticks = the whole quota. This suite runs the real cron
// against a counting KV and holds the steady-state cost of a waiting nudge down.
//
//   node test/kvreads.test.js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let PASS = 0, FAIL = 0;
const check = (name, ok, detail) => {
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          ${detail}`}`);
};

const store = new Map();
let threadReads = 0;
const KV = {
  async get(k, o) {
    if (k.startsWith('thread:')) threadReads++;
    const v = store.get(k);
    if (v == null) return null;
    return (typeof o === 'string' ? o : o && o.type) === 'json' ? JSON.parse(v) : v;
  },
  async getWithMetadata(k, o) { return { value: await this.get(k, o), metadata: null }; },
  async put(k, v) { store.set(k, String(v)); },
  async delete(k) { store.delete(k); },
  async list(o) {
    return { keys: [...store.keys()].filter((k) => !o || !o.prefix || k.startsWith(o.prefix)).map((name) => ({ name })), list_complete: true };
  },
};
// No AI, Twilio or email from a test. Every outbound call gets an empty 200.
globalThis.fetch = async () => new Response('{}', { status: 200 });

// 300 conversations, the last 100 of them a week or more past a text he sent
// and never heard back on: each one comes due for a chase nudge.
const now = Date.now(), index = [];
for (let i = 0; i < 300; i++) {
  const phone = '+1425' + String(1000000 + i);
  const lastTs = now - (i < 200 ? i * 60000 : 8 * 86400000 + i * 60000);
  const msgs = [
    { id: 'a' + i, dir: 'in', body: 'How much for a full detail on my Tahoe?', ts: lastTs - 60000 },
    { id: 'b' + i, dir: 'out', body: 'It would be 240 for that one', ts: lastTs },
  ];
  store.set('thread:' + phone, JSON.stringify({ phone, name: 'Cust ' + i, status: 'active', messages: msgs, lastTs, updatedAt: lastTs }));
  // followupNextAt is what buildIndexSummary stored when he sent that text:
  // the chase step's due time, now in the past for the stale hundred.
  index.push({ phone, name: 'Cust ' + i, lastTs, lastDir: 'out', lastBody: msgs[1].body, unread: 0, status: 'active',
    followupNextAt: i < 200 ? lastTs + 86400000 : now - 1000 });
}
store.set('threads-index', JSON.stringify(index));

const mod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'index.js')).href);
const env = { MESSAGES: KV, PUBLIC_BASE_URL: 'https://x' };
// Each tick is a real minute later. Thirty ticks in one wall-clock second
// would all land in the same minute and say nothing about half an hour.
const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;
async function tick() {
  clock += 60000;
  const pend = [], before = threadReads;
  await mod.default.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => pend.push(p) });
  await Promise.allSettled(pend);
  return threadReads - before;
}

console.log('\n=== a surfaced nudge is not re-read every minute ===');
{
  // Let the engine settle: the first ticks open every newly due thread once
  // to surface its nudge, and that one read each is fair.
  for (let i = 0; i < 3; i++) await tick();
  const surfaced = JSON.parse(store.get('threads-index')).filter((r) => r.followupDue).length;
  check('the setup actually surfaces nudges', surfaced >= 50, `only ${surfaced} surfaced`);

  let reads = 0;
  for (let i = 0; i < 30; i++) reads += await tick();
  // Before the fix: surfaced × 30. After: about each one once per 30 minutes.
  check(`30 ticks read ~${surfaced} threads, not ${surfaced * 30}`, reads <= surfaced * 2,
    `${reads} thread reads over 30 ticks`);
  const perDay = Math.round(reads / 30 * 1440);
  check(`waiting nudges cost ${perDay} reads/day, well under the 100k quota`, perDay < 20000, `${perDay}/day`);

  const still = JSON.parse(store.get('threads-index')).filter((r) => r.followupDue).length;
  check('and every nudge is still surfaced', still === surfaced, `${still} of ${surfaced}`);
}

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
