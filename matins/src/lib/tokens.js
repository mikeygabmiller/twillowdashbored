// Signed, purpose-scoped links for confirm and unsubscribe. HMAC-SHA256 over
// "purpose:email" with TOKEN_SECRET, so a link cannot be guessed, reused for
// the other purpose, or forged for someone else's address.
//
// Web Crypto — identical in the Worker and in Node 18+.

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function makeToken({ secret, purpose, email }) {
  if (!secret) throw new Error('TOKEN_SECRET is not set');
  const payload = `${purpose}:${email.toLowerCase()}`;
  const sig = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function readToken({ secret, purpose, token }) {
  try {
    const [payloadPart, sigPart] = String(token || '').split('.');
    if (!payloadPart || !sigPart) return null;
    const payload = new TextDecoder().decode(unb64url(payloadPart));
    const expected = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload));
    if (!timingSafeEqual(unb64url(sigPart), new Uint8Array(expected))) return null;
    const idx = payload.indexOf(':');
    if (payload.slice(0, idx) !== purpose) return null;
    return payload.slice(idx + 1);
  } catch {
    return null;
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Deliberately permissive: this is a mailing list, not identity verification.
// The double opt-in is what actually proves the address.
export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}
