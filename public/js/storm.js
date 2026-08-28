// Procedural thunderstorm background — slanted rain, distant cloud glow, and
// occasional lightning (flash + jagged bolt). Original work, muted by nature.
// Runs on its own full-screen canvas; respects prefers-reduced-motion.

const rand = (a, b) => a + Math.random() * (b - a);

export function initStorm(canvas) {
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let w = 0, h = 0, dpr = 1;
  let drops = [];
  let flash = 0;          // 0..1 screen flash intensity
  let bolt = null;        // {pts, life}
  let nextStrike = rand(4, 9);
  let last = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const n = Math.round(Math.min(150, w / 9));
    drops = Array.from({ length: n }, () => ({
      x: rand(-w * 0.1, w * 1.1),
      y: rand(0, h),
      len: rand(9, 22),
      v: rand(420, 820),
      a: rand(0.08, 0.26),
    }));
  }

  function makeBolt() {
    const pts = [[rand(w * 0.15, w * 0.85), -10]];
    let [x, y] = pts[0];
    while (y < h * rand(0.45, 0.8)) {
      x += rand(-46, 46);
      y += rand(22, 60);
      pts.push([x, y]);
      // occasional short fork
      if (Math.random() < 0.22) {
        pts.push([x + rand(-70, 70), y + rand(20, 60)]);
        pts.push([x, y]);
      }
    }
    return { pts, life: 0 };
  }

  function strike() {
    flash = rand(0.55, 0.95);
    if (Math.random() < 0.75) bolt = makeBolt();
    // double-flash feel
    if (Math.random() < 0.5) setTimeout(() => { flash = Math.max(flash, rand(0.3, 0.6)); }, rand(90, 200));
    nextStrike = rand(5, 14);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    ctx.clearRect(0, 0, w, h);

    // distant cloud glow, breathing slowly
    const glow = 0.05 + 0.02 * Math.sin(now / 4000) + flash * 0.25;
    const g = ctx.createRadialGradient(w * 0.7, -h * 0.2, 0, w * 0.7, -h * 0.2, h * 0.9);
    g.addColorStop(0, `rgba(150, 175, 220, ${glow.toFixed(3)})`);
    g.addColorStop(1, 'rgba(150, 175, 220, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // rain (wind-slanted)
    ctx.lineWidth = 1;
    for (const d of drops) {
      d.y += d.v * dt;
      d.x -= d.v * 0.18 * dt;
      if (d.y > h + 30) { d.y = -30; d.x = rand(-w * 0.05, w * 1.15); }
      ctx.strokeStyle = `rgba(190, 210, 240, ${(d.a + flash * 0.15).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * 0.18, d.y - d.len);
      ctx.stroke();
    }

    // lightning bolt
    if (bolt) {
      bolt.life += dt;
      const a = Math.max(0, 0.9 - bolt.life * 4);
      if (a <= 0) bolt = null;
      else {
        ctx.strokeStyle = `rgba(235, 242, 255, ${a.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(180, 200, 255, 0.9)';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        bolt.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    // screen flash
    if (flash > 0.005) {
      ctx.fillStyle = `rgba(220, 230, 250, ${(flash * 0.28).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      flash *= Math.pow(0.02, dt); // fast decay
    } else {
      flash = 0;
    }

    nextStrike -= dt;
    if (nextStrike <= 0) strike();
  }

  let running = false;
  const onResize = () => resize();

  return {
    start() {
      if (running || motion.matches) return;
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
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    get running() { return running; },
  };
}
