// Daily editorial selection — strips a 60+ item feed down to 3-5 headlines
// that actually merit time, plus a small "later" tail. The model returns
// indexes into the source array so we don't waste tokens echoing titles.

import { complete } from './llm.js';

const SYSTEM = `Tu es l'éditorialiste de Nicolas, ingénieur IA et automatisation (LiteLLM, n8n, modèles génératifs).
Ton job : trier dans un flux d'items le SIGNAL et ignorer le bruit. Tu retournes du JSON strict.

CRITÈRES DE SIGNAL (à privilégier)
- releases majeures de modèles ou frameworks
- papers de recherche avec impact concret
- outils nouveaux réellement utiles, pas du buzz
- patterns d'architecture ou retours d'expérience approfondis sur des stacks IA
- stories HN très engagées dans son domaine (>250 pts en général)

CRITÈRES DE BRUIT (à ignorer)
- annonces de levées de fonds, valorisations, business
- listes de tendances, "X choses à savoir"
- marketing produit déguisé
- hot takes, généralités sur "l'avenir de l'IA"
- redites — si plusieurs items traitent du même sujet, ne garde que le plus consistant

Pour CHAQUE headline retenue, écris UNE phrase en français qui dit POURQUOI ça mérite 3 minutes de son temps. Concret, factuel. Interdiction d'employer "fascinant", "incroyable", "à ne pas manquer", "révolutionnaire", "game-changer". Pas de flatterie. Si tu doutes, sois bref.

FORMAT DE SORTIE — JSON STRICT, rien d'autre, pas de Markdown :
{"headlines":[{"i":<index>,"why":"<une phrase>"}],"later":[{"i":<index>}]}

3 à 5 headlines. 6 à 12 dans "later". Indices = position dans la liste fournie (0-based).`;

function condense(items) {
  return items.map((it, i) => {
    const kind = it.kind === 'video' ? 'vidéo' : it.kind === 'hn' ? `HN ${it.points || 0}pts` : 'article';
    const src = it.source || it.sourceId || '';
    const summary = it.summary ? ` — ${it.summary.slice(0, 220)}` : '';
    return `[${i}] ${kind} · ${src}: ${it.title}${summary}`;
  }).join('\n');
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch {}
  // Strip code fences if any
  const stripped = raw.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  try { return JSON.parse(stripped); } catch {}
  // Last resort: extract the largest {...} block
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

export async function generateDigest(items) {
  if (!items || items.length === 0) {
    return { headlines: [], later: [] };
  }
  const pool = items.slice(0, 80);
  const userPrompt = `Items disponibles (${pool.length}) :\n\n${condense(pool)}`;
  const raw = await complete(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.2, maxTokens: 1800 },
  );

  const parsed = safeParse(raw);
  if (!parsed || !Array.isArray(parsed.headlines)) {
    throw new Error('Réponse invalide du modèle. Réessaie.');
  }

  // Resolve indexes back to actual items — dedupe (a model can repeat an
  // index) and hard-cap at 5 headlines.
  const seenUrls = new Set();
  const headlines = parsed.headlines
    .map(h => ({ item: pool[h.i], why: (h.why || '').trim() }))
    .filter(h => h.item && h.why)
    .filter(h => {
      if (seenUrls.has(h.item.url)) return false;
      seenUrls.add(h.item.url);
      return true;
    })
    .slice(0, 5);

  const later = (parsed.later || [])
    .map(l => pool[l.i])
    .filter(Boolean)
    .filter(it => {
      if (seenUrls.has(it.url)) return false;
      seenUrls.add(it.url);
      return true;
    })
    .slice(0, 12);

  return {
    generatedAt: Date.now(),
    headlines: headlines.map(h => ({
      url: h.item.url,
      kind: h.item.kind,
      title: h.item.title,
      source: h.item.source,
      sourceId: h.item.sourceId,
      lang: h.item.lang,
      date: h.item.date,
      thumbnail: h.item.thumbnail || '',
      points: h.item.points,
      domain: h.item.domain,
      why: h.why,
    })),
    later: later.map(it => ({
      url: it.url,
      kind: it.kind,
      title: it.title,
      source: it.source,
      date: it.date,
    })),
  };
}
