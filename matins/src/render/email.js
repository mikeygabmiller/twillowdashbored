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
import { wordmarkText } from './brand.js';
import { FOOTER_LINE } from '../config.js';

const GUTTER = 34;

export function renderEmail(issue, { cfg, unsubscribeUrl, permalink }) {
  const t = theme(issue.liturgicalDay.color);
  const url = permalink || `${cfg.siteUrl}/${issue.date}/`;
  const unsub = unsubscribeUrl || `${cfg.siteUrl}/`;
  return {
    subject: `${issue.headline} — ${issue.liturgicalDay.feastOrSaint}`,
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

  // Readings — references and the USCCB link only. Never the text.
  const readingLine = (label, ref) =>
    ref
      ? `<tr>
          <td style="font-family:${SANS};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${t.inkSoft};padding:0 16px 8px 0;white-space:nowrap;vertical-align:baseline;font-weight:600;">${label}</td>
          <td style="font-family:${SERIF};font-size:16.5px;line-height:1.45;color:${t.ink};padding:0 0 8px 0;vertical-align:baseline;">${escapeHtml(ref)}</td>
        </tr>`
      : '';
  const readingRows = [
    readingLine('First', r.firstRef),
    readingLine('Psalm', r.psalmRef),
    readingLine('Second', r.secondRef),
    readingLine('Gospel', r.gospelRef),
  ].join('');
  const usccb = `<a href="${escapeHtml(r.usccbLink)}" style="font-family:${SANS};font-size:14px;color:${t.accent};text-decoration:underline;font-weight:600;">Read the readings at the USCCB &rarr;</a>`;
  rows.push(
    section(
      t,
      'Today at Mass',
      readingRows
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${readingRows}</table>
           <div style="height:14px;line-height:14px;">&nbsp;</div>
           ${usccb}`
        : usccb,
      { first: true }
    )
  );

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

  if (issue.reflection) rows.push(section(t, 'Reflection', para(t, issue.reflection, { last: true })));

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

  rows.push(
    section(
      t,
      'Consider',
      `<div style="font-family:${SERIF};font-size:20px;line-height:1.4;color:${t.ink};">${escapeHtml(issue.consider.question)}</div>
       <div style="height:12px;line-height:12px;">&nbsp;</div>
       ${para(t, issue.consider.answer, { size: 16.5, last: true })}
       ${issue.consider.citation ? `<div style="height:12px;line-height:12px;">&nbsp;</div><div style="font-family:${SANS};font-size:12px;color:${t.inkSoft};">${escapeHtml(issue.consider.citation)}</div>` : ''}`
    )
  );

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
  if (r.firstRef) out.push(`  First   ${r.firstRef}`);
  if (r.psalmRef) out.push(`  Psalm   ${r.psalmRef}`);
  if (r.secondRef) out.push(`  Second  ${r.secondRef}`);
  if (r.gospelRef) out.push(`  Gospel  ${r.gospelRef}`);
  out.push('', `  ${r.usccbLink}`, '');

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
  out.push(heading('Consider'), ...wrap(issue.consider.question, COLS, '  '), '', ...wrapParas(issue.consider.answer));
  if (issue.consider.citation) out.push('', `  ${issue.consider.citation}`);
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
