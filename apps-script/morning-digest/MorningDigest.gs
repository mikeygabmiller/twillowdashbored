/**
 * MORNING DIGEST — Reddit → Gemini → your inbox, on Google Apps Script.
 *
 * FIRST TIME SETUP (three things, all in this editor):
 *   1. Project Settings (gear, left side) → Script Properties → Add:
 *        GEMINI_API_KEY  =  your key
 *      Never paste the key into this file. A key in code leaks the moment you
 *      share the script.
 *   2. Project Settings → set the script timezone to your local zone,
 *      otherwise SEND_HOUR below is interpreted in the wrong timezone.
 *   3. Pick `setup` in the function dropdown above and hit Run. That creates
 *      the daily trigger. Run it again any time to change the hour.
 *
 * To try it right now: pick `previewToLog` and Run, then open the execution
 * log. That builds the whole digest without emailing you.
 */

const SEND_HOUR = 7;          // 24h, in the script's timezone
const POSTS_PER_SUB = 8;      // how many top posts to pull per subreddit
const ITEMS_PER_TOPIC = 5;    // default items per topic; a topic can override with `max`
const COMMENT_POSTS = 12;     // how many posts get their comments pulled
const COMMENTS_PER_POST = 4;

const MODEL = 'gemini-2.5-flash';
const SEEN_KEY = 'digest_seen_ids';
const SEEN_LIMIT = 400;       // ~a week; well inside the 9KB-per-property limit
const UA = 'MorningDigest/2.0 (personal use)';

// Grouping subreddits into topics (rather than one flat list) is what lets the
// summarizer write a coherent section per subject instead of one mixed blob.
// `hint` tells it what's actually useful about that topic. `max` is optional.
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
  },
  {
    label: '🤖 Anthropic & Claude',
    subs: ['ClaudeAI', 'Anthropic'],
    hint: 'Model releases, feature and pricing changes, usage limits, outages, and genuinely useful workflow tips. Call out anything that changes what a paying subscriber gets.',
  },
];

const ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
function setup() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendMorningDigest'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('sendMorningDigest')
    .timeBased().atHour(SEND_HOUR).everyDays(1).create();

  Logger.log('Daily trigger set for ~%s:00 (%s). Apps Script fires within an ' +
    'hour of that time, not on the dot.', SEND_HOUR, Session.getScriptTimeZone());
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
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: built.subject,
      htmlBody: built.html,   // htmlBody, not body — otherwise formatting arrives as raw markup
      body: built.text,       // plain-text fallback for clients that want it
      name: 'Morning Rundown',
    });
    rememberSeen(built.ids);
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

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function buildDigest(opts) {
  opts = opts || {};
  var seen = opts.dryRun ? {} : loadSeen();
  var diagnostics = [];

  var byTopic = collectPosts(seen, diagnostics);
  var sections = [];
  byTopic.forEach(function (items, ti) {
    if (items.length) sections.push({ topic: TOPICS[ti], items: items });
  });

  if (!sections.length) {
    return { ok: false, reason: 'no posts fetched', diagnostics: diagnostics };
  }

  // Comments are where the real verdict lives. Spend the budget round-robin
  // across topics — taking the first N in topic order starved every topic past
  // the second. Each is one more HTTP call; Apps Script allows 20,000/day.
  attachComments(pickForComments(sections, COMMENT_POSTS), diagnostics);

  var summary = summarize(sections, diagnostics);
  var rendered = render(sections, summary);

  if (!rendered.ids.length) {
    return { ok: false, reason: 'summarizer returned nothing usable', diagnostics: diagnostics };
  }

  return {
    ok: true,
    subject: '☕ Morning rundown — ' + truncateWords(summary.headline || todayLabel(), 80),
    html: rendered.html,
    text: rendered.text,
    // Only what actually shipped. Marking dropped posts as seen buries a good
    // post forever just because the model skipped it once.
    ids: rendered.ids,
    diagnostics: diagnostics,
  };
}

/**
 * Fetches every subreddit in one parallel round, then interleaves each topic's
 * subs. Straight concatenation let the first sub fill the whole topic — with
 * two subs and 5 slots, the second sub never appeared.
 */
