// Google Calendar OAuth (authorization-code flow with refresh token)
//
// The browser does an interactive consent once via GIS initCodeClient and
// sends us the auth code. We exchange it for a refresh token (stored here,
// like the IDFM key) + an access token. Thereafter the client asks us to
// mint fresh access tokens from the refresh token — no re-consent.
//
// The client_id is public and sent by the client; only the client_secret is
// a Worker secret (wrangler secret put GOOGLE_CLIENT_SECRET).

import { KEY_GOOGLE } from './keys.js';
import { json, requireAuth, safeJson } from './http.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function postToken(params) {
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await r.json();
  return { r, data };
}

export async function handleGoogleExchange(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const secret = env.GOOGLE_CLIENT_SECRET;
  if (!secret) return json({ error: 'GOOGLE_CLIENT_SECRET non configuré sur le Worker' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { code, clientId, redirectUri } = body || {};
  if (!code || !clientId) return json({ error: 'code and clientId required' }, 400);

  const params = new URLSearchParams({
    code, client_id: clientId, client_secret: secret,
    redirect_uri: redirectUri || 'postmessage',
    grant_type: 'authorization_code',
  });
  let data;
  try {
    const res = await postToken(params);
    data = res.data;
    if (!res.r.ok) return json({ error: data.error_description || data.error || `exchange HTTP ${res.r.status}` }, 502);
  } catch (err) {
    console.error('google exchange failed', err);
    return json({ error: 'exchange failed' }, 502);
  }
  // Persist the refresh token (only returned on first consent / prompt=consent).
  if (data.refresh_token) {
    await env.KV.put(KEY_GOOGLE, JSON.stringify({ refresh_token: data.refresh_token, clientId }));
  }
  return json({ access_token: data.access_token, expires_in: data.expires_in || 3600, got_refresh: !!data.refresh_token });
}

export async function handleGoogleToken(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const secret = env.GOOGLE_CLIENT_SECRET;
  if (!secret) return json({ error: 'GOOGLE_CLIENT_SECRET non configuré sur le Worker' }, 500);
  const stored = safeJson(await env.KV.get(KEY_GOOGLE), null);
  if (!stored || !stored.refresh_token) return json({ error: 'no_refresh_token' }, 409);
  let clientId = stored.clientId;
  try { const b = await request.json(); if (b && b.clientId) clientId = b.clientId; } catch {}
  if (!clientId) return json({ error: 'no client id' }, 400);

  const params = new URLSearchParams({
    client_id: clientId, client_secret: secret,
    refresh_token: stored.refresh_token, grant_type: 'refresh_token',
  });
  let data;
  try {
    const res = await postToken(params);
    data = res.data;
    if (!res.r.ok) {
      // Refresh token revoked / expired (e.g. consent screen still in Testing
      // mode → 7-day expiry). Drop it so the client re-consents cleanly.
      if (data.error === 'invalid_grant') { await env.KV.delete(KEY_GOOGLE); return json({ error: 'refresh_revoked' }, 409); }
      return json({ error: data.error_description || data.error || `refresh HTTP ${res.r.status}` }, 502);
    }
  } catch (err) {
    console.error('google refresh failed', err);
    return json({ error: 'refresh failed' }, 502);
  }
  return json({ access_token: data.access_token, expires_in: data.expires_in || 3600 });
}
