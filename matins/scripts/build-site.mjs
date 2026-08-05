#!/usr/bin/env node
// Writes the static pages for the GitHub Pages repo: the signup landing page,
// an empty archive placeholder, a /today redirect stub, and the mark.
// Daily issue pages are committed by the Worker at build time (lib/publish.js)
// — this script only produces the parts that do not change every day.
//
//   WORKER_URL=https://matins.<subdomain>.workers.dev npm run site

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config.js';
import { renderSignupPage, renderArchivePage, renderTodayRedirect } from '../src/render/web.js';
import { standaloneMarkSvg } from '../src/render/brand.js';
import { theme } from '../src/render/theme.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'site');

if (!process.env.WORKER_URL) {
  console.warn('! WORKER_URL is not set — the signup form will point at SITE_URL and will not work.');
  console.warn('  Re-run with: WORKER_URL=https://matins.<your-subdomain>.workers.dev npm run site\n');
}

const cfg = config(process.env);
const files = [
  ['index.html', renderSignupPage({ cfg, subscribeEndpoint: `${cfg.workerUrl}/subscribe` })],
  ['archive/index.html', renderArchivePage([], { cfg })],
  ['today/index.html', renderTodayRedirect(new Date().toISOString().slice(0, 10), { cfg })],
  ['mark.svg', standaloneMarkSvg(theme('green').accent)],
  ['.nojekyll', ''],
];

for (const [path, content] of files) {
  const full = resolve(outDir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  console.log(`wrote site/${path}`);
}
console.log(`\nSignup posts to: ${cfg.workerUrl}/subscribe`);
