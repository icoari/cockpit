import { getSettings, cacheGet, cacheSet, cacheBust } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, haptic } from './util.js';
import { getPosition, distanceKm } from './geolocation.js';
import { PARIS_RER_A } from './trains.js';

const CACHE_TTL = 6 * 60 * 60 * 1000; // schedule is mostly static

// Coordinates (lat, lon) for key stations
const COORDS = {
  saintLazare:          { lat: 48.8757, lon: 2.3247 },
  conflansFinDOise:     { lat: 48.9931, lon: 2.0823 },
  conflansSainteHonorine: { lat: 49.0021, lon: 2.1037 },
};

const LINES = {
  J:    'line:IDFM:C01739',
  RER_A:'line:IDFM:C01742',
  N152: 'line:IDFM:C01641',
};

const PARIS_RER_A_FROM_COORDS = {
  Auber:                'STIF:StopArea:SP:45873:',
  ChâteletLesHalles:    'STIF:StopArea:SP:45102:',
};

// Format date as YYYYMMDDTHHmmss (Navitia format)
function navitiaDt(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function tonightCutoff() {
  // 05:00 tomorrow morning — captures everything before end of night service
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(5, 0, 0, 0);
  return t;
}

async function fetchJourney(apiKey, fromLat, fromLon, toLat, toLon, lineId, opts = {}) {
  const { count = 1, byArrival = false, datetime } = opts;
  const url = `https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys`
    + `?from=${fromLon};${fromLat}&to=${toLon};${toLat}`
    + `&datetime=${datetime}`
    + (byArrival ? '&datetime_represents=arrival' : '')
    + `&allowed_id[]=${encodeURIComponent(lineId)}`
    + `&count=${count}`;
  const resp = await fetchWithTimeout(url, { headers: { 'apikey': apiKey } }, 10000);
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error('Clé API IDFM invalide');
    return null;
  }
  const data = await resp.json();
  if (data.error) return null;
  return data.journeys || [];
}

function parseNavitiaDt(s) {
  // 20260517T012800 → Date
  if (!s) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(9, 11), mi = +s.slice(11, 13), se = +s.slice(13, 15);
  return new Date(y, m, d, h, mi, se);
}

function findTransitSection(journey) {
  // Pick the first non-walking section with display_informations
  if (!journey?.sections) return null;
  for (const s of journey.sections) {
    if (s.type === 'public_transport') return s;
  }
  return null;
}

function summariseJourney(j) {
  if (!j) return null;
  const dep = parseNavitiaDt(j.departure_date_time);
  const arr = parseNavitiaDt(j.arrival_date_time);
  const section = findTransitSection(j);
  const info = section?.display_informations || {};
  return {
    depart: dep,
    arrive: arr,
    line: info.label || info.code || '',
    direction: info.direction || section?.to?.name || '',
    duration: j.duration,
  };
}

async function loadAll(apiKey) {
  const cached = cacheGet('lastTrainData', CACHE_TTL);
  if (cached) {
    return {
      lastJFdo: cached.lastJFdo && hydrate(cached.lastJFdo),
      lastJSh:  cached.lastJSh  && hydrate(cached.lastJSh),
      lastRer:  cached.lastRer  && { ...hydrate(cached.lastRer.summary), fromStation: cached.lastRer.fromStation },
      nextN152: (cached.nextN152 || []).map(hydrate),
    };
  }

  const cutoff = navitiaDt(tonightCutoff());

  // RER A: from nearest Paris station to Conflans Fin d'Oise
  const pos = await getPosition({ timeout: 4000 });
  let rerStation = PARIS_RER_A[0];
  if (pos) {
    const sorted = PARIS_RER_A
      .map(s => ({ ...s, d: distanceKm(pos, s) }))
      .sort((a, b) => a.d - b.d);
    if (sorted[0].d < 50) rerStation = sorted[0];
  }

  const [lastJFdo, lastJSh, lastRer, nextN152] = await Promise.all([
    fetchJourney(apiKey, COORDS.saintLazare.lat, COORDS.saintLazare.lon,
                 COORDS.conflansFinDOise.lat, COORDS.conflansFinDOise.lon,
                 LINES.J, { count: 1, byArrival: true, datetime: cutoff }),
    fetchJourney(apiKey, COORDS.saintLazare.lat, COORDS.saintLazare.lon,
                 COORDS.conflansSainteHonorine.lat, COORDS.conflansSainteHonorine.lon,
                 LINES.J, { count: 1, byArrival: true, datetime: cutoff }),
    fetchJourney(apiKey, rerStation.lat, rerStation.lon,
                 COORDS.conflansFinDOise.lat, COORDS.conflansFinDOise.lon,
                 LINES.RER_A, { count: 1, byArrival: true, datetime: cutoff }),
    fetchJourney(apiKey, COORDS.saintLazare.lat, COORDS.saintLazare.lon,
                 COORDS.conflansFinDOise.lat, COORDS.conflansFinDOise.lon,
                 LINES.N152, { count: 3, byArrival: false, datetime: navitiaDt(new Date()) }),
  ]);

  const summary = {
    lastJFdo: summariseJourney(lastJFdo?.[0]),
    lastJSh:  summariseJourney(lastJSh?.[0]),
    lastRer:  { summary: summariseJourney(lastRer?.[0]), fromStation: rerStation.name },
    nextN152: (nextN152 || []).map(summariseJourney).filter(Boolean),
  };

  cacheSet('lastTrainData', dehydrate(summary));
  return summary;
}

