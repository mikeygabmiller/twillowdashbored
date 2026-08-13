// Ceilings on the one unauthenticated route that causes mail to be sent.
//
// POST /subscribe takes an address and emails it a confirmation. Without a
// ceiling that is a way to make this Worker deliver mail to any inbox on
// request, as many times as you like — harmless to the list, since nothing is
// sent until the address confirms, and expensive to the sending domain's
// reputation, which is slow to repair and easy to lose.
//
// Two different ceilings, because there are two different abuses:
//   * one source, many addresses  -> per-IP window
//   * many sources, one address   -> per-address cooldown, in subscribers.js
//
// Fixed windows rather than a rolling count: a rolling counter needs a read,
// a write and a list per request, and this needs to be cheap enough to run in
// front of every signup. A fixed window lets through at most two windows'
// worth across a boundary, which at these numbers is nobody.
//
// KV is eventually consistent, so a burst arriving at several colos at once
// can overshoot before the counter propagates. That is understood and
// accepted: this exists to stop a script, not to be an accounting system.

const WINDOW_SECONDS = 3600;

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    null
  );
}

// Counts this hit and reports whether it was over the line. Never throws: a
// rate limiter that breaks signup when KV hiccups is worse than the abuse it
// prevents, so a failure here lets the request through.
export async function takeToken(store, { bucket, id, limit, windowSeconds = WINDOW_SECONDS }) {
  if (!id) return { allowed: true, reason: 'no client id to limit on' };
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${window}:${id}`;
  try {
    const used = Number(await store.getJson(key, 0)) || 0;
    if (used >= limit) return { allowed: false, used, limit, retryAfter: secondsLeft(windowSeconds) };
    // Expire on their own, so the namespace never needs sweeping.
    await store.putJson(key, used + 1, { expirationTtl: windowSeconds * 2 });
    return { allowed: true, used: used + 1, limit };
  } catch (err) {
    console.warn(`ratelimit ${bucket} unavailable, allowing: ${String(err?.message || err)}`);
    return { allowed: true, reason: 'limiter unavailable' };
  }
}

function secondsLeft(windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return windowSeconds - (now % windowSeconds);
}
