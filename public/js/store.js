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

// Tombstoned deletes for the array-of-{id} collections. The sync engine unions
// those lists by id, so a plain splice resurrects the moment another device
// pushes its copy. Instead the item is replaced by a tiny marker — only the id,
// a deleted flag, and when — so the merge can see the deletion and let the
// newest intent win (see mergeCol in sync.js).
export function softDelete(list, id) {
  return (Array.isArray(list) ? list : [])
    .map(it => (it && it.id === id ? { id, deleted: 1, ts: Date.now() } : it));
}

// What UIs and stats should render: the list without its tombstones. A list
// that never had a delete passes through untouched.
export function alive(list) {
  return (Array.isArray(list) ? list : []).filter(it => !it?.deleted);
}

// Every stored key, un-prefixed — so the sync engine can push all of them
// instead of a hand-maintained whitelist.
export function keys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch { /* private mode — nothing stored */ }
  return out;
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
    // role=status carries an implicit aria-live=polite, so screen readers
    // announce each toast without us wiring up the attribute by hand.
    toastEl.setAttribute('role', 'status');
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
