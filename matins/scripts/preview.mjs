#!/usr/bin/env node
// Dry run. Builds a complete issue for any date and writes the email HTML,
// the plain-text fallback, the web page and the raw JSON to preview-out/.
// Sends nothing. Marks nothing as seen. Touches no KV.
//
//   npm run preview                     today
//   npm run preview 2026-12-25          any date
//   npm run preview 2026-12-25 --open   also print the plain text to stdout
//   npm run preview --seed-bad-block    prove the safety pass drops a block
//   npm run preview --offline           answer readings/verse from test fixtures
//   LLM_PROVIDER=stub npm run preview   no API key, no network for generation

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { buildIssue } from '../src/lib/issue.js';
import { makeStore, readOnly } from '../src/lib/store.js';
import { renderEmail } from '../src/render/email.js';
import { renderIssuePage } from '../src/render/web.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const date = args.find((a) => !a.startsWith('--')) || todayInTz(process.env.SEND_TZ || 'America/Los_Angeles');

// No key? Fall back to the offline provider so a preview always produces
// something, and say so loudly.
if (!process.env.LLM_API_KEY && !process.env.LLM_PROVIDER) {
  process.env.LLM_PROVIDER = 'stub';
  console.warn('! LLM_API_KEY not set — using the offline "stub" provider for generated blocks.\n');
}

const cfg = config(process.env);
const store = readOnly(makeStore(null));
const fetchImpl = flags.has('--offline') ? (await import('../test/fixture-fetch.mjs')).fixtureFetch() : undefined;

// romcal pulls in i18next, which prints a sponsor line on load. Keep the CLI
// output clean without touching app code.
for (const m of ['log', 'info', 'warn']) {
  const real = console[m].bind(console);
  console[m] = (...a) => (typeof a[0] === 'string' && a[0].includes('locize.com') ? undefined : real(...a));
}

console.log(`Building ${cfg.appName} for ${date}  (provider: ${cfg.llmProvider}${cfg.llmModel ? `/${cfg.llmModel}` : ''}, dry run)\n`);

const issue = await buildIssue({
  date,
  cfg,
  store,
  dryRun: true,
  seedBadBlock: flags.has('--seed-bad-block'),
  fetchImpl,
});

const email = renderEmail(issue, {
  cfg,
  permalink: `${cfg.siteUrl}/${issue.date}/`,
  unsubscribeUrl: `${cfg.workerUrl}/unsubscribe?t=PREVIEW_TOKEN`,
});
const page = renderIssuePage(issue, { cfg });

const outDir = resolve(root, 'preview-out', date);
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outDir, 'email.html'), email.html),
  writeFile(resolve(outDir, 'email.txt'), email.text),
  writeFile(resolve(outDir, 'page.html'), page),
  writeFile(resolve(outDir, 'issue.json'), JSON.stringify(issue, null, 2)),
]);

// previewToLog: the whole issue, legible, in the terminal.
const d = issue.liturgicalDay;
line();
console.log(`${d.feastOrSaint}`);
console.log(`${d.season} · ${d.rank} · ${d.colorName}${d.isHolyDayOfObligation ? ' · holy day of obligation' : ''}`);
if (d.optionalMemorials?.length) console.log(`also today: ${d.optionalMemorials.join('; ')}`);
line();
console.log(`SUBJECT   ${email.subject}`);
console.log(`PREHEADER ${email.preheader}${issue.headlineGenerated ? '' : '  (fallback — generated headline unavailable)'}`);
line();
console.log(email.text);
line();
console.log('SECTIONS');
for (const [name, present] of [
  ['readings', !issue.readings.unavailable],
  ['verseOfDay', !!issue.verseOfDay],
  ['verse text (Douay-Rheims)', !!issue.verseOfDay?.text],
  ['reflection', !!issue.reflection],
  ['saintStory', !!issue.saintStory],
  ['prayer', !!issue.prayer],
  ['consider', !!issue.consider],
]) {
  console.log(`  ${present ? '✓' : '·'} ${name}${present ? '' : ' — omitted'}`);
}

console.log(`\nWRITING  (form: ${issue.safetyReport.reflectionForm})`);
for (const b of issue.safetyReport.blocks) {
  const bits = [b.drafts ? `${b.drafts} draft${b.drafts === 1 ? '' : 's'}` : null, b.judge ? `judge: ${b.judge}` : null]
    .filter(Boolean)
    .join(' · ');
  console.log(`  ${b.block}${bits ? ` — ${bits}` : ''}`);
  if (b.craft?.length) console.log(`    tired: ${b.craft.join(', ')}`);
}

console.log(`\nSAFETY  (${issue.safetyReport.provider})`);
for (const b of issue.safetyReport.blocks) {
  console.log(`  ${b.pass ? 'PASS' : 'DROP'}  ${b.block} — ${b.reason}`);
}
if (!issue.safetyReport.blocks.length) console.log('  (nothing generated to check)');
if (issue.safetyReport.degraded.length) {
  console.log('\nDEGRADED');
  for (const g of issue.safetyReport.degraded) console.log(`  ${g.section} — ${g.reason}`);
}
console.log(`\nstatus: ${issue.status}`);
console.log(`\nWrote:\n  ${outDir}/email.html\n  ${outDir}/email.txt\n  ${outDir}/page.html\n  ${outDir}/issue.json`);
console.log('\nNothing was sent. Nothing was marked as seen.');

if (flags.has('--open')) console.log(`\nopen ${outDir}/email.html`);

function line() {
  console.log('\n' + '─'.repeat(72));
}

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
