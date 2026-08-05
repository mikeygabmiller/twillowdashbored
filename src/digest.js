/**
 * MORNING DIGEST — the engine.
 *
 * Was a Google Apps Script; now a Cloudflare Worker module that runs beside the
 * SMS dashboard. Moving it here bought four things Apps Script couldn't give it:
 *
 *   • It can see the business. Revenue, jobs, unanswered leads, tomorrow's
 *     bookings and the weather over them are all one KV read away, so "your
 *     numbers" can sit above anything from the internet instead of being a
 *     separate email nobody opens.
 *   • Real endpoints. One-tap actions, a web archive, a capture inbox and a
 *     retune-by-text loop all need URLs, which a time-triggered script doesn't
 *     have.
 *   • A minute cron that already exists, so the breaking interrupt doesn't have
 *     to wait for 7am.
 *   • No 6-minute execution ceiling and no Apps Script quota roulette.
 *
 * KV BUDGET (this Worker shares a free-tier namespace — see the banner in
 * src/index.js): a normal day is ~8 writes. The digest writes once when it
 * sends; hourly breaking checks read but never write unless they actually fire.
 * Nothing in here writes on an idle tick.
 */

import * as V from './digest-verify.js';
import * as S from './digest-sources.js';
import { renderDigest } from './digest-render.js';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
export const K = {
  cfg: 'dg:cfg',
  context: 'dg:context',
  kit: 'dg:kit',
  orders: 'dg:orders',
  capture: 'dg:capture',
  state: 'dg:state',
  seen: 'dg:seen',
  ledger: 'dg:ledger',
  entities: 'dg:entities',
  weights: 'dg:weights',
  feedback: 'dg:feedback',
  absence: 'dg:absence',
  index: 'dg:index',
  secret: 'dg:secret',
  doc: (id) => 'dg:d:' + id,
};

const SEEN_LIMIT = 500;
const FEEDBACK_LIMIT = 300;
const ARCHIVE_LIMIT = 120;

// ---------------------------------------------------------------------------
// Small storage helpers
// ---------------------------------------------------------------------------
export async function getJson(ctx, key, fallback) {
  try {
    const v = await ctx.kv.get(key, { type: 'json' });
    return v == null ? fallback : v;
  } catch { return fallback; }
}
export async function putJson(ctx, key, val) { await ctx.kv.put(key, JSON.stringify(val)); }

