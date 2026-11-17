// One small interface over two providers. Gemini is the default because its API has a free tier;
// Claude is used when only ANTHROPIC_API_KEY is set (or LLM_PROVIDER=anthropic).

export class LLMError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function llmInfo(env = process.env) {
  const wanted = (env.LLM_PROVIDER || '').toLowerCase();
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY);
  let provider = null;
  if (wanted === 'anthropic' && hasClaude) provider = 'anthropic';
  else if (wanted === 'gemini' && hasGemini) provider = 'gemini';
  else if (hasGemini) provider = 'gemini';
  else if (hasClaude) provider = 'anthropic';
  if (!provider) return { provider: null, models: [] };
  const models = provider === 'gemini'
    ? [env.GEMINI_MODEL || 'gemini-3.6-flash', env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite']
    : [env.ANTHROPIC_MODEL || 'claude-haiku-5-5'];
  return { provider, models: [...new Set(models.filter(Boolean))] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the configured model for a JSON object matching `schema` (a plain JSON Schema).
 * Returns the parsed object.
 *
 * - fast: try the lighter model first (good for high-volume, verifiable tasks).
 * - timeoutMs: per request; a timed-out model is skipped for the next one, not retried.
 * - salvage(text): called when the answer is not valid JSON (e.g. cut off); may return a usable object.
 */
export async function generateJSON({ system, user, schema, maxTokens = 4096, fast = false, timeoutMs = 60_000, salvage, env = process.env }) {
  const info = llmInfo(env);
  if (!info.provider) throw new LLMError('No AI key configured. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env.', 503);
  const models = fast ? [...info.models].reverse() : info.models;
  const text = info.provider === 'gemini'
    ? await callGemini({ system, user, schema, maxTokens, models, key: env.GEMINI_API_KEY, timeoutMs })
    : await callClaude({ system, user, schema, maxTokens, model: info.models[0], key: env.ANTHROPIC_API_KEY, timeoutMs });
  try {
    return parseJSON(text);
  } catch (error) {
    const rescued = salvage ? salvage(text) : null;
    if (rescued) return rescued;
    throw error;
  }
}

export function parseJSON(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch { /* fall through */ }
    }
    throw new LLMError('The AI answer was not valid JSON. Try again.', 502);
  }
}

/**
 * Thinking models spend output tokens on hidden reasoning before answering. For extraction that is
 * pure cost: it makes answers slow and can use up maxOutputTokens so the JSON gets cut off.
 */
export function thinkingConfigFor(model) {
  const m = model.toLowerCase();
  if (/gemini-[3-9]/.test(m)) return { thinkingLevel: /flash|lite/.test(m) ? 'minimal' : 'low' };
  if (/gemini-2\.5/.test(m)) return { thinkingBudget: /pro/.test(m) ? 128 : 0 };
  return null;
}

const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

async function callGemini({ system, user, schema, maxTokens, models, key, timeoutMs }) {
  const started = Date.now();
  const budgetMs = 150_000; // stay well inside the hosting platform's function time limit
  let lastStatus = 0;
  let timedOut = false;
  for (const model of models) {
    let thinking = thinkingConfigFor(model);
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = budgetMs - (Date.now() - started);
      if (left < 8_000) break;
      const payload = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      };
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        });
      } catch (error) {
        if (isTimeout(error)) { timedOut = true; break; } // a slow model stays slow: move to the next one
        lastStatus = 0;
        if (attempt < 2) { await sleep(1000); continue; }
        break;
      }
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        // Skip thought summaries if a model returns them; keep the answer text only.
        const out = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
        if (out) return out;
        if (attempt < 1) continue;
        break;
      }
      if (res.status === 400) {
        const detail = await res.text();
        if (/API_KEY_INVALID|API key not valid/i.test(detail)) throw providerError('Gemini', 401);
        if (thinking && /thinking/i.test(detail)) { thinking = null; attempt--; continue; } // model rejects this thinking setting
      }
      if (res.status === 404 || res.status === 429) break; // missing model or used-up quota: try the fallback model
      if ([408, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
        await sleep(1200 * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  if (timedOut && (lastStatus === 0 || lastStatus === 200)) throw new LLMError('Gemini took too long to answer. Try again in a moment.', 504);
  throw providerError('Gemini', lastStatus);
}

async function callClaude({ system, user, schema, maxTokens, model, key, timeoutMs = 60_000 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: `${system}\n\nReply with a single JSON object only, no prose and no code fences, matching this JSON Schema:\n${JSON.stringify(schema)}`,
    messages: [{ role: 'user', content: user }],
  };
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    lastStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (out) return out;
      throw new LLMError('Claude returned an empty answer. Try again.', 502);
    }
    if ([429, 500, 502, 503, 504, 529].includes(res.status) && attempt < 2) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    break;
  }
  throw providerError('Claude', lastStatus);
}

function providerError(name, status) {
  if (status === 401 || status === 403) return new LLMError(`${name} rejected the API key. Check it in .env.`, 502);
  if (status === 404) return new LLMError(`The configured ${name} model is not available for this key. Change the model in .env.`, 502);
  if (status === 429) return new LLMError(`${name} quota is used up for now. Wait a minute and try again.`, 503);
  if (status === 400) return new LLMError(`${name} refused the request format.`, 502);
  return new LLMError(`Could not reach ${name} right now (HTTP ${status || 'network error'}).`, 502);
}
