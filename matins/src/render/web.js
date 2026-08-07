// The web surface. Same issue, same identity as the email — one build feeds
// both. Pages are fully self-contained static HTML (no build step, no JS
// framework) because they get committed straight to GitHub Pages.
//
// What the web can do that the email cannot, and does:
//   * honour the reader's dark-mode setting — this is read before dawn;
//   * carry the reader onward (previous / next / today / archive) instead of
//     dead-ending on a permalink;
//   * print cleanly, for anyone who wants the day on paper.

import { theme, SERIF, SANS, escapeHtml, longDate } from './theme.js';
import { stanzas } from './prayer.js';
import { considerList, readingsOf } from './compat.js';
import { markSvg } from './brand.js';
import { FOOTER_LINE } from '../config.js';

function shell({ title, description, accentColor, body, cfg, canonical, nav = '', extraHead = '' }) {
  const t = theme(accentColor);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="${t.paperAlt}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${t.paperAltDark}" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${escapeHtml(cfg.siteUrl)}/mark.svg" type="image/svg+xml">
<style>
  :root {
    --accent:${t.accent}; --tint:${t.tint};
    --paper:${t.paper}; --paper-alt:${t.paperAlt};
    --ink:${t.ink}; --ink-soft:${t.inkSoft}; --rule:${t.rule};
    --shadow:0 1px 2px rgba(36,31,26,.04), 0 8px 28px rgba(36,31,26,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --accent:${t.accentDark}; --tint:${t.tintDark};
      --paper:${t.paperDark}; --paper-alt:${t.paperAltDark};
      --ink:${t.inkDark}; --ink-soft:${t.inkSoftDark}; --rule:${t.ruleDark};
      --shadow:none;
    }
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--paper-alt);color:var(--ink);font-family:${SERIF};line-height:1.72;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  .wrap{max-width:672px;margin:0 auto;padding:28px 18px 64px}
  .sheet{background:var(--paper);border:1px solid var(--rule);border-radius:14px;padding:0 0 30px;box-shadow:var(--shadow);overflow:hidden}
  /* The liturgical colour of the day, before a word is read. */
  .band{height:5px;background:var(--accent)}
  .inner{padding:30px 34px 0}
  /* ~66 characters to the line: the single biggest thing for reading comfort. */
  .inner > p, .inner > blockquote, .inner > .action, .inner > .prayer, .inner > .note{max-width:38em}
  header.brand{display:flex;align-items:center;gap:11px;margin-bottom:26px}
  header.brand a{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink)}
  .wordmark{font-size:22px;letter-spacing:.14em;text-transform:uppercase}
  .eyebrow{font-family:${SANS};font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-soft);font-weight:600}
  h1{font-weight:400;font-size:clamp(27px,5vw,35px);line-height:1.22;margin:.3em 0 .5em;max-width:22ch}
  /* Not flex: the dot has to sit on the first line of the text and let the
     text wrap under itself, which flex will not do once the line is long. */
  .daybar{font-family:${SANS};font-size:13.5px;line-height:1.6;color:var(--ink-soft)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block;margin-right:8px}
  .hdo{color:var(--accent);font-weight:700}
  hr{border:0;border-top:1px solid var(--rule);margin:24px 0}
  /* Section head: a rule, then the label. The rule is what makes the page
     scannable — it is the only thing separating one section from the next. */
  h2{font-family:${SANS};font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);font-weight:700;margin:0 0 12px;padding-top:28px;border-top:1px solid var(--rule);line-height:1.4}
  h2:first-of-type{border-top:0;padding-top:0}
  h2 + .note{margin:-8px 0 12px}
  p{font-size:17.5px;margin:0 0 15px}
  a{color:var(--accent);text-underline-offset:2px}
  a:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
  .readings{width:auto;border-collapse:collapse;margin:0 0 14px}
  .readings th{font-family:${SANS};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);text-align:left;font-weight:600;padding:0 18px 8px 0;white-space:nowrap;vertical-align:baseline}
  .readings td{padding:0 0 8px 0;font-size:16.5px;line-height:1.45;vertical-align:baseline}
  .usccb{font-family:${SANS};font-size:14.5px;font-weight:600}
  /* Two readings, each with what happens in it and what it asks. */
  .reading{margin:0 0 24px;max-width:38em}
  .reading-label{font-family:${SANS};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);font-weight:700}
  .reading-ref{font-size:19px;line-height:1.35;margin:3px 0 0}
  .reading-summary{font-size:17px;line-height:1.68;margin:9px 0 0}
  .called{border-left:3px solid var(--accent);padding:1px 0 1px 15px;margin:13px 0 0}
  .called .label{font-family:${SANS};font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);font-weight:700}
  .called p{font-size:16.5px;line-height:1.6;margin:4px 0 0}
  /* Three questions read as one section, separated by space not by rules. */
  .closer{color:var(--accent);font-style:italic;font-size:17px;max-width:38em}
  .qa{max-width:38em}
  .qa + .qa{margin-top:28px}
  blockquote{margin:0;border-left:3px solid var(--accent);padding-left:18px;font-style:italic}
  blockquote p{font-size:19.5px;line-height:1.62;margin-bottom:10px}
  .cite{font-family:${SANS};font-style:normal;font-size:12px;color:var(--ink-soft)}
  .action{background:var(--tint);border-radius:9px;padding:16px 18px;margin:6px 0 0}
  .action .label{font-family:${SANS};font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:6px}
  .action p{font-size:16.5px;margin:0}
  /* A prayer is said, not skimmed: one line per line, hanging indent on wrap. */
  .prayer{margin:0 0 15px}
  .prayer .stanza{margin:0 0 14px}
  .prayer .stanza:last-child{margin-bottom:0}
  .prayer .line{font-size:17.5px;line-height:1.58;padding-left:15px;text-indent:-15px;margin:0}
  .prayer-title{font-size:21px;line-height:1.3;margin:0 0 6px}
  .question{font-size:20px;line-height:1.4;margin:0 0 12px}
  .note{font-family:${SANS};font-size:13px;font-style:italic;color:var(--ink-soft);margin:0 0 16px;line-height:1.6}
  nav.issue-nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between;font-family:${SANS};font-size:13.5px;margin-top:34px;padding-top:20px;border-top:1px solid var(--rule)}
  nav.issue-nav a{text-decoration:none;padding:7px 13px;border:1px solid var(--rule);border-radius:999px;color:var(--ink)}
  nav.issue-nav a:hover{border-color:var(--accent);color:var(--accent)}
  nav.issue-nav .spacer{flex:1}
  footer{font-family:${SANS};font-size:13px;color:var(--ink-soft);margin-top:26px;padding-top:18px;border-top:1px solid var(--rule);line-height:1.8}
  ul.archive{list-style:none;margin:0;padding:0}
  ul.archive li{border-bottom:1px solid var(--rule);padding:13px 0}
  ul.archive li:last-child{border-bottom:0}
  ul.archive .row{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  ul.archive time{font-family:${SANS};font-size:12px;color:var(--ink-soft);min-width:58px;flex:none}
  ul.archive a{text-decoration:none;font-size:18px;line-height:1.4}
  ul.archive a:hover{text-decoration:underline}
  ul.archive .feast{font-family:${SANS};font-size:12.5px;color:var(--ink-soft);margin:2px 0 0 88px;line-height:1.5}
  h3.month{font-family:${SANS};font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-soft);font-weight:700;margin:28px 0 6px}
  h3.month:first-of-type{margin-top:8px}
  .swatch{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px;flex:none}
  form.signup{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 8px;max-width:38em}
  form.signup input{flex:1 1 240px;font-family:${SANS};font-size:16px;padding:13px 15px;border:1px solid var(--rule);border-radius:9px;background:var(--paper-alt);color:var(--ink)}
  form.signup input:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  form.signup button{font-family:${SANS};font-size:15px;font-weight:600;padding:13px 24px;border:0;border-radius:9px;background:var(--accent);color:var(--paper);cursor:pointer}
  form.signup button:hover{filter:brightness(1.08)}
  .msg{font-family:${SANS};font-size:14px;margin-top:10px;color:var(--ink-soft)}
  @media (max-width:540px){
    .inner{padding:24px 21px 0}
    h2{padding-top:24px}
    /* The spacers only make sense while the row fits on one line. */
    nav.issue-nav{gap:8px}
    nav.issue-nav .spacer{display:none}
    nav.issue-nav a{padding:7px 11px}
    ul.archive .feast{margin-left:0}
  }
  @media print{
    :root{--paper:#fff;--paper-alt:#fff;--ink:#000;--ink-soft:#444;--rule:#ccc;--shadow:none}
    .wrap{max-width:none;padding:0}
    .sheet{border:0;border-radius:0;box-shadow:none}
    .band,nav.issue-nav,form.signup{display:none}
    a{color:inherit;text-decoration:none}
  }
</style>
${extraHead}
</head>
<body>
<div class="wrap">
  <div class="sheet">
    <div class="band"></div>
    <div class="inner">
      <header class="brand">
        <a href="${escapeHtml(cfg.siteUrl)}/">${markSvg({ accent: 'var(--accent)', size: 30 })}<span class="wordmark">${escapeHtml(cfg.appName)}</span></a>
      </header>
      ${body}
      ${nav}
      <footer>
        <a href="${escapeHtml(cfg.siteUrl)}/archive/">Archive</a> &middot;
        <a href="${escapeHtml(cfg.siteUrl)}/">Subscribe</a><br>
        ${escapeHtml(FOOTER_LINE)}
      </footer>
    </div>
  </div>
</div>
</body>
</html>`;
}

// `index` is the archive index (newest first). It is optional — without it the
// page still renders, it just loses the previous/next links.
export function renderIssuePage(issue, { cfg, index = [] }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const t = theme(d.color);
  const parts = [];

  parts.push(`<div class="eyebrow">${escapeHtml(longDate(issue.date))}</div>
    <h1>${escapeHtml(issue.headline)}</h1>
    <div class="daybar"><span class="dot"></span><span>${escapeHtml(d.feastOrSaint)} &middot; ${escapeHtml(d.season)} &middot; ${escapeHtml(t.label)}${d.isHolyDayOfObligation ? ' &middot; <span class="hdo">Holy day of obligation</span>' : ''}</span></div>
    <hr>`);

  // The verse comes first: one line before anything asks anything of him.
  if (issue.verseOfDay?.ref) {
    const v = issue.verseOfDay;
    parts.push(`<h2>Verse of the day</h2>
      ${v.text
        ? `<blockquote><p>${escapeHtml(v.text)}</p><div class="cite">${escapeHtml(v.ref)} &middot; ${escapeHtml(v.translation || 'Douay-Rheims')}</div></blockquote>`
        : `<p>${escapeHtml(v.ref)}</p>`}`);
  }

  const shown = readingsOf(issue);
  const reading = (p) =>
    p?.ref
      ? `<div class="reading">
          <div class="reading-label">${escapeHtml(p.label)}</div>
          <p class="reading-ref">${escapeHtml(p.ref)}</p>
          ${p.summary ? `<p class="reading-summary">${escapeHtml(p.summary)}</p>` : ''}
          ${p.calledTo ? `<div class="called"><div class="label">You are called to</div><p>${escapeHtml(p.calledTo)}</p></div>` : ''}
        </div>`
      : '';
  parts.push(`<h2>Today at Mass</h2>
    ${reading(shown.epistle)}${reading(shown.gospel)}
    <p class="usccb"><a href="${escapeHtml(r.usccbLink)}">Read them in full at the USCCB &rarr;</a></p>`);

  if (issue.reflection)
    parts.push(`<h2>Reflection</h2>${paragraphs(issue.reflection)}`);

  if (issue.saintStory) {
    parts.push(`<h2>${escapeHtml(issue.saintStory.name || 'Saint of the day')}</h2>
      ${issue.saintStory.isOptional ? '<div class="note">Optional memorial</div>' : ''}
      ${paragraphs(issue.saintStory.life)}
      <div class="action"><div class="label">One thing today</div><p>${escapeHtml(issue.saintStory.oneActionToday)}</p></div>`);
  }

  parts.push(`<h2>Prayer</h2>
    <p class="prayer-title">${escapeHtml(issue.prayer.title)}</p>
    <div class="note">${escapeHtml(issue.prayer.note)}</div>
    ${prayerLines(issue.prayer.text)}`);

  const questions = considerList(issue);
  if (questions.length) {
    parts.push(`<h2>Why we believe what we do</h2>${questions
      .map(
        (q) => `<div class="qa">
          <p class="question">${escapeHtml(q.question)}</p>
          ${paragraphs(q.answer)}
          ${q.citation ? `<div class="cite">${escapeHtml(q.citation)}</div>` : ''}
        </div>`
      )
      .join('')}`);
  }

  return shell({
    title: `${issue.headline} · ${cfg.appName}`,
    description: `${d.feastOrSaint} — ${longDate(issue.date)}. ${cfg.appName}, a daily Catholic devotional.`,
    accentColor: d.color,
    canonical: `${cfg.siteUrl}/${issue.date}/`,
    cfg,
    nav: issueNav(issue.date, index, cfg),
    body: parts.join('\n'),
  });
}

// Previous / next by position in the archive index, so a reader who arrives on
// a shared permalink can keep going instead of hitting a wall.
function issueNav(date, index, cfg) {
  const list = Array.isArray(index) ? index : [];
  const i = list.findIndex((e) => e.date === date);
  const newer = i > 0 ? list[i - 1] : null;
  const older = i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  const link = (entry, label) =>
    entry ? `<a href="${escapeHtml(cfg.siteUrl)}/${escapeHtml(entry.date)}/" rel="${label === 'Previous' ? 'prev' : 'next'}">${label === 'Previous' ? '&larr; ' : ''}${escapeHtml(shortDate(entry.date))}${label === 'Next' ? ' &rarr;' : ''}</a>` : '';
  return `<nav class="issue-nav" aria-label="Issues">
    ${link(older, 'Previous')}
    <span class="spacer"></span>
    <a href="${escapeHtml(cfg.siteUrl)}/today/">Today</a>
    <a href="${escapeHtml(cfg.siteUrl)}/archive/">Archive</a>
    <span class="spacer"></span>
    ${link(newer, 'Next')}
  </nav>`;
}

export function renderArchivePage(index, { cfg }) {
  // Grouped by month: 400 undifferentiated rows is a list you scroll past, and
  // the month is how anyone actually remembers when they read something.
  const groups = [];
  for (const entry of index) {
    const label = monthLabel(entry.date);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, entries: [] });
    groups[groups.length - 1].entries.push(entry);
  }

  const body = groups
    .map(
      (g) => `<h3 class="month">${escapeHtml(g.label)}</h3>
        <ul class="archive">${g.entries
          .map((e) => {
            const t = theme(e.color);
            return `<li>
              <div class="row">
                <time datetime="${escapeHtml(e.date)}">${escapeHtml(dayLabel(e.date))}</time>
                <a href="${escapeHtml(cfg.siteUrl)}/${escapeHtml(e.date)}/"><span class="swatch" style="background:${t.accent}"></span>${escapeHtml(e.headline)}</a>
              </div>
              ${e.feastOrSaint ? `<div class="feast">${escapeHtml(e.feastOrSaint)}</div>` : ''}
            </li>`;
          })
          .join('\n')}</ul>`
    )
    .join('\n');

  return shell({
    title: `Archive · ${cfg.appName}`,
    description: `Every issue of ${cfg.appName}, a daily Catholic devotional.`,
    accentColor: index[0]?.color || 'green',
    canonical: `${cfg.siteUrl}/archive/`,
    cfg,
    body: `<div class="eyebrow">Archive</div><h1>Every issue</h1>
      <div class="daybar"><span>${index.length ? `${index.length} issue${index.length === 1 ? '' : 's'}, newest first` : 'Nothing here yet'}</span></div>
      <hr>
      ${body || '<p>The first issue has not gone out yet.</p>'}`,
  });
}

export function renderTodayRedirect(date, { cfg }) {
  const url = `${cfg.siteUrl}/${date}/`;
  return shell({
    title: `Today · ${cfg.appName}`,
    description: `Today's issue of ${cfg.appName}.`,
    accentColor: 'green',
    cfg,
    extraHead: `<meta http-equiv="refresh" content="0; url=${escapeHtml(url)}">`,
    body: `<h1>Today's issue</h1><p><a href="${escapeHtml(url)}">Continue &rarr;</a></p>`,
  });
}

