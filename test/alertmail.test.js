// Unit tests for the alert email — the HTML one that lands on Mikey's phone.
//
// Two things in this email are load-bearing rather than decorative, and both are
// invisible until they break:
//   1. the cut marker must be the FIRST text in the HTML, because his reply is
//      sliced there — if it drifts down, the whole alert gets read as his answer;
//   2. the [ref:…] line must survive into the HTML, because that is the only
//      thing that says which customer a reply is about.
// Everything else here guards the loud-message-first layout and the escaping.
//
// The functions are module-private in the Worker, so they're lifted out of the
// source by name and evaluated here rather than exported purely for tests.
//
//   node test/alertmail.test.js
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
// Pull a top-level `const NAME = …;` out of the source so the test can't drift
// from the real value (the cut marker especially).
function liftConst(name) {
  const m = SRC.match(new RegExp(`^const ${name} = ([\\s\\S]*?);\\n`, 'm'));
  if (!m) throw new Error(`const ${name} not found in src/index.js`);
  return `const ${name} = ${m[1]};`;
}

const ctx = {};
const NAMES = [
  'assistAlertBody', 'assistAlertHtml', 'assistAskBlock', 'assistMailto',
  'assistStripQuoted', 'assistRefPhone', 'emailAddr', 'normalizePhone',
  'alertHtml', 'mailShell', 'mailCard', 'mailLabel', 'mailShout', 'mailBtn',
  'htmlEsc', 'mailLines', 'mailBody',
];
// eslint-disable-next-line no-new-func
new Function('ctx', 'ENV', 'publicBase',
  NAMES.map(lift).join('\n') + '\n' +
  ['ASSIST_CUT', 'MAILC', 'MAILF', 'ASSIST_YES', 'ASSIST_NO'].map(liftConst).join('\n') + '\n' +
  'ctx.ASSIST_CUT = ASSIST_CUT; ctx.ASSIST_YES = ASSIST_YES; ctx.ASSIST_NO = ASSIST_NO;' +
  NAMES.map((n) => `ctx.${n} = ${n};`).join(''),
)(ctx, { ALERT_EMAIL: 'mikey@example.com', TWILIO_FROM: '+13605550000' }, () => 'https://dash.example.com');

const {
  ASSIST_CUT, ASSIST_YES, assistAlertBody, assistStripQuoted, assistRefPhone, alertHtml,
} = ctx;

let PASS = 0, FAIL = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? PASS++ : FAIL++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

const CFG = {};
const PHONE = '+13605551234';
const MSG = 'Thank you!  My address is 326 Avenue i.\n\nSnohomish wa.';
const ASK = { kind: 'schedule', ask: 'Can you fit in a 2016 Dodge Ram 2500 on Monday?', examples: ['Yes, 1pm Monday', 'No, next week?'] };
const DRAFT = "Ok, I'll work on getting that Monday spot opened up for you right now.";

const alert = assistAlertBody(CFG, { phone: PHONE, who: 'Desiree Albano', msg: MSG, ask: ASK, draft: DRAFT });

console.log('\n=== the reply still routes home ===');
check('the cut marker is the first text in the HTML',
  alert.html.indexOf(ASSIST_CUT) > -1 && alert.html.indexOf(ASSIST_CUT) < alert.html.indexOf('Desiree'), true);
check('the marker is visible text, not a hidden div',
  /display:none[^>]*>[^<]*--- reply above this line ---/.test(alert.html), false);
check('the ref line rides along in the HTML', alert.html.includes(`[ref:${PHONE}]`), true);
check('the ref line is last', alert.html.lastIndexOf('[ref:') > alert.html.lastIndexOf('Desiree'), true);
check('the plain-text part still leads with the marker', alert.text.startsWith(ASSIST_CUT), true);
check('the plain-text part still carries the ref', alert.text.includes(`[ref:${PHONE}]`), true);

console.log('\n=== a reply quoting this alert still parses ===');
// What Gmail sends back when he types YES above the quoted alert.
const quoted = `YES\n\nOn Fri, Aug 7, 2026 at 9:58 AM Mikeys Dashboard <alerts@example.com> wrote:\n> ${alert.text.replace(/\n/g, '\n> ')}`;
check('the ref is found in the quoted reply', assistRefPhone(quoted), PHONE);
check('only what he typed survives the strip', assistStripQuoted(quoted), 'YES');
check('and it reads as a yes', ASSIST_YES.test(assistStripQuoted(quoted).toLowerCase()), true);

console.log('\n=== the one-tap buttons compose a real reply ===');
const btn = alert.html.match(/href="mailto:([^"]+)"/);
check('a mailto button is offered', !!btn, true);
const composed = decodeURIComponent((btn[1].split('body=')[1] || '').replace(/&amp;/g, '&'));
check('the button body is a bare YES plus the ref', composed, `YES\n\n[ref:${PHONE}]`);
check('the ref routes it', assistRefPhone(composed), PHONE);
check('and the ref is stripped back off before it is read as an answer', assistStripQuoted(composed), 'YES');
check('so the button answers exactly like typing YES', ASSIST_YES.test(assistStripQuoted(composed).toLowerCase()), true);

