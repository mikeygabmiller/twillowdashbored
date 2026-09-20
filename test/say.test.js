// "How I talk" — the rules Mikey sets for what his automatic texts may say.
//
// This exists because of one sentence: "I don't want it to ever say what day
// are you thinking." That is a standing preference, and the only honest home
// for a standing preference is config, not a template someone has to edit.
//
// Three layers, tested in the order he reaches for them:
//   1. never[]   a phrase banned outright, everywhere, templates and AI alike
//   2. choices   which closing question, when to sign off, the yes/no switches
//   3. custom{}  he writes the message himself
//
// The invariant that makes layer 1 safe, and the thing most of this file is
// about: a ban that would leave a message with NOTHING to send is refused at
// save time, naming the message — never discovered later by a customer who
// booked and was told nothing.
import fs from 'fs';

let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
src = src.replace(/^export default \{[\s\S]*?^\};$/m, '');

const EXPORTS = ['sayDetok', 'sayBanImpact', 'quoteCloserText',
  'sayDefaults', 'sayRules', 'sayNorm', 'sayBanned', 'sayCustom', 'sayFill',
  'sayFinish', 'sayOneOf', 'sayPreview', 'sayWouldSilence', 'sanitizeSay', 'sayNeverPrompt',
  'findTell', 'defaultConfig', 'quoteOpener', 'quoteFacts', 'quoteCloser', 'openerFault',
  'apiSaveConfig', 'apiSayPreview', 'loadConfig', 'bkMessage', 'dayJobText', 'followupTemplate'];

const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });

