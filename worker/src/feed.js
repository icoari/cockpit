// /feed — pre-aggregated reading feed (YouTube, RSS/Atom, Hacker News),
// rebuilt by the */10 cron from the sources the client pushes up.

import { KEY_FEED, KEY_SOURCES } from './keys.js';
import { json, rawJson, requireAuth, safeJson, isPlainObject, readJsonLimited } from './http.js';
import { isPublicHttpsUrl, fetchPublic } from './url.js';
import { stripHtml, decodeXml, cleanXmlText, pickAtomLink } from './xml.js';

const SOURCES_MAX_BYTES = 32 * 1024;

// Curated baseline sources merged with the user's own — these stay fresh
// even before the user has configured anything on a new device.
const BASELINE_RSS = [
  // anthropic.com has no feed (404): community mirror of the news page.
  { id: 'anthropic', name: 'Anthropic', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', lang: 'en', kind: 'rss' },
  { id: 'openai',    name: 'OpenAI',    url: 'https://openai.com/news/rss.xml',         lang: 'en', kind: 'rss' },
  { id: 'deepmind',  name: 'DeepMind',  url: 'https://deepmind.google/blog/rss.xml',    lang: 'en', kind: 'rss' },
  { id: 'hf',        name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', kind: 'rss' },
  { id: 'simonw',    name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', lang: 'en', kind: 'rss' },
  { id: 'latent',    name: 'Latent Space', url: 'https://www.latent.space/feed', lang: 'en', kind: 'rss' },
];

export async function handleGetFeed(request, env, ctx) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const raw = await env.KV.get(KEY_FEED);
  if (!raw) {
    // Cold start — kick off an aggregation in the background so the next
    // visit hits a populated cache.
    ctx.waitUntil(aggregateFeed(env).catch(err => console.error('feed cold-start aggregation failed', err)));
    return json({ items: [], updatedAt: 0, stale: true });
  }
  return rawJson(raw);
}

export async function handleFeedRefresh(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  await aggregateFeed(env);
  const raw = await env.KV.get(KEY_FEED);
  return rawJson(raw || '{"items":[]}');
}

// Returns an error string, or null when the sources payload is acceptable.
function validateSources(body) {
  if (!isPlainObject(body)) return 'object expected';
  if (body.hn !== undefined && typeof body.hn !== 'boolean') return 'hn must be a boolean';
  if (body.youtube !== undefined) {
    if (!Array.isArray(body.youtube)) return 'youtube must be an array';
    for (const c of body.youtube) {
      if (!isPlainObject(c)) return 'youtube entries must be objects';
      if (c.channelId !== undefined && typeof c.channelId !== 'string') return 'youtube channelId must be a string';
    }
  }
  if (body.rss !== undefined) {
    if (!Array.isArray(body.rss)) return 'rss must be an array';
    for (const s of body.rss) {
      if (!isPlainObject(s)) return 'rss entries must be objects';
    }
  }
  return null;
}

// A single non-https or private-host feed must not block the whole list
// (the client ignores the response): drop it, keep the rest.
function keepPublicRss(body) {
  if (!Array.isArray(body.rss)) return body;
  const rss = body.rss.filter(s => !s.url || (typeof s.url === 'string' && isPublicHttpsUrl(s.url)));
  if (rss.length !== body.rss.length) console.warn(`feed sources: dropped ${body.rss.length - rss.length} non-public rss url(s)`);
  return { ...body, rss };
}

export async function handleSources(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_SOURCES);
    return rawJson(raw || '{}');
  }
  if (request.method === 'POST') {
    const { value: body, response } = await readJsonLimited(request, SOURCES_MAX_BYTES);
    if (response) return response;
    const problem = validateSources(body);
    if (problem) return json({ error: problem }, 400);
    await env.KV.put(KEY_SOURCES, JSON.stringify(keepPublicRss(body)));
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// ---- Aggregation --------------------------------------------------------

const FEED_MAX_AGE_DAYS = 14;
const PRERELEASE = /nightly|[-.](rc|dev|beta|alpha|canary|pre)(\b|\.|\d)|\brc\d|pre-?release|^(stable|beta|latest|next|nightly)$/i;
const FEED_MAX_PER_SOURCE = 6;
const FEED_TOTAL_CAP = 200;
const LOW_QUALITY_TITLE = /\b(promo|bon\s*plan|soldes?|deal|code\s*promo|coupon|black\s*friday|cyber\s*monday|discount|giveaway|sponsored|à\s*\-?\d+\s*%)\b/i;

export async function aggregateFeed(env) {
  const sources = safeJson(await env.KV.get(KEY_SOURCES), {});
  const youtube = (Array.isArray(sources.youtube) ? sources.youtube : []).filter(c => c && c.enabled !== false && c.channelId);
  const userRss = Array.isArray(sources.rss) ? sources.rss : [];
  const rss = userRss.filter(s => s && s.enabled !== false && s.url);
  // Dedupe baseline against ALL user entries (enabled or not) — a user who
  // disabled a baseline feed must not get it re-fetched via the baseline.
  const allUserUrls = new Set(userRss.map(s => s && s.url).filter(Boolean));
  const baseline = BASELINE_RSS.filter(b => !allUserUrls.has(b.url));

  const tasks = [];
  for (const ch of youtube) tasks.push(fetchYouTubeFeed(ch));
  for (const src of [...rss, ...baseline]) tasks.push(fetchRssFeed(src));
  if (sources.hn !== false) tasks.push(fetchHnTop());

  const results = await Promise.all(tasks.map(p => p.catch(() => [])));
  let items = results.flat();

  // Dedupe by canonical URL
  const seen = new Set();
  items = items.filter(it => {
    if (!it.url) return false;
    const key = canonicalize(it.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Normalise unparseable dates so staleness filtering and sorting hold.
  for (const it of items) if (!Number.isFinite(it.date)) it.date = 0;

  // Filter junk + stale
  const cutoff = Date.now() - FEED_MAX_AGE_DAYS * 86400 * 1000;
  items = items.filter(it => {
    if (it.date < cutoff) return false;
    if (it.kind === 'article' && LOW_QUALITY_TITLE.test(it.title || '')) return false;
    return true;
  });

  // Sort by recency, cap
  items.sort((a, b) => b.date - a.date);
  items = items.slice(0, FEED_TOTAL_CAP);

  const payload = { items, updatedAt: Date.now(), version: 2 };
  await env.KV.put(KEY_FEED, JSON.stringify(payload));
  return payload;
}

function canonicalize(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // strip common tracking params
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

// ---- YouTube ----------------------------------------------------------

async function fetchYouTubeFeed(channel) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel.channelId)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 bob-agg/1.0' },
    cf: { cacheTtl: 300, cacheEverything: true },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  return parseYouTubeAtom(xml, channel);
}

function parseYouTubeAtom(xml, channel) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const out = [];
  for (const m of entries.slice(0, FEED_MAX_PER_SOURCE * 2)) {
    const e = m[1];
    const title = decodeXml((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim());
    const link = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] || '';
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1];
    const videoId = e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || '';
    const authorName = (e.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/)?.[1] || channel.name || '').trim();
    const mediaDesc = e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '';
    const isShort = /#shorts?\b/i.test(title) || /#shorts?\b/i.test(mediaDesc) || /\/shorts\//.test(link);
    if (!title || !link || isShort) continue;
    out.push({
      kind: 'video',
      id: videoId || link,
      title,
      url: link,
      source: authorName,
      sourceId: channel.id || channel.channelId,
      channelId: channel.channelId,
      lang: channel.lang || 'en',
      date: published ? Date.parse(published) : Date.now(),
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '',
    });
    if (out.length >= FEED_MAX_PER_SOURCE) break;
  }
  return out;
}

// ---- Generic RSS / Atom -----------------------------------------------

async function fetchRssFeed(src) {
  // Sources stored before the https/public check existed are skipped here.
  if (!isPublicHttpsUrl(src.url)) return [];
  const resp = await fetchPublic(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 bob-agg/1.0' },
    cf: { cacheTtl: 600, cacheEverything: true },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const xml = await resp.text();
  return parseRssOrAtom(xml, src);
}

function parseRssOrAtom(xml, src) {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)]
    : [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)];
  const out = [];
  for (const m of blocks.slice(0, FEED_MAX_PER_SOURCE * 2)) {
    const e = m[1];
    const title = decodeXml(cleanXmlText(e.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] || ''));
    let link = '';
    if (isAtom) {
      link = pickAtomLink(e);
    } else {
      link = cleanXmlText(e.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    }
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1]
                  || e.match(/<updated>([^<]+)<\/updated>/)?.[1]
                  || e.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]
                  || e.match(/<dc:date>([^<]+)<\/dc:date>/)?.[1];
    const summary = decodeXml(stripHtml(
      e.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]
      || e.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1]
      || e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1]
      || ''
    )).slice(0, 280);
    if (!title || !link) continue;
    // GitHub release feeds: keep stable versions, skip nightlies and previews.
    if (PRERELEASE.test(title) && /github\.com\/[^/]+\/[^/]+\/releases/.test(link)) continue;
    out.push({
      kind: 'article',
      id: link,
      title,
      url: link,
      source: src.name,
      sourceId: src.id,
      lang: src.lang || 'en',
      date: published ? Date.parse(published) : Date.now(),
      summary,
    });
    if (out.length >= FEED_MAX_PER_SOURCE) break;
  }
  return out;
}

// ---- HN ---------------------------------------------------------------

async function fetchHnTop() {
  const sinceTs = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40&numericFilters=created_at_i>${sinceTs},points>100`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.hits || []).map(h => {
    const link = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    let domain = '';
    try { domain = h.url ? new URL(h.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com'; } catch {}
    return {
      kind: 'hn',
      id: 'hn-' + h.objectID,
      title: h.title,
      url: link,
      source: 'Hacker News',
      sourceId: 'hn',
      lang: 'en',
      date: new Date(h.created_at).getTime(),
      points: h.points || 0,
      comments: h.num_comments || 0,
      domain,
      hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    };
  });
}
