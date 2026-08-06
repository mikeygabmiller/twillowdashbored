// The look shifts with the church year: the accent is the liturgical colour of
// the day. Everything else stays quiet — cream paper, dark ink, a serif for
// headings, room to breathe.
//
// Every colour comes in a light and a dark value. The web page honours the
// reader's system setting (this thing is read at five in the morning, often in
// the dark); email stays light, because dark-mode support across mail clients
// is too uneven to hand a half-working palette to Gmail's auto-inverter.

export const PAPER = '#FBF7EF';
export const PAPER_ALT = '#F4EEE2';
export const INK = '#241F1A';
export const INK_SOFT = '#5C5449';
export const RULE = '#DDD3C2';

export const PAPER_DARK = '#17140F';
export const PAPER_ALT_DARK = '#0E0C09';
export const INK_DARK = '#EFE7DA';
export const INK_SOFT_DARK = '#A99E8C';
export const RULE_DARK = '#332E27';

// accent / tint are the light-mode pair; accentDark / tintDark the dark one.
// The dark accents are lightened deliberately: the light-mode greens and
// violets fall below readable contrast on a near-black page.
const ACCENTS = {
  green: { accent: '#3E6B4B', tint: '#EDF2ED', accentDark: '#82B891', tintDark: '#1A241C', label: 'Green' },
  violet: { accent: '#5B3E7A', tint: '#F0EBF4', accentDark: '#B394D6', tintDark: '#221B2C', label: 'Violet' },
  purple: { accent: '#5B3E7A', tint: '#F0EBF4', accentDark: '#B394D6', tintDark: '#221B2C', label: 'Violet' },
  white: { accent: '#9A7B31', tint: '#F6F0E2', accentDark: '#D8B662', tintDark: '#272014', label: 'White' },
  gold: { accent: '#9A7B31', tint: '#F6F0E2', accentDark: '#D8B662', tintDark: '#272014', label: 'Gold' },
  red: { accent: '#8C2F2A', tint: '#F6EAE8', accentDark: '#E29289', tintDark: '#281817', label: 'Red' },
  rose: { accent: '#A4576B', tint: '#F8EDEF', accentDark: '#E5A5B4', tintDark: '#2A1D21', label: 'Rose' },
  black: { accent: '#3A3A3A', tint: '#EFEDEA', accentDark: '#BAB4AA', tintDark: '#201F1D', label: 'Black' },
};

export function theme(color) {
  const key = String(color || 'green').toLowerCase();
  const base = ACCENTS[key] || ACCENTS.green;
  return {
    ...base,
    paper: PAPER,
    paperAlt: PAPER_ALT,
    ink: INK,
    inkSoft: INK_SOFT,
    rule: RULE,
    paperDark: PAPER_DARK,
    paperAltDark: PAPER_ALT_DARK,
    inkDark: INK_DARK,
    inkSoftDark: INK_SOFT_DARK,
    ruleDark: RULE_DARK,
  };
}

export const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, 'Times New Roman', serif";
export const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function longDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
