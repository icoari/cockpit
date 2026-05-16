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

// ---------- Header ----------
function renderHeader() {
  document.getElementById('dateLabel').textContent = formatDateLong(new Date());
  document.getElementById('settingsBtn').innerHTML = ICONS.settings;
  renderHeaderWeather(
    document.getElementById('weatherIcon'),
    document.getElementById('weatherTemp'),
    document.getElementById('weatherRange'),
  );
}

// ---------- Tabs ----------
function setActiveTab(name) {
  const tabs = document.querySelector('.tabs');
  tabs.dataset.active = name;
  tabs.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('tab--active', t.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
  });
  updateSettings({ activeTab: name });
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      haptic(4);
      setActiveTab(t.dataset.tab);
    });
  });
  const saved = getSettings().activeTab || 'perso';
  setActiveTab(saved);
}

// ---------- Collapsible cards ----------
function initCollapsibleCards() {
  // All cards start collapsed (compact)
  document.querySelectorAll('.widget.card').forEach(card => {
    card.classList.add('card--compact');
  });

  // Tap a compact card header → expand
  document.body.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-card-toggle]');
    if (toggle) {
      const card = toggle.closest('.card');
      if (!card) return;
      // If clicking on an action button inside head, don't toggle
      if (e.target.closest('[data-action]')) return;
      haptic(4);
      card.classList.toggle('card--compact');
      return;
    }
  });

  // Tap outside any expanded card → collapse it
  document.body.addEventListener('click', (e) => {
    document.querySelectorAll('.widget.card:not(.card--compact)').forEach(card => {
      if (card.contains(e.target)) return;
      // Don't collapse if click is on modal or topbar
      if (e.target.closest('.modal-backdrop')) return;
      if (e.target.closest('.topbar')) return;
      if (e.target.closest('.tabs')) return;
      card.classList.add('card--compact');
    });
  });
}

// ---------- Widgets ----------
const widgets = {};

function mountWidgets() {
  // Perso (life utility) — order matters: most-used first
  widgets.gas         = new GasWidget(document.querySelector('[data-widget="gas"]'));
  widgets.weatherCard = new WeatherCard(document.querySelector('[data-widget="weatherCard"]'));
  widgets.air         = new AirQualityWidget(document.querySelector('[data-widget="air"]'));

  // Pro
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

// Trains auto-refresh every 90s while open
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
initCollapsibleCards();
initSettings();
