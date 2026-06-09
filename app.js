import { ICONS } from './modules/icons.js';
import { formatDateLong, haptic } from './modules/util.js';
import { getSettings, updateSettings, importData, buildSyncPayload } from './modules/state.js';
import { startupReconcile, pullIfNewer } from './modules/sync.js';
import { renderHeaderWeather } from './modules/weather.js';
import { TrainsWidget } from './modules/trains.js';
import { LastTrainWidget } from './modules/lastTrain.js';
import { GasWidget } from './modules/gas.js';
import { WeatherCard } from './modules/weatherCard.js';
import { AirQualityWidget } from './modules/airquality.js';
import { CalendarWidget } from './modules/calendar.js';
import { BinsWidget } from './modules/bins.js';
import { PharmaciesWidget } from './modules/pharmacies.js';
import { SettingsPanel } from './modules/settings.js';
import { WriterApp } from './modules/writer.js';
import { ProWidget } from './modules/pro.js';
import { analyzeHealth } from './modules/insights.js';
import { pushMonitoring } from './modules/notifications.js';
import { TrackersWidget } from './modules/trackers.js';

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
  if (name === 'projets') refreshProjectStats();
  if (name === 'trains')  prioritizeTrainsByLocation();
}

// ---------- Trains ordering ----------
async function prioritizeTrainsByLocation() {
  document.body.classList.remove('loc-paris', 'loc-home');
  try {
    const { getPosition, distanceKm } = await import('./modules/geolocation.js');
    const pos = await getPosition({ timeout: 4500 });
    if (!pos) return;
    const stops = getSettings().idfm?.stopCoords || {
      paris: { lat: 48.8757, lon: 2.3247 },
      home:  { lat: 48.991156, lon: 2.074643 },
    };
    const dHome  = distanceKm(pos, stops.home);
    const dParis = distanceKm(pos, stops.paris);
    // Heuristic: clearly Paris vs clearly home, otherwise leave default order.
    if (dParis < 12 && dHome > 15) {
      document.body.classList.add('loc-paris');
    } else if (dHome < 6 && dParis > 25) {
      document.body.classList.add('loc-home');
    }
  } catch {}
}

function initTabs() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });

  document.querySelectorAll('.tabbar-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic(4);
      setActiveTab(btn.dataset.tab);
      // iOS ghost-click guard: after a fast tab switch, the synthesized click
      // from the same tap can land on a link in the freshly rendered pane.
      // Block pointer events on the content briefly to absorb it.
      const main = document.querySelector('.app');
      if (main) {
        main.style.pointerEvents = 'none';
        setTimeout(() => { main.style.pointerEvents = ''; }, 350);
      }
    });
  });

  const saved = getSettings().activeTab || 'perso';
  setActiveTab(saved);
}

// ---------- Widgets ----------
const widgets = {};
window.__bobWidgets = widgets;   // exposed so ProWidget can pull context from other widgets

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
  widgets.pro          = new ProWidget(document.querySelector('[data-widget="pro"]'));
  widgets.trackers     = new TrackersWidget(document.querySelector('[data-widget="trackers"]'));
}