// ---------------------------------------------------------------------------
// Time (business-local, DST-correct)
// ---------------------------------------------------------------------------
export function localParts(ts, tz) {
  const s = new Date(ts).toLocaleString('en-US', {
    timeZone: tz || 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const m = s.match(/(\w{3}),?\s*(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/);
  if (!m) { const d = new Date(ts); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay() }; }
  const dows = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${m[4]}-${m[2]}-${m[3]}`, hour: +m[5], minute: +m[6], dow: dows[m[1]] == null ? 0 : dows[m[1]] };
}
export function dateLabel(dateStr) {
  const t = Date.parse(dateStr + 'T12:00:00Z');
  return new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export function defaultTopics() {
  return [
    { id: 'detailing', label: 'Detailing products & technique', emoji: '🧽', enabled: true, max: 4,
      subs: ['AutoDetailing', 'Detailing'], usePlaybook: true, breaking: true,
      hint: 'New or newly-praised products, formulas and tools. Real-world reviews and long-term durability beat marketing. Flag anything a working mobile detailer would actually buy or change.',
      context: '' },
    { id: 'tools', label: 'Mechanic tools', emoji: '🔧', enabled: true, max: 3,
      subs: ['Tools', 'MechanicAdvice'],
      hint: 'New tool releases, deals with the actual price, and durability verdicts. Prefer tools useful to someone working out of a vehicle.',
      context: '' },
    { id: 'hf', label: 'Harbor Freight', emoji: '🛠️', enabled: true, max: 3, breaking: true,
      subs: ['harborfreight'],
      hint: 'New arrivals, coupons and current deals, Icon/Hercules/Bauer updates, and which items are genuinely worth buying versus false economy.',
      context: '' },
    { id: 'ow', label: 'Overwatch 2', emoji: '🎮', enabled: true, max: 2,
      subs: ['Overwatch', 'Competitiveoverwatch'],
      hint: 'Patch notes, balance changes, new heroes, seasons and events. Keep this one shorter and fun.',
      context: '' },
    { id: 'aibiz', label: 'AI for business', emoji: '💼', enabled: true, max: 3,
      subs: ['smallbusiness', 'SaaS', 'AI_Agents'],
      hint: 'Concrete ways small businesses use AI to save time or win work, ideally with real numbers. Skip hype and anything selling a course.',
      context: '' },
    { id: 'claude', label: 'Anthropic & Claude', emoji: '🤖', enabled: true, max: 3, breaking: true,
      subs: ['ClaudeAI', 'Anthropic'],
      hint: 'Model releases, feature and pricing changes, usage limits, outages, and genuinely useful workflow tips. Call out anything that changes what a paying subscriber gets.',
      context: '' },
    { id: 'local', label: 'Local & competitors', emoji: '📍', enabled: true, max: 3,
      subs: ['Snohomish', 'Everett'],
      hint: 'Anything that changes demand or pricing in Snohomish County: local events, weather stories, road/construction news, and what other detailers around here are charging or being reviewed for.',
      context: '' },
  ];
}

export function defaultSeasons() {
  return [
    { id: 'pollen', label: 'Pollen season', month: 3, day: 1, leadDays: 21, enabled: true,
      note: 'Pollen hits western WA soon. Exterior jobs start rebooking in two weeks — line up sealant stock and push a "keeps pollen off for 3 months" offer before the calls start.' },
    { id: 'wildfire', label: 'Wildfire smoke & ash', month: 7, day: 15, leadDays: 21, enabled: true,
      note: 'Smoke/ash season is close. Ash is alkaline and etches clear coat fast — stock a pH-neutral wash and pre-write the "do not dry-wipe your car" text for customers.' },
    { id: 'rain', label: 'Rainy season', month: 10, day: 1, leadDays: 21, enabled: true,
      note: 'The rain returns. Interiors and mats become the money work; exterior bookings drop. Time to lean the offer toward interior + ceramic maintenance.' },
    { id: 'salt', label: 'Road salt / winter grime', month: 11, day: 15, leadDays: 21, enabled: true,
      note: 'Road treatment starts on the passes soon. Undercarriage rinses and salt-removal add-ons are worth pricing now, before the first freeze.' },
    { id: 'spring', label: 'Spring detail rush', month: 4, day: 1, leadDays: 30, enabled: true,
      note: 'Spring rush builds in about a month — historically the busiest booking window. Get the calendar, supplies and any helper lined up before it lands, not during.' },
    { id: 'giftcards', label: 'Holiday gift cards', month: 11, day: 20, leadDays: 21, enabled: true,
      note: 'Gift-card season. A simple "detail gift card" post in late November tends to pay for the slow weeks in January.' },
  ];
}

export function defaultSkills() {
  return [
    { title: 'Two-bucket wash, properly', body: 'One bucket of soap, one of rinse water, grit guards in both. Wash top-down in straight lines, never circles — swirls are almost always from wash technique, not from the customer\'s car cover. Rinse the mitt in the rinse bucket after every panel and change water when it looks like coffee.' },
    { title: 'Read paint before you touch it', body: 'Bag test: put your hand in a sandwich bag and glide it over washed paint. If it feels like sandpaper, the car needs decontamination (clay or iron remover) before any polish. Skipping this is what turns a polish into a scratch pattern.' },
    { title: 'Iron remover vs clay — when each wins', body: 'Iron remover dissolves brake-dust fallout chemically and is safer on soft paint. Clay shears off bonded contamination mechanically and always induces some marring. Chemical first, clay only for what survives it.' },
    { title: 'One-step polish math', body: 'A single-stage polish with a medium pad removes most of what a customer notices for a fraction of the labor of a true correction. Price it as its own service. Know your removal ceiling so you never promise a two-step outcome on one-step money.' },
    { title: 'Pad priming and pad count', body: 'A dry pad burns product and heats the paint. Prime with a few drops, spread on speed 1, then cut. Carry at least four pads per car and swap when the pad stops cutting — a saturated pad is the leading cause of "I polished for an hour and nothing happened".' },
    { title: 'Interior order of operations', body: 'Always: remove everything → blow out with air → vacuum → agitate fabric → extract → hard surfaces → glass last. Doing glass before surfaces guarantees you clean it twice.' },
    { title: 'Pet hair without the misery', body: 'Rubber pumice or a horsehair brush plus a light mist of water lifts hair to the surface, then vacuum. Charge for it separately and quote it by the hour — pet hair is the single most underquoted line item in mobile detailing.' },
    { title: 'Odor: source, then oxidize', body: 'Enzyme treatments deal with organic sources; ozone/chlorine dioxide handles what remains in the air path. Neither works if the source (spilled milk under a seat, a soaked carpet pad) is still there. Always find the source first or the smell comes back in a week.' },
    { title: 'Ceramic prep is 90% of the job', body: 'Coating durability is decided before the bottle opens: decontamination, correction, and a panel wipe that actually removes polishing oils. A perfect application over an unprepped panel fails in months and the customer blames the coating.' },
    { title: 'Flash time and high spots', body: 'Coatings flash by temperature and humidity, not by the clock on the bottle. In a cold Washington driveway the window stretches; in a hot one it collapses. Work small sections and level with a fresh towel while it still smears.' },
    { title: 'Water spots: the three kinds', body: 'Fresh mineral deposits wipe off with a diluted acid; etched spots need polishing; and hard-water etching through a coating needs the coating removed. Diagnose before quoting, because those are three different prices.' },
    { title: 'Quote from photos without losing money', body: 'Ask for four photos: full exterior, driver footwell, back seat, and trunk. Quote a range with a stated condition assumption, and put the upcharge trigger in writing ("heavy pet hair adds $X"). Ranges close better than a single number and protect the day rate.' },
    { title: 'Price on time, not on car size', body: 'Track actual minutes per job for two weeks. Most detailers find that condition, not vehicle size, drives 80% of the labor. Rebuilding the price sheet around hours is usually the single biggest margin change available.' },
    { title: 'The follow-up that books the rebook', body: 'A text at 90 days — with a photo of their own car from the job — books more repeat work than any discount. The photo does the selling; the discount just trains people to wait for the discount.' },
    { title: 'Review velocity beats review count', body: 'Local ranking responds to a steady trickle of new reviews more than to a big pile of old ones. Ask at the moment of delivery, in person, with the link already open on your phone. One a week beats ten in a month and then nothing.' },
    { title: 'Water and power on site', body: 'Know your real consumption per job. A 50-gallon tank and a 2000-watt inverter set a hard ceiling on how many jobs you can run before a refill, and routing around that is worth more than driving faster.' },
    { title: 'Winter scheduling reality', body: 'Below about 45°F, coatings and many sealants stop curing predictably and drying takes twice as long. Book interiors in the cold months and put exterior work in the forecast gaps — planning around it beats cancelling on the day.' },
    { title: 'Upsell that isn\'t a sleaze', body: 'Show, don\'t tell: clean half the headlight, half the engine bay, one door jamb. The visible split does the asking. Customers buy what they can see the difference on.' },
    { title: 'Chemical dilution discipline', body: 'Buy concentrates, label every bottle with the ratio and date, and dilute by weight where it matters. Guessing at ratios is the quiet way detailers turn a $30 gallon into a $90 gallon.' },
    { title: 'Know your job costing', body: 'Per job: chemicals, pads/towels amortized, fuel, water, and your hours. Anything under about a 60% gross margin after materials means the price sheet is wrong, not that the day was slow.' },
  ];
}

export function defaultQuestions() {
  return [
    'What did a customer say this week that surprised you?',
    'Which service made you the most money per hour last month — and do you actually push it?',
    'What is the one product you keep reaching for that you have never told anyone about?',
    'What job would you turn down today that you would have taken a year ago?',
    'Which part of a full detail do you dread most? There may be a tool for it.',
    'What is the price you are scared to raise, and what would happen if you did?',
    'Who is your closest competitor right now, and what do they do better?',
    'What did you buy this year that turned out to be a waste of money?',
    'How far are you willing to drive for a job, honestly?',
    'What would have to be true for you to hire help?',
    'What question do customers ask that you still do not have a good answer for?',
    'Which recurring expense could you kill this month without anyone noticing?',
    'What is the longest a lead should wait before you write it off?',
    'What do you want this business to look like in two years?',
    'What is the last thing you learned that changed how you work?',
  ];
}

export function defaultConfig() {
  return {
    enabled: true,
    hour: 7,                       // local send hour
    tz: 'America/Los_Angeles',
    to: '',                        // blank = ALERT_EMAIL
    maxItems: 10,                  // hard cap; "nothing today" is a valid answer
    perSub: 8,
    commentPosts: 12,
    commentsPerPost: 4,
    diversityMax: 2,               // items per source per digest
    emojiHeaders: true,            // false = typography-led (serif, no emoji)
    skim: true,                    // include the 30-second version
    audio: true,
    audioMinutes: 4,
    editorialPass: true,           // the second model call whose only job is cutting
    dedupeDays: 21,                // don't-tell-me-again cool-off
    topics: defaultTopics(),
    seasons: defaultSeasons(),
    signals: [
      { id: 'hf-coupon', label: 'Harbor Freight coupon drop', enabled: true, cadenceDays: 7, pattern: 'coupon|% off|promo code|sale ends' },
      { id: 'ow-patch', label: 'Overwatch patch notes', enabled: true, cadenceDays: 14, pattern: 'patch notes|balance change|hotfix' },
      { id: 'claude-release', label: 'Anthropic model/feature news', enabled: true, cadenceDays: 21, pattern: 'release|launch|now available|pricing|limit' },
    ],
    skills: { enabled: true, index: 0, list: defaultSkills() },
    questions: { enabled: true, index: 0, list: defaultQuestions() },
    local: {
      city: 'Snohomish, WA', lat: 47.9129, lon: -122.0982,
      queries: ['Snohomish County events', 'Everett WA road construction'],
      competitors: ['mobile detailing Snohomish', 'car detailing Everett WA'],
      newsDays: 7,
    },
    voice: { register: '', samples: [] },
    breaking: { enabled: true, maxPerDay: 2, quietStart: 21, quietEnd: 6, minDiscount: 30,
      triggers: ['outage', 'down', 'recall', 'discontinued', 'price drop', 'free for', 'lowest price', 'clearance', 'rate limit', 'usage limit'] },
    weekly: { enabled: true, dow: 0, hour: 17 },
    business: { enabled: true, reviewUrl: '' },
    googleDocId: '',               // optional: living context doc (Drive export)
    googleSheetId: '',             // optional: kit & opinions sheet
    googleSheetRange: 'Sheet1!A1:D200',
    captureAutoAppend: true,
  };
}

export async function loadCfg(ctx) {
  const saved = await getJson(ctx, K.cfg, null);
  const base = defaultConfig();
  if (!saved) return base;
  const cfg = Object.assign(base, saved);
  // Nested objects need a real merge or a config saved before a new field was
  // added would silently drop the default.
  for (const key of ['skills', 'questions', 'local', 'voice', 'breaking', 'weekly', 'business']) {
    cfg[key] = Object.assign({}, base[key], saved[key] || {});
  }
  if (!Array.isArray(cfg.topics) || !cfg.topics.length) cfg.topics = base.topics;
  if (!Array.isArray(cfg.seasons)) cfg.seasons = base.seasons;
  if (!Array.isArray(cfg.signals)) cfg.signals = base.signals;
  if (!Array.isArray(cfg.skills.list) || !cfg.skills.list.length) cfg.skills.list = base.skills.list;
  if (!Array.isArray(cfg.questions.list) || !cfg.questions.list.length) cfg.questions.list = base.questions.list;
  return cfg;
}

export async function saveCfg(ctx, patch) {
  const cur = await loadCfg(ctx);
  const next = Object.assign({}, cur, patch || {});
  await putJson(ctx, K.cfg, next);
  return next;
}

// ---------------------------------------------------------------------------
// Living context doc, kit, standing orders, capture inbox
// ---------------------------------------------------------------------------
export const DEFAULT_CONTEXT = `# Who I am
Mikey — owner-operator, Mikey's Mobile Detailing, Snohomish County WA. Mobile only: I come to the driveway. Solo, working out of the vehicle.

# What I care about
Making the day pay. Tools and products that survive real use. Anything that saves me a second trip.

# What I don't care about
Marketing hype, courses, anything that needs a shop bay or a compressor I don't own.

# Notes
(Edit this from your phone any time — it's read fresh every morning.)
`;

export async function loadContext(ctx) {
  const doc = await getJson(ctx, K.context, null);
  if (doc && typeof doc.text === 'string') return doc;
  return { text: DEFAULT_CONTEXT, updatedAt: 0, source: 'default' };
}

export async function saveContext(ctx, text, source) {
  const doc = { text: String(text || '').slice(0, 60000), updatedAt: Date.now(), source: source || 'app' };
  await putJson(ctx, K.context, doc);
  return doc;
}

/** Appends a dated block to the context doc — how answers and captures accumulate. */
export async function appendContext(ctx, heading, body, today) {
  const doc = await loadContext(ctx);
  const stamp = today || new Date().toISOString().slice(0, 10);
  const next = `${doc.text.trimEnd()}\n\n## ${heading} — ${stamp}\n${String(body || '').trim()}\n`;
  return saveContext(ctx, next, doc.source === 'gdoc' ? 'app' : doc.source);
}

export async function loadKit(ctx) { return await getJson(ctx, K.kit, []); }
export async function loadOrders(ctx) { return await getJson(ctx, K.orders, []); }
export async function loadCapture(ctx) { return await getJson(ctx, K.capture, []); }

/** A note texted or emailed mid-job. Becomes tomorrow's context, verbatim. */
export async function digestCapture(ctx, { text, source, at }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };
  const list = await loadCapture(ctx);
  list.unshift({ id: 'c' + Date.now().toString(36), text: body.slice(0, 2000), source: source || 'app', at: at || Date.now() });
  if (list.length > 100) list.length = 100;
  await putJson(ctx, K.capture, list);
  return { ok: true, count: list.length };
}

// ---------------------------------------------------------------------------
// Optional Google sources (reuses the service account the Website tab already
// uses — no new credential, and both are optional: the KV copies are the truth
// when they aren't configured.)
// ---------------------------------------------------------------------------
export async function readGoogleDoc(ctx, docId) {
  if (!ctx.googleToken) throw new Error('google auth unavailable');
  const token = await ctx.googleToken('https://www.googleapis.com/auth/drive.readonly');
  const res = await (ctx.fetchImpl || fetch)(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export?mimeType=text/plain`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.text()).replace(/\r\n/g, '\n').slice(0, 60000);
}

export async function readGoogleSheet(ctx, sheetId, range) {
  if (!ctx.googleToken) throw new Error('google auth unavailable');
  const token = await ctx.googleToken('https://www.googleapis.com/auth/spreadsheets.readonly');
  const res = await (ctx.fetchImpl || fetch)(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range || 'Sheet1!A1:D200')}`,
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const rows = data.values || [];
  const out = [];
  for (const r of rows) {
    const name = String(r[0] || '').trim();
    if (!name || /^(product|item|name)$/i.test(name)) continue;   // header row
    out.push({ name, verdict: String(r[1] || '').trim().toLowerCase(), note: String(r[2] || '').trim(), owned: !/^no$/i.test(String(r[3] || '')) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Business data — "my numbers first"
// ---------------------------------------------------------------------------
export async function gatherBusiness(ctx, cfg, now) {
  const tz = cfg.tz || 'America/Los_Angeles';
  const today = localParts(now, tz).date;
  const tomorrow = V.addDays(today, 1);
  const month = today.slice(0, 7);
  const out = { today, tomorrow, lines: [] };

  try {
    const doc = await ctx.loadMonth(month);
    const entries = (doc && doc.entries) || [];
    const m = ctx.summarizeMonth(entries);
    out.monthNet = m.net; out.monthGross = m.gross; out.monthJobs = m.jobs; out.owed = m.owed;
    const w = ctx.weekWindow(today);
    const wk = ctx.summarizeWeek(entries, w.start, w.end);
    out.weekGross = wk.gross; out.weekNet = wk.net; out.weekJobs = wk.jobs;
    out.jobsToday = entries.filter((e) => e.date === today && e.type === 'job').length;
    out.todayGross = Math.round(entries.filter((e) => e.date === today && e.type === 'job')
      .reduce((s, e) => s + (+e.amount || 0), 0) * 100) / 100;
    if (m.owed > 0) out.lines.push({ text: `Customers still owe you $${V.fmtMoney(m.owed)} this month.`, tone: 'bad' });
  } catch (err) { out.moneyError = String(err && err.message || err); }

  try {
    const index = await ctx.loadIndex();
    const active = index.filter((e) => !e.archived);
    // A lead is unanswered when the last word in the thread was theirs.
    const waiting = active.filter((e) => e.lastDir === 'in');
    out.unanswered = waiting.length;
    out.openLeads = active.filter((e) => e.status === 'new' || e.status === 'active').length;
    if (waiting.length) {
      const oldest = waiting.slice().sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0))[0];
      const hrs = Math.round((now - (oldest.lastTs || now)) / 3600000);
      out.lines.push({
        text: `${waiting.length} lead${waiting.length === 1 ? '' : 's'} waiting on you — oldest is ${oldest.name || oldest.phone}, ${hrs >= 24 ? Math.round(hrs / 24) + ' day' + (hrs >= 48 ? 's' : '') : hrs + 'h'} without a reply.`,
        tone: 'bad',
      });
    }
    const dueFollowups = active.filter((e) => e.followupDue).length;
    if (dueFollowups) out.lines.push({ text: `${dueFollowups} follow-up${dueFollowups === 1 ? '' : 's'} are due in the Follow-ups tab.`, tone: 'warn' });
    // Review velocity: Won jobs in the last 30 days is the pool that reviews come
    // from, so it's the honest leading indicator when there's no reviews API.
    const thirty = now - 30 * 86400000;
    out.reviews30 = active.filter((e) => e.status === 'won' && (e.statusAt || 0) >= thirty).length;
    const prev30 = active.filter((e) => e.status === 'won' && (e.statusAt || 0) >= thirty - 30 * 86400000 && (e.statusAt || 0) < thirty).length;
    if (out.reviews30 || prev30) {
      const delta = out.reviews30 - prev30;
      out.lines.push({
        text: `${out.reviews30} job${out.reviews30 === 1 ? '' : 's'} closed in the last 30 days (${delta >= 0 ? '+' : ''}${delta} vs the 30 before) — that's your review pool.`,
        tone: delta < 0 ? 'warn' : 'good',
      });
    }
  } catch (err) { out.leadsError = String(err && err.message || err); }

  try {
    const bookings = await ctx.loadBookings();
    const live = (bookings || []).filter((b) => b.status === 'pending' || b.status === 'confirmed');
    out.bookingsTomorrow = live.filter((b) => b.date === tomorrow);
    out.jobsTomorrow = out.bookingsTomorrow.length;
    out.bookingsToday = live.filter((b) => b.date === today);
    const unconfirmed = out.bookingsTomorrow.filter((b) => b.status === 'pending');
    if (unconfirmed.length) out.lines.push({ text: `${unconfirmed.length} of tomorrow's jobs are still unconfirmed.`, tone: 'warn' });
  } catch (err) { out.bookingError = String(err && err.message || err); out.jobsTomorrow = 0; out.bookingsTomorrow = []; }

  return out;
}

/**
 * Behavioral context: what Mikey actually books and gets paid for, which is a
 * far better signal of interest than anything he'd type into a preferences page.
 */
export async function behaviorTerms(ctx, cfg, now) {
  const tz = cfg.tz || 'America/Los_Angeles';
  const today = localParts(now, tz).date;
  const months = [today.slice(0, 7), ctx.prevMonthKey(today.slice(0, 7)), ctx.prevMonthKey(ctx.prevMonthKey(today.slice(0, 7)))];
  const counts = {};
  const bump = (s, n) => { const k = String(s || '').trim().toLowerCase(); if (k.length > 2) counts[k] = (counts[k] || 0) + (n || 1); };
  try {
    for (const m of months) {
      const doc = await ctx.loadMonth(m);
      for (const e of ((doc && doc.entries) || [])) {
        if (e.type === 'job') { bump(e.service, 2); bump(e.vehicle); bump(e.material); }
        else if (e.type === 'exp') bump(e.cat);
      }
    }
  } catch { /* behavior signal is a bonus, never a blocker */ }
  try {
    for (const b of (await ctx.loadBookings() || [])) {
      if (b.service) bump(b.service, 2);
      for (const a of (b.addons || [])) bump(a);
    }
  } catch { /* same */ }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 25);
}

// ---------------------------------------------------------------------------
// Weather-conditional scheduling
// ---------------------------------------------------------------------------
export function buildPlan(business, weather, cfg) {
  const entries = [];
  const date = business.tomorrow;
  const day = (weather && weather.days && weather.days[date]) || null;
  const bookings = (business.bookingsTomorrow || []).slice()
    .sort((a, b) => String(a.slot || '').localeCompare(String(b.slot || '')));

  for (const b of bookings) {
    const outdoors = isOutdoorJob(b);
    const w = S.rainDuring(weather, date, b.slot || '09:00', b.durationMin || 180);
    const label = `${fmt12(b.slot || '09:00')}`;
    const what = `${b.serviceLabel || b.service || 'Job'}${b.name ? ' — ' + b.name : ''}${b.city ? ' (' + b.city + ')' : ''}`;
    if (!w) { entries.push({ when: label, what, note: 'No forecast available for this slot.', tone: '' }); continue; }
    const bits = [`${w.rainChance == null ? '?' : Math.round(w.rainChance)}% rain, ${w.temp == null ? '?' : Math.round(w.temp)}°F, wind ${w.wind == null ? '?' : Math.round(w.wind)} mph`];
    let tone = '';
    if (outdoors && w.rainChance != null && w.rainChance >= 70) {
      tone = 'bad';
      bits.push('That is a wash-out for exterior work — move it or call them today, not tomorrow morning.');
    } else if (outdoors && w.rainChance != null && w.rainChance >= 40) {
      tone = 'warn';
      bits.push('Coin-flip weather. Have the interior-first plan ready so the drive isn\'t wasted.');
    } else if (outdoors && w.temp != null && w.temp < 45) {
      tone = 'warn';
      bits.push('Under 45°F — coatings and sealants stop curing predictably. Sell interior or reschedule the exterior.');
    } else if (outdoors && w.temp != null && w.temp > 85) {
      tone = 'warn';
      bits.push('Hot panel risk: product will flash before you level it. Work in the shade and shrink your sections.');
    } else if (!outdoors) {
      bits.push('Interior work — weather doesn\'t decide this one.');
    } else {
      tone = 'good';
      bits.push('Good window for exterior work.');
    }
    entries.push({ when: label, what, note: bits.join(' · '), tone });
  }

  const plan = { entries };
  if (!bookings.length) {
    plan.empty = day
      ? `Nothing booked for tomorrow. ${Math.round(day.rainChance || 0)}% rain, ${Math.round(day.high || 0)}°F — ${(day.rainChance || 0) < 40 ? 'a dry day with an empty calendar is the day to chase the waiting leads.' : 'a wet day: good for interiors, good for admin.'}`
      : 'Nothing booked for tomorrow.';
  } else if (day) {
    plan.summary = `Tomorrow overall: ${Math.round(day.rainChance || 0)}% rain, ${Math.round(day.low || 0)}–${Math.round(day.high || 0)}°F, wind to ${Math.round(day.wind || 0)} mph.`;
  }
  return plan;
}

// Judged on the SERVICE, never the add-ons: "full detail + pet hair removal" is
// an outdoor job with an indoor add-on, and reading the add-ons first told Mikey
// the weather didn't matter for the one job it mattered most for.
function isOutdoorJob(b) {
  const svc = `${b.service || ''} ${b.serviceLabel || ''}`.toLowerCase();
  if (/exterior|full|wash|polish|ceramic|coat|wax|paint|engine|headlight/.test(svc)) return true;
  if (/interior|inside|seat|carpet|pet|odor|shampoo|steam/.test(svc)) return false;
  return true;   // unknown service → assume the sky gets a vote
}

function fmt12(hm) {
  let [h, m] = String(hm).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  let hr = h % 12; if (hr === 0) hr = 12;
  return `${hr}:${String(m || 0).padStart(2, '0')} ${ap}`;
}

// ---------------------------------------------------------------------------
// Seasonal anticipation
// ---------------------------------------------------------------------------
export function seasonalNotices(seasons, today) {
  const out = [];
  const y = Number(today.slice(0, 4));
  for (const s of (seasons || [])) {
    if (!s || s.enabled === false) continue;
    // Check this year and next, so a December warning about a March season works.
    for (const year of [y, y + 1]) {
      const target = `${year}-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`;
      const days = V.daysBetween(today, target);
      if (days < 0 || days > (s.leadDays || 21)) continue;
      out.push({ id: s.id, days, text: `${s.label} starts in ${days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's')}. ${s.note}` });
      break;
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------
function kitBlock(kit) {
  const owned = (kit || []).filter((k) => k && k.name);
  if (!owned.length) return '';
  const lines = owned.slice(0, 60).map((k) =>
    `- ${k.name}${k.owned === false ? ' (tried, does not own)' : ''}${k.verdict ? ` — ${k.verdict}` : ''}${k.note ? `: ${k.note}` : ''}`);
  return 'HIS KIT AND WHAT HE THINKS OF IT (match deals and advice to this gear; if something replaces or complements what he owns, say so explicitly):\n' + lines.join('\n') + '\n\n';
}

function ordersBlock(orders) {
  const live = (orders || []).filter((o) => o && o.enabled !== false && o.text);
  if (!live.length) return '';
  return 'STANDING ORDERS (absolute — these override every other instruction below):\n' +
    live.map((o) => '- ' + o.text).join('\n') + '\n\n';
}

function voiceBlock(voice) {
  const samples = ((voice && voice.samples) || []).filter(Boolean).slice(0, 4);
  let out = '';
  if (voice && voice.register) out += 'REGISTER: ' + voice.register + '\n';
  if (samples.length) out += 'WRITING SAMPLES HE LIKES — match this register, rhythm and vocabulary:\n' +
    samples.map((s, i) => `[sample ${i + 1}] ${String(s).slice(0, 900)}`).join('\n') + '\n';
  return out ? out + '\n' : '';
}

export function topicPrompt(section, shared) {
  const lines = [];
  section.items.forEach((p, i) => {
    lines.push(`\n[${i + 1}] (${p.sub}) ${p.title}`);
    if (p.body) lines.push('    post: ' + p.body);
    (p.comments || []).forEach((c) => lines.push('    top comment: ' + c));
  });

  return 'You are writing one section of a personal morning briefing for Mikey, who runs a mobile ' +
    'car-detailing business in Snohomish County, WA.\n\n' +
    shared.contextBlock +
    shared.kitBlock +
    shared.ordersBlock +
    shared.voiceBlock +
    (shared.behavior.length ? 'WHAT HE ACTUALLY BOOKS AND BUYS (derived from his own job and expense records — trust this over anything he says he likes): ' + shared.behavior.join(', ') + '\n\n' : '') +
    `THIS SECTION is "${section.topic.label}". What matters here: ${section.topic.hint}\n` +
    (section.topic.context ? `Extra context for this topic only: ${section.topic.context}\n` : '') +
    (section.playbook ? `\n${section.playbook}\n` : '') +
    '\nTHE MOST IMPORTANT RULE: this email is the whole read, not a table of contents. He should never ' +
    'have to click a link to understand what happened. Retell the actual content — the specifics, the ' +
    'numbers, the argument, what people concluded. If a post compares two products, say which won and by ' +
    'how much. If there is a deal, give the price and the catch. A teaser like "detailers debated ceramic ' +
    'coatings" is a failure; write the substance.\n\n' +
    'HARD RULES ON TRUTH — these are checked automatically after you answer, and anything failing them ' +
    'is deleted before he sees it:\n' +
    '- Every price, percentage, measurement and model number you write MUST appear in the material below. ' +
    'Never round, never convert, never estimate a number that is not there.\n' +
    '- "quote" must be an EXACT sentence copied character-for-character from the material for that item. ' +
    'Not a paraphrase. If you cannot find one, leave the item out entirely.\n' +
    '- Where the material disagrees with itself, do NOT pick a side or average them. Fill "contested" ' +
    'with the two positions in their own terms and leave the body neutral.\n' +
    '- Never invent a fact, a source, a price or a date.\n\n' +
    'FORMAT RULES:\n' +
    '- "ref" is the [n] of the post. Use each at most once.\n' +
    '- "headline" is a plain statement of what happened, under 70 characters, no clickbait.\n' +
    '- "point" is 4 to 7 sentences. Lead with the actual point, not "a user posted that".\n' +
    '- The comments are often more valuable than the post. Where they contradict, debunk, or add a ' +
    'caveat, work that in.\n' +
    '- "entity" is the specific product, tool, model or subject the item is about ("CarPro CQuartz", ' +
    '"Icon 1/2in impact"). Keep it stable across days so it can be tracked.\n' +
    '- "deadline" only if the material states one ("ends Sunday", "through 8/12"). Otherwise "".\n' +
    '- "stakes" is the concrete consequence with a number if the material has one ("saves $30", ' +
    '"$40 off list"). Otherwise "".\n' +
    '- Skip memes, rants, karma-farming and photos with no information. Fewer, meatier items beat ' +
    'padding. Return an empty items list if nothing here was worth his time — that is a valid answer.\n' +
    '- "roundup" is 2-3 sentences on the theme and mood of this section.\n\n' +
    'MATERIAL:\n' + lines.join('\n');
}

export const TOPIC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    roundup: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ref: { type: 'INTEGER' },
          headline: { type: 'STRING' },
          point: { type: 'STRING' },
          quote: { type: 'STRING' },
          entity: { type: 'STRING' },
          deadline: { type: 'STRING' },
          stakes: { type: 'STRING' },
          contested: {
            type: 'OBJECT',
            properties: { claim: { type: 'STRING' }, counter: { type: 'STRING' } },
          },
        },
        required: ['ref', 'point'],
      },
    },
  },
  required: ['roundup', 'items'],
};

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------
/**
 * Builds the whole digest. `dryRun` reads everything and writes nothing — no
 * seen-marking, no ledger, no archive — so preview can be run as often as you
 * like without burning tomorrow's material.
 */
export async function buildDigest(ctx, opts = {}) {
  const now = opts.now || Date.now();
  const cfg = opts.cfg || await loadCfg(ctx);
  const tz = cfg.tz || 'America/Los_Angeles';
  const today = localParts(now, tz).date;
  const diag = [];
  const dry = !!opts.dryRun;
  const fetchOpts = { fetchImpl: ctx.fetchImpl, attempts: opts.attempts || 3, sleep: ctx.sleep };

  // ---- state Mikey owns -------------------------------------------------
  let context = await loadContext(ctx);
  if (cfg.googleDocId) {
    try {
      const text = await readGoogleDoc(ctx, cfg.googleDocId);
      if (text && text.trim().length > 20) { context = { text, updatedAt: now, source: 'gdoc' }; diag.push('ok    context doc pulled from Google Docs'); }
    } catch (err) { diag.push('fail  Google Doc — ' + String(err && err.message || err)); }
  }
  let kit = await loadKit(ctx);
  if (cfg.googleSheetId) {
    try {
      const rows = await readGoogleSheet(ctx, cfg.googleSheetId, cfg.googleSheetRange);
      if (rows.length) { kit = rows; diag.push(`ok    kit sheet — ${rows.length} rows`); }
    } catch (err) { diag.push('fail  kit sheet — ' + String(err && err.message || err)); }
  }
  const orders = await loadOrders(ctx);
  const captures = await loadCapture(ctx);
  const seenList = await getJson(ctx, K.seen, []);
  const seen = {}; for (const id of seenList) seen[id] = true;
  const ledger = await getJson(ctx, K.ledger, {});
  const entities = await getJson(ctx, K.entities, {});
  const absenceTracker = await getJson(ctx, K.absence, {});
  let weights = await getJson(ctx, K.weights, { topics: {}, terms: {}, updatedOn: today });
  weights = V.decayWeights(weights, V.daysBetween(weights.updatedOn || today, today));
  weights.updatedOn = today;

  // ---- business + weather ----------------------------------------------
  const business = cfg.business.enabled === false ? { lines: [], tomorrow: V.addDays(today, 1) } : await gatherBusiness(ctx, cfg, now);
  const behavior = await behaviorTerms(ctx, cfg, now);
  let weather = null;
  try {
    const w = await S.collectWeather(cfg.local.lat, cfg.local.lon, tz, fetchOpts);
    weather = w.weather; diag.push(...w.diagnostics);
  } catch (err) { diag.push('fail  weather — ' + String(err && err.message || err)); }
  const plan = buildPlan(business, weather, cfg);

  // ---- sources ----------------------------------------------------------
  const topics = (cfg.topics || []).filter((t) => t && t.enabled !== false);
  const allSubs = [...new Set(topics.reduce((a, t) => a.concat(t.subs || []), []))];
  const reddit = allSubs.length ? await S.collectReddit(allSubs, Object.assign({ perSub: cfg.perSub }, fetchOpts)) : { bySub: {}, diagnostics: [] };
  diag.push(...reddit.diagnostics);

  const feeds = buildFeedList(cfg);
  const feedRes = feeds.length ? await S.collectFeeds(feeds, Object.assign({ perFeed: 6 }, fetchOpts)) : { byFeed: {}, diagnostics: [] };
  diag.push(...feedRes.diagnostics);

  // ---- candidates -------------------------------------------------------
  const kitTerms = (kit || []).map((k) => String(k.name || '').toLowerCase()).filter((s) => s.length > 2);
  const recentSubjects = new Set(Object.keys(ledger)
    .filter((k) => V.daysBetween(ledger[k].lastOn, today) < cfg.dedupeDays)
    .map((k) => k.split('|')[0]));
  const claimedIds = {};
  const sections = [];
  let blockedTotal = 0;

  for (const topic of topics) {
    let cands = [];
    const lists = (topic.subs || []).map((s) => (reddit.bySub[s] || []));
    for (const f of feeds) if (f.topicId === topic.id) lists.push(feedRes.byFeed[f.id] || []);
    // Interleave the sources inside a topic — straight concatenation let the
    // first subreddit fill every slot and the second never appear at all.
    for (let depth = 0; ; depth++) {
      let added = false;
      for (const list of lists) {
        const p = list[depth];
        if (!p) continue;
        added = true;
        if (!p.id || seen[p.id] || claimedIds[p.id]) continue;
        claimedIds[p.id] = true;
        cands.push(Object.assign({}, p, { topicId: topic.id, rank: depth, comments: p.comments || [] }));
      }
      if (!added || depth > 40) break;
    }

    const filtered = V.applyStandingOrders(cands, orders);
    blockedTotal += filtered.blocked.length;
    cands = filtered.items;

    cands.forEach((c) => {
      // Cheap pre-pass of the told-you-already ledger: penalise a candidate
      // whose subject has been reported recently BEFORE spending a model call
      // on it. The real (numbers-aware) ledger check still runs after writing.
      c.repeat = recentSubjects.has(V.slugify(c.title));
      c.score = V.scoreCandidate(c, { weights, kitTerms, behaviorTerms: behavior });
    });
    cands.sort((a, b) => b.score - a.score);
    const quota = V.diversityQuota(cands, cfg.diversityMax, (c) => c.sub);
    // max:0 means "keep the section configured but send nothing from it today",
    // so it must not fall through to the default.
    const limit = topic.max == null ? 4 : topic.max;
    const items = quota.items.slice(0, limit);
    if (items.length) sections.push({ topic, items });
  }
  if (blockedTotal) diag.push(`ok    standing orders blocked ${blockedTotal} candidate(s)`);

  if (!sections.length) {
    diag.push('FAIL  no candidates from any source');
    return { ok: false, reason: 'no material', diagnostics: diag, cfg, today };
  }

  // ---- comments (round-robin so every topic gets coverage) --------------
  const commentTargets = roundRobin(sections.map((s) => s.items), cfg.commentPosts);
  try {
    const c = await S.attachComments(commentTargets, Object.assign({ perPost: cfg.commentsPerPost }, fetchOpts));
    diag.push(...c.diagnostics);
  } catch (err) { diag.push('fail  comments — ' + String(err && err.message || err)); }

  // ---- summarize --------------------------------------------------------
  const playbookText = safePlaybook(await ctx.loadConfig().catch(() => null));
  const shared = {
    contextBlock: buildContextBlock(context, captures),
    kitBlock: kitBlock(kit),
    ordersBlock: ordersBlock(orders),
    voiceBlock: voiceBlock(cfg.voice),
    behavior,
  };

  const summaries = await Promise.all(sections.map(async (section) => {
    const prompt = topicPrompt(
      Object.assign({}, section, { playbook: section.topic.usePlaybook ? playbookText : '' }), shared);
    try {
      const raw = await ctx.gemini(prompt, { json: true, schema: TOPIC_SCHEMA, maxTokens: 8192, temperature: 0.3 });
      const parsed = JSON.parse(raw);
      return { ok: true, roundup: parsed.roundup || '', items: parsed.items || [] };
    } catch (err) {
      diag.push(`FAIL  summary ${section.topic.label} — ${String(err && err.message || err)}`);
      return { ok: false, roundup: '', items: [] };
    }
  }));

  // ---- verify -----------------------------------------------------------
  const verified = [];
  let strippedCount = 0, quoteFails = 0;
  sections.forEach((section, si) => {
    const sum = summaries[si];
    const used = {};
    for (const raw of (sum.items || [])) {
      const post = section.items[Number(raw.ref) - 1];
      if (!post || used[post.id]) continue;
      const material = [post.title, post.body].concat(post.comments || []).join('\n');

      const guard = V.verbatimGuard(raw.point || '', material);
      if (guard.stripped.length) { strippedCount += guard.stripped.length; diag.push(`cut   unverified number in "${(raw.headline || post.title).slice(0, 48)}" — ${guard.stripped.map((s) => s.tokens.join(',')).join(' ')}`); }
      if (!guard.ok) { diag.push(`drop  "${(raw.headline || post.title).slice(0, 48)}" — too little survived the number check`); continue; }

      const q = V.quoteCheck(raw.quote || '', material);
      if (!q.ok) quoteFails++;

      used[post.id] = true;
      const point = guard.text;
      const item = {
        key: post.id,
        topicId: section.topic.id,
        topicLabel: section.topic.label,
        topicEmoji: section.topic.emoji,
        title: String(raw.headline || post.title).slice(0, 140),
        point,
        quote: q.ok ? V.normText(raw.quote) : '',
        quoteScore: q.score,
        entity: String(raw.entity || '').slice(0, 90) || String(raw.headline || post.title).slice(0, 90),
        deadline: cleanLabel(raw.deadline),
        stakes: cleanLabel(raw.stakes),
        contested: raw.contested && raw.contested.claim && raw.contested.counter
          ? { claim: String(raw.contested.claim).slice(0, 300), counter: String(raw.contested.counter).slice(0, 300) } : null,
        url: post.url,
        source: post.sub,
        sourceLabel: /^[a-z0-9_]+$/i.test(post.sub) && post.feedId == null ? 'r/' + post.sub : post.sub,
        score: post.score || 0,
        rank: post.rank || 0,
        roundup: sum.roundup,
      };
      verified.push(item);
    }
  });
  if (strippedCount) diag.push(`ok    verbatim guard stripped ${strippedCount} sentence(s)`);
  if (quoteFails) diag.push(`ok    ${quoteFails} item(s) lost an unverifiable quote`);

  if (!verified.length) {
    diag.push('FAIL  nothing survived verification');
    return { ok: false, reason: 'nothing verified', diagnostics: diag, cfg, today };
  }

  // ---- ledger: fresh / changed / already-told ---------------------------
  const split = V.applyLedger(verified, ledger, { today, cooloffDays: cfg.dedupeDays });
  if (split.repeat.length) diag.push(`ok    suppressed ${split.repeat.length} item(s) already reported`);
  let live = split.fresh.concat(split.changed.map((it) => Object.assign({}, it, {
    changedNote: it.wasNumbers && it.wasNumbers.length
      ? `Changed since ${it.priorOn}` : 'Updated since last time',
  })));

  // ---- price history + story continuity ---------------------------------
  for (const it of live) {
    const ent = entities[V.subjectKey(it)];
    const price = V.lowestMoney(it.point + ' ' + it.title);
    if (price != null && ent) {
      const verdict = V.priceVerdict(ent, price, today);
      if (verdict && verdict.kind !== 'first') it.priceNote = verdict.text;
    }
    const label = V.storyLabel(ent);
    if (label) it.story = label;
  }

  // ---- absence detection ------------------------------------------------
  const allMaterial = sections.map((s) => s.items.map((p) => `${p.title} ${p.body} ${(p.comments || []).join(' ')}`).join('\n')).join('\n').toLowerCase();
  const hitIds = (cfg.signals || []).filter((sig) => {
    if (!sig || !sig.pattern) return false;
    try { return new RegExp(sig.pattern, 'i').test(allMaterial); } catch { return allMaterial.includes(String(sig.pattern).toLowerCase()); }
  }).map((s) => s.id);
  const absence = V.detectAbsence(cfg.signals, absenceTracker, hitIds, today);
  if (absence.flags.length) diag.push(`ok    absence: ${absence.flags.map((f) => f.id).join(', ')}`);

  // ---- editorial pass: the model whose only job is deleting --------------
  let headline = '';
  let subhead = '';
  if (cfg.editorialPass && live.length > 1) {
    try {
      const res = await editorialCut(ctx, live, { cfg, context, business });
      if (res.applied) {
        const keepSet = new Set(res.keep);
        const cutList = live.filter((it) => !keepSet.has(it.key));
        for (const c of cutList) diag.push(`cut   editorial dropped "${c.title.slice(0, 48)}" — ${res.why[c.key] || 'wouldn\'t change a decision'}`);
        live = live.filter((it) => keepSet.has(it.key));
      }
      headline = res.headline || '';
      subhead = res.subhead || '';
      if (res.heroKey) live.forEach((it) => { if (it.key === res.heroKey) it.heroPick = true; });
    } catch (err) { diag.push('fail  editorial pass — ' + String(err && err.message || err)); }
  }

  // ---- rank, cap, split -------------------------------------------------
  const topicOrder = {}; (cfg.topics || []).forEach((t, i) => { topicOrder[t.id] = i; });
  live.forEach((it) => {
    it.rankScore = (it.heroPick ? 1000 : 0)
      + (it.changedNote ? 40 : 0)
      + (it.deadline ? 35 : 0)
      + (it.stakes ? 20 : 0)
      + (it.quote ? 10 : 0)
      + V.weightFor(weights, 'topics', it.topicId) * 30
      - (it.rank || 0) * 3;
  });
  live.sort((a, b) => b.rankScore - a.rankScore);
  if (live.length > cfg.maxItems) {
    diag.push(`ok    length cap dropped ${live.length - cfg.maxItems} item(s)`);
    live = live.slice(0, cfg.maxItems);
  }

  const hero = live[0] || null;
  const rest = live.slice(1);
  const deals = rest.filter((it) => it.deadline).sort((a, b) => deadlineRank(a.deadline) - deadlineRank(b.deadline));
  const dealKeys = new Set(deals.map((d) => d.key));
  const briefItems = rest.filter((it) => !dealKeys.has(it.key));

  const briefs = [];
  for (const t of (cfg.topics || [])) {
    const items = briefItems.filter((it) => it.topicId === t.id);
    if (items.length) briefs.push({ id: t.id, label: t.label, emoji: t.emoji, items });
  }

  // ---- skill, question, seasonal ----------------------------------------
  const state = await getJson(ctx, K.state, {});
  const skill = pickSkill(cfg, state);
  const seasonal = seasonalNotices(cfg.seasons, today);
  const question = cfg.questions.enabled === false ? '' : await pickQuestion(ctx, cfg, state, { context, live, business, diag });

  // ---- headline fallback -------------------------------------------------
  if (!headline) headline = hero ? hero.title : 'Nothing from the internet today — your numbers are below.';

  // ---- assemble + render -------------------------------------------------
  const id = opts.id || nextDigestId(today, await getJson(ctx, K.index, []));
  const doc = {
    id, date: today, dateLabel: dateLabel(today), builtAt: now,
    headline, subhead,
    business, plan, hero, deals, briefs,
    absence: absence.flags,
    seasonal,
    skill,
    question,
    skim: cfg.skim === false ? [] : buildSkim(hero, deals, briefs),
    audioMin: cfg.audioMinutes || 4,
    weather: weather ? { day: (weather.days || {})[business.tomorrow] || null } : null,
    itemKeys: live.map((it) => it.key),
  };

  // Pass actionUrl:false to render a copy with no tap targets (preview, archive
  // re-render); leaving it unset mints real signed links.
  let actionUrl = opts.actionUrl;
  if (actionUrl === undefined) {
    try { actionUrl = await actionUrlFactory(ctx, id, live); }
    catch (err) { diag.push('fail  action links — ' + String(err && err.message || err)); actionUrl = null; }
  }
  if (!actionUrl) actionUrl = null;
  const rendered = renderDigest(doc, {
    emojiHeaders: cfg.emojiHeaders !== false,
    baseUrl: ctx.publicBase(),
    actionUrl,
  });
  doc.readingMin = rendered.readingMin;
  doc.words = rendered.wordCount;

  let audio = rendered.audioScript;
  if (cfg.audio !== false) {
    try {
      const spoken = await speakableRewrite(ctx, audio.script, cfg);
      if (spoken) audio = { script: spoken, words: spoken.split(/\s+/).length, minutes: Math.max(1, Math.round(spoken.split(/\s+/).length / 155)) };
    } catch (err) { diag.push('fail  audio rewrite — ' + String(err && err.message || err)); }
  }

  return {
    ok: true,
    id, today, cfg, doc,
    subject: `☕ ${truncate(headline, 90)}`,
    html: rendered.html,
    text: rendered.text,
    audio,
    diagnostics: diag,
    // Everything the caller must persist if (and only if) it actually sends.
    commit: {
      seen: seenList.concat(live.map((it) => it.key)).slice(-SEEN_LIMIT),
      ledger: V.recordLedger(ledger, live, today),
      entities: V.updateEntities(entities, live, today),
      absence: absence.tracker,
      weights,
      skillIndex: skill ? (state.skillIndex || 0) + 1 : (state.skillIndex || 0),
      capturesConsumed: captures,
    },
    dry,
  };
}

function cleanLabel(s) {
  const t = V.normText(s || '').replace(/^["'\s]+|["'\s]+$/g, '');
  if (!t || /^(none|n\/?a|null|unknown|-)$/i.test(t)) return '';
  return t.slice(0, 60);
}

function truncate(s, n) {
  const t = String(s || '').trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/[\s,;:.]+$/, '') + '…';
}

function roundRobin(lists, budget) {
  const out = [];
  for (let depth = 0; out.length < budget; depth++) {
    let added = false;
    for (const list of lists) {
      if (out.length >= budget) break;
      const p = list[depth];
      if (!p) continue;
      out.push(p); added = true;
    }
    if (!added) break;
  }
  return out;
}

/** Deals sort by how soon they die, not by how loud they are. */
export function deadlineRank(label) {
  const s = String(label || '').toLowerCase();
  if (/today|tonight|hours|ends now/.test(s)) return 0;
  if (/tomorrow/.test(s)) return 1;
  const dows = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < dows.length; i++) if (s.includes(dows[i])) return 2 + i;
  const m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) return 20 + (+m[1]) * 31 + (+m[2]);
  if (/this week|week/.test(s)) return 10;
  if (/month/.test(s)) return 15;
  return 500;
}

function buildSkim(hero, deals, briefs) {
  const lines = [];
  const one = (it) => ({ topic: it.topicLabel, text: firstSentence(it.point) });
  if (hero) lines.push(one(hero));
  for (const d of deals) lines.push({ topic: d.topicLabel, text: `${firstSentence(d.point)}${d.deadline ? ` (${d.deadline})` : ''}` });
  for (const g of briefs) for (const it of g.items) lines.push(one(it));
  return lines;
}

function firstSentence(text) {
  const m = String(text || '').match(/^[^.!?]+[.!?]/);
  return (m ? m[0] : String(text || '').slice(0, 160)).trim();
}

function buildContextBlock(context, captures) {
  let out = 'WHO HE IS AND WHAT HE CARES ABOUT (his own words, re-read fresh every morning — this is ' +
    'the source of truth about him):\n' + String(context.text || '').slice(0, 12000) + '\n\n';
  const pending = (captures || []).slice(0, 20);
  if (pending.length) {
    out += 'NOTES HE CAPTURED SINCE THE LAST DIGEST (treat as fresh, high-priority context):\n' +
      pending.map((c) => '- ' + c.text).join('\n') + '\n\n';
  }
  return out;
}

function safePlaybook(cfg) {
  const p = (cfg && cfg.playbook) || {};
  const bits = [];
  if (p.services) bits.push('HIS SERVICE LIST AND PRICES:\n' + String(p.services).slice(0, 2000));
  if (p.area) bits.push('SERVICE AREA:\n' + String(p.area).slice(0, 600));
  return bits.join('\n\n');
}

function buildFeedList(cfg) {
  const feeds = [];
  const loc = cfg.local || {};
  const days = loc.newsDays || 7;
  for (const q of (loc.queries || [])) {
    feeds.push({ id: 'news-' + V.slugify(q), label: q, url: S.newsFeedUrl(q, { days }), source: 'local news', topicId: 'local' });
  }
  for (const q of (loc.competitors || [])) {
    feeds.push({ id: 'comp-' + V.slugify(q), label: 'competitor: ' + q, url: S.newsFeedUrl(q, { days: days * 4 }), source: 'competitor watch', topicId: 'local' });
  }
  for (const t of (cfg.topics || [])) {
    for (const f of (t.feeds || [])) {
      if (!f || !f.url) continue;
      feeds.push({ id: f.id || 'feed-' + V.slugify(f.url), label: f.label || f.url, url: f.url, source: f.source || f.label || 'web', topicId: t.id });
    }
  }
  return feeds;
}

function nextDigestId(today, index) {
  const sameDay = (index || []).filter((e) => String(e.id || '').startsWith(today)).length;
  return sameDay ? `${today}-${sameDay + 1}` : today;
}

function pickSkill(cfg, state) {
  if (!cfg.skills || cfg.skills.enabled === false) return null;
  const list = cfg.skills.list || [];
  if (!list.length) return null;
  const i = ((state.skillIndex == null ? (cfg.skills.index || 0) : state.skillIndex) % list.length + list.length) % list.length;
  const s = list[i];
  return { title: s.title, body: s.body, n: `${i + 1} of ${list.length}` };
}

// ---------------------------------------------------------------------------
// Model calls: editorial cut, question, audio rewrite
// ---------------------------------------------------------------------------
const CUT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    keep: { type: 'ARRAY', items: { type: 'STRING' } },
    cut: { type: 'ARRAY', items: { type: 'OBJECT', properties: { key: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['key'] } },
    heroKey: { type: 'STRING' },
    headline: { type: 'STRING' },
    subhead: { type: 'STRING' },
  },
  required: ['keep', 'headline'],
};

