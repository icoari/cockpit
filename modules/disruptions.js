import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';

const CACHE_TTL = 5 * 60 * 1000; // 5 min

const LINES = [
  { id: 'line:IDFM:C01739', code: 'J', name: 'Transilien J' },
  { id: 'line:IDFM:C01742', code: 'A', name: 'RER A' },
];

// Keywords on the user's commute path. If a disruption mentions ANY of these,
// it's relevant. Stations BEYOND Conflans (the user's home) on each branch are
// not in the list — disruptions that mention only those are filtered out.
const J_PATH = [
  'conflans', 'saint-lazare', 'st-lazare', 'st lazare', 'paris saint',
  'houilles', 'argenteuil', 'sartrouville', 'maisons-laffitte', 'maisons laffitte',
  'achères', 'acheres', 'tout l\'axe', 'tout laxe',
];
const A_PATH = [
  'conflans', 'cergy', 'nanterre', 'la défense', 'la defense',
  'houilles', 'sartrouville', 'maisons-laffitte', 'maisons laffitte',
  'achères', 'acheres', 'poissy', 'tout l\'axe',
];

function stripHTML(s) {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&#?\w+;/g, (m) => {
      const t = document.createElement('textarea');
      t.innerHTML = m;
      return t.value;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function bestMessage(disruption) {
  let best = '';
  // Prefer "web" or "long" channels for more verbose content
  for (const m of disruption.messages || []) {
    const txt = stripHTML(m.text || '');
    if (txt.length > best.length) best = txt;
  }
  return best;
}

function isRelevant(lineCode, text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const keywords = lineCode === 'J' ? J_PATH : A_PATH;
  return keywords.some(k => lower.includes(k));
}

function isActive(disruption) {
  const now = Date.now();
  return (disruption.application_periods || []).some(p => {
    const begin = parseNavitiaDt(p.begin);
    const end = parseNavitiaDt(p.end);
    return begin && end && now >= begin.getTime() && now <= end.getTime();
  });
}

function isUpcomingIn15Days(disruption) {
  const now = Date.now();
  const limit = now + 15 * 86400 * 1000;
  return (disruption.application_periods || []).some(p => {
    const begin = parseNavitiaDt(p.begin);
    return begin && begin.getTime() > now && begin.getTime() <= limit;
  });
}

function nextPeriod(disruption) {
  const now = Date.now();
  const upcoming = (disruption.application_periods || [])
    .map(p => ({ begin: parseNavitiaDt(p.begin), end: parseNavitiaDt(p.end) }))
    .filter(p => p.begin && p.end && p.end.getTime() >= now)
    .sort((a, b) => a.begin - b.begin);
  return upcoming[0] || null;
}

function parseNavitiaDt(s) {
  if (!s) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(9, 11) || 0, mi = +s.slice(11, 13) || 0, se = +s.slice(13, 15) || 0;
  return new Date(y, m, d, h, mi, se);
}

function fmtPeriod(p) {
  if (!p) return '';
  const sameDay = p.begin.toDateString() === p.end.toDateString();
  const dateF = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeF = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) {
    return `${dateF.format(p.begin)} · ${timeF.format(p.begin)}–${timeF.format(p.end)}`;
  }
  return `${dateF.format(p.begin)} ${timeF.format(p.begin)} → ${dateF.format(p.end)} ${timeF.format(p.end)}`;
}

async function fetchLineDisruptions(apiKey, line) {
  const url = `https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/lines/${line.id}/disruptions?count=30`;
  const resp = await fetchWithTimeout(url, { headers: { 'apikey': apiKey } }, 9000);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.disruptions || []).map(d => ({
    id: d.id,
    line: line.code,
    lineName: line.name,
    status: d.status,
    cause: d.cause || '',
    category: d.category || '',
    severity: d.severity?.name || '',
    text: bestMessage(d),
    periods: d.application_periods || [],
  }));
}

async function loadAll(apiKey) {
  const cached = cacheGet('disruptions', CACHE_TTL);
  if (cached) return cached;
  const results = await Promise.all(LINES.map(l => fetchLineDisruptions(apiKey, l).catch(() => [])));
  const all = results.flat();
  cacheSet('disruptions', all);
  return all;
}

function shortText(s, max = 180) {
  if (!s) return '';
  // Take first sentence-ish
  const cut = s.indexOf('. ');
  const trimmed = (cut > 30 && cut < max) ? s.slice(0, cut + 1) : s.slice(0, max);
  return trimmed + (trimmed.length < s.length ? '…' : '');
}

function renderRow(d) {
  const period = nextPeriod(d);
  return `
    <div class="disr-row">
      <span class="disr-row__line disr-row__line--${d.line.toLowerCase()}">${d.line}</span>
      <div class="disr-row__body">
        <div class="disr-row__text">${escapeHTML(shortText(d.text))}</div>
        ${period ? `<div class="disr-row__period">${escapeHTML(fmtPeriod(period))}</div>` : ''}
      </div>
    </div>
  `;
}

export class DisruptionsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Perturbations & travaux</span>
          <span class="card__subtitle">chargement…</span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div data-body><div class="card__loading">Chargement…</div></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        cacheBust('disruptions');
        this.refresh();
      }
    });
  }

  setSubtitle(t) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = t;
  }
  setBody(html) {
    const el = this.container.querySelector('[data-body]');
    if (el) el.innerHTML = html;
  }

  async refresh() {
    const settings = getSettings();
    if (!settings.idfm.apiKey) {
      this.container.classList.add('card--hidden');
      return;
    }

    try {
      const all = await loadAll(settings.idfm.apiKey);
      // Filter to relevant + active or upcoming-15d, dedupe by id, sort
      const seen = new Set();
      const relevant = all
        .filter(d => d.status !== 'past')
        .filter(d => isActive(d) || isUpcomingIn15Days(d))
        .filter(d => isRelevant(d.line, d.text))
        .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; });

      if (relevant.length === 0) {
        // Hide the card entirely when nothing affects the user
        this.container.classList.add('card--hidden');
        return;
      }
      this.container.classList.remove('card--hidden');

      const active = relevant.filter(d => isActive(d));
      const upcoming = relevant.filter(d => !isActive(d) && isUpcomingIn15Days(d))
        .sort((a, b) => {
          const pa = nextPeriod(a); const pb = nextPeriod(b);
          return (pa?.begin || 0) - (pb?.begin || 0);
        });

      let html = '';
      if (active.length) {
        html += `<div class="disr-section-label disr-section-label--active">En cours</div>`;
        html += active.map(renderRow).join('');
      }
      if (upcoming.length) {
        html += `<div class="disr-section-label">Prévus dans les 15 jours</div>`;
        html += upcoming.map(renderRow).join('');
      }
      this.setBody(html);

      const parts = [];
      if (active.length) parts.push(`${active.length} en cours`);
      if (upcoming.length) parts.push(`${upcoming.length} à venir`);
      this.setSubtitle(parts.join(' · ') || 'aucune');
    } catch (e) {
      this.container.classList.add('card--hidden');
    }
  }
}
