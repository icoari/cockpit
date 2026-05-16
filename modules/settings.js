import {
  getSettings, getState, updateSettings, save,
  addLink, removeLink,
  addHabit, removeHabit,
  addAiSource, toggleAiSource, removeAiSource,
  exportData, importData, resetAll,
} from './state.js';
import { ICONS } from './icons.js';
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
          Pour afficher les prochains trains. Inscription gratuite sur
          <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>,
          puis "Mes jetons d'authentification" → créer un jeton.
        </div>
        <input class="input" type="password" placeholder="apikey IDFM…" data-field="idfmKey" value="${escapeHTML(s.idfm.apiKey)}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Stops trains (avancé)</div>
        <div class="settings-section__desc">Identifiants STIF. Modifie uniquement si les départs ne s'affichent pas correctement.</div>
        <label class="label-row" style="display:block">Conflans Fin d'Oise (Transilien J)</label>
        <input class="input" type="text" data-field="stopConflansJ" value="${escapeHTML(s.idfm.stops.conflansFinDOise)}">
        <label class="label-row" style="display:block">Conflans-Ste-Honorine (RER A)</label>
        <input class="input" type="text" data-field="stopConflansRer" value="${escapeHTML(s.idfm.stops.conflansSainteHonorine)}">
        <label class="label-row" style="display:block">Saint-Lazare (Transilien J)</label>
        <input class="input" type="text" data-field="stopSaintLazare" value="${escapeHTML(s.idfm.stops.saintLazare)}">
        <label class="label-row" style="display:block">Châtelet-Les-Halles (RER A)</label>
        <input class="input" type="text" data-field="stopChatelet" value="${escapeHTML(s.idfm.stops.chatelet)}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Localisation météo</div>
        <input class="input" type="text" placeholder="Nom (Conflans)" data-field="locName" value="${escapeHTML(s.location.name)}">
        <input class="input" type="number" step="0.001" placeholder="Latitude" data-field="locLat" value="${s.location.lat}">
        <input class="input" type="number" step="0.001" placeholder="Longitude" data-field="locLon" value="${s.location.lon}">
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Sources veille IA</div>
        <div class="settings-section__desc">Active / désactive les sources. Les flux RSS sont récupérés via rss2json (gratuit).</div>
        <div class="crud-list" data-ai-list>
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
          <input class="input" type="text" placeholder="Nom (ex. Mistral)" data-new-ai-name style="flex:1;margin:0">
          <input class="input" type="url" placeholder="URL RSS" data-new-ai-url style="flex:2;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-ai">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Liens rapides</div>
        <div class="crud-list">
          ${s.links.map(l => `
            <div class="crud-item">
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(l.label)}</span>
                <span class="crud-item__sub">${escapeHTML(l.url)}</span>
              </div>
              <button class="crud-item__action" data-remove-link="${l.id}" type="button">supprimer</button>
            </div>
          `).join('')}
        </div>
        <div class="btn-row">
          <input class="input" type="text" placeholder="Nom" data-new-link-label style="flex:1;margin:0">
          <input class="input" type="url" placeholder="URL" data-new-link-url style="flex:2;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-link">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Habitudes</div>
        <div class="crud-list">
          ${s.habits.map(h => `
            <div class="crud-item">
              <div class="crud-item__main">
                <span class="crud-item__name">${escapeHTML(h.name)}</span>
              </div>
              <button class="crud-item__action" data-remove-habit="${h.id}" type="button">supprimer</button>
            </div>
          `).join('')}
        </div>
        <div class="btn-row">
          <input class="input" type="text" placeholder="Nouvelle habitude" data-new-habit style="flex:1;margin:0">
          <button class="btn btn--ghost" type="button" data-action="add-habit">Ajouter</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__title">Sauvegarde</div>
        <div class="settings-section__desc">Exporte un JSON complet de tes données. Importe-le sur un autre appareil pour migrer.</div>
        <div class="btn-row">
          <button class="btn btn--ghost" type="button" data-action="export">Exporter JSON</button>
          <button class="btn btn--ghost" type="button" data-action="import">Importer JSON</button>
          <button class="btn btn--danger" type="button" data-action="reset">Réinitialiser tout</button>
        </div>
        <input type="file" accept=".json,application/json" data-import-file style="display:none">
      </div>
    `;

    this.attach();
  }

  attach() {
    // Field auto-save on blur
    this.root.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('change', () => {
        const settings = getSettings();
        const v = el.value;
        switch (el.dataset.field) {
          case 'idfmKey': settings.idfm.apiKey = v.trim(); break;
          case 'stopConflansJ': settings.idfm.stops.conflansFinDOise = v.trim(); break;
          case 'stopConflansRer': settings.idfm.stops.conflansSainteHonorine = v.trim(); break;
          case 'stopSaintLazare': settings.idfm.stops.saintLazare = v.trim(); break;
          case 'stopChatelet': settings.idfm.stops.chatelet = v.trim(); break;
          case 'locName': settings.location.name = v.trim(); break;
          case 'locLat': settings.location.lat = parseFloat(v) || 0; break;
          case 'locLon': settings.location.lon = parseFloat(v) || 0; break;
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
      if (action === 'add-link') {
        const label = this.root.querySelector('[data-new-link-label]').value.trim();
        const url = this.root.querySelector('[data-new-link-url]').value.trim();
        if (label && url) { addLink(label, url); this.render(); }
        return;
      }
      if (action === 'add-habit') {
        const name = this.root.querySelector('[data-new-habit]').value.trim();
        if (name) { addHabit(name); this.render(); }
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
        if (confirm('Réinitialiser TOUT (settings, captures, todos, habitudes) ?')) {
          resetAll();
          this.render();
          this.onChange();
        }
        return;
      }
      const removeLinkId = e.target.closest('[data-remove-link]')?.dataset.removeLink;
      if (removeLinkId) { removeLink(removeLinkId); this.render(); return; }

      const removeHabitId = e.target.closest('[data-remove-habit]')?.dataset.removeHabit;
      if (removeHabitId) { removeHabit(removeHabitId); this.render(); return; }

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
