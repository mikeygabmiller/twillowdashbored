// The issue shape changed; the archive did not. Every issue ever built is
// still sitting in KV and still has to render, so the renderers read the
// payload through here rather than reaching into it directly.
//
// Two changes so far:
//   * `consider` was one question, and is now three;
//   * `readings` carried four bare references, and now carries an epistle and
//     a Gospel with a summary and a call attached.

export function considerList(issue) {
  const c = issue?.consider;
  if (!c) return [];
  return Array.isArray(c) ? c.filter(Boolean) : [c];
}

export function readingsOf(issue) {
  const r = issue?.readings || {};
  if (r.epistle || r.gospel) return { epistle: r.epistle || null, gospel: r.gospel || null };

  // An older issue: keep showing what it has, without a summary it never had.
  const epistleRef = r.secondRef || r.firstRef;
  return {
    epistle: epistleRef ? { ref: epistleRef, label: r.secondRef ? 'Second reading' : 'First reading' } : null,
    gospel: r.gospelRef ? { ref: r.gospelRef, label: 'Gospel' } : null,
  };
}
