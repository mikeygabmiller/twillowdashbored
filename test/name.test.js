// Auto-naming — putting the customer's name on the conversation without anyone
// typing it.
//
// Half the board is titled with a phone number, because the quote screen stopped
// asking for a name and a cold text never had a form. The name is usually right
// there in the words ("hey it's Dave", "my names Ruth") — this reads it out.
//
// The whole risk of the feature is a WRONG name, because it goes out in the next
// text Mikey sends. So most of this suite is the refusals: what it must not
// mistake for a name, and who it must never overwrite.
//
//   node test/name.test.js
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['nameCandidate', 'nameFromEmail', 'nameFromAnswer', 'askedForName', 'applyLearnedName', 'nameRank', 'tidyName',
  'handleInboundSms', 'handleSubmit', 'handleQqcText', 'apiMeta', 'loadThread', 'saveThread', 'loadIndex'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list() { return { keys: [], list_complete: true }; },
};
const alerts = [], sms = [];
globalThis.fetch = async (u, opts) => {
  const url = String(u);
  if (url.includes('generativelanguage')) return { ok: false, status: 429, text: async () => 'no ai in this suite' };
  if (url.includes('api.resend.com')) { alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
  if (url.includes('api.twilio.com')) { const p = new URLSearchParams(String(opts.body)); sms.push({ to: p.get('To'), body: p.get('Body') }); return { ok: true, json: async () => ({ sid: 'SM1' }) }; }
  return { ok: false, status: 404, text: async () => 'no' };
};

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, RESEND_API_KEY: 'r', ALERT_EMAIL: 'a@b.c',
  TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  PUBLIC_BASE_URL: 'https://texting.example.workers.dev',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const eq = (n, got, want) => ok(`${n}  (${JSON.stringify(want)})`, got === want, got);

// Twilio webhooks arrive form-encoded; signature enforcement is off unless the
// Worker var is set, so a plain form body is all an inbound text needs here.
const formReq = (params) => ({
  url: 'https://texting.example.workers.dev/sms',
  headers: { get: () => null },
  formData: async () => new Map(Object.entries(params)),
});
const jsonReq = (body) => ({
  url: 'https://texting.example.workers.dev/submit',
  headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});
const fresh = async () => { store.clear(); alerts.length = 0; sms.length = 0; M.__reset(); };

// --------------------------------------------------------------- the reading
section('What a message says their name is');
[
  ['my name is John Smith', 'John Smith'],
  ['my names ruth', 'Ruth'],
  ["My name's DeShawn", 'DeShawn'],
  ['Hey, this is Dave', 'Dave'],
  ['hi this is ruth callahan, looking for a quote', 'Ruth Callahan'],
  ["it's Dale from Marysville", 'Dale'],          // cut at "from" — the town is not a surname
  ["Hey it's me, John", 'John'],                   // "me" is filler, not a name
  ['im dave', 'Dave'],                             // the never-capitalizes typist
  ["I'm Kayla and I need my truck done", 'Kayla'],
  ['Name: Marcus Webb', 'Marcus Webb'],
  ['Ruth here, following up on that quote', 'Ruth'],
  ['you can call me Sal', 'Sal'],
  ['MY NAME IS TONY RUIZ', 'Tony Ruiz'],           // caps lock is straightened by tidyName
  ['hey this is tony from the shop next door', 'Tony'],
  ['It\'s Tom, sorry for the late reply', 'Tom'],
  ['my name is john smith and i need a quote', 'John Smith'],
].forEach(([t, want]) => eq(`"${t}"`, M.nameCandidate(t), want));

section('What it must refuse to call a name');
[
  "it's fine, thanks",
  "I'm interested in the full detail",
  'this is about my truck',
  'sounds good see you thursday',
  'how much for an suv?',
  "it's raining, can we move it",
  'my car is a 2019 tacoma',
  "is this Mike's number?",                        // a question, and a possessive
  "this is mikey's detailing right?",              // they're asking who WE are
  "it's at 1420 State Ave",
  'im at work till 5',
  'call me back tomorrow',
  "I'm not sure yet",
  'thanks!',
  '',
  'I would love a quote for the interior, it is pretty rough, my kids destroyed it and I never got around to cleaning it out',
  // The sentence carrying on past the "name" is the tell, and it's what catches
  // the long tail no word list ever will — every one of these named somebody
  // ("When", "Urgent", "Kinda Dirty") before that rule existed.
  'call me when you get a chance',
  'this is urgent',
  'this is what i need done',
  'its me again',
  "it's been a week",
  'this is such a mess',
  "it's whatever works for you",
  'its supposed to rain',
  "it's kinda dirty",
  'this is my wifes car',
  'this is the address 123 main st',
  'im so sorry i missed you',
  'im really happy with it',
  'i am very interested',
  'its probably 2 hours',
  "i'm gonna need the interior too",
  "Hi, I'm hoping to get a quote",
  'call me Tuesday',
  'call me asap please',
  "hey! it's Thursday right?",
].forEach((t) => eq(`refuses "${t}"`, M.nameCandidate(t), ''));

section('A name in the email box (quote form only)');
[
  ['ruth.callahan@gmail.com', 'Ruth Callahan'],
  ['dale_hobart@yahoo.com', 'Dale Hobart'],
  ['john-smith@outlook.com', 'John Smith'],
  ['detailguy@gmail.com', ''],                     // one word could be anything
  ['info.desk@shop.com', ''],                      // a role, not a person
  ['ruth.callahan99@gmail.com', ''],               // digits mean a handle
  ['a.b@gmail.com', ''],
  ['', ''],
].forEach(([e, want]) => eq(`"${e}"`, M.nameFromEmail(e), want));

// -------------------------------------------------- answering our own question
section('The reply to "send over your name and the year, make and model"');
const ASK = "Hey there, it's Mikey. I got your quote submission on my site. Whenever you have a minute, feel free to send over your name and the year, make, and model of the car you'd like detailed, and I'll confirm that price. Talk soon!";
ok('we can tell we asked', M.askedForName({ messages: [{ dir: 'out', body: ASK }] }) === true);
ok('and that we did not', M.askedForName({ messages: [{ dir: 'out', body: 'see you thursday' }] }) === false);
ok('a later message of ours closes the window', M.askedForName({ messages: [{ dir: 'out', body: ASK }, { dir: 'out', body: 'sounds good' }] }) === false);
[
  ['John, 2019 F-150', 'John'],
  ['dale hobart - 2016 Tacoma', 'Dale Hobart'],
  ['Tacoma, 2019 TRD', ''],            // they answered the car half first
  ['Ruth, my truck', ''],              // no year — not the answer we asked for
  ['yes, 2019 F-150', ''],
  ['2019 F-150', ''],
  ['Thursday, the 2019 one', ''],
].forEach(([t, want]) => eq(`"${t}"`, M.nameFromAnswer(t, true), want));
eq('and none of it reads at all unless we asked', M.nameFromAnswer('John, 2019 F-150', false), '');

// --------------------------------------------------------------- who wins
section('Who gets to name the conversation');
const t0 = () => ({ phone: '+14255550111', name: '', messages: [] });
let t = t0();
ok('a blank thread takes a guess off an email', M.applyLearnedName(t, 'Ruth Callahan', 'email') === true && t.name === 'Ruth Callahan', t);
ok('…and is marked as a guess', t.nameAuto === 'email');
ok('what they SAY beats what the email guessed', M.applyLearnedName(t, 'Ruth Keller', 'said') === true && t.name === 'Ruth Keller', t);
ok('another email guess can no longer touch it', M.applyLearnedName(t, 'Someone Else', 'email') === false && t.name === 'Ruth Keller', t);
ok('the quote form outranks both', M.applyLearnedName(t, 'Ruth A Keller', 'form') === true, t);
ok('…and stops being marked as a guess', !t.nameAuto);
ok('nothing overwrites a name a human stands behind', M.applyLearnedName(t, 'Dave', 'said') === false && t.name === 'Ruth A Keller', t);
ok('an empty candidate changes nothing', M.applyLearnedName(t, '   ', 'said') === false);
ok('rank 0 for a nameless thread', M.nameRank(t0()) === 0);

// --------------------------------------------------------- end to end: a text
section('An inbound text that introduces them');
await fresh();
await M.handleInboundSms(formReq({ From: '+14255550123', Body: 'hey its Dale, looking to get my F-150 done', NumMedia: '0', MessageSid: 'SM9' }));
let th = await M.loadThread('+14255550123');
eq('the thread is named', th.name, 'Dale');
eq('and marked as learned, not typed', th.nameAuto, 'said');
ok('the list row carries it too', (await M.loadIndex()).some((r) => r.phone === '+14255550123' && r.name === 'Dale'), await M.loadIndex());
ok('the alert subject says who, not a phone number', /Dale/.test((alerts[0] || {}).subject || ''), (alerts[0] || {}).subject);
ok('the alert says it saved the name', /Saved their name as Dale/.test(JSON.stringify(alerts[0] || {})));

section('An ordinary text names nobody, and writes nothing new');
await fresh();
await M.handleInboundSms(formReq({ From: '+14255550124', Body: 'sounds good, thanks!', NumMedia: '0' }));
th = await M.loadThread('+14255550124');
eq('still nameless', th.name, '');
ok('no name note in the alert', !/Saved their name/.test(JSON.stringify(alerts[0] || {})));

section('End to end: they answer the intake question with a bare name');
await fresh();
await M.handleSubmit(jsonReq({ phone: '4255550129', total: '300', smsConsent: true }));
th = await M.loadThread('+14255550129');
// The intake text is queued, not sent — put it in the thread the way the cron
// does, so the reply lands on a conversation where we just asked for the name.
th.messages.push({ id: 'o1', dir: 'out', body: (th.scheduled[0] || {}).body, ts: Date.now() });
await M.saveThread(th);
await M.handleInboundSms(formReq({ From: '+14255550129', Body: 'Marcus, 2018 Silverado', NumMedia: '0' }));
th = await M.loadThread('+14255550129');
eq('the bare name in the answer is read', th.name, 'Marcus');

section('…but the same text on a conversation we never asked is ignored');
await fresh();
await M.handleInboundSms(formReq({ From: '+14255550130', Body: 'Marcus, 2018 Silverado', NumMedia: '0' }));
th = await M.loadThread('+14255550130');
eq('nothing learned', th.name, '');

section("A name Mikey typed survives whatever they say next");
await fresh();
await M.apiMeta(jsonReq({ phone: '+14255550125', name: 'Big Dale' }));
await M.handleInboundSms(formReq({ From: '+14255550125', Body: "hey it's Dale", NumMedia: '0' }));
th = await M.loadThread('+14255550125');
eq('his name stands', th.name, 'Big Dale');
ok('and is not flagged as a guess', !th.nameAuto);

section('Mikey confirming a learned name promotes it');
await fresh();
await M.handleInboundSms(formReq({ From: '+14255550126', Body: 'this is Kayla', NumMedia: '0' }));
await M.apiMeta(jsonReq({ phone: '+14255550126', name: 'Kayla' }));
th = await M.loadThread('+14255550126');
ok('the guess marker is cleared', th.name === 'Kayla' && !th.nameAuto, th);
await M.handleInboundSms(formReq({ From: '+14255550126', Body: "actually it's Kay", NumMedia: '0' }));
th = await M.loadThread('+14255550126');
eq('so a later text cannot rewrite it', th.name, 'Kayla');

// ------------------------------------------------------- end to end: a quote
section('A quote form with no name, but an email carrying one');
await fresh();
await M.handleSubmit(jsonReq({ phone: '4255550127', email: 'ruth.callahan@gmail.com', total: '350', smsConsent: true }));
th = await M.loadThread('+14255550127');
eq('the lead is labelled from the email', th.name, 'Ruth Callahan');
eq('marked as the weakest kind of guess', th.nameAuto, 'email');
const queued = (th.scheduled || [])[0] || {};
ok('the first text still says "Hey there" — a guess never greets a customer', /Hey there, it's Mikey/.test(queued.body || ''), queued.body);
ok('…and still asks for their name', /your name and the year/.test(queued.body || ''), queued.body);
ok('but Mikey\'s alert uses it', /Ruth Callahan/.test((alerts[0] || {}).subject || ''), (alerts[0] || {}).subject);

section('…and then they text back with their real name');
await M.handleInboundSms(formReq({ From: '+14255550127', Body: "it's Ruth Keller, 2019 4Runner", NumMedia: '0' }));
th = await M.loadThread('+14255550127');
eq('the email guess is replaced', th.name, 'Ruth Keller');

section('A quote form with a typed name is untouched by any of this');
await fresh();
await M.handleQqcText(jsonReq({ phone: '4255550128', name: 'DALE HOBART', email: 'someone.else@gmail.com', total: '400' }));
th = await M.loadThread('+14255550128');
eq('the typed name wins over the email', th.name, 'Dale Hobart');
ok('and is not a guess', !th.nameAuto);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
