/**
 * MORNING DIGEST — where the material comes from.
 *
 * Ported off Apps Script, so two things had to change. XmlService doesn't exist
 * in Workers (and there's no DOMParser), so feeds are parsed with regex — fine
 * for RSS/Atom, which is a flat, predictable shape. And UrlFetchApp.fetchAll is
 * replaced by Promise.all over the standard fetch, which is what makes ~15 feeds
 * cost one round trip instead of fifteen.
 *
 * Every fetcher here returns data plus a diagnostic line. When a feed goes quiet
 * you want to know whether it was empty or refused, and you want to know it from
 * the digest console rather than by guessing.
 */

export const UA = 'MorningDigest/3.0 (Cloudflare Worker; personal use)';

const RETRYABLE = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Parallel fetch with backoff
// ---------------------------------------------------------------------------
/**
 * Runs every request concurrently and retries only the ones worth retrying.
 * `fetchImpl` is injectable so the whole pipeline can run offline in tests.
 */
export async function fetchBatch(requests, opts = {}) {
  const f = opts.fetchImpl || fetch;
  const attempts = opts.attempts == null ? 3 : opts.attempts;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const results = new Array(requests.length);
  let pending = requests.map((_, i) => i);
  let wait = opts.baseDelayMs == null ? 800 : opts.baseDelayMs;

  for (let attempt = 0; attempt < attempts && pending.length; attempt++) {
    if (attempt > 0) { await sleep(wait); wait *= 3; }
    const round = await Promise.all(pending.map(async (i) => {
      const req = requests[i];
      try {
        const res = await f(req.url, {
          method: req.method || 'GET',
          headers: Object.assign({ 'User-Agent': UA, 'Accept': req.accept || '*/*' }, req.headers || {}),
          body: req.body,
          // Feeds are read-only and public; a redirect chain is normal.
          redirect: 'follow',
        });
        const body = await res.text();
        return { code: res.status, body, error: res.status === 200 ? null : `HTTP ${res.status}` };
      } catch (err) {
        return { code: 0, body: '', error: String((err && err.message) || err) };
      }
    }));
    const next = [];
    round.forEach((r, j) => {
      const idx = pending[j];
      results[idx] = r;
      if (RETRYABLE.has(r.code) && attempt < attempts - 1) next.push(idx);
    });
    pending = next;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Markup helpers
// ---------------------------------------------------------------------------
export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…').replace(/&amp;/g, '&');
}
function safeChar(code) {
  try { return (code > 0 && code <= 0x10ffff) ? String.fromCodePoint(code) : ''; } catch { return ''; }
}

/**
 * Feed bodies arrive as HTML wrapped in XML entities, and how many layers of
 * escaping survive varies by feed. Alternating strip/decode twice flattens both
 * depths, so live markup never reaches the summarizer (or the email).
 */
export function stripHtml(s) {
  let out = String(s == null ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let i = 0; i < 2; i++) out = decodeEntities(out.replace(/<[^>]+>/g, ' '));
  return out.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? stripHtml(m[1]) : '';
}
function rawTag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? m[1] : '';
}
function attr(xml, name, a) {
  const m = xml.match(new RegExp('<' + name + '\\b[^>]*\\b' + a + '="([^"]*)"', 'i'));
  return m ? decodeEntities(m[1]) : '';
}

export function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u).trim() : '';
}

