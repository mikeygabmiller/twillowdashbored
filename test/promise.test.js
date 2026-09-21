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
  'promStakes', 'promStakesText', 'promStakesHtml', 'promQuestionIn', 'promCostLine',
  'promStakesLite', 'parseReaction',
  'icsEscape', 'icsStamp', 'b64',
  // shared helpers the above lean on
  'jdStr', 'jdIsDate', 'bkLaEpoch', 'bkLaOffsetMin', 'tzFmt', 'localDateStr', 'localTimeHm',
  'humanAgo', 'genId', 'htmlEsc', 'mailLines', 'mailShell', 'mailCard', 'mailLabel',
  'mailShout', 'mailBtn', 'mailBody',
];
// eslint-disable-next-line no-new-func
new Function('ctx', 'ENV', 'publicBase',
  NAMES.map(lift).join('\n') + '\n' +
  ['MAILC', 'MAILF', 'TZFMT', 'PROM_ME_RE', 'PROM_ACT_RE',
    'PROM_DEADLINE_RE', 'PROM_CHASE_RE',
    'REACTION_RE', 'REACTION_ANY_RE', 'REACTION_REMOVED_RE', 'TAPBACKS'].map(liftConst).join('\n') + '\n' +
  NAMES.map((n) => `ctx.${n} = ${n};`).join(''),
)(ctx, { ALERT_EMAIL: 'mikey@example.com' }, () => 'https://dash.example.com');

