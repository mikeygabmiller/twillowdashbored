// Unit tests for kept promises — "I'll get back to you Monday" turning into a
// reminder and a calendar invite.
//
// The two risky directions are opposite and both silent:
//   1. a MISSED promise (the gate rejects something he really committed to) —
//      the customer waits and the job quietly dies;
//   2. a WRONG time (the due-time maths lands in the past, at 3am, or on the
//      wrong day) — the reminder is there but useless, which is worse than none.
// So most of what follows is the gate's false-negative side and the clock.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/promise.test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

function lift(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in src/index.js`);
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
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = ([\\s\\S]*?);\\n`, 'm'));
  if (!m) throw new Error(`const ${name} not found in src/index.js`);
  return `const ${name} = ${m[1]};`;
}

const ctx = {};
const NAMES = [
  'promLooksLikePromise', 'promDueAt', 'promWorkHours', 'promDefaults', 'promCfg',
  'sanitizePromiseCfg', 'promOpenFor', 'promBlank', 'promIcs', 'promGcalUrl',
  'promIcsAttachment', 'promWhenLabel', 'promMadeEmail', 'promDueEmail',
  'icsEscape', 'icsStamp', 'b64',
  // shared helpers the above lean on
  'jdStr', 'jdIsDate', 'bkLaEpoch', 'bkLaOffsetMin', 'tzFmt', 'localDateStr', 'localTimeHm',
  'humanAgo', 'genId', 'htmlEsc', 'mailLines', 'mailShell', 'mailCard', 'mailLabel',
  'mailShout', 'mailBtn', 'mailBody',
];
// eslint-disable-next-line no-new-func
new Function('ctx', 'ENV', 'publicBase',
  NAMES.map(lift).join('\n') + '\n' +
  ['MAILC', 'MAILF', 'TZFMT', 'PROM_ME_RE', 'PROM_ACT_RE'].map(liftConst).join('\n') + '\n' +
  NAMES.map((n) => `ctx.${n} = ${n};`).join(''),
)(ctx, { ALERT_EMAIL: 'mikey@example.com' }, () => 'https://dash.example.com');

const {
  promLooksLikePromise, promDueAt, promWorkHours, sanitizePromiseCfg, promOpenFor,
  promIcs, promGcalUrl, promIcsAttachment, promMadeEmail, promDueEmail, b64, bkLaEpoch,
  localTimeHm, localDateStr,
} = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};
const TZ = 'America/Los_Angeles';

console.log('\n=== the free gate catches how he actually types it ===');
for (const t of [
  "Ok, I'll work on getting that Monday spot opened up for you right now. I'll keep in touch and let you know :)",
  "let me check my schedule and get back to you",
  "I'll get back to you tomorrow with a price",
  "ill let you know by tonight",
  "I'm gonna double check that and text you",
  "let me look into it and I'll call you in the morning",
  "I'll price it out and shoot you a number tonight",
  "gonna follow up with you Monday",
  "I'll confirm with my guy and update you",
  "let me see what I can do and reach out",
]) check(`promise: ${t.slice(0, 44)}…`, promLooksLikePromise(t), true);

console.log('\n=== and stays out of the appointment detector\'s lane ===');
for (const t of [
  "I'll be there at 9",                       // that's a job, not a follow-up
  "see you Saturday!",
  "Sounds good, Saturday at 10 works",
  "Let me know if you need anything else",    // his sign-off, nothing owed
  "$375 for the full detail",
  "",
  "ok",
  "Thanks! My address is 326 Avenue i",       // the customer talking
]) check(`not a promise: ${t.slice(0, 44) || '(empty)'}`, promLooksLikePromise(t), false);

console.log('\n=== the clock: what he said becomes when he is nudged ===');
// Dates here are computed from today, never hardcoded. promDueAt() sanity-checks a
// promised date against the REAL clock — it refuses anything already past or more
// than ~400 days out — so a fixed calendar date in this file quietly stops being
// "a day he named" and starts being "a date in the past", falling into the default
// gap and failing. That is how these two rotted.
const dayStr = (offset) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));
const SOON = dayStr(2);      // comfortably inside the trusted window
const WAY_OUT = dayStr(500); // past the ~400-day horizon it refuses to believe

