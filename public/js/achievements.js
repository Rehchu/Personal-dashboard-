// Trophy / achievement system. Conditions are evaluated from localStorage
// on init and on every 'pd:data-changed'; unlocks persist under 'trophies'
// as {id: timestampMs}. New unlocks play sfx and show a console-styled
// banner (PS: dark pill from the top · Xbox: green-circled pill from the
// bottom), queued one at a time.

import { load, save } from './store.js';
import { sfx } from './sfx.js';
import { ICONS } from './icons.js';

const GAME_THEMES = ['assassins', 'cyberpunk', 'gtav', 'minecraft', 'masseffect'];

const words = t => {
  const s = String(t ?? '').trim();
  return s ? s.split(/\s+/).length : 0;
};

// d = snapshot from gather(). All defs are static author strings — safe HTML.
// prog(d) -> [current, target] drives the progress bar on locked trophies, so a
// half-earned trophy shows how close it is instead of a flat "Locked".
const DEFS = [
  { id: 'first-rep', name: 'First Rep', desc: 'Log your first workout.', test: d => d.workouts.length >= 1, prog: d => [d.workouts.length, 1] },
  { id: 'reps-10', name: 'Putting In Reps', desc: 'Log 10 workouts.', test: d => d.workouts.length >= 10, prog: d => [d.workouts.length, 10] },
  { id: 'streak-3', name: 'On A Roll', desc: 'Work out on 3 different days.', test: d => new Set(d.workouts.map(w => w.date)).size >= 3, prog: d => [new Set(d.workouts.map(w => w.date)).size, 3] },
  { id: 'trend-5', name: 'Trend Watcher', desc: 'Record 5 weigh-ins.', test: d => d.weights.length >= 5, prog: d => [d.weights.length, 5] },
  { id: 'words-1k', name: 'Chapter One', desc: 'Write 1,000 words across your books.', test: d => d.words >= 1000, prog: d => [d.words, 1000] },
  { id: 'words-10k', name: 'Momentum', desc: 'Write 10,000 words across your books.', test: d => d.words >= 10000, prog: d => [d.words, 10000] },
  { id: 'words-50k', name: 'Half A Dragon', desc: 'Write 50,000 words across your books.', test: d => d.words >= 50000, prog: d => [d.words, 50000] },
  { id: 'chapters-5', name: 'The Plot Thickens', desc: 'Create 5 chapters in total.', test: d => d.chapters >= 5, prog: d => [d.chapters, 5] },
  { id: 'first-ink', name: 'First Stroke', desc: 'Draw anything in the notebook.', test: d => d.inked >= 1, prog: d => [d.inked, 1] },
  { id: 'pages-3', name: 'Sketchbook', desc: 'Put ink on 3 notebook pages.', test: d => d.inked >= 3, prog: d => [d.inked, 3] },
  { id: 'multiverse', name: 'Multiverse', desc: 'Try all five game themes.', test: d => GAME_THEMES.every(t => d.themes.includes(t)), prog: d => [GAME_THEMES.filter(t => d.themes.includes(t)).length, GAME_THEMES.length] },
  { id: 'crossplay', name: 'Crossplay', desc: 'Use both console views.', test: d => d.consoles.includes('ps') && d.consoles.includes('xbox'), prog: d => [['ps', 'xbox'].filter(c => d.consoles.includes(c)).length, 2] },
  { id: 'sprint-1', name: 'Sprinter', desc: 'Finish a writing sprint.', test: d => d.sprints >= 1, prog: d => [d.sprints, 1] },
  { id: 'capture-1', name: 'Lightning Rod', desc: 'Capture an idea in the inbox.', test: d => d.captured >= 1, prog: d => [d.captured, 1] },
  { id: 'habit-7', name: 'Habit Forming', desc: 'Hold a 7-day streak on any habit.', test: d => d.habitStreak >= 7, prog: d => [d.habitStreak, 7] },
];

function gather() {
  const books = load('books', []);
  return {
    workouts: load('fit.workouts', []),
    weights: load('fit.weights', []),
    words: books.reduce((s, b) => s + (b.chapters || []).reduce((n, c) => n + words(c.text), 0), 0),
    chapters: books.reduce((s, b) => s + (b.chapters || []).length, 0),
    inked: load('nb.pages', []).filter(p => (p.strokes || []).length).length,
    themes: load('ui.themesUsed', []),
    consoles: load('ui.consolesUsed', []),
    sprints: load('writing.sprints', []).length,
    captured: load('inbox', []).length,
    habitStreak: Math.max(0, ...load('habits', []).map(h => {
      const days = h.days || {};
      let n = 0;
      const d = new Date();
      const key = () => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!days[key()]) d.setDate(d.getDate() - 1); // streak may end yesterday
      while (days[key()]) { n++; d.setDate(d.getDate() - 1); }
      return n;
    })),
  };
}

/* ---------- unlock banner ---------- */
let getMode = () => 'ps';
const queue = [];
let showing = false;

