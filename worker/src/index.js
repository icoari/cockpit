// Bob backend Worker — endpoints + scheduled tasks
//
// Cron schedule (UTC):
//   */10 * * * *     feed aggregation
//   */5 6-23 * * *   IDFM disruption watch
//   0 5 * * *        morning brief push (7h Paris summer)
//   0 16 * * *       last-train-of-tonight check (18h Paris summer)
//   0 21 * * *       health-tracker evening reminder (23h Paris summer)

import { sendWebPush } from './webpush.js';
import {
  handleTranscribe, handleMemoryIndex, handleMemorySearch, handleMemoryForget,
} from './ai.js';

const KV_PREFIX = 'bobsync:';
const KEY_SALT = KV_PREFIX + 'salt';
const KEY_AUTH = KV_PREFIX + 'authHash';
const KEY_DATA = KV_PREFIX + 'data';
const KEY_FEED = KV_PREFIX + 'feed';
const KEY_SOURCES = KV_PREFIX + 'sources';
const KEY_PUSH = KV_PREFIX + 'push';
const KEY_MONITORING = KV_PREFIX + 'monitoring';
const KEY_ALERTED_DISRUPTIONS = KV_PREFIX + 'alertedDisruptions';
const KEY_HEALTH_PING = KV_PREFIX + 'healthPing';
const KEY_LAST_TRAIN_ALERTED = KV_PREFIX + 'lastTrainAlerted';

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      const p = url.pathname;
      if (p === '/' || p === '/health') return json({ ok: true, service: 'bob' });
      if (p === '/proxy')               return await handleProxy(url, request, env);

      if (p === '/sync/salt')           return await handleGetSalt(env);
      if (p === '/sync/setup')          return assertMethod(request, 'POST', () => handleSetup(request, env));
      if (p === '/sync/data')           return await handleSyncData(request, env);
      if (p === '/sync/wipe')           return assertMethod(request, 'DELETE', () => handleWipe(request, env));

      if (p === '/feed')                return await handleGetFeed(request, env, ctx);
      if (p === '/feed/sources')        return await handleSources(request, env);
      if (p === '/feed/refresh')        return assertMethod(request, 'POST', () => handleFeedRefresh(request, env));

      if (p === '/push/subscribe')      return assertMethod(request, 'POST', () => handlePushSubscribe(request, env));
      if (p === '/push/unsubscribe')    return assertMethod(request, 'DELETE', () => handlePushUnsubscribe(request, env));
      if (p === '/push/test')           return assertMethod(request, 'POST', () => handlePushTest(request, env));

      if (p === '/vapid/public')        return json({ publicKey: env.VAPID_PUBLIC_KEY || '' });

      if (p === '/monitoring')          return await handleMonitoring(request, env);
      if (p === '/health/ping')         return assertMethod(request, 'POST', () => handleHealthPing(request, env));
      if (p === '/cron/run')            return assertMethod(request, 'POST', () => handleCronRun(request, env, url));

      if (p === '/llm')                 return assertMethod(request, 'POST', () => handleLlm(request, env));

      // Workers AI (paid plan) — all auth-gated like the LLM proxy.
      if (p === '/transcribe')          return assertMethod(request, 'POST', () => authed(request, env, () => handleTranscribe(request, env, json)));
      if (p === '/memory/index')        return assertMethod(request, 'POST', () => authed(request, env, () => handleMemoryIndex(request, env, json)));
      if (p === '/memory/search')       return assertMethod(request, 'POST', () => authed(request, env, () => handleMemorySearch(request, env, json)));
      if (p === '/memory/forget')       return assertMethod(request, 'DELETE', () => authed(request, env, () => handleMemoryForget(request, env, json)));

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === '*/10 * * * *') {
      ctx.waitUntil(aggregateFeed(env));
    } else if (cron === '*/5 6-23 * * *') {
      ctx.waitUntil(checkDisruptions(env));
    } else if (cron === '0 5 * * *') {
      ctx.waitUntil(sendMorningBriefPush(env));
    } else if (cron === '0 16 * * *') {
      ctx.waitUntil(checkLastTrainsTonight(env));
    } else if (cron === '0 21 * * *') {
      ctx.waitUntil(sendHealthReminder(env));
    }
  },
};

// ====================================================================
// HTTP helpers
// ====================================================================

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LLM-Endpoint, X-LLM-Key, X-LLM-Auth-Style, X-LLM-Format',
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

