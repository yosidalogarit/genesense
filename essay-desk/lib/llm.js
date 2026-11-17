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
 */
export async function generateJSON({ system, user, schema, maxTokens = 4096, env = process.env }) {
  const info = llmInfo(env);
  if (!info.provider) throw new LLMError('No AI key configured. Add GEMINI_API_KEY or ANTHROPIC_API_KEY to .env.', 503);
  const text = info.provider === 'gemini'
    ? await callGemini({ system, user, schema, maxTokens, models: info.models, key: env.GEMINI_API_KEY })
    : await callClaude({ system, user, schema, maxTokens, model: info.models[0], key: env.ANTHROPIC_API_KEY });
  return parseJSON(text);
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

async function callGemini({ system, user, schema, maxTokens, models, key }) {
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
    },
  };
  let lastStatus = 0;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const out = parts.map((p) => p.text || '').join('').trim();
        if (out) return out;
        throw new LLMError('Gemini returned an empty answer (it may have been blocked). Try again.', 502);
      }
      if (res.status === 400) {
        const detail = await res.text();
        if (/API_KEY_INVALID|API key not valid/i.test(detail)) throw providerError('Gemini', 401);
      }
      if (res.status === 404 || res.status === 429) break; // missing model or used-up quota: try the fallback model
      if ([408, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
        await sleep(1200 * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  throw providerError('Gemini', lastStatus);
}

async function callClaude({ system, user, schema, maxTokens, model, key }) {
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
      signal: AbortSignal.timeout(90_000),
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
