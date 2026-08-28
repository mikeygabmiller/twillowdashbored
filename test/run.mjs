// Test runner. Runs EVERY suite, then reports.
//
// This exists because `a && b && c` doesn't: a failure in the second suite meant
// the other eighteen never ran, and the last line printed was one suite's score
// masquerading as the project's. Two real failures sat hidden behind that for
// months. A runner that stops at the first problem is a runner that tells you
// about one problem.
//
//   node test/run.mjs          # unit suites (default)
//   node test/run.mjs ui       # browser suites
//   node test/run.mjs all      # everything
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UNIT = [
  'hold', 'detect', 'pay', 'ai', 'compose', 'thread', 'inbox', 'money', 'quickreply',
  'replycheck', 'autoreply', 'quotes', 'balance', 'alertmail', 'promise', 'recap',
  'geogrid', 'geogrid.ui', 'snapshot', 'journey', 'quotewatch', 'place', 'cold', 'portal', 'sheets', 'gdoc', 'gform', 'seed', 'scan', 'cpu',
  'aicost', 'use',
].map((n) => `${n}.test.js`);

const UI = [
  'detect.ui', 'pay.ui', 'nav.ui', 'search.ui', 'tabs.ui', 'snapshot.ui', 'place.ui',
  'newmsg.ui', 'peek.ui', 'polish.ui', 'journey.ui', 'scan.ui', 'aidiet.ui', 'use.ui',
  'keyboard.ui',
].map((n) => `${n}.test.js`);

const mode = (process.argv[2] || 'unit').toLowerCase();
const files = mode === 'ui' ? UI : mode === 'all' ? [...UNIT, ...UI] : UNIT;

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  child.on('close', (code) => resolve({ file, code, out, ms: Date.now() - started }));
});

const results = [];
for (const file of files) {
  console.log(`\n\x1b[1m──────── ${file} ────────\x1b[0m`);
  results.push(await run(file));
}

// Suites print their own tallies in a few different shapes; pull a count out when
// we can, but the exit code is what decides pass/fail.
const countFails = (out) => {
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/g);
  if (!m || !m.length) return null;
  const last = m[m.length - 1].match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  return { passed: Number(last[1]), failed: Number(last[2]) };
};

const bad = results.filter((r) => r.code !== 0);
let passed = 0, failed = 0;
for (const r of results) {
  const c = countFails(r.out);
  if (c) { passed += c.passed; failed += c.failed; }
}

console.log(`\n\x1b[1m════════ ${mode} summary ════════\x1b[0m`);
for (const r of results) {
  const c = countFails(r.out);
  const tally = c ? `${c.passed} passed, ${c.failed} failed` : (r.code === 0 ? 'ok' : 'no tally');
  const mark = r.code === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${r.file.padEnd(24)} ${tally}  ${(r.ms / 1000).toFixed(1)}s`);
}
console.log(`\n  ${results.length} suites · ${passed} checks passed · ${failed} failed`);
if (bad.length) {
  console.log(`\n\x1b[31m  ${bad.length} suite(s) failing: ${bad.map((r) => r.file).join(', ')}\x1b[0m`);
}
process.exit(bad.length ? 1 : 0);
