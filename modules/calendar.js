import { getSettings, save } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, haptic, fetchWithTimeout } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

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

async function requestToken() {
  await loadGIS();
  const clientId = getSettings().calendar?.clientId;
  if (!clientId) throw new Error('CLIENT_ID_MISSING');
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
        } else {
          storeToken(resp);
          resolve(resp.access_token);
        }
      },
      error_callback: (err) => reject(new Error(err.message || 'Échec de connexion Google')),
    });
    client.requestAccessToken();
  });
}

async function fetchEvents() {
  let token = getStoredToken();
  if (!token) token = await requestToken();

  const calendarId = encodeURIComponent(getSettings().calendar?.calendarId || 'primary');
  const timeMin = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const timeMax = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=20`;
  const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 9000);
  if (resp.status === 401) {
    clearToken();
    token = await requestToken();
    return fetchEvents();
  }
  if (!resp.ok) throw new Error(`Agenda : HTTP ${resp.status}`);
  return resp.json();
}

function formatEventTime(ev) {
  if (ev.start.date) return 'Journée';
  const start = new Date(ev.start.dateTime);
  return start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Google Calendar standard event color palette (colorId 1..11 + default)
const GOOGLE_COLORS = {
  '1':  '#7986CB', // Lavender
  '2':  '#33B679', // Sage
  '3':  '#8E24AA', // Grape
  '4':  '#E67C73', // Flamingo
  '5':  '#F6BF26', // Banana
  '6':  '#F4511E', // Tangerine
  '7':  '#039BE5', // Peacock
  '8':  '#616161', // Graphite
  '9':  '#3F51B5', // Blueberry
  '10': '#0B8043', // Basil
  '11': '#D50000', // Tomato
};
const DEFAULT_EVENT_COLOR = '#7FD1B9'; // Bob accent (used when no colorId)

function eventColor(ev) {
  return GOOGLE_COLORS[ev.colorId] || DEFAULT_EVENT_COLOR;
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function groupByDay(events) {
  const groups = new Map();
  events.forEach(ev => {
    const d = ev.start.date ? new Date(ev.start.date) : new Date(ev.start.dateTime);
    const key = d.toDateString();
    if (!groups.has(key)) groups.set(key, { date: d, events: [] });
    groups.get(key).events.push(ev);
  });
  return Array.from(groups.values()).sort((a, b) => a.date - b.date);
}

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const diff = (target - today) / 86400000;
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export class CalendarWidget {
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
          <span class="card__title">Agenda</span>
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
        return;
      }
      if (e.target.closest('[data-action="signin"]')) {
        e.stopPropagation();
        haptic(8);
        this.signIn();
      }
    });
  }

  setSubtitle(text) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = text;
  }

  setBody(html) {
    const el = this.container.querySelector('[data-body]');
    if (el) el.innerHTML = html;
  }

  async signIn() {
    try {
      await requestToken();
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
          Connecte ton agenda Google via les <a href="#" data-open-settings>Réglages</a> : il faut un <strong>OAuth Client ID</strong> de ton projet Google Cloud (pas une clé API), et autoriser <code>${escapeHTML(location.origin)}</code> dans les origines JavaScript du client.
        </div>
      `);
      this.setSubtitle('non configuré');
      return;
    }

    if (!getStoredToken()) {
      this.setBody(`
        <div class="signin-block">
          <p class="signin-block__text">Connecte-toi à Google pour afficher ton agenda.</p>
          <button class="btn" type="button" data-action="signin">Se connecter à Google</button>
        </div>
      `);
      this.setSubtitle('non connecté');
      return;
    }

    this.setBody('<div class="card__loading">Chargement…</div>');
    try {
      const data = await fetchEvents();
      const events = data.items || [];
      if (events.length === 0) {
        this.setBody('<div class="card__empty">Aucun événement dans les 48 prochaines heures.</div>');
        this.setSubtitle('rien de prévu');
        return;
      }
      const groups = groupByDay(events);
      const html = groups.map(g => `
        <div class="event-group">
          <div class="event-group__label">${escapeHTML(dayLabel(g.date))}</div>
          <div class="event-list">
            ${g.events.map(ev => `
              <div class="event">
                <span class="event__dot" style="background:${eventColor(ev)}"></span>
                <div class="event__time">${escapeHTML(formatEventTime(ev))}</div>
                <div class="event__main">
                  <div class="event__title">${escapeHTML(ev.summary || '(sans titre)')}</div>
                  ${ev.location ? `<div class="event__location">${escapeHTML(ev.location)}</div>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');
      this.setBody(html);

      // Subtitle: next event
      const now = new Date();
      const next = events.find(ev => {
        const d = ev.start.date ? new Date(ev.start.date) : new Date(ev.start.dateTime);
        return d > now;
      });
      if (next) {
        const t = formatEventTime(next);
        const d = next.start.date ? new Date(next.start.date) : new Date(next.start.dateTime);
        const dl = isSameDay(d, now) ? `${t}` : `${dayLabel(d)} ${t}`;
        this.setSubtitle(`prochain : ${dl} · ${(next.summary || '').slice(0, 40)}`);
      } else {
        this.setSubtitle(`${events.length} événements`);
      }
    } catch (e) {
      if (e.message === 'CLIENT_ID_MISSING') {
        return this.refresh();
      }
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }
}
