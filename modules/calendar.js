import { getSettings, save } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, haptic, fetchWithTimeout } from './util.js';
import { WORKER_URL } from './sync.js';

// calendar.events scope = read + write events (no calendar settings changes).
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// ---------- Google Identity ----------
let gisLoadPromise = null;
function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Impossible de charger Google Identity Services'));
    document.head.appendChild(s);
  });
  return gisLoadPromise;
}

function getSyncToken() {
  try {
    const raw = localStorage.getItem('bob-sync-v1');
    const s = raw ? JSON.parse(raw) : null;
    return s?.authToken || null;
  } catch { return null; }
}

// Local cache of the short-lived access token (Worker mints these from the
// refresh token it holds — so this is just to avoid a round-trip per call).
function getStoredToken() {
  const t = getSettings().calendar?.token;
  if (!t || !t.access_token || !t.expires_at) return null;
  if (Date.now() > t.expires_at - 60_000) return null;
  return t.access_token;
}

function storeToken(resp) {
  const settings = getSettings();
  if (!settings.calendar) settings.calendar = {};
  settings.calendar.token = {
    access_token: resp.access_token,
    expires_at: Date.now() + (resp.expires_in || 3600) * 1000,
  };
  save();
}

function clearToken() {
  const settings = getSettings();
  if (settings.calendar) settings.calendar.token = null;
  save();
}

const SIGN_IN_NEEDED = () => Object.assign(new Error('SIGN_IN_NEEDED'), { silent: true });

// One-time interactive consent: GIS authorization-code flow (popup). The code
// goes to the Worker, which trades it for a refresh token + access token.
async function interactiveConnect() {
  await loadGIS();
  const clientId = getSettings().calendar?.clientId;
  if (!clientId) throw new Error('CLIENT_ID_MISSING');
  const code = await new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: SCOPE,
      ux_mode: 'popup',
      // access_type=offline + prompt=consent → Google returns a refresh token.
      access_type: 'offline',
      prompt: 'consent',
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error_description || resp.error));
        else if (resp.code) resolve(resp.code);
        else reject(new Error('no_code'));
      },
      error_callback: (err) => reject(new Error(err.type || err.message || 'oauth_error')),
    });
    client.requestCode();
  });

  const sync = getSyncToken();
  if (!sync) throw new Error('Active la sauvegarde cloud — l\'agenda passe par ton Worker.');
  const r = await fetch(`${WORKER_URL}/google/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sync}` },
    body: JSON.stringify({ code, clientId, redirectUri: 'postmessage' }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error || `Échange HTTP ${r.status}`);
  storeToken(data);
  return data.access_token;
}

// Silent: ask the Worker to mint a fresh access token from the stored refresh
// token. No user interaction. Throws SIGN_IN_NEEDED if there's no refresh
// token yet (or it was revoked).
async function refreshViaWorker() {
  const sync = getSyncToken();
  if (!sync) throw SIGN_IN_NEEDED();
  const clientId = getSettings().calendar?.clientId;
  let r;
  try {
    r = await fetch(`${WORKER_URL}/google/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sync}` },
      body: JSON.stringify({ clientId }),
    });
  } catch { throw SIGN_IN_NEEDED(); }
  if (r.status === 409) throw SIGN_IN_NEEDED();   // no/revoked refresh token
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw SIGN_IN_NEEDED();
  storeToken(data);
  return data.access_token;
}

async function ensureToken() {
  const token = getStoredToken();
  if (token) return token;
  return refreshViaWorker();
}

// ---------- Calendar API ----------
function calendarUrl(path = '') {
  const calId = encodeURIComponent(getSettings().calendar?.calendarId || 'primary');
  return `https://www.googleapis.com/calendar/v3/calendars/${calId}/events${path}`;
}

async function fetchEventsRange(timeMinIso, timeMaxIso, retried = false) {
  let token = await ensureToken();
  const url = `${calendarUrl()}?timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 9000);
  if (resp.status === 401) {
    // One silent retry only — mint a fresh token from the Worker's refresh
    // token. If that fails, the user must re-consent once.
    if (retried) throw SIGN_IN_NEEDED();
    clearToken();
    try { token = await refreshViaWorker(); }
    catch { throw SIGN_IN_NEEDED(); }
    return fetchEventsRange(timeMinIso, timeMaxIso, true);
  }
  if (!resp.ok) throw new Error(`Agenda : HTTP ${resp.status}`);
  return resp.json();
}

async function deleteEvent(eventId) {
  const token = await ensureToken();
  const url = `${calendarUrl()}/${encodeURIComponent(eventId)}`;
  const resp = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  }, 9000);
  // 204 No Content = success; 410 Gone = already deleted (treat as success)
  if (resp.status !== 204 && resp.status !== 410) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Suppression échouée (HTTP ${resp.status}) ${txt.slice(0, 120)}`);
  }
}

