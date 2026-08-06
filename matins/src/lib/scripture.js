// Verse of the day. The reference always comes from the readings API; the
// TEXT, if we print any at all, comes only from a Douay-Rheims lookup and is
// verified to be Douay-Rheims before it is allowed into the issue. An LLM is
// never asked for scripture text anywhere in this app.

import { fetchJson } from './http.js';

// "Luke 14:25-33" -> "Luke 14:25"   |   "John 6:41, 51" -> "John 6:41"
// "Luke 9:28b-36" -> "Luke 9:28"    |   "Mark 9:2-10"    -> "Mark 9:2"
export function firstVerseOf(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const m = ref.match(/^\s*((?:\d\s+)?[A-Za-z][A-Za-z\s.]*?)\s+(\d+)\s*:\s*(\d+)/);
  if (!m) return null;
  const [, book, chapter, verse] = m;
  return `${book.trim().replace(/\.$/, '')} ${chapter}:${verse}`;
}

// The Douay-Rheims is public domain, which is the whole reason this app can
// touch scripture text at all. Fetching the FULL passage — not just the first
// verse — is what lets the day's readings be summarised without the model
// working from memory: it is handed the actual words and retells those.
//
// Our own reference normalising turns "15:21-28" into an en dash for display
// (readings.js); the API wants the plain hyphen back.
export async function getPassage(ref, cfg, { fetchImpl, maxChars = 6000 } = {}) {
  if (!ref || !cfg.drApiBase) return null;
  const apiRef = String(ref).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const url = `${cfg.drApiBase}/${encodeURIComponent(apiRef)}?translation=dra`;
  const res = await fetchJson(url, { timeoutMs: 8000, fetchImpl });
  if (!res.ok) return { ref, text: null, error: res.error };

  // Same hard gate as the verse of the day: anything not identifiably
  // Douay-Rheims is discarded rather than printed or paraphrased.
  const id = String(res.data?.translation_id || '').toLowerCase();
  const name = String(res.data?.translation_name || '');
  if (id !== 'dra' && !/douay/i.test(name)) {
    return { ref, text: null, error: `refused non-Douay-Rheims text (${id || name || 'unknown'})` };
  }
  const text = String(res.data?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ref, text: null, error: 'no passage text' };
  return { ref, text: text.slice(0, maxChars), translation: 'Douay-Rheims' };
}

// Which of the day's readings is the epistle. On a Sunday it is normally the
// second reading; on a weekday the first, when the first is a letter at all.
// When neither is, the reading is still worth showing — it is just not an
// epistle, and saying so is more use than mislabelling it.
const EPISTLE_BOOKS =
  /^(?:Romans|1 Corinthians|2 Corinthians|Galatians|Ephesians|Philippians|Colossians|1 Thessalonians|2 Thessalonians|1 Timothy|2 Timothy|Titus|Philemon|Hebrews|James|1 Peter|2 Peter|1 John|2 John|3 John|Jude)\b/i;

export function pickEpistle(readings) {
  const candidates = [readings?.secondRef, readings?.firstRef].filter(Boolean);
  const epistle = candidates.find((r) => EPISTLE_BOOKS.test(String(r).trim()));
  if (epistle) return { ref: epistle, label: 'Epistle', isEpistle: true };
  const fallback = candidates[0] || null;
  return fallback ? { ref: fallback, label: 'First reading', isEpistle: false } : null;
}

export async function getVerseOfDay(gospelRef, cfg, { fetchImpl } = {}) {
  const ref = firstVerseOf(gospelRef) || gospelRef || null;
  if (!ref) return null;
  if (!cfg.drApiBase) return { ref, text: null, translation: null };

  const url = `${cfg.drApiBase}/${encodeURIComponent(ref)}?translation=dra`;
  const res = await fetchJson(url, { timeoutMs: 6000, fetchImpl });
  if (!res.ok) return { ref, text: null, translation: null, error: res.error };

  // Hard gate: anything that is not identifiably Douay-Rheims is discarded.
  const id = String(res.data?.translation_id || '').toLowerCase();
  const name = String(res.data?.translation_name || '');
  if (id !== 'dra' && !/douay/i.test(name)) {
    return { ref, text: null, translation: null, error: `refused non-Douay-Rheims text (${id || name || 'unknown'})` };
  }
  const text = String(res.data?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 400) return { ref, text: null, translation: null, error: 'no usable verse text' };
  return { ref, text, translation: 'Douay-Rheims' };
}
