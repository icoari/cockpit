// /monitoring — client pushes IDFM key + alert preferences. The data is not
// part of the encrypted sync blob because the scheduled tasks need to read
// it without user interaction. Trust level: same as the YouTube channels
// list (plaintext in user-owned KV).

import { KEY_MONITORING } from './keys.js';
import { json, rawJson, requireAuth, safeJson, isPlainObject, readJsonLimited } from './http.js';

const MONITORING_MAX_BYTES = 32 * 1024;

// Returns an error string, or null when the payload is acceptable.
function validateMonitoring(body) {
  if (!isPlainObject(body)) return 'object expected';
  if (body.idfmKey !== undefined && typeof body.idfmKey !== 'string') return 'idfmKey must be a string';
  if (body.idfmLines !== undefined
      && (!Array.isArray(body.idfmLines) || body.idfmLines.some(l => typeof l !== 'string'))) {
    return 'idfmLines must be an array of strings';
  }
  if (body.stops !== undefined) {
    if (!isPlainObject(body.stops)) return 'stops must be an object';
    for (const s of Object.values(body.stops)) {
      if (s == null) continue;
      if (!isPlainObject(s) || typeof s.lat !== 'number' || typeof s.lon !== 'number') {
        return 'stops entries must be { lat, lon } numbers';
      }
    }
  }
  if (body.alerts !== undefined) {
    if (!isPlainObject(body.alerts)) return 'alerts must be an object';
    if (Object.values(body.alerts).some(v => typeof v !== 'boolean')) return 'alerts values must be booleans';
  }
  return null;
}

export async function handleMonitoring(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_MONITORING);
    return rawJson(raw || '{}');
  }
  if (request.method === 'POST') {
    const { value: body, response } = await readJsonLimited(request, MONITORING_MAX_BYTES);
    if (response) return response;
    const problem = validateMonitoring(body);
    if (problem) return json({ error: problem }, 400);
    await env.KV.put(KEY_MONITORING, JSON.stringify(body));
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

export async function getMonitoring(env) {
  const mon = safeJson(await env.KV.get(KEY_MONITORING), {});
  if (!isPlainObject(mon)) return {};
  // Normalise line ids to the navitia format — older clients pushed the
  // SIRI format (STIF:Line::Cxxxxx:) which 404s on /lines/{id}/disruptions.
  if (Array.isArray(mon.idfmLines)) {
    mon.idfmLines = mon.idfmLines
      .map(id => {
        const m = (typeof id === 'string' ? id : '').match(/C\d{5}/);
        return m ? `line:IDFM:${m[0]}` : null;
      })
      .filter(Boolean);
  }
  return mon;
}
