import { getSettings, cacheGet, cacheSet } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, minutesUntil, haptic } from './util.js';

const CACHE_TTL = 90 * 1000; // 90 sec

// Direction definitions
const ROUTES = {
  aller: {
    j:   { from: 'conflansFinDOise',       toward: 'towardParis',    label: 'Vers Saint-Lazare',   line: 'Transilien J' },
    rer: { from: 'conflansSainteHonorine', toward: 'towardParis',    label: 'Vers Paris',           line: 'RER A' },
  },
  retour: {
    j:   { from: 'saintLazare',           toward: 'towardConflans', label: 'Vers Conflans Fin d\'Oise', line: 'Transilien J' },
    rer: { from: 'chatelet',              toward: 'towardConflans', label: 'Vers Conflans-Ste-Honorine', line: 'RER A' },
  },
};

async function fetchStop(stopRef, apiKey) {
  const cacheKey = `train_${stopRef}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const url = `https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=${encodeURIComponent(stopRef)}`;
  const resp = await fetchWithTimeout(url, {
    headers: { 'apikey': apiKey, 'Accept': 'application/json' },
  }, 8000);
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error('Clé API IDFM invalide');
    throw new Error(`Trains: ${resp.status}`);
  }
  const data = await resp.json();
  cacheSet(cacheKey, data);
  return data;
}

function extractDepartures(siri) {
  if (!siri) return [];
  const delivery = siri?.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0];
  const visits = delivery?.MonitoredStopVisit || [];
  return visits.map(v => {
    const j = v.MonitoredVehicleJourney || {};
    const call = j.MonitoredCall || {};
    const aimed = call.AimedDepartureTime || call.AimedArrivalTime;
    const expected = call.ExpectedDepartureTime || call.ExpectedArrivalTime || aimed;
    const dest = (j.DestinationName && j.DestinationName[0]?.value)
              || (call.DestinationDisplay && call.DestinationDisplay[0]?.value)
              || j.DirectionName?.[0]?.value
              || '';
    const arrivalStatus = call.DepartureStatus || call.ArrivalStatus || 'onTime';
    const cancelled = arrivalStatus === 'cancelled' || call.DepartureStatus === 'cancelled' || call.ArrivalStatus === 'cancelled';
    const lineRef = j.LineRef?.value || '';
    const trainId = j.TrainNumbers?.TrainNumberRef?.[0]?.value || '';
    return {
      destination: dest,
      aimed: aimed ? new Date(aimed) : null,
      expected: expected ? new Date(expected) : null,
      cancelled,
      lineRef,
      trainId,
    };
  })
  .filter(d => d.expected)
  .sort((a, b) => a.expected - b.expected);
}

function filterByDirection(departures, towardList) {
  const tokens = towardList.map(t => t.toLowerCase());
  return departures.filter(d => {
    const dest = (d.destination || '').toLowerCase();
    return tokens.some(t => dest.includes(t.toLowerCase()));
  });
}

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

function renderDepartureList(deps, withDestination = true) {
  if (deps.length === 0) {
    return '<div class="card__empty">Aucun train à venir trouvé.</div>';
  }
  const items = deps.slice(0, 4).map((d, idx) => {
    const mins = minutesUntil(d.expected);
    const isLast = idx === deps.slice(0, 4).length - 1 && deps.length <= 4 && mins > 30;
    const cls = ['train-row'];
    if (d.cancelled) cls.push('train-row--cancel');
    if (isLast) cls.push('train-row--last');

    const aimedTime = d.aimed ? d.aimed.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    const status = statusBadge(d);
    const minLabel = mins < 0 ? 'parti' : mins === 0 ? 'maintenant' : `${mins} min`;

    return `
      <div class="${cls.join(' ')}">
        <div class="train-row__when">${escapeHTML(minLabel)}<small>${escapeHTML(aimedTime)}</small></div>
        <div class="train-row__dest">${escapeHTML(d.destination || '—')}${withDestination && d.trainId ? `<small>n° ${escapeHTML(d.trainId)}</small>` : ''}</div>
        <div class="train-row__status ${status.cls}">${escapeHTML(status.text)}</div>
      </div>
    `;
  }).join('');
  return `<div class="train-list">${items}</div>`;
}

function renderSubtabs(active, ondata) {
  return `
    <div class="subtabs">
      <button class="subtab ${active === 'j' ? 'subtab--active' : ''}" data-subtab="j" type="button">Transilien J</button>
      <button class="subtab ${active === 'rer' ? 'subtab--active' : ''}" data-subtab="rer" type="button">RER A</button>
    </div>
  `;
}

function renderShell(direction, activeSubtab, body) {
  const title = direction === 'aller' ? 'Aller — vers Paris' : 'Retour — vers Conflans';
  return `
    <div class="card__head">
      <span class="card__title">${title}</span>
      <div class="card__actions">
        <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
      </div>
    </div>
    ${renderSubtabs(activeSubtab)}
    <div data-body>${body}</div>
  `;
}

export class TrainsWidget {
  constructor(container, direction) {
    this.container = container;
    this.direction = direction; // 'aller' | 'retour'
    this.subtab = 'j';
    this.container.classList.add('card');
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = renderShell(this.direction, this.subtab, '<div class="card__loading">Chargement…</div>');
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      const refresh = e.target.closest('[data-action="refresh"]');
      if (refresh) { haptic(6); this.refresh(true); return; }
      const sub = e.target.closest('[data-subtab]');
      if (sub) {
        const v = sub.dataset.subtab;
        if (v !== this.subtab) {
          this.subtab = v;
          this.render();
          this.refresh();
        }
      }
    });
  }

  setBody(html) {
    const body = this.container.querySelector('[data-body]');
    if (body) body.innerHTML = html;
  }

  async refresh(force = false) {
    const settings = getSettings();
    if (!settings.idfm.apiKey) {
      this.setBody(`
        <div class="card__error">
          Clé API IDFM manquante. Ajoute-la dans les <a href="#" data-open-settings>Réglages</a>.
          <br><br>
          Inscription gratuite : <a href="https://prim.iledefrance-mobilites.fr/" target="_blank" rel="noopener">prim.iledefrance-mobilites.fr</a>
        </div>
      `);
      return;
    }

    const route = ROUTES[this.direction][this.subtab];
    const stopRef = settings.idfm.stops[route.from];
    const towardList = settings.idfm.destinations[route.toward];

    if (!stopRef) {
      this.setBody('<div class="card__error">Stop ID non configuré pour cette ligne. Voir Réglages.</div>');
      return;
    }

    this.setBody('<div class="card__loading">Chargement…</div>');

    try {
      if (force) {
        // bypass cache
        const cacheKey = `train_${stopRef}`;
        // crude bust by setting a 0-ttl read after this fetch overwrites cache
      }
      const data = await fetchStop(stopRef, settings.idfm.apiKey);
      const all = extractDepartures(data);
      const filtered = filterByDirection(all, towardList);
      const directions = filtered.length > 0 ? filtered : all;
      this.setBody(renderDepartureList(directions));
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message || 'Erreur de chargement')}</div>`);
    }
  }
}
