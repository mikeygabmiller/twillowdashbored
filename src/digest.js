// ===========================================================================
// Morning digest — "what the internet talked about while you slept"
// ===========================================================================
// Gathers top posts from a configurable set of subreddits (plus optional RSS
// feeds for official sources Reddit is bad at), hands the whole pile to Gemini
// once, and emails the summary via Resend at a set hour each morning.
//
// Deliberately standalone: it takes `env` explicitly instead of leaning on
// index.js's module-global ENV, and carries its own Gemini + Resend callers.
// The digest is a nice-to-have — it must never be able to break the SMS cron,
// so runDigestCron() swallows everything and every source fails soft.
//
// Why the Worker and not Claude/a laptop: Reddit's robots.txt blocks AI
// crawlers and most hosted agents can't reach reddit.com at all. A Cloudflare
// Worker has unrestricted outbound fetch and is already running a cron here.
//
// Secrets (optional — unauthenticated Reddit is the fallback):
//   npx wrangler secret put REDDIT_CLIENT_ID
//   npx wrangler secret put REDDIT_CLIENT_SECRET
// Reuses RESEND_API_KEY / ALERT_EMAIL / GEMINI_API_KEY already configured.

const CONFIG_KEY = 'digest:config';
const STATE_KEY = 'digest:state';
const SEEN_KEY = 'digest:seen';
const TOKEN_KEY = 'digest:reddit_token';

// Cloudflare's free plan caps a Worker invocation at 50 subrequests. Every
// Reddit page, RSS feed, Gemini call and the Resend send comes out of that
// budget, so the gatherer spends against a counter and stops early rather than
// dying half-way through with no email sent.
const SUBREQUEST_BUDGET = 40;

const USER_AGENT = 'web:mikeys-morning-digest:v1.0 (by /u/mikeygabmiller)';

// ---------------------------------------------------------------------------
// Defaults — edit these in the dashboard (POST /api/digest/config), not here.
// ---------------------------------------------------------------------------
// `subs` are subreddits; `feeds` are RSS/Atom URLs for official sources where
// Reddit is mostly reaction rather than news. `hint` steers the summarizer
// toward what's actually useful about that topic.
const DEFAULT_TOPICS = [
  {
    id: 'detailing',
    label: '🧽 Detailing products & technique',
    subs: ['AutoDetailing', 'Detailing', 'professionaldetailing'],
    feeds: [],
    hint: 'New or newly-praised products, formulas and tools. Real-world reviews and technique arguments beat marketing. Flag anything a working mobile detailer would actually buy or change.',
  },
  {
    id: 'tools',
    label: '🔧 Mechanic tools',
    subs: ['Tools', 'MechanicAdvice', 'Justrolledintotheshop'],
    feeds: [],
    hint: 'New tool releases, deals, and durability verdicts. Prefer tools useful to a mobile operator working out of a vehicle.',
  },
  {
    id: 'harborfreight',
    label: '🛠️ Harbor Freight',
    subs: ['harborfreight'],
    feeds: [],
    hint: 'New arrivals, coupons and current deals, Icon/Hercules/Bauer line updates, and — most useful — which items are genuinely worth buying versus false economy. Prioritize anything a mobile detailer or someone wrenching out of a vehicle would actually use.',
  },
  {
    id: 'overwatch',
    label: '🎮 Overwatch 2',
    subs: ['Overwatch', 'Competitiveoverwatch'],
    feeds: ['https://news.blizzard.com/en-us/feed'],
    hint: 'Patch notes, balance changes, new heroes, seasons and events. Keep this one short and fun.',
  },
  {
    id: 'ai-business',
    label: '💼 AI for business',
    subs: ['SaaS', 'smallbusiness', 'AI_Agents', 'automation'],
    feeds: ['https://hnrss.org/newest?q=AI+agents&points=100'],
    hint: 'Concrete ways small businesses are using AI to save time or win work — automations, workflows, real results with numbers. Skip hype threads and anything selling a course.',
  },
  {
    id: 'anthropic',
    label: '🤖 Anthropic & Claude',
    subs: ['ClaudeAI', 'Anthropic'],
    feeds: ['https://hnrss.org/newest?q=Anthropic+OR+Claude&points=50'],
    hint: 'Model releases, feature and pricing changes, limits, outages, and genuinely useful workflow tips. Call out anything that changes what a paying subscriber gets.',
  },
];

