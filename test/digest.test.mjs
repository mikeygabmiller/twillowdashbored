import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as V from '../src/digest-verify.js';
import * as S from '../src/digest-sources.js';
import * as R from '../src/digest-render.js';
import * as D from '../src/digest.js';
import { digestRoute } from '../src/digest-api.js';
import { makeCtx, fakeKV, fakeFetch, fakeGemini } from './harness.mjs';
import * as F from './fixtures.mjs';

// ===========================================================================
// Judgment & truth
// ===========================================================================
test('verbatim guard keeps numbers the source states', () => {
  const src = 'CQuartz UK 3.0 is $79 for the 50ml kit, down from $109. It beads at 18 months.';
  const out = V.verbatimGuard('CQuartz UK 3.0 is down to $79 from $109 for a 50ml kit. Owners report beading at 18 months on PNW cars, which is the durability number that matters.', src);
  assert.equal(out.stripped.length, 0);
  assert.ok(out.ok);
  assert.match(out.text, /\$79/);
});

test('verbatim guard strips a sentence carrying an invented price', () => {
  const src = 'Icon 1/2 in impact is 25% off, bringing it to $149.';
  const out = V.verbatimGuard(
    'The Icon impact is 25% off at $149 with the coupon. It normally retails at $44 which nobody mentioned. Worth it for lug nuts if you are already going.',
    src);
  assert.equal(out.stripped.length, 1);
  assert.match(out.stripped[0].tokens.join(','), /\$44/);
  assert.doesNotMatch(out.text, /\$44/);
  assert.match(out.text, /\$149/);
});

test('verbatim guard rejects an item that is mostly invention', () => {
  const src = 'Someone asked about wax.';
  const out = V.verbatimGuard('It is $59 today. It was $99 before. Stock runs out at 40% off.', src);
  assert.equal(out.ok, false);
});

test('verbatim guard checks model numbers, not ordinary counts', () => {
  const src = 'The M12 stubby handled it.';
  const ok = V.verbatimGuard('The M12 stubby handled it, and three of the five commenters agreed it is the pick for tight engine bays under a hood.', src);
  assert.equal(ok.stripped.length, 0);
  const bad = V.verbatimGuard('The M18 stubby handled it, and it is the pick for tight engine bays under a hood without question.', src);
  assert.equal(bad.stripped.length, 1);
});

test('money verifies across formatting differences', () => {
  const src = 'It came to 1,299.00 dollars all in.';
  const out = V.verbatimGuard('The build came to $1299 all in, which is the number worth remembering before you quote a job like it.', src);
  assert.equal(out.stripped.length, 0);
});

test('quote check accepts exact and near-exact, rejects invention', () => {
  const src = 'post: I bought at $79 last spring and it hit $69 in March, so this is not the floor.';
  assert.equal(V.quoteCheck('I bought at $79 last spring and it hit $69 in March', src).ok, true);
  assert.equal(V.quoteCheck('I bought at $79 last spring and it hit $69 in March, so this is not the floor', src).reason, 'exact');
  assert.equal(V.quoteCheck('This sentence was never in any of the source material at all.', src).ok, false);
});

test('source diversity quota stops one subreddit owning the digest', () => {
  const items = [1, 2, 3, 4, 5].map((n) => ({ id: n, source: n <= 4 ? 'AutoDetailing' : 'Tools' }));
  const out = V.diversityQuota(items, 2, (x) => x.source);
  assert.equal(out.items.length, 3);
  assert.equal(out.cut.length, 2);
  assert.equal(out.items.filter((i) => i.source === 'AutoDetailing').length, 2);
});

test('ledger separates fresh, changed and already-told', () => {
  const ledger = {};
  const item = { key: 'a', entity: 'CQuartz UK', title: 'CQuartz UK', point: 'It is $79 today.' };
  let split = V.applyLedger([item], ledger, { today: '2026-08-01' });
  assert.equal(split.fresh.length, 1);
  V.recordLedger(ledger, split.fresh, '2026-08-01');

  split = V.applyLedger([item], ledger, { today: '2026-08-02' });
  assert.equal(split.repeat.length, 1, 'same claim next day is suppressed');

  const cheaper = { key: 'a', entity: 'CQuartz UK', title: 'CQuartz UK', point: 'It is $69 today.' };
  split = V.applyLedger([cheaper], ledger, { today: '2026-08-02' });
  assert.equal(split.changed.length, 1, 'same subject, new number is news');
  assert.equal(split.changed[0].priorOn, '2026-08-01');
});

test('ledger lets a claim back in after the cool-off', () => {
  const ledger = {};
  const item = { key: 'a', entity: 'Thing', title: 'Thing', point: 'It is $10.' };
  V.recordLedger(ledger, V.applyLedger([item], ledger, { today: '2026-07-01' }).fresh, '2026-07-01');
  const split = V.applyLedger([item], ledger, { today: '2026-08-01', cooloffDays: 21 });
  assert.equal(split.repeat.length, 0);
});

