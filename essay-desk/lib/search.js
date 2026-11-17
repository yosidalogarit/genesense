// Search providers. Academic search works with no keys (OpenAlex, then Crossref as a fallback);
// editorial/web search needs at least one of TAVILY_API_KEY, BRAVE_API_KEY or GUARDIAN_API_KEY.
import { classifyUrl, canonicalUrl, hostOf, EDITORIAL_FREE } from './domains.js';

const UA = 'EssayDesk/0.1 (student research tool)';

export function searchInfo(env = process.env) {
  return {
    academic: ['openalex', 'crossref'],
    editorial: [
      env.TAVILY_API_KEY && 'tavily',
      env.BRAVE_API_KEY && 'brave',
      env.GUARDIAN_API_KEY && 'guardian',
    ].filter(Boolean),
  };
}

async function getJSON(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout || 20_000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const clip = (s, n = 420) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, '')}…` : t;
};
const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ---------------- Academic ----------------

function invertedIndexToText(index) {
  if (!index) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(' ');
}

export async function openAlex(query, { limit = 6, env = process.env } = {}) {
  const params = new URLSearchParams({
    search: query,
    'per-page': String(limit),
    filter: 'has_abstract:true,from_publication_date:2010-01-01,type:article|review|book-chapter',
    select: 'id,doi,display_name,publication_year,authorships,primary_location,open_access,best_oa_location,abstract_inverted_index,cited_by_count',
  });
  if (env.OPENALEX_API_KEY) params.set('api_key', env.OPENALEX_API_KEY);
  if (env.CONTACT_EMAIL) params.set('mailto', env.CONTACT_EMAIL);
  const data = await getJSON(`https://api.openalex.org/works?${params}`);
  return (data.results || []).map((w) => {
    const abstract = invertedIndexToText(w.abstract_inverted_index);
    const oa = w.best_oa_location || {};
    const landing = oa.landing_page_url || w.primary_location?.landing_page_url || w.doi || w.id;
    return {
      provider: 'OpenAlex',
      kind: 'academic',
      title: w.display_name || 'Untitled',
      url: landing,
      doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : null,
      pdfUrl: oa.pdf_url || null,
      openAccess: Boolean(w.open_access?.is_oa),
      authors: (w.authorships || []).slice(0, 4).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year || null,
      source: w.primary_location?.source?.display_name || hostOf(landing),
      snippet: clip(abstract),
      abstract,
      citedBy: w.cited_by_count || 0,
    };
  });
}

export async function crossref(query, { limit = 6, env = process.env } = {}) {
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(limit),
    filter: 'has-abstract:true,from-pub-date:2010-01-01',
    select: 'DOI,URL,title,author,container-title,issued,abstract,is-referenced-by-count,link',
  });
  if (env.CONTACT_EMAIL) params.set('mailto', env.CONTACT_EMAIL);
  const data = await getJSON(`https://api.crossref.org/works?${params}`);
  return (data.message?.items || []).map((it) => {
    const abstract = stripTags(it.abstract).replace(/^\s*abstract\s*/i, '').replace(/\s+/g, ' ').trim();
    const pdf = (it.link || []).find((l) => l['content-type'] === 'application/pdf')?.URL || null;
    return {
      provider: 'Crossref',
      kind: 'academic',
      title: (it.title || ['Untitled'])[0],
      url: it.URL || `https://doi.org/${it.DOI}`,
      doi: it.DOI,
      pdfUrl: pdf,
      openAccess: false,
      authors: (it.author || []).slice(0, 4).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      year: it.issued?.['date-parts']?.[0]?.[0] || null,
      source: (it['container-title'] || [])[0] || 'Crossref',
      snippet: clip(abstract),
      abstract,
      citedBy: it['is-referenced-by-count'] || 0,
    };
  });
}

// ---------------- Editorial / web ----------------

function webResult(provider, { title, url, snippet, published, source }) {
  const c = classifyUrl(url);
  return {
    provider,
    kind: c.kind,
    paywall: c.paywall,
    title: title || url,
    url,
    source: source || c.host,
    snippet: clip(stripTags(snippet)),
    year: published ? Number(String(published).slice(0, 4)) || null : null,
    published: published || null,
    authors: [],
  };
}

