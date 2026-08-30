// Cross-device sync client. Whole collections are pushed/pulled against the
// Worker's D1-backed /api/sync endpoints with per-collection revisions.
// Opt-in: nothing syncs until a passphrase is set (control center → Sync).
//
// Everything syncs. Rather than a hand-maintained whitelist, every stored key is
// synced except a small denylist of state that is meaningless or harmful to carry
// between devices (the sync engine's own bookkeeping, an in-progress upload that
// points at a file only on this device, and the focused-tile index that changes
// on every keypress).
//
// Every payload is encrypted client-side with a key derived from the passphrase
// (see synccrypto.js), so D1 only ever holds ciphertext — the camera password and
// the Cloudflare Access token included. Local storage stays plaintext; encryption
// wraps only the trip to and from the cloud.
//
// Conflict strategy: arrays of {id,…} are unioned by id (local wins for the same
// id, since this device was just editing); everything else last-write-wins.

import { load, save, onSave, debounce, showToast, keys as allStoredKeys } from './store.js';
import { deriveKey, encryptData, decryptData } from './synccrypto.js';

// Never synced. sync.* is the engine's own state; ui.bgUpload resumes a multipart
// upload whose file lives only on the device that started it; ui.tile is the
// current scroll position and would push on every tile the user browses past.
const DENY = new Set(['ui.bgUpload', 'ui.tile']);
const syncable = k => !k.startsWith('sync.') && !DENY.has(k);

let key = load('sync.key', null);
let meta = load('sync.meta', {});          // {col: {rev}}
let dirty = new Set(load('sync.dirty', []));
let applying = false;                       // suppress dirty-marking during pull
let busy = false;
let lastSync = load('sync.last', 0);
let lastError = null;

// AES-GCM key derived from the passphrase, memoized for the life of this key.
let cryptoKey = null;
let cryptoKeyFor = null;
async function subtleKey() {
  if (!key) return null;
  if (cryptoKey && cryptoKeyFor === key) return cryptoKey;
  cryptoKey = await deriveKey(key);
  cryptoKeyFor = key;
  return cryptoKey;
}

const persistMeta = () => { applying = true; save('sync.meta', meta); save('sync.dirty', [...dirty]); applying = false; };

onSave((k) => {
  if (applying || k.startsWith('sync.')) return;
  if (!syncable(k)) return;
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

// Decrypt a value that came off the wire; legacy plaintext passes straight
// through. A wrong-key / tampered blob throws, and callers skip that collection
// rather than overwrite good local data with garbage.
async function decode(wire) {
  const ck = await subtleKey();
  if (!ck) return wire; // shouldn't happen while syncing, but never crash on it
  return decryptData(ck, wire);
}
async function encode(value) {
  const ck = await subtleKey();
  if (!ck) return value;
  return encryptData(ck, value);
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
    if (!syncable(col)) continue;
    const localRev = meta[col]?.rev || 0;
    if (info.rev <= localRev) continue;
    const { body: colBody } = await api(`col/${encodeURIComponent(col)}`);
    if (colBody.data === null) continue;
    let serverData;
    try {
      serverData = await decode(colBody.data);
    } catch {
      lastError = `could not decrypt ${col}`; // wrong passphrase or corrupt blob — leave local untouched
      continue;
    }
    const localData = load(col, null);
    const merged = dirty.has(col) ? mergeCol(serverData, localData) : serverData;
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
    body: JSON.stringify({ baseRev, data: await encode(data) }),
  });
  if (status === 409) {
    const serverData = await decode(body.data);
    const merged = mergeCol(serverData, data);
    applying = true; save(col, merged); applying = false;
    const retry = await api(`col/${encodeURIComponent(col)}`, {
      method: 'PUT',
      body: JSON.stringify({ baseRev: body.rev, data: await encode(merged) }),
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
    cryptoKey = null; // force re-derivation for the new key
    save('sync.key', key);
    // push everything this device already has (minus the denylist)
    for (const col of allStoredKeys()) if (syncable(col) && load(col, null) !== null) dirty.add(col);
    await fullSync();
    showToast(body.claimed ? 'Sync enabled — this device set the passphrase' : 'Sync connected');
    return true;
  },

  disable() {
    key = null;
    cryptoKey = null;
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
