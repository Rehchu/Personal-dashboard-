// Notebook module — OneNote-style sections and pages: typed text boxes sitting
// on top of the pressure-sensitive ink canvas. Strokes and text boxes are both
// stored in logical page units, so a page renders identically on any screen.

import { load, save, uid, debounce, showToast, esc } from './store.js';

const LOGICAL_W = 1000;  // logical page width; uniform scale preserves proportions
const LOGICAL_H = 1414;  // fixed A-series page: bounds identical on every screen

const COLORS = ['#f2f5f9', '#ffd23f', '#ff5964', '#5bd97a', '#45b8f2', '#c085ff', '#ff9950', '#8b8fa3'];

// Fixed id, not a fresh uid: every device migrates old flat pages into the same
// section, so a sync merge lines them up instead of making one section each.
const HOME_ID = 'sec-home';
const HOME_NAME = 'Notes';

const TXT_SIZE = 34;      // logical units
const TXT_PAD_X = 10;
const TXT_PAD_Y = 6;
const TXT_LINE = 1.35;
const TXT_FONT = '-apple-system, system-ui, "Segoe UI", Roboto, sans-serif';
const EXPORT_SCALE = 1.6; // export is measured off the logical page, not the screen

const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CSS = `
  .nbk { display: grid; grid-template-columns: minmax(200px, 244px) minmax(0, 1fr); gap: 18px; align-items: start; }
  .nbk-side {
    position: sticky; top: 0; display: flex; flex-direction: column; gap: 8px;
    max-height: calc(100vh - 160px); overflow: auto; padding: 12px;
    background: color-mix(in oklab, var(--surface) 90%, transparent);
    border: 1px solid color-mix(in oklab, var(--ink-3) 22%, transparent);
    border-radius: var(--panel-radius);
  }
  .nbk-side-head { display: flex; gap: 8px; align-items: center; }
  /* 16px keeps iOS from zooming the whole page when the field takes focus */
  .nbk-side-head input { flex: 1; min-width: 0; font-size: 16px; padding: 10px 12px; }
  #nb-close-side { display: none; }
  .nbk-cap-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
  .nbk-cap { font-family: var(--font-display); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }
  .nbk-row { display: flex; align-items: center; gap: 2px; }
  .nbk-pick {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px;
    padding: 6px 10px; border-radius: 10px; text-align: left; font-size: 15px;
    color: var(--ink-2); border: 1px solid transparent;
  }
  .nbk-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nbk-n { font-size: 12px; color: var(--ink-3); flex: 0 0 auto; }
  .nbk-row.active .nbk-pick { color: var(--ink); border-color: var(--accent); background: color-mix(in oklab, var(--accent) 16%, transparent); }
  .nbk-mini { width: 36px; min-height: 44px; border-radius: 9px; color: var(--ink-3); font-size: 14px; }
  .nbk-mini:hover { color: var(--ink); }
  .nbk-empty { font-size: 13px; color: var(--ink-3); padding: 6px 2px; }
  .nbk-hit { font-size: 12.5px; color: var(--ink-3); }

  .nbk-main { min-width: 0; }
  .nbk-pagebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  #nb-title { flex: 1; min-width: 160px; font-family: var(--font-display); font-size: 18px; font-weight: 700; letter-spacing: .04em; }
  .nbk-hint { font-size: 12.5px; margin-top: 10px; }
  .nbk-foot { height: calc(30px + env(safe-area-inset-bottom)); }
  .nbk .nb-tool { min-width: 44px; min-height: 44px; }

  /* text layer: the whole logical page, scaled to fit, so a box keeps the
     same coordinates as the ink underneath it */
  .nbk-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; touch-action: none; pointer-events: none; }
  .nbk-layer.on { pointer-events: auto; }
  .nbk-box { position: absolute; }
  .nbk-tb {
    min-height: 1.2em; color: var(--nbk-ink, var(--ink)); font-family: ${TXT_FONT};
    line-height: ${TXT_LINE}; white-space: pre-wrap; overflow-wrap: anywhere;
    padding: ${TXT_PAD_Y}px ${TXT_PAD_X}px; border: 1px dashed transparent; border-radius: 6px; outline: none;
  }
  .nbk-layer.on .nbk-tb:hover { border-color: color-mix(in oklab, var(--ink-3) 55%, transparent); }
  .nbk-box.sel .nbk-tb { border-color: color-mix(in oklab, var(--accent) 75%, transparent); background: color-mix(in oklab, var(--accent) 8%, transparent); }
  .nbk-chrome { position: absolute; left: 0; bottom: 100%; display: none; gap: calc(6px * var(--nbk-inv, 1)); padding-bottom: calc(4px * var(--nbk-inv, 1)); }
  .nbk-box.below .nbk-chrome { bottom: auto; top: 100%; padding: calc(4px * var(--nbk-inv, 1)) 0 0; }
  .nbk-box.sel .nbk-chrome { display: flex; }
  .nbk-grip, .nbk-del {
    width: calc(44px * var(--nbk-inv, 1)); height: calc(44px * var(--nbk-inv, 1));
    border-radius: calc(11px * var(--nbk-inv, 1)); display: grid; place-items: center;
    font-size: calc(16px * var(--nbk-inv, 1)); line-height: 1; color: var(--ink);
    background: color-mix(in oklab, var(--surface) 94%, transparent);
    border: 1px solid color-mix(in oklab, var(--ink-3) 40%, transparent); touch-action: none;
  }
  .nbk-grip { cursor: move; }
  @media (hover: hover) { .nbk-layer.on .nbk-box:hover .nbk-chrome { display: flex; } }

  @media (max-width: 820px) {
    .nbk { display: block; }
    .nbk-side {
      position: fixed; z-index: 60; left: 0; top: 0; bottom: 0; width: min(320px, 88vw);
      max-height: none; border-radius: 0 16px 16px 0; transform: translateX(-102%);
      transition: transform .22s ease; background: color-mix(in oklab, var(--surface) 98%, var(--bg));
      padding-bottom: calc(100px + env(safe-area-inset-bottom));
    }
    .nbk.open .nbk-side { transform: none; }
    #nb-close-side { display: inline-flex; }
    .nbk-scrim { position: fixed; inset: 0; z-index: 59; background: rgba(0, 0, 0, .55); }
  }
  @media (min-width: 821px) { #nb-menu { display: none; } .nbk-scrim { display: none; } }
  @media (prefers-reduced-motion: reduce) { .nbk-side { transition: none; } }`;

