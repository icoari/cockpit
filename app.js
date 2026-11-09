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
import { CalendarWidget, runEventDictation } from './modules/calendar.js';
import { BinsWidget } from './modules/bins.js';
import { PharmaciesWidget } from './modules/pharmacies.js';
import { SettingsPanel } from './modules/settings.js';
import { WriterApp } from './modules/writer.js';
import { ProWidget } from './modules/pro.js';
import { pushMonitoring } from './modules/notifications.js';
import { TrackersWidget } from './modules/trackers.js';
import { addNote, removeNote, notesByCategory, categorizeNote, recap } from './modules/memory.js';
import { VoiceRecorder, voiceSupported } from './modules/voice.js';

// ---------- Theme ----------
// The class lives on <html> so the page background (visible under the iOS
// status bar and during overscroll) follows the theme too.
function applyTheme() {
  const t = getSettings().theme || 'auto';
  const dark = t === 'dark' || (t === 'auto' && !window.matchMedia('(prefers-color-scheme: light)').matches);
  for (const el of [document.documentElement, document.body]) {
    el.classList.toggle('theme-dark', dark);
    el.classList.toggle('theme-light', !dark);
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { if (bg) m.content = bg; });
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
  document.querySelector('.app')?.scrollTo(0, 0);
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

  // Consume the params: a sync pull triggers location.reload(), which would
  // otherwise replay them and force the tab back on every pull.
  if (location.search) history.replaceState(null, '', location.pathname);
}

// Route a notification URL (carrying ?goto) without reload.
function routeNotificationUrl(rawUrl) {
  try {
    const u = new URL(rawUrl, location.href);
    const tab = u.searchParams.get('goto');
    if (VISIBLE_TABS.includes(tab)) setActiveTab(tab);
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
// minute counts never run on a stale 60 s cache. Only while the Trains tab
// is the one on screen (the Accueil tile polls separately).
setInterval(() => {
  if (!document.hidden && getSettings().activeTab === 'trains') {
    try { widgets.trainsAller?.refresh(true); } catch {}
    try { widgets.trainsRetour?.refresh(true); } catch {}
  }
}, 60 * 1000);

// Re-apply theme when system color scheme changes (auto mode)
window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if ((getSettings().theme || 'auto') === 'auto') applyTheme();
});

// ---------- Projets overlay ----------
// Shared chrome for every full-screen project: back to Bob, centred title,
// optional action on the right.
function projectBar(title, action = '') {
  return `
    <div class="project-bar">
      <button class="project-bar__back" type="button" data-close>${ICONS.chevronLeft}<span>Bob</span></button>
      <span class="project-bar__title">${escapeHTML(title)}</span>
      ${action}
    </div>`;
}

// Sibling apps embedded as-is. NY English Coach lives on its own Worker
// origin: inside the frame its storage is partitioned, so the bar also
// offers to open it in its own tab.
const FRAME_PROJECTS = {
  piano:   { title: 'Piano',            src: '../piano/' },
  nycoach: { title: 'NY English Coach', src: 'https://ny-english-coach.jz7w76ry59.workers.dev/', external: true },
};

// Mounts `html` in the overlay and returns { inner, close }. `onClose` runs
// before the DOM is wiped (e.g. to stop a live mic recording).
function showOverlay(html) {
  const overlay = document.getElementById('projectOverlay');
  const inner = document.getElementById('projectOverlayInner');
  const cleanup = { fn: null };
  const close = () => {
    try { cleanup.fn?.(); } catch {}
    cleanup.fn = null;
    overlay.hidden = true;
    inner.innerHTML = '';
    document.body.classList.remove('project-open');
  };
  inner.innerHTML = html;
  inner.querySelector('[data-close]')?.addEventListener('click', close);
  overlay.hidden = false;
  document.body.classList.add('project-open');
  return { inner, close, cleanup };
}

