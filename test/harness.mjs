/**
 * A whole Worker's worth of fakes: KV, fetch, Gemini, email, and the handful of
 * business-data functions the digest borrows from src/index.js.
 *
 * This exists so the digest can be run end to end — sources → verification →
 * ranking → editorial cut → render → send → persist — without a network, a
 * model, or a deploy. Every assertion in digest.test.mjs runs against the real
 * pipeline code, not a mock of it.
 */

import * as F from './fixtures.mjs';
import { localParts } from '../src/digest.js';

export function fakeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(key, opts) {
      const v = m.get(key);
      if (v === undefined) return null;
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val) { m.set(key, String(val)); },
    async delete(key) { m.delete(key); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function res(status, body) {
  return { status, ok: status === 200, async text() { return body; }, async json() { return JSON.parse(body); } };
}

/**
 * `plan` lets a test break one source on purpose: {reddit:'403'} makes the RSS
 * tiers fail so the JSON fallback has to carry the run.
 */
export function fakeFetch(plan = {}) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      const u = String(url);
      calls.push(u);

      if (/reddit\.com/.test(u)) {
        const cm = u.match(/comments\/(\w+)\//);
        if (cm) {
          const key = 't3_' + cm[1];
          const post = Object.values(F.POSTS).flat().find((p) => p.id === key);
          const comments = F.COMMENTS[key] || [];
          if (!post) return res(404, 'not found');
          return res(200, F.atomFeed([{ id: post.id, title: post.title, url: post.url, body: post.body }]
            .concat(comments.map((c, i) => ({ id: post.id + '_c' + i, title: 'comment', url: post.url, body: c })))));
        }
        const sm = u.match(/\/r\/([^/]+)\//);
        const sub = sm ? sm[1] : '';
        const isJson = /top\.json/.test(u);
        if (plan.reddit === '403' && !isJson) return res(403, 'Blocked');
        if (plan.reddit === 'dead') return res(503, 'nope');
        const posts = F.POSTS[sub];
        if (!posts) return res(200, isJson ? JSON.stringify({ data: { children: [] } }) : F.atomFeed([]));
        if (isJson) {
          return res(200, JSON.stringify({ data: { children: posts.map((p) => ({ data: {
            id: p.id.replace('t3_', ''), title: p.title, permalink: p.url.replace('https://www.reddit.com', ''),
            selftext: p.body, author: 'someone', created_utc: 1785000000, score: 120, num_comments: 40 } })) } }));
        }
        return res(200, F.atomFeed(posts));
      }

      if (/news\.google\.com/.test(u)) {
        if (plan.news === 'dead') return res(500, 'err');
        return res(200, F.rss2Feed(F.NEWS));
      }
      if (/air-quality-api/.test(u)) return res(200, F.airJson(plan.dates || []));
      if (/api\.open-meteo\.com/.test(u)) {
        if (plan.weather === 'dead') return res(500, 'err');
        return res(200, F.weatherJson(plan.dates || []));
      }
      if (/googleapis\.com/.test(u)) return res(403, 'not connected');
      return res(404, 'unmapped ' + u);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Gemini
// ---------------------------------------------------------------------------
// Answers by prompt shape, exactly as the real one would. The topic summaries
// deliberately include one invented price ("$44") and one fabricated quote so
// the verbatim guard and quote check have something real to catch.
export function fakeGemini(opts = {}) {
  const seen = [];
  const fn = async (prompt, o = {}) => {
    seen.push({ prompt, o });
    if (opts.failAll) throw new Error('gemini down');

    if (/MATERIAL:/.test(prompt)) {
      if (opts.failTopics) throw new Error('topic call failed');
      const refs = [...prompt.matchAll(/\n\[(\d+)\] \(([^)]+)\) (.+)/g)].map((m) => ({ n: +m[1], sub: m[2], title: m[3] }));
      const items = refs.slice(0, 3).map((r, i) => {
        const material = prompt.split(`[${r.n}] (`)[1] || '';
        const quote = pickSentence(material);
        const base = {
          ref: r.n,
          headline: r.title.slice(0, 70),
          point: buildPoint(r, material, i),
          quote: i === 2 ? 'This sentence was never in any of the source material at all.' : quote,
          entity: entityFor(r.title),
          deadline: /coupon|ends Sunday|through Sunday/i.test(material) ? 'ends Sunday' : '',
          stakes: /\$149/.test(material) ? 'saves $50' : '',
          contested: i === 1 ? { claim: 'Rinseless is fine on a lightly soiled car.', counter: 'On a work truck it is a scratch machine.' } : { claim: '', counter: '' },
        };
        return base;
      });
      return JSON.stringify({ roundup: 'Steady week, one real deal.', items });
    }

    if (/ONLY job is to delete/.test(prompt)) {
      if (opts.failEditor) throw new Error('editor failed');
      const keys = [...prompt.matchAll(/^KEY (.+)$/gm)].map((m) => m[1].trim());
      const titles = [...prompt.matchAll(/^TITLE (.+)$/gm)].map((m) => m[1].trim());
      const keep = opts.cutAll ? [] : keys.slice(0, opts.keepN || keys.length);
      return JSON.stringify({
        keep,
        cut: keys.slice(keep.length).map((k) => ({ key: k, why: 'no decision behind it' })),
        heroKey: keep[0] || '',
        // Derived from what actually survived, so a test that blocks a product
        // doesn't get it smuggled back in through a hard-coded headline.
        headline: keep.length ? titles[0] + ' — worth the tap today.' : 'Nothing from the internet today.',
        subhead: 'One coupon worth acting on, one tool verdict, and rain over your afternoon job.',
      });
    }

    if (/Ask him ONE question/.test(prompt)) {
      return JSON.stringify({ question: 'What do you charge for a full interior on a three-row SUV right now?' });
    }

    if (/Rewrite this morning briefing/.test(prompt)) {
      return 'Good morning. Here is the short version, spoken. ' + prompt.split('\n\n').slice(-1)[0].slice(0, 600);
    }

    if (/Classify this message/.test(prompt)) {
      const msg = prompt.split('MESSAGE: ')[1] || '';
      if (/less |more |stop showing/i.test(msg)) return JSON.stringify({ intent: 'tune' });
      if (/\$|charge|price/i.test(msg)) return JSON.stringify({ intent: 'answer' });
      return JSON.stringify({ intent: 'note' });
    }

    if (/Turn his words into|adjustments/.test(prompt)) {
      return JSON.stringify({
        topics: [{ id: 'ow', delta: -0.4 }, { id: 'detailing', delta: 0.4 }],
        terms: [], order: '', never: [], reply: 'Less Overwatch, more detailing.',
      });
    }

    if (/single word: ready/.test(prompt)) return 'ready';
    return '{}';
  };
  fn.seen = seen;
  return fn;
}

function buildPoint(r, material, i) {
  if (/CQuartz/.test(r.title)) {
    return 'CarPro CQuartz UK 3.0 is down to $79 for the 50ml kit from $109, and the code runs through Sunday. ' +
      'The thread agrees the coating is still beading at 18 months in PNW weather, which is the durability claim that matters here. ' +
      'One commenter points out the kit only covers about two mid-size cars if prep is tight, so do not plan on stretching it over three. ' +
      'The same commenter bought at $79 last spring and watched it fall to $69 in March, so this is a good price rather than the best one. ' +
      'If you are coating a customer car this month it is worth it; if you are stocking up, it has been cheaper.';
  }
  if (/Icon/.test(r.title)) {
    return 'The Icon 1/2 in impact is 25% off with the September coupon, which puts it at $149. ' +
      'It is rated at 1000 ft-lb of nut-busting torque, and the thread confirms that is plenty for lug nuts. ' +
      'The caveat from someone who owns one: it stalls on rusted suspension bolts, so this is not a substitute for a bigger gun on real rust. ' +
      'The coupon is in the September flyer and does stack with member pricing. ' +
      'Ends Sunday, and it retails at $44 the rest of the year which nobody in the thread mentioned.';
  }
  return `${r.title}. ` + String(material).replace(/\s+/g, ' ').slice(120, 520) +
    ' The thread settles on a clear enough verdict to act on, and the disagreement in the comments is about condition rather than product.';
}

function pickSentence(material) {
  const m = String(material).match(/post: ([^\n]+)/);
  if (!m) return '';
  const first = m[1].match(/[^.!?]+[.!?]/);
  return (first ? first[0] : m[1]).trim();
}

function entityFor(title) {
  if (/CQuartz/i.test(title)) return 'CarPro CQuartz UK 3.0';
  if (/Icon/i.test(title)) return 'Icon 1/2 in impact';
  if (/BOSS|Griots/i.test(title)) return 'Griots BOSS G15';
  if (/Bauer/i.test(title)) return 'Bauer 20V vacuum';
  return title.slice(0, 60);
}

// ---------------------------------------------------------------------------
// The context object src/index.js would hand the digest
// ---------------------------------------------------------------------------
export function makeCtx(overrides = {}) {
  const kv = overrides.kv || fakeKV();
  const now = overrides.now || Date.parse('2026-08-04T14:05:00Z');
  const tz = 'America/Los_Angeles';
  const today = localParts(now, tz).date;
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const ff = overrides.fetch || fakeFetch({ dates: [today, tomorrow, addDay(tomorrow)] });

  const sent = [];
  const notified = [];

  const ctx = {
    env: Object.assign({ ALERT_EMAIL: 'mikey@example.com', RESEND_API_KEY: 're_x', GEMINI_API_KEY: 'g_x' }, overrides.env || {}),
    kv,
    fetchImpl: ff.fn,
    _fetch: ff,
    _sent: sent,
    _notified: notified,
    sleep: async () => {},                       // tests never wait on backoff
    gemini: overrides.gemini || fakeGemini(),
    notify: async (subject, body) => { notified.push({ subject, body }); return true; },
    sendMail: async (m) => {
      if (overrides.mailFails) throw new Error('resend 422');
      sent.push(m); return { id: 'e1' };
    },
    googleToken: overrides.googleToken || null,
    publicBase: () => 'https://texting.example.workers.dev',
    json: (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }),
    readJson: async (req) => { try { return await req.json(); } catch { return {}; } },

    // --- business data, same shapes src/index.js produces ---
    loadConfig: async () => ({ playbook: { services: '- Interior Detail — starts at $160\n- Exterior Detail — starts at $130', area: 'Snohomish + Monroe' } }),
    loadIndex: async () => overrides.index || [
      { phone: '+13605551111', name: 'Dana', status: 'new', lastDir: 'in', lastTs: now - 26 * 3600000, archived: false, followupDue: true },
      { phone: '+13605552222', name: 'Ray', status: 'won', statusAt: now - 5 * 86400000, lastDir: 'out', lastTs: now - 2 * 86400000, archived: false },
      { phone: '+13605553333', name: 'Old', status: 'won', statusAt: now - 45 * 86400000, lastDir: 'out', lastTs: now - 40 * 86400000, archived: false },
    ],
    loadThread: async (phone) => ({ phone, messages: [] }),
    loadBookings: async () => overrides.bookings || [
      { id: 'b1', status: 'confirmed', date: tomorrow, slot: '14:00', durationMin: 180, service: 'full', serviceLabel: 'Full Detail', name: 'Dana', city: 'Monroe', addons: ['pet hair'] },
      { id: 'b2', status: 'pending', date: tomorrow, slot: '09:00', durationMin: 120, service: 'interior', serviceLabel: 'Interior Detail', name: 'Ray', city: 'Everett', addons: [] },
    ],
    loadMonth: async (m) => ({ entries: (overrides.money || defaultMoney(today))[m] || [] }),
    summarizeMonth,
    summarizeWeek,
    weekWindow,
    prevMonthKey,
  };
  ctx._now = now;
  ctx._today = today;
  ctx._tomorrow = tomorrow;
  return ctx;
}

function addDay(d) { return new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10); }

