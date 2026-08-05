// Mass readings. References and a USCCB link only — we never reproduce NABRE
// text. If the readings API is down or has no entry for the date, we still
// hand back the USCCB permalink (it is derivable from the date) and mark the
// result degraded so the renderer can soften the wording.

import { fetchJson } from './http.js';

// https://bible.usccb.org/bible/readings/MMDDYY.cfm
export function usccbLinkFor(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `https://bible.usccb.org/bible/readings/${m}${d}${y.slice(2)}.cfm`;
}

export async function getReadings(dateStr, cfg, { fetchImpl } = {}) {
  const [y, m, d] = dateStr.split('-');
  const url = `${cfg.readingsApiBase}/readings/${y}/${m}-${d}.json`;
  const fallback = { firstRef: null, psalmRef: null, secondRef: null, gospelRef: null, usccbLink: usccbLinkFor(dateStr), degraded: true, source: null };

  const res = await fetchJson(url, { timeoutMs: 8000, fetchImpl });
  if (!res.ok) {
    return { ...fallback, error: res.error };
  }
  const r = res.data?.readings || {};
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const out = {
    firstRef: clean(r.firstReading),
    psalmRef: clean(r.psalm),
    secondRef: clean(r.secondReading),
    gospelRef: clean(r.gospel),
    usccbLink: clean(res.data?.usccbLink) || usccbLinkFor(dateStr),
    source: url,
    degraded: false,
  };
  // A payload with no gospel is not usable as "today's readings".
  if (!out.gospelRef && !out.firstRef) return { ...fallback, error: 'readings payload empty' };
  return out;
}
