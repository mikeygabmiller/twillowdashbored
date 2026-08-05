// The look shifts with the church year: the accent is the liturgical colour of
// the day. Everything else stays quiet — cream paper, dark ink, a serif for
// headings, room to breathe.

export const PAPER = '#FBF7EF';
export const PAPER_ALT = '#F4EEE2';
export const INK = '#241F1A';
export const INK_SOFT = '#5C5449';
export const RULE = '#DDD3C2';

const ACCENTS = {
  green: { accent: '#3E6B4B', tint: '#EDF2ED', label: 'Green' },
  violet: { accent: '#5B3E7A', tint: '#F0EBF4', label: 'Violet' },
  purple: { accent: '#5B3E7A', tint: '#F0EBF4', label: 'Violet' },
  white: { accent: '#9A7B31', tint: '#F6F0E2', label: 'White' },
  gold: { accent: '#9A7B31', tint: '#F6F0E2', label: 'Gold' },
  red: { accent: '#8C2F2A', tint: '#F6EAE8', label: 'Red' },
  rose: { accent: '#A4576B', tint: '#F8EDEF', label: 'Rose' },
  black: { accent: '#3A3A3A', tint: '#EFEDEA', label: 'Black' },
};

export function theme(color) {
  const key = String(color || 'green').toLowerCase();
  const base = ACCENTS[key] || ACCENTS.green;
  return { ...base, paper: PAPER, paperAlt: PAPER_ALT, ink: INK, inkSoft: INK_SOFT, rule: RULE };
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
