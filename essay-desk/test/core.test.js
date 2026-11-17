import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVerbatim, normalize, cleanPhrase } from '../public/js/textmatch.js';
import { verifyPhrases } from '../lib/phrases.js';
import { heuristicAnalysis } from '../lib/analyze.js';
import { pdfTextToParagraphs } from '../lib/extract.js';
import { classifyUrl, canonicalUrl } from '../lib/domains.js';
import { parseJSON } from '../lib/llm.js';

const ARTICLE = `Remote work has become a “double‑edged sword” for many firms.\nA 2023 study found that hybrid workers were  13% more productive — though fully remote staff reported greater isolation.\n\nIt could be argued that the office still matters.`;

test('normalize ignores typography, case and spacing', () => {
  assert.equal(normalize('  “Double‑edged”  sword—indeed '), '"double-edged" sword-indeed');
});

test('findVerbatim maps back to the exact original slice', () => {
  // Wrapping quotes are stripped from the phrase, so the match is the words inside them.
  const hit = findVerbatim(ARTICLE, '"double-edged sword"');
  assert.ok(hit);
  assert.equal(hit.text, 'double‑edged sword');
  const hit2 = findVerbatim(ARTICLE, 'hybrid workers were 13% more productive - though');
  assert.equal(hit2.text, 'hybrid workers were  13% more productive — though');
  assert.equal(findVerbatim(ARTICLE, 'more productive - though fully remote').text, 'more productive — though fully remote');
});

test('findVerbatim rejects paraphrases and phrases across missing words', () => {
  assert.equal(findVerbatim(ARTICLE, 'hybrid employees were 13% more productive'), null);
  assert.equal(findVerbatim(ARTICLE, 'the office matters'), null);
});

test('cleanPhrase strips wrapping quotes and ellipses', () => {
  assert.equal(cleanPhrase('  "…it could be argued that…" '), 'it could be argued that');
});

test('verifyPhrases keeps only verbatim phrases, in text order, deduplicated', () => {
  const out = verifyPhrases(ARTICLE, [
    { text: 'It could be argued that', type: 'academic' },
    { text: 'double-edged sword', type: 'collocation' },
    { text: 'Double-Edged Sword', type: 'collocation' },
    { text: 'remote work is a disaster', type: 'claim' },
    { text: 'greater isolation', type: 'weird-type' },
  ]);
  assert.deepEqual(out.phrases.map((p) => p.text), ['double‑edged sword', 'greater isolation', 'It could be argued that']);
  assert.equal(out.phrases[1].type, 'topic');
  assert.equal(out.dropped, 1);
});

test('heuristic analysis strips task instructions and finds topic phrases', () => {
  const r = heuristicAnalysis('Some people think that governments should impose heavy taxes on fast food to fight childhood obesity. Others believe education is more effective. Discuss both views and give your own opinion. Write at least 350 words.');
  assert.equal(r.task_type, 'discussion (both views + opinion)');
  const all = [...r.key_issues, ...r.academic_queries].join(' ');
  assert.match(all, /childhood obesity/);
  assert.match(all, /fast food/);
  assert.doesNotMatch(all, /\bopinion\b|\bwords\b|\bdiscuss\b/);
  assert.ok(r.academic_queries.length >= 2);
});

test('PDF lines are re-joined into paragraphs with hyphenation repaired', () => {
  const paras = pdfTextToParagraphs(['Introduction\n\nThis study exam-\nines how remote work\naffects output.\nWe find gains.\nMethods follow here and continue\nacross lines.\n12']);
  assert.deepEqual(paras, ['Introduction', 'This study examines how remote work affects output.', 'We find gains.', 'Methods follow here and continue across lines.']);
});

test('URLs are classified and canonicalised', () => {
  assert.deepEqual(classifyUrl('https://www.theconversation.com/x'), { kind: 'editorial', paywall: false, host: 'theconversation.com' });
  assert.equal(classifyUrl('https://www.economist.com/leaders/x').paywall, true);
  assert.equal(classifyUrl('https://link.springer.com/article/10.1/x').kind, 'academic');
  assert.equal(classifyUrl('https://example.com/blog').kind, 'web');
  assert.equal(canonicalUrl('https://www.a.com/p/?utm_source=x&id=2#top'), 'https://a.com/p/?id=2');
});

test('parseJSON tolerates code fences and surrounding prose', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSON('Here you go: {"a": [1,2]} done'), { a: [1, 2] });
  assert.throws(() => parseJSON('nope'));
});
