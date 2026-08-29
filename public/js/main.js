// Dashboard shell — console-style tile rail, hero panel, theming, module host.
// Two console modes (PlayStation-style layout + Xbox-style layout), six themes,
// synthesized UI sounds, ambient particles, control center, trophies.

import { TILES } from './data.js';
import { load, save, esc, showToast } from './store.js';
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

const MODULES = {
  today: { title: 'Today', mount: today.mount },
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
};

const $ = sel => document.querySelector(sel);

/* ---------- themes & consoles ---------- */
const GAME_THEMES = ['assassins', 'cyberpunk', 'gtav', 'minecraft', 'masseffect'];
const THEMES = [...GAME_THEMES, 'xboxgreen'];
const THEME_NAMES = {
  assassins: "Assassin's Creed",
  cyberpunk: 'Cyberpunk',
  gtav: 'GTA V',
  minecraft: 'Minecraft',
  masseffect: 'Mass Effect',
  xboxgreen: 'Xbox',
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
  if (mode === 'video' && !videoOk) mode = 'storm';
  bgMode = mode;
  document.documentElement.dataset.bg = mode;
  bgVideo.hidden = mode !== 'video';
  if (mode === 'video') bgVideo.play().catch(() => { applyBg('storm', explicit); });
  else bgVideo.pause();
  if (mode === 'storm') storm.start(bgChosen); else storm.stop();
}

function cycleBg() {
  const order = videoOk ? ['storm', 'video', 'off'] : ['storm', 'off'];
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
  const tools = $('#appview-tools');
  const body = $('#appview-body');
  tools.innerHTML = '';
  body.innerHTML = '';
  appview.hidden = false;
  ambient.pause(); // the module view fully covers the background layers
  storm.stop();
  if (!bgVideo.hidden) bgVideo.pause();
  try {
    unmount = mod.mount(body, tools) || null;
  } catch (err) {
    body.innerHTML = `<p class="muted">This module hit an error: ${esc(err.message)}</p>`;
  }
}

