import { db, uid, hash, listProjects, saveProject, deleteProject, exportAll, importAll } from './store.js';
import { fullText, selectionOffsets, wrapRange, unwrap, paintHighlights, flashPhrase, locate } from './highlighter.js';
import { normalize } from './textmatch.js';

// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms = 400) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

const COLORS = {
  yellow: 'Argument',
  green: 'Evidence',
  blue: 'Language',
  pink: 'Counter-argument',
};
const PHRASE_TYPES = [
  ['claim', 'Key claims', 'yellow'],
  ['evidence', 'Evidence & data', 'green'],
  ['academic', 'Academic frames', 'blue'],
  ['collocation', 'Collocations', 'blue'],
  ['topic', 'Topic vocabulary', 'blue'],
];

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const yearOf = (a) => a.result?.year || (a.published ? String(a.published).slice(0, 4) : null);

function citation(a) {
  const authors = a.result?.authors?.length ? a.result.authors.join(', ') : (a.byline || a.siteName || hostOf(a.url));
  const year = yearOf(a) || 'n.d.';
  const source = a.result?.source || a.siteName || hostOf(a.url);
  const link = a.result?.doi ? `https://doi.org/${a.result.doi}` : a.url;
  return `${authors} (${year}). ${a.title}. ${source}. ${link}`;
}

async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Could not copy. Select the text and copy it manually.', 'error');
  }
}

function download(name, text, type = 'text/markdown') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const slug = (s) => String(s || 'essay').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'essay';

// ---------------------------------------------------------------- state

const state = {
  config: { ai: null, search: { academic: [], editorial: [] } },
  projects: [],
  project: null,
  article: null, // the article open in the reader
  articles: [], // all articles of the project (for visited markers and notebook sources)
  highlights: [], // all highlights of the project
  filter: 'all',
  tab: 'highlights',
  hlScope: 'article',
  hlColors: new Set(Object.keys(COLORS)),
  busy: { analyze: false, search: false, phrases: false },
  loadToken: 0,
  selection: null,
  popFor: null,
};

const bodyEl = () => $('#article-body');

// ---------------------------------------------------------------- projects

function blankProject() {
  const now = Date.now();
  return { id: uid('p'), title: 'New prompt', prompt: '', analysis: null, queries: { academic: [], editorial: [] }, results: [], warnings: [], notes: '', createdAt: now, updatedAt: now, lastArticleId: null };
}

async function loadProject(id) {
  const project = await db.get('projects', id);
  if (!project) return;
  state.project = project;
  localStorage.setItem('essay-desk:last', id);
  const [articles, highlights] = await Promise.all([db.byIndex('articles', 'projectId', id), db.byIndex('highlights', 'projectId', id)]);
  state.articles = articles;
  state.highlights = highlights.sort((a, b) => a.createdAt - b.createdAt);
  state.article = project.lastArticleId ? articles.find((a) => a.id === project.lastArticleId) || null : null;
  renderProjectSelect();
  renderResearch();
  renderReader();
  renderNotebook();
}

async function refreshProjects() {
  state.projects = await listProjects();
  renderProjectSelect();
}

function renderProjectSelect() {
  const sel = $('#project-select');
  const list = state.projects.some((p) => p.id === state.project?.id) ? state.projects : [state.project, ...state.projects].filter(Boolean);
  sel.innerHTML = list.map((p) => `<option value="${esc(p.id)}" ${p.id === state.project?.id ? 'selected' : ''}>${esc(p.title || 'Untitled')}</option>`).join('');
}

async function persistProject() {
  await saveProject(state.project);
  await refreshProjects();
}

// ---------------------------------------------------------------- research pane

