// AI "summary" as a list of notable phrases copied word for word from the article.
// The model is asked to quote exactly; every phrase is then checked against the article text and
// anything that is not really there (paraphrased or invented) is dropped.
import { generateJSON } from './llm.js';
import { findVerbatim, normalizeWithMap, normalize, cleanPhrase } from '../public/js/textmatch.js';

const TYPES = ['claim', 'evidence', 'academic', 'collocation', 'topic'];

const SCHEMA = {
  type: 'object',
  properties: {
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Exact words copied from the article' },
          type: { type: 'string', enum: TYPES },
        },
        required: ['text', 'type'],
      },
    },
  },
  required: ['phrases'],
};

const SYSTEM = `You pick out notable language from an article for a Vietnamese student preparing a long argumentative essay in English (national excellent student competition, IELTS Task 2 style).
Return phrases COPIED EXACTLY from the article: same words, same order, same spelling. Never paraphrase, never join words from different sentences, never add or drop words, never fix grammar.
Pick a mix of these types:
- claim: the core clause of a key argument or thesis (8-25 words)
- evidence: a statistic, finding or concrete example with its numbers (6-25 words)
- academic: a reusable academic or hedging frame, e.g. "there is growing evidence that", "it could be argued that" (3-10 words)
- collocation: a precise, high-level word combination, e.g. "exacerbate inequality", "a double-edged sword" (2-6 words)
- topic: topic-specific terminology or a sophisticated noun phrase (1-6 words)
Prefer language a strong writer would reuse. Skip names of people, captions, navigation text and boilerplate.
List them in the order they appear in the article.`;

// About 6,000 words: covers a whole editorial and the key sections of most papers, and keeps
// the request fast. Longer sources are summarised from their opening part.
const MAX_CHARS = 36_000;

/** Recover every complete {"text": ..., "type": ...} object from a cut-off JSON answer. */
export function salvagePhrases(raw) {
  const out = [];
  const re = /\{\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"type"\s*:\s*"(\w+)"\s*\}|\{\s*"type"\s*:\s*"(\w+)"\s*,\s*"text"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}/g;
  for (const m of String(raw).matchAll(re)) {
    try {
      out.push(m[1] ? { text: JSON.parse(m[1]), type: m[2] } : { text: JSON.parse(m[4]), type: m[3] });
    } catch { /* skip a malformed item */ }
  }
  return out.length ? { phrases: out, salvaged: true } : null;
}

export async function extractPhrases({ text, title, topic, count = 22 }) {
  const source = String(text || '');
  if (source.trim().length < 200) throw Object.assign(new Error('The article is too short to summarise.'), { status: 400 });
  const n = Math.max(8, Math.min(40, Number(count) || 25));
  const truncated = source.length > MAX_CHARS;
  const user = [
    topic ? `Essay topic: ${topic}` : null,
    title ? `Article title: ${title}` : null,
    `Return about ${n} phrases.`,
    'Article:',
    '"""',
    source.slice(0, MAX_CHARS),
    '"""',
  ].filter(Boolean).join('\n');
  const out = await generateJSON({
    system: SYSTEM, user, schema: SCHEMA,
    maxTokens: 8192, fast: true, timeoutMs: 45_000, salvage: salvagePhrases,
  });
  return { ...verifyPhrases(source, out.phrases || []), truncated };
}

/** Keep only phrases that occur in the source; return each as the exact original slice. */
export function verifyPhrases(source, phrases) {
  const prepared = normalizeWithMap(source);
  const kept = [];
  const seen = new Set();
  let dropped = 0;
  for (const p of phrases) {
    const raw = cleanPhrase(typeof p === 'string' ? p : p?.text);
    if (!raw || raw.split(/\s+/).length > 45) { dropped++; continue; }
    const hit = findVerbatim(source, raw, prepared);
    if (!hit) { dropped++; continue; }
    const key = normalize(hit.text);
    if (seen.has(key)) continue;
    seen.add(key);
    const type = TYPES.includes(p?.type) ? p.type : 'topic';
    kept.push({ text: hit.text.replace(/\s+/g, ' '), type, at: hit.start });
  }
  kept.sort((a, b) => a.at - b.at);
  return { phrases: kept.map(({ text, type }) => ({ text, type })), dropped };
}
