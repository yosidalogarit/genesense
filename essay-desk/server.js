import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePrompt } from './lib/analyze.js';
import { runSearch, searchInfo } from './lib/search.js';
import { extractUrl } from './lib/extract.js';
import { extractPhrases } from './lib/phrases.js';
import { llmInfo } from './lib/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const asString = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const asList = (v, n, max = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, max)).slice(0, n) : []);

app.get('/api/config', (req, res) => {
  const llm = llmInfo();
  res.json({ ai: llm.provider, aiModel: llm.models[0] || null, search: searchInfo() });
});

app.post('/api/analyze', async (req, res, next) => {
  try {
    res.json(await analyzePrompt(asString(req.body?.prompt, 12_000)));
  } catch (e) { next(e); }
});

app.post('/api/search', async (req, res, next) => {
  try {
    const academic = asList(req.body?.academic, 6);
    const editorial = asList(req.body?.editorial, 6);
    if (!academic.length && !editorial.length) return res.status(400).json({ error: 'Add at least one search query.' });
    res.json(await runSearch({ academic, editorial }));
  } catch (e) { next(e); }
});

app.post('/api/extract', async (req, res, next) => {
  try {
    const url = asString(req.body?.url, 2000).trim();
    if (!url) return res.status(400).json({ error: 'No link given.' });
    res.json(await extractUrl(url));
  } catch (e) { next(e); }
});

app.post('/api/phrases', async (req, res, next) => {
  try {
    res.json(await extractPhrases({
      text: asString(req.body?.text, 400_000),
      title: asString(req.body?.title, 400),
      topic: asString(req.body?.topic, 400),
      count: req.body?.count,
    }));
  } catch (e) { next(e); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(here, 'public'), { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on the server.' : err.message });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5178;
  const host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => {
    const llm = llmInfo();
    const s = searchInfo();
    console.log(`Essay Desk running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`  AI: ${llm.provider ? `${llm.provider} (${llm.models[0]})` : 'off — add GEMINI_API_KEY or ANTHROPIC_API_KEY for smart queries and phrase lists'}`);
    console.log(`  Academic search: ${s.academic.join(', ')}`);
    console.log(`  Editorial search: ${s.editorial.length ? s.editorial.join(', ') : 'off — add TAVILY_API_KEY, BRAVE_API_KEY or GUARDIAN_API_KEY'}`);
  });
}
