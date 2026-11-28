// His writing-style guide in every draft (Mikey, 2026-11-24).
//
// docs/WRITING-STYLE.md is measured from the 664 texts he typed himself, and
// "whenever a text needs to be drafted" it has to be in the prompt. What has to
// hold for that to stay true:
//   - the copy inside src/index.js is exactly the .md (edit one, forget the
//     other, and the drafts quietly follow a guide nobody can see)
//   - every surface that writes a customer text gets it, in the right form
//   - it replaces the derived fingerprint instead of arguing with it
//   - AI-written texts he once sent are not shown to the drafter as "his voice"
//   - nothing a customer reads carries an em dash
import fs from 'node:fs';
import { generatedBlock, currentBlock } from '../scripts/sync-writing-style.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x !== undefined ? '→ ' + JSON.stringify(x) : ''); } };
const section = (s) => console.log('\n' + s);

const MD = fs.readFileSync(new URL('../docs/WRITING-STYLE.md', import.meta.url), 'utf8');
const RAW = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

// ---- the worker, in-process, the way afterpage.ui.test.js loads it ---------
const src = RAW.replace(/^export default \{[\s\S]*?^\};$/m, '');
const store = new Map();
const kv = {
  async get(k, o) { const v = store.get(k); if (v === undefined) return null; return (o && o.type === 'json') ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); },
  async list({ prefix } = {}) { return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) }; },
};
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'no', json: async () => ({}) });
// No Gemini key, no Claude key, no AI binding: aiConfigured() is false, so the
// appointment confirmation falls to its template, which is what gets checked.
const M = new Function('__env__', src + '\n; ENV = __env__; return { WRITING_STYLE_GUIDE, styleGuideContext, looksAiWritten,' +
  ' voiceContext, pickVoiceExamples, measureStyle, detConfirmDraft, VOICE_BUCKETS, claudeModel, modelTakesEffort, aiConfigured,' +
  ' POLISH_PLAYBOOK, EXPAND_PLAYBOOK, POLISH_PROMPT, spellPrompt, measuredStyleRules, HELPER_GUIDE, HELPER_QUICK,' +
  ' __reset(){ resetInvocationCaches(); } };')({
  MESSAGES: kv, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14256007897', MIKEY_PHONE: '+13607975831',
  DETECT_DISABLED: '1', PUBLIC_BASE_URL: 'https://texting.test' });
M.__reset();

// The body of one function in src/index.js, so a call site can be read the way
// aicost.test.js reads them: which surface passes what is a fact about the code.
// Cut at the "}" that starts a line, which is how every top-level function in
// that file ends. Counting braces doesn't work: regexes like /^[[{]/ inside a
// function body are unbalanced on purpose.
function body(name) {
  const start = RAW.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = RAW.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`no end for ${name}`);
  return RAW.slice(start, end + 2);
}
const EM = /[—–]/;

section('The guide inside the Worker is the guide in docs/');
ok('the generated block matches docs/WRITING-STYLE.md (if not: node scripts/sync-writing-style.mjs)',
  currentBlock(RAW) === generatedBlock(MD));
