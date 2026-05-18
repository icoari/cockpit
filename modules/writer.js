import { ICONS } from './icons.js';
import { escapeHTML, haptic, uid, debounce } from './util.js';

const KEY = 'bob-writer-v1';

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { chapters: [] };
    const p = JSON.parse(raw);
    if (!Array.isArray(p.chapters)) p.chapters = [];
    return p;
  } catch { return { chapters: [] }; }
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function timeAgo(date) {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `il y a ${Math.floor(diff / 86400)} j`;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(date));
}

export class WriterApp {
  constructor(container, { onExit } = {}) {
    this.container = container;
    this.onExit = onExit || (() => {});
    this.state = load();
    this.currentChapterId = null;
    this.persistDebounced = debounce(() => this.save(), 400);
    this.renderList();
  }

  save() {
    save(this.state);
  }

  current() {
    return this.state.chapters.find(c => c.id === this.currentChapterId);
  }

  newChapter() {
    const c = {
      id: uid(),
      title: 'Chapitre ' + (this.state.chapters.length + 1),
      content: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state.chapters.unshift(c);
    this.save();
    this.currentChapterId = c.id;
    this.renderEditor();
  }

  deleteChapter(id) {
    if (!confirm('Supprimer ce chapitre ?')) return;
    this.state.chapters = this.state.chapters.filter(c => c.id !== id);
    this.save();
    this.renderList();
  }

  renderList() {
    this.currentChapterId = null;
    const totalWords = this.state.chapters.reduce((s, c) => s + countWords(c.content), 0);
    const items = this.state.chapters.length
      ? this.state.chapters.map(c => `
          <button class="writer-item" data-open="${c.id}" type="button">
            <div class="writer-item__main">
              <div class="writer-item__title">${escapeHTML(c.title)}</div>
              <div class="writer-item__meta">${countWords(c.content)} mots · ${timeAgo(c.updatedAt)}</div>
            </div>
            <button class="writer-item__del" data-del="${c.id}" aria-label="Supprimer">${ICONS.trash}</button>
          </button>
        `).join('')
      : '<div class="writer-empty">Aucun chapitre. Crée le premier.</div>';

    this.container.innerHTML = `
      <div class="writer-shell">
        <div class="writer-bar">
          <button class="writer-bar__back" data-action="exit" type="button">← Bob</button>
          <span class="writer-bar__title">Écrire</span>
          <button class="writer-bar__action" data-action="new" type="button" aria-label="Nouveau chapitre">${ICONS.plus}</button>
        </div>
        <div class="writer-body">
          <div class="writer-stats">${this.state.chapters.length} chapitre${this.state.chapters.length > 1 ? 's' : ''} · ${totalWords} mots au total</div>
          <div class="writer-list">${items}</div>
        </div>
      </div>
    `;

    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="exit"]')) { this.onExit(); return; }
      if (e.target.closest('[data-action="new"]')) { haptic(8); this.newChapter(); return; }
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); haptic(8); this.deleteChapter(del.dataset.del); return; }
      const open = e.target.closest('[data-open]');
      if (open) {
        haptic(4);
        this.currentChapterId = open.dataset.open;
        this.renderEditor();
      }
    }, { once: true });
  }

  renderEditor() {
    const c = this.current();
    if (!c) { this.renderList(); return; }
    this.container.innerHTML = `
      <div class="writer-shell">
        <div class="writer-bar">
          <button class="writer-bar__back" data-action="back" type="button">← Chapitres</button>
          <span class="writer-bar__title writer-bar__title--word" data-word-count>${countWords(c.content)} mots</span>
        </div>
        <div class="writer-edit">
          <input class="writer-edit__title" type="text" data-title value="${escapeHTML(c.title)}" placeholder="Titre du chapitre">
          <textarea class="writer-edit__content" data-content placeholder="Écris...">${escapeHTML(c.content)}</textarea>
        </div>
      </div>
    `;

    const titleEl = this.container.querySelector('[data-title]');
    const contentEl = this.container.querySelector('[data-content]');
    const wordEl = this.container.querySelector('[data-word-count]');

    const onChange = () => {
      const c2 = this.current(); if (!c2) return;
      c2.title = titleEl.value;
      c2.content = contentEl.value;
      c2.updatedAt = new Date().toISOString();
      wordEl.textContent = `${countWords(c2.content)} mots`;
      this.persistDebounced();
    };

    titleEl.addEventListener('input', onChange);
    contentEl.addEventListener('input', onChange);
    titleEl.addEventListener('blur', () => this.save());
    contentEl.addEventListener('blur', () => this.save());

    this.container.querySelector('[data-action="back"]').addEventListener('click', () => {
      this.save();
      this.renderList();
    });

    // Auto-grow textarea
    const adjust = () => {
      contentEl.style.height = 'auto';
      contentEl.style.height = contentEl.scrollHeight + 'px';
    };
    contentEl.addEventListener('input', adjust);
    setTimeout(adjust, 0);
  }
}
