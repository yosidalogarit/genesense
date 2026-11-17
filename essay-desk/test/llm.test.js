import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateJSON } from '../lib/llm.js';
import { extractPhrases, salvagePhrases } from '../lib/phrases.js';

const env = { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.6-flash', GEMINI_FALLBACK_MODEL: 'gemini-3.1-flash-lite' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ok = (text, extra = {}) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...extra }] }), { status: 200 });
const schema = { type: 'object', properties: { a: { type: 'number' } } };

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { model: decodeURIComponent(url.match(/models\/([^:]+)/)[1]), body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return calls;
}

test('fast mode tries the lighter model first and asks for minimal thinking', async () => {
  const calls = mockFetch(() => ok('{"a":1}'));
  assert.deepEqual(await generateJSON({ system: 's', user: 'u', schema, fast: true, env }), { a: 1 });
  assert.equal(calls[0].model, 'gemini-3.1-flash-lite');
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('a timed-out model is skipped for the other model, not retried', async () => {
  const calls = mockFetch((c) => {
    if (c.model === 'gemini-3.6-flash') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return ok('{"a":2}');
  });
  assert.deepEqual(await generateJSON({ system: 's', user: 'u', schema, env }), { a: 2 });
  assert.deepEqual(calls.map((c) => c.model), ['gemini-3.6-flash', 'gemini-3.1-flash-lite']);
});

test('when every model times out the error says so clearly', async () => {
  mockFetch(() => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(generateJSON({ system: 's', user: 'u', schema, env }), /took too long/);
});

test('a model that rejects the thinking setting is retried without it', async () => {
  const calls = mockFetch((c) => (c.body.generationConfig.thinkingConfig
    ? new Response('{"error":{"message":"thinking_level is not supported for this model"}}', { status: 400 })
    : ok('{"a":3}')));
  assert.deepEqual(await generateJSON({ system: 's', user: 'u', schema, env }), { a: 3 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, 'gemini-3.6-flash');
});

test('thought parts are ignored', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":4}' }] } }] }), { status: 200 });
  assert.deepEqual(await generateJSON({ system: 's', user: 'u', schema, env }), { a: 4 });
});

test('salvagePhrases recovers complete items from a cut-off answer', () => {
  const cut = '{"phrases":[{"text":"a \\"quoted\\" claim","type":"claim"},{"type":"collocation","text":"double-edged sword"},{"text":"half fin';
  assert.deepEqual(salvagePhrases(cut).phrases, [
    { text: 'a "quoted" claim', type: 'claim' },
    { text: 'double-edged sword', type: 'collocation' },
  ]);
  assert.equal(salvagePhrases('nothing here'), null);
});

test('extractPhrases keeps verified phrases from a cut-off answer', async () => {
  const article = `${'Background sentence about schools. '.repeat(10)}Remote learning has widened the attainment gap between rich and poor pupils. It is a double-edged sword for teachers.`;
  process.env.GEMINI_API_KEY = 'k';
  mockFetch(() => ok('{"phrases":[{"text":"widened the attainment gap","type":"collocation"},{"text":"a double-edged sword","type":"collocation"},{"text":"invented phrase here","type":"topic"},{"text":"cut of', { finishReason: 'MAX_TOKENS' }));
  try {
    const out = await extractPhrases({ text: article });
    assert.deepEqual(out.phrases.map((p) => p.text), ['widened the attainment gap', 'a double-edged sword']);
    assert.equal(out.dropped, 1);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