const NOON = bkLaEpoch(dayStr(0), '12:00');   // midday Pacific, today
const cfg = { tz: TZ, promise: { defaultHours: 24 } };
check('a day and a time is taken as given',
  promDueAt({ date: SOON, time: '14:30' }, cfg, NOON), bkLaEpoch(SOON, '14:30'));
check('a day with no time lands at 9am that day',
  promDueAt({ date: SOON, time: '' }, cfg, NOON), bkLaEpoch(SOON, '09:00'));
check('no day at all falls back to the default gap',
  promDueAt({ date: '', time: '' }, cfg, NOON), NOON + 24 * 3600000);
check('a date in the past is not trusted — it falls back too',
  promDueAt({ date: '2020-01-01', time: '09:00' }, cfg, NOON), NOON + 24 * 3600000);
check('and neither is one well past the horizon',
  promDueAt({ date: WAY_OUT, time: '09:00' }, cfg, NOON), NOON + 24 * 3600000);
check('a shorter default is honoured',
  promDueAt({ date: '', time: '' }, { tz: TZ, promise: { defaultHours: 2 } }, NOON), NOON + 2 * 3600000);

console.log('\n=== nobody gets buzzed at 3am ===');
check('3am becomes 8am the same morning',
  localTimeHm(promWorkHours(bkLaEpoch('2026-08-11', '03:00'), cfg), TZ), '08:00');
check('…on the same day', localDateStr(promWorkHours(bkLaEpoch('2026-08-11', '03:00'), cfg), TZ), '2026-08-11');
check('9pm rolls to the next morning',
  localTimeHm(promWorkHours(bkLaEpoch('2026-08-11', '21:00'), cfg), TZ), '08:00');
check('…which is the next day', localDateStr(promWorkHours(bkLaEpoch('2026-08-11', '21:00'), cfg), TZ), '2026-08-12');
check('a working hour is left exactly alone',
  promWorkHours(bkLaEpoch('2026-08-11', '15:00'), cfg), bkLaEpoch('2026-08-11', '15:00'));
check('8am on the dot is already fine',
  promWorkHours(bkLaEpoch('2026-08-11', '08:00'), cfg), bkLaEpoch('2026-08-11', '08:00'));
check('a vague promise made at 9pm still lands in the morning',
  localTimeHm(promDueAt({ date: '', time: '' }, cfg, bkLaEpoch('2026-08-11', '21:00')), TZ), '08:00');

console.log('\n=== one open promise per conversation ===');
const list = [
  { id: 'a', phone: '+1360', status: 'done', madeAt: 500 },
  { id: 'b', phone: '+1360', status: 'open', madeAt: 100 },
  { id: 'c', phone: '+1360', status: 'open', madeAt: 300 },
  { id: 'd', phone: '+1999', status: 'open', madeAt: 900 },
];
check('the newest open one wins', promOpenFor(list, '+1360').id, 'c');
check('a closed one is never picked up', promOpenFor(list, '+1360').status, 'open');
check('another conversation is untouched', promOpenFor(list, '+1999').id, 'd');
check('nothing open reads as nothing', promOpenFor(list, '+1777'), null);

console.log('\n=== settings are clamped, not trusted ===');
check('a silly gap is pulled back into range', sanitizePromiseCfg({ defaultHours: 99999 }, null).defaultHours, 168);
check('zero hours becomes the shortest real gap', sanitizePromiseCfg({ defaultHours: 0 }, null).defaultHours, 1);
check('scan depth is bounded', sanitizePromiseCfg({ scanDepth: 900 }, null).scanDepth, 10);
check('switches flip', sanitizePromiseCfg({ enabled: false, emailEach: false }, null).enabled, false);
check('junk leaves the current value alone', sanitizePromiseCfg({ defaultHours: 'soon' }, { defaultHours: 6 }).defaultHours, 6);

