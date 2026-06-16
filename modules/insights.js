// Correlation analysis over the health journal. Works on a UNIFIED event
// stream built from both the legacy treatment slots (pseudo-timestamped)
// and the continuous event log (real timestamps). The client pre-computes
// the hard numbers — including a meal→crisis short-lag test that the real
// timestamps finally make possible — and the model interprets them.

import { stream } from './llm.js';

const SYSTEM = `Tu analyses le journal de santé digestive de Nicolas (douleurs de ventre, troubles intestinaux, crises de diarrhée).
Phase 1 : traitement du 14/05 au 13/06/2026 (Débridat/trimébutine 3×/j). Ensuite : suivi continu post-traitement, enregistré en événements horodatés (état, repas, passage WC, crise).

CONTEXTE CLINIQUE (rapporté par le patient, examens normaux : sang, écho, coloscopie)
- Depuis 2 ans : crises de diarrhée post-prandiales, typiquement PENDANT ou < 30 min après le repas, précédées d'un « coup de chaud » (prodrome vagal). Tableau compatible avec un réflexe gastro-colique exagéré.
- Le déclencheur dominant semble être la QUANTITÉ mangée (repas copieux), pas la qualité.
- Transit de base chaotique : parfois 3 selles/jour, parfois aucune. Le risque de crise augmente le lendemain d'un jour sans selle (cycle rétention → vidange massive).
- Expérience naturelle ON/OFF/ON : amandes effilées quotidiennes → amélioration nette ; arrêt (médicament poursuivi) → détérioration ; reprise → ré-amélioration. Hypothèse : fibres insolubles + prébiotiques régularisent le transit et cassent le cycle rétention→crise.
- Lopéramide efficace en traitement de crise.
Ton rôle : confronter ces hypothèses aux données chiffrées, sans complaisance — confirme, infirme ou nuance.

DONNÉES
- état : note globale 1-5 (5 = au mieux), parfois douleur 1-5 et stress 1-5.
- repas : quantité (léger/normal/copieux) + tags (Amandes, Gras, Épicé, Café…).
- WC : échelle de Bristol 1-7 (3-4 = normal, 6-7 = diarrhée, 1-2 = constipation).
- crise : intensité 1-5, parfois Lopéramide pris.

RÈGLES D'ANALYSE
- Cherche CORRÉLATIONS chiffrées et MOTIFS temporels. Latences digestives pertinentes : 30 min à 72 h.
- Degré de confiance honnête (faible/moyen/fort) selon le nombre d'occurrences. < 3 occurrences = anecdotique, dis-le.
- Distingue corrélation et causalité ; hypothèses causales prudentes, jamais d'affirmation.
- Compare traitement vs post-traitement quand les deux existent.
- JAMAIS de diagnostic, jamais de reco de médicament.
- Réponds en français, structuré, concis. Markdown léger.`;

const TREAT_END = '2026-06-13';
const SLOT_H = { matin: 8, midi: 13, soir: 20 };