const DEFAULTS = {
  enabled: true,
  hour: 7,               // local hour (tz below) to send
  tz: 'America/Los_Angeles',
  window: 'day',         // reddit `t` param: hour|day|week|month
  perSub: 12,            // posts pulled per subreddit before ranking
  perTopic: 6,           // items shown per topic in the email
  minScore: 25,          // ignore low-signal posts
  commentBudget: 10,     // how many posts get their top comments pulled
  topics: DEFAULT_TOPICS,
};

// ---------------------------------------------------------------------------
// Config / state (KV)
// ---------------------------------------------------------------------------
async function loadConfig(env) {
  try {
    const raw = await env.MESSAGES.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved, topics: saved.topics || DEFAULTS.topics };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveConfig(env, cfg) {
  await env.MESSAGES.put(CONFIG_KEY, JSON.stringify(cfg));
}

async function loadState(env) {
  try { return JSON.parse(await env.MESSAGES.get(STATE_KEY)) || {}; } catch { return {}; }
}

// Rolling memory of what's already been emailed, so a post that stays on top
// for three days doesn't lead the digest three mornings running.
async function loadSeen(env) {
  try { return new Set(JSON.parse(await env.MESSAGES.get(SEEN_KEY)) || []); } catch { return new Set(); }
}

async function saveSeen(env, seen, added) {
  const all = [...seen, ...added];
  // Keep the most recent 1500 ids — plenty for a week at this volume.
  await env.MESSAGES.put(SEEN_KEY, JSON.stringify(all.slice(-1500)));
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------
// OAuth (a free "script" app at reddit.com/prefs/apps) is strongly preferred:
// unauthenticated .json requests from datacenter IPs get rate-limited or 403'd
// by Reddit, and Cloudflare's egress is very much a datacenter IP. The token is
// cached in KV because it's valid for ~24h and each fetch costs a subrequest.
async function redditToken(env, budget) {
  const id = env.REDDIT_CLIENT_ID;
  const secret = env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;

  try {
    const cached = JSON.parse(await env.MESSAGES.get(TOKEN_KEY) || 'null');
    if (cached && cached.token && cached.exp > Date.now() + 60_000) return cached.token;
  } catch { /* fall through and mint a new one */ }

  if (!budget.spend()) return null;
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${id}:${secret}`),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`reddit auth ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('reddit auth: no token');
  await env.MESSAGES.put(TOKEN_KEY, JSON.stringify({
    token: data.access_token,
    exp: Date.now() + Math.max(0, (data.expires_in || 3600) - 300) * 1000,
  }));
  return data.access_token;
}

// One subreddit's top posts. Returns [] on any failure — a dead subreddit name
// or a Reddit hiccup should cost that section, not the whole email.
async function fetchSub(sub, { token, window, limit, budget }) {
  if (!budget.spend()) return { sub, posts: [], error: 'subrequest budget exhausted' };
  const path = `/r/${encodeURIComponent(sub)}/top?t=${window}&limit=${limit}&raw_json=1`;
  const url = token ? `https://oauth.reddit.com${path}` : `https://www.reddit.com${path}`;
  const headers = { 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { sub, posts: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const children = ((data.data || {}).children) || [];
    const posts = [];
    for (const c of children) {
      const p = c.data || {};
      if (p.stickied || p.over_18 || !p.title) continue;
      posts.push({
        id: `t3_${p.id}`,
        sub,
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        link: p.is_self ? null : p.url,
        score: p.score || 0,
        comments: p.num_comments || 0,
        ratio: p.upvote_ratio || 0,
        flair: p.link_flair_text || '',
        // Truncate early: Worker CPU time is the scarce resource. Generous
        // enough that the summarizer has the actual details to retell, since
        // the email is meant to be read without opening the link.
        body: String(p.selftext || '').replace(/\s+/g, ' ').slice(0, 1500),
        topComments: [],
      });
    }
    return { sub, posts, error: null };
  } catch (err) {
    return { sub, posts: [], error: String((err && err.message) || err) };
  }
}

// The comment section is usually where the actual verdict lives ("that product
// is repackaged X", "don't buy it, here's why"), so the highest-signal posts
// get their top comments pulled. Capped by config — each one is a subrequest.
async function fetchTopComments(post, { token, budget }) {
  if (!budget.spend()) return;
  const path = `${new URL(post.url).pathname}?limit=6&sort=top&depth=1&raw_json=1`;
  const url = token ? `https://oauth.reddit.com${path}` : `https://www.reddit.com${path}`;
  const headers = { 'User-Agent': USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const data = await res.json();
    const listing = Array.isArray(data) ? data[1] : null;
    const children = ((listing || {}).data || {}).children || [];
    for (const c of children) {
      const d = c.data || {};
      if (!d.body || d.stickied || d.author === 'AutoModerator') continue;
      post.topComments.push({
        score: d.score || 0,
        text: String(d.body).replace(/\s+/g, ' ').slice(0, 600),
      });
      if (post.topComments.length >= 4) break;
    }
  } catch { /* comments are a bonus, never a failure */ }
}

// ---------------------------------------------------------------------------
// RSS / Atom — for official sources (patch notes, changelogs, HN queries)
// ---------------------------------------------------------------------------
// A deliberately small regex parser: Workers have no DOMParser, and pulling in
// a real XML library for title+link would cost more than it's worth.
async function fetchFeed(url, { budget, limit = 6 }) {
  if (!budget.spend()) return { url, posts: [], error: 'subrequest budget exhausted' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { url, posts: [], error: `HTTP ${res.status}` };
    const xml = (await res.text()).slice(0, 200_000);
    const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];
    const host = new URL(url).hostname.replace(/^www\./, '');
    const posts = [];
    for (const b of blocks.slice(0, limit)) {
      const title = decodeXml(pick(b, 'title'));
      let link = decodeXml(pick(b, 'link'));
      if (!link) {
        const m = b.match(/<link[^>]*href="([^"]+)"/i);   // Atom style
        if (m) link = decodeXml(m[1]);
      }
      if (!title) continue;
      posts.push({
        id: link || `${host}:${title}`,
        sub: host,
        title,
        url: link || url,
        link: null,
        score: 0,
        comments: 0,
        ratio: 0,
        flair: 'feed',
        body: decodeXml(pick(b, 'description') || pick(b, 'summary') || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600),
        topComments: [],
      });
    }
    return { url, posts, error: null };
  } catch (err) {
    return { url, posts: [], error: String((err && err.message) || err) };
  }
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------
function makeBudget(max) {
  let used = 0;
  return {
    spend() { if (used >= max) return false; used++; return true; },
    get used() { return used; },
    left() { return max - used; },
  };
}

// Rank by engagement, but damp raw score so a 40k-upvote meme in r/Overwatch
// doesn't crowd out a 300-upvote thread that actually says something. Comments
// are weighted heavily — discussion is the thing being asked for here.
function rank(p) {
  return Math.log10(Math.max(1, p.score)) * 10 + Math.min(60, p.comments) * 0.8;
}

async function gather(env, cfg, { seen }) {
  const budget = makeBudget(SUBREQUEST_BUDGET);
  const diagnostics = [];
  let token = null;
  let authMode = 'anonymous';

  try {
    token = await redditToken(env, budget);
    if (token) authMode = 'oauth';
  } catch (err) {
    diagnostics.push({ source: 'reddit-auth', ok: false, error: String((err && err.message) || err) });
  }

  const sections = [];
  // Topics can legitimately share a subreddit (r/Tools turns up under both
  // tools and Harbor Freight talk), so claim each post for the first topic
  // that takes it rather than printing it twice.
  const claimed = new Set();

  for (const topic of cfg.topics) {
    if (topic.enabled === false) continue;
    const collected = [];

    for (const sub of (topic.subs || [])) {
      const r = await fetchSub(sub, { token, window: cfg.window, limit: cfg.perSub, budget });
      diagnostics.push({ source: `r/${sub}`, ok: !r.error, count: r.posts.length, error: r.error });
      for (const p of r.posts) {
        if (p.score < cfg.minScore) continue;
        if (seen.has(p.id) || claimed.has(p.id)) continue;
        collected.push(p);
      }
    }

    for (const feed of (topic.feeds || [])) {
      const r = await fetchFeed(feed, { budget });
      diagnostics.push({ source: feed, ok: !r.error, count: r.posts.length, error: r.error });
      for (const p of r.posts) {
        if (seen.has(p.id) || claimed.has(p.id)) continue;
        collected.push(p);   // feeds skip minScore — they have no votes
      }
    }

    collected.sort((a, b) => rank(b) - rank(a));
    const items = collected.slice(0, cfg.perTopic);
    for (const p of items) claimed.add(p.id);
    sections.push({ topic, items });
  }

  // Spend the remaining comment budget on the highest-ranked Reddit items
  // across all topics, so the hottest discussions get their verdicts attached.
  // Done on preview runs too: the preview exists for tuning, so it has to
  // produce exactly what the real morning email would.
  const candidates = sections
    .flatMap((s) => s.items)
    .filter((p) => p.flair !== 'feed' && p.comments >= 10)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, cfg.commentBudget);
  for (const p of candidates) {
    if (budget.left() <= 3) break;   // leave room for Gemini + Resend
    await fetchTopComments(p, { token, budget });
  }

  return { sections, diagnostics, budget, authMode };
}

// ---------------------------------------------------------------------------
// Summarize
// ---------------------------------------------------------------------------
// One Gemini call for the entire digest: cheaper, stays inside the subrequest
// budget, and lets the model drop a topic that genuinely had nothing worth
// reading rather than padding six sections independently.
//
// Items are passed as numbered refs and the model answers with those numbers —
// it never writes a URL, so it cannot invent one. Titles and links are resolved
// from our own data on the way out.
function buildPrompt(cfg, sections, pool) {
  const lines = [];
  for (const s of sections) {
    if (!s.items.length) continue;
    lines.push(`\n### TOPIC ${s.topic.id} — ${s.topic.label}`);
    lines.push(`What matters here: ${s.topic.hint}`);
    for (const p of s.items) {
      const n = pool.indexOf(p) + 1;
      lines.push(`\n[${n}] (r/${p.sub}, ${p.score} upvotes, ${p.comments} comments) ${p.title}`);
      if (p.body) lines.push(`    post: ${p.body}`);
      for (const c of p.topComments) lines.push(`    top comment (${c.score}): ${c.text}`);
    }
  }

  return `You are writing a personal morning briefing for Mikey, who runs a mobile car-detailing business in Snohomish County, WA. He shops Harbor Freight, wrenches on vehicles, plays Overwatch 2, and pays for Claude.

Below are the top Reddit posts and news items from the last ${cfg.window} in the topics he follows.

THE MOST IMPORTANT RULE: this email is the whole read, not a table of contents. Mikey should never have to click a link to understand what happened. Retell the actual content — the specifics, the numbers, the argument, what people concluded. If a post compares two products, say which won and by how much. If there's a deal, give the price and the catch. If it's a patch, say what actually changed and how players are reacting. A teaser like "detailers debated ceramic coatings" is a failure; write the substance instead.

Rules:
- Every item gets a real paragraph — roughly 4 to 7 sentences. Long enough that he's genuinely informed, written plainly, no filler or throat-clearing.
- Lead each paragraph with the actual point, not with "a user posted that". He knows it's from Reddit.
- The comments are often more valuable than the post. Where they contradict, debunk, or add a big caveat, work that in — "top comment points out it's rebranded X" is exactly the kind of thing he wants.
- Be specific: product names, prices, model numbers, patch numbers, real claims, real disagreements.
- Skip memes, rants, and photos with no information. Returning fewer, meatier items beats padding. It's fine to omit a topic entirely if nothing was worth his time.
- Write a "roundup" for each topic: 2-4 sentences on what the overall mood and through-line was, so the section reads as a story rather than a list.
- Never invent a fact that isn't in the material below. If a detail isn't there, leave it out.

Respond with JSON only, in exactly this shape:
{
  "topics": [
    {
      "id": "<the topic id>",
      "roundup": "<2-4 sentences on the theme and mood of this topic today>",
      "items": [ { "ref": <the [n] number>, "point": "<the full 4-7 sentence writeup>" } ]
    }
  ],
  "headline": "<the single most useful thing in this whole briefing, one sentence>"
}

MATERIAL:
${lines.join('\n')}`;
}

async function geminiJson(env, prompt) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          // Long-form by design: ~6 topics x ~6 paragraphs plus roundups. Too
          // low a ceiling here is what turns the digest back into headlines.
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
          // Same reasoning as index.js's geminiGenerate: hidden thinking tokens
          // come out of maxOutputTokens and were truncating long JSON.
          ...(/2\.5|thinking/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
    .map((p) => p.text || '').join('').trim();
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
// Subject lines get clipped by mail clients anyway; clip on a word boundary so
// what does show up doesn't end mid-word.
function truncateWords(s, max) {
  const str = String(s).trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEmail(cfg, summary, pool, dateLabel) {
  const byId = new Map(cfg.topics.map((t) => [t.id, t]));
  const blocks = [];
  const textLines = [];

  for (const t of (summary.topics || [])) {
    const topic = byId.get(t.id);
    const items = (t.items || [])
      .map((it) => ({ it, post: pool[Number(it.ref) - 1] }))
      .filter((x) => x.post);
    if (!items.length) continue;

    const label = topic ? topic.label : t.id;
    // `roundup` is the current field; `summary` is what the first version
    // emitted. Accept either so an in-flight model response never renders blank.
    const roundup = t.roundup || t.summary || '';
    textLines.push(`\n\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}`);
    if (roundup) textLines.push(`\n${roundup}`);

    const rows = items.map(({ it, post }) => {
      const meta = post.flair === 'feed'
        ? esc(post.sub)
        : `r/${esc(post.sub)} · ${post.score.toLocaleString()} upvotes · ${post.comments} comments`;
      textLines.push(`\n${post.title}\n${it.point}\n  ↳ ${post.url}`);
      // The paragraph is the payload; the link is a footnote for the rare case
      // he wants the original thread. Deliberately not styled as a call to
      // action — nothing here should read as "click to continue".
      return `
        <tr><td style="padding:0 0 26px;">
          <div style="font-size:15px;font-weight:600;line-height:1.45;color:#111;margin-bottom:7px;">${esc(post.title)}</div>
          <div style="font-size:15px;line-height:1.72;color:#2a2a2a;">${esc(it.point)}</div>
          <div style="font-size:11px;color:#9a9a9a;margin-top:8px;">
            ${meta} · <a href="${esc(post.url)}" style="color:#9a9a9a;text-decoration:underline;">thread</a>
          </div>
        </td></tr>`;
    }).join('');

    blocks.push(`
      <tr><td style="padding:34px 0 6px;border-top:2px solid #e4e4e0;">
        <div style="font-size:19px;font-weight:700;color:#111;letter-spacing:-.01em;">${esc(label)}</div>
        ${roundup ? `<div style="font-size:14px;color:#5a5a5a;margin-top:8px;line-height:1.65;">${esc(roundup)}</div>` : ''}
      </td></tr>
      <tr><td style="padding-top:20px;"><table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`);
  }

  if (!blocks.length) {
    return {
      html: `<p style="font-family:sans-serif">Nothing worth reporting this morning — every source was quiet or already covered.</p>`,
      text: 'Nothing worth reporting this morning.',
      empty: true,
    };
  }

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f4;padding:24px 12px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#fff;border-radius:12px;padding:32px 30px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr><td style="padding-bottom:6px;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a;">Morning rundown · ${esc(dateLabel)}</div>
          ${summary.headline ? `<div style="font-size:22px;line-height:1.4;font-weight:700;color:#111;margin-top:12px;letter-spacing:-.01em;">${esc(summary.headline)}</div>` : ''}
        </td></tr>
        ${blocks.join('')}
        <tr><td style="padding-top:24px;border-top:1px solid #ececec;">
          <div style="font-size:11px;color:#9a9a9a;line-height:1.5;">
            Summarized from Reddit and public feeds. Change topics or send time in the dashboard.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  const text = `MORNING RUNDOWN — ${dateLabel}\n${summary.headline ? `\n${summary.headline}\n` : ''}${textLines.join('\n')}`;
  return { html, text, empty: false };
}

async function sendDigestEmail(env, subject, html, text) {
  const to = env.ALERT_EMAIL;
  if (!to) throw new Error('ALERT_EMAIL not set');
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const from = env.DIGEST_FROM || env.ALERT_FROM || 'Morning Rundown <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Build + send
// ---------------------------------------------------------------------------
export async function buildDigest(env, { dryRun = false } = {}) {
  const cfg = await loadConfig(env);
  const seen = dryRun ? new Set() : await loadSeen(env);
  const { sections, diagnostics, budget, authMode } = await gather(env, cfg, { seen });

  const pool = sections.flatMap((s) => s.items);
  if (!pool.length) {
    return { ok: false, reason: 'no_items', diagnostics, authMode, subrequests: budget.used };
  }

  const summary = await geminiJson(env, buildPrompt(cfg, sections, pool));
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: cfg.tz,
  });
  const rendered = renderEmail(cfg, summary, pool, dateLabel);

  return {
    ok: true,
    cfg,
    pool,
    summary,
    rendered,
    dateLabel,
    diagnostics,
    authMode,
    subrequests: budget.used,
    subject: `☕ Morning rundown — ${summary.headline ? truncateWords(summary.headline, 80) : dateLabel}`,
  };
}

export async function sendDigest(env) {
  const built = await buildDigest(env);
  if (!built.ok) return built;
  if (built.rendered.empty) return { ...built, sent: false, reason: 'empty' };

  await sendDigestEmail(env, built.subject, built.rendered.html, built.rendered.text);
  await saveSeen(env, await loadSeen(env), built.pool.map((p) => p.id));
  return { ...built, sent: true };
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------
// Called every minute from runCron(). Gates on the configured local hour and a
// once-per-day marker, so the actual work runs once each morning. Errors are
// reported to KV state (visible in the dashboard) and never rethrown.
export async function runDigestCron(env, now = Date.now(), helpers = {}) {
  const cfg = await loadConfig(env);
  if (!cfg.enabled) return;
  if (String(env.DIGEST_DISABLED || '') === '1') return;

  const localHour = helpers.localHour || defaultLocalHour;
  const localDateStr = helpers.localDateStr || defaultLocalDateStr;

  if (localHour(now, cfg.tz) !== cfg.hour) return;
  const today = localDateStr(now, cfg.tz);

  const state = await loadState(env);
  if (state.sentOn === today) return;

  // Claim the day *before* doing the work: the minute cron would otherwise
  // start a second overlapping run while the first is still talking to Gemini.
  state.sentOn = today;
  await env.MESSAGES.put(STATE_KEY, JSON.stringify(state));

  try {
    const result = await sendDigest(env);
    state.lastRun = { at: now, ok: !!result.sent, reason: result.reason || null, items: (result.pool || []).length };
  } catch (err) {
    state.lastRun = { at: now, ok: false, error: String((err && err.message) || err) };
  }
  await env.MESSAGES.put(STATE_KEY, JSON.stringify(state));
}

function defaultLocalHour(ts, tz) {
  return Number(new Date(ts).toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit' }));
}

function defaultLocalDateStr(ts, tz) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: tz });
}

// ---------------------------------------------------------------------------
// API — mounted under /api/digest/* by index.js (behind the dashboard password)
// ---------------------------------------------------------------------------
export async function digestApi(request, url, env, json) {
  const path = url.pathname;

  if (request.method === 'GET' && path === '/api/digest/config') {
    return json({ ok: true, config: await loadConfig(env), state: await loadState(env) });
  }

  if (request.method === 'POST' && path === '/api/digest/config') {
    const body = await request.json().catch(() => ({}));
    const cur = await loadConfig(env);
    const next = { ...cur };
    if (body.enabled != null) next.enabled = !!body.enabled;
    if (body.hour != null) next.hour = Math.max(0, Math.min(23, Number(body.hour)));
    if (body.tz) next.tz = String(body.tz);
    if (body.window) next.window = String(body.window);
    if (body.perTopic != null) next.perTopic = Math.max(1, Math.min(12, Number(body.perTopic)));
    if (body.perSub != null) next.perSub = Math.max(3, Math.min(25, Number(body.perSub)));
    if (body.minScore != null) next.minScore = Math.max(0, Number(body.minScore));
    if (body.commentBudget != null) next.commentBudget = Math.max(0, Math.min(12, Number(body.commentBudget)));
    if (Array.isArray(body.topics)) next.topics = body.topics;
    await saveConfig(env, next);
    return json({ ok: true, config: next });
  }

  // Reset to the shipped defaults — handy after experimenting with topics.
  if (request.method === 'POST' && path === '/api/digest/reset') {
    await saveConfig(env, { ...DEFAULTS });
    return json({ ok: true, config: { ...DEFAULTS } });
  }

  // Dry run: builds the digest and returns it (with per-source diagnostics)
  // WITHOUT emailing or marking anything as seen. This is the tuning loop.
  if (request.method === 'GET' && path === '/api/digest/preview') {
    try {
      const built = await buildDigest(env, { dryRun: true });
      if (url.searchParams.get('format') === 'html' && built.ok) {
        return new Response(built.rendered.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return json({
        ok: built.ok,
        reason: built.reason || null,
        authMode: built.authMode,
        subrequests: built.subrequests,
        diagnostics: built.diagnostics,
        headline: built.ok ? built.summary.headline : null,
        topics: built.ok ? built.summary.topics : null,
        text: built.ok ? built.rendered.text : null,
      });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }

  // Force a real send right now, ignoring the hour gate (but still respecting
  // the seen-list, so it behaves exactly like the morning run).
  if (request.method === 'POST' && path === '/api/digest/send') {
    try {
      const result = await sendDigest(env);
      return json({
        ok: !!result.sent,
        reason: result.reason || null,
        items: (result.pool || []).length,
        subrequests: result.subrequests,
        diagnostics: result.diagnostics,
      });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }

  return null;   // not a digest route
}
