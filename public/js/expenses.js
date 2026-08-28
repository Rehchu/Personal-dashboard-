// Expenses module — monthly spending log, category breakdown, budget meter.
// Amounts are integer CENTS everywhere; dollars only exist at the edges
// (parseCents on the way in, fmtMoney on the way out).

import { load, save, uid, todayISO, esc, showToast } from './store.js';
import { barChart } from './charts.js';

const DEFAULT_CATS = [
  'groceries', 'gas', 'eating out', 'bills',
  'shop supplies', 'church', 'subscriptions', 'other',
];

/* ---------- money ---------- */

// "$1,234.50" → 123450. Parsed off the digits so no float ever touches money.
function parseCents(text) {
  const s = String(text ?? '').trim().replace(/[$,\s]/g, '');
  if (!s || s === '.' || !/^\d*(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole || '0') * 100 + Number(`${frac}00`.slice(0, 2));
}

function fmtMoney(cents) {
  const v = Math.abs(Math.round(Number(cents) || 0));
  const body = `${Math.floor(v / 100).toLocaleString()}.${String(v % 100).padStart(2, '0')}`;
  return `${cents < 0 ? '−' : ''}$${body}`;
}

// cents → the "12.50" an <input> should show for editing
const centsToInput = cents => `${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/* ---------- storage ---------- */

// Reads tolerate an older float-dollar `amount` field; `cents` always wins.
// Deletes are tombstones so a sync merge (union by id) can't resurrect them.
function normalize(e) {
  const cents = Number.isFinite(e.cents)
    ? Math.round(e.cents)
    : Math.round((Number(e.amount) || 0) * 100);
  const out = {
    id: typeof e.id === 'string' && e.id ? e.id : uid(),
    cents,
    category: typeof e.category === 'string' && e.category.trim() ? e.category.trim() : 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayISO(),
    note: typeof e.note === 'string' ? e.note : '',
    ts: Number(e.ts) || 0,
  };
  if (e.deleted) out.deleted = 1;
  return out;
}

const getAll = () => {
  const raw = load('expenses', []);
  return Array.isArray(raw) ? raw.filter(e => e && typeof e === 'object').map(normalize) : [];
};

const getLive = () => getAll().filter(e => !e.deleted);

function setAll(list) {
  save('expenses', list);
  window.dispatchEvent(new CustomEvent('pd:data-changed'));
}

function getSettings() {
  const s = load('expenses.settings', null);
  const raw = s && typeof s === 'object' ? s : {};
  const cats = Array.isArray(raw.categories)
    ? raw.categories.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
    : [];
  return {
    budgetCents: Number.isFinite(raw.budgetCents) ? Math.max(0, Math.round(raw.budgetCents)) : 0,
    categories: cats.length ? [...new Set(cats)] : DEFAULT_CATS.slice(),
  };
}

function setSettings(s) {
  save('expenses.settings', s);
  window.dispatchEvent(new CustomEvent('pd:data-changed'));
}

/* ---------- dates ---------- */

const monthOf = iso => iso.slice(0, 7);

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key, opts = { month: 'long', year: 'numeric' }) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
}

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const sumCents = list => list.reduce((s, e) => s + e.cents, 0);

function groupByDay(entries) {
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      total: sumCents(list),
      list: list.sort((a, b) => (b.ts - a.ts) || b.id.localeCompare(a.id)),
    }));
}

const CSS = `
  .exp-monthbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .exp-monthbar #ex-month { flex: 1 1 150px; min-width: 0; }
  .exp-nav { min-width: 44px; }
  .exp-catrow { display: flex; gap: 8px; }
  .exp-catrow select { flex: 1 1 auto; min-width: 0; }
  .exp-formrow { display: flex; gap: 10px; flex-wrap: wrap; }
  .exp-meter { height: 12px; border-radius: 999px; overflow: hidden;
    background: color-mix(in oklab, var(--ink-3) 25%, transparent); }
  .exp-meter > span { display: block; height: 100%; border-radius: 999px; background: var(--accent); }
  .exp-meter.over > span { background: #ff5964; }
  .exp-budget-note { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
  .exp-over { color: #ff8a92; }
  .exp-under { color: #74d19a; }
  .exp-legend { list-style: none; margin-top: 14px; display: grid; gap: 2px; }
  .exp-legend li { display: flex; align-items: baseline; gap: 10px; padding: 7px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--ink-3) 14%, transparent); font-size: 15px; }
  .exp-legend .exp-legend-cat { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exp-legend .exp-legend-pct { color: var(--ink-3); font-size: 13px; }
  .exp-day { margin-bottom: 16px; }
  .exp-day-head { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 6px;
    border-bottom: 1px solid color-mix(in oklab, var(--ink-3) 30%, transparent);
    font-family: var(--font-display); font-size: 12px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-3); }
  .exp-row { display: flex; align-items: center; gap: 10px; padding: 10px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--ink-3) 14%, transparent); }
  .exp-main { flex: 1 1 auto; min-width: 0; }
  .exp-cat { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exp-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exp-amt { font-family: var(--font-display); font-weight: 700; white-space: nowrap; }
  .exp-acts { display: flex; gap: 6px; flex: 0 0 auto; }
  @media (max-width: 760px) {
    /* 44px tap targets — base .btn is shorter than that */
    .exp-panel .btn, .exp-acts .btn, .exp-nav { min-height: 44px; }
    .exp-acts .btn { min-width: 44px; padding: 6px 10px; }
    .exp-panel input, .exp-panel select { min-height: 44px; }
    .exp-formrow .btn { flex: 1 1 auto; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .exp-meter > span { transition: width .3s ease; }
  }`;

export function mount(root, tools) {
  if (!document.getElementById('expenses-style')) {
    const style = document.createElement('style');
    style.id = 'expenses-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  let month = thisMonth();
  let editingId = null;

  tools.innerHTML = '<button class="btn small primary" id="ex-jump">＋ Expense</button>';

  root.innerHTML = `
    <div class="exp-monthbar">
      <button class="btn exp-nav" id="ex-prev" aria-label="Previous month">‹</button>
      <input type="month" id="ex-month" aria-label="Month">
      <button class="btn exp-nav" id="ex-next" aria-label="Next month">›</button>
      <button class="btn small" id="ex-now">This month</button>
    </div>
    <div class="stat-row" id="ex-stats"></div>
    <div class="grid-2">
      <div class="panel exp-panel" id="ex-formpanel">
        <h3 id="ex-formtitle">Add an expense</h3>
        <form id="ex-form">
          <div class="field"><label for="ex-amount">Amount</label>
            <input id="ex-amount" inputmode="decimal" autocomplete="off" placeholder="12.50" required></div>
          <div class="field"><label for="ex-cat">Category</label>
            <div class="exp-catrow">
              <select id="ex-cat"></select>
              <button class="btn" type="button" id="ex-newcat" aria-label="New category" title="New category">＋</button>
            </div>
          </div>
          <div class="field"><label for="ex-date">Date</label><input id="ex-date" type="date" required></div>
          <div class="field"><label for="ex-note">Note</label>
            <input id="ex-note" maxlength="120" autocomplete="off" placeholder="Walmart run"></div>
          <div class="exp-formrow">
            <button class="btn primary" type="submit" id="ex-submit">Add expense</button>
            <button class="btn" type="button" id="ex-cancel" hidden>Cancel</button>
          </div>
        </form>
      </div>
      <div>
        <div class="panel exp-panel" style="margin-bottom:18px">
          <h3>Monthly budget</h3>
          <form id="ex-budget-form" class="exp-formrow" style="align-items:flex-end;margin-bottom:14px">
            <div class="field" style="margin:0;flex:1 1 120px">
              <label for="ex-budget">Budget per month</label>
              <input id="ex-budget" inputmode="decimal" autocomplete="off" placeholder="0.00">
            </div>
            <button class="btn primary" type="submit">Save</button>
          </form>
          <div id="ex-budget-view"></div>
        </div>
        <div class="panel exp-panel">
          <h3>By category</h3>
          <div id="ex-chart"></div>
          <ul class="exp-legend" id="ex-legend"></ul>
          <p class="muted" id="ex-cat-empty" hidden>Nothing logged for this month yet.</p>
        </div>
      </div>
    </div>
    <div class="panel exp-panel" style="margin-top:18px">
      <h3 id="ex-list-title">Entries</h3>
      <div id="ex-list"></div>
      <p class="muted" id="ex-empty" hidden>No expenses this month — add the first one above.</p>
    </div>`;

  const $ = sel => root.querySelector(sel);
  const monthInput = $('#ex-month');
  const amountInput = $('#ex-amount');
  const catSelect = $('#ex-cat');
  const dateInput = $('#ex-date');
  const noteInput = $('#ex-note');

  // a date in the shown month, so switching months doesn't file entries in the wrong one
  const defaultDate = () => (month === thisMonth() ? todayISO() : `${month}-01`);

  function renderCats() {
    const { categories } = getSettings();
    // categories only present on old entries still have to be selectable
    const used = new Set(getLive().map(e => e.category));
    const all = [...new Set([...categories, ...used])];
    const keep = catSelect.value;
    catSelect.innerHTML = all.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (keep && all.includes(keep)) catSelect.value = keep;
  }

  function renderBudget(total) {
    const { budgetCents } = getSettings();
    const view = $('#ex-budget-view');
    if (!budgetCents) {
      view.innerHTML = '<p class="muted">No budget set — enter one above to track how much is left.</p>';
      return;
    }
    const pct = Math.min(100, Math.round((total / budgetCents) * 100));
    const left = budgetCents - total;
    view.innerHTML = `
      <div class="exp-meter${left < 0 ? ' over' : ''}" role="img"
        aria-label="${pct}% of the ${esc(fmtMoney(budgetCents))} budget spent">
        <span style="width:${pct}%"></span>
      </div>
      <div class="exp-budget-note">
        <span class="muted">${fmtMoney(total)} of ${fmtMoney(budgetCents)} spent</span>
        <strong class="${left < 0 ? 'exp-over' : 'exp-under'}">
          ${left < 0 ? `${fmtMoney(-left)} over budget` : `${fmtMoney(left)} left`}
        </strong>
      </div>`;
  }

  function renderBreakdown(entries) {
    const totals = new Map();
    for (const e of entries) totals.set(e.category, (totals.get(e.category) || 0) + e.cents);
    const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const total = sumCents(entries);
    const chart = $('#ex-chart');
    const legend = $('#ex-legend');

    $('#ex-cat-empty').hidden = rows.length > 0;
    if (!rows.length) {
      chart.replaceChildren();
      legend.innerHTML = '';
      return;
    }

    chart.replaceChildren(barChart({
      bars: rows.map(([cat, cents]) => ({
        label: cat.length > 9 ? `${cat.slice(0, 8)}…` : cat,
        sublabel: cat,
        value: cents,
      })),
      fmt: fmtMoney,
    }));

    legend.innerHTML = rows.map(([cat, cents]) => `
      <li>
        <span class="exp-legend-cat">${esc(cat)}</span>
        <span class="exp-legend-pct">${Math.round((cents / total) * 100)}%</span>
        <strong>${fmtMoney(cents)}</strong>
      </li>`).join('');
  }

  function renderList(entries) {
    const days = groupByDay(entries);
    $('#ex-list').innerHTML = days.map(d => `
      <div class="exp-day">
        <div class="exp-day-head"><span>${esc(dayLabel(d.date))}</span><span>${fmtMoney(d.total)}</span></div>
        ${d.list.map(e => `
          <div class="exp-row">
            <div class="exp-main">
              <div class="exp-cat">${esc(e.category)}</div>
              ${e.note ? `<span class="exp-note muted">${esc(e.note)}</span>` : ''}
            </div>
            <div class="exp-amt">${fmtMoney(e.cents)}</div>
            <div class="exp-acts">
              <button class="btn small" data-edit="${esc(e.id)}" aria-label="Edit expense" title="Edit">✎</button>
              <button class="btn small danger" data-del="${esc(e.id)}" aria-label="Delete expense" title="Delete">✕</button>
            </div>
          </div>`).join('')}
      </div>`).join('');
    $('#ex-empty').hidden = entries.length > 0;
  }

  function render() {
    const live = getLive();
    const entries = live.filter(e => monthOf(e.date) === month);
    const prevKey = shiftMonth(month, -1);
    const prev = live.filter(e => monthOf(e.date) === prevKey);
    const total = sumCents(entries);
    const prevTotal = sumCents(prev);
    const diff = total - prevTotal;
    const { budgetCents } = getSettings();
    const left = budgetCents - total;

    monthInput.value = month;
    $('#ex-now').hidden = month === thisMonth();
    $('#ex-list-title').textContent = `${monthLabel(month)} · entries`;

    const shortPrev = monthLabel(prevKey, { month: 'short' });
    const trend = !prevTotal && !total ? ['—', `nothing in ${shortPrev}`]
      : !prevTotal ? [fmtMoney(total), `nothing in ${shortPrev}`]
        : diff === 0 ? ['same', `as ${shortPrev}`]
          : [`${diff > 0 ? '↑' : '↓'} ${fmtMoney(Math.abs(diff))}`,
            `${diff > 0 ? 'more' : 'less'} than ${shortPrev}`];

    $('#ex-stats').innerHTML = [
      [fmtMoney(total), `spent in ${monthLabel(month, { month: 'short' })}`],
      [String(entries.length), entries.length === 1 ? 'entry' : 'entries'],
      trend,
      budgetCents
        ? [fmtMoney(Math.abs(left)), left < 0 ? 'over budget' : 'left of budget']
        : ['—', 'no budget set'],
    ].map(([v, l]) => `
      <div class="stat-tile"><div class="stat-value">${esc(v)}</div><div class="stat-label">${esc(l)}</div></div>`).join('');

    renderCats();
    renderBudget(total);
    renderBreakdown(entries);
    renderList(entries);
  }

  function startEdit(entry) {
    editingId = entry.id;
    amountInput.value = centsToInput(entry.cents);
    renderCats();
    catSelect.value = entry.category;
    dateInput.value = entry.date;
    noteInput.value = entry.note;
    $('#ex-formtitle').textContent = 'Edit expense';
    $('#ex-submit').textContent = 'Save changes';
    $('#ex-cancel').hidden = false;
    $('#ex-formpanel').scrollIntoView({ block: 'nearest' });
    amountInput.focus();
  }

  function resetForm() {
    editingId = null;
    amountInput.value = '';
    noteInput.value = '';
    dateInput.value = defaultDate();
    $('#ex-formtitle').textContent = 'Add an expense';
    $('#ex-submit').textContent = 'Add expense';
    $('#ex-cancel').hidden = true;
  }

  $('#ex-form').addEventListener('submit', e => {
    e.preventDefault();
    const cents = parseCents(amountInput.value);
    if (cents === null || cents <= 0) {
      showToast('Enter an amount like 12.50');
      amountInput.focus();
      return;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) ? dateInput.value : defaultDate();
    const patch = {
      cents,
      category: catSelect.value || 'other',
      date,
      note: noteInput.value.trim().slice(0, 120),
      ts: Date.now(),
    };
    const all = getAll();
    if (editingId) {
      const i = all.findIndex(x => x.id === editingId);
      if (i < 0) { resetForm(); render(); return; }
      all[i] = { ...all[i], ...patch };
      showToast('Expense updated');
    } else {
      all.push({ id: uid(), ...patch });
    }
    setAll(all);
    month = monthOf(date); // follow the entry so it is never saved out of sight
    resetForm();
    render();
  });

  $('#ex-cancel').addEventListener('click', () => { resetForm(); render(); });

  $('#ex-newcat').addEventListener('click', () => {
    const name = prompt('New category:');
    if (name === null) return;
    const clean = name.trim().slice(0, 30).toLowerCase();
    if (!clean) return;
    const s = getSettings();
    if (!s.categories.includes(clean)) setSettings({ ...s, categories: [...s.categories, clean] });
    renderCats();
    catSelect.value = clean;
  });

  $('#ex-budget-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#ex-budget');
    const cents = input.value.trim() === '' ? 0 : parseCents(input.value);
    if (cents === null) { showToast('Enter a budget like 1200'); return; }
    setSettings({ ...getSettings(), budgetCents: cents });
    input.value = '';
    input.blur();
    showToast(cents ? `Budget set to ${fmtMoney(cents)}` : 'Budget cleared');
    render();
  });

  root.addEventListener('click', e => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      const entry = getLive().find(x => x.id === edit.dataset.edit);
      if (entry) startEdit(entry);
    } else if (del) {
      const all = getAll();
      const entry = all.find(x => x.id === del.dataset.del);
      if (!entry || !confirm(`Delete ${fmtMoney(entry.cents)} · ${entry.category}?`)) return;
      // tombstone, not a splice: a sync merge unions by id and would bring it back
      entry.deleted = 1;
      entry.ts = Date.now();
      setAll(all);
      if (editingId === entry.id) resetForm();
      render();
      showToast('Expense deleted');
    }
  });

  $('#ex-prev').addEventListener('click', () => { month = shiftMonth(month, -1); if (!editingId) resetForm(); render(); });
  $('#ex-next').addEventListener('click', () => { month = shiftMonth(month, 1); if (!editingId) resetForm(); render(); });
  $('#ex-now').addEventListener('click', () => { month = thisMonth(); if (!editingId) resetForm(); render(); });
  monthInput.addEventListener('change', () => {
    if (!/^\d{4}-\d{2}$/.test(monthInput.value)) { monthInput.value = month; return; }
    month = monthInput.value;
    if (!editingId) resetForm();
    render();
  });

  tools.querySelector('#ex-jump').addEventListener('click', () => {
    $('#ex-formpanel').scrollIntoView({ block: 'nearest' });
    amountInput.focus();
  });

  // a sync pull rewrites localStorage under us — repaint when it lands
  const onData = () => render();
  window.addEventListener('pd:data-changed', onData);

  resetForm();
  render();

  return () => {
    window.removeEventListener('pd:data-changed', onData);
    document.getElementById('expenses-style')?.remove();
  };
}
