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
        generationConfig: geminiGenerationConfig({ cfg, temperature, maxTokens }),
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new LlmError(`gemini ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new LlmError(`gemini returned no text (${describeEmptyGemini(data)})`);
    return text;
  }

  throw new LlmError(`unknown LLM_PROVIDER: ${provider}`);
}

// Recent Gemini models reason before answering, and those tokens are drawn
// from maxOutputTokens. Every call here asks for something short — a nine-word
// headline, a two-field JSON verdict — so without headroom the model can spend
// the whole budget thinking and return an empty candidate. safety.js reads an
// empty reply as "the checker failed" and fails closed on it, so that quirk
// alone could drop every generated block while the issue still sent.
//
// Headroom is the fix that survives a model generation: it costs nothing when
// unused and does not depend on a field name. The field that *disables*
// thinking has been renamed across generations, so it is sent only when
// GEMINI_THINKING_BUDGET is set deliberately — an unrecognised field is a 400,
// which would cause the very failure this is guarding against.
const GEMINI_MIN_OUTPUT_TOKENS = 1024;

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
  // The judge compares drafts; offline there is only ever one worth having.
  if (/There are \d+ drafts/.test(prompt)) {
    return JSON.stringify({ choice: 1, reason: 'offline preview: no comparison made' });
  }
  if (/THE PASSAGES, IN FULL/.test(prompt)) {
    const part = (name) => ({
      summary: `[offline preview] This stands in for two or three sentences saying what actually happens in the ${name}, written from the Douay-Rheims text the model is given.`,
      calledTo: `[offline preview] Do the one concrete thing the ${name} asks of you before you eat tonight.`,
    });
    const out = {};
    if (/^EPISTLE —/m.test(prompt) || /\nEPISTLE —/.test(prompt)) out.epistle = part('epistle');
    if (/GOSPEL —/.test(prompt)) out.gospel = part('Gospel');
    return JSON.stringify(out);
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
