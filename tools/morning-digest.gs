/**
 * MORNING DIGEST — Reddit + Hacker News → Gemini → your inbox, on Google Apps Script.
 *
 * FIRST TIME SETUP (three things, all in this editor):
 *   1. Project Settings (gear, left side) → Script Properties → Add:
 *        GEMINI_API_KEY  =  your key
 *      Never paste the key into this file. A key in code leaks the moment you
 *      share the script.
 *   2. Project Settings → set the script timezone to your local zone,
 *      otherwise SEND_HOUR below is interpreted in the wrong timezone.
 *   3. Pick `setup` in the function dropdown above and hit Run. That checks your
 *      key, checks the network, and creates the daily trigger. Run it again any
 *      time to change the hour.
 *
 * TRY IT NOW:
 *   `previewToLog`    builds the whole digest and prints it — emails nothing.
 *   `previewToInbox`  emails you a [PREVIEW] copy without marking anything seen,
 *                     so tomorrow's real digest is unaffected. Best way to judge
 *                     the layout, since the log can't show you the HTML.
 *   `healthCheck`     one-line verdict on key, Reddit, Gemini and mail quota.
 *   `clearSeen`       forget everything already sent.
 *
 * HOW IT WORKS
 *   collect → rank → gate → dedupe → pull comments → summarize → render
 *   Every stage is designed to fail soft: a dead subreddit, a blocked API or a
 *   refused Gemini call costs that one piece, never the email.
 */

// ---------------------------------------------------------------------------
// Config — the part you actually tune
// ---------------------------------------------------------------------------
const SEND_HOUR = 7;          // 24h, in the script's timezone

const ITEMS_PER_TOPIC = 5;    // default items per topic; a topic can override with `max`
const CANDIDATES_PER_SUB = 25; // how many posts to *consider* per sub (ranking needs depth)
const COMMENT_POSTS = 14;     // how many posts get their comment threads pulled
const COMMENTS_PER_POST = 5;

const MODEL = 'gemini-2.5-flash';
const UA = 'MorningDigest/3.0 (personal use)';

// Pull Hacker News alongside Reddit for topics that name a query. Reddit is
// opinion and hands-on experience; HN is where releases and pricing changes get
// picked apart first. Free, no key, no auth.
const USE_HACKER_NEWS = true;

// A 3-day forecast, rendered without touching the LLM so it cannot be
// hallucinated. For mobile detailing the weather *is* the schedule, so it leads
// the email. Coordinates below are Snohomish, WA — change them or set
// enabled:false. Open-Meteo is free and needs no key.
const WEATHER = {
  enabled: true,
  label: 'Snohomish County',
  lat: 47.9129,
  lon: -122.0982,
};

// Grouping subreddits into topics (rather than one flat list) is what lets the
// summarizer write a coherent section per subject instead of one mixed blob.
//   hint  what's actually useful about this topic — steers the whole section
//   max   optional item cap (defaults to ITEMS_PER_TOPIC)
//   hn    optional Hacker News query, merged in as extra candidates
//   floor optional minimum engagement (score + comments) to survive the gate
const TOPICS = [
  {
    label: '🧽 Detailing products & technique',
    subs: ['AutoDetailing', 'Detailing'],
    hint: 'New or newly-praised products, formulas and tools. Real-world reviews and long-term durability beat marketing. Flag anything a working mobile detailer would actually buy or change.',
  },
  {
    label: '🔧 Mechanic tools',
    subs: ['Tools', 'MechanicAdvice'],
    hint: 'New tool releases, deals with the actual price, and durability verdicts. Prefer tools useful to someone working out of a vehicle.',
  },
  {
    label: '🛠️ Harbor Freight',
    subs: ['harborfreight'],
    hint: 'New arrivals, coupons and current deals, Icon/Hercules/Bauer updates, and which items are genuinely worth buying versus false economy.',
    floor: 15,   // small sub — a low bar here still means a real thread
  },
  {
    label: '🎮 Overwatch 2',
    subs: ['Overwatch', 'Competitiveoverwatch'],
    hint: 'Patch notes, balance changes, new heroes, seasons and events. Keep this one shorter and fun.',
    max: 3,
  },
  {
    label: '💼 AI for business',
    subs: ['smallbusiness', 'SaaS', 'AI_Agents'],
    hint: 'Concrete ways small businesses use AI to save time or win work, ideally with real numbers. Skip hype and anything selling a course.',
    hn: 'AI small business automation',
  },
  {
    label: '🤖 Anthropic & Claude',
    subs: ['ClaudeAI', 'Anthropic'],
    hint: 'Model releases, feature and pricing changes, usage limits, outages, and genuinely useful workflow tips. Call out anything that changes what a paying subscriber gets.',
    hn: 'Anthropic OR Claude',
  },
];

// Ranking / gating knobs. See rankAndGate() for how these combine.
const MIN_ENGAGEMENT = 25;    // default floor on (score + comments) — kills dead threads
const RECENCY_HALF_LIFE_H = 30; // heat halves every ~30h, so yesterday beats last Tuesday

// Obvious no-information posts. Deliberately short: the summarizer is also told
// to skip filler, and an aggressive regex here silently eats good threads.
const JUNK_TITLE = /^(meme|shitpost|\[?oc\]?\s*$)|my first (car|detail)\b|before\s*(&|and|\/)\s*after\s*$/i;

// Seen-list — stops a post that sits on top for days from leading every morning.
const SEEN_IDS_KEY = 'digest_seen_ids';
const SEEN_FP_KEY = 'digest_seen_fps';
const SEEN_DAYS = 10;         // forget after this many days
const SEEN_MAX = 500;         // hard cap; see packSeen() for why the encoding is terse
const FAIL_NOTICE_KEY = 'digest_last_fail_notice';

const ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Validates the config, then installs (or moves) the daily trigger. */
function setup() {
  var problems = [];
  if (!apiKey()) problems.push('GEMINI_API_KEY is not set (Project Settings → Script Properties).');
  if (SEND_HOUR < 0 || SEND_HOUR > 23) problems.push('SEND_HOUR must be 0–23.');
  if (!TOPICS.length) problems.push('TOPICS is empty.');
  if (problems.length) {
    Logger.log('Setup did NOT install a trigger:\n  - %s', problems.join('\n  - '));
    return;
  }

  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendMorningDigest'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('sendMorningDigest')
    .timeBased().atHour(SEND_HOUR).nearMinute(5).everyDays(1).create();

  Logger.log('Daily trigger set for ~%s:00 (%s). Apps Script fires within an ' +
    'hour of that time, not on the dot.\nRun `previewToInbox` to see what it ' +
    'will look like.', SEND_HOUR, Session.getScriptTimeZone());
}