/**
 * The second model call. Its only job is to delete — a writer asked to also
 * summarize will always find a reason to keep everything it wrote.
 */
export async function editorialCut(ctx, items, { cfg, context, business }) {
  const list = items.map((it) => `KEY ${it.key}\nTOPIC ${it.topicLabel}\nTITLE ${it.title}\n${it.point}`).join('\n\n---\n\n');
  const prompt =
    'You are the editor of a one-person morning briefing, and your ONLY job is to delete. You do not ' +
    'rewrite and you do not add. The writer is paid by the word; you are paid by the minute of the ' +
    'reader\'s time you give back.\n\n' +
    'The reader is Mikey, who runs a mobile car-detailing business in Snohomish County, WA.\n\n' +
    'ABOUT HIM:\n' + String(context.text || '').slice(0, 4000) + '\n\n' +
    (business && business.lines && business.lines.length
      ? 'WHAT IS ALREADY DEMANDING HIS ATTENTION TODAY:\n' + business.lines.map((l) => '- ' + l.text).join('\n') + '\n\n' : '') +
    'THE TEST, applied to every item: would reading this change a decision he makes in the next seven ' +
    'days — something he buys, charges, schedules, says to a customer, or stops doing? If it is merely ' +
    'interesting, cut it. If it is a thing he already knows, cut it. If it is industry news with no ' +
    'action behind it, cut it. Being entertaining is not a reason to keep something, with one exception: ' +
    'you may keep at most ONE purely fun item.\n\n' +
    `Keep at most ${cfg.maxItems} items, and keeping fewer is better than keeping more. Keeping ZERO is ` +
    'allowed and is the right answer on a slow day.\n\n' +
    'Then: pick "heroKey" — the single item that most deserves his full attention. Write "headline": one ' +
    'concrete sentence naming the most useful thing in here, no hype, no "here is your briefing". Write ' +
    '"subhead": one short line on what the rest of it adds up to.\n\n' +
    'Return the KEY strings exactly as given. For each cut item give a one-clause reason.\n\n' +
    'ITEMS:\n\n' + list;

  const raw = await ctx.gemini(prompt, { json: true, schema: CUT_SCHEMA, maxTokens: 2048, temperature: 0.2 });
  const parsed = JSON.parse(raw);
  const why = {};
  for (const c of (parsed.cut || [])) if (c && c.key) why[c.key] = c.why || '';
  const valid = new Set(items.map((i) => i.key));
  const keep = (Array.isArray(parsed.keep) ? parsed.keep : []).filter((k) => valid.has(k));
  const cutKeys = (parsed.cut || []).map((c) => c && c.key).filter((k) => valid.has(k));
  return {
    // "Cut everything" is a legitimate verdict and has to be obeyed — but a
    // response whose keys match nothing we sent is a broken answer, not an
    // instruction to empty the digest, so it's ignored instead.
    applied: Array.isArray(parsed.keep) && (keep.length > 0 || cutKeys.length > 0),
    keep,
    why,
    heroKey: valid.has(parsed.heroKey) ? parsed.heroKey : '',
    headline: String(parsed.headline || '').slice(0, 180),
    subhead: String(parsed.subhead || '').slice(0, 200),
  };
}

