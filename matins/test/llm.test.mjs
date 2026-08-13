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
  // A model that reasons first spends output tokens before it writes anything.
  // 1024 was tried and was not enough: it left room to think and not to finish,
  // which truncated every reflection for eight days. The floor has to hold both.
  assert.ok(call.body.generationConfig.maxOutputTokens >= 3072);
  assert.equal(call.body.generationConfig.thinkingConfig, undefined, 'no thinking field unless asked for');
  assert.equal(call.body.generationConfig.temperature, 0.3);
  assert.equal(call.body.systemInstruction.parts[0].text, 'sys');
});

// THE REGRESSION. A candidate that ran out of room mid-sentence used to be
// returned as though the model had finished, because finishReason was only
// consulted when the text was empty. Downstream it looked like bad writing
// (the safety judge failing an incoherent reflection) or a bad parse (no
// closing brace in the saint story) rather than a budget that was too small.
test('a truncated gemini reply is an error, not an answer', async () => {
  const partial = {
    candidates: [{ content: { parts: [{ text: 'He kept the shop open the whole winter and never once' }] }, finishReason: 'MAX_TOKENS' }],
  };
  const c = capture(new Response(JSON.stringify(partial), { status: 200 }));
  await assert.rejects(
    () => llmText({ cfg: gemini, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
    (err) => err instanceof LlmError && /truncated/.test(err.message) && /maxOutputTokens/.test(err.message)
  );
});

test('a gemini reply that stopped for any other reason is an error too', async () => {
  const recited = {
    candidates: [{ content: { parts: [{ text: 'some text' }] }, finishReason: 'RECITATION' }],
  };
  const c = capture(new Response(JSON.stringify(recited), { status: 200 }));
  await assert.rejects(
    () => llmText({ cfg: gemini, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
    (err) => err instanceof LlmError && /RECITATION/.test(err.message)
  );
});

test('a truncated anthropic reply is an error too', async () => {
  const partial = { content: [{ type: 'text', text: 'half a sentence that stops' }], stop_reason: 'max_tokens' };
  const c = capture(new Response(JSON.stringify(partial), { status: 200 }));
  const cfg = config({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' });
  await assert.rejects(
    () => llmText({ cfg, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }),
    (err) => err instanceof LlmError && /truncated/.test(err.message)
  );
});

test('a complete anthropic reply passes through', async () => {
  const whole = { content: [{ type: 'text', text: 'a finished line' }], stop_reason: 'end_turn' };
  const c = capture(new Response(JSON.stringify(whole), { status: 200 }));
  const cfg = config({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' });
  assert.equal(await llmText({ cfg, system: 's', prompt: 'p', fetchImpl: c.fetchImpl }), 'a finished line');
});

// The thinking field is the fix for the truncation above, and it is also the
// field most likely to be renamed out from under this code. If that costs a
// 400 on every call, the issue loses all three generated blocks at once.
test('a rejected thinking field is retried without it, not taken as the answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1
      ? new Response('{"error":{"message":"Unknown name \\"thinkingConfig\\": Cannot find field."}}', { status: 400 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'wrote it anyway' }] }, finishReason: 'STOP' }] }), { status: 200 });
  };
  const cfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', GEMINI_THINKING_BUDGET: '0' });
  assert.equal(await llmText({ cfg, system: 's', prompt: 'p', fetchImpl }), 'wrote it anyway');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(calls[1].generationConfig.thinkingConfig, undefined, 'the retry drops the field it was rejected for');
});

test('a 400 that has nothing to do with thinking is not retried', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response('{"error":{"message":"API key not valid"}}', { status: 400 });
  };
  const cfg = config({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', GEMINI_THINKING_BUDGET: '0' });
  await assert.rejects(() => llmText({ cfg, system: 's', prompt: 'p', fetchImpl }), /API key not valid/);
  assert.equal(n, 1);
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