function sendMorningDigest() {
  // A retried or overlapping trigger must never send the digest twice.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another run is in progress; skipping.');
    return;
  }
  try {
    var built = buildDigest();
    Logger.log('sources:\n' + built.diagnostics.join('\n'));
    if (!built.ok) {
      Logger.log('Nothing sent: %s', built.reason);
      return;
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      Logger.log('Out of daily mail quota; not sending.');
      return;
    }
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: built.subject,
      htmlBody: built.html,   // htmlBody, not body — otherwise formatting arrives as raw markup
      body: built.text,       // plain-text fallback for clients that want it
      name: 'Morning Rundown',
    });
    rememberSeen(built.ids, built.fingerprints);
  } catch (err) {
    // A silent failure is a digest that just stops arriving one morning and is
    // never noticed. Tell someone — but at most once a day, so a broken run on
    // a 6-hour retry loop can't spam the inbox.
    notifyFailure(err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/** Full dry run: builds everything, emails nothing, marks nothing as seen. */
function previewToLog() {
  var built = buildDigest({ dryRun: true });
  Logger.log(built.ok ? built.text : 'Nothing built: ' + built.reason);
  Logger.log('--- sources ---\n' + built.diagnostics.join('\n'));
}

/** Emails a real copy so you can judge the layout — still marks nothing seen. */
function previewToInbox() {
  var built = buildDigest({ dryRun: true });
  if (!built.ok) {
    Logger.log('Nothing built: %s', built.reason);
    return;
  }
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: '[PREVIEW] ' + built.subject,
    htmlBody: built.html,
    body: built.text,
    name: 'Morning Rundown',
  });
  Logger.log('Preview sent. Nothing was marked as seen.\n--- sources ---\n' +
    built.diagnostics.join('\n'));
}

/** Fast verdict on the four things that actually break. */
function healthCheck() {
  var key = apiKey();
  var lines = ['key:      ' + (key ? 'present' : 'MISSING — set GEMINI_API_KEY'),
               'timezone: ' + Session.getScriptTimeZone(),
               'mail:     ' + MailApp.getRemainingDailyQuota() + ' sends left today',
               'trigger:  ' + (ScriptApp.getProjectTriggers().some(function (t) {
                 return t.getHandlerFunction() === 'sendMorningDigest';
               }) ? 'installed' : 'NOT installed — run `setup`')];

  var probe = fetchBatch([redditRequest(listingUrl(TOPICS[0].subs[0], 'day', 3))])[0];
  lines.push('reddit:   ' + (probe.error || 'ok (' + parseListing(probe, TOPICS[0].subs[0]).length + ' posts)'));

  if (key) {
    var g = readGemini(fetchBatch([geminiRequest(key, 'Reply {"headline":"ok"}',
      { type: 'OBJECT', properties: { headline: { type: 'STRING' } }, required: ['headline'] },
      64, 0)])[0]);
    lines.push('gemini:   ' + (g.error || 'ok'));
  }
  Logger.log(lines.join('\n'));
}

/** Run this if you want the next digest to ignore what it has already sent. */
function clearSeen() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(SEEN_IDS_KEY);
  props.deleteProperty(SEEN_FP_KEY);
  Logger.log('Seen-list cleared.');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function buildDigest(opts) {
  opts = opts || {};
  var seen = opts.dryRun ? { ids: {}, fps: {} } : loadSeen();
  var diagnostics = [];

  var weather = WEATHER.enabled ? fetchWeather(diagnostics) : null;

  var byTopic = collectPosts(seen, diagnostics);
  var sections = [];
  byTopic.forEach(function (items, ti) {
    if (items.length) sections.push({ topic: TOPICS[ti], items: items });
  });

  if (!sections.length) {
    // A weather-only email still beats nothing on a quiet morning.
    if (weather) {
      var bare = render([], { headline: '', bullets: [], topics: [] }, weather, diagnostics, null);
      return {
        ok: true,
        subject: '☕ Morning rundown — ' + weather.today.verdict.label + ' for detailing',
        html: bare.html, text: bare.text, ids: [], fingerprints: [], diagnostics: diagnostics,
      };
    }
    return { ok: false, reason: 'no posts fetched', diagnostics: diagnostics };
  }

  // Comments are where the real verdict lives. Spend the budget round-robin
  // across topics — taking the first N in topic order starved every topic past
  // the second. Each is one more HTTP call; Apps Script allows 20,000/day.
  attachComments(pickForComments(sections, COMMENT_POSTS), diagnostics);

  var summary = summarize(sections, diagnostics);
  var rendered = render(sections, summary, weather, diagnostics, apiKey());

  if (!rendered.ids.length) {
    return { ok: false, reason: 'summarizer returned nothing usable', diagnostics: diagnostics };
  }

  return {
    ok: true,
    subject: subjectLine(summary, weather),
    html: rendered.html,
    text: rendered.text,
    // Only what actually shipped. Marking dropped posts as seen buries a good
    // post forever just because the model skipped it once.
    ids: rendered.ids,
    fingerprints: rendered.fingerprints,
    diagnostics: diagnostics,
  };
}

function subjectLine(summary, weather) {
  var lead = summary.headline || (weather ? weather.today.verdict.label + ' for detailing' : todayLabel());
  return '☕ ' + truncateWords(lead, 90);
}

/**
 * One parallel round for every source, then rank → gate → dedupe → interleave.
 *
 * The old version took the first N entries of an RSS feed, which meant "what
 * Reddit happened to list first" decided the whole email. With the JSON
 * listing we get score, comment count and age, so selection can actually be
 * about which threads have substance.
 */
function collectPosts(seen, diagnostics) {
  var reqs = [], meta = [];
  TOPICS.forEach(function (topic, ti) {
    topic.subs.forEach(function (sub) {
      reqs.push(redditRequest(listingUrl(sub, 'day', CANDIDATES_PER_SUB)));
      meta.push({ ti: ti, sub: sub, window: 'day', kind: 'reddit' });
    });
    if (USE_HACKER_NEWS && topic.hn) {
      reqs.push(hnRequest(topic.hn));
      meta.push({ ti: ti, sub: 'HN', window: '48h', kind: 'hn' });
    }
  });

  var results = fetchBatch(reqs);
  var posts = results.map(function (r, i) {
    return meta[i].kind === 'hn' ? parseHn(r) : parseListing(r, meta[i].sub);
  });

  // Reddit's JSON listing is occasionally refused outright (datacenter IPs get
  // 403/429 in waves). The old RSS path still works when that happens, so it
  // stays as a fallback rather than a legacy branch.
  var rssIdx = [];
  posts.forEach(function (list, i) {
    if (meta[i].kind === 'reddit' && !list.length) rssIdx.push(i);
  });
  if (rssIdx.length) {
    var rssRes = fetchBatch(rssIdx.map(function (i) {
      return redditRequest(rssUrl(meta[i].sub, 'day'));
    }));
    rssIdx.forEach(function (i, k) {
      var viaRss = parseAtomEntries(rssRes[k], meta[i].sub);
      if (viaRss.length) {
        posts[i] = viaRss;
        meta[i].window = 'day/rss';
      }
    });
  }

  // A quiet sub can have almost nothing in a 24h window. Widen those to a week
  // rather than letting the topic go empty.
  var retryIdx = [];
  posts.forEach(function (list, i) {
    if (meta[i].kind === 'reddit' && list.length < 4) retryIdx.push(i);
  });
  if (retryIdx.length) {
    var retryRes = fetchBatch(retryIdx.map(function (i) {
      return redditRequest(listingUrl(meta[i].sub, 'week', CANDIDATES_PER_SUB));
    }));
    retryIdx.forEach(function (i, k) {
      var widened = parseListing(retryRes[k], meta[i].sub);
      if (widened.length > posts[i].length) {
        posts[i] = widened;
        meta[i].window = 'week';
      }
    });
  }

  results.forEach(function (r, i) {
    diagnostics.push((r.error && !posts[i].length ? 'FAIL  ' : ' ok   ') +
      (meta[i].kind === 'hn' ? 'HN:' + TOPICS[meta[i].ti].hn : 'r/' + meta[i].sub) +
      (r.error && !posts[i].length ? ' — ' + r.error
        : ' (' + posts[i].length + ' @ ' + meta[i].window + ')'));
  });

  // Rank inside each source first, so a 400k-subscriber sub can't drown a
  // 40k one purely on absolute upvotes.
  posts.forEach(function (list) { scoreRelative(list); });

  // Interleave per topic, skipping anything already seen, already claimed by an
  // earlier topic (subs share crossposts), or a near-duplicate of something
  // already in the email.
  var claimed = {}, claimedFp = {};
  return TOPICS.map(function (topic, ti) {
    var lists = [];
    posts.forEach(function (list, i) {
      if (meta[i].ti !== ti) return;
      lists.push(rankAndGate(list, topic));
    });

    var limit = topic.max || ITEMS_PER_TOPIC;
    var out = [], depth = 0, added = true;
    while (out.length < limit && added) {
      added = false;
      for (var k = 0; k < lists.length && out.length < limit; k++) {
        var p = lists[k][depth];
        if (!p) continue;
        added = true;
        if (seen.ids[p.id] || claimed[p.id]) continue;
        if (seen.fps[p.fp] || claimedFp[p.fp]) continue;
        claimed[p.id] = true;
        claimedFp[p.fp] = true;
        out.push(p);
      }
      depth++;
    }
    return out;
  });
}

