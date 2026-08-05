// Small fetch helpers. Every outbound call in this app is allowed to fail:
// a section drops, the issue still goes out. Nothing here ever throws.

export async function fetchJson(url, { timeoutMs = 8000, fetchImpl, ...init } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: 'response was not JSON' };
    }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

export function html(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers || {}) },
  });
}
