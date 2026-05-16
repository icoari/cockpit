import { getState, getSettings, toggleHabit, getHabitLog } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, addDays, dateKey, haptic } from './util.js';

const DAY_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// Get the Monday of the week containing date d
function startOfWeek(d) {
  const r = new Date(d);
  const day = r.getDay(); // 0 = Sun, 1 = Mon
  const diff = day === 0 ? -6 : 1 - day;
  r.setDate(r.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

function streakFor(habitLog) {
  let streak = 0;
  let cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  while (true) {
    if (habitLog[dateKey(cursor)]) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

export class HabitsWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
  }

  render() {
    const habits = getSettings().habits;
    const monday = startOfWeek(new Date());
    const today = dateKey(new Date());

    const rows = habits.map(h => {
      const log = getHabitLog(h.id);
      const streak = streakFor(log);
      const dots = Array.from({ length: 7 }, (_, i) => {
        const d = addDays(monday, i);
        const k = dateKey(d);
        const done = !!log[k];
        const isToday = k === today;
        const isFuture = d > new Date() && !isToday;
        const cls = ['habit-dot'];
        if (done) cls.push('habit-dot--done');
        if (isToday) cls.push('habit-dot--today');
        if (isFuture) cls.push('habit-dot--future');
        return `
          <button class="${cls.join(' ')}" data-habit="${h.id}" data-day="${k}" type="button" ${isFuture ? 'disabled' : ''}>
            ${DAY_LABELS[i]}
          </button>
        `;
      }).join('');
      return `
        <div class="habit-row">
          <div class="habit-row__header">
            <span class="habit-row__name">${escapeHTML(h.name)}</span>
            <span class="habit-row__streak">${streak > 0 ? `${ICONS.flame} ${streak} j` : ''}</span>
          </div>
          <div class="habit-dots">${dots}</div>
        </div>
      `;
    }).join('');

    this.container.innerHTML = `
      <div class="card__head">
        <span class="card__title">Habitudes — cette semaine</span>
      </div>
      ${habits.length === 0
        ? '<div class="card__empty">Aucune habitude. Ajoute-en dans les Réglages.</div>'
        : `<div class="habit-list">${rows}</div>`}
    `;
  }

  attach() {
    this.container.addEventListener('click', (e) => {
      const dot = e.target.closest('[data-habit]');
      if (!dot || dot.disabled) return;
      haptic(8);
      toggleHabit(dot.dataset.habit, dot.dataset.day);
      this.render();
    });
  }
}