/**
 * heat = upvotes + 3× comments, decayed by age.
 *
 * Comments are weighted heavily on purpose: a thread with 90 upvotes and 200
 * comments is an argument worth reading, while 3,000 upvotes and 11 comments is
 * a photo. That ratio is the single best cheap proxy for "is there information
 * in here", and it is exactly what the RSS feed could never tell us.
 */
function heatOf(p) {
  var raw = (p.score || 0) + 3 * (p.numComments || 0);
  var ageH = Math.max(0, (Date.now() - p.created) / 3600000);
  return raw * Math.pow(0.5, ageH / RECENCY_HALF_LIFE_H);
}

/** Normalizes heat against the source's own median, so subs compete fairly. */
function scoreRelative(list) {
  list.forEach(function (p) { p.heat = heatOf(p); });
  var heats = list.map(function (p) { return p.heat; }).sort(function (a, b) { return a - b; });
  var median = heats.length ? heats[Math.floor(heats.length / 2)] : 0;
  list.forEach(function (p) { p.rel = median > 0 ? p.heat / median : (p.heat > 0 ? 1 : 0); });
}

/** Drops the obvious non-content, then orders by relative heat. */
function rankAndGate(list, topic) {
  var floor = typeof topic.floor === 'number' ? topic.floor : MIN_ENGAGEMENT;
  return list.filter(function (p) {
    if (p.stickied || p.nsfw) return false;
    if (JUNK_TITLE.test(p.title)) return false;
    // Posts with no metrics come from the RSS fallback — let them through
    // rather than gating a whole sub to zero on missing data.
    if (!p.hasMetrics) return true;
    return (p.score + p.numComments) >= floor;
  }).sort(function (a, b) {
    return (b.rel - a.rel) || (b.heat - a.heat);
  });
}

/**
 * Round-robin across topics so every section gets some comment coverage, but
 * within a topic the highest-ranked posts get theirs first — those are the ones
 * whose threads are worth the call.
 */
