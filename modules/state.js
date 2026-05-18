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
    // English — IA
    { id: 'hn',          name: 'Hacker News',     enabled: true,  type: 'hn-algolia',  lang: 'en', category: 'ai' },
    { id: 'openai',      name: 'OpenAI',          enabled: true,  type: 'rss', url: 'https://openai.com/news/rss.xml', lang: 'en', category: 'ai' },
    { id: 'deepmind',    name: 'Google DeepMind', enabled: true,  type: 'rss', url: 'https://deepmind.google/blog/rss.xml', lang: 'en', category: 'ai' },
    { id: 'hf',          name: 'Hugging Face',    enabled: true,  type: 'rss', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', category: 'ai' },
    { id: 'google-ai',   name: 'Google AI',       enabled: true,  type: 'rss', url: 'https://blog.google/technology/ai/rss/', lang: 'en', category: 'ai' },
    { id: 'simonw',      name: 'Simon Willison',  enabled: true,  type: 'rss', url: 'https://simonwillison.net/atom/everything/', lang: 'en', category: 'ai' },
    { id: 'lesswrong',   name: 'LessWrong',       enabled: false, type: 'rss', url: 'https://www.lesswrong.com/feed.xml', lang: 'en', category: 'ai' },
    { id: 'techcrunch',  name: 'TechCrunch AI',   enabled: false, type: 'rss', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', lang: 'en', category: 'ai' },
    // French — IA
    { id: 'actuia',      name: 'ActuIA',          enabled: true,  type: 'rss', url: 'https://www.actuia.com/feed/', lang: 'fr', category: 'ai' },
    // French — Tech non-IA
    { id: 'numerama',    name: 'Numerama',        enabled: true,  type: 'rss', url: 'https://www.numerama.com/feed/', lang: 'fr', category: 'tech' },
    { id: 'frandroid',   name: 'Frandroid',       enabled: true,  type: 'rss', url: 'https://www.frandroid.com/feed', lang: 'fr', category: 'tech' },
    { id: 'siecle',      name: 'Siècle Digital',  enabled: true,  type: 'rss', url: 'https://siecledigital.fr/feed/', lang: 'fr', category: 'tech' },
    { id: 'korben',      name: 'Korben',          enabled: true,  type: 'rss', url: 'https://korben.info/feed', lang: 'fr', category: 'tech' },
    { id: 'nextink',     name: 'Next',            enabled: false, type: 'rss', url: 'https://next.ink/feed/', lang: 'fr', category: 'tech' },
    { id: 'jdg',         name: 'Journal du Geek', enabled: false, type: 'rss', url: 'https://www.journaldugeek.com/feed/', lang: 'fr', category: 'tech' },
    { id: 'lmi',         name: 'Le Monde Informatique', enabled: false, type: 'rss', url: 'https://www.lemondeinformatique.fr/flux-rss/rss.xml', lang: 'fr', category: 'tech' },
    { id: 'clubic',      name: 'Clubic',          enabled: false, type: 'rss', url: 'https://www.clubic.com/feed/news.rss', lang: 'fr', category: 'tech' },
    // English — Tech général
    { id: 'theverge',    name: 'The Verge',       enabled: false, type: 'rss', url: 'https://www.theverge.com/rss/index.xml', lang: 'en', category: 'tech' },
    { id: 'arstechnica', name: 'Ars Technica',    enabled: false, type: 'rss', url: 'https://feeds.arstechnica.com/arstechnica/index', lang: 'en', category: 'tech' },
  ],
  calendar: {
    clientId: '',
    calendarId: 'primary',
    token: null,
  },
  encombrants: {
    pattern: 'monthly-2nd-tuesday',
    extraDates: [],
    address: 'Conflans-Sainte-Honorine',
  },
  collectes: {
    // Each: enabled (bool), pattern (string), label (string)
    ordures:    { enabled: true, pattern: 'weekly-friday',    label: 'Ordures ménagères' },
    tri:        { enabled: true, pattern: 'weekly-wednesday', label: 'Tri sélectif' },
    verre:      { enabled: false, pattern: 'monthly-1st-tuesday', label: 'Verre' },
  },
  pharmacies: {
    radiusKm: 3,
  },
  youtube: {
    channels: [
      // English — main channels (verified May 2026)
      { id: 'tmp',      channelId: 'UCbfYPyITQ-7l4upoX8nvctg', name: 'Two Minute Papers', enabled: true, lang: 'en' },
      { id: 'lex',      channelId: 'UCSHZKyawb77ixDdsGog4iWA', name: 'Lex Fridman',       enabled: true, lang: 'en' },
      { id: 'yk',       channelId: 'UCZHmQk67mSJgfCCTn7xBfew', name: 'Yannic Kilcher',    enabled: true, lang: 'en' },
      { id: 'mattwolfe', channelId: 'UChpleBmo18P08aKCIgti38g', name: 'Matt Wolfe',       enabled: true, lang: 'en' },
      { id: 'aiexpl',   channelId: 'UCNJ1Ymd5yFuUPtn21xtRbbw', name: 'AI Explained',      enabled: true, lang: 'en' },
      { id: 'fireship', channelId: 'UCsBjURrPoezykLs9EqgamOA', name: 'Fireship',          enabled: true, lang: 'en' },
      // French
      { id: 'underscore', channelId: 'UCWedHS9qKebauVIK2J7383g', name: 'Underscore_',         enabled: true, lang: 'fr' },
      { id: 'defendia',   channelId: 'UCnEHCrot2HkySxMTmDPhZyg', name: 'Defend Intelligence', enabled: true, lang: 'fr' },
      { id: 'cocadmin',   channelId: 'UCVRJ6D343dX-x730MRP8tNw', name: 'cocadmin',            enabled: true, lang: 'fr' },
      { id: 'actutech',   channelId: 'UCTag-fSBSpjH0g3fTUatAfg', name: 'Actu Tech',           enabled: true, lang: 'fr' },
      // Optional — disabled by default
      { id: '3b1b',        channelId: 'UC1_uAIS3r8Vu6JjXWvastJg', name: '3Blue1Brown',    enabled: false, lang: 'en' },
      { id: 'sentdex',     channelId: 'UCQALLeQPoZdZC4JNUboVEUg', name: 'Sentdex',        enabled: false, lang: 'en' },
      { id: 'micode',      channelId: 'UCYnvxJ-PKiGXo_tYXpWAC-w', name: 'Micode (perso)', enabled: false, lang: 'fr' },
    ],
  },
  activeTab: 'perso',
};