const M = new Function('__env__', src + '\n; ENV = __env__; return Object.assign({' + EXPORTS.join(',') +
  '}, {__reset(){ resetInvocationCaches(); }});')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't',
  TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831', DETECT_DISABLED: '1',
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);
const req = (body) => new Request('https://x/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const base = () => { const c = M.defaultConfig(); c.reviewUrl = 'https://g.page/r/abc'; return c; };
const withSay = (over) => { const c = base(); c.say = Object.assign({}, c.say, over); return c; };
const find = (cfg, id) => M.sayPreview(cfg).find((m) => m.id === id);
const allText = (cfg) => M.sayPreview(cfg).map((m) => m.text).join(' \n ');

section('the thing he actually asked for');
ok('"what day" is banned out of the box', M.sayDefaults().never.some((x) => /what day/i.test(x)));
ok('and no message says it', !/what day/i.test(allText(base())), allText(base()).match(/[^.]*what day[^.]*/i));
ok('the quote text still asks something', /\?/.test(find(base(), 'opener').text), find(base(), 'opener').text);

section('1 · never say this');
ok('a banned phrase is reported by name', M.sayBanned('so what day are you thinking?', base()), 'what day are you thinking');
ok('an unbanned sentence is clean', M.sayBanned('See you Tuesday at ten.', base()) === '');
ok('matching ignores case', !!M.sayBanned('WHAT DAY ARE YOU THINKING', base()));
ok('…and punctuation', !!M.sayBanned('What day, are you thinking?', base()));
ok('…and runs of whitespace', !!M.sayBanned('what   day  are you\nthinking', base()));
ok('a rule too short to be a phrase is ignored',
  M.sayBanned('anything at all', withSay({ never: ['a'] })) === '');
ok('no rules means nothing is banned', M.sayBanned('what day are you thinking', withSay({ never: [] })) === '');

section('a ban removes that wording but keeps the message');
const oneGone = withSay({ never: ['no worries at all'] });
ok('the message still sends', !!find(oneGone, 'booking:cancelled').text);
ok('…just not with that wording', !/no worries at all/i.test(find(oneGone, 'booking:cancelled').text));
ok('and nothing is reported silenced', M.sayWouldSilence(oneGone).length === 0, M.sayWouldSilence(oneGone));

section('a ban that would empty a message is caught, not sent blank');
const killer = withSay({ never: ['Mikey'] });
const silenced = M.sayWouldSilence(killer);
ok('it notices', silenced.length > 0, silenced.length);
ok('it names the message, not a code', silenced[0] && /[a-z ]/i.test(silenced[0].label), silenced[0]);
ok('the booking confirmation is among them', silenced.some((m) => m.id === 'booking:confirm'), silenced);
ok('and those messages really are empty, never a blank-ish string',
  find(killer, 'booking:confirm').text === '');

section('…and the save is refused, so he can never reach that state');
await (async () => {
  store.clear(); M.__reset();
  let r = await (await M.apiSaveConfig(req({ say: { never: ['Mikey'] } }))).json();
  ok('refused', r.ok === false && r.error === 'would_silence', r);
  ok('it hands back what would break', Array.isArray(r.silenced) && r.silenced.length > 0);
  ok('and nothing was stored', !store.has('config'));
  M.__reset();
  r = await (await M.apiSaveConfig(req({ say: { never: ['no worries at all'] } }))).json();
  ok('a harmless ban saves fine', r.ok === true && r.config.say.never.includes('no worries at all'), r.error);
})();

section('2 · the choices — where the closing question comes from');
const closer = (c) => find(withSay({ closer: c, never: [] }), 'opener').text;
ok("'open' offers his openings", /what I've got open\?/i.test(closer('open')), closer('open'));
ok("'day' puts the old wording back", /what day were you looking/i.test(closer('day')), closer('day'));
ok("'part' asks morning or afternoon", /morning or afternoon/i.test(closer('part')));
ok("'address' asks where to go", /address I'd be coming to/i.test(closer('address')));
ok("'none' asks nothing", (closer('none').match(/\?/g) || []).length === 0, closer('none'));
// The sign-off comes after the closing question, so strip it before checking
// that the question itself is a whole, properly terminated sentence.
const body = (t) => t.replace(/\s*-\s*Mikey\s*$/, '').trim();
ok('every choice still ends a sentence properly', ['open', 'day', 'part', 'address', 'none']
  .every((c) => /[.?]$/.test(body(closer(c)))), ['open', 'day', 'part', 'address', 'none']
  .map((c) => body(closer(c)).slice(-40)));
ok('no choice leaves a dangling space before the sign-off',
  ['open', 'day', 'part', 'address', 'none'].every((c) => !/\s{2,}/.test(closer(c))));
ok('an unknown choice falls back rather than breaking',
  /what I've got open\?/i.test(find(withSay({ closer: 'nonsense', never: [] }), 'opener').text));

section('sign-off policy');
const signed = (t) => /-\s*Mikey\s*$/.test(t);
ok('"first" signs a confirmation', signed(find(withSay({ signoff: 'first' }), 'booking:confirm').text));
ok('…but not a reminder', !signed(find(withSay({ signoff: 'first' }), 'booking:remind24').text));
ok('"always" signs the reminder too', signed(find(withSay({ signoff: 'always' }), 'booking:remind24').text));
ok('"never" signs nothing at all',
  M.sayPreview(withSay({ signoff: 'never' })).every((m) => !signed(m.text)));
ok('it never doubles up a sign-off already in the wording',
  (find(withSay({ signoff: 'always' }), 'booking:confirm').text.match(/- Mikey/g) || []).length === 1);

section('the yes/no switches');
ok('review ask on: the finished-job text carries the link',
  find(withSay({ reviewAsk: true }), 'run:done').text.includes('g.page'));
ok('review ask off: it does not',
  !find(withSay({ reviewAsk: false }), 'run:done').text.includes('g.page'));
ok('…and the review-only follow-up goes quiet instead of sending filler',
  find(withSay({ reviewAsk: false }), 'followup:won:review').text === '');
ok('…which is allowed, not flagged as broken',
  M.sayWouldSilence(withSay({ reviewAsk: false })).length === 0);
ok('water & power on: the confirm spells it out',
  /spigot|faucet/i.test(find(withSay({ waterPower: true }), 'booking:confirm').text));
ok('off: it does not',
  !/spigot|faucet|outlet/i.test(find(withSay({ waterPower: false }), 'booking:confirm').text),
  find(withSay({ waterPower: false }), 'booking:confirm').text);
ok('…and the message still reads as a sentence',
  !/\s{2,}|\s\./.test(find(withSay({ waterPower: false }), 'booking:confirm').text));
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
ok('emoji off strips one out of his own wording',
  !EMOJI.test(M.sayFinish('All done 🚗', withSay({ emoji: false }), 'every')));
ok('emoji on lets it through',
  EMOJI.test(M.sayFinish('All done 🚗', withSay({ emoji: true }), 'every')));

section('3 · he writes it himself');
const mine = withSay({ custom: { 'booking:confirm': 'Locked in {date} at {time}. See ya.' } });
ok('his wording wins outright', find(mine, 'booking:confirm').text.startsWith('Locked in'));
ok('and the screen marks it as his', find(mine, 'booking:confirm').custom === true);
ok('other messages are untouched', find(mine, 'booking:remindAm').text.startsWith('Morning'));
ok('placeholders are filled', M.sayFill('Hi {first}, {date} at {time}', { first: 'Dana', date: 'Aug 4', time: '10' }) === 'Hi Dana, Aug 4 at 10');
ok('an unknown brace is left exactly as he typed it', M.sayFill('Hi {nope}', { first: 'D' }) === 'Hi {nope}');
ok('a missing value leaves the placeholder rather than printing nothing',
  M.sayFill('Hi {first}', {}) === 'Hi {first}');
ok('his own wording still obeys the sign-off policy',
  signed(M.sayFinish('Locked in.', withSay({ signoff: 'always' }), 'every')));

section('the AI is held to the same rules');
ok('a banned phrase trips the draft gate', M.findTell('so what day are you thinking?', base()) === 'what day are you thinking');
ok('his rule is reported ahead of the built-in tells',
  M.findTell('Certainly! what day are you thinking', base()) === 'what day are you thinking');
ok('built-in tells still fire', M.findTell("Certainly! I'd be happy to assist.", base()) === 'Certainly!');
ok('the model is told the bans up front', /never.*what day are you thinking/i.test(M.sayNeverPrompt(base())));
ok('…and told nothing when there are none', M.sayNeverPrompt(withSay({ never: [] })) === '');
ok('the opener gate refuses a draft using a banned phrase',
  !!M.openerFault("Hey Dana, it's Mikey. Got your Tacoma down here. So what day are you thinking?",
    M.quoteFacts({ name: 'Dana', vehicle: '2019 Toyota Tacoma' }), [], base()));

section('what gets stored is what he can actually set');
const san = (o, cur) => M.sanitizeSay(o, cur);
ok('a junk sign-off falls back', san({ signoff: 'shout' }).signoff === 'first');
ok('a junk closer falls back', san({ closer: 'whatever' }).closer === 'open');
ok('bans are trimmed and capped', san({ never: ['  spaced  ', 'x', ''] }).never.length === 1);
ok('…and the survivor is trimmed', san({ never: ['  spaced  '] }).never[0] === 'spaced');
ok('a long ban is cut, not rejected', san({ never: ['y'.repeat(400)] }).never[0].length === 120);
ok('no more than 50 bans', san({ never: Array(80).fill('phrase here') }).never.length === 50);
ok('a custom key nobody can see is dropped', Object.keys(san({ custom: { 'not:a:message': 'hi' } }).custom).length === 0);
ok('a real custom key is kept', san({ custom: { 'booking:confirm': 'hi there' } }).custom['booking:confirm'] === 'hi there');
ok('an empty custom clears that override', san({ custom: { 'booking:confirm': '   ' } }).custom['booking:confirm'] === undefined);
ok('omitting a field keeps what was stored', san({}, { signoff: 'never' }).signoff === 'never');
ok('a non-object body cannot wipe the rules', san(null, { closer: 'day' }).closer === 'day');

section('the preview is the real thing, not a second copy of it');
const pv = M.sayPreview(base());
ok('every message has an id and a label', pv.every((m) => m.id && m.label));
ok('it covers the booking texts', pv.filter((m) => m.id.startsWith('booking:')).length === 5);
ok('the run board', pv.filter((m) => m.id.startsWith('run:')).length === 3);
ok('the follow-up cadence', pv.filter((m) => m.id.startsWith('followup:')).length === 7);
ok('the cold list, the plan and the opener',
  pv.some((m) => m.id === 'cold:quote') && pv.some((m) => m.id === 'plan') && pv.some((m) => m.id === 'opener'));
ok('and it renders what the real builder renders',
  find(base(), 'booking:confirm').text === M.bkMessage('confirm',
    { phone: '+14255550147', name: 'Dana Reed', slot: '10:00', dateLabel: 'Tue, Aug 4',
      serviceName: 'Full Detail', vehicle: '2019 Subaru Outback', id: 'sample' }, base()));
ok('char counts are reported for the segment maths', pv.every((m) => m.chars === m.text.length));

section('the editor opens on the real sentence, not a blank box');
// Without this, "write your own" means either retyping the message or copying
// the preview and shipping the sample date to every customer forever.
const conf = find(base(), 'booking:confirm');
ok('the template is the message', conf.template.length > 40);
ok('the sample date is a placeholder', /\{date\}/.test(conf.template), conf.template);
ok('…the time too', /\{time\}/.test(conf.template));
ok('…and the service', /\{service\}/.test(conf.template));
ok('no sample value is left to be shipped', !/Aug 4|10:00 AM|Dana|Subaru/.test(conf.template), conf.template);
ok('the first name survives as {first}, not half a surname',
  /\{first\}/.test(find(base(), 'booking:remindAm').template), find(base(), 'booking:remindAm').template);
ok('the full name wins over the first name', M.sayDetok('Hey Dana Reed') === 'Hey {name}');
ok('a template put back through the filler rebuilds the message',
  M.sayFill(conf.template, { date: 'Tue, Aug 4', time: '10:00 AM', service: 'Full Detail',
    name: 'Dana Reed', first: 'Dana', car: '2019 Subaru Outback' }) === conf.text);
ok('his own wording is what the editor opens with once he has one',
  find(withSay({ custom: { 'booking:confirm': 'Mine.' } }), 'booking:confirm').template === 'Mine.');

section('every message is filed under a group');
ok('all of them have one', M.sayPreview(base()).every((m) => !!m.group));
ok('there are several, not one bucket', new Set(M.sayPreview(base()).map((m) => m.group)).size >= 4);
ok('nothing lands in the catch-all', !M.sayPreview(base()).some((m) => m.group === 'Other'));

section('a ban reports how much work it is doing');
const impact = M.sayBanImpact(withSay({ never: ['no worries at all'] }));
ok('it counts the wordings it blocks', impact[0] && impact[0].blocks >= 1, impact);
ok('and names the phrase back', impact[0].phrase === 'no worries at all');
ok('a ban that matches nothing reports zero rather than lying',
  M.sayBanImpact(withSay({ never: ['xylophone repair'] }))[0].blocks === 0);
ok('two overlapping bans are each counted on their own merits',
  M.sayBanImpact(withSay({ never: ['no worries at all', 'no worries'] })).every((x) => x.blocks >= 1),
  M.sayBanImpact(withSay({ never: ['no worries at all', 'no worries'] })));

section('a ban beats a conflicting closer choice');
// Choosing "what day" AND banning it is a contradiction. The ban is the
// stronger statement, and the opener is one sentence with no variants for
// sayOneOf to filter, so the closer is the only place it can bite.
const clash = withSay({ closer: 'day' });
ok('the banned wording does not go out', !/what day were you looking/i.test(find(clash, 'opener').text), find(clash, 'opener').text);
ok('…and it falls to a legal question rather than going silent',
  find(clash, 'opener').text.length > 40 && /\?/.test(find(clash, 'opener').text));
ok('with the ban lifted, his choice is honoured',
  /what day were you looking/i.test(find(withSay({ closer: 'day', never: [] }), 'opener').text));
ok('banning every closing question drops the question, not the text',
  (() => {
    const all = ['open', 'day', 'part', 'address', 'none'].map((c) => M.quoteCloserText(c, false));
    const t = find(withSay({ closer: 'open', never: all }), 'opener').text;
    return t.length > 40 && !/\?/.test(t);
  })(), find(withSay({ closer: 'open', never: ['Want me to send over'] }), 'opener').text);
ok('and the opener never ends on a dangling space',
  !/\s$/.test(find(withSay({ closer: 'none' }), 'opener').text));

section('a banned phrase he typed himself is flagged, not silently stripped');
const ownBad = withSay({ never: ['brand new'], custom: { 'booking:confirm': 'Looks brand new when I go.' } });
ok('his wording still sends', find(ownBad, 'booking:confirm').text.includes('brand new'));
ok('…but the screen warns him', find(ownBad, 'booking:confirm').warn === 'brand new');
ok('a clean message carries no warning', !find(base(), 'booking:remindAm').warn);

section('the preview endpoint reads, and only reads');
await (async () => {
  store.clear(); M.__reset();
  const before = store.size;
  const r = await (await M.apiSayPreview(req({ say: { closer: 'day', never: [] } }))).json();
  ok('it returns the messages', r.ok && r.messages.length > 5);
  ok('it previews the UNSAVED rules', /what day were you looking/i.test(r.messages.find((m) => m.id === 'opener').text));
  ok('…without storing them', store.size === before && !store.has('config'));
  ok('it reports what would be silenced', Array.isArray(r.silenced));
  ok('and how much each ban is doing', Array.isArray(r.impact));
  ok('every row carries what the editor needs', r.messages.every((m) => m.group && typeof m.template === 'string'));
  const r2 = await (await M.apiSayPreview(req({ say: { never: ['Mikey'] } }))).json();
  ok('and flags a silencing draft before he saves it', r2.silenced.length > 0);
})();

section('the rules survive a config round trip');
await (async () => {
  store.clear(); M.__reset();
  await M.apiSaveConfig(req({ say: { closer: 'part', signoff: 'never', never: ['no worries'] } }));
  M.__reset();
  const cfg = await M.loadConfig();
  ok('closer stuck', M.sayRules(cfg).closer === 'part');
  ok('signoff stuck', M.sayRules(cfg).signoff === 'never');
  ok('the ban stuck', M.sayRules(cfg).never.includes('no worries'));
  ok('and it reaches the live templates', !signed(M.bkMessage('confirm',
    { phone: '+1', name: 'Dana', slot: '10:00', dateLabel: 'Aug 4', serviceName: 'Full Detail' }, cfg)));
})();

section('a config with no rules at all still works');
ok('templates render', !!M.bkMessage('confirm', { phone: '+1', name: 'D', slot: '10:00', dateLabel: 'Aug 4', serviceName: 'Full' }, {}));
ok('sayRules tolerates undefined', M.sayRules().closer === 'open');
ok('sayFinish tolerates undefined', typeof M.sayFinish('hi', undefined, 'every') === 'string');
ok('sayOneOf still picks without rules', M.sayOneOf('x', ['a', 'b'], undefined, 'k').length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
