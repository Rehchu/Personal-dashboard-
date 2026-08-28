// Synthesized console UI sounds — Web Audio only, no files, no DOM.
// Two original voices: 'ps' (airy, glassy high blips) and 'xbox'
// (lower, rounder thumps). Everything no-ops until a user gesture
// unlocks the AudioContext, or if audio is unavailable at all.

import { load, save } from './store.js';

let ctx = null;
let master = null;
let muted = !!load('sfx.muted', false);
let mode = 'ps';
let armed = false;

// One voice = one oscillator through an exponential envelope.
// w: waveform, f: start Hz, f2: glide-to Hz, at: start offset (s),
// a: attack (s), d: duration (s), g: peak gain, lp: lowpass cutoff Hz.
const SETS = {
  ps: {
    move: [{ w: 'sine', f: 1320, f2: 1560, d: 0.055, g: 0.5 }],
    select: [
      { w: 'triangle', f: 880, d: 0.11, g: 0.5 },
      { w: 'sine', f: 1760, at: 0.02, d: 0.09, g: 0.3 },
    ],
    back: [{ w: 'sine', f: 1100, f2: 720, d: 0.09, g: 0.45 }],
    open: [
      { w: 'sine', f: 780, f2: 1560, d: 0.14, g: 0.45 },
      { w: 'triangle', f: 390, f2: 780, d: 0.14, g: 0.25 },
    ],
    switch: [{ w: 'triangle', f: 620, f2: 1240, d: 0.13, g: 0.45 }],
    trophy: [
      { w: 'sine', f: 1047, d: 0.18, g: 0.5 },
      { w: 'sine', f: 1319, at: 0.14, d: 0.26, g: 0.5 },
    ],
    boot: [
      { w: 'sine', f: 392, a: 0.28, d: 0.6, g: 0.4 },
      { w: 'sine', f: 587, a: 0.34, d: 0.6, g: 0.25 },
      { w: 'triangle', f: 196, a: 0.3, d: 0.6, g: 0.2, lp: 900 },
    ],
  },
  xbox: {
    move: [{ w: 'sine', f: 300, f2: 210, d: 0.05, g: 0.6, lp: 700 }],
    select: [
      { w: 'sine', f: 340, f2: 190, d: 0.11, g: 0.6, lp: 800 },
      { w: 'triangle', f: 760, d: 0.03, g: 0.15, lp: 1200 },
    ],
    back: [{ w: 'sine', f: 250, f2: 150, d: 0.09, g: 0.55, lp: 700 }],
    open: [
      { w: 'sine', f: 150, f2: 320, d: 0.15, g: 0.55, lp: 900 },
      { w: 'triangle', f: 75, f2: 160, d: 0.15, g: 0.3, lp: 500 },
    ],
    switch: [{ w: 'triangle', f: 200, f2: 420, d: 0.14, g: 0.5, lp: 1000 }],
    trophy: [
      { w: 'sine', f: 392, d: 0.18, g: 0.55, lp: 1400 },
      { w: 'sine', f: 523, at: 0.14, d: 0.26, g: 0.55, lp: 1400 },
    ],
    boot: [
      { w: 'sine', f: 110, a: 0.28, d: 0.6, g: 0.5, lp: 600 },
      { w: 'sine', f: 165, a: 0.34, d: 0.6, g: 0.3, lp: 600 },
      { w: 'triangle', f: 55, a: 0.3, d: 0.6, g: 0.25, lp: 300 },
    ],
  },
};

function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.15;
    master.connect(ctx.destination);
  } catch {
    ctx = null; // no audio here — sfx stays a silent no-op
  }
  return ctx;
}

function off() {
  removeEventListener('pointerdown', unlock);
  removeEventListener('keydown', unlock);
}

function unlock() {
  const c = ensureCtx();
  if (!c) {
    off();
    return;
  }
  c.resume().then(() => {
    if (c.state === 'running') off();
  }).catch(() => {});
}

function voice(t0, v) {
  const start = t0 + (v.at || 0);
  const end = start + v.d;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = v.w;
  osc.frequency.setValueAtTime(v.f, start);
  if (v.f2) osc.frequency.exponentialRampToValueAtTime(v.f2, end);
  // exponential in/out so nothing clicks
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(v.g, start + (v.a || 0.008));
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  let head = osc;
  if (v.lp) {
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass';
    lo.frequency.value = v.lp;
    osc.connect(lo);
    head = lo;
  }
  head.connect(env);
  env.connect(master);
  osc.start(start);
  osc.stop(end + 0.03);
  osc.onended = () => env.disconnect();
}

export const sfx = {
  init() {
    if (armed) return;
    armed = true;
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
  },
  play(name) {
    if (muted || !ctx || !master || ctx.state !== 'running') return;
    const set = SETS[mode][name];
    if (!set) return;
    try {
      const t0 = ctx.currentTime;
      for (const v of set) voice(t0, v);
    } catch { /* a failed blip is never worth an error */ }
  },
  setMuted(b) {
    muted = !!b;
    save('sfx.muted', muted);
  },
  isMuted() {
    return muted;
  },
  setConsole(m) {
    mode = m === 'xbox' ? 'xbox' : 'ps';
  },
};
