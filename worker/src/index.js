// Bob backend Worker — endpoints + scheduled aggregation
//
// HTTP routes:
//   GET    /health
//   GET    /proxy?url=...        CORS proxy with edge caching (10 min)
//   GET    /sync/salt            { setup: bool, salt? }
//   POST   /sync/setup           { salt, authHash }
//   GET    /sync/data            (auth) returns the encrypted blob
//   POST   /sync/data            (auth) { iv, ciphertext, version }
//   DELETE /sync/wipe            (auth) wipes all sync state
//   GET    /feed                 (auth) returns aggregated feed
//   POST   /feed/sources         (auth) sets the user's sources (plaintext)
//   GET    /feed/sources         (auth) returns the user's sources
//   POST   /push/subscribe       (auth) saves a Web Push subscription
//   DELETE /push/unsubscribe     (auth) drops the subscription
//
// Cron */10 * * * * → scheduled() re-aggregates feeds into KV.

const KV_PREFIX = 'bobsync:';
const KEY_SALT = KV_PREFIX + 'salt';
const KEY_AUTH = KV_PREFIX + 'authHash';
const KEY_DATA = KV_PREFIX + 'data';
const KEY_FEED = KV_PREFIX + 'feed';
const KEY_SOURCES = KV_PREFIX + 'sources';
const KEY_PUSH = KV_PREFIX + 'push';

// Curated baseline sources merged with the user's own — these stay fresh
// even before the user has configured anything on a new device.
const BASELINE_RSS = [
  { id: 'anthropic', name: 'Anthropic', url: 'https://www.anthropic.com/news/rss.xml', lang: 'en', kind: 'rss' },
  { id: 'openai',    name: 'OpenAI',    url: 'https://openai.com/news/rss.xml',         lang: 'en', kind: 'rss' },
  { id: 'deepmind',  name: 'DeepMind',  url: 'https://deepmind.google/blog/rss.xml',    lang: 'en', kind: 'rss' },
  { id: 'hf',        name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', lang: 'en', kind: 'rss' },
  { id: 'simonw',    name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', lang: 'en', kind: 'rss' },
  { id: 'latent',    name: 'Latent Space', url: 'https://www.latent.space/feed', lang: 'en', kind: 'rss' },
  { id: 'arxiv-ai',  name: 'arXiv cs.AI', url: 'https://export.arxiv.org/rss/cs.AI', lang: 'en', kind: 'rss' },
  { id: 'arxiv-cl',  name: 'arXiv cs.CL', url: 'https://export.arxiv.org/rss/cs.CL', lang: 'en', kind: 'rss' },
  { id: 'arxiv-lg',  name: 'arXiv cs.LG', url: 'https://export.arxiv.org/rss/cs.LG', lang: 'en', kind: 'rss' },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const p = url.pathname;
      if (p === '/' || p === '/health') return json({ ok: true, service: 'bob' });
      if (p === '/proxy')               return await handleProxy(url);

      if (p === '/sync/salt')           return await handleGetSalt(env);
      if (p === '/sync/setup')          return assertMethod(request, 'POST', () => handleSetup(request, env));
      if (p === '/sync/data')           return await handleSyncData(request, env);
      if (p === '/sync/wipe')           return assertMethod(request, 'DELETE', () => handleWipe(request, env));

      if (p === '/feed')                return await handleGetFeed(request, env);
      if (p === '/feed/sources')        return await handleSources(request, env);
      if (p === '/feed/refresh')        return assertMethod(request, 'POST', () => handleFeedRefresh(request, env));

      if (p === '/push/subscribe')      return assertMethod(request, 'POST', () => handlePushSubscribe(request, env));
      if (p === '/push/unsubscribe')    return assertMethod(request, 'DELETE', () => handlePushUnsubscribe(request, env));

      if (p === '/llm')                 return assertMethod(request, 'POST', () => handleLlm(request, env));

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(aggregateFeed(env));
  },
};

// ====================================================================
// HTTP helpers
// ====================================================================

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

async function assertMethod(request, method, fn) {
  if (request.method !== method) return json({ error: `${method} only` }, 405);
  return fn();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token || token.length > 200) return false;
  const stored = await env.KV.get(KEY_AUTH);
  if (!stored) return false;
  const incoming = await sha256Hex(token);
  if (incoming.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < incoming.length; i++) diff |= incoming.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

// ====================================================================
// /proxy
// ====================================================================

function isProxyTargetAllowed(target) {
  let u;
  try { u = new URL(target); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')
      || h.startsWith('127.') || h.startsWith('10.')
      || h.startsWith('169.254.') || h.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;
  return true;
}

async function handleProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) return json({ error: 'missing url' }, 400);
  if (!isProxyTargetAllowed(target)) return json({ error: 'target not allowed' }, 400);

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bob-proxy/1.0)' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed: ' + e.message }, 502);
  }

  const ct = upstream.headers.get('Content-Type') || 'text/plain';
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(),
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=600',
    },
  });
}

// ====================================================================
// /sync
// ====================================================================

async function handleGetSalt(env) {
  const salt = await env.KV.get(KEY_SALT);
  if (!salt) return json({ setup: false });
  return json({ setup: true, salt });
}

