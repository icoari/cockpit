// Correlation analysis over the health-tracker journal. Pre-computes the
// hard numbers client-side (lag-window co-occurrences, day-of-week, slot
// distributions) so the model interprets data instead of recounting it,
// then asks for cautious correlation/causality hypotheses.

import { stream } from './llm.js';

const SYSTEM = `Tu analyses le journal de santé digestive de Nicolas (douleurs de ventre, troubles intestinaux, crises de diarrhée).
Phase 1 : traitement du 14/05 au 13/06/2026 (Débridat/trimébutine 3×/j). Ensuite : suivi continu post-traitement.

CONTEXTE CLINIQUE (rapporté par le patient, examens normaux : sang, écho, coloscopie)
- Depuis 2 ans : crises de diarrhée post-prandiales, typiquement PENDANT ou < 30 min après le repas, précédées d'un « coup de chaud » (prodrome vagal). Tableau compatible avec un réflexe gastro-colique exagéré.
- Le déclencheur dominant semble être la QUANTITÉ mangée (repas copieux), pas la qualité.
- Transit de base chaotique : parfois 3 selles/jour, parfois aucune. Le risque de crise augmente le lendemain d'un jour sans selle (cycle rétention → vidange massive).
- Expérience naturelle ON/OFF/ON : amandes effilées quotidiennes → amélioration nette ; arrêt (médicament poursuivi) → détérioration ; reprise → ré-amélioration. Hypothèse : fibres insolubles + prébiotiques régularisent le transit et cassent le cycle rétention→crise.
- Lopéramide efficace en traitement de crise.
Ton rôle : confronter ces hypothèses aux données chiffrées, sans complaisance — confirme, infirme ou nuance.

Chaque créneau (matin/midi/soir) peut contenir : note globale 1-5 (5 = au mieux), cachet pris, crise 1-5 + heure, douleur ventre 1-5, transit sur l'échelle de Bristol (1-7, 3-4 = normal, 6-7 = diarrhée), stress 1-5, tags repas (Gras, Épicé, Lactose…), commentaire libre.

RÈGLES D'ANALYSE
- Tu cherches des CORRÉLATIONS chiffrées et des MOTIFS temporels. Les fenêtres de latence digestives pertinentes vont de 30 minutes à 72 h (un repas du soir peut déclencher une crise le lendemain).
- Pour chaque corrélation, donne un degré de confiance honnête (faible / moyen / fort) basé sur le nombre d'occurrences. Moins de 3 occurrences = anecdotique, dis-le.
- Distingue corrélation et causalité. Tu peux formuler des HYPOTHÈSES causales prudentes, jamais des affirmations.
- Compare la période traitement vs post-traitement quand les deux existent.
- JAMAIS de diagnostic médical, jamais de recommandation de médicament.
- Réponds en français, structuré, concis. Markdown léger (gras, listes).`;

function summarizeEntries(entries) {
  const days = Object.keys(entries).sort();
  const slots = ['matin', 'midi', 'soir'];
  const lines = [];
  for (const d of days) {
    const day = entries[d] || {};
    const bits = [];
    for (const s of slots) {
      const e = day[s];
      if (!e) continue;
      let bit = `${s[0]}:${e.note}`;
      if (e.cachet) bit += 'C';
      const crise = typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0);
      if (crise > 0) bit += ` crise${crise}${e.criseTime ? '@' + e.criseTime : ''}`;
      if (e.douleur > 0) bit += ` dlr${e.douleur}`;
      if (e.transit > 0) bit += ` B${e.transit}`;
      if (e.stress > 0) bit += ` str${e.stress}`;
      if (e.repas) bit += ` rep:${e.repas}`;
      if (Array.isArray(e.tags) && e.tags.length) bit += ` [${e.tags.join(',')}]`;
      if (e.notes) bit += ` "${e.notes.replace(/"/g, "'").slice(0, 70)}"`;
      bits.push(bit);
    }
    if (bits.length) lines.push(`${d} → ${bits.join(' | ')}`);
  }
  return lines.join('\n');
}

