// Accueil — the assistant landing page. Gathers a snapshot of the day
// (weather, agenda, trains, top brief items, project status) and lets the
// LLM open with a 2-3 sentence contextual opener.

import { ICONS, weatherCodeIcon } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic, safeUrl } from './util.js';
import { getSettings, getState, cacheGet, cacheSet } from './state.js';
import { isConfigured as llmConfigured, complete } from './llm.js';
import { nextJAndRer } from './trains.js';

async function getTransport() {
  const cached = cacheGet('home_transport', 60 * 1000);
  if (cached) return cached;
  try {
    const t = await nextJAndRer();
    if (t) cacheSet('home_transport', t);
    return t;
  } catch { return null; }
}

const GREETING_KEY = 'bob-home-greeting-v1';
const GREETING_TTL_MS = 4 * 3600 * 1000;       // 4 h fresh
const GREETING_HARD_TTL_MS = 16 * 3600 * 1000; // older than that → always regen

function loadGreeting() {
  try {
    const raw = localStorage.getItem(GREETING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveGreeting(g) {
  try { localStorage.setItem(GREETING_KEY, JSON.stringify(g)); } catch {}
}

const SYSTEM_HOME = `Tu écris l'ouverture du tableau de bord de Nicolas, ingénieur IA et automatisation (LiteLLM, n8n, modèles génératifs).
3 phrases maximum, en français, texte plat. Pas de Markdown, pas d'emoji, pas de « Bonjour ».
Style : neutre, factuel, précis. Tu pointes ce qui compte aujourd'hui en t'appuyant sur les données fournies. Tu peux suggérer une priorité concrète.
Interdit : flatterie, généralités, formules creuses, "à ne pas manquer".`;

function weatherLabelFromCode(c) {
  if (c === 0 || c === 1) return 'clair';
  if (c === 2) return 'partiel';
  if (c === 3) return 'couvert';
  if (c === 45 || c === 48) return 'brouillard';
  if (c >= 51 && c <= 67) return 'pluie';
  if (c >= 80 && c <= 82) return 'averses';      // before the snow range — 80-82 is rain showers
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'neige';
  if (c >= 95) return 'orage';
  return 'changeant';
}

async function fetchWeather() {
  const cached = cacheGet('home_weather2', 30 * 60 * 1000);
  if (cached) return cached;
  const loc = getSettings().location || {};
  if (!loc.lat || !loc.lon) return null;
  try {
    const r = await fetchWithTimeout(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`,
      {}, 4000,
    );
    if (!r.ok) return null;
    const d = await r.json();
    const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const out = {
      temp: Math.round(d.current?.temperature_2m ?? 0),
      code: d.current?.weather_code ?? 0,
      tMax: num(d.daily?.temperature_2m_max?.[0]),
      tMin: num(d.daily?.temperature_2m_min?.[0]),
    };
    cacheSet('home_weather2', out);
    return out;
  } catch { return null; }
}

function getDigestHeadlines() {
  try {
    const raw = localStorage.getItem('bob-digest-v2');
    if (!raw) return [];
    const d = JSON.parse(raw);
    return (d.headlines || []).slice(0, 2);
  } catch { return []; }
}

function getProjectStats() {
  const out = {};
  try {
    const raw = localStorage.getItem('health-tracker-v1');
    const data = raw ? JSON.parse(raw) : null;
    const entries = data?.entries || {};
    const events = Array.isArray(data?.events) ? data.events : [];
    const days = Object.keys(entries);
    const total = days.reduce((s, d) => s + Object.keys(entries[d] || {}).length, 0) + events.length;
    if (total === 0) {
      out.health = { label: 'Suivi santé', sub: 'Aucune entrée', accent: 'p-health' };
    } else {
      // Parse as LOCAL midnight — new Date('YYYY-MM-DD') is UTC midnight and
      // undercounts by one day in UTC+ timezones.
      const [sy, sm, sd] = (data?.startDate || '2026-05-14').split('-').map(Number);
      const startDate = new Date(sy, sm - 1, sd);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const dayN = Math.max(1, Math.floor((today - startDate) / 86400000) + 1);
      const phase = dayN <= 31 ? `Jour ${dayN} / 31` : `J+${dayN - 31} post-traitement`;
      out.health = { label: 'Suivi santé', sub: `${phase} · ${total} entrées`, accent: 'p-health' };
    }
  } catch {}
  try {
    const raw = localStorage.getItem('bob-writer-v1');
    const data = raw ? JSON.parse(raw) : null;
    const chapters = data?.chapters || [];
    if (chapters.length === 0) {
      out.writer = { label: 'Écrire', sub: 'Aucun chapitre', accent: 'p-writer' };
    } else {
      const words = chapters.reduce((s, c) => s + (c.content || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const wlabel = words >= 1000 ? (words / 1000).toFixed(1).replace('.0', '') + 'k mots' : `${words} mots`;
      out.writer = { label: 'Écrire', sub: `${chapters.length} chapitre${chapters.length > 1 ? 's' : ''} · ${wlabel}`, accent: 'p-writer' };
    }
  } catch {}
  try {
    // Trackers live at the state root, not under settings.
    const trackers = getState().trackers || {};
    const last = trackers.coiffeur;
    out.coiffeur = last
      ? { label: 'Coiffeur', sub: ago(last), accent: 'p-beiue' }
      : null;
  } catch {}
  return out;
}

function ago(dateISO) {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const n = Math.floor((today - that) / 86400000);
  if (n <= 0) return "aujourd'hui";
  if (n === 1) return 'hier';
  return `il y a ${n} jours`;
}

function tinyMd(s) {
  return escapeHTML(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

export class HomeWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('home-shell');
    this.context = null;
    this.greeting = loadGreeting();
    this.greetingBusy = false;
    this.firstBoot = true;
    this.render();
    this.bootstrap();

    // The other widgets (trains, calendar) fetch asynchronously — catch
    // their data as it lands with a few staggered early refreshes, then
    // keep the page alive with a 60 s soft refresh.
    [2500, 6000, 12000].forEach(ms => setTimeout(() => this.softRefresh(), ms));
    setInterval(() => {
      if (!document.hidden) this.softRefresh();
    }, 60_000);
  }

  // Re-gather context and re-render the data sections without touching
  // the greeting (which has its own TTL logic).
  async softRefresh() {
    this.context = await this.gatherContext();
    this.renderTiles();
    this.renderPrios();
    this.renderProjects();
    if (this.shouldRegenerate()) this.regenerateGreeting();
  }

  render() {
    this.container.innerHTML = `
      <section class="home-greeting" data-greeting>
        <span class="home-greeting__eyebrow">Aujourd'hui</span>
        <div class="home-greeting__body" data-greeting-body>
          ${this.greeting?.text ? tinyMd(this.greeting.text) : '<p class="home-greeting__placeholder">Ouverture en préparation…</p>'}
        </div>
        <button class="home-greeting__refresh" type="button" data-action="refresh-greeting" aria-label="Régénérer l'ouverture">${ICONS.refresh}</button>
      </section>

      <section class="home-section" data-section="quick">
        <div class="home-section__head"><span class="home-section__label">Accès rapide</span></div>
        <div class="home-quick">
          <button class="home-quick__btn home-quick__btn--health" type="button" data-home-voice>
            <span class="home-quick__icon">${ICONS.mic}</span><span class="home-quick__label">Dicter santé</span>
          </button>
          <button class="home-quick__btn home-quick__btn--event" type="button" data-home-event>
            <span class="home-quick__icon">${ICONS.mic}</span><span class="home-quick__label">Dicter event</span>
          </button>
          <button class="home-quick__btn home-quick__btn--memory" type="button" data-home-memory>
            <span class="home-quick__icon">${ICONS.brain}</span><span class="home-quick__label">Mémoire</span>
          </button>
        </div>
      </section>

      <div class="home-tiles" data-tiles></div>

      <section class="home-section" data-section="prios">
        <div class="home-section__head"><span class="home-section__label">À lire prio</span></div>
        <div class="home-section__body" data-prios>—</div>
      </section>

      <section class="home-section" data-section="projects">
        <div class="home-section__head"><span class="home-section__label">Projets</span></div>
        <div class="home-projects" data-projects>—</div>
      </section>
    `;
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh-greeting"]')) {
        e.preventDefault(); e.stopPropagation();
        haptic(4);
        this.regenerateGreeting(true);
        return;
      }
      if (e.target.closest('[data-home-voice]')) {
        haptic(6);
        document.dispatchEvent(new CustomEvent('bob-open-project', { detail: { project: 'health', voice: true } }));
        return;
      }
      if (e.target.closest('[data-home-event]')) {
        haptic(6);
        document.dispatchEvent(new CustomEvent('bob-dicter-event'));
        return;
      }
      if (e.target.closest('[data-home-memory]')) {
        haptic(6);
        document.dispatchEvent(new CustomEvent('bob-open-project', { detail: { project: 'memory' } }));
        return;
      }
      const tile = e.target.closest('[data-goto]');
      if (tile && tile.dataset.goto) {
        haptic(4);
        document.dispatchEvent(new CustomEvent('bob-goto-tab', { detail: { tab: tile.dataset.goto } }));
        return;
      }
      const card = e.target.closest('[data-home-project]');
      if (card) {
        document.dispatchEvent(new CustomEvent('bob-open-project', { detail: { project: card.dataset.homeProject } }));
      }
    });
  }

  async bootstrap() {
    this.context = await this.gatherContext();
    this.renderTiles();
    this.renderPrios();
    this.renderProjects();
    if (this.shouldRegenerate()) {
      // On first mount, give the other widgets a moment to fetch their data
      // so the prompt has something to work with (calendar events, train
      // departures, headlines). After that, regenerate immediately on each
      // refresh — the data is already populated.
      if (this.firstBoot) {
        this.firstBoot = false;
        setTimeout(() => this.regenerateGreeting(), 2500);
      } else {
        this.regenerateGreeting();
      }
    }
  }

  shouldRegenerate() {
    if (!llmConfigured()) return false;
    if (!this.greeting?.generatedAt) return true;
    const age = Date.now() - this.greeting.generatedAt;
    if (age > GREETING_HARD_TTL_MS) return true;
    if (age > GREETING_TTL_MS) {
      const last = new Date(this.greeting.generatedAt).toDateString();
      return last !== new Date().toDateString();
    }
    // Also regenerate if the cached greeting was built on a thin context but
    // we now have real data to work with.
    if (this.greeting.thin && this.hasMeaningfulContext()) return true;
    return false;
  }

  hasMeaningfulContext() {
    const c = this.context;
    if (!c) return false;
    return !!(c.weather || c.transport || (c.headlines && c.headlines.length));
  }

  async gatherContext() {
    const [weather, transport] = await Promise.all([fetchWeather(), getTransport()]);
    return {
      weather,
      transport,
      headlines: getDigestHeadlines(),
      projects: getProjectStats(),
      now: new Date(),
    };
  }

  renderTiles() {
    const el = this.container.querySelector('[data-tiles]');
    if (!el) return;
    const c = this.context;

    const w = c.weather;
    const minmax = (w && w.tMin != null && w.tMax != null)
      ? `<span class="home-weather__minmax"><span>↓&nbsp;${w.tMin}°</span><span>↑&nbsp;${w.tMax}°</span></span>`
      : '';
    const hour = (c.now || new Date()).getHours();
    const isDay = hour >= 7 && hour < 21;
    const weatherTile = w ? `
      <button class="home-tile home-tile--weather" type="button" data-goto="perso">
        <span class="home-tile__label">Météo</span>
        <span class="home-weather__main">
          <span class="home-weather__temp">${w.temp}°</span>
          <span class="home-weather__icon">${weatherCodeIcon(w.code, isDay)}</span>
        </span>
        <span class="home-tile__sub">${escapeHTML(weatherLabelFromCode(w.code))}</span>
        ${minmax}
      </button>` : '';

    el.innerHTML = weatherTile + this.transportTile(c.transport);
  }

  // Wide tile: next Transilien J + next RER A, for the direction that matches
  // the current location (toward Paris from home, toward Conflans from Paris).
  transportTile(tr) {
    const dirLabel = tr ? (tr.direction === 'retour' ? '→ Conflans' : '→ Paris') : '';
    // Small destination label only for the RER A in the Paris→Conflans sense
    // (its western branches differ — useful to see which one).
    const rerRetour = !!tr && tr.direction === 'retour';
    const row = (kind, dep, showLabel) => {
      const name = kind === 'j' ? 'J' : 'RER A';
      if (!dep) {
        return `<div class="home-train"><span class="home-train__line line-${kind}">${name}</span><span class="home-train__time">—</span><span class="home-train__in">—</span></div>`;
      }
      const mins = Math.round((dep.expectedMs - Date.now()) / 60000);
      const time = new Date(dep.expectedMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const when = dep.cancelled ? 'supprimé' : (mins <= 0 ? 'à quai' : mins <= 1 ? 'imminent' : `${mins} min`);
      const label = (showLabel && dep.destination)
        ? `<span class="home-train__dest">${escapeHTML(dep.destination)}</span>` : '';
      return `<div class="home-train ${dep.cancelled ? 'home-train--cancel' : ''}">
        <span class="home-train__line line-${kind}">${name}</span>
        <span class="home-train__time">${time}</span>
        ${label}
        <span class="home-train__in">${when}</span>
      </div>`;
    };
    const body = tr
      ? `<div class="home-trains">${row('j', tr.j, false)}${row('rer', tr.rer, rerRetour)}</div>`
      : `<div class="home-train__empty">Prochains départs · ouvre Trains</div>`;
    return `
      <button class="home-tile home-tile--wide" type="button" data-goto="trains">
        <span class="home-tile__label">Prochains départs ${escapeHTML(dirLabel)}</span>
        ${body}
      </button>`;
  }

  renderPrios() {
    const el = this.container.querySelector('[data-prios]');
    if (!el) return;
    const heads = this.context.headlines;
    if (!heads.length) {
      el.innerHTML = `<p class="home-empty">Ouvre <strong>Pro</strong> pour générer l'éditorial du jour.</p>`;
      return;
    }
    el.innerHTML = heads.map(h => {
      const href = safeUrl(h.url);
      if (!href) return '';
      return `
      <a class="home-prio" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">
        <span class="home-prio__source">${escapeHTML(h.source || '')} · ${escapeHTML(timeAgo(new Date(h.date)))}</span>
        <span class="home-prio__title">${escapeHTML(h.title || '')}</span>
        ${h.why ? `<span class="home-prio__why">${escapeHTML(h.why)}</span>` : ''}
      </a>
    `;
    }).join('');
  }

  renderProjects() {
    const el = this.container.querySelector('[data-projects]');
    if (!el) return;
    const p = this.context.projects;
    const cards = [];
    if (p.health)   cards.push(this.projectCard('health',   p.health));
    if (p.writer)   cards.push(this.projectCard('writer',   p.writer));
    if (p.coiffeur) cards.push(this.projectCard('coiffeur-info', p.coiffeur, false));
    el.innerHTML = cards.join('');
  }

  projectCard(key, info, tappable = true) {
    const tag = tappable ? 'button' : 'div';
    const attrs = tappable ? `type="button" data-home-project="${escapeHTML(key)}"` : '';
    return `
      <${tag} class="home-project home-project--${escapeHTML(info.accent)}" ${attrs}>
        <span class="home-project__label">${escapeHTML(info.label)}</span>
        <span class="home-project__sub">${escapeHTML(info.sub)}</span>
      </${tag}>
    `;
  }

  async regenerateGreeting(force = false) {
    if (this.greetingBusy) return;
    if (!llmConfigured()) {
      const body = this.container.querySelector('[data-greeting-body]');
      if (body) body.innerHTML = `<p class="home-greeting__placeholder">Configure l'assistant dans Réglages pour activer l'ouverture du jour.</p>`;
      return;
    }
    this.greetingBusy = true;
    const body = this.container.querySelector('[data-greeting-body]');
    const refreshBtn = this.container.querySelector('[data-action="refresh-greeting"]');
    if (refreshBtn) refreshBtn.classList.add('home-greeting__refresh--busy');
    if (body && (!this.greeting?.text || force)) {
      body.innerHTML = `<p class="home-greeting__placeholder">Lecture du contexte…</p>`;
    }
    try {
      if (!this.context) this.context = await this.gatherContext();
      const prompt = buildGreetingPrompt(this.context);
      const text = await complete(
        [
          { role: 'system', content: SYSTEM_HOME },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.45, maxTokens: 220 },
      );
      const trimmed = (text || '').trim();
      const thin = !this.hasMeaningfulContext();
      this.greeting = { text: trimmed, generatedAt: Date.now(), thin };
      // Don't bake an obviously-empty context into the 4 h cache — the next
      // refresh will replace it as soon as we have real data.
      if (!thin) saveGreeting(this.greeting);
      if (body) body.innerHTML = tinyMd(trimmed);
    } catch (e) {
      if (body) body.innerHTML = `<p class="home-greeting__placeholder" style="color:var(--danger)">Échec : ${escapeHTML(e.message)}</p>`;
    } finally {
      this.greetingBusy = false;
      if (refreshBtn) refreshBtn.classList.remove('home-greeting__refresh--busy');
    }
  }

  refresh() {
    return this.bootstrap();
  }
}

function buildGreetingPrompt(c) {
  const lines = [];
  const today = c.now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const hh = c.now.getHours();
  const moment = hh < 11 ? 'matin' : hh < 14 ? 'midi' : hh < 18 ? 'après-midi' : 'soir';
  lines.push(`Date : ${today}, ${moment} (${hh}h).`);
  if (c.weather) lines.push(`Météo : ${c.weather.temp}°C, ${weatherLabelFromCode(c.weather.code)}.`);
  if (c.headlines && c.headlines.length) {
    lines.push(`Actu tech du jour :`);
    c.headlines.forEach(h => lines.push(`- ${h.source} — ${h.title}${h.why ? ' (' + h.why + ')' : ''}`));
  }
  // Volontairement SANS trains, agenda ni écriture — l'ouverture parle surtout
  // de l'actu tech (et de la météo).
  return lines.join('\n') + `\n\nDonne 2 à 3 phrases d'ouverture, factuelles, centrées sur l'actu tech qui compte ce ${moment}. N'invente pas de rendez-vous ni d'agenda.`;
}
