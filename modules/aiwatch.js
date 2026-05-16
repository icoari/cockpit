import { getSettings, cacheGet, cacheSet, cacheBust, markAiRead, isAiRead, setAiSearch, getAiSearch } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic, debounce } from './util.js';

const CACHE_TTL = 10 * 60 * 1000;
const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';
const RSS2JSON = 'https://api.rss2json.com/v1/api.json';

const HN_DEFAULT_QUERY = 'AI OR LLM OR GPT OR Claude OR Anthropic OR OpenAI';

function stripHTML(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchHN(searchQuery) {
  const q = searchQuery && searchQuery.trim() ? searchQuery.trim() : HN_DEFAULT_QUERY;
  const sevenDaysAgo = Math.floor((Date.now() - 14 * 86400 * 1000) / 1000);
  const url = `${HN_API}?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=25&numericFilters=created_at_i>${sevenDaysAgo},points>3`;
  const resp = await fetchWithTimeout(url, {}, 7000);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.hits || []).map(h => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: 'Hacker News',
    sourceId: 'hn',
    lang: 'en',
    date: new Date(h.created_at),
    summary: h.story_text ? stripHTML(h.story_text).slice(0, 240) : '',
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
    lang: src.lang || 'en',
    date: new Date(it.pubDate || it.published || Date.now()),
    summary: stripHTML(it.description || it.content || '').slice(0, 240),
  }));
}

async function fetchAll(searchQuery) {
  const cacheKey = searchQuery ? `aiwatch_search_${searchQuery}` : 'aiwatch';
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached.map(it => ({ ...it, date: new Date(it.date) }));

  const sources = getSettings().aiSources.filter(s => s.enabled);
  const promises = sources.map(s => {
    if (s.type === 'hn-algolia') return fetchHN(searchQuery).catch(() => []);
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

  // Apply local search filter on title/summary for RSS sources (HN already filtered server-side)
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it =>
      it.sourceId === 'hn' || // HN search was server-side
      (it.title && it.title.toLowerCase().includes(q)) ||
      (it.summary && it.summary.toLowerCase().includes(q))
    );
  }

  // Filter out items older than 30 days
  const cutoff = Date.now() - 30 * 86400 * 1000;
  items = items.filter(it => it.date.getTime() > cutoff);

  items.sort((a, b) => b.date - a.date);
  items = items.slice(0, 80);

  cacheSet(cacheKey, items.map(it => ({ ...it, date: it.date.toISOString() })));
  return items;
}