function collectPosts(seen, diagnostics) {
  var reqs = [], meta = [];
  TOPICS.forEach(function (topic, ti) {
    topic.subs.forEach(function (sub) {
      reqs.push(redditRequest(subredditUrl(sub, 'day')));
      meta.push({ ti: ti, sub: sub, window: 'day' });
    });
  });

  var results = fetchBatch(reqs);
  var posts = results.map(function (r, i) { return parseEntries(r, meta[i].sub); });

  // A quiet sub can have almost nothing in a 24h window. Widen those to a week
  // rather than letting the topic go empty.
  var retryIdx = [];
  posts.forEach(function (list, i) { if (list.length < 2) retryIdx.push(i); });
  if (retryIdx.length) {
    var retryRes = fetchBatch(retryIdx.map(function (i) {
      return redditRequest(subredditUrl(meta[i].sub, 'week'));
    }));
    retryIdx.forEach(function (i, k) {
      var widened = parseEntries(retryRes[k], meta[i].sub);
      if (widened.length > posts[i].length) {
        posts[i] = widened;
        meta[i].window = 'week';
      }
    });
  }

  results.forEach(function (r, i) {
    diagnostics.push((r.error ? 'FAIL  r/' : ' ok   r/') + meta[i].sub +
      (r.error ? ' — ' + r.error
               : ' (' + posts[i].length + ' @ ' + meta[i].window + ')'));
  });

  // Interleave per topic, skipping anything already seen or already claimed by
  // an earlier topic (subs can share a crosspost).
  var claimed = {};
  return TOPICS.map(function (topic, ti) {
    var lists = [];
    posts.forEach(function (list, i) { if (meta[i].ti === ti) lists.push(list); });
    var limit = topic.max || ITEMS_PER_TOPIC;
    var out = [], depth = 0, added = true;
    while (out.length < limit && added) {
      added = false;
      for (var k = 0; k < lists.length && out.length < limit; k++) {
        var p = lists[k][depth];
        if (!p) continue;
        added = true;
        if (seen[p.id] || claimed[p.id]) continue;
        claimed[p.id] = true;
        out.push(p);
      }
      depth++;
    }
    return out;
  });
}

/** Round-robin across topics so every section gets some comment coverage. */
function pickForComments(sections, budget) {
  var out = [], depth = 0, added = true;
  while (out.length < budget && added) {
    added = false;
    for (var i = 0; i < sections.length && out.length < budget; i++) {
      var p = sections[i].items[depth];
      if (!p) continue;
      out.push(p);
      added = true;
    }
    depth++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit (RSS — no API key, no OAuth)
// ---------------------------------------------------------------------------
function subredditUrl(sub, window) {
  return 'https://www.reddit.com/r/' + encodeURIComponent(sub) +
         '/top/.rss?t=' + window + '&limit=' + POSTS_PER_SUB;
}

function redditRequest(url) {
  return { url: url, muteHttpExceptions: true, headers: { 'User-Agent': UA } };
}

function parseEntries(result, sub) {
  if (result.error) return [];
  try {
    var entries = XmlService.parse(result.body).getRootElement().getChildren('entry', ATOM);
    var posts = [];
    for (var i = 0; i < entries.length && posts.length < POSTS_PER_SUB; i++) {
      var e = entries[i];
      var link = e.getChild('link', ATOM);
      var href = link && link.getAttribute('href') ? link.getAttribute('href').getValue() : '';
      var id = text(e.getChild('id', ATOM));
      if (!id) continue;
      posts.push({
        id: id,
        sub: sub,
        title: text(e.getChild('title', ATOM)),
        url: safeUrl(href),
        // THE FIX THAT MATTERS: the RSS <content> holds the post body. Without
        // it the summarizer only has headlines and has to guess or pad.
        body: stripHtml(text(e.getChild('content', ATOM))).slice(0, 1500),
        comments: [],
      });
    }
    return posts;
  } catch (err) {
    return [];
  }
}

/** Reddit serves a post's comment thread as Atom too: <post url> + ".rss". */
function attachComments(posts, diagnostics) {
  var targets = posts.filter(function (p) { return p.url; });
  if (!targets.length) return;

  var results = fetchBatch(targets.map(function (p) {
    return redditRequest(p.url.replace(/\/$/, '') + '/.rss?sort=top&limit=6');
  }));

  var got = 0;
  results.forEach(function (r, i) {
    if (r.error) return;
    try {
      var entries = XmlService.parse(r.body).getRootElement().getChildren('entry', ATOM);
      var post = targets[i];
      // Entry 0 is the post itself; the rest are comments, top-sorted.
      for (var j = 1; j < entries.length && post.comments.length < COMMENTS_PER_POST; j++) {
        var body = stripHtml(text(entries[j].getChild('content', ATOM)));
        if (body && body.length > 40) post.comments.push(body.slice(0, 600));
      }
      if (post.comments.length) got++;
    } catch (err) {
      // Comments are a bonus. Never let one bad thread cost the whole digest.
    }
  });
  diagnostics.push(' ok   comments on ' + got + '/' + targets.length + ' posts');
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
// ---------------------------------------------------------------------------
const TOPIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    roundup: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { ref: { type: 'INTEGER' }, point: { type: 'STRING' } },
        required: ['ref', 'point'],
      },
    },
  },
  required: ['roundup', 'items'],
};

