import {
  getSettings, save,
  addAiSource, toggleAiSource, removeAiSource,
  addYoutubeChannel, toggleYoutubeChannel, removeYoutubeChannel,
  addEncombrantDate, removeEncombrantDate,
  exportData, importData, resetAll, buildSyncPayload,
} from './state.js';
import { ENCOMBRANTS_PATTERNS } from './bins.js';
import { escapeHTML } from './util.js';
import {
  isSyncEnabled, getSyncMeta, setupSync, unlockSync,
  disableSyncLocally, wipeRemote, pullNow, pushNow, schedulePush, WORKER_URL,
  getSyncAuthHeader,
} from './sync.js';
import { ping as llmPing } from './llm.js';
import {
  supportsPush, permissionStatus, subscribePush, unsubscribePush,
  isSubscribed, sendTestPush, pushMonitoring,
} from './notifications.js';

const ICONS_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export class SettingsPanel {
  constructor(rootEl, onChange) {
    this.root = rootEl;
    this.onChange = onChange || (() => {});
    this.open = new Set();   // which accordion sections are expanded
    this.render();
  }

  // One collapsible section: header (title + live summary + chevron) and a
  // body that only exists in the layout when expanded.
  section(id, title, summary, bodyHtml) {
    const isOpen = this.open.has(id);
    return `
      <div class="acc ${isOpen ? 'acc--open' : ''}" data-acc="${id}">
        <button class="acc__head" type="button" data-acc-head="${id}">
          <span class="acc__title">${escapeHTML(title)}</span>
          <span class="acc__summary">${summary}</span>
          <span class="acc__chevron">${ICONS_CHEVRON}</span>
        </button>
        <div class="acc__body" ${isOpen ? '' : 'hidden'}>${bodyHtml}</div>
      </div>
    `;
  }

  groupLabel(text) {
    return `<div class="settings-group">${escapeHTML(text)}</div>`;
  }

  // Refresh the live counters in the accordion headers without re-rendering
  // (so checkbox toggling keeps focus + scroll position).
  updateCounts() {
    const s = getSettings();
    const setSummary = (id, text) => {
      const el = this.root.querySelector(`[data-acc="${id}"] .acc__summary`);
      if (el) el.textContent = text;
    };
    const rssOn = s.aiSources.filter(x => x.enabled).length;
    const ytOn = (s.youtube?.channels || []).filter(c => c.enabled).length;
    setSummary('rss', `${rssOn} active${rssOn > 1 ? 's' : ''} / ${s.aiSources.length}`);
    setSummary('youtube', `${ytOn} active${ytOn > 1 ? 's' : ''} / ${(s.youtube?.channels || []).length}`);
  }

  render() {
    const s = getSettings();
    const themeLabel = s.theme === 'dark' ? 'Sombre' : s.theme === 'light' ? 'Clair' : 'Auto';
    const rssOn = s.aiSources.filter(x => x.enabled).length;
    const ytOn = (s.youtube?.channels || []).filter(c => c.enabled).length;
    const alertsOn = [s.alerts?.trainAlerts !== false, s.alerts?.morningBrief !== false, !!s.alerts?.healthReminder].filter(Boolean).length;
    const ok = (label) => `<span class="acc__summary--ok">${escapeHTML(label)}</span>`;
    const dim = (label) => escapeHTML(label);

    this.root.innerHTML = `
      ${this.groupLabel('Général')}

      ${this.section('theme', 'Apparence', dim(themeLabel), `
        <div class="theme-row" data-theme-row>
          ${['auto', 'dark', 'light'].map(t => `
            <button class="theme-btn ${s.theme === t ? 'theme-btn--active' : ''}" data-theme="${t}" type="button">
              ${t === 'auto' ? 'Auto' : t === 'dark' ? 'Sombre' : 'Clair'}
            </button>
          `).join('')}
        </div>
      `)}

      ${this.section('location', 'Localisation', s.location?.name ? dim(s.location.name) : dim('non configurée'), `
        <div class="settings-section__desc">Position par défaut, utilisée si la géolocalisation est refusée.</div>
        <input class="input" type="text" placeholder="Nom" data-field="locName" value="${escapeHTML(s.location.name || '')}">
        <input class="input" type="number" step="0.001" placeholder="Latitude" data-field="locLat" value="${s.location.lat ?? ''}">
        <input class="input" type="number" step="0.001" placeholder="Longitude" data-field="locLon" value="${s.location.lon ?? ''}">
      `)}

      ${this.section('notifs', 'Notifications', alertsOn ? ok(`${alertsOn} alerte${alertsOn > 1 ? 's' : ''}`) : dim('inactives'), `
        <div class="settings-section__desc">
          Push iOS via Web Push. <strong>Bob doit être sur l'écran d'accueil</strong> pour fonctionner sur iPhone.
        </div>
        <div id="pushStatus" class="settings-info" style="margin:0 0 10px;padding:8px 12px;font-size:12px">Chargement…</div>
        <div class="btn-row" style="margin-bottom:10px">
          <button class="btn" type="button" data-action="push-enable">Activer</button>
          <button class="btn btn--ghost" type="button" data-action="push-test">Tester</button>
          <button class="btn btn--danger" type="button" data-action="push-disable">Désactiver</button>
        </div>
        <div class="btn-row" style="margin-bottom:14px">
          <button class="btn btn--ghost" type="button" data-action="check-trains-now">Vérifier les trains ce soir</button>
        </div>
        <label class="label-row" style="display:block;margin-top:6px">
          <input type="checkbox" data-field="alertTrains" ${s.alerts?.trainAlerts !== false ? 'checked' : ''}>
          Alertes perturbations IDFM (J, RER A)
        </label>
        <label class="label-row" style="display:block">
          <input type="checkbox" data-field="alertBrief" ${s.alerts?.morningBrief !== false ? 'checked' : ''}>
          Brief matinal (7h)
        </label>
        <label class="label-row" style="display:block">
          <input type="checkbox" data-field="alertHealth" ${s.alerts?.healthReminder ? 'checked' : ''}>
          Rappel Suivi santé soir (23h)
        </label>
      `)}

      ${this.groupLabel('Services')}

      ${this.section('idfm', 'Trains — clé IDFM', s.idfm.apiKey ? ok('configurée') : dim('manquante'), `
        <div class="settings-section__desc">
          Inscription gratuite sur <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>.
        </div>
        <input class="input" type="password" placeholder="apikey IDFM…" data-field="idfmKey" value="${escapeHTML(s.idfm.apiKey)}">
      `)}

      ${this.section('calendar', 'Agenda Google', s.calendar?.token ? ok('connecté') : (s.calendar?.clientId ? dim('non connecté') : dim('non configuré')), `
        <div class="settings-section__desc">
          Projet sur <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> →
          API Calendar → OAuth Client ID « Application Web » avec l'origine <code>${escapeHTML(location.origin)}</code>.
        </div>
        <input class="input" type="text" placeholder="OAuth Client ID Google" data-field="calendarClientId" value="${escapeHTML(s.calendar?.clientId || '')}">
        <input class="input" type="text" placeholder="ID du calendrier (défaut : primary)" data-field="calendarId" value="${escapeHTML(s.calendar?.calendarId || 'primary')}">
        ${s.calendar?.token ? `<div class="settings-info">✓ Connecté · <button class="link-btn" type="button" data-action="cal-disconnect">se déconnecter</button></div>` : ''}
      `)}

      ${this.section('llm', 'Assistant IA', s.llm?.enabled && s.llm?.apiKey ? ok(s.llm.model || 'activé') : dim('désactivé'), `
        <div class="settings-section__desc">
          Endpoint compatible OpenAI ou Anthropic, via ton Worker.
          Azure Foundry Anthropic : URL <code>…/anthropic/v1/messages?api-version=…</code>, format Anthropic, auth api-key.
        </div>
        <input class="input" type="url" placeholder="https://…/v1/messages ou /chat/completions" data-field="llmEndpoint" value="${escapeHTML(s.llm?.endpoint || '')}" autocomplete="off" spellcheck="false">
        <input class="input" type="password" placeholder="API key" data-field="llmApiKey" value="${escapeHTML(s.llm?.apiKey || '')}" autocomplete="off" spellcheck="false">
        <input class="input" type="text" placeholder="Modèle (ex. claude-sonnet-4-5)" data-field="llmModel" value="${escapeHTML(s.llm?.model || '')}" autocomplete="off">
        <div class="settings-2col">
          <select class="input" data-field="llmFormat">
            <option value="openai"    ${(s.llm?.format || 'openai') === 'openai' ? 'selected' : ''}>OpenAI</option>
            <option value="anthropic" ${s.llm?.format === 'anthropic' ? 'selected' : ''}>Anthropic</option>
          </select>
          <select class="input" data-field="llmAuthStyle">
            <option value="bearer" ${s.llm?.authStyle !== 'azure' ? 'selected' : ''}>Bearer</option>
            <option value="azure"  ${s.llm?.authStyle === 'azure' ? 'selected' : ''}>api-key (Azure)</option>
          </select>
        </div>
        <label class="label-row" style="display:block;margin-top:10px">
          <input type="checkbox" data-field="llmEnabled" ${s.llm?.enabled ? 'checked' : ''}>
          Activer l'assistant
        </label>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn--ghost" type="button" data-action="llm-ping">Tester</button>
          <span class="settings-info" data-llm-status style="margin:0;padding:8px 12px;font-size:12px"></span>
        </div>
      `)}

      ${this.groupLabel('Veille')}

      ${this.section('rss', 'Sources articles', dim(`${rssOn} active${rssOn > 1 ? 's' : ''} / ${s.aiSources.length}`), `
        <div class="crud-list crud-list--compact">
          ${s.aiSources.map(src => `
            <label class="crud-item crud-item--compact">
              <input type="checkbox" data-toggle-ai="${src.id}" ${src.enabled ? 'checked' : ''}>
              <span class="crud-item__name">${escapeHTML(src.name)}${src.lang === 'fr' ? ' <small class="crud-item__lang">FR</small>' : ''}</span>
              <button class="crud-item__action" data-remove-ai="${src.id}" type="button" aria-label="Supprimer ${escapeHTML(src.name)}">×</button>
            </label>
          `).join('')}
        </div>
        <div class="btn-row" style="margin-top:10px">
          <input class="input" type="text" placeholder="Nom" data-new-ai-name style="flex:1;margin:0">
          <input class="input" type="url" placeholder="URL RSS" data-new-ai-url style="flex:2;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-ai">Ajouter</button>
        </div>
      `)}

      ${this.section('youtube', 'Chaînes YouTube', dim(`${ytOn} active${ytOn > 1 ? 's' : ''} / ${(s.youtube?.channels || []).length}`), `
        <div class="crud-list crud-list--compact">
          ${(s.youtube?.channels || []).map(c => `
            <label class="crud-item crud-item--compact">
              <input type="checkbox" data-toggle-yt="${c.id}" ${c.enabled ? 'checked' : ''}>
              <span class="crud-item__name">${escapeHTML(c.name)}${c.lang === 'fr' ? ' <small class="crud-item__lang">FR</small>' : ''}</span>
              <button class="crud-item__action" data-remove-yt="${c.id}" type="button" aria-label="Supprimer ${escapeHTML(c.name)}">×</button>
            </label>
          `).join('')}
        </div>
        <div class="settings-section__desc" style="margin-top:10px">Channel ID : commence par <code>UC</code>, visible dans le code source de la chaîne.</div>
        <div class="btn-row">
          <input class="input" type="text" placeholder="Nom" data-new-yt-name style="flex:1;margin:0">
          <input class="input" type="text" placeholder="UC…" data-new-yt-id style="flex:1;margin:0">
          <select class="input" data-new-yt-lang style="flex:0 0 72px;margin:0">
            <option value="en">EN</option>
            <option value="fr">FR</option>
          </select>
          <button class="btn btn--ghost" type="button" data-action="add-yt">Ajouter</button>
        </div>
      `)}

      ${this.groupLabel('Widgets')}

      ${this.section('bins', 'Encombrants', s.encombrants?.address ? dim(s.encombrants.address) : dim('—'), `
        <input class="input" type="text" placeholder="Adresse" data-field="encombrantsAddress" value="${escapeHTML(s.encombrants?.address || '')}">
        <select class="input" data-field="encombrantsPattern">
          ${Object.entries(ENCOMBRANTS_PATTERNS).map(([key, p]) => `
            <option value="${key}" ${s.encombrants?.pattern === key ? 'selected' : ''}>${escapeHTML(p.label)}</option>
          `).join('')}
        </select>
        <label class="label-row" style="display:block;margin-top:12px">Dates exceptionnelles</label>
        <div class="crud-list crud-list--compact">
          ${(s.encombrants?.extraDates || []).map(d => `
            <div class="crud-item crud-item--compact">
              <span class="crud-item__name">${escapeHTML(new Date(d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span>
              <button class="crud-item__action" data-remove-bin="${escapeHTML(d)}" type="button" aria-label="Supprimer">×</button>
            </div>
          `).join('') || '<div class="card__empty" style="padding:4px 0">Aucune date.</div>'}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <input class="input" type="date" data-new-bin-date style="flex:1;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-bin">Ajouter</button>
        </div>
      `)}

      ${this.section('gas', 'Stations essence', dim(`${s.gas.radiusKm} km`), `
        <label class="label-row" style="display:block">Rayon de recherche (km)</label>
        <input class="input" type="number" min="1" max="50" data-field="gasRadius" value="${s.gas.radiusKm}">
      `)}

      ${this.groupLabel('Données')}

      ${this.section('sync', 'Sauvegarde cloud', isSyncEnabled() ? ok('activée') : dim('inactive'), `
        <div class="settings-section__desc">
          Chiffrée end-to-end sur Cloudflare. Sans la passphrase, les données sont irrécupérables.
        </div>
        ${this.renderSyncBlock()}
      `)}

      ${this.section('local', 'Export local', dim('JSON'), `
        <div class="btn-row">
          <button class="btn btn--ghost" type="button" data-action="export">Exporter JSON</button>
          <button class="btn btn--ghost" type="button" data-action="import">Importer JSON</button>
          <button class="btn btn--danger" type="button" data-action="reset">Réinitialiser</button>
        </div>
        <input type="file" accept=".json,application/json" data-import-file style="display:none">
      `)}
    `;

    this.attach();
  }

  attach() {
    // All listeners are delegated on this.root, which survives re-renders —
    // attach exactly once or every re-render stacks another full set
    // (N passphrase prompts, N imports, N pushMonitoring calls…).
    if (this.listenersAttached) { this.refreshPushStatus(); return; }
    this.listenersAttached = true;

    this.root.addEventListener('change', (e) => {
      const el = e.target.closest('[data-field]');
      if (!el) return;
        const settings = getSettings();
        const v = el.type === 'checkbox' ? el.checked : el.value;
        if (!settings.llm) settings.llm = { enabled: false, endpoint: '', apiKey: '', model: '', authStyle: 'bearer', format: 'openai' };
        switch (el.dataset.field) {
          case 'idfmKey':            settings.idfm.apiKey = v.trim(); pushMonitoring(); break;
          case 'calendarClientId':   settings.calendar.clientId = v.trim(); break;
          case 'calendarId':         settings.calendar.calendarId = v.trim() || 'primary'; break;
          case 'locName':            settings.location.name = v.trim(); break;
          case 'locLat': { const f = parseFloat(v); settings.location.lat = Number.isFinite(f) ? f : null; break; }
          case 'locLon': { const f = parseFloat(v); settings.location.lon = Number.isFinite(f) ? f : null; break; }
          case 'gasRadius':          settings.gas.radiusKm = Math.max(1, parseInt(v, 10) || 8); break;
          case 'encombrantsAddress': settings.encombrants.address = v.trim(); break;
          case 'encombrantsPattern': settings.encombrants.pattern = v; break;
          case 'llmEndpoint':        settings.llm.endpoint = v.trim(); break;
          case 'llmApiKey':          settings.llm.apiKey = v.trim(); break;
          case 'llmModel':           settings.llm.model = v.trim(); break;
          case 'llmAuthStyle':       settings.llm.authStyle = v; break;
          case 'llmFormat':          settings.llm.format = v; break;
          case 'llmEnabled':         settings.llm.enabled = !!v; break;
          case 'alertTrains':        (settings.alerts = settings.alerts || {}).trainAlerts = !!v; pushMonitoring(); break;
          case 'alertBrief':         (settings.alerts = settings.alerts || {}).morningBrief = !!v; pushMonitoring(); break;
          case 'alertHealth':        (settings.alerts = settings.alerts || {}).healthReminder = !!v; pushMonitoring(); break;
        }
        save();
        this.onChange();
    });

    this.root.addEventListener('click', async (e) => {
      // Accordion toggle — flip the DOM in place, no re-render (a re-render
      // would lose input focus mid-typing in another section).
      const accHead = e.target.closest('[data-acc-head]');
      if (accHead) {
        e.preventDefault();
        const id = accHead.dataset.accHead;
        const acc = accHead.closest('.acc');
        const body = acc?.querySelector('.acc__body');
        if (!acc || !body) return;
        if (this.open.has(id)) {
          this.open.delete(id);
          acc.classList.remove('acc--open');
          body.hidden = true;
        } else {
          this.open.add(id);
          acc.classList.add('acc--open');
          body.hidden = false;
        }
        return;
      }

      const themeBtn = e.target.closest('[data-theme]');
      if (themeBtn) {
        getSettings().theme = themeBtn.dataset.theme;
        save();
        this.render();
        this.onChange();
        return;
      }

      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add-ai') {
        const name = this.root.querySelector('[data-new-ai-name]').value.trim();
        const url = this.root.querySelector('[data-new-ai-url]').value.trim();
        if (name && url) { addAiSource(name, url); this.render(); this.onChange(); }
        return;
      }
      if (action === 'add-yt') {
        const name = this.root.querySelector('[data-new-yt-name]').value.trim();
        const cid  = this.root.querySelector('[data-new-yt-id]').value.trim();
        const lang = this.root.querySelector('[data-new-yt-lang]').value;
        if (name && cid) { addYoutubeChannel(name, cid, lang); this.render(); this.onChange(); }
        return;
      }
      if (action === 'add-bin') {
        const date = this.root.querySelector('[data-new-bin-date]').value;
        if (date) { addEncombrantDate(date); this.render(); this.onChange(); }
        return;
      }
      if (action === 'cal-disconnect') {
        getSettings().calendar.token = null;
        save();
        this.render();
        this.onChange();
        return;
      }
      if (action === 'export') {
        const blob = new Blob([exportData()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cockpit-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 500);
        return;
      }
      if (action === 'import') {
        this.root.querySelector('[data-import-file]').click();
        return;
      }
      if (action === 'reset') {
        // Wipes local state, chapters, health journal AND notes — and the
        // wiped state then syncs to the cloud. Never one tap.
        if (!confirm('Tout réinitialiser ? Réglages, chapitres, journal santé et notes seront effacés (et la sauvegarde cloud sera écrasée).')) return;
        resetAll();
        this.render();
        this.onChange();
        return;
      }
      if (action === 'push-enable') {
        const statusEl = this.root.querySelector('#pushStatus');
        statusEl.textContent = 'Demande en cours…';
        try {
          await subscribePush();
          await pushMonitoring();
          statusEl.textContent = '✓ Notifications activées sur cet appareil.';
          statusEl.style.color = 'var(--accent)';
        } catch (err) {
          statusEl.textContent = 'Échec : ' + (err.message || err);
          statusEl.style.color = 'var(--danger)';
        }
        return;
      }
      if (action === 'push-disable') {
        const statusEl = this.root.querySelector('#pushStatus');
        await unsubscribePush();
        statusEl.textContent = 'Notifications désactivées.';
        statusEl.style.color = '';
        return;
      }
      if (action === 'check-trains-now') {
        const statusEl = this.root.querySelector('#pushStatus');
        statusEl.textContent = 'Vérification ce soir + perturbations en cours…';
        statusEl.style.color = '';
        try {
          await pushMonitoring();
          const auth = getSyncAuthHeader() || {};
          const [r1, r2] = await Promise.all([
            fetch(`${WORKER_URL}/cron/run?task=last-trains`, { method: 'POST', headers: auth }),
            fetch(`${WORKER_URL}/cron/run?task=disruptions`, { method: 'POST', headers: auth }),
          ]);
          if (r1.ok && r2.ok) {
            statusEl.textContent = '✓ Vérifié. S\'il y a quelque chose à signaler, une notif arrive.';
            statusEl.style.color = 'var(--accent)';
          } else {
            statusEl.textContent = `Erreur HTTP ${r1.status}/${r2.status}`;
            statusEl.style.color = 'var(--danger)';
          }
        } catch (err) {
          statusEl.textContent = 'Échec : ' + (err.message || err);
          statusEl.style.color = 'var(--danger)';
        }
        return;
      }
      if (action === 'push-test') {
        const statusEl = this.root.querySelector('#pushStatus');
        statusEl.textContent = 'Envoi du test…';
        try {
          await sendTestPush();
          statusEl.textContent = '✓ Test envoyé. La notification doit apparaître d\'ici quelques secondes.';
          statusEl.style.color = 'var(--accent)';
        } catch (err) {
          statusEl.textContent = 'Échec : ' + (err.message || err);
          statusEl.style.color = 'var(--danger)';
        }
        return;
      }
      if (action === 'llm-ping') {
        const statusEl = this.root.querySelector('[data-llm-status]');
        statusEl.textContent = 'Test en cours…';
        statusEl.style.color = '';
        try {
          const out = await llmPing();
          statusEl.textContent = '✓ Réponse : ' + (out || '').slice(0, 60);
          statusEl.style.color = 'var(--accent)';
        } catch (err) {
          statusEl.textContent = 'Échec : ' + (err.message || err);
          statusEl.style.color = 'var(--danger)';
        }
        return;
      }
      // preventDefault: the remove buttons sit inside <label> rows — without
      // it the label activation would also toggle the row's checkbox.
      const removeAiId = e.target.closest('[data-remove-ai]')?.dataset.removeAi;
      if (removeAiId) { e.preventDefault(); removeAiSource(removeAiId); this.render(); this.onChange(); return; }

      const removeYtId = e.target.closest('[data-remove-yt]')?.dataset.removeYt;
      if (removeYtId) { e.preventDefault(); removeYoutubeChannel(removeYtId); this.render(); this.onChange(); return; }

      const removeBinDate = e.target.closest('[data-remove-bin]')?.dataset.removeBin;
      if (removeBinDate) { e.preventDefault(); removeEncombrantDate(removeBinDate); this.render(); this.onChange(); return; }
    });

    this.root.addEventListener('change', (e) => {
      const tgl = e.target.closest('[data-toggle-ai]');
      if (tgl) { toggleAiSource(tgl.dataset.toggleAi); this.updateCounts(); this.onChange(); return; }

      const ytTgl = e.target.closest('[data-toggle-yt]');
      if (ytTgl) { toggleYoutubeChannel(ytTgl.dataset.toggleYt); this.updateCounts(); this.onChange(); return; }

      const file = e.target.closest('[data-import-file]');
      if (file && file.files[0]) {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            importData(reader.result);
            location.reload();
          } catch (err) {
            alert('Échec de l\'import : ' + (err.message || err));
          }
        };
        reader.onerror = () => alert('Lecture du fichier échouée');
        reader.readAsText(file.files[0]);
        file.value = '';
      }
    });

    this.attachSyncHandlers();
    this.refreshPushStatus();
  }

  async refreshPushStatus() {
    const el = this.root.querySelector('#pushStatus');
    if (!el) return;
    if (!supportsPush()) {
      el.textContent = 'Cet appareil ne supporte pas Web Push. Sur iPhone, ajoute Bob à l\'écran d\'accueil d\'abord.';
      return;
    }
    const perm = permissionStatus();
    const sub = await isSubscribed();
    if (sub && perm === 'granted')      el.textContent = '✓ Notifications actives sur cet appareil.';
    else if (perm === 'denied')         el.textContent = 'Permission refusée — autorise les notifications dans les réglages du navigateur.';
    else                                el.textContent = 'Notifications inactives — clique « Activer ».';
  }

  // ---------- Cloud sync (end-to-end encrypted) ----------

  renderSyncBlock() {
    if (isSyncEnabled()) {
      const meta = getSyncMeta() || {};
      const last = meta.lastPushedAt
        ? new Date(meta.lastPushedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : 'jamais';
      return `
        <div class="settings-info">✓ Activé sur cet appareil · dernière sync : ${escapeHTML(last)}</div>
        <div class="btn-row">
          <button class="btn" type="button" data-action="sync-now">Synchroniser maintenant</button>
          <button class="btn btn--ghost" type="button" data-action="sync-pull">Restaurer depuis le cloud</button>
          <button class="btn btn--ghost" type="button" data-action="sync-disable-local">Oublier sur cet appareil</button>
          <button class="btn btn--danger" type="button" data-action="sync-wipe">Effacer du cloud</button>
        </div>
      `;
    }
    return `
      <div class="btn-row">
        <button class="btn" type="button" data-action="sync-setup">Activer la sync</button>
        <button class="btn btn--ghost" type="button" data-action="sync-unlock">Restaurer depuis le cloud</button>
        <button class="btn btn--danger" type="button" data-action="sync-wipe-cold">Effacer la sauvegarde cloud</button>
      </div>
    `;
  }

  attachSyncHandlers() {
    this.root.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action || !action.startsWith('sync-')) return;
      e.preventDefault();
      e.stopPropagation();

      if (action === 'sync-setup') return this.runSetup();
      if (action === 'sync-unlock') return this.runUnlock();
      if (action === 'sync-pull') return this.runPull();
      if (action === 'sync-now') return this.runPushNow();
      if (action === 'sync-disable-local') return this.runDisableLocal();
      if (action === 'sync-wipe') return this.runWipe();
      if (action === 'sync-wipe-cold') return this.runWipeFromInit();
    });
  }

  async runSetup() {
    const pp = prompt('Choisis une passphrase forte (au moins 12 caractères). Note-la dans 1Password — sans elle les données sont irrécupérables.');
    if (!pp) return;
    if (pp.length < 12) { alert('Minimum 12 caractères.'); return; }
    const confirm2 = prompt('Re-tape la passphrase pour confirmer :');
    if (confirm2 !== pp) { alert('Les passphrases ne correspondent pas.'); return; }
    try {
      await setupSync(pp);
      // First push: send the current local state to the cloud immediately.
      schedulePush(buildSyncPayload);
      this.render();
      this.onChange();
    } catch (err) {
      alert('Activation échouée : ' + (err.message || err));
    }
  }

  async runUnlock() {
    const pp = prompt('Entre la passphrase utilisée à l\'activation :');
    if (!pp) return;
    try {
      const result = await unlockSync(pp);
      if (result && result.state) {
        importData(JSON.stringify(result.state));
        location.reload();
      } else {
        this.render();
        this.onChange();
      }
    } catch (err) {
      alert('Déverrouillage échoué : ' + (err.message || err));
    }
  }

  async runPushNow() {
    try {
      await pushNow(buildSyncPayload);
      this.render();
      this.onChange();
    } catch (err) {
      alert('Échec de la synchro : ' + (err.message || err));
    }
  }

  async runPull() {
    try {
      const result = await pullNow();
      if (!result || !result.state) return;
      importData(JSON.stringify(result.state));
      location.reload();
    } catch (err) {
      alert('Pull échoué : ' + (err.message || err));
    }
  }

  async runDisableLocal() {
    disableSyncLocally();
    this.render();
    this.onChange();
  }

  async runWipe() {
    if (!confirm('Effacer définitivement la sauvegarde cloud ? Cette action est irréversible.')) return;
    try {
      await wipeRemote();
      this.render();
      this.onChange();
    } catch (err) {
      alert('Wipe échoué : ' + (err.message || err));
    }
  }

  // Wipe from the un-activated state — needs the passphrase to authenticate
  // against the Worker, then wipes everything and clears local sync state.
  async runWipeFromInit() {
    const pp = prompt('Passphrase pour confirmer l\'effacement de la sauvegarde cloud :');
    if (!pp) return;
    try {
      await unlockSync(pp);
      await wipeRemote();
      this.render();
      this.onChange();
    } catch (err) {
      alert('Effacement échoué : ' + (err.message || err));
    }
  }
}
