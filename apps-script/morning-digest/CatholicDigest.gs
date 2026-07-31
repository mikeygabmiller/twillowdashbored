/**
 * CATHOLIC MORNING DIGEST — Catholic Answers + Reddit → Gemini → your inbox.
 *
 * FIRST TIME SETUP (all in this editor):
 *   1. Project Settings (gear) → Script Properties → Add:
 *        GEMINI_API_KEY  =  your key
 *      Never paste the key into this file.
 *   2. Project Settings → set the script timezone to your local zone,
 *      otherwise SEND_HOUR below is interpreted in the wrong timezone.
 *   3. Pick `setup` in the function dropdown and hit Run.
 *
 * To try it right now: pick `previewToLog` and Run, then read the execution
 * log. It builds the whole digest, emails nothing, and ends with a source
 * report showing what each feed actually returned.
 *
 * ── ON THE PRAYERS ────────────────────────────────────────────────────────
 * The prayers below are hardcoded on purpose. A language model asked to
 * "recall a traditional prayer" will produce something that reads right and
 * has quietly drifted a phrase — and a prayer is a fixed text, so drift is
 * simply an error. Hardcoding means the wording is decided once, by you,
 * instead of re-rolled every morning.
 *
 * That logic applies to whoever typed them in, including me. VERIFY THESE
 * AGAINST A SOURCE YOU TRUST — your missal, your parish, a printed
 * collection — before you pray them daily. Fix the text here once and it is
 * right forever after. Translations legitimately vary between editions; the
 * point is that you choose which one, not that a model guesses nightly.
 */

const SEND_HOUR = 7;          // 24h, in the script's timezone
const POSTS_PER_SUB = 8;      // how many top posts to pull per subreddit
const ITEMS_PER_TOPIC = 5;    // default items per topic; a topic can override with `max`
const COMMENT_POSTS = 12;     // how many posts get their comments pulled
const COMMENTS_PER_POST = 4;

const MODEL = 'gemini-2.5-flash';
const SEEN_KEY = 'digest_seen_ids';
const PRAYER_KEY = 'digest_recent_prayers';
const SEEN_LIMIT = 400;       // ~a week; well inside the 9KB-per-property limit
const PRAYER_MEMORY = 5;      // how many recent prayers to avoid repeating
const UA = 'CatholicDigest/1.0 (personal use)';

// Optional Script Property: LITURGY_URL — a JSON endpoint returning today's
// liturgical celebrations. Set it and the saint section is grounded in the
// real calendar; leave it unset and the section is honestly labelled as a
// themed patron rather than claiming to be the calendar's saint of the day.
const LITURGY_PROP = 'LITURGY_URL';

