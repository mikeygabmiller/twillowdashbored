// The call log — the ledger behind the Calls screen.
//
// Two bugs are what this suite exists to stop coming back.
//
// The first is the one that sent every voicemail to Google Voice. Inbound calls
// were forwarded to MIKEY_PHONE, which IS the Google Voice number, and Google
// Voice ANSWERS a forwarded call with its own greeting — so Twilio saw the call
// as `completed`, <Record> never ran, and the message, the transcript and the
// missed-call trail all stayed somewhere this dashboard couldn't read. Dialing
// the handset directly, on a timeout that expires before the carrier's own
// voicemail picks up, is the fix. Both halves are asserted below.
//
// The second is quieter: one ring reaches us through up to five webhooks, and
// every one of them has to land on the SAME row. Get that wrong and a single
// missed call reads as five entries — which is exactly the kind of thing nobody
// notices until the screen is full of them.
//
//   node test/calls.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

// Same lift as the other unit suites — the Worker's functions are module-private,
// so they're pulled out by name rather than exported purely for tests.
function lift(name) {
  let start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let p = SRC.indexOf('(', start), pd = 0, bodyStart = -1;
  for (let j = p; j < SRC.length; j++) {
    if (SRC[j] === '(') pd++;
    else if (SRC[j] === ')') { pd--; if (pd === 0) { bodyStart = SRC.indexOf('{', j); break; } }
  }
  if (bodyStart < 0) throw new Error(`could not find body of ${name}`);
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`could not find end of ${name}`);
}
function liftDecl(name) {
  const m = SRC.match(new RegExp(`^(?:const|let) ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`declaration ${name} not found in src/index.js`);
  return m[0];
}

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// KV as a Map that counts writes, because the write budget is the constraint the
// whole design bends around.
function world(seed = {}, env = {}) {
  const store = new Map();
  const w = { store, written: [] };
  for (const k of Object.keys(seed)) store.set(k, JSON.stringify(seed[k]));
  w.deps = {
    kv: () => ({
      get: async (k, opt) => {
        const v = store.get(k);
        if (v == null) return null;
        return opt && opt.type === 'json' ? JSON.parse(v) : v;
      },
      put: async (k, v) => { w.written.push(k); store.set(k, v); },
    }),
    genId: () => 'id' + Math.random().toString(36).slice(2, 8),
    ENV: Object.assign({ MIKEY_PHONE: '+13607975831', TWILIO_FROM: '+13606001234' }, env),
  };
  return w;
}

const NAMES = ['kv', 'genId', 'ENV'];
const BODY =
  liftDecl('CALLS_KEY') + '\n' + liftDecl('CALLS_MAX') + '\n' + liftDecl('CALL_BRIDGE_PHONE') + '\n' +
  lift('normalizePhone') + '\n' + lift('escapeXml') + '\n' + lift('callBridgePhone') + '\n' +
  lift('loadCalls') + '\n' + lift('saveCalls') + '\n' + lift('recordCall') + '\n' +
  lift('recentlyScreened') + '\n' + lift('callForwardPhone') + '\n' + lift('dialMikeyTwiml') + '\n' +
  liftDecl('CALL_REC_NOTICE') + '\n' + liftDecl('CALL_REC_NAME') + '\n' +
  lift('callRecordingOn') + '\n' + lift('callRecordStartTwiml') + '\n' + lift('callRecordStopTwiml') + '\n' +
  lift('callRecordingKeep') + '\n' + lift('callTranscriptMessage') + '\n' +
  'return { loadCalls, saveCalls, recordCall, recentlyScreened, callForwardPhone, dialMikeyTwiml, CALLS_MAX,' +
  ' callRecordingOn, callRecordStopTwiml, callRecordingKeep, callTranscriptMessage, CALL_REC_NOTICE };';
// eslint-disable-next-line no-new-func
const build = (w) => new Function(...NAMES, BODY)(...NAMES.map((k) => w.deps[k]));

console.log('\n=== an inbound call rings the handset, not Google Voice ===');
{
  const w = world({}, { MIKEY_PHONE: '+13607975831' });
  const M = build(w);
  const xml = M.dialMikeyTwiml({});
  check('dials the click-to-call handset', /<Number>\+14252321355<\/Number>/.test(xml), true);
  check('never dials MIKEY_PHONE — that is the Google Voice number',
    xml.includes('+13607975831'), false);
  // The carrier's own voicemail answers around 25s. Whichever voicemail picks up
  // first owns the message, so Twilio has to get there first or we are back to
  // messages we cannot read.
  const timeout = Number((xml.match(/timeout="(\d+)"/) || [])[1]);
  check('times out before the carrier voicemail can answer', timeout > 0 && timeout < 25, true);
  check('unanswered calls fall through to our own voicemail', xml.includes('action="/voicemail"'), true);
  check('the caller hears real ringback, not silence', xml.includes('answerOnBridge="true"'), true);
}

console.log('\n=== where it rings is settable without a deploy ===');
{
  const M = build(world());
  check('config wins', M.callForwardPhone({ callForwardTo: '4255559999' }), '+14255559999');
  check('blank falls back to the usual handset', M.callForwardPhone({ callForwardTo: '' }), '+14252321355');
  check('no config at all is still fine', M.callForwardPhone(null), '+14252321355');
  check('and the TwiML follows it',
    /<Number>\+14255559999<\/Number>/.test(M.dialMikeyTwiml({ callForwardTo: '4255559999' })), true);
}

console.log('\n=== five webhooks, one ring, one row ===');
{
  const w = world(); const M = build(w);
  // The exact sequence Twilio fires for a caller who presses 1, isn't picked up,
  // and leaves a message that transcribes a minute later.
  await M.recordCall({ sid: 'CA1', from: '+14255551234', fromNorm: '+14255551234', outcome: 'screened' });
  await M.recordCall({ sid: 'CA1', outcome: 'ringing' });
  await M.recordCall({ sid: 'CA1', outcome: 'missed', dialStatus: 'no-answer' });
  await M.recordCall({ sid: 'CA1', outcome: 'voicemail', recording: 'https://api.twilio.com/r.mp3', recordingSid: 'RE1', vmSec: 14 });
  await M.recordCall({ sid: 'CA1', recordingSid: 'RE1', transcript: 'hey mikey, full detail on my truck' });

  const doc = await M.loadCalls();
  check('one call is one row', doc.calls.length, 1);
  check('the last word on the outcome wins', doc.calls[0].outcome, 'voicemail');
  check('the transcript is on the row', doc.calls[0].transcript, 'hey mikey, full detail on my truck');
  check('who called survived every later patch', doc.calls[0].fromNorm, '+14255551234');
  // The transcript callback arrives without a recording URL half the time. A
  // plain Object.assign would blank the playable recording right when you want it.
  check('and the recording was not wiped by the transcript', doc.calls[0].recording, 'https://api.twilio.com/r.mp3');
}

console.log('\n=== the transcript callback can find its call by recording alone ===');
{
  const w = world(); const M = build(w);
  await M.recordCall({ sid: 'CA9', fromNorm: '+14255550001', outcome: 'voicemail', recordingSid: 'RE9' });
  await M.recordCall({ recordingSid: 'RE9', transcript: 'call me back' });
  const doc = await M.loadCalls();
  check('still one row', doc.calls.length, 1);
  check('and it got the words', doc.calls[0].transcript, 'call me back');
}

console.log('\n=== newest first, and the log cannot grow forever ===');
{
  const w = world(); const M = build(w);
  await M.recordCall({ sid: 'A', fromNorm: '+1555', outcome: 'missed' });
  await M.recordCall({ sid: 'B', fromNorm: '+1556', outcome: 'missed' });
  const doc = await M.loadCalls();
  check('the newest call is on top', doc.calls.map((c) => c.sid), ['B', 'A']);

  const big = { calls: [], seenTs: 0 };
  for (let i = 0; i < M.CALLS_MAX + 40; i++) big.calls.push({ id: 'x' + i, sid: 's' + i });
  await M.saveCalls(big);
  const back = await M.loadCalls();
  check('capped', back.calls.length, M.CALLS_MAX);
  check('and it is the oldest that fall off', back.calls[0].sid, 's0');
}

console.log('\n=== a robo-dialer redialing all afternoon costs one write, not forty ===');
{
  const w = world(); const M = build(w);
  const now = Date.now();
  const doc = { calls: [{ id: 'z', fromNorm: '+18005551212', outcome: 'screened', ts: now - 60000 }], seenTs: 0 };
  check('the same number, minutes later, is the same story', M.recentlyScreened(doc, '+18005551212'), true);
  check('a different number is not', M.recentlyScreened(doc, '+14255551234'), false);
  // Half an hour on it is a fresh attempt and worth its own row — somebody who
  // rings back after lunch is usually a person, not a dialer.
  doc.calls[0].ts = now - 45 * 60000;
  check('and neither is the same number an hour later', M.recentlyScreened(doc, '+18005551212'), false);
  // A call that actually got through is never suppressed, however recent.
  check('an answered call is never treated as a repeat robo-dial',
    M.recentlyScreened({ calls: [{ fromNorm: '+18005551212', outcome: 'answered', ts: now }] }, '+18005551212'), false);
}

console.log('\n=== reading the log never writes ===');
{
  const w = world({ calls: { calls: [{ id: 'a', sid: 'CA1', outcome: 'missed' }], seenTs: 5 } });
  const M = build(w);
  await M.loadCalls(); await M.loadCalls();
  check('no writes for two reads', w.written.length, 0);
}

console.log('\n=== recording: the notice is ON the recording, before it rings ===');
{
  const M = build(world());
  const xml = M.dialMikeyTwiml({});
  const start = xml.indexOf('<Start><Recording'), say = xml.indexOf('<Say'), dial = xml.indexOf('<Dial');
  // RCW 9.73.030(3): an announcement only counts as consent if it is recorded
  // too. So the order is the law: start recording, then say it, then ring.
  check('recording starts before the notice', start >= 0 && start < say, true);
  check('the notice plays before the phone rings', say >= 0 && say < dial, true);
  check('the caller hears that it is recorded', xml.includes("This call is recorded"), true);
  // Mikey, 2026-10-06: "doesn't miss any details" made him sound forgetful.
  check('and the reason is the customer, not his memory', /miss any details/.test(xml), false);
  check('Twilio tells us when the file is ready', xml.includes('recordingStatusCallback="/call-recording"'), true);
  check('it is on by default', M.callRecordingOn({}), true);
  check('no config at all is still on', M.callRecordingOn(null), true);

  const off = M.dialMikeyTwiml({ callRecording: false });
  check('switched off: no recording', off.includes('<Recording'), false);
  check('switched off: and no claim that it is recorded', off.includes('recorded'), false);
  check('switched off: the call still rings', /<Number>\+14252321355<\/Number>/.test(off), true);
}

console.log('\n=== recording: a missed call stops before voicemail ===');
{
  const M = build(world());
  check('the call recording stops so the voicemail is not stored twice',
    M.callRecordStopTwiml({}), '<Stop><Recording name="call"/></Stop>');
  check('nothing to stop when recording is off', M.callRecordStopTwiml({ callRecording: false }), '');
  // Only conversations are kept. A missed call's file is the notice and a ring.
  check('answered is kept', M.callRecordingKeep({ outcome: 'answered' }), true);
  check('a call he made is kept', M.callRecordingKeep({ outcome: 'outgoing' }), true);
  check('missed is not', M.callRecordingKeep({ outcome: 'missed' }), false);
  check('voicemail is not (it has its own)', M.callRecordingKeep({ outcome: 'voicemail' }), false);
  check('screened out is not', M.callRecordingKeep({ outcome: 'screened' }), false);
  check('hung up during the notice is not', M.callRecordingKeep({ outcome: 'ringing' }), false);
}

console.log('\n=== recording: what lands in the conversation ===');
{
  const M = build(world());
  const m = M.callTranscriptMessage({ dir: 'in', talkSec: 252, recording: 'https://api.twilio.com/r.mp3', recordingSid: 'RE5' },
    'yeah it is a 2019 tacoma, pretty muddy');
  check('reads as a phone call with its length', m.body, '📞 Phone call, 4:12\n"yeah it is a 2019 tacoma, pretty muddy"');
  check('kind call, so it never reads as Waiting on you', m.kind, 'call');
  check('playable', m.recording, 'https://api.twilio.com/r.mp3');
  check('findable by recording, so a retried callback is not a second bubble', m.recordingSid, 'RE5');
  const out = M.callTranscriptMessage({ dir: 'out', recSec: 65, recording: 'u' }, '');
  check('a call he made says so, and no transcript says nothing made up', out.body, '📞 You called them, 1:05');
  check('and is marked as having no transcript', out.transcriptFailed, true);
}

console.log('\n=== recording: the transcript, piece by piece ===');
{
  const SRC_TX = ['CALL_TX_MODEL', 'CALL_TX_CHUNK', 'CALL_TX_MAX_CHUNKS', 'CALL_TX_PROMPT'].map(liftDecl).join('\n') + '\n' +
    lift('bytesToB64') + '\n' + lift('transcribeCallAudio') + '\nreturn { transcribeCallAudio, CALL_TX_CHUNK };';
  const calls = [];
  const mk = (bytes, aiRun) => new Function('ENV', 'fetch', SRC_TX)(
    { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', AI: aiRun ? { run: aiRun } : undefined },
    async (u, o) => { calls.push({ u, auth: o && o.headers && o.headers.Authorization }); return { ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer }; });
  const T = mk(1, null);
  const size = Math.floor(T.CALL_TX_CHUNK * 2.5);
  const seen = [];
  const X = mk(size, async (model, input) => {
    const n = seen.push({ model, len: atob(input.audio).length, lang: input.language });
    await new Promise((r) => setTimeout(r, 5 * (4 - n)));   // finish out of order
    return { text: ' part' + n + ' ' };
  });
  const text = await X.transcribeCallAudio('https://api.twilio.com/rec.mp3');
  check('2.5 MB goes up as three pieces', seen.length, 3);
  check('pieces are 1 MB except the last', seen.map((x) => x.len), [T.CALL_TX_CHUNK, T.CALL_TX_CHUNK, size - 2 * T.CALL_TX_CHUNK]);
  check('Whisper turbo, in English', [seen[0].model, seen[0].lang], ['@cf/openai/whisper-large-v3-turbo', 'en']);
  check('the text comes back in call order, not finish order', text, 'part1 part2 part3');
  check('the recording is fetched with the Twilio login', !!calls[calls.length - 1].auth, true);

  const none = await mk(10, null).transcribeCallAudio('u');
  check('no AI binding: no transcript, no crash', none, '');
  let threw = false;
  try { await mk(10, async () => { throw new Error('down'); }).transcribeCallAudio('u'); } catch { threw = true; }
  check('every piece failing is a failure, not an empty "transcript"', threw, true);
}

console.log(`\n================  ${PASS} passed, ${FAIL} failed  ================`);
process.exit(FAIL ? 1 : 0);
