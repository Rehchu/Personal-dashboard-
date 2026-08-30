// Dashboard shell — console-style tile rail, hero panel, theming, module host.
// Two console modes (PlayStation-style layout + Xbox-style layout), six themes,
// synthesized UI sounds, ambient particles, control center, trophies.

import { TILES } from './data.js';
import { load, save, esc, showToast, keys as storeKeys } from './store.js';
import { sfx } from './sfx.js';
import { initAmbient } from './ambient.js';
import { initStorm } from './storm.js';
import { makeClip, clipSupported } from './videoclip.js';
import { ICONS } from './icons.js';
import { initAchievements, trophyCaseHTML } from './achievements.js';
import { activityCards } from './activity.js';
import { sync } from './sync.js';
import * as github from './github.js';
import * as fitness from './fitness.js';
import * as writing from './writing.js';
import * as notebook from './notebook.js';
import * as expenses from './expenses.js';
import * as cloudflare from './cloudflare.js';
import * as today from './today.js';
import * as habits from './habits.js';
import * as dragons from './dragons.js';
import * as archive from './archive.js';
import * as ptz from './ptz.js';
import * as csvedit from './csvedit.js';
import * as service from './service.js';
import * as biz from './biz.js';
import * as gaming from './gaming.js';
import * as town from './town.js';

const MODULES = {
  today: { title: 'Today', mount: today.mount },
  ops: { title: 'Mission Control', mount: biz.mount },
  projects: { title: 'GitHub Projects', mount: github.mount },
  fitness: { title: 'Fitness', mount: fitness.mount },
  writing: { title: 'Book Writing', mount: writing.mount },
  notebook: { title: 'Notebook', mount: notebook.mount },
  habits: { title: 'Habits', mount: habits.mount },
  dragons: { title: 'Dragon Vault', mount: dragons.mount },
  archive: { title: 'Chat Archive', mount: archive.mount },
  expenses: { title: 'Expenses', mount: expenses.mount },
  cloudflare: { title: 'Cloudflare Fleet', mount: cloudflare.mount },
  ptz: { title: 'Church Cameras', mount: ptz.mount },
  csv: { title: 'Song Bank', mount: csvedit.mount },
  service: { title: 'Service Planner', mount: service.mount },
  gaming: { title: 'Gaming', mount: gaming.mount },
  town: { title: 'Dyer Town', mount: town.mount },
};

const $ = sel => document.querySelector(sel);

/* ---------- themes & consoles ---------- */
const GAME_THEMES = ['assassins', 'cyberpunk', 'gtav', 'minecraft', 'masseffect'];
// xboxgreen is the original green skin; playstation / xboxone are the two console
// skins — each with its own generated background — kept out of GAME_THEMES so the
// "try all five game themes" trophy still means the five franchises.
const THEMES = [...GAME_THEMES, 'xboxgreen', 'playstation', 'xboxone'];
const THEME_NAMES = {
  assassins: "Assassin's Creed",
  cyberpunk: 'Cyberpunk',
  gtav: 'GTA V',
  minecraft: 'Minecraft',
  masseffect: 'Mass Effect',
  xboxgreen: 'Xbox',
  playstation: 'PlayStation',
  xboxone: 'Xbox One',
};

let consoleMode = load('console', 'ps') === 'xbox' ? 'xbox' : 'ps';
let uiReady = false; // suppress sounds/fx during initial paint

const ambient = initAmbient($('#fx-canvas'));

/* ---------- animated background: storm / video / off ---------- */
const storm = initStorm($('#storm-canvas'));
const bgVideo = $('#bg-video');
let videoOk = false;
bgVideo.addEventListener('canplay', () => { videoOk = true; });
bgVideo.addEventListener('error', () => { videoOk = false; });
let bgMode = load('ui.bg', 'storm');
// reduced motion decides the DEFAULT background only. Picking one in the
// control center is the owner asking for it, so an explicit choice wins —
// and only an explicit choice is persisted.
let bgChosen = load('ui.bg', null) !== null;

function applyBg(mode, explicit = false) {
  if (explicit) { bgChosen = true; save('ui.bg', mode); }
  if (!bgChosen && matchMedia('(prefers-reduced-motion: reduce)').matches) mode = 'off';
  // The element ships with no src (see index.html) so Storm/Off never fetches
  // the video. The first time a video background is actually asked for, point it
  // at the selected-background route and load — canplay then flips videoOk true
  // (the init listener below re-runs applyBg('video')). A specific clip set by
  // playSelectedBg/playThemeBg already owns .src, so don't clobber it.
  if (mode === 'video' && !bgVideo.src) { bgVideo.src = '/media/bg.mp4'; bgVideo.load(); }
  if (mode === 'video' && !videoOk) mode = 'storm';
  bgMode = mode;
  document.documentElement.dataset.bg = mode;
  bgVideo.hidden = mode !== 'video';
  if (mode === 'video') bgVideo.play().catch(() => { applyBg('storm', explicit); });
  else bgVideo.pause();
  if (mode === 'storm') storm.start(bgChosen); else storm.stop();
}

function cycleBg() {
  // Video is offered once a clip has proven playable (videoOk) OR the gallery
  // holds backgrounds — since the video no longer preloads, a fresh page can't
  // have flipped videoOk yet even though a perfectly good clip is one tap away.
  // Choosing Video then lazily loads the clip: storm shows for a beat, and the
  // init canplay listener promotes to video the moment the file is ready.
  const haveVideo = videoOk || gallery.items.length > 0;
  const order = haveVideo ? ['storm', 'video', 'off'] : ['storm', 'off'];
  applyBg(order[(order.indexOf(bgMode) + 1) % order.length], true);
}

const BG_LABEL = { storm: 'Bg: Storm', video: 'Bg: Video', off: 'Bg: Off' };

function trackUse(key, value) {
  const used = new Set(load(key, []));
  if (!used.has(value)) {
    used.add(value);
    save(key, [...used]);
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  }
}