export function renderSignupPage({ cfg, subscribeEndpoint }) {
  return shell({
    title: `${cfg.appName} — a daily Catholic devotional`,
    description: `${cfg.appName}: the day's Mass readings, a short reflection, a saint, a traditional prayer. One email, every morning.`,
    accentColor: 'green',
    canonical: `${cfg.siteUrl}/`,
    cfg,
    body: `<div class="eyebrow">A daily Catholic devotional</div>
      <h1>The liturgical day, in your inbox before work.</h1>
      <p>One email, every morning, built on the day the Church is actually keeping.</p>
      <table class="readings" style="margin-top:20px">
        <tr><th scope="row">At Mass</th><td>today's readings, with a link to the USCCB</td></tr>
        <tr><th scope="row">Verse</th><td>one line, Douay-Rheims</td></tr>
        <tr><th scope="row">Reflection</th><td>short, and tied to ordinary working life</td></tr>
        <tr><th scope="row">Today</th><td>the saint the Church is keeping, and one thing to do about it</td></tr>
        <tr><th scope="row">Prayer</th><td>a traditional prayer, laid out to be prayed</td></tr>
        <tr><th scope="row">Consider</th><td>one straight answer to one real question about the faith</td></tr>
      </table>
      <p>Free. Unsubscribe in one click, whenever you want.</p>
      <form class="signup" method="POST" action="${escapeHtml(subscribeEndpoint)}">
        <input type="email" name="email" required placeholder="you@example.com" autocomplete="email" aria-label="Email address">
        <button type="submit">Send me the morning issue</button>
      </form>
      <div class="msg">We send a confirmation link first — nothing arrives until you click it.</div>
      <hr>
      <p><a href="${escapeHtml(cfg.siteUrl)}/archive/">Read past issues &rarr;</a></p>`,
  });
}

// Small pages the Worker returns directly for confirm / unsubscribe.
export function renderNotice({ cfg, title, message, accentColor = 'green' }) {
  return shell({
    title: `${title} · ${cfg.appName}`,
    description: title,
    accentColor,
    cfg,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(cfg.siteUrl)}/">Back to ${escapeHtml(cfg.appName)}</a></p>`,
  });
}

function paragraphs(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join('\n');
}

function prayerLines(text) {
  return `<div class="prayer">${stanzas(text)
    .map((block) => `<div class="stanza">${block.map((line) => `<p class="line">${escapeHtml(line)}</p>`).join('')}</div>`)
    .join('')}</div>`;
}

function shortDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// "Thu 6" — en-US puts the number first for this combination, which reads
// like a count rather than a date.
function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const day = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' });
  return `${weekday} ${day}`;
}

function monthLabel(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