const DEFAULT_STATE = {
  version: 3,
  settings: DEFAULT_SETTINGS,
  aiRead: {},
  feedSearch: {},   // { ai: '...', tech: '...' }
  cache: {},
};

let state = load();

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    const old = localStorage.getItem('cockpit-v2') || localStorage.getItem('cockpit-v1');
    if (old) {
      const parsed = safeJSON(old, null);
      if (parsed) return migrate(mergeDeep(structuredClone(DEFAULT_STATE), parsed));
    }
    return structuredClone(DEFAULT_STATE);
  }
  const parsed = safeJSON(raw, null);
  if (!parsed) return structuredClone(DEFAULT_STATE);
  return migrate(mergeDeep(structuredClone(DEFAULT_STATE), parsed));
}

// Targeted migrations between schema versions
function migrate(merged) {
  if (!merged.settings) merged.settings = structuredClone(DEFAULT_SETTINGS);

  // Auto-heal: a faulty import or buggy CRUD can leave critical arrays empty.
  // Restore defaults so the user isn't stuck with no videos / no articles.
  if (!Array.isArray(merged.settings.aiSources) || merged.settings.aiSources.length === 0) {
    merged.settings.aiSources = structuredClone(DEFAULT_SETTINGS.aiSources);
  }
  if (!merged.settings.youtube) merged.settings.youtube = { channels: [] };
  if (!Array.isArray(merged.settings.youtube.channels) || merged.settings.youtube.channels.length === 0) {
    merged.settings.youtube.channels = structuredClone(DEFAULT_SETTINGS.youtube.channels);
  }

  const channels = merged.settings.youtube.channels;

  // Old YouTube channels (early curation list) — replace entirely with new defaults
  const oldChannelIds = ['scienceclic', 'reveilleur', 'hygiene'];
  if (channels.some(c => oldChannelIds.includes(c.id))) {
    merged.settings.youtube.channels = structuredClone(DEFAULT_SETTINGS.youtube.channels);
    return merged;
  }

  // Bad channel IDs that pointed to defunct or secondary channels.
  const badChannelIds = [
    'UCSPkiRjFYpz-8DY-aF_1wRg',
    'UC2Xd-TjJByJyK2w1zNwY0zQ',
    'UCHmD-oSpV0sNfAUnpYpj8KA',
    'UCJIfeSCssxSC_Dhc5s7woww',
    'UCglJU3xeXOcq7d3kQP_4BOg',
  ];
  if (channels.some(c => badChannelIds.includes(c.channelId))) {
    merged.settings.youtube.channels = structuredClone(DEFAULT_SETTINGS.youtube.channels);
  }
  return merged;
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
export function setFeedSearch(category, q) {
  if (!state.feedSearch) state.feedSearch = {};
  state.feedSearch[category] = q || '';
  save();
}
export function getFeedSearch(category) { return state.feedSearch?.[category] || ''; }

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

// YouTube channels CRUD
export function addYoutubeChannel(name, channelId, lang = 'en') {
  if (!state.settings.youtube) state.settings.youtube = { channels: [] };
  state.settings.youtube.channels.push({ id: uid(), name: name.trim(), channelId: channelId.trim(), enabled: true, lang });
  save();
}
export function toggleYoutubeChannel(id) {
  const c = state.settings.youtube?.channels?.find(x => x.id === id);
  if (c) { c.enabled = !c.enabled; save(); }
}
export function removeYoutubeChannel(id) {
  if (!state.settings.youtube) return;
  state.settings.youtube.channels = state.settings.youtube.channels.filter(c => c.id !== id);
  save();
}

// Encombrants
export function addEncombrantDate(dateIso) {
  if (!dateIso) return;
  const list = state.settings.encombrants.extraDates || (state.settings.encombrants.extraDates = []);
  if (!list.includes(dateIso)) {
    list.push(dateIso);
    list.sort();
    save();
  }
}
export function removeEncombrantDate(dateIso) {
  state.settings.encombrants.extraDates = (state.settings.encombrants.extraDates || []).filter(d => d !== dateIso);
  save();
}
export function setEncombrantPattern(p) {
  state.settings.encombrants.pattern = p;
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
const WRITER_KEY = 'bob-writer-v1';
const HEALTH_KEY = 'health-tracker-v1';

function readLocalJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function exportData() {
  // Build a clean snapshot:
  //  - omit calendar OAuth token (security: would leak an active access token)
  //  - omit volatile cache (recreated on first use)
  //  - include the writer chapters AND the health-tracker entries
  //    (both live in separate localStorage keys on the same origin)
  const snapshot = structuredClone(state);
  if (snapshot.settings?.calendar) snapshot.settings.calendar.token = null;
  delete snapshot.cache;
  return JSON.stringify({
    ...snapshot,
    _writer: readLocalJSON(WRITER_KEY),
    _healthTracker: readLocalJSON(HEALTH_KEY),
  }, null, 2);
}

export function importData(json) {
  const parsed = safeJSON(json, null);
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON invalide');
  const writer = parsed._writer;
  const health = parsed._healthTracker;
  const rest = { ...parsed };
  delete rest._writer;
  delete rest._healthTracker;

  // Defensive: an empty critical array in the backup must NOT wipe the
  // populated defaults (mergeDeep replaces arrays wholesale).
  if (rest.settings) {
    if (Array.isArray(rest.settings.aiSources) && rest.settings.aiSources.length === 0) {
      delete rest.settings.aiSources;
    }
    if (rest.settings.youtube && Array.isArray(rest.settings.youtube.channels)
        && rest.settings.youtube.channels.length === 0) {
      delete rest.settings.youtube.channels;
    }
  }

  state = mergeDeep(structuredClone(DEFAULT_STATE), rest);
  state = migrate(state);     // auto-heal anything still missing
  state.cache = {};            // force every widget to refetch fresh data
  save();
  if (writer && typeof writer === 'object') {
    try { localStorage.setItem(WRITER_KEY, JSON.stringify(writer)); } catch {}
  }
  if (health && typeof health === 'object') {
    try { localStorage.setItem(HEALTH_KEY, JSON.stringify(health)); } catch {}
  }
}

export function resetAll() {
  state = structuredClone(DEFAULT_STATE);
  save();
  try { localStorage.removeItem(WRITER_KEY); } catch {}
  try { localStorage.removeItem(HEALTH_KEY); } catch {}
}
