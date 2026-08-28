// Per-theme ambient particle layer on one full-screen canvas (behind the UI).
// Slow, sparse, low-alpha — ambience, not spectacle. ≤60 particles per theme.
// Under prefers-reduced-motion a single static sparse frame is drawn instead.
//
//   const ambient = initAmbient(canvas);
//   ambient.setTheme('cyberpunk');
//   ambient.destroy();

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];

function wrap(p, w, h, m) {
  if (p.x < -m) p.x = w + m; else if (p.x > w + m) p.x = -m;
  if (p.y < -m) p.y = h + m; else if (p.y > h + m) p.y = -m;
}

/* ---------- theme systems ---------- */
// Each maker returns { update(dt, w, h), draw(ctx, w, h) }.
// k is a density factor (0.5 for the reduced-motion static frame).

function masseffect(w, h, k) {
  const stars = Array.from({ length: Math.round(54 * k) }, (_, i) => ({
    x: rand(0, w), y: rand(0, h),
    z: i % 3, // depth layer
    tw: rand(0, TAU),
  }));
  let shot = null;
  let next = rand(5, 8);
  return {
    update(dt, w, h) {
      for (const s of stars) {
        s.x -= (1.5 + s.z * 3) * dt;
        s.tw += dt * (0.4 + s.z * 0.3);
        if (s.x < -2) { s.x = w + 2; s.y = rand(0, h); }
      }
      next -= dt;
      if (!shot && next <= 0) {
        shot = { x: rand(w * 0.4, w * 0.95), y: rand(h * 0.05, h * 0.4), life: 0 };
        next = rand(7, 9);
      }
      if (shot) {
        shot.x -= 55 * dt; shot.y += 20 * dt; shot.life += dt;
        if (shot.life > 2.6 || shot.x < -80) shot = null;
      }
    },
    draw(ctx) {
      for (const s of stars) {
        const a = (0.1 + s.z * 0.08) * (0.65 + 0.35 * Math.sin(s.tw));
        ctx.fillStyle = `rgba(205, 225, 255, ${a.toFixed(3)})`;
        ctx.fillRect(s.x, s.y, 1 + s.z * 0.7, 1 + s.z * 0.7);
      }
      if (shot) {
        const a = 0.35 * Math.sin(Math.min(shot.life / 2.6, 1) * Math.PI);
        const g = ctx.createLinearGradient(shot.x, shot.y, shot.x + 70, shot.y - 25);
        g.addColorStop(0, `rgba(220, 235, 255, ${a.toFixed(3)})`);
        g.addColorStop(1, 'rgba(220, 235, 255, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(shot.x, shot.y);
        ctx.lineTo(shot.x + 70, shot.y - 25);
        ctx.stroke();
      }
    },
  };
}

function minecraft(w, h, k) {
  const cubes = Array.from({ length: Math.round(26 * k) }, () => ({
    x: rand(0, w), y: rand(0, h),
    s: Math.round(rand(6, 10)),
    v: rand(6, 14),
    sway: rand(0, TAU),
    c: pick(['92, 156, 58', '124, 88, 56']), // grass, dirt
    a: rand(0.12, 0.3),
  }));
  return {
    update(dt, w, h) {
      for (const c of cubes) {
        c.y -= c.v * dt;
        c.sway += dt * 0.6;
        if (c.y < -12) { c.y = h + 12; c.x = rand(0, w); }
      }
    },
    draw(ctx) {
      for (const c of cubes) {
        ctx.fillStyle = `rgba(${c.c}, ${c.a.toFixed(3)})`;
        // rounded coords keep the pixel edges hard
        ctx.fillRect(Math.round(c.x + Math.sin(c.sway) * 4), Math.round(c.y), c.s, c.s);
      }
    },
  };
}

const GLYPHS = '01<>/#$+';

function cyberpunk(w, h, k) {
  const n = Math.round(12 * k);
  const cols = Array.from({ length: n }, (_, i) => ({
    x: Math.round((i + rand(0.15, 0.85)) * (w / n)),
    y: rand(-h * 0.5, h),
    v: rand(18, 42),
    len: Math.round(rand(3, 6)),
    chars: [],
    c: pick(['252, 238, 10', '0, 240, 255']), // #fcee0a, #00f0ff
  }));
  const reroll = c => {
    c.chars = Array.from({ length: c.len }, () => pick(GLYPHS));
  };
  cols.forEach(reroll);
  let band = null;
  let next = rand(4, 9);
  return {
    update(dt, w, h) {
      for (const c of cols) {
        c.y += c.v * dt;
        if (Math.random() < dt * 1.2) c.chars[(Math.random() * c.len) | 0] = pick(GLYPHS);
        if (c.y - c.len * 14 > h) {
          c.y = rand(-h * 0.4, -20);
          c.v = rand(18, 42);
          reroll(c);
        }
      }
      band = null; // one frame only
      next -= dt;
      if (next <= 0) {
        band = { y: rand(0, h), hgt: rand(14, 50) };
        next = rand(4, 9);
      }
    },
    draw(ctx, w) {
      ctx.font = '12px monospace';
      for (const c of cols) {
        for (let i = 0; i < c.len; i++) {
          const a = 0.18 * (1 - i / c.len);
          ctx.fillStyle = `rgba(${c.c}, ${a.toFixed(3)})`;
          ctx.fillText(c.chars[i], c.x, c.y - i * 14);
        }
      }
      if (band) {
        ctx.fillStyle = 'rgba(0, 240, 255, 0.05)';
        ctx.fillRect(0, band.y, w, band.hgt);
      }
    },
  };
}

function gtav(w, h, k) {
  const motes = Array.from({ length: Math.round(38 * k) }, () => ({
    x: rand(0, w), y: rand(0, h),
    r: rand(0.8, 2),
    vx: rand(-4, 4), vy: rand(-3, 1.5),
    a: rand(0.06, 0.2),
    tw: rand(0, TAU),
  }));
  const streaks = Array.from({ length: Math.round(3 * k) }, () => ({
    x: rand(0, w),
    y: rand(h * 0.04, h * 0.32), // top third
    len: rand(120, 240),
    v: rand(4, 9) * pick([1, -1]),
    c: pick(['255, 122, 89', '255, 128, 160']), // sunset orange, pink
    a: rand(0.07, 0.12),
  }));
  return {
    update(dt, w, h) {
      for (const m of motes) {
        m.x += m.vx * dt; m.y += m.vy * dt; m.tw += dt * 0.7;
        wrap(m, w, h, 4);
      }
      for (const s of streaks) {
        s.x += s.v * dt;
        if (s.x > w + s.len) s.x = -s.len;
        else if (s.x < -s.len) s.x = w + s.len;
      }
    },
    draw(ctx) {
      for (const m of motes) {
        const a = m.a * (0.7 + 0.3 * Math.sin(m.tw));
        ctx.fillStyle = `rgba(255, 205, 150, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, TAU);
        ctx.fill();
      }
      for (const s of streaks) {
        const g = ctx.createLinearGradient(s.x, 0, s.x + s.len, 0);
        g.addColorStop(0, `rgba(${s.c}, 0)`);
        g.addColorStop(0.5, `rgba(${s.c}, ${s.a.toFixed(3)})`);
        g.addColorStop(1, `rgba(${s.c}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(s.x, s.y, s.len, 2);
      }
    },
  };
}

function assassins(w, h, k) {
  const motes = Array.from({ length: Math.round(44 * k) }, () => ({
    x: rand(0, w), y: rand(0, h),
    s: rand(1, 2.4),
    vx: rand(-9, -3), vy: rand(3, 9), // Animus bits drift down-left
    a: rand(0.07, 0.22),
  }));
  let streak = null;
  let next = rand(5, 9);
  return {
    update(dt, w, h) {
      for (const m of motes) {
        m.x += m.vx * dt; m.y += m.vy * dt;
        wrap(m, w, h, 4);
      }
      next -= dt;
      if (!streak && next <= 0) {
        streak = { x: rand(w * 0.3, w), y: rand(0, h * 0.5), life: 0 };
        next = rand(6, 10);
      }
      if (streak) {
        streak.x -= 90 * dt; streak.y += 55 * dt; streak.life += dt;
        if (streak.life > 1.8) streak = null;
      }
    },
    draw(ctx) {
      for (const m of motes) {
        ctx.fillStyle = `rgba(255, 255, 255, ${m.a.toFixed(3)})`;
        ctx.fillRect(m.x, m.y, m.s, m.s);
      }
      if (streak) {
        const a = 0.3 * Math.sin(Math.min(streak.life / 1.8, 1) * Math.PI);
        const g = ctx.createLinearGradient(streak.x, streak.y, streak.x + 46, streak.y - 28);
        g.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
        g.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(streak.x, streak.y);
        ctx.lineTo(streak.x + 46, streak.y - 28);
        ctx.stroke();
      }
    },
  };
}

function xboxgreen(w, h, k) {
  const orbs = Array.from({ length: Math.round(14 * k) }, () => ({
    x: rand(0, w), y: rand(0, h),
    r: rand(24, 70),
    vx: rand(-5, 5), vy: rand(-4, 4),
    a: rand(0.05, 0.13),
    tw: rand(0, TAU),
    c: pick(['124, 216, 90', '16, 124, 16', '160, 240, 120']),
  }));
  return {
    update(dt, w, h) {
      for (const o of orbs) {
        o.x += o.vx * dt; o.y += o.vy * dt; o.tw += dt * 0.5;
        wrap(o, w, h, o.r);
      }
    },
    draw(ctx) {
      for (const o of orbs) {
        const a = o.a * (0.75 + 0.25 * Math.sin(o.tw));
        const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
        g.addColorStop(0, `rgba(${o.c}, ${a.toFixed(3)})`);
        g.addColorStop(0.65, `rgba(${o.c}, ${(a * 0.35).toFixed(3)})`);
        g.addColorStop(1, `rgba(${o.c}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, TAU);
        ctx.fill();
      }
    },
  };
}

const SYSTEMS = { masseffect, minecraft, cyberpunk, gtav, assassins, xboxgreen };

/* ---------- public API ---------- */

export function initAmbient(canvas) {
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let theme = document.documentElement.dataset.theme;
  if (!SYSTEMS[theme]) theme = 'masseffect';
  let w = 0;
  let h = 0;
  let system = null;
  let raf = 0;
  let last = 0;

  function seed() {
    system = SYSTEMS[theme](w, h, motion.matches ? 0.5 : 1);
    if (motion.matches) {
      ctx.clearRect(0, 0, w, h);
      system.draw(ctx, w, h);
    }
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth;
    h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed(); // old positions no longer fit the new bounds
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) { last = now; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    ctx.clearRect(0, 0, w, h);
    system.update(dt, w, h);
    system.draw(ctx, w, h);
  }

  function start() {
    if (raf || motion.matches) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function onMotionChange() {
    stop();
    seed();
    start();
  }

  addEventListener('resize', resize);
  motion.addEventListener('change', onMotionChange);
  resize();
  start();

  return {
    pause: stop,   // e.g. while an opaque module view covers the canvas
    resume: start, // no-ops under prefers-reduced-motion
    setTheme(name) {
      theme = SYSTEMS[name] ? name : 'masseffect';
      seed();
    },
    destroy() {
      stop();
      removeEventListener('resize', resize);
      motion.removeEventListener('change', onMotionChange);
      ctx.clearRect(0, 0, w, h);
      system = null;
    },
  };
}
