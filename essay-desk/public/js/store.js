// Everything the student creates lives in this browser's IndexedDB: projects (one per prompt),
// opened articles (cached so they reopen offline), and highlights with notes.

const DB_NAME = 'essay-desk';
const VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('articles')) {
        const s = db.createObjectStore('articles', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const s = db.createObjectStore('highlights', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('articleId', 'articleId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = await fn(t.objectStore(store));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return result;
}

export const uid = (p = '') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export const db = {
  get: (store, id) => tx(store, 'readonly', (s) => wrap(s.get(id))),
  put: (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value))),
  delete: (store, id) => tx(store, 'readwrite', (s) => wrap(s.delete(id))),
  all: (store) => tx(store, 'readonly', (s) => wrap(s.getAll())),
  byIndex: (store, index, key) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(key))),
};

export async function listProjects() {
  const all = await db.all('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(p) {
  p.updatedAt = Date.now();
  await db.put('projects', p);
  return p;
}

export async function deleteProject(id) {
  const [arts, hls] = await Promise.all([db.byIndex('articles', 'projectId', id), db.byIndex('highlights', 'projectId', id)]);
  await tx('articles', 'readwrite', (s) => { for (const a of arts) s.delete(a.id); });
  await tx('highlights', 'readwrite', (s) => { for (const h of hls) s.delete(h.id); });
  await db.delete('projects', id);
}

export async function exportAll() {
  const [projects, articles, highlights] = await Promise.all([db.all('projects'), db.all('articles'), db.all('highlights')]);
  return { app: 'essay-desk', version: 1, exportedAt: new Date().toISOString(), projects, articles, highlights };
}

export async function importAll(data) {
  if (data?.app !== 'essay-desk') throw new Error('This file is not an Essay Desk backup.');
  for (const [store, rows] of [['projects', data.projects], ['articles', data.articles], ['highlights', data.highlights]]) {
    await tx(store, 'readwrite', (s) => { for (const r of rows || []) s.put(r); });
  }
  return (data.projects || []).length;
}
