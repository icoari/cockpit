import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, minutesUntil, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';

const CACHE_TTL = 60 * 1000;

// RER A stations in Paris with verified IDFM stop IDs + coordinates
export const PARIS_RER_A = [
  { name: 'Auber',                      stopRef: 'STIF:StopArea:SP:45873:',  lat: 48.8717, lon: 2.3308 },
  { name: 'Châtelet-Les Halles',        stopRef: 'STIF:StopArea:SP:45102:',  lat: 48.8617, lon: 2.3470 },
  { name: 'Charles de Gaulle - Étoile', stopRef: 'STIF:StopArea:SP:58759:',  lat: 48.8748, lon: 2.2950 },
  { name: 'La Défense',                 stopRef: 'STIF:StopArea:SP:470549:', lat: 48.8919, lon: 2.2384 },
  { name: 'Gare de Lyon',               stopRef: 'STIF:StopArea:SP:470195:', lat: 48.8443, lon: 2.3743 },
  { name: 'Nation',                     stopRef: 'STIF:StopArea:SP:473875:', lat: 48.8484, lon: 2.3958 },
];

// ---------- Data fetching ----------
export async function fetchStop(stopRef, apiKey, { force = false } = {}) {
  const cacheKey = `train_${stopRef}`;
  if (!force) {
    const cached = cacheGet(cacheKey, CACHE_TTL);
    if (cached) return cached;
  }
  const url = `https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=${encodeURIComponent(stopRef)}`;
  const resp = await fetchWithTimeout(url, {
    headers: { 'apikey': apiKey, 'Accept': 'application/json' },
  }, 9000);
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error('Clé API IDFM invalide');
    throw new Error(`API trains : HTTP ${resp.status}`);
  }
  const data = await resp.json();
  cacheSet(cacheKey, data);
  return data;
}

export function extractDepartures(siri) {
  if (!siri) return [];
  const delivery = siri?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0];
  const visits = delivery?.MonitoredStopVisit || [];
  return visits.map(v => {
    const j = v.MonitoredVehicleJourney || {};
    const call = j.MonitoredCall || {};
    const aimed = call.AimedDepartureTime || call.AimedArrivalTime;
    const expected = call.ExpectedDepartureTime || call.ExpectedArrivalTime || aimed;
    const dest = (call.DestinationDisplay && call.DestinationDisplay[0]?.value)
              || (j.DestinationName && j.DestinationName[0]?.value)
              || '';
    const arrivalStatus = call.DepartureStatus || call.ArrivalStatus || 'onTime';
    const cancelled = arrivalStatus === 'cancelled';
    const lineRef = j.LineRef?.value || '';
    const trainId = j.VehicleJourneyName?.[0]?.value || '';
    const platform = call.DeparturePlatformName?.value || call.ArrivalPlatformName?.value || '';
    return {
      destination: dest,
      aimed: aimed ? new Date(aimed) : null,
      expected: expected ? new Date(expected) : null,
      cancelled,
      lineRef,
      trainId,
      platform,
    };
  })
  .filter(d => d.expected)
  .sort((a, b) => a.expected - b.expected);
}

// ---------- Filters per route ----------
function isParisBoundFromConflans(dep, lineRef, paris = true) {
  if (dep.lineRef !== lineRef) return false;
  const dest = (dep.destination || '').toLowerCase();
  if (paris) {
    // J line: Paris-bound = destination contains "saint-lazare" or "paris"
    // RER A: Paris-bound = destination is one of eastern termini (NOT cergy/poissy)
    if (lineRef === 'STIF:Line::C01739:') return dest.includes('saint-lazare') || dest.includes('paris');
    if (lineRef === 'STIF:Line::C01742:') {
      const west = ['cergy', 'poissy', 'saint-germain', 'maisons-laffitte'];
      return !west.some(w => dest.includes(w));
    }
  }
  return true;
}

export function isConflansBoundFromParisJ(dep) {
  if (dep.lineRef !== 'STIF:Line::C01739:') return false;
  const dest = (dep.destination || '').toLowerCase();
  // J line trains that pass through Conflans-Fin-d'Oise OR Conflans-Sainte-Honorine
  // J5 (Conflans-Fin-d'Oise then Mantes branch): Mantes, Vernon, Issou, Argenteuil, Houilles
  // J6 (Conflans-Sainte-Honorine then Gisors branch): Gisors, Boissy-l'Aillerie, Pontoise (via SH)
  // J3 (Conflans-FdO via Pontoise): rarely
  return ['mantes', 'vernon', 'issou', 'gisors', 'boissy', 'pontoise', 'porcheville'].some(t => dest.includes(t));
}

