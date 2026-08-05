// KV access, plus an in-memory stand-in so the preview CLI and the tests run
// with no Cloudflare binding at all.
//
// Keys
//   sub:<email>        { email, status: pending|active|unsubscribed, createdAt, confirmedAt, unsubscribedAt }
//   issue:<YYYY-MM-DD> the full issue JSON (the archive record)
//   issues:index       [{ date, headline, feastOrSaint, color }] newest first, capped
//   rot:prayer         [ids] most recently used first
//   rot:qa             [ids] most recently used first
//   sent:<YYYY-MM-DD>  { at, count } — presence means "already sent", the send lock

export class MemoryStore {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

export function makeStore(kv) {
  const backing = kv || new MemoryStore();
  return {
    raw: backing,
    async getJson(key, fallback = null) {
      try {
        const v = await backing.get(key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    async putJson(key, value, opts) {
      await backing.put(key, JSON.stringify(value), opts);
    },
    async del(key) {
      await backing.delete(key);
    },
    async listKeys(prefix) {
      const out = [];
      let cursor;
      do {
        const res = await backing.list({ prefix, cursor });
        out.push(...res.keys.map((k) => k.name));
        cursor = res.list_complete === false ? res.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

// A store that reads real state but throws away every write. Used by preview
// so a dry run can never mark a prayer as seen or an issue as sent.
export function readOnly(store) {
  return {
    ...store,
    dryRun: true,
    async putJson() {},
    async del() {},
  };
}

export const ISSUE_INDEX_KEY = 'issues:index';
export const ISSUE_INDEX_MAX = 400;

export async function saveIssue(store, issue) {
  await store.putJson(`issue:${issue.date}`, issue);
  const index = await store.getJson(ISSUE_INDEX_KEY, []);
  const entry = {
    date: issue.date,
    headline: issue.headline || issue.liturgicalDay?.feastOrSaint || issue.date,
    feastOrSaint: issue.liturgicalDay?.feastOrSaint || null,
    color: issue.liturgicalDay?.color || 'green',
  };
  const next = [entry, ...index.filter((e) => e.date !== issue.date)]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, ISSUE_INDEX_MAX);
  await store.putJson(ISSUE_INDEX_KEY, next);
  return next;
}