console.log('\n=== what he sees first is what they said ===');
check('their words are in the shout block', /font-weight:800[^<]*">&ldquo;Thank you!/.test(alert.html.replace(/\s+/g, ' ')), true);
check('their words come before the draft reply',
  alert.html.indexOf('Thank you!') < alert.html.indexOf('Here'), true);
check('their words are the inbox preview line',
  alert.html.slice(0, alert.html.indexOf('</div>')).includes('Thank you!'), true);
check('line breaks in their text are kept', alert.html.includes('Snohomish wa.'), true);
check('the draft is offered with a send button', alert.html.includes('Send it'), true);

console.log('\n=== a complaint gets no one-tap answer ===');
const hot = assistAlertBody(CFG, {
  phone: PHONE, who: 'Dave', msg: 'you scratched my hood',
  ask: { kind: 'escalate', ask: 'He says the hood is scratched.', examples: [] }, draft: DRAFT,
});
check('no send button', hot.html.includes('Send it'), false);
check('no draft shown at all', hot.html.includes(DRAFT), false);
check('it says handle it yourself', hot.html.toLowerCase().includes('handle this one yourself'), true);
check('the text part agrees', hot.text.includes(DRAFT), false);

console.log('\n=== nothing a customer types can inject markup ===');
const evil = assistAlertBody(CFG, {
  phone: PHONE, who: '<b>Bob</b>', msg: '<script>alert(1)</script> & "quotes"', ask: null, draft: '',
});
check('their tags are escaped', evil.html.includes('<script>'), false);
check('the escaped form is what shows', evil.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
check('their name is escaped too', evil.html.includes('<b>Bob</b>'), false);
check('ampersands are escaped', evil.html.includes('&amp; &quot;quotes&quot;'), true);

console.log('\n=== email answering off: no marker, no ref, no buttons ===');
const off = assistAlertBody({ assistEmail: false }, { phone: PHONE, who: 'Dave', msg: 'hi', ask: ASK, draft: DRAFT });
check('no cut marker in the text', off.text.includes(ASSIST_CUT), false);
check('no ref in the text', off.text.includes('[ref:'), false);
check('no ref in the HTML', off.html.includes('[ref:'), false);
check('no mailto buttons', off.html.includes('mailto:'), false);
check('but the message is still shown loud', off.html.includes('&ldquo;hi&rdquo;'), true);

console.log('\n=== plain-text alerts get laid out too ===');
const vm = alertHtml('🎙️ Voicemail transcript from +13605551234',
  '"Hey Mikey, it\'s Dave — can you do my truck Saturday?"\n\nOpen the dashboard to reply.');
check('the quoted transcript becomes the loud block', /font-weight:800/.test(vm), true);
check('the transcript is escaped and present', vm.includes('Hey Mikey, it&#039;s Dave') || vm.includes("Hey Mikey, it's Dave"), true);
check('a dashboard button is added', vm.includes('https://dash.example.com'), true);
check('it is a whole document', vm.startsWith('<!doctype html>') && vm.trimEnd().endsWith('</html>'), true);

const conf = alertHtml('Re: your customer', `${ASSIST_CUT}\nQueued for Dave.\n\n[ref:${PHONE}]`);
// The hidden inbox-preview line sits above everything by design; order is only
// meaningful for the text a mail client will actually quote back.
const visible = (h) => h.replace(/<div style="display:none[\s\S]*?<\/div>/, '');
check('a confirmation keeps its marker first', visible(conf).indexOf(ASSIST_CUT) < visible(conf).indexOf('Queued'), true);
check('a confirmation keeps its ref', conf.includes(`[ref:${PHONE}]`), true);
check('the ref appears once, at the bottom', (conf.match(/\[ref:/g) || []).length, 1);
check('the preview line is the message, not the plumbing',
  /Queued for Dave/.test(conf.slice(0, conf.indexOf('</div>'))) && !/\[ref:/.test(conf.slice(0, conf.indexOf('</div>'))), true);

const quote = alertHtml('🔔 New quote — Desiree Albano',
  '🔔 NEW QUOTE — Desiree Albano\nPhone: +1 360 555 1234\nQuote: $375 full detail\n\nOpen the dashboard to reply.');
check('an emoji-led first line becomes a heading', quote.includes('NEW QUOTE — Desiree Albano</div>'), true);
check('"Label: value" lines put the weight on the value', /Phone:<\/span> <b[^>]*>\+1 360 555 1234<\/b>/.test(quote), true);
check('an alert outside the reply loop is captioned with its subject',
  quote.includes('🔔 New quote — Desiree Albano</div>') &&
  quote.indexOf('🔔 New quote — Desiree Albano</div>') < quote.indexOf('NEW QUOTE — Desiree Albano</div>'), true);
check('and carries no reply plumbing', quote.includes(ASSIST_CUT) || quote.includes('[ref:'), false);

console.log('\n=== a photo with no words ===');
const pic = assistAlertBody(CFG, { phone: PHONE, who: 'Dave', msg: '', ask: null, draft: '', media: 2 });
check('says a photo came in', pic.html.includes('Dave sent a photo'), true);
check('no empty pair of quotes', pic.html.includes('&ldquo;&rdquo;'), false);
check('counts them', pic.html.includes('2 photos, no message'), true);
check('the text part says photo too', pic.text.includes('"[photo]"'), true);

console.log('\n=== the markup itself is sound ===');
for (const [label, html] of [['customer alert', alert.html], ['plain alert', vm]]) {
  const open = (html.match(/<table\b/g) || []).length, close = (html.match(/<\/table>/g) || []).length;
  check(`${label}: tables are balanced`, open === close && open > 0, true);
  const dopen = (html.match(/<div\b/g) || []).length, dclose = (html.match(/<\/div>/g) || []).length;
  check(`${label}: divs are balanced`, dopen === dclose, true);
  check(`${label}: opts out of dark-mode inversion`, html.includes('color-scheme'), true);
  check(`${label}: fits in a phone-width column`, html.includes('max-width:600px'), true);
}

console.log(`\n${FAIL ? '✗' : '✓'} ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL ? 1 : 0);