function dehydrate(s) {
  const ser = (j) => j && ({ ...j, depart: j.depart?.toISOString(), arrive: j.arrive?.toISOString() });
  return {
    lastJFdo: ser(s.lastJFdo),
    lastJSh:  ser(s.lastJSh),
    lastRer:  s.lastRer && { fromStation: s.lastRer.fromStation, summary: ser(s.lastRer.summary) },
    nextN152: s.nextN152.map(ser).filter(Boolean),
  };
}

function hydrate(j) {
  return j && { ...j, depart: j.depart ? new Date(j.depart) : null, arrive: j.arrive ? new Date(j.arrive) : null };
}

function fmtTime(d) {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function durationLabel(target) {
  if (!target) return '';
  const diffMin = Math.round((target - Date.now()) / 60000);
  if (diffMin < 0) return 'parti';
  if (diffMin < 60) return `dans ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m === 0 ? `dans ${h} h` : `dans ${h} h ${m}`;
}

function renderRow(label, sub, j, options = {}) {
  if (!j) {
    return `
      <div class="last-train-row last-train-row--empty">
        <div class="last-train-row__line">${escapeHTML(label)}</div>
        <div class="last-train-row__empty">Service indisponible</div>
      </div>
    `;
  }
  return `
    <div class="last-train-row ${options.backup ? 'last-train-row--backup' : ''}">
      <div class="last-train-row__line">${escapeHTML(label)}${sub ? ` <small>${escapeHTML(sub)}</small>` : ''}</div>
      <div class="last-train-row__main">
        <span class="last-train-row__time">${fmtTime(j.depart)}</span>
        <span class="last-train-row__until">${escapeHTML(durationLabel(j.depart))}</span>
      </div>
      <div class="last-train-row__dest">arrivée ${fmtTime(j.arrive)}${j.direction ? ' · vers ' + escapeHTML(j.direction) : ''}</div>
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
        cacheBust('lastTrainData');
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
      const d = await loadAll(settings.idfm.apiKey);

      // Decide J primary/backup: if backup is later than primary, show as backup section
      let jRow = '';
      if (d.lastJFdo && d.lastJSh && d.lastJSh.depart > d.lastJFdo.depart) {
        jRow = renderRow('Transilien J', 'vers Conflans Fin d\'Oise', d.lastJFdo)
             + renderRow('Transilien J — backup', 'vers Conflans-Ste-Honorine', d.lastJSh, { backup: true });
      } else if (d.lastJFdo) {
        jRow = renderRow('Transilien J', 'vers Conflans Fin d\'Oise', d.lastJFdo);
      } else if (d.lastJSh) {
        jRow = renderRow('Transilien J', 'vers Conflans-Ste-Honorine', d.lastJSh, { backup: true });
      } else {
        jRow = renderRow('Transilien J', '', null);
      }

      const rerStationLabel = d.lastRer?.fromStation ? `depuis ${d.lastRer.fromStation}` : '';
      const rerRow = renderRow('RER A', rerStationLabel, d.lastRer?.summary);

      let n152Block = '';
      if (d.nextN152.length > 0) {
        const first = d.nextN152[0];
        const others = d.nextN152.slice(1, 3);
        n152Block = renderRow('Noctilien N152', 'depuis Saint-Lazare', first);
        if (others.length > 0) {
          n152Block += `<div class="last-train-extra">Autres N152 ce soir : ${
            others.map(o => fmtTime(o.depart)).join(' · ')
          }</div>`;
        }
      } else {
        n152Block = renderRow('Noctilien N152', 'depuis Saint-Lazare', null);
      }

      const html = `
        <div class="last-train-list">
          ${rerRow}
          ${jRow}
          ${n152Block}
        </div>
        <div class="last-train-foot">Horaires théoriques (planificateur IDFM). Pour le temps réel, vois "Trains retour".</div>
      `;
      this.setBody(html);

      // Subtitle: the latest of the lot
      const candidates = [];
      if (d.lastJFdo) candidates.push({ label: 'J', t: d.lastJFdo.depart });
      if (d.lastJSh)  candidates.push({ label: 'J-SH', t: d.lastJSh.depart });
      if (d.lastRer?.summary)  candidates.push({ label: 'RER A', t: d.lastRer.summary.depart });
      if (d.nextN152[0]) candidates.push({ label: 'N152', t: d.nextN152[0].depart });
      if (candidates.length === 0) {
        this.setSubtitle('aucune donnée');
      } else {
        candidates.sort((a, b) => b.t - a.t);
        const latest = candidates[0];
        this.setSubtitle(`dernier : ${latest.label} à ${fmtTime(latest.t)}`);
      }
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }
}
