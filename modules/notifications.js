// Web Push subscription + monitoring config sync against the Worker.
// iOS specifics: push only works for a PWA added to the Home Screen.

import { WORKER_URL } from './sync.js';
import { getSettings } from './state.js';

function getSyncAuth() {
  try {
    const raw = localStorage.getItem('bob-sync-v1');
    const s = raw ? JSON.parse(raw) : null;
    return s?.authToken || null;
  } catch { return null; }
}

function authedHeaders() {
  const tok = getSyncAuth();
  return tok
    ? { 'Authorization': `Bearer ${tok}` }
    : null;
}

export function supportsPush() {
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}

export function permissionStatus() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function getVapidPublicKey() {
  const resp = await fetch(`${WORKER_URL}/vapid/public`);
  const data = await resp.json();
  if (!data.publicKey) throw new Error('VAPID public key indisponible');
  return data.publicKey;
}

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

function arrayBufferToB64Url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Subscribe (request permission first if needed) and send the subscription
// to the Worker. Returns the subscription on success.
export async function subscribePush() {
  if (!supportsPush()) throw new Error('Cet appareil ne supporte pas Web Push. Sur iOS, ajoute Bob à l\'écran d\'accueil d\'abord.');
  const auth = authedHeaders();
  if (!auth) throw new Error('Active la sauvegarde cloud d\'abord.');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permission refusée par le navigateur.');

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    const pubKey = await getVapidPublicKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pubKey),
    });
  }

  // Serialize subscription to JSON (keys returned as raw buffers).
  const json = sub.toJSON();
  const resp = await fetch(`${WORKER_URL}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(json),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return json;
}

export async function unsubscribePush() {
  const auth = authedHeaders();
  if (!auth) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {}
  try {
    await fetch(`${WORKER_URL}/push/unsubscribe`, {
      method: 'DELETE',
      headers: auth,
    });
  } catch {}
}

export async function isSubscribed() {
  if (!supportsPush()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return false; }
}

export async function sendTestPush() {
  const auth = authedHeaders();
  if (!auth) throw new Error('Sync requise.');
  const resp = await fetch(`${WORKER_URL}/push/test`, {
    method: 'POST',
    headers: auth,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }
}

// ---------- Monitoring config ----------

export async function pushMonitoring() {
  const auth = authedHeaders();
  if (!auth) return;
  const s = getSettings();
  const alerts = s.alerts || {};
  const body = {
    idfmKey: s.idfm?.apiKey || '',
    idfmLines: [
      s.idfm?.lines?.transilienJ,
      s.idfm?.lines?.rerA,
    ].filter(Boolean),
    alerts: {
      trainAlerts:     alerts.trainAlerts     !== false,
      morningBrief:    alerts.morningBrief    !== false,
      healthReminder:  alerts.healthReminder  !== false,
    },
  };
  try {
    await fetch(`${WORKER_URL}/monitoring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
  } catch { /* will retry on next push */ }
}

export async function pingHealth(date, slot) {
  const auth = authedHeaders();
  if (!auth) return;
  try {
    await fetch(`${WORKER_URL}/health/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ date, slot }),
    });
  } catch {}
}
