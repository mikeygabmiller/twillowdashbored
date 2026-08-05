/**
 * MORNING DIGEST — HTTP surface.
 *
 * Everything under /api/digest/* sits behind the dashboard password (the gate in
 * src/index.js runs first). The one public route is /d/a/<token>: the one-tap
 * buttons have to work from an email client with no session, so they carry a
 * signed, expiring token instead of a cookie.
 */

import * as D from './digest.js';
import * as S from './digest-sources.js';

/**
 * Returns a Response, or null if the path isn't ours (so the caller's router
 * keeps looking).
 */
export async function digestRoute(request, url, ctx) {
  const p = url.pathname;
  const method = request.method;

  // ---- public: one-tap action from the email ---------------------------
  if (method === 'GET' && p.startsWith('/d/a/')) return tapAction(request, url, ctx, p.slice(5));

  if (!p.startsWith('/api/digest')) return null;

  if (method === 'GET'  && p === '/api/digest/state')    return apiState(ctx);
  if (method === 'POST' && p === '/api/digest/config')   return apiConfig(request, ctx);
  if (method === 'GET'  && p === '/api/digest/context')  return ctx.json({ ok: true, context: await D.loadContext(ctx) });
  if (method === 'POST' && p === '/api/digest/context')  return apiContext(request, ctx);
  if (method === 'POST' && p === '/api/digest/kit')      return apiKit(request, ctx);
  if (method === 'POST' && p === '/api/digest/orders')   return apiOrders(request, ctx);
  if (method === 'GET'  && p === '/api/digest/capture')  return ctx.json({ ok: true, capture: await D.loadCapture(ctx) });
  if (method === 'POST' && p === '/api/digest/capture')  return apiCapture(request, ctx);
  if (method === 'POST' && p === '/api/digest/run')      return apiRun(request, ctx);
  if (method === 'GET'  && p === '/api/digest/archive')  return apiArchive(url, ctx);
  if (method === 'GET'  && p === '/api/digest/doc')      return apiDoc(url, ctx);
  if (method === 'GET'  && p === '/api/digest/audio')    return apiAudio(url, ctx);
  if (method === 'POST' && p === '/api/digest/feedback') return apiFeedback(request, ctx);
  if (method === 'POST' && p === '/api/digest/retune')   return apiRetune(request, ctx);
  if (method === 'POST' && p === '/api/digest/ingest')   return apiIngest(request, ctx);
  if (method === 'GET'  && p === '/api/digest/selftest') return apiSelfTest(ctx);
  if (method === 'POST' && p === '/api/digest/reset')    return apiReset(request, ctx);
  if (method === 'POST' && p === '/api/digest/weekly')   return ctx.json(await D.weeklyRollup(ctx, Date.now()));
  if (method === 'POST' && p === '/api/digest/breaking') return ctx.json(await D.checkBreaking(ctx, Date.now()));

  return ctx.json({ ok: false, error: 'unknown digest route', path: p }, 404);
}

