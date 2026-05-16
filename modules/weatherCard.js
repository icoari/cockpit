import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS, weatherCodeIcon, weatherCodeLabel } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';

const CACHE_TTL = 30 * 60 * 1000;

async function fetchForecast() {
  const cached = cacheGet('weatherCard', CACHE_TTL);
  if (cached) return cached;
  const { lat, lon } = getSettings().location;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day,wind_speed_10m,relative_humidity_2m&hourly=temperature_2m,precipitation_probability,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Europe%2FParis&forecast_days=3`;
  const resp = await fetchWithTimeout(url, {}, 6000);
  if (!resp.ok) throw new Error(`Météo : HTTP ${resp.status}`);
  const data = await resp.json();
  cacheSet('weatherCard', data);
  return data;
}

function rainSummary(hourly) {
  const now = Date.now();
  // Find first hour in next 12h where precipitation prob > 60
  for (let i = 0; i < hourly.time.length && i < 12; i++) {
    const t = new Date(hourly.time[i]).getTime();
    if (t < now) continue;
    if ((hourly.precipitation_probability?.[i] ?? 0) >= 60) {
      const when = new Date(hourly.time[i]).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return { rain: true, when, prob: hourly.precipitation_probability[i] };
    }
  }
  return { rain: false };
}

function renderHourlyChart(hourly) {
  const W = 100, H = 40;
  // Take next 12 hours starting from current time
  const now = Date.now();
  const points = [];
  for (let i = 0; i < hourly.time.length && points.length < 12; i++) {
    const t = new Date(hourly.time[i]).getTime();
    if (t < now - 60 * 60 * 1000) continue; // skip past hours
    points.push({
      hour: new Date(hourly.time[i]),
      temp: hourly.temperature_2m[i],
      prob: hourly.precipitation_probability[i] ?? 0,
    });
  }
  if (points.length === 0) return '';
  const temps = points.map(p => p.temp);
  const tmin = Math.min(...temps);
  const tmax = Math.max(...temps);
  const range = Math.max(1, tmax - tmin);
  const dx = W / Math.max(1, points.length - 1);
  let path = '';
  points.forEach((p, i) => {
    const x = i * dx;
    const y = H - 6 - ((p.temp - tmin) / range) * (H - 12);
    path += `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  // Rain bars
  const bars = points.map((p, i) => {
    const x = i * dx - dx * 0.3;
    const w = dx * 0.6;
    const h = (p.prob / 100) * (H - 4);
    const y = H - h;
    if (p.prob < 5) return '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="rgba(127,209,185,0.18)" rx="1" />`;
  }).join('');
  // X axis ticks
  const ticks = points.filter((_, i) => i === 0 || i === points.length - 1 || i % 4 === 0);
  const tickEls = ticks.map(p => {
    const i = points.indexOf(p);
    const x = i * dx;
    const label = p.hour.toLocaleTimeString('fr-FR', { hour: '2-digit' }).replace(':00', 'h');
    return `<text x="${x.toFixed(1)}" y="${H - 0.5}" font-size="3.4" fill="rgba(255,255,255,0.35)" text-anchor="middle">${label}</text>`;
  }).join('');
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="weather-sparkline">
      ${bars}
      <path d="${path}" fill="none" stroke="#7FD1B9" stroke-width="0.8" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
      ${tickEls}
    </svg>
  `;
}

function renderDailyRow(daily, idx) {
  const date = new Date(daily.time[idx]);
  const dayLabel = idx === 0 ? "Aujourd'hui" : idx === 1 ? 'Demain'
    : new Intl.DateTimeFormat('fr-FR', { weekday: 'long' }).format(date);
  const tmax = Math.round(daily.temperature_2m_max[idx]);
  const tmin = Math.round(daily.temperature_2m_min[idx]);
  const code = daily.weather_code[idx];
  const prob = daily.precipitation_probability_max?.[idx] ?? 0;
  return `
    <div class="weather-day">
      <span class="weather-day__icon">${weatherCodeIcon(code, true)}</span>
      <span class="weather-day__label">${escapeHTML(dayLabel)}</span>
      <span class="weather-day__rain">${prob >= 30 ? prob + '%' : ''}</span>
      <span class="weather-day__range"><strong>${tmax}°</strong><span>${tmin}°</span></span>
    </div>
  `;
}

export class WeatherCard {
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
          <span class="card__title">Météo — ${escapeHTML(getSettings().location.name)}</span>
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
        cacheBust('weatherCard');
        this.refresh();
      }
    });
  }

  setSubtitle(text) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = text;
  }

  async refresh() {
    const body = this.container.querySelector('[data-body]');
    body.innerHTML = '<div class="card__loading">Chargement…</div>';
    try {
      const data = await fetchForecast();
      const code = data.current.weather_code;
      const isDay = data.current.is_day === 1;
      const t = Math.round(data.current.temperature_2m);
      const wind = Math.round(data.current.wind_speed_10m);
      const humidity = data.current.relative_humidity_2m;
      const rain = rainSummary(data.hourly);
      const label = weatherCodeLabel(code);

      const dailyHtml = (data.daily.time || []).slice(0, 3).map((_, i) => renderDailyRow(data.daily, i)).join('');
      const chartHtml = renderHourlyChart(data.hourly);

      const rainAlert = rain.rain
        ? `<div class="weather-alert">Pluie probable vers ${rain.when} (${rain.prob}%)</div>`
        : '';

      body.innerHTML = `
        <div class="weather-current">
          <div class="weather-current__icon">${weatherCodeIcon(code, isDay)}</div>
          <div class="weather-current__main">
            <div class="weather-current__temp">${t}°</div>
            <div class="weather-current__label">${escapeHTML(label)}</div>
          </div>
          <div class="weather-current__stats">
            <div>vent <strong>${wind} km/h</strong></div>
            <div>humid. <strong>${humidity}%</strong></div>
          </div>
        </div>
        ${rainAlert}
        ${chartHtml}
        <div class="weather-days">${dailyHtml}</div>
      `;
      this.setSubtitle(`${t}° · ${label}${rain.rain ? ` · pluie ${rain.when}` : ''}`);
    } catch (e) {
      body.innerHTML = `<div class="card__error">${escapeHTML(e.message)}</div>`;
      this.setSubtitle('erreur');
    }
  }
}
