import { ICONS } from './modules/icons.js';
import { formatDateLong, haptic } from './modules/util.js';
import { getSettings, updateSettings, importData, buildSyncPayload } from './modules/state.js';
import { startupReconcile } from './modules/sync.js';
import { escapeHTML } from './modules/util.js';
import { HomeWidget } from './modules/home.js';
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
import { searchMemory, reindexMemory, lastIndexedAt } from './modules/memory.js';

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
}

// ---------- Tabs ----------
const VISIBLE_TABS = ['home', 'perso', 'trains', 'pro', 'projets'];
const TAB_LABELS = { home: 'Accueil', perso: 'Perso', trains: 'Trains', pro: 'Pro', projets: 'Projets', settings: 'Réglages' };
let prevTabBeforeSettings = null;

function setActiveTab(name, opts = {}) {
  if (name === 'settings') {
    const cur = getSettings().activeTab;
    if (cur && cur !== 'settings') prevTabBeforeSettings = cur;
  }
  document.querySelectorAll('.tabbar-btn').forEach(b => {
    b.classList.toggle('tabbar-btn--active', b.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
  });
  document.body.classList.toggle('on-settings', name === 'settings');

  document.getElementById('pageSection').textContent = TAB_LABELS[name] || '';
  updateSettings({ activeTab: name });
  // Instant scroll so the swipe / tap feels immediate; smooth scroll
  // sometimes finishes ~half a second after the swipe and reads as a
  // delayed shift.
  window.scrollTo(0, 0);
  if (name === 'projets') refreshProjectStats();
  if (name === 'trains')  prioritizeTrainsByLocation();
  if (name === 'home' && widgets.home) widgets.home.refresh();
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
    });
  });

  // Gear icon in the header opens settings (which no longer lives in the tabbar)
  const cog = document.getElementById('headerCog');
  if (cog) {
    cog.addEventListener('click', () => {
      haptic(4);
      if (getSettings().activeTab === 'settings') {
        setActiveTab(prevTabBeforeSettings || 'home');
      } else {
        setActiveTab('settings');
      }
    });
  }

  // App opens on Accueil, unless a push notification deep-links to a tab
  // (?goto=trains|pro|…).
  const params = new URLSearchParams(location.search);
  const goto = params.get('goto');
  setActiveTab(VISIBLE_TABS.includes(goto) ? goto : 'home');

  // A medication reminder deep-links into the health project on a dose
  // (?project=health&dose=midi) — open it after the shell settles.
  if (params.get('project') === 'health') {
    const dose = params.get('dose') || undefined;
    setTimeout(() => openProject('health', { dose }), 200);
  }
}

// Route a notification URL (carrying ?goto / ?project / ?dose) without reload.
function routeNotificationUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, location.href);
    const tab = u.searchParams.get('goto');
    if (VISIBLE_TABS.includes(tab)) setActiveTab(tab);
    if (u.searchParams.get('project') === 'health') {
      const dose = u.searchParams.get('dose') || undefined;
      openProject('health', { dose });
    }
  } catch {}
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
  widgets.home         = new HomeWidget(document.querySelector('[data-widget="home"]'));
}

