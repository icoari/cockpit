// Writer copilot — wraps the assistant with task-specific prompts that work
// on a textarea: rewrite a selection, continue a passage, suggest a turn,
// tighten prose, fix grammar.

import { complete, stream } from './llm.js';

const SYSTEM_WRITER = `Tu es l'assistant d'écriture de Nicolas qui rédige un livre en français.
Tu respectes scrupuleusement son style : phrases nettes, vocabulaire soutenu sans pédanterie, voix narrative claire.
Pas d'introduction du type "voici la suite". Tu rends UNIQUEMENT le texte demandé, sans guillemets, sans commentaire, sans Markdown.
Si l'utilisateur demande un raccourci, vise une réduction de 30 à 40% en préservant le sens et la cadence.`;

function buildUser(task, params) {
  const ctx = params.context ? `Contexte (chapitre en cours, avant la zone à modifier) :\n${params.context.slice(-2000)}\n\n` : '';
  switch (task) {
    case 'rephrase':
      return `${ctx}Reformule ce passage en gardant exactement le même sens et la même longueur. Améliore la fluidité.

Passage :
"""
${params.selection}
"""`;
    case 'continue':
      return `${ctx}Continue le texte naturellement. Produis 2 à 4 phrases qui poursuivent la scène, dans le même ton et au même rythme. Pas de méta-commentaire.`;
    case 'tighten':
      return `${ctx}Raccourcis ce passage de 30 à 40 % en préservant le sens et la cadence. Élimine redondances et adverbes faibles.

Passage :
"""
${params.selection}
"""`;
    case 'fix':
      return `${ctx}Corrige UNIQUEMENT la grammaire, la conjugaison, l'orthographe et la ponctuation. Ne touche pas au style ni au vocabulaire.

Passage :
"""
${params.selection}
"""`;
    case 'twist':
      return `${ctx}Propose un retournement narratif ou un détail concret qui pourrait suivre, en une seule phrase descriptive. Tu peux contredire la trajectoire actuelle si c'est plus intéressant.`;
    case 'summarize':
      return `${ctx}Résume le chapitre en 5 puces concises (mode plan), sans rentrer dans le détail des phrases — juste les beats narratifs.

Texte :
"""
${params.selection || params.context}
"""`;
    default:
      throw new Error(`Tâche copilote inconnue : ${task}`);
  }
}

export async function runCopilot(task, params) {
  return complete(
    [
      { role: 'system', content: SYSTEM_WRITER },
      { role: 'user', content: buildUser(task, params) },
    ],
    { temperature: task === 'fix' ? 0.1 : 0.6, maxTokens: 800 },
  );
}

export async function streamCopilot(task, params, onChunk) {
  return stream(
    [
      { role: 'system', content: SYSTEM_WRITER },
      { role: 'user', content: buildUser(task, params) },
    ],
    onChunk,
    { temperature: task === 'fix' ? 0.1 : 0.6, maxTokens: 800 },
  );
}