// ---------- (legacy sub-tabs — replaced by ProWidget; left as a no-op stub) ----------
function initSubtabs() {
  const buttons = document.querySelectorAll('[data-subtabs] .subtab');
  if (!buttons.length) return;

  function setActive(name) {
    buttons.forEach(b => b.classList.toggle('subtab--active', b.dataset.subtab === name));
    document.querySelectorAll('[data-subtab-pane]').forEach(p => {
      p.hidden = p.dataset.subtabPane !== name;
    });
    updateSettings({ proSubtab: name });
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      haptic(4);
      setActive(btn.dataset.subtab);
    });
  });

  const saved = getSettings().proSubtab || 'videos';
  setActive(saved);
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
    const currentTheme = getSettings().theme || 'auto';
    const cacheBust = Date.now();
    inner.innerHTML = `
      <div class="project-shell">
        <div class="project-bar">
          <button class="project-bar__back" type="button" data-close>← Bob</button>
          <span class="project-bar__title">Suivi santé</span>
          <button class="project-bar__action" type="button" data-action="analyze" aria-label="Analyse">${ICONS.lightbulb}</button>
        </div>
        <iframe class="project-frame" src="../health-tracker/?theme=${encodeURIComponent(currentTheme)}&_v=${cacheBust}" allow="vibrate"></iframe>
        <div class="insights-overlay" hidden data-insights-overlay>
          <div class="insights-panel">
            <div class="insights-panel__head">
              <span class="insights-panel__title">Analyse · Suivi santé</span>
              <button class="insights-panel__close" type="button" data-action="close-analyze" aria-label="Fermer">${ICONS.close}</button>
            </div>
            <div class="insights-panel__body" data-insights-body>
              <p class="insights-panel__placeholder">Lecture du journal…</p>
            </div>
            <div class="insights-panel__foot">
              <span class="insights-panel__hint">Observations factuelles, aucun diagnostic.</span>
            </div>
          </div>
        </div>
      </div>
    `;
    inner.querySelector('[data-close]').addEventListener('click', close);
    inner.querySelector('[data-action="analyze"]').addEventListener('click', () => openHealthInsights(inner));
    inner.querySelector('[data-action="close-analyze"]').addEventListener('click', () => {
      inner.querySelector('[data-insights-overlay]').hidden = true;
    });
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

  if (name === 'beiue') {
    inner.innerHTML = `
      <div class="project-shell">
        <div class="project-bar">
          <button class="project-bar__back" type="button" data-close>← Bob</button>
          <span class="project-bar__title">BEIUE</span>
        </div>
        <div class="beiue-form">
          <p class="beiue-form__intro">Truth engine. Renseigne la cible, le moteur fait le reste.</p>
          <label class="beiue-field">
            <span class="beiue-field__label">Prénom</span>
            <input type="text" class="beiue-field__input" id="beiueName" placeholder="Marc" autocomplete="off" spellcheck="false">
          </label>
          <div class="beiue-field">
            <span class="beiue-field__label">Genre</span>
            <div class="beiue-segment" data-segment="gender" role="radiogroup">
              <button type="button" class="beiue-segment__opt beiue-segment__opt--active" data-value="m" role="radio" aria-checked="true">Masculin</button>
              <button type="button" class="beiue-segment__opt" data-value="f" role="radio" aria-checked="false">Féminin</button>
            </div>
          </div>
          <div class="beiue-field">
            <span class="beiue-field__label">Posture</span>
            <div class="beiue-segment" data-segment="kind" role="radiogroup">
              <button type="button" class="beiue-segment__opt beiue-segment__opt--active" data-value="0" role="radio" aria-checked="true">Pas gentil</button>
              <button type="button" class="beiue-segment__opt" data-value="1" role="radio" aria-checked="false">Gentil</button>
            </div>
          </div>
          <button type="button" class="beiue-launch" id="beiueLaunch" disabled>Lancer</button>
        </div>
      </div>
    `;
    inner.querySelector('[data-close]').addEventListener('click', close);

    const nameInput = inner.querySelector('#beiueName');
    const launchBtn = inner.querySelector('#beiueLaunch');
    let gender = 'm';
    let kind = '0';

    inner.querySelectorAll('[data-segment]').forEach(group => {
      group.addEventListener('click', (e) => {
        const opt = e.target.closest('.beiue-segment__opt');
        if (!opt) return;
        haptic(4);
        group.querySelectorAll('.beiue-segment__opt').forEach(b => {
          const active = b === opt;
          b.classList.toggle('beiue-segment__opt--active', active);
          b.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        if (group.dataset.segment === 'gender') gender = opt.dataset.value;
        else kind = opt.dataset.value;
      });
    });

    const syncEnabled = () => {
      launchBtn.disabled = !nameInput.value.trim();
    };
    nameInput.addEventListener('input', syncEnabled);

    launchBtn.addEventListener('click', () => {
      const n = nameInput.value.trim();
      if (!n) return;
      const params = new URLSearchParams();
      params.set('n', n);
      let qs = params.toString();
      if (gender === 'f') qs += '&f';
      if (kind === '1') qs += '&g';
      window.open(`https://icoari.github.io/BEIUE/?${qs}`, '_blank', 'noopener,noreferrer');
    });

    overlay.hidden = false;
    document.body.classList.add('project-open');
    setTimeout(() => nameInput.focus(), 280);
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
  refreshProjectStats();
  // Refresh stats every time the Projets tab becomes active.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshProjectStats();
  });
}