// Determine if a J train going west passes through Conflans Fin d'Oise (primary) vs SH (backup)
function jBranch(dest) {
  const d = (dest || '').toLowerCase();
  if (d.includes('mantes') || d.includes('vernon') || d.includes('porcheville') || d.includes('issou')) return 'fdo';
  if (d.includes('gisors') || d.includes("boissy-l'aillerie") || d.includes('pontoise')) return 'sh';
  return null;
}

export function isConflansBoundFromParisRER(dep) {
  if (dep.lineRef !== 'STIF:Line::C01742:') return false;
  const dest = (dep.destination || '').toLowerCase();
  // RER A trains to Conflans Fin d'Oise are only those bound for Cergy le Haut
  return dest.includes('cergy');
}

// ---------- Rendering helpers ----------
function statusBadge(d) {
  if (d.cancelled) return { cls: 'train-row__status--cancel', text: 'Supprimé' };
  if (!d.aimed || !d.expected) return { cls: '', text: '—' };
  const delaySec = (d.expected - d.aimed) / 1000;
  if (delaySec > 60) {
    const min = Math.round(delaySec / 60);
    return { cls: 'train-row__status--late', text: `+${min} min` };
  }
  return { cls: '', text: 'à l\'heure' };
}

function renderRow(d, { highlightLast = false } = {}) {
  const mins = minutesUntil(d.expected);
  const cls = ['train-row'];
  if (d.cancelled) cls.push('train-row--cancel');
  if (highlightLast) cls.push('train-row--last');

  const aimedTime = d.aimed
    ? d.aimed.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : '';
  const status = statusBadge(d);
  const isNow = mins === 0;
  const minLabel = mins < 0 ? 'parti' : isNow ? 'NOW' : `${mins} min`;
  const whenExtraCls = isNow ? 'train-row__when--now' : '';

  return `
    <div class="${cls.join(' ')}">
      <div class="train-row__when ${whenExtraCls}">${escapeHTML(minLabel)}<small>${escapeHTML(aimedTime)}${d.platform ? ' · voie ' + escapeHTML(d.platform) : ''}</small></div>
      <div class="train-row__dest">${escapeHTML(d.destination || '—')}</div>
      <div class="train-row__status ${status.cls}">${escapeHTML(status.text)}</div>
    </div>
  `;
}

function renderList(deps, opts = {}) {
  if (deps.length === 0) return '<div class="card__empty">Aucun train à venir.</div>';
  const last = deps[deps.length - 1];
  const showLastBadge = opts.markLast && deps.length <= 4 && minutesUntil(last.expected) > 25;
  return '<div class="train-list">' + deps.map((d, i) => renderRow(d, {
    highlightLast: showLastBadge && i === deps.length - 1,
  })).join('') + '</div>';
}

function renderSubtabs(active) {
  return `
    <div class="subtabs">
      <button class="subtab ${active === 'rer' ? 'subtab--active' : ''}" data-subtab="rer" type="button">RER A</button>
      <button class="subtab ${active === 'j' ? 'subtab--active' : ''}" data-subtab="j" type="button">Transilien J</button>
    </div>
  `;
}

function renderShell(direction, activeSubtab, body, subtitle = '') {
  const title = direction === 'aller' ? 'Trains — vers Paris' : 'Trains — retour';
  return `
    <div class="card__head">
      <div class="card__head-main">
        <span class="card__title">${escapeHTML(title)}</span>
        ${subtitle ? `<span class="card__subtitle">${escapeHTML(subtitle)}</span>` : ''}
      </div>
      <div class="card__actions">
        <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
      </div>
    </div>
    <div class="card__body">
      ${renderSubtabs(activeSubtab)}
      <div data-body>${body}</div>
    </div>
  `;
}

