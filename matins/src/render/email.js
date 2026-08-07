// Email rendering: tables, inline styles, no external CSS, no web fonts, no
// images. Preheader is the headline. Sections that were dropped or degraded
// simply are not here — the issue never explains its own machinery to readers.
//
// Layout rules, so the whole thing stays scannable at five in the morning:
//   * one hairline rule between sections, never inside one;
//   * ~66 characters to the line, which is what the 34px gutters are for;
//   * prayers keep their line breaks (see render/prayer.js) — they are said,
//     not skimmed;
//   * the liturgical colour appears as a band at the top and as the section
//     labels, so the day announces itself before a word is read.
//
// The email stays light-mode on purpose. See render/theme.js.

import { theme, SERIF, SANS, escapeHtml, longDate } from './theme.js';
import { stanzas, stanzasToText } from './prayer.js';
import { considerList, readingsOf } from './compat.js';
import { wordmarkText } from './brand.js';
import { FOOTER_LINE } from '../config.js';

const GUTTER = 34;

export function renderEmail(issue, { cfg, unsubscribeUrl, permalink }) {
  const t = theme(issue.liturgicalDay.color);
  const url = permalink || `${cfg.siteUrl}/${issue.date}/`;
  const unsub = unsubscribeUrl || `${cfg.siteUrl}/`;
  return {
    // The headline alone. Appending the feast used to push the interesting
    // half of the line past where a phone truncates it, and the feast is
    // already the first thing in the preview line underneath.
    subject: sentenceCase(issue.headline),
    preheader: preheader(issue),
    html: html(issue, { cfg, t, url, unsub }),
    text: text(issue, { cfg, url, unsub }),
  };
}

// The inbox preview line. The headline alone repeats the subject and wastes the
// one bit of the email a reader sees before opening it, so it carries what is
// actually in today's issue instead.
function preheader(issue) {
  const bits = [issue.liturgicalDay.feastOrSaint];
  if (issue.readings?.gospelRef) bits.push(issue.readings.gospelRef);
  bits.push(issue.prayer.title);
  return bits.join(' · ');
}

// Headlines are written lower case, which is right on the page and reads like
// a mistake in a subject line. Only the first letter moves.
function sentenceCase(s) {
  const line = String(s || '').trim();
  return line ? line[0].toUpperCase() + line.slice(1) : line;
}

// `first` skips the divider so the header rule isn't doubled.
function section(t, title, inner, { first = false, note = null } = {}) {
  return `<tr><td style="padding:${first ? 4 : 30}px ${GUTTER}px 0 ${GUTTER}px;">
    ${first ? '' : `<div style="border-top:1px solid ${t.rule};font-size:1px;line-height:1px;margin-bottom:26px;">&nbsp;</div>`}
    <div style="font-family:${SANS};font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:${t.accent};font-weight:700;">${escapeHtml(title)}</div>
    ${note ? `<div style="height:5px;line-height:5px;">&nbsp;</div><div style="font-family:${SANS};font-size:12px;color:${t.inkSoft};">${escapeHtml(note)}</div>` : ''}
    <div style="height:12px;line-height:12px;">&nbsp;</div>
    ${inner}
  </td></tr>`;
}

function para(t, s, { size = 17, last = false } = {}) {
  const style = `margin:0 0 ${last ? 0 : 15}px 0;font-family:${SERIF};font-size:${size}px;line-height:1.7;color:${t.ink};`;
  return String(s)
    .split(/\n{2,}/)
    .map((p) => `<p style="${style}">${escapeHtml(p.trim())}</p>`)
    .join('');
}

// A prayer, line for line. Each line is its own block so a long line wraps with
// a hanging indent instead of looking like the start of a new one.
function prayerBlock(t, textBody) {
  return stanzas(textBody)
    .map(
      (block) =>
        `<div style="margin:0 0 14px 0;">${block
          .map(
            (line) =>
              `<div style="font-family:${SERIF};font-size:17.5px;line-height:1.58;color:${t.ink};padding-left:14px;text-indent:-14px;">${escapeHtml(line)}</div>`
          )
          .join('')}</div>`
    )
    .join('');
}