function refreshProjectStats() {
  const setStat = (key, label, value) => {
    const el = document.querySelector(`[data-project-stat="${key}"]`);
    if (!el) return;
    if (value === null || value === undefined) {
      el.textContent = label;
      return;
    }
    el.innerHTML = `${label} <span class="projet-card__stat-value">${value}</span>`;
  };

  // Suivi santé — read entries, compute filled-days / total + last entry age
  try {
    const raw = localStorage.getItem('health-tracker-v1');
    const data = raw ? JSON.parse(raw) : null;
    const entries = data?.entries || {};
    const days = Object.keys(entries);
    const totalSlots = days.reduce((sum, d) => sum + Object.keys(entries[d] || {}).length, 0);
    if (days.length === 0) {
      setStat('health', 'Aucune entrée', null);
    } else {
      const startDate = new Date(data?.startDate || '2026-05-14');
      const today = new Date(); today.setHours(0,0,0,0);
      const dayN = Math.max(1, Math.floor((today - startDate) / 86400000) + 1);
      const totalPeriod = 31;
      setStat('health', `Jour ${Math.min(dayN, totalPeriod)} / ${totalPeriod}`, `${totalSlots} entrées`);
    }
  } catch { setStat('health', 'Aucune entrée', null); }

  // Écrire — chapter count + total word count
  try {
    const raw = localStorage.getItem('bob-writer-v1');
    const data = raw ? JSON.parse(raw) : null;
    const chapters = data?.chapters || [];
    if (chapters.length === 0) {
      setStat('writer', 'Aucun chapitre', null);
    } else {
      const totalWords = chapters.reduce((s, c) => s + (c.content || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const formatted = totalWords >= 1000 ? (totalWords / 1000).toFixed(1).replace('.0', '') + 'k mots' : `${totalWords} mots`;
      setStat('writer', `${chapters.length} chapitre${chapters.length > 1 ? 's' : ''}`, formatted);
    }
  } catch { setStat('writer', 'Aucun chapitre', null); }

  // BEIUE is a launcher — no live stats
}

// ---------- Health insights panel (lives inside the Suivi santé project shell) ----------
function tinyMarkdown(s) {
  const escape = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/((?:^|\n)(?:- [^\n]+\n?)+)/g, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^- /, '')).map(li => `<li>${li}</li>`).join('');
    return `\n<ul>${items}</ul>\n`;
  });
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
}

async function openHealthInsights(scope) {
  const overlay = scope.querySelector('[data-insights-overlay]');
  const body = scope.querySelector('[data-insights-body]');
  overlay.hidden = false;
  body.innerHTML = '<p class="insights-panel__placeholder">Lecture du journal…</p>';

  let entries = {};
  try {
    const raw = localStorage.getItem('health-tracker-v1');
    if (raw) entries = (JSON.parse(raw)?.entries) || {};
  } catch {}

  if (!Object.keys(entries).length) {
    body.innerHTML = '<p class="insights-panel__placeholder">Aucune entrée à analyser pour l\'instant.</p>';
    return;
  }

  body.innerHTML = '<p class="insights-panel__placeholder">Analyse en cours…</p>';
  let acc = '';
  try {
    await analyzeHealth({
      entries,
      onChunk: (delta) => {
        acc += delta;
        body.innerHTML = tinyMarkdown(acc);
      },
    });
  } catch (e) {
    body.innerHTML = `<p class="insights-panel__placeholder" style="color:var(--danger)">Échec : ${e.message || e}</p>`;
  }
}

// ---------- Init ----------
applyTheme();
renderHeader();
mountWidgets();
initTabs();
initSubtabs();
initSettings();
initProjects();

// Keep the Worker's monitoring config in sync with the current settings
// (IDFM key, alert toggles, stop coords). Fire-and-forget on startup.
pushMonitoring();

// Auto-reconcile with the cloud — push any pending local edits, then pull
// if the remote blob is strictly newer than what we last sent. Re-checks
// every time the tab regains focus (throttled to once per minute).
let lastPullAt = 0;
async function reconcileNow() {
  if (Date.now() - lastPullAt < 60_000) return;
  lastPullAt = Date.now();
  try {
    const result = await pullIfNewer();
    if (result?.state) {
      importData(JSON.stringify(result.state));
      location.reload();
    }
  } catch {}
}
(async () => {
  try {
    const result = await startupReconcile(buildSyncPayload);
    if (result?.state) {
      importData(JSON.stringify(result.state));
      location.reload();
    }
  } catch {}
})();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reconcileNow();
});
window.addEventListener('focus', reconcileNow);

// ---------- Service worker registration (moved from inline script for CSP) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
