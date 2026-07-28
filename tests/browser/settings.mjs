import { chromium } from 'playwright-core';
import fs from 'fs';
const HTML = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

let config = { followupsEnabled: true, dayOf: { enabled: true, detect: true, briefHour: 7, recap: true, leaveAlerts: true, setupMin: 10, idleDayPing: true, weatherWarn: true, rainPct: 50 } };
const saves = [];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await p.route('**/*', async (route) => {
  const path = new URL(route.request().url()).pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/config' && route.request().method() === 'POST') {
    const body = JSON.parse(route.request().postData() || '{}');
    saves.push(body);
    if (body.dayOf) config.dayOf = Object.assign({}, config.dayOf, body.dayOf);
    return json({ ok: true, config });
  }
  if (path === '/api/config') return json({ ok: true, config });
  if (path === '/api/threads') return json({ ok: true, threads: [], config });
  if (path === '/api/run') return json({ ok: true, run: { jobs: [], total: 0 }, proposals: [], changes: [], upcoming: [], config: config.dayOf });
  if (path === '/api/version') return json({ ok: true, build: '2026-07-28·tracking+receipt' });
  if (path.startsWith('/api/')) return json({ ok: true, config });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await p.goto('https://texting.test/');
await p.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

console.log('\nDay-of settings in the menu');
await p.locator('#menuBtn, [data-ic="menu"]').first().click();
await p.waitForTimeout(500);
ok('panel renders', await p.locator('#dayOfSettings').count() === 1);
ok('master switch present', await p.locator('#doEnabled').count() === 1);
ok('master switch reads ON', (await p.locator('#doEnabled').getAttribute('class')).includes('on'));
ok('brief hour shows 7', await p.locator('#doBrief').inputValue() === '7');
ok('setup padding shows 10', await p.locator('#doSetup').inputValue() === '10');

await p.locator('#doEnabled').click();
await p.waitForTimeout(500);
ok('toggling master switch saves', saves.length === 1 && saves[0].dayOf.enabled === false, saves);
ok('other settings preserved on save', saves[0].dayOf.briefHour === 7 && saves[0].dayOf.setupMin === 10, saves[0].dayOf);
ok('switch reflects OFF after save', !(await p.locator('#doEnabled').getAttribute('class')).includes(' on'));

const last = () => saves[saves.length - 1].dayOf;
await p.locator('#doBrief').fill('6');
await p.locator('#doBrief').blur();
await p.waitForTimeout(500);
ok('brief hour saves', last().briefHour === 6, last());
ok('…and keeps the master switch off', last().enabled === false);

await p.locator('#doSetup').fill('20');
await p.locator('#doSetup').blur();
await p.waitForTimeout(500);
ok('setup padding saves', last().setupMin === 20, last());
ok('…without clobbering the brief hour', last().briefHour === 6, last());
console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
