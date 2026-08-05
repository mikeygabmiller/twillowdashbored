// Liturgical day from romcal. This is the spine of the whole issue: nothing
// about the day (season, colour, rank, saint) is ever asked of an LLM.
//
// romcal is pinned in package.json — it is still a beta line and minor bumps
// have broken shapes before.

import { Romcal } from 'romcal';
import { UnitedStates_En } from '@romcal/calendar.united-states';

const BUNDLES = {
  'en-US': UnitedStates_En,
};

const yearCache = new Map(); // `${locale}:${year}` -> calendar object

function bundleFor(locale) {
  return BUNDLES[locale] || UnitedStates_En;
}

export function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return false;
  const d = new Date(`${dateStr}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

async function calendarForYear(year, locale) {
  const key = `${locale}:${year}`;
  if (!yearCache.has(key)) {
    const romcal = new Romcal({ localizedCalendar: bundleFor(locale), scope: 'gregorian' });
    yearCache.set(key, await romcal.generateCalendar(year));
  }
  return yearCache.get(key);
}

// romcal returns every celebration that lands on the date, highest precedence
// first, with optional memorials after it. We keep the leading one as the day
// and surface an optional memorial as the saint when the day itself is a plain
// weekday — that is exactly how a parish would keep it.
export async function getLiturgicalDay(dateStr, cfg) {
  if (!isValidDate(dateStr)) throw new Error(`bad date: ${dateStr}`);
  const year = Number(dateStr.slice(0, 4));
  const cal = await calendarForYear(year, cfg.calendarLocale);
  const entries = cal[dateStr];
  if (!entries || !entries.length) throw new Error(`no liturgical data for ${dateStr}`);

  const principal = entries[0];
  const optional = entries.slice(1).filter((e) => e.martyrology && e.martyrology.length);
  const saintEntry = principal.martyrology && principal.martyrology.length ? principal : optional[0] || null;

  return {
    date: dateStr,
    season: principal.seasonNames?.[0] || titleCase(principal.seasons?.[0] || ''),
    color: (principal.colors?.[0] || 'GREEN').toLowerCase(),
    colorName: principal.colorNames?.[0] || (principal.colors?.[0] || 'green').toLowerCase(),
    rank: principal.rankName || titleCase(principal.rank || ''),
    feastOrSaint: principal.name,
    isHolyDayOfObligation: !!principal.isHolyDayOfObligation,
    weekdayCycle: principal.cycles?.weekdayCycle || null,
    sundayCycle: principal.cycles?.sundayCycle || null,
    // Everything below is the grounded fact sheet handed to the LLM for the
    // saint story. If it is not in here, the model may not assert it.
    saint: saintEntry ? saintFacts(saintEntry) : null,
    optionalMemorials: optional.map((e) => e.name),
  };
}

function saintFacts(entry) {
  const m = entry.martyrology?.[0] || {};
  return {
    id: entry.id,
    name: entry.name,
    rank: entry.rankName || titleCase(entry.rank || ''),
    isOptional: !!entry.isOptional,
    color: (entry.colors?.[0] || '').toLowerCase(),
    canonizationLevel: m.canonizationLevel || null, // SAINT | BLESSED | ...
    titles: (m.titles || entry.titles || []).map(titleCase),
    dateOfDeath: m.dateOfDeath ?? null,
    dateOfDeathIsApproximative: !!m.dateOfDeathIsApproximative,
    dateOfBirth: m.dateOfBirth ?? null,
  };
}

function titleCase(s) {
  return String(s)
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
