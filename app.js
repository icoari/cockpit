import { ICONS } from './modules/icons.js';
import { formatDateLong, haptic } from './modules/util.js';
import { getSettings, updateSettings } from './modules/state.js';
import { renderHeaderWeather } from './modules/weather.js';
import { TrainsWidget } from './modules/trains.js';
import { LastTrainWidget } from './modules/lastTrain.js';
import { FeedWidget } from './modules/aiwatch.js';
import { YoutubeWidget } from './modules/youtube.js';
import { HackerNewsWidget } from './modules/hackernews.js';
import { GasWidget } from './modules/gas.js';
import { WeatherCard } from './modules/weatherCard.js';
import { AirQualityWidget } from './modules/airquality.js';
import { CalendarWidget } from './modules/calendar.js';
import { BinsWidget } from './modules/bins.js';
import { PharmaciesWidget } from './modules/pharmacies.js';
import { SettingsPanel } from './modules/settings.js';
import { WriterApp } from './modules/writer.js';

// ---------- Theme ----------
function applyTheme() {
  const t = getSettings().theme || 'auto';
  document.body.classList.remove('theme-light', 'theme-dark');
  if (t === 'light') {
    document.body.classList.add('theme-light');
  } else if (t === 'dark') {
    document.body.classList.add('theme-dark');
  } else {
    // auto: rely on prefers-color-scheme
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.body.classList.add('theme-light');
    } else {
      document.body.classList.add('theme-dark');
    }
  }
}

// ---------- Page header ----------
function renderHeader() {
  document.getElementById('dateLabel').textContent = formatDateLong(new Date());
  renderHeaderWeather(
    document.getElementById('weatherIcon'),
    null,
    null,
    document.getElementById('weatherTemp'),
  );
}

// ---------- Tabs ----------
const TAB_LABELS = { perso: 'Perso', trains: 'Trains', pro: 'Pro', projets: 'Projets', settings: 'Réglages' };

function setActiveTab(name) {
  document.querySelectorAll('.tabbar-btn').forEach(b => {
    b.classList.toggle('tabbar-btn--active', b.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
  });
  // Page header: hide on settings (settings has its own implicit header via sections)
  const header = document.querySelector('[data-page-header]');
  if (header) header.hidden = (name === 'settings');

  document.getElementById('pageSection').textContent = TAB_LABELS[name] || '';
  updateSettings({ activeTab: name });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initTabs() {
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
  widgets.weatherCard = new WeatherCard(document.querySelector('[data-widget="weatherCard"]'));
  widgets.calendar    = new CalendarWidget(document.querySelector('[data-widget="calendar"]'));
  widgets.gas         = new GasWidget(document.querySelector('[data-widget="gas"]'));
  widgets.pharmacies  = new PharmaciesWidget(document.querySelector('[data-widget="pharmacies"]'));
  widgets.bins        = new BinsWidget(document.querySelector('[data-widget="bins"]'));
  widgets.air         = new AirQualityWidget(document.querySelector('[data-widget="air"]'));

  widgets.trainsAller  = new TrainsWidget(document.querySelector('[data-widget="trains-aller"]'), 'aller');
  widgets.trainsRetour = new TrainsWidget(document.querySelector('[data-widget="trains-retour"]'), 'retour');
  widgets.lastTrain    = new LastTrainWidget(document.querySelector('[data-widget="last-train"]'));
  widgets.youtube      = new YoutubeWidget(document.querySelector('[data-widget="youtube"]'));
  widgets.hackernews   = new HackerNewsWidget(document.querySelector('[data-widget="hackernews"]'));
  widgets.techwatch    = new FeedWidget(document.querySelector('[data-widget="techwatch"]'), { category: 'tech', title: 'Veille tech' });
}

// ---------- Settings ----------
let settingsPanel = null;
function initSettings() {
  settingsPanel = new SettingsPanel(
    document.getElementById('settingsBody'),
    () => {
      // After any settings change, refresh affected pieces
      applyTheme();
      Object.values(widgets).forEach(w => {
        if (typeof w.refresh === 'function') {
          try { w.refresh(); } catch {}
        }
      });
      renderHeader();
    }
  );

  // Weather chip → open settings tab
  document.getElementById('weatherMini').addEventListener('click', () => {
    haptic(4);
    setActiveTab('settings');
  });

  // Any element marked [data-open-settings] opens the settings tab
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-settings]')) {
      e.preventDefault();
      setActiveTab('settings');
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

// Live train auto-refresh every 90 s
setInterval(() => {
  if (!document.hidden) {
    try { widgets.trainsAller?.refresh(); } catch {}
    try { widgets.trainsRetour?.refresh(); } catch {}
  }
}, 60 * 1000);

// Re-apply theme when system color scheme changes (auto mode)
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if ((getSettings().theme || 'auto') === 'auto') applyTheme();
});

// ---------- Projets overlay ----------
function openProject(name) {
  const overlay = document.getElementById('projectOverlay');
  const inner = document.getElementById('projectOverlayInner');
  if (!overlay || !inner) return;

  const close = () => {
    overlay.hidden = true;
    inner.innerHTML = '';
    document.body.classList.remove('project-open');
  };

  if (name === 'health') {
    inner.innerHTML = `
      <div class="project-shell">
        <div class="project-bar">
          <button class="project-bar__back" type="button" data-close>← Bob</button>
          <span class="project-bar__title">Suivi santé</span>
        </div>
        <iframe class="project-frame" src="../health-tracker/" allow="vibrate"></iframe>
      </div>
    `;
    inner.querySelector('[data-close]').addEventListener('click', close);
    overlay.hidden = false;
    document.body.classList.add('project-open');
    return;
  }

  if (name === 'writer') {
    inner.innerHTML = `<div class="project-shell project-shell--writer" id="writerHost"></div>`;
    new WriterApp(document.getElementById('writerHost'), { onExit: close });
    overlay.hidden = false;
    document.body.classList.add('project-open');
    return;
  }
}

function initProjects() {
  document.body.addEventListener('click', (e) => {
    const card = e.target.closest('[data-project]');
    if (card) {
      haptic(6);
      openProject(card.dataset.project);
    }
  });
}

// ---------- Init ----------
applyTheme();
renderHeader();
mountWidgets();
initTabs();
initSettings();
initProjects();

// ---------- Service worker registration (moved from inline script for CSP) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
