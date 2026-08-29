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
const ACCESS_KEY = 'ptz.access';
const LOGIN_KEY = 'ptz.login';
const SEEDED_KEY = 'ptz.seeded';

// The church's three PTZ cameras, each behind its own tunnel hostname. They are
// wired in so nobody has to type them on a phone in a dark booth. Seeding runs
// once: a camera removed on purpose stays removed.
const CHURCH_CAMS = [
  { name: 'Camera 1', base: 'https://cam1.myfaithtech.com' },
  { name: 'Camera 2', base: 'https://cam2.myfaithtech.com' },
  { name: 'Camera 3', base: 'https://cam3.myfaithtech.com' },
];

const DIRS = [
  ['leftup', '↖'], ['up', '↑'], ['rightup', '↗'],
  ['left', '←'], ['home', '⌂'], ['right', '→'],
  ['leftdown', '↙'], ['down', '↓'], ['rightdown', '↘'],
];

function getCams() {
  let cams = load(CAMS_KEY, []);
  if (load(SEEDED_KEY, false)) return cams;
  const have = new Set(cams.map(c => c.base));
  const missing = CHURCH_CAMS.filter(c => !have.has(c.base))
    .map(c => ({ id: uid(), name: c.name, base: c.base, user: '', pass: '', viewOnly: false }));
  if (missing.length) { cams = [...cams, ...missing]; save(CAMS_KEY, cams); }
  save(SEEDED_KEY, true);
  return cams;
}

// The cameras share one login and sit behind one Access-guarded tunnel, so both
// are asked for once and kept here rather than repeated on every camera.
// Anything typed against a single camera still wins for that camera.
export const getAccess = () => load(ACCESS_KEY, null);
export const getLogin = () => load(LOGIN_KEY, null);

function accessFor(cam) {
  if (cam?.accessId) return { id: cam.accessId, secret: cam.accessSecret };
  const shared = getAccess();
  return shared?.id ? { id: shared.id, secret: shared.secret } : undefined;
}

// People paste what is in the address bar, which lands on a page — the camera's
// own web UI at /index.html — not at the root the CGI endpoint hangs off.
export function normalizeBase(raw) {
  const s = String(raw || '').trim();
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return s.replace(/\/+$/, '');
  }
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/[^/]*\.[a-z0-9]{2,5}$/i, '');
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

function authFor(cam) {
  if (cam?.user) return { user: cam.user, pass: cam.pass };
  const shared = getLogin();
  return shared?.user ? { user: shared.user, pass: shared.pass } : undefined;
}

