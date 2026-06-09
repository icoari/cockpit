// Pro page — unified feed (videos + papers + articles + HN) with a daily
// brief on top and smart filters. Replaces the old YouTube + AI watch + HN
// stack with a single signal-first surface.

import { ICONS } from './icons.js';
import { escapeHTML, timeAgo, haptic, debounce, fetchWithTimeout } from './util.js';
import { fetchFeed, pushSources } from './feed.js';
import { isConfigured as llmConfigured, complete } from './llm.js';
import { streamBrief } from './briefing.js';
import { markAiRead, isAiRead, setFeedSearch, getFeedSearch, getSettings } from './state.js';
import { isSyncEnabled } from './sync.js';

const TAB_CHIPS = [
  { id: 'all',     label: 'Tout',     match: () => true },
  { id: 'video',   label: 'Vidéos',   match: it => it.kind === 'video' },
  { id: 'paper',   label: 'Papers',   match: it => it.kind === 'article' && /arxiv|huggingface\.co\/papers/i.test(it.url) },
  { id: 'article', label: 'Articles', match: it => it.kind === 'article' && !/arxiv/i.test(it.url) },
  { id: 'hn',      label: 'HN',       match: it => it.kind === 'hn' },
];

function tinyMd(s) {
  // Compact-only markdown — bold, lists, paragraphs.
  let html = escapeHTML(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '</p><p>');
  // bullet lists
  html = html.replace(/(?:^|<p>)((?:- [^\n]+\n?)+)(<\/p>|$)/g, (m, list) => {
    const items = list.split('\n').filter(Boolean).map(l => l.replace(/^- /, '')).map(li => `<li>${li}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  return `<p>${html}</p>`;
}

function itemBadge(it) {
  if (it.kind === 'video') return { icon: ICONS.play || ICONS.zap, color: 'video' };
  if (it.kind === 'hn')    return { icon: ICONS.zap,  color: 'hn' };
  if (it.url && /arxiv/i.test(it.url)) return { icon: ICONS.note, color: 'paper' };
  return { icon: ICONS.newspaper, color: 'article' };
}

function renderCard(it) {
  const read = isAiRead(it.url);
  const badge = itemBadge(it);
  const time = timeAgo(new Date(it.date));
  const lang = it.lang === 'fr' ? '<span class="pro-card__lang">FR</span>' : '';
  const meta = it.kind === 'hn'
    ? `${escapeHTML(it.domain || 'news.ycombinator.com')} · ${it.points || 0} pts · ${it.comments || 0} comm.`
    : escapeHTML(it.source || '');
  const thumb = it.thumbnail
    ? `<div class="pro-card__thumb" style="background-image:url('${escapeHTML(it.thumbnail)}')"></div>`
    : `<div class="pro-card__thumb pro-card__thumb--${badge.color}">${badge.icon}</div>`;
  const summary = it.summary && it.kind !== 'video'
    ? `<div class="pro-card__summary">${escapeHTML(it.summary)}</div>`
    : '';
  return `
    <a class="pro-card ${read ? 'pro-card--read' : ''} pro-card--${badge.color}"
       href="${escapeHTML(it.url)}" target="_blank" rel="noopener noreferrer"
       data-url="${escapeHTML(it.url)}" data-id="${escapeHTML(it.id || it.url)}">
      ${thumb}
      <div class="pro-card__body">
        <div class="pro-card__meta">
          <span class="pro-card__source">${meta}</span>
          ${lang}
          <span class="pro-card__time">${escapeHTML(time)}</span>
        </div>
        <div class="pro-card__title">${escapeHTML(it.title || '(sans titre)')}</div>
        ${summary}
      </div>
    </a>
  `;
}

export class ProWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card', 'pro-shell');
    this.items = [];
    this.activeChip = 'all';
    this.activeSource = null;
    this.search = getFeedSearch('pro') || '';
    this.brief = null;          // markdown
    this.briefAt = null;        // timestamp
    this.briefBusy = false;
    this.render();
    this.attach();
    this.bootstrap();
  }

  render() {
    this.container.innerHTML = `
      <div class="pro-head">
        <div class="pro-head__title">
          <span class="pro-head__eyebrow">Veille</span>
          <span class="pro-head__total" data-total>—</span>
        </div>
        <div class="pro-head__actions">
          <button class="pro-iconbtn" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>

      <div class="brief-card ${this.brief ? '' : 'brief-card--empty'}" data-brief-card>
        <div class="brief-card__head">
          <span class="brief-card__eyebrow">Brief du jour</span>
          <button class="brief-card__action" data-action="brief" type="button">
            <span data-brief-label>${this.brief ? 'Régénérer' : 'Générer'}</span>
          </button>
        </div>
        <div class="brief-card__body" data-brief-body>
          ${this.brief
            ? tinyMd(this.brief)
            : '<p class="brief-card__placeholder">Sélection éditoriale des dernières 48 h, condensée en 3 sections : prio, signal secondaire, à skipper.</p>'}
        </div>
      </div>

      <div class="pro-search">
        <span class="pro-search__icon">${ICONS.search}</span>
        <input class="pro-search__input" type="search" placeholder="Filtrer titres, sources, mots-clés…" data-search>
      </div>

      <div class="pro-chips" data-chips></div>

      <div class="pro-list" data-list><div class="card__loading">Chargement…</div></div>
    `;
    this.container.querySelector('[data-search]').value = this.search;
  }

  attach() {
    this.container.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'refresh') {
        e.preventDefault(); e.stopPropagation();
        haptic(6);
        await this.bootstrap({ force: true });
        return;
      }
      if (action === 'brief') {
        e.preventDefault(); e.stopPropagation();
        haptic(6);
        this.runBrief();
        return;
      }
      const chip = e.target.closest('[data-chip]');
      if (chip) {
        e.preventDefault(); e.stopPropagation();
        haptic(4);
        const id = chip.dataset.chip;
        const type = chip.dataset.chipType;
        if (type === 'src') {
          this.activeSource = this.activeSource === id ? null : id;
        } else {
          this.activeChip = id;
          this.activeSource = null;
        }
        this.renderChips();
        this.renderList();
        return;
      }
      const card = e.target.closest('[data-url]');
      if (card) markAiRead(card.dataset.url);
    });

    const input = this.container.querySelector('[data-search]');
    input.addEventListener('input', debounce(() => {
      this.search = input.value.trim();
      setFeedSearch('pro', this.search);
      this.renderList();
    }, 200));
  }

  async bootstrap({ force = false } = {}) {
    const listEl = this.container.querySelector('[data-list]');
    if (!isSyncEnabled()) {
      listEl.innerHTML = `
        <div class="card__empty">
          Active la sauvegarde cloud dans <a href="#" data-open-settings>Réglages</a> pour activer le feed agrégé.
        </div>`;
      return;
    }
    listEl.innerHTML = '<div class="card__loading">Agrégation en cours…</div>';
    try {
      pushSources();   // fire & forget — keep Worker's source list current
      let data = await fetchFeed({ force });
      // Cold KV → trigger an aggregation right now and re-read.
      if ((data.items || []).length === 0 && data.stale) {
        listEl.innerHTML = '<div class="card__loading">Première agrégation côté edge…</div>';
        data = await fetchFeed({ force: true });
      }
      this.items = data.items || [];
      if (this.items.length === 0) {
        listEl.innerHTML = '<div class="card__empty">Pas encore d\'items. Vérifie que tes sources sont actives dans Réglages.</div>';
        return;
      }
      this.renderChips();
      this.renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="card__error">${escapeHTML(e.message || 'Erreur de chargement')}</div>`;
    }
  }

  filtered() {
    const chipDef = TAB_CHIPS.find(c => c.id === this.activeChip) || TAB_CHIPS[0];
    const q = this.search.toLowerCase();
    return this.items.filter(it => {
      if (!chipDef.match(it)) return false;
      if (this.activeSource && it.sourceId !== this.activeSource) return false;
      if (q) {
        const t = (it.title || '').toLowerCase();
        const s = (it.summary || '').toLowerCase();
        const src = (it.source || '').toLowerCase();
        if (!t.includes(q) && !s.includes(q) && !src.includes(q)) return false;
      }
      return true;
    });
  }

  renderChips() {
    const chipsEl = this.container.querySelector('[data-chips]');
    const counts = {};
    for (const c of TAB_CHIPS) counts[c.id] = 0;
    const sourceCounts = {};
    for (const it of this.items) {
      for (const c of TAB_CHIPS) if (c.match(it)) counts[c.id]++;
      sourceCounts[it.sourceId] = (sourceCounts[it.sourceId] || 0) + 1;
    }
    const main = TAB_CHIPS.map(c =>
      `<button class="pro-chip ${this.activeChip === c.id ? 'pro-chip--active' : ''}"
              data-chip="${c.id}" data-chip-type="main" type="button">${c.label} <span class="pro-chip__n">${counts[c.id]}</span></button>`
    ).join('');
    const top = Object.entries(sourceCounts).sort((a,b) => b[1] - a[1]).slice(0, 12);
    const sources = top.length > 0
      ? `<span class="pro-chip-sep"></span>` + top.map(([id, n]) => {
          const label = this.sourceLabel(id);
          return `<button class="pro-chip pro-chip--src ${this.activeSource === id ? 'pro-chip--active' : ''}"
                  data-chip="${escapeHTML(id)}" data-chip-type="src" type="button">${escapeHTML(label)} <span class="pro-chip__n">${n}</span></button>`;
        }).join('')
      : '';
    chipsEl.innerHTML = main + sources;
    this.container.querySelector('[data-total]').textContent = `${this.items.length} items`;
  }

  sourceLabel(id) {
    // Lookup human name from settings for nicer chips
    const s = getSettings();
    const yt = s.youtube?.channels?.find(c => c.id === id || c.channelId === id);
    if (yt) return yt.name;
    const rss = s.aiSources?.find(x => x.id === id);
    if (rss) return rss.name;
    if (id === 'hn') return 'HN';
    if (id?.startsWith('arxiv-')) return id.replace('arxiv-', 'arXiv ').toUpperCase();
    return id || 'autre';
  }

  renderList() {
    const listEl = this.container.querySelector('[data-list]');
    const filtered = this.filtered();
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="card__empty">Aucun item ne matche ces filtres.</div>';
      return;
    }
    listEl.innerHTML = filtered.slice(0, 60).map(renderCard).join('');
  }

  async runBrief() {
    if (this.briefBusy) return;
    const card = this.container.querySelector('[data-brief-card]');
    const body = this.container.querySelector('[data-brief-body]');
    const label = this.container.querySelector('[data-brief-label]');

    if (!llmConfigured()) {
      body.innerHTML = `<p class="brief-card__placeholder">Configure d'abord l'Assistant dans <a href="#" data-open-settings>Réglages</a>.</p>`;
      card.classList.remove('brief-card--empty');
      return;
    }

    this.briefBusy = true;
    label.textContent = 'Génération…';
    body.innerHTML = '<p class="brief-card__placeholder">Analyse en cours…</p>';
    card.classList.remove('brief-card--empty');

    try {
      const weather = await this.getWeatherContext().catch(() => null);
      const calendar = await this.getCalendarContext().catch(() => []);
      let acc = '';
      await streamBrief({ feedItems: this.items, weather, calendar }, (delta) => {
        acc += delta;
        body.innerHTML = tinyMd(acc);
      });
      this.brief = acc;
      this.briefAt = Date.now();
      label.textContent = 'Régénérer';
    } catch (e) {
      body.innerHTML = `<p class="brief-card__placeholder" style="color:var(--danger)">Échec : ${escapeHTML(e.message)}</p>`;
      label.textContent = this.brief ? 'Régénérer' : 'Générer';
    } finally {
      this.briefBusy = false;
    }
  }

  async getWeatherContext() {
    const s = getSettings();
    const lat = s.location?.lat;
    const lon = s.location?.lon;
    if (!lat || !lon) return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
    const resp = await fetchWithTimeout(url, {}, 4000);
    if (!resp.ok) return null;
    const d = await resp.json();
    const code = d.current?.weather_code ?? 0;
    return { tempNow: Math.round(d.current?.temperature_2m ?? 0), label: weatherLabel(code) };
  }

  async getCalendarContext() {
    // Read events for today directly from any mounted CalendarWidget cache —
    // avoid re-fetching. Skipped quietly if not available.
    return [];
  }

  refresh() {
    return this.bootstrap();
  }
}

function weatherLabel(code) {
  if (code === 0 || code === 1) return 'clair';
  if (code === 2) return 'partiel';
  if (code === 3) return 'couvert';
  if (code >= 51 && code <= 67) return 'pluie';
  if (code >= 71 && code <= 86) return 'neige';
  if (code >= 95) return 'orage';
  return 'changeant';
}
