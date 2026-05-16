import {
  getSettings, save,
  addAiSource, toggleAiSource, removeAiSource,
  exportData, importData, resetAll,
} from './state.js';
import { escapeHTML } from './util.js';

export class SettingsPanel {
  constructor(rootEl, onChange) {
    this.root = rootEl;
    this.onChange = onChange || (() => {});
  }

  open() {
    this.render();
    document.getElementById('settingsBackdrop').classList.add('modal-backdrop--open');
  }

  close() {
    document.getElementById('settingsBackdrop').classList.remove('modal-backdrop--open');
    this.onChange();
  }

  render() {
    const s = getSettings();

    this.root.innerHTML = `
      <div class="settings-section">
        <div class="settings-section__title">Clé API IDFM</div>
        <div class="settings-section__desc">
          Pour les trains. Inscription gratuite (3 min) sur
          <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>,
          puis "Mes jetons d'authentification" → créer un jeton → coller ci-dessous.
        </div>
        <input class="input" type="password" placeholder="apikey IDFM…" data-field="idfmKey" value="${escapeHTML(s.idfm.apiKey)}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Localisation</div>
        <div class="settings-section__desc">Position par défaut (Conflans) si le GPS du téléphone n'est pas disponible. Utilisée pour la météo et le rayon des stations essence.</div>
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
        <div class="settings-section__title">Sources veille IA</div>
        <div class="settings-section__desc">Active / désactive les sources. Les flux RSS passent par rss2json (gratuit, sans clé).</div>
        <div class="crud-list">
          ${s.aiSources.map(src => `
            <div class="crud-item">
              <label class="label-row" style="margin:0">
                <input type="checkbox" data-toggle-ai="${src.id}" ${src.enabled ? 'checked' : ''}>
              </label>
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(src.name)}</span>
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
        <div class="settings-section__desc">Exporte un JSON complet (settings + cache). Utile avant un reset ou pour migrer.</div>
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
          case 'idfmKey':    settings.idfm.apiKey = v.trim(); break;
          case 'locName':    settings.location.name = v.trim(); break;
          case 'locLat':     settings.location.lat = parseFloat(v) || 0; break;
          case 'locLon':     settings.location.lon = parseFloat(v) || 0; break;
          case 'gasRadius':  settings.gas.radiusKm = Math.max(1, parseInt(v, 10) || 8); break;
        }
        save();
      });
    });

    this.root.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add-ai') {
        const name = this.root.querySelector('[data-new-ai-name]').value.trim();
        const url = this.root.querySelector('[data-new-ai-url]').value.trim();
        if (name && url) { addAiSource(name, url); this.render(); }
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
      if (removeAiId) { removeAiSource(removeAiId); this.render(); return; }
    });

    this.root.addEventListener('change', (e) => {
      const tgl = e.target.closest('[data-toggle-ai]');
      if (tgl) { toggleAiSource(tgl.dataset.toggleAi); return; }

      const file = e.target.closest('[data-import-file]');
      if (file && file.files[0]) {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            importData(reader.result);
            alert('Importé.');
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