function renderResearch() {
  const p = state.project;
  const root = $('#research');
  if (!p.prompt) {
    root.innerHTML = `
      <div class="compose">
        <h1>What is the writing prompt?</h1>
        <p class="lede">Paste the whole task, including any quotation, passage or data. Essay Desk works out the debate and finds academic research and editorials on it.</p>
        <div class="chatbox">
          <textarea id="prompt-input" placeholder="e.g. “In many countries, young people are increasingly choosing vocational training over university…” — paste the full prompt here" aria-label="Writing prompt"></textarea>
          <div class="chatbox-foot">
            <span class="hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to send</span>
            <button class="btn" id="analyze-btn">Find sources</button>
          </div>
        </div>
        ${state.config.ai ? '' : '<div class="notice info">AI is off, so queries come from keyword extraction. You can edit them before searching. Add a free Gemini key in <code>.env</code> for better queries and phrase lists.</div>'}
      </div>`;
    const ta = $('#prompt-input');
    ta.value = p.draft || '';
    ta.focus();
    ta.addEventListener('input', debounce(() => { p.draft = ta.value; saveProject(p); }, 600));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) analyze(); });
    $('#analyze-btn').addEventListener('click', analyze);
    return;
  }

  const a = p.analysis;
  const visited = new Set(state.articles.map((x) => x.resultId).filter(Boolean));
  const saved = new Set(state.articles.filter((x) => x.saved).map((x) => x.resultId || x.id));
  const results = p.results || [];
  const counts = { all: results.length, academic: 0, editorial: 0, saved: 0 };
  for (const r of results) {
    if (r.kind === 'academic') counts.academic++;
    else counts.editorial++;
    if (saved.has(r.id)) counts.saved++;
  }
  const shown = results.filter((r) => state.filter === 'all'
    || (state.filter === 'academic' && r.kind === 'academic')
    || (state.filter === 'editorial' && r.kind !== 'academic')
    || (state.filter === 'saved' && saved.has(r.id)));

  root.innerHTML = `
    <div class="prompt-bubble" id="prompt-bubble" title="Click to expand">${esc(p.prompt)}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:4px"><button class="btn link" id="edit-prompt">Edit prompt</button></div>

    ${a ? `
    <div class="section">
      <div class="section-head"><h2>The debate</h2>${a.source === 'keywords' ? '<span class="hint">keyword extraction</span>' : ''}</div>
      <p class="analysis-topic">${esc(a.topic)}</p>
      <p class="analysis-meta">${a.task_type ? `<strong>${esc(a.task_type)}.</strong> ` : ''}${esc(a.summary || '')}</p>
      <div>${(a.key_issues || []).map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>
      ${a.warning ? `<div class="notice">${esc(a.warning)}</div>` : ''}
    </div>` : ''}

    <div class="section">
      <div class="section-head"><h2>Search queries</h2><span class="hint">click a query to edit</span></div>
      ${queryGroup('academic', 'Academic research', `${state.config.search.academic.join(' / ') || 'OpenAlex'}`)}
      ${queryGroup('editorial', 'Editorials & journalism', state.config.search.editorial.length ? state.config.search.editorial.join(' / ') : 'needs a search key')}
      <button class="btn" id="search-btn" ${state.busy.search ? 'disabled' : ''}>${state.busy.search ? '<span class="spinner"></span> Searching…' : (results.length ? 'Search again' : 'Search sources')}</button>
      ${!state.config.search.editorial.length ? '<div class="notice info">Editorial search is off. Add a free <strong>Tavily</strong> or <strong>Guardian</strong> API key to <code>.env</code> to find op-eds and journalism. You can still paste any article link below.</div>' : ''}
    </div>

    <div class="section">
      <div class="section-head"><h2>Sources</h2></div>
      <form class="open-link" id="open-link">
        <input type="url" id="open-url" placeholder="Paste any article or PDF link to open it" aria-label="Article link" required>
        <button class="btn ghost" type="submit">Open</button>
      </form>
      ${(p.warnings || []).map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
      ${results.length ? `
      <div class="filters" role="group" aria-label="Filter sources">
        ${['all', 'academic', 'editorial', 'saved'].map((f) => `<button data-filter="${f}" aria-pressed="${state.filter === f}">${f[0].toUpperCase() + f.slice(1)} ${counts[f]}</button>`).join('')}
      </div>
      <div id="results">
        ${shown.map((r) => resultCard(r, visited.has(r.id), saved.has(r.id))).join('') || '<div class="empty">Nothing here yet.</div>'}
      </div>` : (state.busy.search ? '<div class="empty"><span class="spinner"></span> Looking for sources…</div>' : '<div class="empty">Run a search to see sources.</div>')}
    </div>`;

  $('#prompt-bubble').addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
  $('#edit-prompt').addEventListener('click', () => {
    p.draft = p.prompt;
    p.prompt = '';
    persistProject().then(renderResearch);
  });
  $('#search-btn').addEventListener('click', search);
  $('#open-link').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#open-url').value.trim();
    if (url) openArticle({ url, title: url, kind: 'web' });
  });
  for (const b of root.querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => { state.filter = b.dataset.filter; renderResearch(); });
  }
  bindQueryEditors(root);
  for (const card of root.querySelectorAll('.result')) {
    const r = results.find((x) => x.id === card.dataset.id);
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      openArticle(r);
    });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) openArticle(r); });
    card.querySelector('[data-act="save"]')?.addEventListener('click', () => toggleSaved(r));
  }
}

function queryGroup(kind, label, sourceNote) {
  const qs = state.project.queries[kind] || [];
  return `
    <div class="query-group" data-kind="${kind}">
      <div class="query-group-label"><span class="kind ${kind === 'academic' ? 'academic' : 'editorial'}">${esc(label)}</span><span class="hint">· ${esc(sourceNote)}</span></div>
      <div class="chips">
        ${qs.map((q, i) => `<span class="chip"><span contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(q)}</span><button data-del="${i}" aria-label="Remove query">×</button></span>`).join('')}
        <input class="chip-add" placeholder="+ add query" aria-label="Add ${esc(label)} query">
      </div>
    </div>`;
}

function bindQueryEditors(root) {
  for (const group of root.querySelectorAll('.query-group')) {
    const kind = group.dataset.kind;
    const list = state.project.queries[kind];
    for (const span of group.querySelectorAll('[contenteditable]')) {
      span.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } });
      span.addEventListener('blur', () => {
        const i = Number(span.dataset.i);
        const v = span.textContent.trim();
        if (!v) list.splice(i, 1);
        else list[i] = v;
        persistProject().then(renderResearch);
      });
    }
    for (const b of group.querySelectorAll('[data-del]')) {
      b.addEventListener('click', () => { list.splice(Number(b.dataset.del), 1); persistProject().then(renderResearch); });
    }
    const add = group.querySelector('.chip-add');
    add.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && add.value.trim()) {
        list.push(add.value.trim());
        persistProject().then(() => { renderResearch(); $(`.query-group[data-kind="${kind}"] .chip-add`)?.focus(); });
      }
    });
  }
}

