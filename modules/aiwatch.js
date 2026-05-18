import { getSettings, cacheGet, cacheSet, cacheBust, markAiRead, isAiRead, setFeedSearch, getFeedSearch } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic, debounce } from './util.js';

const CACHE_TTL = 10 * 60 * 1000;
const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';
const CORS_PROXY = 'https://api.codetabs.com/v1/proxy?quest=';

const HN_DEFAULT_QUERIES = {
  ai:   'AI OR LLM OR GPT OR Claude OR Anthropic OR OpenAI',
  tech: 'show OR launch OR open source OR developer',
};

function stripHTML(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchHN(category, searchQuery) {
  const q = searchQuery && searchQuery.trim() ? searchQuery.trim() : (HN_DEFAULT_QUERIES[category] || HN_DEFAULT_QUERIES.ai);
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

function parseFeedXml(xml, src) {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  if (dom.querySelector('parsererror')) return [];
  // Atom or RSS — try both
  const atomEntries = Array.from(dom.getElementsByTagName('entry'));
  if (atomEntries.length) {
    return atomEntries.map(e => {
      const title = e.getElementsByTagName('title')[0]?.textContent || '';
      let link = '';
      for (const l of Array.from(e.getElementsByTagName('link'))) {
        if (l.getAttribute('rel') === 'alternate' || !l.getAttribute('rel')) link = l.getAttribute('href') || link;
      }
      const published = e.getElementsByTagName('published')[0]?.textContent
                     || e.getElementsByTagName('updated')[0]?.textContent;
      const summary = e.getElementsByTagName('summary')[0]?.textContent
                   || e.getElementsByTagName('content')[0]?.textContent || '';
      return {
        title: title.trim(),
        url: link.trim(),
        source: src.name,
        sourceId: src.id,
        lang: src.lang || 'en',
        date: published ? new Date(published) : new Date(),
        summary: stripHTML(summary).slice(0, 240),
      };
    }).filter(it => it.url && it.title);
  }
  // RSS 2.0
  const items = Array.from(dom.getElementsByTagName('item'));
  return items.map(e => {
    const title = e.getElementsByTagName('title')[0]?.textContent || '';
    const link = e.getElementsByTagName('link')[0]?.textContent || '';
    const published = e.getElementsByTagName('pubDate')[0]?.textContent;
    const description = e.getElementsByTagName('description')[0]?.textContent || '';
    return {
      title: title.trim(),
      url: link.trim(),
      source: src.name,
      sourceId: src.id,
      lang: src.lang || 'en',
      date: published ? new Date(published) : new Date(),
      summary: stripHTML(description).slice(0, 240),
    };
  }).filter(it => it.url && it.title);
}

async function fetchRSS(src) {
  const url = CORS_PROXY + encodeURIComponent(src.url);
  const resp = await fetchWithTimeout(url, {}, 9000);
  if (!resp.ok) return [];
  const text = await resp.text();
  return parseFeedXml(text, src);
}

// Titles matching these patterns are click-bait / commercial — filter them out
// from the merged Articles feed to raise signal-to-noise.
const LOW_QUALITY_TITLE = /\b(promo|bon\s*plan|soldes?|deal|code\s*promo|coupon|black\s*friday|cyber\s*monday|discount|giveaway|sponsored|à\s*\-?\d+\s*%)\b/i;

async function fetchAll(category, searchQuery) {
  const cacheKey = searchQuery ? `feed_${category}_search_${searchQuery}` : `feed_${category}`;
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached.map(it => ({ ...it, date: new Date(it.date) }));

  // 'articles' = all enabled RSS sources (AI + tech), no HN. Otherwise filter
  // strictly by the requested category.
  const sources = getSettings().aiSources.filter(s => {
    if (!s.enabled) return false;
    if (category === 'articles') return s.type === 'rss';
    return (s.category || 'ai') === category;
  });
  const promises = sources.map(s => {
    if (s.type === 'hn-algolia') return fetchHN(category, searchQuery).catch(() => []);
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

  // Local title/summary filter for search
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it =>
      it.sourceId === 'hn' ||
      (it.title && it.title.toLowerCase().includes(q)) ||
      (it.summary && it.summary.toLowerCase().includes(q))
    );
  }

  const cutoff = Date.now() - 30 * 86400 * 1000;
  items = items.filter(it => it.date.getTime() > cutoff);

  // Quality filter: drop obvious click-bait / promo titles from the combined
  // Articles feed. HN items always pass (they're already curated by points).
  if (category === 'articles') {
    items = items.filter(it => !LOW_QUALITY_TITLE.test(it.title));
  }

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

export class FeedWidget {
  constructor(container, opts = {}) {
    this.container = container;
    this.category = opts.category || 'ai';
    this.title = opts.title || (this.category === 'ai' ? 'Veille IA' : 'Veille tech');
    this.placeholder = opts.placeholder || 'Rechercher un mot-clé…';
    this.container.classList.add('card');
    this.items = [];
    this.filter = null;
    this.langFilter = null;
    this.searchInput = getFeedSearch(this.category);
    this.render();
    this.attach();
    const sEl = this.container.querySelector('[data-ai-search]');
    if (sEl) sEl.value = this.searchInput;
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">${escapeHTML(this.title)}</span>
          <span class="card__subtitle"></span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="ai-search-row">
        <span class="ai-search-row__icon">${ICONS.search}</span>
        <input class="ai-search" type="search" placeholder="${escapeHTML(this.placeholder)}" data-ai-search>
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
        cacheBust(`feed_${this.category}`);
        if (this.searchInput) cacheBust(`feed_${this.category}_search_${this.searchInput}`);
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

    const searchEl = this.container.querySelector('[data-ai-search]');
    searchEl.addEventListener('input', debounce((e) => {
      this.searchInput = e.target.value.trim();
      setFeedSearch(this.category, this.searchInput);
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
      this.items = await fetchAll(this.category, this.searchInput);
      this.renderItems();
      if (this.items.length > 0) {
        const fresh = this.items[0];
        const label = this.searchInput
          ? `« ${this.searchInput} » · ${this.items.length} résultats`
          : `${this.items.length} articles · dernier ${timeAgo(fresh.date)}`;
        this.setSubtitle(label);
      } else {
        this.setSubtitle(this.searchInput ? 'aucun résultat' : 'aucun article récent');
      }
    } catch (e) {
      listEl.innerHTML = `<div class="card__error">Impossible de charger (${escapeHTML(e.message || 'erreur')}).</div>`;
      this.setSubtitle('erreur');
    }
  }
}

// Backward-compatible alias
export const AiWatchWidget = FeedWidget;
