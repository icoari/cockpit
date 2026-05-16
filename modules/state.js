import { safeJSON, uid, todayKey } from './util.js';

const KEY = 'cockpit-v3';

const DEFAULT_SETTINGS = {
  idfm: {
    apiKey: '',
    stops: {
      conflansFinDOise:        'STIF:StopArea:SP:43114:',
      conflansSainteHonorine:  'STIF:StopArea:SP:47447:',
      saintLazare:             'STIF:StopArea:SP:58566:',
    },
    lines: {
      transilienJ: 'STIF:Line::C01739:',
      rerA:        'STIF:Line::C01742:',
    },
  },
  location: {
    lat: 49.005,
    lon: 2.099,
    name: 'Conflans',
  },
  gas: {
    radiusKm: 8,
    fuel: 'e10',
  },
  theme: 'auto',  // auto | dark | light
  aiSources: [
    // English
    { id: 'hn',          name: 'Hacker News',     enabled: true,  type: 'hn-algolia',  lang: 'en' },
    { id: 'openai',      name: 'OpenAI',          enabled: true,  type: 'rss', url: 'https://openai.com/news/rss.xml', lang: 'en' },
    { id: 'deepmind',    name: 'Google DeepMind', enabled: true,  type: 'rss', url: 'https://deepmind.google/blog/rss.xml', lang: 'en' },
    { id: 'hf',          name: 'Hugging Face',    enabled: true,  type: 'rss', url: 'https://huggingface.co/blog/feed.xml', lang: 'en' },
    { id: 'google-ai',   name: 'Google AI',       enabled: true,  type: 'rss', url: 'https://blog.google/technology/ai/rss/', lang: 'en' },
    { id: 'simonw',      name: 'Simon Willison',  enabled: true,  type: 'rss', url: 'https://simonwillison.net/atom/everything/', lang: 'en' },
    { id: 'lesswrong',   name: 'LessWrong',       enabled: false, type: 'rss', url: 'https://www.lesswrong.com/feed.xml', lang: 'en' },
    { id: 'techcrunch',  name: 'TechCrunch AI',   enabled: false, type: 'rss', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en' },
    { id: 'theverge',    name: 'The Verge',       enabled: false, type: 'rss', url: 'https://www.theverge.com/rss/index.xml', lang: 'en' },
    // French
    { id: 'numerama',    name: 'Numerama',        enabled: true,  type: 'rss', url: 'https://www.numerama.com/feed/', lang: 'fr' },
    { id: 'frandroid',   name: 'Frandroid',       enabled: true,  type: 'rss', url: 'https://www.frandroid.com/feed', lang: 'fr' },
    { id: 'siecle',      name: 'Siècle Digital',  enabled: true,  type: 'rss', url: 'https://siecledigital.fr/feed/', lang: 'fr' },
    { id: 'maddyness',   name: 'Maddyness',       enabled: false, type: 'rss', url: 'https://www.maddyness.com/feed/', lang: 'fr' },
    { id: 'korben',      name: 'Korben',          enabled: false, type: 'rss', url: 'https://korben.info/feed', lang: 'fr' },
    { id: 'actuia',      name: 'ActuIA',          enabled: false, type: 'rss', url: 'https://www.actuia.com/feed/', lang: 'fr' },
    { id: 'jdn',         name: 'Journal du Net',  enabled: false, type: 'rss', url: 'https://www.journaldunet.com/rss/', lang: 'fr' },
  ],
  calendar: {
    clientId: '',
    calendarId: 'primary',
    token: null,
  },
  encombrants: {
    nextDates: [],   // array of ISO date strings ("2026-06-04")
    address: 'Résidence le Castelet, Conflans-Sainte-Honorine',
  },
  activeTab: 'perso',
};

const DEFAULT_STATE = {
  version: 3,
  settings: DEFAULT_SETTINGS,
  aiRead: {},
  aiSearch: '',
  cache: {},
};

let state = load();

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    // Try migrating from older versions
    const old = localStorage.getItem('cockpit-v2') || localStorage.getItem('cockpit-v1');
    if (old) {
      const parsed = safeJSON(old, null);
      if (parsed) return mergeDeep(structuredClone(DEFAULT_STATE), parsed);
    }
    return structuredClone(DEFAULT_STATE);
  }
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

// AI watch
export function markAiRead(url) { state.aiRead[url] = true; save(); }
export function isAiRead(url) { return !!state.aiRead[url]; }
export function setAiSearch(q) { state.aiSearch = q || ''; save(); }
export function getAiSearch() { return state.aiSearch || ''; }

// AI sources CRUD
export function addAiSource(name, url, lang = 'en') {
  state.settings.aiSources.push({ id: uid(), name: name.trim(), type: 'rss', url: url.trim(), enabled: true, lang });
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

// Encombrants
export function addEncombrantDate(dateIso) {
  if (!dateIso) return;
  const list = state.settings.encombrants.nextDates;
  if (!list.includes(dateIso)) {
    list.push(dateIso);
    list.sort();
    save();
  }
}
export function removeEncombrantDate(dateIso) {
  state.settings.encombrants.nextDates = state.settings.encombrants.nextDates.filter(d => d !== dateIso);
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
