// The "app ≠ server" footer.
//
// This is the one thing in the app that tells you a deploy landed but you are
// not running it — an installed PWA can hold a document open for days. It used
// to state the problem and stop, which left "close and reopen it" as folklore.
// So the two things worth testing are that it detects the mismatch honestly,
// and that the way out is on screen and does the right things.
//
// The "right things" specifically exclude unregistering the service worker: the
// Web Push subscription lives on that registration, and dropping it would stop
// the phone ringing for new texts to fix a cosmetic staleness.
import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const APP_BUILD = (HTML.match(/var\s+APP_BUILD\s*=\s*"([^"]+)"/) || [])[1];
const threads = [{ phone: '+14255551234', name: 'Jenna Smith', status: 'new', unread: 0, lastBody: 'hi', lastDir: 'in', lastTs: Date.now(), tags: [] }];

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const errs = [];

// serverBuild drives whether the footer should agree or complain.
async function openApp(serverBuild) {
  const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  const hits = { reload: 0, reloadCache: [] };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url()); const path = u.pathname;
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (path === '/') {
      hits.reload++; hits.reloadCache.push(req.headers()['cache-control'] || '');
      return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    }
    if (path === '/api/version') return json({ ok: true, build: serverBuild });
    if (path === '/api/threads') return json({ ok: true, threads, config: {} });
    if (path.startsWith('/api/')) return json({ ok: true });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await page.goto('https://texting.test/');
  await page.waitForTimeout(900);
  // More → Tools & account is where the build stamp lives
  await page.evaluate(() => document.getElementById('vxFab').style.display = 'none');
  await page.locator('.navitem[data-tab="more"]').click();
  await page.waitForTimeout(600);
  await page.locator('#mrBody .mr-row', { hasText: 'Tools & account' }).first().click();
  await page.waitForTimeout(900);
  return { page, hits };
}

section('Matching builds say so, and offer nothing to fix');
{
  const { page } = await openApp(APP_BUILD);
  const txt = await page.locator('#buildStamp').textContent();
  ok('the footer reads live', /✓ live/.test(txt), txt);
  ok('and names both builds', txt.includes(APP_BUILD), txt);
  ok('no update button when there is nothing to update', (await page.locator('#buildUpdate').count()) === 0);
  await page.close();
}

section('A newer server is called out, with the way out attached');
{
  const { page, hits } = await openApp('2099-01-01·newer');
  const txt = await page.locator('#buildStamp').textContent();
  ok('the footer flags the mismatch', /⚠ mismatch/.test(txt), txt);
  ok('it shows the build this tab is running', txt.includes(APP_BUILD), txt);
  ok('and the one the server has', txt.includes('2099-01-01·newer'), txt);
  ok('an Update now button is offered', (await page.locator('#buildUpdate').count()) === 1);
  ok('it is visible, not buried', await page.locator('#buildUpdate').isVisible());
  ok('and it says what is wrong in words', /older copy/.test(txt), txt);

  // What the button does. A reload alone can be answered from the HTTP disk
  // cache with the very page we are trying to replace, so it has to re-fetch
  // past it — and it must leave the service worker registration alone.
  // The button ends in location.reload(), which wipes any state left in the
  // page — so the instrumentation reports each call out to Node as it happens
  // rather than being read back afterwards.
  const before = hits.reload;
  const seen = { unregister: 0, update: 0, cacheDeleted: [], fetches: [] };
  await page.exposeFunction('__rec', (o) => {
    if (o.k === 'fetch') seen.fetches.push(o);
    else if (o.k === 'cacheDelete') seen.cacheDeleted.push(o.name);
    else if (o.k === 'update') seen.update++;
    else if (o.k === 'unregister') seen.unregister++;
  });
  await page.evaluate(() => {
    const f = window.fetch;
    window.fetch = (u, init) => { window.__rec({ k: 'fetch', u: String(u), cache: (init || {}).cache || '' }); return f(u, init); };
    navigator.serviceWorker.getRegistrations = () => Promise.resolve([{
      update: () => { window.__rec({ k: 'update' }); return Promise.resolve(); },
      unregister: () => { window.__rec({ k: 'unregister' }); return Promise.resolve(true); },
    }]);
    // Two cached shells to be cleared, so "it cleared them" is a real
    // observation. defineProperty, not assignment: caches is a read-only
    // accessor on the global, and a plain assignment quietly does nothing.
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        keys: () => Promise.resolve(['mkd-shell-v17', 'mkd-shell-v16']),
        delete: (k) => { window.__rec({ k: 'cacheDelete', name: k }); return Promise.resolve(true); },
      },
    });
  });
  await page.locator('#buildUpdate').click();
  await page.waitForTimeout(2000);
  ok('the button re-fetched the page', hits.reload > before, { before, after: hits.reload });
  ok('it re-fetched past the HTTP cache', seen.fetches.some((x) => x.cache === 'reload'), seen.fetches);
  ok('it dropped every cached shell', seen.cacheDeleted.length === 2, seen.cacheDeleted);
  ok('it nudged the service worker to update', seen.update === 1, seen.update);
  ok('it did NOT unregister the service worker (push lives there)', seen.unregister === 0, seen.unregister);
  await page.close();
}

console.log('\nJS errors:', errs.length ? '\n  ' + errs.join('\n  ') : 'none');
if (errs.length) fail += errs.length;
console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
await browser.close();
process.exit(fail ? 1 : 0);
