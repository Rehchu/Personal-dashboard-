// Minimal single-series SVG charts (line + bar) with hover tooltips.
// Marks follow the house chart spec: 2px lines, ≥8px hover markers,
// 4px rounded bar data-ends, 2px gaps, recessive grid, text in ink tokens.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * pow) return m * pow;
  return 10 * pow;
}

function frame(width, height) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  wrap.append(svg, tip);
  const showTip = (px, py, html) => {
    tip.innerHTML = html;
    tip.style.left = `${(px / width) * 100}%`;
    tip.style.top = `${(py / height) * 100}%`;
    tip.style.opacity = '1';
  };
  const hideTip = () => { tip.style.opacity = '0'; };
  return { wrap, svg, showTip, hideTip };
}

function gridLines(svg, pad, W, H, yMax, fmt) {
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + ((H - pad.t - pad.b) * i) / ticks;
    const value = yMax - (yMax * i) / ticks;
    svg.append(el('line', {
      x1: pad.l, x2: W - pad.r, y1: y, y2: y,
      stroke: 'currentColor', 'stroke-opacity': i === ticks ? 0.35 : 0.10, 'stroke-width': 1,
    }));
    const label = el('text', {
      x: pad.l - 8, y: y + 4, 'text-anchor': 'end',
      fill: 'var(--ink-3)', 'font-size': 11, 'font-family': 'var(--font-body)',
    });
    label.textContent = fmt(value);
    svg.append(label);
  }
}

// points: [{label, value}] in x order. Returns a DOM node.
export function lineChart({ points, color = 'var(--chart, var(--accent))', fmt = v => String(Math.round(v)), empty = 'No data yet' }) {
  const W = 640, H = 240, pad = { t: 14, r: 14, b: 26, l: 62 };
  const { wrap, svg, showTip, hideTip } = frame(W, H);
  if (points.length < 2) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 15 });
    t.textContent = points.length === 1 ? 'Add one more entry to draw a trend' : empty;
    svg.append(t);
    return wrap;
  }

  const values = points.map(p => p.value);
  const lo = Math.min(...values), hi = Math.max(...values);
  const spread = Math.max(hi - lo, 1e-9);
  const yLo = lo - spread * 0.15, yHi = hi + spread * 0.15;
  const x = i => pad.l + ((W - pad.l - pad.r) * i) / (points.length - 1);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - yLo) / (yHi - yLo));

  // grid: min / mid / max of the padded range
  [yLo, (yLo + yHi) / 2, yHi].forEach(v => {
    const gy = y(v);
    svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: gy, y2: gy, stroke: 'currentColor', 'stroke-opacity': 0.10, 'stroke-width': 1 }));
    const label = el('text', { x: pad.l - 8, y: gy + 4, 'text-anchor': 'end', fill: 'var(--ink-3)', 'font-size': 11 });
    label.textContent = fmt(v);
    svg.append(label);
  });

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  svg.append(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // first / last x labels
  [[0, 'start'], [points.length - 1, 'end']].forEach(([i, anchor]) => {
    const t = el('text', { x: x(i), y: H - 8, 'text-anchor': anchor, fill: 'var(--ink-3)', 'font-size': 11 });
    t.textContent = points[i].label;
    svg.append(t);
  });

  // hover: crosshair + marker + tooltip
  const cross = el('line', { y1: pad.t, y2: H - pad.b, stroke: 'currentColor', 'stroke-opacity': 0, 'stroke-width': 1 });
  const dot = el('circle', { r: 5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
  svg.append(cross, dot);
  svg.append(el('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, fill: 'transparent' }));

  svg.addEventListener('pointermove', e => {
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(points.length - 1,
      Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * (points.length - 1))));
    const px = x(i), py = y(points[i].value);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    cross.setAttribute('stroke-opacity', 0.25);
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1);
    showTip(px, py, `<strong>${fmt(points[i].value)}</strong> · ${points[i].label}`);
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('stroke-opacity', 0);
    dot.setAttribute('opacity', 0);
    hideTip();
  });

  return wrap;
}

// bars: [{label, value, sublabel?}]. Rounded 4px data-end, 2px gaps.
export function barChart({ bars, color = 'var(--chart, var(--accent))', fmt = v => String(Math.round(v)), labelEvery = 1 }) {
  const W = 640, H = 240, pad = { t: 14, r: 14, b: 26, l: 62 };
  const { wrap, svg, showTip, hideTip } = frame(W, H);
  const yMax = niceMax(Math.max(...bars.map(b => b.value), 1));
  gridLines(svg, pad, W, H, yMax, fmt);

  const innerW = W - pad.l - pad.r;
  const step = innerW / bars.length;
  const barW = Math.max(step - 2, 2); // 2px surface gap between bars
  const baseline = H - pad.b;

  bars.forEach((b, i) => {
    const h = ((baseline - pad.t) * b.value) / yMax;
    const bx = pad.l + i * step + (step - barW) / 2;
    const by = baseline - h;
    const r = Math.min(4, barW / 2, h); // rounded data-end only, anchored baseline
    const d = h <= 0
      ? ''
      : `M${bx},${baseline} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${baseline} Z`;
    if (d) {
      const path = el('path', { d, fill: color });
      svg.append(path);
    }
    // hover target spans full column height
    const hit = el('rect', { x: pad.l + i * step, y: pad.t, width: step, height: baseline - pad.t, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      showTip(bx + barW / 2, h > 0 ? by : baseline - 8,
        `<strong>${fmt(b.value)}</strong> · ${b.sublabel || b.label}`);
    });
    hit.addEventListener('pointerleave', hideTip);
    svg.append(hit);

    if (i % labelEvery === 0) {
      const t = el('text', { x: bx + barW / 2, y: H - 8, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-size': 10.5 });
      t.textContent = b.label;
      svg.append(t);
    }
  });

  return wrap;
}