function pickForComments(sections, budget) {
  var out = [], depth = 0, added = true;
  while (out.length < budget && added) {
    added = false;
    for (var i = 0; i < sections.length && out.length < budget; i++) {
      var p = sections[i].items[depth];
      if (!p) continue;
      // `added` tracks "this topic still has posts at this depth", not "we took
      // one" — otherwise a topic whose next post is a HN story (no comment feed
      // to pull) would end the whole loop early.
      added = true;
      if (p.source !== 'reddit') continue;
      out.push(p);
    }
    depth++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit (public JSON — no API key, no OAuth — with the Atom feed as fallback)
// ---------------------------------------------------------------------------
function listingUrl(sub, window, limit) {
  return 'https://www.reddit.com/r/' + encodeURIComponent(sub) +
         '/top.json?t=' + window + '&limit=' + limit + '&raw_json=1';
}

function rssUrl(sub, window) {
  return 'https://www.reddit.com/r/' + encodeURIComponent(sub) +
         '/top/.rss?t=' + window + '&limit=' + CANDIDATES_PER_SUB;
}

function redditRequest(url) {
  return { url: url, muteHttpExceptions: true, headers: { 'User-Agent': UA } };
}

/** The JSON listing — everything the RSS feed was missing. */
function parseListing(result, sub) {
  if (result.error) return [];
  try {
    var children = JSON.parse(result.body).data.children || [];
    return children.map(function (c) {
      var d = c.data || {};
      if (!d.id) return null;
      return {
        id: 't3_' + d.id,
        source: 'reddit',
        sub: d.subreddit || sub,
        title: String(d.title || ''),
        url: 'https://www.reddit.com' + (d.permalink || ''),
        // A link post's body is empty, so carry the destination domain instead —
        // "arstechnica.com" is real context that "(no post text)" is not.
        body: cleanText(d.selftext || '').slice(0, 2000),
        domain: d.is_self ? '' : String(d.domain || ''),
        flair: String(d.link_flair_text || ''),
        score: Number(d.score) || 0,
        numComments: Number(d.num_comments) || 0,
        created: (Number(d.created_utc) || 0) * 1000,
        stickied: !!d.stickied,
        nsfw: !!d.over_18,
        hasMetrics: true,
        comments: [],
        fp: fingerprint(d.title),
      };
    }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

/** Fallback path: the Atom feed, which has no numbers but is rarely blocked. */
function parseAtomEntries(result, sub) {
  if (result.error) return [];
  try {
    var entries = XmlService.parse(result.body).getRootElement().getChildren('entry', ATOM);
    var posts = [];
    for (var i = 0; i < entries.length && posts.length < CANDIDATES_PER_SUB; i++) {
      var e = entries[i];
      var link = e.getChild('link', ATOM);
      var href = link && link.getAttribute('href') ? link.getAttribute('href').getValue() : '';
      var id = text(e.getChild('id', ATOM));
      if (!id) continue;
      var title = text(e.getChild('title', ATOM));
      posts.push({
        id: id,
        source: 'reddit',
        sub: sub,
        title: title,
        url: safeUrl(href),
        // The RSS <content> holds the post body. Without it the summarizer only
        // has headlines and has to guess or pad.
        body: stripHtml(text(e.getChild('content', ATOM))).slice(0, 2000),
        domain: '',
        flair: '',
        score: 0,
        numComments: 0,
        created: Date.parse(text(e.getChild('updated', ATOM))) || Date.now(),
        stickied: false,
        nsfw: false,
        hasMetrics: false,   // ranking and gating must not punish this
        comments: [],
        fp: fingerprint(title),
      });
    }
    return posts;
  } catch (err) {
    return [];
  }
}

/** Reddit serves a post's comment thread as JSON at <permalink>.json. */
function attachComments(posts, diagnostics) {
  var targets = posts.filter(function (p) { return p.url; });
  if (!targets.length) return;

  var results = fetchBatch(targets.map(function (p) {
    return redditRequest(p.url.replace(/\/$/, '') +
      '.json?sort=top&limit=10&depth=1&raw_json=1');
  }));

  var got = 0;
  results.forEach(function (r, i) {
    if (r.error) return;
    try {
      var post = targets[i];
      // [0] is the post itself, [1] is the comment tree.
      var kids = (JSON.parse(r.body)[1] || {}).data.children || [];
      for (var j = 0; j < kids.length && post.comments.length < COMMENTS_PER_POST; j++) {
        var d = kids[j].data || {};
        var body = cleanText(d.body || '');
        if (d.stickied || !body || body.length < 60) continue;
        // The score rides along into the prompt: the model can then say "the
        // top reply, at +240, disagrees" instead of treating every comment as
        // equally endorsed.
        post.comments.push({ text: body.slice(0, 900), score: Number(d.score) || 0 });
      }
      if (post.comments.length) got++;
    } catch (err) {
      // Comments are a bonus. Never let one bad thread cost the whole digest.
    }
  });
  diagnostics.push(' ok   comments on ' + got + '/' + targets.length + ' posts');
}

// ---------------------------------------------------------------------------
// Hacker News (Algolia search — free, no key)
// ---------------------------------------------------------------------------
function hnRequest(query) {
  var since = Math.floor((Date.now() - 48 * 3600000) / 1000);
  return {
    url: 'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=15' +
         '&numericFilters=created_at_i>' + since + ',points>20' +
         '&query=' + encodeURIComponent(query),
    muteHttpExceptions: true,
    headers: { 'User-Agent': UA },
  };
}

function parseHn(result) {
  if (result.error) return [];
  try {
    return (JSON.parse(result.body).hits || []).map(function (h) {
      if (!h.objectID) return null;
      return {
        id: 'hn_' + h.objectID,
        source: 'hn',
        sub: 'HackerNews',
        title: String(h.title || ''),
        url: 'https://news.ycombinator.com/item?id=' + h.objectID,
        body: cleanText(h.story_text || '').slice(0, 2000),
        domain: String(h.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
        flair: '',
        score: Number(h.points) || 0,
        numComments: Number(h.num_comments) || 0,
        created: (Number(h.created_at_i) || 0) * 1000,
        stickied: false,
        nsfw: false,
        hasMetrics: true,
        comments: [],
        fp: fingerprint(h.title),
      };
    }).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Weather (Open-Meteo — free, no key). Rendered verbatim, never through the LLM.
// ---------------------------------------------------------------------------
function fetchWeather(diagnostics) {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + WEATHER.lat +
    '&longitude=' + WEATHER.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,' +
    'precipitation_probability_max,wind_speed_10m_max' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3';

  var r = fetchBatch([{ url: url, muteHttpExceptions: true }])[0];
  if (r.error) {
    diagnostics.push('FAIL  weather — ' + r.error);
    return null;
  }
  try {
    var d = JSON.parse(r.body).daily;
    var days = d.time.map(function (iso, i) {
      var day = {
        iso: iso,
        name: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayName(iso),
        code: d.weather_code[i],
        hi: Math.round(d.temperature_2m_max[i]),
        lo: Math.round(d.temperature_2m_min[i]),
        rain: Math.round(d.precipitation_probability_max[i]),
        wind: Math.round(d.wind_speed_10m_max[i]),
      };
      day.sky = skyLabel(day.code);
      day.verdict = detailingVerdict(day);
      return day;
    });
    diagnostics.push(' ok   weather (' + days.length + ' days)');
    return { days: days, today: days[0] };
  } catch (err) {
    diagnostics.push('FAIL  weather — ' + err);
    return null;
  }
}

/**
 * Turns a forecast into the only question that matters on a work morning:
 * can I wash cars today, and what will bite me if I do?
 */
function detailingVerdict(day) {
  if (day.rain >= 60) return { label: 'Washout', tone: 'bad', note: day.rain + '% rain — interiors, coatings cure indoors' };
  if (day.hi <= 38) return { label: 'Too cold', tone: 'bad', note: 'Highs ' + day.hi + '° — most sealants and ceramics will not flash' };
  if (day.rain >= 30) return { label: 'Risky', tone: 'warn', note: day.rain + '% rain — keep jobs short, watch the radar' };
  if (day.wind >= 20) return { label: 'Windy', tone: 'warn', note: day.wind + ' mph — grit and fast drying, rinse panel by panel' };
  if (day.hi >= 88) return { label: 'Hot', tone: 'warn', note: day.hi + '° — work shaded panels, water spots set fast' };
  if (day.hi >= 60 && day.rain < 20) return { label: 'Prime', tone: 'good', note: day.hi + '° and dry — best day of the three for paint work' };
  return { label: 'Workable', tone: 'good', note: day.hi + '°, ' + day.rain + '% rain' };
}

function skyLabel(code) {
  if (code === 0) return '☀️ Clear';
  if (code <= 2) return '🌤️ Mostly sunny';
  if (code === 3) return '☁️ Overcast';
  if (code <= 48) return '🌫️ Fog';
  if (code <= 57) return '🌦️ Drizzle';
  if (code <= 67) return '🌧️ Rain';
  if (code <= 77) return '🌨️ Snow';
  if (code <= 82) return '🌧️ Showers';
  if (code <= 86) return '🌨️ Snow showers';
  return '⛈️ Storms';
}

// ---------------------------------------------------------------------------
// Summarize — one Gemini call per topic, all fired in parallel
// ---------------------------------------------------------------------------
//
// One giant call was the fragile part of this script: a single truncation,
// safety block or 503 lost the entire email, and 30-odd posts of material
// pushed the JSON close to the output ceiling. Per topic, a failure costs one
// section (which falls back to a plain listing) and each response is small
// enough that truncation stops being a live risk. fetchAll keeps the wall time
// at roughly one call regardless.
//
// Two changes carry most of the quality gain over the previous version:
//   `refs` is a list, not one integer, so the model can fuse the four threads
//   that are all about the same patch into one write-up that cites all four;
//   and every item carries a kicker + tag + "why it matters", which is what
//   turns a wall of paragraphs into something skimmable at 7am.
// ---------------------------------------------------------------------------
const TAGS = { DEAL: 1, NEW: 1, VERDICT: 1, 'HEADS-UP': 1, TIP: 1, DEBATE: 1 };

const TOPIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    roundup: { type: 'STRING', description: '2-4 sentences on the overall theme and mood of this section.' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          refs: {
            type: 'ARRAY',
            description: 'The [n] numbers this item is built from. Use several when threads cover the same story.',
            items: { type: 'INTEGER' },
          },
          tag: { type: 'STRING', description: 'One of: DEAL, NEW, VERDICT, HEADS-UP, TIP, DEBATE.' },
          headline: { type: 'STRING', description: 'Under 10 words, states the finding itself, not the topic.' },
          point: { type: 'STRING', description: 'The full retelling, 4-7 sentences, with the specifics.' },
          why: { type: 'STRING', description: 'One sentence: what he should do or watch because of this.' },
          importance: { type: 'INTEGER', description: '1-5, how much this matters to him specifically.' },
        },
        required: ['refs', 'tag', 'headline', 'point', 'why', 'importance'],
      },
    },
  },
  required: ['roundup', 'items'],
};

const BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One concrete sentence naming the single most useful thing in here.' },
    bullets: {
      type: 'ARRAY',
      description: 'Exactly three, each under 18 words, most actionable first.',
      items: { type: 'STRING' },
    },
  },
  required: ['headline', 'bullets'],
};

function summarize(sections, diagnostics) {
  var key = apiKey();
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings → Script Properties.');

  // A small thinking budget measurably improves how well it separates signal
  // from filler. The old script set it to zero purely to avoid truncation —
  // raising the output ceiling well above what a section needs buys the
  // quality back without reintroducing that risk.
  var results = fetchBatch(sections.map(function (s) {
    return geminiRequest(key, topicPrompt(s), TOPIC_SCHEMA, 16384, 1024);
  }));

  var parsedAll = results.map(readGemini);

  // One retry for whatever failed, with thinking off and a bigger ceiling —
  // that combination clears both of the failures we actually see (MAX_TOKENS
  // and transient 5xx) without a second full round for everyone.
  var retryIdx = [];
  parsedAll.forEach(function (p, i) { if (p.error) retryIdx.push(i); });
  if (retryIdx.length) {
    var retries = fetchBatch(retryIdx.map(function (i) {
      return geminiRequest(key, topicPrompt(sections[i]), TOPIC_SCHEMA, 24576, 0);
    }));
    retryIdx.forEach(function (i, k) {
      var again = readGemini(retries[k]);
      diagnostics.push((again.error ? 'FAIL  ' : ' ok   ') + 'retry ' +
        sections[i].topic.label + (again.error ? ' — ' + again.error : ''));
      if (!again.error) parsedAll[i] = again;
    });
  }

  var topics = sections.map(function (s, i) {
    var parsed = parsedAll[i];
    if (parsed.error) {
      diagnostics.push('FAIL  summary ' + s.topic.label + ' — ' + parsed.error);
      return { label: s.topic.label, roundup: '', items: null };  // null → fallback listing
    }
    var items = (parsed.value.items || []).slice().sort(function (a, b) {
      return (Number(b.importance) || 0) - (Number(a.importance) || 0);
    });
    return { label: s.topic.label, roundup: parsed.value.roundup || '', items: items };
  });

  // The brief is deliberately not written here. It reads best when it is built
  // from the finished write-ups, which only exist once rendering has resolved
  // refs and dropped whatever did not survive — see render().
  return { headline: '', bullets: [], topics: topics };
}

function topicPrompt(section) {
  var lines = [];
  section.items.forEach(function (p, i) {
    lines.push('\n[' + (i + 1) + '] ' + p.title);
    lines.push('    source: ' + (p.source === 'hn' ? 'Hacker News' : 'r/' + p.sub) +
      ' · ' + p.score + ' points · ' + p.numComments + ' comments · ' + ageLabel(p.created) +
      (p.flair ? ' · flair: ' + p.flair : '') +
      (p.domain ? ' · links to ' + p.domain : ''));
    if (p.body) lines.push('    post: ' + p.body);
    p.comments.forEach(function (c) {
      lines.push('    comment (+' + c.score + '): ' + c.text);
    });
  });

  return 'You are writing one section of a personal morning briefing for Mikey, who runs a ' +
    'mobile car-detailing business in Snohomish County, WA. He shops Harbor Freight, wrenches ' +
    'on vehicles, plays Overwatch 2, and pays for Claude.\n\n' +
    'This section is "' + section.topic.label + '". What matters here: ' + section.topic.hint + '\n\n' +
    'THE MOST IMPORTANT RULE: this email is the whole read, not a table of contents. He should ' +
    'never have to click a link to understand what happened. Retell the actual content — the ' +
    'specifics, the numbers, the argument, what people concluded. If a post compares two ' +
    'products, say which won and by how much. If there is a deal, give the price and the catch. ' +
    'A teaser like "detailers debated ceramic coatings" is a failure; write the substance.\n\n' +
    'Rules:\n' +
    '- "point" is a real paragraph, roughly 4 to 7 sentences. Plain language, no filler.\n' +
    '- Lead with the actual point, not "a user posted that". He knows where it came from.\n' +
    '- "headline" states the finding itself — "Bauer 20V impact strips lug nuts at 450 ft-lb", ' +
    'not "impact wrench discussion". Under 10 words.\n' +
    '- The comments are often more valuable than the post, and their scores tell you how much ' +
    'the room agreed. Where they contradict, debunk or add a caveat, work that in and say so.\n' +
    '- Point counts and comment counts are given per post. A thread with heavy discussion and ' +
    'modest points is usually the more interesting one — weight it accordingly.\n' +
    '- Be specific: product names, prices, model numbers, patch numbers, real disagreements.\n' +
    '- Skip memes, rants and photos with no information. Fewer, meatier items beat padding. ' +
    'Return an empty items list if nothing here was worth his time.\n' +
    '- "why" is one sentence on what he should do, buy, avoid or watch. No restating the point.\n' +
    '- "tag" is exactly one of DEAL, NEW, VERDICT, HEADS-UP, TIP, DEBATE.\n' +
    '- "importance" is 1-5 for how much this matters to *him* — a working detailer who wrenches, ' +
    'games and pays for Claude. Not how popular the thread was.\n' +
    '- Never invent a fact that is not in the material below. If the material is thin, say less.\n' +
    '- "refs" holds the [n] numbers you used. When several threads cover the same story, write ' +
    'ONE item and list all of their numbers. Never use the same number in two items.\n\n' +
    'MATERIAL:\n' + lines.join('\n');
}

/** The top-of-email brief: one headline plus the three things worth knowing. */
function briefFor(key, topics, diagnostics) {
  var points = [];
  topics.forEach(function (t) {
    (t.items || []).forEach(function (it) {
      points.push('- [' + t.label + '] ' + (it.headline || '') + ' — ' + (it.why || it.point || ''));
    });
  });
  if (!points.length) return { headline: '', bullets: [] };

  var res = fetchBatch([geminiRequest(key,
    'Below are the write-ups in one morning briefing for a mobile car detailer who also ' +
    'wrenches, games and pays for Claude.\n\n' +
    'Reply with JSON: a "headline" of one concrete sentence naming the single most useful ' +
    'thing in here, and "bullets", exactly three, each under 18 words, ordered most ' +
    'actionable first. Name the actual thing — the product, the price, the patch. ' +
    'No hype, no "here is your briefing", no bullet that just points at a section.\n\n' +
    points.join('\n'),
    BRIEF_SCHEMA, 1024, 0)])[0];

  var parsed = readGemini(res);
  if (parsed.error) {
    diagnostics.push('FAIL  brief — ' + parsed.error);
    return { headline: '', bullets: [] };
  }
  return {
    headline: parsed.value.headline || '',
    bullets: (parsed.value.bullets || []).slice(0, 3),
  };
}

function apiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function geminiRequest(key, prompt, schema, maxTokens, thinkingBudget) {
  return {
    // The key goes in a header, not the query string: a thrown error or a
    // logged URL would otherwise carry the key with it.
    url: 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        // Long-form by design. A low ceiling here is the thing that quietly
        // turns the digest back into headlines.
        maxOutputTokens: maxTokens,
        // The schema is enforced server-side, so a malformed shape stops being
        // a thing the renderer has to survive.
        responseMimeType: 'application/json',
        responseSchema: schema,
        // 2.5 "thinks" by default and those hidden tokens come out of the
        // output budget. Kept small and paired with a high ceiling, so it can
        // triage the material without truncating long JSON mid-object.
        thinkingConfig: { thinkingBudget: thinkingBudget },
      },
    }),
  };
}

