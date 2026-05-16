import { getSettings } from './state.js';
import { escapeHTML } from './util.js';

// ---------- Pattern definitions ----------
const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

// Weekday: 0=Sun … 6=Sat
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

function nextQuarterlyFirstThursday(count = 6) {
  const dates = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const months = [0, 3, 6, 9];
  let year = today.getFullYear();
  while (dates.length < count) {
    for (const m of months) {
      const d = nthWeekdayOfMonth(year, m, 4, 1);
      if (d >= today) dates.push(d);
      if (dates.length >= count) break;
    }
    year++;
  }
  return dates;
}
function nextQuarterlyThirdThursday(count = 6) {
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
}

const PATTERNS = {
  // Encombrants
  'monthly-2nd-tuesday':           { label: 'Immeuble — 2ᵉ mardi du mois',           next: (n) => nextMonthlyNthWeekday(2, 2, n) },
  'monthly-1st-thursday-quarter':  { label: 'Maison orange/violet — 1er jeudi (1/4/7/10)', next: nextQuarterlyFirstThursday },
  'monthly-3rd-thursday-quarter':  { label: 'Maison bleu/vert — 3ᵉ jeudi (1/4/7/10)',       next: nextQuarterlyThirdThursday },
  // Weekly (for OM / tri / verre)
  'weekly-monday':    { label: 'Tous les lundis',    next: (n) => nextWeeklies(1, n) },
  'weekly-tuesday':   { label: 'Tous les mardis',    next: (n) => nextWeeklies(2, n) },
  'weekly-wednesday': { label: 'Tous les mercredis', next: (n) => nextWeeklies(3, n) },
  'weekly-thursday':  { label: 'Tous les jeudis',    next: (n) => nextWeeklies(4, n) },
  'weekly-friday':    { label: 'Tous les vendredis', next: (n) => nextWeeklies(5, n) },
  'weekly-saturday':  { label: 'Tous les samedis',   next: (n) => nextWeeklies(6, n) },
  // Monthly Nth weekday — most common variants for tri or verre
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

function formatLongDate(d) {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

// Get all upcoming collections: { type, label, date, daysUntil }[]
function allUpcoming() {
  const { encombrants, collectes } = getSettings();
  const list = [];

  // Encombrants
  const enPat = PATTERNS[encombrants.pattern] || PATTERNS['monthly-2nd-tuesday'];
  const enDates = enPat.next(6);
  for (const d of enDates) list.push({ type: 'encombrants', label: 'Encombrants', date: d, accent: 'accent' });
  for (const ds of (encombrants.extraDates || [])) {
    const d = parseDate(ds);
    if (daysUntil(d) >= 0) list.push({ type: 'encombrants', label: 'Encombrants', date: d, accent: 'accent' });
  }

  // Other collectes
  for (const [key, cfg] of Object.entries(collectes || {})) {
    if (!cfg.enabled || cfg.pattern === 'disabled') continue;
    const p = PATTERNS[cfg.pattern];
    if (!p) continue;
    const dates = p.next(8);
    for (const d of dates) list.push({ type: key, label: cfg.label, date: d, accent: key === 'ordures' ? 'neutral' : key === 'tri' ? 'success' : 'neutral' });
  }

  // Dedup by type+date day
  const seen = new Set();
  return list
    .filter(it => {
      const k = `${it.type}-${it.date.toDateString()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date - b.date);
}

export class BinsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
  }

  render() {
    const { encombrants } = getSettings();
    const upcoming = allUpcoming();

    if (upcoming.length === 0) {
      this.container.innerHTML = `
        <div class="card__head">
          <div class="card__head-main">
            <span class="card__title">Collectes</span>
            <span class="card__subtitle">aucune collecte configurée</span>
          </div>
        </div>
        <div class="card__empty">
          Configure tes calendriers de collecte dans les <a href="#" data-open-settings>Réglages</a>.
        </div>
      `;
      return;
    }

    // Hero: countdown to next encombrants specifically (the headline event)
    const nextEnc = upcoming.find(it => it.type === 'encombrants');
    const heroHtml = nextEnc ? this.renderHero(nextEnc, encombrants.address) : '';

    // Group upcoming by type, take next 2 of each (but next encombrants already shown in hero)
    const byType = {};
    upcoming.forEach(it => {
      if (!byType[it.type]) byType[it.type] = [];
      byType[it.type].push(it);
    });

    const orderedTypes = ['ordures', 'tri', 'encombrants', 'verre'];
    const sections = orderedTypes
      .filter(t => byType[t] && byType[t].length > 0)
      .map(t => {
        const items = t === 'encombrants' ? byType[t].slice(1, 4) : byType[t].slice(0, 3);
        if (items.length === 0) return '';
        return `
          <div class="collecte-section">
            <div class="collecte-section__title">${escapeHTML(byType[t][0].label)}</div>
            ${items.map(it => `
              <div class="collecte-row">
                <span class="collecte-row__day">${escapeHTML(formatLongDate(it.date))}</span>
                <span class="collecte-row__when">dans ${daysUntil(it.date)} j</span>
              </div>
            `).join('')}
          </div>
        `;
      }).join('');

    const headSubtitle = nextEnc
      ? `prochain encombrant ${formatLongDate(nextEnc.date)}`
      : (upcoming[0] ? `prochaine ${upcoming[0].label.toLowerCase()} ${formatLongDate(upcoming[0].date)}` : 'aucune collecte');

    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Collectes</span>
          <span class="card__subtitle">${escapeHTML(headSubtitle)}</span>
        </div>
      </div>
      ${heroHtml}
      ${sections ? `<div class="collecte-sections">${sections}</div>` : ''}
    `;
  }

  renderHero(item, address) {
    const days = daysUntil(item.date);
    const bigNumber = days === 0 ? "aujourd'hui" : days === 1 ? 'demain' : `${days}`;
    const unit = days > 1 ? 'jours' : '';
    return `
      <div class="bins-hero">
        <div class="bins-hero__number">${escapeHTML(bigNumber)}${unit ? `<small>${unit}</small>` : ''}</div>
        <div class="bins-hero__label">avant le prochain ramassage d'encombrants</div>
        <div class="bins-hero__date">${escapeHTML(formatLongDate(item.date))}</div>
        ${address ? `<div class="bins-hero__addr">${escapeHTML(address)}</div>` : ''}
        <div class="bins-hero__rule">Dépôt la veille à partir de 19h</div>
      </div>
    `;
  }

  refresh() { this.render(); }
}
