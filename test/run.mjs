// Test runner. Runs EVERY suite, in parallel, then reports.
//
// This exists because `a && b && c` doesn't: a failure in the second suite meant
// the other eighteen never ran, and the last line printed was one suite's score
// masquerading as the project's. Two real failures sat hidden behind that for
// months. A runner that stops at the first problem is a runner that tells you
// about one problem.
//
// It runs them SIDE BY SIDE because the UI suites are the whole cost of the
// loop: 36 of them, each spawning its own node and its own Chromium, and a
// browser costs about six seconds to start before it has tested anything. Run
// end to end that was ~8 minutes, which is long enough that a change gets
// shipped on "it passed last time" instead of on a run. Suites are already
// isolated from each other — separate processes, separate browsers, no shared
// files, no ports — so nothing had to change in them to make this safe.
//
// Output is held per suite and printed when that suite finishes, rather than
// streamed. Four suites writing to one terminal at once is unreadable, and the
// interleaving lands mid-line.
//
//   node test/run.mjs                  # unit suites (default)
//   node test/run.mjs ui               # browser suites
//   node test/run.mjs all              # everything
//   node test/run.mjs ui polish peek   # just the suites matching those words
//   node test/run.mjs ui -j 2          # fewer at once (a small machine, or to debug)
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNIT = [
  'hold', 'detect', 'pay', 'ai', 'compose', 'thread', 'inbox', 'money', 'quickreply',
  'replycheck', 'autoreply', 'quotes', 'balance', 'alertmail', 'assistmail', 'promise', 'recap',
  'geogrid', 'geogrid.ui', 'snapshot', 'journey', 'quotewatch', 'place', 'cold', 'portal', 'sheets', 'gdoc', 'gform', 'seed', 'scan', 'cpu',
  'aicost', 'sayback', 'autoai', 'selftest', 'voicepairs', 'kept', 'use', 'calls', 'reachout', 'adsource', 'adsexport', 'quotereply', 'askme', 'photo', 'rain', 'name', 'openings', 'ready', 'opener', 'preview', 'voice', 'say', 'react',
].map((n) => `${n}.test.js`);

const UI = [
  'detect.ui', 'pay.ui', 'nav.ui', 'search.ui', 'tabs.ui', 'snapshot.ui', 'place.ui',
  'newmsg.ui', 'peek.ui', 'polish.ui', 'journey.ui', 'scan.ui', 'aidiet.ui', 'autoai.ui', 'use.ui', 'layout.ui', 'stale.ui',
  'keyboard.ui', 'assist.ui', 'calls.ui', 'adsource.ui', 'askme.ui', 'photo.ui',
  'sayback.ui', 'winddown.ui', 'homeloop.ui', 'rain.ui', 'sendnow.ui', 'qol.ui', 'qol2.ui', 'name.ui', 'five.ui', 'ready.ui', 'opener.ui', 'preview.ui', 'say.ui', 'aikey.ui', 'react.ui', 'promise.ui',
].map((n) => `${n}.test.js`);

const argv = process.argv.slice(2);
const mode = (argv[0] && !argv[0].startsWith('-') ? argv[0] : 'unit').toLowerCase();
const rest = argv.slice(['unit', 'ui', 'all'].includes(mode) ? 1 : 0);

// -j N caps how many run at once. The default is one per core, held to 4: past
// that the browsers are fighting each other for CPU and the wall clock stops
// improving. One core still means one at a time, which is the old behaviour.
let jobs = Math.max(1, Math.min(os.cpus().length || 1, 4));
const jIdx = rest.findIndex((a) => a === '-j' || a === '--jobs');
if (jIdx >= 0) { jobs = Math.max(1, Number(rest[jIdx + 1]) || 1); rest.splice(jIdx, 2); }
if (process.env.TEST_JOBS) jobs = Math.max(1, Number(process.env.TEST_JOBS) || 1);

