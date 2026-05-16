import { getSettings } from './state.js';
import { escapeHTML, haptic } from './util.js';

function initial(label) {
  const trimmed = (label || '').trim();
  if (!trimmed) return '?';
  // First letter of first word, or first 2 letters of acronyms
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return trimmed[0].toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export class LinksWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
  }

  render() {
    const links = getSettings().links;
    this.container.innerHTML = `
      <div class="card__head">
        <span class="card__title">Liens rapides</span>
      </div>
      ${links.length === 0
        ? '<div class="card__empty">Aucun lien. Ajoute-en dans les Réglages.</div>'
        : `<div class="links-grid">
            ${links.map(l => `
              <a class="link-tile" href="${escapeHTML(l.url)}" target="_blank" rel="noopener noreferrer">
                <span class="link-tile__initial">${escapeHTML(initial(l.label))}</span>
                <span class="link-tile__label">${escapeHTML(l.label)}</span>
              </a>
            `).join('')}
          </div>`}
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.link-tile')) haptic(4);
    });
  }

  refresh() { this.render(); }
}
