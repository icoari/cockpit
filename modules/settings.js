import {
  getSettings, save,
  addAiSource, toggleAiSource, removeAiSource,
  addYoutubeChannel, toggleYoutubeChannel, removeYoutubeChannel,
  addEncombrantDate, removeEncombrantDate, setEncombrantPattern,
  exportData, importData, resetAll,
} from './state.js';
import { ENCOMBRANTS_PATTERNS } from './bins.js';
import { escapeHTML } from './util.js';

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
        <div class="settings-section__title">Encombrants — ${escapeHTML(s.encombrants?.address || 'adresse')}</div>
        <div class="settings-section__desc">
          À Conflans-Sainte-Honorine, le calendrier dépend du type de logement.
          Dépôt la veille à partir de 19h. Renseignements GPSEO : 01 30 33 90 00.
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
        <div class="settings-section__title">Sauvegarde</div>
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
        const v = el.value;
        switch (el.dataset.field) {
          case 'idfmKey':            settings.idfm.apiKey = v.trim(); break;
          case 'calendarClientId':   settings.calendar.clientId = v.trim(); break;
          case 'calendarId':         settings.calendar.calendarId = v.trim() || 'primary'; break;
          case 'locName':            settings.location.name = v.trim(); break;
          case 'locLat':             settings.location.lat = parseFloat(v) || 0; break;
          case 'locLon':             settings.location.lon = parseFloat(v) || 0; break;
          case 'gasRadius':          settings.gas.radiusKm = Math.max(1, parseInt(v, 10) || 8); break;
          case 'encombrantsAddress': settings.encombrants.address = v.trim(); break;
          case 'encombrantsPattern': settings.encombrants.pattern = v; break;
        }
        save();
        this.onChange();
      });
    });

    this.root.addEventListener('click', (e) => {
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
            this.render();
            this.onChange();
          } catch (err) {
            alert('Échec de l\'import : ' + err.message);
          }
        };
        reader.readAsText(file.files[0]);
      }
    });
  }
}