export async function tavily(query, { limit = 8, editorialOnly = true, env = process.env } = {}) {
  const body = { query, max_results: limit, search_depth: 'basic', topic: 'general' };
  if (editorialOnly) body.include_domains = EDITORIAL_FREE;
  const data = await getJSON('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (data.results || []).map((r) => webResult('Tavily', { title: r.title, url: r.url, snippet: r.content, published: r.published_date }));
}

export async function brave(query, { limit = 8, env = process.env } = {}) {
  const params = new URLSearchParams({ q: query, count: String(limit), safesearch: 'strict' });
  const data = await getJSON(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'X-Subscription-Token': env.BRAVE_API_KEY },
  });
  return (data.web?.results || []).map((r) => webResult('Brave', { title: stripTags(r.title), url: r.url, snippet: r.description, published: r.page_age, source: r.profile?.name }));
}

export async function guardian(query, { limit = 6, env = process.env } = {}) {
  const params = new URLSearchParams({
    q: query,
    'api-key': env.GUARDIAN_API_KEY,
    'page-size': String(limit),
    'order-by': 'relevance',
    'show-fields': 'trailText,byline',
    'from-date': '2012-01-01',
  });
  const data = await getJSON(`https://content.guardianapis.com/search?${params}`);
  return (data.response?.results || []).map((r) => {
    const res = webResult('Guardian', {
      title: r.webTitle,
      url: r.webUrl,
      snippet: r.fields?.trailText,
      published: r.webPublicationDate,
      source: `The Guardian${r.pillarName === 'Opinion' ? ' · Opinion' : ` · ${r.sectionName}`}`,
    });
    res.kind = 'editorial';
    res.authors = r.fields?.byline ? [r.fields.byline] : [];
    return res;
  });
}

// ---------------- Orchestration ----------------

async function academicFor(query, env) {
  try {
    return await openAlex(query, { env });
  } catch (error) {
    // OpenAlex shares a daily budget per IP when no key is set; Crossref has no such limit.
    const results = await crossref(query, { env });
    results.warning = `OpenAlex unavailable (${error.message}); used Crossref.`;
    return results;
  }
}

async function editorialFor(query, env) {
  const jobs = [];
  if (env.TAVILY_API_KEY) jobs.push(tavily(query, { env }));
  if (env.BRAVE_API_KEY) jobs.push(brave(query, { env }));
  if (env.GUARDIAN_API_KEY) jobs.push(guardian(query, { env }));
  const settled = await Promise.allSettled(jobs);
  const out = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
  out.warnings = settled.filter((s) => s.status === 'rejected').map((s) => s.reason.message);
  return out;
}

/** Interleave lists so the first results of every query come before the tail of any one query. */
function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

export async function runSearch({ academic = [], editorial = [] }, env = process.env) {
  const warnings = [];
  const academicLists = await Promise.all(academic.slice(0, 6).map(async (q) => {
    try {
      const r = await academicFor(q, env);
      if (r.warning) warnings.push(r.warning);
      return r.map((x) => ({ ...x, query: q }));
    } catch (error) {
      warnings.push(`Academic search failed for “${q}”: ${error.message}`);
      return [];
    }
  }));
  const editorialLists = searchInfo(env).editorial.length
    ? await Promise.all(editorial.slice(0, 6).map(async (q) => {
      const r = await editorialFor(q, env);
      warnings.push(...r.warnings.map((w) => `Web search issue for “${q}”: ${w}`));
      return r.map((x) => ({ ...x, query: q }));
    }))
    : [];
  const seen = new Set();
  const results = [];
  for (const r of interleave([...academicLists, ...editorialLists].filter((l) => l.length))) {
    const key = r.doi ? `doi:${r.doi.toLowerCase()}` : canonicalUrl(r.url);
    const titleKey = `t:${r.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (seen.has(key) || seen.has(titleKey)) continue;
    seen.add(key);
    seen.add(titleKey);
    results.push({ id: hashId(key), ...r });
  }
  return { results, warnings: [...new Set(warnings)] };
}

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `r${(h >>> 0).toString(36)}`;
}