test('price history refuses to call a price a floor when it is not', () => {
  const entities = {};
  V.updateEntities(entities, [{ entity: 'CQuartz UK', title: 'x', point: 'was $69' }], '2026-03-10');
  V.updateEntities(entities, [{ entity: 'CQuartz UK', title: 'x', point: 'now $89' }], '2026-06-10');
  const verdict = V.priceVerdict(entities['cquartz-uk'], 79, '2026-08-04');
  assert.equal(verdict.kind, 'above_floor');
  assert.match(verdict.text, /\$69/);
  assert.match(verdict.text, /March/);
  assert.match(verdict.text, /isn't the bottom/);

  const floor = V.priceVerdict(entities['cquartz-uk'], 59, '2026-08-04');
  assert.equal(floor.kind, 'floor');
});

test('story continuity counts consecutive days only', () => {
  const e = {};
  V.updateEntities(e, [{ entity: 'Thing', point: '' }], '2026-08-01');
  V.updateEntities(e, [{ entity: 'Thing', point: '' }], '2026-08-02');
  V.updateEntities(e, [{ entity: 'Thing', point: '' }], '2026-08-03');
  assert.equal(V.storyLabel(e.thing), 'Day 3');
  V.updateEntities(e, [{ entity: 'Thing', point: '' }], '2026-08-20');
  assert.equal(V.storyLabel(e.thing), '', 'a gap resets the run');
});

test('absence detection flags a broken rhythm, and only once', () => {
  const signals = [{ id: 'hf-coupon', label: 'HF coupon drop', cadenceDays: 7 }];
  const tracker = { 'hf-coupon': { hits: ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'], lastOn: '2026-06-22' } };
  const first = V.detectAbsence(signals, tracker, [], '2026-07-05');
  assert.equal(first.flags.length, 1);
  assert.match(first.flags[0].text, /first break in 2 weeks/i);
  const second = V.detectAbsence(signals, first.tracker, [], '2026-07-06');
  assert.equal(second.flags.length, 0, 'does not re-flag the same silence daily');
  const back = V.detectAbsence(signals, second.tracker, ['hf-coupon'], '2026-07-07');
  assert.equal(back.flags.length, 0);
  assert.equal(back.tracker['hf-coupon'].flaggedOn, '');
});

test('absence stays quiet without enough history to know the rhythm', () => {
  const out = V.detectAbsence([{ id: 'x', label: 'X', cadenceDays: 7 }], { x: { hits: ['2026-06-01'], lastOn: '2026-06-01' } }, [], '2026-08-01');
  assert.equal(out.flags.length, 0);
});

test('weights decay back toward neutral on a half-life', () => {
  let w = { topics: { ow: 1 }, terms: {} };
  V.bumpWeight(w, 'topics', 'ow', -0.8);
  assert.equal(w.topics.ow, 0.2);
  w = V.decayWeights(w, 14);
  assert.ok(w.topics.ow > 0.55 && w.topics.ow < 0.65, 'halfway back after one half-life');
  w = V.decayWeights(w, 140);
  assert.equal(w.topics.ow, undefined, 'a weight that reaches neutral is dropped');
});

test('weights are clamped so one tap cannot bury a topic forever', () => {
  const w = { topics: {}, terms: {} };
  for (let i = 0; i < 20; i++) V.bumpWeight(w, 'topics', 'ow', -0.5);
  assert.equal(w.topics.ow, V.WEIGHT_MIN);
});

test('standing orders block candidates before the model ever sees them', () => {
  const cands = [
    { title: 'Great air ratchet', body: 'needs a compressor to run', comments: [] },
    { title: 'Cordless polisher', body: 'battery powered', comments: [] },
  ];
  const out = V.applyStandingOrders(cands, [{ id: 'o1', text: 'never show me anything needing a compressor', never: ['compressor'] }]);
  assert.equal(out.items.length, 1);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.items[0].title, 'Cordless polisher');
});

test('scoring rewards kit matches and punishes repeats', () => {
  const base = { topicId: 't', rank: 0, title: 'CQuartz sale', body: '', comments: [] };
  const plain = V.scoreCandidate(base, { weights: {}, kitTerms: [], behaviorTerms: [] });
  const owned = V.scoreCandidate(base, { weights: {}, kitTerms: ['cquartz'], behaviorTerms: [] });
  const repeat = V.scoreCandidate(Object.assign({ repeat: true }, base), { weights: {}, kitTerms: [], behaviorTerms: [] });
  assert.ok(owned > plain);
  assert.ok(repeat < plain);
});

// ===========================================================================
// Sources
// ===========================================================================
test('atom parsing survives entity-escaped HTML inside content', () => {
  const xml = F.atomFeed(F.POSTS.AutoDetailing);
  const posts = S.parseFeed(xml, { limit: 10 });
  assert.equal(posts.length, 3);
  assert.equal(posts[0].id, 't3_aa1');
  assert.match(posts[0].title, /CQuartz UK 3\.0/);
  assert.match(posts[0].body, /\$79 for the 50ml kit/);
  assert.doesNotMatch(posts[0].body, /</, 'no live markup survives into the body');
});

test('rss 2.0 with CDATA parses too', () => {
  const items = S.parseFeed(F.rss2Feed(F.NEWS), { limit: 5 });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Snohomish County fair week brings road closures');
  assert.match(items[1].body, /\$250/);
});

test('reddit falls back to the JSON endpoint when RSS is refused', async () => {
  const ff = fakeFetch({ reddit: '403' });
  const out = await S.collectReddit(['AutoDetailing'], { perSub: 5, fetchImpl: ff.fn, sleep: async () => {}, attempts: 1 });
  assert.equal(out.bySub.AutoDetailing.length, 3);
  assert.ok(out.diagnostics.some((d) => /tier3/.test(d) && /^ok/.test(d)), out.diagnostics.join('\n'));
});

test('a subreddit that answers nowhere costs only itself', async () => {
  const ff = fakeFetch({ reddit: 'dead' });
  const out = await S.collectReddit(['AutoDetailing'], { perSub: 5, fetchImpl: ff.fn, sleep: async () => {}, attempts: 1 });
  assert.deepEqual(out.bySub, {});
  assert.ok(out.diagnostics.some((d) => /no source tier answered/.test(d)));
});

test('comments are pulled and attached to their post', async () => {
  const ff = fakeFetch({});
  const post = { id: 't3_aa1', url: 'https://www.reddit.com/r/AutoDetailing/comments/aa1/cquartz/', comments: [] };
  const out = await S.attachComments([post], { perPost: 4, fetchImpl: ff.fn, sleep: async () => {}, attempts: 1 });
  assert.equal(out.got, 1);
  assert.equal(post.comments.length, 2);
  assert.match(post.comments[0], /hit \$69 in March/);
});

test('weather maps to hours so a 2pm job can be judged', async () => {
  const dates = ['2026-08-04', '2026-08-05', '2026-08-06'];
  const ff = fakeFetch({ dates });
  const { weather } = await S.collectWeather(47.9, -122.1, 'America/Los_Angeles', { fetchImpl: ff.fn, sleep: async () => {}, attempts: 1 });
  assert.equal(weather.ok, true);
  const during = S.rainDuring(weather, '2026-08-05', '14:00', 180);
  assert.equal(during.rainChance, 82);
  assert.equal(during.source, 'hourly');
  const morning = S.rainDuring(weather, '2026-08-05', '09:00', 120);
  assert.equal(morning.rainChance, 12);
});

// ===========================================================================
// Renderer
// ===========================================================================
function sampleDoc() {
  return {
    id: '2026-08-04', date: '2026-08-04', dateLabel: 'Tuesday, August 4',
    headline: 'CQuartz is $79 through Sunday.',
    business: { monthNet: 337.5, weekGross: 440, jobsToday: 1, jobsTomorrow: 2, unanswered: 1, reviews30: 1, monthJobs: 2,
      lines: [{ text: '1 lead waiting on you.', tone: 'bad' }] },
    plan: { entries: [{ when: '2:00 PM', what: 'Full Detail — Dana', note: '82% rain · wash-out', tone: 'bad' }], summary: 'Tomorrow: 82% rain.' },
    hero: { key: 'h1', title: 'CQuartz UK 3.0 at $79', point: 'It is $79 for the 50ml kit.', quote: 'not the floor',
      sourceLabel: 'r/AutoDetailing', url: 'https://reddit.com/x', entity: 'CQuartz', topicId: 'detailing', topicLabel: 'Detailing',
      deadline: 'ends Sunday', stakes: 'saves $30', story: 'Day 3', priceNote: 'It hit $69 in March.',
      contested: { claim: 'Buy now.', counter: 'Wait for the holiday sale.' } },
    deals: [{ key: 'd1', title: 'Icon impact 25% off', point: 'Now $149.', topicLabel: 'Harbor Freight', topicId: 'hf', deadline: 'ends Sunday' }],
    briefs: [{ id: 'ow', label: 'Overwatch 2', emoji: '🎮', items: [{ key: 'b1', title: 'Patch', point: 'Balance pass.', topicLabel: 'Overwatch 2', topicId: 'ow' }] }],
    absence: [{ text: 'HF coupon: nothing for 15 days.' }],
    seasonal: [{ text: 'Wildfire smoke season starts in 12 days.' }],
    skill: { title: 'Two-bucket wash', body: 'One soap, one rinse.', n: '1 of 20' },
    question: 'What do you charge for a three-row SUV?',
    skim: [{ topic: 'Detailing', text: 'CQuartz is $79.' }],
  };
}

test('the email keeps the same skeleton in the same order every day', () => {
  const out = R.renderDigest(sampleDoc(), { baseUrl: 'https://x.dev', actionUrl: (i, a) => `https://x.dev/d/a/${i.key}-${a}` });
  // Apostrophes arrive HTML-escaped, so the labels are matched on their stable parts.
  const order = ['Your numbers', 'The plan', '30 seconds', 'one thing', 'Clock is running', 'Briefs',
    'didn&#39;t happen', 'Coming at you', 's skill', 'One question'];
  let at = -1;
  for (const label of order) {
    const i = out.html.indexOf(label);
    assert.ok(i > at, `${label} is out of order`);
    at = i;
  }
});

test('business numbers render above anything from the internet', () => {
  // The headline sits above everything by design (it's the inbox preview line);
  // what must never move is the numbers block relative to the internet content.
  const html = R.renderDigest(sampleDoc(), { baseUrl: 'https://x.dev' }).html;
  assert.ok(html.indexOf('Your numbers') < html.indexOf('one thing'));
  assert.ok(html.indexOf('Month net') < html.indexOf('CQuartz UK 3.0 at $79'), 'tiles precede the hero item');
  assert.ok(html.indexOf('Month net') < html.indexOf('Briefs'));
  assert.ok(html.indexOf('Unanswered leads') < html.indexOf('Icon impact'));
});

test('the email carries reading time, chips, contested block and one-tap links', () => {
  const out = R.renderDigest(sampleDoc(), { baseUrl: 'https://x.dev', actionUrl: (i, a) => `https://x.dev/d/a/${i.key}-${a}` });
  assert.match(out.html, /min read/);
  assert.match(out.html, /ends Sunday/);
  assert.match(out.html, /saves \$30/);
  assert.match(out.html, /Day 3/);
  assert.match(out.html, /One camp/);
  assert.match(out.html, /The other/);
  assert.match(out.html, /https:\/\/x\.dev\/d\/a\/h1-buy/);
  assert.match(out.html, /Not for me/);
  assert.match(out.html, /Remind me Friday/);
  assert.doesNotMatch(out.html, /\[object Promise\]/);
  assert.ok(out.readingMin >= 1);
});

test('an empty day still renders every section, and says so', () => {
  const empty = Object.assign(sampleDoc(), { hero: null, deals: [], briefs: [], absence: [], seasonal: [], skim: [] });
  const out = R.renderDigest(empty, { baseUrl: 'https://x.dev' });
  assert.match(out.html, /Nothing worth your time today/);
  assert.match(out.html, /Nothing with a deadline today/);
  assert.match(out.html, /Your numbers/);
  assert.match(out.text, /Nothing worth your time today/);
});

test('typography mode drops the emoji from headers', () => {
  const withEmoji = R.renderDigest(sampleDoc(), { emojiHeaders: true, baseUrl: 'https://x.dev' });
  const without = R.renderDigest(sampleDoc(), { emojiHeaders: false, baseUrl: 'https://x.dev' });
  assert.match(withEmoji.html, /💵 Your numbers/);
  assert.doesNotMatch(without.html, /💵/);
  assert.match(without.html, /serif/);
});

test('audio script is speech-shaped and inside its time budget', () => {
  const out = R.renderAudioScript(sampleDoc(), { minutes: 4 });
  assert.ok(out.words > 40, 'has content');
  assert.ok(out.words <= 4 * 155, 'respects the budget');
  assert.doesNotMatch(out.script, /https?:\/\//);
  assert.doesNotMatch(out.script, /r\/AutoDetailing/);
  assert.match(out.script, /dollars/, 'money is spoken, not symboled');
});

test('html escaping survives a hostile title', () => {
  const doc = sampleDoc();
  doc.hero.title = '<script>alert(1)</script> & "quotes"';
  const out = R.renderDigest(doc, { baseUrl: 'https://x.dev' });
  assert.doesNotMatch(out.html, /<script>alert/);
  assert.match(out.html, /&lt;script&gt;/);
});

// ===========================================================================
// Pipeline
// ===========================================================================
test('a full build produces a verified, ranked, rendered digest', async () => {
  const ctx = makeCtx();
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, true, built.reason);
  assert.ok(built.doc.hero, 'a hero was chosen');
  assert.ok(built.html.length > 2000);
  assert.match(built.subject, /☕/);

  // Business data made it in, above the internet.
  assert.equal(built.doc.business.jobsTomorrow, 2);
  assert.equal(built.doc.business.unanswered, 1);
  assert.ok(built.doc.business.lines.some((l) => /waiting on you/.test(l.text)));

  // Weather-conditional scheduling caught the 2pm outdoor job under rain.
  const wet = built.doc.plan.entries.find((e) => /2:00 PM/.test(e.when));
  assert.ok(wet, 'the 2pm job is in the plan');
  assert.equal(wet.tone, 'bad');
  assert.match(wet.note, /82% rain/);
  assert.match(wet.note, /wash-out/i);

  // The interior job is not judged on weather.
  const indoor = built.doc.plan.entries.find((e) => /9:00 AM/.test(e.when));
  assert.match(indoor.note, /weather doesn't decide/);

  // The invented "$44" never reaches the email, and the run says it cut it.
  assert.doesNotMatch(built.html, /retails at \$44/);
  assert.ok(built.diagnostics.some((d) => /unverified number.*\$44/.test(d)), built.diagnostics.join('\n'));

  // The fabricated quote was dropped rather than printed.
  assert.doesNotMatch(built.html, /never in any of the source material/);

  // Skeleton pieces that must always exist.
  assert.ok(built.doc.question.length > 8);
  assert.ok(built.doc.skill.title);
  assert.ok(built.audio.script.length > 100);
});

test('dry run writes nothing at all', async () => {
  const ctx = makeCtx();
  const before = ctx.kv._m.size;
  const built = await D.buildDigest(ctx, { now: ctx._now, dryRun: true, actionUrl: false });
  assert.equal(built.ok, true);
  assert.equal(ctx.kv._m.size, before, 'no KV writes during a preview');
  assert.equal(ctx._sent.length, 0);
});

test('sending persists exactly what it shipped and nothing more', async () => {
  const ctx = makeCtx();
  const built = await D.buildDigest(ctx, { now: ctx._now });
  const res = await D.sendDigest(ctx, built);
  assert.equal(res.delivered, true);
  assert.equal(ctx._sent.length, 1);
  assert.ok(ctx._sent[0].html.length > 1000);
  assert.ok(ctx._sent[0].text.length > 400, 'plain-text alternative is sent too');

  const seen = await ctx.kv.get(D.K.seen, { type: 'json' });
  assert.deepEqual(seen.slice().sort(), built.doc.itemKeys.slice().sort(), 'only shipped items are marked seen');

  const index = await ctx.kv.get(D.K.index, { type: 'json' });
  assert.equal(index.length, 1);
  assert.equal(index[0].id, built.id);
  assert.ok(index[0].q.includes('cquartz'), 'archive is searchable');

  const state = await ctx.kv.get(D.K.state, { type: 'json' });
  assert.equal(state.lastSentOn, ctx._today);
  assert.equal(state.pendingQuestion, built.doc.question);
});

test('the next day never repeats what it already shipped', async () => {
  const ctx = makeCtx();
  const first = await D.buildDigest(ctx, { now: ctx._now });
  await D.sendDigest(ctx, first);
  assert.ok(first.doc.itemKeys.length);

  // Nothing new has appeared in the sources overnight, so anything the second
  // run finds must be material the first run didn't use. A post that was
  // fetched but not shipped deliberately stays eligible — dropping it once
  // shouldn't bury it forever.
  const second = await D.buildDigest(ctx, { now: ctx._now + 86400000 });
  if (second.ok) {
    for (const key of second.doc.itemKeys) {
      assert.ok(!first.doc.itemKeys.includes(key), `${key} was already sent yesterday`);
    }
  } else {
    assert.match(second.reason, /no material|nothing verified/);
  }
});

test('running the sources dry is reported, not crashed through', async () => {
  const ctx = makeCtx({ fetch: fakeFetch({ reddit: 'dead', news: 'dead', dates: ['2026-08-04', '2026-08-05'] }) });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, false);
  assert.match(built.reason, /no material/);
  assert.ok(built.diagnostics.some((d) => /no source tier answered/.test(d)));
});

test('the editorial pass can cut everything and that is a valid digest', async () => {
  const ctx = makeCtx({ gemini: fakeGemini({ cutAll: true }) });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, true);
  assert.equal(built.doc.hero, null);
  assert.match(built.html, /Nothing worth your time today/);
  assert.match(built.html, /Your numbers/, 'the numbers still ship on an empty day');
});

test('a failed model call degrades instead of killing the run', async () => {
  const ctx = makeCtx({ gemini: fakeGemini({ failEditor: true }) });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, true);
  assert.ok(built.diagnostics.some((d) => /editorial pass/.test(d)));
  assert.ok(built.doc.hero, 'items survive without the editor');
});