async function createEvent(title, startIso, endIso, colorId) {
  const token = await ensureToken();
  const pad = (n) => String(n).padStart(2, '0');
  // Last covered day (inclusive). Google end.date is exclusive, so add 1.
  const lastDay = endIso && endIso >= startIso ? endIso : startIso;
  const last = new Date(lastDay + 'T00:00:00');
  last.setDate(last.getDate() + 1);
  const exclusiveEnd = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;

  const body = {
    summary: title,
    start: { date: startIso },
    end:   { date: exclusiveEnd },
  };
  if (colorId) body.colorId = String(colorId);

  const resp = await fetchWithTimeout(calendarUrl(), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 9000);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Création échouée (HTTP ${resp.status}) ${txt.slice(0, 120)}`);
  }
  return resp.json();
}

// ---------- Date helpers ----------
const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

const pad2 = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function isSameDay(a, b) { return a.toDateString() === b.toDateString(); }

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function buildMonthGrid(year, month) {
  // First day of month, then back up to previous Monday.
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // 0 = Mon
  const start = new Date(year, month, 1 - firstWeekday);
  // 6 rows × 7 cols = 42 cells
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

function fmtMonth(y, m) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })
    .format(new Date(y, m, 1));
}

function getEventDate(ev) {
  if (ev.start.date) return new Date(ev.start.date + 'T00:00:00');
  return new Date(ev.start.dateTime);
}

function getEventEnd(ev) {
  if (ev.end?.date) return new Date(ev.end.date + 'T00:00:00');
  if (ev.end?.dateTime) return new Date(ev.end.dateTime);
  return null;
}

function isAllDay(ev) { return !!ev.start.date; }

// Returns the list of Date objects (00:00) the event covers.
// All-day events: end.date is exclusive (Google convention) — covers
// [start.date, end.date). Timed events: covers [start day, end day]
// (inclusive on both sides, except if end is exactly midnight).
function eventDays(ev) {
  const start = getEventDate(ev);
  const end = getEventEnd(ev);
  if (!end) {
    const d = new Date(start); d.setHours(0, 0, 0, 0);
    return [d];
  }
  const startDay = new Date(start); startDay.setHours(0, 0, 0, 0);
  let endDay;
  if (isAllDay(ev)) {
    // end.date is exclusive — last covered day is end - 1
    endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
    endDay.setDate(endDay.getDate() - 1);
  } else {
    endDay = new Date(end); endDay.setHours(0, 0, 0, 0);
    // If event ends at exactly midnight, don't count the end day
    if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
      endDay.setDate(endDay.getDate() - 1);
    }
  }
  if (endDay < startDay) endDay = new Date(startDay);
  const days = [];
  const cur = new Date(startDay);
  while (cur <= endDay) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function fmtEventTime(ev) {
  if (isAllDay(ev)) return 'Journée';
  return new Date(ev.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Google Calendar standard event color palette
const GOOGLE_COLORS = {
  '1':'#7986CB','2':'#33B679','3':'#8E24AA','4':'#E67C73','5':'#F6BF26',
  '6':'#F4511E','7':'#039BE5','8':'#616161','9':'#3F51B5','10':'#0B8043','11':'#D50000',
};
const DEFAULT_EVENT_COLOR = '#7FD1B9';
const eventColor = (ev) => GOOGLE_COLORS[ev.colorId] || DEFAULT_EVENT_COLOR;

// ---------- Widget ----------
export class CalendarWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.selectedDay = toIso(now);
    this.events = [];
    this.createOpen = false;
    this.createColorId = '';
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Agenda</span>
          <span class="card__subtitle">chargement…</span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="create" type="button" aria-label="Créer un événement">${ICONS.plus}</button>
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
        return;
      }
      if (e.target.closest('[data-action="create"]')) {
        e.stopPropagation();
        haptic(6);
        this.toggleCreate();
        return;
      }
      if (e.target.closest('[data-action="signin"]')) {
        e.stopPropagation();
        haptic(8);
        this.signIn();
        return;
      }
      const navBtn = e.target.closest('[data-cal-nav]');
      if (navBtn) {
        e.stopPropagation();
        haptic(4);
        const dir = navBtn.dataset.calNav === 'next' ? 1 : -1;
        let y = this.viewYear, m = this.viewMonth + dir;
        if (m < 0) { m = 11; y--; }
        else if (m > 11) { m = 0; y++; }
        this.viewYear = y; this.viewMonth = m;
        this.refresh();
        return;
      }
      const dayBtn = e.target.closest('[data-cal-day]');
      if (dayBtn) {
        e.stopPropagation();
        haptic(4);
        this.selectedDay = dayBtn.dataset.calDay;
        this.renderBody();
        return;
      }
      const colorBtn = e.target.closest('[data-cal-color]');
      if (colorBtn) {
        e.stopPropagation();
        haptic(2);
        this.createColorId = colorBtn.dataset.calColor;
        this.container.querySelectorAll('[data-cal-color]').forEach(b => {
          b.classList.toggle('cal-color--selected', b.dataset.calColor === this.createColorId);
        });
        return;
      }
      if (e.target.closest('[data-action="today"]')) {
        e.stopPropagation();
        haptic(4);
        const now = new Date();
        this.viewYear = now.getFullYear();
        this.viewMonth = now.getMonth();
        this.selectedDay = toIso(now);
        this.refresh();
        return;
      }
      if (e.target.closest('[data-action="create-cancel"]')) {
        e.stopPropagation();
        this.createOpen = false;
        this.createDraft = null;
        this.renderBody();
        return;
      }
      if (e.target.closest('[data-action="create-submit"]')) {
        e.stopPropagation();
        this.submitCreate();
        return;
      }
      const delBtn = e.target.closest('[data-cal-del]');
      if (delBtn) {
        e.stopPropagation();
        haptic(8);
        this.handleDelete(delBtn.dataset.calDel);
        return;
      }
    });
  }

  async handleDelete(eventId) {
    try {
      await deleteEvent(eventId);
      this.events = this.events.filter(e => e.id !== eventId);
      haptic(12);
      this.renderBody();
    } catch (e) {
      alert('Échec de la suppression : ' + e.message);
    }
  }

  toggleCreate() {
    this.createOpen = !this.createOpen;
    if (!this.createOpen) this.createDraft = null;
    this.renderBody();
    if (this.createOpen) {
      setTimeout(() => {
        this.container.querySelector('[data-create-title]')?.focus();
      }, 50);
    }
  }

  async submitCreate() {
    const titleEl = this.container.querySelector('[data-create-title]');
    const startEl = this.container.querySelector('[data-create-start]');
    const endEl   = this.container.querySelector('[data-create-end]');
    const title = titleEl?.value.trim();
    const startDate  = startEl?.value;
    const endDate    = endEl?.value || startDate;
    if (!title || !startDate) return;
    const submitBtn = this.container.querySelector('[data-action="create-submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await createEvent(title, startDate, endDate, this.createColorId);
      this.createOpen = false;
      this.createDraft = null;
      this.createColorId = '';
      haptic(12);
      await this.refresh();
    } catch (e) {
      alert('Échec de la création : ' + e.message);
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  setSubtitle(t) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = t;
  }
  setBody(html) {
    const el = this.container.querySelector('[data-body]');
    if (el) el.innerHTML = html;
  }

  async signIn() {
    try {
      await interactiveConnect();
      this.refresh();
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message || 'Échec de connexion')}</div>`);
      this.setSubtitle('erreur');
    }
  }

  async refresh() {
    const settings = getSettings();
    if (!settings.calendar?.clientId) {
      this.setBody(`
        <div class="card__empty">
          Connecte ton agenda Google via les <a href="#" data-open-settings>Réglages</a>.
        </div>
      `);
      this.setSubtitle('non configuré');
      return;
    }

    this.setBody('<div class="card__loading">Chargement…</div>');
    try {
      // Fetch the visible month +/- one week (covers grid edges + soon events)
      const monthStart = startOfMonth(new Date(this.viewYear, this.viewMonth, 1));
      const padStart = new Date(monthStart); padStart.setDate(padStart.getDate() - 7);
      const padEnd   = new Date(this.viewYear, this.viewMonth + 1, 7);
      const data = await fetchEventsRange(padStart.toISOString(), padEnd.toISOString());
      this.events = data.items || [];
      this.renderBody();
      // Subtitle: next event after now
      const now = new Date();
      const next = this.events
        .map(ev => ({ ev, d: getEventDate(ev) }))
        .filter(x => x.d >= now)
        .sort((a, b) => a.d - b.d)[0];
      if (next) {
        const t = fmtEventTime(next.ev);
        const dl = isSameDay(next.d, now)
          ? t
          : new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' }).format(next.d) + ' ' + t;
        this.setSubtitle(`prochain : ${dl} · ${(next.ev.summary || '').slice(0, 40)}`);
      } else {
        this.setSubtitle('rien à venir');
      }
    } catch (e) {
      if (e.message === 'SIGN_IN_NEEDED') {
        this.setBody(`
          <div class="signin-block">
            <p class="signin-block__text">Connecte-toi à Google pour afficher ton agenda.</p>
            <button class="btn" type="button" data-action="signin">Se connecter à Google</button>
          </div>
        `);
        this.setSubtitle('non connecté');
        return;
      }
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }

  // Render the body part only — grid + selected day events + create form.
  // Snapshot the create-form inputs first: tapping a day cell re-renders
  // and would otherwise wipe a half-typed event title.
  renderBody() {
    const titleEl = this.container.querySelector('[data-create-title]');
    const startEl = this.container.querySelector('[data-create-start]');
    const endEl   = this.container.querySelector('[data-create-end]');
    if (titleEl) {
      this.createDraft = { title: titleEl.value, start: startEl?.value || '', end: endEl?.value || '' };
    }
    const grid = this.renderGrid();
    const list = this.renderSelectedDayList();
    const createForm = this.createOpen ? this.renderCreateForm() : '';
    this.setBody(grid + createForm + list);
  }

  renderGrid() {
    const cells = buildMonthGrid(this.viewYear, this.viewMonth);
    const today = new Date();
    const todayIso = toIso(today);
    const eventsByDay = new Map();
    for (const ev of this.events) {
      for (const d of eventDays(ev)) {
        const key = toIso(d);
        if (!eventsByDay.has(key)) eventsByDay.set(key, []);
        eventsByDay.get(key).push(ev);
      }
    }
    const monthLabel = fmtMonth(this.viewYear, this.viewMonth);
    const cellsHtml = cells.map(d => {
      const iso = toIso(d);
      const dayEvents = eventsByDay.get(iso) || [];
      const otherMonth = d.getMonth() !== this.viewMonth;
      const isToday = iso === todayIso;
      const isSelected = iso === this.selectedDay;
      const cls = ['cal-day'];
      if (otherMonth) cls.push('cal-day--other');
      if (isToday) cls.push('cal-day--today');
      if (isSelected) cls.push('cal-day--selected');
      if (dayEvents.length) cls.push('cal-day--has');
      const dots = dayEvents.slice(0, 3).map(ev =>
        `<span class="cal-day__dot" style="background:${eventColor(ev)}"></span>`
      ).join('');
      return `
        <button class="${cls.join(' ')}" data-cal-day="${iso}" type="button">
          <span class="cal-day__num">${d.getDate()}</span>
          <span class="cal-day__dots">${dots}</span>
        </button>
      `;
    }).join('');

    return `
      <div class="cal-grid">
        <div class="cal-grid__nav">
          <button class="cal-nav-btn" data-cal-nav="prev" type="button" aria-label="Mois précédent">‹</button>
          <span class="cal-grid__title">${escapeHTML(monthLabel)}</span>
          <button class="cal-today-btn" data-action="today" type="button">Aujourd'hui</button>
          <button class="cal-nav-btn" data-cal-nav="next" type="button" aria-label="Mois suivant">›</button>
        </div>
        <div class="cal-grid__weekdays">
          ${WEEKDAYS.map(w => `<span>${w}</span>`).join('')}
        </div>
        <div class="cal-grid__days">${cellsHtml}</div>
      </div>
    `;
  }

  renderSelectedDayList() {
    const selectedDate = new Date(this.selectedDay + 'T00:00:00');
    const dayEvents = this.events
      .filter(ev => eventDays(ev).some(d => isSameDay(d, selectedDate)))
      .sort((a, b) => {
        if (isAllDay(a) && !isAllDay(b)) return -1;
        if (!isAllDay(a) && isAllDay(b)) return 1;
        return getEventDate(a) - getEventDate(b);
      });
    const label = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
      .format(selectedDate);

    if (dayEvents.length === 0) {
      return `
        <div class="cal-day-list">
          <div class="cal-day-list__label">${escapeHTML(label)}</div>
          <div class="card__empty">Aucun événement ce jour.</div>
        </div>
      `;
    }

    const dayLabelShort = (d) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(d);

    return `
      <div class="cal-day-list">
        <div class="cal-day-list__label">${escapeHTML(label)}</div>
        <div class="event-list">
          ${dayEvents.map(ev => {
            const days = eventDays(ev);
            const multi = days.length > 1;
            let spanInfo = '';
            if (multi) {
              const first = days[0];
              const last = days[days.length - 1];
              const isFirst = isSameDay(first, selectedDate);
              const isLast  = isSameDay(last,  selectedDate);
              if (isFirst) spanInfo = `→ jusqu'au ${dayLabelShort(last)}`;
              else if (isLast) spanInfo = `depuis le ${dayLabelShort(first)} →`;
              else {
                const dayIdx = days.findIndex(d => isSameDay(d, selectedDate)) + 1;
                spanInfo = `jour ${dayIdx} / ${days.length} · jusqu'au ${dayLabelShort(last)}`;
              }
            }
            const timeLabel = multi ? '' : fmtEventTime(ev);
            return `
              <div class="event ${multi ? 'event--multi' : ''}">
                <span class="event__dot" style="background:${eventColor(ev)}"></span>
                <div class="event__time">${escapeHTML(timeLabel || (isAllDay(ev) ? 'Journée' : ''))}</div>
                <div class="event__main">
                  <div class="event__title">${escapeHTML(ev.summary || '(sans titre)')}</div>
                  ${spanInfo ? `<div class="event__span">${escapeHTML(spanInfo)}</div>` : ''}
                  ${ev.location ? `<div class="event__location">${escapeHTML(ev.location)}</div>` : ''}
                </div>
                <button class="event__del" type="button" data-cal-del="${escapeHTML(ev.id)}" aria-label="Supprimer">${ICONS.trash}</button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderCreateForm() {
    const draft = this.createDraft || {};
    const defaultDate = draft.start || this.selectedDay;
    const colorChoices = [
      { id: '', color: '#7FD1B9', label: 'Par défaut' },
      { id: '1',  color: GOOGLE_COLORS['1'],  label: 'Lavande' },
      { id: '2',  color: GOOGLE_COLORS['2'],  label: 'Sauge' },
      { id: '10', color: GOOGLE_COLORS['10'], label: 'Basilic' },
      { id: '7',  color: GOOGLE_COLORS['7'],  label: 'Paon' },
      { id: '9',  color: GOOGLE_COLORS['9'],  label: 'Myrtille' },
      { id: '3',  color: GOOGLE_COLORS['3'],  label: 'Raisin' },
      { id: '4',  color: GOOGLE_COLORS['4'],  label: 'Flamant' },
      { id: '5',  color: GOOGLE_COLORS['5'],  label: 'Banane' },
      { id: '6',  color: GOOGLE_COLORS['6'],  label: 'Mandarine' },
      { id: '11', color: GOOGLE_COLORS['11'], label: 'Tomate' },
      { id: '8',  color: GOOGLE_COLORS['8'],  label: 'Graphite' },
    ];
    const colorsHtml = colorChoices.map(c => `
      <button class="cal-color ${c.id === this.createColorId ? 'cal-color--selected' : ''}"
              data-cal-color="${c.id}"
              style="background:${c.color}"
              type="button"
              title="${escapeHTML(c.label)}"
              aria-label="${escapeHTML(c.label)}"></button>
    `).join('');
    return `
      <div class="cal-create">
        <input class="input cal-create__title" type="text" placeholder="Titre de l'événement" data-create-title value="${escapeHTML(draft.title || '')}">
        <div class="cal-create__dates">
          <input class="input" type="date" value="${escapeHTML(draft.start || defaultDate)}" data-create-start>
          <span class="cal-create__sep">→</span>
          <input class="input" type="date" value="${escapeHTML(draft.end || defaultDate)}" data-create-end>
        </div>
        <div class="cal-create__colors">${colorsHtml}</div>
        <div class="btn-row">
          <button class="btn btn--ghost" type="button" data-action="create-cancel">Annuler</button>
          <button class="btn" type="button" data-action="create-submit">Créer</button>
        </div>
      </div>
    `;
  }
}
