// Email rendering: tables, inline styles, no external CSS, no web fonts, no
// images. Preheader is the headline. Sections that were dropped or degraded
// simply are not here — the issue never explains its own machinery to readers.

import { theme, SERIF, SANS, escapeHtml, longDate } from './theme.js';
import { wordmarkText } from './brand.js';
import { FOOTER_LINE } from '../config.js';

export function renderEmail(issue, { cfg, unsubscribeUrl, permalink }) {
  const t = theme(issue.liturgicalDay.color);
  const url = permalink || `${cfg.siteUrl}/${issue.date}/`;
  const unsub = unsubscribeUrl || `${cfg.siteUrl}/`;
  return {
    subject: `${issue.headline} — ${issue.liturgicalDay.feastOrSaint}`,
    preheader: issue.headline,
    html: html(issue, { cfg, t, url, unsub }),
    text: text(issue, { cfg, url, unsub }),
  };
}

function section(t, title, inner) {
  return `<tr><td style="padding:26px 30px 0 30px;">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${t.accent};font-weight:600;">${escapeHtml(title)}</div>
    <div style="height:10px;line-height:10px;">&nbsp;</div>
    ${inner}
  </td></tr>`;
}

function para(t, s, extra = '') {
  return `<p style="margin:0 0 14px 0;font-family:${SERIF};font-size:17px;line-height:1.68;color:${t.ink};${extra}">${escapeHtml(s).replace(/\n\n+/g, '</p><p style="margin:0 0 14px 0;font-family:' + SERIF + ';font-size:17px;line-height:1.68;color:' + t.ink + ';">')}</p>`;
}