test('with every model call failing there is no digest, but there is a reason', async () => {
  const ctx = makeCtx({ gemini: fakeGemini({ failAll: true }) });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, false);
  assert.match(built.reason, /nothing verified|no material/);
  assert.ok(built.diagnostics.length > 3);
});

test('standing orders and the hard cap both bite in a real build', async () => {
  const ctx = makeCtx();
  await ctx.kv.put(D.K.orders, JSON.stringify([{ id: 'o1', text: 'no coatings', never: ['cquartz'], enabled: true }]));
  await ctx.kv.put(D.K.cfg, JSON.stringify(Object.assign(D.defaultConfig(), { maxItems: 2 })));
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, true);
  assert.doesNotMatch(built.html, /CQuartz/i);
  assert.ok(built.diagnostics.some((d) => /standing orders blocked/.test(d)));
  assert.ok(built.doc.itemKeys.length <= 2);
});

test('deals sort by expiry, not by excitement', () => {
  assert.ok(D.deadlineRank('ends today') < D.deadlineRank('ends tomorrow'));
  assert.ok(D.deadlineRank('ends tomorrow') < D.deadlineRank('ends Sunday'));
  assert.ok(D.deadlineRank('ends Sunday') < D.deadlineRank('this month'));
  assert.ok(D.deadlineRank('') > D.deadlineRank('this month'));
});