const {
  promLooksLikePromise, promDueAt, promWorkHours, sanitizePromiseCfg, promOpenFor,
  promIcs, promGcalUrl, promIcsAttachment, promMadeEmail, promDueEmail, b64, bkLaEpoch,
  localTimeHm, localDateStr,
  promStakes, promStakesText, promStakesHtml, promQuestionIn, promDefaults, promStakesLite,
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

console.log('\n=== the stakes: why this one matters ===');
// A reminder that only names the task loses to whatever else is on the screen.
// These read the conversation for the facts that make answering obvious — and
// every one of them has to come off the messages, never be invented.
const HOUR = 3600000, DAY = 86400000;
const NOW2 = Date.parse('2026-09-20T18:00:00Z');
function thr(over) {
  return Object.assign({
    phone: '+13605551234', name: 'Kara Simms', status: 'new',
    quote: { total: 370, at: NOW2 - 9 * DAY },
    messages: [],
  }, over);
}
function msg(dir, body, agoMs) { return { dir, body, ts: NOW2 - agoMs }; }
const REC2 = { id: 'p9', phone: '+13605551234', name: 'Kara Simms', madeAt: NOW2 - 4 * DAY, quote: "I'll let you know", nudges: 0 };

const s1 = promStakes(thr({ messages: [
  msg('in', 'Can you give me an idea of your schedule so I know your availability?', 3 * DAY),
  msg('out', "I'll reach out this weekend and let you know", 4 * DAY - HOUR),
] }), REC2, cfg, NOW2);
check('the open quote is money on the table', s1.money, 370);
check('and it says how long that price has been sitting', /\$370 is still on the table/.test(s1.lines[0]) && /9d ago/.test(s1.lines[0]), true);
check('waiting is measured from THEIR last word', s1.waitingMs, 3 * DAY);
check('their own words come back verbatim', s1.theirLast.startsWith('Can you give me an idea'), true);
check('the question they asked is pulled out', /idea of your schedule/.test(s1.question), true);
check('and named as unanswered', s1.lines.some((l) => /never answered what they asked/i.test(l)), true);
check('the cost line leads with the money', s1.cost, "That's $370 going to whoever answers them first.");
check('at most four reasons — a list you skim past is no list', s1.lines.length <= 4, true);

console.log('\n=== someone who chases is someone still buying ===');
const s2 = promStakes(thr({ quote: null, messages: [
  msg('out', "I'll get back to you", 5 * DAY),
  msg('in', 'just checking in to see if we can schedule?', 3 * DAY),
  msg('in', 'Any update on that?', 1 * DAY),
] }), Object.assign({}, REC2, { madeAt: NOW2 - 5 * DAY }), cfg, NOW2);
check('every message since the promise is counted', s2.chases, 2);
check('and called out as unanswered', s2.lines.some((l) => /written 2 times since/.test(l)), true);
check('no quote means no money line', s2.money, 0);
check('the cost line switches to the chase', /never mind/.test(s2.cost), true);

const s3 = promStakes(thr({ quote: null, messages: [
  msg('out', "I'll let you know", 2 * DAY),
  msg('in', 'Hey, still planning on coming by?', 1 * DAY),
] }), Object.assign({}, REC2, { madeAt: NOW2 - 2 * DAY }), cfg, NOW2);
check('a single chase is quoted back, not counted', s3.lines.some((l) => /came back to ask again/.test(l)), true);
check('one ask gets its own cost line', /a third time/.test(s3.cost), true);

console.log('\n=== a deadline makes a late reply unrecoverable ===');
const s4 = promStakes(thr({ quote: null, messages: [
  msg('in', "I'm selling it to a friend so I need it done before I leave", 2 * DAY),
] }), REC2, cfg, NOW2);
check('the clock is spotted in their words', s4.deadline, 'selling');
check('and quoted rather than paraphrased', s4.lines.some((l) => /mentioned "selling"/.test(l)), true);

console.log('\n=== a won or lost job has no money at stake ===');
check('won', promStakes(thr({ status: 'won' }), REC2, cfg, NOW2).money, 0);
check('lost', promStakes(thr({ status: 'lost' }), REC2, cfg, NOW2).money, 0);

console.log('\n=== a repeat nudge says so ===');
const s5 = promStakes(thr({ quote: null, messages: [msg('in', 'sounds good', 2 * DAY)] }),
  Object.assign({}, REC2, { nudges: 1 }), cfg, NOW2);
check('it admits the first one was ignored', s5.lines.some((l) => /reminder 2/i.test(l)), true);

console.log('\n=== nothing to say beats saying nothing ===');
const s6 = promStakes({ phone: '+1', name: '', messages: [] }, { madeAt: NOW2, nudges: 0 }, cfg, NOW2);
check('an empty conversation raises no reasons', s6.lines.length, 0);
check('and renders to nothing at all', promStakesText(s6) + promStakesHtml(s6), '');

console.log('\n=== the question extractor ===');
check('no question mark, no question', promQuestionIn('Sounds good thanks'), '');
check('the LAST question is the one still hanging',
  promQuestionIn('How much is it? And when can you come?'), 'And when can you come?');
check('a statement before it is dropped',
  promQuestionIn('The car is filthy. Can you do Friday?'), 'Can you do Friday?');

console.log('\n=== the nudge email carries all of it ===');
const RECS = Object.assign({}, REC2, { what: 'send Kara the Friday time', stakes: s1 });
const due2 = promDueEmail(RECS, cfg);
check('their words are in the text half', due2.text.includes('Can you give me an idea'), true);
check('the money is in the text half', due2.text.includes('$370 is still on the table'), true);
check('so is the cost of ignoring it', due2.text.includes('whoever answers them first'), true);
check('the html shows the reasons', due2.html.includes('Why this one matters'), true);
check('and their words, so he answers a person not a task', due2.html.includes('Can you give me an idea'), true);
check('the inbox preheader is THEIR words', due2.html.indexOf('Can you give me an idea') < due2.html.indexOf('You promised'), true);
const due3 = promDueEmail(Object.assign({}, RECS, { nudges: 2 }), cfg);
check('a repeat nudge is labelled as one', due3.html.includes('reminder 3'), true);

console.log('\n=== a customer cannot inject markup through the stakes ===');
const evil2 = promDueEmail(Object.assign({}, RECS, {
  stakes: Object.assign({}, s1, { theirLast: '<script>alert(1)</script>', cost: '<img src=x>' }) }), cfg);
check('tags are escaped', evil2.html.includes('<script>') || evil2.html.includes('<img src=x>'), false);
check('the escaped form shows instead', evil2.html.includes('&lt;script&gt;'), true);

console.log('\n=== repeat-nudge settings are clamped too ===');
check('a silly gap is pulled back', sanitizePromiseCfg({ nudgeEvery: 99999 }, null).nudgeEvery, 168);
check('and a silly count', sanitizePromiseCfg({ maxNudges: 500 }, null).maxNudges, 10);
check('zero nudges is not a way to disable it', sanitizePromiseCfg({ maxNudges: 0 }, null).maxNudges, 1);
check('defaults are sane', [promDefaults().nudgeEvery, promDefaults().maxNudges].join(','), '24,3');

console.log('\n=== a tapback is a sticker, not a message ===');
// Found against the real board: a 👍 on his own quote was being counted as
// "they chased you twice", which is a reason that simply isn't true. One false
// reason and he stops trusting the true ones.
const LIKED = 'Liked \u201cAn interior detail for your Escape with the shampoo would be $250.\u201d';
const s7 = promStakes(thr({ quote: null, messages: [
  msg('out', 'An interior detail for your Escape with the shampoo would be $250.', 31 * DAY),
  msg('in', LIKED, 31 * DAY - HOUR),
] }), Object.assign({}, REC2, { madeAt: NOW2 - 31 * DAY }), cfg, NOW2);
check('a reaction is not a chase', s7.chases, 0);
check('and never becomes "they last said"', s7.theirLast, '');
check('so the row claims nothing it cannot back up', s7.lines.some((l) => /written|came back/.test(l)), false);

console.log('\n=== no name, still readable English ===');
const s8 = promStakes({ phone: '+19094889355', name: '', status: 'new', messages: [
  msg('in', 'Checking in for a quote for a ford explorer, Maltby area. Brian', 45 * DAY),
] }, { madeAt: NOW2 - 45 * DAY, nudges: 0 }, cfg, NOW2);
check('not "They has been waiting"', /They has been/.test(s8.lines.join(' ')), false);
check('the sentence changes shape instead', s8.lines.some((l) => /^They've been waiting 45d/.test(l)), true);

console.log('\n=== the same sentence is never quoted twice ===');
const s9 = promStakes(thr({ quote: null, messages: [
  msg('out', 'I will keep in touch!', 40 * DAY),
  msg('in', 'hello! just checking in to see if we can schedule?', 39 * DAY),
] }), Object.assign({}, REC2, { madeAt: NOW2 - 40 * DAY }), cfg, NOW2);
check('the chase is quoted', s9.lines.some((l) => /came back to ask again/.test(l)), true);
check('and the question line stands down rather than repeat it',
  s9.lines.filter((l) => /just checking in to see if we can schedule/.test(l)).length, 1);

console.log('\n=== one message back is not always a chase ===');
// David sent the address Mikey asked for. That is him doing his part, not him
// chasing — so the cost line must not describe a nag that never happened.
const s10 = promStakes(thr({ quote: null, messages: [
  msg('out', 'If you send over your address I can let you know when I can come by.', 31 * DAY),
  msg('in', '5113 69th Ave Ne Marysville', 31 * DAY - HOUR),
] }), Object.assign({}, REC2, { madeAt: NOW2 - 31 * DAY }), cfg, NOW2);
check('it counts as a message waiting on him', s10.chases, 1);
check('but is not called a chase', /come back once to ask/.test(s10.cost), false);
check('the silence is what gets named instead', /warm lead/.test(s10.cost), true);

console.log('\n=== only what renders gets stored ===');
// This doc is read by the cron every minute. Anything kept on it that nothing
// draws is weight paid 1,440 times a day.
const lite = promStakesLite(s1);
check('the rendered facts survive',
  [lite.money, lite.lines.length > 0, !!lite.cost, !!lite.theirLast].join(','), '370,true,true,true');
check('the working-out does not', [lite.question, lite.chaseQuote, lite.deadline].join(''), '');
check('and it still renders the same email',
  promDueEmail(Object.assign({}, REC2, { stakes: lite }), cfg).text.includes('$370 is still on the table'), true);
check('an empty one stores as nothing', promStakesLite(null), null);

console.log(`\n${FAIL ? '✗' : '✓'} ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
