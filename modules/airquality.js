import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchAir() {
  const cached = cacheGet('air', CACHE_TTL);
  if (cached) return cached;
  const { lat, lon } = getSettings().location;
  if (lat == null || lon == null) {
    throw new Error('Localisation non configurée — renseigne lat/lon dans les Réglages.');
  }
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide&hourly=alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen&timezone=Europe%2FParis&forecast_days=1`;
  const resp = await fetchWithTimeout(url, {}, 6000);
  if (!resp.ok) throw new Error(`Air : HTTP ${resp.status}`);
  const data = await resp.json();
  cacheSet('air', data);
  return data;
}

const AQI_BUCKETS = [
  { max: 20,  label: 'Très bon', cls: 'aqi--good' },
  { max: 40,  label: 'Bon',       cls: 'aqi--ok' },
  { max: 60,  label: 'Moyen',     cls: 'aqi--meh' },
  { max: 80,  label: 'Mauvais',   cls: 'aqi--bad' },
  { max: 100, label: 'Très mauvais', cls: 'aqi--bad' },
  { max: Infinity, label: 'Extrêmement mauvais', cls: 'aqi--worst' },
];

function classifyAqi(v) {
  return AQI_BUCKETS.find(b => v <= b.max);
}

const POLLEN_LABELS = {
  alder_pollen:  'Aulne',
  birch_pollen:  'Bouleau',
  grass_pollen:  'Graminées',
  mugwort_pollen:'Armoise',
  olive_pollen:  'Olivier',
  ragweed_pollen:'Ambroisie',
};

// Pollen grade based on grains/m³
function pollenLevel(v) {
  if (v == null) return null;
  if (v < 0.5) return null; // negligible
  if (v < 1.5) return { label: 'faible', cls: 'pollen--low' };
  if (v < 5)   return { label: 'modéré', cls: 'pollen--med' };
  if (v < 20)  return { label: 'élevé', cls: 'pollen--high' };
  return { label: 'très élevé', cls: 'pollen--very-high' };
}

export class AirQualityWidget {
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
          <span class="card__title">Air & pollens</span>
          <span class="card__subtitle"></span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="card__body" data-body></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        cacheBust('air');
        this.refresh();
      }
    });
  }

  setSubtitle(t) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = t;
  }

  async refresh() {
    const body = this.container.querySelector('[data-body]');
    body.innerHTML = '<div class="card__loading">Chargement…</div>';
    try {
      const data = await fetchAir();
      const aqi = Math.round(data.current.european_aqi);
      const bucket = classifyAqi(aqi);
      const pm10 = Math.round(data.current.pm10);
      const pm25 = Math.round(data.current.pm2_5);
      const no2 = Math.round(data.current.nitrogen_dioxide);
      const o3 = Math.round(data.current.ozone);

      // Pollen: take the latest available hour <= now
      const hourly = data.hourly || {};
      let pollens = [];
      if (hourly.time && hourly.time.length) {
        const now = Date.now();
        let idx = 0;
        for (let i = 0; i < hourly.time.length; i++) {
          if (new Date(hourly.time[i]).getTime() <= now) idx = i;
        }
        for (const k of Object.keys(POLLEN_LABELS)) {
          if (hourly[k]) {
            const v = hourly[k][idx];
            const level = pollenLevel(v);
            if (level) pollens.push({ name: POLLEN_LABELS[k], value: v, level });
          }
        }
        pollens.sort((a, b) => b.value - a.value);
      }

      const aqiCircleHtml = `
        <div class="aqi-circle ${bucket.cls}">
          <div class="aqi-circle__value">${aqi}</div>
          <div class="aqi-circle__label">indice</div>
        </div>
      `;

      body.innerHTML = `
        <div class="aqi-main">
          ${aqiCircleHtml}
          <div class="aqi-info">
            <div class="aqi-info__verdict">${bucket.label}</div>
            <div class="aqi-stats">
              <div>PM2.5 <strong>${pm25} µg/m³</strong></div>
              <div>PM10 <strong>${pm10} µg/m³</strong></div>
              <div>NO₂ <strong>${no2} µg/m³</strong></div>
              <div>O₃ <strong>${o3} µg/m³</strong></div>
            </div>
          </div>
        </div>
        ${pollens.length > 0 ? `
          <div class="pollen-section">
            <div class="pollen-section__title">Pollens dans l'air</div>
            <div class="pollen-list">
              ${pollens.map(p => `
                <div class="pollen-item ${p.level.cls}">
                  <span class="pollen-item__name">${escapeHTML(p.name)}</span>
                  <span class="pollen-item__level">${escapeHTML(p.level.label)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : '<div class="card__empty" style="margin-top:8px">Aucun pollen significatif actuellement.</div>'}
      `;
      this.setSubtitle(`indice ${aqi} · ${bucket.label}${pollens.length ? ' · ' + pollens[0].name.toLowerCase() + ' ' + pollens[0].level.label : ''}`);
    } catch (e) {
      body.innerHTML = `<div class="card__error">${escapeHTML(e.message)}</div>`;
      this.setSubtitle('erreur');
    }
  }
}