function resultCard(r, visited, saved) {
  const kindLabel = r.kind === 'academic' ? 'Academic' : r.kind === 'editorial' ? 'Editorial' : 'Web';
  const meta = [r.authors?.slice(0, 3).join(', ') + (r.authors?.length > 3 ? ' et al.' : ''), r.year].filter(Boolean).join(' · ');
  const active = state.article?.resultId === r.id;
  return `
    <article class="result ${visited ? 'visited' : ''} ${active ? 'active' : ''}" data-id="${esc(r.id)}" tabindex="0">
      <div class="result-top">
        <span class="kind ${r.kind}">${kindLabel}</span>
        <span class="src" title="${esc(r.source || hostOf(r.url))}">${esc(r.source || hostOf(r.url))}</span>
        ${r.openAccess ? '<span class="badge oa">Open access</span>' : ''}
        ${r.paywall ? '<span class="badge pay">May be paywalled</span>' : ''}
        <span class="result-actions">
          <button class="icon-btn ${saved ? 'on' : ''}" data-act="save" title="${saved ? 'Saved' : 'Save for later'}" aria-pressed="${saved}">${saved ? '★' : '☆'}</button>
        </span>
      </div>
      <h3 class="result-title">${esc(r.title)}</h3>
      ${meta ? `<div class="result-meta">${esc(meta)}</div>` : ''}
      ${r.snippet ? `<p class="result-snippet">${esc(r.snippet)}</p>` : ''}
    </article>`;
}

