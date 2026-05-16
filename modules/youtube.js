import { getSettings, cacheGet, cacheSet, cacheBust, markAiRead, isAiRead, setFeedSearch, getFeedSearch } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, fetchWithTimeout, timeAgo, haptic, debounce } from './util.js';

const CACHE_TTL = 30 * 60 * 1000;
const CORS_PROXY = 'https://corsproxy.io/?';
const YT_RSS = (channelId) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
const MAX_DAYS = 10;
const MAX_PER_CHANNEL = 4;
const SHORTS_RE = /#shorts?\b/i;

function parseYouTubeFeed(xmlText, channel) {
  const dom = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (dom.querySelector('parsererror')) return [];
  const entries = Array.from(dom.getElementsByTagName('entry'));
  return entries.map(e => {
    const title = (e.getElementsByTagName('title')[0]?.textContent || '').trim();
    let link = '';
    for (const l of Array.from(e.getElementsByTagName('link'))) {
      if (l.getAttribute('rel') === 'alternate') link = l.getAttribute('href');
    }
    const published = e.getElementsByTagName('published')[0]?.textContent;
    const author = (e.getElementsByTagName('name')[0]?.textContent || channel.name).trim();
    let videoId = '';
    for (const c of Array.from(e.childNodes)) {
      if (c.localName === 'videoId') { videoId = c.textContent; break; }
    }
    if (!videoId && link) {
      const m = link.match(/v=([A-Za-z0-9_-]+)/);
      if (m) videoId = m[1];
    }
    // Read media:description / media:title for shorts detection in description text
    let mediaDesc = '';
    for (const c of Array.from(e.childNodes)) {
      if (c.localName === 'group') {
        for (const sub of Array.from(c.childNodes)) {
          if (sub.localName === 'description') mediaDesc = sub.textContent || '';
        }
      }
    }
    const isShort = SHORTS_RE.test(title) || SHORTS_RE.test(mediaDesc) || /\/shorts\//.test(link);
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
    return {
      title,
      url: link,
      videoId,
      channelId: channel.channelId,
      channelName: author,
      channelLabel: channel.name,
      lang: channel.lang || 'en',
      date: published ? new Date(published) : new Date(),
      thumbnail,
      isShort,
    };
  }).filter(v => v.url && v.title && !v.isShort);
}

async function fetchChannel(channel) {
  const url = CORS_PROXY + encodeURIComponent(YT_RSS(channel.channelId));
  const resp = await fetchWithTimeout(url, {}, 9000);
  if (!resp.ok) return [];
  const text = await resp.text();
  // Filter shorts + cap per channel + last MAX_DAYS days
  const cutoff = Date.now() - MAX_DAYS * 86400 * 1000;
  return parseYouTubeFeed(text, channel)
    .filter(v => v.date.getTime() > cutoff)
    .sort((a, b) => b.date - a.date)
    .slice(0, MAX_PER_CHANNEL);
}

