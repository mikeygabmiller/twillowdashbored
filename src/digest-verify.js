/**
 * MORNING DIGEST — judgment & truth layer.
 *
 * Everything in this file is a pure function: no network, no KV, no clock of
 * its own. That is deliberate — these are the rules that decide whether a claim
 * is allowed to reach the inbox, so they have to be testable in isolation
 * (see test/digest.test.mjs, which runs the whole set offline).
 *
 * The through-line: a language model is a good writer and an unreliable
 * witness. Every number and every quote it produces is checked back against the
 * source text it was given, and anything that cannot be found there is removed
 * before rendering rather than being flagged after the fact.
 */

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------
export function normText(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(s) {
  return normText(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Sentence split that keeps the terminator, so a rebuilt paragraph still reads right. */
export function sentences(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const out = t.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) || [t];
  return out.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Verbatim number guard
// ---------------------------------------------------------------------------
// Only the classes of number that a reader would act on are policed: money,
// percentages, measurements with a unit, and model/part numbers. Plain counts
// ("three of the five commenters agreed") are prose, not claims, and checking
// them produced nothing but false strips.

const UNITS = 'oz|ml|l|g|kg|lb|lbs|mm|cm|m|in|inch|inches|ft|yd|gsm|w|kw|v|ah|mah|nm|rpm|psi|gal|qt|pt|micron|um|k|mil|year|years|yr|month|months|day|days|hour|hours|hr|min|minute|minutes|pack|ct|count|piece|pc|grit';

/** Money / percent / measurement / model tokens, each with a normalized form. */
export function claimTokens(text) {
  const s = String(text || '');
  const out = [];
  const push = (kind, raw, norm) => { if (norm) out.push({ kind, raw, norm }); };

  // $1,299.00  ·  $79  ·  79 dollars  ·  USD 40
  const money = /(?:\$\s?([\d,]+(?:\.\d+)?))|(?:\b([\d,]+(?:\.\d+)?)\s?(?:dollars|usd)\b)/gi;
  for (let m; (m = money.exec(s));) push('money', m[0].trim(), numNorm(m[1] || m[2]));

  // 40%  ·  12.5 %
  const pct = /\b([\d,]+(?:\.\d+)?)\s?%/g;
  for (let m; (m = pct.exec(s));) push('percent', m[0].trim(), numNorm(m[1]));

  // 16oz  ·  3 year  ·  1500 grit
  const meas = new RegExp(String.raw`\b([\d,]+(?:\.\d+)?)\s?-?\s?(${UNITS})\b`, 'gi');
  for (let m; (m = meas.exec(s));) push('measure', m[0].trim(), numNorm(m[1]) + ' ' + unitNorm(m[2]));

  // M12 · GT-500 · CS-2 · 2.5 Flash · v14.2 — a token mixing letters and digits.
  const model = /\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/gi;
  for (let m; (m = model.exec(s));) {
    const raw = m[0];
    if (/^\d+(st|nd|rd|th)$/i.test(raw)) continue;          // 1st, 2nd — ordinals, not models
    if (raw.length < 2 || raw.length > 24) continue;
    push('model', raw, raw.toLowerCase().replace(/-/g, ''));
  }
  return out;
}

function numNorm(v) {
  if (v == null) return '';
  let n = String(v).replace(/,/g, '');
  if (n.indexOf('.') >= 0) n = n.replace(/0+$/, '').replace(/\.$/, '');
  return n;
}
function unitNorm(u) {
  const x = String(u).toLowerCase();
  const map = { inch: 'in', inches: 'in', lbs: 'lb', years: 'year', yr: 'year', months: 'month',
    days: 'day', hours: 'hour', hr: 'hour', minutes: 'min', minute: 'min', um: 'micron',
    count: 'ct', piece: 'pc', l: 'l' };
  return map[x] || x;
}

/** Everything the source *does* say, in the same normalized shapes. */
export function sourceClaimIndex(sourceText) {
  const toks = claimTokens(sourceText);
  const idx = { money: new Set(), percent: new Set(), measure: new Set(), model: new Set(), bare: new Set() };
  for (const t of toks) idx[t.kind].add(t.norm);
  // Bare numeric values, so "$79" in the write-up still verifies against a
  // source that wrote "79 bucks" or "79.00".
  const bare = /\b[\d,]+(?:\.\d+)?\b/g;
  const s = String(sourceText || '');
  for (let m; (m = bare.exec(s));) idx.bare.add(numNorm(m[0]));
  return idx;
}

function tokenSupported(tok, idx) {
  if (tok.kind === 'model') return idx.model.has(tok.norm);
  if (tok.kind === 'measure') {
    if (idx.measure.has(tok.norm)) return true;
    return idx.bare.has(tok.norm.split(' ')[0]);   // number present, unit paraphrased
  }
  if (idx[tok.kind] && idx[tok.kind].has(tok.norm)) return true;
  return idx.bare.has(tok.norm);
}

/**
 * Strip every sentence carrying a number the source never stated.
 * Returns the surviving text plus what was removed, so the run is auditable.
 */
export function verbatimGuard(text, sourceText) {
  const idx = sourceClaimIndex(sourceText);
  const kept = [];
  const stripped = [];
  for (const sent of sentences(text)) {
    const bad = claimTokens(sent).filter((t) => !tokenSupported(t, idx));
    if (bad.length) stripped.push({ sentence: sent, tokens: bad.map((b) => b.raw) });
    else kept.push(sent);
  }
  const out = kept.join(' ').replace(/\s+/g, ' ').trim();
  const total = kept.length + stripped.length;
  return {
    text: out,
    stripped,
    // A write-up that lost most of itself was mostly invention. Drop it whole
    // rather than shipping the surviving half, which reads like a non-sequitur.
    ok: !!out && out.length >= 80 && (total === 0 || kept.length / total >= 0.5),
  };
}

// ---------------------------------------------------------------------------
// Quote-backed claims
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'that', 'this', 'with', 'as', 'at', 'be', 'was', 'are']);

function words(s) {
  return normText(s).toLowerCase().replace(/[^a-z0-9$%.\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Does this quote actually occur in the material? Exact substring first; then an
 * in-order subsequence match, which survives the "…" a model puts in the middle
 * of a long quote without letting it stitch together words that were never
 * adjacent to each other's meaning.
 */
export function quoteCheck(quote, sourceText, minWords = 5) {
  const q = normText(quote).toLowerCase();
  const src = normText(sourceText).toLowerCase();
  if (!q || q.length < 15) return { ok: false, reason: 'too_short', score: 0 };
  if (src.includes(q)) return { ok: true, reason: 'exact', score: 1 };

  const qw = words(q).filter((w) => !STOPWORDS.has(w));
  if (qw.length < minWords) return { ok: false, reason: 'too_short', score: 0 };
  const sw = words(src);
  let i = 0, hits = 0;
  for (const w of qw) {
    const at = sw.indexOf(w, i);
    if (at >= 0) { hits++; i = at + 1; }
  }
  const score = hits / qw.length;
  return { ok: score >= 0.85, reason: score >= 0.85 ? 'subsequence' : 'not_found', score: Math.round(score * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Source diversity quota
// ---------------------------------------------------------------------------
/** No single source may own the digest. Keeps input order otherwise. */
export function diversityQuota(items, max = 2, keyFn = (x) => x.source || '') {
  const seen = {};
  const kept = [], cut = [];
  for (const it of items || []) {
    const k = keyFn(it) || '';
    seen[k] = (seen[k] || 0) + 1;
    if (max > 0 && seen[k] > max) cut.push(it); else kept.push(it);
  }
  return { items: kept, cut };
}

// ---------------------------------------------------------------------------
// Don't-tell-me-again ledger  +  entity / price memory
// ---------------------------------------------------------------------------
/**
 * A claim's identity: what it is about, plus the numbers attached to it. Same
 * subject + same numbers = the same thing it already said. Same subject with
 * different numbers = news, and specifically the kind worth leading with.
 */
export function claimFingerprint(item) {
  const subject = slugify(item.entity || item.title || item.point || '');
  const nums = claimTokens((item.point || '') + ' ' + (item.title || ''))
    .filter((t) => t.kind === 'money' || t.kind === 'percent')
    .map((t) => t.kind[0] + t.norm)
    .sort();
  return subject + '|' + nums.join(',');
}

export function subjectKey(item) {
  return slugify(item.entity || item.title || '');
}

/**
 * Split candidates against what has already been reported.
 *   fresh    — never mentioned
 *   changed  — same subject, different numbers (carries `wasNumbers`)
 *   repeat   — identical claim, already told; suppressed
 */
export function applyLedger(items, ledger, opts = {}) {
  const cooloffDays = opts.cooloffDays == null ? 21 : opts.cooloffDays;
  const today = opts.today || '1970-01-01';
  const out = { fresh: [], changed: [], repeat: [] };
  for (const it of items || []) {
    const fp = claimFingerprint(it);
    const subj = subjectKey(it);
    const exact = ledger[fp];
    if (exact && daysBetween(exact.lastOn, today) < cooloffDays) {
      out.repeat.push(Object.assign({}, it, { ledgerKey: fp, toldOn: exact.lastOn, toldCount: exact.count || 1 }));
      continue;
    }
    const prior = Object.keys(ledger).find((k) => k.split('|')[0] === subj && k !== fp);
    if (prior) {
      out.changed.push(Object.assign({}, it, {
        ledgerKey: fp,
        priorKey: prior,
        wasNumbers: (prior.split('|')[1] || '').split(',').filter(Boolean),
        priorOn: ledger[prior].lastOn,
      }));
      continue;
    }
    out.fresh.push(Object.assign({}, it, { ledgerKey: fp }));
  }
  return out;
}

export function recordLedger(ledger, items, today, limit = 600) {
  for (const it of items || []) {
    const fp = it.ledgerKey || claimFingerprint(it);
    const prev = ledger[fp];
    ledger[fp] = {
      firstOn: (prev && prev.firstOn) || today,
      lastOn: today,
      count: ((prev && prev.count) || 0) + 1,
      gist: normText(it.title || it.entity || '').slice(0, 120),
    };
  }
  // Oldest-first eviction keeps the doc inside KV's per-value ceiling.
  const keys = Object.keys(ledger);
  if (keys.length > limit) {
    keys.sort((a, b) => String(ledger[a].lastOn).localeCompare(String(ledger[b].lastOn)));
    for (const k of keys.slice(0, keys.length - limit)) delete ledger[k];
  }
  return ledger;
}

export function daysBetween(a, b) {
  const t1 = Date.parse(String(a) + 'T00:00:00Z'), t2 = Date.parse(String(b) + 'T00:00:00Z');
  if (!isFinite(t1) || !isFinite(t2)) return 9999;
  return Math.round((t2 - t1) / 86400000);
}

export function addDays(dateStr, n) {
  const t = Date.parse(String(dateStr) + 'T00:00:00Z');
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Entity memory. Gives two things the backlog asks for by name: story
 * continuity ("Day 3 of the CQuartz price drop") and price history, which is
 * what lets the digest say "$79, but it hit $69 in March — not the floor".
 */
export function updateEntities(entities, items, today, opts = {}) {
  const keepPrices = opts.keepPrices == null ? 12 : opts.keepPrices;
  for (const it of items || []) {
    const key = subjectKey(it);
    if (!key) continue;
    const e = entities[key] || { label: normText(it.entity || it.title).slice(0, 90), firstOn: today, days: 0, run: 0, prices: [] };
    const gap = daysBetween(e.lastOn || today, today);
    if (e.lastOn !== today) {
      e.days = (e.days || 0) + 1;
      e.run = gap <= 1 ? (e.run || 0) + 1 : 1;   // consecutive-day streak
      e.lastOn = today;
    }
    if (!e.lastOn) e.lastOn = today;
    const price = lowestMoney(it.point + ' ' + (it.title || ''));
    if (price != null) {
      const last = e.prices[e.prices.length - 1];
      if (!last || last.v !== price || last.on !== today) e.prices.push({ on: today, v: price });
      if (e.prices.length > keepPrices) e.prices = e.prices.slice(-keepPrices);
    }
    entities[key] = e;
  }
  return entities;
}

export function lowestMoney(text) {
  const vals = claimTokens(text).filter((t) => t.kind === 'money').map((t) => parseFloat(t.norm)).filter((n) => isFinite(n) && n > 0);
  return vals.length ? Math.min.apply(null, vals) : null;
}

/**
 * Price-history verification. Returns a short, honest line or null — never a
 * "buy now", because the whole point is that most prices are not the floor.
 */
export function priceVerdict(entity, currentValue, today) {
  if (!entity || currentValue == null) return null;
  const hist = (entity.prices || []).filter((p) => p.on !== today && isFinite(p.v));
  if (!hist.length) return { kind: 'first', text: 'First price we have on record — no history to compare against yet.' };
  let low = hist[0];
  for (const p of hist) if (p.v < low.v) low = p;
  const prev = hist[hist.length - 1];
  const when = monthLabel(low.on);
  if (currentValue <= low.v) {
    return { kind: 'floor', low: low.v, text: `Lowest we've seen — previous best was $${fmtMoney(low.v)} in ${when}.` };
  }
  const delta = Math.round((currentValue - low.v) * 100) / 100;
  const dir = prev && prev.v !== currentValue
    ? ` Last seen at $${fmtMoney(prev.v)} on ${prev.on}.` : '';
  return {
    kind: 'above_floor', low: low.v, delta,
    text: `$${fmtMoney(currentValue)}, but it hit $${fmtMoney(low.v)} in ${when} — $${fmtMoney(delta)} off the floor, so this isn't the bottom.${dir}`,
  };
}

export function fmtMoney(n) {
  const v = Math.round(Number(n) * 100) / 100;
  const s = v % 1 === 0 ? String(v) : v.toFixed(2);
  const [int, frac] = s.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}

function monthLabel(dateStr) {
  const t = Date.parse(String(dateStr) + 'T12:00:00Z');
  if (!isFinite(t)) return String(dateStr);
  return new Date(t).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** "Day 3 of…" — only once a thing has actually run more than a day. */
export function storyLabel(entity) {
  if (!entity || !(entity.run > 1)) return '';
  return `Day ${entity.run}`;
}

// ---------------------------------------------------------------------------
// Absence detection
// ---------------------------------------------------------------------------
/**
 * Flags what did NOT happen. A signal is a thing that normally shows up on a
 * rhythm (the Harbor Freight coupon drop, a patch on Tuesdays). Once there's
 * enough history to know the rhythm, a missed beat is itself the news.
 */
export function detectAbsence(signals, tracker, hitIds, today) {
  const flags = [];
  const hits = new Set(hitIds || []);
  for (const sig of signals || []) {
    if (!sig || !sig.id || sig.enabled === false) continue;
    const t = tracker[sig.id] || { hits: [] };
    if (hits.has(sig.id)) {
      if (t.hits[t.hits.length - 1] !== today) t.hits.push(today);
      if (t.hits.length > 40) t.hits = t.hits.slice(-40);
      t.lastOn = today;
      t.flaggedOn = '';                       // it came back; the streak resets
      tracker[sig.id] = t;
      continue;
    }
    tracker[sig.id] = t;
    if ((t.hits || []).length < 3 || !t.lastOn) continue;   // not enough rhythm to judge
    const cadence = sig.cadenceDays || medianGap(t.hits) || 7;
    const silent = daysBetween(t.lastOn, today);
    if (silent <= Math.max(cadence * 1.6, cadence + 2)) continue;
    if (t.flaggedOn && daysBetween(t.flaggedOn, today) < Math.max(3, Math.round(cadence))) continue;
    t.flaggedOn = today;
    flags.push({
      id: sig.id,
      label: sig.label || sig.id,
      silentDays: silent,
      cadenceDays: Math.round(cadence),
      streak: t.hits.length,
      text: `${sig.label || sig.id}: nothing for ${silent} days (usually every ~${Math.round(cadence)}). ` +
            `First break in ${humanSpan(silent)} after ${t.hits.length} straight.`,
    });
  }
  return { flags, tracker };
}

function medianGap(dates) {
  const ds = (dates || []).slice().sort();
  const gaps = [];
  for (let i = 1; i < ds.length; i++) gaps.push(daysBetween(ds[i - 1], ds[i]));
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function humanSpan(days) {
  if (days < 7) return `${days} days`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Feedback weights (with decay)
// ---------------------------------------------------------------------------
// A thumbs-down should bend tomorrow hard and next month barely at all, so every
// weight walks back toward 1.0 on a half-life. Without the decay a single angry
// tap in July silently censors a topic forever.
export const WEIGHT_MIN = 0.2;
export const WEIGHT_MAX = 3;

export function decayWeights(weights, elapsedDays, halfLifeDays = 14) {
  if (!(elapsedDays > 0)) return weights;
  const k = Math.pow(0.5, elapsedDays / (halfLifeDays || 14));
  for (const bag of ['topics', 'terms']) {
    const m = weights[bag] || {};
    for (const key of Object.keys(m)) {
      const w = 1 + (m[key] - 1) * k;
      if (Math.abs(w - 1) < 0.02) delete m[key]; else m[key] = round2(w);
    }
    weights[bag] = m;
  }
  return weights;
}

export function bumpWeight(weights, bag, key, delta) {
  if (!key) return weights;
  const m = weights[bag] = weights[bag] || {};
  const next = clamp((m[key] == null ? 1 : m[key]) + delta, WEIGHT_MIN, WEIGHT_MAX);
  m[key] = round2(next);
  return weights;
}

export function weightFor(weights, bag, key) {
  const m = (weights && weights[bag]) || {};
  return m[key] == null ? 1 : m[key];
}

/**
 * Ranking score for one candidate. Position in the source feed is the base;
 * everything after that is Mikey-specific — his weights, his kit, the services
 * he actually books, and a penalty for anything he's already been told.
 */
export function scoreCandidate(cand, ctx) {
  const w = ctx.weights || {};
  let score = 100 - (cand.rank || 0) * 4;
  score *= weightFor(w, 'topics', cand.topicId);
  const hay = (cand.title + ' ' + (cand.body || '')).toLowerCase();
  for (const term of Object.keys((w.terms) || {})) {
    if (hay.includes(term)) score *= weightFor(w, 'terms', term);
  }
  for (const kit of ctx.kitTerms || []) if (kit && hay.includes(kit)) score += 18;      // matches gear he owns
  for (const b of ctx.behaviorTerms || []) if (b && hay.includes(b)) score += 12;       // matches work he books
  if (cand.comments && cand.comments.length) score += 6;                                // a verdict exists
  if (cand.repeat) score -= 60;
  return Math.round(score * 100) / 100;
}

/**
 * Standing orders as hard filters. Each order can carry a `never` phrase list;
 * anything matching is dropped before it ever reaches the model, which is the
 * only way "never show me anything needing a compressor" stays true on a day
 * when the model is feeling agreeable.
 */
export function applyStandingOrders(cands, orders) {
  const active = (orders || []).filter((o) => o && o.enabled !== false && Array.isArray(o.never) && o.never.length);
  if (!active.length) return { items: cands, blocked: [] };
  const items = [], blocked = [];
  for (const c of cands) {
    const hay = (c.title + ' ' + (c.body || '') + ' ' + (c.comments || []).join(' ')).toLowerCase();
    const hit = active.find((o) => o.never.some((p) => p && hay.includes(String(p).toLowerCase())));
    if (hit) blocked.push({ title: c.title, order: hit.text || hit.id });
    else items.push(c);
  }
  return { items, blocked };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(n) { return Math.round(n * 100) / 100; }
