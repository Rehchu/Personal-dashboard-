// Cross-device sync client. Whole collections are pushed/pulled against the
// Worker's D1-backed /api/sync endpoints with per-collection revisions.
// Opt-in: nothing syncs until a passphrase is set (control center → Sync).
// Conflict strategy: arrays of {id,…} are unioned by id (local wins for the
// same id, since this device was just editing); everything else last-write-wins.

import { load, save, onSave, debounce, showToast } from './store.js';

const COLS = [
  'fit.workouts', 'fit.weights', 'books', 'nb.pages', 'habits', 'inbox',
  'trophies', 'writing.daylog', 'writing.sprints',
  'ui.themesUsed', 'ui.consolesUsed', 'memories', 'expenses', 'expenses.settings',
];

let key = load('sync.key', null);
let meta = load('sync.meta', {});          // {col: {rev}}
let dirty = new Set(load('sync.dirty', []));
let applying = false;                       // suppress dirty-marking during pull
let busy = false;
let lastSync = load('sync.last', 0);
let lastError = null;

const persistMeta = () => { applying = true; save('sync.meta', meta); save('sync.dirty', [...dirty]); applying = false; };

onSave((k) => {
  if (applying || k.startsWith('sync.')) return;
  if (!COLS.includes(k)) return;
  dirty.add(k);
  applying = true; save('sync.dirty', [...dirty]); applying = false;
  if (key) schedulePush();
});

async function api(path, opts = {}) {
  const res = await fetch(`/api/sync/${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'X-Sync-Key': key || '', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(body.error || `sync ${res.status}`);
  return { status: res.status, body };
}

function mergeCol(serverData, localData) {
  if (Array.isArray(serverData) && Array.isArray(localData) && (serverData[0]?.id || localData[0]?.id)) {
    const byId = new Map();
    for (const item of serverData) if (item && item.id) byId.set(item.id, item);
    for (const item of localData) if (item && item.id) byId.set(item.id, item); // local wins
    return [...byId.values()];
  }
  if (serverData && localData && typeof serverData === 'object' && !Array.isArray(serverData)
    && typeof localData === 'object' && !Array.isArray(localData)) {
    return { ...serverData, ...localData }; // maps like trophies/daylog: union, local wins
  }
  return localData ?? serverData;
}

async function pull() {
  const { body } = await api('state');
  for (const [col, info] of Object.entries(body.cols || {})) {
    if (!COLS.includes(col)) continue;
    const localRev = meta[col]?.rev || 0;
    if (info.rev <= localRev) continue;
    const { body: colBody } = await api(`col/${encodeURIComponent(col)}`);
    if (colBody.data === null) continue;
    const localData = load(col, null);
    const merged = dirty.has(col) ? mergeCol(colBody.data, localData) : colBody.data;
    applying = true;
    save(col, merged);
    applying = false;
    meta[col] = { rev: colBody.rev };
    if (dirty.has(col)) dirty.add(col); // still needs a push of the merge
  }
  persistMeta();
  window.dispatchEvent(new CustomEvent('pd:data-changed'));
}

async function pushCol(col) {
  const data = load(col, null);
  if (data === null) { dirty.delete(col); return; }
  const baseRev = meta[col]?.rev || 0;
  const { status, body } = await api(`col/${encodeURIComponent(col)}`, {
    method: 'PUT',
    body: JSON.stringify({ baseRev, data }),
  });
  if (status === 409) {
    const merged = mergeCol(body.data, data);
    applying = true; save(col, merged); applying = false;
    const retry = await api(`col/${encodeURIComponent(col)}`, {
      method: 'PUT',
      body: JSON.stringify({ baseRev: body.rev, data: merged }),
    });
    if (retry.status === 409) throw new Error(`sync conflict on ${col}`);
    meta[col] = { rev: retry.body.rev };
  } else {
    meta[col] = { rev: body.rev };
  }
  dirty.delete(col);
}

async function push() {
  for (const col of [...dirty]) await pushCol(col);
  persistMeta();
}

async function fullSync() {
  if (!key || busy || !navigator.onLine) return;
  busy = true;
  lastError = null;
  try {
    await pull();
    await push();
    lastSync = Date.now();
    save('sync.last', lastSync);
  } catch (err) {
    lastError = err.message;
  } finally {
    busy = false;
  }
}

const schedulePush = debounce(fullSync, 4000);

export const sync = {
  enabled: () => Boolean(key),
  status() {
    if (!key) return 'Sync off';
    if (busy) return 'Syncing…';
    if (lastError) return `Sync error`;
    if (lastSync) return `Synced ${new Date(lastSync).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    return 'Sync on';
  },
  lastError: () => lastError,

  // Set up (or connect to) the account passphrase, then run a full cycle.
  async setup(passphrase) {
    const res = await fetch('/api/sync/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: passphrase }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `claim failed (${res.status})`);
    key = passphrase;
    save('sync.key', key);
    for (const col of COLS) if (load(col, null) !== null) dirty.add(col);
    await fullSync();
    showToast(body.claimed ? 'Sync enabled — this device set the passphrase' : 'Sync connected');
    return true;
  },

  disable() {
    key = null;
    save('sync.key', null);
    showToast('Sync off (data stays on this device)');
  },

  init() {
    if (!key) return;
    fullSync();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastSync > 60_000) fullSync();
    });
    window.addEventListener('online', () => fullSync());
  },
};