async function fetchAll(searchQuery) {
  const cacheKey = searchQuery ? `yt_search_${searchQuery}` : 'yt_all';
  const cached = cacheGet(cacheKey, CACHE_TTL);
  if (cached) return cached.map(it => ({ ...it, date: new Date(it.date) }));

  const channels = getSettings().youtube?.channels?.filter(c => c.enabled) || [];
  const promises = channels.map(c => fetchChannel(c).catch(() => []));
  const results = await Promise.all(promises);
  let items = results.flat();

  const seen = new Set();
  items = items.filter(it => {
    if (!it.url || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    items = items.filter(it =>
      (it.title && it.title.toLowerCase().includes(q)) ||
      (it.channelName && it.channelName.toLowerCase().includes(q))
    );
  }

  const cutoff = Date.now() - MAX_DAYS * 86400 * 1000;
  items = items.filter(it => it.date.getTime() > cutoff);
  items.sort((a, b) => b.date - a.date);
  // Round-robin cap is already done per channel; merged cap to avoid huge feeds
  items = items.slice(0, 40);

  cacheSet(cacheKey, items.map(it => ({ ...it, date: it.date.toISOString() })));
  return items;
}

function renderVideo(v) {
  const read = isAiRead(v.url);
  const langTag = v.lang === 'fr' ? '<span class="ai-item__lang">FR</span>' : '';
  return `
    <a class="yt-item ${read ? 'yt-item--read' : ''}" href="${escapeHTML(v.url)}" target="_blank" rel="noopener noreferrer" data-url="${escapeHTML(v.url)}">
      <div class="yt-item__thumb" ${v.thumbnail ? `style="background-image:url('${escapeHTML(v.thumbnail)}')"` : ''}></div>
      <div class="yt-item__info">
        <div class="yt-item__title">${escapeHTML(v.title)}</div>
        <div class="yt-item__meta">
          <span class="yt-item__channel">${escapeHTML(v.channelName || v.channelLabel)}</span>
          ${langTag}
          <span>·</span>
          <span>${escapeHTML(timeAgo(v.date))}</span>
        </div>
      </div>
    </a>
  `;
}

export class YoutubeWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.items = [];
    this.channelFilter = null;
    this.langFilter = null;
    this.searchInput = getFeedSearch('youtube');
    this.render();
    this.attach();
    const sEl = this.container.querySelector('[data-yt-search]');
    if (sEl) sEl.value = this.searchInput;
    this.refresh();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">YouTube — tech & IA</span>
          <span class="card__subtitle"></span>
        </div>
        <div class="card__actions">
          <button class="card__action" data-action="refresh" type="button" aria-label="Rafraîchir">${ICONS.refresh}</button>
        </div>
      </div>
      <div class="ai-search-row">
        <span class="ai-search-row__icon">${ICONS.search}</span>
        <input class="ai-search" type="search" placeholder="Rechercher dans les vidéos…" data-yt-search>
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
        cacheBust('yt_all');
        if (this.searchInput) cacheBust(`yt_search_${this.searchInput}`);
        this.refresh();
        return;
      }
      const chip = e.target.closest('[data-chip]');
      if (chip) {
        e.stopPropagation();
        haptic(4);
        const v = chip.dataset.chip === '' ? null : chip.dataset.chip;
        const type = chip.dataset.chipType;
        if (type === 'lang') this.langFilter = (this.langFilter === v) ? null : v;
        else this.channelFilter = (this.channelFilter === v) ? null : v;
        this.renderItems();
        return;
      }
      const item = e.target.closest('[data-url]');
      if (item) {
        markAiRead(item.dataset.url);
        item.classList.add('yt-item--read');
      }
    });

    const searchEl = this.container.querySelector('[data-yt-search]');
    searchEl.addEventListener('input', debounce((e) => {
      this.searchInput = e.target.value.trim();
      setFeedSearch('youtube', this.searchInput);
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

    const channelCounts = {};
    const langCounts = { fr: 0, en: 0 };
    for (const it of this.items) {
      channelCounts[it.channelId] = (channelCounts[it.channelId] || 0) + 1;
      if (it.lang === 'fr') langCounts.fr++;
      else langCounts.en++;
    }
    const channels = (getSettings().youtube?.channels || []).filter(c => channelCounts[c.channelId]);

    let chips = '';
    if (langCounts.fr > 0 && langCounts.en > 0) {
      chips += `<button class="ai-chip ${this.langFilter === 'fr' ? 'ai-chip--active' : ''}" data-chip="fr" data-chip-type="lang" type="button">FR (${langCounts.fr})</button>`;
      chips += `<button class="ai-chip ${this.langFilter === 'en' ? 'ai-chip--active' : ''}" data-chip="en" data-chip-type="lang" type="button">EN (${langCounts.en})</button>`;
      chips += `<span class="ai-chip-sep"></span>`;
    }
    chips += `<button class="ai-chip ${this.channelFilter === null ? 'ai-chip--active' : ''}" data-chip="" data-chip-type="ch" type="button">Toutes (${this.items.length})</button>`;
    chips += channels.map(c => `<button class="ai-chip ${this.channelFilter === c.channelId ? 'ai-chip--active' : ''}" data-chip="${c.channelId}" data-chip-type="ch" type="button">${escapeHTML(c.name)} (${channelCounts[c.channelId]})</button>`).join('');
    filtersEl.innerHTML = chips;

    let visible = this.items;
    if (this.langFilter) visible = visible.filter(it => it.lang === this.langFilter);
    if (this.channelFilter) visible = visible.filter(it => it.channelId === this.channelFilter);

    if (visible.length === 0) {
      listEl.innerHTML = '<div class="card__empty">Aucune vidéo correspondante.</div>';
      return;
    }
    listEl.innerHTML = `<div class="yt-list">${visible.slice(0, 30).map(renderVideo).join('')}</div>`;
  }

  async refresh() {
    const listEl = this.container.querySelector('[data-list]');
    listEl.innerHTML = '<div class="card__loading">Chargement des vidéos…</div>';
    this.setSubtitle('chargement…');
    try {
      this.items = await fetchAll(this.searchInput);
      this.renderItems();
      if (this.items.length > 0) {
        const fresh = this.items[0];
        const label = this.searchInput
          ? `« ${this.searchInput} » · ${this.items.length} vidéos`
          : `${this.items.length} vidéos · dernière ${timeAgo(fresh.date)}`;
        this.setSubtitle(label);
      } else {
        this.setSubtitle(this.searchInput ? 'aucun résultat' : 'aucune vidéo');
      }
    } catch (e) {
      listEl.innerHTML = `<div class="card__error">Impossible de charger (${escapeHTML(e.message || 'erreur')}).</div>`;
      this.setSubtitle('erreur');
    }
  }
}