/** Unwraps a Gemini response into {value} or {error} — never throws. */
function readGemini(result) {
  if (result.error) return { error: 'Gemini ' + result.error + ': ' + result.body.slice(0, 200) };
  try {
    var body = JSON.parse(result.body);
    if (body.promptFeedback && body.promptFeedback.blockReason) {
      return { error: 'blocked: ' + body.promptFeedback.blockReason };
    }
    var cand = body.candidates && body.candidates[0];
    if (!cand) return { error: 'no candidates' };
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      // MAX_TOKENS here means the JSON is cut mid-object; parsing it would
      // throw somewhere far less obvious than this line.
      return { error: 'finishReason ' + cand.finishReason };
    }
    var parts = cand.content && cand.content.parts;
    if (!parts || !parts.length) return { error: 'empty response' };
    return { value: JSON.parse(parts[0].text) };
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// HTTP — parallel, with backoff on the codes worth retrying
// ---------------------------------------------------------------------------
const RETRYABLE = { 0: true, 429: true, 500: true, 502: true, 503: true, 504: true };

/**
 * fetchAll runs the whole batch concurrently, so a dozen subreddits cost about
 * one round trip instead of a dozen. Failures retry with backoff; a batch-level
 * throw falls back to one-at-a-time so a single bad URL cannot take the rest
 * down with it.
 */
function fetchBatch(requests) {
  var results = new Array(requests.length);
  var pending = requests.map(function (_, i) { return i; });
  var wait = 1500;

  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt > 0) { Utilities.sleep(wait); wait *= 3; }

    var batch = pending.map(function (i) { return requests[i]; });
    var responses = null;
    try {
      responses = UrlFetchApp.fetchAll(batch);
    } catch (err) {
      responses = null;
    }

    var next = [];
    for (var j = 0; j < batch.length; j++) {
      var idx = pending[j];
      var r;
      if (responses) {
        r = readResponse(responses[j]);
      } else {
        try { r = readResponse(UrlFetchApp.fetch(batch[j].url, batch[j])); }
        catch (e) { r = { code: 0, body: String(e), error: String(e) }; }
      }
      results[idx] = r;
      if (RETRYABLE[r.code]) next.push(idx);
    }
    pending = next;
  }
  return results;
}

