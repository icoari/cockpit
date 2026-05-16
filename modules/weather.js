import { getSettings, cacheGet, cacheSet } from './state.js';
import { weatherCodeIcon } from './icons.js';
import { fetchWithTimeout } from './util.js';

const CACHE_TTL = 30 * 60 * 1000; // 30 min

export async function fetchWeather() {
  const cached = cacheGet('weather', CACHE_TTL);
  if (cached) return cached;

  const { lat, lon } = getSettings().location;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Europe%2FParis&forecast_days=1`;

  const resp = await fetchWithTimeout(url, {}, 6000);
  if (!resp.ok) throw new Error(`Météo: ${resp.status}`);
  const data = await resp.json();
  cacheSet('weather', data);
  return data;
}

export async function renderHeaderWeather(iconEl, tempEl, rangeEl) {
  try {
    const data = await fetchWeather();
    const code = data.current.weather_code;
    const isDay = data.current.is_day === 1;
    iconEl.innerHTML = weatherCodeIcon(code, isDay);
    tempEl.textContent = `${Math.round(data.current.temperature_2m)}°`;
    const tmax = Math.round(data.daily.temperature_2m_max[0]);
    const tmin = Math.round(data.daily.temperature_2m_min[0]);
    rangeEl.textContent = `${tmin}° / ${tmax}°`;
  } catch (e) {
    iconEl.innerHTML = '';
    tempEl.textContent = '—';
    rangeEl.textContent = '';
  }
}
