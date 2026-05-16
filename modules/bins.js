import { getSettings } from './state.js';
import { escapeHTML } from './util.js';

const PATTERNS = {
  'monthly-2nd-tuesday': {
    label: 'Immeuble — 2ᵉ mardi du mois',
    next(count = 6) {
      const dates = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let cur = new Date(today.getFullYear(), today.getMonth(), 1);
      while (dates.length < count) {
        const d = nthWeekdayOfMonth(cur.getFullYear(), cur.getMonth(), 2, 2);
        if (d >= today) dates.push(d);
        cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      }
      return dates;
    },
  },
  'monthly-1st-thursday-quarter': {
    label: 'Maison secteurs orange/violet — 1er jeudi des mois 1/4/7/10',
    next(count = 6) {
      const dates = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const months = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
      let year = today.getFullYear();
      while (dates.length < count) {
        for (const m of months) {
          const d = nthWeekdayOfMonth(year, m, 4, 1); // Thursday=4, 1st
          if (d >= today) dates.push(d);
          if (dates.length >= count) break;
        }
        year++;
      }
      return dates;
    },
  },
  'monthly-3rd-thursday-quarter': {
    label: 'Maison secteurs bleu/vert — 3ᵉ jeudi des mois 1/4/7/10',
    next(count = 6) {
      const dates = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const months = [0, 3, 6, 9];
      let year = today.getFullYear();
      while (dates.length < count) {
        for (const m of months) {
          const d = nthWeekdayOfMonth(year, m, 4, 3);
          if (d >= today) dates.push(d);
          if (dates.length >= count) break;
        }
        year++;
      }
      return dates;
    },
  },
  'manual': {
    label: 'Dates personnalisées seulement',
    next() { return []; },
  },
};

export const ENCOMBRANTS_PATTERNS = PATTERNS;

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

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

function getAllUpcoming() {
  const { encombrants } = getSettings();
  const patternFn = PATTERNS[encombrants.pattern] || PATTERNS['monthly-2nd-tuesday'];
  const pattern = patternFn.next(8);
  const extra = (encombrants.extraDates || []).map(parseDate).filter(d => daysUntil(d) >= 0);

  // Dedup by date string
  const seen = new Set();
  const all = [...pattern, ...extra].filter(d => {
    const k = d.toDateString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return all.sort((a, b) => a - b);
}

export class BinsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
  }

  render() {
    const { encombrants } = getSettings();
    const upcoming = getAllUpcoming();

    if (upcoming.length === 0) {
      this.container.innerHTML = `
        <div class="card__head">
          <div class="card__head-main">
            <span class="card__title">Encombrants</span>
            <span class="card__subtitle">configure ton calendrier</span>
          </div>
        </div>
        <div class="card__empty">
          Aucune date à venir. Configure le calendrier dans les <a href="#" data-open-settings>Réglages</a>.
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
        <div class="bins-hero__rule">Dépôt la veille à partir de 19h</div>
      </div>
      ${restRender ? `
        <div class="bins-rest">
          <div class="bins-rest__title">Passages suivants</div>
          ${restRender}
        </div>
      ` : ''}
    `;
  }

  refresh() { this.render(); }
}
