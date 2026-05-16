import { ICONS } from './modules/icons.js';
import { formatDateLong, haptic } from './modules/util.js';
import { getSettings, updateSettings } from './modules/state.js';
import { renderHeaderWeather } from './modules/weather.js';
import { TrainsWidget } from './modules/trains.js';
import { AiWatchWidget } from './modules/aiwatch.js';
import { LinksWidget } from './modules/links.js';
import { CaptureWidget } from './modules/capture.js';
import { TodosWidget } from './modules/todos.js';
import { HabitsWidget } from './modules/habits.js';
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
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      haptic(4);
      setActiveTab(t.dataset.tab);
    });
  });

  // Default tab: pro if before 14h or no preference
  const hour = new Date().getHours();
  const saved = getSettings().activeTab;
  const defaultTab = (hour < 14 || hour >= 20) ? 'pro' : (saved || 'perso');
  setActiveTab(saved || defaultTab);
}

// ---------- Widgets ----------
const widgets = {};

function mountWidgets() {
  // Pro pane
  widgets.trainsAller = new TrainsWidget(
    document.querySelector('[data-widget="trains-aller"]'),
    'aller'
  );
  widgets.trainsRetour = new TrainsWidget(
    document.querySelector('[data-widget="trains-retour"]'),
    'retour'
  );
  widgets.aiwatch = new AiWatchWidget(
    document.querySelector('[data-widget="aiwatch"]')
  );
  widgets.links = new LinksWidget(
    document.querySelector('[data-widget="links"]')
  );

  // Perso pane
  widgets.capture = new CaptureWidget(
    document.querySelector('[data-widget="capture"]')
  );
  widgets.todos = new TodosWidget(
    document.querySelector('[data-widget="todos"]')
  );
  widgets.habits = new HabitsWidget(
    document.querySelector('[data-widget="habits"]')
  );
}

// ---------- Settings ----------
function initSettings() {
  const panel = new SettingsPanel(
    document.getElementById('settingsBody'),
    () => {
      // re-render widgets that depend on settings
      try { widgets.links?.refresh(); } catch {}
      try { widgets.trainsAller?.refresh(); } catch {}
      try { widgets.trainsRetour?.refresh(); } catch {}
      try { widgets.aiwatch?.refresh(); } catch {}
      try { widgets.habits?.render(); } catch {}
      // also refresh weather (location might've changed)
      renderHeader();
    }
  );

  document.getElementById('settingsBtn').addEventListener('click', () => {
    haptic(4);
    panel.open();
  });
  document.getElementById('settingsClose').addEventListener('click', () => panel.close());
  document.getElementById('settingsBackdrop').addEventListener('click', (e) => {
    // Close on backdrop click (not on the modal itself)
    if (e.target === e.currentTarget) panel.close();
  });

  // Allow widget cards to open settings (via [data-open-settings])
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
  try { widgets.trainsAller?.refresh(); } catch {}
  try { widgets.trainsRetour?.refresh(); } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshLiveData();
});

window.addEventListener('focus', refreshLiveData);

// Periodic train refresh (every 2 min while open)
setInterval(() => {
  if (!document.hidden) {
    try { widgets.trainsAller?.refresh(); } catch {}
    try { widgets.trainsRetour?.refresh(); } catch {}
  }
}, 120 * 1000);

// ---------- Init ----------
renderHeader();
mountWidgets();
initTabs();
initSettings();
