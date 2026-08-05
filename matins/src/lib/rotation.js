// Rotation for the hardcoded banks: never repeat inside the cooldown window,
// and where there is a choice, prefer something that fits the day.
//
// Deterministic given (date, recent list) so a preview for a date shows what
// that date would actually get.

import { ROTATION_COOLDOWN } from '../config.js';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick(items, { recent = [], cooldown = 10, tags = [], seed = '' } = {}) {
  const blocked = new Set(recent.slice(0, cooldown));
  let pool = items.filter((i) => !blocked.has(i.id));
  // Cooldown longer than the bank: fall back to least-recently-used.
  if (!pool.length) {
    const rank = new Map(recent.map((id, i) => [id, i]));
    pool = [...items].sort((a, b) => (rank.get(b.id) ?? 1e9) - (rank.get(a.id) ?? 1e9));
    return pool[0];
  }
  const wanted = tags.map((t) => String(t).toLowerCase()).filter(Boolean);
  const fitting = pool.filter((i) => (i.tags || []).some((t) => wanted.includes(String(t).toLowerCase())));
  const from = fitting.length ? fitting : pool;
  return from[hash(seed) % from.length];
}

export async function pickPrayer(store, { prayers, date, tags }) {
  const recent = await store.getJson('rot:prayer', []);
  const chosen = pick(prayers, { recent, cooldown: ROTATION_COOLDOWN.prayer, tags, seed: `prayer:${date}` });
  return { chosen, commit: () => store.putJson('rot:prayer', [chosen.id, ...recent.filter((i) => i !== chosen.id)].slice(0, 60)) };
}

export async function pickQa(store, { bank, date, tags }) {
  const recent = await store.getJson('rot:qa', []);
  const chosen = pick(bank, { recent, cooldown: ROTATION_COOLDOWN.qa, tags, seed: `qa:${date}` });
  return { chosen, commit: () => store.putJson('rot:qa', [chosen.id, ...recent.filter((i) => i !== chosen.id)].slice(0, 120)) };
}
