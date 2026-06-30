// Mémoire — a voice-first notes app. Capture a note (typed or dictated), the
// LLM lightly cleans it and files it under a category (Culture, Lieux, Idées…).
// Ask for a recap by voice and get a short synthesized answer over all notes.
//
// Notes live in localStorage (bob-notes-v1) and ride the encrypted cloud sync
// as `_notes` (see state.js).

import { complete } from './llm.js';

const KEY = 'bob-notes-v1';
export const SUGGESTED = ['Culture', 'Lieux', 'Idées', 'Courses', 'Travail', 'Perso', 'Divers'];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export function loadNotes() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    return Array.isArray(p?.notes) ? p.notes : [];
  } catch { return []; }
}
function persist(notes) { try { localStorage.setItem(KEY, JSON.stringify({ notes })); } catch {} }

export function addNote(text, category) {
  const notes = loadNotes();
  const note = { id: uid(), text: (text || '').trim(), category: (category || 'Divers').trim() || 'Divers', createdAt: Date.now() };
  notes.unshift(note);
  persist(notes);
  return note;
}
export function removeNote(id) { persist(loadNotes().filter(n => n.id !== id)); }
export function updateNote(id, patch) {
  const notes = loadNotes();
  const i = notes.findIndex(n => n.id === id);
  if (i >= 0) { notes[i] = { ...notes[i], ...patch }; persist(notes); }
}

// Notes grouped by category, categories ordered by most-recent activity.
export function notesByCategory() {
  const notes = loadNotes();
  const map = new Map();
  for (const n of notes) {
    if (!map.has(n.category)) map.set(n.category, []);
    map.get(n.category).push(n);
  }
  return map;
}

const SYSTEM_CAT = `Tu ranges une note dictée ou tapée par Nicolas (français).
Nettoie LÉGÈREMENT le texte (ponctuation, majuscules) sans le reformuler ni l'allonger.
Choisis UNE catégorie courte. Privilégie : Culture (films/séries/livres à voir ou lire), Lieux (endroits où aller), Idées, Courses, Travail, Perso, Divers. Tu peux en créer une autre, courte, si rien ne colle.
Réponds UNIQUEMENT en JSON : {"text":"...","category":"..."}`;

export async function categorizeNote(rawText) {
  const fallback = { text: (rawText || '').trim(), category: 'Divers' };
  try {
    const out = await complete(
      [{ role: 'system', content: SYSTEM_CAT }, { role: 'user', content: rawText }],
      { temperature: 0, maxTokens: 300 },
    );
    let raw = (out || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
    const o = JSON.parse(raw);
    return {
      text: (o.text || rawText || '').trim() || fallback.text,
      category: ((o.category || 'Divers').trim() || 'Divers').slice(0, 40),
    };
  } catch { return fallback; }
}

const SYSTEM_RECAP = `Tu es l'assistant de notes de Nicolas. À partir de ses notes (JSON) et de sa demande, réponds de façon COURTE et efficace en français : quelques lignes, listes à puces si utile. Pas de blabla, pas de préambule.`;

export async function recap(question) {
  const notes = loadNotes().map(n => ({ category: n.category, text: n.text }));
  if (!notes.length) return 'Aucune note pour l\'instant — capture la première.';
  const user = `Demande : ${question || 'Fais-moi un récap clair de mes notes.'}\n\nNotes :\n${JSON.stringify(notes)}`;
  return (await complete(
    [{ role: 'system', content: SYSTEM_RECAP }, { role: 'user', content: user }],
    { temperature: 0.3, maxTokens: 600 },
  )).trim();
}
