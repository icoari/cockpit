import { getSettings, cacheGet, cacheSet, cacheBust, save } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const ENDPOINT = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';

const FUEL_LABELS = {
  sp95: 'SP95',
  sp98: 'SP98',
  e10:  'E10',
};

async function fetchStations(lat, lon, radiusKm) {
  const where = `within_distance(geom, geom'POINT(${lon} ${lat})', ${radiusKm}km)`;
  const url = `${ENDPOINT}?limit=100&where=${encodeURIComponent(where)}`;
  const resp = await fetchWithTimeout(url, {}, 8000);
  if (!resp.ok) throw new Error(`Stations essence : HTTP ${resp.status}`);
  return resp.json();
}

function readPrice(rec, fuel) {
  const p = rec[`${fuel}_prix`];
  if (p == null) return null;
  return Number(p);
}

function nicifyStreet(s) {
  if (!s) return '';
  // ALL CAPS street names → Title Case
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export class GasWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.lastSummary = '';
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    const fuel = getSettings().gas.fuel;
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Stations essence</span>
          <span class="card__subtitle"></span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="card__body">
        <div class="fuel-tabs" data-fuel-tabs>
          ${Object.entries(FUEL_LABELS).map(([k, v]) => `
            <button class="fuel-tab ${fuel === k ? 'fuel-tab--active' : ''}" data-fuel="${k}" type="button">${escapeHTML(v)}</button>
          `).join('')}
        </div>
        <div data-body><div class="card__loading">Localisation…</div></div>
      </div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        // Bust the key actually used by the last fetch (GPS-coord based) —
        // the settings-based key never matches it.
        if (this.lastCacheKey) cacheBust(this.lastCacheKey);
        this.refresh();
        return;
      }
      const fuelBtn = e.target.closest('[data-fuel]');
      if (fuelBtn) {
        e.stopPropagation();
        haptic(4);
        const v = fuelBtn.dataset.fuel;
        const settings = getSettings();
        if (settings.gas.fuel !== v) {
          settings.gas.fuel = v;
          save();
          this.render();
          this.refresh();
        }
      }
    });
  }

  cacheKey() {
    const s = getSettings();
    return `gas_${s.location.lat}_${s.location.lon}_${s.gas.radiusKm}`;
  }

  setSubtitle(text) {
    this.lastSummary = text;
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = text;
  }

  setBody(html) {
    const el = this.container.querySelector('[data-body]');
    if (el) el.innerHTML = html;
  }

  async refresh() {
    const settings = getSettings();
    const fuel = settings.gas.fuel;
    this.setBody('<div class="card__loading">Localisation…</div>');
    this.setSubtitle('chargement…');

    // Try geolocation first; fall back to configured location
    let pos = await getPosition({ timeout: 4000 });
    let geoloc = !!pos;
    if (!pos) pos = { lat: settings.location.lat, lon: settings.location.lon };
    if (pos.lat == null || pos.lon == null) {
      this.setBody('<div class="card__empty">Localisation indisponible — autorise la géolocalisation ou renseigne lat/lon dans les <a href="#" data-open-settings>Réglages</a>.</div>');
      this.setSubtitle('non configuré');
      return;
    }

    let data;
    const cacheKey = `gas_${pos.lat.toFixed(2)}_${pos.lon.toFixed(2)}_${settings.gas.radiusKm}`;
    this.lastCacheKey = cacheKey;
    const cached = cacheGet(cacheKey, CACHE_TTL);
    if (cached) {
      data = cached;
    } else {
      try {
        data = await fetchStations(pos.lat, pos.lon, settings.gas.radiusKm);
        cacheSet(cacheKey, data);
      } catch (e) {
        this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
        this.setSubtitle('erreur');
        return;
      }
    }

    const stations = (data.results || [])
      .map(r => ({
        id: r.id,
        address: nicifyStreet(r.adresse),
        city: r.ville,
        lat: r.geom?.lat,
        lon: r.geom?.lon,
        price: readPrice(r, fuel),
        priceDate: r[`${fuel}_maj`] ? new Date(r[`${fuel}_maj`]) : null,
      }))
      .filter(s => s.price != null && s.lat && s.lon)
      .map(s => ({ ...s, dist: distanceKm(pos, { lat: s.lat, lon: s.lon }) }));

    if (stations.length === 0) {
      this.setBody(`<div class="card__empty">Aucune station vendant du ${escapeHTML(FUEL_LABELS[fuel])} dans un rayon de ${settings.gas.radiusKm} km.</div>`);
      this.setSubtitle('aucune station');
      return;
    }

    // Top 3 cheapest
    const cheapest = [...stations].sort((a, b) => a.price - b.price).slice(0, 3);
    // Also note the closest one if it isn't already in the top 3
    const closest = [...stations].sort((a, b) => a.dist - b.dist)[0];
    const showClosest = closest && !cheapest.find(s => s.id === closest.id) && closest.dist < cheapest[0].dist;

    const renderRow = (s, opts = {}) => {
      const stale = s.priceDate ? (Date.now() - s.priceDate.getTime() > 14 * 86400 * 1000) : false;
      return `
        <a class="gas-row" target="_blank" rel="noopener noreferrer"
           href="https://maps.apple.com/?daddr=${s.lat},${s.lon}">
          <div class="gas-row__price">${s.price.toFixed(3)} €<small>/L</small></div>
          <div class="gas-row__info">
            <div class="gas-row__name">${escapeHTML(s.address || s.city)}</div>
            <div class="gas-row__sub">${escapeHTML(s.city)} · ${s.dist.toFixed(1)} km${stale ? ' · prix > 14 j' : ''}</div>
          </div>
          ${opts.badge ? `<span class="gas-row__badge">${escapeHTML(opts.badge)}</span>` : ''}
        </a>
      `;
    };

    let html = '<div class="gas-list">';
    cheapest.forEach((s, i) => {
      html += renderRow(s, { badge: i === 0 ? 'le moins cher' : '' });
    });
    if (showClosest) {
      html += `<div class="train-section-label" style="margin-top:6px">Le plus proche</div>`;
      html += renderRow(closest);
    }
    html += '</div>';
    html += `<div class="gas-foot">Position : ${geoloc ? 'GPS' : 'Conflans (par défaut)'} · ${stations.length} stations dans ${settings.gas.radiusKm} km</div>`;
    this.setBody(html);

    const cheapestPrice = cheapest[0].price.toFixed(3);
    this.setSubtitle(`${FUEL_LABELS[fuel]} dès ${cheapestPrice} €/L`);
  }
}
