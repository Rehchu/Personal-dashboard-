// Fitness module — workout log, weigh-ins, streaks, trends. All localStorage.

import { load, save, uid, todayISO, esc, softDelete, alive } from './store.js';
import { lineChart, barChart } from './charts.js';

const TYPES = ['Strength', 'Run', 'Walk', 'Cycle', 'Swim', 'Sports', 'Stretch', 'Other'];

// Raw lists (tombstones included) are only for writing back; everything the UI
// and stats touch goes through alive() so deleted entries never render or count.
const allWorkouts = () => load('fit.workouts', []);
const allWeights = () => load('fit.weights', []);
const getWorkouts = () => alive(allWorkouts());
const getWeights = () => alive(allWeights());

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekStats(workouts) {
  const days = new Set();
  for (let i = 0; i < 7; i++) days.add(dayKey(i));
  const week = workouts.filter(w => days.has(w.date));
  return {
    count: week.length,
    minutes: week.reduce((s, w) => s + (Number(w.minutes) || 0), 0),
  };
}

function streak(workouts) {
  const dates = new Set(workouts.map(w => w.date));
  let n = 0;
  let offset = dates.has(dayKey(0)) ? 0 : 1; // today counts; else streak may end yesterday
  while (dates.has(dayKey(offset + n))) n++;
  return n;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function mount(root, tools) {
  tools.innerHTML = `
    <a class="btn small" href="https://apextraining.dev" target="_blank" rel="noopener">ApexCoach ↗</a>
    <a class="btn small" href="https://github.com/Rehchu/super-spork" target="_blank" rel="noopener">Super Spork ↗</a>`;

  root.innerHTML = `
    <div class="stat-row" id="fit-stats"></div>
    <div class="grid-2">
      <div class="panel">
        <h3>Log a workout</h3>
        <form id="fit-form">
          <div class="field"><label for="fw-date">Date</label><input id="fw-date" type="date" required></div>
          <div class="field"><label for="fw-type">Type</label>
            <select id="fw-type">${TYPES.map(t => `<option>${t}</option>`).join('')}</select>
          </div>
          <div class="field"><label for="fw-name">What did you do?</label>
            <input id="fw-name" placeholder="Bench press · 5k run · pickup basketball…" required></div>
          <div class="field"><label for="fw-min">Minutes</label>
            <input id="fw-min" type="number" min="1" max="1440" inputmode="numeric" placeholder="45"></div>
          <div class="field"><label for="fw-srw">Sets × reps @ weight (optional)</label>
            <input id="fw-srw" placeholder="3×10 @ 185 lb"></div>
          <div class="field"><label for="fw-notes">Notes</label><input id="fw-notes" placeholder="Felt strong."></div>
          <button class="btn primary" type="submit">Add workout</button>
        </form>
      </div>
      <div>
        <div class="panel" style="margin-bottom:18px">
          <h3>Last 14 days · active minutes</h3>
          <div id="fit-days"></div>
        </div>
        <div class="panel">
          <h3>Weigh-in</h3>
          <form id="wt-form" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px">
            <div class="field" style="margin:0"><label for="wt-date">Date</label><input id="wt-date" type="date" required></div>
            <div class="field" style="margin:0"><label for="wt-val">Weight (lb)</label>
              <input id="wt-val" type="number" min="1" max="1500" step="0.1" inputmode="decimal" required style="width:110px"></div>
            <button class="btn primary" type="submit">Log</button>
          </form>
          <div id="wt-chart"></div>
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h3>History</h3>
      <div style="overflow-x:auto">
        <table class="data"><thead>
          <tr><th>Date</th><th>Type</th><th>Workout</th><th>Min</th><th>Detail</th><th></th></tr>
        </thead><tbody id="fit-rows"></tbody></table>
      </div>
      <p class="muted" id="fit-empty" hidden>Nothing logged yet — first one's on the board in ten seconds.</p>
    </div>`;

  root.querySelector('#fw-date').value = todayISO();
  root.querySelector('#wt-date').value = todayISO();

  function render() {
    const workouts = getWorkouts().slice().sort((a, b) => b.date.localeCompare(a.date));
    const weights = getWeights().slice().sort((a, b) => a.date.localeCompare(b.date));
    const wk = weekStats(workouts);
    const latest = weights[weights.length - 1];

    root.querySelector('#fit-stats').innerHTML = [
      [wk.count, 'workouts this week'],
      [wk.minutes, 'active minutes this week'],
      [`${streak(workouts)}d`, 'current streak'],
      [latest ? `${latest.value} lb` : '—', latest ? `weight · ${fmtDate(latest.date)}` : 'no weigh-ins yet'],
    ].map(([v, l]) => `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`).join('');

    // 14-day bars
    const perDay = new Map();
    for (const w of workouts) perDay.set(w.date, (perDay.get(w.date) || 0) + (Number(w.minutes) || 0));
    const bars = [];
    for (let i = 13; i >= 0; i--) {
      const key = dayKey(i);
      bars.push({ label: fmtDate(key).replace(' ', ' '), sublabel: fmtDate(key), value: perDay.get(key) || 0 });
    }
    const daysEl = root.querySelector('#fit-days');
    daysEl.replaceChildren(barChart({ bars, fmt: v => `${Math.round(v)} min`, labelEvery: 3 }));

    // weight line
    const wtEl = root.querySelector('#wt-chart');
    wtEl.replaceChildren(lineChart({
      points: weights.map(w => ({ label: fmtDate(w.date), value: Number(w.value) })),
      fmt: v => `${Math.round(v * 10) / 10} lb`,
      empty: 'Log a weigh-in to start the trend line',
    }));

    // history table
    const rows = root.querySelector('#fit-rows');
    const recent = workouts.slice(0, 25);
    rows.innerHTML = recent.map(w => `
      <tr>
        <td>${fmtDate(w.date)}</td>
        <td>${esc(w.type)}</td>
        <td>${esc(w.name)}</td>
        <td>${w.minutes || '—'}</td>
        <td>${esc([w.srw, w.notes].filter(Boolean).join(' · ')) || '—'}</td>
        <td><button class="btn small danger" data-del="${w.id}" title="Delete">✕</button></td>
      </tr>`).join('');
    root.querySelector('#fit-empty').hidden = workouts.length > 0;

    rows.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      // tombstone, not a splice: the sync merge unions by id and would bring it back
      save('fit.workouts', softDelete(allWorkouts(), btn.dataset.del));
      render();
    }));
  }

  root.querySelector('#fit-form').addEventListener('submit', e => {
    e.preventDefault();
    const w = {
      id: uid(),
      date: root.querySelector('#fw-date').value || todayISO(),
      type: root.querySelector('#fw-type').value,
      name: root.querySelector('#fw-name').value.trim(),
      minutes: Number(root.querySelector('#fw-min').value) || 0,
      srw: root.querySelector('#fw-srw').value.trim(),
      notes: root.querySelector('#fw-notes').value.trim(),
      ts: Date.now(), // lets the sync merge order this entry against a tombstone
    };
    if (!w.name) return;
    save('fit.workouts', [...allWorkouts(), w]);
    e.target.reset();
    root.querySelector('#fw-date').value = todayISO();
    render();
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  });

  root.querySelector('#wt-form').addEventListener('submit', e => {
    e.preventDefault();
    const date = root.querySelector('#wt-date').value || todayISO();
    const value = Number(root.querySelector('#wt-val').value);
    if (!value) return;
    // one weigh-in per day — latest wins. The replaced entry is a delete like
    // any other, so it gets a tombstone instead of quietly vanishing (a sync
    // merge would otherwise restore it next to the new one).
    let rest = allWeights();
    for (const w of getWeights()) if (w.date === date) rest = softDelete(rest, w.id);
    save('fit.weights', [...rest, { id: uid(), date, value, ts: Date.now() }]);
    root.querySelector('#wt-val').value = '';
    render();
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  });

  render();
}
