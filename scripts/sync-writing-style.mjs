// Copies the drafting part of docs/WRITING-STYLE.md into src/index.js, between
// the BEGIN/END markers, as the WRITING_STYLE_GUIDE constant.
//
// Why a copy at all: the Worker can't read a file at runtime, and every test
// suite loads src/index.js as one block of text (new Function over the source),
// so an `import` of the markdown would break all of them. The guide therefore
// lives inside the Worker, and test/writingstyle.test.js fails the moment the
// two disagree, so editing the .md and forgetting this step can't ship.
//
//   node scripts/sync-writing-style.mjs           rewrite the block in src/index.js
//   node scripts/sync-writing-style.mjs --check   exit 1 if the block is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = path.join(ROOT, 'docs', 'WRITING-STYLE.md');
export const SRC = path.join(ROOT, 'src', 'index.js');
export const BEGIN = '// BEGIN GENERATED WRITING_STYLE_GUIDE';
export const END = '// END GENERATED WRITING_STYLE_GUIDE';

// The part the drafts get: "Start here" onward. The title, the contents list
// and "How this was built" describe the file (and that the repo is public), not
// how he texts, so they would only be noise in a prompt.
export function guideForDrafts(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const start = at(/^## Start here/);
  const contents = at(/^## Contents/);
  const numbers = at(/^## 2\. /);
  if (start < 0 || contents < 0 || numbers < 0 || !(start < contents && contents < numbers)) {
    throw new Error('docs/WRITING-STYLE.md no longer has "## Start here", "## Contents" and "## 2. " in that order; update guideForDrafts() to match');
  }
  return lines.slice(start, contents).concat(lines.slice(numbers))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// One JSON string per line, so a change to the guide is a readable diff here too.
export function generatedBlock(md) {
  const body = guideForDrafts(md).split('\n').map((l) => '  ' + JSON.stringify(l) + ',').join('\n');
  return [
    BEGIN,
    '// Do not edit by hand. Edit docs/WRITING-STYLE.md, then run:',
    '//   node scripts/sync-writing-style.mjs',
    'const WRITING_STYLE_GUIDE = [',
    body,
    "].join('\\n');",
    END,
  ].join('\n');
}

export function currentBlock(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a < 0 || b < a) return null;
  return src.slice(a, b + END.length);
}

function main() {
  const md = fs.readFileSync(DOC, 'utf8');
  const src = fs.readFileSync(SRC, 'utf8');
  const have = currentBlock(src);
  if (have == null) throw new Error(`src/index.js has no "${BEGIN}" ... "${END}" markers`);
  const want = generatedBlock(md);
  if (process.argv.includes('--check')) {
    if (have !== want) {
      console.error('src/index.js is out of date with docs/WRITING-STYLE.md. Run: node scripts/sync-writing-style.mjs');
      process.exit(1);
    }
    console.log('WRITING_STYLE_GUIDE is in sync with docs/WRITING-STYLE.md');
    return;
  }
  if (have === want) { console.log('Already in sync.'); return; }
  fs.writeFileSync(SRC, src.replace(have, want));
  console.log('Updated WRITING_STYLE_GUIDE in src/index.js from docs/WRITING-STYLE.md');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
