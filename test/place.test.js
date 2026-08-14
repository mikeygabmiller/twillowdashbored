// "Where am I going?" — the address on the run board.
//
// A job booked over text arrives carrying nothing but a phone number, so the
// address has to be found: first in that customer's garage, and failing that in
// the words of the conversation. This module is what stopped the run board from
// showing a job with a blank address, so most of what's asserted here is that
// the address actually lands — and that a guess stays a guess until it's saved.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['findAddressInThread', 'buildDay', 'loadThread', 'saveThread', 'updateIndexEntry',
  'openThreadForRead', 'attachPlace', 'bkLaEpoch', 'loadDay', 'saveDay', 'localDateStr'];

const store = new Map();
let writes = 0;
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); writes++; },
  async delete(k) { store.delete(k); writes++; },
  async list({ prefix } = {}) {
    return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__resetCfg(){ CFG_CACHE = null; }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const msg = (dir, body, ts) => ({ id: Math.random().toString(36).slice(2), dir, body, ts: ts || Date.now() });

// ------------------------------------------------------- the regex itself
section('Reading an address out of a normal text message');
const finds = (body, dir = 'in') => {
  const r = M.findAddressInThread({ messages: [msg(dir, body)] });
  return r ? r.text : '';
};
[
  ['1425 Cedar Ave', '1425 Cedar Ave'],
  ['im at 8817 4th St NE', '8817 4th St NE'],
  ['Address is 210 SW Marine Drive, Everett', '210 SW Marine Drive'],
  ['12043 Meadow Lane apt 4', '12043 Meadow Lane apt 4'],
  ['come to 55 N Elm Court #12', '55 N Elm Court #12'],
  ['sure — 3320 Silver Lake Rd works', '3320 Silver Lake Rd'],
  ['9 Bell Way', '9 Bell Way'],
].forEach(([body, want]) => {
  const got = finds(body);
  ok(`"${body}" → ${want}`, got.toLowerCase() === want.toLowerCase(), got);
});

section('…and not reading one where there is none');
['$150 for 2 cars', 'be there in 20 minutes', 'thanks!', 'my number is 425 555 1234',
 'I have a 2019 Tahoe', 'can you do 10 am saturday', 'its 3 cars total', '',
].forEach((body) => ok(`ignores "${body || '(empty)'}"`, finds(body) === '', finds(body)));

section('Whose word counts');
ok("the customer's own message wins over Mikey's",
  M.findAddressInThread({ messages: [msg('out', '90 Pine St'), msg('in', '1425 Cedar Ave')] }).text === '1425 Cedar Ave');
ok('…but Mikey\'s is used when the customer never wrote one',
  M.findAddressInThread({ messages: [msg('out', '90 Pine St'), msg('in', 'sounds good')] }).text === '90 Pine St');
ok('the most recent address wins',
  M.findAddressInThread({ messages: [msg('in', '90 Pine St'), msg('in', 'actually 1425 Cedar Ave')] }).text === '1425 Cedar Ave');
ok('only the last 40 messages are read',
  M.findAddressInThread({ messages: [msg('in', '90 Pine St')].concat(
    Array.from({ length: 45 }, () => msg('in', 'ok'))) }) === null);

// ------------------------------------------------------ onto the run board
const TODAY = M.localDateStr(Date.now(), 'America/Los_Angeles');
const at10 = M.bkLaEpoch(TODAY, '10:00');

async function seed(thread) {
  store.clear(); writes = 0;
  M.__resetCfg();
  const t = await M.loadThread(thread.phone);
  Object.assign(t, thread);
  await M.saveThread(t);
  await M.updateIndexEntry(t);
}
const firstJob = async () => (await M.buildDay(TODAY)).jobs[0];

section('A job booked over text gets its address from the garage');
await seed({
  phone: '+14255551234', name: 'Jenna', appointmentAt: at10,
  messages: [msg('in', 'saturday at 10 works')],
  garage: { vehicles: [{ year: '2019', make: 'Chevy', model: 'Tahoe', color: 'Silver' }],
    address: '1425 Cedar Ave', city: 'Everett', gate: '4412', parking: 'driveway on the left',
    water: false, power: true, prefs: '', avoid: 'soft top' },
});
let j = await firstJob();
ok('the stop is on the board', !!j && j.phone === '+14255551234');
ok('address filled from the garage', j.address === '1425 Cedar Ave', j.address);
ok('city too', j.city === 'Everett', j.city);
ok('marked as coming from the garage', j.placeFrom === 'garage', j.placeFrom);
ok('gate code carried', j.gate === '4412', j.gate);
ok('where to park carried', j.parking === 'driveway on the left');
ok('no water is carried as false, not dropped', j.water === false, j.water);
ok('power true carried', j.power === true);
ok('careful-with note carried', j.avoid === 'soft top');
ok('vehicle label built', j.vehicle === '2019 Silver Chevy Tahoe', j.vehicle);
ok('mapQuery is navigable', j.mapQuery === '1425 Cedar Ave, Everett, WA', j.mapQuery);
ok('no guess needed', j.addressGuess === '', j.addressGuess);

section('No garage? Read it out of the conversation');
await seed({
  phone: '+14255559999', name: 'Ruth', appointmentAt: at10,
  messages: [msg('in', 'yes 10 is good'), msg('in', 'im at 8817 4th St NE')],
  garage: null,
});
j = await firstJob();
ok('the guess is offered', j.addressGuess === '8817 4th St NE', j.addressGuess);
ok('…but address itself stays empty', j.address === '', j.address);
ok('marked as coming from the text', j.placeFrom === 'text', j.placeFrom);
ok('a guess is still navigable', j.mapQuery === '8817 4th St NE', j.mapQuery);

section('A guess is never written down');
writes = 0;
await M.buildDay(TODAY);
ok('building the day writes nothing', writes === 0, writes);
ok('the thread on disk has no address', !(await M.loadThread('+14255559999')).garage);

section('Opening the conversation offers the same guess, unsaved');
const opened = await M.openThreadForRead('+14255559999');
ok('the guess rides along on the thread', opened.addressGuess === '8817 4th St NE', opened.addressGuess);
ok('and is not persisted', !(store.get('thread:+14255559999') || '').includes('addressGuess'));

section('Nothing to find is handled quietly');
await seed({
  phone: '+14255558888', name: 'Sam', appointmentAt: at10,
  messages: [msg('in', 'sounds good see you then')], garage: null,
});
j = await firstJob();
ok('no address', j.address === '' && j.addressGuess === '', j);
ok('no crash, job still listed', j.phone === '+14255558888');
ok('mapQuery is empty rather than garbage', j.mapQuery === '', j.mapQuery);

section('A garage address beats a different one in the texts');
await seed({
  phone: '+14255557777', name: 'Dee', appointmentAt: at10,
  messages: [msg('in', 'my old place was 90 Pine St')],
  garage: { vehicles: [], address: '1425 Cedar Ave', city: 'Everett' },
});
j = await firstJob();
ok('saved address wins', j.address === '1425 Cedar Ave' && j.addressGuess === '', j.address);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
