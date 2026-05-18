import { cacheGet, cacheSet, cacheBust, markAiRead, isAiRead } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic } from './util.js';

const CACHE_TTL = 10 * 60 * 1000;
const API = 'https://hn.algolia.com/api/v1/search';

const MIN_POINTS = 100;

async function fetchTopStories() {
  const cached = cacheGet('hn_top_v2', CACHE_TTL);
  if (cached) return cached.map(s => ({ ...s, date: new Date(s.date) }));

  // Front-page stories from the last 48 h, kept above a quality threshold so
  // the list stays substantive (Show HN drafts and 5-point items drop out).
  const sinceTs = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000);
  const url = `${API}?tags=front_page&hitsPerPage=40&numericFilters=created_at_i>${sinceTs},points>${MIN_POINTS}`;
  const resp = await fetchWithTimeout(url, {}, 7000);
  if (!resp.ok) throw new Error(`Hacker News : HTTP ${resp.status}`);
  const data = await resp.json();
  const items = (data.hits || []).map(h => ({
    id: h.objectID,
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: h.points || 0,
    comments: h.num_comments || 0,
    author: h.author || '',
    date: new Date(h.created_at),
    domain: (() => {
      try { return h.url ? new URL(h.url).hostname.replace(/^www\./, '') : 'news.ycombinator.com'; }
      catch { return ''; }
    })(),
  }));
  items.sort((a, b) => b.points - a.points);
  const top = items.slice(0, 12);
  cacheSet('hn_top_v2', top.map(s => ({ ...s, date: s.date.toISOString() })));
  return top;
}

function renderStory(s) {
  const read = isAiRead(s.url);
  return `
    <a class="hn-item ${read ? 'hn-item--read' : ''}" href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer" data-url="${escapeHTML(s.url)}">
      <div class="hn-item__score">
        <span class="hn-item__points">${s.points}</span>
        <span class="hn-item__points-label">pts</span>
      </div>
      <div class="hn-item__info">
        <div class="hn-item__title">${escapeHTML(s.title)}</div>
        <div class="hn-item__meta">
          ${s.domain ? `<span class="hn-item__domain">${escapeHTML(s.domain)}</span><span>·</span>` : ''}
          <span>${s.comments} comm.</span>
          <span>·</span>
          <span>${escapeHTML(timeAgo(s.date))}</span>
        </div>
      </div>
    </a>
  `;
}

export class HackerNewsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.items = [];
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Hacker News — top du jour</span>
          <span class="card__subtitle"></span>
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
        cacheBust('hn_top_v2');
        this.refresh();
        return;
      }
      const item = e.target.closest('[data-url]');
      if (item) {
        markAiRead(item.dataset.url);
        item.classList.add('hn-item--read');
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
    this.setBody('<div class="card__loading">Chargement…</div>');
    this.setSubtitle('chargement…');
    try {
      this.items = await fetchTopStories();
      if (this.items.length === 0) {
        this.setBody('<div class="card__empty">Aucune story récupérée.</div>');
        this.setSubtitle('vide');
        return;
      }
      this.setBody(`<div class="hn-list">${this.items.map(renderStory).join('')}</div>`);
      const maxPoints = this.items[0].points;
      this.setSubtitle(`${this.items.length} stories · top ${maxPoints} pts`);
    } catch (e) {
      this.setBody(`<div class="card__error">${escapeHTML(e.message)}</div>`);
      this.setSubtitle('erreur');
    }
  }
}