function closeModule() {
  if (appview.hidden) return;
  if (typeof unmount === 'function') { try { unmount(); } catch { /* noop */ } }
  unmount = null;
  appview.hidden = true;
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

async function uploadMultipart(file, panel, signal) {
  const name = file.name || 'clip'; // a trimmed clip is a Blob, with no name
  let state = loadResume(file, name);
  if (state) {
    showToast(`Resuming at part ${state.parts.length + 1}`);
  } else {
    const { uploadId } = await mpuFetch('/api/media/bg/mpu/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: file.type || 'video/mp4' }),
      signal,
    });
    state = { uploadId, name, size: file.size, partSize: MPU_PART, parts: [] };
    save('ui.bgUpload', state);
  }

  const total = Math.ceil(file.size / MPU_PART);
  for (let n = state.parts.length + 1; n <= total; n++) {
    const chunk = file.slice((n - 1) * MPU_PART, Math.min(n * MPU_PART, file.size));
    const done = (n - 1) * MPU_PART;
    panel.set((done / file.size) * 100,
      `Uploading part ${n} of ${total} — ${(done / MB).toFixed(0)}/${(file.size / MB).toFixed(0)} MB`);
    const part = await mpuFetch(
      `/api/media/bg/mpu/part?uploadId=${encodeURIComponent(state.uploadId)}&part=${n}`,
      { method: 'PUT', body: chunk, signal },
    );
    state.parts.push({ partNumber: part.partNumber, etag: part.etag });
    save('ui.bgUpload', state); // survives a reload mid-upload
  }

  panel.set(100, 'Finishing…');
  await mpuFetch('/api/media/bg/mpu/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: state.uploadId, parts: state.parts }),
    signal,
  });
  save('ui.bgUpload', null);
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

      if (body.size <= MPU_SINGLE_MAX) {
        await mpuFetch('/api/media/bg', { method: 'PUT', body, signal: ctrl.signal }, 2);
      } else {
        await uploadMultipart(body, panel, ctrl.signal);
      }
      panel.close();
      showToast('Background video saved 🎬');
      videoOk = false;
      bgVideo.src = `/media/bg.mp4?v=${Date.now()}`;
      bgVideo.load();
      bgVideo.addEventListener('canplay', () => applyBg('video', true), { once: true });
    } catch (err) {
      panel.close();
      if (err.name === 'AbortError') {
        const st = load('ui.bgUpload', null);
        if (st) fetch('/api/media/bg/mpu/abort', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId: st.uploadId }),
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

function buildCC() {
  const other = consoleMode === 'ps' ? 'xbox' : 'ps';
  const items = [
    { ico: 'home', label: 'Home', fn: () => { closeModule(); hideCC(); } },
    { ico: other, label: other === 'xbox' ? 'Xbox view' : 'PS view', fn: () => { applyConsole(other, { announce: true }); buildCC(); } },
    { ico: sfx.isMuted() ? 'soundOff' : 'sound', label: sfx.isMuted() ? 'Sound off' : 'Sound on', fn: () => { sfx.setMuted(!sfx.isMuted()); if (!sfx.isMuted()) sfx.play('select'); buildCC(); } },
    { ico: 'trophy', label: 'Trophies', fn: toggleTrophies },
    { ico: 'sparkle', label: BG_LABEL[bgMode] || 'Bg', fn: () => { cycleBg(); sfx.play('select'); buildCC(); } },
    { ico: 'controller', label: 'Bg clip 30s ⬆', fn: () => uploadBgVideo('clip') },
    { ico: 'controller', label: 'Bg full video ⬆', fn: () => uploadBgVideo('full') },
    { ico: 'home', label: sync.status(), fn: syncAction },
    { ico: 'soundOff', label: 'Lock', fn: lockApp },
    { ico: 'controller', label: 'Cloudflare', href: 'https://dash.cloudflare.com' },
  ];
  ccActions.innerHTML = '';
  items.forEach(it => {
    const node = document.createElement(it.href ? 'a' : 'button');
    node.className = 'cc-btn';
    if (it.href) { node.href = it.href; node.target = '_blank'; node.rel = 'noopener'; node.style.textDecoration = 'none'; }
    node.innerHTML = `<span class="cc-ico">${ICONS[it.ico] || ''}</span><span class="cc-label">${esc(it.label)}</span>`;
    if (it.fn) node.addEventListener('click', it.fn);
    ccActions.append(node);
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
  ccActions.append(themeRow);
}

function toggleTrophies() {
  ccExtra.hidden = !ccExtra.hidden;
  if (!ccExtra.hidden) ccExtra.innerHTML = `<div class="trophy-case">${trophyCaseHTML()}</div>`;
}

function showCC() {
  buildCC();
  ccExtra.hidden = true;
  ccenter.hidden = false;
  sfx.play('open');
}

function hideCC() {
  if (ccenter.hidden) return;
  ccenter.hidden = true;
  sfx.play('back');
}

$('#cc-btn').innerHTML = ICONS.controller;
$('#cc-btn').addEventListener('click', () => (ccenter.hidden ? showCC() : hideCC()));
ccenter.addEventListener('click', e => { if (e.target === ccenter) hideCC(); });
$('#profile-chip').addEventListener('click', () => (ccenter.hidden ? showCC() : hideCC()));

// gamerscore-style points: 500 per trophy, shown on the profile chip
function updateScore() {
  const n = Object.keys(load('trophies', {})).length;
  $('#profile-score').textContent = n ? `G ${(n * 500).toLocaleString()}` : '';
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
  setTimeout(() => {
    el.classList.add('done');
    try { sessionStorage.setItem('pd.booted', '1'); } catch { /* noop */ }
    setTimeout(() => { el.hidden = true; }, 550);
  }, 1400);
}

/* ---------- init ---------- */
sfx.init();
applyConsole(consoleMode);
renderRail();
boot();
initAchievements(() => consoleMode);
sync.init();
applyBg(bgMode);
// if the video file exists it becomes selectable a moment after load
bgVideo.addEventListener('canplay', () => { if (load('ui.bg', 'storm') === 'video') applyBg('video', true); }, { once: true });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is best-effort */ });
}
uiReady = true;
