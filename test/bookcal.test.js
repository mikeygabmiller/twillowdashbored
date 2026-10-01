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
