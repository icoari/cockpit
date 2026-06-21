// Mémoire — semantic search across Bob's own corpus (book chapters + health
// journal comments). The Worker embeds text and stores ONLY the vectors in
// Vectorize; the full text never leaves the device. At search time we rebuild
// the id→text map locally from localStorage and resolve the Worker's id hits
// back to their text. So search is as private as the rest of Bob.

import { WORKER_URL } from './sync.js';

const STATE_KEY = 'bob-memory-v1';      // { ids: [...indexed ids], at }
const CHUNK_MAX = 1200;                  // chars per embedded chunk

function token() {
  try {
    const s = JSON.parse(localStorage.getItem('bob-sync-v1') || 'null');
    return s?.authToken || null;
  } catch { return null; }
}

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

// Split long text into paragraph-ish chunks so a search lands on a passage,
// not a whole chapter.
function chunk(text) {
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > CHUNK_MAX && buf) { out.push(buf); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf) out.push(buf);
  return out.length ? out : (text.trim() ? [text.trim()] : []);
}

function shortDate(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(ts));
  } catch { return ''; }
}

// Rebuild the full corpus as docs + an id→meta map. Single source of truth for
// both indexing and resolving search hits.
export function buildCorpus() {
  const docs = [];   // { id, type, text, ts }
  const map = {};    // id -> { type, snippet, ts, ref }

  // ---- Chapters (bob-writer-v1) ----
  const writer = lsGet('bob-writer-v1');
  for (const c of (writer?.chapters || [])) {
    const title = (c.title || '').trim();
    const ts = c.updatedAt ? new Date(c.updatedAt).getTime() : 0;
    const chunks = chunk(c.content || '');
    chunks.forEach((ck, i) => {
      const id = `chapter:${c.id}#${i}`;
      const text = (i === 0 && title) ? `${title}\n\n${ck}` : ck;
      docs.push({ id, type: 'chapter', text, ts });
      map[id] = { type: 'chapter', snippet: ck.slice(0, 240), title, ts, ref: c.id };
    });
  }

  // ---- Health comments (health-tracker-v1) ----
  const health = lsGet('health-tracker-v1');
  const TYPE_FR = { etat: 'État', repas: 'Repas', wc: 'WC', crise: 'Crise' };
  for (const ev of (Array.isArray(health?.events) ? health.events : [])) {
    const comment = (ev.data?.comment || '').trim();
    if (!comment) continue;          // only free text is worth embedding
    const tags = Array.isArray(ev.data?.tags) ? ev.data.tags.join(', ') : '';
    const label = TYPE_FR[ev.type] || 'Note';
    const text = `[${label}] ${comment}${tags ? ' — ' + tags : ''}`;
    const id = `health:${ev.id}`;
    docs.push({ id, type: 'health', text, ts: ev.ts || 0 });
    map[id] = { type: 'health', snippet: text.slice(0, 240), title: label, ts: ev.ts || 0, ref: 'health' };
  }
  // Legacy slot comments
  const entries = health?.entries || {};
  for (const day of Object.keys(entries)) {
    const slots = entries[day] || {};
    for (const slot of Object.keys(slots)) {
      const comment = (slots[slot]?.comment || '').trim();
      if (!comment) continue;
      const id = `health-slot:${day}:${slot}`;
      const text = `[${slot}] ${comment}`;
      const ts = new Date(`${day}T12:00:00`).getTime() || 0;
      docs.push({ id, type: 'health', text, ts });
      map[id] = { type: 'health', snippet: text.slice(0, 240), title: slot, ts, ref: 'health' };
    }
  }

  return { docs, map };
}

// Push the corpus to the Worker for (re)embedding. Also forgets vectors whose
// ids no longer exist locally (deleted chapters / events).
export async function reindexMemory() {
  const t = token();
  if (!t) throw new Error('Active la sauvegarde cloud d\'abord.');
  const { docs } = buildCorpus();

  const resp = await fetch(`${WORKER_URL}/memory/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
    body: JSON.stringify({ docs }),
  });
  if (!resp.ok) throw new Error(`Index HTTP ${resp.status}`);
  const data = await resp.json();

  // Prune vectors for ids that disappeared since last index.
  const prev = lsGet(STATE_KEY)?.ids || [];
  const nowIds = new Set(docs.map(d => d.id));
  const gone = prev.filter(id => !nowIds.has(id));
  if (gone.length) {
    fetch(`${WORKER_URL}/memory/forget`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
      body: JSON.stringify({ ids: gone }),
    }).catch(() => {});
  }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ids: [...nowIds], at: Date.now() })); } catch {}
  return data.indexed || 0;
}

// Search: embed the query on the Worker, get nearest ids back, resolve to
// local text. type ∈ {undefined,'chapter','health'}.
export async function searchMemory(query, type) {
  const t = token();
  if (!t) throw new Error('Active la sauvegarde cloud d\'abord.');
  const resp = await fetch(`${WORKER_URL}/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${t}` },
    body: JSON.stringify({ query, topK: 12, ...(type ? { type } : {}) }),
  });
  if (!resp.ok) throw new Error(`Search HTTP ${resp.status}`);
  const data = await resp.json();

  const { map } = buildCorpus();
  return (data.matches || [])
    .map(m => {
      const local = map[m.id];
      if (!local) return null;       // stale vector (text deleted) — skip
      return {
        id: m.id,
        score: m.score,
        type: local.type,
        title: local.title,
        snippet: local.snippet,
        ts: local.ts,
        dateLabel: shortDate(local.ts),
        ref: local.ref,
      };
    })
    .filter(Boolean);
}

export function lastIndexedAt() {
  return lsGet(STATE_KEY)?.at || 0;
}
