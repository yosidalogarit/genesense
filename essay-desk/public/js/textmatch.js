// Shared by the server (phrase verification) and the browser (finding phrases in the reader).
// "Verbatim" here means the same characters once typography is ignored: curly vs straight quotes,
// en/em dashes vs hyphens, non-breaking spaces and runs of whitespace, and letter case.

const CHAR_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...',
};

const SPACE = /[\s  -​  　]/;

/**
 * Normalise text and keep, for every character of the result, the index of the original character
 * it came from, so a match in the normalised text can be mapped back to an exact original slice.
 */
export function normalizeWithMap(text) {
  let out = '';
  const map = [];
  let lastWasSpace = true; // trims leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SPACE.test(ch)) {
      if (!lastWasSpace) {
        out += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    if (ch === '­' || ch === '‌' || ch === '‍' || ch === '﻿') continue; // soft hyphen, joiners
    const rep = CHAR_MAP[ch] ?? ch.toLowerCase();
    for (const r of rep) {
      out += r;
      map.push(i);
    }
    lastWasSpace = false;
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { norm: out, map };
}

export function normalize(text) {
  return normalizeWithMap(text).norm;
}

/** Trim stray quote marks and punctuation an AI may wrap around a quoted phrase. */
export function cleanPhrase(phrase) {
  return String(phrase || '')
    .trim()
    .replace(/^["'‘’“”\s]+|["'‘’“”\s]+$/g, '')
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, '')
    .trim();
}

/**
 * Find `phrase` in `source` (both raw). Returns { start, end, text } in original coordinates of
 * `source`, or null when the phrase is not really there. Pass a precomputed normalizeWithMap(source)
 * as `prepared` when searching the same source many times.
 */
export function findVerbatim(source, phrase, prepared, fromIndex = 0) {
  const target = normalize(cleanPhrase(phrase));
  if (!target) return null;
  const { norm, map } = prepared || normalizeWithMap(source);
  let from = 0;
  if (fromIndex > 0) {
    from = map.findIndex((orig) => orig >= fromIndex);
    if (from < 0) return null;
  }
  const at = norm.indexOf(target, from);
  if (at < 0) return null;
  const start = map[at];
  const end = map[at + target.length - 1] + 1;
  return { start, end, text: source.slice(start, end) };
}
