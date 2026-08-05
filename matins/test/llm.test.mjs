import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { llmText, listModels, LlmError } from '../src/lib/llm.js';

const gemini = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'test-key' });

function capture(response) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return response;
  };
  return { calls, fetchImpl };
}

const ok = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });

test('gemini requests carry the key as a header and leave room for reasoning', async () => {
  const c = capture(ok('a quiet start'));
  const text = await llmText({ cfg: gemini, system: 'sys', prompt: 'p', maxTokens: 60, fetchImpl: c.fetchImpl });
  assert.equal(text, 'a quiet start');
  const [call] = c.calls;
  assert.match(call.url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(call.init.headers['x-goog-api-key'], 'test-key');
  assert.ok(!call.url.includes('test-key'), 'the key must not ride in the URL');
  // A 60-token cap on a model that reasons first can return an empty
  // candidate, which fails closed and drops every block. Headroom prevents
  // that without depending on a field name that changes between generations.
  assert.ok(call.body.generationConfig.maxOutputTokens >= 1024);
  assert.equal(call.body.generationConfig.thinkingConfig, undefined, 'no thinking field unless asked for');
  assert.equal(call.body.generationConfig.temperature, 0.3);
  assert.equal(call.body.systemInstruction.parts[0].text, 'sys');
});

test('a thinking budget is sent only when configured', async () => {
  const c = capture(ok('x'));
  const cfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', GEMINI_THINKING_BUDGET: '0' });
  await llmText({ cfg, system: 's', prompt: 'p', fetchImpl: c.fetchImpl });
  assert.deepEqual(c.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('an explicit model overrides the default', async () => {
  const c = capture(ok('x'));
  const cfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', LLM_MODEL: 'gemini-3.5-flash-lite' });
  await llmText({ cfg, system: 's', prompt: 'p', fetchImpl: c.fetchImpl });
  assert.match(c.calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
});

test('listModels reports what the key can actually reach', async () => {
  const payload = {
    models: [
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
    ],
  };
  const c = capture(new Response(JSON.stringify(payload), { status: 200 }));
  const res = await listModels({ cfg: gemini, fetchImpl: c.fetchImpl });
  assert.deepEqual(res.models, ['gemini-3.6-flash'], 'embedding-only models are not usable here');
  assert.equal(c.calls[0].init.headers['x-goog-api-key'], 'test-key');

  const bad = capture(new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
  const err = await listModels({ cfg: gemini, fetchImpl: bad.fetchImpl });
  assert.equal(err.models, null);
  assert.match(err.error, /API key not valid/);
});

test('an empty gemini candidate explains itself', async () => {
  const cases = [
    [{ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }, /maxOutputTokens/],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, /prompt blocked: SAFETY/],
    [{ candidates: [{ content: { parts: [] }, finishReason: 'RECITATION' }] }, /finishReason RECITATION/],
    [{ candidates: [] }, /no candidates/],
  ];
  for (const [payload, expected] of cases) {
    const c = capture(new Response(JSON.stringify(payload), { status: 200 }));
    await assert.rejects(
      () => llmText({ cfg: gemini, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
      (err) => err instanceof LlmError && expected.test(err.message),
      `expected ${expected}`
    );
  }
});

test('an API error surfaces its status and body', async () => {
  const c = capture(new Response('{"error":{"message":"model not found"}}', { status: 404 }));
  await assert.rejects(
    () => llmText({ cfg: gemini, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
    (err) => /gemini 404/.test(err.message) && /model not found/.test(err.message)
  );
});

test('a missing key is caught before any request is made', async () => {
  const c = capture(ok('never reached'));
  await assert.rejects(
    () => llmText({ cfg: config({ LLM_PROVIDER: 'gemini' }), system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
    /LLM_API_KEY is not set/
  );
  assert.equal(c.calls.length, 0);
});

test('the stub provider never touches the network', async () => {
  const c = capture(ok('never reached'));
  const text = await llmText({ cfg: config({ LLM_PROVIDER: 'stub' }), system: 's', prompt: 'p', fetchImpl: c.fetchImpl });
  assert.ok(text.includes('[offline preview]'));
  assert.equal(c.calls.length, 0);
});
