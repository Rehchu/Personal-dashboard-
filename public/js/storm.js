// Procedural thunderstorm background — depth-layered rain driven by a slow wind
// gust, a distant cloud glow, and lightning (multi-stage flash + forked bolt).
// Original work. Runs on its own full-screen canvas; respects prefers-reduced-motion.

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// three depth bands. alpha and width are fixed per band so a whole band strokes
// in a single beginPath/stroke; near drops are long, fast, bright and drift most.
const BANDS = [
  { share: 0.40, alpha: 0.15, width: 0.9, len: [11, 20], v: [340, 500], drift: 0.50 },
  { share: 0.34, alpha: 0.29, width: 1.3, len: [21, 38], v: [560, 800], drift: 0.78 },
  { share: 0.26, alpha: 0.44, width: 1.8, len: [36, 70], v: [880, 1320], drift: 1.10 },
];

export function initStorm(canvas) {
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let w = 0, h = 0, dpr = 1;
  let layers = [];
  let glow = null;        // cached radial gradient, rebuilt only on resize
  let windT = 0;          // gust clock
  let flash = 0;          // 0..1 screen flash intensity
  let stages = [];        // queued flash stages: {t, level}
  let bolt = null;        // {main, forks, life, ttl}
  let nextStrike = rand(1.2, 3.5);
  let last = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    // sizing the bitmap resets all context state, so restore it here
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // full-opacity stops: globalAlpha modulates it per frame instead of
    // rebuilding the gradient every time the glow breathes
    glow = ctx.createRadialGradient(w * 0.68, -h * 0.25, 0, w * 0.68, -h * 0.25, h * 1.15);
    glow.addColorStop(0, 'rgb(154, 182, 230)');
    glow.addColorStop(0.45, 'rgba(122, 150, 202, 0.42)');
    glow.addColorStop(1, 'rgba(122, 150, 202, 0)');
    seed();
  }

  // density follows canvas area, not width, so a phone gets real rain; the
  // ceiling keeps a desktop at the same total stroke count as a tablet
  function seed() {
    const total = clamp(Math.round((w * h) / 1000), 220, 520);
    layers = BANDS.map((spec) => ({
      spec,
      drops: Array.from({ length: Math.round(total * spec.share) }, () => ({
        x: rand(-40, w + 40),
        y: rand(-h * 0.2, h),
        len: rand(spec.len[0], spec.len[1]),
        v: rand(spec.v[0], spec.v[1]),
      })),
    }));
  }

  // two out-of-phase sines so the gust never settles into an obvious loop
  function wind() {
    return -170 + 130 * Math.sin(windT * 0.11) + 60 * Math.sin(windT * 0.037 + 1.7);
  }

  function makeBolt() {
    const x0 = rand(w * 0.12, w * 0.88);
    const main = [[x0, -12]];
    const forks = [];
    let x = x0, y = -12;
    const endY = h * rand(0.55, 0.95);
    while (y < endY) {
      x += rand(-38, 38);
      y += rand(18, 46);
      main.push([x, y]);
      if (Math.random() < 0.2) {
        const fork = [[x, y]];
        let fx = x, fy = y;
        for (let i = Math.round(rand(2, 5)); i > 0; i--) {
          fx += rand(-62, 62);
          fy += rand(16, 44);
          fork.push([fx, fy]);
        }
        forks.push(fork);
      }
    }
    return { main, forks, life: 0, ttl: rand(0.22, 0.42) };
  }

  function strike() {
    if (Math.random() < 0.28) {
      // sheet lightning behind the cloud deck: glow only, no channel
      stages = [{ t: 0, level: rand(0.18, 0.34) }];
    } else {
      bolt = makeBolt();
      // leader then return stroke, so the flash stutters instead of ramping once
      stages = [{ t: 0, level: rand(0.7, 1) }, { t: rand(0.05, 0.11), level: rand(0.45, 0.8) }];
      if (Math.random() < 0.55) stages.push({ t: rand(0.16, 0.3), level: rand(0.3, 0.6) });
    }
    nextStrike = rand(3, 9);
  }

  function trace(pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  // main channel and every fork share one path, so a pass is a single stroke
  function strokeBolt(b) {
    ctx.beginPath();
    trace(b.main);
    for (const fork of b.forks) trace(fork);
    ctx.stroke();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    windT += dt;
    ctx.clearRect(0, 0, w, h);

    // queued flash stages fire on the clock, not on timers that outlive stop()
    for (let i = stages.length - 1; i >= 0; i--) {
      stages[i].t -= dt;
      if (stages[i].t <= 0) {
        flash = Math.max(flash, stages[i].level);
        stages.splice(i, 1);
      }
    }

    // distant cloud glow, breathing slowly and lit hard by a strike
    ctx.globalAlpha = clamp(0.16 + 0.05 * Math.sin(now / 4200) + flash * 0.55, 0, 1);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    // rain, one stroke per depth band
    const gust = wind();
    for (const layer of layers) {
      const { spec } = layer;
      const vx = gust * spec.drift;
      ctx.strokeStyle = `rgba(198, 216, 245, ${(spec.alpha + flash * 0.35).toFixed(3)})`;
      ctx.lineWidth = spec.width;
      ctx.beginPath();
      for (const d of layer.drops) {
        d.y += d.v * dt;
        d.x += vx * dt;
        if (d.y - d.len > h) {
          d.y = rand(-60, -10);
          d.x = rand(-40, w + 40);
        } else if (d.x < -80) {
          d.x += w + 160;
        } else if (d.x > w + 80) {
          d.x -= w + 160;
        }
        // trail the streak along the drop's own velocity so slant tracks the gust
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - vx * (d.len / d.v), d.y - d.len);
      }
      ctx.stroke();
    }

    // lightning bolt: soft halo pass, then a hot core, both flickering out
    if (bolt) {
      bolt.life += dt;
      if (bolt.life >= bolt.ttl) bolt = null;
      else {
        const k = 1 - bolt.life / bolt.ttl;
        const a = clamp(k * (0.78 + 0.22 * Math.sin(bolt.life * 90)), 0, 1);
        ctx.shadowColor = 'rgba(150, 185, 255, 0.95)';
        ctx.shadowBlur = 22;
        ctx.strokeStyle = `rgba(150, 190, 255, ${(a * 0.55).toFixed(3)})`;
        ctx.lineWidth = 6;
        strokeBolt(bolt);
        ctx.shadowBlur = 10;
        ctx.strokeStyle = `rgba(245, 250, 255, ${a.toFixed(3)})`;
        ctx.lineWidth = 2;
        strokeBolt(bolt);
        ctx.shadowBlur = 0;
      }
    }

    // screen flash — sits under the UI layers, so text never washes out
    if (flash > 0.004) {
      ctx.fillStyle = `rgba(206, 224, 255, ${(flash * 0.5).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      flash *= Math.pow(0.012, dt);
    } else {
      flash = 0;
    }

    nextStrike -= dt;
    if (nextStrike <= 0) strike();
  }

  let running = false;
  const onResize = () => resize();

  return {
    // force: the owner picked this background in the control center, which
    // outranks the reduced-motion default
    start(force = false) {
      if (running || (motion.matches && !force)) return;
      running = true;
      canvas.hidden = false;
      addEventListener('resize', onResize);
      resize();
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      canvas.hidden = true;
      flash = 0;
      stages = [];
      bolt = null;
      nextStrike = rand(1.2, 3.5);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    get running() { return running; },
  };
}
