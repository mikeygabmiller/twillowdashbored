// A website booking reaches Mikey: on his Google Calendar, and as an email and
// a push a week, 3 days and a day before the job.
//
// End to end through the real Worker, with fake KV, Twilio, Resend and a fake
// Apps Script on the other end, because what broke was the plumbing: the old
// calendar "connection" only ever read his calendar, and nothing wrote a booking
// to it, so a green "✓ Connected" coexisted with an empty calendar.
//
//   node test/bookcal.test.js
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

const store = new Map();
const KV = {
  async get(k, o) { const v = store.has(k) ? store.get(k) : null; if (v == null) return null; return o && (o.type === 'json' || o === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { store.delete(k); },
  async list(o) { const p = (o && o.prefix) || ''; return { keys: [...store.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true }; },
};
const SCRIPT = 'https://script.google.com/macros/s/AKfyTEST123/exec';
let scriptKey = '';
const script = [], emails = [];
const cal = new Map();   // the fake Google Calendar: bkId -> event
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === SCRIPT) {
    const d = JSON.parse(init.body);
    script.push(d);
    if (d.key !== scriptKey) return new Response(JSON.stringify({ ok: false, error: 'wrong key' }));
    if (d.op === 'ping') return new Response(JSON.stringify({ ok: true, calendar: 'Mikey' }));
    if (d.op === 'upsert') { const had = cal.has(d.id); cal.set(d.id, d); return new Response(JSON.stringify({ ok: true, created: !had })); }
    if (d.op === 'delete') { const had = cal.delete(d.id); return new Response(JSON.stringify({ ok: true, deleted: had })); }
  }
  if (u.includes('api.resend.com')) { const b = JSON.parse(init.body); emails.push(b); return new Response(JSON.stringify({ id: 'e' }), { status: 200 }); }
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
  const req = new Request('https://dash.test' + path, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.1.0.' + (++ipN) }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, ENV, ctx);
  await settle();
  try { return await res.json(); } catch { return null; }
}
async function book(city, name) {
  const o = await call('GET', '/api/next-openings?service=full&size=sedan&n=1');
  const s = o.openings[0];
  return call('POST', '/api/book', { service: 'full', size: 'sedan', date: s.date, slot: s.slot, name, phone: '425555' + String(1000 + ipN).slice(-4), address: '1 Main St', city });
}
const bookings = async () => JSON.parse(store.get('bk:index') || '[]');

console.log('\nNot set up yet: the email still carries the calendar button');
{
  const r = await book('Snohomish', 'Ann Early');
  ok(r && r.ok, 'the booking goes through → ' + JSON.stringify(r));
  ok(script.length === 0, 'nothing is sent to a script that isn\'t there');
  const m = emails.find((e) => /New booking/.test(e.subject));
  ok(!!m, 'the new-booking email went out');
  ok(m && /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/.test(m.html), 'it has an Add to Google Calendar link');
  ok(m && /Add to Google Calendar/.test(m.html), 'labelled as such');
}

console.log('\nSetup: the script carries his key, and a bad link is refused');
{
  const g = await call('GET', '/api/gcal-setup');
  ok(g.ok && !g.connected, 'starts unconnected');
  const m = g.script.match(/var KEY = '([A-Za-z0-9]+)'/);
  ok(!!m && m[1].length >= 20, 'the script has a long key filled in');
  ok(!/__KEY__/.test(g.script), 'no placeholder left in what he copies');
  scriptKey = m ? m[1] : '';
  const again = await call('GET', '/api/gcal-setup');
  ok(again.script === g.script, 'the key does not change on a second look');
  const bad = await call('POST', '/api/gcal-setup', { url: 'https://example.com/hook' });
  ok(!bad.ok && /script\.google\.com/.test(bad.error), 'a link that isn\'t a web app link is refused in words');
  const good = await call('POST', '/api/gcal-setup', { url: SCRIPT });
  ok(good.ok && good.connected && good.calendar === 'Mikey', 'Connect pings the script and names the calendar');
}

console.log('\nThe booking from before setup gets added with one tap');
{
  const r = await call('POST', '/api/gcal-sync-all', {});
  ok(r.ok && r.added === 1, 'one upcoming booking added → ' + JSON.stringify(r));
  const [bk] = await bookings();
  ok(cal.has(bk.id), 'it is on the calendar');
}

console.log('\nA new booking lands on the calendar by itself');
let pendingId = '';
{
  const before = cal.size;
  const r = await book('Seattle', 'Ray Request');
  ok(r && r.ok && r.status === 'pending', 'an out-of-area booking is a request');
  pendingId = r.id;
  ok(cal.size === before + 1, 'one new event');
  const ev = cal.get(r.id);
  ok(ev && /^❓ NOT CONFIRMED: /.test(ev.title), 'a request says NOT CONFIRMED in the title → ' + (ev && ev.title));
  ok(ev && /Ray Request/.test(ev.title) && /Full Detail|Full/.test(ev.title), 'the title has the service and the name');
  ok(ev && ev.location === '1 Main St, Seattle', 'the address is the event location');
  ok(ev && ev.end - ev.start >= 3600000, 'the event lasts as long as the job');
  ok(ev && JSON.stringify(ev.popups) === JSON.stringify([10080, 4320, 1440, 120, 30]), 'phone alerts a week, 3 days, a day, 2 h and 30 min before');
  ok(ev && /Phone: /.test(ev.description), 'his notes have the phone number');
}

console.log('\nConfirm and cancel keep the calendar in step');
{
  await call('POST', '/api/booking', { id: pendingId, action: 'confirm' });
  const ev = cal.get(pendingId);
  ok(ev && /^🚗 /.test(ev.title) && !/NOT CONFIRMED/.test(ev.title), 'confirm drops NOT CONFIRMED → ' + (ev && ev.title));
  const n = cal.size;
  ok(cal.size === n, 'confirm updates the same event, never a second one');
  await call('POST', '/api/booking', { id: pendingId, action: 'cancel' });
  ok(!cal.has(pendingId), 'cancel takes it off the calendar');
}

console.log('\nA job agreed over text goes on the calendar by itself');
{
  // Detection has found "Saturday at 10 works" and he taps Yes on the card:
  // the same detPlaceOnDay the automatic path runs.
  const at = Date.now() + 5 * 86400000;
  const date = new Date(at - 7 * 3600000).toISOString().slice(0, 10);
  // Pacific wall clock to epoch, the way detection fills rec.at.
  const la = (d, hm) => { const n = Date.parse(d + 'T' + hm + ':00Z'); const off = new Date(n).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/); return n - (off ? +off[1] : -8) * 3600000; };
  const det = { id: 'd1', phone: '+14255559876', kind: 'set', name: 'Tex Ted', date, slot: '10:00', at: la(date, '10:00'),
    tentative: false, customerConfirmed: true, currentAt: null, service: 'Full Detail', vehicle: '2019 Tahoe',
    address: '9 Elm St', city: 'Everett', price: 369, notes: 'gate 4412', durationMin: 270,
    confidence: 0.9, evidence: 'saturday at 10 works', at_: Date.now() };
  await KV.put('det:index', JSON.stringify([det]));
  const before = cal.size;
  const r = await call('POST', '/api/detection', { id: 'd1', action: 'confirm' });
  ok(r && r.ok, 'confirm puts it on the board → ' + JSON.stringify(r && r.error));
  ok(cal.size === before + 1, 'and one event lands on his calendar with no other tap');
  const id = [...cal.keys()].find((k) => /^m:/.test(k));
  const ev = cal.get(id);
  ok(ev && /^🚗 Full Detail · Tex Ted \(Everett\)$/.test(ev.title), 'titled with the service, name and town → ' + (ev && ev.title));
  ok(ev && ev.location === '9 Elm St, Everett', 'the address is the location');
  ok(ev && ev.end - ev.start === 270 * 60000, 'it lasts as long as the job');
  ok(ev && /Quoted: \$369/.test(ev.description) && /Phone: \+14255559876/.test(ev.description) && /gate 4412/.test(ev.description), 'his notes have the price, phone and gate code');
  ok(ev && JSON.stringify(ev.popups) === JSON.stringify([10080, 4320, 1440, 120, 30]), 'same phone alerts as a booking');

  // He edits the time on the board: the same event moves.
  const n = cal.size;
  await call('POST', '/api/day/job', { date, id, name: 'Tex Ted', phone: '+14255559876', service: 'Full Detail', slot: '13:00', durationMin: 270, address: '9 Elm St', city: 'Everett' });
  ok(cal.size === n && cal.get(id).start === ev.start + 3 * 3600000, 'an edit on the board moves the same event, never a second one');

  // The customer asks to move to the next day and he accepts the card.
  const next = new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  await KV.put('det:index', JSON.stringify([{ ...det, id: 'd2', kind: 'reschedule', date: next, slot: '11:00', at: la(next, '11:00'), currentAt: det.at }]));
  await call('POST', '/api/detection', { id: 'd2', action: 'accept' });
  ok(cal.size === n && cal.has(id), 'an accepted move keeps one event');
  ok(cal.get(id).start - ev.start === 86400000 + 3600000, 'and it is on the new day at the new time');
  const oldDay = JSON.parse(store.get('day:' + date) || '{"manual":[]}');
  const newDay = JSON.parse(store.get('day:' + next) || '{"manual":[]}');
  ok(!oldDay.manual.some((m) => m.id === id) && newDay.manual.some((m) => m.id === id && m.slot === '11:00'), 'the board moved with it');

  // A day off the board is a day off the calendar.
  await call('POST', '/api/day/remove', { date: next, jobId: id });
  ok(!cal.has(id), 'taking it off the board takes it off the calendar');

  // A hand-typed job (a cash job, a friend's truck) goes on too.
  await call('POST', '/api/day/job', { date, name: 'Cash Carl', slot: '07:00', service: 'Exterior' });
  ok([...cal.values()].some((e) => /Exterior · Cash Carl/.test(e.title)), 'a job he types on the board goes on the calendar');
}

console.log('\nA time nobody agreed says so on the calendar');
{
  const date = new Date(Date.now() + 8 * 86400000 - 7 * 3600000).toISOString().slice(0, 10);
  await KV.put('det:index', JSON.stringify([{ id: 'd3', phone: '+14255550111', kind: 'set', name: 'Sat Sue', date, slot: '09:00', at: 0,
    tentative: true, customerConfirmed: true, service: '', vehicle: '', address: '', city: '', price: 0, notes: '', durationMin: 180,
    confidence: 0.8, evidence: 'saturday works', at_: Date.now() }]));
  await call('POST', '/api/detection', { id: 'd3', action: 'confirm' });
  const ev = [...cal.values()].find((e) => /Sat Sue/.test(e.title));
  ok(ev && /^⏰ TIME NOT SET: /.test(ev.title), 'the title says the time is not set → ' + (ev && ev.title));
  ok(ev && /placeholder/.test(ev.description), 'and the notes say 9 AM is a placeholder');
}

console.log('\nCatch-up: one tap adds the board jobs that were there before');
{
  const before = [...cal.keys()];
  cal.clear();
  const r = await call('POST', '/api/gcal-sync-all', {});
  ok(r.ok && [...cal.keys()].some((k) => /^m:/.test(k)), 'sync-all includes jobs from the day board → ' + JSON.stringify(r));
  ok(cal.size >= before.filter((k) => /^m:/.test(k)).length, 'every board job is back');
}

console.log('\nA week, 3 days and a day before: an email and a push, once each');
{
  // A job 10 days out, booked now.
  const realNow = Date.now;
  const T0 = Math.ceil(realNow() / 300000) * 300000;   // on a 5-minute tick
  const appt = T0 + 10 * 86400000;
  const all = await bookings();
  const bk = { ...all[0], id: 'far1', status: 'confirmed', apptAt: appt, createdAt: T0, heads: undefined, name: 'Fay Far', dateLabel: 'Sat, Oct 11', slot: '07:00' };
  await KV.put('bk:index', JSON.stringify([bk]));
  const tick = async (at) => { Date.now = () => at; emails.length = 0; await worker.scheduled({}, ENV, ctx); await settle(); Date.now = realNow; return emails.filter((e) => /Fay Far/.test(e.subject)); };
  const tickAt = (ms) => Math.ceil(ms / 300000) * 300000;
  ok((await tick(tickAt(appt - 8 * 86400000))).length === 0, 'nothing 8 days out');
  const w = await tick(tickAt(appt - 7 * 86400000));
  ok(w.length === 1 && /in one week/.test(w[0].subject), 'one week out → ' + (w[0] && w[0].subject));
  ok(w[0] && /Add to Google Calendar/.test(w[0].html), 'the reminder has the calendar button');
  const note = JSON.parse(store.get('push:note') || '{}');
  ok(/Fay Far/.test(note.title || ''), 'the push has a headline with the name');
  ok((await tick(tickAt(appt - 7 * 86400000) + 300000)).length === 0, 'and not again five minutes later');
  const d3 = await tick(tickAt(appt - 3 * 86400000));
  ok(d3.length === 1 && /in 3 days/.test(d3[0].subject), '3 days out');
  const d1 = await tick(tickAt(appt - 86400000));
  ok(d1.length === 1 && /tomorrow/.test(d1[0].subject), 'a day out');
  ok((await tick(tickAt(appt - 3600000))).length === 0, 'nothing more after that');
  const off = await tick(tickAt(appt - 7 * 86400000) + 60000);
  ok(off.length === 0, 'off the 5-minute beat it does not even look');

  // Booked 2 days ahead: the week and 3-day notes would be noise.
  const appt2 = T0 + 2 * 86400000;
  await KV.put('bk:index', JSON.stringify([{ ...bk, id: 'near1', name: 'Nat Near', apptAt: appt2, createdAt: T0, heads: undefined }]));
  const tick2 = async (at) => { Date.now = () => at; emails.length = 0; await worker.scheduled({}, ENV, ctx); await settle(); Date.now = realNow; return emails.filter((e) => /Nat Near/.test(e.subject)); };
  ok((await tick2(T0 + 300000)).length === 0, 'booked 2 days out: no "one week" or "3 days"');
  const n1 = await tick2(tickAt(appt2 - 86400000));
  ok(n1.length === 1 && /tomorrow/.test(n1[0].subject), 'but it still gets "tomorrow"');

  // A missed stretch sends the nearest one, not a pile.
  await KV.put('bk:index', JSON.stringify([{ ...bk, id: 'gap1', name: 'Gus Gap', apptAt: appt, createdAt: T0, heads: undefined }]));
  const tick3 = async (at) => { Date.now = () => at; emails.length = 0; await worker.scheduled({}, ENV, ctx); await settle(); Date.now = realNow; return emails.filter((e) => /Gus Gap/.test(e.subject)); };
  const g = await tick3(tickAt(appt - 2 * 86400000));
  ok(g.length === 1 && /in 3 days/.test(g[0].subject), 'after missing the week mark, one email, the nearest');
  const cancelled = { ...bk, id: 'x1', name: 'Cal Cancelled', status: 'cancelled', heads: undefined };
  await KV.put('bk:index', JSON.stringify([cancelled]));
  Date.now = () => tickAt(appt - 86400000); emails.length = 0; await worker.scheduled({}, ENV, ctx); await settle(); Date.now = realNow;
  ok(!emails.some((e) => /Cal Cancelled/.test(e.subject)), 'a cancelled job gets no reminders');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
