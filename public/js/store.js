// Tiny localStorage JSON store. Everything is namespaced under "pd."
// so the dashboard can never collide with other apps on the same origin.

const PREFIX = 'pd.';

// Save subscribers (sync engine): called with (key, value) after each write.
const saveHooks = [];
export function onSave(fn) { saveHooks.push(fn); }

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    return false; // private mode / quota — app keeps working in memory
  }
  for (const fn of saveHooks) { try { fn(key, value); } catch { /* noop */ } }
  return true;
}

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastEl;
let toastTimer;
export function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
