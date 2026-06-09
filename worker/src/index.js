// Bob backend Worker
// Routes:
//   GET    /proxy?url=...        CORS proxy with edge caching
//   GET    /sync/salt            returns { setup: bool, salt? }
//   POST   /sync/setup           body: { salt, authHash } - one-shot setup
//   GET    /sync/data            returns the encrypted blob (auth required)
//   POST   /sync/data            body: { iv, ciphertext, version }
//   DELETE /sync/wipe            wipes all sync state (auth required)

const KV_PREFIX = 'bobsync:';
const KEY_SALT = KV_PREFIX + 'salt';
const KEY_AUTH = KV_PREFIX + 'authHash';
const KEY_DATA = KV_PREFIX + 'data';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      switch (url.pathname) {
        case '/':
        case '/health':
          return json({ ok: true, service: 'bob' });
        case '/proxy':
          return await handleProxy(url);
        case '/sync/salt':
          return await handleGetSalt(env);
        case '/sync/setup':
          if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
          return await handleSetup(request, env);
        case '/sync/data':
          if (request.method === 'GET') return await handleGetData(request, env);
          if (request.method === 'POST') return await handlePutData(request, env);
          return json({ error: 'method not allowed' }, 405);
        case '/sync/wipe':
          if (request.method !== 'DELETE') return json({ error: 'DELETE only' }, 405);
          return await handleWipe(request, env);
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500);
    }
  },
};

// ---------------- helpers ----------------

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
  // constant-time comparison
  if (incoming.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < incoming.length; i++) diff |= incoming.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

// ---------------- /proxy ----------------

function isProxyTargetAllowed(target) {
  let u;
  try { u = new URL(target); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  // Block obvious internal / loopback
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

// ---------------- /sync ----------------

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

async function handleGetData(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  const raw = await env.KV.get(KEY_DATA);
  if (!raw) return json(null);
  return new Response(raw, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function handlePutData(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { iv, ciphertext, version } = body || {};
  if (typeof iv !== 'string' || typeof ciphertext !== 'string') {
    return json({ error: 'iv and ciphertext required' }, 400);
  }
  if (ciphertext.length > 8 * 1024 * 1024) {
    // KV value limit is 25 MB but let's be reasonable for sync payloads
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

async function handleWipe(request, env) {
  if (!await verifyAuth(request, env)) return json({ error: 'unauthorized' }, 401);
  await env.KV.delete(KEY_SALT);
  await env.KV.delete(KEY_AUTH);
  await env.KV.delete(KEY_DATA);
  return json({ ok: true });
}
