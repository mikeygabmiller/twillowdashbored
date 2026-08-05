/**
 * MORNING DIGEST — rendering.
 *
 * Three outputs from one document: the HTML email, a plain-text fallback, and a
 * ~4-minute audio script for the drive. The HTML is also exactly what the web
 * archive serves, so there is no second layout to keep in sync.
 *
 * Two rules shape everything here:
 *   1. The skeleton never moves. Same sections, same order, every single day —
 *      an empty section says it's empty rather than disappearing, because a
 *      digest whose shape changes daily has to be read instead of scanned.
 *   2. Business numbers sit above anything from the internet. Always.
 */

import { fmtMoney } from './digest-verify.js';

const WPM_READ = 210;     // silent reading
const WPM_SPEAK = 155;    // comfortable TTS pace

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function wordCount(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

export function readingTime(text) {
  return Math.max(1, Math.round(wordCount(text) / WPM_READ));
}

// ---------------------------------------------------------------------------
// Palette — matched to the dashboard (red on near-black chrome, light body).
// ---------------------------------------------------------------------------
const C = {
  bg: '#f4f4f2', card: '#ffffff', ink: '#14140f', body: '#33332c', mute: '#7c7c72',
  line: '#e3e3dd', accent: '#c0261f', accentSoft: '#fdf0ef', good: '#1f7a4d',
  warn: '#9a5b00', warnSoft: '#fdf5e6', chip: '#f0f0ec',
};

function sectionHeader(label, emoji, useEmoji) {
  // Typography-led mode drops the emoji for a letterspaced rule — the same
  // content reading as a briefing rather than a group chat.
  const text = useEmoji && emoji ? `${emoji} ${label}` : label;
  return `<tr><td style="padding:30px 0 4px;border-top:1px solid ${C.line};">
    <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.mute};font-family:inherit;">${esc(text)}</div>
  </td></tr>`;
}

function chip(text, tone) {
  const map = {
    deadline: `background:${C.warnSoft};color:${C.warn};`,
    stakes: `background:#eef7f1;color:${C.good};`,
    story: `background:${C.accentSoft};color:${C.accent};`,
    changed: `background:#eef2fb;color:#2b4c8c;`,
    plain: `background:${C.chip};color:${C.mute};`,
  };
  return `<span style="display:inline-block;${map[tone] || map.plain}border-radius:999px;padding:3px 9px;font-size:11px;font-weight:700;letter-spacing:.02em;margin:0 6px 6px 0;">${esc(text)}</span>`;
}

function para(s, style) {
  return String(s || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<div style="${style}">${esc(p)}</div>`).join('');
}

const P_BODY = `font-size:15px;line-height:1.68;color:${C.body};margin:0 0 10px;`;
const P_HERO = `font-size:16px;line-height:1.72;color:${C.ink};margin:0 0 12px;`;

// ---------------------------------------------------------------------------
// One-tap actions
// ---------------------------------------------------------------------------
// Every tap is both an action and a training signal — that's the whole point of
// putting them in the email instead of in the app. `actionUrl` is injected so
// this file never has to know how tokens are signed.
function actionRow(item, actionUrl) {
  if (!actionUrl) return '';
  const btn = (label, action, bg, fg, border) =>
    `<a href="${esc(actionUrl(item, action))}" style="display:inline-block;text-decoration:none;background:${bg};color:${fg};border:1px solid ${border};border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;margin:0 6px 6px 0;">${esc(label)}</a>`;
  return `<div style="margin-top:10px;">
    ${btn('Buy it', 'buy', C.accent, '#fff', C.accent)}
    ${btn('Not for me', 'reject', '#fff', C.mute, C.line)}
    ${btn('Remind me Friday', 'remind', '#fff', C.mute, C.line)}
  </div>`;
}

function quoteBlock(item) {
  if (!item.quote) return '';
  const src = item.sourceLabel ? ` — ${item.sourceLabel}` : '';
  return `<div style="border-left:3px solid ${C.line};padding:2px 0 2px 12px;margin:10px 0;font-size:13px;line-height:1.6;color:${C.mute};font-style:italic;">
    “${esc(item.quote)}”${esc(src)}
  </div>`;
}

function contestedBlock(item) {
  if (!item.contested || !item.contested.claim || !item.contested.counter) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0;border:1px solid ${C.line};border-radius:10px;">
    <tr>
      <td width="50%" valign="top" style="padding:11px 13px;border-right:1px solid ${C.line};">
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.mute};margin-bottom:5px;">One camp</div>
        <div style="font-size:13px;line-height:1.6;color:${C.body};">${esc(item.contested.claim)}</div>
      </td>
      <td width="50%" valign="top" style="padding:11px 13px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.mute};margin-bottom:5px;">The other</div>
        <div style="font-size:13px;line-height:1.6;color:${C.body};">${esc(item.contested.counter)}</div>
      </td>
    </tr>
  </table>`;
}

function itemChips(item) {
  const bits = [];
  if (item.story) bits.push(chip(item.story, 'story'));
  if (item.deadline) bits.push(chip(item.deadline, 'deadline'));
  if (item.stakes) bits.push(chip(item.stakes, 'stakes'));
  if (item.changedNote) bits.push(chip(item.changedNote, 'changed'));
  return bits.length ? `<div style="margin:2px 0 8px;">${bits.join('')}</div>` : '';
}

function sourceLine(item) {
  const parts = [];
  if (item.sourceLabel) parts.push(esc(item.sourceLabel));
  if (item.url) parts.push(`<a href="${esc(item.url)}" style="color:${C.mute};">source</a>`);
  if (!parts.length) return '';
  return `<div style="font-size:11px;color:${C.mute};margin-top:8px;">${parts.join(' · ')}</div>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function heroBlock(item, actionUrl) {
  if (!item) {
    return `<tr><td style="padding:14px 0 4px;"><div style="${P_BODY}color:${C.mute};">Nothing worth your time today. That's a real answer, not a gap.</div></td></tr>`;
  }
  return `<tr><td style="padding:14px 0 6px;">
    <div style="font-size:20px;font-weight:800;line-height:1.35;color:${C.ink};margin-bottom:8px;">${esc(item.title)}</div>
    ${itemChips(item)}
    ${para(item.point, P_HERO)}
    ${item.priceNote ? `<div style="${P_BODY}background:${C.warnSoft};border-radius:8px;padding:10px 12px;color:${C.warn};">${esc(item.priceNote)}</div>` : ''}
    ${contestedBlock(item)}
    ${quoteBlock(item)}
    ${sourceLine(item)}
    ${actionRow(item, actionUrl)}
  </td></tr>`;
}

function briefRow(item, actionUrl) {
  return `<tr><td style="padding:0 0 18px;">
    <div style="font-size:14px;font-weight:700;line-height:1.45;color:${C.ink};margin-bottom:5px;">${esc(item.title)}</div>
    ${itemChips(item)}
    ${para(item.point, P_BODY)}
    ${item.priceNote ? `<div style="font-size:13px;line-height:1.6;color:${C.warn};margin:0 0 8px;">${esc(item.priceNote)}</div>` : ''}
    ${contestedBlock(item)}
    ${quoteBlock(item)}
    ${sourceLine(item)}
    ${actionRow(item, actionUrl)}
  </td></tr>`;
}

function numbersBlock(biz) {
  if (!biz) return '';
  const tile = (label, value, tone) => `
    <td width="33%" valign="top" style="padding:0 6px 12px 0;">
      <div style="background:${C.chip};border-radius:10px;padding:12px 13px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${C.mute};">${esc(label)}</div>
        <div style="font-size:19px;font-weight:800;color:${tone || C.ink};margin-top:4px;">${esc(value)}</div>
      </div>
    </td>`;
  const rows = [];
  const tiles = [
    ['Month net', '$' + fmtMoney(biz.monthNet || 0), (biz.monthNet || 0) >= 0 ? C.ink : C.accent],
    ['Jobs today', String(biz.jobsToday == null ? '—' : biz.jobsToday), C.ink],
    ['Booked tomorrow', String(biz.jobsTomorrow == null ? '—' : biz.jobsTomorrow), C.ink],
    ['Unanswered leads', String(biz.unanswered || 0), (biz.unanswered || 0) > 0 ? C.accent : C.ink],
    ['Week gross', '$' + fmtMoney(biz.weekGross || 0), C.ink],
    ['Reviews (30d)', String(biz.reviews30 == null ? '—' : biz.reviews30), C.ink],
  ];
  for (let i = 0; i < tiles.length; i += 3) {
    rows.push('<tr>' + tiles.slice(i, i + 3).map((t) => tile(t[0], t[1], t[2])).join('') + '</tr>');
  }
  const lines = (biz.lines || []).map((l) =>
    `<div style="${P_BODY}"><span style="color:${l.tone === 'bad' ? C.accent : l.tone === 'good' ? C.good : C.body};font-weight:${l.tone ? 700 : 400};">${esc(l.text)}</span></div>`).join('');
  return `<tr><td style="padding:14px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>
    ${lines}
  </td></tr>`;
}

function planBlock(plan) {
  if (!plan || !plan.entries || !plan.entries.length) {
    return `<tr><td style="padding:12px 0 4px;"><div style="${P_BODY}color:${C.mute};">${esc(plan && plan.empty ? plan.empty : 'Nothing on the book for tomorrow.')}</div></td></tr>`;
  }
  const rows = plan.entries.map((e) => `
    <tr><td style="padding:0 0 10px;">
      <div style="font-size:14px;font-weight:700;color:${C.ink};">${esc(e.when)} · ${esc(e.what)}</div>
      <div style="font-size:13px;line-height:1.6;color:${e.tone === 'bad' ? C.accent : e.tone === 'warn' ? C.warn : C.body};margin-top:3px;">${esc(e.note)}</div>
    </td></tr>`).join('');
  return `<tr><td style="padding:12px 0 0;"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    ${plan.summary ? `<div style="${P_BODY}color:${C.mute};">${esc(plan.summary)}</div>` : ''}</td></tr>`;
}

function listBlock(items, emptyText, tone) {
  if (!items || !items.length) {
    return emptyText ? `<tr><td style="padding:12px 0 0;"><div style="${P_BODY}color:${C.mute};">${esc(emptyText)}</div></td></tr>` : '';
  }
  const color = tone === 'warn' ? C.warn : C.body;
  return `<tr><td style="padding:12px 0 0;">${items.map((t) =>
    `<div style="${P_BODY}color:${color};">• ${esc(typeof t === 'string' ? t : t.text)}</div>`).join('')}</td></tr>`;
}

function skimBlock(lines, actionUrl) {
  if (!lines || !lines.length) return '';
  return `<tr><td style="padding:12px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.chip};border-radius:10px;">
      <tr><td style="padding:14px 16px;">
        ${lines.map((l) => `<div style="font-size:13px;line-height:1.62;color:${C.body};margin-bottom:6px;">
            <span style="color:${C.mute};">${esc(l.topic)}</span> &nbsp;${esc(l.text)}
          </div>`).join('')}
      </td></tr>
    </table>
  </td></tr>`;
}

function questionBlock(q, replyUrl) {
  if (!q) return '';
  return `<tr><td style="padding:12px 0 0;">
    <div style="border:2px solid ${C.accentSoft};background:${C.accentSoft};border-radius:12px;padding:15px 17px;">
      <div style="font-size:15px;line-height:1.6;color:${C.ink};font-weight:700;">${esc(q)}</div>
      <div style="font-size:12px;line-height:1.6;color:${C.mute};margin-top:7px;">
        Reply to this email — or text the business number starting with <b>#answer</b> — and your answer goes
        straight into the context doc. It changes what tomorrow's rundown knows about you.
      </div>
      ${replyUrl ? `<div style="margin-top:9px;"><a href="${esc(replyUrl)}" style="font-size:12px;font-weight:700;color:${C.accent};text-decoration:none;">Answer in the app →</a></div>` : ''}
    </div>
  </td></tr>`;
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------
export function renderDigest(d, opts = {}) {
  const useEmoji = opts.emojiHeaders !== false;
  const actionUrl = opts.actionUrl || null;
  const base = String(opts.baseUrl || '').replace(/\/+$/, '');
  const archiveUrl = base ? base + '/digest.html' : '';
  const audioUrl = base && d.id ? `${base}/digest.html?id=${encodeURIComponent(d.id)}&audio=1` : '';
  const replyUrl = base ? base + '/digest.html?ask=1' : '';

  const text = renderText(d);
  const readingMin = readingTime(text);

  const blocks = [];
  const H = (label, emoji) => blocks.push(sectionHeader(label, emoji, useEmoji));

  // 1 — Your numbers. Above the internet, every day, no exceptions.
  H('Your numbers', '💵');
  blocks.push(numbersBlock(d.business));

  // 2 — Tomorrow's plan, weather included.
  H('The plan', '📅');
  blocks.push(planBlock(d.plan));

  // 3 — Skim version, so the full read is optional.
  if (d.skim && d.skim.length) {
    H('The whole thing in 30 seconds', '⚡');
    blocks.push(skimBlock(d.skim, actionUrl));
  }

  // 4 — One hero, full length.
  H('Today\'s one thing', '⭐');
  blocks.push(heroBlock(d.hero, actionUrl));

  // 5 — Deals, sorted by when they die, not by how exciting they are.
  H('Clock is running', '⏳');
  if (d.deals && d.deals.length) {
    blocks.push(`<tr><td style="padding:12px 0 0;"><table width="100%" cellpadding="0" cellspacing="0">${d.deals.map((i) => briefRow(i, actionUrl)).join('')}</table></td></tr>`);
  } else {
    blocks.push(`<tr><td style="padding:12px 0 0;"><div style="${P_BODY}color:${C.mute};">Nothing with a deadline today.</div></td></tr>`);
  }

  // 6 — Briefs, grouped, in a topic order that never changes.
  H('Briefs', '📌');
  if (d.briefs && d.briefs.length) {
    blocks.push(`<tr><td style="padding:12px 0 0;">${d.briefs.map((g) => `
      <div style="font-size:12px;font-weight:700;color:${C.accent};margin:6px 0 10px;">${esc(useEmoji && g.emoji ? g.emoji + ' ' + g.label : g.label)}</div>
      <table width="100%" cellpadding="0" cellspacing="0">${g.items.map((i) => briefRow(i, actionUrl)).join('')}</table>
    `).join('')}</td></tr>`);
  } else {
    blocks.push(`<tr><td style="padding:12px 0 0;"><div style="${P_BODY}color:${C.mute};">Nothing worth your time today.</div></td></tr>`);
  }

  // 7 — What did NOT happen.
  H('What didn\'t happen', '🕳️');
  blocks.push(listBlock(d.absence, 'Every routine thing showed up on schedule.', 'warn'));

  // 8 — Season ahead of time, not during.
  H('Coming at you', '🌦️');
  blocks.push(listBlock(d.seasonal, 'Nothing seasonal on the horizon this week.'));

  // 9 — Skill of the day, in sequence.
  H('Today\'s skill', '🎓');
  if (d.skill) {
    blocks.push(`<tr><td style="padding:12px 0 0;">
      <div style="font-size:14px;font-weight:700;color:${C.ink};margin-bottom:5px;">${esc(d.skill.title)}${d.skill.n ? ` <span style="color:${C.mute};font-weight:400;">· ${esc(d.skill.n)}</span>` : ''}</div>
      ${para(d.skill.body, P_BODY)}
    </td></tr>`);
  } else {
    blocks.push(`<tr><td style="padding:12px 0 0;"><div style="${P_BODY}color:${C.mute};">Curriculum finished — add more in the app.</div></td></tr>`);
  }

  // 10 — One question, every day.
  H('One question', '❓');
  blocks.push(questionBlock(d.question, replyUrl));

  const html = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(d.headline || d.dateLabel)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:22px 10px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.card};border-radius:14px;padding:28px 26px 30px;font-family:${useEmoji ? '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif' : 'Iowan Old Style,Palatino,Georgia,\'Times New Roman\',serif'};">
  <tr><td>
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${C.mute};">
      Morning rundown · ${esc(d.dateLabel)} · ${readingMin} min read
    </div>
    ${d.headline ? `<div style="font-size:23px;line-height:1.34;font-weight:800;color:${C.ink};margin-top:11px;">${esc(d.headline)}</div>` : ''}
    ${d.subhead ? `<div style="font-size:13px;line-height:1.6;color:${C.mute};margin-top:7px;">${esc(d.subhead)}</div>` : ''}
  </td></tr>
  ${blocks.join('')}
  <tr><td style="padding:26px 0 0;border-top:1px solid ${C.line};">
    <div style="font-size:12px;line-height:1.7;color:${C.mute};">
      ${archiveUrl ? `<a href="${esc(archiveUrl)}" style="color:${C.mute};font-weight:700;">Archive &amp; search</a> · ` : ''}
      ${audioUrl ? `<a href="${esc(audioUrl)}" style="color:${C.mute};font-weight:700;">Listen (${d.audioMin || 4} min)</a> · ` : ''}
      Reply in plain English to retune it — “less Overwatch, more coatings” works.
    </div>
    ${d.diagnosticsNote ? `<div style="font-size:11px;color:${C.mute};margin-top:8px;">${esc(d.diagnosticsNote)}</div>` : ''}
  </td></tr>
</table>
</td></tr></table>`;

  return { html, text, readingMin, wordCount: wordCount(text), audioScript: renderAudioScript(d) };
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------
function rule(label) { return `\n\n${label.toUpperCase()}\n${'-'.repeat(Math.max(12, label.length))}`; }

export function renderText(d) {
  const L = [];
  L.push(`MORNING RUNDOWN — ${d.dateLabel}`);
  if (d.headline) L.push('\n' + d.headline);

  L.push(rule('Your numbers'));
  const b = d.business || {};
  L.push(`Month net $${fmtMoney(b.monthNet || 0)} · week gross $${fmtMoney(b.weekGross || 0)} · jobs today ${b.jobsToday == null ? '—' : b.jobsToday} · booked tomorrow ${b.jobsTomorrow == null ? '—' : b.jobsTomorrow} · unanswered leads ${b.unanswered || 0}`);
  for (const l of (b.lines || [])) L.push('• ' + l.text);

  L.push(rule('The plan'));
  if (d.plan && d.plan.entries && d.plan.entries.length) {
    for (const e of d.plan.entries) L.push(`${e.when} · ${e.what}\n  ${e.note}`);
    if (d.plan.summary) L.push(d.plan.summary);
  } else L.push((d.plan && d.plan.empty) || 'Nothing on the book for tomorrow.');

  if (d.skim && d.skim.length) {
    L.push(rule('30-second version'));
    for (const s of d.skim) L.push(`[${s.topic}] ${s.text}`);
  }

  L.push(rule("Today's one thing"));
  L.push(d.hero ? itemText(d.hero) : "Nothing worth your time today. That's a real answer, not a gap.");

  L.push(rule('Clock is running'));
  if (d.deals && d.deals.length) for (const i of d.deals) L.push(itemText(i));
  else L.push('Nothing with a deadline today.');

  L.push(rule('Briefs'));
  if (d.briefs && d.briefs.length) {
    for (const g of d.briefs) { L.push(`\n${g.label}`); for (const i of g.items) L.push(itemText(i)); }
  } else L.push('Nothing worth your time today.');

  L.push(rule("What didn't happen"));
  L.push((d.absence || []).length ? (d.absence).map((a) => '• ' + (a.text || a)).join('\n') : 'Every routine thing showed up on schedule.');

  L.push(rule('Coming at you'));
  L.push((d.seasonal || []).length ? (d.seasonal).map((a) => '• ' + (a.text || a)).join('\n') : 'Nothing seasonal on the horizon this week.');

  L.push(rule("Today's skill"));
  L.push(d.skill ? `${d.skill.title}${d.skill.n ? ' · ' + d.skill.n : ''}\n${d.skill.body}` : 'Curriculum finished — add more in the app.');

  if (d.question) { L.push(rule('One question')); L.push(d.question); L.push('(Reply to this email, or text "#answer …", and it lands in your context doc.)'); }

  return L.join('\n');
}

function itemText(i) {
  const bits = [];
  const tags = [i.story, i.deadline, i.stakes, i.changedNote].filter(Boolean);
  bits.push(`\n${i.title}${tags.length ? ' [' + tags.join(' | ') + ']' : ''}`);
  bits.push(i.point);
  if (i.priceNote) bits.push('! ' + i.priceNote);
  if (i.contested && i.contested.claim) bits.push(`Contested — one camp: ${i.contested.claim}  |  the other: ${i.contested.counter}`);
  if (i.quote) bits.push(`"${i.quote}"${i.sourceLabel ? ' — ' + i.sourceLabel : ''}`);
  if (i.url) bits.push('  ↳ ' + i.url);
  return bits.join('\n');
}

// ---------------------------------------------------------------------------
// Audio script (~4 minutes)
// ---------------------------------------------------------------------------
// Written for the ear: no URLs, no bullet characters, no "r slash" — and hard
// budgeted so it stays a commute, not a podcast.
export function renderAudioScript(d, opts = {}) {
  const budget = Math.round((opts.minutes || 4) * WPM_SPEAK);
  const out = [];
  let used = 0;
  const add = (s) => {
    const t = speakable(s);
    if (!t) return false;
    const w = wordCount(t);
    if (used + w > budget) return false;
    out.push(t); used += w; return true;
  };

  add(`Good morning. Here's ${d.dateLabel}.`);
  const b = d.business || {};
  add(`First, your numbers. Month to date you're net ${moneySpoken(b.monthNet)}, on ${b.monthJobs || 0} jobs. ` +
      `${b.jobsTomorrow ? `You've got ${b.jobsTomorrow} on the book tomorrow.` : 'Nothing on the book for tomorrow yet.'} ` +
      `${b.unanswered ? `${b.unanswered} lead${b.unanswered === 1 ? '' : 's'} still waiting on a reply from you.` : 'No leads waiting on you.'}`);
  for (const l of (b.lines || []).slice(0, 2)) add(l.text);

  if (d.plan && d.plan.entries && d.plan.entries.length) {
    add('Now tomorrow.');
    for (const e of d.plan.entries.slice(0, 4)) add(`${e.when}, ${e.what}. ${e.note}`);
  }

  if (d.hero) { add('The one thing worth your attention today.'); add(d.hero.title + '.'); add(d.hero.point); if (d.hero.priceNote) add(d.hero.priceNote); }
  for (const i of (d.deals || []).slice(0, 2)) add(`${i.title}. ${i.point}${i.deadline ? ' ' + i.deadline + '.' : ''}`);

  for (const g of (d.briefs || [])) {
    for (const i of (g.items || []).slice(0, 2)) if (!add(`${i.title}. ${firstSentences(i.point, 2)}`)) break;
  }
  for (const a of (d.absence || []).slice(0, 1)) add(a.text || a);
  if (d.skill) add(`Today's skill. ${d.skill.title}. ${firstSentences(d.skill.body, 3)}`);
  if (d.question) add(`And a question for you. ${d.question}`);
  add('That\'s it. Go make money.');

  const script = out.join('\n\n');
  return { script, words: used, minutes: Math.max(1, Math.round(used / WPM_SPEAK)) };
}

function speakable(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\br\/(\w+)/gi, '$1')
    .replace(/[•·↳*_#>]/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, (_, n) => moneySpoken(parseFloat(String(n).replace(/,/g, ''))))
    .replace(/\s+/g, ' ')
    .trim();
}

function moneySpoken(n) {
  const v = Number(n);
  if (!isFinite(v)) return 'nothing';
  const neg = v < 0;
  const a = Math.abs(v);
  const whole = Math.round(a * 100) / 100;
  const s = whole % 1 === 0 ? `${fmtMoney(whole)} dollars` : `${fmtMoney(whole)} dollars`;
  return (neg ? 'minus ' : '') + s;
}

function firstSentences(text, n) {
  const parts = String(text || '').match(/[^.!?]+[.!?]+/g) || [String(text || '')];
  return parts.slice(0, n).join(' ').trim();
}
