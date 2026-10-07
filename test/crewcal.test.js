// JP's calendar: confirmed jobs go on the calendar Mikey shares with his
// helper, by themselves, and Mikey hears about each one.
//
// End to end through the real Worker, with fake KV, Twilio, Resend, Google's
// public calendar feed, and two fake Apps Scripts (his own calendar's and
// JP's), because the point is which jobs reach which calendar: JP drives to
// what's on his, so a request Mikey hasn't confirmed, a time nobody agreed, or
// a job that was cancelled must never be on it.
//
//   node test/crewcal.test.js
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

const store = new Map();
const KV = {
  async get(k, o) { const v = store.has(k) ? store.get(k) : null; if (v == null) return null; return o && (o.type === 'json' || o === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { store.delete(k); },
  async list(o) { const p = (o && o.prefix) || ''; return { keys: [...store.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true }; },
};
const MINE = 'https://script.google.com/macros/s/AKfyMINE/exec';
const CREW = 'https://script.google.com/macros/s/AKfyCREW/exec';
const CAL_ID = 'abc123def456@group.calendar.google.com';
let mineKey = '', crewKey = '';
let isPublic = true, googleDown = false, crewBroken = false;
const emails = [], crewCalls = [];
const mine = new Map(), crew = new Map();   // the two fake calendars: id -> event
function fakeScript(cal, key, d, name) {
  if (d.key !== key) return { ok: false, error: 'wrong key' };
  if (d.op === 'ping') return { ok: true, calendar: name, owned: true };
  if (d.op === 'upsert') {
    const had = cal.get(d.id);
    cal.set(d.id, d);
    return { ok: true, created: !had, moved: !!had && (had.start !== d.start || had.end !== d.end || had.location !== d.location) };
  }
  if (d.op === 'delete') return { ok: true, deleted: cal.delete(d.id) };
  return { ok: false, error: 'unknown op' };
}
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === MINE) return new Response(JSON.stringify(fakeScript(mine, mineKey, JSON.parse(init.body), 'Mikey')));
  if (u === CREW) {
    const d = JSON.parse(init.body); crewCalls.push(d);
    if (crewBroken && d.op !== 'ping') return new Response(JSON.stringify({ ok: false, error: 'Exception: You do not have permission' }));
    return new Response(JSON.stringify(fakeScript(crew, crewKey, d, 'WORK')));
  }
  if (u.startsWith('https://calendar.google.com/calendar/ical/')) {
    if (googleDown) throw new Error('network');
    ok(u.includes(encodeURIComponent(CAL_ID)) && u.endsWith('/public/basic.ics'), 'the privacy check asks for this calendar\'s public feed → ' + u);
    return isPublic
      ? new Response('BEGIN:VCALENDAR\nX-WR-CALNAME:WORK\nEND:VCALENDAR\n', { status: 200 })
      : new Response('<html>Not Found</html>', { status: 404 });
  }
  if (u.includes('api.resend.com')) { emails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'e' }), { status: 200 }); }
  if (u.includes('api.twilio.com')) return new Response(JSON.stringify({ sid: 'SM1', status: 'queued' }), { status: 201 });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const ENV = { TWILIO_AUTH_TOKEN: 't', TWILIO_ACCOUNT_SID: 'AC', TWILIO_FROM: '+14255550000', MIKEY_PHONE: '+14255550001',
  MESSAGES: KV, RESEND_API_KEY: 're_x', ALERT_EMAIL: 'm@example.com', PUBLIC_BASE_URL: 'https://dash.test' };
const worker = (await import('../src/index.js')).default;

let waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
const settle = async () => { while (waits.length) { const w = waits; waits = []; await Promise.allSettled(w); } };
let ipN = 0;
async function call(method, path, body) {
  const req = new Request('https://dash.test' + path, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.2.0.' + (++ipN) }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, ENV, ctx);
  await settle();
  try { return await res.json(); } catch { return null; }
}
let nth = 0;
async function book(city, name, extra) {
  const o = await call('GET', '/api/next-openings?service=full&size=suv&n=6');
  const s = o.openings[(nth++) % o.openings.length];
  return call('POST', '/api/book', Object.assign({ service: 'full', size: 'suv', sizeLabel: 'SUV / Pickup', date: s.date, slot: s.slot, name,
    phone: '425555' + String(2000 + ipN).slice(-4), address: '12 Pine St', city, vehicle: '2019 Honda Pilot', condition: 'Really rough' }, extra || {}));
}
const crewMail = (re) => emails.filter((e) => /JP's calendar/.test(e.subject) && (!re || re.test(e.subject)));
const tomorrow = () => new Date(Date.now() + 2 * 86400000 - 7 * 3600000).toISOString().slice(0, 10);

console.log('\nBefore setup: bookings work and nothing goes anywhere near JP');
{
  const r = await book('Snohomish', 'Ann Before');
  ok(r && r.ok && r.status === 'confirmed', 'a booking in his towns confirms → ' + JSON.stringify(r));
  ok(crewCalls.length === 0 && crew.size === 0, 'no call to a script that isn\'t there');
  ok(crewMail().length === 0, 'and no alert about JP');
}

console.log('\nHis own calendar, connected the way it always was');
{
  const g = await call('GET', '/api/gcal-setup');
  mineKey = g.script.match(/var KEY = '([A-Za-z0-9]+)'/)[1];
  ok(/var CAL = '';/.test(g.script) && !/__CAL__|__KEY__/.test(g.script), 'his own script writes to his main calendar, no placeholders left');
  const c = await call('POST', '/api/gcal-setup', { url: MINE });
  ok(c.ok && c.connected && c.calendar === 'Mikey', 'his own calendar connects');
}

console.log('\nSetup: the calendar id, the script, and no public calendar');
{
  const g = await call('GET', '/api/gcal-crew');
  ok(g.ok && !g.connected && !g.script && g.who === 'JP', 'starts unconnected, no script until it has a calendar → ' + JSON.stringify(g));
  const bad = await call('POST', '/api/gcal-crew', { calId: "x'; DriveApp.getRootFolder(); '" });
  ok(!bad.ok && /Calendar ID/.test(bad.error), 'something that isn\'t a calendar id is refused in words');
  const secret = await call('POST', '/api/gcal-crew', { calId: 'https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-0123/basic.ics' });
  ok(!secret.ok, 'the secret iCal address is not a calendar id');
  const s = await call('POST', '/api/gcal-crew', { calId: '  ' + CAL_ID + ' ' });
  ok(s.ok && s.calId === CAL_ID && !s.connected, 'the id saves, trimmed');
  const m = s.script.match(/var KEY = '([A-Za-z0-9]+)'/);
  ok(!!m && m[1].length >= 20 && m[1] !== mineKey, 'JP\'s script has its own long key');
  ok(s.script.includes(`var CAL = '${CAL_ID}';`), 'and writes only to that calendar');
  ok(!/__CAL__|__KEY__/.test(s.script), 'no placeholders left in what he copies');
  crewKey = m ? m[1] : '';
  const embed = await call('POST', '/api/gcal-crew', { calId: 'https://calendar.google.com/calendar/embed?src=' + encodeURIComponent(CAL_ID) + '&ctz=America%2FLos_Angeles' });
  ok(embed.ok && embed.calId === CAL_ID && embed.script === s.script, 'pasting the public URL instead finds the same id, same script');

  isPublic = true;
  const pub = await call('POST', '/api/gcal-crew', { url: CREW });
  ok(!pub.ok && /public/.test(pub.error) && /Make available to public/.test(pub.error), 'a public calendar is refused, with where to switch it off → ' + pub.error);
  ok(!crewCalls.length, 'and the script is never even pinged');
  isPublic = false;
  const c = await call('POST', '/api/gcal-crew', { url: CREW });
  ok(c.ok && c.connected && c.calendar === 'WORK', 'private: Connect pings the script and names the calendar → ' + JSON.stringify(c));
  const again = await call('GET', '/api/gcal-crew');
  ok(again.connected && again.calendar === 'WORK' && again.script === s.script, 'and it stays connected');
}

console.log('\nThe catch-up puts the confirmed jobs on, quietly, and only those');
{
  await book('Seattle', 'Pat Pending');   // a request he hasn't confirmed
  const before = emails.length;
  const r = await call('POST', '/api/gcal-crew-sync-all', {});
  ok(r.ok && r.added === 1 && r.updated === 0, 'the one confirmed booking from before setup goes on → ' + JSON.stringify(r));
  ok([...crew.values()].some((e) => /Ann Before/.test(e.title)) && ![...crew.values()].some((e) => /Pat Pending/.test(e.title)), 'the unconfirmed request stays off');
  ok(emails.length === before, 'no email per job on a catch-up he tapped');
  const r2 = await call('POST', '/api/gcal-crew-sync-all', {});
  ok(r2.ok && r2.added === 0 && r2.updated === 1 && crew.size === 1, 'tapping twice never makes a second event');
  const mineBefore = mine.size;
  const crewBefore = crewCalls.length;
  await call('POST', '/api/gcal-sync-all', {});
  ok(crewCalls.length === crewBefore && mine.size >= mineBefore, 'his own catch-up doesn\'t touch JP\'s calendar');
}

console.log('\nA request goes on only once he confirms it, with what JP needs');
let reqId = '';
{
  const r = await book('Seattle', 'Ray Request', { addons: ['Pet Hair Removal'], notes: 'Gate code 4412, dog in the yard' });
  reqId = r.id;
  ok(r.ok && r.status === 'pending', 'out of area is a request');
  ok(!crew.has(reqId), 'not on JP\'s calendar while it\'s a request');
  ok(mine.has(reqId), 'but on Mikey\'s own, marked NOT CONFIRMED, as before');
  emails.length = 0;
  await call('POST', '/api/booking', { id: reqId, action: 'confirm' });
  const ev = crew.get(reqId);
  ok(!!ev, 'confirm puts it on JP\'s calendar');
  ok(ev && ev.title === '🚗 Full Detail · Ray Request (Seattle)', 'titled with the job, the name and the town → ' + (ev && ev.title));
  ok(ev && ev.location === '12 Pine St, Seattle', 'the address is the location, so a tap opens Maps');
  ok(ev && ev.end - ev.start >= 3 * 3600000, 'it lasts as long as the job');
  const d = (ev && ev.description) || '';
  ok(/SUV \/ Pickup · 2019 Honda Pilot · Really rough/.test(d), 'the size, the car and its condition → ' + d.split('\n')[0]);
  ok(/Add-ons: Pet Hair Removal/.test(d), 'the add-ons');
  ok(/Customer: Ray Request · \(425\) 555-\d{4}/.test(d), 'the customer\'s name and a phone number he can tap');
  ok(/Gate code 4412, dog in the yard/.test(d), 'their notes');
  ok(/spigot and outlet/.test(d), 'that the customer has the water and power');
  ok(!/\$/.test(d), 'never the price');
  ok(Array.isArray(ev.popups) && ev.popups.length === 0, 'no reminders set from here: each person sets their own');
  const m = crewMail(/On JP's calendar/);
  ok(m.length === 1 && /Ray Request/.test(m[0].subject), 'Mikey gets one alert that it went on → ' + (m[0] && m[0].subject));
  ok(m[0] && /What JP sees:/.test(m[0].text) && /Gate code 4412/.test(m[0].text), 'showing exactly what JP sees');
  ok(m[0] && /Nothing was sent to the customer/.test(m[0].text), 'and that the customer wasn\'t texted about it');
  ok(!/—/.test(m[0].subject + m[0].text + d), 'no em dashes in what JP or Mikey read');
}

console.log('\nAn instant booking goes straight on');
{
  emails.length = 0;
  const r = await book('Everett', 'Ed Instant');
  ok(r.ok && r.status === 'confirmed' && crew.has(r.id), 'confirmed by itself, on JP\'s calendar by itself');
  ok(crewMail(/On JP's calendar.*Ed Instant/).length === 1, 'with the alert');
}

console.log('\nCancelled or declined comes off, and Mikey hears it');
{
  emails.length = 0;
  await call('POST', '/api/booking', { id: reqId, action: 'cancel' });
  ok(!crew.has(reqId) && !mine.has(reqId), 'off both calendars');
  ok(crewMail(/Off JP's calendar.*Ray Request/).length === 1, 'and an alert that it came off');
  const p = (await book('Seattle', 'Dee Declined')).id;
  const callsBefore = crewCalls.length;
  emails.length = 0;
  await call('POST', '/api/booking', { id: p, action: 'decline' });
  ok(crewCalls.length === callsBefore, 'declining a request that was never on JP\'s calendar costs no call');
  ok(crewMail().length === 0, 'and no alert');
}

console.log('\nThe customer cancelling from their own link takes it off both calendars');
{
  const r = await book('Monroe', 'Cy Cancel');
  const all = JSON.parse(store.get('bk:index'));
  const bk = all.find((b) => b.id === r.id);
  ok(crew.has(r.id) && mine.has(r.id), 'it was on both');
  store.set('cust:tok123456789abc', JSON.stringify({ phone: bk.phone, createdAt: Date.now() }));
  emails.length = 0;
  const res = await call('POST', '/api/cust/action?t=tok123456789abc', { action: 'cancel', id: r.id });
  ok(res && res.ok && res.cancelled, 'their cancel goes through → ' + JSON.stringify(res));
  ok(!crew.has(r.id), 'off JP\'s calendar, so he doesn\'t drive to it');
  ok(!mine.has(r.id), 'and off Mikey\'s own (it used to stay there)');
  ok(crewMail(/Off JP's calendar.*Cy Cancel/).length === 1, 'and Mikey hears it came off JP\'s');
}

console.log('\nJobs on the day board: on with a real time, off without one');
{
  const date = tomorrow();
  emails.length = 0;
  const j = await call('POST', '/api/day/job', { date, name: 'Cash Carl', phone: '4255557777', slot: '13:00', service: 'Exterior Detail', vehicle: 'F-150',
    address: '7 Oak Rd', city: 'Lake Stevens', durationMin: 120, price: 199, notes: 'Side gate, code 9911' });
  ok(j && j.ok, 'he types a job on the board');
  const id = [...crew.keys()].find((k) => /^m:/.test(k));
  const ev = crew.get(id);
  ok(ev && ev.title === '🚗 Exterior Detail · Cash Carl (Lake Stevens)', 'it goes on JP\'s calendar → ' + (ev && ev.title));
  ok(ev && /\(425\) 555-7777/.test(ev.description) && /code 9911/.test(ev.description) && !/\$/.test(ev.description), 'with the phone and his notes, never the price');
  ok(crewMail(/On JP's calendar.*Cash Carl/).length === 1, 'and the alert');

  emails.length = 0;
  await call('POST', '/api/day/job', { date, id, name: 'Cash Carl', phone: '4255557777', slot: '13:00', service: 'Exterior Detail', vehicle: 'F-150',
    address: '7 Oak Rd', city: 'Lake Stevens', durationMin: 120, price: 199, notes: 'Side gate, code 9911. Bring the long hose' });
  ok(crew.size && /long hose/.test(crew.get(id).description), 'an edit to the notes updates JP\'s copy');
  ok(crewMail().length === 0, 'without an alert: nothing about when or where changed');

  await call('POST', '/api/day/job', { date, id, name: 'Cash Carl', phone: '4255557777', slot: '15:00', service: 'Exterior Detail', vehicle: 'F-150',
    address: '7 Oak Rd', city: 'Lake Stevens', durationMin: 120, price: 199 });
  ok(crew.get(id).start === ev.start + 2 * 3600000, 'a new time moves the same event');
  ok(crewMail(/Changed on JP's calendar/).length === 1, 'and Mikey hears it changed');

  emails.length = 0;
  await call('POST', '/api/day/remove', { date, jobId: id });
  ok(!crew.has(id), 'off the board is off JP\'s calendar');
  const off = crewMail(/Off JP's calendar/);
  ok(off.length === 1 && /Cash Carl/.test(off[0].subject), 'and the alert says which job → ' + (off[0] && off[0].subject));

  emails.length = 0;
  const past = new Date(Date.now() - 2 * 86400000 - 7 * 3600000).toISOString().slice(0, 10);
  await call('POST', '/api/day/job', { date: past, name: 'Logged Later', slot: '09:00', service: 'Interior' });
  ok(![...crew.values()].some((e) => /Logged Later/.test(e.title)) && !crewMail().length, 'a job typed in after it happened doesn\'t go to JP');
}

console.log('\nA time nobody agreed stays off until it\'s pinned');
{
  const date = tomorrow();
  const det = { id: 'd9', phone: '+14255550999', kind: 'set', name: 'Sat Sue', date, slot: '09:00', at: 0,
    tentative: true, customerConfirmed: true, service: 'Interior Detail', vehicle: '', address: '3 Elm St', city: 'Monroe', price: 0, notes: '', durationMin: 180,
    confidence: 0.8, evidence: 'saturday works', at_: Date.now() };
  await KV.put('det:index', JSON.stringify([det]));
  emails.length = 0;
  await call('POST', '/api/detection', { id: 'd9', action: 'confirm' });
  ok([...mine.values()].some((e) => /TIME NOT SET.*Sat Sue/.test(e.title)), 'on Mikey\'s own calendar, marked TIME NOT SET');
  ok(![...crew.values()].some((e) => /Sat Sue/.test(e.title)), 'but not on JP\'s');
  ok(!crewMail().length, 'and no JP alert');
  const day = JSON.parse(store.get('day:' + date));
  const job = day.manual.find((m) => m.name === 'Sat Sue');
  await call('POST', '/api/day/job', { date, id: job.id, name: 'Sat Sue', phone: job.phone, slot: '10:00', service: 'Interior Detail', address: '3 Elm St', city: 'Monroe', durationMin: 180 });
  ok(crew.has(job.id), 'once he saves it with a real time, it goes on JP\'s');
  ok(crewMail(/On JP's calendar.*Sat Sue/).length === 1, 'with the alert');
}

console.log('\nWhen it can\'t go on, Mikey is told loudly, because JP doesn\'t know');
{
  isPublic = true;
  emails.length = 0;
  const r = await book('Bothell', 'Pub Lick');
  ok(r.ok && r.status === 'confirmed', 'the booking itself is never held up');
  ok(!crew.has(r.id), 'a calendar that went public gets nothing');
  const m = crewMail(/NOT on JP's calendar.*Pub Lick/);
  ok(m.length === 1 && /public/.test(m[0].text) && /Text JP this one yourself/.test(m[0].text), 'the alert says why and what to do → ' + (m[0] && m[0].subject));
  const sa = await call('POST', '/api/gcal-crew-sync-all', {});
  ok(!sa.ok && /public/.test(sa.error), 'the catch-up refuses too');
  isPublic = false;

  googleDown = true;
  emails.length = 0;
  const r2 = await book('Bothell', 'Net Down');
  ok(!crew.has(r2.id), 'if Google can\'t say it\'s private, it waits');
  const m2 = crewMail(/NOT on JP's calendar.*Net Down/);
  ok(m2.length === 1 && /didn't answer/.test(m2[0].text) && !/is public/.test(m2[0].text), 'and says that, not that the calendar is public');
  googleDown = false;

  crewBroken = true;
  emails.length = 0;
  const r3 = await book('Bothell', 'Perm Denied');
  ok(crewMail(/NOT on JP's calendar.*Perm Denied/).length === 1, 'a script that can\'t write → the same loud alert');
  crewBroken = false;

  const after = await call('POST', '/api/gcal-crew-sync-all', {});
  ok(after.ok && crew.has(r.id) && crew.has(r2.id) && crew.has(r3.id), 'and the catch-up puts all three on once it\'s fixed → ' + JSON.stringify(after));
}

console.log('\nHis helper\'s name is whatever he calls him');
{
  const cfg = JSON.parse(store.get('money:cfg') || '{}');
  store.set('money:cfg', JSON.stringify(Object.assign(cfg, { jpName: 'Jordan' })));
  emails.length = 0;
  const r = await book('Duvall', 'Nia Name');
  ok(emails.some((e) => /On Jordan's calendar.*Nia Name/.test(e.subject)), 'the alert uses the name from the money settings');
  const g = await call('GET', '/api/gcal-crew');
  ok(g.who === 'Jordan', 'and so does the settings screen');
  ok(r.ok, 'booked');
}

console.log('\nChanging the calendar disconnects until the new script is deployed');
{
  const r = await call('POST', '/api/gcal-crew', { calId: 'zzz999@group.calendar.google.com' });
  ok(r.ok && !r.connected && r.script.includes("var CAL = 'zzz999@group.calendar.google.com';"), 'a different calendar needs its own script → ' + JSON.stringify({ c: r.connected }));
  const before = crewCalls.length;
  await book('Arlington', 'Off Line');
  ok(crewCalls.length === before, 'and nothing is sent to the old one meanwhile');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