// ---------------------------------------------------------------------------
// Prayers — fixed texts, chosen by id, never generated.
// Deliberately skewed toward prayers that are traditional but not the ones in
// every pew card, so the digest teaches something rather than reciting what is
// already known by heart.
// ---------------------------------------------------------------------------
const PRAYERS = [
  {
    id: 'anima_christi',
    title: 'Anima Christi',
    note: 'Fourteenth century; carried into wide use by St. Ignatius of Loyola.',
    tags: 'union with Christ, perseverance, the Passion, a good death',
    text: 'Soul of Christ, sanctify me.\n' +
          'Body of Christ, save me.\n' +
          'Blood of Christ, inebriate me.\n' +
          'Water from the side of Christ, wash me.\n' +
          'Passion of Christ, strengthen me.\n' +
          'O good Jesus, hear me.\n' +
          'Within Thy wounds hide me.\n' +
          'Suffer me not to be separated from Thee.\n' +
          'From the malignant enemy defend me.\n' +
          'In the hour of my death call me.\n' +
          'And bid me come unto Thee,\n' +
          'That with Thy Saints I may praise Thee\n' +
          'Forever and ever. Amen.',
  },
  {
    id: 'suscipe',
    title: 'The Suscipe of St. Ignatius',
    note: 'From the Spiritual Exercises of St. Ignatius of Loyola.',
    tags: 'surrender, detachment from possessions, offering your work',
    text: 'Take, Lord, and receive all my liberty,\n' +
          'my memory, my understanding, and my entire will,\n' +
          'all I have and call my own.\n' +
          'You have given all to me.\n' +
          'To you, Lord, I return it.\n' +
          'Everything is yours; do with it what you will.\n' +
          'Give me only your love and your grace.\n' +
          'That is enough for me.',
  },
  {
    id: 'ephrem',
    title: 'The Lenten Prayer of St. Ephrem the Syrian',
    note: 'Fourth century. Prayed daily through Lent in the Eastern churches.',
    tags: 'sloth, idle talk, judging others, humility, patience, self-knowledge',
    text: 'O Lord and Master of my life,\n' +
          'take from me the spirit of sloth, faint-heartedness,\n' +
          'lust of power, and idle talk.\n\n' +
          'But give rather the spirit of chastity, humility,\n' +
          'patience, and love to Thy servant.\n\n' +
          'Yea, O Lord and King, grant me to see my own errors\n' +
          'and not to judge my brother;\n' +
          'for Thou art blessed unto ages of ages. Amen.',
  },
  {
    id: 'de_foucauld',
    title: 'The Prayer of Abandonment',
    note: 'Bl. Charles de Foucauld, hermit of the Sahara, canonized 2022.',
    tags: 'trust, uncertainty, anxiety about the future, abandonment to providence',
    text: 'Father, I abandon myself into your hands;\n' +
          'do with me what you will.\n' +
          'Whatever you may do, I thank you:\n' +
          'I am ready for all, I accept all.\n' +
          'Let only your will be done in me,\n' +
          'and in all your creatures.\n' +
          'I wish no more than this, O Lord.\n\n' +
          'Into your hands I commend my soul;\n' +
          'I offer it to you with all the love of my heart,\n' +
          'for I love you, Lord, and so need to give myself,\n' +
          'to surrender myself into your hands, without reserve,\n' +
          'and with boundless confidence,\n' +
          'for you are my Father.',
  },
  {
    id: 'richard_chichester',
    title: 'The Prayer of St. Richard of Chichester',
    note: 'Thirteenth-century English bishop.',
    tags: 'gratitude, discipleship, knowing and following Christ',
    text: 'Thanks be to Thee, my Lord Jesus Christ,\n' +
          'for all the benefits Thou hast given me,\n' +
          'for all the pains and insults Thou hast borne for me.\n\n' +
          'O most merciful Redeemer, Friend and Brother,\n' +
          'may I know Thee more clearly,\n' +
          'love Thee more dearly,\n' +
          'and follow Thee more nearly,\n' +
          'day by day. Amen.',
  },
  {
    id: 'sub_tuum',
    title: 'Sub Tuum Praesidium',
    note: 'The oldest known prayer to the Blessed Virgin; on papyrus by roughly AD 250.',
    tags: 'Marian devotion, protection, danger, difficulty',
    text: 'We fly to thy protection,\n' +
          'O holy Mother of God.\n' +
          'Despise not our petitions in our necessities,\n' +
          'but deliver us always from all dangers,\n' +
          'O glorious and blessed Virgin. Amen.',
  },
  {
    id: 'breastplate',
    title: "St. Patrick's Breastplate (the Lorica)",
    note: 'From the Irish hymn traditionally ascribed to St. Patrick.',
    tags: 'protection, spiritual warfare, beginning the working day',
    text: 'Christ with me,\n' +
          'Christ before me,\n' +
          'Christ behind me,\n' +
          'Christ in me,\n' +
          'Christ beneath me,\n' +
          'Christ above me,\n' +
          'Christ on my right,\n' +
          'Christ on my left,\n' +
          'Christ when I lie down,\n' +
          'Christ when I sit down,\n' +
          'Christ when I arise,\n' +
          'Christ in the heart of every man who thinks of me,\n' +
          'Christ in the mouth of everyone who speaks of me,\n' +
          'Christ in every eye that sees me,\n' +
          'Christ in every ear that hears me.',
  },
  {
    id: 'spiritual_communion',
    title: 'Act of Spiritual Communion',
    note: 'St. Alphonsus Liguori.',
    tags: 'the Eucharist, longing for Christ, a day away from Mass',
    text: 'My Jesus, I believe that You are present in the Most Holy Sacrament.\n' +
          'I love You above all things, and I desire to receive You into my soul.\n' +
          'Since I cannot at this moment receive You sacramentally,\n' +
          'come at least spiritually into my heart.\n' +
          'I embrace You as if You were already there\n' +
          'and unite myself wholly to You.\n' +
          'Never permit me to be separated from You. Amen.',
  },
  {
    id: 'divine_praises',
    title: 'The Divine Praises',
    note: 'Composed in 1797 in reparation for blasphemy; prayed after Benediction.',
    tags: 'reparation, blasphemy, guarding your speech on the job',
    text: 'Blessed be God.\n' +
          'Blessed be His Holy Name.\n' +
          'Blessed be Jesus Christ, true God and true Man.\n' +
          'Blessed be the Name of Jesus.\n' +
          'Blessed be His Most Sacred Heart.\n' +
          'Blessed be His Most Precious Blood.\n' +
          'Blessed be Jesus in the Most Holy Sacrament of the Altar.\n' +
          'Blessed be the Holy Spirit, the Paraclete.\n' +
          'Blessed be the great Mother of God, Mary most holy.\n' +
          'Blessed be her holy and Immaculate Conception.\n' +
          'Blessed be her glorious Assumption.\n' +
          'Blessed be the name of Mary, Virgin and Mother.\n' +
          'Blessed be St. Joseph, her most chaste spouse.\n' +
          'Blessed be God in His angels and in His Saints.',
  },
  {
    id: 'newman_ourlife',
    title: 'Radiating Christ',
    note: 'St. John Henry Newman, from a meditation on Christian witness.',
    tags: 'witness at work, dealing with customers, ordinary influence on others',
    text: 'Dear Jesus, help me to spread Your fragrance everywhere I go.\n' +
          'Flood my soul with Your spirit and life.\n' +
          'Penetrate and possess my whole being so utterly\n' +
          'that all my life may only be a radiance of Yours.\n\n' +
          'Shine through me and be so in me\n' +
          'that every soul I come in contact with\n' +
          'may feel Your presence in my soul.\n' +
          'Let them look up and see no longer me, but only Jesus.',
  },
];

