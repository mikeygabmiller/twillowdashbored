// Unit tests for the map-rank identity match — the thing that decides whether a
// Places result IS your listing.
//
// This is the code path behind "why is it 20+ everywhere?". When the compare
// fails, every grid point records 21 ("20+") and the map looks exactly like a
// business that ranks nowhere, even when the listing sits at #1. So the risky
// direction here runs BOTH ways: a false negative paints a scary red grid, and
// a false positive reports a competitor's rank as yours. The cases below pin
// down the drift we actually see (city suffix, "Mobile" in the middle, LLC)
// while keeping unrelated businesses that share a first word out.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/geogrid.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
function liftConst(name) {
  const start = SRC.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`const ${name} not found in src/index.js`);
  let depth = 0;
  for (let j = SRC.indexOf('=', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`could not find end of const ${name}`);
}

const scope = {};
new Function('S', `
  ${liftConst('GEO_GENERIC_WORDS')}
  ${liftConst('GEO_NOT_FOUND_RANK')}
  ${lift('geoNameKey')}
  ${lift('geoTokens')}
  ${lift('geoDistinctTokens')}
  ${lift('geoNameMatches')}
  ${lift('geoStats')}
  S.geoNameMatches = geoNameMatches; S.geoStats = geoStats;
`)(scope);
const { geoNameMatches, geoStats } = scope;

let PASS = 0, FAIL = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${ok ? '' : `\n     got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log('\n=== map rank: is this Places result my listing? ===');
// Exact / punctuation / containment — what already worked, kept working.
check('exact name', geoNameMatches("Mikey's Mobile Detailing", "Mikey's Mobile Detailing"), true);
check('punctuation and case drift', geoNameMatches('MIKEYS MOBILE DETAILING', "mikey's mobile detailing"), true);
check('listing carries an LLC suffix', geoNameMatches("Mikey's Mobile Detailing LLC", "Mikey's Mobile Detailing"), true);

// The real-world misses that produced a full grid of 20+.
check('owner typed the city on the end',
  geoNameMatches("Mikey's Mobile Detailing", "Mikey's Detailing Snohomish"), true);
check('owner left "Mobile" out',
  geoNameMatches("Mikey's Mobile Detailing", "Mikey's Detailing"), true);
check('word order swapped',
  geoNameMatches('Mobile Detailing by Mikey', "Mikey's Mobile Detailing"), true);

// The other direction: a competitor must never be reported as your rank.
check('different business, same trade',
  geoNameMatches('Precision Auto Detailing', "Mikey's Mobile Detailing"), false);
check('shares one word, different business',
  geoNameMatches("Mikey's Pizza Kitchen", "Mikey's Detailing Snohomish"), false);
check('generic words alone are not a match',
  geoNameMatches('Mobile Detailing Co', 'Auto Detailing Services'), false);
check('empty side never matches', geoNameMatches('', "Mikey's Mobile Detailing"), false);

console.log('\n=== map rank: scan stats ===');
const allMissed = [{ rank: 21, total: 20 }, { rank: 21, total: 20 }, { rank: 21, total: 20 }];
const s1 = geoStats(allMissed);
check('nothing matched -> ARP null, ATRP 21', [s1.arp, s1.atrp], [null, 21]);
check('nothing matched -> every point counted missing', s1.missing, 3);
check('results came back -> empty stays 0', s1.empty, 0);

const noResults = [{ rank: 21, total: 0 }, { rank: 21, total: 0 }];
check('Google returned nothing -> empty flags it', geoStats(noResults).empty, 2);

const mixed = [{ rank: 1, total: 20 }, { rank: 4, total: 20 }, { rank: 21, total: 20 }, { rank: 2, total: 20 }];
const s2 = geoStats(mixed);
check('ARP averages only where you ranked', s2.arp, 2.33);
check('ATRP counts a miss as 20+', s2.atrp, 7);
check('SoLV is share of top 3', s2.solv, 50);
check('top10 counts ranks 1-10', s2.top10, 3);

console.log(`\n${FAIL ? 'FAILED' : 'OK'} — ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