async function analyze() {
  const ta = $('#prompt-input');
  const prompt = ta?.value.trim();
  if (!prompt) { toast('Paste the writing prompt first.'); return; }
  if (state.busy.analyze) return;
  state.busy.analyze = true;
  const btn = $('#analyze-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reading the prompt…';
  try {
    const analysis = await api('/api/analyze', { prompt });
    const p = state.project;
    p.prompt = prompt;
    p.draft = '';
    p.analysis = analysis;
    p.queries = { academic: analysis.academic_queries || [], editorial: analysis.editorial_queries || [] };
    p.title = analysis.topic ? analysis.topic[0].toUpperCase() + analysis.topic.slice(1) : prompt.slice(0, 60);
    await persistProject();
    state.busy.analyze = false;
    renderResearch();
    await search();
  } catch (e) {
    toast(e.message, 'error');
    state.busy.analyze = false;
    btn.disabled = false;
    btn.textContent = 'Find sources';
  }
}

async function search() {
  const p = state.project;
  if (state.busy.search) return;
  if (!p.queries.academic.length && !p.queries.editorial.length) { toast('Add at least one query.'); return; }
  state.busy.search = true;
  renderResearch();
  try {
    const { results, warnings } = await api('/api/search', p.queries);
    p.results = results;
    p.warnings = warnings;
    state.filter = 'all';
    await persistProject();
    if (!results.length) toast('No sources found. Try simpler or broader queries.');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy.search = false;
    renderResearch();
  }
}

async function toggleSaved(r) {
  const id = articleId(r.url);
  let a = state.articles.find((x) => x.id === id);
  if (!a) {
    // Save without opening: keep the search result so it can be opened later.
    a = { id, projectId: state.project.id, url: r.url, title: r.title, resultId: r.id, result: r, saved: true, stub: true, openedAt: 0 };
    state.articles.push(a);
  } else {
    a.saved = !a.saved;
  }
  await db.put('articles', a);
  renderResearch();
  if (state.article?.id === a.id) { state.article = a; renderReaderHead(); }
}

// ---------------------------------------------------------------- reader

const articleId = (url) => `${state.project.id}:${hash(canonical(url))}`;

function abstractArticle(r, reason) {
  return {
    format: 'abstract',
    title: r.title,
    byline: (r.authors || []).join(', ') || null,
    siteName: r.source,
    published: r.year ? String(r.year) : null,
    contentHtml: `<h3>Abstract</h3><p>${esc(r.abstract)}</p>`,
    text: `Abstract\n${r.abstract}`,
    url: r.url,
    kind: 'academic',
    words: r.abstract.split(/\s+/).length,
    partial: true,
    reason,
  };
}

async function fetchArticle(r) {
  const tries = [];
  if (r.kind === 'academic' && r.pdfUrl && r.openAccess) tries.push(r.pdfUrl);
  tries.push(r.url);
  let lastError = null;
  let preview = null;
  for (const url of [...new Set(tries)]) {
    try {
      const a = await api('/api/extract', { url });
      if (!a.partial) return a;
      preview = preview || a;
    } catch (e) {
      lastError = e;
    }
  }
  if (r.abstract && (!preview || preview.text.length < r.abstract.length * 1.3)) {
    return abstractArticle(r, lastError?.message || 'Only a preview of the full text was available.');
  }
  if (preview) return preview;
  throw lastError || new Error('Could not open this source.');
}

async function openArticle(r) {
  const id = articleId(r.url);
  const token = ++state.loadToken;
  setPane('reader');
  const cached = state.articles.find((x) => x.id === id);
  if (cached && !cached.stub) {
    showArticle(cached);
    return;
  }
  $('#reader').innerHTML = `
    <div class="article-head">
      <div class="article-kicker"><span class="spinner"></span> Opening ${esc(r.source || hostOf(r.url))}…</div>
      <h1 class="article-title">${esc(r.title)}</h1>
    </div>`;
  highlightActiveResult(r.id);
  try {
    const data = await fetchArticle(r);
    if (token !== state.loadToken) return;
    const a = {
      ...data,
      id,
      projectId: state.project.id,
      url: r.url,
      sourceUrl: data.url,
      title: data.title && data.title.length > 3 && !/^https?:/.test(data.title) ? data.title : r.title,
      resultId: r.id || null,
      result: r.provider ? r : null,
      saved: cached?.saved || false,
      phrases: cached?.phrases || null,
      openedAt: Date.now(),
    };
    a.stub = false;
    await db.put('articles', a);
    state.articles = state.articles.filter((x) => x.id !== id).concat(a);
    showArticle(a);
  } catch (e) {
    if (token !== state.loadToken) return;
    $('#reader').innerHTML = `
      <div class="article-head">
        <div class="article-kicker"><span class="kind ${r.kind || 'web'}">${esc(r.source || hostOf(r.url))}</span></div>
        <h1 class="article-title">${esc(r.title)}</h1>
        <div class="notice">${esc(e.message)}</div>
        <div class="article-actions"><a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Open the original ↗</a></div>
      </div>
      ${r.snippet ? `<div class="article-body"><p>${esc(r.snippet)}</p></div>` : ''}`;
  }
}

function highlightActiveResult(resultId) {
  for (const el of document.querySelectorAll('.result')) el.classList.toggle('active', el.dataset.id === resultId);
}

async function showArticle(a) {
  state.article = a;
  state.project.lastArticleId = a.id;
  saveProject(state.project);
  a.openedAt = Date.now();
  highlightActiveResult(a.resultId);
  for (const el of document.querySelectorAll('.result')) if (el.dataset.id === a.resultId) el.classList.add('visited');
  renderReader();
  renderNotebook();
  $('#reader-scroll').scrollTop = 0;
}

function renderReaderHead() {
  const a = state.article;
  const head = $('#article-head');
  if (!a || !head) return;
  const year = yearOf(a);
  const minutes = Math.max(1, Math.round((a.words || 0) / 220));
  const kind = a.kind || 'web';
  const kindLabel = a.format === 'abstract' ? 'Abstract only' : kind === 'academic' ? 'Academic' : kind === 'editorial' ? 'Editorial' : 'Web';
  head.innerHTML = `
    <div class="article-kicker">
      <span class="kind ${kind}">${kindLabel}</span>
      <span>${esc(a.result?.source || a.siteName || hostOf(a.url))}</span>
      ${a.format === 'pdf' ? `<span class="badge">PDF${a.pages ? ` · ${a.pages} pages` : ''}</span>` : ''}
    </div>
    <h1 class="article-title">${esc(a.title)}</h1>
    <div class="article-meta">${[a.byline || a.result?.authors?.join(', '), year, a.words ? `${a.words.toLocaleString()} words · ${minutes} min read` : null].filter(Boolean).map(esc).join(' · ')}</div>
    ${a.format === 'abstract' ? `<div class="notice">Only the abstract could be shown here. ${esc(a.reason || '')} The full paper may need library access.</div>` : ''}
    ${a.partial && a.format !== 'abstract' ? '<div class="notice">This looks like only part of the article (a paywall, cookie wall or page that needs JavaScript). Open the original to read the rest.</div>' : ''}
    ${a.truncated ? '<div class="notice info">Long PDF: only the first 60 pages are shown.</div>' : ''}
    <div class="article-actions">
      <a class="btn ghost small" href="${esc(a.sourceUrl || a.url)}" target="_blank" rel="noopener noreferrer">Original ↗</a>
      <button class="btn ghost small" data-act="save">${a.saved ? '★ Saved' : '☆ Save'}</button>
      <button class="btn ghost small" data-act="cite">Copy citation</button>
      <button class="btn ghost small" data-act="phrases">Notable phrases</button>
    </div>`;
  head.querySelector('[data-act="save"]').addEventListener('click', async () => {
    a.saved = !a.saved;
    await db.put('articles', a);
    renderReaderHead();
    renderResearch();
  });
  head.querySelector('[data-act="cite"]').addEventListener('click', () => copy(citation(a), 'Citation copied'));
  head.querySelector('[data-act="phrases"]').addEventListener('click', () => {
    setTab('phrases');
    setPane('notebook');
    if (!a.phrases && state.config.ai) extractPhrases();
  });
}

function renderReader() {
  const a = state.article;
  const root = $('#reader');
  if (!a || a.stub) {
    root.innerHTML = `
      <div class="reader-empty">
        <h2>Read sources here, and mark them up as you go.</h2>
        <ol>
          <li>Paste the writing prompt on the left. Essay Desk works out the debate and searches for research and editorials.</li>
          <li>Open a source. Select any text to highlight it, add a note, or copy it as a quote with its citation.</li>
          <li>Use <strong>Notable phrases</strong> for a list of reusable language copied word for word from the article.</li>
          <li>Export everything as Markdown when you are ready to plan the essay.</li>
        </ol>
        <div class="legend">${Object.entries(COLORS).map(([c, label], i) => `<span><i class="hl-${c}"></i>${label} <kbd>${i + 1}</kbd></span>`).join('')}</div>
      </div>`;
    return;
  }
  root.innerHTML = `<header class="article-head" id="article-head"></header><div class="article-body" id="article-body"></div>`;
  renderReaderHead();
  const body = bodyEl();
  body.innerHTML = a.contentHtml || '';
  const mine = state.highlights.filter((h) => h.articleId === a.id);
  const repaired = paintHighlights(body, mine);
  for (const r of repaired) {
    Object.assign(state.highlights.find((h) => h.id === r.id), r);
    db.put('highlights', r);
  }
}

// ---------------------------------------------------------------- selection & highlights

function showToolbar() {
  const body = bodyEl();
  if (!body) return hideToolbar();
  const sel = selectionOffsets(body);
  if (!sel) return hideToolbar();
  state.selection = sel;
  const tb = $('#sel-toolbar');
  tb.hidden = false;
  const w = tb.offsetWidth;
  const h = tb.offsetHeight;
  let top = sel.rect.top - h - 10;
  if (top < 60) top = sel.rect.bottom + 10;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, sel.rect.left + sel.rect.width / 2 - w / 2));
  tb.style.top = `${top}px`;
  tb.style.left = `${left}px`;
}