// Guard a handler behind the sync token — used by the Workers AI endpoints.
async function authed(request, env, fn) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
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
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  // Raw IPv6 (URL hostname keeps the brackets) and any IPv4-shaped host in
  // private/reserved space. Plain-number hosts (decimal/hex IPs) blocked too.
  if (h.startsWith('[')) return false;
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return false;
  if (h === '0.0.0.0' || h.startsWith('127.') || h.startsWith('10.')
      || h.startsWith('169.254.') || h.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
      || /^100\.(6[4-9]|[7-9]\d|1[0-2][0-7])\./.test(h)) return false;
  return true;
}

async function handleProxy(url, request, env) {
  // Auth required — without it this is an open proxy anyone can burn
  // quota and IP reputation through.
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const target = url.searchParams.get('url');
  if (!target) return json({ error: 'missing url' }, 400);
  if (!isProxyTargetAllowed(target)) return json({ error: 'target not allowed' }, 400);

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bob-proxy/1.0)' },
      cf: { cacheTtl: 600, cacheEverything: true },
      signal: AbortSignal.timeout(10_000),
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
  await env.KV.delete(KEY_MONITORING);          // holds the plaintext IDFM key
  await env.KV.delete(KEY_HEALTH_PING);
  await env.KV.delete(KEY_ALERTED_DISRUPTIONS);
  await env.KV.delete(KEY_LAST_TRAIN_ALERTED);
  return json({ ok: true });
}

// ====================================================================
// /feed (aggregation)
// ====================================================================