function renderItem(item) {
  const read = isAiRead(item.url);
  const langTag = item.lang === 'fr' ? '<span class="ai-item__lang">FR</span>' : '';
  return `
    <a class="ai-item ${read ? 'ai-item--read' : ''}" href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer" data-url="${escapeHTML(item.url)}">
      <div class="ai-item__meta">
        <span class="ai-item__source">${escapeHTML(item.source)}</span>
        ${langTag}
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
    this.filter = null;             // sourceId filter (chip)
    this.langFilter = null;         // 'fr' | 'en' | null
    this.searchInput = '';
    this.render();
    this.attach();
    // Restore search from state
    this.searchInput = getAiSearch();
    const sEl = this.container.querySelector('[data-ai-search]');
    if (sEl) sEl.value = this.searchInput;
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
      <div class="ai-search-row">
        <span class="ai-search-row__icon">${ICONS.search}</span>
        <input class="ai-search" type="search" placeholder="Rechercher un mot-clé…" data-ai-search>
      </div>
      <div class="ai-filters" data-filters></div>
      <div data-list><div class="card__loading">Chargement…</div></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.stopPropagation();
        haptic(6);
        cacheBust('aiwatch');
        if (this.searchInput) cacheBust(`aiwatch_search_${this.searchInput}`);
        this.refresh();
        return;
      }
      const chip = e.target.closest('[data-chip]');
      if (chip) {
        e.stopPropagation();
        haptic(4);
        const v = chip.dataset.chip === '' ? null : chip.dataset.chip;
        const type = chip.dataset.chipType;
        if (type === 'lang') {
          this.langFilter = (this.langFilter === v) ? null : v;
        } else {
          this.filter = (this.filter === v) ? null : v;
        }
        this.renderItems();
        return;
      }
      const item = e.target.closest('[data-url]');
      if (item) {
        markAiRead(item.dataset.url);
        item.classList.add('ai-item--read');
      }
    });

    // Search input with debounce
    const searchEl = this.container.querySelector('[data-ai-search]');
    searchEl.addEventListener('input', debounce((e) => {
      this.searchInput = e.target.value.trim();
      setAiSearch(this.searchInput);
      this.refresh();
    }, 400));
  }

  setSubtitle(text) {
    const el = this.container.querySelector('.card__subtitle');
    if (el) el.textContent = text;
  }

  renderItems() {
    const listEl = this.container.querySelector('[data-list]');
    const filtersEl = this.container.querySelector('[data-filters]');

    const langCounts = { fr: 0, en: 0 };
    const sourceCounts = {};
    for (const it of this.items) {
      sourceCounts[it.sourceId] = (sourceCounts[it.sourceId] || 0) + 1;
      if (it.lang === 'fr') langCounts.fr++;
      else langCounts.en++;
    }
    const sources = getSettings().aiSources.filter(s => sourceCounts[s.id]);

    // Build chips: language toggle + source filters
    let chips = '';
    if (langCounts.fr > 0 && langCounts.en > 0) {
      chips += `<button class="ai-chip ${this.langFilter === 'fr' ? 'ai-chip--active' : ''}" data-chip="fr" data-chip-type="lang" type="button">FR (${langCounts.fr})</button>`;
      chips += `<button class="ai-chip ${this.langFilter === 'en' ? 'ai-chip--active' : ''}" data-chip="en" data-chip-type="lang" type="button">EN (${langCounts.en})</button>`;
      chips += `<span class="ai-chip-sep"></span>`;
    }
    chips += `<button class="ai-chip ${this.filter === null ? 'ai-chip--active' : ''}" data-chip="" data-chip-type="src" type="button">Tous (${this.items.length})</button>`;
    chips += sources.map(s => `<button class="ai-chip ${this.filter === s.id ? 'ai-chip--active' : ''}" data-chip="${s.id}" data-chip-type="src" type="button">${escapeHTML(s.name)} (${sourceCounts[s.id]})</button>`).join('');
    filtersEl.innerHTML = chips;

    let visible = this.items;
    if (this.langFilter) visible = visible.filter(it => it.lang === this.langFilter);
    if (this.filter) visible = visible.filter(it => it.sourceId === this.filter);

    if (visible.length === 0) {
      listEl.innerHTML = '<div class="card__empty">Aucun article correspondant.</div>';
      return;
    }
    listEl.innerHTML = `<div class="ai-list">${visible.slice(0, 40).map(renderItem).join('')}</div>`;
  }

  async refresh() {
    const listEl = this.container.querySelector('[data-list]');
    listEl.innerHTML = '<div class="card__loading">Chargement…</div>';
    this.setSubtitle('chargement…');
    try {
      this.items = await fetchAll(this.searchInput);
      this.renderItems();
      if (this.items.length > 0) {
        const fresh = this.items[0];
        const label = this.searchInput ? `« ${this.searchInput} » · ${this.items.length} résultats` : `${this.items.length} articles · dernier ${timeAgo(fresh.date)}`;
        this.setSubtitle(label);
      } else {
        this.setSubtitle(this.searchInput ? 'aucun résultat' : 'aucun article récent');
      }
    } catch (e) {
      listEl.innerHTML = `<div class="card__error">Impossible de charger la veille (${escapeHTML(e.message || 'erreur')}).</div>`;
      this.setSubtitle('erreur');
    }
  }
}