function runSwitchFx(theme) {
  const fx = $('#switch-fx');
  if (!fx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  fx.className = '';
  void fx.offsetWidth; // restart the animation
  fx.className = `run fx-${theme}`;
  clearTimeout(runSwitchFx.t);
  runSwitchFx.t = setTimeout(() => { fx.className = ''; }, 800);
}

function applyTheme(name, { announce = false, fx = false } = {}) {
  if (!THEMES.includes(name)) name = consoleMode === 'xbox' ? 'xboxgreen' : 'masseffect';
  document.documentElement.dataset.theme = name;
  save(`theme.${consoleMode}`, name);
  if (GAME_THEMES.includes(name)) trackUse('ui.themesUsed', name);
  document.querySelectorAll('.theme-dot').forEach(b => {
    const active = b.dataset.setTheme === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  ambient.setTheme(name);
  applyThemeBg(name); // if this theme owns a background, show it (no-op otherwise)
  if (fx && uiReady) runSwitchFx(name);
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  });
  if (announce) { sfx.play('switch'); showToast(`${THEME_NAMES[name]} theme`); }
}

function updateConsoleBtn() {
  const btn = $('#console-btn');
  const target = consoleMode === 'ps' ? 'xbox' : 'ps';
  btn.innerHTML = ICONS[target];
  const label = target === 'xbox' ? 'Switch to Xbox view' : 'Switch to PlayStation view';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function applyConsole(mode, { announce = false } = {}) {
  consoleMode = mode === 'xbox' ? 'xbox' : 'ps';
  document.documentElement.dataset.console = consoleMode;
  save('console', consoleMode);
  sfx.setConsole(consoleMode);
  trackUse('ui.consolesUsed', consoleMode);
  applyTheme(load(`theme.${consoleMode}`, consoleMode === 'xbox' ? 'xboxgreen' : 'masseffect'),
    { fx: uiReady });
  updateConsoleBtn();
  if (announce) {
    sfx.play('switch');
    showToast(consoleMode === 'xbox' ? 'Xbox view' : 'PlayStation view');
  }
}

document.querySelectorAll('.theme-dot').forEach(btn => {
  const ico = ICONS[btn.dataset.setTheme];
  if (ico) btn.innerHTML = ico;
  btn.addEventListener('click', () => applyTheme(btn.dataset.setTheme, { announce: true, fx: true }));
});

$('#console-btn').addEventListener('click', () =>
  applyConsole(consoleMode === 'ps' ? 'xbox' : 'ps', { announce: true }));

/* ---------- clock ---------- */
function tickClock() {
  const now = new Date();
  $('#clock-time').textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  $('#clock-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
tickClock();
setInterval(tickClock, 30 * 1000);

/* ---------- tile rail ---------- */
const rail = $('#rail');
let focusIndex = Math.min(load('ui.tile', 0), TILES.length - 1);
let tileEls = [];

// the mark of whatever service a tile opens, taken from its own link
function iconHost(t) {
  if (t.icon) return t.icon;
  const link = (t.actions || []).find(a => a.href && a.href.startsWith('https://'));
  try {
    return link ? new URL(link.href).hostname : '';
  } catch {
    return '';
  }
}

function renderRail() {
  rail.innerHTML = '';
  tileEls = TILES.map((t, i) => {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-label', t.title);
    tile.style.setProperty('--tile-accent', t.accent);
    const host = iconHost(t);
    tile.innerHTML = `<span class="tile-glyph" aria-hidden="true">${t.glyph}</span>
      ${host ? `<img class="tile-logo" src="/api/icon?host=${encodeURIComponent(host)}" alt="" aria-hidden="true" loading="lazy">` : ''}
      ${t.badge ? `<span class="badge">${esc(t.badge)}</span>` : ''}
      <span class="tile-label">${esc(t.title)}</span>`;
    // a host with no reachable mark keeps its glyph rather than showing a gap
    const logo = tile.querySelector('.tile-logo');
    if (logo) logo.addEventListener('error', () => logo.remove(), { once: true });
    tile.addEventListener('click', () => {
      // touch devices: one tap opens (the focus-then-open dance is for
      // pointer/keyboard consoles, not phones)
      if (i === focusIndex || matchMedia('(hover: none)').matches) {
        setFocus(i, false);
        activate(t);
      } else {
        setFocus(i);
      }
    });
    tile.addEventListener('pointerenter', e => {
      if (e.pointerType === 'mouse') setFocus(i, false);
    });
    rail.append(tile);
    return tile;
  });
  setFocus(focusIndex, false);
}

function setFocus(i, scroll = true) {
  const next = Math.max(0, Math.min(TILES.length - 1, i));
  const changed = next !== focusIndex;
  focusIndex = next;
  save('ui.tile', focusIndex);
  tileEls.forEach((el, j) => {
    el.classList.toggle('focused', j === focusIndex);
    el.setAttribute('aria-selected', String(j === focusIndex));
  });
  const t = TILES[focusIndex];
  if (scroll) tileEls[focusIndex].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  if (changed && uiReady) sfx.play('move');

  $('#hero-watermark').textContent = t.glyph;
  $('#hero-title').textContent = t.title;
  $('#hero-desc').textContent = t.desc;
  const icon = $('#hero-icon');
  icon.textContent = t.glyph;
  icon.style.setProperty('--hero-accent', t.accent);
  icon.style.background = `linear-gradient(150deg, color-mix(in oklab, ${t.accent} 85%, white 8%), color-mix(in oklab, ${t.accent} 55%, black 35%))`;

  const actions = $('#hero-actions');
  actions.innerHTML = '';
  (t.actions || []).forEach((a, k) => {
    let node;
    if (a.href) {
      node = document.createElement('a');
      node.href = a.href;
      node.target = '_blank';
      node.rel = 'noopener';
      node.textContent = a.label;
    } else {
      node = document.createElement('button');
      node.textContent = a.label;
      node.addEventListener('click', () => activate(t));
    }
    node.className = 'hero-btn' + (k === 0 ? ' primary' : '');
    actions.append(node);
  });

  // PS5-style activity cards for the focused tile
  const act = $('#activity');
  const cards = activityCards(t.id);
  if (cards) act.replaceChildren(cards);
  else act.replaceChildren();
}

function activate(t) {
  if (t.kind === 'module') { sfx.play('open'); openModule(t.id); }
  else if (t.url) { sfx.play('select'); window.open(t.url, '_blank', 'noopener'); }
}

/* ---------- module host ---------- */
const appview = $('#appview');
let unmount = null;

function openModule(id) {
  const mod = MODULES[id];
  if (!mod) return;
  $('#appview-title').textContent = mod.title;
  // the tab/window title should follow the open module, then restore on close
  document.title = `${mod.title} — Dyer HQ`;
  const tools = $('#appview-tools');
  const body = $('#appview-body');
  tools.innerHTML = '';
  body.innerHTML = '';
  appview.hidden = false;
  // Make the background untabbable + invisible to assistive tech while the
  // full-screen module owns the view, and push a history entry so the phone
  // back gesture closes the module instead of leaving the app.
  setBgInert(true);
  pushOverlayState();
  ambient.pause(); // the module view fully covers the background layers
  storm.stop();
  if (!bgVideo.hidden) bgVideo.pause();
  try {
    unmount = mod.mount(body, tools) || null;
  } catch (err) {
    body.innerHTML = `<p class="muted">This module hit an error: ${esc(err.message)}</p>`;
    // a crashed mount was a dead end — give a way back into the module
    const retry = document.createElement('button');
    retry.className = 'btn';
    retry.style.marginTop = '12px';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => openModule(id));
    body.append(retry);
  }
  // move focus into the overlay so keyboard users are not stranded behind it
  const back = $('#appview-back');
  if (back) back.focus();
}

function closeModule() {
  if (appview.hidden) return;
  if (typeof unmount === 'function') { try { unmount(); } catch { /* noop */ } }
  unmount = null;
  appview.hidden = true;
  document.title = 'Dyer HQ — Dashboard';
  // hand the background back to the keyboard/AT (unless the control center is
  // still up over it) and drop the history entry we pushed on open
  if (ccenter.hidden) setBgInert(false);
  consumeOverlayState();
  $('#appview-body').innerHTML = '';
  $('#appview-tools').innerHTML = '';
  ambient.resume();
  if (bgMode === 'storm') storm.start();
  if (bgMode === 'video' && !bgVideo.hidden) bgVideo.play().catch(() => { /* noop */ });
  sfx.play('back');
  setFocus(focusIndex, false); // refresh activity cards with any new data
  rail.focus({ preventScroll: true });
}

$('#appview-back').addEventListener('click', closeModule);

/* ---------- control center / guide ---------- */
const ccenter = $('#ccenter');
const ccActions = $('#cc-actions');
const ccExtra = $('#cc-extra');

/* ---------- overlay plumbing (focus, inert, phone back) ----------
   An open overlay (module or control center) must take the background out of
   the tab order for keyboard/AT users, and register a history entry so the
   Android/browser back gesture just closes the overlay instead of exiting the
   whole PWA. The two overlays are mutually exclusive in practice (the control
   center can only be reached from the home screen), so a single pushed entry
   is enough. */
const BG_LAYERS = ['#topbar', '#pill-nav', '#home'];
function setBgInert(on) {
  BG_LAYERS.forEach(sel => {
    const el = $(sel);
    if (el) el.toggleAttribute('inert', on); // guard: a skin could drop a layer
  });
}

let overlayStatePushed = false; // true while our synthetic history entry exists
let handlingPop = false;        // guards against re-entrancy from history.back()
function pushOverlayState() {
  if (overlayStatePushed) return; // idempotent — never stack entries
  overlayStatePushed = true;
  try { history.pushState({ pdOverlay: true }, ''); } catch { /* noop */ }
}
// Drop our entry when an overlay closes by any route other than the back
// gesture, so the next back press still leaves the app.
function consumeOverlayState() {
  if (handlingPop || !overlayStatePushed) return;
  if (!(appview.hidden && ccenter.hidden)) return; // another overlay still open
  overlayStatePushed = false;
  try { history.back(); } catch { /* noop */ }
}
window.addEventListener('popstate', () => {
  overlayStatePushed = false; // this entry has now been popped by the browser
  handlingPop = true;
  if (!ccenter.hidden) hideCC();
  else if (!appview.hidden) closeModule();
  handlingPop = false;
});

/* ---------- PWA install prompt ----------
   Chrome fires beforeinstallprompt when the app is installable; the native
   prompt can only be shown from that stashed event, later, on a user gesture. */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; });

let ccInvoker = null; // element to restore focus to when the control center closes

async function lockApp() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* offline */ }
  location.reload(); // the Worker now serves the login screen
}

