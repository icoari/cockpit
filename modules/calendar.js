import { getSettings, save } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, haptic, fetchWithTimeout } from './util.js';

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

async function requestToken({ silent = false } = {}) {
  await loadGIS();
  const clientId = getSettings().calendar?.clientId;
  if (!clientId) throw new Error('CLIENT_ID_MISSING');
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error_description || resp.error));
        else { storeToken(resp); resolve(resp.access_token); }
      },
      error_callback: (err) => reject(new Error(err.type || err.message || 'oauth_error')),
    });
    if (silent) client.requestAccessToken({ prompt: '' });
    else        client.requestAccessToken();
  });
}

async function ensureToken() {
  let token = getStoredToken();
  if (token) return token;
  try { return await requestToken({ silent: true }); }
  catch { throw Object.assign(new Error('SIGN_IN_NEEDED'), { silent: true }); }
}

// ---------- Calendar API ----------
function calendarUrl(path = '') {
  const calId = encodeURIComponent(getSettings().calendar?.calendarId || 'primary');
  return `https://www.googleapis.com/calendar/v3/calendars/${calId}/events${path}`;
}

async function fetchEventsRange(timeMinIso, timeMaxIso) {
  let token = await ensureToken();
  const url = `${calendarUrl()}?timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 9000);
  if (resp.status === 401) {
    clearToken();
    try { token = await requestToken({ silent: true }); }
    catch { throw Object.assign(new Error('SIGN_IN_NEEDED'), { silent: true }); }
    return fetchEventsRange(timeMinIso, timeMaxIso);
  }
  if (!resp.ok) throw new Error(`Agenda : HTTP ${resp.status}`);
  return resp.json();
}

async function createEvent(title, dateIso) {
  const token = await ensureToken();
  const endDate = new Date(dateIso + 'T00:00:00');
  endDate.setDate(endDate.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  const endIso = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}`;
  const body = {
    summary: title,
    start: { date: dateIso },
    end:   { date: endIso },
  };
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
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

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

function isAllDay(ev) { return !!ev.start.date; }

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
        this.renderBody();
        return;
      }
      if (e.target.closest('[data-action="create-submit"]')) {
        e.stopPropagation();
        this.submitCreate();
        return;
      }
    });
  }

  toggleCreate() {
    this.createOpen = !this.createOpen;
    this.renderBody();
    if (this.createOpen) {
      setTimeout(() => {
        this.container.querySelector('[data-create-title]')?.focus();
      }, 50);
    }
  }

  async submitCreate() {
    const titleEl = this.container.querySelector('[data-create-title]');
    const dateEl  = this.container.querySelector('[data-create-date]');
    const title = titleEl?.value.trim();
    const date  = dateEl?.value;
    if (!title || !date) return;
    const submitBtn = this.container.querySelector('[data-action="create-submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await createEvent(title, date);
      this.createOpen = false;
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
      await requestToken({ silent: false });
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

  // Render the body part only — grid + selected day events + create form
  renderBody() {
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
      const d = getEventDate(ev);
      const key = toIso(d);
      if (!eventsByDay.has(key)) eventsByDay.set(key, []);
      eventsByDay.get(key).push(ev);
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
      .map(ev => ({ ev, d: getEventDate(ev) }))
      .filter(x => isSameDay(x.d, selectedDate))
      .sort((a, b) => {
        // All-day events first, then by time
        if (isAllDay(a.ev) && !isAllDay(b.ev)) return -1;
        if (!isAllDay(a.ev) && isAllDay(b.ev)) return 1;
        return a.d - b.d;
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

    return `
      <div class="cal-day-list">
        <div class="cal-day-list__label">${escapeHTML(label)}</div>
        <div class="event-list">
          ${dayEvents.map(({ ev }) => `
            <div class="event">
              <span class="event__dot" style="background:${eventColor(ev)}"></span>
              <div class="event__time">${escapeHTML(fmtEventTime(ev))}</div>
              <div class="event__main">
                <div class="event__title">${escapeHTML(ev.summary || '(sans titre)')}</div>
                ${ev.location ? `<div class="event__location">${escapeHTML(ev.location)}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  renderCreateForm() {
    const defaultDate = this.selectedDay;
    return `
      <div class="cal-create">
        <input class="input cal-create__title" type="text" placeholder="Titre de l'événement" data-create-title>
        <input class="input cal-create__date" type="date" value="${defaultDate}" data-create-date>
        <div class="btn-row">
          <button class="btn btn--ghost" type="button" data-action="create-cancel">Annuler</button>
          <button class="btn" type="button" data-action="create-submit">Créer</button>
        </div>
      </div>
    `;
  }
}