// ---------------------------------------------------------------------------
// Console state
// ---------------------------------------------------------------------------
async function apiState(ctx) {
  const cfg = await D.loadCfg(ctx);
  const [context, kit, orders, capture, state, weights, index, feedback] = await Promise.all([
    D.loadContext(ctx), D.loadKit(ctx), D.loadOrders(ctx), D.loadCapture(ctx),
    D.getJson(ctx, D.K.state, {}), D.getJson(ctx, D.K.weights, { topics: {}, terms: {} }),
    D.getJson(ctx, D.K.index, []), D.getJson(ctx, D.K.feedback, []),
  ]);
  const entities = await D.getJson(ctx, D.K.entities, {});
  const now = Date.now();
  const p = D.localParts(now, cfg.tz);
  return ctx.json({
    ok: true,
    cfg, context, kit, orders, capture, weights,
    state: {
      lastSentOn: state.lastSentOn || '', lastId: state.lastId || '', lastAt: state.lastAt || 0,
      lastError: state.lastError || '', lastErrorAt: state.lastErrorAt || 0,
      lastDiagnostics: state.lastDiagnostics || [],
      pendingQuestion: state.pendingQuestion || '',
      reminders: state.reminders || [],
      breakingOn: state.breakingOn || '', breakingCount: state.breakingCount || 0,
      skillIndex: state.skillIndex || 0,
    },
    archive: index.slice(0, 40).map((e) => ({ id: e.id, date: e.date, dateLabel: e.dateLabel, headline: e.headline, readingMin: e.readingMin, items: e.items })),
    feedback: feedback.slice(0, 40),
    trackedEntities: Object.keys(entities).length,
    localNow: `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    emailTo: cfg.to || ctx.env.ALERT_EMAIL || '(not set)',
    hasGemini: !!ctx.env.GEMINI_API_KEY,
    hasEmail: !!(ctx.env.RESEND_API_KEY && (cfg.to || ctx.env.ALERT_EMAIL)),
  });
}

// ---------------------------------------------------------------------------
// Settings & the things Mikey edits
// ---------------------------------------------------------------------------
const CFG_FIELDS = ['enabled', 'hour', 'tz', 'to', 'maxItems', 'perSub', 'commentPosts', 'commentsPerPost',
  'diversityMax', 'emojiHeaders', 'skim', 'audio', 'audioMinutes', 'editorialPass', 'dedupeDays',
  'topics', 'seasons', 'signals', 'skills', 'questions', 'local', 'voice', 'breaking', 'weekly',
  'business', 'googleDocId', 'googleSheetId', 'googleSheetRange', 'captureAutoAppend'];

async function apiConfig(request, ctx) {
  const data = await ctx.readJson(request);
  const patch = {};
  for (const f of CFG_FIELDS) if (data[f] !== undefined) patch[f] = data[f];
  if (patch.hour != null) patch.hour = Math.max(0, Math.min(23, Math.round(Number(patch.hour) || 0)));
  if (patch.maxItems != null) patch.maxItems = Math.max(0, Math.min(30, Math.round(Number(patch.maxItems) || 0)));
  if (patch.diversityMax != null) patch.diversityMax = Math.max(1, Math.min(10, Math.round(Number(patch.diversityMax) || 2)));
  if (Array.isArray(patch.topics)) {
    patch.topics = patch.topics.filter((t) => t && t.id).map((t) => ({
      id: String(t.id).slice(0, 30), label: String(t.label || t.id).slice(0, 60),
      emoji: String(t.emoji || '').slice(0, 4), enabled: t.enabled !== false,
      max: Math.max(0, Math.min(10, Math.round(Number(t.max) || 3))),
      subs: (t.subs || []).map((s) => String(s).replace(/[^\w]/g, '').slice(0, 40)).filter(Boolean).slice(0, 8),
      feeds: (t.feeds || []).filter((f) => f && f.url).map((f) => ({ id: String(f.id || '').slice(0, 40), label: String(f.label || '').slice(0, 60), url: S.safeUrl(f.url), source: String(f.source || '').slice(0, 40) })).slice(0, 6),
      hint: String(t.hint || '').slice(0, 900),
      context: String(t.context || '').slice(0, 3000),
      usePlaybook: !!t.usePlaybook, breaking: !!t.breaking,
    })).slice(0, 16);
  }
  const cfg = await D.saveCfg(ctx, patch);
  return ctx.json({ ok: true, cfg });
}

async function apiContext(request, ctx) {
  const data = await ctx.readJson(request);
  if (data.append) {
    const doc = await D.appendContext(ctx, String(data.heading || 'Note').slice(0, 80), String(data.append).slice(0, 8000));
    return ctx.json({ ok: true, context: doc });
  }
  const doc = await D.saveContext(ctx, data.text, 'app');
  return ctx.json({ ok: true, context: doc });
}

async function apiKit(request, ctx) {
  const data = await ctx.readJson(request);
  const kit = (Array.isArray(data.kit) ? data.kit : []).filter((k) => k && k.name).map((k) => ({
    name: String(k.name).slice(0, 90),
    verdict: String(k.verdict || '').slice(0, 40),
    note: String(k.note || '').slice(0, 400),
    owned: k.owned !== false,
  })).slice(0, 200);
  await D.putJson(ctx, D.K.kit, kit);
  return ctx.json({ ok: true, kit });
}

async function apiOrders(request, ctx) {
  const data = await ctx.readJson(request);
  const orders = (Array.isArray(data.orders) ? data.orders : []).filter((o) => o && o.text).map((o) => ({
    id: String(o.id || 'o' + Math.random().toString(36).slice(2, 9)),
    text: String(o.text).slice(0, 240),
    never: (o.never || []).map((s) => String(s).toLowerCase().slice(0, 60)).filter(Boolean).slice(0, 12),
    enabled: o.enabled !== false,
    addedOn: o.addedOn || new Date().toISOString().slice(0, 10),
    source: o.source || 'app',
  })).slice(0, 60);
  await D.putJson(ctx, D.K.orders, orders);
  return ctx.json({ ok: true, orders });
}

async function apiCapture(request, ctx) {
  const data = await ctx.readJson(request);
  if (data.clear) { await D.putJson(ctx, D.K.capture, []); return ctx.json({ ok: true, capture: [] }); }
  const r = await D.digestCapture(ctx, { text: data.text, source: data.source || 'app' });
  return ctx.json(Object.assign(r, { capture: await D.loadCapture(ctx) }));
}

async function apiIngest(request, ctx) {
  const data = await ctx.readJson(request);
  return ctx.json(await D.digestIngest(ctx, { text: data.text, source: data.source || 'app' }));
}

async function apiRetune(request, ctx) {
  const data = await ctx.readJson(request);
  return ctx.json(await D.retune(ctx, data.text));
}

// ---------------------------------------------------------------------------
// Build / preview / send
// ---------------------------------------------------------------------------
async function apiRun(request, ctx) {
  const data = await ctx.readJson(request);
  const dry = data.send !== true;                    // sending is opt-in, always
  const built = await D.buildDigest(ctx, { dryRun: dry, actionUrl: dry ? false : undefined });
  if (!built.ok) return ctx.json({ ok: false, error: built.reason, diagnostics: built.diagnostics }, 200);

  if (dry) {
    return ctx.json({
      ok: true, dry: true, id: built.id, subject: built.subject,
      html: built.html, text: built.text, audio: built.audio,
      doc: stripHeavy(built.doc), diagnostics: built.diagnostics,
    });
  }
  const res = await D.sendDigest(ctx, built);
  return ctx.json({ ok: true, dry: false, id: built.id, subject: built.subject, delivered: res.delivered, error: res.error, diagnostics: built.diagnostics });
}

function stripHeavy(doc) {
  const d = Object.assign({}, doc);
  delete d.html;
  return d;
}

// ---------------------------------------------------------------------------
// Archive + search
// ---------------------------------------------------------------------------
async function apiArchive(url, ctx) {
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(60, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10)));
  const index = await D.getJson(ctx, D.K.index, []);
  let rows = index;
  if (q) {
    // Every word has to appear somewhere in the issue — "that polish from last
    // month" finds the issue, and two words don't match twice as much noise.
    const words = q.split(/\s+/).filter(Boolean);
    rows = index.filter((e) => words.every((w) => String(e.q || '').includes(w) || String(e.headline || '').toLowerCase().includes(w)));
  }
  return ctx.json({
    ok: true, q, total: rows.length,
    results: rows.slice(0, limit).map((e) => ({
      id: e.id, date: e.date, dateLabel: e.dateLabel, headline: e.headline,
      readingMin: e.readingMin, items: e.items,
      excerpt: q ? excerpt(e.q || '', q.split(/\s+/)[0]) : '',
    })),
  });
}

function excerpt(blob, word) {
  const i = blob.indexOf(word);
  if (i < 0) return blob.slice(0, 160);
  return (i > 40 ? '…' : '') + blob.slice(Math.max(0, i - 60), i + 140) + '…';
}

async function apiDoc(url, ctx) {
  const id = String(url.searchParams.get('id') || '');
  if (!/^[\d-]{8,16}$/.test(id)) return ctx.json({ ok: false, error: 'bad_id' }, 400);
  const doc = await D.getJson(ctx, D.K.doc(id), null);
  if (!doc) return ctx.json({ ok: false, error: 'not_found' }, 404);
  return ctx.json({ ok: true, doc });
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
// The browser speaks the script for free and offline (see digest.html), which is
// the path that always works. Real synthesized MP3 is opt-in and needs Cloud
// Text-to-Speech enabled on the same Google project as the service account.
async function apiAudio(url, ctx) {
  const id = String(url.searchParams.get('id') || '');
  const doc = id ? await D.getJson(ctx, D.K.doc(id), null) : await latestDoc(ctx);
  if (!doc) return ctx.json({ ok: false, error: 'not_found' }, 404);
  const audio = doc.audio || { script: '', minutes: 0 };
  if (url.searchParams.get('mp3') !== '1') {
    return ctx.json({ ok: true, id: doc.id, script: audio.script, minutes: audio.minutes, words: audio.words });
  }
  try {
    const mp3 = await synthesize(ctx, audio.script);
    return new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' } });
  } catch (err) {
    return ctx.json({ ok: false, error: String(err && err.message || err), script: audio.script }, 200);
  }
}

async function latestDoc(ctx) {
  const index = await D.getJson(ctx, D.K.index, []);
  return index.length ? await D.getJson(ctx, D.K.doc(index[0].id), null) : null;
}

async function synthesize(ctx, script) {
  if (!ctx.googleToken) throw new Error('Google service account not connected');
  const text = String(script || '').trim();
  if (!text) throw new Error('no script');
  const token = await ctx.googleToken('https://www.googleapis.com/auth/cloud-platform');
  const chunks = splitForTts(text, 4500);
  const parts = [];
  for (const chunk of chunks) {
    const res = await (ctx.fetchImpl || fetch)('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: chunk },
        voice: { languageCode: 'en-US', name: 'en-US-Neural2-D' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.02 },
      }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    parts.push(base64ToBytes(data.audioContent || ''));
  }
  // MP3 frames concatenate cleanly, so chunked synthesis plays as one file.
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function splitForTts(text, max) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + '\n\n' + para).length > max) { if (cur) out.push(cur); cur = para.slice(0, max); }
    else cur = cur ? cur + '\n\n' + para : para;
  }
  if (cur) out.push(cur);
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
async function apiFeedback(request, ctx) {
  const d = await ctx.readJson(request);
  return ctx.json(await D.recordFeedback(ctx, {
    digestId: d.digestId, itemKey: d.itemKey, action: d.action,
    topicId: d.topicId, entity: d.entity, note: d.note,
  }));
}

/** The email buttons land here. No session — the token is the authority. */
async function tapAction(request, url, ctx, token) {
  const payload = await D.verifyAction(ctx, token);
  if (!payload) return actionPage('Link expired', 'That button is older than 45 days, or the link was altered. Open the archive and tap it there instead.', ctx, false);
  const res = await D.recordFeedback(ctx, {
    digestId: payload.d, itemKey: payload.i, action: payload.a,
    topicId: payload.t, entity: payload.e,
  });
  const what = payload.e || 'that item';
  const copy = {
    buy: [`Nice — ${what} it is.`, 'Logged as a buy. You\'ll see more like it, and it\'s in this week\'s rollup.'],
    reject: [`Won't show you ${what} again.`, 'That topic just got quieter. The weighting fades back over a couple of weeks, so it isn\'t permanent unless you keep tapping.'],
    remind: [`Reminder set${res.extra && res.extra.remindOn ? ' for ' + res.extra.remindOn : ' for Friday'}.`, `You'll get a nudge about ${what} at 8am.`],
    up: ['Noted.', 'More of that.'],
    down: ['Noted.', 'Less of that.'],
    save: ['Saved.', 'It\'s in the archive whenever you want it.'],
  }[payload.a] || ['Got it.', ''];
  return actionPage(copy[0], copy[1], ctx, true);
}