/* ---------- background video upload ----------
   Cloudflare rejects a request body over 100 MB at the edge, so anything
   bigger than SINGLE_MAX is cut into equal parts and pushed through R2's
   multipart API — one request per part, retried individually, and resumable
   across reloads (a 375 MB phone upload will not survive in one shot). */
const MPU_PART = 16 * 1024 * 1024;
const MPU_SINGLE_MAX = 80 * 1024 * 1024;
const MB = 1048576;

function uploadPanel(onCancel) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:50%;transform:translateX(-50%);
    bottom:calc(78px + env(safe-area-inset-bottom));width:min(420px,92vw);z-index:60;
    background:color-mix(in oklab, var(--surface) 96%, transparent);backdrop-filter:blur(14px);
    border:1px solid color-mix(in oklab, var(--ink-3) 30%, transparent);border-radius:14px;
    padding:13px 15px;box-shadow:0 18px 40px -18px rgba(0,0,0,.8);color:var(--ink)`;
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px">
      <span id="up-text" style="flex:1;font-size:13px">Preparing…</span>
      <button id="up-cancel" style="font-size:12px;color:var(--ink-3);padding:4px 6px">Cancel</button>
    </div>
    <div style="height:6px;border-radius:99px;margin-top:9px;overflow:hidden;
      background:color-mix(in oklab, var(--ink-3) 25%, transparent)">
      <div id="up-bar" style="height:100%;width:0;background:var(--accent);transition:width 200ms ease"></div>
    </div>`;
  document.body.append(el);
  el.querySelector('#up-cancel').addEventListener('click', onCancel);
  return {
    set(pct, text) {
      el.querySelector('#up-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
      el.querySelector('#up-text').textContent = text;
    },
    close() { el.remove(); },
  };
}

async function mpuFetch(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      // a rejected part is worth retrying; a rejected request shape is not
      if (res.status < 500 && res.status !== 408) throw new Error(body.error || `HTTP ${res.status}`);
      lastErr = new Error(body.error || `HTTP ${res.status}`);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 1000 * 3 ** i));
  }
  throw lastErr;
}

