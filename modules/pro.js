// Pro page — editorial daily digest. Not a feed: 3-5 headlines that earned
// their place, picked by the assistant. A small "Plus tard" tail for items
// worth scanning if there's time. That's it.

import { ICONS } from './icons.js';
import { escapeHTML, timeAgo, haptic } from './util.js';
import { fetchFeed, pushSources } from './feed.js';
import { isConfigured as llmConfigured } from './llm.js';
import { generateDigest } from './digest.js';
import { markAiRead, isAiRead } from './state.js';
import { isSyncEnabled } from './sync.js';

const DIGEST_KEY = 'bob-digest-v2';
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;   // 4 h
const AUTO_REFRESH_MS = 8 * 60 * 60 * 1000;  // 8 h since last refresh = auto-regen on open

function loadDigest() {
  try {
    const raw = localStorage.getItem(DIGEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveDigest(d) {
  try { localStorage.setItem(DIGEST_KEY, JSON.stringify(d)); } catch {}
}

function kindLabel(item) {
  if (item.kind === 'video') return 'Vidéo';
  if (item.kind === 'hn')    return `HN · ${item.points || 0} pts`;
  if (item.url && /arxiv|huggingface\.co\/papers/i.test(item.url)) return 'Paper';
  return 'Article';
}

function renderHeadline(item) {
  const read = isAiRead(item.url);
  const isVideo = item.kind === 'video';
  const eyebrowParts = [
    kindLabel(item),
    item.source,
    timeAgo(new Date(item.date)),
  ].filter(Boolean);

  const thumb = isVideo && item.thumbnail
    ? `<div class="pro2-headline__thumb" style="background-image:url('${escapeHTML(item.thumbnail)}')" aria-hidden="true"></div>`
    : '';

  return `
    <a class="pro2-headline ${read ? 'pro2-headline--read' : ''} pro2-headline--${item.kind}"
       href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer"
       data-url="${escapeHTML(item.url)}">
      <div class="pro2-headline__eyebrow">
        ${eyebrowParts.map(p => `<span>${escapeHTML(p)}</span>`).join('<span class="pro2-headline__sep">·</span>')}
      </div>
      <div class="pro2-headline__title">${escapeHTML(item.title)}</div>
      <div class="pro2-headline__why">${escapeHTML(item.why || '')}</div>
      ${thumb}
    </a>
  `;
}

function renderLaterItem(item) {
  const read = isAiRead(item.url);
  return `
    <a class="pro2-later__item ${read ? 'pro2-later__item--read' : ''}"
       href="${escapeHTML(item.url)}" target="_blank" rel="noopener noreferrer"
       data-url="${escapeHTML(item.url)}">
      <span class="pro2-later__title">${escapeHTML(item.title)}</span>
      <span class="pro2-later__meta">${escapeHTML(item.source || '')} · ${escapeHTML(timeAgo(new Date(item.date)))}</span>
    </a>
  `;
}

export class ProWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('pro2-shell');
    this.feedItems = [];
    this.digest = loadDigest();
    this.busy = false;
    this.render();
    this.attach();
    this.bootstrap();
  }

  render() {
    const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    this.container.innerHTML = `
      <header class="pro2-head">
        <div class="pro2-head__date">${escapeHTML(today)}</div>
        <h2 class="pro2-head__title">Aujourd'hui</h2>
        <div class="pro2-head__meta">
          <span data-meta>—</span>
          <button class="pro2-refresh" data-action="refresh" type="button" aria-label="Rafraîchir l'éditorial">${ICONS.refresh}</button>
        </div>
      </header>
      <div class="pro2-body" data-body></div>
    `;
  }

  attach() {
    this.container.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="refresh"]')) {
        e.preventDefault();
        e.stopPropagation();
        haptic(6);
        await this.regenerate();
        return;
      }
      const card = e.target.closest('[data-url]');
      if (card) markAiRead(card.dataset.url);
    });
  }

  setMeta(text) {
    const el = this.container.querySelector('[data-meta]');
    if (el) el.textContent = text;
  }

  async bootstrap() {
    const body = this.container.querySelector('[data-body]');

    if (!isSyncEnabled()) {
      body.innerHTML = `<div class="pro2-empty">Active la sauvegarde cloud (Réglages) pour activer le feed agrégé.</div>`;
      this.setMeta('non configuré');
      return;
    }

    pushSources();
    body.innerHTML = `<div class="pro2-loading">Récupération du feed…</div>`;

    try {
      const data = await fetchFeed({ force: false });
      this.feedItems = data.items || [];
    } catch (e) {
      body.innerHTML = `<div class="pro2-error">Erreur feed : ${escapeHTML(e.message)}</div>`;
      this.setMeta('erreur');
      return;
    }

    if (this.feedItems.length === 0) {
      body.innerHTML = `<div class="pro2-empty">Pas encore d'items dans le feed.</div>`;
      this.setMeta('vide');
      return;
    }

    const age = this.digest ? Date.now() - this.digest.generatedAt : Infinity;
    if (this.digest && age < AUTO_REFRESH_MS) {
      this.renderDigest({ stale: age > STALE_AFTER_MS });
    } else if (llmConfigured()) {
      await this.regenerate();
    } else {
      this.renderFallback();
    }
  }

  async regenerate() {
    if (this.busy) return;
    const body = this.container.querySelector('[data-body]');

    if (!llmConfigured()) {
      this.renderFallback();
      return;
    }
    if (this.feedItems.length === 0) {
      this.renderFallback();
      return;
    }

    this.busy = true;
    body.innerHTML = `<div class="pro2-loading"><span class="pro2-spinner"></span>L'éditorial du jour se prépare…</div>`;
    this.setMeta('curation…');
    try {
      this.digest = await generateDigest(this.feedItems);
      saveDigest(this.digest);
      this.renderDigest();
    } catch (e) {
      body.innerHTML = `<div class="pro2-error">Erreur curation : ${escapeHTML(e.message)}</div>`;
      this.setMeta('erreur');
    } finally {
      this.busy = false;
    }
  }

  renderDigest({ stale = false } = {}) {
    const body = this.container.querySelector('[data-body]');
    const headlines = this.digest?.headlines || [];
    const later = this.digest?.later || [];

    if (headlines.length === 0) {
      this.renderFallback();
      return;
    }

    body.innerHTML = `
      <section class="pro2-headlines">
        ${headlines.map(renderHeadline).join('')}
      </section>
      ${later.length > 0 ? `
        <section class="pro2-later">
          <div class="pro2-later__head">
            <span class="pro2-later__label">Plus tard</span>
            <span class="pro2-later__count">${later.length}</span>
          </div>
          <div class="pro2-later__list">
            ${later.map(renderLaterItem).join('')}
          </div>
        </section>
      ` : ''}
    `;

    const ago = timeAgo(new Date(this.digest.generatedAt));
    this.setMeta(`${headlines.length} retenu${headlines.length > 1 ? 's' : ''} · curé ${ago}${stale ? ' · à rafraîchir' : ''}`);
  }

  renderFallback() {
    const body = this.container.querySelector('[data-body]');
    const top = this.feedItems.slice(0, 8);
    body.innerHTML = `
      <div class="pro2-fallback">
        ${llmConfigured()
          ? 'Aucune curation pour le moment.'
          : 'Configure l\'assistant dans Réglages pour la curation éditoriale.'}
      </div>
      <section class="pro2-later">
        <div class="pro2-later__head"><span class="pro2-later__label">Récents</span><span class="pro2-later__count">${top.length}</span></div>
        <div class="pro2-later__list">${top.map(renderLaterItem).join('')}</div>
      </section>
    `;
    this.setMeta(`${top.length} items récents`);
  }

  refresh() {
    return this.bootstrap();
  }
}
