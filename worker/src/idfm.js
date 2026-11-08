// IDFM (Île-de-France Mobilités, Navitia API) — disruption watch on the
// user's lines and the evening last-train check.

import { KEY_ALERTED_DISRUPTIONS, KEY_LAST_TRAIN_ALERTED } from './keys.js';
import { safeJson } from './http.js';
import { parisNow, parisHourMin, parseNavitiaDate, navitiaDtParisToday } from './time.js';
import { stripHtml } from './xml.js';
import { pushOne } from './push.js';
import { getMonitoring } from './monitoring.js';

const NAVITIA_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia';

// IDFM disruption watch — checks the user's lines and pushes once per
// previously-unseen disruption.
export async function checkDisruptions(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.trainAlerts === false) return;
  if (!mon.idfmKey || !Array.isArray(mon.idfmLines) || mon.idfmLines.length === 0) return;

  const alertedList = safeJson(await env.KV.get(KEY_ALERTED_DISRUPTIONS), []);
  const alerted = new Set(Array.isArray(alertedList) ? alertedList : []);
  const stillActive = new Set();
  const newAlerts = [];
  let anyLineFailed = false;

  for (const lineId of mon.idfmLines) {
    try {
      const url = `${NAVITIA_BASE}/lines/${encodeURIComponent(lineId)}/disruptions`;
      const r = await fetch(url, {
        headers: { 'apikey': mon.idfmKey },
        cf: { cacheTtl: 0 },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) { anyLineFailed = true; continue; }
      const data = await r.json();
      const list = data.disruptions || [];
      const now = Date.now();
      for (const d of list) {
        if (!isImpactful(d)) continue;
        const ends = (d.application_periods || []).map(p => parseNavitiaDate(p.end)).filter(Boolean);
        if (ends.length && ends.every(t => t < now)) continue;
        // Track for expiry-pruning only the ids we already notified; new ones
        // join the persisted set after a SUCCESSFUL push (or as backlog).
        if (alerted.has(d.id)) { stillActive.add(d.id); continue; }
        const summary = compactDisruptionText(d);
        newAlerts.push({ id: d.id, line: lineMnemonic(lineId), summary, rank: severityRank(d) });
      }
    } catch (err) {
      anyLineFailed = true;
      console.error('disruption fetch failed for', lineId, err);
    }
  }

  // Snapshot what was previously alerted BEFORE the send loop mutates the
  // set — comparing after meant a freshly-sent alert looked "unchanged",
  // the KV write was skipped, and the same disruption re-pushed every cycle.
  const previous = Array.from(alerted).sort();

  // Send one push per new alert — max 3 per cycle, the most severe first.
  newAlerts.sort((a, b) => a.rank - b.rank);
  let anyPushFailed = false;
  for (const a of newAlerts.slice(0, 3)) {
    const ok = await pushOne(env, {
      title: `${a.line} · perturbation`,
      body: a.summary.slice(0, 180),
      tag: `bob-disr-${a.id}`,
      url: '/?goto=trains',
    }, { urgency: 'high', ttl: 6 * 3600 });
    if (ok) { alerted.add(a.id); stillActive.add(a.id); }
    else anyPushFailed = true;
  }
  // The un-pushed remainder (beyond the 3-cap) is swallowed as seen so a
  // backlog of minor disruptions can never trickle-spam over cycles —
  // unless a delivery failed, in which case we retry everything next cycle.
  if (!anyPushFailed) {
    for (const a of newAlerts.slice(3)) { alerted.add(a.id); stillActive.add(a.id); }
  }

  // Persist the active set so each disruption alerts exactly once. When a
  // line fetch failed, keep the previous IDs too — pruning them now would
  // re-alert the same disruption when the API recovers. Skip the write
  // when truly nothing changed (this cron runs every 15 min).
  const persistSet = anyLineFailed ? new Set([...alerted, ...stillActive]) : stillActive;
  const persist = Array.from(persistSet).sort();
  if (JSON.stringify(persist) !== JSON.stringify(previous)) {
    await env.KV.put(KEY_ALERTED_DISRUPTIONS, JSON.stringify(persist));
  }
}

// Lower = more severe = pushed first when several disruptions are new.
function severityRank(d) {
  const effect = (d.severity?.effect || '').toUpperCase();
  if (effect === 'NO_SERVICE') return 0;
  if (effect === 'REDUCED_SERVICE') return 1;
  if (effect === 'SIGNIFICANT_DELAYS') return 2;
  if (effect === 'DETOUR' || effect === 'MODIFIED_SERVICE') return 3;
  return 4;
}

function lineMnemonic(lineId) {
  if (lineId.includes('C01739')) return 'Transilien J';
  if (lineId.includes('C01742')) return 'RER A';
  if (lineId.includes('C01641')) return 'Noctilien N152';
  return 'Ligne';
}

// Effects that warrant a push. INFORMATION / NO_EFFECT and the like are
// deliberately excluded — they were the source of the notification flood.
const IMPACTFUL_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS', 'DETOUR', 'MODIFIED_SERVICE']);
const IMPACT_KEYWORDS = /supprim|interromp|ne circul|suspend|coupure|fortement perturb|trafic interrompu|ferm[ée]/i;