function loadResume(file, name) {
  const st = load('ui.bgUpload', null);
  if (!st || st.name !== name || st.size !== file.size || st.partSize !== MPU_PART) return null;
  return st;
}

async function uploadMultipart(file, panel, signal, label) {
  const name = file.name || 'clip'; // a trimmed clip is a Blob, with no name
  let state = loadResume(file, name);
  if (state) {
    showToast(`Resuming at part ${state.parts.length + 1}`);
  } else {
    // the id names the object this upload is filling, so two devices uploading
    // at the same time write to two objects instead of over each other
    const { uploadId, id } = await mpuFetch('/api/media/bg/mpu/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: file.type || 'video/mp4' }),
      signal,
    });
    state = { uploadId, id, name, size: file.size, partSize: MPU_PART, parts: [] };
    save('ui.bgUpload', state);
  }

  const total = Math.ceil(file.size / MPU_PART);
  for (let n = state.parts.length + 1; n <= total; n++) {
    const chunk = file.slice((n - 1) * MPU_PART, Math.min(n * MPU_PART, file.size));
    const done = (n - 1) * MPU_PART;
    panel.set((done / file.size) * 100,
      `Uploading part ${n} of ${total} — ${(done / MB).toFixed(0)}/${(file.size / MB).toFixed(0)} MB`);
    const part = await mpuFetch(
      `/api/media/bg/mpu/part?id=${encodeURIComponent(state.id)}&uploadId=${encodeURIComponent(state.uploadId)}&part=${n}`,
      { method: 'PUT', body: chunk, signal },
    );
    state.parts.push({ partNumber: part.partNumber, etag: part.etag });
    save('ui.bgUpload', state); // survives a reload mid-upload
  }

  panel.set(100, 'Finishing…');
  const done = await mpuFetch('/api/media/bg/mpu/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: state.id, uploadId: state.uploadId, parts: state.parts, name: label }),
    signal,
  });
  save('ui.bgUpload', null);
  return done;
}

/* ---------- the background gallery ----------
   An upload used to overwrite the one before it. Each is now kept, and the
   list — plus which one is showing — lives in R2 rather than in any one
   browser, so it is the same library on the phone and on the desk. */

let gallery = { selected: null, items: [] };

async function refreshGallery() {
  try {
    const res = await fetch('/api/media/bg');
    if (!res.ok) return gallery;
    const body = await res.json();
    gallery = { selected: body.selected ?? null, items: Array.isArray(body.items) ? body.items : [] };
  } catch {
    // offline: keep whatever the last load found rather than emptying the shelf
  }
  return gallery;
}

// Point the player at whichever background is selected. A cache-buster is
// needed because the URL does not change when the selection does.
function playSelectedBg(explicit = false) {
  if (!gallery.selected) { videoOk = false; if (explicit) applyBg('storm', true); return; }
  videoOk = false;
  bgVideo.src = `/media/bg/${gallery.selected}?v=${Date.now()}`;
  bgVideo.load();
  bgVideo.addEventListener('canplay', () => applyBg('video', true), { once: true });
}

/* ---------- per-theme backgrounds ----------
   Each console theme can own a background. The map lives in 'ui.bgByTheme'
   ({ themeName: bgId }) which the sync engine carries across devices like any
   other saved key, so mapping Mass Effect → a clip on the desk shows the same
   clip on the phone. Switching to a mapped theme points the player at that clip
   WITHOUT touching the global selection, so people who never mapped a theme keep
   the background they picked. */

// Point the player at one specific background id. Reuses applyBg's own
// reduced-motion gate: a device that prefers reduced motion and has never
// chosen a background stays calm even on a mapped theme.
function playThemeBg(id) {
  videoOk = false;
  // /media/bg/<id> is already unique per background, so no cache-buster is
  // needed — dropping the ?v=Date.now() lets switching back to a theme reuse
  // the cached clip instead of re-downloading it every time.
  bgVideo.src = `/media/bg/${id}`;
  bgVideo.load();
  bgVideo.addEventListener('canplay', () => applyBg('video'), { once: true });
}

function applyThemeBg(theme) {
  // a module fully covers the background layers; don't churn them underneath it
  if (typeof appview !== 'undefined' && appview && !appview.hidden) return;
  const map = load('ui.bgByTheme', {});
  const id = map[theme];
  if (!id) return;                    // unmapped theme: leave the current background untouched
  if (!gallery.items.length) return;  // gallery not loaded yet — the boot pass retries this
  if (!gallery.items.some(it => it.id === id)) {
    // the mapped object was deleted on some device: forget the dangling mapping
    // and fall back to whatever the global selection / storm already is
    delete map[theme];
    save('ui.bgByTheme', map);
    return;
  }
  playThemeBg(id);
}

// Bind the currently active theme to a background id and show it now.
function useForTheme(id) {
  const theme = document.documentElement.dataset.theme;
  const map = load('ui.bgByTheme', {});
  map[theme] = id;
  save('ui.bgByTheme', map);
  showToast(`${THEME_NAMES[theme] || 'This theme'} → this background`);
  applyThemeBg(theme);
  buildGallery();
}