test('seasonal warnings arrive before the season, not during', () => {
  const seasons = [{ id: 'wildfire', label: 'Wildfire smoke', month: 7, day: 15, leadDays: 21, note: 'Stock pH-neutral wash.', enabled: true }];
  assert.equal(D.seasonalNotices(seasons, '2026-06-01').length, 0, 'too early');
  const warn = D.seasonalNotices(seasons, '2026-07-01');
  assert.equal(warn.length, 1);
  assert.match(warn[0].text, /starts in 14 days/);
  assert.equal(D.seasonalNotices(seasons, '2026-08-20').length, 0, 'the season itself is not news');
});

test('seasonal warnings cross the year boundary', () => {
  const seasons = [{ id: 'pollen', label: 'Pollen', month: 1, day: 5, leadDays: 21, note: 'x', enabled: true }];
  const warn = D.seasonalNotices(seasons, '2025-12-20');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].days, 16);
});

test('behavioral context comes from booked work, not stated preferences', async () => {
  const ctx = makeCtx();
  const terms = await D.behaviorTerms(ctx, D.defaultConfig(), ctx._now);
  assert.ok(terms.includes('full'), terms.join(','));
  assert.ok(terms.includes('interior'));
  assert.ok(terms.includes('pet hair'), 'booking add-ons count');
});

