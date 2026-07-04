import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';

const CACHE_TTL = 6 * 60 * 60 * 1000;
const FINESS = 'https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets/carte-des-pharmacies-dile-de-france/records';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Parse an opening_hours spec into the intervals that apply on a given
// weekday index (0=Sunday). One implementation for isOpenNow AND closesSoon
// (they were ~35 duplicated lines). Returns { matched, intervals } where
// `matched` says whether ANY rule in the spec parsed — unparseable specs
// (sunrise-sunset, localized syntax) must read as "unknown", not "closed".
function intervalsForDay(spec, wdIdx) {
  const wd = DAYS[wdIdx];
  let matched = false;
  const intervals = [];
  for (const rule of spec.split(';').map(r => r.trim()).filter(Boolean)) {
    const m = rule.match(/^(.*?)(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)\s*$/);
    if (!m) continue;
    matched = true;
    const dayPart = m[1].trim();
    let applies = !dayPart;
    if (dayPart) {
      for (const seg of dayPart.split(',').map(s => s.trim())) {
        if (seg.includes('-')) {
          const [start, end] = seg.split('-').map(s => s.trim());
          const sI = DAYS.indexOf(start), eI = DAYS.indexOf(end);
          if (sI < 0 || eI < 0) continue;
          if (sI <= eI && wdIdx >= sI && wdIdx <= eI) { applies = true; break; }
          if (sI > eI && (wdIdx >= sI || wdIdx <= eI)) { applies = true; break; }
        } else if (seg === wd) { applies = true; break; }
      }
    }
    if (!applies) continue;
    for (const iv of m[2].split(',')) {
      const [from, to] = iv.split('-');
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      intervals.push({ fromMin: fh * 60 + fm, toMin: th * 60 + tm });
    }
  }
  return { matched, intervals };
}

// true / false / null (unknown). Handles overnight ranges (22:00-06:00):
// covered tonight from today's rule, and before dawn from yesterday's rule.
function isOpenNow(spec) {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (trimmed === '24/7') return true;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = intervalsForDay(trimmed, now.getDay());
  const yesterday = intervalsForDay(trimmed, (now.getDay() + 6) % 7);
  if (!today.matched && !yesterday.matched) return null;   // unparseable → unknown
  for (const { fromMin, toMin } of today.intervals) {
    if (toMin > fromMin) { if (minutes >= fromMin && minutes < toMin) return true; }
    else if (minutes >= fromMin) return true;              // overnight, evening leg
  }
  for (const { fromMin, toMin } of yesterday.intervals) {
    if (toMin <= fromMin && minutes < toMin) return true;  // overnight, morning leg
  }
  return false;
}

// Minutes until closing if ≤ 60, else null.
function closesSoon(spec) {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (trimmed === '24/7') return null;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const today = intervalsForDay(trimmed, now.getDay());
  const yesterday = intervalsForDay(trimmed, (now.getDay() + 6) % 7);
  for (const { fromMin, toMin } of today.intervals) {
    if (toMin > fromMin) {
      if (minutes >= fromMin && minutes < toMin && toMin - minutes <= 60) return toMin - minutes;
    } else if (minutes >= fromMin) {
      const left = toMin + 1440 - minutes;                 // closes tomorrow
      if (left <= 60) return left;
    }
  }
  for (const { fromMin, toMin } of yesterday.intervals) {
    if (toMin <= fromMin && minutes < toMin && toMin - minutes <= 60) return toMin - minutes;
  }
  return null;
}

function niceCase(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bPharm\b/, 'Pharmacie')
    .replace(/\bSelarl\b/i, '');
}

