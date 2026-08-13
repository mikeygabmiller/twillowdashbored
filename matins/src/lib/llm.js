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
    // A block that ran out of room is a fragment, not an answer. See below.
    if (data.stop_reason === 'max_tokens') {
      throw new LlmError(`anthropic truncated: hit max_tokens after ${text.length} characters`);
    }
    return text;
  }

  if (provider === 'gemini') {
    const data = await geminiGenerate({ cfg, system, prompt, temperature, maxTokens, f });
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new LlmError(`gemini returned no text (${describeEmptyGemini(data)})`);
    // THE ONE THAT COST EIGHT ISSUES. A candidate that stopped because it ran
    // out of room is a fragment: a reflection that ends mid-sentence, a JSON
    // object with no closing brace. Returning it as if the model had finished
    // pushes the failure downstream, where it looks like bad writing or a bad
    // parse rather than a budget that was too small — the reflection reached
    // the safety judge and was correctly failed for incoherence, and the saint
    // story died in parseJsonReply, every single day, for the same reason.
    // Raising it here means produce() retries, and a persistent failure names
    // its actual cause.
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new LlmError(`gemini truncated: hit maxOutputTokens after ${text.length} characters`);
    }
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new LlmError(`gemini stopped early: finishReason ${candidate.finishReason}`);
    }
    return text;
  }

  throw new LlmError(`unknown LLM_PROVIDER: ${provider}`);
}

// Sending thinkingConfig is the fix for the truncation above, and it is also
// the field most likely to be renamed or dropped between model generations —
// where an unrecognised field is a 400 and every block of the issue is lost.
// So the request is tried once as configured, and a 400 that names the field is
// retried without it rather than taken as the day's answer.
async function geminiGenerate({ cfg, system, prompt, temperature, maxTokens, f }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.llmModel)}:generateContent`;
  const send = async (generationConfig) => {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.llmApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    return { status: res.status, body: await res.text() };
  };

  const generationConfig = geminiGenerationConfig({ cfg, temperature, maxTokens });
  let { status, body } = await send(generationConfig);

  if (status === 400 && generationConfig.thinkingConfig && /thinking/i.test(body)) {
    console.warn(`gemini rejected thinkingConfig, retrying without it: ${body.slice(0, 200)}`);
    const { thinkingConfig, ...rest } = generationConfig;
    ({ status, body } = await send(rest));
  }

  if (status !== 200) throw new LlmError(`gemini ${status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// Recent Gemini models reason before answering, and those tokens are drawn
// from maxOutputTokens. Headroom alone was tried first and was not enough: a
// 1024 floor sized as slack for a nine-word headline is not a budget a full
// reasoning pass can share with a six-sentence reflection, and the result was
// eight consecutive issues whose reflection and saint story were truncated
// rather than absent — the failure mode the floor was meant to prevent, one
// step further along.
//
// Two things now hold this closed. GEMINI_THINKING_BUDGET = "0" turns the
// reasoning off for work that needs none, and this floor is large enough that
// even if a future model ignores the budget, both the thinking and the answer
// fit. Unused output tokens cost nothing.
const GEMINI_MIN_OUTPUT_TOKENS = 3072;

function geminiGenerationConfig({ cfg, temperature, maxTokens }) {
  const generationConfig = { temperature, maxOutputTokens: Math.max(maxTokens, GEMINI_MIN_OUTPUT_TOKENS) };
  if (cfg.geminiThinkingBudget !== '') {
    generationConfig.thinkingConfig = { thinkingBudget: Number(cfg.geminiThinkingBudget) };
  }
  return generationConfig;
}

// Lists the models the configured key can actually reach. Model names change;
// this is how you find the current one instead of guessing (GET /admin/models).
export async function listModels({ cfg, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (cfg.llmProvider !== 'gemini') return { provider: cfg.llmProvider, models: null, note: 'model listing is only wired up for gemini' };
  if (!cfg.llmApiKey) return { provider: 'gemini', models: null, error: 'LLM_API_KEY is not set' };
  try {
    const res = await f('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': cfg.llmApiKey },
    });
    const body = await res.text();
    if (!res.ok) return { provider: 'gemini', models: null, error: `gemini ${res.status}: ${body.slice(0, 300)}` };
    const all = JSON.parse(body).models || [];
    return {
      provider: 'gemini',
      configured: cfg.llmModel,
      // Only the ones this app could actually use.
      models: all
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .sort(),
    };
  } catch (err) {
    return { provider: 'gemini', models: null, error: String(err?.message || err) };
  }
}

// An empty Gemini candidate is never self-explanatory. Say why, so the reason
// lands in safetyReport instead of a shrug.
function describeEmptyGemini(data) {
  const block = data?.promptFeedback?.blockReason;
  if (block) return `prompt blocked: ${block}`;
  const c = data?.candidates?.[0];
  if (!c) return 'no candidates returned';
  if (c.finishReason === 'MAX_TOKENS') return 'hit maxOutputTokens before writing anything';
  if (c.finishReason && c.finishReason !== 'STOP') return `finishReason ${c.finishReason}`;
  return 'empty candidate';
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