async function pickQuestion(ctx, cfg, state, { context, live, business, diag }) {
  const asked = state.askedQuestions || [];
  try {
    const prompt =
      'Here is everything a morning briefing knows about its reader, Mikey (mobile car detailing, ' +
      'Snohomish County WA):\n\n' + String(context.text || '').slice(0, 4000) + '\n\n' +
      (live.length ? 'Today it is telling him about: ' + live.map((i) => i.title).join('; ') + '\n\n' : '') +
      (business && business.lines && business.lines.length ? 'His numbers say: ' + business.lines.map((l) => l.text).join(' ') + '\n\n' : '') +
      'Ask him ONE question whose answer would make tomorrow\'s briefing meaningfully better — something ' +
      'the context above does not already answer. Concrete, answerable in one text message, about his ' +
      'actual work or preferences. Not philosophical, not a survey question, no preamble.\n' +
      (asked.length ? 'Do NOT repeat any of these already-asked questions: ' + asked.slice(-20).join(' | ') + '\n' : '') +
      'Reply with JSON: {"question":"..."}';
    const raw = await ctx.gemini(prompt, { json: true, maxTokens: 256, temperature: 0.8,
      schema: { type: 'OBJECT', properties: { question: { type: 'STRING' } }, required: ['question'] } });
    const q = String(JSON.parse(raw).question || '').trim();
    if (q.length > 8) return q.slice(0, 240);
  } catch (err) { if (diag) diag.push('fail  question — ' + String(err && err.message || err)); }
  const list = cfg.questions.list || [];
  if (!list.length) return '';
  return list[((state.questionIndex || 0) % list.length + list.length) % list.length];
}