// ===========================================================================
// Delivery & the loop
// ===========================================================================
test('cron sends once at the hour and never twice', async () => {
  const ctx = makeCtx();
  const at7 = Date.parse('2026-08-04T14:00:00Z');   // 07:00 Pacific
  const r1 = await D.digestCron(ctx, at7);
  assert.ok(r1.done.some((d) => /^digest /.test(d)), JSON.stringify(r1));
  assert.equal(ctx._sent.length, 1);

  const r2 = await D.digestCron(ctx, at7 + 60000);
  assert.equal(ctx._sent.length, 1, 'a second tick in the same hour must not re-send');
  assert.ok(!r2.done.some((d) => /^digest /.test(d)));
});

test('cron does nothing at the wrong hour', async () => {
  const ctx = makeCtx();
  const r = await D.digestCron(ctx, Date.parse('2026-08-04T18:00:00Z')); // 11:00 Pacific
  assert.equal(ctx._sent.length, 0);
  assert.equal(r.done.length, 0);
});

test('a failed email still gets the digest to Mikey and records the failure', async () => {
  const ctx = makeCtx({ mailFails: true });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  const res = await D.sendDigest(ctx, built);
  assert.equal(res.delivered, false);
  assert.equal(ctx._notified.length, 1);
  assert.match(ctx._notified[0].body, /digest\.html\?id=/);
  const doc = await ctx.kv.get(D.K.doc(built.id), { type: 'json' });
  assert.equal(doc.delivered, false);
  assert.ok(doc.deliveryError);
});