async function selectBg(id) {
  const res = await fetch('/api/media/bg/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) { showToast('Could not switch background'); return; }
  gallery = await res.json();
  playSelectedBg(true);
  buildGallery();
}

async function deleteBg(id, name) {
  if (!confirm(`Delete "${name}"? This removes it from every device.`)) return;
  const res = await fetch(`/api/media/bg/${id}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Could not delete that background'); return; }
  const body = await res.json();
  gallery = body.index || await refreshGallery();
  showToast('Deleted');
  if (!gallery.selected) applyBg('storm', true); else playSelectedBg();
  buildGallery();
}

const galleryHost = () => document.getElementById('bg-gallery');

function buildGallery() {
  const host = galleryHost();
  if (!host) return;
  if (!gallery.items.length) {
    host.innerHTML = '<p class="muted" style="font-size:12.5px;margin:0">'
      + 'No backgrounds saved yet. Upload one and it stays here — the next upload adds to the shelf '
      + 'instead of replacing it.</p>';
    return;
  }
  const activeTheme = document.documentElement.dataset.theme;
  const themeMap = load('ui.bgByTheme', {});
  host.innerHTML = gallery.items.map(it => {
    const on = it.id === gallery.selected;
    const mappedHere = themeMap[activeTheme] === it.id;
    // a 30s trimmed clip can be under a megabyte; "0.0 MB" reads as broken
    const mb = it.bytes
      ? (it.bytes >= MB ? `${(it.bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(it.bytes / 1024))} KB`)
      : '';
    const themeLabel = THEME_NAMES[activeTheme] || 'this theme';
    return `<div class="bg-card${on ? ' on' : ''}">
      <button class="bg-pick" data-use="${esc(it.id)}" title="Show this background">
        <span class="bg-name">${esc(it.name || 'Background')}</span>
        <span class="muted bg-meta">${esc(mb)}${on ? ' · showing' : ''}${mappedHere ? ` · ${esc(themeLabel)}` : ''}</span>
      </button>
      <button class="btn small${mappedHere ? ' bg-theme-on' : ''}" data-theme-use="${esc(it.id)}"
        title="Use this background for the ${esc(themeLabel)} theme" aria-pressed="${mappedHere}">🎨</button>
      <button class="btn small danger" data-drop="${esc(it.id)}" title="Delete">✕</button>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-use]').forEach(b =>
    b.addEventListener('click', () => selectBg(b.dataset.use)));
  host.querySelectorAll('[data-theme-use]').forEach(b =>
    b.addEventListener('click', () => useForTheme(b.dataset.themeUse)));
  host.querySelectorAll('[data-drop]').forEach(b => {
    const it = gallery.items.find(i => i.id === b.dataset.drop);
    b.addEventListener('click', () => deleteBg(b.dataset.drop, it?.name || 'this background'));
  });
}

let uploading = false;

// mode 'clip' trims a 30s loop in the browser first (a few MB, one request);
// mode 'full' pushes the whole file through the multipart path.
function uploadBgVideo(mode = 'clip') {
  if (uploading) { showToast('An upload is already running'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/mp4,video/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 600 * MB) { showToast('Video is over the 600 MB cap'); return; }

    uploading = true;
    const ctrl = new AbortController();
    const panel = uploadPanel(() => ctrl.abort());
    panel.set(0, `Starting ${(file.size / MB).toFixed(0)} MB upload…`);
    try {
      let body = file;
      if (mode === 'clip' && clipSupported()) {
        panel.set(0, 'Trimming a 30s loop — keep this screen open…');
        body = await makeClip(file, {
          seconds: 30,
          onProgress: p => panel.set(p * 100, `Trimming 30s loop — ${Math.round(p * 30)}s of 30s`),
        });
        panel.set(0, `Uploading ${(body.size / MB).toFixed(1)} MB clip…`);
      } else if (mode === 'clip') {
        showToast('This browser cannot trim video — sending the full file');
      }

      const label = (file.name || 'Background').replace(/\.[a-z0-9]{2,5}$/i, '');
      if (body.size <= MPU_SINGLE_MAX) {
        await mpuFetch(`/api/media/bg?name=${encodeURIComponent(label)}`,
          { method: 'PUT', body, signal: ctrl.signal }, 2);
      } else {
        await uploadMultipart(body, panel, ctrl.signal, label);
      }
      panel.close();
      showToast('Background saved to the gallery 🎬');
      await refreshGallery();
      playSelectedBg();
    } catch (err) {
      panel.close();
      if (err.name === 'AbortError') {
        const st = load('ui.bgUpload', null);
        if (st) fetch('/api/media/bg/mpu/abort', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: st.id, uploadId: st.uploadId }),
        }).catch(() => { /* best effort */ });
        save('ui.bgUpload', null);
        showToast('Upload cancelled');
      } else {
        // parts already stored stay in ui.bgUpload — picking the same file resumes
        showToast(`Upload failed: ${err.message}`);
      }
    } finally {
      uploading = false;
    }
  };
  input.click();
}

/* ---------- import a background from a URL ----------
   The owner generates 8-second loops on Higgsfield; rather than downloading each
   one to the phone and pushing it back up, the Worker pulls the file straight
   from the (allowlisted) source into the same gallery. The two known clips get
   one-tap preset buttons that also map themselves to their theme. */
// One generated ambient loop per theme, matched to that theme's world. Setting
// them up imports each into R2 once and maps it to its theme, so switching to a
// theme becomes a full scene change on every device.
const HIGGS_CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_3IckDDDwJI3D408OKE8QdQYJgqc';
const HIGGS_PRESETS = {
  masseffect:  { name: 'Mass Effect',       url: `${HIGGS_CDN}/hf_20260830_135248_0fb7af14-8236-408a-9fe3-ba6a0ce515f8.mp4` },
  assassins:   { name: "Assassin's Creed",  url: `${HIGGS_CDN}/hf_20260830_135236_9dab5934-3f29-4d8c-8d19-e58c38f5650e.mp4` },
  cyberpunk:   { name: 'Cyberpunk',         url: `${HIGGS_CDN}/hf_20260830_142837_5c18fb80-f8c8-4088-9b11-72e42ffd39e2.mp4` },
  gtav:        { name: 'GTA V',             url: `${HIGGS_CDN}/hf_20260830_143039_d428c73d-5761-47cc-97c2-92112bac5adb.mp4` },
  minecraft:   { name: 'Minecraft',         url: `${HIGGS_CDN}/hf_20260830_142837_3d683410-8ac8-4bcb-8ad0-b60feb86d992.mp4` },
  playstation: { name: 'PlayStation',       url: `${HIGGS_CDN}/hf_20260830_143039_cd1eb944-2c48-4276-a380-17c22ba0aaeb.mp4` },
  xboxone:     { name: 'Xbox One',          url: `${HIGGS_CDN}/hf_20260830_142837_582421f5-f08b-417c-80e8-1b674a0e2596.mp4` },
};

