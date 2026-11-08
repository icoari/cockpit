// /push — Web Push subscription management + the shared send helper used by
// every scheduled reminder.

import { sendWebPush } from './webpush.js';
import { KEY_PUSH } from './keys.js';
import { json, requireAuth, safeJson } from './http.js';
import { getMonitoring } from './monitoring.js';

function vapidConfig(env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:bob@local',
  };
}

async function getSubscription(env) {
  return safeJson(await env.KV.get(KEY_PUSH), null);
}

export async function handlePushSubscribe(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
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

export async function handlePushUnsubscribe(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  await env.KV.delete(KEY_PUSH);
  return json({ ok: true });
}

export async function handlePushTest(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  const sub = await getSubscription(env);
  if (!sub) return json({ error: 'aucune souscription enregistrée' }, 404);
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
      console.error('push test rejected', resp.status, text.slice(0, 200));
      return json({ error: `push ${resp.status}` }, 502);
    }
    return json({ ok: true });
  } catch (err) {
    console.error('push test failed', err);
    return json({ error: 'push failed' }, 500);
  }
}

export async function pushOne(env, payload, opts = {}) {
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
  } catch (err) {
    console.error('push failed', err);
    return false;
  }
}

// Morning brief push — just nudges the user; the actual digest is generated
// when they open Bob (the LLM key never leaves the device).
export async function sendMorningBriefPush(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.morningBrief === false) return;
  await pushOne(env, {
    title: 'Brief du jour',
    body: 'L\'éditorial t\'attend dans Bob → Pro.',
    tag: 'bob-brief',
    url: '/?goto=pro',
  }, { urgency: 'normal' });
}
