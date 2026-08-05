// Resend delivery. Every message carries List-Unsubscribe headers plus a
// visible one-click link, and pending or unsubscribed addresses are never
// passed in here — activeSubscribers() is the only source of recipients.

import { renderEmail } from '../render/email.js';
import { makeToken } from './tokens.js';

const BATCH = 100; // Resend's /emails/batch limit

export async function sendIssue({ issue, cfg, store, recipients, fetchImpl, dryRun = false }) {
  const f = fetchImpl || globalThis.fetch;
  const result = { attempted: recipients.length, sent: 0, failed: 0, errors: [], dryRun };
  if (!recipients.length) return result;
  if (!cfg.resendKey && !dryRun) {
    result.errors.push('RESEND_API_KEY is not set');
    result.failed = recipients.length;
    return result;
  }

  const permalink = `${cfg.siteUrl}/${issue.date}/`;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const chunk = recipients.slice(i, i + BATCH);
    const messages = await Promise.all(
      chunk.map(async (email) => {
        const token = await makeToken({ secret: cfg.tokenSecret, purpose: 'unsub', email });
        const unsubscribeUrl = `${cfg.workerUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
        const rendered = renderEmail(issue, { cfg, unsubscribeUrl, permalink });
        return {
          from: cfg.fromEmail,
          to: [email],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        };
      })
    );

    if (dryRun) {
      result.sent += messages.length;
      continue;
    }

    try {
      const res = await f('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.resendKey}` },
        body: JSON.stringify(messages),
      });
      const body = await res.text();
      if (!res.ok) {
        result.failed += chunk.length;
        result.errors.push(`resend ${res.status}: ${body.slice(0, 200)}`);
      } else {
        result.sent += chunk.length;
      }
    } catch (err) {
      result.failed += chunk.length;
      result.errors.push(String(err?.message || err));
    }
  }

  if (!dryRun) await store.putJson(`sent:${issue.date}`, { at: new Date().toISOString(), ...result });
  return result;
}

export async function sendOne({ cfg, to, subject, html, text, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (!cfg.resendKey) return { ok: false, error: 'RESEND_API_KEY is not set' };
  try {
    const res = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.resendKey}` },
      body: JSON.stringify({ from: cfg.fromEmail, to: [to], subject, html, text, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
    });
    const body = await res.text();
    return res.ok ? { ok: true } : { ok: false, error: `resend ${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