function hideToolbar() {
  $('#sel-toolbar').hidden = true;
  state.selection = null;
}

async function addHighlight(color, { withNote = false, start, end, text } = {}) {
  const a = state.article;
  const sel = start != null ? { start, end, text } : state.selection;
  if (!a || !sel) return null;
  const h = { id: uid('h'), projectId: state.project.id, articleId: a.id, start: sel.start, end: sel.end, text: sel.text, color, note: '', createdAt: Date.now() };
  state.highlights.push(h);
  await db.put('highlights', h);
  wrapRange(bodyEl(), h.start, h.end, { className: `hl hl-${color}`, id: h.id });
  window.getSelection()?.removeAllRanges();
  hideToolbar();
  renderNotebook();
  if (withNote) {
    const mark = bodyEl().querySelector(`mark[data-id="${h.id}"]`);
    if (mark) openPopover(h.id, mark);
  }
  return h;
}

function repaintHighlight(h) {
  const body = bodyEl();
  if (!body || state.article?.id !== h.articleId) return;
  unwrap(body, `mark[data-id="${h.id}"]`);
  wrapRange(body, h.start, h.end, { className: `hl hl-${h.color}${h.note ? ' has-note' : ''}`, id: h.id });
}

async function updateHighlight(id, patch, { repaint = true, notebook = true } = {}) {
  const h = state.highlights.find((x) => x.id === id);
  if (!h) return;
  Object.assign(h, patch);
  await db.put('highlights', h);
  if (repaint) repaintHighlight(h);
  else {
    for (const m of document.querySelectorAll(`mark[data-id="${id}"]`)) m.classList.toggle('has-note', Boolean(h.note));
  }
  if (notebook) renderNotebook();
}

async function removeHighlight(id) {
  state.highlights = state.highlights.filter((x) => x.id !== id);
  await db.delete('highlights', id);
  if (bodyEl()) unwrap(bodyEl(), `mark[data-id="${id}"]`);
  closePopover();
  renderNotebook();
}

