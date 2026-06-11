import { getSettings, cacheGet, cacheSet } from './state.js';
import { weatherCodeIcon } from './icons.js';
import { fetchWithTimeout } from './util.js';

const CACHE_TTL = 30 * 60 * 1000;

export async function fetchWeather() {
  const cached = cacheGet('weather', CACHE_TTL);
  if (cached) return cached;

  const { lat, lon } = getSettings().location;
  if (lat == null || lon == null) {
    throw Object.assign(new Error('Localisation non configurée (Réglages).'), { notConfigured: true });
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FParis&forecast_days=1`;

  const resp = await fetchWithTimeout(url, {}, 6000);
  if (!resp.ok) throw new Error(`Météo: ${resp.status}`);
  const data = await resp.json();
  cacheSet('weather', data);
  return data;
}

// Renders the small weather chip in the header (icon + current temp).
// Signature kept backward-compatible: (iconEl, _tempEl, _rangeEl, chipTempEl).
export async function renderHeaderWeather(iconEl, _tempEl, _rangeEl, chipTempEl) {
  try {
    const data = await fetchWeather();
    const code = data.current.weather_code;
    const isDay = data.current.is_day === 1;
    if (iconEl) iconEl.innerHTML = weatherCodeIcon(code, isDay);
    const t = Math.round(data.current.temperature_2m);
    if (chipTempEl) chipTempEl.textContent = `${t}°`;
    if (_tempEl) _tempEl.textContent = `${t}°`;
  } catch {
    if (iconEl) iconEl.innerHTML = '';
    if (chipTempEl) chipTempEl.textContent = '—';
  }
}
