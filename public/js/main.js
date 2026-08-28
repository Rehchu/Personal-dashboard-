// Dashboard shell — console-style tile rail, hero panel, theming, module host.
// Two console modes (PlayStation-style layout + Xbox-style layout), six themes,
// synthesized UI sounds, ambient particles, control center, trophies.

import { TILES } from './data.js';
import { load, save, esc, showToast } from './store.js';
import { sfx } from './sfx.js';
import { initAmbient } from './ambient.js';
import { ICONS } from './icons.js';
import { initAchievements, trophyCaseHTML } from './achievements.js';
import { activityCards } from './activity.js';
import { sync } from './sync.js';
import * as github from './github.js';
import * as fitness from './fitness.js';
import * as writing from './writing.js';
import * as notebook from './notebook.js';
import * as cloudflare from './cloudflare.js';
import * as today from './today.js';
import * as habits from './habits.js';
import * as dragons from './dragons.js';
import * as archive from './archive.js';

const MODULES = {
  today: { title: 'Today', mount: today.mount },
  projects: { title: 'GitHub Projects', mount: github.mount },
  fitness: { title: 'Fitness', mount: fitness.mount },
  writing: { title: 'Book Writing', mount: writing.mount },
  notebook: { title: 'Notebook', mount: notebook.mount },
  habits: { title: 'Habits', mount: habits.mount },
  dragons: { title: 'Dragon Vault', mount: dragons.mount },
  archive: { title: 'Claude Archive', mount: archive.mount },
  cloudflare: { title: 'Cloudflare Fleet', mount: cloudflare.mount },
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

function renderRail() {
  rail.innerHTML = '';
  tileEls = TILES.map((t, i) => {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-label', t.title);
    tile.style.setProperty('--tile-accent', t.accent);
    tile.innerHTML = `<span aria-hidden="true">${t.glyph}</span>
      ${t.badge ? `<span class="badge">${esc(t.badge)}</span>` : ''}
      <span class="tile-label">${esc(t.title)}</span>`;
    tile.addEventListener('click', () => {
      if (i === focusIndex) activate(t);
      else setFocus(i);
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
  ambient.pause(); // the module view fully covers the particle canvas
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
  sfx.play('back');
  setFocus(focusIndex, false); // refresh activity cards with any new data
  rail.focus({ preventScroll: true });
}

$('#appview-back').addEventListener('click', closeModule);

/* ---------- control center / guide ---------- */
const ccenter = $('#ccenter');
const ccActions = $('#cc-actions');
const ccExtra = $('#cc-extra');

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
    { ico: 'sparkle', label: sync.status(), fn: syncAction },
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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is best-effort */ });
}
uiReady = true;