function openPopover(id, mark) {
  const h = state.highlights.find((x) => x.id === id);
  if (!h) return;
  state.popFor = id;
  const pop = $('#hl-pop');
  pop.hidden = false;
  for (const s of pop.querySelectorAll('.swatch')) s.classList.toggle('current', s.dataset.color === h.color);
  const note = $('#hl-pop-note');
  note.value = h.note || '';
  const rect = mark.getBoundingClientRect();
  const w = pop.offsetWidth;
  let top = rect.bottom + 8;
  if (top + pop.offsetHeight > window.innerHeight - 10) top = rect.top - pop.offsetHeight - 8;
  pop.style.top = `${Math.max(60, top)}px`;
  pop.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, rect.left))}px`;
  if (!h.note) note.focus();
}

function closePopover() {
  $('#hl-pop').hidden = true;
  state.popFor = null;
}

function quoteWithCitation(text, a) {
  const authorish = a.result?.authors?.[0]?.split(' ').pop() || a.byline?.split(/,| and /)[0]?.split(' ').pop() || a.siteName || hostOf(a.url);
  return `“${text.replace(/\s+/g, ' ').trim()}” (${authorish}, ${yearOf(a) || 'n.d.'})\n— ${citation(a)}`;
}

function bindReaderEvents() {
  const scroller = $('#reader-scroll');
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#sel-toolbar, #hl-pop')) return;
    setTimeout(() => {
      if (bodyEl()?.contains(e.target) || state.selection) showToolbar();
    }, 0);
  });
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey && bodyEl() && document.activeElement === document.body) showToolbar();
  });
  document.addEventListener('selectionchange', debounce(() => {
    // Touch devices: selection handles do not fire mouseup.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && bodyEl()?.contains(sel.anchorNode)) showToolbar();
    else if (!$('#sel-toolbar').matches(':hover')) hideToolbar();
  }, 250));
  scroller.addEventListener('scroll', () => { hideToolbar(); closePopover(); }, { passive: true });

  $('#sel-toolbar').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  $('#sel-toolbar').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) { addHighlight(sw.dataset.color); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'note') addHighlight('yellow', { withNote: true });
    if (act === 'cite' && state.selection) {
      copy(quoteWithCitation(state.selection.text, state.article), 'Quote with citation copied');
      hideToolbar();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideToolbar(); closePopover(); return; }
    if (!state.selection || $('#sel-toolbar').hidden) return;
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    const color = Object.keys(COLORS)[Number(e.key) - 1];
    if (color) { e.preventDefault(); addHighlight(color); }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addHighlight('yellow', { withNote: true }); }
  });

  $('#reader').addEventListener('click', (e) => {
    const mark = e.target.closest('mark.hl');
    if (!mark || !window.getSelection().isCollapsed) return;
    openPopover(mark.dataset.id, mark);
  });
  $('#hl-pop').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw && state.popFor) {
      updateHighlight(state.popFor, { color: sw.dataset.color });
      for (const s of $('#hl-pop').querySelectorAll('.swatch')) s.classList.toggle('current', s === sw);
    }
    if (e.target.closest('[data-act="delete"]') && state.popFor) removeHighlight(state.popFor);
  });
  const saveNote = debounce((id, value) => updateHighlight(id, { note: value }, { repaint: false }), 450);
  $('#hl-pop-note').addEventListener('input', (e) => { if (state.popFor) saveNote(state.popFor, e.target.value); });
  document.addEventListener('mousedown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop, mark.hl')) closePopover();
  });
}

// ---------------------------------------------------------------- notebook

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  renderNotebook();
}

function renderNotebook() {
  const root = $('#notebook');
  const articleCount = state.article ? state.highlights.filter((h) => h.articleId === state.article.id).length : 0;
  $('#hl-count').textContent = state.highlights.length ? (state.article ? `${articleCount}/${state.highlights.length}` : state.highlights.length) : '';
  if (state.tab === 'highlights') renderHighlightsTab(root);
  else if (state.tab === 'phrases') renderPhrasesTab(root);
  else renderNotesTab(root);
}

function renderHighlightsTab(root) {
  const scope = state.article ? state.hlScope : 'project';
  const list = state.highlights
    .filter((h) => (scope === 'project' || h.articleId === state.article.id) && state.hlColors.has(h.color))
    .sort((a, b) => (scope === 'article' ? a.start - b.start : a.createdAt - b.createdAt));
  const titleOf = (id) => state.articles.find((x) => x.id === id)?.title || 'Source';
  root.innerHTML = `
    <div class="nb-bar">
      <div class="seg" role="group" aria-label="Scope">
        <button data-scope="article" aria-pressed="${scope === 'article'}" ${state.article ? '' : 'disabled'}>This source</button>
        <button data-scope="project" aria-pressed="${scope === 'project'}">All sources</button>
      </div>
      <div class="color-filter" role="group" aria-label="Filter by colour">
        ${Object.entries(COLORS).map(([c, label]) => `<button class="hl-${c}" data-color="${c}" aria-pressed="${state.hlColors.has(c)}" title="${label}"></button>`).join('')}
      </div>
    </div>
    ${list.length ? list.map((h) => `
      <div class="hl-item c-${h.color}" data-id="${h.id}">
        <p class="hl-quote" data-act="jump">${esc(h.text)}</p>
        <div class="hl-src">${COLORS[h.color]}${scope === 'project' ? ` · ${esc(titleOf(h.articleId))}` : ''}</div>
        <textarea class="hl-note" rows="1" placeholder="Add a note…">${esc(h.note || '')}</textarea>
        <div class="hl-tools">
          <button class="btn link" data-act="quote">Copy quote</button>
          <button class="btn link" data-act="delete">Remove</button>
        </div>
      </div>`).join('') : `<div class="empty">${state.article ? 'Select text in the article to highlight it.' : 'Open a source to start highlighting.'}</div>`}`;

  for (const b of root.querySelectorAll('[data-scope]')) b.addEventListener('click', () => { state.hlScope = b.dataset.scope; renderNotebook(); });
  for (const b of root.querySelectorAll('.color-filter [data-color]')) {
    b.addEventListener('click', () => {
      const c = b.dataset.color;
      if (state.hlColors.has(c) && state.hlColors.size > 1) state.hlColors.delete(c);
      else state.hlColors.add(c);
      renderNotebook();
    });
  }
  for (const item of root.querySelectorAll('.hl-item')) {
    const id = item.dataset.id;
    const h = state.highlights.find((x) => x.id === id);
    const note = item.querySelector('.hl-note');
    const grow = () => { note.style.height = 'auto'; note.style.height = `${note.scrollHeight + 2}px`; };
    grow();
    const save = debounce(() => updateHighlight(id, { note: note.value }, { repaint: false, notebook: false }), 450);
    note.addEventListener('input', () => { grow(); save(); });
    item.querySelector('[data-act="jump"]').addEventListener('click', async () => {
      if (state.article?.id !== h.articleId) {
        const a = state.articles.find((x) => x.id === h.articleId);
        if (!a) return;
        await showArticle(a);
      }
      setPane('reader');
      const mark = bodyEl()?.querySelector(`mark[data-id="${id}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.animate([{ outline: '3px solid rgba(15,92,99,0.6)' }, { outline: '3px solid transparent' }], { duration: 1400 });
      }
    });
    item.querySelector('[data-act="quote"]').addEventListener('click', () => {
      const a = state.articles.find((x) => x.id === h.articleId);
      copy(a ? quoteWithCitation(h.text, a) : h.text, 'Quote with citation copied');
    });
    item.querySelector('[data-act="delete"]').addEventListener('click', () => removeHighlight(id));
  }
}