function defaultMoney(today) {
  const m = today.slice(0, 7);
  return {
    [m]: [
      { id: '1', date: today, ts: 1, type: 'job', amount: 260, service: 'full', jp: 60, method: 'cash', vehicle: 'suv' },
      { id: '2', date: today, ts: 2, type: 'exp', amount: 42.5, cat: 'supplies' },
      { id: '3', date: addDay(today), ts: 3, type: 'job', amount: 180, service: 'interior', owed: 60 },
    ],
  };
}

// --- copies of the money helpers in src/index.js (same math, same rounding) ---
function money2(n) { return Math.round(Number(n) * 100) / 100; }

export function summarizeMonth(entries) {
  const s = { gross: 0, jp: 0, exp: 0, personal: 0, net: 0, jobs: 0, owed: 0, byCat: {}, byService: {}, byMethod: {} };
  for (const e of (entries || [])) {
    if (e.type === 'job') {
      s.gross += e.amount; s.jobs++;
      if (e.owed) s.owed += e.owed;
      if (e.jp) s.jp += e.jp;
    } else if (e.type === 'jp') s.jp += e.amount;
    else if (e.type === 'personal') s.personal += e.amount;
    else { s.exp += e.amount; s.byCat[e.cat || 'misc'] = money2((s.byCat[e.cat || 'misc'] || 0) + e.amount); }
  }
  for (const k of ['gross', 'jp', 'exp', 'personal', 'owed']) s[k] = money2(s[k]);
  s.net = money2(s.gross - s.jp - s.exp);
  return s;
}

export function summarizeWeek(entries, start, end) {
  const s = { exp: 0, personal: 0, jp: 0, gross: 0, jobs: 0, byCat: {}, byService: {} };
  for (const e of (entries || [])) {
    if (!e.date || e.date < start || e.date > end) continue;
    if (e.type === 'jp') s.jp += e.amount;
    else if (e.type === 'personal') s.personal += e.amount;
    else if (e.type === 'exp') s.exp += e.amount;
    else if (e.type === 'job') { s.gross += e.amount; s.jobs++; if (e.jp) s.jp += e.jp; }
  }
  for (const k of ['exp', 'personal', 'jp', 'gross']) s[k] = money2(s[k]);
  s.net = money2(s.gross - s.jp - s.exp);
  return s;
}

export function weekWindow(todayStr) {
  const d = new Date(todayStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function prevMonthKey(m) {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}