// ---------------------------------------------------------------------------
// Generic feed parsing (Atom + RSS 2.0)
// ---------------------------------------------------------------------------
export function parseFeed(xml, opts = {}) {
  const body = String(xml || '');
  if (!body.trim()) return [];
  const limit = opts.limit || 25;
  const out = [];

  const entries = body.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const e of entries) {
    if (out.length >= limit) break;
    const href = attr(e, 'link', 'href') || tag(e, 'id');
    out.push({
      id: tag(e, 'id') || href,
      title: tag(e, 'title'),
      url: safeUrl(href),
      body: stripHtml(rawTag(e, 'content') || rawTag(e, 'summary')).slice(0, 1800),
      author: stripHtml(rawTag(rawTag(e, 'author'), 'name')),
      ts: Date.parse(tag(e, 'updated') || tag(e, 'published')) || 0,
    });
  }
  if (out.length) return out;

  const items = body.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const it of items) {
    if (out.length >= limit) break;
    const link = tag(it, 'link') || attr(it, 'link', 'href');
    out.push({
      id: tag(it, 'guid') || link || tag(it, 'title'),
      title: tag(it, 'title'),
      url: safeUrl(link),
      body: stripHtml(rawTag(it, 'description') || rawTag(it, 'content:encoded')).slice(0, 1800),
      author: tag(it, 'dc:creator') || tag(it, 'author'),
      ts: Date.parse(tag(it, 'pubDate') || tag(it, 'dc:date')) || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------
// Reddit rate-limits and sometimes outright refuses datacenter egress, and a
// Worker is about as datacenter as it gets. So every subreddit gets a ladder of
// hosts/formats and the first one that answers wins. A sub that fails all three
// costs its own section, never the digest.
export const REDDIT_HOSTS = [
  (sub, win, n) => `https://www.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?t=${win}&limit=${n}`,
  (sub, win, n) => `https://old.reddit.com/r/${encodeURIComponent(sub)}/top/.rss?t=${win}&limit=${n}`,
  (sub, win, n) => `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=${win}&limit=${n}&raw_json=1`,
];

function parseRedditJson(body, sub, limit) {
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const children = ((data || {}).data || {}).children || [];
  return children.slice(0, limit).map((c) => {
    const d = c.data || {};
    return {
      id: 't3_' + d.id,
      sub,
      title: String(d.title || ''),
      url: d.permalink ? 'https://www.reddit.com' + d.permalink : safeUrl(d.url),
      body: String(d.selftext || '').slice(0, 1800),
      author: String(d.author || ''),
      ts: (d.created_utc || 0) * 1000,
      score: d.score || 0,
      numComments: d.num_comments || 0,
    };
  }).filter((p) => p.title);
}

function parseRedditFeed(body, sub, limit) {
  return parseFeed(body, { limit }).map((e) => ({
    id: e.id || e.url,
    sub,
    title: e.title,
    url: e.url,
    body: e.body,
    author: e.author,
    ts: e.ts,
    score: 0,
    numComments: 0,
  })).filter((p) => p.title && p.id);
}

/**
 * Pulls top posts for a list of subreddits. One parallel round per host tier,
 * so the common case (tier 1 works) is a single round trip for every sub.
 * Quiet subs are automatically re-asked over a week-long window rather than
 * being allowed to leave their topic empty.
 */
export async function collectReddit(subs, opts = {}) {
  const perSub = opts.perSub || 8;
  const diagnostics = [];
  const bySub = {};
  const windowUsed = {};
  let todo = subs.slice();

  for (const win of ['day', 'week']) {
    for (let tier = 0; tier < REDDIT_HOSTS.length && todo.length; tier++) {
      const reqs = todo.map((s) => ({ url: REDDIT_HOSTS[tier](s, win, perSub), accept: tier === 2 ? 'application/json' : 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' }));
      const res = await fetchBatch(reqs, opts);
      const still = [];
      res.forEach((r, i) => {
        const sub = todo[i];
        if (r.error) {
          diagnostics.push(`fail  r/${sub} ${win} tier${tier + 1} — ${r.error}`);
          still.push(sub);
          return;
        }
        const posts = tier === 2 ? parseRedditJson(r.body, sub, perSub) : parseRedditFeed(r.body, sub, perSub);
        if (!posts.length) {
          diagnostics.push(`empty r/${sub} ${win} tier${tier + 1}`);
          still.push(sub);
          return;
        }
        // A widened retry only wins if it actually found more; otherwise the
        // fresher 24h pull stays.
        if ((bySub[sub] || []).length >= posts.length) return;
        bySub[sub] = posts;
        windowUsed[sub] = win;
        diagnostics.push(`ok    r/${sub} — ${posts.length} posts @ ${win} (tier${tier + 1})`);
      });
      todo = still;
    }
    // Only subs that produced fewer than two posts are worth widening; anything
    // else already has enough to say.
    todo = todo.concat(Object.keys(bySub).filter((s) => windowUsed[s] === 'day' && bySub[s].length < 2));
    todo = [...new Set(todo)];
    if (!todo.length) break;
  }
  for (const s of todo) if (!bySub[s]) diagnostics.push(`FAIL  r/${s} — no source tier answered`);
  return { bySub, diagnostics };
}

/**
 * Comment threads. The verdict on a product almost always lives in the replies,
 * not the post, so this is where the digest earns the "you never have to click"
 * promise. Best-effort by design: a dead thread costs that post its comments.
 */
export async function attachComments(posts, opts = {}) {
  const perPost = opts.perPost || 4;
  const targets = posts.filter((p) => p.url && /reddit\.com/i.test(p.url));
  if (!targets.length) return { got: 0, diagnostics: [] };
  const res = await fetchBatch(targets.map((p) => ({
    url: p.url.replace(/\/$/, '') + '/.rss?sort=top&limit=8',
    accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  })), opts);

  let got = 0;
  res.forEach((r, i) => {
    if (r.error) return;
    const entries = parseFeed(r.body, { limit: perPost + 3 });
    const post = targets[i];
    post.comments = post.comments || [];
    // Entry 0 is the post restated; the rest are comments, top-sorted.
    for (let j = 1; j < entries.length && post.comments.length < perPost; j++) {
      const b = entries[j].body;
      if (b && b.length > 40) post.comments.push(b.slice(0, 700));
    }
    if (post.comments.length) got++;
  });
  return { got, diagnostics: [`ok    comments on ${got}/${targets.length} posts`] };
}

// ---------------------------------------------------------------------------
// Web feeds (competitor / local / anything with an RSS URL)
// ---------------------------------------------------------------------------
/** Google News search as a feed — no key, and it covers local + competitor watch. */
export function newsFeedUrl(query, opts = {}) {
  const q = opts.days ? `${query} when:${opts.days}d` : String(query || '');
  const params = `hl=${opts.hl || 'en-US'}&gl=${opts.gl || 'US'}&ceid=${opts.ceid || 'US:en'}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${params}`;
}

/**
 * Fetches arbitrary feeds. `feeds` is [{id, label, url, source}]; the shape that
 * comes back matches a Reddit post closely enough that scoring, the verbatim
 * guard and rendering all treat them identically.
 */
export async function collectFeeds(feeds, opts = {}) {
  const list = (feeds || []).filter((f) => f && safeUrl(f.url));
  if (!list.length) return { byFeed: {}, diagnostics: [] };
  const res = await fetchBatch(list.map((f) => ({ url: f.url, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' })), opts);
  const byFeed = {};
  const diagnostics = [];
  res.forEach((r, i) => {
    const f = list[i];
    if (r.error) { diagnostics.push(`fail  feed ${f.label || f.id} — ${r.error}`); return; }
    const items = parseFeed(r.body, { limit: opts.perFeed || 6 }).map((e) => ({
      id: e.id || e.url,
      sub: f.source || f.label || 'web',
      title: e.title,
      url: e.url,
      body: e.body,
      author: e.author,
      ts: e.ts,
      comments: [],
      feedId: f.id,
    })).filter((p) => p.title);
    byFeed[f.id] = items;
    diagnostics.push(`${items.length ? 'ok   ' : 'empty'} feed ${f.label || f.id} — ${items.length} items`);
  });
  return { byFeed, diagnostics };
}

// ---------------------------------------------------------------------------
// Weather + air quality (Open-Meteo — free, no key, no attribution burden)
// ---------------------------------------------------------------------------
export function weatherUrl(lat, lon, tz) {
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`
    + '&daily=precipitation_probability_max,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,uv_index_max'
    + '&hourly=precipitation_probability,temperature_2m,wind_speed_10m,cloud_cover'
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(tz || 'America/Los_Angeles')}&forecast_days=3`;
}

export function airQualityUrl(lat, lon, tz) {
  return 'https://air-quality-api.open-meteo.com/v1/air-quality'
    + `?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`
    + `&hourly=us_aqi,pm2_5&timezone=${encodeURIComponent(tz || 'America/Los_Angeles')}&forecast_days=2`;
}

/**
 * Returns per-day forecast keyed by YYYY-MM-DD plus an hourly index, which is
 * what makes "your 2pm is outdoors and it's 80% rain" possible rather than just
 * "it might rain tomorrow".
 */
export async function collectWeather(lat, lon, tz, opts = {}) {
  const res = await fetchBatch([
    { url: weatherUrl(lat, lon, tz), accept: 'application/json' },
    { url: airQualityUrl(lat, lon, tz), accept: 'application/json' },
  ], opts);
  const diagnostics = [];
  const out = { days: {}, hours: {}, aqi: {}, ok: false };

  if (res[0].error) diagnostics.push(`fail  weather — ${res[0].error}`);
  else {
    try {
      const d = JSON.parse(res[0].body);
      const dd = d.daily || {};
      (dd.time || []).forEach((date, i) => {
        out.days[date] = {
          rainChance: num(dd.precipitation_probability_max, i),
          rainInches: num(dd.precipitation_sum, i),
          high: num(dd.temperature_2m_max, i),
          low: num(dd.temperature_2m_min, i),
          wind: num(dd.wind_speed_10m_max, i),
          uv: num(dd.uv_index_max, i),
        };
      });
      const hh = d.hourly || {};
      (hh.time || []).forEach((t, i) => {
        out.hours[t] = {
          rainChance: num(hh.precipitation_probability, i),
          temp: num(hh.temperature_2m, i),
          wind: num(hh.wind_speed_10m, i),
          cloud: num(hh.cloud_cover, i),
        };
      });
      out.ok = !!Object.keys(out.days).length;
      diagnostics.push(`ok    weather — ${Object.keys(out.days).length} days`);
    } catch (err) { diagnostics.push('fail  weather — bad json'); }
  }

  if (!res[1].error) {
    try {
      const a = JSON.parse(res[1].body);
      const hh = a.hourly || {};
      (hh.time || []).forEach((t, i) => { out.aqi[t] = { usAqi: num(hh.us_aqi, i), pm25: num(hh.pm2_5, i) }; });
      diagnostics.push('ok    air quality');
    } catch (err) { diagnostics.push('fail  air quality — bad json'); }
  }
  return { weather: out, diagnostics };
}

function num(arr, i) {
  const v = (arr || [])[i];
  return v == null ? null : Number(v);
}

/** Worst rain probability across a job's actual working hours. */
export function rainDuring(weather, dateStr, startHm, durationMin) {
  if (!weather || !weather.hours) return null;
  const startMin = hm2min(startHm);
  const endMin = startMin + (durationMin || 120);
  let worst = null, temp = null, wind = null;
  for (let h = Math.floor(startMin / 60); h <= Math.floor((endMin - 1) / 60); h++) {
    const key = `${dateStr}T${String(Math.min(23, Math.max(0, h))).padStart(2, '0')}:00`;
    const cell = weather.hours[key];
    if (!cell) continue;
    if (cell.rainChance != null && (worst == null || cell.rainChance > worst)) worst = cell.rainChance;
    if (temp == null || (cell.temp != null && cell.temp < temp)) temp = cell.temp;
    if (cell.wind != null && (wind == null || cell.wind > wind)) wind = cell.wind;
  }
  if (worst == null) {
    const day = weather.days[dateStr];
    if (!day) return null;
    return { rainChance: day.rainChance, temp: day.high, wind: day.wind, source: 'daily' };
  }
  return { rainChance: worst, temp, wind, source: 'hourly' };
}

function hm2min(hm) {
  const p = String(hm || '09:00').split(':');
  return (+p[0] || 0) * 60 + (+(p[1] || 0));
}
