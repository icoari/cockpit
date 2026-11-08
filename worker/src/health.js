// Health tracker — daily log ping, medication schedule and dose state, plus
// the reminder crons that read them.

import { KEY_HEALTH_PING, KEY_TREATMENT, KEY_MED_STATE } from './keys.js';
import { json, rawJson, requireAuth, safeJson, isPlainObject } from './http.js';
import { parisNow, isDateKey } from './time.js';
import { pushOne } from './push.js';
import { getMonitoring } from './monitoring.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function handleHealthPing(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { date, slot } = body || {};
  if (typeof date !== 'string' || typeof slot !== 'string') {
    return json({ error: 'date and slot required' }, 400);
  }
  await env.KV.put(KEY_HEALTH_PING, JSON.stringify({ lastEntryDate: date, lastSlot: slot, ts: Date.now() }));
  return json({ ok: true });
}

// times is a map slot → "HH:MM". Cleared time inputs arrive as "" and are
// dropped; anything else malformed is rejected.
function parseTimes(times) {
  if (times === undefined || times === null) return {};
  if (!isPlainObject(times)) return null;
  const out = {};
  for (const [slot, v] of Object.entries(times)) {
    if (v === '' || v === null) continue;
    if (typeof v !== 'string' || !HHMM.test(v)) return null;
    out[slot] = v;
  }
  return out;
}

// Treatment schedule pushed by the health app — times, cycle, on/off. Stored
// in its own KV key (not the encrypted sync blob) so the reminder cron can
// read it without user interaction.
export async function handleTreatment(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  if (request.method === 'GET') {
    const raw = await env.KV.get(KEY_TREATMENT);
    return rawJson(raw || '{}');
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
    if (!isPlainObject(body)) return json({ error: 'object expected' }, 400);
    if (!isDateKey(body.startDate)) return json({ error: 'startDate required (YYYY-MM-DD)' }, 400);
    const times = parseTimes(body.times);
    if (!times) return json({ error: 'times must map dose slots to "HH:MM"' }, 400);
    const t = {
      startDate: body.startDate,
      cycleOn: Number(body.cycleOn) || 30,
      cycleOff: Number(body.cycleOff) || 5,
      months: Number(body.months) || 6,
      doses: Array.isArray(body.doses) ? body.doses.filter(s => typeof s === 'string') : ['matin', 'midi', 'soir'],
      times,
      med: typeof body.med === 'string' ? body.med : 'Trimébutine',
      enabled: body.enabled !== false,
    };
    await env.KV.put(KEY_TREATMENT, JSON.stringify(t));
    return json({ ok: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

// Which doses are already taken today — suppresses their reminders.
export async function handleMed(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { date, taken } = body || {};
  if (!isDateKey(date)) return json({ error: 'date required (YYYY-MM-DD)' }, 400);
  let st = safeJson(await env.KV.get(KEY_MED_STATE), null);
  if (!st || st.date !== date) st = { date, taken: [], alerted: [] };
  st.taken = Array.isArray(taken) ? taken.filter(s => typeof s === 'string') : [];
  await env.KV.put(KEY_MED_STATE, JSON.stringify(st));
  return json({ ok: true });
}

// Evening reminder — fired at 23h Paris. Quiet, just a hint.
export async function sendHealthReminder(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.healthReminder === false) return;
  // Skip if the client logged an evening entry today (Paris date).
  const ping = safeJson(await env.KV.get(KEY_HEALTH_PING), null);
  if (ping && ping.lastEntryDate === parisNow().dateKey && ping.lastSlot === 'soir') return;
  await pushOne(env, {
    title: 'Suivi santé',
    body: 'Saisi ton soir ? Une minute suffit.',
    tag: 'bob-health',
    url: '/?goto=projets',
  }, { urgency: 'low' });
}

// Medication reminders — pushes at each meal time on ON-days only, once per
// dose per day, and never for a dose already logged. Runs on the */15 4-23
// UTC cron (15-min granularity is plenty for a "take it around now" nudge).
export async function checkMedicationReminders(env) {
  const t = safeJson(await env.KV.get(KEY_TREATMENT), null);
  if (!isPlainObject(t)) return;
  if (t.enabled === false) return;

  const { dateKey, minutes } = parisNow();
  const info = treatmentDayInfo(t, dateKey);
  if (!info.on) return;                 // pause day, before start, or finished

  const doses = Array.isArray(t.doses) && t.doses.length ? t.doses : ['matin', 'midi', 'soir'];
  const times = isPlainObject(t.times) ? t.times : {};

  let st = safeJson(await env.KV.get(KEY_MED_STATE), null);
  if (!st || st.date !== dateKey) st = { date: dateKey, taken: [], alerted: [] };
  if (!Array.isArray(st.taken)) st.taken = [];
  if (!Array.isArray(st.alerted)) st.alerted = [];

  const LABEL = { matin: 'du matin', midi: 'du midi', soir: 'du soir' };
  let changed = false;
  for (const slot of doses) {
    const hhmm = times[slot];
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) continue;
    const [hh, mm] = hhmm.split(':').map(Number);
    const slotMin = hh * 60 + mm;
    if (minutes < slotMin) continue;             // not time yet
    if (minutes > slotMin + 120) continue;       // window passed — no late spam
    if (st.taken.includes(slot)) continue;       // already logged
    if (st.alerted.includes(slot)) continue;     // already reminded today

    // No `actions` array: the SW treats an action tap like a body tap anyway,
    // and the body tap already opens the app on the dose and marks it taken.
    const ok = await pushOne(env, {
      title: `${t.med || 'Traitement'} — prise ${LABEL[slot] || slot}`,
      body: 'À prendre au cours du repas. Tape pour valider la prise.',
      tag: `bob-med-${dateKey}-${slot}`,
      url: `/?goto=projets&project=health&dose=${slot}`,
      renotify: true,
    }, { urgency: 'high', ttl: 4 * 3600 });
    if (ok) { st.alerted.push(slot); changed = true; }
  }
  if (changed) {
    // Re-read before writing: a /health/med POST (user tapping « Pris » right
    // when the reminder lands — the most likely moment) may have updated
    // `taken` while the push loop ran. Merge instead of clobbering.
    const fresh = safeJson(await env.KV.get(KEY_MED_STATE), null);
    if (fresh && fresh.date === st.date) {
      st.taken = Array.isArray(fresh.taken) ? fresh.taken : st.taken;
      st.alerted = [...new Set([...(Array.isArray(fresh.alerted) ? fresh.alerted : []), ...st.alerted])];
    }
    await env.KV.put(KEY_MED_STATE, JSON.stringify(st));
  }
}

// Is `dateKey` an ON-day of the treatment? Cycles of cycleOn ON + cycleOff
// OFF, capped at `months` cycles. Day diff computed at 00:00 UTC for both
// endpoints (we only need whole-day distance).
function treatmentDayInfo(t, dateKey) {
  const start = Date.parse(t.startDate + 'T00:00:00Z');
  const cur = Date.parse(dateKey + 'T00:00:00Z');
  if (isNaN(start) || isNaN(cur)) return { on: false };
  const diff = Math.floor((cur - start) / 86400000);
  if (diff < 0) return { on: false };
  const on = Number(t.cycleOn) || 30;
  const off = Number(t.cycleOff) || 5;
  const months = Number(t.months) || 6;
  const len = on + off;
  const cycle = Math.floor(diff / len) + 1;
  if (cycle > months) return { on: false };
  return { on: (diff % len) < on, cycle };
}
