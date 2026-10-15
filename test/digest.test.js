// The check-in email's two dashboard routes (2026-10-14).
//
// A scheduled session reads Mikey's dashboard three times a day and emails him
// who needs a reply and what's really open. It can't carry Gmail or Google
// Calendar, so the dashboard lends it both: its calendar feed, now with titles,
// and its own alert mail, which only ever goes to Mikey.
//
//   node test/digest.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
};
const mail = [];
let ICS = '';
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('api.resend.com')) { mail.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ id: 'e1' }) }; }
  if (url.includes('calendar.example')) return { ok: true, text: async () => ICS };
  return { ok: false, status: 404, text: async () => 'no' };
};

const EXPORTS = ['apiCalendarDays', 'apiDigestEmail', 'bkParseIcs', 'bkAddDays', 'bkLocalParts'];
const mk = (env) => new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ resetInvocationCaches(); }});')(Object.assign({ MESSAGES: kv }, env));

let pass = 0, fail = 0;
const ok = (name, cond, got) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' → ' + JSON.stringify(got)}`); };
const req = (b) => ({ json: async () => b });

console.log('\nThe calendar feed keeps each event\'s title');
{
  const M = mk({});
  const ev = M.bkParseIcs('BEGIN:VEVENT\r\nDTSTART:20261024T230000Z\r\nDTEND:20261025T020000Z\r\nSUMMARY:Treat Street\\, Evergreen\r\nEND:VEVENT\r\n');
  ok('a title comes through, unescaped', ev.length === 1 && ev[0].title === 'Treat Street, Evergreen', ev);
  const free = M.bkParseIcs('BEGIN:VEVENT\r\nDTSTART:20261024T160000Z\r\nDTEND:20261024T170000Z\r\nSUMMARY:Mass\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\n');
  ok('an event marked free is still left out', free.length === 0, free);
}

console.log('\nGET /api/calendar/days lists busy events with titles, day by day');
{
  const M = mk({});
  const today = M.bkLocalParts(Date.now()).date;
  const d2 = M.bkAddDays(today, 2), d3 = M.bkAddDays(today, 3);
  const z = (d) => d.replace(/-/g, '');
  ICS = 'BEGIN:VCALENDAR\r\n' +
    `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${z(d2)}\r\nDTEND;VALUE=DATE:${z(M.bkAddDays(d2, 1))}\r\nSUMMARY:Help James with truck\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nDTSTART;TZID=America/Los_Angeles:${z(d3)}T160000\r\nDTEND;TZID=America/Los_Angeles:${z(d3)}T190000\r\nSUMMARY:Treat Street\r\nEND:VEVENT\r\n` +
    'END:VCALENDAR\r\n';
  await kv.put('bk:config', JSON.stringify({ calendar: { enabled: true, icalUrl: 'https://calendar.example/basic.ics' } }));
  const r = await (await M.apiCalendarDays(new URL('https://x/api/calendar/days?days=5'))).json();
  ok('answers', r.ok === true, r);
  const james = r.events.find((e) => e.title === 'Help James with truck');
  ok('an all-day event shows as the whole day', james && james.date === d2 && james.allDay === true, r.events);
  const treat = r.events.find((e) => e.title === 'Treat Street');
  ok('a timed event keeps its Pacific times', treat && treat.date === d3 && treat.start === '16:00' && treat.end === '19:00', treat);
  ok('nothing outside the days asked for', r.events.every((e) => e.date >= today && e.date <= M.bkAddDays(today, 4)), r.events);
  await kv.put('bk:config', JSON.stringify({ calendar: { enabled: false } }));
  M.__resetCfg();
  const off = await M.apiCalendarDays(new URL('https://x/api/calendar/days'));
  ok('says so when his calendar isn\'t connected', off.status === 409, off.status);
}

console.log('\nPOST /api/digest/email only ever mails Mikey');
{
  const M = mk({ RESEND_API_KEY: 'r', ALERT_EMAIL: 'mikey@example.com' });
  const r = await (await M.apiDigestEmail(req({ subject: 'Check-in Thu 6:50 AM: 2 need a reply, 1 to schedule', text: 'Do this first: text Don back.', to: 'someone@else.com' }))).json();
  ok('sends', r.ok === true, r);
  ok('to his alert address, whatever the caller asked for', mail.length === 1 && JSON.stringify(mail[0].to) === JSON.stringify(['mikey@example.com']), mail[0] && mail[0].to);
  ok('with the subject it was given', mail[0].subject === 'Check-in Thu 6:50 AM: 2 need a reply, 1 to schedule');
  ok('and the words as the text part', mail[0].text === 'Do this first: text Don back.');
  const empty = await M.apiDigestEmail(req({ subject: '', text: '' }));
  ok('an empty email is refused', empty.status === 422 && mail.length === 1, empty.status);
  const M2 = mk({});
  const nokey = await M2.apiDigestEmail(req({ subject: 'x', text: 'y' }));
  ok('no mail set up: says so, sends nothing', nokey.status === 500 && mail.length === 1, nokey.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