// ---------------------------------------------------------------------------
// Topics. A subreddit belongs to exactly one topic — listing it twice fetches
// it twice and lets the first topic claim every post, starving the second.
// ---------------------------------------------------------------------------
const TOPICS = [
  {
    label: '❓ Catholic Q&A & Apologetics',
    subs: ['AskAPriest', 'Catholicism'],
    hint: 'Clear questions and orthodox Catholic answers, in the spirit of Catholic Answers apologetics. Explanations of theology, morality, sacraments or liturgy. Separate settled Church teaching from private opinion and from common confusion.',
  },
  {
    label: '🌍 Catholic Life & Philosophy',
    subs: ['CatholicPhilosophy', 'Catholic'],
    hint: 'Living the faith in the modern world: philosophy, moral reasoning, work, vocation, and the intellectual defense of the faith. Prefer practical insight a young working Catholic can act on.',
  },
];

const ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');
const CONTENT_NS = XmlService.getNamespace('content', 'http://purl.org/rss/1.0/modules/content/');

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
      name: 'Catholic Morning Rundown',
    });
    rememberSeen(built.ids);
    rememberPrayer(built.prayerId);
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

/** Prints every prayer so you can proofread them in one pass. */
function reviewPrayers() {
  Logger.log(PRAYERS.map(function (p) {
    return repeat('=', 60) + '\n' + p.title + '\n' + p.note + '\n\n' + p.text;
  }).join('\n\n'));
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function buildDigest(opts) {
  opts = opts || {};
  var seen = opts.dryRun ? {} : loadSeen();
  var diagnostics = [];

  var caArticle = getCatholicAnswersArticle(seen, diagnostics);
  var liturgy = getLiturgy(diagnostics);

  var byTopic = collectPosts(seen, diagnostics);
  var sections = [];
  byTopic.forEach(function (items, ti) {
    if (items.length) sections.push({ topic: TOPICS[ti], items: items });
  });

  if (!sections.length && !caArticle) {
    return { ok: false, reason: 'no posts or articles fetched', diagnostics: diagnostics };
  }

  attachComments(pickForComments(sections, COMMENT_POSTS), diagnostics);

  var summary = summarize(sections, caArticle, liturgy, diagnostics);
  var rendered = render(sections, summary);

  // The prayer and saint alone are not a digest. Require something fetched.
  if (!rendered.ids.length && !summary.caSummaryObj) {
    return { ok: false, reason: 'nothing usable survived summarizing', diagnostics: diagnostics };
  }

  return {
    ok: true,
    subject: '✝️ Catholic Rundown — ' + truncateWords(summary.headline || todayLabel(), 80),
    html: rendered.html,
    text: rendered.text,
    ids: rendered.ids,
    prayerId: summary.prayer ? summary.prayer.id : '',
    diagnostics: diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Catholic Answers
// ---------------------------------------------------------------------------
function getCatholicAnswersArticle(seen, diagnostics) {
  var urls = [
    'https://www.catholic.com/feeds/magazine/rss',
    'https://www.catholic.com/rss',
    'https://www.catholic.com/feed',
  ];

  var xml = null, used = '';
  for (var i = 0; i < urls.length && !xml; i++) {
    try {
      var res = UrlFetchApp.fetch(urls[i], {
        muteHttpExceptions: true,
        headers: { 'User-Agent': UA },   // some hosts reject the default agent
      });
      if (res.getResponseCode() === 200) {
        xml = XmlService.parse(res.getContentText());
        used = urls[i];
      }
    } catch (e) {
      // Not XML, or not reachable. Try the next candidate.
    }
  }

  if (!xml) {
    diagnostics.push('FAIL  Catholic Answers — no feed responded with parseable XML');
    return null;
  }

  var entries = feedEntries(xml);
  if (!entries.length) {
    diagnostics.push('FAIL  Catholic Answers — feed had no items (' + used + ')');
    return null;
  }

  // Walk down until we hit one that has not already been sent. Otherwise the
  // same lead article headlines the digest for as long as it tops the feed.
  for (var j = 0; j < entries.length; j++) {
    var article = readArticle(entries[j]);
    if (!article || !article.title) continue;
    var key = article.url || article.title;
    if (seen[key]) continue;

    article.id = key;
    diagnostics.push(' ok   Catholic Answers — ' + truncateWords(article.title, 60) +
      ' (item ' + (j + 1) + ', ' + article.body.length + ' chars)');
    return article;
  }

  diagnostics.push(' ok   Catholic Answers — every item already sent, skipping');
  return null;
}

/** RSS 2.0 puts items under <channel>; Atom puts entries at the root. */
function feedEntries(xml) {
  var root = xml.getRootElement();
  var ns = root.getNamespace();

  var items = root.getChildren('item', ns);
  if (items.length) return items;

  var channel = root.getChild('channel', ns);
  if (channel) {
    items = channel.getChildren('item', ns);
    if (items.length) return items;
  }

  return root.getChildren('entry', ATOM);
}

function readArticle(el) {
  var title = '', link = '', content = '';

  if (el.getName() === 'item') {
    var ns = el.getNamespace();
    title = el.getChildText('title', ns) || '';
    link = el.getChildText('link', ns) || '';
    content = el.getChildText('description', ns) || '';
    var encoded = el.getChildText('encoded', CONTENT_NS);
    if (encoded) content = encoded;
  } else {
    title = el.getChildText('title', ATOM) || '';
    var linkEl = el.getChild('link', ATOM);
    link = linkEl && linkEl.getAttribute('href') ? linkEl.getAttribute('href').getValue() : '';
    content = el.getChildText('content', ATOM) || el.getChildText('summary', ATOM) || '';
  }

  var body = stripHtml(content);

  // A feed teaser is usually a couple of sentences. Fetch the page for the
  // rest — stripHtml drops script and style bodies, so what comes back is
  // prose rather than the site's minified CSS.
  if (body.length < 500 && safeUrl(link)) {
    try {
      var page = UrlFetchApp.fetch(link, {
        muteHttpExceptions: true,
        headers: { 'User-Agent': UA },
      });
      if (page.getResponseCode() === 200) {
        var full = stripHtml(page.getContentText());
        if (full.length > body.length) body = full;
      }
    } catch (e) {
      // Keep the teaser; a short summary beats no section.
    }
  }

  return {
    title: stripHtml(title),
    url: safeUrl(link),
    body: body.slice(0, 6000),
  };
}

// ---------------------------------------------------------------------------
// Liturgical calendar (optional, and honest when absent)
// ---------------------------------------------------------------------------
function getLiturgy(diagnostics) {
  var url = PropertiesService.getScriptProperties().getProperty(LITURGY_PROP);
  if (!url) return null;

  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': UA } });
    if (res.getResponseCode() !== 200) {
      diagnostics.push('FAIL  liturgy — HTTP ' + res.getResponseCode());
      return null;
    }
    // Kept deliberately shape-agnostic: any JSON is flattened to its string
    // values, so a change of provider does not need a code change.
    var names = collectStrings(JSON.parse(res.getContentText()));
    if (!names.length) {
      diagnostics.push('FAIL  liturgy — no readable text in the response');
      return null;
    }
    var text = names.join('; ').slice(0, 500);
    diagnostics.push(' ok   liturgy — ' + truncateWords(text, 70));
    return text;
  } catch (err) {
    diagnostics.push('FAIL  liturgy — ' + String(err));
    return null;
  }
}

function collectStrings(node, out) {
  out = out || [];
  if (out.length > 20) return out;
  if (typeof node === 'string') {
    if (node.length > 2 && node.length < 120) out.push(node);
  } else if (node && typeof node === 'object') {
    Object.keys(node).forEach(function (k) { collectStrings(node[k], out); });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit (RSS — no API key, no OAuth)
// ---------------------------------------------------------------------------
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
// Summarize — one Gemini call per topic plus one for the article, in parallel
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

const ARTICLE_SCHEMA = {
  type: 'OBJECT',
  properties: { summary: { type: 'STRING' } },
  required: ['summary'],
};

function summarize(sections, caArticle, liturgy, diagnostics) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Set GEMINI_API_KEY in Project Settings → Script Properties.');

  var reqs = sections.map(function (s) {
    return geminiRequest(key, topicPrompt(s), TOPIC_SCHEMA, 8192);
  });

  if (caArticle) {
    reqs.push(geminiRequest(key, articlePrompt(caArticle), ARTICLE_SCHEMA, 2048));
  }

  var results = fetchBatch(reqs);

  // The article request was appended last, so it comes off the end.
  var caSummaryObj = null;
  if (caArticle) {
    var parsedCA = readGemini(results.pop());
    if (parsedCA.error || !parsedCA.value.summary) {
      diagnostics.push('FAIL  Catholic Answers summary — ' + (parsedCA.error || 'empty'));
    } else {
      caSummaryObj = {
        id: caArticle.id,
        title: caArticle.title,
        url: caArticle.url,
        summary: parsedCA.value.summary,
      };
    }
  }

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

  var supplement = spiritualSupplement(key, topics, caSummaryObj, liturgy, diagnostics);

  return {
    headline: supplement.headline,
    saint: supplement.saint,
    saintGrounded: !!liturgy,
    prayer: supplement.prayer,
    topics: topics,
    caSummaryObj: caSummaryObj,
  };
}

function topicPrompt(section) {
  var lines = [];
  section.items.forEach(function (p, i) {
    lines.push('\n[' + (i + 1) + '] (r/' + p.sub + ') ' + p.title);
    if (p.body) lines.push('    post: ' + p.body);
    p.comments.forEach(function (c) { lines.push('    top comment: ' + c); });
  });

  return 'You are writing one section of a personal morning briefing for Mikey, an 18-year-old ' +
    'Catholic who runs his own mobile car-detailing business.\n\n' +
    'This section is "' + section.topic.label + '". What matters here: ' + section.topic.hint + '\n\n' +
    'THE MOST IMPORTANT RULE: this email is the whole read, not a table of contents. He should ' +
    'never have to click a link to understand what was said. Retell the actual question, the ' +
    'actual reasoning, and what people concluded. A teaser like "users discussed the sacraments" ' +
    'is a failure; write the substance.\n\n' +
    'Rules:\n' +
    '- Every item gets a real paragraph, roughly 4 to 7 sentences. Plain language, no filler.\n' +
    '- Lead with the question and the Catholic answer to it, not "a user posted that".\n' +
    '- Where the thread reaches a clear and orthodox answer, say so plainly.\n' +
    '- Where the thread is contested, or where commenters give an answer that goes beyond what ' +
    'the Church actually binds, say that too. Distinguish defined doctrine from theological ' +
    'opinion from personal practice. Do not present a redditor\'s opinion as Church teaching.\n' +
    '- Cite what the material itself cites — a canon, a paragraph of the Catechism, a Council — ' +
    'only when the material names it. Do not supply citations from your own memory.\n' +
    '- Skip memes, rants and photos with no information. Fewer, meatier items beat padding. ' +
    'Return an empty items list if nothing here was worth his time.\n' +
    '- "roundup" is 2-4 sentences on the overall theme and mood of this section.\n' +
    '- NEVER invent a fact, a quotation, or a citation that is not in the material below.\n' +
    '- "ref" is the [n] number of the post you are writing about. Use each at most once.\n\n' +
    'MATERIAL:\n' + lines.join('\n');
}

function articlePrompt(article) {
  return 'Summarize this Catholic Answers article for a quick morning read: the main apologetic ' +
    'or theological point, the reasoning behind it, and the practical upshot. Four to six ' +
    'sentences, plain language. Retell the argument rather than describing that an argument was ' +
    'made. Never add a fact, quotation or citation that is not in the text below.\n\n' +
    'TITLE: ' + article.title + '\n\nTEXT:\n' + article.body;
}

// ---------------------------------------------------------------------------
// Saint and prayer
//
// The prayer is CHOSEN, never written: the model returns an id constrained by
// the schema's enum, and the text comes from PRAYERS above. The saint is
// grounded in the liturgical feed when LITURGY_URL is set, and is labelled as
// a themed patron rather than "the saint of the day" when it is not — because
// without the calendar the model is guessing, and the email should not claim
// otherwise.
// ---------------------------------------------------------------------------
function spiritualSupplement(key, topics, caSummaryObj, liturgy, diagnostics) {
  var eligible = eligiblePrayers();
  var fallback = { headline: '', saint: null, prayer: eligible[0] };

  var points = [];
  if (caSummaryObj) {
    points.push('- Catholic Answers article "' + caSummaryObj.title + '": ' + caSummaryObj.summary);
  }
  topics.forEach(function (t) {
    (t.items || []).forEach(function (it) { points.push('- ' + it.point); });
  });

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEEE, MMMM d, yyyy');

  var saintInstruction = liturgy
    ? '2. "saint": TODAY\'S LITURGICAL CALENDAR SAYS: "' + liturgy + '". Write about the saint ' +
      'or celebration named there. Do not substitute a different saint. If the day has no saint ' +
      '(a plain weekday), pick a saint whose life speaks to the themes below and say so in the ' +
      'life summary.\n'
    : '2. "saint": Choose a saint whose life speaks to the themes below and to a young tradesman ' +
      'running his own business — work, craftsmanship, perseverance, young manhood, honest ' +
      'dealing. Do NOT claim it is today\'s feast; you do not have the liturgical calendar. ' +
      'Stick to well-attested facts about the saint and keep the life summary to what you are ' +
      'confident is true.\n';

  var prompt = 'You are assembling the closing section of a Catholic morning briefing for Mikey, ' +
    'an 18-year-old who runs his own mobile car-detailing business. Today is ' + today + '.\n\n' +
    'Reply with JSON providing:\n\n' +
    '1. "headline": one sentence naming the single most useful or striking thing in the ' +
    'material below. Concrete, no hype, no "here is your briefing".\n' +
    saintInstruction +
    '   Give "name", "life_summary" (3-5 sentences), and "how_to_emulate" (3-5 sentences of ' +
    'specific, practical things he could actually do today at work or at home — not platitudes).\n' +
    '3. "prayer_id": pick the ONE prayer from this list that best fits the saint and the themes. ' +
    'Return only its id.\n' +
    eligible.map(function (p) {
      return '   - ' + p.id + ' — "' + p.title + '" (' + p.tags + ')';
    }).join('\n') + '\n\n' +
    'Never invent a fact, quotation or citation.\n\n' +
    'MATERIAL:\n' + (points.length ? points.join('\n') : '(nothing fetched today)');

  var schema = {
    type: 'OBJECT',
    properties: {
      headline: { type: 'STRING' },
      saint: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          life_summary: { type: 'STRING' },
          how_to_emulate: { type: 'STRING' },
        },
        required: ['name', 'life_summary', 'how_to_emulate'],
      },
      // The enum is the guarantee: the model cannot return a prayer we do not
      // have, and cannot return prayer text at all.
      prayer_id: { type: 'STRING', enum: eligible.map(function (p) { return p.id; }) },
    },
    required: ['headline', 'saint', 'prayer_id'],
  };

  var parsed = readGemini(fetchBatch([geminiRequest(key, prompt, schema, 4096)])[0]);
  if (parsed.error) {
    diagnostics.push('FAIL  saint & prayer — ' + parsed.error + ' (using a prayer anyway)');
    return fallback;
  }

  // Resolve against `eligible`, not all of PRAYERS. The enum should make an
  // ineligible id impossible, but if the model returns one anyway, honouring
  // it would silently defeat the rotation.
  var chosen = null;
  for (var i = 0; i < eligible.length; i++) {
    if (eligible[i].id === parsed.value.prayer_id) chosen = eligible[i];
  }

  return {
    headline: parsed.value.headline || '',
    saint: parsed.value.saint || null,
    prayer: chosen || eligible[0],
  };
}

/** Everything except the last few days' prayers, so the rotation moves. */
function eligiblePrayers() {
  var recent = {};
  try {
    JSON.parse(PropertiesService.getScriptProperties().getProperty(PRAYER_KEY) || '[]')
      .forEach(function (id) { recent[id] = true; });
  } catch (err) { /* no memory is fine */ }

  var open = PRAYERS.filter(function (p) { return !recent[p.id]; });
  return open.length ? open : PRAYERS.slice();
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
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
        // Low: this is doctrinal content being retold, not creative writing.
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
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
      responses = null;   // one bad request fails the batch; go one by one
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

  // --- Catholic Answers -----------------------------------------------------
  if (summary.caSummaryObj) {
    var ca = summary.caSummaryObj;
    ids.push(ca.id);
    textLines.push('\n\n' + repeat('=', 60) + '\n🛡️ CATHOLIC ANSWERS DAILY\n' + repeat('=', 60));
    textLines.push('\n' + ca.title + '\n' + ca.summary + '\n  ↳ ' + ca.url);

    blocks.push(
      sectionHeader('🛡️ Catholic Answers Daily', '') +
      '<tr><td style="padding-top:16px;padding-bottom:6px;">' +
        '<div style="font-size:15px;font-weight:600;line-height:1.45;color:#111;margin-bottom:7px;">' +
          esc(ca.title) + '</div>' +
        paragraphs(ca.summary) +
        (ca.url ? '<div style="font-size:11px;color:#9a9a9a;margin-top:8px;">catholic.com · ' +
          '<a href="' + esc(ca.url) + '" style="color:#9a9a9a;">read the full article</a></div>' : '') +
      '</td></tr>');
  }

  // --- Reddit sections ------------------------------------------------------
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
        return { post: section.items[Number(it.ref) - 1], point: it.point };
      }).filter(function (x) {
        if (!x.post || !x.point || used[x.post.id]) return false;
        used[x.post.id] = true;
        return true;
      });
    }
    if (!rowsData.length) return;

    var roundup = t.items === null
      ? 'Summary unavailable for this section — raw posts below.'
      : (t.roundup || '');

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
          (x.post.url ? ' · <a href="' + esc(x.post.url) + '" style="color:#9a9a9a;">thread</a>' : '') +
        '</div></td></tr>';
    }).join('');

    blocks.push(
      sectionHeader(section.topic.label, roundup) +
      '<tr><td style="padding-top:20px;"><table width="100%" cellpadding="0" cellspacing="0">' +
        rows + '</table></td></tr>');
  });

  // --- Saint ----------------------------------------------------------------
  if (summary.saint) {
    var heading = summary.saintGrounded
      ? '🕊️ Saint of the Day: ' + summary.saint.name
      : '🕊️ Patron for Today: ' + summary.saint.name;

    textLines.push('\n\n' + repeat('=', 60) + '\n' + heading.replace(/^..\s/, '') + '\n' + repeat('=', 60));
    textLines.push('\nLife: ' + summary.saint.life_summary);
    textLines.push('\nHow to emulate him today: ' + summary.saint.how_to_emulate);
    if (!summary.saintGrounded) {
      textLines.push('\n(Chosen to fit today\'s themes, not read from the liturgical calendar.)');
    }

    blocks.push(
      sectionHeader(heading, '') +
      '<tr><td style="padding-top:16px;padding-bottom:6px;">' +
        '<div style="font-size:15px;line-height:1.72;color:#2a2a2a;margin-bottom:12px;">' +
          '<b>Life:</b> ' + esc(summary.saint.life_summary) + '</div>' +
        '<div style="font-size:15px;line-height:1.72;color:#2a2a2a;">' +
          '<b>How to emulate him today:</b> ' + esc(summary.saint.how_to_emulate) + '</div>' +
        (summary.saintGrounded ? '' :
          '<div style="font-size:11px;color:#9a9a9a;margin-top:10px;">Chosen to fit today\'s ' +
          'themes — not read from the liturgical calendar.</div>') +
      '</td></tr>');
  }

  // --- Prayer ---------------------------------------------------------------
  if (summary.prayer) {
    var pr = summary.prayer;
    textLines.push('\n\n' + repeat('=', 60) + '\n🙏 ' + pr.title + '\n' + repeat('=', 60));
    textLines.push('\n' + pr.text + '\n\n— ' + pr.note);

    blocks.push(
      sectionHeader('🙏 ' + pr.title, '') +
      '<tr><td style="padding-top:16px;padding-bottom:6px;">' +
        '<div style="font-size:15px;line-height:1.85;color:#2a2a2a;font-style:italic;' +
          'background:#faf9f6;padding:18px 20px;border-radius:8px;border-left:4px solid #c9b37e;">' +
          // esc() FIRST, then insert the breaks — otherwise the <br> tags get
          // escaped along with the text and print literally.
          esc(pr.text).replace(/\n/g, '<br>') +
        '</div>' +
        '<div style="font-size:11px;color:#9a9a9a;margin-top:10px;">' + esc(pr.note) + '</div>' +
      '</td></tr>');
  }

  var html =
    // Preheader: what the inbox preview line shows instead of the kicker.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' +
      esc(summary.headline || todayLabel()) + '</div>' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:24px 12px;">' +
    '<tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" ' +
      'style="max-width:640px;background:#fff;border-radius:12px;padding:32px 30px 36px;' +
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
    '<tr><td><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a8a;">' +
      'Catholic Morning Rundown · ' + esc(todayLabel()) + '</div>' +
      (summary.headline ? '<div style="font-size:22px;line-height:1.4;font-weight:700;color:#111;' +
        'margin-top:12px;">' + esc(summary.headline) + '</div>' : '') +
    '</td></tr>' + blocks.join('') +
    '</table></td></tr></table>';

  return {
    html: html,
    ids: ids,
    text: 'CATHOLIC MORNING RUNDOWN — ' + todayLabel() +
          (summary.headline ? '\n\n' + summary.headline : '') + textLines.join('\n'),
  };
}

