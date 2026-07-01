/**
 * Shared core for Mikey's Detailing SMS dashboard.
 * Used by both the API function and the scheduled-send dispatcher.
 *
 * Storage: Netlify Blobs (getStore('mkd-messages')).
 *   threads-index           → array of lightweight conversation summaries
 *   thread:<E.164 phone>     → full conversation object
 *
 * Secrets come from process.env:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, MIKEY_PHONE
 */

import { getStore } from '@netlify/blobs';

export const INDEX_KEY = 'threads-index';
export const threadKey = (phone) => `thread:${phone}`;

export function store() {
  return getStore('mkd-messages');
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Thread + index model
// ---------------------------------------------------------------------------
export function blankThread(phone) {
  return {
    phone,
    name: '',
    tags: [],
    status: '',        // '', 'new', 'active', 'won', 'lost'
    notes: '',
    pinned: false,
    archived: false,
    unread: 0,
    appointmentAt: null, // ms timestamp of the customer's booked detail (for reminders)
    linked: [],        // array of related thread phone numbers (E.164)
    messages: [],      // { id, dir:'in'|'out', body, ts, kind, error? }
    scheduled: [],     // { id, body, sendAt }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
// Average "time to reply": for each customer message that was waiting, measure
// how long until Mikey's next outbound message. Auto/quote messages still count
// as outbound. Returns { avgMs, count, awaiting, awaitingSince }.
export function computeReplyStats(messages) {
  let total = 0, count = 0, pending = null;
  for (const m of (messages || [])) {
    if (m.dir === 'in') { if (pending == null) pending = m.ts; }
    else if (m.dir === 'out' && pending != null) { total += (m.ts - pending); count++; pending = null; }
  }
  return { avgMs: count ? Math.round(total / count) : null, count, awaiting: pending != null, awaitingSince: pending };
}

// Compact transcript for prompting the model (most-recent `max` messages).
export function transcript(thread, max = 40) {
  return (thread.messages || []).slice(-max)
    .map((m) => `${m.dir === 'in' ? 'Customer' : 'Mikey'}: ${String(m.body || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Gemini (Google Generative Language API) — key comes from process.env only.
// ---------------------------------------------------------------------------
export async function geminiGenerate(prompt, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature == null ? 0.4 : opts.temperature,
      // Give the model plenty of room so replies/summaries finish their thought.
      // gemini-2.0-flash supports up to 8192 output tokens.
      maxOutputTokens: opts.maxTokens || 2048,
    },
  };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const candidate = (data.candidates || [])[0] || {};
  const parts = (candidate.content || {}).parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  // If the model stopped because it ran out of tokens, the last sentence is a
  // dangling fragment. Trim back to the last complete sentence so the reader
  // never sees text cut off mid-word. (JSON responses are left untouched so we
  // don't corrupt the structure — those callers parse and validate downstream.)
  if (candidate.finishReason === 'MAX_TOKENS' && !opts.json) {
    return trimToCompleteSentence(text);
  }
  return text;
}

// Trim a possibly-truncated string back to its last sentence-ending punctuation
// so a cut-off final fragment is dropped rather than shown mid-thought. Falls
// back to the original text if there's no earlier sentence boundary to cut to.
function trimToCompleteSentence(text) {
  if (!text) return text;
  const lastEnd = Math.max(
    text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '),
    text.lastIndexOf('.\n'), text.lastIndexOf('!\n'), text.lastIndexOf('?\n'),
  );
  // Also handle punctuation at the very end (e.g. a complete final sentence).
  if (/[.!?]["')\]]?$/.test(text)) return text;
  if (lastEnd > 0) return text.slice(0, lastEnd + 1).trim();
  return text;
}

// Load a thread, filling in any fields missing from older saved data.
export async function loadThread(phone) {
  const raw = await store().get(threadKey(phone), { type: 'json' });
  return Object.assign(blankThread(phone), raw || {});
}

export async function saveThread(thread) {
  thread.updatedAt = Date.now();
  await store().setJSON(threadKey(thread.phone), thread);
}

export async function loadIndex() {
  return (await store().get(INDEX_KEY, { type: 'json' })) || [];
}

export async function saveIndex(index) {
  await store().setJSON(INDEX_KEY, index);
}

function preview(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

// Recompute and upsert this thread's summary in the index.
export async function updateIndexEntry(thread) {
  const index = await loadIndex();
  const last = thread.messages[thread.messages.length - 1];
  const summary = {
    phone: thread.phone,
    name: thread.name || '',
    tags: thread.tags || [],
    status: thread.status || '',
    pinned: !!thread.pinned,
    archived: !!thread.archived,
    unread: thread.unread || 0,
    scheduledCount: (thread.scheduled || []).length,
    lastBody: last ? preview(last.body) : '',
    lastDir: last ? last.dir : '',
    lastTs: last ? last.ts : (thread.updatedAt || Date.now()),
  };
  const i = index.findIndex((t) => t.phone === thread.phone);
  if (i >= 0) index[i] = summary;
  else index.push(summary);
  await saveIndex(index);
}

// Append a message to a thread (creating it if needed) and refresh the index.
export async function appendMessage(phone, message, opts = {}) {
  const thread = await loadThread(phone);
  if (opts.name && !thread.name) thread.name = opts.name;
  message.id = message.id || genId();
  message.ts = message.ts || Date.now();
  thread.messages.push(message);
  if (message.dir === 'in') thread.unread = (thread.unread || 0) + 1;
  await saveThread(thread);
  await updateIndexEntry(thread);
  return thread;
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: process.env.TWILIO_FROM, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return res.json();
}

// Click-to-call: ring Mikey's cell, then bridge the call to the customer.
export async function placeBridgeCall(customer) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const twiml =
    `<Response><Say voice="alice">Connecting your call.</Say>` +
    `<Dial callerId="${escapeXml(from)}">${escapeXml(customer)}</Dial></Response>`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: process.env.MIKEY_PHONE, From: from, Twiml: twiml }),
  });
  if (!res.ok) throw new Error(`Twilio call ${res.status}: ${await res.text()}`);
  return res.json();
}

export function normalizePhone(raw) {
  if (!raw) return null;
  if (/^\+1\d{10}$/.test(raw)) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

// ---------------------------------------------------------------------------
// Scheduled send dispatch (shared so the cron and a manual trigger agree)
// ---------------------------------------------------------------------------
export async function dispatchDueScheduled(now = Date.now()) {
  const index = await loadIndex();
  let sent = 0;
  for (const entry of index) {
    if (!entry.scheduledCount) continue;
    const thread = await loadThread(entry.phone);
    const due = (thread.scheduled || []).filter((s) => s.sendAt <= now);
    if (!due.length) continue;
    thread.scheduled = (thread.scheduled || []).filter((s) => s.sendAt > now);
    for (const s of due) {
      try {
        await sendSms(thread.phone, s.body);
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled' });
        sent++;
      } catch (err) {
        thread.messages.push({ id: genId(), dir: 'out', body: s.body, ts: Date.now(), kind: 'scheduled', error: String(err.message || err) });
      }
    }
    await saveThread(thread);
    await updateIndexEntry(thread);
  }
  return sent;
}