// ---------- Widget classes ----------
export class TrainsWidget {
  constructor(container, direction) {
    this.container = container;
    this.direction = direction; // 'aller' | 'retour'
    this.subtab = direction === 'aller' ? 'rer' : 'rer'; // default both to RER (user's primary)
    this.lastSummary = '';
    this.container.classList.add('card');
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = renderShell(
      this.direction,
      this.subtab,
      '<div class="card__loading">Chargement…</div>',
      this.lastSummary,
    );
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      // Refresh button
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        this.refresh(true);
        return;
      }
      // Subtab switch
      const sub = e.target.closest('[data-subtab]');
      if (sub) {
        e.stopPropagation();
        const v = sub.dataset.subtab;
        if (v !== this.subtab) {
          haptic(4);
          this.subtab = v;
          this.render();
          this.refresh();
        }
        return;
      }
    });
  }

  setBody(html, summary = null) {
    const body = this.container.querySelector('[data-body]');
    if (body) body.innerHTML = html;
    if (summary !== null) {
      this.lastSummary = summary;
      const subtitleEl = this.container.querySelector('.card__subtitle');
      if (subtitleEl) {
        subtitleEl.textContent = summary;
      } else if (summary) {
        const head = this.container.querySelector('.card__head-main');
        if (head) {
          const span = document.createElement('span');
          span.className = 'card__subtitle';
          span.textContent = summary;
          head.appendChild(span);
        }
      }
    }
  }

  buildSummary(deps) {
    if (!deps || deps.length === 0) return 'aucun train';
    const next = deps[0];
    const mins = minutesUntil(next.expected);
    const timeStr = next.expected.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const minStr = mins <= 0 ? 'maintenant' : `${mins} min`;
    return `prochain ${timeStr} · ${minStr}`;
  }

  async refresh(force = false) {
    const settings = getSettings();
    if (!settings.idfm.apiKey) {
      this.setBody(`
        <div class="card__error">
          Clé API IDFM manquante. Ajoute-la dans les <a href="#" data-open-settings>Réglages</a>.
          <br><br>
          Inscription gratuite (3 min) : <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>
        </div>
      `, 'clé API manquante');
      return;
    }

    this.setBody('<div class="card__loading">Chargement…</div>');

    try {
      if (this.direction === 'aller') {
        await this.refreshAller(settings, force);
      } else {
        await this.refreshRetour(settings, force);
      }
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message || 'Erreur de chargement')}</div>`, 'erreur');
    }
  }

  async refreshAller(settings, force) {
    const stopRef = settings.idfm.stops.conflansFinDOise;
    const lineRef = this.subtab === 'rer' ? settings.idfm.lines.rerA : settings.idfm.lines.transilienJ;
    const data = await fetchStop(stopRef, settings.idfm.apiKey, { force });
    const all = extractDepartures(data);
    const filtered = all.filter(d => isParisBoundFromConflans(d, lineRef));
    const trimmed = filtered.slice(0, 3);
    this.items = trimmed;
    this.setBody(renderList(trimmed), this.buildSummary(trimmed));
  }

  async refreshRetour(settings, force) {
    if (this.subtab === 'j') {
      await this.refreshRetourJ(settings, force);
    } else {
      await this.refreshRetourRer(settings, force);
    }
  }

  async refreshRetourJ(settings, force) {
    // From Saint-Lazare (58566). Filter J line trains heading toward Conflans area.
    const stopRef = settings.idfm.stops.saintLazare;
    const data = await fetchStop(stopRef, settings.idfm.apiKey, { force });
    const all = extractDepartures(data);
    const conflansBound = all.filter(isConflansBoundFromParisJ);

    // Split: trains passing through Fin d'Oise vs only Sainte-Honorine (backup)
    const primary = conflansBound.filter(d => jBranch(d.destination) === 'fdo').slice(0, 3);
    const backup = conflansBound.filter(d => jBranch(d.destination) === 'sh').slice(0, 2);

    let html = `<div class="train-section-label">Vers Conflans Fin d'Oise</div>`;
    html += renderList(primary, { markLast: false });
    if (backup.length > 0) {
      html += `<div class="train-section-label train-section-label--backup">Vers Conflans-Sainte-Honorine</div>`;
      html += renderList(backup);
    }
    this.items = primary.length ? primary : backup;
    this.setBody(html, this.buildSummary(primary.length ? primary : backup));
  }

  async refreshRetourRer(settings, force) {
    // Use geolocation to pick the nearest Paris RER A station; fallback Auber
    const pos = await getPosition({ timeout: 5000 });
    let station = PARIS_RER_A[0]; // Auber default
    let usedGeoloc = false;
    if (pos) {
      // Sort by distance, pick closest (only if reasonably close to Paris)
      const sorted = PARIS_RER_A.map(s => ({ ...s, d: distanceKm(pos, s) })).sort((a, b) => a.d - b.d);
      if (sorted[0].d < 50) { station = sorted[0]; usedGeoloc = true; }
    }

    const data = await fetchStop(station.stopRef, settings.idfm.apiKey, { force });
    const all = extractDepartures(data);
    const filtered = all.filter(isConflansBoundFromParisRER).slice(0, 3);

    const stationLabel = usedGeoloc
      ? `Depuis ${station.name} (le plus proche)`
      : `Depuis ${station.name}`;

    let html = `<div class="train-section-label">${escapeHTML(stationLabel)} → Conflans Fin d'Oise</div>`;
    html += renderList(filtered, { markLast: true });
    if (filtered.length === 0) {
      html += `<div class="card__empty" style="margin-top:8px">Aucun RER A vers Conflans Fin d'Oise depuis cette gare en ce moment. Bascule sur "Transilien J" pour le backup via Saint-Lazare.</div>`;
    }
    this.items = filtered;
    this.setBody(html, this.buildSummary(filtered) + (usedGeoloc ? ` · ${station.name}` : ''));
  }
}