function renderPhrasesTab(root) {
  const a = state.article;
  if (!a || a.stub) {
    root.innerHTML = '<div class="empty">Open a source to pull out its notable phrases.</div>';
    return;
  }
  if (!state.config.ai) {
    root.innerHTML = `<div class="notice info">Notable phrases need an AI key. Add <code>GEMINI_API_KEY</code> (free from Google AI Studio) or <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart the app.</div>`;
    return;
  }
  if (state.busy.phrases) {
    root.innerHTML = '<div class="empty"><span class="spinner"></span> Reading the article and copying out phrases…</div>';
    return;
  }
  if (!a.phrases) {
    root.innerHTML = `
      <p class="hint" style="margin-top:0">A list of reusable language copied word for word from this source: key claims, evidence, academic frames, collocations and topic vocabulary. Every phrase is checked against the text, so nothing is paraphrased.</p>
      <button class="btn" id="phrases-btn">Extract notable phrases</button>`;
    $('#phrases-btn').addEventListener('click', extractPhrases);
    return;
  }
  const marked = new Set(state.highlights.filter((h) => h.articleId === a.id).map((h) => normalize(h.text)));
  const groups = PHRASE_TYPES.map(([type, label, color]) => ({ type, label, color, items: a.phrases.list.filter((p) => p.type === type) })).filter((g) => g.items.length);
  root.innerHTML = `
    <div class="nb-bar">
      <button class="btn ghost small" data-act="all">Highlight all</button>
      <button class="btn ghost small" data-act="copy">Copy list</button>
      <button class="btn link" data-act="again" style="margin-left:auto">Regenerate</button>
    </div>
    ${a.phrases.dropped ? `<p class="hint">${a.phrases.dropped} suggestion${a.phrases.dropped > 1 ? 's were' : ' was'} dropped because ${a.phrases.dropped > 1 ? 'they were' : 'it was'} not word for word in the text.</p>` : ''}
    ${a.phrases.truncated ? '<p class="hint">Long source: phrases come from the first part only.</p>' : ''}
    ${groups.map((g) => `
      <div class="phrase-group">
        <h3>${g.label}</h3>
        ${g.items.map((p) => `
          <div class="phrase ${marked.has(normalize(p.text)) ? 'done' : ''}" data-text="${esc(p.text)}" data-color="${g.color}" title="Show in article">
            <span class="ph-text">${esc(p.text)}</span>
            <button class="icon-btn ph-add" data-act="mark" title="Highlight as ${COLORS[g.color]}">＋</button>
          </div>`).join('')}
      </div>`).join('') || '<div class="empty">No phrases could be verified. Try Regenerate.</div>'}`;

  for (const el of root.querySelectorAll('.phrase')) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="mark"]')) { markPhrase(el.dataset.text, el.dataset.color); return; }
      setPane('reader');
      if (!flashPhrase(bodyEl(), el.dataset.text)) toast('Could not find that phrase in the reader.');
    });
  }
  root.querySelector('[data-act="again"]').addEventListener('click', extractPhrases);
  root.querySelector('[data-act="copy"]').addEventListener('click', () => {
    const text = groups.map((g) => `${g.label}\n${g.items.map((p) => `- ${p.text}`).join('\n')}`).join('\n\n');
    copy(`${a.title}\n${citation(a)}\n\n${text}`, 'Phrase list copied');
  });
  root.querySelector('[data-act="all"]').addEventListener('click', async () => {
    let n = 0;
    for (const g of groups) for (const p of g.items) if (await markPhrase(p.text, g.color, { quiet: true })) n++;
    renderNotebook();
    toast(n ? `Highlighted ${n} phrase${n > 1 ? 's' : ''}` : 'All phrases are already highlighted');
  });
}

async function markPhrase(text, color, { quiet = false } = {}) {
  const body = bodyEl();
  if (!body) return false;
  if (state.highlights.some((h) => h.articleId === state.article.id && normalize(h.text) === normalize(text))) return false;
  const hit = locate(body, text);
  if (!hit) { if (!quiet) toast('Could not find that phrase in the reader.'); return false; }
  await addHighlight(color, hit);
  return true;
}

async function extractPhrases() {
  const a = state.article;
  const body = bodyEl();
  if (!a || !body || state.busy.phrases) return;
  state.busy.phrases = true;
  renderNotebook();
  try {
    const res = await api('/api/phrases', { text: fullText(body), title: a.title, topic: state.project.analysis?.topic || '' });
    a.phrases = { list: res.phrases, dropped: res.dropped, truncated: res.truncated, at: Date.now() };
    await db.put('articles', a);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy.phrases = false;
    if (state.article === a) renderNotebook();
  }
}

function renderNotesTab(root) {
  root.innerHTML = `
    <div class="nb-bar"><span class="hint">Your plan for this essay. Saved automatically.</span><span class="saved-flag" id="saved-flag" style="margin-left:auto"></span></div>
    <textarea class="notes-area" id="notes-area" placeholder="Thesis:\n\nBody 1 (argument + evidence):\n\nBody 2:\n\nCounter-argument & rebuttal:\n\nUseful phrases:"></textarea>`;
  const ta = $('#notes-area');
  ta.value = state.project.notes || '';
  const save = debounce(async () => {
    state.project.notes = ta.value;
    await saveProject(state.project);
    $('#saved-flag').textContent = 'Saved';
  }, 500);
  ta.addEventListener('input', () => { $('#saved-flag').textContent = '…'; save(); });
}

// ---------------------------------------------------------------- export