test('one-tap tokens round-trip, expire, and reject tampering', async () => {
  const ctx = makeCtx();
  const token = await D.signAction(ctx, { d: '2026-08-04', i: 'k1', a: 'buy', t: 'detailing', e: 'CQuartz', x: Date.now() + 10000 });
  const ok = await D.verifyAction(ctx, token);
  assert.equal(ok.a, 'buy');
  assert.equal(ok.e, 'CQuartz');

  assert.equal(await D.verifyAction(ctx, token.split('.')[0] + '.deadbeef'), null);
  const expired = await D.signAction(ctx, { i: 'k1', a: 'buy', x: Date.now() - 1 });
  assert.equal(await D.verifyAction(ctx, expired), null);
});

test('a tap moves the weighting and lands in the log', async () => {
  const ctx = makeCtx();
  await D.recordFeedback(ctx, { digestId: 'd1', itemKey: 'k1', action: 'reject', topicId: 'ow', entity: 'Overwatch patch' });
  const w = await ctx.kv.get(D.K.weights, { type: 'json' });
  assert.ok(w.topics.ow < 1);
  const log = await ctx.kv.get(D.K.feedback, { type: 'json' });
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'reject');
});

test('"remind me Friday" schedules a real reminder the cron delivers', async () => {
  const ctx = makeCtx();
  await D.recordFeedback(ctx, { digestId: 'd1', itemKey: 'k1', action: 'remind', topicId: 'hf', entity: 'Icon impact' });
  const state = await ctx.kv.get(D.K.state, { type: 'json' });
  assert.equal(state.reminders.length, 1);
  assert.equal(new Date(state.reminders[0].on + 'T12:00:00Z').getUTCDay(), 5, 'lands on a Friday');

  // Fast-forward to that Friday morning and let the cron fire it.
  const fri = Date.parse(state.reminders[0].on + 'T16:00:00Z');   // 9am Pacific
  await D.digestCron(ctx, fri);
  assert.ok(ctx._notified.some((n) => /remind/i.test(n.subject)));
  const after = await ctx.kv.get(D.K.state, { type: 'json' });
  assert.equal(after.reminders.length, 0, 'a delivered reminder is cleared');
});

test('plain-English retune moves weights and confirms in words', async () => {
  const ctx = makeCtx();
  const r = await D.retune(ctx, 'less Overwatch, more coatings');
  assert.equal(r.ok, true);
  assert.match(r.reply, /Less Overwatch/i);
  const w = await ctx.kv.get(D.K.weights, { type: 'json' });
  assert.ok(w.topics.ow < 1);
  assert.ok(w.topics.detailing > 1);
});

test('retune works without a model at all', async () => {
  const ctx = makeCtx({ gemini: fakeGemini({ failAll: true }) });
  const r = await D.retune(ctx, 'less overwatch please');
  assert.equal(r.ok, true);
  const w = await ctx.kv.get(D.K.weights, { type: 'json' });
  assert.ok(w.topics.ow < 1);
});

test('a text to the business number becomes a captured note', async () => {
  const ctx = makeCtx();
  const r = await D.digestIngest(ctx, { text: 'Ran out of drying towels again', source: 'sms' });
  assert.equal(r.intent, 'note');
  const cap = await ctx.kv.get(D.K.capture, { type: 'json' });
  assert.equal(cap.length, 1);
  assert.match(cap[0].text, /drying towels/);
});

