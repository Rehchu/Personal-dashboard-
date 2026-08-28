// Habits module — daily check-offs, contribution grids, streaks. All localStorage.

import { load, save, uid, todayISO, esc, showToast } from './store.js';

const WEEKS = 12;
const DAYS = WEEKS * 7;

const getHabits = () => load('habits', []);

function setHabits(habits) {
  save('habits', habits);
  window.dispatchEvent(new CustomEvent('pd:data-changed'));
}

function seed() {
  if (load('habits', null) !== null) return;
  save('habits', [
    { id: uid(), name: 'Read Bible', emoji: '📖', days: {} },
    { id: uid(), name: 'Write the book', emoji: '🐉', days: {} },
  ]);
}

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Consecutive done days ending today (or yesterday, if today isn't checked yet).
function currentStreak(days) {
  const start = days[dayKey(0)] ? 0 : 1;
  let n = 0;
  while (days[dayKey(start + n)]) n++;
  return n;
}

function bestStreak(days) {
  const keys = Object.keys(days).filter(k => days[k]).sort();
  let best = 0;
  let run = 0;
  let prev = 0;
  for (const k of keys) {
    const t = new Date(`${k}T12:00:00`).getTime();
    run = prev && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  }
  return best;
}

// 12 weeks × 7 rows, column-major so today lands bottom-right.
function gridHTML(days) {
  const cells = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const key = dayKey(i);
    const on = days[key] ? ' on' : '';
    cells.push(`<span class="hab-cell${on}" title="${fmtDate(key)}${on ? ' · done' : ''}"></span>`);
  }
  return `<div class="hab-grid" role="img" aria-label="Last ${WEEKS} weeks">${cells.join('')}</div>`;
}

const CSS = `
  .hab-today { display: flex; flex-wrap: wrap; gap: 10px; }
  .hab-chip {
    display: inline-flex; align-items: center; gap: 10px; padding: 12px 18px; min-height: 52px;
    background: var(--surface-2); color: var(--ink); border: 1px solid transparent;
    border-radius: var(--tile-radius); font-family: var(--font-body); font-size: 1rem; cursor: pointer;
  }
  .hab-chip .hab-check { opacity: .25; font-weight: 700; }
  .hab-chip.done { background: var(--accent); border-color: var(--accent); }
  .hab-chip.done, .hab-chip.done .hab-check { color: var(--on-accent); opacity: 1; }
  .hab-list { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); margin-top: 18px; }
  .hab-meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .hab-actions { margin-left: auto; display: flex; gap: 6px; }
  .hab-gridwrap { overflow-x: auto; }
  .hab-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 11px); grid-auto-columns: 11px; gap: 2px; width: max-content; }
  .hab-cell { width: 11px; height: 11px; border-radius: 2px; background: var(--surface-2); }
  .hab-cell.on { background: var(--accent); }
  @media (prefers-reduced-motion: no-preference) {
    .hab-chip { transition: transform .12s ease, background-color .15s ease, color .15s ease; }
    .hab-chip:active { transform: scale(.93); }
    .hab-chip.pop { animation: hab-pop .28s ease; }
    @keyframes hab-pop { 0% { transform: scale(.93); } 55% { transform: scale(1.07); } 100% { transform: scale(1); } }
  }`;