async function speakableRewrite(ctx, script, cfg) {
  const prompt =
    'Rewrite this morning briefing as something spoken aloud to one person driving to their first job. ' +
    'Keep every fact and every number exactly as written — do not add, drop or change a single figure. ' +
    'Remove anything that only works on a page: bullets, headings, URLs, "r slash", parentheticals. ' +
    'Use short sentences and natural spoken connectives. Do not add a sign-off beyond what is there. ' +
    'Aim for about ' + Math.round((cfg.audioMinutes || 4) * 155) + ' words. Return only the script text.\n\n' + script;
  const out = await ctx.gemini(prompt, { maxTokens: 2048, temperature: 0.4 });
  const t = String(out || '').trim();
  return t.length > 200 ? t : '';
}

// ---------------------------------------------------------------------------
// Send + persist
// ---------------------------------------------------------------------------
export async function sendDigest(ctx, built, opts = {}) {
  const cfg = built.cfg;
  const to = cfg.to || ctx.env.ALERT_EMAIL || '';
  let delivered = false, error = '';
  try {
    await ctx.sendMail({ subject: built.subject, text: built.text, html: built.html, to });
    delivered = true;
  } catch (err) {
    error = String(err && err.message || err);
    // Email is the medium this thing lives in; a text saying "it's on the web"
    // beats silence, but never the whole digest by SMS.
    try { await ctx.notify('☕ Morning rundown (email failed)', `${built.doc.headline}\n\nRead it: ${ctx.publicBase()}/digest.html?id=${built.id}`); } catch { /* nothing left to try */ }
  }

  await persistDigest(ctx, built, { delivered, error, ...opts });
  return { delivered, error };
}