function ensureStyle() {
  if (document.getElementById('trophy-style')) return;
  const style = document.createElement('style');
  style.id = 'trophy-style';
  style.textContent = `
    #trophy-banner {
      position: fixed; left: 50%; z-index: 400; pointer-events: none;
      display: flex; align-items: center; gap: 11px;
      font: 600 15px var(--font-body, system-ui);
      color: #fff; opacity: 0; transform: translateX(-50%);
    }
    #trophy-banner .trophy-ico { display: inline-flex; flex: none; }
    #trophy-banner.trophy-ps {
      top: 18px; padding: 10px 22px 10px 16px; border-radius: 999px;
      background: rgba(10, 12, 18, .93); border: 1px solid rgba(255, 255, 255, .14);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
      animation: trophy-drop .45s cubic-bezier(.2, .9, .3, 1.15) forwards;
    }
    #trophy-banner.trophy-ps .trophy-ico { color: #eac54f; font-size: 21px; }
    #trophy-banner.trophy-xbox {
      bottom: 26px; padding: 7px 22px 7px 7px; border-radius: 999px;
      background: rgba(14, 18, 14, .94); border: 1px solid rgba(255, 255, 255, .1);
      box-shadow: 0 12px 32px rgba(0, 0, 0, .45);
      animation: trophy-rise .45s cubic-bezier(.2, .9, .3, 1.15) forwards;
    }
    #trophy-banner.trophy-xbox .trophy-ico {
      width: 34px; height: 34px; border-radius: 50%; font-size: 18px;
      align-items: center; justify-content: center;
      background: #107c10; box-shadow: 0 0 0 2px rgba(255, 255, 255, .25) inset;
    }
    #trophy-banner.trophy-hide { animation: trophy-fade-out .35s ease forwards; }
    @keyframes trophy-drop { from { opacity: 0; transform: translate(-50%, -160%); } to { opacity: 1; transform: translate(-50%, 0); } }
    @keyframes trophy-rise { from { opacity: 0; transform: translate(-50%, 160%); } to { opacity: 1; transform: translate(-50%, 0); } }
    @keyframes trophy-fade { to { opacity: 1; } }
    @keyframes trophy-fade-out { to { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) {
      /* base.css kills ALL animations under reduced motion, so visibility can't
         come from an animation here — set the end states directly. */
      #trophy-banner.trophy-ps, #trophy-banner.trophy-xbox { animation: none; opacity: 1 !important; transform: none !important; }
      #trophy-banner.trophy-hide { animation: none; opacity: 0 !important; }
    }
    .trophy-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; margin-bottom: 8px;
      background: var(--surface-2); border-radius: 12px;
    }
    .trophy-row .trophy-ico { display: inline-flex; flex: none; font-size: 22px; color: #eac54f; }
    .trophy-row.trophy-locked { opacity: .55; }
    .trophy-row.trophy-locked .trophy-ico { color: var(--ink-3); }
    .trophy-name { font-weight: 700; color: var(--ink); }
    .trophy-desc { font-size: 13px; color: var(--ink-2); }
    .trophy-when { margin-left: auto; font-size: 12px; color: var(--ink-3); white-space: nowrap; }
    .trophy-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
    .trophy-tab { flex: 1; padding: 8px 6px; border-radius: 10px; cursor: pointer;
      border: 1px solid var(--line, rgba(255,255,255,.12)); background: var(--surface-2);
      color: var(--ink-2); font: 700 13px var(--font-display, system-ui); letter-spacing: .02em; }
    .trophy-tab.on { background: var(--accent); color: #fff; border-color: transparent; }
    .trophy-prog { height: 5px; border-radius: 3px; margin-top: 7px; overflow: hidden;
      background: var(--surface-3, rgba(255,255,255,.1)); }
    .trophy-prog i { display: block; height: 100%; background: var(--accent); }
    .trophy-progn { font-size: 11px; color: var(--ink-3); margin-top: 3px; }
    .trophy-empty { display: flex; align-items: center; gap: 12px; padding: 22px 16px;
      color: var(--ink-2); font-size: 13.5px; line-height: 1.5; }
    .trophy-empty-ico { font-size: 2rem; flex: none; }
  `;
  document.head.append(style);
}

