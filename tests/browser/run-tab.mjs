import { chromium } from 'playwright-core';
import fs from 'fs';

const HTML = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const now = Date.now();
const at = (h, m, dayOffset = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };

// Mutable server state so we can assert that taps actually change things.
let state = {
  proposals: [{
    id: 'p1', phone: '+14255551234', name: 'Jenna', at: at(10, 0), status: 'proposed', tentative: false,
    customerConfirmed: true, service: 'Full Detail', vehicle: '2019 Tahoe', address: '123 Main St', city: 'Everett',
    price: 339, notes: 'gate code 4412', evidence: 'yes saturday 10am works', confidence: 0.92,
  }],
  changes: [{
    id: 'c1', phone: '+14255557777', name: 'Rob', at: at(14, 0), status: 'scheduled', customerConfirmed: true,
    pendingChange: { kind: 'move', at: at(16, 0), evidence: 'can we push to 4?' },
  }],
  jobs: [{
    id: 'j1', phone: '+14255550001', name: 'Dana', at: at(8, 30), status: 'scheduled', customerConfirmed: false,
    service: 'Interior Detail', vehicle: '2021 Civic', address: '900 Pine St', city: 'Monroe', price: 240,
    notes: 'dog hair, park in alley', leaveAt: at(8, 0), driveMin: 20, tentative: false,
  }],
  upcoming: [{ id: 'u1', phone: '+14255550002', name: 'Chris', at: at(9, 0, 2), status: 'scheduled', customerConfirmed: true }],
};
const sent = [];

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 414, height: 896 } });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|sw\.js|fetching the script/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

await p.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  if (path === '/' || path.endsWith('index.html')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
  if (path === '/api/run') return json({
    ok: true,
    run: { date: url.searchParams.get('date'), jobs: state.jobs, total: state.jobs.reduce((s, j) => s + (j.price || 0), 0),
      unconfirmed: state.jobs.filter((j) => !j.customerConfirmed).length, tentative: 0,
      routeSuggestion: { savesMin: 22, order: [{ id: 'j1', name: 'Dana' }, { id: 'c1', name: 'Rob' }] } },
    weather: { pop: 70, hi: 74, lo: 55, wet: true },
    proposals: state.proposals, changes: state.changes, upcoming: state.upcoming,
    config: { enabled: true, detect: true, briefHour: 7 },
  });
  if (path === '/api/job') {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action === 'confirm') {
      const j = state.proposals.find((x) => x.id === body.id);
      state.proposals = state.proposals.filter((x) => x.id !== body.id);
      j.status = 'scheduled'; state.jobs.push(j); state.jobs.sort((a, c) => a.at - c.at);
      return json({ ok: true, job: j, draft: "Hey Jenna, you're all set for Sat at 10:00 AM — Full Detail. - Mikey", gcal: 'https://calendar.google.com/calendar/render?action=TEMPLATE' });
    }
    if (body.action === 'dismiss') { state.proposals = state.proposals.filter((x) => x.id !== body.id); return json({ ok: true }); }
    if (body.action === 'accept-change') {
      const j = state.changes.find((x) => x.id === body.id);
      j.at = j.pendingChange.at; j.pendingChange = null;
      state.changes = state.changes.filter((x) => x.id !== body.id); state.jobs.push(j);
      return json({ ok: true, job: j, draft: 'Moved you to 4:00 PM. - Mikey' });
    }
    if (body.action === 'edit') {
      const all = [...state.jobs, ...state.proposals];
      const j = all.find((x) => x.id === body.id);
      Object.assign(j, { name: body.name, service: body.service, address: body.address, city: body.city, price: +body.price, notes: body.notes, at: body.at });
      return json({ ok: true, job: j });
    }
    if (body.action === 'done') { state.jobs = state.jobs.filter((x) => x.id !== body.id); return json({ ok: true }); }
    if (body.action === 'confirmed-by-customer') return json({ ok: true });
    return json({ ok: true });
  }
  if (path === '/api/send') { sent.push(JSON.parse(route.request().postData() || '{}')); return json({ ok: true, thread: {} }); }
  if (path === '/api/threads') return json({ ok: true, threads: [], config: {} });
  if (path === '/api/version') return json({ ok: true, build: '2026-07-28·tracking+receipt' });
  if (path === '/api/health') return json({ ok: true, storage: 'ok' });
  if (path.startsWith('/api/')) return json({ ok: true });
  return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
});

await p.goto('https://texting.test/');
await p.waitForTimeout(900);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };

