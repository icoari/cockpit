import { getSettings, cacheGet, cacheSet, cacheBust, markAiRead, isAiRead } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic } from './util.js';

const CACHE_TTL = 10 * 60 * 1000;
const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';
const RSS2JSON = 'https://api.rss2json.com/v1/api.json';

// Broad AI-related search for HN
const HN_QUERIES = ['AI OR LLM OR GPT OR Claude OR Anthropic OR OpenAI'];

function stripHTML(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchHN() {
  // Past 7 days, AI-related, popular enough to be relevant (>=5 points)
  const sevenDaysAgo = Math.floor((Date.now() - 7 * 86400 * 1000) / 1000);
  const url = `${HN_API}?query=${encodeURIComponent(HN_QUERIES[0])}&tags=story&hitsPerPage=30&numericFilters=created_at_i>${sevenDaysAgo},points>5`;
  const resp = await fetchWithTimeout(url, {}, 7000);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.hits || []).map(h => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: 'Hacker News',
    sourceId: 'hn',
    date: new Date(h.created_at),
    summary: h.story_text ? stripHTML(h.story_text).slice(0, 240) : '',
    points: h.points,
  }));
}

async function fetchRSS(src) {
  const url = `${RSS2JSON}?rss_url=${encodeURIComponent(src.url)}`;
  const resp = await fetchWithTimeout(url, {}, 8000);
  if (!resp.ok) return [];
  const data = await resp.json();
  if (data.status !== 'ok' || !Array.isArray(data.items)) return [];
  return data.items.map(it => ({
    title: it.title,
    url: it.link,
    source: data.feed?.title || src.name,
    sourceId: src.id,
    date: new Date(it.pubDate || it.published || Date.now()),
    summary: stripHTML(it.description || it.content || '').slice(0, 240),
  }));
}

async function fetchAll() {
  const cached = cacheGet('aiwatch', CACHE_TTL);
  if (cached) return cached.map(it => ({ ...it, date: new Date(it.date) }));

  const sources = getSettings().aiSources.filter(s => s.enabled);
  const promises = sources.map(s => {
    if (s.type === 'hn-algolia') return fetchHN().catch(() => []);
    if (s.type === 'rss') return fetchRSS(s).catch(() => []);
    return Promise.resolve([]);
  });

  const results = await Promise.all(promises);
  let items = results.flat();

  // Dedupe by URL
  const seen = new Set();
  items = items.filter(it => {
    if (!it.url || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  // Filter out items older than 30 days (defensive against bad pubDates)
  const cutoff = Date.now() - 30 * 86400 * 1000;
  items = items.filter(it => it.date.getTime() > cutoff);

  // Sort by date desc
  items.sort((a, b) => b.date - a.date);
  items = items.slice(0, 60);

  cacheSet('aiwatch', items.map(it => ({ ...it, date: it.date.toISOString() })));
  return items;
}

function renderItem(item) {
  const read = isAiRead(item.url);
  return `
    <a class="ai-item ${read ? 'ai-item--read' : ''}" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer" data-url="${escapeHTML(item.url)}">
      <div class="ai-item__meta">
        <span class="ai-item__source">${escapeHTML(item.source)}</span>
        <span>·</span>
        <span>${escapeHTML(timeAgo(item.date))}</span>
      </div>
      <div class="ai-item__title">${escapeHTML(item.title)}</div>
      ${item.summary ? `<div class="ai-item__summary">${escapeHTML(item.summary)}</div>` : ''}
    </a>
  `;
}

export class AiWatchWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.items = [];
    this.filter = null;
    this.lastSummary = '';
    this.render();
    this.attach();
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Veille IA</span>
          <span class="card__subtitle"></span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="card__body">
        <div class="ai-filters" data-filters></div>
        <div data-list><div class="card__loading">Chargement…</div></div>
      </div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        cacheBust('aiwatch');
        this.refresh();
        return;
      }
      const chip = e.target.closest('[data-chip]');
      if (chip) {
        e.stopPropagation();
        haptic(4);
        const v = chip.dataset.chip === '' ? null : chip.dataset.chip;
        this.filter = (this.filter === v) ? null : v;
        this.renderItems();
        return;
      }
      const item = e.target.closest('[data-url]');
      if (item) {
        markAiRead(item.dataset.url);
        item.classList.add('ai-item--read');
      }
    });
  }

  setSubtitle(text) {
    this.lastSummary = text;
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = text;
  }

  renderItems() {
    const listEl = this.container.querySelector('[data-list]');
    const filtersEl = this.container.querySelector('[data-filters]');

    const sourceCounts = {};
    for (const it of this.items) {
      sourceCounts[it.sourceId] = (sourceCounts[it.sourceId] || 0) + 1;
    }
    const sources = getSettings().aiSources.filter(s => sourceCounts[s.id]);
    filtersEl.innerHTML = [
      `<button class="ai-chip ${this.filter === null ? 'ai-chip--active' : ''}" data-chip="" type="button">Tous (${this.items.length})</button>`,
      ...sources.map(s => `<button class="ai-chip ${this.filter === s.id ? 'ai-chip--active' : ''}" data-chip="${s.id}" type="button">${escapeHTML(s.name)} (${sourceCounts[s.id]})</button>`),
    ].join('');

    const visible = this.filter ? this.items.filter(it => it.sourceId === this.filter) : this.items;
    if (visible.length === 0) {
      listEl.innerHTML = '<div class="card__empty">Aucun article pour cette source.</div>';
      return;
    }
    listEl.innerHTML = `<div class="ai-list">${visible.slice(0, 30).map(renderItem).join('')}</div>`;
  }

  async refresh() {
    const listEl = this.container.querySelector('[data-list]');
    listEl.innerHTML = '<div class="card__loading">Chargement…</div>';
    this.setSubtitle('chargement…');
    try {
      this.items = await fetchAll();
      this.renderItems();
      if (this.items.length > 0) {
        const fresh = this.items[0];
        this.setSubtitle(`${this.items.length} articles · dernier ${timeAgo(fresh.date)}`);
      } else {
        this.setSubtitle('aucun article récent');
      }
    } catch (e) {
      listEl.innerHTML = `<div class="card__error">Impossible de charger la veille (${escapeHTML(e.message || 'erreur')}).</div>`;
      this.setSubtitle('erreur');
    }
  }
}