function html(issue, { cfg, t, url, unsub }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const rows = [];

  // Two readings — the epistle and the Gospel — each with what happens in it
  // and what it asks. The scripture TEXT is never reproduced: the summary is
  // written from it, in other words. See lib/issue.js.
  const reading = (p) => {
    if (!p?.ref) return '';
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;">
      <tr><td>
        <div style="font-family:${SANS};font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${t.inkSoft};font-weight:700;">${escapeHtml(p.label)}</div>
        <div style="height:4px;line-height:4px;">&nbsp;</div>
        <div style="font-family:${SERIF};font-size:18px;line-height:1.35;color:${t.ink};">${escapeHtml(p.ref)}</div>
        ${p.summary
          ? `<div style="height:9px;line-height:9px;">&nbsp;</div>
             <p style="margin:0;font-family:${SERIF};font-size:16.5px;line-height:1.65;color:${t.ink};">${escapeHtml(p.summary)}</p>`
          : ''}
        ${p.calledTo
          ? `<div style="height:11px;line-height:11px;">&nbsp;</div>
             <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
               <tr>
                 <td width="3" style="width:3px;background:${t.accent};font-size:1px;line-height:1px;">&nbsp;</td>
                 <td style="padding:1px 0 1px 14px;">
                   <div style="font-family:${SANS};font-size:10.5px;letter-spacing:0.13em;text-transform:uppercase;color:${t.accent};font-weight:700;">You are called to</div>
                   <div style="height:4px;line-height:4px;">&nbsp;</div>
                   <div style="font-family:${SERIF};font-size:16.5px;line-height:1.6;color:${t.ink};">${escapeHtml(p.calledTo)}</div>
                 </td>
               </tr>
             </table>`
          : ''}
      </td></tr>
    </table>`;
  };
  const usccb = `<a href="${escapeHtml(r.usccbLink)}" style="font-family:${SANS};font-size:14px;color:${t.accent};text-decoration:underline;font-weight:600;">Read them in full at the USCCB &rarr;</a>`;
  const shown = readingsOf(issue);
  const readingBlocks = `${reading(shown.epistle)}${reading(shown.gospel)}`;
  rows.push(section(t, 'Today at Mass', `${readingBlocks}${usccb}`, { first: true }));

  if (issue.verseOfDay?.ref) {
    const v = issue.verseOfDay;
    rows.push(
      section(
        t,
        'Verse of the day',
        v.text
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
               <tr>
                 <td width="3" style="width:3px;background:${t.accent};font-size:1px;line-height:1px;">&nbsp;</td>
                 <td style="padding:2px 0 2px 18px;">
                   <p style="margin:0 0 10px 0;font-family:${SERIF};font-size:19.5px;line-height:1.62;color:${t.ink};font-style:italic;">${escapeHtml(v.text)}</p>
                   <div style="font-family:${SANS};font-size:12px;letter-spacing:0.02em;color:${t.inkSoft};">${escapeHtml(v.ref)} &middot; ${escapeHtml(v.translation || 'Douay-Rheims')}</div>
                 </td>
               </tr>
             </table>`
          : `<div style="font-family:${SERIF};font-size:19px;color:${t.ink};">${escapeHtml(v.ref)}</div>`
      )
    );
  }

  if (issue.reflection) {
    // The closing line is a prayer, not a summary, so it is set apart from the
    // prose rather than reading as its last sentence.
    const closer = issue.reflectionCloser
      ? `<div style="height:6px;line-height:6px;">&nbsp;</div>
         <div style="font-family:${SERIF};font-size:17px;line-height:1.55;color:${t.accent};font-style:italic;">${escapeHtml(issue.reflectionCloser)}</div>`
      : '';
    rows.push(section(t, 'Reflection', `${para(t, issue.reflection, { last: true })}${closer}`));
  }

  if (issue.saintStory) {
    rows.push(
      section(
        t,
        issue.saintStory.name || 'Saint of the day',
        `${para(t, issue.saintStory.life)}
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${t.tint};border-radius:8px;">
           <tr><td style="padding:16px 18px;">
             <div style="font-family:${SANS};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:${t.accent};font-weight:700;">One thing today</div>
             <div style="height:7px;line-height:7px;">&nbsp;</div>
             <div style="font-family:${SERIF};font-size:16.5px;line-height:1.6;color:${t.ink};">${escapeHtml(issue.saintStory.oneActionToday)}</div>
           </td></tr>
         </table>`,
        { note: issue.saintStory.isOptional ? 'Optional memorial' : null }
      )
    );
  }

  rows.push(
    section(
      t,
      'Prayer',
      `<div style="font-family:${SERIF};font-size:21px;line-height:1.3;color:${t.ink};">${escapeHtml(issue.prayer.title)}</div>
       <div style="height:6px;line-height:6px;">&nbsp;</div>
       <div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${t.inkSoft};font-style:italic;">${escapeHtml(issue.prayer.note)}</div>
       <div style="height:16px;line-height:16px;">&nbsp;</div>
       ${prayerBlock(t, issue.prayer.text)}`
    )
  );

  // Three questions now. Separated by space rather than by rules, so they read
  // as one section rather than three.
  const questions = considerList(issue);
  if (questions.length) {
    rows.push(
      section(
        t,
        'Why we believe what we do',
        questions
          .map(
            (q, i) => `<div style="${i ? 'margin-top:26px;' : ''}">
              <div style="font-family:${SERIF};font-size:19px;line-height:1.4;color:${t.ink};">${escapeHtml(q.question)}</div>
              <div style="height:10px;line-height:10px;">&nbsp;</div>
              ${para(t, q.answer, { size: 16.5, last: true })}
              ${q.citation ? `<div style="height:10px;line-height:10px;">&nbsp;</div><div style="font-family:${SANS};font-size:12px;color:${t.inkSoft};">${escapeHtml(q.citation)}</div>` : ''}
            </div>`
          )
          .join('')
      )
    );
  }

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(issue.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${t.paperAlt};-webkit-font-smoothing:antialiased;">
<div style="display:none;font-size:1px;color:${t.paperAlt};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader(issue))}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${t.paperAlt};">
<tr><td align="center" style="padding:28px 12px 40px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${t.paper};border:1px solid ${t.rule};border-radius:12px;overflow:hidden;">
    <!-- The liturgical colour of the day, before anything is read. -->
    <tr><td style="background:${t.accent};height:5px;font-size:1px;line-height:5px;">&nbsp;</td></tr>
    <tr><td style="padding:30px ${GUTTER}px 0 ${GUTTER}px;">
      ${wordmarkText({ appName: cfg.appName, accent: t.accent, ink: t.ink })}
    </td></tr>
    <tr><td style="padding:24px ${GUTTER}px 0 ${GUTTER}px;">
      <div style="font-family:${SANS};font-size:12px;letter-spacing:0.11em;text-transform:uppercase;color:${t.inkSoft};font-weight:600;">${escapeHtml(longDate(issue.date))}</div>
      <div style="height:8px;line-height:8px;">&nbsp;</div>
      <h1 style="margin:0;font-family:${SERIF};font-size:30px;line-height:1.24;font-weight:normal;color:${t.ink};">${escapeHtml(issue.headline)}</h1>
      <div style="height:14px;line-height:14px;">&nbsp;</div>
      <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${t.inkSoft};">
        <span style="display:inline-block;width:9px;height:9px;border-radius:9px;background:${t.accent};margin-right:8px;"></span>${escapeHtml(d.feastOrSaint)} &middot; ${escapeHtml(d.season)}${d.isHolyDayOfObligation ? ' &middot; <strong style="color:' + t.accent + ';font-weight:700;">Holy day of obligation</strong>' : ''}
      </div>
      <div style="height:24px;line-height:24px;">&nbsp;</div>
      <div style="border-top:1px solid ${t.rule};font-size:1px;line-height:1px;">&nbsp;</div>
    </td></tr>
    ${rows.join('\n')}
    <tr><td style="padding:34px ${GUTTER}px 0 ${GUTTER}px;">
      <div style="border-top:1px solid ${t.rule};font-size:1px;line-height:1px;">&nbsp;</div>
    </td></tr>
    <tr><td style="padding:20px ${GUTTER}px 32px ${GUTTER}px;">
      <div style="font-family:${SANS};font-size:13px;line-height:1.8;color:${t.inkSoft};">
        <a href="${escapeHtml(url)}" style="color:${t.accent};text-decoration:underline;font-weight:600;">Read this on the web</a> &middot; forward it to someone who would want it.<br>
        ${escapeHtml(FOOTER_LINE)}<br>
        <a href="${escapeHtml(unsub)}" style="color:${t.inkSoft};text-decoration:underline;">Unsubscribe in one click</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// Plain text. Wrapped to 72 columns so it reads the same in a terminal client,
// a phone, and the quoted-reply pane of whatever the reader uses.
const COLS = 72;

function text(issue, { cfg, url, unsub }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const out = [
    cfg.appName.toUpperCase(),
    longDate(issue.date),
    '',
    ...wrap(issue.headline, COLS),
    ...wrap(`${d.feastOrSaint} · ${d.season}${d.isHolyDayOfObligation ? ' · Holy day of obligation' : ''}`, COLS),
    '',
    heading('Today at Mass'),
  ];
  const shown = readingsOf(issue);
  for (const p of [shown.epistle, shown.gospel]) {
    if (!p?.ref) continue;
    out.push(`  ${p.label.toUpperCase()} — ${p.ref}`);
    if (p.summary) out.push(...wrapParas(p.summary, '  '));
    if (p.calledTo) out.push('', ...wrap(`You are called to: ${p.calledTo}`, COLS, '  '));
    out.push('');
  }
  out.push(`  ${r.usccbLink}`, '');

  if (issue.verseOfDay?.ref) {
    out.push(heading('Verse of the day'));
    if (issue.verseOfDay.text) out.push(...wrap(`"${issue.verseOfDay.text}"`, COLS, '  '));
    out.push(`  ${issue.verseOfDay.ref}${issue.verseOfDay.text ? ` · ${issue.verseOfDay.translation}` : ''}`, '');
  }
  if (issue.reflection) out.push(heading('Reflection'), ...wrapParas(issue.reflection), '');
  if (issue.saintStory) {
    out.push(
      heading(issue.saintStory.name || 'Saint of the day'),
      ...wrapParas(issue.saintStory.life),
      '',
      ...wrap(`One thing today: ${issue.saintStory.oneActionToday}`, COLS, '  '),
      ''
    );
  }
  out.push(
    heading('Prayer'),
    `  ${issue.prayer.title}`,
    ...wrap(issue.prayer.note, COLS, '  '),
    '',
    stanzasToText(issue.prayer.text, { indent: '    ' }),
    ''
  );
  const questions = considerList(issue);
  if (questions.length) {
    out.push(heading('Why we believe what we do'));
    for (const q of questions) {
      out.push(...wrap(q.question, COLS, '  '), '', ...wrapParas(q.answer));
      if (q.citation) out.push('', `  ${q.citation}`);
      out.push('');
    }
    out.pop();
  }
  out.push(
    '',
    '─'.repeat(COLS),
    `Read this on the web: ${url}`,
    FOOTER_LINE,
    `Unsubscribe: ${unsub}`
  );
  return out.join('\n');
}

function heading(label) {
  const text = label.toUpperCase();
  return `${text}\n${'─'.repeat(Math.min(text.length, COLS))}`;
}

function wrapParas(body, indent = '  ') {
  return String(body)
    .split(/\n{2,}/)
    .flatMap((p, i) => (i ? ['', ...wrap(p.trim(), COLS, indent)] : wrap(p.trim(), COLS, indent)));
}

function wrap(body, cols, indent = '') {
  const width = Math.max(20, cols - indent.length);
  const lines = [];
  for (const source of String(body).split('\n')) {
    let line = '';
    for (const word of source.trim().split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(indent + line);
  }
  return lines;
}
