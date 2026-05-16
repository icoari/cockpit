import { getSettings } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, haptic } from './util.js';

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysUntil(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(date); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function formatLongDate(d) {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(d);
}

export class BinsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
  }

  render() {
    const { encombrants } = getSettings();
    const upcoming = (encombrants.nextDates || [])
      .map(parseDate)
      .filter(d => daysUntil(d) >= 0)
      .sort((a, b) => a - b);

    if (upcoming.length === 0) {
      this.container.innerHTML = `
        <div class="card__head">
          <div class="card__head-main">
            <span class="card__title">Encombrants</span>
            <span class="card__subtitle">aucune date enregistrée</span>
          </div>
        </div>
        <div class="card__empty">
          Ajoute la date de la prochaine collecte dans les <a href="#" data-open-settings>Réglages</a>.
          <br><br>
          <small style="color: var(--text-faint);">${escapeHTML(encombrants.address || '')}</small>
        </div>
      `;
      return;
    }

    const next = upcoming[0];
    const days = daysUntil(next);
    const restRender = upcoming.slice(1, 4).map(d => `
      <div class="bins-row">
        <span class="bins-row__day">${escapeHTML(formatLongDate(d))}</span>
        <span class="bins-row__when">dans ${daysUntil(d)} j</span>
      </div>
    `).join('');

    const bigNumber = days === 0 ? "aujourd'hui"
                    : days === 1 ? 'demain'
                    : `${days}`;
    const unit = days > 1 ? 'jours' : '';

    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Encombrants</span>
          <span class="card__subtitle">${escapeHTML(formatLongDate(next))}</span>
        </div>
      </div>
      <div class="bins-hero">
        <div class="bins-hero__number">${escapeHTML(bigNumber)}${unit ? `<small>${unit}</small>` : ''}</div>
        <div class="bins-hero__label">avant la prochaine collecte</div>
        ${encombrants.address ? `<div class="bins-hero__addr">${escapeHTML(encombrants.address)}</div>` : ''}
      </div>
      ${restRender ? `
        <div class="bins-rest">
          <div class="bins-rest__title">Passages suivants</div>
          ${restRender}
        </div>
      ` : ''}
    `;
  }

  attach() {
    // Refresh whenever the widget might be remounted; settings panel calls refresh.
  }

  refresh() { this.render(); }
}