function html(issue, { cfg, t, url, unsub }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const rows = [];

  // Readings — references and the USCCB link only. Never the text.
  const readingLine = (label, ref) =>
    ref ? `<tr><td style="font-family:${SANS};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${t.inkSoft};padding:0 14px 6px 0;white-space:nowrap;">${label}</td><td style="font-family:${SERIF};font-size:16px;color:${t.ink};padding:0 0 6px 0;">${escapeHtml(ref)}</td></tr>` : '';
  const readingRows = [
    readingLine('First', r.firstRef),
    readingLine('Psalm', r.psalmRef),
    readingLine('Second', r.secondRef),
    readingLine('Gospel', r.gospelRef),
  ].join('');
  rows.push(
    section(
      t,
      'Today at Mass',
      readingRows
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${readingRows}</table>
           <div style="height:12px;line-height:12px;">&nbsp;</div>
           <a href="${escapeHtml(r.usccbLink)}" style="font-family:${SANS};font-size:14px;color:${t.accent};text-decoration:underline;">Read today's readings at the USCCB &rarr;</a>`
        : `<a href="${escapeHtml(r.usccbLink)}" style="font-family:${SANS};font-size:14px;color:${t.accent};text-decoration:underline;">Today's readings at the USCCB &rarr;</a>`
    )
  );

  if (issue.verseOfDay?.ref) {
    const v = issue.verseOfDay;
    rows.push(
      section(
        t,
        'Verse of the day',
        v.text
          ? `<div style="border-left:3px solid ${t.accent};padding:2px 0 2px 16px;">
               <p style="margin:0 0 8px 0;font-family:${SERIF};font-size:19px;line-height:1.6;color:${t.ink};font-style:italic;">${escapeHtml(v.text)}</p>
               <div style="font-family:${SANS};font-size:12px;color:${t.inkSoft};">${escapeHtml(v.ref)} · ${escapeHtml(v.translation || 'Douay-Rheims')}</div>
             </div>`
          : `<div style="font-family:${SERIF};font-size:19px;color:${t.ink};">${escapeHtml(v.ref)}</div>`
      )
    );
  }

  if (issue.reflection) rows.push(section(t, 'Reflection', para(t, issue.reflection)));

  if (issue.saintStory) {
    rows.push(
      section(
        t,
        d.feastOrSaint ? 'Today' : 'Saint of the day',
        `${para(t, issue.saintStory.life)}
         <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${t.tint};border-radius:6px;">
           <tr><td style="padding:14px 16px;">
             <div style="font-family:${SANS};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${t.accent};font-weight:600;">One thing today</div>
             <div style="height:6px;line-height:6px;">&nbsp;</div>
             <div style="font-family:${SERIF};font-size:16px;line-height:1.6;color:${t.ink};">${escapeHtml(issue.saintStory.oneActionToday)}</div>
           </td></tr>
         </table>`
      )
    );
  }

  rows.push(
    section(
      t,
      'Prayer',
      `<div style="font-family:${SERIF};font-size:18px;color:${t.ink};margin-bottom:4px;">${escapeHtml(issue.prayer.title)}</div>
       <div style="font-family:${SANS};font-size:13px;color:${t.inkSoft};margin-bottom:12px;">${escapeHtml(issue.prayer.note)}</div>
       ${para(t, issue.prayer.text, 'font-size:17px;')}`
    )
  );

  rows.push(
    section(
      t,
      'Consider',
      `<div style="font-family:${SERIF};font-size:18px;color:${t.ink};margin-bottom:10px;">${escapeHtml(issue.consider.question)}</div>
       ${para(t, issue.consider.answer, 'font-size:16px;')}
       ${issue.consider.citation ? `<div style="font-family:${SANS};font-size:12px;color:${t.inkSoft};">${escapeHtml(issue.consider.citation)}</div>` : ''}`
    )
  );

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(issue.headline)}</title>
</head>
<body style="margin:0;padding:0;background:${t.paperAlt};">
<div style="display:none;font-size:1px;color:${t.paperAlt};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(issue.headline)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${t.paperAlt};">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${t.paper};border:1px solid ${t.rule};border-radius:10px;">
    <tr><td style="padding:28px 30px 0 30px;">
      ${wordmarkText({ appName: cfg.appName, accent: t.accent, ink: t.ink })}
    </td></tr>
    <tr><td style="padding:22px 30px 0 30px;">
      <div style="font-family:${SANS};font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:${t.inkSoft};">${escapeHtml(longDate(issue.date))}</div>
      <div style="height:6px;line-height:6px;">&nbsp;</div>
      <h1 style="margin:0;font-family:${SERIF};font-size:28px;line-height:1.28;font-weight:normal;color:${t.ink};">${escapeHtml(issue.headline)}</h1>
      <div style="height:12px;line-height:12px;">&nbsp;</div>
      <div style="font-family:${SANS};font-size:13px;color:${t.inkSoft};">
        <span style="display:inline-block;width:9px;height:9px;border-radius:9px;background:${t.accent};margin-right:7px;"></span>${escapeHtml(d.feastOrSaint)} · ${escapeHtml(d.season)}${d.isHolyDayOfObligation ? ' · Holy day of obligation' : ''}
      </div>
      <div style="height:18px;line-height:18px;">&nbsp;</div>
      <div style="border-top:1px solid ${t.rule};font-size:1px;line-height:1px;">&nbsp;</div>
    </td></tr>
    ${rows.join('\n')}
    <tr><td style="padding:30px 30px 0 30px;">
      <div style="border-top:1px solid ${t.rule};font-size:1px;line-height:1px;">&nbsp;</div>
    </td></tr>
    <tr><td style="padding:18px 30px 30px 30px;">
      <div style="font-family:${SANS};font-size:13px;line-height:1.7;color:${t.inkSoft};">
        <a href="${escapeHtml(url)}" style="color:${t.accent};text-decoration:underline;">Read this on the web</a> · forward it to someone who would want it.<br>
        ${escapeHtml(FOOTER_LINE)}<br>
        <a href="${escapeHtml(unsub)}" style="color:${t.inkSoft};text-decoration:underline;">Unsubscribe in one click</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function text(issue, { cfg, url, unsub }) {
  const d = issue.liturgicalDay;
  const r = issue.readings;
  const out = [
    cfg.appName.toUpperCase(),
    longDate(issue.date),
    '',
    issue.headline,
    `${d.feastOrSaint} · ${d.season}${d.isHolyDayOfObligation ? ' · Holy day of obligation' : ''}`,
    '',
    '--- TODAY AT MASS ---',
  ];
  if (r.firstRef) out.push(`First: ${r.firstRef}`);
  if (r.psalmRef) out.push(`Psalm: ${r.psalmRef}`);
  if (r.secondRef) out.push(`Second: ${r.secondRef}`);
  if (r.gospelRef) out.push(`Gospel: ${r.gospelRef}`);
  out.push(`Readings: ${r.usccbLink}`, '');

  if (issue.verseOfDay?.ref) {
    out.push('--- VERSE OF THE DAY ---');
    if (issue.verseOfDay.text) out.push(`"${issue.verseOfDay.text}"`);
    out.push(`${issue.verseOfDay.ref}${issue.verseOfDay.text ? ` (${issue.verseOfDay.translation})` : ''}`, '');
  }
  if (issue.reflection) out.push('--- REFLECTION ---', issue.reflection, '');
  if (issue.saintStory) {
    out.push('--- TODAY ---', issue.saintStory.life, '', `One thing today: ${issue.saintStory.oneActionToday}`, '');
  }
  out.push('--- PRAYER ---', issue.prayer.title, issue.prayer.note, '', issue.prayer.text, '');
  out.push('--- CONSIDER ---', issue.consider.question, issue.consider.answer);
  if (issue.consider.citation) out.push(issue.consider.citation);
  out.push('', `Read this on the web: ${url}`, FOOTER_LINE, `Unsubscribe: ${unsub}`);
  return out.join('\n');
}