// Hard numbers computed locally — the model interprets, it doesn't count.
function computeCorrelations(entries) {
  const slots = ['matin', 'midi', 'soir'];
  const slotOffset = { matin: 0, midi: 1, soir: 2 };   // pseudo-time within day
  const events = [];   // flattened, ordered

  for (const d of Object.keys(entries).sort()) {
    for (const s of slots) {
      const e = (entries[d] || {})[s];
      if (!e) continue;
      events.push({
        date: d, slot: s,
        t: new Date(d + 'T00:00:00').getTime() + slotOffset[s] * 7 * 3600 * 1000 + 5 * 3600 * 1000,
        crise: typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0),
        douleur: e.douleur || 0,
        transit: e.transit || 0,
        stress: e.stress || 0,
        tags: Array.isArray(e.tags) ? e.tags : [],
        repas: e.repas || '',
        note: e.note,
        cachet: !!e.cachet,
      });
    }
  }

  const crises = events.filter(e => e.crise > 0);
  const LAG = 48 * 3600 * 1000;   // look-back window before each crisis

  // Tag → crisis co-occurrence within the 48 h window preceding the crisis
  const tagBefore = {};
  const tagTotal = {};
  for (const ev of events) for (const t of ev.tags) tagTotal[t] = (tagTotal[t] || 0) + 1;
  for (const cr of crises) {
    const seen = new Set();
    for (const ev of events) {
      if (ev.t < cr.t - LAG || ev.t >= cr.t) continue;
      for (const t of ev.tags) seen.add(t);
    }
    for (const t of seen) tagBefore[t] = (tagBefore[t] || 0) + 1;
  }

  // Day-of-week distribution of crises
  const dowNames = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const crisesByDow = {};
  for (const cr of crises) {
    const dow = dowNames[new Date(cr.date + 'T12:00:00').getDay()];
    crisesByDow[dow] = (crisesByDow[dow] || 0) + 1;
  }

  // Slot distribution
  const crisesBySlot = {};
  for (const cr of crises) crisesBySlot[cr.slot] = (crisesBySlot[cr.slot] || 0) + 1;

  // Stress / douleur relationship (same slot)
  const stressWith = events.filter(e => e.stress > 0);
  const highStress = stressWith.filter(e => e.stress >= 3);
  const avgDouleurHighStress = highStress.length
    ? (highStress.reduce((a, e) => a + e.douleur, 0) / highStress.length).toFixed(2) : null;
  const lowStress = stressWith.filter(e => e.stress < 3);
  const avgDouleurLowStress = lowStress.length
    ? (lowStress.reduce((a, e) => a + e.douleur, 0) / lowStress.length).toFixed(2) : null;

  // ---- Day-level analyses targeting the patient's specific hypotheses ----
  const dayMap = {};
  for (const ev of events) {
    const d = dayMap[ev.date] || (dayMap[ev.date] = {
      crise: false, copieux: false, amandes: false, transitCount: 0, logged: 0,
    });
    d.logged++;
    if (ev.crise > 0) d.crise = true;
    if (ev.repas === 'copieux') d.copieux = true;
    if (ev.tags.includes('Amandes')) d.amandes = true;
    if (ev.transit > 0) d.transitCount++;
  }
  const dayKeys = Object.keys(dayMap).sort();
  const rate = (num, den) => den > 0 ? `${num}/${den} (${Math.round(num / den * 100)}%)` : '0/0';

  // a) Repas copieux → crise le jour même ou le lendemain
  let copN = 0, copCrise = 0, nonCopN = 0, nonCopCrise = 0;
  for (let i = 0; i < dayKeys.length; i++) {
    const d = dayMap[dayKeys[i]];
    const next = dayMap[dayKeys[i + 1]];
    const criseSoon = d.crise || (next && next.crise);
    if (d.copieux) { copN++; if (criseSoon) copCrise++; }
    else if (d.logged > 0) { nonCopN++; if (criseSoon) nonCopCrise++; }
  }

  // b) Jour sans selle loggée → crise le lendemain (le facteur de risque rapporté)
  let zeroN = 0, zeroCrise = 0, someN = 0, someCrise = 0;
  for (let i = 0; i < dayKeys.length - 1; i++) {
    const d = dayMap[dayKeys[i]];
    const next = dayMap[dayKeys[i + 1]];
    if (!next || d.logged < 2) continue;   // need a reasonably-logged day
    if (d.transitCount === 0) { zeroN++; if (next.crise) zeroCrise++; }
    else { someN++; if (next.crise) someCrise++; }
  }

  // c) Amandes → crise dans les 48 h (effet protecteur attendu : taux PLUS BAS)
  let amN = 0, amCrise = 0, noAmN = 0, noAmCrise = 0;
  for (let i = 0; i < dayKeys.length; i++) {
    const d = dayMap[dayKeys[i]];
    const next = dayMap[dayKeys[i + 1]];
    const criseSoon = d.crise || (next && next.crise);
    if (d.amandes) { amN++; if (criseSoon) amCrise++; }
    else if (d.logged > 0) { noAmN++; if (criseSoon) noAmCrise++; }
  }

  const lines = [];
  lines.push(`Crises totales : ${crises.length} sur ${events.length} créneaux remplis.`);
  lines.push(`Repas copieux → crise (jour J ou J+1) : ${rate(copCrise, copN)} · jours sans copieux : ${rate(nonCopCrise, nonCopN)}`);
  lines.push(`Jour sans selle loggée → crise le lendemain : ${rate(zeroCrise, zeroN)} · jour avec selle(s) : ${rate(someCrise, someN)}`);
  lines.push(`Jour avec Amandes → crise (J ou J+1) : ${rate(amCrise, amN)} · sans amandes : ${rate(noAmCrise, noAmN)}`);
  if (Object.keys(tagTotal).length) {
    lines.push(`Tags présents dans les 48 h avant une crise (occurrences avant-crise / total du tag) :`);
    for (const t of Object.keys(tagTotal).sort()) {
      lines.push(`  - ${t} : ${tagBefore[t] || 0}/${tagTotal[t]}`);
    }
  }
  if (Object.keys(crisesByDow).length) {
    lines.push(`Crises par jour de semaine : ${Object.entries(crisesByDow).map(([d, n]) => `${d}=${n}`).join(', ')}`);
  }
  if (Object.keys(crisesBySlot).length) {
    lines.push(`Crises par créneau : ${Object.entries(crisesBySlot).map(([s, n]) => `${s}=${n}`).join(', ')}`);
  }
  if (avgDouleurHighStress !== null && avgDouleurLowStress !== null) {
    lines.push(`Douleur moyenne quand stress ≥3 : ${avgDouleurHighStress} · quand stress <3 : ${avgDouleurLowStress}`);
  }
  return lines.join('\n');
}

