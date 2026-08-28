// Notebook module — pressure-sensitive handwriting canvas for Apple Pencil
// (any pointer works). Strokes are stored as vectors in logical page units,
// so pages re-render crisply at any window size / DPR and survive reloads.

import { load, save, uid, debounce, showToast } from './store.js';

const LOGICAL_W = 1000;  // logical page width; uniform scale preserves proportions
const LOGICAL_H = 1414;  // fixed A-series page: bounds identical on every screen

const COLORS = ['#f2f5f9', '#ffd23f', '#ff5964', '#5bd97a', '#45b8f2', '#c085ff', '#ff9950', '#8b8fa3'];

const newPage = () => ({ id: uid(), strokes: [] });

export function mount(root, tools) {
  let pages = load('nb.pages', null);
  if (!pages || !pages.length) pages = [newPage()];
  let pageIndex = Math.min(load('nb.page', 0), pages.length - 1);
  let tool = 'pen';
  let color = load('nb.color', COLORS[0]);
  let size = load('nb.size', 4);
  let usePressure = load('nb.pressure', true);
  // Default ON: Apple Pencil + mouse draw, fingers scroll the page.
  let pencilOnly = load('nb.pencilOnly', true);
  const redoStack = [];

  let warnedStorage = false;
  const persist = debounce(() => {
    const ok = save('nb.pages', pages) && save('nb.page', pageIndex);
    if (!ok && !warnedStorage) {
      warnedStorage = true;
      showToast('⚠ Storage full — recent ink may not be saved');
    }
  }, 400);

  tools.innerHTML = `
    <button class="btn small" id="nb-prev" title="Previous page">‹</button>
    <span class="muted" id="nb-pageno" style="min-width:64px;text-align:center"></span>
    <button class="btn small" id="nb-next" title="Next page">›</button>
    <button class="btn small" id="nb-addpage" title="New page">＋ page</button>
    <button class="btn small" id="nb-export">⬇ PNG</button>`;

  root.innerHTML = `
    <div class="nb-toolbar">
      <div class="nb-group" role="group" aria-label="Tools">
        <button class="nb-tool" data-tool="pen" title="Pen">✒️</button>
        <button class="nb-tool" data-tool="highlighter" title="Highlighter">🖍️</button>
        <button class="nb-tool" data-tool="eraser" title="Eraser">◻️</button>
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
        <label class="nb-toggle" title="Ignore fingers — draw only with Apple Pencil (palm rejection)">
          <input type="checkbox" id="nb-pencil"> pencil only</label>
      </div>
      <div class="nb-group">
        <button class="nb-tool" id="nb-undo" title="Undo">↩</button>
        <button class="nb-tool" id="nb-redo" title="Redo">↪</button>
        <button class="nb-tool" id="nb-clear" title="Clear page">🗑</button>
      </div>
    </div>
    <div id="nb-stage"><canvas id="nb-canvas"></canvas></div>`;

  const stage = root.querySelector('#nb-stage');
  const canvas = root.querySelector('#nb-canvas');
  const ctx = canvas.getContext('2d');
  let scale = 1; // css px per logical unit
  let dpr = 1;

  const page = () => pages[pageIndex];

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
    if (!pts.length) return;
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

  function resize() {
    // Measure the canvas itself (stage border-box is 2px larger → blur/offset).
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = window.devicePixelRatio || 1;
    scale = rect.width / LOGICAL_W;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    redraw();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  // ---------- input ----------
  let live = null; // stroke being drawn
  let livePointerId = null;

  function logical(e) {
    const rect = canvas.getBoundingClientRect();
    return [
      (e.clientX - rect.left) / scale,
      (e.clientY - rect.top) / scale,
      e.pressure || 0,
    ].map(n => Math.round(n * 100) / 100);
  }

  function allowed(e) {
    if (pencilOnly && e.pointerType === 'touch') return false;
    return true;
  }

  canvas.addEventListener('pointerdown', e => {
    if (!allowed(e) || !e.isPrimary) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    livePointerId = e.pointerId;
    live = { tool, color, size, pressure: usePressure, pts: [logical(e)] };
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    if (tool === 'highlighter') redraw();
    else drawSegment(live, 0);
  });

  canvas.addEventListener('pointermove', e => {
    // `live` only exists between pointerdown and pointerup, so hover moves
    // (e.g. Apple Pencil 2 hover) never draw. Don't gate on e.buttons — some
    // iPad Safari versions report buttons=0 for in-contact Pencil moves.
    if (!live || e.pointerId !== livePointerId) return;
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
  });

  function finish(e) {
    if (!live || (e && e.pointerId !== livePointerId)) return;
    if (e && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    page().strokes.push(live);
    live = null;
    livePointerId = null;
    redoStack.length = 0;
    persist();
  }

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { live = null; livePointerId = null; redraw(); });

  // ---------- toolbar wiring ----------
  const setActive = (sel, match) => root.querySelectorAll(sel).forEach(b =>
    b.classList.toggle('active', match(b)));

  function syncToolbar() {
    setActive('.nb-tool[data-tool]', b => b.dataset.tool === tool);
    setActive('.nb-swatch', b => b.dataset.color === color);
    root.querySelector('#nb-size').value = size;
    root.querySelector('#nb-pressure').checked = usePressure;
    root.querySelector('#nb-pencil').checked = pencilOnly;
    tools.querySelector('#nb-pageno').textContent = `${pageIndex + 1} / ${pages.length}`;
  }

  root.querySelectorAll('.nb-tool[data-tool]').forEach(b =>
    b.addEventListener('click', () => { tool = b.dataset.tool; syncToolbar(); }));
  root.querySelectorAll('.nb-swatch').forEach(b =>
    b.addEventListener('click', () => { color = b.dataset.color; save('nb.color', color); tool = tool === 'eraser' ? 'pen' : tool; syncToolbar(); }));
  root.querySelector('#nb-size').addEventListener('input', e => { size = Number(e.target.value); save('nb.size', size); });
  root.querySelector('#nb-pressure').addEventListener('change', e => { usePressure = e.target.checked; save('nb.pressure', usePressure); });
  // With pencil-only on, fingers should scroll the page (native-app feel);
  // pen and mouse pointers are unaffected by touch-action.
  const applyTouchAction = () => { canvas.style.touchAction = pencilOnly ? 'pan-x pan-y' : 'none'; };
  root.querySelector('#nb-pencil').addEventListener('change', e => {
    pencilOnly = e.target.checked;
    save('nb.pencilOnly', pencilOnly);
    applyTouchAction();
  });
  applyTouchAction();

  root.querySelector('#nb-undo').addEventListener('click', () => {
    const s = page().strokes.pop();
    if (s) { redoStack.push(s); redraw(); persist(); }
  });
  root.querySelector('#nb-redo').addEventListener('click', () => {
    const s = redoStack.pop();
    if (s) { page().strokes.push(s); redraw(); persist(); }
  });
  root.querySelector('#nb-clear').addEventListener('click', () => {
    if (!page().strokes.length || confirm('Clear this page?')) {
      page().strokes = [];
      redoStack.length = 0;
      redraw(); persist();
    }
  });

  function goto(i) {
    pageIndex = Math.max(0, Math.min(pages.length - 1, i));
    redoStack.length = 0;
    syncToolbar(); redraw(); persist();
  }
  tools.querySelector('#nb-prev').addEventListener('click', () => goto(pageIndex - 1));
  tools.querySelector('#nb-next').addEventListener('click', () => goto(pageIndex + 1));
  tools.querySelector('#nb-addpage').addEventListener('click', () => {
    pages.splice(pageIndex + 1, 0, newPage());
    goto(pageIndex + 1);
  });

  tools.querySelector('#nb-export').addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(rect.width * 2);
    out.height = Math.round(rect.height * 2);
    const octx = out.getContext('2d');
    octx.fillStyle = getComputedStyle(stage).backgroundColor || '#10151d';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0, out.width, out.height);
    const a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = `notebook-page-${pageIndex + 1}.png`;
    a.click();
  });

  syncToolbar();
  resize();

  return () => ro.disconnect(); // unmount cleanup
}
