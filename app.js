import { ICONS } from './modules/icons.js';
import { formatDateLong, haptic } from './modules/util.js';
import { getSettings, updateSettings } from './modules/state.js';
import { renderHeaderWeather } from './modules/weather.js';
import { TrainsWidget } from './modules/trains.js';
import { AiWatchWidget } from './modules/aiwatch.js';
import { GasWidget } from './modules/gas.js';
import { WeatherCard } from './modules/weatherCard.js';
import { AirQualityWidget } from './modules/airquality.js';
import { SettingsPanel } from './modules/settings.js';

// ---------- Page header ----------
function renderHeader() {
  document.getElementById('dateLabel').textContent = formatDateLong(new Date());
  document.getElementById('settingsBtn').innerHTML = ICONS.settings;
  renderHeaderWeather(
    document.getElementById('weatherIcon'),
    null,
    null,
    document.getElementById('weatherTemp'),
  );
}

// ---------- Tabs ----------
function setActiveTab(name) {
  document.querySelectorAll('.tabbar-btn').forEach(b => {
    b.classList.toggle('tabbar-btn--active', b.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
  });
  document.getElementById('pageSection').textContent = name === 'pro' ? 'Pro' : 'Perso';
  updateSettings({ activeTab: name });
  // Scroll to top of new pane
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initTabs() {
  // Inject SVG icons
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });

  document.querySelectorAll('.tabbar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic(4);
      setActiveTab(btn.dataset.tab);
    });
  });

  const saved = getSettings().activeTab || 'perso';
  setActiveTab(saved);
}

// ---------- Widgets ----------
const widgets = {};

function mountWidgets() {
  widgets.gas         = new GasWidget(document.querySelector('[data-widget="gas"]'));
  widgets.weatherCard = new WeatherCard(document.querySelector('[data-widget="weatherCard"]'));
  widgets.air         = new AirQualityWidget(document.querySelector('[data-widget="air"]'));
  widgets.trainsAller  = new TrainsWidget(document.querySelector('[data-widget="trains-aller"]'), 'aller');
  widgets.trainsRetour = new TrainsWidget(document.querySelector('[data-widget="trains-retour"]'), 'retour');
  widgets.aiwatch      = new AiWatchWidget(document.querySelector('[data-widget="aiwatch"]'));
}

// ---------- Settings ----------
function initSettings() {
  const panel = new SettingsPanel(
    document.getElementById('settingsBody'),
    () => {
      Object.values(widgets).forEach(w => {
        if (typeof w.refresh === 'function') {
          try { w.refresh(); } catch {}
        }
      });
      renderHeader();
    }
  );

  document.getElementById('settingsBtn').addEventListener('click', () => {
    haptic(4);
    panel.open();
  });
  document.getElementById('settingsClose').addEventListener('click', () => panel.close());
  document.getElementById('settingsBackdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) panel.close();
  });

  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) {
      e.preventDefault();
      panel.open();
    }
  });

  // Weather chip tap → open settings (location config)
  document.getElementById('weatherMini').addEventListener('click', () => {
    haptic(4);
    panel.open();
  });
}

// ---------- Lifecycle ----------
function refreshLiveData() {
  renderHeader();
  Object.values(widgets).forEach(w => {
    if (typeof w.refresh === 'function') {
      try { w.refresh(); } catch {}
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshLiveData();
});
window.addEventListener('focus', refreshLiveData);

setInterval(() => {
  if (!document.hidden) {
    try { widgets.trainsAller?.refresh(); } catch {}
    try { widgets.trainsRetour?.refresh(); } catch {}
  }
}, 90 * 1000);

// ---------- Init ----------
renderHeader();
mountWidgets();
initTabs();
initSettings();