function showNext() {
  const def = queue.shift();
  if (!def) { showing = false; return; }
  showing = true;
  ensureStyle();
  const xbox = getMode() === 'xbox';
  const el = document.createElement('div');
  el.id = 'trophy-banner';
  el.className = xbox ? 'trophy-xbox' : 'trophy-ps';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="trophy-ico">${ICONS.trophy}</span>` +
    `<span>${xbox ? 'Achievement unlocked — ' : 'Trophy unlocked · '}${def.name}</span>`;
  document.body.append(el);
  sfx.play('trophy');
  setTimeout(() => {
    el.classList.add('trophy-hide');
    setTimeout(() => { el.remove(); showNext(); }, 380);
  }, 3500);
}

/* ---------- evaluation ---------- */
function evaluate() {
  const unlocked = load('trophies', {});
  const d = gather();
  const fresh = DEFS.filter(t => !(t.id in unlocked) && t.test(d));
  if (!fresh.length) return;
  for (const t of fresh) unlocked[t.id] = Date.now();
  save('trophies', unlocked);
  queue.push(...fresh);
  if (!showing) showNext();
}

export function initAchievements(getConsole) {
  if (getConsole) getMode = getConsole;
  ensureStyle();
  evaluate();
  window.addEventListener('pd:data-changed', evaluate);
}

const escGame = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dyerHqPanel() {
  const unlocked = load('trophies', {});
  const d = gather();
  const rows = [...DEFS]
    .sort((a, b) => (a.id in unlocked ? 0 : 1) - (b.id in unlocked ? 0 : 1))
    .map(t => {
      const ts = unlocked[t.id];
      const when = ts
        ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : 'Locked';
      // locked trophies with a measurable condition show how close they are
      let bar = '';
      if (!ts && t.prog) {
        const [cur, target] = t.prog(d);
        const pct = Math.max(0, Math.min(100, Math.round((cur / target) * 100)));
        if (pct > 0 && pct < 100) {
          bar = `<div class="trophy-prog"><i style="width:${pct}%"></i></div>
            <div class="trophy-progn">${cur.toLocaleString()} / ${target.toLocaleString()}</div>`;
        }
      }
      return `
        <div class="trophy-row ${ts ? 'trophy-unlocked' : 'trophy-locked'}">
          <span class="trophy-ico">${ICONS.trophy}</span>
          <div style="min-width:0;flex:1">
            <div class="trophy-name">${t.name}</div>
            <div class="trophy-desc">${t.desc}</div>
            ${bar}
          </div>
          <span class="trophy-when">${when}</span>
        </div>`;
    });
  const n = Object.keys(unlocked).filter(id => DEFS.some(t => t.id === id)).length;
  return `<div class="trophy-desc" style="margin-bottom:10px">${n} / ${DEFS.length} unlocked</div>${rows.join('')}`;
}

// Xbox and PlayStation panels read the Gaming module's cached payloads (written
// by gaming.js). No fetch here — the case reflects the last sync; opening the
// Gaming tile refreshes it.
function consolePanel(kind) {
  const data = load(kind === 'xbox' ? 'gaming.xbox' : 'gaming.psn', null)?.data;
  const label = kind === 'xbox' ? 'Xbox' : 'PlayStation';
  if (!data || data.configured === false) {
    return `<div class="trophy-empty">
      <div class="trophy-empty-ico">${kind === 'xbox' ? '🟢' : '🔵'}</div>
      <div>Connect your ${label} account in the <b>Gaming</b> tile to see your real ${kind === 'xbox' ? 'achievements' : 'trophies'} here.</div>
    </div>`;
  }
  const recent = data.recent || [];
  if (!recent.length) return `<div class="trophy-empty"><div>No recent ${label} titles synced yet.</div></div>`;
  return recent.map(g => {
    const pct = kind === 'xbox'
      ? (g.total ? Math.round((Number(g.earned || 0) / Number(g.total)) * 100) : 0)
      : Number(g.progress || 0);
    const sub = kind === 'xbox'
      ? `${Number(g.earned || 0)}/${Number(g.total || 0)} achievements`
      : `${Number(g.progress || 0)}% complete`;
    return `
      <div class="trophy-row trophy-unlocked">
        <span class="trophy-ico">${kind === 'xbox' ? '🎮' : '🏆'}</span>
        <div style="min-width:0;flex:1">
          <div class="trophy-name">${escGame(g.name || 'Game')}</div>
          <div class="trophy-desc">${sub}</div>
          <div class="trophy-prog"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>
        </div>
      </div>`;
  }).join('');
}

export function trophyCaseHTML() {
  return `
    <div class="trophy-tabs" role="tablist">
      <button class="trophy-tab on" data-tab="hq">Dyer HQ</button>
      <button class="trophy-tab" data-tab="xbox">Xbox</button>
      <button class="trophy-tab" data-tab="psn">PlayStation</button>
    </div>
    <div class="trophy-panel" data-panel="hq">${dyerHqPanel()}</div>
    <div class="trophy-panel" data-panel="xbox" hidden>${consolePanel('xbox')}</div>
    <div class="trophy-panel" data-panel="psn" hidden>${consolePanel('psn')}</div>`;
}

// Tab switching — one delegated listener for the life of the page, since the
// case HTML is re-inserted each time the control center opens.
if (typeof document !== 'undefined' && !window.__trophyTabsWired) {
  window.__trophyTabsWired = true;
  document.addEventListener('click', e => {
    const tab = e.target.closest('.trophy-tab');
    if (!tab) return;
    const root = tab.closest('.trophy-case');
    if (!root) return;
    root.querySelectorAll('.trophy-tab').forEach(t => t.classList.toggle('on', t === tab));
    root.querySelectorAll('.trophy-panel').forEach(p => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  });
}
