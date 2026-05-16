import { getSettings } from './state.js';
import { escapeHTML } from './util.js';

// ---------- Pattern definitions ----------
function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

function nextWeeklies(weekday, count = 6) {
  const dates = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const offset = (weekday - today.getDay() + 7) % 7;
  let d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  while (dates.length < count) {
    dates.push(new Date(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
  }
  return dates;
}

function nextMonthlyNthWeekday(weekday, n, count = 6) {
  const dates = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let year = today.getFullYear(), month = today.getMonth();
  while (dates.length < count) {
    const d = nthWeekdayOfMonth(year, month, weekday, n);
    if (d >= today) dates.push(d);
    month++; if (month > 11) { month = 0; year++; }
  }
  return dates;
}

function nextQuarterlyNthThursday(n, count = 6) {
  const dates = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const months = [0, 3, 6, 9];
  let year = today.getFullYear();
  while (dates.length < count) {
    for (const m of months) {
      const d = nthWeekdayOfMonth(year, m, 4, n);
      if (d >= today) dates.push(d);
      if (dates.length >= count) break;
    }
    year++;
  }
  return dates;
}

const PATTERNS = {
  'monthly-2nd-tuesday':          { label: 'Immeuble — 2ᵉ mardi du mois',           next: (n) => nextMonthlyNthWeekday(2, 2, n) },
  'monthly-1st-thursday-quarter': { label: 'Maison orange/violet — 1er jeudi (1/4/7/10)', next: (n) => nextQuarterlyNthThursday(1, n) },
  'monthly-3rd-thursday-quarter': { label: 'Maison bleu/vert — 3ᵉ jeudi (1/4/7/10)',       next: (n) => nextQuarterlyNthThursday(3, n) },
  'weekly-monday':    { label: 'Tous les lundis',    next: (n) => nextWeeklies(1, n) },
  'weekly-tuesday':   { label: 'Tous les mardis',    next: (n) => nextWeeklies(2, n) },
  'weekly-wednesday': { label: 'Tous les mercredis', next: (n) => nextWeeklies(3, n) },
  'weekly-thursday':  { label: 'Tous les jeudis',    next: (n) => nextWeeklies(4, n) },
  'weekly-friday':    { label: 'Tous les vendredis', next: (n) => nextWeeklies(5, n) },
  'weekly-saturday':  { label: 'Tous les samedis',   next: (n) => nextWeeklies(6, n) },
  'monthly-1st-monday':    { label: '1er lundi du mois',    next: (n) => nextMonthlyNthWeekday(1, 1, n) },
  'monthly-1st-tuesday':   { label: '1er mardi du mois',    next: (n) => nextMonthlyNthWeekday(2, 1, n) },
  'monthly-1st-wednesday': { label: '1er mercredi du mois', next: (n) => nextMonthlyNthWeekday(3, 1, n) },
  'monthly-1st-friday':    { label: '1er vendredi du mois', next: (n) => nextMonthlyNthWeekday(5, 1, n) },
  'manual':           { label: 'Dates manuelles seulement', next: () => [] },
  'disabled':         { label: 'Désactivé',                 next: () => [] },
};

export const COLLECTE_PATTERNS = PATTERNS;
export const ENCOMBRANTS_PATTERNS = Object.fromEntries(
  ['monthly-2nd-tuesday', 'monthly-1st-thursday-quarter', 'monthly-3rd-thursday-quarter', 'manual']
    .map(k => [k, PATTERNS[k]])
);

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysUntil(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(date); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
function shortDate(d) {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

function nextOfType(type) {
  const { encombrants, collectes } = getSettings();
  if (type === 'encombrants') {
    const pat = PATTERNS[encombrants.pattern] || PATTERNS['monthly-2nd-tuesday'];
    const patDates = pat.next(3);
    const extra = (encombrants.extraDates || []).map(parseDate).filter(d => daysUntil(d) >= 0);
    const all = [...patDates, ...extra].sort((a, b) => a - b);
    return all[0] || null;
  }
  const cfg = collectes?.[type];
  if (!cfg?.enabled || cfg.pattern === 'disabled') return null;
  const p = PATTERNS[cfg.pattern];
  if (!p) return null;
  const dates = p.next(1);
  return dates[0] || null;
}

export class BinsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
  }

  render() {
    const { collectes } = getSettings();

    const types = [
      { key: 'ordures',     short: 'Ordures' },
      { key: 'tri',         short: 'Tri' },
      { key: 'encombrants', short: 'Encombrants' },
    ];

    const cols = types.map(t => {
      const date = nextOfType(t.key);
      if (!date) {
        return `
          <div class="collecte-col collecte-col--disabled">
            <div class="collecte-col__label">${escapeHTML(t.short)}</div>
            <div class="collecte-col__num">—</div>
            <div class="collecte-col__date">non configuré</div>
          </div>
        `;
      }
      const days = daysUntil(date);
      const num = days === 0 ? "aujourd'hui" : days === 1 ? 'demain' : `${days}`;
      const unit = days > 1 ? '<small>j</small>' : '';
      const accent = t.key === 'encombrants' ? 'collecte-col--accent' : '';
      return `
        <div class="collecte-col ${accent}">
          <div class="collecte-col__label">${escapeHTML(t.short)}</div>
          <div class="collecte-col__num">${escapeHTML(num)}${unit}</div>
          <div class="collecte-col__date">${escapeHTML(shortDate(date))}</div>
        </div>
      `;
    }).join('');

    // Headline: next encombrants for the subtitle
    const nextEnc = nextOfType('encombrants');
    const subtitle = nextEnc
      ? `prochain encombrant ${shortDate(nextEnc)} · dans ${daysUntil(nextEnc)} j`
      : 'aucune collecte';

    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Collectes</span>
          <span class="card__subtitle">${escapeHTML(subtitle)}</span>
        </div>
      </div>
      <div class="collecte-grid">${cols}</div>
    `;
  }

  refresh() { this.render(); }
}
