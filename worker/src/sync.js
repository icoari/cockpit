// /sync — end-to-end encrypted blob storage. The Worker only ever sees the
// salt, a SHA-256 of the auth token and the ciphertext.

import { KEY_SALT, KEY_AUTH, KEY_DATA, ALL_KEYS } from './keys.js';
import { json, rawJson, requireAuth, isRateLimited } from './http.js';

export async function handleGetSalt(env) {
  const salt = await env.KV.get(KEY_SALT);
  if (!salt) return json({ setup: false });
  return json({ setup: true, salt });
}

export async function handleSetup(request, env) {
  if (await isRateLimited(request, env)) return json({ error: 'too many requests' }, 429, { 'Retry-After': '60' });
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

export async function handleSyncData(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_DATA);
    if (!raw) return json(null);
    return rawJson(raw);
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

export async function handleWipe(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  await Promise.all(ALL_KEYS.map(k => env.KV.delete(k)));
  return json({ ok: true });
}