function openProject(name, opts = {}) {
  if (!document.getElementById('projectOverlay')) return;

  const frame = FRAME_PROJECTS[name];
  if (frame) {
    const action = frame.external
      ? `<a class="project-bar__action" href="${frame.src}" target="_blank" rel="noopener" aria-label="Ouvrir à part">${ICONS.external}</a>`
      : '';
    showOverlay(`
      <div class="project-shell">
        ${projectBar(frame.title, action)}
        <iframe class="project-frame" src="${frame.src}" loading="eager" allow="microphone; autoplay; screen-wake-lock"></iframe>
      </div>
    `);
    return;
  }

  if (name === 'writer') {
    const { close } = showOverlay(`<div class="project-shell project-shell--writer" id="writerHost"></div>`);
    new WriterApp(document.getElementById('writerHost'), { onExit: close });
    return;
  }

  if (name === 'memory') {
    const { inner, cleanup } = showOverlay(`
      <div class="project-shell">
        ${projectBar('Mémoire')}
        <div class="notes">
          <div class="notes__bar">
            ${voiceSupported() ? `<button class="notes__action notes__action--voice" type="button" data-notes="voice">${ICONS.mic}<span>Note vocale</span></button>` : ''}
            ${voiceSupported() ? `<button class="notes__action" type="button" data-notes="recap">${ICONS.brain}<span>Récap</span></button>` : ''}
          </div>
          <form class="notes__add" data-notes-add>
            <input class="notes__input" type="text" placeholder="Écrire une note…" data-notes-input data-no-swipe autocomplete="off">
            <button class="notes__add-btn" type="submit" aria-label="Ajouter">${ICONS.plus}</button>
          </form>
          <div class="notes__status" data-notes-status></div>
          <div class="notes__panel" data-notes-panel hidden></div>
          <div class="notes__list" data-notes-list></div>
        </div>
      </div>
    `);
    cleanup.fn = initNotes(inner);
    return;
  }

  if (name === 'beiue') {
    const { inner } = showOverlay(`
      <div class="project-shell">
        ${projectBar('BEIUE')}
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
    `);

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

  // Mémoire — note count
  try {
    const raw = localStorage.getItem('bob-notes-v1');
    const notes = raw ? (JSON.parse(raw).notes || []) : [];
    setStat('memory', notes.length ? 'Notes' : 'Aucune note', notes.length ? `${notes.length}` : null);
  } catch { setStat('memory', 'Notes', null); }

  // Piano — saved transcriptions (v2 storage; the v1 lessons are gone)
  try {
    const p = JSON.parse(localStorage.getItem('piano-v2-data') || 'null');
    const scores = p?.scores;
    const n = Array.isArray(scores) ? scores.length : Object.keys(scores || {}).length;
    setStat('piano', n ? 'Partitions' : 'Aucune partition', n ? `${n}` : null);
  } catch { setStat('piano', 'Aucune partition', null); }

  // BEIUE is a launcher — no live stats
}

// ---------- Mémoire (voice-first notes) ----------
function initNotes(scope) {
  const statusEl = scope.querySelector('[data-notes-status]');
  const panel = scope.querySelector('[data-notes-panel]');
  const listEl = scope.querySelector('[data-notes-list]');
  const addForm = scope.querySelector('[data-notes-add]');
  const input = scope.querySelector('[data-notes-input]');
  let rec = null;

  const setStatus = (t) => { statusEl.textContent = t || ''; };
  const showPanel = (html) => { panel.hidden = false; panel.innerHTML = html; };
  const hidePanel = () => { panel.hidden = true; panel.innerHTML = ''; };
  const working = (t) => `<div class="cv-working"><span class="cv-spin"></span>${escapeHTML(t)}</div>`;

  function renderList() {
    const map = notesByCategory();
    if (map.size === 0) {
      listEl.innerHTML = '<div class="notes__empty">Aucune note. Dicte-en une, ou écris-la ci-dessus.</div>';
      return;
    }
    let html = '';
    for (const [cat, arr] of map) {
      html += `<div class="notes-cat">
        <div class="notes-cat__head">${escapeHTML(cat)}<span class="notes-cat__count">${arr.length}</span></div>
        ${arr.map(n => `<div class="note"><span class="note__text">${escapeHTML(n.text)}</span><button class="note__del" data-note-del="${n.id}" type="button" aria-label="Supprimer">${ICONS.trash}</button></div>`).join('')}
      </div>`;
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('[data-note-del]').forEach(b => b.addEventListener('click', () => {
      haptic(8); removeNote(b.dataset.noteDel); renderList();
    }));
  }

  // Record → transcribe, then hand the text to `onText`. Renders its own
  // record/stop/working UI in the panel.
  async function captureVoice(label, onText) {
    // Cancel any previous recorder first — tapping « Note vocale » then
    // « Récap » must not leave the first one recording with no stop button.
    if (rec) { try { rec.cancel(); } catch {} rec = null; }
    try { rec = new VoiceRecorder(); await rec.start(); }
    catch (e) { showPanel(`<div class="notes__err">Micro refusé : ${escapeHTML(e.message || '')}</div>`); return; }
    showPanel(`<button class="cv-rec" type="button" data-stop>${ICONS.mic}<span>${escapeHTML(label)}, tape pour arrêter</span></button>`);
    panel.querySelector('[data-stop]').addEventListener('click', async () => {
      haptic(8);
      showPanel(working('Transcription…'));
      let text;
      try { text = await rec.stopAndTranscribe(); }
      catch (e) { showPanel(`<div class="notes__err">Transcription : ${escapeHTML(e.message || '')}</div>`); return; }
      if (!text) { hidePanel(); return; }
      onText(text);
    });
  }

  function voiceNote() {
    captureVoice('Dis ta note', async (text) => {
      showPanel(working('Rangement…'));
      const { text: clean, category } = await categorizeNote(text);
      showPanel(`
        <div class="note-edit">
          <textarea class="note-edit__text" data-ne-text rows="3">${escapeHTML(clean)}</textarea>
          <div class="note-edit__row">
            <input class="note-edit__cat" data-ne-cat value="${escapeHTML(category)}" placeholder="Catégorie">
            <button class="btn btn--ghost" type="button" data-ne-cancel>Annuler</button>
            <button class="btn" type="button" data-ne-save>Enregistrer</button>
          </div>
        </div>`);
      panel.querySelector('[data-ne-cancel]').addEventListener('click', hidePanel);
      panel.querySelector('[data-ne-save]').addEventListener('click', () => {
        const t = panel.querySelector('[data-ne-text]').value.trim();
        const c = panel.querySelector('[data-ne-cat]').value.trim() || 'Divers';
        if (t) { addNote(t, c); haptic(12); }
        hidePanel(); renderList();
      });
    });
  }

  function recapFlow() {
    captureVoice('Pose ta question', async (question) => {
      showPanel(working('Récap…'));
      let ans;
      try { ans = await recap(question); }
      catch (e) { showPanel(`<div class="notes__err">${escapeHTML(e.message || 'échec')}</div>`); return; }
      showPanel(`<div class="notes__recap">
        <div class="notes__recap-q">« ${escapeHTML(question)} »</div>
        <div class="notes__recap-a">${tinyMarkdown(ans)}</div>
        <button class="btn btn--ghost" type="button" data-recap-close>Fermer</button>
      </div>`);
      panel.querySelector('[data-recap-close]').addEventListener('click', hidePanel);
    });
  }

  scope.querySelector('[data-notes="voice"]')?.addEventListener('click', () => { haptic(6); voiceNote(); });
  scope.querySelector('[data-notes="recap"]')?.addEventListener('click', () => { haptic(6); recapFlow(); });

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    setStatus('Rangement…');
    try { const { text, category } = await categorizeNote(v); addNote(text, category); }
    catch { addNote(v, 'Divers'); }
    setStatus('');
    renderList();
  });

  renderList();

  // Cleanup for the overlay close — stop a live recording before DOM wipe.
  return () => { if (rec) { try { rec.cancel(); } catch {} rec = null; } };
}

