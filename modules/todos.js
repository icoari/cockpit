import { getState, addTodo, toggleTodo, removeTodo } from './state.js';
import { ICONS } from './icons.js';
import { escapeHTML, todayKey, haptic, dateKey } from './util.js';

export class TodosWidget {
  constructor(container) {
    this.container = container;
    this.container.classList.add('card');
    this.render();
    this.attach();
    this.renderList();
  }

  render() {
    this.container.innerHTML = `
      <div class="card__head">
        <span class="card__title">Tâches du jour</span>
      </div>
      <div class="todo-add-row">
        <input class="todo-input" type="text" placeholder="Ajouter une tâche…" data-input>
      </div>
      <div class="todo-list" data-list></div>
      <div class="todo-summary" data-summary></div>
    `;
  }

  attach() {
    const input = this.container.querySelector('[data-input]');
    const list = this.container.querySelector('[data-list]');

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        if (!v) return;
        haptic(8);
        addTodo(v);
        input.value = '';
        this.renderList();
      }
    });

    list.addEventListener('click', (e) => {
      const del = e.target.closest('[data-delete]');
      if (del) {
        e.stopPropagation();
        haptic(8);
        removeTodo(del.dataset.delete);
        this.renderList();
        return;
      }
      const item = e.target.closest('[data-toggle]');
      if (item) {
        haptic(4);
        toggleTodo(item.dataset.toggle);
        this.renderList();
      }
    });
  }

  renderList() {
    const list = this.container.querySelector('[data-list]');
    const summary = this.container.querySelector('[data-summary]');
    const today = todayKey();

    const all = getState().todos;
    const todayTodos = all.filter(t => dateKey(new Date(t.createdAt)) === today);
    const recentDone = all.filter(t => t.done && t.completedAt && dateKey(new Date(t.completedAt)) === today);
    const stale = all.filter(t => !t.done && dateKey(new Date(t.createdAt)) !== today);

    const visible = [...todayTodos, ...recentDone.filter(t => !todayTodos.includes(t)), ...stale.slice(0, 10)];
    const dedup = [...new Set(visible)];

    if (dedup.length === 0) {
      list.innerHTML = '<div class="card__empty">Aucune tâche pour aujourd\'hui. Ajoute-en une ci-dessus.</div>';
      summary.innerHTML = '';
      return;
    }

    list.innerHTML = dedup.map(t => {
      const isStale = !t.done && dateKey(new Date(t.createdAt)) !== today;
      const cls = ['todo-item'];
      if (t.done) cls.push('todo-item--done');
      if (isStale) cls.push('todo-item--stale');
      return `
        <div class="${cls.join(' ')}" data-toggle="${t.id}">
          <span class="todo-check"></span>
          <span class="todo-text">${escapeHTML(t.text)}</span>
          <button class="todo-delete" data-delete="${t.id}" aria-label="Supprimer">${ICONS.trash}</button>
        </div>
      `;
    }).join('');

    const done = todayTodos.filter(t => t.done).length;
    const total = todayTodos.length;
    summary.innerHTML = total > 0
      ? `<strong>${done}</strong> / ${total} faite${total > 1 ? 's' : ''} aujourd'hui`
      : '';
  }
}