function readResponse(res) {
  var code = res.getResponseCode();
  var body = res.getContentText();
  return { code: code, body: body, error: code === 200 ? null : 'HTTP ' + code };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const C = {
  page: '#f6f6f4', card: '#ffffff', ink: '#111111', body: '#2a2a2a',
  soft: '#5a5a5a', faint: '#9a9a9a', rule: '#e4e4e0', wash: '#f4f4f1',
  good: '#1f7a45', warn: '#a86400', bad: '#b02a2a',
};

const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif';

function render(sections, summary, weather, diagnostics, key) {
  var blocks = [];
  var textLines = [];
  var ids = [];
  var fingerprints = [];
  var byLabel = {};
  (summary.topics || []).forEach(function (t) { byLabel[t.label] = t; });

  var totalItems = 0;

  sections.forEach(function (section) {
    var t = byLabel[section.topic.label] || { items: null };
    var rowsData;

    if (t.items === null) {
      // The summary call failed for this topic. A bare listing still beats a
      // hole in the email, and it says so rather than pretending.
      rowsData = section.items.map(function (p) {
        return {
          posts: [p],
          headline: p.title,
          tag: '',
          point: p.body ? truncateWords(p.body, 500) : (p.domain ? 'Link post → ' + p.domain : '(no post text)'),
          why: '',
        };
      });
    } else {
      // The model answers with reference numbers, never URLs, so it cannot
      // invent a link. Titles and links are resolved here from our own data,
      // and an out-of-range ref is simply dropped.
      var used = {};
      rowsData = (t.items || []).map(function (it) {
        var posts = (it.refs || []).map(function (n) {
          return section.items[Number(n) - 1];
        }).filter(function (p) {
          if (!p || used[p.id]) return false;
          used[p.id] = true;
          return true;
        });
        return {
          posts: posts,
          headline: String(it.headline || '').trim(),
          tag: TAGS[String(it.tag || '').toUpperCase()] ? String(it.tag).toUpperCase() : '',
          point: String(it.point || '').trim(),
          why: String(it.why || '').trim(),
        };
      }).filter(function (x) { return x.posts.length && x.point; });
    }
    if (!rowsData.length) return;

    var degraded = t.items === null;
    var roundup = degraded ? 'Summary unavailable for this section — raw posts below.' : (t.roundup || '');
    totalItems += rowsData.length;

    textLines.push('\n' + repeat('=', 68) + '\n' + section.topic.label +
      '  (' + rowsData.length + ')\n' + repeat('=', 68));
    if (roundup) textLines.push(wrap(roundup, 68));

    var rows = rowsData.map(function (x, i) {
      x.posts.forEach(function (p) { ids.push(p.id); fingerprints.push(p.fp); });
      var head = x.headline || x.posts[0].title;

      textLines.push('\n' + (i + 1) + '. ' + (x.tag ? '[' + x.tag + '] ' : '') + head);
      textLines.push(wrap(x.point, 68, '   '));
      if (x.why) textLines.push(wrap('→ ' + x.why, 68, '   '));
      x.posts.forEach(function (p) {
        textLines.push('   ' + metaText(p) + '\n     ' + p.url);
      });

      return '<tr><td class="d-tile" style="padding:16px 16px 14px;background:' + C.wash +
          ';border-radius:10px;">' +
        (x.tag ? tagPill(x.tag) : '') +
        '<div class="d-ink" style="font-size:16px;font-weight:700;line-height:1.4;color:' +
          C.ink + ';margin:' + (x.tag ? '8px' : '0') + ' 0 8px;">' + esc(head) + '</div>' +
        paragraphs(x.point) +
        (x.why ? '<div class="d-why" style="font-size:14px;line-height:1.6;color:' + C.ink +
          ';background:#fff;border-left:3px solid ' + C.ink + ';padding:8px 12px;margin-top:10px;' +
          'border-radius:0 6px 6px 0;"><b>Why it matters:</b> ' + esc(x.why) + '</div>' : '') +
        '<div class="d-faint" style="font-size:11px;color:' + C.faint + ';margin-top:10px;">' +
          x.posts.map(sourceLink).join(' &nbsp;·&nbsp; ') + '</div>' +
        '</td></tr><tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>';
    }).join('');

    blocks.push(
      '<tr><td style="padding:30px 0 4px;border-top:2px solid ' + C.rule + ';">' +
        '<div class="d-ink" style="font-size:19px;font-weight:700;color:' + C.ink + ';">' +
          esc(section.topic.label) +
          '<span class="d-faint" style="font-weight:400;font-size:13px;color:' + C.faint +
            ';"> &nbsp;' + rowsData.length + '</span></div>' +
        (roundup ? '<div class="d-soft" style="font-size:14px;color:' + C.soft +
          ';margin-top:8px;line-height:1.65;">' + esc(roundup) + '</div>' : '') +
      '</td></tr>' +
      '<tr><td style="padding-top:16px;"><table width="100%" cellpadding="0" cellspacing="0">' +
        rows + '</table></td></tr>');
  });

  // The brief is written last, from the finished write-ups, so it can name the
  // single best thing in the email rather than guessing from raw posts.
  if (key && totalItems) {
    var brief = briefFor(key, summary.topics, diagnostics);
    summary.headline = brief.headline;
    summary.bullets = brief.bullets;
  }

  var html =
    darkModeStyles() +
    // Preheader: what the inbox preview line shows instead of "Morning rundown ·".
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' +
      esc(summary.headline || (weather ? weather.today.verdict.note : todayLabel())) + '</div>' +
    '<table class="d-page" width="100%" cellpadding="0" cellspacing="0" style="background:' +
      C.page + ';padding:24px 12px;">' +
    '<tr><td align="center"><table class="d-card" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="max-width:660px;background:' + C.card + ';border-radius:12px;padding:30px 26px 30px;' +
      'font-family:' + FONT + ';">' +
    headerBlock(summary) +
    (weather ? weatherBlock(weather) : '') +
    blocks.join('') +
    footerBlock(diagnostics) +
    '</table></td></tr></table>';

  var plain = 'MORNING RUNDOWN — ' + todayLabel() +
    (summary.headline ? '\n\n' + wrap(summary.headline, 68) : '') +
    (summary.bullets && summary.bullets.length
      ? '\n\n' + summary.bullets.map(function (b, i) {
          return wrap((i + 1) + '. ' + b, 68);
        }).join('\n')
      : '') +
    (weather ? '\n\n' + weatherText(weather) : '') +
    '\n' + textLines.join('\n');

  return { html: html, text: plain, ids: ids, fingerprints: fingerprints };
}

function headerBlock(summary) {
  var bullets = (summary.bullets || []).map(function (b, i) {
    return '<tr><td valign="top" style="padding:0 10px 7px 0;font-size:13px;font-weight:700;color:' +
        C.faint + ';width:16px;">' + (i + 1) + '</td>' +
      '<td class="d-body" style="padding:0 0 7px;font-size:14px;line-height:1.5;color:' +
        C.body + ';">' + esc(b) + '</td></tr>';
  }).join('');

  return '<tr><td>' +
    '<div class="d-faint" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' +
      C.faint + ';">Morning rundown · ' + esc(todayLabel()) + '</div>' +
    (summary.headline ? '<div class="d-ink" style="font-size:22px;line-height:1.38;font-weight:700;color:' +
      C.ink + ';margin-top:12px;">' + esc(summary.headline) + '</div>' : '') +
    (bullets ? '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">' +
      bullets + '</table>' : '') +
    '</td></tr>';
}

/** Three days, colour-coded, with the working verdict spelled out. */
function weatherBlock(weather) {
  var cells = weather.days.map(function (d) {
    var tone = d.verdict.tone === 'good' ? C.good : d.verdict.tone === 'warn' ? C.warn : C.bad;
    return '<td width="33%" valign="top" style="padding:0 6px;">' +
      '<div class="d-tile" style="background:' + C.wash + ';border-radius:8px;padding:12px 12px 11px;' +
        'border-top:3px solid ' + tone + ';">' +
      '<div class="d-faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:' +
        C.faint + ';">' + esc(d.name) + '</div>' +
      '<div class="d-ink" style="font-size:15px;font-weight:700;color:' + C.ink +
        ';margin-top:4px;">' + esc(d.sky) + '</div>' +
      '<div class="d-body" style="font-size:13px;color:' + C.body + ';margin-top:3px;">' +
        d.hi + '° / ' + d.lo + '° · 💧' + d.rain + '% · 💨' + d.wind + '</div>' +
      '<div style="font-size:12px;font-weight:700;color:' + tone + ';margin-top:7px;">' +
        esc(d.verdict.label) + '</div>' +
      '<div class="d-soft" style="font-size:11px;line-height:1.45;color:' + C.soft +
        ';margin-top:2px;">' + esc(d.verdict.note) + '</div>' +
      '</div></td>';
  }).join('');

  return '<tr><td style="padding:22px 0 4px;">' +
    '<div class="d-faint" style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' +
      C.faint + ';margin-bottom:9px;">Wash window · ' + esc(WEATHER.label) + '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' + cells + '</tr></table></td></tr>';
}

function weatherText(weather) {
  // Two lines per day rather than one wide row: a 68-column table plus the
  // verdict note runs past 80 characters, which every plain-text client then
  // hard-wraps into ragged garbage.
  return 'WASH WINDOW — ' + WEATHER.label + '\n' + weather.days.map(function (d) {
    return '  ' + pad(d.name, 10) + pad(d.sky, 17) + pad(d.hi + '/' + d.lo + 'F', 9) +
      pad(d.rain + '% rain', 10) + d.verdict.label +
      '\n' + wrap(d.verdict.note, 68, '    ');
  }).join('\n');
}

function footerBlock(diagnostics) {
  var fails = diagnostics.filter(function (d) { return d.indexOf('FAIL') === 0; }).length;
  var oks = diagnostics.length - fails;
  return '<tr><td style="padding:26px 0 0;border-top:2px solid ' + C.rule + ';">' +
    '<div class="d-faint" style="font-size:11px;color:' + C.faint + ';line-height:1.6;">' +
      oks + ' sources read' + (fails ? ' · ' + fails + ' unavailable' : '') +
      ' · built ' + esc(nowLabel()) +
    '</div></td></tr>';
}

function tagPill(tag) {
  return '<span class="d-pill" style="display:inline-block;font-size:10px;font-weight:700;' +
    'letter-spacing:.07em;padding:3px 8px;border-radius:4px;background:' + C.ink +
    ';color:#fff;">' + esc(tag) + '</span>';
}

function sourceLink(p) {
  return (p.source === 'hn' ? 'HN' : 'r/' + esc(p.sub)) +
    (p.hasMetrics ? ' · ↑' + p.score + ' · 💬' + p.numComments : '') +
    ' · ' + esc(ageLabel(p.created)) +
    ' · <a class="d-link" href="' + esc(p.url) + '" style="color:' + C.faint + ';">thread</a>';
}

function metaText(p) {
  return (p.source === 'hn' ? 'HN' : 'r/' + p.sub) +
    (p.hasMetrics ? ' · ' + p.score + ' pts · ' + p.numComments + ' comments' : '') +
    ' · ' + ageLabel(p.created);
}

/**
 * Inline styles are the only thing every mail client honours, so they carry the
 * light theme. This block upgrades the clients that do support media queries —
 * without it the card backgrounds get auto-inverted into something unreadable.
 * `!important` is required: inline styles otherwise win.
 */
function darkModeStyles() {
  return '<meta name="color-scheme" content="light dark">' +
    '<style>@media (prefers-color-scheme: dark){' +
    '.d-page{background:#15161a!important}' +
    '.d-card{background:#1e1f25!important}' +
    '.d-ink{color:#f2f2f0!important}' +
    '.d-body{color:#d6d6d2!important}' +
    '.d-soft{color:#a9a9a4!important}' +
    '.d-tile{background:#26272e!important}' +
    '.d-faint{color:#868681!important}' +
    '.d-why{background:#1e1f25!important;border-left-color:#f2f2f0!important;color:#f2f2f0!important}' +
    '.d-pill{background:#f2f2f0!important;color:#15161a!important}' +
    '.d-link{color:#868681!important}' +
    '}</style>';
}

/** A 4-7 sentence write-up often arrives as two paragraphs; keep the break. */
function paragraphs(s) {
  return String(s || '').split(/\n{2,}/).map(function (para) {
    return '<div class="d-body" style="font-size:15px;line-height:1.7;color:' + C.body +
      ';margin-bottom:8px;">' + esc(para.trim()) + '</div>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Seen-list
// ---------------------------------------------------------------------------
//
// Stored as "id~day,id~day", not JSON. A Script Property caps at 9KB, and
// {"t3_1abcdef":20321} costs ~22 bytes per entry against ~14 for the packed
// form — enough that a JSON map of 500 ids would silently fail to save. Days
// are days-since-epoch so entries can expire instead of only being trimmed.
// ---------------------------------------------------------------------------
function loadSeen() {
  return { ids: unpackSeen(SEEN_IDS_KEY), fps: unpackSeen(SEEN_FP_KEY) };
}

function unpackSeen(key) {
  var map = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(key) || '';
    var cutoff = today() - SEEN_DAYS;
    raw.split(',').forEach(function (chunk) {
      var at = chunk.lastIndexOf('~');
      if (at < 1) return;
      var day = Number(chunk.slice(at + 1));
      if (day >= cutoff) map[chunk.slice(0, at)] = day;
    });
  } catch (err) { /* an unreadable seen-list must not stop the digest */ }
  return map;
}

function rememberSeen(ids, fingerprints) {
  packSeen(SEEN_IDS_KEY, ids);
  packSeen(SEEN_FP_KEY, fingerprints);
}

function packSeen(key, fresh) {
  try {
    var map = unpackSeen(key);          // already expired-filtered
    var day = today();
    (fresh || []).forEach(function (v) { if (v) map[v] = day; });

    var entries = Object.keys(map).map(function (k) { return { k: k, d: map[k] }; })
      .sort(function (a, b) { return a.d - b.d; })  // oldest first, so slice keeps the newest
      .slice(-SEEN_MAX)
      .map(function (e) { return e.k + '~' + e.d; });

    PropertiesService.getScriptProperties().setProperty(key, entries.join(','));
  } catch (err) { /* a full seen-list is not worth failing a send over */ }
}

/**
 * Collapses a title to its distinctive words, sorted, so the same story posted
 * to two subs with reworded headlines still collides. Crossposts already share
 * an id; this catches the ones that don't.
 *
 * The result is hashed rather than kept as words. Six words average ~35 bytes,
 * which puts 500 of them at ~18KB — double the 9KB Script Property ceiling, so
 * the whole fingerprint list would silently fail to save. Seven base-36 chars
 * fit the same 500 in about 6KB, and hashing also guarantees the `,` and `~`
 * that delimit the packed list can never appear inside a key.
 */
const STOP = {};
'the a an and or of for to in on at is are was be with my your this that new i it if how why what when'
  .split(' ').forEach(function (w) { STOP[w] = 1; });

function fingerprint(title) {
  var words = String(title || '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    // Numbers survive at any length, and short words do not. A price, a patch
    // number or a year is the most distinguishing token a title has — dropping
    // them made "Patch 12 notes" and "Patch 13 notes" the same fingerprint, so
    // the second one got silently deduped away as a repost.
    .filter(function (w) { return (w.length > 3 || /^\d+$/.test(w)) && !STOP[w]; });
  var basis = words.slice(0, 6).sort().join(' ') ||
    String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return basis ? hash32(basis) : '';
}

/** FNV-1a. Not cryptographic — it only has to make accidental collisions rare. */
function hash32(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------
// Failure notice
// ---------------------------------------------------------------------------
function notifyFailure(err) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(FAIL_NOTICE_KEY) === String(today())) return;  // one a day, max
    props.setProperty(FAIL_NOTICE_KEY, String(today()));
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: '⚠️ Morning rundown failed to build',
      body: 'The digest threw before it could send:\n\n' + String(err && err.stack || err) +
        '\n\nOpen the Apps Script execution log for the full trace, or run ' +
        '`healthCheck` to see which piece is down.',
      name: 'Morning Rundown',
    });
  } catch (e) { /* if even this fails, the log is the last resort */ }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function text(el) { return el ? el.getText() : ''; }
function repeat(s, n) { return new Array(n + 1).join(s); }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + repeat(' ', n - s.length); }
function today() { return Math.floor(Date.now() / 86400000); }