async function importBg(url, name) {
  const res = await fetch('/api/media/bg/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(name ? { url, name } : { url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body; // { id, index }
}

function importBgFromUrl() {
  const url = prompt('Paste a Higgsfield video URL to add to the gallery:');
  if (!url || !url.trim()) return;
  showToast('Importing…');
  importBg(url.trim())
    .then(async body => {
      gallery = body.index || await refreshGallery();
      showToast('Background imported 🎬');
      playSelectedBg(); // the import selects itself server-side; show it
      buildGallery();
      buildCC();
    })
    .catch(err => showToast(`Import failed: ${err.message}`));
}

async function addPresetBg(theme) {
  const preset = HIGGS_PRESETS[theme];
  if (!preset) return;
  showToast(`Adding ${preset.name} background…`);
  try {
    const body = await importBg(preset.url, `${preset.name} (Higgsfield)`);
    gallery = body.index || await refreshGallery();
    // map the clip to its theme so switching to that theme shows it everywhere
    const map = load('ui.bgByTheme', {});
    map[theme] = body.id;
    save('ui.bgByTheme', map);
    showToast(`${preset.name} background added 🎬`);
    // if the owner is standing on that theme, show it right away; otherwise it
    // waits quietly until they switch to it (no jarring background swap)
    if (document.documentElement.dataset.theme === theme) applyThemeBg(theme);
    buildGallery();
    buildCC();
  } catch (err) {
    showToast(`Import failed: ${err.message}`);
  }
}

// Import every theme's clip once and map it to its theme. Sequential on purpose:
// the R2 index is written compare-and-set, so parallel imports would fight over
// it, and the source is rate-limited. Idempotent — a theme already mapped to a
// background that still exists is skipped, so re-tapping only fills the gaps.
async function setupAllThemeBgs() {
  const entries = Object.entries(HIGGS_PRESETS);
  let added = 0, skipped = 0, failed = 0;
  for (const [theme, preset] of entries) {
    const map = load('ui.bgByTheme', {});
    if (map[theme] && gallery.items.some(it => it.id === map[theme])) { skipped += 1; continue; }
    showToast(`Setting up ${preset.name}… (${added + skipped + failed + 1}/${entries.length})`);
    try {
      const body = await importBg(preset.url, `${preset.name} (Higgsfield)`);
      gallery = body.index || await refreshGallery();
      const m = load('ui.bgByTheme', {});   // re-read: each import may have refreshed state
      m[theme] = body.id;
      save('ui.bgByTheme', m);
      added += 1;
    } catch (err) {
      failed += 1;
      showToast(`${preset.name} failed: ${err.message}`);
    }
  }
  buildGallery();
  buildCC();
  applyThemeBg(document.documentElement.dataset.theme); // show the current theme's, if it got one
  showToast(`Theme backgrounds ready — ${added} added${skipped ? `, ${skipped} already set` : ''}${failed ? `, ${failed} failed` : ''} 🎬`);
}

function syncAction() {
  if (!sync.enabled()) {
    const pass = prompt('Set (or enter) your sync passphrase — the same one on every device:');
    if (!pass) return;
    sync.setup(pass.trim())
      .then(() => buildCC())
      .catch(err => showToast(`Sync setup failed: ${err.message}`));
  } else if (confirm('Turn sync off on this device? (Data stays local.)')) {
    sync.disable();
    buildCC();
  }
}

// Whole-account backup, independent of sync: dump every stored 'pd.*' key to a
// JSON file the browser downloads. This is the escape hatch when sync is off or
// broken and the only copy of the data lives in one browser's localStorage.
function backupData() {
  try {
    const dump = {};
    for (const k of storeKeys()) dump[k] = load(k, null);
    const payload = { app: 'dyer-hq', version: 1, exported: new Date().toISOString(), data: dump };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dyer-hq-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    // revoke on a tick so the download has committed to the URL first
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast(`Backed up ${Object.keys(dump).length} keys`);
  } catch (err) {
    showToast(`Backup failed: ${err.message}`);
  }
}

// Restore reads a picked backup file and writes its keys back through save() —
// so the sync engine's onSave hook picks each one up — then reloads to rebuild
// the UI from fresh state. Guarded hard against a file that is not one of ours,
// since a bad restore would silently overwrite good data.
function restoreData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        showToast('Restore failed: not a valid JSON file');
        return;
      }
      // accept either our wrapped {data:{…}} shape or a bare key→value map
      const data = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object'
        ? parsed.data : parsed;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        showToast('Restore failed: unrecognized backup file');
        return;
      }
      const names = Object.keys(data);
      if (!names.length) { showToast('Restore failed: no keys in file'); return; }
      if (!confirm(`Restore ${names.length} keys? This overwrites data on this device.`)) return;
      let ok = 0;
      for (const k of names) { if (save(k, data[k])) ok += 1; }
      showToast(`Restored ${ok} keys — reloading…`);
      setTimeout(() => location.reload(), 800);
    };
    reader.onerror = () => showToast('Restore failed: could not read the file');
    reader.readAsText(file);
  });
  input.click();
}

const GALLERY_CSS = `
  #bg-gallery .bg-card { display: flex; gap: 8px; align-items: center; }
  #bg-gallery .bg-pick { flex: 1; min-width: 0; text-align: left; padding: 8px 10px; border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--ink-3) 32%, transparent);
    background: color-mix(in oklab, var(--surface-2) 70%, transparent); color: var(--ink); cursor: pointer; }
  #bg-gallery .bg-card.on .bg-pick { border-color: var(--accent); }
  #bg-gallery .bg-name { display: block; font-size: 13px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  #bg-gallery .bg-meta { display: block; font-size: 11px; margin-top: 1px; }
  #bg-gallery .bg-theme-on { border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 20%, transparent); }`;