function actionPage(title, body, ctx, ok) {
  const base = ctx.publicBase();
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:460px;margin:14vh auto;background:#fff;border-radius:16px;padding:30px 26px;text-align:center;">
  <div style="font-size:34px;">${ok ? '✅' : '⚠️'}</div>
  <h1 style="font-size:20px;margin:14px 0 8px;color:#14140f;">${escapeHtml(title)}</h1>
  <p style="font-size:14px;line-height:1.65;color:#5c5c54;margin:0 0 22px;">${escapeHtml(body)}</p>
  <a href="${escapeHtml(base)}/digest.html" style="display:inline-block;background:#c0261f;color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-size:14px;font-weight:700;">Open the rundown</a>
</div></body></html>`;
  return new Response(html, { status: ok ? 200 : 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Self-test & reset
// ---------------------------------------------------------------------------
/**
 * Reachability, from the Worker's own egress. Reddit in particular refuses some
 * datacenter ranges, and when it does you want to see which tier answered rather
 * than a silent empty section tomorrow morning.
 */
async function apiSelfTest(ctx) {
  const cfg = await D.loadCfg(ctx);
  const sub = ((cfg.topics || [])[0] || {}).subs && cfg.topics[0].subs[0] || 'AutoDetailing';
  const checks = [];
  const reqs = [
    { name: 'reddit rss (www)', url: S.REDDIT_HOSTS[0](sub, 'day', 3) },
    { name: 'reddit rss (old)', url: S.REDDIT_HOSTS[1](sub, 'day', 3) },
    { name: 'reddit json', url: S.REDDIT_HOSTS[2](sub, 'day', 3) },
    { name: 'google news rss', url: S.newsFeedUrl('car detailing', { days: 7 }) },
    { name: 'open-meteo forecast', url: S.weatherUrl(cfg.local.lat, cfg.local.lon, cfg.tz) },
    { name: 'open-meteo air quality', url: S.airQualityUrl(cfg.local.lat, cfg.local.lon, cfg.tz) },
  ];
  const res = await S.fetchBatch(reqs, { attempts: 1, fetchImpl: ctx.fetchImpl });
  res.forEach((r, i) => {
    const items = r.error ? 0 : (reqs[i].name === 'reddit json' ? countJsonPosts(r.body) : S.parseFeed(r.body, { limit: 5 }).length);
    checks.push({ name: reqs[i].name, ok: !r.error && (items > 0 || /meteo/.test(reqs[i].name)), code: r.code, items, error: r.error || '' });
  });

  let gemini = { ok: false, error: 'GEMINI_API_KEY not set' };
  if (ctx.env.GEMINI_API_KEY) {
    try {
      const out = await ctx.gemini('Reply with the single word: ready', { maxTokens: 16, temperature: 0 });
      gemini = { ok: /ready/i.test(out), sample: String(out).slice(0, 40) };
    } catch (err) { gemini = { ok: false, error: String(err && err.message || err) }; }
  }
  checks.push(Object.assign({ name: 'gemini' }, gemini));
  checks.push({ name: 'email (resend)', ok: !!(ctx.env.RESEND_API_KEY && (cfg.to || ctx.env.ALERT_EMAIL)),
    error: ctx.env.RESEND_API_KEY ? (cfg.to || ctx.env.ALERT_EMAIL ? '' : 'no recipient set') : 'RESEND_API_KEY not set' });
  checks.push({ name: 'google service account (docs/sheets/tts)', ok: !!ctx.googleToken && (await googleProbe(ctx)), error: ctx.googleToken ? '' : 'not connected — optional' });

  return ctx.json({ ok: checks.every((c) => c.ok || /optional/.test(c.error || '')), checks });
}

async function googleProbe(ctx) {
  try { return !!(await ctx.googleToken('https://www.googleapis.com/auth/drive.readonly')); } catch { return false; }
}

function countJsonPosts(body) {
  try { return (((JSON.parse(body) || {}).data || {}).children || []).length; } catch { return 0; }
}

async function apiReset(request, ctx) {
  const d = await ctx.readJson(request);
  const what = String(d.what || '');
  const map = { seen: D.K.seen, ledger: D.K.ledger, weights: D.K.weights, entities: D.K.entities, absence: D.K.absence, feedback: D.K.feedback };
  if (what === 'all') {
    for (const k of Object.values(map)) await ctx.kv.delete(k);
    return ctx.json({ ok: true, cleared: Object.keys(map) });
  }
  if (!map[what]) return ctx.json({ ok: false, error: 'unknown: ' + what }, 400);
  await ctx.kv.delete(map[what]);
  return ctx.json({ ok: true, cleared: [what] });
}