export async function persistDigest(ctx, built, meta = {}) {
  const c = built.commit;
  const doc = Object.assign({}, built.doc, {
    html: built.html, text: built.text,
    audio: built.audio, diagnostics: built.diagnostics,
    delivered: !!meta.delivered, deliveryError: meta.error || '',
  });
  await putJson(ctx, K.doc(built.id), doc);

  const index = await getJson(ctx, K.index, []);
  index.unshift({
    id: built.id, date: built.doc.date, dateLabel: built.doc.dateLabel,
    headline: built.doc.headline, readingMin: built.doc.readingMin || 0,
    items: (built.doc.itemKeys || []).length,
    topics: (built.doc.briefs || []).map((b) => b.id),
    // The search index is a flat text blob — with an archive this size, scanning
    // it in the Worker is faster and simpler than maintaining a real index.
    q: searchBlob(built.doc),
    at: built.doc.builtAt,
  });
  if (index.length > ARCHIVE_LIMIT) {
    for (const gone of index.splice(ARCHIVE_LIMIT)) { try { await ctx.kv.delete(K.doc(gone.id)); } catch { /* best effort */ } }
  }
  await putJson(ctx, K.index, index);

  await putJson(ctx, K.seen, c.seen);
  await putJson(ctx, K.ledger, c.ledger);
  await putJson(ctx, K.entities, c.entities);
  await putJson(ctx, K.absence, c.absence);
  await putJson(ctx, K.weights, c.weights);

  const state = await getJson(ctx, K.state, {});
  state.lastSentOn = built.today;
  state.lastId = built.id;
  state.lastAt = Date.now();
  state.skillIndex = c.skillIndex;
  state.questionIndex = (state.questionIndex || 0) + 1;
  if (built.doc.question) {
    state.pendingQuestion = built.doc.question;
    state.pendingQuestionAt = Date.now();
    state.askedQuestions = (state.askedQuestions || []).concat([built.doc.question]).slice(-40);
  }
  await putJson(ctx, K.state, state);

  // Captures folded into the context doc become permanent; the inbox empties so
  // the same note never shows up two mornings running.
  if (built.cfg.captureAutoAppend !== false && (c.capturesConsumed || []).length) {
    await appendContext(ctx, 'Captured notes', c.capturesConsumed.map((x) => '- ' + x.text).join('\n'), built.today);
    await putJson(ctx, K.capture, []);
  }
}

/**
 * The searchable text for one issue, kept deliberately small. The whole archive
 * index is one KV value that every search reads, so a fat blob per issue turns
 * "what was that polish last month?" into a megabyte-scale read. Titles,
 * entities, sources and quotes are what people actually search by; the body only
 * contributes its opening.
 */
function searchBlob(doc) {
  const bits = [doc.headline, doc.subhead];
  const push = (it) => { if (it) bits.push(it.title, it.entity, it.source, it.quote, String(it.point || '').slice(0, 260)); };
  push(doc.hero);
  for (const d of (doc.deals || [])) push(d);
  for (const g of (doc.briefs || [])) for (const it of g.items) push(it);
  for (const s of (doc.seasonal || [])) bits.push(s.text);
  if (doc.skill) bits.push(doc.skill.title);
  return bits.filter(Boolean).join(' • ').slice(0, 4000).toLowerCase();
}

// ---------------------------------------------------------------------------
// Feedback: one-tap actions, thumbs, plain-English retune
// ---------------------------------------------------------------------------
// Every tap is training data. That's the reason the buttons live in the email
// rather than only in the app: the moment he decides "not for me" is the moment
// he's reading it, and any friction between those two things loses the signal.

export const ACTIONS = ['buy', 'reject', 'remind', 'up', 'down', 'save'];

const ACTION_WEIGHT = { buy: 0.45, save: 0.25, up: 0.35, reject: -0.4, down: -0.35, remind: 0.15 };