console.log('\nOpening the Today tab');
await p.locator('.navitem[data-tab="run"]').click();
await p.waitForTimeout(700);

ok('tab renders', await p.locator('.run-head').count() === 1);
ok('proposal card shown', await p.locator('.rj-card.proposal').count() === 1);
ok('“Looks like you booked this” flag', (await p.locator('.rj-card.proposal .rj-flag').first().textContent()).includes('Looks like you booked'));
ok('the quoted evidence is shown', (await p.locator('.rj-card.proposal .rj-ev').first().textContent()).includes('saturday 10am works'));
ok('pending change card shown', await p.locator('.rj-card.change').count() === 1);
ok('rain banner shown', (await p.locator('.run-banner.warn').first().textContent()).includes('70%'));
ok('route tip shown', (await p.locator('.run-banner.tip').first().textContent()).includes('22 min'));
ok('scheduled job listed', await p.locator('.rj-card:not(.proposal):not(.change)').count() === 1);
ok('unconfirmed job flagged', await p.locator('.rj-card.unconf').count() === 1);
ok('leave-by time shown', (await p.locator('.rj-leave').first().textContent()).includes('Leave by'));
ok('customer note shown', (await p.locator('.rj-note').first().textContent()).includes('dog hair'));
ok('address links to maps', decodeURIComponent(await p.locator('.rj-addr').first().getAttribute('href')).includes('900 Pine St, Monroe'));
ok('upcoming job listed', await p.locator('.rj-mini').count() === 1);
ok('nav badge counts the 2 cards', (await p.locator('#navRun').textContent()) === '2');

console.log('\nConfirming a detected job');
await p.locator('.rj-card.proposal .btn.accent').click();
await p.waitForTimeout(600);
ok('draft sheet opens', await p.locator('#runDraft').isVisible());
ok('draft is editable text', (await p.locator('#runDraftText').inputValue()).includes("you're all set"));
ok('nothing was texted automatically', sent.length === 0);
ok('“Add to calendar” offered', await p.locator('.rd-acts a').count() === 1);

await p.locator('#runDraftText').fill('Custom message from Mikey. - Mikey');
await p.locator('[data-rd="send"]').click();
await p.waitForTimeout(600);
ok('sending uses the EDITED text', sent.length === 1 && sent[0].body === 'Custom message from Mikey. - Mikey', sent);
ok('draft sheet closes', !(await p.locator('#runDraft').isVisible()));
ok('job moved out of proposals', await p.locator('.rj-card.proposal').count() === 0);
ok('…and onto the day', await p.locator('.rj-card:not(.proposal):not(.change)').count() === 2);

console.log('\nEditing a job inline');
const jobCard = p.locator('.rj-card:not(.proposal):not(.change)').first();
await jobCard.locator('[data-act="edit"]').click();
await p.waitForTimeout(400);
ok('edit form opens', await p.locator('#rjAddress').count() === 1);
await p.locator('#rjAddress').fill('555 New Address');
await p.locator('#rjPrice').fill('400');
await p.locator('[data-act="save"]').click();
await p.waitForTimeout(600);
ok('edited address persisted', decodeURIComponent(await p.locator('.rj-addr').first().getAttribute('href')).includes('555 New Address'));
ok('edited price shown', (await p.content()).includes('$400'));

console.log('\nDay navigation');
await p.locator('[data-run="next"]').click();
await p.waitForTimeout(500);
ok('moves to Tomorrow', (await p.locator('.run-title b').textContent()) === 'Tomorrow');
await p.locator('[data-run="prev"]').click();
await p.waitForTimeout(500);
ok('back to Today', (await p.locator('.run-title b').textContent()) === 'Today');

console.log('\nDismissing a false positive');
state.proposals = [{ id: 'p2', phone: '+1425', name: 'Sam', at: at(11, 0), status: 'proposed', evidence: 'maybe next week', confidence: 0.5, tentative: true }];
await p.locator('.navitem[data-tab="home"]').click(); await p.waitForTimeout(200);
await p.locator('.navitem[data-tab="run"]').click(); await p.waitForTimeout(700);
ok('new proposal appears', await p.locator('.rj-card.proposal').count() === 1);
ok('loose time is called out', (await p.locator('.rj-tent').first().textContent()).includes('not pinned down'));
await p.locator('.rj-card.proposal [data-act="dismiss"]').click();
await p.waitForTimeout(600);
ok('dismissed card disappears', await p.locator('.rj-card.proposal').count() === 0);

console.log('\nJS errors:', errs.length ? errs : 'none');
if (errs.length) fail += errs.length;
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
