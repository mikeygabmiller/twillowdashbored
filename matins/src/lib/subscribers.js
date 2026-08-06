// Subscribers. Email, status, timestamps — nothing else is stored.
//
//   subscribe  -> pending  (confirmation email sent)
//   confirm    -> active   (the only status that ever receives an issue)
//   unsubscribe-> unsubscribed (kept, so a resubscribe is deliberate and a
//                bounce/complaint address is never silently re-added)

import { makeToken, readToken, normalizeEmail } from './tokens.js';
import { sendOne } from './send.js';
import { theme, SERIF, SANS, escapeHtml } from '../render/theme.js';
import { FOOTER_LINE } from '../config.js';

const key = (email) => `sub:${email}`;

export async function getSubscriber(store, email) {
  return store.getJson(key(email));
}

export async function subscribe({ store, cfg, rawEmail, fetchImpl }) {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, status: 400, message: 'That does not look like an email address.' };

  const existing = await getSubscriber(store, email);
  if (existing?.status === 'active') {
    return { ok: true, status: 200, message: "You're already subscribed — tomorrow's issue is on its way.", state: 'active' };
  }

  const now = new Date().toISOString();
  const record = {
    email,
    status: 'pending',
    createdAt: existing?.createdAt || now,
    confirmedAt: null,
    unsubscribedAt: existing?.unsubscribedAt || null,
    lastRequestedAt: now,
  };
  await store.putJson(key(email), record);

  const token = await makeToken({ secret: cfg.tokenSecret, purpose: 'confirm', email });
  const url = `${cfg.workerUrl}/confirm?t=${encodeURIComponent(token)}`;
  const mail = confirmationEmail({ cfg, url });
  const res = await sendOne({ cfg, to: email, ...mail, fetchImpl });
  if (!res.ok) {
    // The reader gets a calm message; whoever is on call needs the real reason,
    // which is almost always an unverified sender or a missing Resend key.
    console.error(`subscribe: confirmation email to ${email} failed — ${res.error}`);
    // Also kept where it can be read from a browser, since /admin/status is the
    // only diagnostic surface for someone running this without a terminal.
    await store.putJson('diag:lastEmailError', { at: new Date().toISOString(), kind: 'confirmation', error: res.error }).catch(() => {});
    return { ok: false, status: 502, message: 'We could not send the confirmation email. Try again in a minute.', error: res.error };
  }

  // A failure that has since been fixed is worse than no diagnostic at all: it
  // sits in /admin/status looking current and sends you hunting a solved
  // problem. A send that works clears it.
  await store.del('diag:lastEmailError').catch(() => {});
  return { ok: true, status: 200, message: 'Check your inbox — click the link and you are in.', state: 'pending' };
}

export async function confirm({ store, cfg, token }) {
  const email = await readToken({ secret: cfg.tokenSecret, purpose: 'confirm', token });
  if (!email) return { ok: false, status: 400, message: 'That confirmation link is not valid.' };
  const existing = await getSubscriber(store, email);
  if (!existing) return { ok: false, status: 404, message: 'We have no record of that address. Sign up again and it will take two seconds.' };
  if (existing.status === 'active') return { ok: true, status: 200, message: 'Already confirmed. You are on the list.' };
  await store.putJson(key(email), { ...existing, status: 'active', confirmedAt: new Date().toISOString() });
  return { ok: true, status: 200, message: 'You are in. The next issue arrives tomorrow morning.' };
}

export async function unsubscribe({ store, cfg, token }) {
  const email = await readToken({ secret: cfg.tokenSecret, purpose: 'unsub', token });
  if (!email) return { ok: false, status: 400, message: 'That unsubscribe link is not valid.' };
  const existing = await getSubscriber(store, email);
  if (!existing) return { ok: true, status: 200, message: 'That address is not on the list.' };
  await store.putJson(key(email), { ...existing, status: 'unsubscribed', unsubscribedAt: new Date().toISOString() });
  return { ok: true, status: 200, message: 'Unsubscribed. No hard feelings — the archive stays open to you.' };
}

// The ONLY source of recipients. Anything not 'active' cannot be reached.
export async function activeSubscribers(store) {
  const keys = await store.listKeys('sub:');
  const out = [];
  for (const k of keys) {
    const rec = await store.getJson(k);
    if (rec?.status === 'active' && rec.email) out.push(rec.email);
  }
  return out;
}

export async function subscriberCounts(store) {
  const keys = await store.listKeys('sub:');
  const counts = { active: 0, pending: 0, unsubscribed: 0 };
  for (const k of keys) {
    const rec = await store.getJson(k);
    if (rec?.status in counts) counts[rec.status] += 1;
  }
  return counts;
}

function confirmationEmail({ cfg, url }) {
  const t = theme('green');
  return {
    subject: `Confirm your subscription to ${cfg.appName}`,
    html: `<!doctype html><html><body style="margin:0;background:${t.paperAlt};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.paperAlt};"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:${t.paper};border:1px solid ${t.rule};border-radius:10px;">
<tr><td style="padding:30px;">
  <div style="font-family:${SERIF};font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:${t.ink};">${escapeHtml(cfg.appName)}</div>
  <p style="font-family:${SERIF};font-size:17px;line-height:1.65;color:${t.ink};">One click and you are on the list — the day's readings, a short reflection, a saint, a prayer, every morning.</p>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;background:${t.accent};color:#fff;font-family:${SANS};font-size:15px;text-decoration:none;padding:12px 22px;border-radius:8px;">Confirm my subscription</a></p>
  <p style="font-family:${SANS};font-size:13px;color:${t.inkSoft};line-height:1.7;">If you did not ask for this, ignore this email — nothing will be sent.<br>${escapeHtml(FOOTER_LINE)}</p>
</td></tr></table></td></tr></table></body></html>`,
    text: `${cfg.appName}\n\nConfirm your subscription:\n${url}\n\nIf you did not ask for this, ignore this email — nothing will be sent.\n${FOOTER_LINE}`,
  };
}