function tinyMarkdown(s) {
  let html = escapeHTML(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/((?:^|\n)(?:- [^\n]+\n?)+)/g, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^- /, '')).map(li => `<li>${li}</li>`).join('');
    return `\n<ul>${items}</ul>\n`;
  });
  html = html.replace(/\n{2,}/g, '</p><p>');
  return `<p>${html}</p>`;
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
  if (name === 'writer' || name === 'beiue' || name === 'memory' || name in FRAME_PROJECTS) {
    openProject(name);
  }
});

// Home tiles navigate to their related tab.
document.addEventListener('bob-goto-tab', (e) => {
  const tab = e.detail?.tab;
  if (VISIBLE_TABS.includes(tab)) setActiveTab(tab);
});

// "Dicter un event" → a dedicated dictation overlay that auto-starts. Opened
// straight from the tap (gesture preserved → mic works without re-prompt).
function openEventDictation() {
  if (!document.getElementById('projectOverlay')) return;
  const { close, cleanup } = showOverlay(`
    <div class="project-shell">
      ${projectBar('Dicter un événement')}
      <div class="dictate-host" id="dictateHost"></div>
    </div>`);
  cleanup.fn = runEventDictation(document.getElementById('dictateHost'), {
    onClose: close,
    onCreated: () => { try { widgets.calendar?.refresh(); } catch {} },
  });
}
document.addEventListener('bob-dicter-event', openEventDictation);

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
      // applyState returns false on failure so sync retries the pull next
      // time instead of marking the remote version as seen.
      const result = await startupReconcile(buildSyncPayload, (state) => {
        try { importData(JSON.stringify(state)); return true; }
        catch (e) { console.warn('[sync] import failed', e); return false; }
      });
      if (result?.applied) location.reload();
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
