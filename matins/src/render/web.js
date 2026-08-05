// The web surface. Same issue, same identity as the email — one build feeds
// both. Pages are fully self-contained static HTML (no build step, no JS
// framework) because they get committed straight to GitHub Pages.

import { theme, SERIF, SANS, escapeHtml, longDate } from './theme.js';
import { markSvg } from './brand.js';
import { FOOTER_LINE } from '../config.js';

function shell({ title, description, accentColor, body, cfg, canonical, extraHead = '' }) {
  const t = theme(accentColor);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : ''}
<meta name="twitter:card" content="summary">
<link rel="icon" href="${escapeHtml(cfg.siteUrl)}/mark.svg" type="image/svg+xml">
<style>
  :root { --accent:${t.accent}; --tint:${t.tint}; --paper:${t.paper}; --paper-alt:${t.paperAlt}; --ink:${t.ink}; --ink-soft:${t.inkSoft}; --rule:${t.rule}; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper-alt);color:var(--ink);font-family:${SERIF};line-height:1.7;-webkit-font-smoothing:antialiased}
  .wrap{max-width:660px;margin:0 auto;padding:28px 18px 64px}
  .sheet{background:var(--paper);border:1px solid var(--rule);border-radius:12px;padding:34px 32px 30px}
  header.brand{display:flex;align-items:center;gap:11px;margin-bottom:26px}
  header.brand a{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--ink)}
  .wordmark{font-size:22px;letter-spacing:.14em;text-transform:uppercase}
  .eyebrow{font-family:${SANS};font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
  h1{font-weight:400;font-size:clamp(26px,5vw,34px);line-height:1.25;margin:.35em 0 .5em}
  .daybar{font-family:${SANS};font-size:13px;color:var(--ink-soft);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block}
  hr{border:0;border-top:1px solid var(--rule);margin:22px 0}
  h2{font-family:${SANS};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);font-weight:600;margin:32px 0 10px}
  p{font-size:17.5px;margin:0 0 15px}
  a{color:var(--accent)}
  .readings{width:100%;border-collapse:collapse;margin-bottom:10px}
  .readings th{font-family:${SANS};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);text-align:left;font-weight:500;padding:0 14px 6px 0;white-space:nowrap;vertical-align:top}
  .readings td{padding:0 0 6px 0;font-size:16.5px}
  blockquote{margin:0;border-left:3px solid var(--accent);padding-left:16px;font-style:italic;font-size:19px}
  .cite{font-family:${SANS};font-style:normal;font-size:12px;color:var(--ink-soft)}
  .action{background:var(--tint);border-radius:8px;padding:15px 17px;margin-top:6px}
  .action .label{font-family:${SANS};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:5px}
  .action p{font-size:16.5px;margin:0}
  .prayer{white-space:pre-line}
  .note{font-family:${SANS};font-size:13px;color:var(--ink-soft);margin:-6px 0 12px}
  footer{font-family:${SANS};font-size:13px;color:var(--ink-soft);margin-top:34px;padding-top:18px;border-top:1px solid var(--rule);line-height:1.75}
  ul.archive{list-style:none;margin:0;padding:0}
  ul.archive li{border-bottom:1px solid var(--rule);padding:14px 0;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
  ul.archive time{font-family:${SANS};font-size:12px;color:var(--ink-soft);min-width:104px}
  ul.archive a{text-decoration:none;font-size:18px}
  ul.archive a:hover{text-decoration:underline}
  .swatch{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
  form.signup{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 6px}
  form.signup input{flex:1 1 240px;font-family:${SANS};font-size:16px;padding:12px 14px;border:1px solid var(--rule);border-radius:8px;background:#fff;color:var(--ink)}
  form.signup button{font-family:${SANS};font-size:15px;padding:12px 22px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
  .msg{font-family:${SANS};font-size:14px;margin-top:10px}
  @media (max-width:520px){ .sheet{padding:24px 20px} }
</style>
${extraHead}
</head>
<body>
<div class="wrap">
  <div class="sheet">
    <header class="brand">
      <a href="${escapeHtml(cfg.siteUrl)}/">${markSvg({ accent: t.accent, size: 30 })}<span class="wordmark">${escapeHtml(cfg.appName)}</span></a>
    </header>
    ${body}
    <footer>
      <a href="${escapeHtml(cfg.siteUrl)}/archive/">Archive</a> ·
      <a href="${escapeHtml(cfg.siteUrl)}/">Subscribe</a><br>
      ${escapeHtml(FOOTER_LINE)}
    </footer>
  </div>
</div>
</body>
</html>`;
}

export function renderIssuePage(issue, { cfg }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const t = theme(d.color);
  const parts = [];

  parts.push(`<div class="eyebrow">${escapeHtml(longDate(issue.date))}</div>
    <h1>${escapeHtml(issue.headline)}</h1>
    <div class="daybar"><span class="dot"></span>${escapeHtml(d.feastOrSaint)} · ${escapeHtml(d.season)} · ${escapeHtml(t.label)}${d.isHolyDayOfObligation ? ' · Holy day of obligation' : ''}</div>
    <hr>`);

  const row = (label, ref) => (ref ? `<tr><th>${label}</th><td>${escapeHtml(ref)}</td></tr>` : '');
  const rows = [row('First', r.firstRef), row('Psalm', r.psalmRef), row('Second', r.secondRef), row('Gospel', r.gospelRef)].join('');
  parts.push(`<h2>Today at Mass</h2>
    ${rows ? `<table class="readings">${rows}</table>` : ''}
    <p><a href="${escapeHtml(r.usccbLink)}">Read today's readings at the USCCB &rarr;</a></p>`);

  if (issue.verseOfDay?.ref) {
    const v = issue.verseOfDay;
    parts.push(`<h2>Verse of the day</h2>
      ${v.text
        ? `<blockquote><p>${escapeHtml(v.text)}</p><div class="cite">${escapeHtml(v.ref)} · ${escapeHtml(v.translation || 'Douay-Rheims')}</div></blockquote>`
        : `<p>${escapeHtml(v.ref)}</p>`}`);
  }

  if (issue.reflection) parts.push(`<h2>Reflection</h2>${paragraphs(issue.reflection)}`);

  if (issue.saintStory) {
    parts.push(`<h2>Today</h2>${paragraphs(issue.saintStory.life)}
      <div class="action"><div class="label">One thing today</div><p>${escapeHtml(issue.saintStory.oneActionToday)}</p></div>`);
  }

  parts.push(`<h2>Prayer</h2>
    <p style="margin-bottom:4px;">${escapeHtml(issue.prayer.title)}</p>
    <div class="note">${escapeHtml(issue.prayer.note)}</div>
    <p class="prayer">${escapeHtml(issue.prayer.text)}</p>`);

  parts.push(`<h2>Consider</h2>
    <p style="margin-bottom:8px;">${escapeHtml(issue.consider.question)}</p>
    ${paragraphs(issue.consider.answer)}
    ${issue.consider.citation ? `<div class="cite">${escapeHtml(issue.consider.citation)}</div>` : ''}`);

  return shell({
    title: `${issue.headline} · ${cfg.appName}`,
    description: `${d.feastOrSaint} — ${longDate(issue.date)}. ${cfg.appName}, a daily Catholic devotional.`,
    accentColor: d.color,
    canonical: `${cfg.siteUrl}/${issue.date}/`,
    cfg,
    body: parts.join('\n'),
  });
}

export function renderArchivePage(index, { cfg }) {
  const items = index
    .map((e) => {
      const t = theme(e.color);
      return `<li><time datetime="${escapeHtml(e.date)}">${escapeHtml(shortDate(e.date))}</time>
        <a href="${escapeHtml(cfg.siteUrl)}/${escapeHtml(e.date)}/"><span class="swatch" style="background:${t.accent}"></span>${escapeHtml(e.headline)}</a></li>`;
    })
    .join('\n');
  return shell({
    title: `Archive · ${cfg.appName}`,
    description: `Every issue of ${cfg.appName}, a daily Catholic devotional.`,
    accentColor: index[0]?.color || 'green',
    canonical: `${cfg.siteUrl}/archive/`,
    cfg,
    body: `<div class="eyebrow">Archive</div><h1>Every issue</h1><hr>
      ${items ? `<ul class="archive">${items}</ul>` : '<p>The first issue has not gone out yet.</p>'}`,
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
      <p>Every morning: today's Mass readings with a link to the USCCB, a short reflection tied to ordinary working life, the saint the Church is keeping today and one thing to do about it, a traditional prayer, and one straight answer to one real question about the faith.</p>
      <p>Free. One email a day. Unsubscribe in one click, whenever you want.</p>
      <form class="signup" method="POST" action="${escapeHtml(subscribeEndpoint)}">
        <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address">
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

function shortDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