const G = M.WRITING_STYLE_GUIDE;
ok('it starts at his rules', G.startsWith('## Start here'), G.slice(0, 40));
ok('it carries every section through the AI-prompt version', /## 2\. The numbers/.test(G) && /## 13\. Short version for an AI prompt/.test(G));
ok('and leaves out how the file was built and its contents list',
  !/How this was built/.test(G) && !/^## Contents/m.test(G));
ok('his real phrases made it in', /shoot for/.test(G) && /general street area/.test(G) && /year, make, and model/.test(G));

section('Wrapped for a prompt');
const draft = M.styleGuideContext('draft'), auto = M.styleGuideContext('auto');
ok('a draft says he reads it before it goes out', /Mikey reads every draft before it is sent/.test(draft));
ok('the automatic one says nobody does', /goes out on its own, without Mikey reading it first/.test(auto));
ok('both carry the whole guide', draft.includes(G) && auto.includes(G));
ok('both say the playbook prices beat the old ones in the examples', /playbook prices always win/.test(draft) && /playbook prices always win/.test(auto));
ok('both say section 8 is about who sends, not what may be written', /section 8 is about who sends a text/.test(draft));
ok('the wrapper has no em dash to copy', !EM.test(draft.replace(G, '')) && !EM.test(auto.replace(G, '')));

section('AI-written texts are not his voice');
for (const t of [
  'Hey! Being straight with you — the Duvall date is looking shaky.',
  'Apologies for the late reply – I\'m migrating phone numbers right now.',
  'Hey, it’s Mikey. Thanks for reaching out!',
  'I spent around an hour on the seatbelts alone; they had stubborn stains.',
  'Here are two packages I would recommend:\nOption 1: $430\nOption 2: $550',
  "Here's what my interior detail includes:\n- Full vacuum\n- Steam clean\n- Inside glass",
]) ok('flags: ' + JSON.stringify(t.slice(0, 48)), M.looksAiWritten(t) === true);
for (const t of [
  'Great! I can likely come by next week. I\'ll keep you posted when I have a firm day and time.',
  'Be there in 10.',
  'Hey, thanks for the call! If you send over your address I can let you know. Talk soon! -Mikey',
  'Total is $279, tax included.',
  'Thank you!!',
  'I have a slot tomorrow from 9:30-2ish. If that doesn\'t work we can shoot for next week, your call.',
]) ok('passes: ' + JSON.stringify(t.slice(0, 48)), M.looksAiWritten(t) === false);

// A small voice profile: his texts, one AI one that would otherwise rank first,
// and a fingerprint to see whether it leaks through.
const voice = { fingerprint: 'FINGERPRINT-SENTINEL', buckets: {} };
for (const b of M.VOICE_BUCKETS) voice.buckets[b] = [];
const AI_TEXT = 'Option 1: $430 for the truck — full detail, carpet shampoo and polish; Option 2: $550';
voice.buckets.price.push(
  { t: AI_TEXT, q: 'how much for my truck' },
  { t: 'Perfect, for a full detail on your truck it will come to $380. If you send over your address I can let you know.', q: 'how much for my truck' },
  { t: 'Sounds good! An interior detail for your Escape with the shampoo would be $250.', q: 'interior only, fabric seats' },
);
voice.buckets.offer.push({ t: 'Can we shoot for 11am?', q: 'what time works' }, { t: 'Would Wednesday around 1pm work for you?', q: 'when can you come' });
voice.buckets.quick.push({ t: 'Be there in 10.' }, { t: 'Ready for ya.' }, { t: 'Sounds good!' }, { t: 'Got it!' }, { t: 'ETA is 1:50.' });
voice.style = M.measureStyle(voice);
const picked = M.pickVoiceExamples(voice, 'price', 'how much for my truck', 20).map((r) => r.t);
ok('retrieval never hands over the AI-written text, even as the closest match', !picked.includes(AI_TEXT), picked);
ok('it still hands over his real one for the same question', picked.some((t) => /\$380/.test(t)));
const guided = M.voiceContext(voice, 'price', 'how much for my truck', { guide: true });
ok('with the guide in the prompt, the derived fingerprint stays out', !/FINGERPRINT-SENTINEL/.test(guided));
ok('and so do the measured rules it replaces', !/HIS STYLE, MEASURED/.test(guided));
ok('but his real texts still go in', /\$380/.test(guided));
const unguided = M.voiceContext(voice, 'price', 'how much for my truck');
ok('without it (the keyboard predictor), the fingerprint is still there', /FINGERPRINT-SENTINEL/.test(unguided) && /HIS STYLE, MEASURED/.test(unguided));

section('Every surface that writes a customer text gets the guide');
const reply = body('generateReply');
ok('reply drafts: the guide is in the cached system block', /const system =[\s\S]*?styleGuideContext\('draft'\)[\s\S]*?;/.test(reply));
ok('and the derived fingerprint is not', !/voiceStyleContext\(voice\)/.test(reply));
const opener = body('draftQuoteOpener');
ok('the automatic quote opener gets the "goes out on its own" form', /styleGuideContext\('auto'\)/.test(opener));
ok('in the cached block, on both the first try and the retry', (opener.match(/system: stable/g) || []).length === 2);
ok('with only the examples from the voice profile', /voiceContext\(voice, bucket, situation, \{ guide: true \}\)/.test(opener));
const followup = body('buildFollowupDraft');
ok('follow-up drafts get it', /styleGuideContext\('draft'\)/.test(followup) && /surface: 'follow-up draft', tier: 'voice', system,/.test(followup));
const appt = body('detConfirmDraft');
ok('appointment confirmations get it', /system: styleGuideContext\('draft'\)/.test(appt));

section('No em dash in the appointment confirmation');
ok('(no AI configured here, so the template is what comes back)', M.aiConfigured() === false);
const rec = { name: 'Ted Basrak', date: '2026-12-05', slot: '13:00', service: 'Full Detail — In & Out', address: '123 Main St' };
const locked = await M.detConfirmDraft(rec, {}, 'confirm');
ok('the locked-in text has no em dash, even from his saved service name', !EM.test(locked), locked);
ok('and names the service the way he would', /Full Detail/.test(locked) && !/In & Out/.test(locked), locked);
const pin = await M.detConfirmDraft(Object.assign({}, rec, { tentative: true }), {}, 'pin');
ok('the "pin down a time" text asks morning or afternoon without one', /morning or afternoon/.test(pin) && !EM.test(pin), pin);

section('The model that writes the instant drafts');
ok('the key route defaults to Haiku 5.5', M.claudeModel('key') === 'claude-haiku-5-5', M.claudeModel('key'));
ok('which takes the effort dial', M.modelTakesEffort(M.claudeModel('key')) === true);

// Mikey, 2026-11-27: "a special focus on phrasing", "clarity and grammar,
// proper grammar and proper sentence phrasing", "especially the longer ones".
// The guide used to teach the opposite in places (keep his comma splices, keep
// his lowercase starts) and even listed perfect grammar as the sign of an AI.
section('Clear, correct grammar comes first in the guide');
ok('it is rule 1', /\n1\. \*\*Clear, correct sentences, every time\.\*\*/.test(G));
ok('section 3 opens with grammar and clarity, before the formatting',
  /## 3\. Grammar and clarity[^\n]*\n\n\*\*Grammar and clarity come first\.\*\*/.test(G));
ok('longer texts get their own recipe: answer first, next step last',
  /\*\*Longer texts get the most care\.\*\*/.test(G) && /Lead with the answer or the main point\./.test(G) && /End with the next step or one question\./.test(G));
ok('nothing tells a writer to keep two sentences glued with a comma', !/Keep that rhythm/.test(G));
ok('or to start lowercase', !/Lowercase starts are fine/.test(G) && !/lowercase quick texts/.test(G) && !/A lowercase start only on/.test(G));
ok('section 11 no longer calls correct grammar the sign of an AI',
  !/with perfect grammar/.test(G) && /Correct grammar is not the giveaway/.test(G));
ok('his example texts are marked as voice, not grammar to copy', /Those habits show his voice, not\s+grammar to copy/.test(MD));
ok('the checklist starts with grammar', /## 12\. Before you hit send\n\n1\. Is the grammar right\?/.test(G));
const BLOCK = (G.match(/```text\n([\s\S]*?)```/) || [null, ''])[1];
ok('the short AI-prompt version leads with it', /^You are texting[^\n]*\n- Clear, correct sentences come first/.test(BLOCK), BLOCK.slice(0, 160));
ok('and no longer teaches "ya" or "10:30ish"', !/\bya\b/.test(BLOCK.replace('"you" not "ya"', '')) && !/10:30ish/.test(BLOCK));
ok('"Ready for ya." is gone from the phrases to use', !/Ready for ya/.test(G));
ok('every draft is told a grammar rule beats one of his example texts',
  /Where one of his example texts breaks a grammar rule, the rule wins/.test(draft) && /the rule wins/.test(auto));

section('The Polish buttons fix grammar instead of guarding his habits');
const PB = M.POLISH_PLAYBOOK;
const fixList = PB.slice(PB.indexOf('FIX SILENTLY'), PB.indexOf('FLAG, NEVER FIX'));
const handsOff = PB.slice(PB.indexOf('NEVER TOUCH'));
ok('✨ Polish capitalises a lowercase start', /starts with a lowercase letter\. Capitalise it/.test(fixList));
ok('…which is off the hands-off list', !/lowercase/i.test(handsOff), handsOff);
ok('his opener gets its apostrophe', /"it's Mikey", with the apostrophe/.test(fixList));
ok('…and "its Mikey" is off the hands-off list', !/its Mikey/.test(handsOff));
ok('mixed-up words get fixed', /your \/ you're, then \/ than/.test(fixList) && /"ya" for "you"/.test(fixList));
ok('an overlong sentence in a longer text gets split', /longer text \(three sentences or more\), a sentence over about 25 words/.test(fixList));
ok('a correct text still comes back untouched', /return his message EXACTLY as written/.test(PB));
ok('"Expand it" (his longer version) is told proper grammar, longer texts most of all',
  /Proper grammar in every sentence/.test(M.EXPAND_PLAYBOOK) && /gets the most care/.test(M.EXPAND_PLAYBOOK));
ok('…and its sample phrase is no longer two sentences glued with a comma', !/is fine, doesn't have to be detailed/.test(M.EXPAND_PLAYBOOK));
ok('email replies: comma splices split and sentences capitalised, words still kept',
  /Two sentences joined by only a comma/.test(M.POLISH_PROMPT) && /capital letter at the start of every sentence/.test(M.POLISH_PROMPT) && /Never add a word/.test(M.POLISH_PROMPT));
const sp = M.spellPrompt('hi');
ok('"Fix spelling": the same fixes, still no word changes',
  /two sentences joined by only a comma split into two/.test(sp) && /capital letter at the start of every sentence/.test(sp) && /Do not change, add, remove or reorder any words/.test(sp));
const habits = M.measuredStyleRules({ n: 100, medLen: 80, p90Len: 200, medSentences: 1, greetPct: 10, emojiPct: 2, smileyPct: 0, exclaimPct: 30, lowerStartPct: 20 });
ok('measured habits no longer call lowercase starts "normal for him"', /Do not copy that/.test(habits) && !/normal for him/.test(habits), habits);
ok('the helper page asks for proper grammar too', M.HELPER_GUIDE.some((s) => s.points.some((p) => /Use proper grammar and spelling/.test(p))));
ok('…and its tap-to-use starters have no missing words', !M.HELPER_QUICK.some((q) => /(^|\. )Just want to know/.test(q.text)));

console.log(`\n================  ${pass} passed, ${fail} failed  ================`);
process.exit(fail ? 1 : 0);
