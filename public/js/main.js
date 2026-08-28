// Dashboard shell — PS5-style tile rail, hero panel, theming, module host.

import { TILES } from './data.js';
import { load, save, esc, showToast } from './store.js';
import * as github from './github.js';
import * as fitness from './fitness.js';
import * as writing from './writing.js';
import * as notebook from './notebook.js';
import * as cloudflare from './cloudflare.js';

const MODULES = {
  projects: { title: 'GitHub Projects', mount: github.mount },
  fitness: { title: 'Fitness', mount: fitness.mount },
  writing: { title: 'Book Writing', mount: writing.mount },
  notebook: { title: 'Notebook', mount: notebook.mount },
  cloudflare: { title: 'Cloudflare Fleet', mount: cloudflare.mount },
};

const $ = sel => document.querySelector(sel);

/* ---------- theme ---------- */
const THEMES = ['assassins', 'cyberpunk', 'gtav', 'minecraft', 'masseffect'];
const THEME_NAMES = {
  assassins: "Assassin's Creed",
  cyberpunk: 'Cyberpunk',
  gtav: 'GTA V',
  minecraft: 'Minecraft',
  masseffect: 'Mass Effect',
};

function applyTheme(name, announce = false) {
  if (!THEMES.includes(name)) name = 'masseffect';
  document.documentElement.dataset.theme = name;
  save('theme', name);
  document.querySelectorAll('.theme-dot').forEach(b => {
    const active = b.dataset.setTheme === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  });
  if (announce) showToast(`${THEME_NAMES[name]} theme`);
}

document.querySelectorAll('.theme-dot').forEach(btn =>
  btn.addEventListener('click', () => applyTheme(btn.dataset.setTheme, true)));

applyTheme(load('theme', 'masseffect'));

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
  focusIndex = Math.max(0, Math.min(TILES.length - 1, i));
  save('ui.tile', focusIndex);
  tileEls.forEach((el, j) => {
    el.classList.toggle('focused', j === focusIndex);
    el.setAttribute('aria-selected', String(j === focusIndex));
  });
  const t = TILES[focusIndex];
  if (scroll) tileEls[focusIndex].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

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
}

function activate(t) {
  if (t.kind === 'module') openModule(t.id);
  else if (t.url) window.open(t.url, '_blank', 'noopener');
}

renderRail();

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
  rail.focus({ preventScroll: true });
}

$('#appview-back').addEventListener('click', closeModule);

/* ---------- keyboard (console feel) ---------- */
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (e.key === 'Escape') {
    if (e.isComposing) return; // don't cancel IME composition into a close
    // First Escape in a module form field just leaves the field.
    if (!appview.hidden && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      document.activeElement.blur();
      return;
    }
    closeModule();
    return;
  }
  if (!appview.hidden) return; // typing inside a module
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // A Tab-focused link/button (hero actions, theme dots, tiles — tiles are
  // buttons) must keep its native Enter/Space activation; the rail shortcuts
  // below are for when focus is on the rail/body, not an interactive element.
  const onInteractive = tag === 'A' || tag === 'BUTTON';
  switch (e.key) {
    case 'ArrowRight': setFocus(focusIndex + 1); e.preventDefault(); break;
    case 'ArrowLeft': setFocus(focusIndex - 1); e.preventDefault(); break;
    case 'Home': setFocus(0); e.preventDefault(); break;
    case 'End': setFocus(TILES.length - 1); e.preventDefault(); break;
    case 'Enter':
    case ' ':
      if (onInteractive) return;
      activate(TILES[focusIndex]);
      e.preventDefault();
      break;
    case 't': {
      const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % THEMES.length];
      applyTheme(next, true);
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
