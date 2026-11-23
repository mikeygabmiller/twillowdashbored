// The AI playbook (2026-11-23). Every draft quotes from it, and for months it
// said $200 / $130 / $260 while the website charged $249 / $199 / $369. These
// keep the retired numbers out, check the worked quotes still add up from the
// price book, and check the seed carries a stored copy forward.
import fs from 'fs';
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = { async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
const M = new Function('__env__', src + '\n; ENV = __env__; return { defaultPlaybook, seedPlaybookIfNeeded, loadConfig, resetInvocationCaches, PLAYBOOK_SEED_VERSION };')({ MESSAGES: kv });
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const P = M.defaultPlaybook(), all = Object.values(P).join('\n');

console.log('\nThe price book, not the old prices');
ok('the three services at the website\'s prices', /Exterior Detail: \$199 \/ \$239 \/ \$279/.test(P.services) && /Interior Detail: \$249 \/ \$289 \/ \$329/.test(P.services) && /Full Detail, inside and out: \$369 \/ \$409 \/ \$449/.test(P.services));
for (const bad of ['$200', '$130', '$260', '$160', '30 seconds', '3–4 hours', '3-4 hours', 'Wednesday', 'Sultan', 'Apple Pay is', 'pre-sale detail is $300', '20 ft'])
  ok(`no "${bad}"`, !all.includes(bad));
ok('no em dash anywhere', !/—/.test(all));
ok('payment is cash, check, Venmo or Zelle, no cards', /cash, check, Venmo or Zelle\. No cards/.test(P.booking));
ok('Lynnwood and Edmonds are not served', /Lynnwood and Edmonds are not served/.test(P.area));
ok('never claims licensed or insured', /Never say or hint that Mikey is licensed or insured/.test(P.rules));

console.log('\nEvery worked quote adds up from the price book');
const sums = [...P.quoting.matchAll(/(\$\d+(?: \+ \$\d+)+) = \$(\d+)/g)];
ok('there are worked quotes to check', sums.length >= 5, sums.length);
for (const m of sums) {
  const total = m[1].split('+').reduce((a, x) => a + Number(x.replace(/[^\d]/g, '')), 0);
  ok(`${m[0]}`, total === Number(m[2]), total);
}
const book = new Set([199, 239, 279, 249, 289, 329, 369, 409, 449, 20, 30, 10, 60]);
for (const m of sums) for (const x of m[1].split('+')) ok(`  ${x.trim()} is a price-book number`, book.has(Number(x.replace(/[^\d]/g, ''))));

console.log('\nA stored playbook from before is carried forward once');
store.set('config', JSON.stringify({ playbookSeed: 4, playbook: { services: 'Interior Detail — starts at $200' } }));
M.resetInvocationCaches();
await M.seedPlaybookIfNeeded();
let c = JSON.parse(store.get('config'));
ok('the stored services are the new ones', /\$249 \/ \$289 \/ \$329/.test(c.playbook.services));
ok('stamped with the new seed version', c.playbookSeed === M.PLAYBOOK_SEED_VERSION && M.PLAYBOOK_SEED_VERSION === 5);
c.playbook.tone = 'his own edit'; store.set('config', JSON.stringify(c)); M.resetInvocationCaches();
await M.seedPlaybookIfNeeded();
ok('a later edit of his is never overwritten', JSON.parse(store.get('config')).playbook.tone === 'his own edit');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
