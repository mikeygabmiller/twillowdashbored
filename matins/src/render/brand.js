// Wordmark. The mark is an arch with a rising sun behind it — a doorway at
// dawn, which is what matins is. Accent takes the liturgical colour, so the
// mark itself moves through the church year.
//
// Email clients are unreliable with SVG, so email uses the type-only lockup
// (`wordmarkText`) and the web uses the full mark.

import { SERIF, escapeHtml } from './theme.js';

export function markSvg({ accent = '#3E6B4B', size = 34 } = {}) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Matins mark">
  <path d="M20 7c6.6 0 12 5.4 12 12v14H8V19C8 12.4 13.4 7 20 7z" fill="${accent}" fill-opacity="0.12"/>
  <path d="M20 7c6.6 0 12 5.4 12 12v14H8V19C8 12.4 13.4 7 20 7z" stroke="${accent}" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M12 33V21.5a8 8 0 0 1 16 0V33" stroke="${accent}" stroke-width="1.2" stroke-opacity="0.55"/>
  <circle cx="20" cy="21.5" r="4.2" fill="${accent}" fill-opacity="0.9"/>
  <path d="M4 33h32" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
}

export function wordmarkSvg({ appName = 'Matins', accent = '#3E6B4B', ink = '#241F1A' } = {}) {
  return `<span style="display:inline-flex;align-items:center;gap:10px;">
  ${markSvg({ accent })}
  <span style="font-family:${SERIF};font-size:26px;letter-spacing:0.06em;color:${ink};">${escapeHtml(appName)}</span>
</span>`;
}

// Email-safe: type only, plus a rule in the accent colour.
export function wordmarkText({ appName = 'Matins', accent = '#3E6B4B', ink = '#241F1A' } = {}) {
  return `<span style="font-family:${SERIF};font-size:24px;letter-spacing:0.14em;text-transform:uppercase;color:${ink};">${escapeHtml(appName)}</span>
  <span style="display:inline-block;width:26px;border-top:2px solid ${accent};vertical-align:middle;margin-left:10px;"></span>`;
}

// Standalone file for the site (favicon / og). Written by scripts/build-site.mjs.
export function standaloneMarkSvg(accent = '#3E6B4B') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="64" height="64" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
  <rect width="40" height="40" rx="8" fill="#FBF7EF"/>
  <path d="M20 7c6.6 0 12 5.4 12 12v14H8V19C8 12.4 13.4 7 20 7z" fill="${accent}" fill-opacity="0.12" stroke="${accent}" stroke-width="1.6" stroke-linejoin="round"/>
  <circle cx="20" cy="21.5" r="4.2" fill="${accent}"/>
  <path d="M4 33h32" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;
}