function sectionHeader(label, roundup) {
  return '<tr><td style="padding:34px 0 6px;border-top:2px solid #e4e4e0;">' +
    '<div style="font-size:19px;font-weight:700;color:#111;">' + esc(label) + '</div>' +
    (roundup ? '<div style="font-size:14px;color:#5a5a5a;margin-top:8px;line-height:1.65;">' +
      esc(roundup) + '</div>' : '') +
    '</td></tr>';
}

/** A 4-7 sentence write-up often arrives as two paragraphs; keep the break. */
function paragraphs(s) {
  return String(s || '').split(/\n{2,}/).map(function (para) {
    return '<div style="font-size:15px;line-height:1.72;color:#2a2a2a;margin-bottom:8px;">' +
      esc(para.trim()) + '</div>';
  }).join('');
}

// ---------------------------------------------------------------------------
// Seen-list — stops a post or article that sits on top for days from leading
// every morning
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

function rememberPrayer(id) {
  if (!id) return;
  try {
    var prev = JSON.parse(PropertiesService.getScriptProperties().getProperty(PRAYER_KEY) || '[]');
    PropertiesService.getScriptProperties()
      .setProperty(PRAYER_KEY, JSON.stringify(prev.concat([id]).slice(-PRAYER_MEMORY)));
  } catch (err) { /* rotation is a nicety, not worth failing a send over */ }
}

/** Run this if you want the next digest to ignore what it has already sent. */
function clearSeen() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(SEEN_KEY);
  props.deleteProperty(PRAYER_KEY);
  Logger.log('Seen-list and prayer rotation cleared.');
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
 *
 * Script and style bodies are removed FIRST. Removing tags alone leaves the
 * JavaScript and CSS between them as text, which on a real web page is
 * thousands of characters of minified junk ahead of the first sentence of
 * prose — enough to fill the whole budget sent to the model.
 */
function stripHtml(s) {
  var out = String(s || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
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
