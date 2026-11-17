// Highlights are stored as character offsets into the reader's text (plus the quoted text, so a
// highlight can be re-anchored if the offsets ever stop matching).
import { findVerbatim } from './textmatch.js';

const NO_WRAP_PARENTS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'DL']);

function textNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

export function fullText(root) {
  return textNodes(root).map((n) => n.data).join('');
}

function offsetOf(root, node, offset) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Character offsets of the current selection inside root, or null if it is empty or outside. */
export function selectionOffsets(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  let start = offsetOf(root, range.startContainer, range.startOffset);
  let end = offsetOf(root, range.endContainer, range.endOffset);
  const text = fullText(root);
  // Trim whitespace the browser includes when a selection is made by double/triple click.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end - start < 1) return null;
  return { start, end, text: text.slice(start, end), rect: range.getBoundingClientRect() };
}

/** Wrap [start, end) in <mark> elements (one per text node it crosses). Returns the marks. */
export function wrapRange(root, start, end, { className, id }) {
  const marks = [];
  let pos = 0;
  for (const node of textNodes(root)) {
    const len = node.data.length;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    pos = nodeEnd;
    if (nodeEnd <= start) continue;
    if (nodeStart >= end) break;
    if (!node.data.trim() && NO_WRAP_PARENTS.has(node.parentNode?.nodeName)) continue;
    let target = node;
    const a = Math.max(0, start - nodeStart);
    const b = Math.min(len, end - nodeStart);
    if (b < len) target.splitText(b);
    if (a > 0) target = target.splitText(a);
    const mark = document.createElement('mark');
    mark.className = className;
    if (id) mark.dataset.id = id;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

export function unwrap(root, selector) {
  for (const mark of root.querySelectorAll(selector)) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/**
 * Paint saved highlights. Returns highlights whose offsets had to be repaired (caller may persist).
 */
export function paintHighlights(root, highlights) {
  const repaired = [];
  const text = fullText(root);
  for (const h of highlights) {
    let { start, end } = h;
    if (text.slice(start, end) !== h.text) {
      const hit = findVerbatim(text, h.text);
      if (!hit) continue; // the quote no longer exists in this text; keep it in the notebook only
      start = hit.start;
      end = hit.end;
      repaired.push({ ...h, start, end });
    }
    wrapRange(root, start, end, { className: `hl hl-${h.color}${h.note ? ' has-note' : ''}`, id: h.id });
  }
  return repaired;
}

/** Briefly flash a phrase in the reader and scroll to it. Returns false if it is not in the text. */
export function flashPhrase(root, phrase) {
  unwrap(root, 'mark.flash');
  const hit = findVerbatim(fullText(root), phrase);
  if (!hit) return false;
  const marks = wrapRange(root, hit.start, hit.end, { className: 'flash' });
  marks[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => unwrap(root, 'mark.flash'), 2600);
  return true;
}

export function locate(root, phrase) {
  return findVerbatim(fullText(root), phrase);
}
