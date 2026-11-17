// Fetch a page or PDF and turn it into clean, safe reading HTML plus plain text.
import dns from 'node:dns/promises';
import net from 'node:net';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { extractText, getDocumentProxy } from 'unpdf';
import { classifyUrl, hostOf } from './domains.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_HTML = 6 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;

export class ExtractError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

const quietConsole = new VirtualConsole(); // swallow CSS/script parse noise from real-world pages
const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);

// ---------- SSRF guard: this server fetches URLs on the user's behalf ----------

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractError('That is not a valid web address.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ExtractError('Only http(s) links can be opened.', 400);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new ExtractError('Local addresses cannot be opened.', 400);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new ExtractError('Local addresses cannot be opened.', 400);
    return url;
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new ExtractError('Local addresses cannot be opened.', 400);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    // Behind an HTTPS proxy the proxy resolves names, so a local lookup failure is not fatal there.
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) throw new ExtractError(`Could not find ${host}.`, 502);
  }
  return url;
}

async function safeFetch(raw, { accept } = {}) {
  let current = raw;
  for (let hop = 0; hop < 6; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: accept || 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    return { res, finalUrl: url.toString() };
  }
  throw new ExtractError('Too many redirects.', 502);
}

async function readCapped(res, cap) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cap) throw new ExtractError('The file is too large to open here.', 413);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new ExtractError('The file is too large to open here.', 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------- HTML ----------

function sanitize(html, baseUrl) {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u',
      'a', 'figure', 'figcaption', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'sup', 'sub', 'hr', 'pre', 'code', 'span', 'div', 'section', 'article', 'small', 'abbr', 'cite', 'q', 'mark', 'dl', 'dt', 'dd'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
  });
  const dom = new JSDOM(`<body>${clean}</body>`, { url: baseUrl });
  const doc = dom.window.document;
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      a.href = new URL(a.getAttribute('href'), baseUrl).toString();
    } catch {
      a.removeAttribute('href');
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) { img.remove(); continue; }
    try { img.src = new URL(src, baseUrl).toString(); } catch { img.remove(); continue; }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  }
  // Drop empty wrappers left after sanitising.
  for (const el of doc.querySelectorAll('p, div, span, section')) {
    if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
  }
  return doc.body.innerHTML;
}

function textOf(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  // Keep paragraph boundaries, so text from two paragraphs never runs together.
  for (const el of doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, tr, br, div')) el.after(doc.createTextNode('\n'));
  return doc.body.textContent.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function meta(doc, ...names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    if (el?.content) return el.content.trim();
  }
  return null;
}

function extractHtml(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: quietConsole });
  const doc = dom.window.document;
  const published = meta(doc, 'article:published_time', 'citation_publication_date', 'citation_date', 'datePublished', 'date', 'dc.date', 'DC.date.issued');
  const citationAuthors = [...doc.querySelectorAll('meta[name="citation_author"]')].map((m) => m.content).filter(Boolean);
  const pdfMeta = meta(doc, 'citation_pdf_url');
  const doiMeta = meta(doc, 'citation_doi', 'dc.identifier', 'DC.identifier');
  const article = new Readability(doc, { charThreshold: 400, keepClasses: false }).parse();
  if (!article?.content) throw new ExtractError('Could not find the article text on that page.', 422);
  const content = sanitize(article.content, url);
  return {
    title: (article.title || '').trim(),
    byline: (article.byline || citationAuthors.slice(0, 4).join(', ') || '').trim() || null,
    siteName: article.siteName || hostOf(url),
    published,
    excerpt: article.excerpt || null,
    contentHtml: content,
    text: textOf(content),
    pdfUrl: pdfMeta ? new URL(pdfMeta, url).toString() : null,
    doi: doiMeta && /^10\./.test(doiMeta.replace(/^doi:/i, '')) ? doiMeta.replace(/^doi:/i, '') : null,
  };
}