// ---------- Swipe navigation between tabs ----------
function initSwipeNavigation() {
  const SWIPE_X_MIN = 70;
  const SWIPE_RATIO = 1.6;
  const MAX_DURATION = 600;
  let start = null;
  let cancelled = false;
  let swipeJustFired = 0;

  // Only block swipe when the touch originates inside something that
  // legitimately needs horizontal interaction or its own scroll behaviour.
  // Buttons / anchors / cards are fine — a tap stays a tap (dx stays small),
  // a swipe becomes a swipe (dx grows).
  const isSwipeBlocker = (el) => {
    if (!el) return false;
    return !!el.closest('input, textarea, select, [data-no-swipe]');
  };

  document.addEventListener('touchstart', (e) => {
    cancelled = false;
    if (e.touches.length !== 1) { cancelled = true; return; }
    if (document.body.classList.contains('project-open')) { cancelled = true; return; }
    if (isSwipeBlocker(e.target)) { cancelled = true; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!start || cancelled) return;
    const t = e.touches[0];
    const dy = Math.abs(t.clientY - start.y);
    const dx = Math.abs(t.clientX - start.x);
    if (dy > 24 && dy > dx) cancelled = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!start || cancelled) { start = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Date.now() - start.time;
    start = null;
    if (dt > MAX_DURATION) return;
    if (Math.abs(dx) < SWIPE_X_MIN) return;
    if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;

    const cur = getSettings().activeTab;
    if (cur === 'settings') return;
    const idx = VISIBLE_TABS.indexOf(cur);
    if (idx === -1) return;
    const newIdx = dx > 0 ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= VISIBLE_TABS.length) return;

    document.body.classList.remove('swipe-prev', 'swipe-next');
    document.body.classList.add(dx > 0 ? 'swipe-prev' : 'swipe-next');
    swipeJustFired = Date.now();
    haptic(3);
    setActiveTab(VISIBLE_TABS[newIdx]);
    // Drop the swipe class exactly when the slide finishes — a timer can
    // remove it early/late and a base animation would then restart.
    const pane = document.querySelector('.pane:not([hidden])');
    const clear = () => document.body.classList.remove('swipe-prev', 'swipe-next');
    if (pane) pane.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 600);   // safety net if animationend never fires
  }, { passive: true });

  // Absorb the SINGLE synthesized click that fires on whatever was under
  // the finger when a swipe completed. One-shot: a deliberate fast tap
  // right after a swipe must keep working.
  document.addEventListener('click', (e) => {
    if (swipeJustFired && Date.now() - swipeJustFired < 350) {
      swipeJustFired = 0;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
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

// Live train auto-refresh — force fresh SIRI data so the displayed
// minute counts never run on a stale 60 s cache.
setInterval(() => {
  if (!document.hidden) {
    try { widgets.trainsAller?.refresh(true); } catch {}
    try { widgets.trainsRetour?.refresh(true); } catch {}
  }
}, 60 * 1000);

// Re-apply theme when system color scheme changes (auto mode)
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if ((getSettings().theme || 'auto') === 'auto') applyTheme();
});

// ---------- Projets overlay ----------
function openProject(name, opts = {}) {
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
    // A medication reminder deep-links to a specific dose (?dose=midi) so the
    // health app opens straight onto it and marks it taken.
    const doseParam = opts.dose ? `&dose=${encodeURIComponent(opts.dose)}` : '';
    inner.innerHTML = `
      <div class="project-shell">
        <div class="project-bar">
          <button class="project-bar__back" type="button" data-close>← Bob</button>
          <span class="project-bar__title">Suivi santé</span>
          <button class="project-bar__action" type="button" data-action="analyze" aria-label="Analyse">${ICONS.lightbulb}</button>
        </div>
        <iframe class="project-frame" src="../health-tracker/?theme=${encodeURIComponent(currentTheme)}${doseParam}&_v=${cacheBust}" allow="vibrate"></iframe>
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
    new WriterApp(document.getElementById('writerHost'), { onExit: close, openChapterId: opts.openChapterId });
    overlay.hidden = false;
    document.body.classList.add('project-open');
    return;
  }

  if (name === 'memory') {
    inner.innerHTML = `
      <div class="project-shell">
        <div class="project-bar">
          <button class="project-bar__back" type="button" data-close>← Bob</button>
          <span class="project-bar__title">Mémoire</span>
          <button class="project-bar__action" type="button" data-action="reindex" aria-label="Ré-indexer">${ICONS.refresh}</button>
        </div>
        <div class="memory">
          <div class="memory__search">
            <span class="memory__search-icon" aria-hidden="true">${ICONS.search}</span>
            <input class="memory__input" type="search" inputmode="search" enterkeyhint="search"
                   placeholder="Cherche par le sens…" autocomplete="off" data-mem-input data-no-swipe>
          </div>
          <div class="memory__filters" data-mem-filters>
            <button class="memory__chip memory__chip--active" type="button" data-mem-type="">Tout</button>
            <button class="memory__chip" type="button" data-mem-type="chapter">Chapitres</button>
            <button class="memory__chip" type="button" data-mem-type="health">Journal</button>
          </div>
          <div class="memory__status" data-mem-status></div>
          <div class="memory__results" data-mem-results></div>
        </div>
      </div>
    `;
    inner.querySelector('[data-close]').addEventListener('click', close);
    overlay.hidden = false;
    document.body.classList.add('project-open');
    initMemory(inner, close);
    setTimeout(() => inner.querySelector('[data-mem-input]')?.focus(), 280);
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
    const events = Array.isArray(data?.events) ? data.events : [];
    const days = Object.keys(entries);
    const totalSlots = days.reduce((sum, d) => sum + Object.keys(entries[d] || {}).length, 0);
    const total = totalSlots + events.length;
    if (total === 0) {
      setStat('health', 'Aucune entrée', null);
    } else {
      const [sy, sm, sd] = (data?.startDate || '2026-05-14').split('-').map(Number);
      const startDate = new Date(sy, sm - 1, sd);   // local midnight, not UTC
      const today = new Date(); today.setHours(0,0,0,0);
      const dayN = Math.max(1, Math.floor((today - startDate) / 86400000) + 1);
      const totalPeriod = 31;
      const label = dayN <= totalPeriod
        ? `Jour ${dayN} / ${totalPeriod}`
        : `J+${dayN - totalPeriod} post-traitement`;
      setStat('health', label, `${total} entrées`);
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

// ---------- Mémoire (semantic search) ----------
function initMemory(scope, close) {
  const input = scope.querySelector('[data-mem-input]');
  const statusEl = scope.querySelector('[data-mem-status]');
  const resultsEl = scope.querySelector('[data-mem-results]');
  const filters = scope.querySelector('[data-mem-filters]');
  let activeType = '';
  let lastQuery = '';
  let searchToken = 0;

  const typeLabel = { chapter: 'Chapitre', health: 'Journal' };

  const render = (results) => {
    if (!results.length) {
      resultsEl.innerHTML = '<div class="memory__empty">Aucun passage proche. Reformule, ou ré-indexe (↻) si tu viens d\'écrire.</div>';
      return;
    }
    resultsEl.innerHTML = results.map(r => `
      <button class="memory-hit" type="button" data-hit-type="${r.type}" data-hit-ref="${escapeHTML(r.ref || '')}">
        <div class="memory-hit__head">
          <span class="memory-hit__kind memory-hit__kind--${r.type}">${typeLabel[r.type] || 'Note'}</span>
          ${r.title ? `<span class="memory-hit__title">${escapeHTML(r.title)}</span>` : ''}
          ${r.dateLabel ? `<span class="memory-hit__date">${escapeHTML(r.dateLabel)}</span>` : ''}
          <span class="memory-hit__score">${Math.round(r.score * 100)}%</span>
        </div>
        <div class="memory-hit__snippet">${escapeHTML(r.snippet)}</div>
      </button>
    `).join('');
  };

  const run = async () => {
    const q = input.value.trim();
    lastQuery = q;
    if (q.length < 2) { resultsEl.innerHTML = ''; statusEl.textContent = ''; return; }
    const mine = ++searchToken;
    statusEl.textContent = 'Recherche…';
    try {
      const results = await searchMemory(q, activeType || undefined);
      if (mine !== searchToken) return;   // a newer search superseded this one
      statusEl.textContent = results.length ? `${results.length} passage${results.length > 1 ? 's' : ''}` : '';
      render(results);
    } catch (e) {
      if (mine !== searchToken) return;
      statusEl.textContent = 'Erreur : ' + (e.message || e);
    }
  };

  const runDebounced = (() => {
    let t = null;
    return () => { clearTimeout(t); t = setTimeout(run, 350); };
  })();

  input.addEventListener('input', runDebounced);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-mem-type]');
    if (!chip) return;
    haptic(4);
    activeType = chip.dataset.memType;
    filters.querySelectorAll('.memory__chip').forEach(c =>
      c.classList.toggle('memory__chip--active', c === chip));
    if (lastQuery) run();
  });

  resultsEl.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-hit-type]');
    if (!hit) return;
    haptic(6);
    const type = hit.dataset.hitType;
    const ref = hit.dataset.hitRef;
    close();
    if (type === 'chapter') openProject('writer', { openChapterId: ref });
    else if (type === 'health') openProject('health');
  });

  // Reindex on open (background) so freshly-written text is searchable, and
  // on the manual ↻ button.
  const doReindex = async (manual) => {
    statusEl.textContent = manual ? 'Indexation…' : statusEl.textContent;
    try {
      const n = await reindexMemory();
      if (manual) {
        statusEl.textContent = `Indexé · ${n} passages`;
        setTimeout(() => { if (!lastQuery) statusEl.textContent = ''; }, 2500);
      }
    } catch (e) {
      if (manual) statusEl.textContent = 'Indexation échouée : ' + (e.message || e);
    }
  };
  scope.querySelector('[data-action="reindex"]').addEventListener('click', () => { haptic(4); doReindex(true); });
  // Auto-reindex if it's been a while (or never).
  if (Date.now() - lastIndexedAt() > 5 * 60 * 1000) doReindex(false);
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
  let events = [];
  try {
    const raw = localStorage.getItem('health-tracker-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      entries = parsed?.entries || {};
      events = Array.isArray(parsed?.events) ? parsed.events : [];
    }
  } catch {}

  if (!Object.keys(entries).length && !events.length) {
    body.innerHTML = '<p class="insights-panel__placeholder">Aucune entrée à analyser pour l\'instant.</p>';
    return;
  }

  body.innerHTML = '<p class="insights-panel__placeholder">Analyse en cours…</p>';
  let acc = '';
  try {
    await analyzeHealth({
      entries,
      events,
      onChunk: (delta) => {
        acc += delta;
        body.innerHTML = tinyMarkdown(acc);
      },
    });
  } catch (e) {
    body.innerHTML = `<p class="insights-panel__placeholder" style="color:var(--danger)">Échec : ${escapeHTML(e.message || String(e))}</p>`;
  }
}

// ---------- Init ----------
applyTheme();
renderHeader();
mountWidgets();
initTabs();
initSettings();
initProjects();
initSwipeNavigation();

// Project cards on the Home page send a custom event — route it through openProject.
document.addEventListener('bob-open-project', (e) => {
  const name = e.detail?.project;
  if (name === 'health' || name === 'writer' || name === 'beiue' || name === 'memory') openProject(name);
});

// Home tiles navigate to their related tab.
document.addEventListener('bob-goto-tab', (e) => {
  const tab = e.detail?.tab;
  if (VISIBLE_TABS.includes(tab)) setActiveTab(tab);
});

// Keep the Worker's monitoring config in sync with the current settings
// (IDFM key, alert toggles, stop coords). Fire-and-forget on startup.
pushMonitoring();

// Auto-reconcile with the cloud — always push pending local edits FIRST,
// then pull only if remote is strictly newer. A shared in-flight gate +
// 60 s throttle prevents the startup pass and a focus event from racing
// each other into double pulls / double reloads.
let lastReconcileAt = 0;
let reconcileInFlight = null;
function reconcile({ throttle = true } = {}) {
  if (reconcileInFlight) return reconcileInFlight;
  if (throttle && Date.now() - lastReconcileAt < 60_000) return Promise.resolve();
  lastReconcileAt = Date.now();
  reconcileInFlight = (async () => {
    try {
      const result = await startupReconcile(buildSyncPayload);
      if (result?.state) {
        importData(JSON.stringify(result.state));
        location.reload();
      }
    } catch {} finally {
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}
reconcile({ throttle: false });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reconcile();
});
window.addEventListener('focus', () => reconcile());

// ---------- Service worker registration (moved from inline script for CSP) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
  // A notification tap on an already-open Bob posts the target URL here —
  // route the ?goto= tab without a reload.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'notification-clicked') return;
    routeNotificationUrl(e.data.url);
  });
}
