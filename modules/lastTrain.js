import { getSettings } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';
import { fetchStop, extractDepartures, isConflansBoundFromParisJ, isConflansBoundFromParisRER, PARIS_RER_A } from './trains.js';

function fmtTime(d) {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function durationLabel(target) {
  const diffMin = Math.round((target - Date.now()) / 60000);
  if (diffMin < 0) return 'parti';
  if (diffMin < 60) return `dans ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m === 0 ? `dans ${h} h` : `dans ${h} h ${m}`;
}

async function findLastJ(apiKey) {
  const settings = getSettings();
  const data = await fetchStop(settings.idfm.stops.saintLazare, apiKey);
  const all = extractDepartures(data);
  const conflansBound = all.filter(isConflansBoundFromParisJ);
  return conflansBound[conflansBound.length - 1] || null;
}

async function findLastRER(apiKey) {
  const pos = await getPosition({ timeout: 4000 });
  let station = PARIS_RER_A[0];
  if (pos) {
    const sorted = PARIS_RER_A.map(s => ({ ...s, d: distanceKm(pos, s) })).sort((a, b) => a.d - b.d);
    if (sorted[0].d < 50) station = sorted[0];
  }
  const data = await fetchStop(station.stopRef, apiKey);
  const all = extractDepartures(data);
  const conflansBound = all.filter(isConflansBoundFromParisRER);
  return { dep: conflansBound[conflansBound.length - 1] || null, station: station.name };
}

function renderRow(dep, label, station) {
  if (!dep) {
    return `
      <div class="last-train-row last-train-row--empty">
        <div class="last-train-row__line">${escapeHTML(label)}</div>
        <div class="last-train-row__empty">Aucun train visible dans les données IDFM. Reviens plus tard dans la journée.</div>
      </div>
    `;
  }
  const aimed = dep.aimed || dep.expected;
  return `
    <div class="last-train-row">
      <div class="last-train-row__line">${escapeHTML(label)}${station ? ` <small>depuis ${escapeHTML(station)}</small>` : ''}</div>
      <div class="last-train-row__main">
        <span class="last-train-row__time">${fmtTime(aimed)}</span>
        <span class="last-train-row__until">${escapeHTML(durationLabel(aimed))}</span>
      </div>
      <div class="last-train-row__dest">${escapeHTML(dep.destination)}</div>
    </div>
  `;
}

export class LastTrainWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Dernier train pour rentrer</span>
          <span class="card__subtitle">chargement…</span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div data-body><div class="card__loading">Chargement…</div></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        this.refresh();
      }
    });
  }

  setSubtitle(t) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = t;
  }

  setBody(html) {
    const el = this.container.querySelector('[data-body]');
    if (el) el.innerHTML = html;
  }

  async refresh() {
    const settings = getSettings();
    if (!settings.idfm.apiKey) {
      this.setBody(`<div class="card__error">Clé API IDFM manquante. <a href="#" data-open-settings>Réglages</a>.</div>`);
      this.setSubtitle('clé manquante');
      return;
    }

    this.setBody('<div class="card__loading">Chargement…</div>');
    this.setSubtitle('chargement…');

    try {
      const [lastJ, lastRer] = await Promise.all([
        findLastJ(settings.idfm.apiKey).catch(() => null),
        findLastRER(settings.idfm.apiKey).catch(() => ({ dep: null, station: '' })),
      ]);

      const html = `
        <div class="last-train-list">
          ${renderRow(lastJ, 'Transilien J', 'Saint-Lazare')}
          ${renderRow(lastRer.dep, 'RER A', lastRer.station)}
        </div>
        <div class="last-train-foot">Le dernier visible aujourd'hui dans les données IDFM. La nuit, c'est le vrai dernier.</div>
      `;
      this.setBody(html);

      // Subtitle: shows latest of the two
      const candidates = [];
      if (lastJ) candidates.push({ line: 'J', date: lastJ.aimed || lastJ.expected });
      if (lastRer.dep) candidates.push({ line: 'RER A', date: lastRer.dep.aimed || lastRer.dep.expected });
      if (candidates.length === 0) {
        this.setSubtitle('aucun visible');
      } else {
        candidates.sort((a, b) => b.date - a.date);
        const latest = candidates[0];
        this.setSubtitle(`${latest.line} à ${fmtTime(latest.date)} (${durationLabel(latest.date)})`);
      }
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }
}