// ---------- PDF ----------

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function pdfTextToParagraphs(pages) {
  const paragraphs = [];
  for (const page of pages) {
    const lines = page.replace(/\r/g, '').split('\n').map((l) => l.trim());
    let buf = '';
    const push = () => {
      const t = buf.replace(/\s+/g, ' ').trim();
      if (t.length > 1 && !/^\d+$/.test(t)) paragraphs.push(t);
      buf = '';
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { push(); continue; }
      if (buf.endsWith('-') && /^[a-z]/.test(line)) buf = buf.slice(0, -1) + line; // re-join hyphenated words
      else buf = buf ? `${buf} ${line}` : line;
      const next = lines[i + 1] || '';
      if (/[.?!:]["”’)]?$/.test(line) && (/^[A-Z0-9•\-–(“"]/.test(next)) && line.length < 70) push(); // short last line of a paragraph
    }
    push();
  }
  return paragraphs;
}

async function extractPdf(buf, url) {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch {
    throw new ExtractError('That PDF could not be read.', 422);
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).slice(0, 60);
  let info = {};
  try { info = (await pdf.getMetadata())?.info || {}; } catch { /* metadata is optional */ }
  const paragraphs = pdfTextToParagraphs(pages);
  if (paragraphs.join(' ').length < 200) throw new ExtractError('This PDF has no selectable text (it may be a scan).', 422);
  const contentHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  return {
    title: (info.Title || '').trim()
      || (paragraphs[0] && paragraphs[0].length < 180 ? paragraphs[0] : '')
      || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'PDF document'),
    byline: (info.Author || '').trim() || null,
    siteName: hostOf(url),
    published: null,
    excerpt: null,
    contentHtml,
    text: paragraphs.join('\n\n'),
    format: 'pdf',
    pages: totalPages,
    truncated: totalPages > pages.length,
  };
}

// ---------- Guardian (full text through their API, no scraping) ----------

async function extractGuardian(url) {
  const path = new URL(url).pathname.replace(/^\//, '');
  const params = new URLSearchParams({ 'api-key': process.env.GUARDIAN_API_KEY, 'show-fields': 'body,byline,trailText,headline' });
  const res = await fetch(`https://content.guardianapis.com/${path}?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const c = (await res.json()).response?.content;
  if (!c?.fields?.body) return null;
  const contentHtml = sanitize(c.fields.body, url);
  return {
    title: c.fields.headline || c.webTitle,
    byline: c.fields.byline || null,
    siteName: c.pillarName === 'Opinion' ? 'The Guardian · Opinion' : 'The Guardian',
    published: c.webPublicationDate,
    excerpt: c.fields.trailText ? textOf(c.fields.trailText) : null,
    contentHtml,
    text: textOf(contentHtml),
  };
}

// ---------- Entry point ----------

export async function extractUrl(rawUrl) {
  const host = hostOf(rawUrl);
  if (process.env.GUARDIAN_API_KEY && (host === 'theguardian.com' || host.endsWith('.theguardian.com'))) {
    const g = await extractGuardian(rawUrl).catch(() => null);
    if (g) return finish(g, rawUrl);
  }
  const { res, finalUrl } = await safeFetch(rawUrl);
  if (res.status === 401 || res.status === 403 || res.status === 402) {
    throw new ExtractError(`The site refused to share the page (HTTP ${res.status}); it may be paywalled or block automated readers. Open the original instead.`, 422);
  }
  if (!res.ok) throw new ExtractError(`The site answered HTTP ${res.status}.`, 502);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const isPdf = type.includes('application/pdf') || (/\.pdf($|\?)/i.test(finalUrl) && !type.includes('html'));
  if (isPdf) {
    const buf = await readCapped(res, MAX_PDF);
    return finish(await extractPdf(buf, finalUrl), finalUrl);
  }
  if (!type.includes('html') && !type.includes('xml') && type) throw new ExtractError(`Cannot display this kind of file (${type.split(';')[0]}).`, 415);
  const buf = await readCapped(res, MAX_HTML);
  const charset = /charset=([\w-]+)/.exec(type)?.[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(charset).decode(buf); } catch { html = buf.toString('utf8'); }
  return finish(extractHtml(html, finalUrl), finalUrl);
}

function finish(article, url) {
  const c = classifyUrl(url);
  const words = article.text ? article.text.split(/\s+/).filter(Boolean).length : 0;
  return {
    format: 'html',
    ...article,
    url,
    kind: c.kind,
    words,
    // Very short results usually mean a paywall, a cookie wall or a page that needs JavaScript.
    partial: words < 250,
  };
}
