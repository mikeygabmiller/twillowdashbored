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

// Which shape today's reflection takes. Same machinery as the prayers: a model
// asked only for a length writes the same paragraph every day, so the shape is
// rotated out from under it.
export async function pickForm(store, { forms, date, tags }) {
  const recent = await store.getJson('rot:form', []);
  const chosen = pick(forms, { recent, cooldown: ROTATION_COOLDOWN.form, tags, seed: `form:${date}` });
  return { chosen, commit: () => store.putJson('rot:form', [chosen.id, ...recent.filter((i) => i !== chosen.id)].slice(0, 40)) };
}

// The opening sentence is where repetition shows first — every Tuesday starts
// with an alarm going off. Recent openings are fed back into the prompt as
// ground already covered.
const OPENINGS_KEY = 'rot:openings';
const OPENINGS_KEPT = 24;

export function openingOf(text) {
  return String(text || '').trim().split(/\s+/).slice(0, 8).join(' ');
}

export async function recentOpenings(store) {
  return store.getJson(OPENINGS_KEY, []);
}

export async function rememberOpening(store, text) {
  const opening = openingOf(text);
  if (!opening) return;
  const recent = await store.getJson(OPENINGS_KEY, []);
  await store.putJson(OPENINGS_KEY, [opening, ...recent.filter((o) => o !== opening)].slice(0, OPENINGS_KEPT));
}

export async function pickQa(store, { bank, date, tags }) {
  const recent = await store.getJson('rot:qa', []);
  const chosen = pick(bank, { recent, cooldown: ROTATION_COOLDOWN.qa, tags, seed: `qa:${date}` });
  return { chosen, commit: () => store.putJson('rot:qa', [chosen.id, ...recent.filter((i) => i !== chosen.id)].slice(0, 120)) };
}

// Several questions in one issue. Each pick sees the ones already chosen today
// as recently used, so a single issue can never ask the same thing twice, and
// they are all remembered together when the issue actually ships.
export async function pickQaSet(store, { bank, date, tags, count = 1 }) {
  const recent = await store.getJson('rot:qa', []);
  const chosen = [];
  for (let i = 0; i < Math.min(count, bank.length); i++) {
    const taken = chosen.map((q) => q.id);
    const next = pick(bank, {
      recent: [...taken, ...recent],
      cooldown: ROTATION_COOLDOWN.qa + taken.length,
      tags,
      seed: `qa:${date}:${i}`,
    });
    if (!next || taken.includes(next.id)) break;
    chosen.push(next);
  }
  const ids = chosen.map((q) => q.id);
  return {
    chosen,
    commit: () => store.putJson('rot:qa', [...ids, ...recent.filter((i) => !ids.includes(i))].slice(0, 200)),
  };
}