console.log('\n=== the calendar invite is a real one ===');
const REC = {
  id: 'p1', phone: '+13605551234', name: 'Desiree Albano',
  quote: "I'll keep in touch and let you know :)", what: 'tell her if Monday opened up',
  dueAt: bkLaEpoch('2026-08-12', '09:00'), madeAt: NOON,
};
const ics = promIcs(REC);
check('it is a calendar file', ics.startsWith('BEGIN:VCALENDAR') && ics.trim().endsWith('END:VCALENDAR'), true);
check('CRLF line endings, as the spec demands', ics.includes('\r\n') && !/[^\r]\n/.test(ics), true);
check('one event', (ics.match(/BEGIN:VEVENT/g) || []).length, 1);
check('starting at the promised time', ics.includes(`DTSTART:${ctx.icsStamp(REC.dueAt)}`), true);
check('and ending after it', ics.includes(`DTEND:${ctx.icsStamp(REC.dueAt + 900000)}`), true);
check('it names who', ics.includes('SUMMARY:Follow up with Desiree Albano'), true);
check('it carries an alarm', ics.includes('BEGIN:VALARM') && ics.includes('TRIGGER:PT0M'), true);
check('it links back to the conversation', ics.includes('https://dash.example.com/?c=+13605551234'), true);
check('a stable id, so re-adding updates instead of duplicating', ics.includes('UID:promise-p1@'), true);

console.log('\n=== ics escaping (a comma in a quote must not become a new field) ===');
const tricky = promIcs(Object.assign({}, REC, { quote: 'call you, text you; maybe\nboth', what: 'a, b' }));
const descLine = tricky.split('\r\n').filter((l) => l.startsWith('DESCRIPTION:'))[0];
check('commas are escaped', descLine.includes('\\,'), true);
check('semicolons are escaped', descLine.includes('\\;'), true);
check('newlines become \\n, not a broken file', descLine.includes('\\n') && tricky.split('\r\n').every((l) => /^[A-Z]/.test(l) || l === ''), true);

console.log('\n=== the one-tap Google Calendar link ===');
const g = promGcalUrl(REC);
check('points at Google', g.startsWith('https://calendar.google.com/calendar/render?'), true);
check('carries the window', g.includes(`dates=${ctx.icsStamp(REC.dueAt)}%2F${ctx.icsStamp(REC.dueAt + 900000)}`), true);
check('and the name, encoded', g.includes('Follow+up+with+Desiree+Albano') || g.includes('Follow%20up%20with%20Desiree%20Albano'), true);

console.log('\n=== the attachment ===');
const att = promIcsAttachment(REC);
check('is named for the customer', att.filename, 'follow-up-Desiree-Albano.ics');
check('is base64', /^[A-Za-z0-9+/]+=*$/.test(att.content), true);
check('and decodes back to the same file', Buffer.from(att.content, 'base64').toString('utf8'), ics);
check('emoji survive the encoding', Buffer.from(b64('café 🚗'), 'base64').toString('utf8'), 'café 🚗');

console.log('\n=== the emails ===');
const made = promMadeEmail(REC, cfg);
check('his own words are the loud part', /font-weight:800[^<]*">&ldquo;I&#039;ll keep in touch|font-weight:800[^<]*">&ldquo;I'll keep in touch/.test(made.html.replace(/\s+/g, ' ')), true);
check('it says when the nudge lands', made.html.includes('Aug 12'), true);
check('with an add-to-calendar button', made.html.includes('calendar.google.com'), true);
check('it is a whole document', made.html.startsWith('<!doctype html>'), true);
check('the text part stands on its own', made.text.includes("I'll keep in touch") && made.text.includes('Open the conversation'), true);
check('and says nothing was sent to the customer', /just for you/i.test(made.text), true);

const due = promDueEmail(REC, cfg);
check('the nudge quotes the promise', due.html.includes('keep in touch'), true);
check('and offers the conversation', due.html.includes('https://dash.example.com/?c=+13605551234'), true);

console.log('\n=== a customer cannot inject markup through a quote ===');
const evil = promMadeEmail(Object.assign({}, REC, { name: '<b>x</b>', quote: '<script>alert(1)</script>', what: '<img src=x>' }), cfg);
check('tags are escaped', evil.html.includes('<script>') || evil.html.includes('<img src=x>'), false);
check('the escaped form shows instead', evil.html.includes('&lt;script&gt;'), true);

console.log(`\n${FAIL ? '✗' : '✓'} ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
