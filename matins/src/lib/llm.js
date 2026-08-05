// Provider-agnostic text call. Anthropic or Gemini by config; "stub" is an
// offline deterministic provider so `npm run preview` and the tests run with
// no key and no network.
//
// Every call is JSON-in / text-out with a low temperature. The model is only
// ever handed facts we already have — it is never the source of one.

import { TEMPERATURE } from '../config.js';

export class LlmError extends Error {}

export async function llmText({ cfg, system, prompt, maxTokens = 700, temperature = TEMPERATURE.generate, fetchImpl }) {
  const provider = cfg.llmProvider;
  if (provider === 'stub') return stubText({ system, prompt });
  if (!cfg.llmApiKey) throw new LlmError(`LLM_API_KEY is not set (provider "${provider}")`);
  const f = fetchImpl || globalThis.fetch;

  if (provider === 'anthropic') {
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new LlmError(`anthropic ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new LlmError('anthropic returned no text');
    return text;
  }

  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.llmModel)}:generateContent`;
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.llmApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new LlmError(`gemini ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new LlmError('gemini returned no text');
    return text;
  }

  throw new LlmError(`unknown LLM_PROVIDER: ${provider}`);
}

// Parses a JSON object out of a model reply that may be fenced or padded.
export function parseJsonReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new LlmError('no JSON object in reply');
  return JSON.parse(raw.slice(start, end + 1));
}

// --- offline provider -------------------------------------------------------
// Deterministic, obviously-placeholder prose. It exists so the pipeline can be
// exercised end to end without a key; it is not devotional writing and the
// renderer labels it in preview output.
function stubText({ system, prompt }) {
  if (/return only json/i.test(system) && /verdict/i.test(system)) {
    // Safety pass: approve unless the block carries the seeded test marker.
    const bad = /SEEDED_BAD_BLOCK|guaranteed to make you rich|the Church teaches that money/i.test(prompt);
    return JSON.stringify(
      bad
        ? { pass: false, reason: 'Presents a private opinion as binding Church teaching and makes a promise the Church does not make.' }
        : { pass: true, reason: 'No doctrinal, factual, or citation problems found.' }
    );
  }
  const kind = /HEADLINE/.test(prompt) ? 'headline' : /SAINT/.test(prompt) ? 'saint' : 'reflection';
  if (kind === 'headline') return '[offline preview] A quiet start to an ordinary weekday';
  if (kind === 'saint') {
    return JSON.stringify({
      life: '[offline preview] This is placeholder text produced without an LLM key. Set LLM_PROVIDER and LLM_API_KEY to generate the real saint story.',
      oneActionToday: '[offline preview] Do one small piece of your work today with more care than anyone will notice.',
    });
  }
  return '[offline preview] This is placeholder reflection text produced without an LLM key. It stands in for four to six sentences tied to the readings and the feast above. Set LLM_PROVIDER and LLM_API_KEY to generate the real thing. The pipeline, rotation, safety pass, and both renderers are otherwise running exactly as they would in production.';
}
