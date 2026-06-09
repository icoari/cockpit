// Tiny long-interval trackers — tap the date to set / change it, the row
// shows how many days since. Data lives at state.trackers.{key} so the
// encrypted sync + JSON export carry it without any extra schema work.

import { ICONS } from './icons.js';
import { escapeHTML } from './util.js';
import { getState, save } from './state.js';

const SLOTS = [
  { key: 'coiffeur', label: 'Coiffeur', iconKey: 'scissors' },
  { key: 'dentiste', label: 'Dentiste', iconKey: 'tooth' },
  { key: 'osteo',    label: 'Ostéo',    iconKey: 'bone' },
];

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function ago(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that  = new Date(d); that.setHours(0, 0, 0, 0);
  const n = daysBetween(that, today);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return 'hier';
  if (n < 0) return `dans ${-n} jours`;
  return `il y a ${n} jours`;
}

export class TrackersWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
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
    const filled = SLOTS.filter(s => bucket[s.key]).length;
    this.container.innerHTML = `
      <div class="card__head">
        <div class="card__head-main">
          <span class="card__title">Compteurs</span>
          <span class="card__subtitle">${filled}/${SLOTS.length} suivis</span>
        </div>
      </div>
      <div class="tracker-rows">
        ${SLOTS.map(slot => this.renderRow(slot, bucket[slot.key])).join('')}
      </div>
    `;
  }

  renderRow(slot, value) {
    const icon = ICONS[slot.iconKey] || ICONS.activity;
    const since = value ? ago(value) : '—';
    const dateValue = value || '';
    return `
      <label class="tracker-row" data-tracker="${escapeHTML(slot.key)}">
        <span class="tracker-row__icon">${icon}</span>
        <span class="tracker-row__body">
          <span class="tracker-row__label">${escapeHTML(slot.label)}</span>
          <span class="tracker-row__since">${escapeHTML(since)}</span>
        </span>
        <input class="tracker-row__date" type="date"
               value="${escapeHTML(dateValue)}"
               max="${escapeHTML(todayISO())}"
               aria-label="Dernière fois — ${escapeHTML(slot.label)}">
      </label>
    `;
  }

  attach() {
    this.container.addEventListener('change', (e) => {
      const input = e.target.closest('.tracker-row__date');
      if (!input) return;
      const row = input.closest('[data-tracker]');
      const key = row?.dataset.tracker;
      if (!key) return;
      const v = input.value;
      const bucket = this.ensureBucket();
      if (v) bucket[key] = v;
      else   delete bucket[key];
      save();
      this.render();
    });
  }

  refresh() { this.render(); }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
