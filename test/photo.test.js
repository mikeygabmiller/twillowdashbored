// Photos going OUT — the plumbing that decides what a customer's phone actually
// receives, and what a URL from the browser is allowed to make the Worker do.
//
// Three things are worth a test here and one of them is a security boundary:
//
//   (a) /i/<id> is PUBLIC. It has to be — Twilio fetches the URL itself with no
//       cookie — so the id is the only thing standing between a customer's photo
//       and the open internet, and photoIdOk is what says an id is an id.
//   (b) A URL the browser hands us goes to Twilio, and Twilio fetches it. If
//       photoIdFromUrl accepted anything else, "send this photo" would be a way
//       to point the Worker at any host on the internet.
//   (c) A photo-only text has no words. Every place that assumed a body — the
//       empty-message guard, the list row preview — had to learn that.
//
//   node test/photo.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let p = SRC.indexOf('(', SRC.indexOf(`function ${name}(`)), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// A fake KV holding exactly one photo, plus a captured publicBase.
const STORE = new Map();
const ctx = {};
new Function('ctx', 'STORE',
  'const ENV={};const PHOTO_MAX_PER_MSG=10;' +
  'function kv(){return {' +
  '  list:async({prefix})=>{const v=STORE.get(prefix);return {keys:v?[{name:prefix,metadata:v.metadata}]:[]}},' +
  '};}' +
  'function publicBase(){return "https://texting.example.workers.dev"}' +
  lift('photoKey') + lift('photoIdOk') + lift('photoIdFromUrl') +
  lift('resolveOutMedia') + lift('photoAbsolute') +
  'ctx.photoIdOk=photoIdOk;ctx.photoIdFromUrl=photoIdFromUrl;' +
  'ctx.resolveOutMedia=resolveOutMedia;ctx.photoAbsolute=photoAbsolute;')(ctx, STORE);
const { photoIdOk, photoIdFromUrl, resolveOutMedia, photoAbsolute } = ctx;

const GOOD = 'AbCdEf0123456789_-xyzQ';   // 22 chars, jdToken's alphabet and length

// ---------------------------------------------------------------------------
console.log('\n-- an id is an id, and nothing else is --');
check('a real token passes',        photoIdOk(GOOD), true);
check('empty is not an id',         photoIdOk(''), false);
check('a path traversal is not',    photoIdOk('../config'), false);
check('a key with a colon is not',  photoIdOk('thread:+15551234567'), false);
check('too short is not',           photoIdOk('abc'), false);
check('too long is not',            photoIdOk('a'.repeat(64)), false);

console.log('\n-- only a URL we minted can be handed to Twilio --');
check('our relative form',      photoIdFromUrl(`/i/${GOOD}`), GOOD);
check('our absolute form',      photoIdFromUrl(`https://texting.example.workers.dev/i/${GOOD}`), GOOD);
check('the bare id',            photoIdFromUrl(GOOD), GOOD);
check('someone else\'s host',   photoIdFromUrl('https://evil.example.com/payload.jpg'), null);
check('our path on their host', photoIdFromUrl(`https://evil.example.com/i/${GOOD}/../../secret`), null);
check('an internal address',    photoIdFromUrl('http://169.254.169.254/latest/meta-data/'), null);
check('a data: URL',            photoIdFromUrl('data:image/jpeg;base64,AAAA'), null);
check('a file: URL',            photoIdFromUrl('file:///etc/passwd'), null);
check('nothing at all',         photoIdFromUrl(''), null);
check('a query tacked on',      photoIdFromUrl(`/i/${GOOD}?x=1`), null);

console.log('\n-- absolute is what goes on the wire --');
check('built from the public base', photoAbsolute(`/i/${GOOD}`), `https://texting.example.workers.dev/i/${GOOD}`);
check('a URL we did not mint stays off the wire', photoAbsolute('https://evil.example.com/x.jpg'), '');

// ---------------------------------------------------------------------------
console.log('\n-- a photo that is not in KV never reaches Twilio --');
STORE.set(`img:${GOOD}`, { bytes: new ArrayBuffer(8), metadata: { type: 'image/png' } });
const MISSING = 'ZZZZZZZZZZZZZZZZZZZZZZ';
check('the one we are holding resolves',
  await resolveOutMedia([`/i/${GOOD}`]), [{ url: `/i/${GOOD}`, type: 'image/png' }]);
check('one that expired is dropped',        await resolveOutMedia([`/i/${MISSING}`]), []);
check('a foreign URL is dropped',           await resolveOutMedia(['https://evil.example.com/x.jpg']), []);
check('nothing in, nothing out',            await resolveOutMedia(undefined), []);
check('object form works too',
  await resolveOutMedia([{ url: `/i/${GOOD}` }]), [{ url: `/i/${GOOD}`, type: 'image/png' }]);
check('never more than Twilio will take',
  (await resolveOutMedia(new Array(14).fill(`/i/${GOOD}`))).length, 10);

// ---------------------------------------------------------------------------
console.log('\n-- the send path knows a photo can BE the message --');
const apiSend = lift('apiSend');
check('empty is only empty with no photo on it',
  /if \(!body && !media\.length\) return json\(\{ ok: false, error: 'empty_message' \}/.test(apiSend), true);
check('a photo the server cannot find is refused rather than sent',
  /error: 'photo_missing'/.test(apiSend), true);
check('the media rides along to Twilio', /sendSms\(phone, body, \{ media \}\)/.test(apiSend), true);
check('and is stored on the message',    /if \(media\.length\) msg\.media = media;/.test(apiSend), true);
check('a wordless photo is not a writing sample',
  /else if \(body && voiceUsable\(msg\)\)/.test(SRC), true);

console.log('\n-- Twilio gets repeated MediaUrl params, absolute --');
const sendSms = lift('sendSms');
check('appended as MediaUrl', /params\.append\('MediaUrl', abs\)/.test(sendSms), true);
check('always through photoAbsolute', /const abs = photoAbsolute\(/.test(sendSms), true);
check('capped at the Twilio limit', /\.slice\(0, PHOTO_MAX_PER_MSG\)/.test(sendSms), true);
check('the opt-out guard still runs first',
  sendSms.indexOf('recipient_opted_out') < sendSms.indexOf('MediaUrl'), true);
check('and so does the practice-number guard',
  sendSms.indexOf('practice_number') < sendSms.indexOf('MediaUrl'), true);

console.log('\n-- /i/ is public on purpose, and only /i/ is --');
check('the route sits above the /api password gate',
  SRC.indexOf("pathname.startsWith('/i/')") < SRC.indexOf("!(await isAuthed(request))"), true);
check('the upload sits below it',
  SRC.indexOf("pathname === '/api/send-photo'") > SRC.indexOf("!(await isAuthed(request))"), true);
check('photos are not indexable', /X-Robots-Tag/.test(lift('servePhoto')), true);

console.log('\n-- his own photo is not the customer\'s evidence --');
// has-photo is what the AI advisor reads as "they showed me the car". A photo he
// SENT is not that, and counting it would flag every conversation he ever sent a
// before/after to.
check('hasMedia counts inbound only',
  /hasMedia: \(thread\.messages \|\| \[\]\)\.some\(\(m\) => m\.dir === 'in' &&/.test(SRC), true);

console.log('\n-- the list row says something happened --');
check('a photo-only text previews as a photo',
  /Array\.isArray\(last\.media\) && last\.media\.length \? '\\uD83D\\uDCF7 Photo' : ''/.test(SRC), true);

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