// Strict filter: only surface disruptions that are active now (or within a few
// hours) AND genuinely impactful — a strong severity effect, or, when IDFM
// gives no effect, a message that clearly signals a real disruption.
function isImpactful(d, withinHours = 6) {
  const text = (d.messages?.[0]?.text || '').trim();
  if (!text) return false;

  // Active now or starting soon.
  const now = Date.now();
  const cutoff = now + withinHours * 3600 * 1000;
  const periods = d.application_periods || [];
  let active = periods.length === 0;
  for (const p of periods) {
    const start = parseNavitiaDate(p.begin);
    const end   = parseNavitiaDate(p.end);
    if ((!start || start <= cutoff) && (!end || end >= now)) { active = true; break; }
  }
  if (!active) return false;

  const effect = (d.severity?.effect || '').toUpperCase();
  if (IMPACTFUL_EFFECTS.has(effect)) return true;
  if (!effect) return IMPACT_KEYWORDS.test(stripHtml(text));
  return false;   // INFORMATION / NO_EFFECT / minor → no push
}

function compactDisruptionText(d) {
  const msg = (d.messages?.[0]?.text || '').toString();
  return stripHtml(msg) || 'Trafic perturbé sur la ligne.';
}

// Daily 18 h Paris check — asks the journey planner for tonight's LAST
// arrival home on each line and warns the user if it lands significantly
// earlier than usual (engineering works, last-train-of-night cuts that
// the disruption API often hides).
export async function checkLastTrainsTonight(env) {
  const mon = await getMonitoring(env);
  if (mon.alerts?.trainAlerts === false) return;
  if (!mon.idfmKey || !mon.stops?.paris || !mon.stops?.home) return;

  const lineJ    = 'line:IDFM:C01739';
  const lineRerA = 'line:IDFM:C01742';
  // Probe from 21h Paris so the 50-journey window reaches end of service.
  const dt = navitiaDtParisToday(21, 0);

  const probes = [
    { label: 'Transilien J',  dest: 'Conflans FdO', line: lineJ,    from: mon.stops.paris,    to: mon.stops.home,    earlyThreshold: 23 * 60 + 30 },
    { label: 'RER A',         dest: 'Conflans FdO', line: lineRerA, from: mon.stops.paris,    to: mon.stops.home,    earlyThreshold: 23 * 60 + 45 },
  ];
  if (mon.stops.homeAlt) {
    probes.push({ label: 'Transilien J', dest: 'Conflans SH', line: lineJ, from: mon.stops.paris, to: mon.stops.homeAlt, earlyThreshold: 23 * 60 + 30 });
  }

  // `false` = the API errored (don't alert), `null` = API answered with no
  // journeys (that IS the alert-worthy case).
  const results = await Promise.all(probes.map(p => lastJourneyTonight(mon.idfmKey, p, dt).catch(err => {
    console.error('last-train probe failed', p.label, err);
    return false;
  })));

  const findings = [];
  for (let i = 0; i < probes.length; i++) {
    const r = results[i];
    if (r === false) continue;   // transient API failure — skip, don't false-alert
    if (r === null) {
      findings.push({ probe: probes[i], type: 'none', text: 'aucun départ trouvé ce soir' });
      continue;
    }
    if (!r.departMs) continue;   // parse glitch on an existing journey — skip
    // Compare in Paris local time — the Worker clock is UTC.
    const { h, m } = parisHourMin(r.departMs);
    const minOfDay = h * 60 + m;
    // Past-midnight departures (h < 4) are end-of-service, never "early".
    if (h >= 4 && minOfDay < probes[i].earlyThreshold) {
      findings.push({
        probe: probes[i],
        type: 'early',
        text: `dernier départ ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      });
    }
  }

  if (findings.length === 0) return;

  const todayKey = parisNow().dateKey;
  const alerted = safeJson(await env.KV.get(KEY_LAST_TRAIN_ALERTED), {});
  // Reset alerted map daily — keep only today's entry to bound size.
  const stillAlerted = alerted[todayKey] || {};
  const sig = findings.map(f => `${f.probe.label}-${f.probe.dest}-${f.type}`).join('|');
  if (stillAlerted.sig === sig) return;  // identical alert already sent today

  const summary = findings.map(f => `${f.probe.label} → ${f.probe.dest} : ${f.text}`).join(' · ');
  await pushOne(env, {
    title: 'Trains ce soir',
    body: summary.slice(0, 220),
    tag: 'bob-last-trains',
    url: '/?goto=trains',
  }, { urgency: 'high', ttl: 8 * 3600 });

  await env.KV.put(KEY_LAST_TRAIN_ALERTED, JSON.stringify({ [todayKey]: { sig, ts: Date.now() } }));
}

async function lastJourneyTonight(apiKey, probe, dt) {
  // count=50 from 21h Paris covers end-of-service even on a frequent line —
  // querying from "now" returns 50 journeys ending mid-evening and would
  // mislabel the 50th as the "last".
  const url = `${NAVITIA_BASE}/journeys`
            + `?from=${probe.from.lon};${probe.from.lat}`
            + `&to=${probe.to.lon};${probe.to.lat}`
            + `&datetime=${dt}`
            + `&allowed_id[]=${encodeURIComponent(probe.line)}`
            + `&count=50`;
  const r = await fetch(url, { headers: { 'apikey': apiKey }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) return false;        // API failure ≠ "no journeys tonight"
  const data = await r.json();
  if (data.error) return false;
  const journeys = data.journeys || [];
  if (journeys.length === 0) return null;
  const last = journeys[journeys.length - 1];
  return { departMs: parseNavitiaDate(last.departure_date_time) };
}
