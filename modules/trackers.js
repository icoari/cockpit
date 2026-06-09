// Tiny long-interval trackers — tap when an event happens, the widget tells
// you how many days since the last time. Currently shipping with one slot
// (coiffeur). The data shape `state.trackers[key]` is generic so more slots
// can be added without a schema change.

import { ICONS } from './icons.js';
import { escapeHTML, haptic } from './util.js';
import { getState, save } from './state.js';

const SLOTS = [
  { key: 'coiffeur', label: 'Coiffeur', iconKey: 'scissors' },
];

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / 86400000);
}

function ago(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const n = daysBetween(that, today);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return 'hier';
  return `il y a ${n} jours`;
}

function shortDate(date) {
  return new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export class TrackersWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('trackers');
    this.render();
    this.attach();
  }

  ensureBucket() {
    const s = getState();
    if (!s.trackers) s.trackers = {};
    return s.trackers;
  }

  render() {
    const bucket = this.ensureBucket();
    this.container.innerHTML = SLOTS.map(slot => {
      const last = bucket[slot.key];
      const value = last ? ago(last) : 'jamais marqué';
      const sub   = last ? `dernière : ${shortDate(last)}` : 'tape pour démarrer';
      const icon  = ICONS[slot.iconKey] || ICONS.activity;
      return `
        <div class="tracker" data-tracker="${escapeHTML(slot.key)}">
          <span class="tracker__icon">${icon}</span>
          <div class="tracker__body">
            <div class="tracker__label">${escapeHTML(slot.label)}</div>
            <div class="tracker__value">${escapeHTML(value)}</div>
            <div class="tracker__sub">${escapeHTML(sub)}</div>
          </div>
          <button class="tracker__action" type="button" data-action="mark" aria-label="Marquer aujourd'hui">${ICONS.refresh}</button>
        </div>
      `;
    }).join('');
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="mark"]');
      if (!btn) return;
      const row = btn.closest('[data-tracker]');
      const key = row?.dataset.tracker;
      if (!key) return;
      const slot = SLOTS.find(s => s.key === key);
      const bucket = this.ensureBucket();
      const last = bucket[key];
      const prompt = last
        ? `Marquer ${slot.label.toLowerCase()} aujourd'hui ? (dernière : ${shortDate(last)})`
        : `Marquer ${slot.label.toLowerCase()} aujourd'hui ?`;
      if (!confirm(prompt)) return;
      haptic(8);
      bucket[key] = new Date().toISOString().slice(0, 10);
      save();
      this.render();
    });
  }

  refresh() { this.render(); }
}
