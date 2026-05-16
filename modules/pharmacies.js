import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';

const CACHE_TTL = 6 * 60 * 60 * 1000;     // 6h — pharmacy data doesn't change often
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Very small subset of OSM opening_hours parser handling common formats:
//   "Mo-Fr 09:00-19:30; Sa 09:00-13:00"
//   "Mo-Sa 08:30-12:30,14:00-19:30"
//   "24/7"
//   "Mo,We,Fr 09:00-19:00"
function isOpenNow(spec) {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (trimmed === '24/7') return true;

  const now = new Date();
  const wd = DAYS[now.getDay()];
  const wdIdx = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // Split rules by ; (multiple rule sets)
  const rules = trimmed.split(';').map(r => r.trim()).filter(Boolean);
  for (const rule of rules) {
    // rule like "Mo-Fr 09:00-19:30" or "Sa 09:00-13:00" or just "08:00-12:00" (assumes all days)
    const match = rule.match(/^(.*?)(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)\s*$/);
    if (!match) continue;
    let dayPart = match[1].trim();
    const timePart = match[2];

    let appliesToday = false;
    if (!dayPart || /^(PH|SH)/.test(dayPart)) {
      // No day part or only PH/SH → applies every day
      appliesToday = !dayPart;
    } else {
      // Day part: "Mo-Fr" or "Mo,We,Fr" or "Mo"
      const segments = dayPart.split(',').map(s => s.trim());
      for (const seg of segments) {
        if (seg.includes('-')) {
          const [start, end] = seg.split('-').map(s => s.trim());
          const sI = DAYS.indexOf(start), eI = DAYS.indexOf(end);
          if (sI < 0 || eI < 0) continue;
          if (sI <= eI) {
            if (wdIdx >= sI && wdIdx <= eI) { appliesToday = true; break; }
          } else {
            if (wdIdx >= sI || wdIdx <= eI) { appliesToday = true; break; }
          }
        } else {
          if (seg === wd) { appliesToday = true; break; }
        }
      }
    }
    if (!appliesToday) continue;

    // Check any time interval
    const intervals = timePart.split(',');
    for (const iv of intervals) {
      const [from, to] = iv.split('-');
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const fMin = fh * 60 + fm;
      const tMin = th * 60 + tm;
      if (minutes >= fMin && minutes < tMin) return true;
    }
  }
  return false;
}

function closesSoon(spec) {
  // Returns minutes until close if open and close within next 60 min, else null
  if (!spec) return null;
  const trimmed = spec.trim();
  if (trimmed === '24/7') return null;
  const now = new Date();
  const wd = DAYS[now.getDay()];
  const wdIdx = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const rules = trimmed.split(';').map(r => r.trim()).filter(Boolean);
  for (const rule of rules) {
    const match = rule.match(/^(.*?)(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)\s*$/);
    if (!match) continue;
    const dayPart = match[1].trim();
    const timePart = match[2];
    let appliesToday = false;
    if (!dayPart) appliesToday = true;
    else {
      const segments = dayPart.split(',').map(s => s.trim());
      for (const seg of segments) {
        if (seg.includes('-')) {
          const [start, end] = seg.split('-').map(s => s.trim());
          const sI = DAYS.indexOf(start), eI = DAYS.indexOf(end);
          if (sI < 0 || eI < 0) continue;
          if (sI <= eI && wdIdx >= sI && wdIdx <= eI) { appliesToday = true; break; }
          if (sI > eI && (wdIdx >= sI || wdIdx <= eI)) { appliesToday = true; break; }
        } else if (seg === wd) { appliesToday = true; break; }
      }
    }
    if (!appliesToday) continue;
    const intervals = timePart.split(',');
    for (const iv of intervals) {
      const [from, to] = iv.split('-');
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const fMin = fh * 60 + fm;
      const tMin = th * 60 + tm;
      if (minutes >= fMin && minutes < tMin && tMin - minutes <= 60) return tMin - minutes;
    }
  }
  return null;
}