// exported so the service planner can recall presets without duplicating this
export async function send(cam, cmd, args = {}) {
  const res = await fetch('/api/ptz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      base: cam.base, cmd, args,
      auth: authFor(cam),
      access: accessFor(cam),
    }),
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
    <button class="btn small" id="ptz-token">🔑 Sign-in</button>
    <button class="btn small" id="ptz-test">⇋ Test</button>`;

  root.innerHTML = `
    <style>
      #ptz-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
        max-width: 300px; margin: 0 auto; touch-action: none; }
      #ptz-pad button { aspect-ratio: 1; font-size: 26px; border-radius: 12px;
        border: 1px solid color-mix(in oklab, var(--ink-3) 34%, transparent);
        background: color-mix(in oklab, var(--surface-2) 75%, transparent); color: var(--ink); }
      #ptz-pad button:active { background: var(--accent); color: #04121b; }
      #ptz-view { position: relative; aspect-ratio: 16/9; border-radius: 10px; overflow: hidden;
        background: #05080d; border: 1px solid color-mix(in oklab, var(--ink-3) 30%, transparent);
        display: grid; place-items: center; }
      #ptz-img { width: 100%; height: 100%; object-fit: contain; display: none; }
      #ptz-img.on { display: block; }
      #ptz-view-msg { position: absolute; padding: 0 16px; text-align: center; font-size: 13px; }
      .ptz-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: center; }
      .ptz-preset { min-width: 44px; min-height: 44px; }
      .ptz-preset.arm { border-color: var(--accent); color: var(--accent); }
      .ptz-f { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
      .ptz-f input { display: block; width: 100%; margin-top: 3px; padding: 7px 9px;
        font-size: 15px; /* under 16px iOS zooms the page on focus */ }
    </style>
    <div style="display:grid;grid-template-columns:minmax(240px,320px) 1fr;gap:18px;align-items:start" id="ptz-grid">
      <div class="panel">
        <h3>Cameras</h3>
        <div id="ptz-list"></div>
        <details id="ptz-creds" style="margin-top:12px">
          <summary style="cursor:pointer;font-size:13px"><strong>Sign-in</strong> <span class="muted" id="ptz-creds-state"></span></summary>
          <p class="muted" style="font-size:12px;margin:8px 0 10px">
            Typed once and used for every camera. Stored in this dashboard only,
            behind your login.
          </p>
          <label class="ptz-f">Camera username<input id="pc-user" autocomplete="off" spellcheck="false"></label>
          <label class="ptz-f">Camera password<input id="pc-pass" type="password" autocomplete="off"></label>
          <label class="ptz-f">Access Client ID <span class="muted">(blank if Access is off)</span>
            <input id="pc-aid" autocomplete="off" spellcheck="false"></label>
          <label class="ptz-f">Access Client Secret<input id="pc-asec" type="password" autocomplete="off"></label>
          <button class="btn small" id="pc-save" style="margin-top:10px">Save for all cameras</button>
        </details>
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
        <div id="ptz-view">
          <img id="ptz-img" alt="Camera preview">
          <div id="ptz-view-msg" class="muted">No camera selected</div>
        </div>
        <div class="ptz-row" style="margin:10px 0 16px">
          <button class="btn small" id="ptz-live">▸ Live view</button>
          <span class="muted" id="ptz-fps"></span>
        </div>
        <div id="ptz-controls">
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
        <p class="muted" id="ptz-viewonly" hidden style="text-align:center;margin-top:14px">
          View only — this camera has no motor. An operator points it by hand.
        </p>
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
    renderAccess();
    const host = root.querySelector('#ptz-list');
    if (!cams.length) {
      host.innerHTML = '<p class="muted">No cameras yet. Add one with its address.</p>';
      nameEl.textContent = 'No camera';
      return;
    }
    host.innerHTML = cams.map(c => `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <button class="btn small" data-cam="${c.id}" style="flex:1;text-align:left;${c.id === current?.id ? 'border-color:var(--accent);' : ''}">
          ${esc(c.name)}${c.viewOnly ? ' <span class="muted">· view only</span>' : ''}<br><span class="muted" style="font-size:11.5px">${esc(c.base)}</span>
        </button>
        <button class="btn small danger" data-del="${c.id}" title="Remove">✕</button>
      </div>`).join('');
    host.querySelectorAll('[data-cam]').forEach(btn => btn.addEventListener('click', () => {
      current = cams.find(c => c.id === btn.dataset.cam);
      save('ptz.sel', current.id);
      renderList();
      // the preview must follow the selection, not keep showing the old camera
      if (live) { misses = 0; clearTimeout(timer); tick(); }
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
    applyCapability();
  }

  // the wireless ground camera has no motor: show its picture, not a dead pad
  function applyCapability() {
    const controls = root.querySelector('#ptz-controls');
    const note = root.querySelector('#ptz-viewonly');
    const viewOnly = !!current?.viewOnly;
    controls.hidden = viewOnly;
    note.hidden = !viewOnly;
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
    // the house controller stores 0-9, so 0 has to be reachable here too
    host.innerHTML = Array.from({ length: 10 }, (_, i) =>
      `<button class="btn small ptz-preset${saveMode ? ' arm' : ''}" data-preset="${i}">${i}</button>`).join('');
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
    const user = prompt('Username — leave blank to use the shared sign-in', '') || '';
    const pass = user ? (prompt('Password', '') || '') : '';
    const viewOnly = !confirm('Does this camera pan, tilt and zoom?\n\nOK = yes (PTZ)\nCancel = view only');
    // no login or Access prompt here by default: both are set once, for all cameras
    const cam = {
      id: uid(), name: name.trim(), base: normalizeBase(base),
      user: user.trim(), pass, viewOnly,
    };
    cams.push(cam);
    current = cam;
    save(CAMS_KEY, cams);
    save('ptz.sel', cam.id);
    renderList();
  });

  // One login and one token, for every camera. Secrets go back into the fields
  // so they can be corrected, but never into text the page renders — the status
  // line names what is set, not what it is.
  const credsBox = root.querySelector('#ptz-creds');
  function renderAccess() {
    const login = getLogin();
    const access = getAccess();
    const bits = [];
    bits.push(login?.user ? `signed in as ${esc(login.user)}` : 'no camera login yet');
    if (access?.id) bits.push('Access token set');
    const perCam = cams.filter(c => c.user || c.accessId).length;
    if (perCam) bits.push(`${perCam} camera${perCam > 1 ? 's' : ''} using their own`);
    root.querySelector('#ptz-creds-state').textContent = `· ${bits.join(' · ')}`;
    // nothing saved yet: open the form rather than hide it behind a twisty
    if (!login?.user) credsBox.open = true;
  }

  const fill = () => {
    const login = getLogin() || {};
    const access = getAccess() || {};
    root.querySelector('#pc-user').value = login.user || '';
    root.querySelector('#pc-pass').value = login.pass || '';
    root.querySelector('#pc-aid').value = access.id || '';
    root.querySelector('#pc-asec').value = access.secret || '';
  };

  root.querySelector('#pc-save').addEventListener('click', () => {
    const user = root.querySelector('#pc-user').value.trim();
    const pass = root.querySelector('#pc-pass').value;
    const id = root.querySelector('#pc-aid').value.trim();
    const secret = root.querySelector('#pc-asec').value.trim();
    save(LOGIN_KEY, user ? { user, pass } : null);
    save(ACCESS_KEY, id ? { id, secret } : null);
    // a camera carrying its own copy would shadow the shared one, so retire those
    let freed = 0;
    cams.forEach(c => {
      if (c.user || c.accessId) {
        c.user = ''; c.pass = '';
        delete c.accessId; delete c.accessSecret;
        freed += 1;
      }
    });
    if (freed) save(CAMS_KEY, cams);
    renderAccess();
    credsBox.open = false;
    showToast(user ? 'Saved for all cameras' : 'Sign-in cleared');
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

  /* ---------- live view ----------
     The cameras stream RTSP, which no browser plays, so the preview polls the
     camera's still image instead. It is about a frame a second — enough to aim
     and frame a shot, which is what remote control actually needs. */
  const img = root.querySelector('#ptz-img');
  const viewMsg = root.querySelector('#ptz-view-msg');
  const liveBtn = root.querySelector('#ptz-live');
  const fpsNote = root.querySelector('#ptz-fps');
  let live = false;
  let timer = 0;
  let objectUrl = '';
  let misses = 0;

  function showMsg(text) {
    viewMsg.textContent = text;
    viewMsg.style.display = text ? '' : 'none';
  }

  function stopLive(reason) {
    live = false;
    clearTimeout(timer);
    timer = 0;
    liveBtn.textContent = '▸ Live view';
    fpsNote.textContent = '';
    if (reason) showMsg(reason);
  }

  async function tick() {
    if (!live || !current) return;
    // a hidden tab should not keep asking the camera for frames
    if (document.hidden) { timer = setTimeout(tick, 1000); return; }
    try {
      const res = await fetch('/api/ptz/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base: current.base,
          path: current.snapPath,
          auth: authFor(current),
          access: accessFor(current),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `snapshot failed (${res.status})`);
      }
      // remember which path answered so later frames skip the search
      const found = res.headers.get('x-snapshot-path');
      if (found && found !== current.snapPath) {
        current.snapPath = found;
        save(CAMS_KEY, cams);
      }
      const blob = await res.blob();
      if (objectUrl) URL.revokeObjectURL(objectUrl); // or every frame leaks
      objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
      img.classList.add('on');
      showMsg('');
      misses = 0;
      fpsNote.textContent = `${(blob.size / 1024).toFixed(0)} KB · ~1 fps`;
    } catch (err) {
      misses += 1;
      if (misses >= 4) { stopLive(`${err.message} — stopped after 4 tries`); return; }
      showMsg(err.message);
    }
    if (live) timer = setTimeout(tick, misses ? 3000 : 1000);
  }

  function startLive() {
    if (!current) { showMsg('Add a camera first'); return; }
    live = true;
    misses = 0;
    liveBtn.textContent = '⏸ Pause';
    showMsg('Connecting…');
    tick();
  }

  liveBtn.addEventListener('click', () => (live ? stopLive('Paused') : startLive()));
  const onVisible = () => { if (live && !document.hidden) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVisible);

  tools.querySelector('#ptz-token').addEventListener('click', () => {
    credsBox.open = true;
    credsBox.scrollIntoView({ block: 'nearest' });
    root.querySelector('#pc-user').focus();
  });

  fill();
  renderList();
  renderPresets();
  if (current) showMsg('Press Live view to see the camera');

  return () => {
    // never leave a camera panning because the module was closed mid-press
    stoppers.forEach(stop => stop());
    stopLive();
    document.removeEventListener('visibilitychange', onVisible);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}