export function mount(root, tools) {
  seed();

  if (!document.getElementById('habits-style')) {
    const style = document.createElement('style');
    style.id = 'habits-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  tools.innerHTML = '<button class="btn small primary" id="hab-add-btn">＋ Habit</button>';

  root.innerHTML = `
    <div class="stat-row" id="hab-stats"></div>
    <div class="panel" id="hab-add" hidden style="margin-bottom:18px">
      <h3>New habit</h3>
      <form id="hab-form" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="margin:0"><label for="hab-name">Name</label>
          <input id="hab-name" maxlength="60" placeholder="Stretch 10 min" required></div>
        <div class="field" style="margin:0"><label for="hab-emoji">Emoji</label>
          <input id="hab-emoji" maxlength="4" placeholder="🔥" style="width:70px"></div>
        <button class="btn primary" type="submit">Add</button>
      </form>
    </div>
    <div class="panel">
      <h3>Today</h3>
      <div class="hab-today" id="hab-today"></div>
      <p class="muted" id="hab-empty" hidden>No habits yet — hit ＋ Habit and start a streak.</p>
    </div>
    <div class="hab-list" id="hab-list"></div>`;

  let popId = null; // habit just checked off — gets the pop animation after render

  function render() {
    const habits = getHabits();
    const today = todayISO();

    const currents = habits.map(h => currentStreak(h.days));
    let weekDone = 0;
    for (const h of habits) for (let i = 0; i < 7; i++) if (h.days[dayKey(i)]) weekDone++;
    root.querySelector('#hab-stats').innerHTML = [
      [habits.length, 'habits'],
      [`${habits.length ? Math.max(...currents) : 0}d`, 'best current streak'],
      [weekDone, 'check-offs this week'],
    ].map(([v, l]) => `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`).join('');

    root.querySelector('#hab-today').innerHTML = habits.map(h => `
      <button class="hab-chip${h.days[today] ? ' done' : ''}" data-toggle="${h.id}"
        aria-pressed="${h.days[today] ? 'true' : 'false'}">
        <span>${esc(h.emoji)}</span><span>${esc(h.name)}</span><span class="hab-check">✓</span>
      </button>`).join('');
    root.querySelector('#hab-empty').hidden = habits.length > 0;

    root.querySelector('#hab-list').innerHTML = habits.map((h, i) => `
      <div class="panel">
        <h3>${esc(h.emoji)} ${esc(h.name)}</h3>
        <div class="hab-meta">
          <span class="muted">🔥 ${currents[i]}d streak · best ${bestStreak(h.days)}d</span>
          <span class="hab-actions">
            <button class="btn small" data-rename="${h.id}">Rename</button>
            <button class="btn small danger" data-del="${h.id}">✕</button>
          </span>
        </div>
        <div class="hab-gridwrap">${gridHTML(h.days)}</div>
      </div>`).join('');

    if (popId) {
      const chip = root.querySelector(`[data-toggle="${popId}"]`);
      if (chip) chip.classList.add('pop');
      popId = null;
    }
  }

  root.addEventListener('click', e => {
    const toggle = e.target.closest('[data-toggle]');
    const rename = e.target.closest('[data-rename]');
    const del = e.target.closest('[data-del]');
    const habits = getHabits();

    if (toggle) {
      const h = habits.find(x => x.id === toggle.dataset.toggle);
      if (!h) return;
      const today = todayISO();
      if (h.days[today]) delete h.days[today];
      else { h.days[today] = 1; popId = h.id; }
      setHabits(habits);
      render();
    } else if (rename) {
      const h = habits.find(x => x.id === rename.dataset.rename);
      if (!h) return;
      const name = prompt('Habit name:', h.name);
      if (name === null || !name.trim()) return;
      h.name = name.trim().slice(0, 60);
      const emoji = prompt('Emoji:', h.emoji);
      if (emoji !== null && emoji.trim()) h.emoji = emoji.trim().slice(0, 4);
      setHabits(habits);
      render();
    } else if (del) {
      const h = habits.find(x => x.id === del.dataset.del);
      if (!h || !confirm(`Delete "${h.name}"? Its history goes with it.`)) return;
      setHabits(habits.filter(x => x.id !== h.id));
      render();
      showToast('Habit deleted');
    }
  });

  root.querySelector('#hab-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = root.querySelector('#hab-name').value.trim();
    if (!name) return;
    const emoji = root.querySelector('#hab-emoji').value.trim() || '✅';
    setHabits([...getHabits(), { id: uid(), name: name.slice(0, 60), emoji: emoji.slice(0, 4), days: {} }]);
    e.target.reset();
    root.querySelector('#hab-add').hidden = true;
    render();
  });

  tools.querySelector('#hab-add-btn').addEventListener('click', () => {
    const panel = root.querySelector('#hab-add');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) root.querySelector('#hab-name').focus();
  });

  render();

  return () => {
    document.getElementById('habits-style')?.remove();
  };
}
