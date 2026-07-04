// Pulls the pre-aggregated feed maintained by the Worker cron (every 10 min)
// and exposes it to the Pro page. Sources are pushed up to the Worker so the
// cron knows what to fetch on this user's behalf.

import { WORKER_URL, getSyncAuthHeader } from './sync.js';
import { getSettings, cacheGet, cacheSet } from './state.js';

const FEED_CACHE_TTL = 60_000;

export async function pushSources() {
  const auth = getSyncAuthHeader();
  if (!auth) return;
  const s = getSettings();
  const payload = {
    youtube: (s.youtube?.channels || []).map(c => ({
      id: c.id, channelId: c.channelId, name: c.name,
      enabled: c.enabled, lang: c.lang,
    })),
    rss: (s.aiSources || []).filter(x => x.type === 'rss').map(x => ({
      id: x.id, name: x.name, url: x.url, enabled: x.enabled, lang: x.lang, category: x.category,
    })),
    // Honour the Hacker News toggle in Réglages — this was hardcoded true, so
    // disabling HN had no effect on the Worker aggregation.
    hn: (s.aiSources || []).find(x => x.type === 'hn-algolia')?.enabled !== false,
  };
  try {
    await fetch(`${WORKER_URL}/feed/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
  } catch { /* offline — try again next push */ }
}

export async function fetchFeed({ force = false } = {}) {
  if (!force) {
    const cached = cacheGet('feed_agg', FEED_CACHE_TTL);
    if (cached) return cached;
  }
  const auth = getSyncAuthHeader();
  if (!auth) throw new Error('Sync requise pour le feed agrégé.');
  const endpoint = force ? '/feed/refresh' : '/feed';
  const resp = await fetch(`${WORKER_URL}${endpoint}`, {
    method: force ? 'POST' : 'GET',
    headers: auth,
  });
  if (!resp.ok) throw new Error(`Feed HTTP ${resp.status}`);
  const data = await resp.json();
  cacheSet('feed_agg', data);
  return data;
}
