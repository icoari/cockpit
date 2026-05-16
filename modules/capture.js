import { getState, addCapture, removeCapture } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, timeAgo, haptic, debounce } from './util.js';

export class CaptureWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.search = '';
    this.tagFilter = null;
    this.render();
    this.attach();
    this.renderList();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <span class="card__title">Capture rapide</span>
      </div>
      <div class="capture-input-row">
        <textarea class="capture-input" placeholder="Une idée, une note, une course… utilise #tag pour catégoriser" rows="1" data-input></textarea>
        <button class="capture-add" type="button" data-add>Ajouter</button>
      </div>
      <input class="capture-search" type="search" placeholder="Rechercher…" data-search>
      <div class="capture-list" data-list></div>
    `;
  }

  attach() {
    const input = this.container.querySelector('[data-input]');
    const add = this.container.querySelector('[data-add]');
    const search = this.container.querySelector('[data-search]');
    const list = this.container.querySelector('[data-list]');

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.commitInput(input);
      }
    });

    add.addEventListener('click', () => this.commitInput(input));

    search.addEventListener('input', debounce(() => {
      this.search = search.value.trim().toLowerCase();
      this.renderList();
    }, 200));

    list.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-delete]');
      if (delBtn) {
        haptic(8);
        removeCapture(delBtn.dataset.delete);
        this.renderList();
        return;
      }
      const tag = e.target.closest('[data-tag]');
      if (tag) {
        haptic(4);
        const t = tag.dataset.tag;
        this.tagFilter = (this.tagFilter === t) ? null : t;
        this.renderList();
      }
    });
  }

  commitInput(input) {
    const text = input.value.trim();
    if (!text) return;
    haptic(8);
    addCapture(text);
    input.value = '';
    input.style.height = 'auto';
    this.renderList();
  }

  renderList() {
    const list = this.container.querySelector('[data-list]');
    let items = getState().captures;

    if (this.tagFilter) {
      items = items.filter(c => c.tags.includes(this.tagFilter));
    }
    if (this.search) {
      items = items.filter(c => c.text.toLowerCase().includes(this.search));
    }

    if (items.length === 0) {
      const total = getState().captures.length;
      if (total === 0) {
        list.innerHTML = '<div class="card__empty">Tape une première note pour commencer. Utilise <code>#tag</code> pour catégoriser.</div>';
      } else {
        list.innerHTML = '<div class="card__empty">Aucun résultat.</div>';
      }
      return;
    }

    const filterChip = this.tagFilter
      ? `<div class="capture-item__meta"><span class="capture-item__tag" data-tag="${escapeHTML(this.tagFilter)}">#${escapeHTML(this.tagFilter)} ×</span></div>`
      : '';

    list.innerHTML = filterChip + items.slice(0, 100).map(c => {
      const date = new Date(c.date);
      const tags = c.tags.map(t => `<span class="capture-item__tag" data-tag="${escapeHTML(t)}">#${escapeHTML(t)}</span>`).join('');
      return `
        <div class="capture-item">
          <div class="capture-item__meta">
            <span>${escapeHTML(timeAgo(date))}</span>
            ${tags ? `<span>·</span>${tags}` : ''}
          </div>
          <div class="capture-item__text">${escapeHTML(c.text)}</div>
          <button class="capture-item__delete" data-delete="${c.id}" aria-label="Supprimer">${ICONS.trash}</button>
        </div>
      `;
    }).join('');
  }
}