function buildCC() {
  if (!document.getElementById('bg-gallery-css')) {
    const style = document.createElement('style');
    style.id = 'bg-gallery-css';
    style.textContent = GALLERY_CSS;
    document.head.append(style);
  }
  const other = consoleMode === 'ps' ? 'xbox' : 'ps';
  // The strip outgrew a single row — sixteen buttons wrapped into an unreadable
  // pile that overflowed the sheet on phones. Grouped by what you're doing, so
  // the eye finds the row it needs, and the sheet itself scrolls when short.
  const groups = [
    { title: 'Quick', items: [
      { ico: 'home', label: 'Home', fn: () => { closeModule(); hideCC(); } },
      { ico: other, label: other === 'xbox' ? 'Xbox view' : 'PS view', fn: () => { applyConsole(other, { announce: true }); buildCC(); } },
      { ico: sfx.isMuted() ? 'soundOff' : 'sound', label: sfx.isMuted() ? 'Sound off' : 'Sound on', fn: () => { sfx.setMuted(!sfx.isMuted()); if (!sfx.isMuted()) sfx.play('select'); buildCC(); } },
      { ico: 'trophy', label: 'Trophies', fn: toggleTrophies },
      { ico: 'soundOff', label: 'Lock', fn: lockApp },
    ] },
    { title: 'Background', items: [
      { ico: 'sparkle', label: BG_LABEL[bgMode] || 'Bg', fn: () => { cycleBg(); sfx.play('select'); buildCC(); } },
      { ico: 'sparkle', label: 'Theme bgs', title: 'Import all seven generated theme backgrounds', fn: setupAllThemeBgs },
      { ico: 'sparkle', label: `Gallery (${gallery.items.length})`, fn: () => { const h = galleryHost(); if (h) { h.hidden = !h.hidden; if (!h.hidden) h.scrollIntoView({ block: 'nearest' }); } } },
      { ico: 'controller', label: 'Clip 30s ⬆', fn: () => uploadBgVideo('clip') },
      { ico: 'controller', label: 'Full video ⬆', fn: () => uploadBgVideo('full') },
      { ico: 'sparkle', label: 'From URL', fn: importBgFromUrl },
    ] },
    { title: 'Account', items: [
      // surface the underlying error as a hover/long-press title so a stuck sync
      // is legible, not just the generic "Sync error" label
      { ico: 'home', label: sync.status(), title: sync.lastError() || undefined, fn: syncAction },
      { ico: 'sparkle', label: 'Backup', fn: backupData },
      { ico: 'sparkle', label: 'Restore', fn: restoreData },
      { ico: 'controller', label: 'Cloudflare', href: 'https://dash.cloudflare.com' },
    ] },
  ];
  // only offer Install when the browser has actually handed us a prompt to fire
  if (deferredInstallPrompt) {
    groups[2].items.push({ ico: 'sparkle', label: 'Install app', fn: async () => {
      const e = deferredInstallPrompt;
      deferredInstallPrompt = null; // a prompt event can only be used once
      try { e.prompt(); await e.userChoice; } catch { /* dismissed */ }
      buildCC(); // the item drops off now that the prompt is spent
    } });
  }
  ccActions.innerHTML = '';
  groups.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'cc-group';
    const title = document.createElement('div');
    title.className = 'cc-group-title';
    title.textContent = group.title;
    const row = document.createElement('div');
    row.className = 'cc-group-row';
    group.items.forEach(it => {
      const node = document.createElement(it.href ? 'a' : 'button');
      node.className = 'cc-btn';
      if (it.href) { node.href = it.href; node.target = '_blank'; node.rel = 'noopener'; node.style.textDecoration = 'none'; }
      if (it.title) node.title = it.title; // e.g. the full sync error behind a "Sync error" label
      node.innerHTML = `<span class="cc-ico">${ICONS[it.ico] || ''}</span><span class="cc-label">${esc(it.label)}</span>`;
      if (it.fn) node.addEventListener('click', it.fn);
      row.append(node);
    });
    wrap.append(title, row);
    ccActions.append(wrap);
  });

  // named theme row — the game skins, spelled out
  const themeRow = document.createElement('div');
  themeRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:16px;border-top:1px solid color-mix(in oklab, var(--ink-3) 25%, transparent);padding-top:14px';
  const current = document.documentElement.dataset.theme;
  THEMES.forEach(name => {
    const b = document.createElement('button');
    b.className = 'btn small';
    if (name === current) b.style.borderColor = 'var(--accent)';
    b.innerHTML = `${ICONS[name] || ''} ${esc(THEME_NAMES[name])}`;
    b.querySelector('svg')?.style.setProperty('vertical-align', '-2px');
    b.addEventListener('click', () => { applyTheme(name, { announce: true, fx: true }); buildCC(); });
    themeRow.append(b);
  });
  // the saved backgrounds, folded away until asked for — the control centre is
  // a quick strip of actions, not a file browser
  const shelf = document.createElement('div');
  shelf.id = 'bg-gallery';
  shelf.hidden = true;
  // the control centre lays its actions out in a grid, so the shelf has to be
  // told to span it or it lands in one narrow cell
  shelf.style.cssText = 'grid-column:1/-1;width:100%;margin-top:14px;'
    + 'border-top:1px solid color-mix(in oklab, var(--ink-3) 25%, transparent);'
    + 'padding-top:14px;display:grid;gap:8px;text-align:left';
  ccActions.append(shelf);
  buildGallery();

  ccActions.append(themeRow);
}

function toggleTrophies() {
  ccExtra.hidden = !ccExtra.hidden;
  if (!ccExtra.hidden) ccExtra.innerHTML = `<div class="trophy-case">${trophyCaseHTML()}</div>`;
}

function showCC() {
  // remember who opened it so focus can return there on close
  ccInvoker = (document.activeElement && document.activeElement !== document.body)
    ? document.activeElement : $('#cc-btn');
  buildCC();
  ccExtra.hidden = true;
  ccenter.hidden = false;
  const sheet = $('#cc-sheet');
  if (sheet) sheet.setAttribute('aria-modal', 'true');
  setBgInert(true);
  pushOverlayState();
  // pull focus into the sheet so keyboard users land on its first control
  const first = ccActions.querySelector('.cc-btn');
  if (first) first.focus();
  sfx.play('open');
}

function hideCC() {
  if (ccenter.hidden) return;
  ccenter.hidden = true;
  const sheet = $('#cc-sheet');
  if (sheet) sheet.removeAttribute('aria-modal');
  // release the background unless a module is still open beneath the sheet
  if (appview.hidden) setBgInert(false);
  consumeOverlayState();
  // return focus to whatever opened the control center
  if (ccInvoker && typeof ccInvoker.focus === 'function') {
    try { ccInvoker.focus(); } catch { /* node may be gone */ }
  }
  ccInvoker = null;
  sfx.play('back');
}

$('#cc-btn').innerHTML = ICONS.controller;
$('#cc-btn').addEventListener('click', () => (ccenter.hidden ? showCC() : hideCC()));
ccenter.addEventListener('click', e => { if (e.target === ccenter) hideCC(); });
$('#profile-chip').addEventListener('click', () => (ccenter.hidden ? showCC() : hideCC()));