export async function recordFeedback(ctx, { digestId, itemKey, action, topicId, entity, note }) {
  if (!ACTIONS.includes(action)) return { ok: false, error: 'bad_action' };
  const now = Date.now();
  const cfg = await loadCfg(ctx);
  const today = localParts(now, cfg.tz).date;

  const weights = await getJson(ctx, K.weights, { topics: {}, terms: {}, updatedOn: today });
  const delta = ACTION_WEIGHT[action] || 0;
  if (topicId) V.bumpWeight(weights, 'topics', topicId, delta);
  // Entity terms move at half strength: disliking one impact wrench shouldn't
  // bury the whole idea of impact wrenches.
  for (const term of entityTerms(entity)) V.bumpWeight(weights, 'terms', term, delta / 2);
  weights.updatedOn = today;
  await putJson(ctx, K.weights, weights);

  const log = await getJson(ctx, K.feedback, []);
  log.unshift({ id: 'f' + now.toString(36), at: now, on: today, digestId, itemKey, action, topicId, entity: entity || '', note: note || '' });
  if (log.length > FEEDBACK_LIMIT) log.length = FEEDBACK_LIMIT;
  await putJson(ctx, K.feedback, log);

  let extra = null;
  if (action === 'remind') extra = await scheduleReminder(ctx, { entity, itemKey, digestId, now, cfg });
  if (action === 'reject') {
    // A rejection is also a standing-order candidate — three of them on the same
    // subject is Mikey telling you something in the only vocabulary he has time
    // for. Recorded, not auto-applied: silent rules are how a digest goes weird.
    const rejects = log.filter((f) => f.action === 'reject' && f.entity && V.slugify(f.entity) === V.slugify(entity || ''));
    if (rejects.length >= 3) extra = { suggestOrder: `Stop showing me ${entity}` };
  }
  return { ok: true, weights: { topic: V.weightFor(weights, 'topics', topicId) }, extra };
}

function entityTerms(entity) {
  return String(entity || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 4);
}

/** "Remind me Friday" — next Friday, 8am local, delivered by the minute cron. */
export async function scheduleReminder(ctx, { entity, itemKey, digestId, now, cfg }) {
  const tz = cfg.tz || 'America/Los_Angeles';
  const p = localParts(now, tz);
  let daysAhead = (5 - p.dow + 7) % 7;      // 5 = Friday
  if (daysAhead === 0) daysAhead = 7;
  const on = V.addDays(p.date, daysAhead);
  const state = await getJson(ctx, K.state, {});
  state.reminders = (state.reminders || []).filter((r) => r.itemKey !== itemKey);
  state.reminders.push({ on, hour: 8, itemKey, digestId, text: entity || 'the thing you flagged', at: now });
  if (state.reminders.length > 40) state.reminders = state.reminders.slice(-40);
  await putJson(ctx, K.state, state);
  return { remindOn: on };
}

const RETUNE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    topics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, delta: { type: 'NUMBER' } }, required: ['id', 'delta'] } },
    terms: { type: 'ARRAY', items: { type: 'OBJECT', properties: { term: { type: 'STRING' }, delta: { type: 'NUMBER' } }, required: ['term', 'delta'] } },
    order: { type: 'STRING' },
    never: { type: 'ARRAY', items: { type: 'STRING' } },
    reply: { type: 'STRING' },
  },
  required: ['reply'],
};

/**
 * "less Overwatch, more coatings" — parsed into weight moves, and, when it reads
 * like a rule rather than a preference, into a standing order.
 */
export async function retune(ctx, text) {
  const cfg = await loadCfg(ctx);
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };
  const today = localParts(Date.now(), cfg.tz).date;
  const topicList = (cfg.topics || []).map((t) => `${t.id} = ${t.label}`).join('; ');

  let parsed = null;
  try {
    const raw = await ctx.gemini(
      'Mikey just replied to his morning briefing to change what it sends him. Turn his words into ' +
      'adjustments.\n\nTOPIC IDS: ' + topicList + '\n\n' +
      'Rules:\n- "delta" is between -1 and 1. "less X" is about -0.4, "a lot less"/"stop" is -0.9, ' +
      '"more X" is +0.4, "way more" is +0.9.\n' +
      '- Use "terms" for subjects that are not whole topics (a product, a brand, a technique).\n' +
      '- Only fill "order" if he stated a permanent RULE ("never show me anything needing a compressor"). ' +
      'Then "never" is the literal phrases to filter on, lowercase. Otherwise leave both empty.\n' +
      '- "reply" is one short sentence confirming what you changed, in plain language.\n\n' +
      'HIS MESSAGE: ' + body.slice(0, 1200),
      { json: true, schema: RETUNE_SCHEMA, maxTokens: 600, temperature: 0.2 });
    parsed = JSON.parse(raw);
  } catch (err) {
    parsed = heuristicRetune(body, cfg);
    if (!parsed) return { ok: false, error: 'could not read that: ' + String(err && err.message || err) };
  }

  const weights = await getJson(ctx, K.weights, { topics: {}, terms: {}, updatedOn: today });
  const changed = [];
  for (const t of (parsed.topics || [])) {
    if (!(cfg.topics || []).some((x) => x.id === t.id)) continue;
    V.bumpWeight(weights, 'topics', t.id, clampDelta(t.delta));
    changed.push(`${t.id} ${t.delta > 0 ? '↑' : '↓'}`);
  }
  for (const t of (parsed.terms || [])) {
    const term = String(t.term || '').toLowerCase().trim();
    if (term.length < 3) continue;
    V.bumpWeight(weights, 'terms', term, clampDelta(t.delta));
    changed.push(`"${term}" ${t.delta > 0 ? '↑' : '↓'}`);
  }
  weights.updatedOn = today;
  await putJson(ctx, K.weights, weights);

  let order = null;
  if (parsed.order && String(parsed.order).trim()) {
    const orders = await loadOrders(ctx);
    order = {
      id: 'o' + Date.now().toString(36),
      text: String(parsed.order).slice(0, 240),
      never: (parsed.never || []).map((s) => String(s).toLowerCase().slice(0, 60)).filter(Boolean).slice(0, 12),
      enabled: true, addedOn: today, source: 'reply',
    };
    orders.unshift(order);
    await putJson(ctx, K.orders, orders.slice(0, 60));
    changed.push('added standing order');
  }

  return { ok: true, reply: parsed.reply || 'Got it.', changed, order };
}

function clampDelta(d) { return Math.max(-1, Math.min(1, Number(d) || 0)); }

/** No-Gemini fallback so "less overwatch" still works when the key is missing. */
function heuristicRetune(body, cfg) {
  const s = body.toLowerCase();
  const topics = [];
  for (const t of (cfg.topics || [])) {
    const name = t.label.toLowerCase().split(/[&,]/)[0].trim();
    const words = [t.id, name].concat(name.split(/\s+/).filter((w) => w.length > 4));
    for (const w of words) {
      if (!w || !s.includes(w)) continue;
      const before = s.slice(Math.max(0, s.indexOf(w) - 24), s.indexOf(w));
      if (/less|fewer|stop|no more|drop/.test(before)) { topics.push({ id: t.id, delta: -0.4 }); break; }
      if (/more|extra/.test(before)) { topics.push({ id: t.id, delta: 0.4 }); break; }
    }
  }
  if (!topics.length) return null;
  return { topics, terms: [], reply: 'Adjusted: ' + topics.map((t) => `${t.id} ${t.delta > 0 ? 'up' : 'down'}`).join(', ') + '.' };
}

// ---------------------------------------------------------------------------
// Breaking interrupt
// ---------------------------------------------------------------------------
// A 40%-off coupon that expires at midnight is worthless at 7am tomorrow. This
// runs hourly, looks only at the topics flagged as interrupt-worthy, and is
// deliberately hard to trigger — an interrupt that fires twice a day is just a
// digest with worse timing.
export async function checkBreaking(ctx, now) {
  const cfg = await loadCfg(ctx);
  if (!cfg.enabled || !cfg.breaking || cfg.breaking.enabled === false) return { fired: 0, reason: 'disabled' };
  const tz = cfg.tz || 'America/Los_Angeles';
  const p = localParts(now, tz);
  const qs = cfg.breaking.quietStart == null ? 21 : cfg.breaking.quietStart;
  const qe = cfg.breaking.quietEnd == null ? 6 : cfg.breaking.quietEnd;
  const quiet = qs > qe ? (p.hour >= qs || p.hour < qe) : (p.hour >= qs && p.hour < qe);
  if (quiet) return { fired: 0, reason: 'quiet hours' };
  if (p.hour === cfg.hour || p.hour === cfg.hour + 1) return { fired: 0, reason: 'digest window' };

  const state = await getJson(ctx, K.state, {});
  const firedToday = (state.breakingOn === p.date) ? (state.breakingCount || 0) : 0;
  if (firedToday >= (cfg.breaking.maxPerDay || 2)) return { fired: 0, reason: 'daily cap' };

  const topics = (cfg.topics || []).filter((t) => t.enabled !== false && t.breaking);
  const subs = [...new Set(topics.reduce((a, t) => a.concat(t.subs || []), []))];
  if (!subs.length) return { fired: 0, reason: 'no breaking topics' };

  const seenList = await getJson(ctx, K.seen, []);
  const seen = new Set(seenList);
  const alerted = new Set(state.breakingIds || []);
  const res = await S.collectReddit(subs, { perSub: 6, attempts: 2, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep });

  const triggers = (cfg.breaking.triggers || []).map((t) => String(t).toLowerCase());
  const orders = await loadOrders(ctx);
  const hits = [];
  for (const t of topics) {
    for (const sub of (t.subs || [])) {
      for (const post of (res.bySub[sub] || [])) {
        if (!post.id || seen.has(post.id) || alerted.has(post.id)) continue;
        const hay = `${post.title} ${post.body}`.toLowerCase();
        const trig = triggers.find((x) => hay.includes(x));
        const pct = biggestPercent(hay);
        const bigDiscount = pct >= (cfg.breaking.minDiscount || 30);
        if (!trig && !bigDiscount) continue;
        // Fresh only — a 3-day-old thread is not breaking anything.
        if (post.ts && now - post.ts > 14 * 3600000) continue;
        hits.push({ post, topic: t, why: bigDiscount ? `${pct}% off` : trig });
      }
    }
  }
  if (!hits.length) return { fired: 0, reason: 'nothing urgent' };

  const filtered = V.applyStandingOrders(hits.map((h) => Object.assign({}, h.post, { _h: h })), orders).items;
  if (!filtered.length) return { fired: 0, reason: 'blocked by standing orders' };

  const room = (cfg.breaking.maxPerDay || 2) - firedToday;
  const send = filtered.slice(0, room).map((x) => x._h);
  const lines = send.map((h) => `• [${h.topic.label}] ${h.post.title}\n  ${V.normText(h.post.body).slice(0, 300)}\n  ${h.post.url}`);
  await ctx.notify(`⚡ ${send.length === 1 ? send[0].post.title.slice(0, 70) : send.length + ' things that will not wait'}`,
    `This didn't wait for 7am (${send.map((h) => h.why).join(', ')}):\n\n${lines.join('\n\n')}\n\nEverything else is in the morning rundown.`);

  state.breakingOn = p.date;
  state.breakingCount = firedToday + send.length;
  state.breakingIds = (state.breakingIds || []).concat(send.map((h) => h.post.id)).slice(-60);
  state.breakingLastAt = now;
  await putJson(ctx, K.state, state);
  return { fired: send.length, items: send.map((h) => h.post.title) };
}

function biggestPercent(text) {
  let best = 0;
  const re = /(\d{1,3})\s?%\s?(?:off|discount)/g;
  for (let m; (m = re.exec(text));) best = Math.max(best, +m[1]);
  return best;
}