/** Only http(s) ever reaches an href. */
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
}

/** Markdown noise and zero-width junk make the prompt longer without adding meaning. */
function cleanText(s) {
  return String(s || '')
    .replace(/​/g, '')
    .replace(/&amp;#x200B;/g, '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^&gt;/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reddit's Atom <content> is HTML wrapped in XML entities. XmlService decodes
 * one layer for us, but how many layers are left varies, so stripping and
 * decoding once in either order can leave live markup in the text. Alternating
 * twice handles both depths.
 */
function stripHtml(s) {
  var out = String(s || '');
  for (var i = 0; i < 2; i++) {
    out = decodeEntities(out.replace(/<[^>]+>/g, ' '));
  }
  return out.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;|&#32;/g, ' ')
    .replace(/&amp;/g, '&');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateWords(s, max) {
  s = String(s || '').trim();
  if (s.length <= max) return s;
  var cut = s.slice(0, max), sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/** Hard-wraps for the plain-text part, which no client will wrap sensibly. */
function wrap(s, width, indent) {
  indent = indent || '';
  var out = [], line = indent;
  String(s || '').split(/\s+/).forEach(function (w) {
    if (line.length + w.length + 1 > width && line.trim()) {
      out.push(line);
      line = indent + w;
    } else {
      line = line.trim() ? line + ' ' + w : indent + w;
    }
  });
  if (line.trim()) out.push(line);
  return out.join('\n');
}

function ageLabel(ms) {
  var h = Math.round((Date.now() - ms) / 3600000);
  if (!ms || h < 0) return 'just now';
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function dayName(iso) {
  var parts = String(iso).split('-');
  return Utilities.formatDate(
    new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
    Session.getScriptTimeZone(), 'EEEE');
}

function todayLabel() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEEE, MMMM d');
}

function nowLabel() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'h:mm a');
}