function normText(t) {
  if (!t || typeof t !== 'object') return null;
  const w = clamp(num(t.w, 480), 120, LOGICAL_W - 20);
  return {
    id: t.id || uid(),
    x: clamp(num(t.x, 60), 0, LOGICAL_W - w),
    y: clamp(num(t.y, 60), 0, LOGICAL_H - 30),
    w,
    size: clamp(num(t.size, TXT_SIZE), 14, 120),
    text: typeof t.text === 'string' ? t.text : '',
  };
}

// Old pages are { id, strokes } with no title, no section and no text — every
// missing field is filled in here rather than rewritten in storage first.
function normPage(p, i, sec) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    id: src.id || uid(),
    title: typeof src.title === 'string' && src.title.trim() ? src.title.slice(0, 80) : `Page ${i + 1}`,
    secId: typeof src.secId === 'string' && src.secId ? src.secId : sec.id,
    secName: typeof src.secName === 'string' && src.secName ? src.secName.slice(0, 60) : sec.name,
    secOrd: num(src.secOrd, sec.ord),
    ord: num(src.ord, i),
    strokes: Array.isArray(src.strokes) ? src.strokes : [],
    texts: Array.isArray(src.texts) ? src.texts.map(normText).filter(Boolean) : [],
  };
}

// Accepts the old flat page array, the current shape, and the mixed array a
// sync merge can produce; a nested {pages:[…]} record is unrolled, never dropped.
function normalize(raw) {
  const home = { id: HOME_ID, name: HOME_NAME, ord: 0 };
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.pages)) {
      const sec = {
        id: item.id || uid(),
        name: String(item.name || item.title || HOME_NAME).slice(0, 60),
        ord: num(item.ord, out.length),
      };
      for (const p of item.pages) out.push(normPage(p, out.length, sec));
      continue;
    }
    out.push(normPage(item, out.length, home));
  }
  if (!out.length) out.push(normPage({}, 0, home));
  return out;
}

// Sections live on their pages, so a section exists exactly as long as it holds
// at least one page — that keeps the whole notebook inside one synced key.
function sectionsOf(pages) {
  const map = new Map();
  pages.forEach((p, i) => {
    const hit = map.get(p.secId);
    if (hit) { hit.n++; hit.ord = Math.min(hit.ord, num(p.secOrd, hit.ord)); }
    else map.set(p.secId, { id: p.secId, name: p.secName, ord: num(p.secOrd, i), n: 1, seen: i });
  });
  return [...map.values()].sort((a, b) => a.ord - b.ord || a.seen - b.seen);
}

const pagesIn = (pages, secId) =>
  pages.filter(p => p.secId === secId).sort((a, b) => a.ord - b.ord);

const pageText = p => p.texts.map(t => t.text).join('\n');
const countWords = s => (s.match(/[^\s]+/g) || []).length;

