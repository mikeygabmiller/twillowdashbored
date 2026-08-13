// The ceilings on the two unauthenticated surfaces: the signup route, which
// causes mail to be sent to an address the caller chooses, and the admin error
// bodies, which used to answer questions nobody had authenticated to ask.

import test from 'node:test';
import assert from 'node:assert/strict';

import { config, SIGNUP_LIMITS } from '../src/config.js';
import { makeStore } from '../src/lib/store.js';
import { takeToken, clientIp } from '../src/lib/ratelimit.js';
import { subscribe } from '../src/lib/subscribers.js';

const cfg = config({
  LLM_PROVIDER: 'stub',
  RESEND_API_KEY: 'test-key',
  TOKEN_SECRET: 'a-long-enough-test-secret',
  WORKER_URL: 'https://matins.test.workers.dev',
});

// Counts confirmation emails instead of sending them.
function fakeResend() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"1"}', { status: 200 });
  };
  return { sent, fetchImpl };
}

test('signup is capped per IP, and the cap is per window not per lifetime', async () => {
  const store = makeStore(null);
  const take = () => takeToken(store, { bucket: 'sub', id: '203.0.113.7', limit: SIGNUP_LIMITS.perIpPerHour });

  for (let i = 0; i < SIGNUP_LIMITS.perIpPerHour; i++) {
    assert.equal((await take()).allowed, true, `signup ${i + 1} is a real person`);
  }
  const over = await take();
  assert.equal(over.allowed, false);
  assert.ok(over.retryAfter > 0, 'the caller is told when to come back');

  // A different address is unaffected — this limits a source, not the service.
  const other = await takeToken(store, { bucket: 'sub', id: '198.51.100.2', limit: SIGNUP_LIMITS.perIpPerHour });
  assert.equal(other.allowed, true);
});

test('an unknown client is allowed rather than blocked', async () => {
  const store = makeStore(null);
  const res = await takeToken(store, { bucket: 'sub', id: null, limit: 1 });
  assert.equal(res.allowed, true, 'no client id is not grounds to refuse a signup');
});

test('a broken limiter lets signups through instead of breaking signup', async () => {
  const broken = { ...makeStore(null), getJson: async () => { throw new Error('KV is having a moment'); } };
  const res = await takeToken(broken, { bucket: 'sub', id: '203.0.113.7', limit: 1 });
  assert.equal(res.allowed, true);
});

test('the client IP comes from Cloudflare, falling back to the forwarded chain', () => {
  const req = (headers) => new Request('https://matins.test.workers.dev/subscribe', { headers });
  assert.equal(clientIp(req({ 'CF-Connecting-IP': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req({ 'X-Forwarded-For': '203.0.113.9, 70.41.3.18' })), '203.0.113.9');
  assert.equal(clientIp(req({})), null);
});

// A per-IP ceiling cannot see many sources aimed at one inbox. This can.
test('resubmitting the form does not re-mail a pending address', async () => {
  const store = makeStore(null);
  const mail = fakeResend();

  const first = await subscribe({ store, cfg, rawEmail: 'Reader@Example.com', fetchImpl: mail.fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.resent, true);
  assert.equal(mail.sent.length, 1);
  assert.deepEqual(mail.sent[0].to, ['reader@example.com'], 'the address is normalised before anything is stored or sent');

  const second = await subscribe({ store, cfg, rawEmail: 'reader@example.com', fetchImpl: mail.fetchImpl });
  assert.equal(second.ok, true, 'the reader is not shown an error for pressing the button twice');
  assert.equal(second.resent, false);
  assert.equal(mail.sent.length, 1, 'no second confirmation email');
  assert.match(second.message, /Check your inbox/);
});

test('once the cooldown has passed a confirmation can be sent again', async () => {
  const store = makeStore(null);
  const mail = fakeResend();
  await subscribe({ store, cfg, rawEmail: 'reader@example.com', fetchImpl: mail.fetchImpl });

  // Age the record past the cooldown rather than waiting fifteen minutes.
  const stale = await store.getJson('sub:reader@example.com');
  const past = new Date(Date.now() - (SIGNUP_LIMITS.resendCooldownSeconds + 60) * 1000).toISOString();
  await store.putJson('sub:reader@example.com', { ...stale, lastRequestedAt: past });

  const again = await subscribe({ store, cfg, rawEmail: 'reader@example.com', fetchImpl: mail.fetchImpl });
  assert.equal(again.resent, true, 'a genuinely lost confirmation can still be re-requested');
  assert.equal(mail.sent.length, 2);
});

test('an already-active address is never re-mailed', async () => {
  const store = makeStore(null);
  const mail = fakeResend();
  await store.putJson('sub:reader@example.com', { email: 'reader@example.com', status: 'active', confirmedAt: 'x' });
  const res = await subscribe({ store, cfg, rawEmail: 'reader@example.com', fetchImpl: mail.fetchImpl });
  assert.equal(res.state, 'active');
  assert.equal(mail.sent.length, 0);
});

test('the unauthenticated admin diagnostics are off unless turned on', () => {
  assert.equal(config({}).adminDiagnostics, false, 'off by default');
  assert.equal(config({ ADMIN_DIAGNOSTICS: '1' }).adminDiagnostics, true);
  assert.equal(config({ ADMIN_DIAGNOSTICS: '0' }).adminDiagnostics, false);
});

test('the alert address is configuration, never a subscriber', () => {
  assert.equal(config({}).alertEmail, '');
  assert.equal(config({ ALERT_EMAIL: 'me@example.com' }).alertEmail, 'me@example.com');
});