function dayKeyOf(t) {
  const d = new Date(t);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Flatten slots + event log into one timestamped, typed stream.
function unifiedEvents(entries, events) {
  const out = [];
  for (const d of Object.keys(entries || {})) {
    for (const s of ['matin', 'midi', 'soir']) {
      const e = (entries[d] || {})[s];
      if (!e) continue;
      const base = new Date(d + 'T00:00:00'); base.setHours(SLOT_H[s]);
      const t = base.getTime();
      if (typeof e.note === 'number') out.push({ t, kind: 'etat', note: e.note, douleur: e.douleur || 0, stress: e.stress || 0, src: 'slot' });
      const c = typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0);
      if (c > 0) out.push({ t, kind: 'crise', intensity: c, src: 'slot' });
      if (e.transit > 0) out.push({ t, kind: 'wc', bristol: e.transit, src: 'slot' });
      if (e.repas || (Array.isArray(e.tags) && e.tags.length)) out.push({ t, kind: 'repas', size: e.repas || '', tags: e.tags || [], src: 'slot' });
    }
  }
  for (const ev of (events || [])) {
    const t = ev.ts;
    if (!t) continue;
    if (ev.type === 'etat') out.push({ t, kind: 'etat', note: ev.note, douleur: ev.douleur || 0, stress: ev.stress || 0, comment: ev.comment || '', src: 'ev' });
    else if (ev.type === 'crise') out.push({ t, kind: 'crise', intensity: ev.intensity || 0, loperamide: !!ev.loperamide, comment: ev.comment || '', src: 'ev' });
    else if (ev.type === 'wc') out.push({ t, kind: 'wc', bristol: ev.bristol || 0, comment: ev.comment || '', src: 'ev' });
    else if (ev.type === 'repas') out.push({ t, kind: 'repas', size: ev.size || '', tags: ev.tags || [], comment: ev.comment || '', src: 'ev' });
    // état captured inside a non-état event → emit an extra état point so it
    // feeds the mood trend and stats.
    if (ev.type !== 'etat' && typeof ev.note === 'number' && ev.note > 0) {
      out.push({ t, kind: 'etat', note: ev.note, douleur: 0, stress: 0, src: 'ev-embed' });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const rate = (num, den) => den > 0 ? `${num}/${den} (${Math.round(num / den * 100)}%)` : '0/0';

function computeCorrelations(U) {
  const crises = U.filter(e => e.kind === 'crise');
  const meals = U.filter(e => e.kind === 'repas');
  const wcs = U.filter(e => e.kind === 'wc');
  const lines = [];

  lines.push(`Total : ${U.length} événements · ${crises.length} crises · ${meals.length} repas · ${wcs.length} passages WC.`);

  // --- Meal → crisis short lag (the gastrocolic-reflex test) ---
  // Only meaningful with real timestamps; slot data lands on pseudo-hours.
  const realMeals = meals.filter(m => m.src === 'ev');
  const realCrises = crises.filter(c => c.src === 'ev');
  if (realMeals.length >= 3 && realCrises.length >= 1) {
    const H4 = 4 * 3600 * 1000;
    let copFollowed = 0, copTotal = 0, otherFollowed = 0, otherTotal = 0;
    for (const m of realMeals) {
      const crisisSoon = realCrises.some(c => c.t > m.t && c.t - m.t <= H4);
      if (m.size === 'copieux') { copTotal++; if (crisisSoon) copFollowed++; }
      else { otherTotal++; if (crisisSoon) otherFollowed++; }
    }
    let crisisWithMeal = 0;
    for (const c of realCrises) {
      if (realMeals.some(m => m.t < c.t && c.t - m.t <= H4)) crisisWithMeal++;
    }
    lines.push(`Repas → crise dans les 4 h : copieux ${rate(copFollowed, copTotal)} · autres ${rate(otherFollowed, otherTotal)}`);
    lines.push(`Crises précédées d'un repas < 4 h : ${rate(crisisWithMeal, realCrises.length)} (test du réflexe gastro-colique)`);
  }

  // --- Day-level rollup ---
  const dayMap = {};
  for (const e of U) {
    const k = dayKeyOf(e.t);
    const d = dayMap[k] || (dayMap[k] = { crise: false, copieux: false, amandes: false, wc: 0, logged: 0 });
    d.logged++;
    if (e.kind === 'crise') d.crise = true;
    if (e.kind === 'repas' && e.size === 'copieux') d.copieux = true;
    if (e.kind === 'repas' && (e.tags || []).includes('Amandes')) d.amandes = true;
    if (e.kind === 'wc') d.wc++;
  }
  const dayKeys = Object.keys(dayMap).sort();

  let copN = 0, copCrise = 0, nonCopN = 0, nonCopCrise = 0;
  let zeroN = 0, zeroCrise = 0, someN = 0, someCrise = 0;
  let amN = 0, amCrise = 0, noAmN = 0, noAmCrise = 0;
  for (let i = 0; i < dayKeys.length; i++) {
    const d = dayMap[dayKeys[i]];
    const next = dayMap[dayKeys[i + 1]];
    const criseSoon = d.crise || (next && next.crise);
    if (d.copieux) { copN++; if (criseSoon) copCrise++; } else { nonCopN++; if (criseSoon) nonCopCrise++; }
    if (d.amandes) { amN++; if (criseSoon) amCrise++; } else { noAmN++; if (criseSoon) noAmCrise++; }
    if (next) {
      if (d.wc === 0) { zeroN++; if (next.crise) zeroCrise++; }
      else { someN++; if (next.crise) someCrise++; }
    }
  }
  lines.push(`Repas copieux → crise (J ou J+1) : ${rate(copCrise, copN)} · sans copieux : ${rate(nonCopCrise, nonCopN)}`);
  lines.push(`Jour sans passage WC → crise le lendemain : ${rate(zeroCrise, zeroN)} · jour avec WC : ${rate(someCrise, someN)}`);
  lines.push(`Jour avec Amandes → crise (J ou J+1) : ${rate(amCrise, amN)} · sans amandes : ${rate(noAmCrise, noAmN)}`);

  // --- WC per day (transit regularity) ---
  const wcDays = dayKeys.filter(k => dayMap[k].wc > 0).length;
  const avgWc = wcDays ? (wcs.length / dayKeys.length).toFixed(2) : '0';
  lines.push(`Passages WC : ${avgWc}/jour en moyenne · ${dayKeys.length - wcDays} jour(s) sans aucun passage loggé.`);

  // --- Bristol distribution ---
  if (wcs.length) {
    const norm = wcs.filter(w => w.bristol >= 3 && w.bristol <= 4).length;
    const liq = wcs.filter(w => w.bristol >= 6).length;
    const cons = wcs.filter(w => w.bristol <= 2).length;
    lines.push(`Transit (Bristol) : ${rate(norm, wcs.length)} normal · ${liq} liquide(s) · ${cons} dur(s).`);
  }

  // --- Tag co-occurrence in the 48 h before a crisis ---
  const LAG = 48 * 3600 * 1000;
  const tagTotal = {}, tagBefore = {};
  for (const m of meals) for (const t of (m.tags || [])) tagTotal[t] = (tagTotal[t] || 0) + 1;
  for (const c of crises) {
    const seen = new Set();
    for (const m of meals) if (m.t < c.t && c.t - m.t <= LAG) for (const t of (m.tags || [])) seen.add(t);
    for (const t of seen) tagBefore[t] = (tagBefore[t] || 0) + 1;
  }
  if (Object.keys(tagTotal).length) {
    lines.push('Tags présents < 48 h avant une crise (avant-crise / total) :');
    for (const t of Object.keys(tagTotal).sort()) lines.push(`  - ${t} : ${tagBefore[t] || 0}/${tagTotal[t]}`);
  }

  // --- Crisis by day of week ---
  const dow = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const byDow = {};
  for (const c of crises) { const n = dow[new Date(c.t).getDay()]; byDow[n] = (byDow[n] || 0) + 1; }
  if (crises.length) lines.push(`Crises par jour de semaine : ${Object.entries(byDow).map(([d, n]) => `${d}=${n}`).join(', ') || '—'}`);

  // --- Stress vs pain ---
  const etats = U.filter(e => e.kind === 'etat' && e.stress > 0);
  const hi = etats.filter(e => e.stress >= 3), lo = etats.filter(e => e.stress < 3);
  if (hi.length && lo.length) {
    const avg = arr => (arr.reduce((a, e) => a + (e.douleur || 0), 0) / arr.length).toFixed(2);
    lines.push(`Douleur moyenne — stress ≥3 : ${avg(hi)} · stress <3 : ${avg(lo)}`);
  }

  return lines.join('\n');
}

function summaryStats(U) {
  const acc = () => ({ noteSum: 0, noteN: 0, crise: 0, wc: 0, wcNormal: 0, douleurSum: 0, douleurN: 0, lop: 0 });
  const ph = { traitement: acc(), apres: acc() };
  for (const e of U) {
    const b = dayKeyOf(e.t) <= TREAT_END ? ph.traitement : ph.apres;
    if (e.kind === 'etat') {
      if (typeof e.note === 'number') { b.noteSum += e.note; b.noteN++; }
      if (e.douleur > 0) { b.douleurSum += e.douleur; b.douleurN++; }
    } else if (e.kind === 'crise') { b.crise++; if (e.loperamide) b.lop++; }
    else if (e.kind === 'wc') { b.wc++; if (e.bristol >= 3 && e.bristol <= 4) b.wcNormal++; }
  }
  const fmt = (b, label) => (b.noteN + b.crise + b.wc) === 0 ? `${label} : aucune donnée` :
    `${label} : note moy ${b.noteN ? (b.noteSum / b.noteN).toFixed(2) : '—'}, ${b.crise} crises${b.lop ? ` (${b.lop} avec Lopéramide)` : ''}, ` +
    `douleur moy ${b.douleurN ? (b.douleurSum / b.douleurN).toFixed(2) : '—'}, ` +
    `transit normal ${b.wc ? Math.round(b.wcNormal / b.wc * 100) + '%' : '—'}`;
  return fmt(ph.traitement, 'Traitement (14/05→13/06)') + '\n' + fmt(ph.apres, 'Post-traitement (14/06→)');
}

// Compact per-day journal from the unified stream.
function journal(U) {
  const byDay = {};
  for (const e of U) (byDay[dayKeyOf(e.t)] ||= []).push(e);
  const clock = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const lines = [];
  for (const k of Object.keys(byDay).sort()) {
    const bits = byDay[k].filter(e => e.src !== 'ev-embed').map(e => {
      const hm = clock(e.t);
      const note = e.comment ? ` «${e.comment.slice(0, 50)}»` : '';
      if (e.kind === 'etat') return `${hm} état${e.note}${e.douleur ? ' dlr' + e.douleur : ''}${e.stress ? ' str' + e.stress : ''}${note}`;
      if (e.kind === 'repas') return `${hm} repas:${e.size || '?'}${(e.tags || []).length ? '[' + e.tags.join(',') + ']' : ''}${note}`;
      if (e.kind === 'wc') return `${hm} wcB${e.bristol}${note}`;
      if (e.kind === 'crise') return `${hm} crise${e.intensity}${e.loperamide ? '(lop)' : ''}${note}`;
      return '';
    });
    lines.push(`${k} → ${bits.join(' | ')}`);
  }
  return lines.join('\n');
}

export async function analyzeHealth({ entries, events, onChunk }) {
  const U = unifiedEvents(entries, events);
  if (U.length === 0) {
    onChunk('Pas encore de données de suivi à analyser.');
    return;
  }
  const userPrompt = `STATS PAR PHASE
${summaryStats(U)}

CORRÉLATIONS PRÉ-CALCULÉES (chiffres exacts, à interpréter)
${computeCorrelations(U)}

JOURNAL DÉTAILLÉ (date → événements horodatés ; dlr=douleur, str=stress, B=Bristol, lop=Lopéramide)
${journal(U)}

Analyse en 5 blocs :
1. **Tendance** — évolution globale, comparaison traitement vs post-traitement si applicable (1-2 phrases chiffrées)
2. **Corrélations** — les motifs les plus solides dans les chiffres pré-calculés, avec degré de confiance. Commente explicitement le test repas→crise < 4 h (réflexe gastro-colique) et l'effet des amandes.
3. **Hypothèses causales prudentes** — ce qui mériterait d'être testé (ex. éviction d'un tag, repas fractionnés), en soulignant l'incertitude
4. **Signaux faibles** — motifs intrigants mais sous-échantillonnés
5. **Pour le médecin** — 2-3 questions concrètes fondées sur les données`;
  await stream(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    onChunk,
    { temperature: 0.3, maxTokens: 1800 },
  );
}