export function mount(root, tools) {
  let pages = normalize(load('nb.pages', null));

  let curId = load('nb.pageId', null);
  if (!pages.some(p => p.id === curId)) {
    // first open after the rebuild: fall back to the old numeric page index
    const i = clamp(num(load('nb.page', 0), 0), 0, pages.length - 1);
    curId = pages[i].id;
  }
  const page = () => pages.find(p => p.id === curId) || pages[0];
  let curSec = page().secId;

  const MODES = ['text', 'pen', 'highlighter', 'eraser'];
  let mode = MODES.includes(load('nb.mode', 'text')) ? load('nb.mode', 'text') : 'text';
  let inkTool = mode === 'text' ? 'pen' : mode; // what an Apple Pencil draws with in text mode
  let color = load('nb.color', COLORS[0]);
  let size = load('nb.size', 4);
  let usePressure = load('nb.pressure', true);
  // Default ON: Apple Pencil + mouse draw, fingers scroll the page.
  let pencilOnly = load('nb.pencilOnly', true);
  let query = '';

  let undoStack = [];
  let redoStack = [];

  let warnedStorage = false;
  function persistNow() {
    const idx = pages.findIndex(p => p.id === curId);
    // nb.page stays a flat index: the dashboard's activity cards read it
    const ok = save('nb.pages', pages) && save('nb.page', Math.max(0, idx));
    save('nb.pageId', curId);
    save('nb.sec', curSec);
    if (!ok && !warnedStorage) {
      warnedStorage = true;
      showToast('⚠ Storage full — recent notes may not be saved');
    }
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  }
  const persist = debounce(persistNow, 400);

  if (!document.getElementById('notebook-style')) {
    const style = document.createElement('style');
    style.id = 'notebook-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  tools.innerHTML = `
    <button class="btn small" id="nb-menu" aria-expanded="false">☰ Pages</button>
    <button class="btn small" id="nb-prev" title="Previous page">‹</button>
    <span class="muted" id="nb-pageno" style="min-width:56px;text-align:center"></span>
    <button class="btn small" id="nb-next" title="Next page">›</button>
    <button class="btn small" id="nb-addpage" title="New page">＋ page</button>
    <button class="btn small" id="nb-export">⬇ PNG</button>`;

  root.innerHTML = `
    <div class="nbk" id="nb-wrap">
      <div class="nbk-scrim" id="nb-scrim" hidden></div>
      <aside class="nbk-side" id="nb-side">
        <div class="nbk-side-head">
          <input id="nb-search" type="search" placeholder="Search notes" aria-label="Search notes">
          <button class="btn small" id="nb-close-side" aria-label="Close notebook list">✕</button>
        </div>
        <div id="nb-browse">
          <div class="nbk-cap-row">
            <span class="nbk-cap">Sections</span>
            <button class="btn small" id="nb-addsec" title="New section">＋</button>
          </div>
          <div id="nb-seclist"></div>
          <div class="nbk-cap-row">
            <span class="nbk-cap">Pages</span>
            <button class="btn small" id="nb-addpage2" title="New page">＋</button>
          </div>
          <div id="nb-pagelist"></div>
        </div>
        <div id="nb-results" hidden></div>
      </aside>
      <main class="nbk-main">
        <div class="nbk-pagebar">
          <input id="nb-title" maxlength="80" placeholder="Page title" aria-label="Page title">
          <span class="muted" id="nb-count"></span>
        </div>
        <div class="nb-toolbar">
          <div class="nb-group" role="group" aria-label="Mode">
            <button class="nb-tool" data-mode="text" title="Text — tap the page to type">T</button>
            <button class="nb-tool" data-mode="pen" title="Pen">✒️</button>
            <button class="nb-tool" data-mode="highlighter" title="Highlighter">🖍️</button>
            <button class="nb-tool" data-mode="eraser" title="Eraser">◻️</button>
          </div>
          <div class="nb-group" role="group" aria-label="Colors" id="nb-colors">
            ${COLORS.map(c => `<button class="nb-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
          </div>
          <div class="nb-group">
            <label class="nb-toggle" for="nb-size" title="Stroke size">size
              <input id="nb-size" type="range" min="1" max="14" step="0.5" style="width:90px"></label>
          </div>
          <div class="nb-group">
            <label class="nb-toggle" title="Vary stroke width with Apple Pencil pressure">
              <input type="checkbox" id="nb-pressure"> pressure</label>
            <label class="nb-toggle" title="Ignore fingers for ink — draw only with Apple Pencil (palm rejection)">
              <input type="checkbox" id="nb-pencil"> pencil only</label>
          </div>
          <div class="nb-group">
            <button class="nb-tool" id="nb-undo" title="Undo">↩</button>
            <button class="nb-tool" id="nb-redo" title="Redo">↪</button>
            <button class="nb-tool" id="nb-clear" title="Clear page">🗑</button>
          </div>
        </div>
        <div id="nb-stage">
          <canvas id="nb-canvas"></canvas>
          <div class="nbk-layer" id="nb-layer"></div>
        </div>
        <p class="muted nbk-hint">Tap the page in Text mode to start typing there — Apple Pencil always draws.</p>
        <div class="nbk-foot"></div>
      </main>
    </div>`;

  const wrap = root.querySelector('#nb-wrap');
  const stage = root.querySelector('#nb-stage');
  const canvas = root.querySelector('#nb-canvas');
  const layer = root.querySelector('#nb-layer');
  const titleEl = root.querySelector('#nb-title');
  const ctx = canvas.getContext('2d');
  let scale = 1; // css px per logical unit
  let dpr = 1;

  /* ---------- ink ---------- */

  function strokeWidth(s, p) {
    const base = s.size * (s.tool === 'highlighter' ? 2.6 : s.tool === 'eraser' ? 3.2 : 1);
    if (!s.pressure) return base;
    const pr = p > 0 ? p : 0.5;
    return base * (0.35 + pr * 1.3);
  }

  function applyToolStyle(s) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
    ctx.strokeStyle = s.color;
  }

  // Draw the tail of a stroke: the segment ending at point i (midpoint smoothing).
  function drawSegment(s, i) {
    const pts = s.pts;
    if (i === 0) {
      // dot for a tap
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], strokeWidth(s, pts[0][2]) / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1;
      ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.fill();
      return;
    }
    const [x0, y0] = pts[i - 1];
    const [x1, y1, p1] = pts[i];
    applyToolStyle(s);
    ctx.lineWidth = strokeWidth(s, p1);
    ctx.beginPath();
    if (i === 1) {
      ctx.moveTo(x0, y0);
      ctx.lineTo((x0 + x1) / 2, (y0 + y1) / 2);
    } else {
      const [xp, yp] = pts[i - 2];
      ctx.moveTo((xp + x0) / 2, (yp + y0) / 2);
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    if (i === pts.length - 1) ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function drawStroke(s) {
    const pts = s.pts;
    if (!pts || !pts.length) return;
    if (s.tool === 'highlighter') {
      // One path at constant width: per-segment strokes double the alpha at
      // every joint and render as chains of darker blobs.
      applyToolStyle(s);
      ctx.lineWidth = s.size * 2.6;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.stroke();
      return;
    }
    for (let i = 0; i < pts.length; i++) drawSegment(s, i);
  }

  function redraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    for (const s of page().strokes) drawStroke(s);
    if (live) drawStroke(live); // a mid-stroke redraw must not erase live ink
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /* ---------- paper-aware text colour ---------- */

  // The paper is light in some themes and near-black in others, so typed text
  // picks its colour from the stage background instead of guessing.
  function paperInk() {
    const bg = getComputedStyle(stage).backgroundColor || '';
    const m = bg.match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return '#f2f5f9';
    const [r, g, b] = m.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#14181f' : '#f2f5f9';
  }

  function applyPaperInk() {
    wrap.style.setProperty('--nbk-ink', paperInk());
  }

  /* ---------- text boxes ---------- */

  const findText = id => page().texts.find(t => t.id === id);

  const readBox = el => (typeof el.innerText === 'string' ? el.innerText : el.textContent)
    .replace(/\u00a0/g, ' ').replace(/\n$/, '');

  function place(box, t) {
    box.style.left = `${t.x}px`;
    box.style.top = `${t.y}px`;
    box.style.width = `${t.w}px`;
    // the move/delete chrome hangs above the box; near the top edge it flips under
    box.classList.toggle('below', t.y * scale < 52);
  }

  function boxEl(t) {
    const box = document.createElement('div');
    box.className = 'nbk-box';
    box.dataset.id = t.id;
    const chrome = document.createElement('div');
    chrome.className = 'nbk-chrome';
    chrome.innerHTML = `<span class="nbk-grip" title="Drag to move" aria-hidden="true">⠿</span>
      <button class="nbk-del" title="Delete this text" aria-label="Delete this text">✕</button>`;
    const ed = document.createElement('div');
    ed.className = 'nbk-tb';
    // plaintext-only keeps pasted markup out; older engines reject the value
    try { ed.contentEditable = 'plaintext-only'; } catch { /* fall through */ }
    if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true';
    ed.style.fontSize = `${t.size}px`;
    ed.textContent = t.text;
    box.append(chrome, ed);
    place(box, t);
    return box;
  }

  function renderTexts() {
    layer.replaceChildren(...page().texts.map(boxEl));
  }

  function addTextAt(x, y) {
    const bx = clamp(x - TXT_PAD_X, 8, LOGICAL_W - 200);
    const t = normText({
      x: bx,
      y: clamp(y - TXT_SIZE * 0.7, 8, LOGICAL_H - 70),
      w: clamp(LOGICAL_W - bx - 24, 200, 560),
      size: TXT_SIZE,
      text: '',
    });
    page().texts.push(t);
    pushOp({ k: 'add', t, i: page().texts.length - 1 });
    const box = boxEl(t);
    layer.append(box);
    const ed = box.querySelector('.nbk-tb');
    box.classList.add('sel');
    ed.focus({ preventScroll: true }); // must stay inside the gesture or iOS keeps the keyboard shut
    persist();
  }

  const boxFor = id => [...layer.children].find(el => el.dataset.id === id);

  function removeText(id, { undoable = true } = {}) {
    const p = page();
    const i = p.texts.findIndex(t => t.id === id);
    if (i < 0) return;
    const [t] = p.texts.splice(i, 1);
    if (undoable) pushOp({ k: 'del', t, i });
    // an abandoned empty box never happened as far as undo is concerned
    else undoStack = undoStack.filter(op => op.id !== id && !(op.t && op.t.id === id));
    boxFor(id)?.remove();
    updateCount();
    renderSide();
    persist();
  }

  layer.addEventListener('input', e => {
    const box = e.target.closest('.nbk-box');
    if (!box) return;
    const t = findText(box.dataset.id);
    if (!t) return;
    t.text = readBox(e.target);
    updateCount();
    persist();
  });

  layer.addEventListener('focusin', e => {
    const box = e.target.closest('.nbk-box');
    if (box) box.classList.add('sel');
  });

  layer.addEventListener('focusout', e => {
    const box = e.target.closest('.nbk-box');
    if (!box) return;
    box.classList.remove('sel');
    const t = findText(box.dataset.id);
    if (t && !t.text.trim()) removeText(t.id, { undoable: false }); // empty + blurred = gone
    else renderSide();
  });

  layer.addEventListener('click', e => {
    const del = e.target.closest('.nbk-del');
    if (del) removeText(del.closest('.nbk-box').dataset.id);
  });

  // paste stays plain text even where contenteditable fell back to 'true'
  layer.addEventListener('paste', e => {
    if (!e.target.closest('.nbk-tb')) return;
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  });

  // Escape leaves the text box; the shell's Escape would close the module
  layer.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.target.blur?.();
  });

  /* ---------- undo / redo ---------- */

  function pushOp(op) {
    undoStack.push(op);
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
  }

  function applyOp(op, dir) { // dir: -1 undo, 1 redo
    const p = page();
    const drop = id => {
      const i = p.texts.findIndex(t => t.id === id);
      if (i >= 0) p.texts.splice(i, 1);
    };
    if (op.k === 'stroke') {
      if (dir < 0) {
        const i = p.strokes.lastIndexOf(op.s);
        if (i >= 0) p.strokes.splice(i, 1);
      } else p.strokes.push(op.s);
    } else if (op.k === 'add') {
      if (dir < 0) drop(op.t.id);
      else p.texts.splice(Math.min(op.i, p.texts.length), 0, op.t);
    } else if (op.k === 'del') {
      if (dir < 0) p.texts.splice(Math.min(op.i, p.texts.length), 0, op.t);
      else drop(op.t.id);
    } else if (op.k === 'move') {
      const t = p.texts.find(x => x.id === op.id);
      const to = dir < 0 ? op.from : op.to;
      if (t) { t.x = to[0]; t.y = to[1]; }
    } else if (op.k === 'clear') {
      if (dir < 0) { p.strokes = op.strokes.slice(); p.texts = op.texts.slice(); }
      else { p.strokes = []; p.texts = []; }
    }
    redraw();
    renderTexts();
    updateCount();
    renderSide();
    persist();
  }

  /* ---------- sizing ---------- */

  function resize() {
    // Measure the canvas itself (stage border-box is 2px larger → blur/offset).
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = window.devicePixelRatio || 1;
    scale = rect.width / LOGICAL_W;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    layer.style.width = `${LOGICAL_W}px`;
    layer.style.height = `${LOGICAL_H}px`;
    layer.style.transform = `scale(${scale})`;
    // chrome sizes itself in screen px by undoing the layer scale
    layer.style.setProperty('--nbk-inv', String(1 / scale));
    for (const box of layer.querySelectorAll('.nbk-box')) {
      const t = findText(box.dataset.id);
      if (t) place(box, t);
    }
    redraw();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  // themes swap the paper colour under the text
  const themeWatch = new MutationObserver(applyPaperInk);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-console'] });

  /* ---------- pointer routing ---------- */

  let live = null;          // stroke being drawn
  let livePointerId = null;
  let pan = null;           // finger scrolling the page
  let tap = null;           // pending text-box placement
  let drag = null;          // text box being moved

  function logical(e) {
    const rect = canvas.getBoundingClientRect();
    return [
      (e.clientX - rect.left) / scale,
      (e.clientY - rect.top) / scale,
      e.pressure || 0,
    ].map(n => Math.round(n * 100) / 100);
  }

  // Which tool this pointer draws with, or null if it isn't drawing. An Apple
  // Pencil draws in every mode — that is what the hardware is expected to do.
  function drawTool(e) {
    if (!e.isPrimary) return null;
    if (mode === 'text') return e.pointerType === 'pen' ? inkTool : null;
    if (pencilOnly && e.pointerType === 'touch') return null;
    return mode;
  }

  const scroller = () => stage.closest('#appview-body') || document.scrollingElement;

  stage.addEventListener('pointerdown', e => {
    const grip = e.target.closest?.('.nbk-grip');
    if (grip) {
      const box = grip.closest('.nbk-box');
      const t = findText(box.dataset.id);
      if (!t) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, t, box, cx: e.clientX, cy: e.clientY, x0: t.x, y0: t.y };
      return;
    }
    if (e.target.closest?.('.nbk-del')) return;

    const tool = drawTool(e);
    if (tool) {
      e.preventDefault();
      if (layer.contains(document.activeElement)) document.activeElement.blur();
      stage.setPointerCapture(e.pointerId);
      livePointerId = e.pointerId;
      live = { tool, color, size, pressure: usePressure, pts: [logical(e)] };
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
      if (tool === 'highlighter') redraw();
      else drawSegment(live, 0);
      return;
    }

    const inBox = Boolean(e.target.closest?.('.nbk-box'));
    // fingers pan the scroll container; inside a box they select text instead
    if (e.pointerType === 'touch' && !inBox) pan = { id: e.pointerId, y: e.clientY };
    if (mode === 'text' && !inBox && e.isPrimary) {
      tap = { id: e.pointerId, cx: e.clientX, cy: e.clientY, pt: logical(e) };
    }
  });

  stage.addEventListener('pointermove', e => {
    if (drag && e.pointerId === drag.id) {
      const t = drag.t;
      t.x = clamp(drag.x0 + (e.clientX - drag.cx) / scale, 0, LOGICAL_W - t.w);
      t.y = clamp(drag.y0 + (e.clientY - drag.cy) / scale, 0, LOGICAL_H - 40);
      place(drag.box, t);
      return;
    }
    // `live` only exists between pointerdown and pointerup, so hover moves
    // (e.g. Apple Pencil 2 hover) never draw. Don't gate on e.buttons — some
    // iPad Safari versions report buttons=0 for in-contact Pencil moves.
    if (live && e.pointerId === livePointerId) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      let added = false;
      for (const ev of events) {
        const pt = logical(ev);
        const last = live.pts[live.pts.length - 1];
        if (Math.abs(pt[0] - last[0]) < 0.4 && Math.abs(pt[1] - last[1]) < 0.4) continue;
        live.pts.push(pt);
        added = true;
        if (live.tool !== 'highlighter') drawSegment(live, live.pts.length - 1);
      }
      // Highlighter re-renders as one translucent path so joints don't stack.
      if (added && live.tool === 'highlighter') redraw();
      return;
    }
    if (tap && e.pointerId === tap.id
      && (Math.abs(e.clientX - tap.cx) > 10 || Math.abs(e.clientY - tap.cy) > 10)) tap = null;
    if (pan && e.pointerId === pan.id) {
      scroller().scrollTop -= e.clientY - pan.y;
      pan.y = e.clientY;
    }
  });

  function endStroke(e) {
    if (!live || (e && e.pointerId !== livePointerId)) return;
    if (e && stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    page().strokes.push(live);
    pushOp({ k: 'stroke', s: live });
    live = null;
    livePointerId = null;
    persist();
  }

  stage.addEventListener('pointerup', e => {
    if (drag && e.pointerId === drag.id) {
      const { t, x0, y0 } = drag;
      drag = null;
      if (t.x !== x0 || t.y !== y0) {
        pushOp({ k: 'move', id: t.id, from: [x0, y0], to: [t.x, t.y] });
        persist();
      }
      return;
    }
    endStroke(e);
    if (pan && e.pointerId === pan.id) pan = null;
    if (tap && e.pointerId === tap.id) {
      const [x, y] = tap.pt;
      tap = null;
      addTextAt(x, y);
    }
  });

  stage.addEventListener('pointercancel', e => {
    if (drag && e.pointerId === drag.id) { place(drag.box, drag.t); drag = null; }
    if (pan && e.pointerId === pan.id) pan = null;
    if (tap && e.pointerId === tap.id) tap = null;
    if (live && e.pointerId === livePointerId) { live = null; livePointerId = null; redraw(); }
  });

  /* ---------- sidebar ---------- */

  const openSide = on => {
    wrap.classList.toggle('open', on);
    root.querySelector('#nb-scrim').hidden = !on;
    tools.querySelector('#nb-menu').setAttribute('aria-expanded', String(on));
  };

  function rowHTML(kind, id, name, meta, active) {
    return `<div class="nbk-row${active ? ' active' : ''}">
      <button class="nbk-pick" data-pick="${kind}" data-id="${esc(id)}">
        <span class="nbk-nm">${esc(name)}</span><span class="nbk-n">${esc(meta)}</span>
      </button>
      <button class="nbk-mini" data-ren="${kind}" data-id="${esc(id)}" aria-label="Rename ${kind}">✎</button>
      <button class="nbk-mini" data-del="${kind}" data-id="${esc(id)}" aria-label="Delete ${kind}">✕</button>
    </div>`;
  }

  function renderSide() {
    const q = query.trim().toLowerCase();
    root.querySelector('#nb-browse').hidden = Boolean(q);
    const res = root.querySelector('#nb-results');
    res.hidden = !q;

    if (q) {
      const hits = pages.filter(p =>
        p.title.toLowerCase().includes(q) || pageText(p).toLowerCase().includes(q));
      res.innerHTML = hits.length
        ? hits.map(p => {
          const body = pageText(p).replace(/\s+/g, ' ').trim();
          const at = body.toLowerCase().indexOf(q);
          const snip = at < 0 ? body.slice(0, 60) : body.slice(Math.max(0, at - 20), at + 46);
          return `<div class="nbk-row${p.id === curId ? ' active' : ''}">
            <button class="nbk-pick" data-pick="page" data-id="${esc(p.id)}">
              <span class="nbk-nm">${esc(p.title)}
                <span class="nbk-hit">— ${esc(p.secName)}${snip ? ` · ${esc(snip)}` : ''}</span>
              </span>
            </button></div>`;
        }).join('')
        : '<p class="nbk-empty">Nothing matches that.</p>';
      return;
    }

    const secs = sectionsOf(pages);
    root.querySelector('#nb-seclist').innerHTML = secs.map(s =>
      rowHTML('section', s.id, s.name, `${s.n}`, s.id === curSec)).join('');

    const list = pagesIn(pages, curSec);
    root.querySelector('#nb-pagelist').innerHTML = list.length
      ? list.map(p => {
        const w = countWords(pageText(p));
        const meta = w ? `${w}w` : (p.strokes.length ? '✎' : '');
        return rowHTML('page', p.id, p.title, meta, p.id === curId);
      }).join('')
      : '<p class="nbk-empty">No pages in this section.</p>';
  }

  function updateCount() {
    const p = page();
    const w = countWords(pageText(p));
    root.querySelector('#nb-count').textContent =
      `${w} ${w === 1 ? 'word' : 'words'} · ${p.strokes.length} ${p.strokes.length === 1 ? 'stroke' : 'strokes'}`;
  }

  function selectPage(id, { close = false } = {}) {
    const p = pages.find(x => x.id === id);
    if (!p) return;
    curId = p.id;
    curSec = p.secId;
    undoStack = [];
    redoStack = [];
    renderTexts();
    redraw();
    syncUI();
    renderSide();
    persistNow();
    if (close) openSide(false);
  }

  function addPage(secId) {
    const sec = sectionsOf(pages).find(s => s.id === secId) || { id: HOME_ID, name: HOME_NAME, ord: 0 };
    const sibs = pagesIn(pages, sec.id);
    const p = normPage({
      title: `Page ${sibs.length + 1}`,
      secId: sec.id,
      secName: sec.name,
      secOrd: sec.ord,
      ord: sibs.length ? num(sibs[sibs.length - 1].ord, sibs.length - 1) + 1 : 0,
    }, pages.length, sec);
    pages.push(p);
    selectPage(p.id, { close: true });
  }

  function addSection() {
    const name = prompt('Section name:', 'New section');
    if (name === null || !name.trim()) return;
    const secs = sectionsOf(pages);
    const sec = {
      id: uid(),
      name: name.trim().slice(0, 60),
      ord: secs.length ? num(secs[secs.length - 1].ord, secs.length - 1) + 1 : 0,
    };
    const p = normPage({ title: 'Page 1', secId: sec.id, secName: sec.name, secOrd: sec.ord, ord: 0 }, 0, sec);
    pages.push(p);
    curSec = sec.id;
    selectPage(p.id, { close: true });
  }

  root.querySelector('#nb-side').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.pick === 'page') { selectPage(id, { close: true }); return; }
    if (btn.dataset.pick === 'section') {
      const first = pagesIn(pages, id)[0];
      curSec = id;
      if (first) selectPage(first.id, { close: true });
      else { renderSide(); openSide(false); }
      return;
    }

    if (btn.dataset.ren === 'page') {
      const p = pages.find(x => x.id === id);
      if (!p) return;
      const name = prompt('Page title:', p.title);
      if (name === null || !name.trim()) return;
      p.title = name.trim().slice(0, 80);
      syncUI(); renderSide(); persist();
      return;
    }
    if (btn.dataset.ren === 'section') {
      const sec = sectionsOf(pages).find(s => s.id === id);
      if (!sec) return;
      const name = prompt('Section name:', sec.name);
      if (name === null || !name.trim()) return;
      // the name lives on every page of the section — rename them together
      for (const p of pages) if (p.secId === id) p.secName = name.trim().slice(0, 60);
      renderSide(); persist();
      return;
    }

    if (btn.dataset.del === 'page') {
      const p = pages.find(x => x.id === id);
      if (!p) return;
      const has = p.strokes.length || p.texts.length;
      if (has && !confirm(`Delete "${p.title}"? Its ink and text go with it.`)) return;
      const sec = { id: p.secId, name: p.secName, ord: p.secOrd };
      pages = pages.filter(x => x.id !== id);
      let next = pagesIn(pages, sec.id)[0];
      if (!next) {
        // a section only exists through its pages, so keep one blank page alive
        next = normPage({ title: 'Page 1', secId: sec.id, secName: sec.name, secOrd: sec.ord, ord: 0 }, 0, sec);
        pages.push(next);
      }
      selectPage(next.id);
      showToast('Page deleted');
      return;
    }
    if (btn.dataset.del === 'section') {
      const sec = sectionsOf(pages).find(s => s.id === id);
      if (!sec) return;
      if (!confirm(`Delete section "${sec.name}" and its ${sec.n} page${sec.n === 1 ? '' : 's'}?`)) return;
      pages = pages.filter(p => p.secId !== id);
      if (!pages.length) pages = normalize(null);
      curSec = pages[0].secId;
      selectPage(pagesIn(pages, curSec)[0].id);
      showToast('Section deleted');
    }
  });

  root.querySelector('#nb-search').addEventListener('input', e => {
    query = e.target.value;
    renderSide();
  });
  root.querySelector('#nb-addsec').addEventListener('click', addSection);
  root.querySelector('#nb-addpage2').addEventListener('click', () => addPage(curSec));
  root.querySelector('#nb-close-side').addEventListener('click', () => openSide(false));
  root.querySelector('#nb-scrim').addEventListener('click', () => openSide(false));

  titleEl.addEventListener('input', () => {
    page().title = titleEl.value.slice(0, 80);
    renderSide();
    persist();
  });

  /* ---------- toolbar ---------- */

  const setActive = (sel, match) => root.querySelectorAll(sel).forEach(b =>
    b.classList.toggle('active', match(b)));

  function syncUI() {
    setActive('.nb-tool[data-mode]', b => b.dataset.mode === mode);
    setActive('.nb-swatch', b => b.dataset.color === color);
    root.querySelector('#nb-size').value = size;
    root.querySelector('#nb-pressure').checked = usePressure;
    root.querySelector('#nb-pencil').checked = pencilOnly;
    layer.classList.toggle('on', mode === 'text');
    // don't fight the caret while the owner is typing the title
    if (document.activeElement !== titleEl) titleEl.value = page().title;
    const list = pagesIn(pages, curSec);
    const i = list.findIndex(p => p.id === curId);
    tools.querySelector('#nb-pageno').textContent = `${Math.max(0, i) + 1} / ${list.length || 1}`;
    updateCount();
  }

  root.querySelectorAll('.nb-tool[data-mode]').forEach(b =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      if (mode !== 'text') inkTool = mode; // what the Pencil keeps drawing with in text mode
      save('nb.mode', mode);
      syncUI();
    }));

  root.querySelectorAll('.nb-swatch').forEach(b =>
    b.addEventListener('click', () => {
      color = b.dataset.color;
      save('nb.color', color);
      if (mode === 'eraser') { mode = 'pen'; inkTool = 'pen'; save('nb.mode', mode); }
      syncUI();
    }));

  root.querySelector('#nb-size').addEventListener('input', e => {
    size = Number(e.target.value);
    save('nb.size', size);
  });
  root.querySelector('#nb-pressure').addEventListener('change', e => {
    usePressure = e.target.checked;
    save('nb.pressure', usePressure);
  });
  // touch-action stays 'none' in every mode: on iPadOS a CSS pan gesture also
  // captures Apple Pencil (stylus counts as direct manipulation), which would
  // turn strokes into scrolls. Finger-scroll is done in JS instead.
  root.querySelector('#nb-pencil').addEventListener('change', e => {
    pencilOnly = e.target.checked;
    save('nb.pencilOnly', pencilOnly);
  });

  root.querySelector('#nb-undo').addEventListener('click', () => {
    const op = undoStack.pop();
    if (!op) return;
    redoStack.push(op);
    applyOp(op, -1);
  });
  root.querySelector('#nb-redo').addEventListener('click', () => {
    const op = redoStack.pop();
    if (!op) return;
    undoStack.push(op);
    applyOp(op, 1);
  });
  root.querySelector('#nb-clear').addEventListener('click', () => {
    const p = page();
    if (!p.strokes.length && !p.texts.length) return;
    if (!confirm('Clear this page? Ink and text both go.')) return;
    pushOp({ k: 'clear', strokes: p.strokes.slice(), texts: p.texts.slice() });
    p.strokes = [];
    p.texts = [];
    renderTexts();
    redraw();
    updateCount();
    renderSide();
    persist();
  });

  /* ---------- header tools ---------- */

  function step(delta) {
    const list = pagesIn(pages, curSec);
    const i = list.findIndex(p => p.id === curId);
    const next = list[clamp((i < 0 ? 0 : i) + delta, 0, list.length - 1)];
    if (next && next.id !== curId) selectPage(next.id);
  }

  tools.querySelector('#nb-menu').addEventListener('click', () => openSide(!wrap.classList.contains('open')));
  tools.querySelector('#nb-prev').addEventListener('click', () => step(-1));
  tools.querySelector('#nb-next').addEventListener('click', () => step(1));
  tools.querySelector('#nb-addpage').addEventListener('click', () => addPage(curSec));

  tools.querySelector('#nb-export').addEventListener('click', () => {
    const p = page();
    const out = document.createElement('canvas');
    out.width = Math.round(LOGICAL_W * EXPORT_SCALE);
    out.height = Math.round(LOGICAL_H * EXPORT_SCALE);
    const octx = out.getContext('2d');
    octx.fillStyle = getComputedStyle(stage).backgroundColor || '#10151d';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0, out.width, out.height);
    // text lives in the DOM, so it has to be re-drawn or the export loses it
    octx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
    octx.fillStyle = paperInk();
    octx.textBaseline = 'top';
    for (const t of p.texts) {
      octx.font = `${t.size}px ${TXT_FONT}`;
      const maxW = t.w - TXT_PAD_X * 2 - 2;
      let y = t.y + TXT_PAD_Y;
      for (const para of t.text.split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
          const next = line ? `${line} ${word}` : word;
          if (line && octx.measureText(next).width > maxW) {
            octx.fillText(line, t.x + TXT_PAD_X, y);
            y += t.size * TXT_LINE;
            line = word;
          } else line = next;
        }
        octx.fillText(line, t.x + TXT_PAD_X, y);
        y += t.size * TXT_LINE;
      }
    }
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `${(p.title || 'notebook-page').replace(/[^\w -]+/g, '').trim() || 'notebook-page'}.png`;
    a.click();
  });

  applyPaperInk();
  renderTexts();
  syncUI();
  renderSide();
  resize();

  return () => { // unmount cleanup: never lose the last 400ms of ink or typing
    ro.disconnect();
    themeWatch.disconnect();
    document.getElementById('notebook-style')?.remove();
    const p = page();
    for (const t of p.texts.slice()) if (!t.text.trim()) removeText(t.id, { undoable: false });
    persistNow();
  };
}
