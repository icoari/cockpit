// Daily brief — picks the highest-signal items from the aggregated feed and
// pairs them with calendar + weather context so the assistant produces a
// targeted morning brief instead of generic recap.

import { complete, stream } from './llm.js';

const SYSTEM = `Tu es l'assistant personnel de Nicolas, ingénieur en IA et automatisation (LiteLLM, n8n, modèles génératifs).
Tu fournis des briefings concis, précis, sans flatterie ni jargon mou.
Réponds en français. Pas d'introduction du type "voici ton brief". Va droit au but.
Format Markdown léger autorisé (gras, listes), mais reste compact.`;

function topItemsForBrief(feedItems, max = 25) {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  return feedItems
    .filter(it => it.date > cutoff)
    .sort((a, b) => {
      // Slight boost for HN points and Anthropic/OpenAI/DeepMind/HF sources
      const aScore = (a.points || 0) + (priorityBoost(a) * 50);
      const bScore = (b.points || 0) + (priorityBoost(b) * 50);
      if (aScore !== bScore) return bScore - aScore;
      return b.date - a.date;
    })
    .slice(0, max);
}

function priorityBoost(item) {
  const src = (item.sourceId || '').toLowerCase();
  if (['anthropic', 'openai', 'deepmind', 'hf', 'simonw', 'latent'].includes(src)) return 2;
  if (src.startsWith('arxiv')) return 1.5;
  if (item.kind === 'hn' && (item.points || 0) > 250) return 1;
  return 0;
}

function condense(items) {
  return items.map(it => {
    const kind = it.kind === 'video' ? 'vidéo' : it.kind === 'hn' ? `HN ${it.points || 0}pts` : 'article';
    const src = it.source || it.sourceId || '';
    const hint = it.summary ? ` — ${it.summary.slice(0, 160)}` : '';
    return `- [${kind} · ${src}] ${it.title}${hint}`;
  }).join('\n');
}

export async function generateBrief({ feedItems, calendar = [], weather = null, trains = null }) {
  const items = topItemsForBrief(feedItems);
  if (items.length === 0) {
    return '**Pas de contenu récent** dans tes flux ces 48 dernières heures.';
  }

  const now = new Date();
  const today = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  const contextBlocks = [];
  if (weather) contextBlocks.push(`Météo locale : ${weather.tempNow}°C, ${weather.label}`);
  if (trains?.next) contextBlocks.push(`Prochain train aller : ${trains.next}`);
  if (calendar.length > 0) {
    contextBlocks.push('Agenda aujourd\'hui :\n' + calendar.map(e => `- ${e.time || 'journée'} · ${e.title}`).join('\n'));
  }

  const userPrompt = `On est ${today}.
${contextBlocks.join('\n\n')}

Voici les items récents de mes flux (vidéos, articles, HN). Donne-moi un brief structuré en 3 sections :

**À lire en priorité** (3-5 items max, ceux qui méritent vraiment 5 minutes — papiers de fond, releases majeures, outils nouveaux pertinents pour un ingé IA/automatisation)

**Le reste de signal** (3-4 items secondaires intéressants mais moins urgents)

**À skipper** (mentionne 1-2 sujets sur-représentés ou sans intérêt si tu en vois)

Pour chaque item retenu, format : titre, source, et UNE phrase max sur pourquoi c'est intéressant. Pas de blabla.

Items disponibles :
${condense(items)}`;

  return complete(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.4, maxTokens: 1200 },
  );
}

export async function streamBrief(input, onChunk) {
  const items = topItemsForBrief(input.feedItems || []);
  if (items.length === 0) {
    onChunk('**Pas de contenu récent** dans tes flux ces 48 dernières heures.');
    return;
  }
  const now = new Date();
  const today = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const contextBlocks = [];
  if (input.weather) contextBlocks.push(`Météo Conflans : ${input.weather.tempNow}°C, ${input.weather.label}`);
  if (input.trains?.next) contextBlocks.push(`Prochain train aller : ${input.trains.next}`);
  if (input.calendar?.length) {
    contextBlocks.push('Agenda aujourd\'hui :\n' + input.calendar.map(e => `- ${e.time || 'journée'} · ${e.title}`).join('\n'));
  }
  const userPrompt = `On est ${today}.
${contextBlocks.join('\n\n')}

Voici les items récents de mes flux. Donne-moi un brief structuré en 3 sections :

**À lire en priorité** (3-5 items max — papiers de fond, releases majeures, outils nouveaux pertinents pour un ingé IA/automatisation)

**Le reste de signal** (3-4 items secondaires)

**À skipper** (1-2 sujets sur-représentés si tu en vois)

Pour chaque item retenu, format : titre, source, et UNE phrase max sur pourquoi c'est intéressant. Pas de blabla.

Items disponibles :
${condense(items)}`;
  await stream(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    onChunk,
    { temperature: 0.4, maxTokens: 1200 },
  );
}