function formatPhone(p) {
  if (!p) return '';
  const s = String(p).replace(/\D/g, '');
  if (s.length === 9) return '0' + s.replace(/(\d)(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
  return s;
}

async function fetchFINESS(lat, lon, radiusKm) {
  const where = `within_distance(wgs84, geom'POINT(${lon} ${lat})', ${radiusKm}km)`;
  const url = `${FINESS}?limit=50&where=${encodeURIComponent(where)}`;
  const resp = await fetchWithTimeout(url, {}, 8000);
  if (!resp.ok) throw new Error(`Pharmacies (FINESS) : HTTP ${resp.status}`);
  return resp.json();
}

async function fetchOSMHours(lat, lon, radiusM) {
  const query = `[out:json][timeout:25];node["amenity"="pharmacy"](around:${radiusM},${lat},${lon});out;`;
  const url = `${OVERPASS}?data=${encodeURIComponent(query)}`;
  try {
    const resp = await fetchWithTimeout(url, {}, 9000);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.elements || [];
  } catch {
    return [];
  }
}

function matchHours(pharmacy, osmList) {
  if (!osmList.length) return null;
  // Match by proximity (< 60 m) — same pharmacy in both datasets
  const closest = osmList
    .map(o => ({ ...o, d: distanceKm({ lat: pharmacy.lat, lon: pharmacy.lon }, { lat: o.lat, lon: o.lon }) * 1000 }))
    .filter(o => o.d < 60)
    .sort((a, b) => a.d - b.d)[0];
  return closest?.tags?.opening_hours || null;
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
        if (this.lastCacheKey) cacheBust(this.lastCacheKey);
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
    const radiusKm = settings.pharmacies?.radiusKm || 3;

    this.setBody('<div class="card__loading">Localisation…</div>');
    this.setSubtitle('chargement…');

    let pos = await getPosition({ timeout: 4000 });
    let geoloc = !!pos;
    if (!pos) pos = { lat: settings.location.lat, lon: settings.location.lon };
    if (pos.lat == null || pos.lon == null) {
      this.setBody('<div class="card__empty">Localisation indisponible — autorise la géolocalisation ou renseigne lat/lon dans les <a href="#" data-open-settings>Réglages</a>.</div>');
      this.setSubtitle('non configuré');
      return;
    }

    const cacheKey = `pharma_v2_${pos.lat.toFixed(3)}_${pos.lon.toFixed(3)}_${radiusKm}`;
    this.lastCacheKey = cacheKey;
    let entries = cacheGet(cacheKey, CACHE_TTL);
    if (!entries) {
      try {
        const [finessData, osmList] = await Promise.all([
          fetchFINESS(pos.lat, pos.lon, radiusKm),
          fetchOSMHours(pos.lat, pos.lon, radiusKm * 1000),
        ]);
        entries = (finessData.results || []).map(r => {
          // Coerce to numbers — they land in the maps href attribute.
          const lat = Number(r.lat), lon = Number(r.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          const numvoie = r.numvoie ? String(r.numvoie) : '';
          const street = [numvoie, r.typvoie, r.voie].filter(Boolean).join(' ');
          const name = niceCase(r.rs || 'Pharmacie');
          return {
            id: r.nofinesset,
            name,
            street: niceCase(street),
            city: niceCase(r.commune || ''),
            phone: formatPhone(r.telephone),
            lat, lon,
            openingHours: matchHours({ lat, lon }, osmList),
          };
        }).filter(Boolean);
        cacheSet(cacheKey, entries);
      } catch (e) {
        this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
        this.setSubtitle('erreur');
        return;
      }
    }

    if (entries.length === 0) {
      this.setBody(`<div class="card__empty">Aucune pharmacie trouvée dans ${radiusKm} km.</div>`);
      this.setSubtitle('aucune');
      return;
    }

    const enriched = entries.map(p => {
      const open = isOpenNow(p.openingHours);
      const soon = closesSoon(p.openingHours);
      let status;
      if (open === true && soon !== null) status = { cls: 'pharma-status--soon', text: `ferme dans ${soon} min`, openRank: 0 };
      else if (open === true) status = { cls: 'pharma-status--open', text: 'ouverte', openRank: 0 };
      else if (open === false) status = { cls: 'pharma-status--closed', text: 'fermée', openRank: 1 };
      else status = { cls: 'pharma-status--unknown', text: 'horaires inconnus', openRank: 2 };
      const dist = distanceKm(pos, { lat: p.lat, lon: p.lon });
      return { ...p, status, dist };
    }).sort((a, b) => {
      // Open first, then by distance
      if (a.status.openRank !== b.status.openRank) return a.status.openRank - b.status.openRank;
      return a.dist - b.dist;
    });

    const top = enriched.slice(0, 2);
    const openCount = enriched.filter(p => p.status.cls.startsWith('pharma-status--open') || p.status.cls === 'pharma-status--soon').length;

    const rows = top.map(p => `
      <a class="pharma-row" target="_blank" rel="noopener noreferrer"
         href="https://maps.apple.com/?daddr=${p.lat},${p.lon}">
        <div class="pharma-row__info">
          <div class="pharma-row__name">${escapeHTML(p.name)}</div>
          <div class="pharma-row__sub">${p.street ? escapeHTML(p.street) + ' · ' : ''}${p.dist.toFixed(2)} km${p.phone ? ' · ' + escapeHTML(p.phone) : ''}</div>
        </div>
        <div class="pharma-row__status ${p.status.cls}">${escapeHTML(p.status.text)}</div>
      </a>
    `).join('');

    this.setBody(`
      <div class="pharma-list">${rows}</div>
      <div class="pharma-foot">
        ${enriched.length - top.length > 0 ? `+ ${enriched.length - top.length} autres dans ${radiusKm} km · ` : ''}
        <a href="https://monpharmacien-idf.fr/" target="_blank" rel="noopener" class="link-btn">Pharmacie de garde →</a>
      </div>
    `);
    this.setSubtitle(`${openCount} ouverte${openCount > 1 ? 's' : ''} sur ${enriched.length} dans ${radiusKm} km`);
  }
}