const all = mode === 'ui' ? UI : mode === 'all' ? [...UNIT, ...UI] : UNIT;
// Anything left over filters by substring, so `run.mjs ui polish` is the one
// suite you're actually working on rather than the other thirty-five.
const filters = rest.filter((a) => !a.startsWith('-'));
const files = filters.length ? all.filter((f) => filters.some((w) => f.includes(w))) : all;
if (!files.length) {
  console.log(`\n  No ${mode} suite matches ${filters.join(', ')}.`);
  process.exit(1);
}

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    // Printed here, whole, so a suite's output stays in one piece even though
    // three others were writing while it ran.
    console.log(`\n\x1b[1m──────── ${file} ────────\x1b[0m`);
    process.stdout.write(out);
    resolve({ file, code, out, ms: Date.now() - started });
  });
});

const wall = Date.now();
const results = [];
{
  // A queue rather than chunked batches: a slow suite holds up one lane, not the
  // whole run, so the pool stays full until there is nothing left to hand out.
  const queue = files.slice();
  const lane = async () => { while (queue.length) results.push(await run(queue.shift())); };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, lane));
  // Finishing order is whatever the machine decided; the report reads better in
  // the order they're declared in.
  results.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
}

// Running four browsers at once buys back six minutes and costs the occasional
// suite that dies before it tests anything — a Chromium that loses the race for
// a resource, not a broken assertion. So every failure is re-run ONCE, alone,
// with nothing else competing. What that cannot do is quietly turn red into
// green: a suite that only passes the second time is reported as FLAKY, by name,
// every run, because a test that fails one time in ten is a real problem that a
// silent retry would bury. Only a suite that fails alone too is a failure.
const flaky = [];
for (const r of results.filter((x) => x.code !== 0)) {
  console.log(`\n\x1b[33m──────── retrying ${r.file} on its own ────────\x1b[0m`);
  const again = await run(r.file);
  Object.assign(r, again);
  if (again.code === 0) flaky.push(r.file);
}

// Suites print their own tallies in a few different shapes; pull a count out when
// we can, but the exit code is what decides pass/fail.
const countFails = (out) => {
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/g);
  if (!m || !m.length) return null;
  const last = m[m.length - 1].match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  return { passed: Number(last[1]), failed: Number(last[2]) };
};

const bad = results.filter((r) => r.code !== 0);  // after retries — see the loop above
let passed = 0, failed = 0;
for (const r of results) {
  const c = countFails(r.out);
  if (c) { passed += c.passed; failed += c.failed; }
}

console.log(`\n\x1b[1m════════ ${mode} summary ════════\x1b[0m`);
for (const r of results) {
  const c = countFails(r.out);
  const tally = c ? `${c.passed} passed, ${c.failed} failed` : (r.code === 0 ? 'ok' : 'no tally');
  const mark = r.code !== 0 ? '\x1b[31m✗\x1b[0m' : flaky.includes(r.file) ? '\x1b[33m⚠\x1b[0m' : '\x1b[32m✓\x1b[0m';
  const note = flaky.includes(r.file) ? '  \x1b[33m(FLAKY — failed in parallel, passed alone)\x1b[0m' : '';
  console.log(`  ${mark} ${r.file.padEnd(24)} ${tally}  ${(r.ms / 1000).toFixed(1)}s${note}`);
}
console.log(`\n  ${results.length} suites · ${passed} checks passed · ${failed} failed` +
  ` · ${(Date.now() - wall) / 1000 | 0}s wall, ${jobs} at a time`);
if (flaky.length) {
  console.log(`\n\x1b[33m  ${flaky.length} flaky: ${flaky.join(', ')} — passed alone. Worth a look, not a blocker.\x1b[0m`);
}
if (bad.length) {
  console.log(`\n\x1b[31m  ${bad.length} suite(s) failing: ${bad.map((r) => r.file).join(', ')}\x1b[0m`);
}
process.exit(bad.length ? 1 : 0);
