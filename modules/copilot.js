// Writer copilot — strictly creative, no correction-style tasks. The point
// is to provoke or extend, not to police grammar.

import { complete, stream } from './llm.js';

const SYSTEM_WRITER = `Tu es l'assistant d'écriture créatif de Nicolas qui rédige un livre en français.
Tu respectes scrupuleusement son style : phrases nettes, vocabulaire soutenu sans pédanterie, voix narrative claire.
Pas d'introduction du type "voici la suite". Tu rends UNIQUEMENT le texte demandé, sans guillemets autour, sans commentaire, sans Markdown.
Tu n'es JAMAIS dans la correction grammaticale ou orthographique. Tu ne reformules pas pour reformuler. Tu apportes du matériau narratif neuf.`;

const SYSTEM_QUESTION = `Tu es l'assistant d'écriture créatif de Nicolas. Tu poses UNE seule question à Nicolas, concrète, qui pointe vers du matériau narratif possible — un détail, un personnage, une motivation cachée, une bifurcation. Interdit : questions vagues du type "que veux-tu dire ?", "où vas-tu avec ça ?", "et après ?".
Format : une seule phrase en français, terminée par un point d'interrogation. Rien d'autre. Pas de préambule, pas de Markdown.`;

function buildUser(task, params) {
  const ctx = params.context
    ? `Contexte (le texte écrit jusqu'à présent — pour rester dans le ton) :\n${params.context.slice(-2000)}\n\n`
    : '';
  switch (task) {
    case 'continue':
      return `${ctx}Continue le récit. Deux à quatre phrases qui poursuivent naturellement le passage, dans le même rythme et la même voix. Pas de méta-commentaire, pas de "fin de chapitre".`;

    case 'expand': {
      const target = (params.selection && params.selection.trim()) || params.context.slice(-800);
      return `${ctx}Élargis ce passage : enrichis-le sans en changer le sens, en ajoutant matière concrète — gestes, sensations, environnement, micro-événements. Garde le tempo. Rends UNE version élargie complète (3 à 6 phrases), pas une analyse.

Passage de départ :
"""
${target}
"""`;
    }

    case 'deepen':
      return `${ctx}Ralentis le tempo ici. Ajoute deux à trois phrases qui ancrent la scène avec du concret — un détail physique, un geste précis, un élément sensoriel inattendu mais juste. Pas d'introspection abstraite ; du tangible.`;

    case 'twist':
      return `${ctx}Introduis un élément qui change le sens : un personnage qui entre, un détail qui réoriente, une phrase qui ouvre une piste latérale. Une à trois phrases. Doit s'intégrer naturellement à la suite du texte.`;

    case 'character': {
      const target = (params.selection && params.selection.trim()) || params.context.slice(-1000);
      return `${ctx}Introduis ici un nouveau personnage. Donne-le en deux phrases maximum : une caractéristique physique précise (pas un cliché), un détail comportemental ou un objet associé. Ne nomme pas le personnage si le texte n'en attendait pas. Reste dans la scène — ne saute pas dans le temps.

Passage qui précède :
"""
${target}
"""`;
    }

    default:
      throw new Error(`Tâche copilote inconnue : ${task}`);
  }
}

export async function streamCopilot(task, params, onChunk) {
  if (task === 'question') {
    return stream(
      [
        { role: 'system', content: SYSTEM_QUESTION },
        { role: 'user', content: `Contexte récent :\n${(params.context || '').slice(-1500)}\n\nPose-moi la question.` },
      ],
      onChunk,
      { temperature: 0.7, maxTokens: 200 },
    );
  }
  return stream(
    [
      { role: 'system', content: SYSTEM_WRITER },
      { role: 'user', content: buildUser(task, params) },
    ],
    onChunk,
    { temperature: 0.6, maxTokens: 800 },
  );
}
