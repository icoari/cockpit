// Pattern analysis over the health-tracker entries — reads the encrypted
// blob in localStorage (same origin), produces a concise prompt, asks the
// assistant for medically-cautious observations.

import { stream } from './llm.js';

const SYSTEM = `Tu analyses un journal de santé personnel sur 31 jours (3 créneaux/jour : matin, midi, soir).
Chaque entrée comporte une note 1-5 (5 = au mieux, 1 = au pire), un éventuel cachet pris, une éventuelle crise (intensité 1-5 + heure), et un commentaire libre.
Tu ne donnes JAMAIS de diagnostic médical. Tu ne recommandes pas de médicaments.
Tu cherches des CORRÉLATIONS et MOTIFS dans les données fournies, factuels et chiffrés.
Réponds en français, structuré, concis. Mentionne les limites (échantillon court, biais auto-déclaratif) si pertinent.`;

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
      const note = e.note;
      const cachet = e.cachet ? ' C' : '';
      const crise = (typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0));
      const cr = crise > 0 ? ` crise${crise}${e.criseTime ? '@' + e.criseTime : ''}` : '';
      const comment = e.notes ? ` "${e.notes.replace(/"/g, "'").slice(0, 80)}"` : '';
      bits.push(`${s[0]}:${note}${cachet}${cr}${comment}`);
    }
    if (bits.length) lines.push(`${d} → ${bits.join(' | ')}`);
  }
  return lines.join('\n');
}

function summaryStats(entries) {
  const slots = ['matin', 'midi', 'soir'];
  let total = 0, count = 0, criseN = 0, criseIntensity = 0, cachetN = 0;
  const perSlot = { matin: { sum: 0, n: 0 }, midi: { sum: 0, n: 0 }, soir: { sum: 0, n: 0 } };
  for (const d of Object.keys(entries)) {
    const day = entries[d] || {};
    for (const s of slots) {
      const e = day[s];
      if (!e) continue;
      total += e.note; count++;
      perSlot[s].sum += e.note; perSlot[s].n++;
      if (e.cachet) cachetN++;
      const c = typeof e.crise === 'number' ? e.crise : (e.crise ? 3 : 0);
      if (c > 0) { criseN++; criseIntensity += c; }
    }
  }
  return {
    days: Object.keys(entries).length,
    fills: count,
    avgNote: count ? (total / count).toFixed(2) : null,
    perSlot: Object.fromEntries(slots.map(s => [s, perSlot[s].n ? +(perSlot[s].sum / perSlot[s].n).toFixed(2) : null])),
    cachets: cachetN,
    crises: { count: criseN, avgIntensity: criseN ? +(criseIntensity / criseN).toFixed(2) : null },
  };
}

export async function analyzeHealth({ entries, onChunk }) {
  if (!entries || Object.keys(entries).length === 0) {
    onChunk('Pas encore de données de suivi à analyser.');
    return;
  }
  const stats = summaryStats(entries);
  const journal = summarizeEntries(entries);
  const userPrompt = `Stats agrégées :
- Jours avec au moins une entrée : ${stats.days}
- Créneaux remplis : ${stats.fills}
- Note moyenne : ${stats.avgNote} / 5
- Moyennes par créneau : matin ${stats.perSlot.matin ?? '—'}, midi ${stats.perSlot.midi ?? '—'}, soir ${stats.perSlot.soir ?? '—'}
- Cachets pris : ${stats.cachets}
- Crises : ${stats.crises.count} (intensité moyenne ${stats.crises.avgIntensity ?? '—'} / 5)

Journal détaillé (date → m/M/s : note + flags) :
${journal}

Analyse ces données et fournis :
1. **Tendance globale** (en 1 phrase chiffrée)
2. **Corrélations marquantes** (créneau le plus à risque, lien éventuel cachet/crise, motifs temporels)
3. **Points d'attention** (jours notables, séquences suspectes)
4. **Pistes à creuser avec un médecin** (questions concrètes à préparer, pas de diagnostic)`;
  await stream(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    onChunk,
    { temperature: 0.35, maxTokens: 1400 },
  );
}