function summaryStats(entries) {
  const slots = ['matin', 'midi', 'soir'];
  const TREAT_END = '2026-06-13';
  const acc = () => ({ total: 0, count: 0, criseN: 0, cachetN: 0, douleurSum: 0, douleurN: 0, transitN: 0, transitNormal: 0 });
  const phases = { traitement: acc(), apres: acc() };
  for (const d of Object.keys(entries)) {
    const bucket = d <= TREAT_END ? phases.traitement : phases.apres;
    for (const s of slots) {
      const e = (entries[d] || {})[s];
      if (!e) continue;
      bucket.total += e.note; bucket.count++;
      if (e.cachet) bucket.cachetN++;
      const c = typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0);
      if (c > 0) bucket.criseN++;
      if (e.douleur > 0) { bucket.douleurSum += e.douleur; bucket.douleurN++; }
      if (e.transit > 0) {
        bucket.transitN++;
        if (e.transit >= 3 && e.transit <= 4) bucket.transitNormal++;
      }
    }
  }
  const fmt = (b, label) => b.count === 0 ? `${label} : aucune donnée` :
    `${label} : note moy ${(b.total / b.count).toFixed(2)}, ${b.criseN} crises, cachets ${b.cachetN}, ` +
    `douleur moy ${b.douleurN ? (b.douleurSum / b.douleurN).toFixed(2) : '—'}, ` +
    `transit normal ${b.transitN ? Math.round(b.transitNormal / b.transitN * 100) + '%' : '—'}`;
  return fmt(phases.traitement, 'Traitement (14/05→13/06)') + '\n' + fmt(phases.apres, 'Post-traitement (14/06→)');
}

export async function analyzeHealth({ entries, onChunk }) {
  if (!entries || Object.keys(entries).length === 0) {
    onChunk('Pas encore de données de suivi à analyser.');
    return;
  }
  const userPrompt = `STATS PAR PHASE
${summaryStats(entries)}

CORRÉLATIONS PRÉ-CALCULÉES (chiffres exacts, à interpréter)
${computeCorrelations(entries)}

JOURNAL DÉTAILLÉ (date → créneaux ; C=cachet, dlr=douleur, B=Bristol, str=stress)
${summarizeEntries(entries)}

Analyse en 5 blocs :
1. **Tendance** — évolution globale, comparaison traitement vs post-traitement si applicable (1-2 phrases chiffrées)
2. **Corrélations** — les motifs les plus solides dans les chiffres pré-calculés, avec degré de confiance (faible/moyen/fort selon le nombre d'occurrences)
3. **Hypothèses causales prudentes** — ce qui MÉRITERAIT d'être testé (ex. éviter un tag 2 semaines), en soulignant l'incertitude
4. **Signaux faibles** — motifs intrigants mais sous-échantillonnés, à surveiller
5. **Pour le médecin** — 2-3 questions concrètes à poser, fondées sur les données`;
  await stream(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    onChunk,
    { temperature: 0.3, maxTokens: 1800 },
  );
}