function summarize(sections, diagnostics) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings → Script Properties.');

  var results = fetchBatch(sections.map(function (s) {
    return geminiRequest(key, topicPrompt(s), TOPIC_SCHEMA, 8192);
  }));

  var topics = sections.map(function (s, i) {
    var parsed = readGemini(results[i]);
    if (parsed.error) {
      diagnostics.push('FAIL  summary ' + s.topic.label + ' — ' + parsed.error);
      return { label: s.topic.label, roundup: '', items: null };  // null → fallback listing
    }
    return {
      label: s.topic.label,
      roundup: parsed.value.roundup || '',
      items: parsed.value.items || [],
    };
  });

  return { headline: headlineFor(key, topics, diagnostics), topics: topics };
}

function topicPrompt(section) {
  var lines = [];
  section.items.forEach(function (p, i) {
    lines.push('\n[' + (i + 1) + '] (r/' + p.sub + ') ' + p.title);
    if (p.body) lines.push('    post: ' + p.body);
    p.comments.forEach(function (c) { lines.push('    top comment: ' + c); });
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
    '- Every item gets a real paragraph, roughly 4 to 7 sentences. Plain language, no filler.\n' +
    '- Lead with the actual point, not "a user posted that". He knows it is from Reddit.\n' +
    '- The comments are often more valuable than the post. Where they contradict, debunk or add ' +
    'a caveat, work that in.\n' +
    '- Be specific: product names, prices, model numbers, patch numbers, real disagreements.\n' +
    '- Skip memes, rants and photos with no information. Fewer, meatier items beat padding. ' +
    'Return an empty items list if nothing here was worth his time.\n' +
    '- "roundup" is 2-4 sentences on the overall theme and mood of this section.\n' +
    '- Never invent a fact that is not in the material below.\n' +
    '- "ref" is the [n] number of the post you are writing about. Use each at most once.\n\n' +
    'MATERIAL:\n' + lines.join('\n');
}

function headlineFor(key, topics, diagnostics) {
  var points = [];
  topics.forEach(function (t) {
    (t.items || []).forEach(function (it) { points.push('- ' + it.point); });
  });
  if (!points.length) return '';

  var res = fetchBatch([geminiRequest(key,
    'Below are the write-ups in one morning briefing. Reply with JSON ' +
    '{"headline":"..."} — one sentence naming the single most useful thing in ' +
    'here for a mobile car detailer who also wrenches, games and pays for Claude. ' +
    'Be concrete; no hype, no "here is your briefing".\n\n' + points.join('\n'),
    { type: 'OBJECT', properties: { headline: { type: 'STRING' } }, required: ['headline'] },
    512)])[0];

  var parsed = readGemini(res);
  if (parsed.error) {
    diagnostics.push('FAIL  headline — ' + parsed.error);
    return '';
  }
  return parsed.value.headline || '';
}

function geminiRequest(key, prompt, schema, maxTokens) {
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
        responseMimeType: 'application/json',
        // The schema is enforced server-side, so a malformed shape stops being
        // a thing the renderer has to survive.
        responseSchema: schema,
        // 2.5 "thinks" by default and those hidden tokens come out of the
        // output budget, which truncates long JSON mid-object.
        thinkingConfig: { thinkingBudget: 0 },
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
 * fetchAll runs the whole batch concurrently, so 11 subreddits cost about one
 * round trip instead of eleven. Failures retry with backoff; a batch-level
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
function render(sections, summary) {
  var blocks = [];
  var textLines = [];
  var ids = [];
  var byLabel = {};
  (summary.topics || []).forEach(function (t) { byLabel[t.label] = t; });

  sections.forEach(function (section) {
    var t = byLabel[section.topic.label] || { items: null };
    var rowsData;

    if (t.items === null) {
      // The summary call failed for this topic. A bare listing still beats a
      // hole in the email, and it says so rather than pretending.
      rowsData = section.items.map(function (p) {
        return { post: p, point: p.body ? truncateWords(p.body, 400) : '(no post text)' };
      });
    } else {
      // The model answers with reference numbers, never URLs, so it cannot
      // invent a link. Titles and links are resolved here from our own data,
      // and an out-of-range ref is simply dropped.
      var used = {};
      rowsData = (t.items || []).map(function (it) {
        var n = Number(it.ref);
        return { post: section.items[n - 1], point: it.point };
      }).filter(function (x) {
        if (!x.post || !x.point || used[x.post.id]) return false;
        used[x.post.id] = true;
        return true;
      });
    }
    if (!rowsData.length) return;

    var degraded = t.items === null;
    var roundup = degraded ? 'Summary unavailable for this section — raw posts below.' : (t.roundup || '');

    textLines.push('\n\n' + repeat('=', 60) + '\n' + section.topic.label + '\n' + repeat('=', 60));
    if (roundup) textLines.push('\n' + roundup);

    var rows = rowsData.map(function (x) {
      ids.push(x.post.id);
      textLines.push('\n' + x.post.title + '\n' + x.point + '\n  ↳ ' + x.post.url);
      return '<tr><td style="padding:0 0 26px;">' +
        '<div style="font-size:15px;font-weight:600;line-height:1.45;color:#111;margin-bottom:7px;">' +
          esc(x.post.title) + '</div>' +
        paragraphs(x.point) +
        '<div style="font-size:11px;color:#9a9a9a;margin-top:8px;">r/' + esc(x.post.sub) +
          ' · <a href="' + esc(x.post.url) + '" style="color:#9a9a9a;">thread</a></div>' +
        '</td></tr>';
    }).join('');

    blocks.push(
      '<tr><td style="padding:34px 0 6px;border-top:2px solid #e4e4e0;">' +
        '<div style="font-size:19px;font-weight:700;color:#111;">' + esc(section.topic.label) + '</div>' +
        (roundup ? '<div style="font-size:14px;color:#5a5a5a;margin-top:8px;line-height:1.65;">' +
          esc(roundup) + '</div>' : '') +
      '</td></tr>' +
      '<tr><td style="padding-top:20px;"><table width="100%" cellpadding="0" cellspacing="0">' +
        rows + '</table></td></tr>');
  });

  var html =
    // Preheader: what the inbox preview line shows instead of "Morning rundown ·".
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' +
      esc(summary.headline || todayLabel()) + '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:24px 12px;">' +
    '<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" ' +
      'style="max-width:640px;background:#fff;border-radius:12px;padding:32px 30px 36px;' +
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
    '<tr><td><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a;">' +
      'Morning rundown · ' + esc(todayLabel()) + '</div>' +
      (summary.headline ? '<div style="font-size:22px;line-height:1.4;font-weight:700;color:#111;' +
        'margin-top:12px;">' + esc(summary.headline) + '</div>' : '') +
    '</td></tr>' + blocks.join('') +
    '</table></td></tr></table>';

  return {
    html: html,
    ids: ids,
    text: 'MORNING RUNDOWN — ' + todayLabel() +
          (summary.headline ? '\n\n' + summary.headline : '') + textLines.join('\n'),
  };
}

/** A 4-7 sentence write-up often arrives as two paragraphs; keep the break. */
function paragraphs(s) {
  return String(s || '').split(/\n{2,}/).map(function (para) {
    return '<div style="font-size:15px;line-height:1.72;color:#2a2a2a;margin-bottom:8px;">' +
      esc(para.trim()) + '</div>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Seen-list — stops a post that sits on top for days from leading every morning
// ---------------------------------------------------------------------------
function loadSeen() {
  try {
    var map = {};
    JSON.parse(PropertiesService.getScriptProperties().getProperty(SEEN_KEY) || '[]')
      .forEach(function (id) { map[id] = true; });
    return map;
  } catch (err) { return {}; }
}

function rememberSeen(ids) {
  try {
    var prev = JSON.parse(PropertiesService.getScriptProperties().getProperty(SEEN_KEY) || '[]');
    PropertiesService.getScriptProperties()
      .setProperty(SEEN_KEY, JSON.stringify(prev.concat(ids).slice(-SEEN_LIMIT)));
  } catch (err) { /* a full seen-list is not worth failing a send over */ }
}

/** Run this if you want the next digest to ignore what it has already sent. */
function clearSeen() {
  PropertiesService.getScriptProperties().deleteProperty(SEEN_KEY);
  Logger.log('Seen-list cleared.');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function text(el) { return el ? el.getText() : ''; }
function repeat(s, n) { return new Array(n + 1).join(s); }

/** Only http(s) ever reaches an href. */
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
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

function todayLabel() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEEE, MMMM d');
}