test('an answer to the question of the day lands in the context doc', async () => {
  const ctx = makeCtx();
  await ctx.kv.put(D.K.state, JSON.stringify({ pendingQuestion: 'What do you charge for a three-row SUV?', pendingQuestionAt: Date.now() }));
  const r = await D.digestIngest(ctx, { text: '$260 for a full interior on a three-row', source: 'sms' });
  assert.equal(r.intent, 'answer');
  const ctxDoc = await D.loadContext(ctx);
  assert.match(ctxDoc.text, /\$260 for a full interior/);
  assert.match(ctxDoc.text, /What do you charge/);
  const state = await ctx.kv.get(D.K.state, { type: 'json' });
  assert.equal(state.pendingQuestion, '', 'the question is answered and cleared');
});

test('an explicit #tune prefix beats the classifier', async () => {
  const ctx = makeCtx();
  const r = await D.digestIngest(ctx, { text: '#tune less Overwatch, more coatings', source: 'sms' });
  assert.equal(r.intent, 'tune');
});

test('captured notes reach the next build and are then folded into context', async () => {
  const ctx = makeCtx();
  await D.digestCapture(ctx, { text: 'Customer asked about matte wrap coating', source: 'sms' });
  const built = await D.buildDigest(ctx, { now: ctx._now });
  const topicPrompt = ctx.gemini.seen.find((s) => /MATERIAL:/.test(s.prompt));
  assert.match(topicPrompt.prompt, /matte wrap coating/, 'the note is in the prompt');

  await D.sendDigest(ctx, built);
  const cap = await ctx.kv.get(D.K.capture, { type: 'json' });
  assert.deepEqual(cap, [], 'inbox emptied so it is not re-read tomorrow');
  const doc = await D.loadContext(ctx);
  assert.match(doc.text, /matte wrap coating/, 'and kept permanently');
});

test('breaking interrupt fires on a real deadline and respects its daily cap', async () => {
  const ctx = makeCtx();
  const at10 = Date.parse('2026-08-04T17:20:00Z');   // 10:20 Pacific
  const r = await D.checkBreaking(ctx, at10);
  assert.ok(r.fired >= 1, JSON.stringify(r));
  assert.ok(ctx._notified.some((n) => /⚡/.test(n.subject)));

  const again = await D.checkBreaking(ctx, at10 + 3600000);
  assert.equal(again.fired, 0);
  assert.match(again.reason, /daily cap|nothing urgent/);
});

test('breaking interrupt stays quiet overnight', async () => {
  const ctx = makeCtx();
  const r = await D.checkBreaking(ctx, Date.parse('2026-08-05T06:20:00Z')); // 23:20 Pacific
  assert.equal(r.fired, 0);
  assert.equal(r.reason, 'quiet hours');
});

test('weekly rollup reports what mattered and what was acted on', async () => {
  const ctx = makeCtx();
  const built = await D.buildDigest(ctx, { now: ctx._now });
  await D.sendDigest(ctx, built);
  await D.recordFeedback(ctx, { digestId: built.id, itemKey: 'k1', action: 'buy', topicId: 'detailing', entity: 'CQuartz UK 3.0' });

  await D.weeklyRollup(ctx, ctx._now);
  const mail = ctx._notified[ctx._notified.length - 1];
  assert.match(mail.subject, /week in the rundown/);
  assert.match(mail.body, /WHAT MATTERED/);
  assert.match(mail.body, /CQuartz UK 3\.0/);
  assert.match(mail.body, /ACTUAL SCOREBOARD/);
});

// ===========================================================================
// HTTP surface
// ===========================================================================
async function call(ctx, method, path, body) {
  const url = new URL('https://x.dev' + path);
  const req = new Request(url, body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res = await digestRoute(req, url, ctx);
  if (!res) return null;
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, text }; }
}

