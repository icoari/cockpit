// End-to-end encrypted cloud sync against the Bob Worker.
//
// Local sync state lives at bob-sync-v1:
//   { salt, authToken, dataKeyHex, lastPushedAt, lastPushedHash }
//
// Worker exposes:
//   GET  /sync/salt
//   POST /sync/setup   { salt, authHash }
//   GET  /sync/data    Authorization: Bearer <authToken>
//   POST /sync/data    { iv, ciphertext, version }
//   DELETE /sync/wipe

import {
  deriveKeys, importDataKey, encrypt, decrypt,
  sha256Hex, randomSalt,
} from './crypto.js';

export const WORKER_URL = 'https://bob.jz7w76ry59.workers.dev';
const LS_KEY = 'bob-sync-v1';
const PUSH_DEBOUNCE_MS = 5_000;

function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeLocal(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

function clearLocal() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

export function isSyncEnabled() {
  const s = readLocal();
  return !!(s?.authToken && s?.dataKeyHex);
}

export function getSyncMeta() {
  const s = readLocal();
  if (!s) return null;
  return { lastPushedAt: s.lastPushedAt || null };
}

// One-shot remote setup. Called the first time the user enables sync ANYWHERE.
// Subsequent devices use unlockSync() instead.
export async function setupSync(passphrase) {
  const remote = await fetch(`${WORKER_URL}/sync/salt`).then(r => r.json());
  if (remote.setup) {
    throw new Error('Sync déjà activé sur ce compte. Utilise « Restaurer » à la place.');
  }

  const salt = randomSalt();
  const { authToken, dataKeyHex } = await deriveKeys(passphrase, salt);
  const authHash = await sha256Hex(authToken);

  const resp = await fetch(`${WORKER_URL}/sync/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salt, authHash }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Setup HTTP ${resp.status}`);
  }
  writeLocal({ salt, authToken, dataKeyHex });
  return { salt };
}

// Re-derive keys from passphrase on a fresh device, verify against the Worker,
// then pull the existing backup if any.
export async function unlockSync(passphrase) {
  const remote = await fetch(`${WORKER_URL}/sync/salt`).then(r => r.json());
  if (!remote.setup) {
    throw new Error('Aucune sauvegarde n\'existe — active la sync d\'abord sur un appareil.');
  }
  const { authToken, dataKeyHex, dataKey } = await deriveKeys(passphrase, remote.salt);

  // Probe with a GET — 401 means the passphrase is wrong.
  const probe = await fetch(`${WORKER_URL}/sync/data`, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  if (probe.status === 401) throw new Error('Passphrase incorrecte.');
  if (!probe.ok) throw new Error(`Erreur Worker (HTTP ${probe.status}).`);

  writeLocal({ salt: remote.salt, authToken, dataKeyHex });

  const payload = await probe.json();
  if (!payload) return null;
  const plaintext = await decrypt(payload.iv, payload.ciphertext, dataKey);
  return { state: JSON.parse(plaintext), updatedAt: payload.updatedAt };
}

let pushTimer = null;
let pushPending = null;
let pushInFlight = null;   // promise of the currently-running push, if any

// Schedule an encrypted push. buildPayload() is called inside the debounced
// callback so the payload reflects the LATEST state, not the value at the
// moment schedulePush() was first hit.
export function schedulePush(buildPayload) {
  if (!isSyncEnabled()) return;
  pushPending = buildPayload;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(runPush, PUSH_DEBOUNCE_MS);
}

// True when an edit is waiting in the debounce window or being sent.
export function hasPendingPush() {
  return !!(pushPending || pushInFlight);
}

async function runPush() {
  // Serialize pushes — two interleaved POSTs can persist lastPushedAt out
  // of order and make pullIfNewer re-pull our own blob.
  if (pushInFlight) {
    await pushInFlight;
    if (!pushPending) return;
  }
  if (!pushPending) return;
  const buildPayload = pushPending;
  pushPending = null;

  pushInFlight = (async () => {
    try {
      const plaintext = buildPayload();
      if (plaintext == null) return;
      const hash = await sha256Hex(plaintext);
      const local = readLocal();
      if (!local) return;
      if (local.lastPushedHash === hash) return;   // identical to last push, skip

      const dataKey = await importDataKey(local.dataKeyHex);
      const { iv, ciphertext } = await encrypt(plaintext, dataKey);

      const resp = await fetch(`${WORKER_URL}/sync/data`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${local.authToken}`,
        },
        body: JSON.stringify({ iv, ciphertext, version: 1 }),
      });
      if (!resp.ok) {
        console.warn('[sync] push failed', resp.status);
        return;
      }
      const data = await resp.json();
      writeLocal({ ...readLocal(), lastPushedHash: hash, lastPushedAt: data.updatedAt });
    } catch (e) {
      console.warn('[sync] push error', e);
    } finally {
      pushInFlight = null;
    }
  })();
  await pushInFlight;
}

// Force-push the current snapshot immediately, bypassing the 5 s debounce.
export async function pushNow(buildPayload) {
  if (!isSyncEnabled()) throw new Error('Sync non activée.');
  pushPending = buildPayload;
  clearTimeout(pushTimer);
  await runPush();
  const local = readLocal();
  return { updatedAt: local?.lastPushedAt || null };
}

// Pull the remote blob only if it's strictly newer than what we last
// pushed from this device. Updates the local lastPushedAt/Hash so the
// next check is idempotent. Used at startup + on tab focus.
export async function pullIfNewer() {
  if (!isSyncEnabled()) return null;
  const local = readLocal();
  if (!local) return null;
  const lastPushedAt = local.lastPushedAt || 0;

  let resp;
  try {
    resp = await fetch(`${WORKER_URL}/sync/data`, {
      headers: { 'Authorization': `Bearer ${local.authToken}` },
    });
  } catch { return null; }
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data || !data.updatedAt) return null;
  // Skip if remote isn't meaningfully newer (avoid round-trip races).
  if (data.updatedAt <= lastPushedAt + 1500) return null;

  const dataKey = await importDataKey(local.dataKeyHex);
  const plaintext = await decrypt(data.iv, data.ciphertext, dataKey);
  const hash = await sha256Hex(plaintext);
  writeLocal({ ...local, lastPushedAt: data.updatedAt, lastPushedHash: hash });
  return { state: JSON.parse(plaintext), updatedAt: data.updatedAt };
}

// Convenience: push any unsynced local change first, then pull if remote
// turns out to be newer. The sequence avoids clobbering pending local edits.
export async function startupReconcile(buildPayload) {
  if (!isSyncEnabled()) return null;
  try { await pushNow(buildPayload); } catch {}
  return pullIfNewer();
}

// Force-pull the remote blob (e.g. on startup or via a manual button).
export async function pullNow() {
  if (!isSyncEnabled()) return null;
  const local = readLocal();
  const resp = await fetch(`${WORKER_URL}/sync/data`, {
    headers: { 'Authorization': `Bearer ${local.authToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data) return null;
  const dataKey = await importDataKey(local.dataKeyHex);
  const plaintext = await decrypt(data.iv, data.ciphertext, dataKey);
  return { state: JSON.parse(plaintext), updatedAt: data.updatedAt };
}

// Forget the keys locally — does NOT touch the remote backup.
export function disableSyncLocally() {
  clearLocal();
}

// Wipe everything on the Worker too (irreversible).
export async function wipeRemote() {
  const local = readLocal();
  if (!local) return;
  await fetch(`${WORKER_URL}/sync/wipe`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${local.authToken}` },
  });
  clearLocal();
}
