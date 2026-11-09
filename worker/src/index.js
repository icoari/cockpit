// Bob backend Worker — router + scheduled entry point. Handlers live in
// their own modules; cron schedule is documented in cron.js.

import { json, withCors, corsHeaders, assertMethod, authed } from './http.js';
import { handleGetSalt, handleSetup, handleSyncData, handleWipe } from './sync.js';
import { handleGetFeed, handleSources, handleFeedRefresh } from './feed.js';
import { handlePushSubscribe, handlePushUnsubscribe, handlePushTest } from './push.js';
import { handleMonitoring } from './monitoring.js';
import { handleGoogleExchange, handleGoogleToken } from './google.js';
import { handleLlm } from './llm.js';
import { handleTranscribe } from './ai.js';
import { handleCronRun, runTasks, tasksForCron } from './cron.js';

async function route(request, env, ctx, url) {
  const p = url.pathname;
  if (p === '/' || p === '/health') return json({ ok: true, service: 'bob' });

  if (p === '/sync/salt')           return handleGetSalt(env);
  if (p === '/sync/setup')          return assertMethod(request, 'POST', () => handleSetup(request, env));
  if (p === '/sync/data')           return handleSyncData(request, env);
  if (p === '/sync/wipe')           return assertMethod(request, 'DELETE', () => handleWipe(request, env));

  if (p === '/feed')                return handleGetFeed(request, env, ctx);
  if (p === '/feed/sources')        return handleSources(request, env);
  if (p === '/feed/refresh')        return assertMethod(request, 'POST', () => handleFeedRefresh(request, env));

  if (p === '/push/subscribe')      return assertMethod(request, 'POST', () => handlePushSubscribe(request, env));
  if (p === '/push/unsubscribe')    return assertMethod(request, 'DELETE', () => handlePushUnsubscribe(request, env));
  if (p === '/push/test')           return assertMethod(request, 'POST', () => handlePushTest(request, env));

  if (p === '/vapid/public')        return json({ publicKey: env.VAPID_PUBLIC_KEY || '' });

  if (p === '/monitoring')          return handleMonitoring(request, env);
  if (p === '/cron/run')            return assertMethod(request, 'POST', () => handleCronRun(request, env, url));

  if (p === '/llm')                 return assertMethod(request, 'POST', () => handleLlm(request, env));

  // Google Calendar — server-side OAuth so access survives past 1h (the
  // browser implicit flow can't refresh and re-prompts every launch).
  if (p === '/google/exchange')     return assertMethod(request, 'POST', () => handleGoogleExchange(request, env));
  if (p === '/google/token')        return assertMethod(request, 'POST', () => handleGoogleToken(request, env));

  // Workers AI (paid plan) — auth-gated like the LLM proxy.
  if (p === '/transcribe')          return assertMethod(request, 'POST', () => authed(request, env, () => handleTranscribe(request, env)));

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    let response;
    try {
      response = await route(request, env, ctx, new URL(request.url));
    } catch (err) {
      console.error('unhandled error', request.method, new URL(request.url).pathname, err);
      response = json({ error: 'internal error' }, 500);
    }
    return withCors(response, request);
  },

  async scheduled(event, env, ctx) {
    const names = tasksForCron(event.cron);
    if (names.length === 0) {
      console.error('no task for cron', event.cron);
      return;
    }
    ctx.waitUntil(runTasks(names, env));
  },
};
