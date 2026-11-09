// Daily editorial selection — strips a 100+ item feed down to 5-7 headlines
// that actually merit time, plus a small "later" tail. The model returns
// indexes into the source array so we don't waste tokens echoing titles.
// What counts as signal comes from the reader profile (Réglages > Veille).

import { complete } from './llm.js';
import { getSettings } from './state.js';

// Public themes only: the profile travels to the LLM endpoint and syncs to
// the personal Worker, so it never names an employer, a colleague or an
// internal project.
export const DEFAULT_PROFILE = `Lead engineer plateforme IA et automatisation dans un établissement de crédit européen, secteur régulé. Il conçoit et exploite pour toute l'entreprise une passerelle LLM, une plateforme d'automatisation low-code, l'observabilité de l'IA et les assistants des équipes.
Priorités de veille, par poids :
- fort : n8n (workflows, agents n8n, MCP, monitoring, gouvernance) ; Claude, Claude Code, Cowork, skills, managed settings ; passerelles LLM et LiteLLM (clés virtuelles, budgets, quotas, fallbacks) ; OpenTelemetry Collector et conventions gen_ai, télémétrie des assistants ; Grafana et dashboards as code ; MCP (connecteurs SaaS, OAuth, clients) ; agents en entreprise, assistants run et SRE avec droits limités.
- moyen : sécurité des LLM et des agents (OWASP LLM Top 10, agence excessive, moindre privilège) ; plateformes d'agents no-code face à l'automatisation industrialisée (Dust, n8n) ; modèles et fournisseurs (Anthropic, Gemini sur Vertex AI, Azure AI Foundry), quotas et limites de débit ; FinOps IA et cloud ; mesure de l'impact de l'IA sur le delivery (métriques DORA, part des PR faites avec l'IA) ; Langfuse et LLMOps ; Terraform sur Azure (Container Apps, Front Door, WAF).
- faible : réglementation IA en finance (AI Act, DORA, EBA) quand une échéance ou une décision tombe ; GCP pour l'IA ; productivité des développeurs assistée par IA.
- à écarter : data science et ML classique (scoring), IA grand public et chatbots consommateurs, levées de fonds et actualité startup, matériel et puces.
Utile pour lui : ce qu'il peut tester, mettre à jour, budgéter ou expliquer à ses équipes cette semaine.`;

export function readerProfile() {
  const p = (getSettings().veilleProfile || '').trim();
  return p || DEFAULT_PROFILE;
}

export const RUBRICS = ['Ta stack', 'Modèles', 'Agents', 'Coûts', 'Régulation', 'Terrain'];

function systemPrompt(profile) {
  return `Tu es le rédacteur en chef de la veille quotidienne de Nicolas. Son profil :
${profile}

Ton job : dans un flux d'items, retenir ce qui compte pour LUI cette semaine et ignorer le reste. Tu retournes du JSON strict.

À PRIVILÉGIER
- ce qui touche directement ses outils ou ses fournisseurs (changement d'API, nouvelle version, dépréciation, prix)
- nouveaux modèles et capacités réellement disponibles, avec impact concret
- retours d'expérience approfondis et patterns d'architecture sur des systèmes IA en production
- régulation et supervision de l'IA dans la finance quand une décision ou une échéance est annoncée
- stories Hacker News très engagées sur ces sujets

À IGNORER
- levées de fonds, valorisations, rachats sans impact produit
- listes « X choses à savoir », hot takes, généralités sur l'avenir de l'IA
- marketing produit déguisé, tests de smartphones, gadgets
- doublons : si plusieurs items couvrent le même sujet, garde le plus consistant

Pour CHAQUE titre retenu :
- "rubric" : une seule valeur parmi ${RUBRICS.map(r => `"${r}"`).join(', ')}
- "why" : UNE phrase en français qui relie l'item à son travail : ce qu'il peut tester, vérifier, mettre à jour ou décider. Concret, factuel, sans flatterie. Interdits : "fascinant", "incroyable", "à ne pas manquer", "révolutionnaire", "game-changer", le tiret cadratin.

Ordonne les titres du plus utile au moins utile pour lui.

FORMAT DE SORTIE : JSON STRICT, rien d'autre, pas de Markdown :
{"headlines":[{"i":<index>,"rubric":"<rubrique>","why":"<une phrase>"}],"later":[{"i":<index>}]}

5 à 7 headlines. 6 à 12 dans "later". Indices = position dans la liste fournie (0-based).`;
}

// The aggregated feed is sorted by date, so a chatty source (arXiv, HN)
// crowds out the rest. Take the freshest few per source, round-robin.
const PER_SOURCE = 8;
const POOL_SIZE = 110;
function balancedPool(items) {
  const bySource = new Map();
  for (const it of items) {
    const key = it.sourceId || it.source || 'autre';
    if (!bySource.has(key)) bySource.set(key, []);
    const list = bySource.get(key);
    if (list.length < PER_SOURCE) list.push(it);
  }
  const lists = [...bySource.values()];
  const pool = [];
  for (let round = 0; round < PER_SOURCE && pool.length < POOL_SIZE; round++) {
    for (const list of lists) {
      if (list[round]) pool.push(list[round]);
      if (pool.length >= POOL_SIZE) break;
    }
  }
  return pool;
}

function condense(items) {
  return items.map((it, i) => {
    const kind = it.kind === 'video' ? 'vidéo' : it.kind === 'hn' ? `HN ${it.points || 0}pts` : 'article';
    const src = it.source || it.sourceId || '';
    const summary = it.summary ? ` : ${it.summary.slice(0, 220)}` : '';
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
  const pool = balancedPool(items);
  const userPrompt = `Items disponibles (${pool.length}) :\n\n${condense(pool)}`;
  const raw = await complete(
    [
      { role: 'system', content: systemPrompt(readerProfile()) },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.2, maxTokens: 2400 },
  );

  const parsed = safeParse(raw);
  if (!parsed || !Array.isArray(parsed.headlines)) {
    throw new Error('Réponse invalide du modèle. Réessaie.');
  }

  // Resolve indexes back to actual items — dedupe (a model can repeat an
  // index) and hard-cap at 7 headlines.
  const seenUrls = new Set();
  const headlines = parsed.headlines
    .map(h => ({ item: pool[h.i], why: (h.why || '').replace(/\s*—\s*/g, ', ').trim(), rubric: RUBRICS.includes(h.rubric) ? h.rubric : '' }))
    .filter(h => h.item && h.why)
    .filter(h => {
      if (seenUrls.has(h.item.url)) return false;
      seenUrls.add(h.item.url);
      return true;
    })
    .slice(0, 7);

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
      rubric: h.rubric,
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