function buildMarkdown() {
  const p = state.project;
  const lines = [`# ${p.title}`, '', `_Exported from Essay Desk on ${new Date().toLocaleString()}_`, '', '## Prompt', '', ...p.prompt.split('\n').map((l) => `> ${l}`), ''];
  if (p.analysis) {
    lines.push('## The debate', '', `**${p.analysis.topic}** — ${p.analysis.task_type || ''}`, '', p.analysis.summary || '', '');
    if (p.analysis.key_issues?.length) lines.push(...p.analysis.key_issues.map((k) => `- ${k}`), '');
  }
  if (p.notes?.trim()) lines.push('## My notes', '', p.notes.trim(), '');
  const used = state.articles.filter((a) => !a.stub && (a.saved || state.highlights.some((h) => h.articleId === a.id) || a.phrases));
  if (used.length) {
    lines.push('## Sources', '');
    for (const a of used) {
      lines.push(`### ${a.title}`, '', `${citation(a)}`, '');
      const hls = state.highlights.filter((h) => h.articleId === a.id).sort((x, y) => x.start - y.start);
      for (const [color, label] of Object.entries(COLORS)) {
        const group = hls.filter((h) => h.color === color);
        if (!group.length) continue;
        lines.push(`**${label}**`, '');
        for (const h of group) {
          lines.push(`- “${h.text.replace(/\s+/g, ' ').trim()}”`);
          if (h.note?.trim()) lines.push(`  - _Note:_ ${h.note.trim().replace(/\n+/g, ' ')}`);
        }
        lines.push('');
      }
      if (a.phrases?.list?.length) {
        lines.push('**Notable phrases**', '');
        for (const [type, label] of PHRASE_TYPES) {
          const items = a.phrases.list.filter((x) => x.type === type);
          if (items.length) lines.push(`- _${label}:_ ${items.map((x) => `“${x.text}”`).join(' · ')}`);
        }
        lines.push('');
      }
    }
  }
  const savedOnly = state.articles.filter((a) => a.stub && a.saved);
  if (savedOnly.length) {
    lines.push('## Saved to read later', '', ...savedOnly.map((a) => `- [${a.title}](${a.url})`), '');
  }
  return lines.join('\n');
}

async function handleMenu(action) {
  $('#export-menu').hidden = true;
  $('#export-btn').setAttribute('aria-expanded', 'false');
  if (action === 'export-md') {
    if (!state.project.prompt) { toast('Nothing to export yet.'); return; }
    download(`${slug(state.project.title)}.md`, buildMarkdown());
  } else if (action === 'backup') {
    download(`essay-desk-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()), 'application/json');
  } else if (action === 'restore') {
    $('#restore-file').click();
  } else if (action === 'delete-project') {
    if (!confirm(`Delete “${state.project.title}” with its highlights and notes? This cannot be undone.`)) return;
    await deleteProject(state.project.id);
    await refreshProjects();
    if (state.projects.length) await loadProject(state.projects[0].id);
    else await createProject();
    toast('Project deleted');
  }
}

// ---------------------------------------------------------------- shell

function setPane(pane) {
  $('.layout').dataset.pane = pane;
  for (const b of document.querySelectorAll('.mobile-nav button')) b.setAttribute('aria-current', String(b.dataset.pane === pane));
}

async function createProject() {
  // Reuse an untouched blank project instead of piling up empty ones.
  const blank = state.projects.find((p) => !p.prompt && !p.draft);
  if (blank) return loadProject(blank.id);
  const p = blankProject();
  await saveProject(p);
  await refreshProjects();
  await loadProject(p.id);
  setPane('research');
}

function renderStatus() {
  const c = state.config;
  const el = $('#status');
  el.innerHTML = `
    <span class="dot ${c.ai ? 'on' : ''}">AI ${c.ai ? '' : 'off'}</span>
    <span class="dot on">Academic</span>
    <span class="dot ${c.search.editorial.length ? 'on' : ''}">Editorial</span>`;
  el.title = [
    `AI: ${c.ai ? `${c.ai} (${c.aiModel})` : 'off — add GEMINI_API_KEY or ANTHROPIC_API_KEY'}`,
    `Academic: ${c.search.academic.join(', ')}`,
    `Editorial: ${c.search.editorial.join(', ') || 'off — add TAVILY_API_KEY, BRAVE_API_KEY or GUARDIAN_API_KEY'}`,
  ].join('\n');
}

async function init() {
  try {
    state.config = await api('/api/config');
  } catch {
    toast('Cannot reach the Essay Desk server. Is it running?', 'error');
  }
  renderStatus();
  await refreshProjects();
  const last = localStorage.getItem('essay-desk:last');
  const start = state.projects.find((p) => p.id === last) || state.projects[0];
  if (start) await loadProject(start.id);
  else await createProject();

  bindReaderEvents();
  $('#project-select').addEventListener('change', (e) => loadProject(e.target.value));
  $('#new-project').addEventListener('click', createProject);
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  for (const b of document.querySelectorAll('.mobile-nav button')) b.addEventListener('click', () => setPane(b.dataset.pane));
  $('#export-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#export-menu');
    menu.hidden = !menu.hidden;
    $('#export-btn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('#export-menu').hidden = true; });
  $('#export-menu').addEventListener('click', (e) => { const b = e.target.closest('[data-action]'); if (b) handleMenu(b.dataset.action); });
  $('#restore-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const n = await importAll(JSON.parse(await file.text()));
      await refreshProjects();
      toast(`Restored ${n} project${n === 1 ? '' : 's'}`);
    } catch (err) {
      toast(err.message || 'Could not read that backup.', 'error');
    }
  });
}

init();