test('the console state endpoint returns everything the UI needs', async () => {
  const ctx = makeCtx();
  const r = await call(ctx, 'GET', '/api/digest/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.cfg.topics.length > 3);
  assert.ok(r.body.context.text.length > 20);
  assert.equal(r.body.hasGemini, true);
  assert.match(r.body.localNow, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('config saves survive a round trip and are clamped', async () => {
  const ctx = makeCtx();
  const r = await call(ctx, 'POST', '/api/digest/config', { hour: 99, maxItems: -4, emojiHeaders: false });
  assert.equal(r.body.cfg.hour, 23);
  assert.equal(r.body.cfg.maxItems, 0);
  assert.equal(r.body.cfg.emojiHeaders, false);
  const again = await call(ctx, 'GET', '/api/digest/state');
  assert.equal(again.body.cfg.hour, 23);
  assert.ok(again.body.cfg.topics.length > 3, 'defaults survive a partial save');
});

test('preview builds without sending; send delivers', async () => {
  const ctx = makeCtx();
  const preview = await call(ctx, 'POST', '/api/digest/run', {});
  assert.equal(preview.body.dry, true);
  assert.ok(preview.body.html.length > 1000);
  assert.equal(ctx._sent.length, 0);

  const sent = await call(ctx, 'POST', '/api/digest/run', { send: true });
  assert.equal(sent.body.delivered, true);
  assert.equal(ctx._sent.length, 1);
});

test('archive search finds an issue by a product mentioned inside it', async () => {
  const ctx = makeCtx();
  const built = await D.buildDigest(ctx, { now: ctx._now });
  await D.sendDigest(ctx, built);

  const hit = await call(ctx, 'GET', '/api/digest/archive?q=cquartz');
  assert.equal(hit.body.total, 1);
  assert.ok(hit.body.results[0].excerpt.length > 10);

  const miss = await call(ctx, 'GET', '/api/digest/archive?q=lawnmower');
  assert.equal(miss.body.total, 0);
});

test('the one-tap route records the tap and answers with a page', async () => {
  const ctx = makeCtx();
  const token = await D.signAction(ctx, { d: 'd1', i: 'k1', a: 'reject', t: 'ow', e: 'Overwatch', x: Date.now() + 10000 });
  const url = new URL('https://x.dev/d/a/' + token);
  const res = await digestRoute(new Request(url), url, ctx);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Won't show you Overwatch again/);
  const w = await ctx.kv.get(D.K.weights, { type: 'json' });
  assert.ok(w.topics.ow < 1);
});

test('a tampered one-tap link is refused without touching anything', async () => {
  const ctx = makeCtx();
  const url = new URL('https://x.dev/d/a/bm90LWEtdG9rZW4.zzzz');
  const res = await digestRoute(new Request(url), url, ctx);
  assert.equal(res.status, 410);
  assert.equal(await ctx.kv.get(D.K.weights), null);
});

test('self-test reports each source separately', async () => {
  const ctx = makeCtx();
  const r = await call(ctx, 'GET', '/api/digest/selftest');
  const names = r.body.checks.map((c) => c.name);
  assert.ok(names.includes('reddit rss (www)'));
  assert.ok(names.includes('open-meteo forecast'));
  assert.ok(names.includes('gemini'));
  assert.equal(r.body.checks.find((c) => c.name === 'gemini').ok, true);
});

test('self-test names the source that is down', async () => {
  const ctx = makeCtx({ fetch: fakeFetch({ reddit: '403', dates: ['2026-08-04'] }) });
  const r = await call(ctx, 'GET', '/api/digest/selftest');
  const rss = r.body.checks.find((c) => c.name === 'reddit rss (www)');
  assert.equal(rss.ok, false);
  assert.equal(rss.code, 403);
  assert.equal(r.body.checks.find((c) => c.name === 'reddit json').ok, true);
});

test('kit and standing orders save through their endpoints', async () => {
  const ctx = makeCtx();
  await call(ctx, 'POST', '/api/digest/kit', { kit: [{ name: 'Griots G15', verdict: 'love it', note: 'daily driver', owned: true }, { name: '' }] });
  const kit = await ctx.kv.get(D.K.kit, { type: 'json' });
  assert.equal(kit.length, 1);

  await call(ctx, 'POST', '/api/digest/orders', { orders: [{ text: 'no compressor tools', never: ['compressor', 'air line'] }] });
  const orders = await ctx.kv.get(D.K.orders, { type: 'json' });
  assert.equal(orders[0].never.length, 2);
  assert.ok(orders[0].id);
});

test('reset clears one memory without touching the others', async () => {
  const ctx = makeCtx();
  await ctx.kv.put(D.K.seen, JSON.stringify(['a']));
  await ctx.kv.put(D.K.ledger, JSON.stringify({ x: 1 }));
  await call(ctx, 'POST', '/api/digest/reset', { what: 'seen' });
  assert.equal(await ctx.kv.get(D.K.seen), null);
  assert.ok(await ctx.kv.get(D.K.ledger));
});

test('an unknown digest route 404s instead of falling through', async () => {
  const ctx = makeCtx();
  const r = await call(ctx, 'GET', '/api/digest/nope');
  assert.equal(r.status, 404);
});

test('non-digest paths are left alone for the main router', async () => {
  const ctx = makeCtx();
  const url = new URL('https://x.dev/api/threads');
  assert.equal(await digestRoute(new Request(url), url, ctx), null);
});

test('a topic set to zero items keeps its place but sends nothing', async () => {
  const ctx = makeCtx();
  const cfg = D.defaultConfig();
  cfg.topics = cfg.topics.map((t) => (t.id === 'detailing' ? Object.assign({}, t, { max: 0 }) : t));
  await ctx.kv.put(D.K.cfg, JSON.stringify(cfg));
  const built = await D.buildDigest(ctx, { now: ctx._now });
  assert.equal(built.ok, true);
  assert.equal((built.doc.briefs || []).some((g) => g.id === 'detailing'), false);
  assert.doesNotMatch(built.html.replace(/^<div style="display:none[\s\S]*?<\/div>/, ''), /CQuartz UK 3\.0 dropped/);
});

test('a subject reported recently is deprioritised before it costs a model call', async () => {
  const ctx = makeCtx();
  const ledger = {};
  ledger[V.slugify(F.POSTS.AutoDetailing[0].title) + '|m79'] = { firstOn: ctx._today, lastOn: ctx._today, count: 1 };
  await ctx.kv.put(D.K.ledger, JSON.stringify(ledger));
  const built = await D.buildDigest(ctx, { now: ctx._now, dryRun: true, actionUrl: false });
  assert.equal(built.ok, true);
  const detailing = built.doc.itemKeys;
  const heroIsRepeat = built.doc.hero && built.doc.hero.key === 't3_aa1';
  assert.equal(heroIsRepeat, false, 'a just-reported subject should not lead');
  assert.ok(detailing.length > 0);
});
