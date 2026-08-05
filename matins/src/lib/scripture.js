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