// ---------------------------------------------------------------------------
// Weekly rollup
// ---------------------------------------------------------------------------
export async function weeklyRollup(ctx, now) {
  const cfg = await loadCfg(ctx);
  const tz = cfg.tz || 'America/Los_Angeles';
  const today = localParts(now, tz).date;
  const since = V.addDays(today, -7);

  const index = (await getJson(ctx, K.index, [])).filter((e) => e.date >= since);
  const feedback = (await getJson(ctx, K.feedback, [])).filter((f) => f.on >= since);
  const weights = await getJson(ctx, K.weights, { topics: {}, terms: {} });

  const acted = feedback.filter((f) => f.action === 'buy' || f.action === 'save' || f.action === 'remind');
  const rejected = feedback.filter((f) => f.action === 'reject' || f.action === 'down');
  const readMin = index.reduce((s, e) => s + (e.readingMin || 0), 0);
  const itemCount = index.reduce((s, e) => s + (e.items || 0), 0);

  let money = null;
  try {
    const doc = await ctx.loadMonth(today.slice(0, 7));
    const w = ctx.weekWindow(today);
    money = ctx.summarizeWeek((doc && doc.entries) || [], w.start, w.end);
  } catch { /* money is a bonus here */ }

  const L = [];
  L.push(`Last 7 days of the morning rundown — ${index.length} issue${index.length === 1 ? '' : 's'}, ${itemCount} items, about ${readMin} minutes of reading.`);
  L.push('');
  L.push('WHAT MATTERED');
  const heads = index.slice(0, 7).map((e) => `• ${e.dateLabel}: ${e.headline}`);
  L.push(heads.length ? heads.join('\n') : '• Nothing sent this week.');
  L.push('');
  L.push('WHAT YOU ACTED ON');
  L.push(acted.length
    ? acted.map((f) => `• ${f.action === 'buy' ? 'Buying' : f.action === 'remind' ? 'Reminder set for' : 'Saved'}: ${f.entity || f.itemKey}`).join('\n')
    : '• Nothing tapped. If nothing was worth a tap, tell it so — reply "less of everything" and it will cut harder.');
  L.push('');
  L.push('WHAT IT STOPPED SHOWING YOU');
  L.push(rejected.length ? rejected.map((f) => `• ${f.entity || f.topicId}`).join('\n') : '• Nothing rejected.');
  const tuned = Object.keys(weights.topics || {}).map((k) => `${k} ×${weights.topics[k]}`);
  if (tuned.length) { L.push(''); L.push('CURRENT TOPIC WEIGHTS'); L.push('• ' + tuned.join(' · ')); }
  if (money) {
    L.push('');
    L.push('AND THE ACTUAL SCOREBOARD');
    L.push(`• Gross $${V.fmtMoney(money.gross)} · net $${V.fmtMoney(money.net)} · ${money.jobs} job${money.jobs === 1 ? '' : 's'} this week.`);
  }
  L.push('');
  L.push(`Archive: ${ctx.publicBase()}/digest.html`);

  await ctx.notify('📊 Your week in the rundown', L.join('\n'));
  const state = await getJson(ctx, K.state, {});
  state.weeklyOn = today;
  await putJson(ctx, K.state, state);
  return { ok: true, issues: index.length, acted: acted.length };
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
/**
 * Called once a minute by the Worker's scheduled handler. Everything here is
 * read-only until something actually has to happen — see the KV budget note at
 * the top of this file and the banner in src/index.js.
 */
export async function digestCron(ctx, now = Date.now()) {
  const cfg = await loadCfg(ctx);
  if (!cfg.enabled) return { skipped: 'disabled' };
  const tz = cfg.tz || 'America/Los_Angeles';
  const p = localParts(now, tz);
  const done = [];

  // 1 — the digest itself
  if (p.hour === (cfg.hour == null ? 7 : cfg.hour)) {
    const state = await getJson(ctx, K.state, {});
    // A claim older than 15 minutes belongs to a run that died mid-build (an
    // eviction, a thrown promise nobody caught). Without this the day's digest
    // would be silently skipped and no retry would ever come.
    const stale = state.buildingOn === p.date && (now - (state.buildingAt || 0) > 15 * 60000);
    if (state.lastSentOn !== p.date && (state.buildingOn !== p.date || stale)) {
      // Claim the day BEFORE the long build so a retried or overlapping tick
      // can't send two digests. The claim is released only by a completed run.
      state.buildingOn = p.date;
      state.buildingAt = now;
      await putJson(ctx, K.state, state);
      try {
        const built = await buildDigest(ctx, { now, cfg });
        if (built.ok) { await sendDigest(ctx, built); done.push('digest ' + built.id); }
        else {
          done.push('digest skipped: ' + built.reason);
          const st = await getJson(ctx, K.state, {});
          st.lastError = built.reason; st.lastErrorAt = now; st.buildingOn = '';
          st.lastDiagnostics = (built.diagnostics || []).slice(0, 40);
          await putJson(ctx, K.state, st);
        }
      } catch (err) {
        const st = await getJson(ctx, K.state, {});
        st.lastError = String(err && err.message || err); st.lastErrorAt = now; st.buildingOn = '';
        await putJson(ctx, K.state, st);
        done.push('digest failed: ' + st.lastError);
      }
    }
  }

  // 2 — reminders ("remind me Friday"), delivered on the day at the hour asked
  const state2 = await getJson(ctx, K.state, {});
  const due = (state2.reminders || []).filter((r) => r.on <= p.date && p.hour >= (r.hour || 8));
  if (due.length) {
    state2.reminders = (state2.reminders || []).filter((r) => !due.includes(r));
    await putJson(ctx, K.state, state2);
    await ctx.notify('⏰ You asked to be reminded',
      due.map((r) => `• ${r.text}${r.digestId ? `\n  ${ctx.publicBase()}/digest.html?id=${r.digestId}` : ''}`).join('\n\n'));
    done.push(`reminders ${due.length}`);
  }

  // 3 — weekly rollup
  if (cfg.weekly && cfg.weekly.enabled !== false &&
      p.dow === (cfg.weekly.dow == null ? 0 : cfg.weekly.dow) &&
      p.hour === (cfg.weekly.hour == null ? 17 : cfg.weekly.hour)) {
    const st = await getJson(ctx, K.state, {});
    if (st.weeklyOn !== p.date) { await weeklyRollup(ctx, now); done.push('weekly'); }
  }

  // 4 — breaking interrupt, once an hour at :20 (fetches, writes only on a hit)
  if (p.minute === 20) {
    const r = await checkBreaking(ctx, now).catch((err) => ({ fired: 0, reason: String(err && err.message || err) }));
    if (r.fired) done.push(`breaking ${r.fired}`);
  }

  return { done };
}

// ---------------------------------------------------------------------------
// Inbound text / email → capture, answer, or retune
// ---------------------------------------------------------------------------
const INTENT_SCHEMA = {
  type: 'OBJECT',
  properties: { intent: { type: 'STRING' }, reason: { type: 'STRING' } },
  required: ['intent'],
};

/**
 * One inbox for three different things Mikey might be doing when he texts the
 * business number: dropping a note, answering the question of the day, or
 * retuning the digest. Explicit prefixes win; otherwise a pending question and
 * then the model decide; capture is the safe default.
 */
export async function digestIngest(ctx, { text, source }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'empty' };
  const cfg = await loadCfg(ctx);
  const today = localParts(Date.now(), cfg.tz).date;
  const state = await getJson(ctx, K.state, {});

  const m = body.match(/^#(note|answer|tune|retune)\b[:\s]*/i);
  let intent = m ? m[1].toLowerCase() : '';
  const payload = m ? body.slice(m[0].length).trim() : body;
  if (intent === 'retune') intent = 'tune';

  if (!intent) {
    // A question asked this morning and still unanswered makes the next message
    // an answer far more often than not.
    const fresh = state.pendingQuestion && (Date.now() - (state.pendingQuestionAt || 0) < 20 * 3600000);
    try {
      const raw = await ctx.gemini(
        'Classify this message from a business owner to his own morning-briefing system.\n' +
        (fresh ? `This morning it asked him: "${state.pendingQuestion}"\n` : '') +
        'Reply with intent = "answer" (he is answering that question), "tune" (he is telling the ' +
        'briefing to send more or less of something), or "note" (anything else — a thought, a reminder, ' +
        'a fact about himself or the business to remember).\n\nMESSAGE: ' + payload.slice(0, 800),
        { json: true, schema: INTENT_SCHEMA, maxTokens: 120, temperature: 0 });
      intent = String(JSON.parse(raw).intent || '').toLowerCase();
    } catch {
      intent = /\b(less|more|stop showing|never show)\b/i.test(payload) ? 'tune' : (fresh ? 'answer' : 'note');
    }
    if (!['answer', 'tune', 'note'].includes(intent)) intent = 'note';
  }

  if (intent === 'tune') {
    const r = await retune(ctx, payload);
    return { ok: r.ok, intent: 'tune', reply: r.reply || r.error, changed: r.changed };
  }
  if (intent === 'answer') {
    const q = state.pendingQuestion || 'Note';
    await appendContext(ctx, `Q: ${q}`, payload, today);
    state.pendingQuestion = '';
    await putJson(ctx, K.state, state);
    return { ok: true, intent: 'answer', reply: 'Added to your context doc — tomorrow\'s digest knows it.' };
  }
  await digestCapture(ctx, { text: payload, source: source || 'text' });
  return { ok: true, intent: 'note', reply: 'Captured. It\'s in tomorrow\'s context.' };
}

// ---------------------------------------------------------------------------
// Signed one-tap action tokens
// ---------------------------------------------------------------------------
// The buttons have to work from an email client with no session, so they carry
// their own authority: an HMAC over the payload with a per-install secret, and a
// short expiry. Worst case a leaked link nudges a topic weight.
export async function actionSecret(ctx) {
  let s = await ctx.kv.get(K.secret);
  if (!s) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    s = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    await ctx.kv.put(K.secret, s);
  }
  return s;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

export async function signAction(ctx, payload) {
  const secret = await actionSecret(ctx);
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyAction(ctx, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const secret = await actionSecret(ctx);
  const expect = b64url(await hmac(secret, body));
  if (!timingSafeEq(expect, sig)) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); } catch { return null; }
  if (payload.x && Date.now() > payload.x) return null;
  return payload;
}

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The `actionUrl(item, action)` the renderer calls. Rendering is synchronous and
 * signing is not, so every token is minted up front and handed over as a plain
 * lookup — the alternative is a template string quietly interpolating
 * "[object Promise]" into a live email.
 */
export const TAP_ACTIONS = ['buy', 'reject', 'remind'];

export async function actionUrlFactory(ctx, digestId, items) {
  const base = ctx.publicBase();
  const exp = Date.now() + 45 * 86400000;
  const map = new Map();
  for (const item of (items || [])) {
    for (const a of TAP_ACTIONS) {
      const token = await signAction(ctx, { d: digestId, i: item.key, a, t: item.topicId, e: item.entity, x: exp });
      map.set(item.key + '|' + a, `${base}/d/a/${token}`);
    }
  }
  return (item, action) => map.get(item.key + '|' + action) || '';
}