// The profile chip carries the dashboard's own trophy points (500 each), and —
// once the Gaming module has connected a console — the real gamerscore and
// trophy level pulled from Xbox/PSN alongside them.
function updateScore() {
  const n = Object.keys(load('trophies', {})).length;
  const mine = n ? `G ${(n * 500).toLocaleString()}` : '';
  const real = gaming.chipSummary();
  $('#profile-score').textContent = [mine, real].filter(Boolean).join('  ·  ');
}
updateScore();
window.addEventListener('pd:data-changed', updateScore);

/* ---------- pill nav (Xbox mode) ---------- */
document.querySelectorAll('#pill-nav .pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('#pill-nav .pill').forEach(p =>
      p.classList.toggle('active', p === pill));
    sfx.play('select');
    switch (pill.dataset.pill) {
      case 'home': closeModule(); setFocus(0); break;
      case 'apps': closeModule(); setFocus(TILES.findIndex(t => t.kind === 'link')); break;
      case 'trophies': showCC(); toggleTrophies(); break;
      case 'sync': showCC(); break;
    }
  });
});

/* ---------- keyboard (console feel) ---------- */
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (e.key === 'Escape') {
    if (e.isComposing) return; // don't cancel IME composition into a close
    if (!ccenter.hidden) { hideCC(); return; }
    // First Escape in a module form field just leaves the field.
    if (!appview.hidden && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      document.activeElement.blur();
      return;
    }
    closeModule();
    return;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'c' && appview.hidden) { ccenter.hidden ? showCC() : hideCC(); return; }
  if (!appview.hidden || !ccenter.hidden) return;
  // A Tab-focused link/button (hero actions, theme dots, tiles — tiles are
  // buttons) must keep its native Enter/Space activation; the rail shortcuts
  // below are for when focus is on the rail/body, not an interactive element.
  const onInteractive = tag === 'A' || tag === 'BUTTON';
  // Arrow keys move the rail selection; if DOM focus sits on a tile from an
  // earlier click, follow it — otherwise Enter would fire the stale tile.
  const chaseFocus = () => {
    if (tileEls.includes(document.activeElement)) tileEls[focusIndex].focus({ preventScroll: true });
  };
  switch (e.key) {
    case 'ArrowRight': setFocus(focusIndex + 1); chaseFocus(); e.preventDefault(); break;
    case 'ArrowLeft': setFocus(focusIndex - 1); chaseFocus(); e.preventDefault(); break;
    case 'Home': setFocus(0); chaseFocus(); e.preventDefault(); break;
    case 'End': setFocus(TILES.length - 1); chaseFocus(); e.preventDefault(); break;
    case 'Enter':
    case ' ':
      if (onInteractive) return;
      activate(TILES[focusIndex]);
      e.preventDefault();
      break;
    case 't': {
      const list = THEMES;
      const next = list[(list.indexOf(document.documentElement.dataset.theme) + 1) % list.length];
      applyTheme(next, { announce: true, fx: true });
      break;
    }
  }
});

rail.addEventListener('wheel', e => {
  // vertical wheel scrolls the rail horizontally, console-style
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    rail.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

/* ---------- boot splash ---------- */
function boot() {
  const el = $('#boot');
  let seen = false;
  try { seen = sessionStorage.getItem('pd.booted') === '1'; } catch { /* private mode */ }
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.hidden = true;
    return;
  }
  $('#boot-icon').innerHTML = ICONS[consoleMode === 'xbox' ? 'xbox' : 'ps'];
  // 700ms hold (was 1400) — still long enough to read as an intentional
  // splash, half the fixed cost on first launch. Once-per-session via the
  // 'pd.booted' flag set below, so it's a one-time tax, not every navigation.
  setTimeout(() => {
    el.classList.add('done');
    try { sessionStorage.setItem('pd.booted', '1'); } catch { /* noop */ }
    setTimeout(() => { el.hidden = true; }, 550);
  }, 700);
}

/* ---------- Mission Control live badge ----------
   The ops tile wears the count of things wanting attention (open shop tickets +
   waiting leads + open IT tickets). Read from biz.js's cache first so it paints
   instantly, then refreshed once from the bridges in the background. */
function opsAttentionCount() {
  const shop = load('biz.shop', null)?.data;
  const it = load('biz.ariseit', null)?.data;
  let n = 0;
  if (shop && shop.configured !== false) n += (shop.tickets?.length || 0) + (shop.leads?.count || 0);
  if (it && it.configured !== false) n += (it.open?.length || 0);
  return n;
}

function refreshOpsBadge() {
  const i = TILES.findIndex(t => t.id === 'ops');
  if (i < 0 || !tileEls[i]) return;
  const badge = tileEls[i].querySelector('.badge');
  if (!badge) return;
  const n = opsAttentionCount();
  badge.textContent = n > 0 ? String(n) : 'LIVE';
  badge.classList.toggle('badge-alert', n > 0);
}

async function pollOps() {
  try {
    for (const [path, key] of [['/api/biz/shop', 'biz.shop'], ['/api/biz/ariseit', 'biz.ariseit']]) {
      const res = await fetch(path, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (data && !data._error) save(key, { at: Date.now(), data });
      }
    }
  } catch { /* offline — the cached badge stands */ }
  refreshOpsBadge();
}

// A module (e.g. the Today briefing) can ask to jump to another module.
window.addEventListener('pd:open', e => {
  const id = e.detail;
  const idx = TILES.findIndex(t => t.id === id);
  if (idx < 0 || TILES[idx].kind !== 'module') return;
  if (!appview.hidden) closeModule();
  setFocus(idx, false);
  openModule(id);
});

/* ---------- init ---------- */
sfx.init();
applyConsole(consoleMode);
renderRail();
refreshOpsBadge();
pollOps();
boot();
initAchievements(() => consoleMode);
sync.init();
applyBg(bgMode);
// applyBg only points the (src-less) element at /media/bg.mp4 when the saved
// background is 'video', so Storm/Off visits never fetch it. When it IS video,
// that load fires canplay here and we flip the picture up — before the gallery
// listing comes back — without a network hit for anyone else.
bgVideo.addEventListener('canplay', () => { if (load('ui.bg', 'storm') === 'video') applyBg('video', true); }, { once: true });
refreshGallery().then(() => {
  if (!gallery.items.length) videoOk = false;
  // the gallery is loaded now, so a theme that owns a background can finally
  // resolve its mapping (the applyTheme during boot ran before this landed)
  applyThemeBg(document.documentElement.dataset.theme);
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is best-effort */ });
}
uiReady = true;