async function handleGetFeed(request, env, ctx) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const raw = await env.KV.get(KEY_FEED);
  if (!raw) {
    // Cold start — kick off an aggregation in the background so the next
    // visit hits a populated cache.
    if (ctx) ctx.waitUntil(aggregateFeed(env).catch(() => {}));
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
  let sub;
  try { sub = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  if (!sub?.endpoint || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')
      || !sub.keys?.p256dh || !sub.keys?.auth) {
    return json({ error: 'invalid subscription shape' }, 400);
  }
  await env.KV.put(KEY_PUSH, JSON.stringify({
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  }));
  return json({ ok: true });
}

async function handlePushUnsubscribe(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.KV.delete(KEY_PUSH);
  return json({ ok: true });
}

async function handlePushTest(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const subRaw = await env.KV.get(KEY_PUSH);
  if (!subRaw) return json({ error: 'aucune souscription enregistrée' }, 404);
  const sub = JSON.parse(subRaw);
  try {
    const resp = await sendWebPush({
      subscription: sub,
      payload: JSON.stringify({
        title: 'Bob · test',
        body: 'Si tu vois ce message, les notifications sont prêtes.',
        tag: 'bob-test',
        url: '/',
      }),
      vapid: vapidConfig(env),
      urgency: 'normal',
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return json({ error: `push ${resp.status}: ${text.slice(0, 200)}` }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ====================================================================
// /monitoring — client pushes IDFM key + alert preferences. The data is
// not part of the encrypted sync blob because the scheduled tasks need
// to read it without user interaction. Trust level: same as the YouTube
// channels list (plaintext in user-owned KV).
// ====================================================================

async function handleCronRun(request, env, url) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const task = url.searchParams.get('task') || '';
  switch (task) {
    case 'feed':         await aggregateFeed(env); break;
    case 'disruptions':  await checkDisruptions(env); break;
    case 'last-trains':  await checkLastTrainsTonight(env); break;
    case 'brief':        await sendMorningBriefPush(env); break;
    case 'health':       await sendHealthReminder(env); break;
    default: return json({ error: 'unknown task' }, 400);
  }
  return json({ ok: true, task });
}

async function handleHealthPing(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { date, slot } = body || {};
  if (typeof date !== 'string' || typeof slot !== 'string') {
    return json({ error: 'date and slot required' }, 400);
  }
  await env.KV.put(KEY_HEALTH_PING, JSON.stringify({ lastEntryDate: date, lastSlot: slot, ts: Date.now() }));
  return json({ ok: true });
}

async function handleMonitoring(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_MONITORING);
    return new Response(raw || '{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    await env.KV.put(KEY_MONITORING, JSON.stringify(body));
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// ====================================================================
// Push helpers
// ====================================================================

function vapidConfig(env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:bob@local',
  };
}

async function getSubscription(env) {
  const raw = await env.KV.get(KEY_PUSH);
  return raw ? JSON.parse(raw) : null;
}

async function getMonitoring(env) {
  const raw = await env.KV.get(KEY_MONITORING);
  const mon = raw ? JSON.parse(raw) : {};
  // Normalise line ids to the navitia format — older clients pushed the
  // SIRI format (STIF:Line::Cxxxxx:) which 404s on /lines/{id}/disruptions.
  if (Array.isArray(mon.idfmLines)) {
    mon.idfmLines = mon.idfmLines
      .map(id => {
        const m = (id || '').match(/C\d{5}/);
        return m ? `line:IDFM:${m[0]}` : null;
      })
      .filter(Boolean);
  }
  return mon;
}

async function pushOne(env, payload, opts = {}) {
  const sub = await getSubscription(env);
  if (!sub) return false;
  try {
    const resp = await sendWebPush({
      subscription: sub,
      payload: JSON.stringify(payload),
      vapid: vapidConfig(env),
      urgency: opts.urgency || 'normal',
      ttl: opts.ttl ?? 43200,
    });
    if (resp.status === 404 || resp.status === 410) {
      // Subscription gone — wipe so we don't keep retrying.
      await env.KV.delete(KEY_PUSH);
    }
    return resp.ok;
  } catch (e) {
    console.error('push failed', e.message);
    return false;
  }
}

// ====================================================================
// Cron tasks
// ====================================================================

// Morning brief push — just nudges the user; the actual digest is generated
// when they open Bob (the LLM key never leaves the device).
async function sendMorningBriefPush(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.morningBrief === false) return;
  await pushOne(env, {
    title: 'Brief du jour',
    body: 'L\'éditorial t\'attend dans Bob → Pro.',
    tag: 'bob-brief',
    url: '/?goto=pro',
  }, { urgency: 'normal' });
}

// Evening reminder — fired at 23h Paris. Quiet, just a hint.
async function sendHealthReminder(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.healthReminder === false) return;
  // Skip if the client logged a recent entry today.
  const pingRaw = await env.KV.get(KEY_HEALTH_PING);
  if (pingRaw) {
    try {
      const ping = JSON.parse(pingRaw);
      const todayISO = new Date().toISOString().slice(0, 10);
      if (ping.lastEntryDate === todayISO && ping.lastSlot === 'soir') return;
    } catch {}
  }
  await pushOne(env, {
    title: 'Suivi santé',
    body: 'Saisi ton soir ? Une minute suffit.',
    tag: 'bob-health',
    url: '/?goto=projets',
  }, { urgency: 'low' });
}

// IDFM disruption watch — checks the user's lines and pushes once per
// previously-unseen disruption.
async function checkDisruptions(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.trainAlerts === false) return;
  if (!mon.idfmKey || !Array.isArray(mon.idfmLines) || mon.idfmLines.length === 0) return;

  const alertedRaw = await env.KV.get(KEY_ALERTED_DISRUPTIONS);
  const alerted = new Set(alertedRaw ? JSON.parse(alertedRaw) : []);
  const stillActive = new Set();
  const newAlerts = [];
  let anyLineFailed = false;

  for (const lineId of mon.idfmLines) {
    try {
      const url = `https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/lines/${encodeURIComponent(lineId)}/disruptions`;
      const r = await fetch(url, {
        headers: { 'apikey': mon.idfmKey },
        cf: { cacheTtl: 0 },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) { anyLineFailed = true; continue; }
      const data = await r.json();
      const list = data.disruptions || [];
      const now = Date.now();
      for (const d of list) {
        if (!isImpactful(d)) continue;
        const ends = (d.application_periods || []).map(p => parseNavitiaDate(p.end)).filter(Boolean);
        if (ends.length && ends.every(t => t < now)) continue;
        // Track for expiry-pruning only the ids we already notified; new ones
        // join the persisted set after a SUCCESSFUL push (or as backlog).
        if (alerted.has(d.id)) { stillActive.add(d.id); continue; }
        const summary = compactDisruptionText(d);
        newAlerts.push({ id: d.id, line: lineMnemonic(lineId), summary, rank: severityRank(d) });
      }
    } catch (e) {
      anyLineFailed = true;
      console.error('disruption fetch failed for', lineId, e.message);
    }
  }

  // Snapshot what was previously alerted BEFORE the send loop mutates the
  // set — comparing after meant a freshly-sent alert looked "unchanged",
  // the KV write was skipped, and the same disruption re-pushed every 5 min.
  const previous = Array.from(alerted).sort();

  // Send one push per new alert — max 3 per cycle, the most severe first.
  // The rest are still persisted as "seen" so a backlog of minor
  // disruptions can never flood the user.
  newAlerts.sort((a, b) => a.rank - b.rank);
  let anyPushFailed = false;
  for (const a of newAlerts.slice(0, 3)) {
    const ok = await pushOne(env, {
      title: `${a.line} · perturbation`,
      body: a.summary.slice(0, 180),
      tag: `bob-disr-${a.id}`,
      url: '/?goto=trains',
    }, { urgency: 'high', ttl: 6 * 3600 });
    if (ok) { alerted.add(a.id); stillActive.add(a.id); }
    else anyPushFailed = true;
  }
  // The un-pushed remainder (beyond the 3-cap) is swallowed as seen so a
  // backlog of minor disruptions can never trickle-spam over cycles —
  // unless a delivery failed, in which case we retry everything next cycle.
  if (!anyPushFailed) {
    for (const a of newAlerts.slice(3)) { alerted.add(a.id); stillActive.add(a.id); }
  }

  // Persist the active set so each disruption alerts exactly once. When a
  // line fetch failed, keep the previous IDs too — pruning them now would
  // re-alert the same disruption when the API recovers. Skip the write
  // when truly nothing changed (this cron runs every 5 min).
  const persistSet = anyLineFailed ? new Set([...alerted, ...stillActive]) : stillActive;
  const persist = Array.from(persistSet).sort();
  if (JSON.stringify(persist) !== JSON.stringify(previous)) {
    await env.KV.put(KEY_ALERTED_DISRUPTIONS, JSON.stringify(persist));
  }
}

// Lower = more severe = pushed first when several disruptions are new.
function severityRank(d) {
  const effect = (d.severity?.effect || '').toUpperCase();
  if (effect === 'NO_SERVICE') return 0;
  if (effect === 'REDUCED_SERVICE') return 1;
  if (effect === 'SIGNIFICANT_DELAYS') return 2;
  if (effect === 'DETOUR' || effect === 'MODIFIED_SERVICE') return 3;
  return 4;
}

function lineMnemonic(lineId) {
  if (lineId.includes('C01739')) return 'Transilien J';
  if (lineId.includes('C01742')) return 'RER A';
  if (lineId.includes('C01641')) return 'Noctilien N152';
  return 'Ligne';
}

// Permissive filter: surface any disruption with a user-facing message and
// an application period that's active right now or starting within ~12 h.
// Severity classifications from IDFM are inconsistent (planned engineering
// works often land under REDUCED_SERVICE or just have no severity at all),
// so we trust the human message and the time window.
function isImpactful(d, withinHours = 12) {
  const text = (d.messages?.[0]?.text || '').trim();
  if (!text) return false;

  const now = Date.now();
  const cutoff = now + withinHours * 3600 * 1000;
  const periods = d.application_periods || [];
  if (periods.length === 0) return true;

  for (const p of periods) {
    const start = parseNavitiaDate(p.begin);
    const end   = parseNavitiaDate(p.end);
    if ((!start || start <= cutoff) && (!end || end >= now)) return true;
  }
  return false;
}

function compactDisruptionText(d) {
  const msg = (d.messages?.[0]?.text || '').toString().trim();
  // Strip HTML
  return msg.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || 'Trafic perturbé sur la ligne.';
}

// ---- Paris time helpers -------------------------------------------------
// Workers run in UTC; Navitia timestamps are Europe/Paris local. Convert
// explicitly or every comparison drifts by 1-2 h.

function parisOffsetMs(utcDate = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcDate).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - utcDate.getTime();
}

// Navitia "YYYYMMDDTHHmmss" (Paris local) → epoch ms
function parseNavitiaDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return utcGuess - parisOffsetMs(new Date(utcGuess));
}

// epoch ms → { h, m } in Paris local time
function parisHourMin(epochMs) {
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return { h: +parts.hour % 24, m: +parts.minute };
}

// Daily 18 h Paris check — asks the journey planner for tonight's LAST
// arrival home on each line and warns the user if it lands significantly
// earlier than usual (engineering works, last-train-of-night cuts that
// the disruption API often hides).
async function checkLastTrainsTonight(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.trainAlerts === false) return;
  if (!mon.idfmKey || !mon.stops?.paris || !mon.stops?.home) return;

  const lineJ    = 'line:IDFM:C01739';
  const lineRerA = 'line:IDFM:C01742';
  // Probe from 21h Paris so the 50-journey window reaches end of service.
  const dt = navitiaDtParisToday(21, 0);

  const probes = [
    { label: 'Transilien J',  dest: 'Conflans FdO', line: lineJ,    from: mon.stops.paris,    to: mon.stops.home,    earlyThreshold: 23 * 60 + 30 },
    { label: 'RER A',         dest: 'Conflans FdO', line: lineRerA, from: mon.stops.paris,    to: mon.stops.home,    earlyThreshold: 23 * 60 + 45 },
  ];
  if (mon.stops.homeAlt) {
    probes.push({ label: 'Transilien J', dest: 'Conflans SH', line: lineJ, from: mon.stops.paris, to: mon.stops.homeAlt, earlyThreshold: 23 * 60 + 30 });
  }

  // `false` = the API errored (don't alert), `null` = API answered with no
  // journeys (that IS the alert-worthy case).
  const results = await Promise.all(probes.map(p => lastJourneyTonight(mon.idfmKey, p, dt).catch(() => false)));

  const findings = [];
  for (let i = 0; i < probes.length; i++) {
    const r = results[i];
    if (r === false) continue;   // transient API failure — skip, don't false-alert
    if (r === null) {
      findings.push({ probe: probes[i], type: 'none', text: 'aucun départ trouvé ce soir' });
      continue;
    }
    if (!r.departMs) continue;   // parse glitch on an existing journey — skip
    // Compare in Paris local time — the Worker clock is UTC.
    const { h, m } = parisHourMin(r.departMs);
    const minOfDay = h * 60 + m;
    // Past-midnight departures (h < 4) are end-of-service, never "early".
    if (h >= 4 && minOfDay < probes[i].earlyThreshold) {
      findings.push({
        probe: probes[i],
        type: 'early',
        text: `dernier départ ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      });
    }
  }

  if (findings.length === 0) return;

  const todayKey = new Date().toISOString().slice(0, 10);
  const alertedRaw = await env.KV.get(KEY_LAST_TRAIN_ALERTED);
  const alerted = alertedRaw ? JSON.parse(alertedRaw) : {};
  // Reset alerted map daily — keep only today's entry to bound size.
  const stillAlerted = alerted[todayKey] || {};
  const sig = findings.map(f => `${f.probe.label}-${f.probe.dest}-${f.type}`).join('|');
  if (stillAlerted.sig === sig) return;  // identical alert already sent today

  const summary = findings.map(f => `${f.probe.label} → ${f.probe.dest} : ${f.text}`).join(' · ');
  await pushOne(env, {
    title: 'Trains ce soir',
    body: summary.slice(0, 220),
    tag: 'bob-last-trains',
    url: '/?goto=trains',
  }, { urgency: 'high', ttl: 8 * 3600 });

  await env.KV.put(KEY_LAST_TRAIN_ALERTED, JSON.stringify({ [todayKey]: { sig, ts: Date.now() } }));
}

async function lastJourneyTonight(apiKey, probe, dt) {
  // count=50 from 21h Paris covers end-of-service even on a frequent line —
  // querying from "now" returns 50 journeys ending mid-evening and would
  // mislabel the 50th as the "last".
  const url = `https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys`
            + `?from=${probe.from.lon};${probe.from.lat}`
            + `&to=${probe.to.lon};${probe.to.lat}`
            + `&datetime=${dt}`
            + `&allowed_id[]=${encodeURIComponent(probe.line)}`
            + `&count=50`;
  const r = await fetch(url, { headers: { 'apikey': apiKey }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) return false;        // API failure ≠ "no journeys tonight"
  const data = await r.json();
  if (data.error) return false;
  const journeys = data.journeys || [];
  if (journeys.length === 0) return null;
  const last = journeys[journeys.length - 1];
  return { departMs: parseNavitiaDate(last.departure_date_time) };
}

// "YYYYMMDDTHHmmss" for a given Paris local hour today
function navitiaDtParisToday(hour, minute = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = fmt.format(new Date()).split('-');
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}${mo}${d}T${pad(hour)}${pad(minute)}00`;
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
      // Generous — long generations stream for a while, but a wedged
      // upstream must not hold the Worker open forever.
      signal: AbortSignal.timeout(120_000),
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
  // Dedupe baseline against ALL user entries (enabled or not) — a user who
  // disabled a baseline feed must not get it re-fetched via the baseline.
  const allUserUrls = new Set((sources.rss || []).map(s => s.url).filter(Boolean));
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
  const resp = await fetch(src.url, {
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

// ---- XML utils --------------------------------------------------------

function decodeXml(s) {
  // &amp; decoded LAST or "&amp;lt;" double-decodes into a real "<".
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanXmlText(s) {
  // strip CDATA wrappers
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

// Atom entries can carry several <link> tags (self, enclosure, alternate)
// with attributes in any order and either quote style. Prefer
// rel="alternate", fall back to the first link that isn't self/enclosure.
function pickAtomLink(entryXml) {
  const tags = [...entryXml.matchAll(/<link\b[^>]*>/g)].map(m => m[0]);
  let fallback = '';
  for (const tag of tags) {
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (!href) continue;
    const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (rel === 'alternate' || rel === '') {
      if (rel === 'alternate') return href;
      if (!fallback) fallback = href;
    }
  }
  return fallback;
}

function stripHtml(s) {
  return cleanXmlText(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
