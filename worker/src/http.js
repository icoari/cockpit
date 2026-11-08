// HTTP helpers — CORS, JSON responses, bounded body reading, auth.

import { KEY_AUTH } from './keys.js';

// Browser origins allowed to read responses: the GitHub Pages fronts, plus
// any local dev server.
const ALLOWED_ORIGIN = 'https://icoari.github.io';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function isAllowedOrigin(origin) {
  return origin === ALLOWED_ORIGIN || LOCAL_ORIGIN.test(origin);
}

export function corsHeaders(request) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-LLM-Endpoint, X-LLM-Key, X-LLM-Auth-Style, X-LLM-Format',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const origin = request.headers.get('Origin') || '';
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// Applied once by the router to every response, streamed bodies included.
export function withCors(response, request) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders(request))) out.headers.set(k, v);
  return out;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Raw JSON string already serialised (KV values) — served as-is.
export function rawJson(raw) {
  return new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function assertMethod(request, method, fn) {
  if (request.method !== method) return json({ error: `${method} only` }, 405);
  return fn();
}

// JSON.parse for stored values: a corrupted or missing entry yields the
// fallback instead of throwing.
export function safeJson(str, fallback = null) {
  if (str == null || str === '') return fallback;
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Read the request body up to `maxBytes`. Returns { bytes } or { response }
// (413) — the stream is cancelled as soon as the cap is crossed.
export async function readBodyLimited(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { response: json({ error: 'payload too large' }, 413) };
  }
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { response: json({ error: 'payload too large' }, 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return { bytes };
}

// Bounded JSON body. Returns { value } or { response } (413 / 400).
export async function readJsonLimited(request, maxBytes) {
  const { bytes, response } = await readBodyLimited(request, maxBytes);
  if (response) return { response };
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { response: json({ error: 'invalid json' }, 400) };
  }
}

// ---- Auth ---------------------------------------------------------------

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token || token.length > 200) return false;
  const stored = hexToBytes(await env.KV.get(KEY_AUTH));
  if (!stored || stored.byteLength !== 32) return false;
  const incoming = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return crypto.subtle.timingSafeEqual(incoming, stored);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// True when the caller's IP is over the AUTH_LIMITER budget. A missing or
// failing binding never blocks a request.
export async function isRateLimited(request, env) {
  const limiter = env.AUTH_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return false;
  try {
    const { success } = await limiter.limit({ key: clientIp(request) });
    return !success;
  } catch (err) {
    console.error('rate limiter failed', err);
    return false;
  }
}

// Returns null when authorised, otherwise the error response to send.
// Only failed attempts count against the rate limit.
export async function requireAuth(request, env) {
  if (await verifyAuth(request, env)) return null;
  if (await isRateLimited(request, env)) return json({ error: 'too many requests' }, 429, { 'Retry-After': '60' });
  return json({ error: 'unauthorized' }, 401);
}

// Guard a handler behind the sync token.
export async function authed(request, env, fn) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  return fn();
}
