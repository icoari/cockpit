import { safeJSON, uid, todayKey } from './util.js';

const KEY = 'cockpit-v1';

const DEFAULT_SETTINGS = {
  idfm: {
    apiKey: '',
    stops: {
      conflansFinDOise: 'STIF:StopArea:SP:43135:',   // Transilien J
      conflansSainteHonorine: 'STIF:StopArea:SP:43169:', // RER A (à confirmer)
      saintLazare: 'STIF:StopArea:SP:71359:',         // Transilien J terminus
      chatelet: 'STIF:StopArea:SP:474148:',           // RER A central Paris (à confirmer)
    },
    destinations: {
      // Identification of trains going "toward Paris" or "toward Conflans"
      towardParis: ['Paris Saint-Lazare', 'Saint-Lazare', 'Paris-St-Lazare', 'Paris', 'Boissy-Saint-Léger', 'Marne-la-Vallée', 'Marne la Vallée'],
      towardConflans: ['Conflans', 'Mantes-la-Jolie', 'Mantes', 'Gisors', 'Vernon', 'Cergy', 'Poissy', 'Saint-Germain'],
    },
  },
  location: {
    lat: 49.005,
    lon: 2.099,
    name: 'Conflans',
  },
  aiSources: [
    { id: 'hn',         name: 'Hacker News',     enabled: true,  type: 'hn-algolia' },
    { id: 'anthropic',  name: 'Anthropic',       enabled: true,  type: 'rss', url: 'https://www.anthropic.com/news/rss.xml' },
    { id: 'openai',     name: 'OpenAI',          enabled: true,  type: 'rss', url: 'https://openai.com/news/rss.xml' },
    { id: 'deepmind',   name: 'Google DeepMind', enabled: true,  type: 'rss', url: 'https://deepmind.google/blog/rss.xml' },
    { id: 'hf',         name: 'Hugging Face',    enabled: true,  type: 'rss', url: 'https://huggingface.co/blog/feed.xml' },
    { id: 'arxiv',      name: 'arXiv cs.AI',     enabled: false, type: 'rss', url: 'http://export.arxiv.org/rss/cs.AI' },
    { id: 'mistral',    name: 'Mistral',         enabled: false, type: 'rss', url: 'https://mistral.ai/news/rss.xml' },
  ],
  links: [
    { id: uid(), label: 'Azure DevOps',  url: 'https://dev.azure.com/' },
    { id: uid(), label: 'Slack',         url: 'https://app.slack.com/' },
    { id: uid(), label: 'Outlook',       url: 'https://outlook.office.com/' },
    { id: uid(), label: 'Younited',      url: 'https://www.younited-credit.fr/' },
    { id: uid(), label: 'GitHub',        url: 'https://github.com/' },
    { id: uid(), label: 'ChatGPT',       url: 'https://chat.openai.com/' },
  ],
  habits: [
    { id: uid(), name: 'Boire 2L d\'eau' },
    { id: uid(), name: 'Marcher 30 min' },
    { id: uid(), name: 'Lire' },
    { id: uid(), name: 'Pas d\'écran après 22h' },
  ],
  activeTab: 'pro',
};

const DEFAULT_STATE = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  captures: [],       // [{ id, text, tags: [], date }]
  todos: [],          // [{ id, text, done, createdAt, completedAt }]
  habits: {},         // { habitId: { 'YYYY-MM-DD': true } }
  aiRead: {},         // { itemUrl: true }
  cache: {
    weather: null,
    trains: {},
    aiwatch: null,
  },
};

let state = load();

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);
  const parsed = safeJSON(raw, null);
  if (!parsed) return structuredClone(DEFAULT_STATE);
  // Shallow merge with defaults so new fields appear after updates
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

export function getState() {
  return state;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Storage failed', e);
  }
}

export function getSettings() {
  return state.settings;
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  save();
}

// Captures
export function addCapture(text) {
  const tags = [...text.matchAll(/#([\w\-éèêàâôùç]+)/gi)].map(m => m[1].toLowerCase());
  state.captures.unshift({
    id: uid(),
    text: text.trim(),
    tags,
    date: new Date().toISOString(),
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
    id: uid(),
    text: text.trim(),
    done: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
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

// Habits
export function toggleHabit(habitId, dayKey = todayKey()) {
  if (!state.habits[habitId]) state.habits[habitId] = {};
  if (state.habits[habitId][dayKey]) {
    delete state.habits[habitId][dayKey];
  } else {
    state.habits[habitId][dayKey] = true;
  }
  save();
}

export function getHabitLog(habitId) {
  return state.habits[habitId] || {};
}

// AI Watch — mark read
export function markAiRead(url) {
  state.aiRead[url] = true;
  save();
}

export function isAiRead(url) {
  return !!state.aiRead[url];
}

// CRUD on settings collections
export function addLink(label, url) {
  state.settings.links.push({ id: uid(), label: label.trim(), url: url.trim() });
  save();
}

export function removeLink(id) {
  state.settings.links = state.settings.links.filter(l => l.id !== id);
  save();
}

export function addHabit(name) {
  state.settings.habits.push({ id: uid(), name: name.trim() });
  save();
}

export function removeHabit(id) {
  state.settings.habits = state.settings.habits.filter(h => h.id !== id);
  delete state.habits[id];
  save();
}

export function addAiSource(name, url) {
  state.settings.aiSources.push({
    id: uid(),
    name: name.trim(),
    type: 'rss',
    url: url.trim(),
    enabled: true,
  });
  save();
}

export function toggleAiSource(id) {
  const s = state.settings.aiSources.find(x => x.id === id);
  if (!s) return;
  s.enabled = !s.enabled;
  save();
}

export function removeAiSource(id) {
  state.settings.aiSources = state.settings.aiSources.filter(s => s.id !== id);
  save();
}

// Cache helpers
export function cacheGet(key, ttlMs) {
  const c = state.cache[key];
  if (!c || !c.ts) return null;
  if (Date.now() - c.ts > ttlMs) return null;
  return c.data;
}

export function cacheSet(key, data) {
  state.cache[key] = { ts: Date.now(), data };
  save();
}

// Export / Import (settings.js will use these)
export function exportData() {
  return JSON.stringify(state, null, 2);
}

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
