// PTZ module — pan/tilt/zoom control for the church PTZOptics cameras.
//
// The cameras live on the church LAN, so the browser cannot reach them and
// never tries: every command goes to this dashboard's own Worker, which
// forwards it. Reaching that LAN from outside is the tunnel's job (see the
// setup note in the panel) — nothing here asks for a camera to be exposed to
// the internet.

import { load, save, uid, esc, showToast } from './store.js';

const SPEED_KEY = 'ptz.speed';
const CAMS_KEY = 'ptz.cams';

const DIRS = [
  ['leftup', '↖'], ['up', '↑'], ['rightup', '↗'],
  ['left', '←'], ['home', '⌂'], ['right', '→'],
  ['leftdown', '↙'], ['down', '↓'], ['rightdown', '↘'],
];

const getCams = () => load(CAMS_KEY, []);

async function send(cam, cmd, args = {}) {
  const res = await fetch('/api/ptz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base: cam.base, cmd, args, auth: cam.user ? { user: cam.user, pass: cam.pass } : undefined }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `camera said ${res.status}`);
  return body;
}

export function mount(root, tools) {
  let cams = getCams();
  let current = cams.find(c => c.id === load('ptz.sel', null)) || cams[0] || null;
  let speed = load(SPEED_KEY, 12);
  let saveMode = false;

  tools.innerHTML = `<button class="btn small" id="ptz-add">＋ Camera</button>
    <button class="btn small" id="ptz-test">⇋ Test</button>`;

  root.innerHTML = `
    <style>
      #ptz-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
        max-width: 300px; margin: 0 auto; touch-action: none; }
      #ptz-pad button { aspect-ratio: 1; font-size: 26px; border-radius: 12px;
        border: 1px solid color-mix(in oklab, var(--ink-3) 34%, transparent);
        background: color-mix(in oklab, var(--surface-2) 75%, transparent); color: var(--ink); }
      #ptz-pad button:active { background: var(--accent); color: #04121b; }
      .ptz-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: center; }
      .ptz-preset { min-width: 44px; min-height: 44px; }
      .ptz-preset.arm { border-color: var(--accent); color: var(--accent); }
    </style>
    <div style="display:grid;grid-template-columns:minmax(240px,320px) 1fr;gap:18px;align-items:start" id="ptz-grid">
      <div class="panel">
        <h3>Cameras</h3>
        <div id="ptz-list"></div>
        <p class="muted" style="margin-top:12px;font-size:12.5px">
          Cameras are only reachable from outside the building through a tunnel.
          Run <code>cloudflared</code> on a machine at the church and point the
          camera address here at that hostname — no router ports opened, and the
          tunnel sits behind your login.
        </p>
      </div>
      <div class="panel">
        <div class="ptz-row" style="justify-content:space-between;margin-bottom:14px">
          <strong id="ptz-name">No camera</strong>
          <span class="muted" id="ptz-status">&nbsp;</span>
        </div>
        <div id="ptz-pad"></div>
        <div class="ptz-row" style="margin-top:16px">
          <button class="btn" id="ptz-zin">＋ Zoom</button>
          <button class="btn" id="ptz-zout">－ Zoom</button>
        </div>
        <div class="ptz-row" style="margin-top:14px">
          <label class="muted" style="flex:1;max-width:260px">speed
            <input id="ptz-speed" type="range" min="1" max="24" value="${speed}" style="width:100%">
          </label>
        </div>
        <div style="margin-top:16px">
          <div class="ptz-row" style="justify-content:space-between">
            <strong style="font-size:14px">Presets</strong>
            <button class="btn small" id="ptz-savemode">Save to…</button>
          </div>
          <div class="ptz-row" id="ptz-presets" style="margin-top:10px"></div>
        </div>
      </div>
    </div>`;

  if (matchMedia('(max-width: 860px)').matches) {
    root.querySelector('#ptz-grid').style.gridTemplateColumns = '1fr';
  }

  const statusEl = root.querySelector('#ptz-status');
  const nameEl = root.querySelector('#ptz-name');

  const setStatus = (msg, bad) => {
    statusEl.textContent = msg;
    statusEl.style.color = bad ? '#ff8a92' : '';
  };

  async function run(cmd, args) {
    if (!current) { setStatus('add a camera first', true); return; }
    try {
      await send(current, cmd, args);
      setStatus(`${cmd} ok`);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function renderList() {
    const host = root.querySelector('#ptz-list');
    if (!cams.length) {
      host.innerHTML = '<p class="muted">No cameras yet. Add one with its address.</p>';
      nameEl.textContent = 'No camera';
      return;
    }
    host.innerHTML = cams.map(c => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <button class="btn small" data-cam="${c.id}" style="flex:1;text-align:left;${c.id === current?.id ? 'border-color:var(--accent);' : ''}">
          ${esc(c.name)}<br><span class="muted" style="font-size:11.5px">${esc(c.base)}</span>
        </button>
        <button class="btn small danger" data-del="${c.id}" title="Remove">✕</button>
      </div>`).join('');
    host.querySelectorAll('[data-cam]').forEach(btn => btn.addEventListener('click', () => {
      current = cams.find(c => c.id === btn.dataset.cam);
      save('ptz.sel', current.id);
      renderList();
    }));
    host.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const cam = cams.find(c => c.id === btn.dataset.del);
      if (!cam || !confirm(`Remove ${cam.name}?`)) return;
      cams = cams.filter(c => c.id !== cam.id);
      if (current?.id === cam.id) current = cams[0] || null;
      save(CAMS_KEY, cams);
      renderList();
    }));
    nameEl.textContent = current ? current.name : 'No camera';
  }

  // press and hold to move, release to stop — the camera keeps moving until
  // it is told to stop, so every press must have a matching stop
  function holdToMove(btn, startCmd, stopCmd, args) {
    let moving = false;
    const start = e => {
      e.preventDefault();
      if (startCmd === 'home') { run('home'); return; }
      moving = true;
      run(startCmd, args());
    };
    const stop = () => {
      if (!moving) return;
      moving = false;
      run(stopCmd);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
    return stop;
  }

  const stoppers = [];
  const pad = root.querySelector('#ptz-pad');
  pad.innerHTML = DIRS.map(([cmd, glyph]) =>
    `<button data-dir="${cmd}" aria-label="${cmd}">${glyph}</button>`).join('');
  pad.querySelectorAll('[data-dir]').forEach(btn => {
    const cmd = btn.dataset.dir;
    stoppers.push(holdToMove(btn, cmd, 'ptzstop', () => ({ pan: speed, tilt: Math.min(20, speed) })));
  });

  stoppers.push(holdToMove(root.querySelector('#ptz-zin'), 'zoomin', 'zoomstop', () => ({ zoom: Math.min(7, Math.round(speed / 4)) })));
  stoppers.push(holdToMove(root.querySelector('#ptz-zout'), 'zoomout', 'zoomstop', () => ({ zoom: Math.min(7, Math.round(speed / 4)) })));

  root.querySelector('#ptz-speed').addEventListener('input', e => {
    speed = Number(e.target.value);
    save(SPEED_KEY, speed);
  });

  const savemodeBtn = root.querySelector('#ptz-savemode');
  function renderPresets() {
    const host = root.querySelector('#ptz-presets');
    host.innerHTML = Array.from({ length: 9 }, (_, i) =>
      `<button class="btn small ptz-preset${saveMode ? ' arm' : ''}" data-preset="${i + 1}">${i + 1}</button>`).join('');
    host.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => {
      const n = Number(btn.dataset.preset);
      if (saveMode) {
        run('posset', { preset: n }).then(() => showToast(`Saved preset ${n}`));
        saveMode = false;
        savemodeBtn.textContent = 'Save to…';
        renderPresets();
      } else {
        run('poscall', { preset: n });
      }
    }));
  }
  savemodeBtn.addEventListener('click', () => {
    saveMode = !saveMode;
    savemodeBtn.textContent = saveMode ? 'Pick a slot…' : 'Save to…';
    renderPresets();
  });

  tools.querySelector('#ptz-add').addEventListener('click', () => {
    const name = prompt('Camera name?', 'Stage cam');
    if (!name) return;
    const base = prompt('Camera address (e.g. https://cam1.yourtunnel.example or http://192.168.1.40)');
    if (!base) return;
    const user = prompt('Username (blank if none)', 'admin') || '';
    const pass = user ? (prompt('Password', '') || '') : '';
    const cam = { id: uid(), name: name.trim(), base: base.trim().replace(/\/+$/, ''), user: user.trim(), pass };
    cams.push(cam);
    current = cam;
    save(CAMS_KEY, cams);
    save('ptz.sel', cam.id);
    renderList();
  });

  tools.querySelector('#ptz-test').addEventListener('click', async () => {
    if (!current) { setStatus('add a camera first', true); return; }
    setStatus('testing…');
    try {
      await send(current, 'ptzstop');
      setStatus('camera answered ✓');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  renderList();
  renderPresets();

  return () => {
    // never leave a camera panning because the module was closed mid-press
    stoppers.forEach(stop => stop());
  };
}