async function handleSetup(request, env) {
  const existing = await env.KV.get(KEY_SALT);
  if (existing) return json({ error: 'already set up. wipe first.' }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { salt, authHash } = body || {};
  if (typeof salt !== 'string' || salt.length < 16 || salt.length > 128) {
    return json({ error: 'salt must be 16-128 chars' }, 400);
  }
  if (typeof authHash !== 'string' || authHash.length !== 64 || !/^[0-9a-f]+$/i.test(authHash)) {
    return json({ error: 'authHash must be 64 hex chars (SHA-256)' }, 400);
  }
  await env.KV.put(KEY_SALT, salt);
  await env.KV.put(KEY_AUTH, authHash.toLowerCase());
  return json({ ok: true });
}

async function handleSyncData(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_DATA);
    if (!raw) return json(null);
    return new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    const { iv, ciphertext, version } = body || {};
    if (typeof iv !== 'string' || typeof ciphertext !== 'string') {
      return json({ error: 'iv and ciphertext required' }, 400);
    }
    if (ciphertext.length > 8 * 1024 * 1024) {
      return json({ error: 'payload too large' }, 413);
    }
    const payload = {
      iv,
      ciphertext,
      version: typeof version === 'number' ? version : 1,
      updatedAt: Date.now(),
    };
    await env.KV.put(KEY_DATA, JSON.stringify(payload));
    return json({ ok: true, updatedAt: payload.updatedAt });
  }
  return json({ error: 'method not allowed' }, 405);
}

async function handleWipe(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.KV.delete(KEY_SALT);
  await env.KV.delete(KEY_AUTH);
  await env.KV.delete(KEY_DATA);
  await env.KV.delete(KEY_FEED);
  await env.KV.delete(KEY_SOURCES);
  await env.KV.delete(KEY_PUSH);
  return json({ ok: true });
}

// ====================================================================
// /feed (aggregation)
// ====================================================================

async function handleGetFeed(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const raw = await env.KV.get(KEY_FEED);
  if (!raw) {
    // Cold start — kick off an aggregation in the background so the next
    // visit hits a populated cache. Return what we can from the network now.
    return json({ items: [], updatedAt: 0, stale: true });
  }
  return new Response(raw, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function handleFeedRefresh(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  await aggregateFeed(env);
  const raw = await env.KV.get(KEY_FEED);
  return new Response(raw || '{"items":[]}', {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function handleSources(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_SOURCES);
    return new Response(raw || '{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    await env.KV.put(KEY_SOURCES, JSON.stringify(body));
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// ====================================================================
// /push
// ====================================================================

async function handlePushSubscribe(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const sub = await request.json();
  await env.KV.put(KEY_PUSH, JSON.stringify(sub));
  return json({ ok: true });
}

async function handlePushUnsubscribe(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.KV.delete(KEY_PUSH);
  return json({ ok: true });
}

// ====================================================================
// /llm — authenticated transparent proxy to any OpenAI-compatible
// chat-completions endpoint (Azure OpenAI, Azure AI Foundry / Anthropic,
// LiteLLM, OpenAI). Required because most managed LLM endpoints don't
// expose CORS for browser direct calls.
//
// Headers expected (all from the client):
//   Authorization:     Bearer <user sync token>
//   X-LLM-Endpoint:    full upstream URL (must be https://)
//   X-LLM-Key:         upstream API key
//   X-LLM-Auth-Style:  'bearer' | 'azure'   (default: bearer)
// ====================================================================

async function handleLlm(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);

  const endpoint = request.headers.get('X-LLM-Endpoint');
  const upstreamKey = request.headers.get('X-LLM-Key');
  const authStyle = (request.headers.get('X-LLM-Auth-Style') || 'bearer').toLowerCase();
  const format = (request.headers.get('X-LLM-Format') || 'openai').toLowerCase();

  if (!endpoint || !upstreamKey) {
    return json({ error: 'missing X-LLM-Endpoint or X-LLM-Key' }, 400);
  }

  let u;
  try { u = new URL(endpoint); }
  catch { return json({ error: 'invalid endpoint URL' }, 400); }
  if (u.protocol !== 'https:') return json({ error: 'endpoint must be https' }, 400);

  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (authStyle === 'azure') upstreamHeaders['api-key'] = upstreamKey;
  else upstreamHeaders['Authorization'] = `Bearer ${upstreamKey}`;

  // Anthropic Messages API needs an anthropic-version header. Azure AI Foundry
  // expects the same header when going through /anthropic/v1/messages.
  if (format === 'anthropic') {
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  }

  const body = await request.text();

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed: ' + e.message }, 502);
  }

  // Pass through the response — including streaming bodies — to the client.
  const ct = upstream.headers.get('Content-Type') || 'application/json';
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(),
      'Content-Type': ct,
      'Cache-Control': 'no-store',
    },
  });
}

// ====================================================================
// Feed aggregation (cron + parsing)
// ====================================================================

const FEED_MAX_AGE_DAYS = 14;
const FEED_MAX_PER_SOURCE = 6;
const FEED_TOTAL_CAP = 200;
const LOW_QUALITY_TITLE = /\b(promo|bon\s*plan|soldes?|deal|code\s*promo|coupon|black\s*friday|cyber\s*monday|discount|giveaway|sponsored|à\s*\-?\d+\s*%)\b/i;

async function aggregateFeed(env) {
  const sourcesRaw = await env.KV.get(KEY_SOURCES);
  const sources = sourcesRaw ? JSON.parse(sourcesRaw) : {};
  const youtube = (sources.youtube || []).filter(c => c.enabled !== false && c.channelId);
  const rss = (sources.rss || []).filter(s => s.enabled !== false && s.url);
  const baseline = BASELINE_RSS.filter(b => !rss.some(s => s.url === b.url));

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
  const resp = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 bob-agg/1.0' },
    cf: { cacheTtl: 600, cacheEverything: true },
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
      link = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1]
          || e.match(/<link[^>]*href="([^"]+)"[^>]*>/)?.[1]
          || '';
    } else {
      link = (e.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1] || '').trim();
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
  const resp = await fetch(url);
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

// ---- XML utils --------------------------------------------------------

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanXmlText(s) {
  // strip CDATA wrappers
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function stripHtml(s) {
  return cleanXmlText(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
