import { safeJSON, uid, todayKey } from './util.js';

const KEY = 'cockpit-v2';

const DEFAULT_SETTINGS = {
  idfm: {
    apiKey: '',
    // Verified via IDFM open data and live API (2026-05-16)
    stops: {
      conflansFinDOise:        'STIF:StopArea:SP:43114:',  // J + RER A
      conflansSainteHonorine:  'STIF:StopArea:SP:47447:',  // J only (backup)
      saintLazare:             'STIF:StopArea:SP:58566:',
      chatelet:                'STIF:StopArea:SP:45102:',
      auber:                   'STIF:StopArea:SP:45873:',
    },
    // Line IDs (STIF refs)
    lines: {
      transilienJ: 'STIF:Line::C01739:',
      rerA:        'STIF:Line::C01742:',
    },
    // Heuristics: destinations matching these go *toward Conflans / west* on RER A
    rerWestDestinations: ['Cergy', 'Poissy'],
    // RER A trains stopping at Conflans Fin d'Oise: only those bound for Cergy le Haut
    rerToConflans:       ['Cergy le Haut', 'Cergy'],
  },
  location: {
    lat: 49.005,
    lon: 2.099,
    name: 'Conflans',
  },
  gas: {
    radiusKm: 8,
    fuel: 'gazole',   // gazole | sp95 | sp98 | e85 | e10 | gplc
  },
  aiSources: [
    { id: 'hn',          name: 'Hacker News',     enabled: true,  type: 'hn-algolia' },
    { id: 'openai',      name: 'OpenAI',          enabled: true,  type: 'rss', url: 'https://openai.com/news/rss.xml' },
    { id: 'deepmind',    name: 'Google DeepMind', enabled: true,  type: 'rss', url: 'https://deepmind.google/blog/rss.xml' },
    { id: 'hf',          name: 'Hugging Face',    enabled: true,  type: 'rss', url: 'https://huggingface.co/blog/feed.xml' },
    { id: 'google-ai',   name: 'Google AI',       enabled: true,  type: 'rss', url: 'https://blog.google/technology/ai/rss/' },
    { id: 'lesswrong',   name: 'LessWrong',       enabled: false, type: 'rss', url: 'https://www.lesswrong.com/feed.xml' },
    { id: 'simonw',      name: 'Simon Willison',  enabled: true,  type: 'rss', url: 'https://simonwillison.net/atom/everything/' },
    { id: 'techcrunch',  name: 'TechCrunch AI',   enabled: false, type: 'rss', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
    { id: 'theverge',    name: 'The Verge',       enabled: false, type: 'rss', url: 'https://www.theverge.com/rss/index.xml' },
  ],
  activeTab: 'perso',
};

const DEFAULT_STATE = {
  version: 2,
  settings: DEFAULT_SETTINGS,
  captures: [],
  todos: [],
  habits: {},
  aiRead: {},
  cache: {},
};

let state = load();

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);
  const parsed = safeJSON(raw, null);
  if (!parsed) return structuredClone(DEFAULT_STATE);
  return mergeDeep(structuredClone(DEFAULT_STATE), parsed);
}

function mergeDeep(target, source) {
  for (const k in source) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      target[k] = mergeDeep(target[k] || {}, source[k]);
    } else {
      target[k] = source[k];
    }
  }
  return target;
}

export function getState() { return state; }
export function getSettings() { return state.settings; }

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.error('Storage failed', e); }
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  save();
}

// Captures
export function addCapture(text) {
  const tags = [...text.matchAll(/#([\w\-éèêàâôùç]+)/gi)].map(m => m[1].toLowerCase());
  state.captures.unshift({
    id: uid(), text: text.trim(), tags, date: new Date().toISOString(),
  });
  save();
}
export function removeCapture(id) {
  state.captures = state.captures.filter(c => c.id !== id);
  save();
}

// Todos
export function addTodo(text) {
  state.todos.unshift({
    id: uid(), text: text.trim(), done: false,
    createdAt: new Date().toISOString(), completedAt: null,
  });
  save();
}
export function toggleTodo(id) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.completedAt = t.done ? new Date().toISOString() : null;
  save();
}
export function removeTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  save();
}

// AI read
export function markAiRead(url) { state.aiRead[url] = true; save(); }
export function isAiRead(url) { return !!state.aiRead[url]; }

// AI sources CRUD
export function addAiSource(name, url) {
  state.settings.aiSources.push({ id: uid(), name: name.trim(), type: 'rss', url: url.trim(), enabled: true });
  save();
}
export function toggleAiSource(id) {
  const s = state.settings.aiSources.find(x => x.id === id);
  if (s) { s.enabled = !s.enabled; save(); }
}
export function removeAiSource(id) {
  state.settings.aiSources = state.settings.aiSources.filter(s => s.id !== id);
  save();
}

// Cache helpers
export function cacheGet(key, ttlMs) {
  const c = state.cache[key];
  if (!c || !c.ts || c.data == null) return null;
  if (Date.now() - c.ts > ttlMs) return null;
  return c.data;
}
export function cacheSet(key, data) {
  state.cache[key] = { ts: Date.now(), data };
  save();
}
export function cacheBust(key) {
  delete state.cache[key];
  save();
}

// Export / Import / Reset
export function exportData() { return JSON.stringify(state, null, 2); }
export function importData(json) {
  const parsed = safeJSON(json, null);
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON invalide');
  state = mergeDeep(structuredClone(DEFAULT_STATE), parsed);
  save();
}
export function resetAll() {
  state = structuredClone(DEFAULT_STATE);
  save();
}
