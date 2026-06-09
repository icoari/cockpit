import {
  getSettings, save,
  addAiSource, toggleAiSource, removeAiSource,
  addYoutubeChannel, toggleYoutubeChannel, removeYoutubeChannel,
  addEncombrantDate, removeEncombrantDate, setEncombrantPattern,
  exportData, importData, resetAll, buildSyncPayload,
} from './state.js';
import { ENCOMBRANTS_PATTERNS } from './bins.js';
import { escapeHTML } from './util.js';
import {
  isSyncEnabled, getSyncMeta, setupSync, unlockSync,
  disableSyncLocally, wipeRemote, pullNow, schedulePush,
} from './sync.js';
import { ping as llmPing } from './llm.js';
import { pushSources } from './feed.js';
import {
  supportsPush, permissionStatus, subscribePush, unsubscribePush,
  isSubscribed, sendTestPush, pushMonitoring,
} from './notifications.js';

export class SettingsPanel {
  constructor(rootEl, onChange) {
    this.root = rootEl;
    this.onChange = onChange || (() => {});
    this.render();
  }

  render() {
    const s = getSettings();
    const isLight = document.body.classList.contains('theme-light');

    this.root.innerHTML = `
      <div class="settings-section">
        <div class="settings-section__title">Apparence</div>
        <div class="theme-row" data-theme-row>
          ${['auto', 'dark', 'light'].map(t => `
            <button class="theme-btn ${s.theme === t ? 'theme-btn--active' : ''}" data-theme="${t}" type="button">
              ${t === 'auto' ? 'Auto' : t === 'dark' ? 'Sombre' : 'Clair'}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Clé API IDFM</div>
        <div class="settings-section__desc">
          Pour les trains. Inscription gratuite (3 min) sur
          <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>.
        </div>
        <input class="input" type="password" placeholder="apikey IDFM…" data-field="idfmKey" value="${escapeHTML(s.idfm.apiKey)}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Assistant</div>
        <div class="settings-section__desc">
          Transite par ton Worker Cloudflare (la sync doit être activée).
          Trois cas typiques :
          <br>· <strong>Azure AI Foundry · Anthropic</strong> — URL <code>…/anthropic/v1/messages?api-version=2024-05-01-preview</code>, format Anthropic, auth api-key
          <br>· <strong>Azure AI Foundry · OpenAI-compat</strong> — URL <code>…/models/chat/completions?api-version=2024-05-01-preview</code>, format OpenAI, auth api-key
          <br>· <strong>LiteLLM / OpenAI</strong> — URL <code>…/v1/chat/completions</code>, format OpenAI, auth Bearer
        </div>
        <input class="input" type="url" placeholder="https://…/v1/messages ou /chat/completions" data-field="llmEndpoint" value="${escapeHTML(s.llm?.endpoint || '')}" autocomplete="off" spellcheck="false">
        <input class="input" type="password" placeholder="API key" data-field="llmApiKey" value="${escapeHTML(s.llm?.apiKey || '')}" autocomplete="off" spellcheck="false">
        <input class="input" type="text" placeholder="Modèle (ex. claude-sonnet-4-5, gpt-4o)" data-field="llmModel" value="${escapeHTML(s.llm?.model || '')}" autocomplete="off">
        <label class="label-row" style="display:block;margin-top:6px">Format de l'API</label>
        <select class="input" data-field="llmFormat">
          <option value="openai"    ${(s.llm?.format || 'openai') === 'openai' ? 'selected' : ''}>OpenAI Chat Completions</option>
          <option value="anthropic" ${s.llm?.format === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option>
        </select>
        <label class="label-row" style="display:block;margin-top:6px">Authentification</label>
        <select class="input" data-field="llmAuthStyle">
          <option value="bearer" ${s.llm?.authStyle !== 'azure' ? 'selected' : ''}>Bearer (OpenAI / LiteLLM)</option>
          <option value="azure"  ${s.llm?.authStyle === 'azure' ? 'selected' : ''}>api-key (Azure)</option>
        </select>
        <label class="label-row" style="display:block;margin-top:10px">
          <input type="checkbox" data-field="llmEnabled" ${s.llm?.enabled ? 'checked' : ''}>
          Activer l'assistant
        </label>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn--ghost" type="button" data-action="llm-ping">Tester</button>
          <span class="settings-info" data-llm-status style="margin:0;padding:8px 12px;font-size:12px"></span>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Agenda Google</div>
        <div class="settings-section__desc">
          Crée un projet sur <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a>,
          active l'API Calendar, crée un identifiant <strong>OAuth Client ID</strong> de type "Application Web",
          et autorise l'origine <code>${escapeHTML(location.origin)}</code>. Colle le Client ID ci-dessous.
        </div>
        <input class="input" type="text" placeholder="OAuth Client ID Google" data-field="calendarClientId" value="${escapeHTML(s.calendar?.clientId || '')}">
        <input class="input" type="text" placeholder="ID du calendrier (par défaut : primary)" data-field="calendarId" value="${escapeHTML(s.calendar?.calendarId || 'primary')}">
        ${s.calendar?.token ? `<div class="settings-info">✓ Connecté à Google · <button class="link-btn" type="button" data-action="cal-disconnect">se déconnecter</button></div>` : ''}
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Encombrants${s.encombrants?.address ? ' — ' + escapeHTML(s.encombrants.address) : ''}</div>
        <div class="settings-section__desc">
          Calendrier de ramassage des encombrants. Choisis ton pattern + d'éventuelles dates exceptionnelles.
        </div>
        <input class="input" type="text" placeholder="Adresse" data-field="encombrantsAddress" value="${escapeHTML(s.encombrants?.address || '')}">
        <label class="label-row" style="display:block;margin-top:6px">Calendrier</label>
        <select class="input" data-field="encombrantsPattern">
          ${Object.entries(ENCOMBRANTS_PATTERNS).map(([key, p]) => `
            <option value="${key}" ${s.encombrants?.pattern === key ? 'selected' : ''}>${escapeHTML(p.label)}</option>
          `).join('')}
        </select>

        <label class="label-row" style="display:block;margin-top:14px">Dates supplémentaires (exceptions, vacances…)</label>
        <div class="crud-list">
          ${(s.encombrants?.extraDates || []).map(d => `
            <div class="crud-item">
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</span>
                <span class="crud-item__sub">${escapeHTML(d)}</span>
              </div>
              <button class="crud-item__action" data-remove-bin="${d}" type="button">supprimer</button>
            </div>
          `).join('') || '<div class="card__empty" style="padding:6px 0">Aucune date ajoutée.</div>'}
        </div>
        <div class="btn-row">
          <input class="input" type="date" data-new-bin-date style="flex:1;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-bin">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Localisation</div>
        <div class="settings-section__desc">Position par défaut. Utilisée si la géolocalisation est refusée.</div>
        <input class="input" type="text" placeholder="Nom" data-field="locName" value="${escapeHTML(s.location.name)}">
        <input class="input" type="number" step="0.001" placeholder="Latitude" data-field="locLat" value="${s.location.lat}">
        <input class="input" type="number" step="0.001" placeholder="Longitude" data-field="locLon" value="${s.location.lon}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Stations essence</div>
        <label class="label-row" style="display:block">Rayon de recherche (km)</label>
        <input class="input" type="number" min="1" max="50" data-field="gasRadius" value="${s.gas.radiusKm}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Chaînes YouTube</div>
        <div class="settings-section__desc">
          Tu trouves le Channel ID dans l'URL d'une chaîne (clique "voir le code source" et cherche "channelId").
          Format : commence par <code>UC</code> suivi de 22 caractères.
        </div>
        <div class="crud-list">
          ${(s.youtube?.channels || []).map(c => `
            <div class="crud-item">
              <label class="label-row" style="margin:0">
                <input type="checkbox" data-toggle-yt="${c.id}" ${c.enabled ? 'checked' : ''}>
              </label>
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(c.name)} ${c.lang === 'fr' ? '<small style="color:var(--accent);font-weight:600">FR</small>' : ''}</span>
                <span class="crud-item__sub">${escapeHTML(c.channelId)}</span>
              </div>
              <button class="crud-item__action" data-remove-yt="${c.id}" type="button">supprimer</button>
            </div>
          `).join('')}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <input class="input" type="text" placeholder="Nom de la chaîne" data-new-yt-name style="flex:1;margin:0">
          <input class="input" type="text" placeholder="Channel ID (UC…)" data-new-yt-id style="flex:1;margin:0">
          <select class="input" data-new-yt-lang style="flex:0 0 80px;margin:0">
            <option value="en">EN</option>
            <option value="fr">FR</option>
          </select>
          <button class="btn btn--ghost" type="button" data-action="add-yt">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Sources veille tech (RSS)</div>
        <div class="settings-section__desc">Active les sources de ton choix. Les flux RSS passent par rss2json (gratuit).</div>
        <div class="crud-list">
          ${s.aiSources.map(src => `
            <div class="crud-item">
              <label class="label-row" style="margin:0">
                <input type="checkbox" data-toggle-ai="${src.id}" ${src.enabled ? 'checked' : ''}>
              </label>
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(src.name)} ${src.lang === 'fr' ? '<small style="color:var(--accent);font-weight:600;letter-spacing:0.04em">FR</small>' : ''}</span>
                ${src.url ? `<span class="crud-item__sub">${escapeHTML(src.url)}</span>` : `<span class="crud-item__sub">${escapeHTML(src.type)}</span>`}
              </div>
              <button class="crud-item__action" data-remove-ai="${src.id}" type="button">supprimer</button>
            </div>
          `).join('')}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <input class="input" type="text" placeholder="Nom" data-new-ai-name style="flex:1;margin:0">
          <input class="input" type="url" placeholder="URL RSS" data-new-ai-url style="flex:2;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-ai">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Notifications</div>
        <div class="settings-section__desc">
          Push iOS via Web Push standard. <strong>Bob doit être ajouté à l'écran d'accueil</strong> pour que ça fonctionne sur iPhone.
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
          Alertes perturbations IDFM (lignes J, RER A)
        </label>
        <label class="label-row" style="display:block">
          <input type="checkbox" data-field="alertBrief" ${s.alerts?.morningBrief !== false ? 'checked' : ''}>
          Notification du brief matinal (7h)
        </label>
        <label class="label-row" style="display:block">
          <input type="checkbox" data-field="alertHealth" ${s.alerts?.healthReminder ? 'checked' : ''}>
          Rappel Suivi santé soir (23h)
        </label>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Sauvegarde cloud (chiffrée)</div>
        <div class="settings-section__desc">
          Sauvegarde end-to-end chiffrée sur Cloudflare. Sans la passphrase,
          les données sont irrécupérables — note-la dans 1Password.
        </div>
        ${this.renderSyncBlock()}
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Sauvegarde locale</div>
        <div class="btn-row">
          <button class="btn btn--ghost" type="button" data-action="export">Exporter JSON</button>
          <button class="btn btn--ghost" type="button" data-action="import">Importer JSON</button>
          <button class="btn btn--danger" type="button" data-action="reset">Réinitialiser</button>
        </div>
        <input type="file" accept=".json,application/json" data-import-file style="display:none">
      </div>
    `;

    this.attach();
  }

  attach() {
    this.root.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('change', () => {
        const settings = getSettings();
        const v = el.type === 'checkbox' ? el.checked : el.value;
        if (!settings.llm) settings.llm = { enabled: false, endpoint: '', apiKey: '', model: '', authStyle: 'bearer' };
        switch (el.dataset.field) {
          case 'idfmKey':            settings.idfm.apiKey = v.trim(); pushMonitoring(); break;
          case 'calendarClientId':   settings.calendar.clientId = v.trim(); break;
          case 'calendarId':         settings.calendar.calendarId = v.trim() || 'primary'; break;
          case 'locName':            settings.location.name = v.trim(); break;
          case 'locLat':             settings.location.lat = parseFloat(v) || 0; break;
          case 'locLon':             settings.location.lon = parseFloat(v) || 0; break;
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
    });

    this.root.addEventListener('click', async (e) => {
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
        if (confirm('Réinitialiser TOUT ?')) {
          resetAll();
          this.render();
          this.onChange();
        }
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
        if (!confirm('Désactiver les notifications sur cet appareil ?')) return;
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
          const auth = { 'Authorization': 'Bearer ' + (JSON.parse(localStorage.getItem('bob-sync-v1') || '{}').authToken || '') };
          const [r1, r2] = await Promise.all([
            fetch('https://bob.jz7w76ry59.workers.dev/cron/run?task=last-trains', { method: 'POST', headers: auth }),
            fetch('https://bob.jz7w76ry59.workers.dev/cron/run?task=disruptions', { method: 'POST', headers: auth }),
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
      const removeAiId = e.target.closest('[data-remove-ai]')?.dataset.removeAi;
      if (removeAiId) { removeAiSource(removeAiId); this.render(); this.onChange(); return; }

      const removeYtId = e.target.closest('[data-remove-yt]')?.dataset.removeYt;
      if (removeYtId) { removeYoutubeChannel(removeYtId); this.render(); this.onChange(); return; }

      const removeBinDate = e.target.closest('[data-remove-bin]')?.dataset.removeBin;
      if (removeBinDate) { removeEncombrantDate(removeBinDate); this.render(); this.onChange(); return; }
    });

    this.root.addEventListener('change', (e) => {
      const tgl = e.target.closest('[data-toggle-ai]');
      if (tgl) { toggleAiSource(tgl.dataset.toggleAi); this.onChange(); return; }

      const ytTgl = e.target.closest('[data-toggle-yt]');
      if (ytTgl) { toggleYoutubeChannel(ytTgl.dataset.toggleYt); this.onChange(); return; }

      const file = e.target.closest('[data-import-file]');
      if (file && file.files[0]) {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            importData(reader.result);
            alert('Import réussi. La page va se recharger.');
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
      if (action === 'sync-disable-local') return this.runDisableLocal();
      if (action === 'sync-wipe') return this.runWipe();
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
      alert('Sync activée. Tes données seront chiffrées et envoyées dans quelques secondes.');
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
        const ok = confirm('Sauvegarde trouvée. Restaurer ? La page se rechargera.');
        if (!ok) return;
        importData(JSON.stringify(result.state));
        location.reload();
      } else {
        alert('Sync activée. Aucune sauvegarde existante côté cloud pour le moment.');
        this.render();
        this.onChange();
      }
    } catch (err) {
      alert('Déverrouillage échoué : ' + (err.message || err));
    }
  }

  async runPull() {
    try {
      const result = await pullNow();
      if (!result || !result.state) { alert('Aucune sauvegarde côté cloud.'); return; }
      const ok = confirm('Remplacer les données locales par la sauvegarde cloud ? La page se rechargera.');
      if (!ok) return;
      importData(JSON.stringify(result.state));
      location.reload();
    } catch (err) {
      alert('Pull échoué : ' + (err.message || err));
    }
  }

  async runDisableLocal() {
    if (!confirm('Oublier les clés sur cet appareil ? Le cloud reste intact, tu pourras restaurer plus tard avec la passphrase.')) return;
    disableSyncLocally();
    this.render();
    this.onChange();
  }

  async runWipe() {
    if (!confirm('EFFACER TOUTES les données sur le cloud ? Action irréversible.')) return;
    try {
      await wipeRemote();
      alert('Sauvegarde cloud effacée.');
      this.render();
      this.onChange();
    } catch (err) {
      alert('Wipe échoué : ' + (err.message || err));
    }
  }
}