async function fetchPharmacies(lat, lon, radiusM) {
  const cacheKey = `pharma_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;
  const query = `[out:json][timeout:25];node["amenity"="pharmacy"](around:${radiusM},${lat},${lon});out body;`;
  const resp = await fetchWithTimeout(OVERPASS, {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' },
  }, 12000);
  if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
  const data = await resp.json();
  cacheSet(cacheKey, data);
  return data;
}

function statusOf(pharmacy) {
  const oh = pharmacy.tags?.opening_hours;
  if (!oh) return { cls: 'pharma-status--unknown', text: 'horaires non précisés' };
  const open = isOpenNow(oh);
  if (open === null) return { cls: 'pharma-status--unknown', text: 'horaires non précisés' };
  if (open === false) return { cls: 'pharma-status--closed', text: 'fermée' };
  const soon = closesSoon(oh);
  if (soon !== null) return { cls: 'pharma-status--soon', text: `ferme dans ${soon} min` };
  return { cls: 'pharma-status--open', text: 'ouverte' };
}

function nicifyAddr(p) {
  const t = p.tags || {};
  const parts = [t['addr:housenumber'], t['addr:street']].filter(Boolean);
  return parts.join(' ') || t['addr:full'] || '';
}

export class PharmaciesWidget {
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
          <span class="card__title">Pharmacies</span>
          <span class="card__subtitle">chargement…</span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div data-body><div class="card__loading">Localisation…</div></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
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
    const radius = (settings.pharmacies?.radiusKm || 3) * 1000;

    this.setBody('<div class="card__loading">Localisation…</div>');
    this.setSubtitle('chargement…');

    let pos = await getPosition({ timeout: 4000 });
    let geoloc = !!pos;
    if (!pos) pos = { lat: settings.location.lat, lon: settings.location.lon };

    try {
      const data = await fetchPharmacies(pos.lat, pos.lon, radius);
      const elements = data.elements || [];
      if (elements.length === 0) {
        this.setBody(`<div class="card__empty">Aucune pharmacie trouvée dans ${radius / 1000} km.</div>`);
        this.setSubtitle('aucune trouvée');
        return;
      }
      // Add distance and sort by distance
      const enriched = elements.map(e => ({
        ...e,
        dist: distanceKm(pos, { lat: e.lat, lon: e.lon }),
        status: statusOf(e),
      })).sort((a, b) => {
        // Open first, then closer
        const openA = a.status.cls === 'pharma-status--open' || a.status.cls === 'pharma-status--soon' ? 0 : 1;
        const openB = b.status.cls === 'pharma-status--open' || b.status.cls === 'pharma-status--soon' ? 0 : 1;
        if (openA !== openB) return openA - openB;
        return a.dist - b.dist;
      });

      const top = enriched.slice(0, 4);
      const openCount = enriched.filter(p => p.status.cls === 'pharma-status--open' || p.status.cls === 'pharma-status--soon').length;

      const rows = top.map(p => {
        const t = p.tags || {};
        const name = t.name || 'Pharmacie';
        const addr = nicifyAddr(p);
        return `
          <a class="pharma-row" target="_blank" rel="noopener noreferrer"
             href="https://maps.apple.com/?daddr=${p.lat},${p.lon}">
            <div class="pharma-row__info">
              <div class="pharma-row__name">${escapeHTML(name)}</div>
              <div class="pharma-row__sub">${addr ? escapeHTML(addr) + ' · ' : ''}${p.dist.toFixed(1)} km</div>
            </div>
            <div class="pharma-row__status ${p.status.cls}">${escapeHTML(p.status.text)}</div>
          </a>
        `;
      }).join('');

      this.setBody(`
        <div class="pharma-list">${rows}</div>
        <div class="pharma-foot">
          <a href="https://monpharmacien-idf.fr/" target="_blank" rel="noopener" class="link-btn">Pharmacie de garde →</a>
        </div>
      `);
      this.setSubtitle(`${openCount} ouverte${openCount > 1 ? 's' : ''} sur ${enriched.length} · ${geoloc ? 'GPS' : 'défaut'}`);
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }
}
