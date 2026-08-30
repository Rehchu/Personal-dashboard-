// Dyer Town — the AI city, inside the dashboard. The town itself lives on the
// owner's Mac (agents think with his Claude subscription through the Agent SDK);
// the Mac pushes its state to the Worker and this module paints it: the map,
// who's where, what's been built, the live feed — and a chat that queues your
// message for an agent and shows their in-character answer when the town picks
// it up (a few seconds; the Mac polls between ticks).

import { load, save, esc, showToast } from './store.js';

const KIND_ICO = { house: '🏠', shop: '🏪', landmark: '🗼' };

// Building art, generated on Higgsfield. The Worker pulls each file server-side
// into R2 the first time a signed-in browser asks for it (this module posts the
// source URL; the Worker's allowlist vets it), then serves it from R2 forever.
const TOWN_ART_SRC = {
  house: 'https://d8j0ntlcm91z4.cloudfront.net/user_3IckDDDwJI3D408OKE8QdQYJgqc/hf_20260830_183122_ea85b24e-4253-47c4-ba5e-aebc8877285f.png',
  shop: 'https://d8j0ntlcm91z4.cloudfront.net/user_3IckDDDwJI3D408OKE8QdQYJgqc/hf_20260830_183122_caac7e17-d1ca-42d5-b360-f4e4ffab20bd.png',
  landmark: 'https://d8j0ntlcm91z4.cloudfront.net/user_3IckDDDwJI3D408OKE8QdQYJgqc/hf_20260830_183122_d78f1a17-0477-466c-a549-c501105b297a.png',
};

async function loadTownArt(kind) {
  const get = () => fetch(`/api/town/art/${kind}`);
  let res = await get();
  if (res.status === 404) {
    // first device ever to render the map — ask the Worker to import the art
    const imp = await fetch('/api/town/art', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, url: TOWN_ART_SRC[kind] }),
    });
    if (!imp.ok) return null;
    res = await get();
  }
  if (!res.ok) return null;
  const blob = await res.blob();
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode().catch(() => {});
  return img.naturalWidth ? img : null;
}

const AGENT_FACES = ['🧑‍🔧', '🧑‍💼', '🧑‍🍳', '🧑‍🎨', '🧑‍🚒', '🧑‍🌾', '🧑‍💻', '🧑‍🏫'];
const hashStr = s => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h; };

function injectStyle() {
  if (document.getElementById('town-style')) return;
  const style = document.createElement('style');
  style.id = 'town-style';
  style.textContent = `
    #town-grid { display:grid; grid-template-columns: 1.3fr 1fr; gap:16px; align-items:start; }
    @media (max-width: 860px){ #town-grid { grid-template-columns:1fr; } }
    #town-canvas { display:block; width:100%; border-radius:12px;
      background:#101a16; border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent); }
    .town-feed { max-height:300px; overflow:auto; }
    .town-ev { padding:6px 0; border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); font-size:13.5px; color:var(--ink-2); }
    .town-ev:first-child { border-top:0; }
    .town-ev b { color:var(--accent); }
    .town-ev .t { color:var(--ink-3); font-size:11px; margin-right:6px; }
    .town-agent { display:flex; align-items:baseline; gap:8px; padding:8px 0;
      border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); }
    .town-agent:first-child { border-top:0; }
    .town-agent .nm { font-weight:700; color:var(--ink); }
    .town-agent .rl { color:var(--ink-3); font-size:12.5px; }
    .town-agent .co { margin-left:auto; color:#e0b23a; font-size:13px; }
    .town-chatlog { margin-top:10px; max-height:180px; overflow:auto; display:flex; flex-direction:column; gap:6px; }
    .town-msg { padding:7px 11px; border-radius:10px; font-size:13.5px; max-width:85%; }
    .town-msg.me { align-self:flex-end; background:var(--surface-2); }
    .town-msg.them { align-self:flex-start; background:color-mix(in oklab,var(--accent) 15%,var(--surface-2)); }
    .town-chat-row { display:flex; gap:8px; margin-top:10px; }
    .town-chat-row select, .town-chat-row input { padding:8px 10px; font-size:15px; }
    .town-chat-row input { flex:1; min-width:0; }
    .town-off { text-align:center; padding:30px 16px; color:var(--ink-2); }
    .town-off .big { font-size:2.4rem; }`;
  document.head.append(style);
}

export function mount(root, tools) {
  injectStyle();
  let alive = true;
  let timer = 0;
  let agentsSig = '';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn small';
  refreshBtn.textContent = '⟳ Refresh';
  tools.append(refreshBtn);

  root.innerHTML = `
    <div id="town-grid">
      <div>
        <div class="panel"><h3>The town</h3><canvas id="town-canvas"></canvas></div>
        <div class="panel" style="margin-top:16px"><h3>Live feed</h3><div class="town-feed" id="town-feed"></div></div>
      </div>
      <div>
        <div class="panel"><h3>📋 Corporate inbox</h3><div id="town-approvals"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Townsfolk</h3><div id="town-agents"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Work reports</h3><div id="town-reports"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Talk to someone</h3>
          <div class="town-chat-row">
            <select id="town-who"></select>
            <input id="town-say" placeholder="Say something…" autocomplete="off" maxlength="500">
            <button class="btn small" id="town-send">Send</button>
          </div>
          <div class="town-chatlog" id="town-chatlog"></div>
        </div>
      </div>
    </div>
    <div id="town-offline" class="town-off" hidden></div>`;

  const grid = root.querySelector('#town-grid');
  const offline = root.querySelector('#town-offline');

  // ---- the living map ----
  // A little game world, Smallville-style: districts on a canvas, buildings in
  // them, and each agent as a sprite that actually WALKS — across town when the
  // engine moves them, and wandering about their district in between. State
  // arrives every 5s; everything between polls is animated locally.
  const canvas = root.querySelector('#town-canvas');
  const ctx = canvas.getContext('2d');
  const art = {};
  for (const kind of Object.keys(TOWN_ART_SRC)) loadTownArt(kind).then(img => { if (img) art[kind] = img; });

  const CELL_H = 200;
  let districts = {};      // loc key -> {x,y,w,h,label}
  let placedStructs = [];  // structures with computed x/y
  const sprites = new Map();
  const bubblesShown = new Set();
  let mapReady = false;
  let raf = 0;

  const randIn = d => ({
    x: d.x + 24 + Math.random() * (d.w - 48),
    y: d.y + 64 + Math.random() * (d.h - 92),
  });

  function syncWorld(s) {
    const keys = Object.keys(s.map || {});
    if (!keys.length) { mapReady = false; return; }
    const cols = keys.length > 4 ? 3 : 2;
    const rows = Math.ceil(keys.length / cols);
    const W = 900, H = rows * CELL_H;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    districts = {};
    keys.forEach((k, i) => {
      districts[k] = {
        x: (i % cols) * (W / cols) + 6, y: Math.floor(i / cols) * CELL_H + 6,
        w: W / cols - 12, h: CELL_H - 12, label: s.map[k],
      };
    });

    const perLoc = {};
    placedStructs = (s.structures || []).map(st => {
      const d = districts[st.loc] || districts[keys[0]];
      const i = (perLoc[st.loc] = (perLoc[st.loc] || 0) + 1) - 1;
      return { ...st, x: d.x + 46 + (i % 3) * 86, y: d.y + 52 + Math.floor(i / 3) * 12 };
    });

    const seen = new Set();
    for (const a of s.agents || []) {
      seen.add(a.id);
      let sp = sprites.get(a.id);
      const d = districts[a.loc] || districts[keys[0]];
      if (!sp) {
        const p = randIn(d);
        sp = { x: p.x, y: p.y, tx: p.x, ty: p.y, loc: a.loc, wanderAt: 0, bubble: null, bubbleUntil: 0 };
        sprites.set(a.id, sp);
      } else if (sp.loc !== a.loc) {
        sp.loc = a.loc;                    // walk across town to the new district
        const p = randIn(d);
        sp.tx = p.x; sp.ty = p.y;
      }
      sp.name = a.name;
      sp.face = AGENT_FACES[hashStr(a.id) % AGENT_FACES.length];
      sp.hue = hashStr(a.name || a.id) % 360;
    }
    for (const id of sprites.keys()) if (!seen.has(id)) sprites.delete(id);

    // fresh feed lines become speech bubbles over their agent
    const feed = s.feed || [];
    const maxTick = feed.reduce((m, e) => Math.max(m, Number(e.tick) || 0), 0);
    for (const e of feed) {
      if ((Number(e.tick) || 0) < maxTick - 1) continue;
      const key = `${e.tick}|${e.name}|${e.text}`;
      if (bubblesShown.has(key)) continue;
      bubblesShown.add(key);
      for (const sp of sprites.values()) {
        if (sp.name === e.name) {
          sp.bubble = String(e.text || '').slice(0, 52);
          sp.bubbleUntil = performance.now() + 6500;
        }
      }
    }
    if (bubblesShown.size > 400) bubblesShown.clear();
    mapReady = true;
  }

  let lastT = 0;
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!mapReady || grid.hidden) return;
    const dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;
    const now = performance.now();

    for (const sp of sprites.values()) {
      const dx = sp.tx - sp.x, dy = sp.ty - sp.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        const speed = 55;                                  // px/s — a stroll
        sp.x += (dx / dist) * speed * dt;
        sp.y += (dy / dist) * speed * dt;
        sp.moving = true;
      } else if (sp.moving || !sp.wanderAt) {
        sp.moving = false;
        sp.wanderAt = now + 1200 + Math.random() * 3500;   // linger, then wander
      } else if (now > sp.wanderAt) {
        const d = districts[sp.loc];
        if (d) { const p = randIn(d); sp.tx = p.x; sp.ty = p.y; }
        sp.wanderAt = now + 1200 + Math.random() * 3500;
      }
    }
    draw(now, t);
  }

  function draw(now, t) {
    const { width: W, height: H } = canvas;
    ctx.clearRect(0, 0, W, H);
    for (const d of Object.values(districts)) {
      ctx.fillStyle = '#16241d';
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.roundRect(d.x, d.y, d.w, d.h, 14);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font = '600 12px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(d.label.toUpperCase(), d.x + 14, d.y + 22);
    }
    for (const st of placedStructs) {
      const done = (Number(st.progress) || 0) >= 100;
      const img = done && art[st.kind];
      if (img) {
        ctx.drawImage(img, st.x - 34, st.y - 34, 68, 68);
      } else {
        ctx.font = '26px system-ui';
        ctx.textAlign = 'center';
        ctx.globalAlpha = done ? 1 : 0.55;
        ctx.fillText(done ? (KIND_ICO[st.kind] || '🏘️') : '🏗️', st.x, st.y + 8);
        ctx.globalAlpha = 1;
      }
      if (!done) {
        const p = Math.max(0, Math.min(100, Number(st.progress) || 0));
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(st.x - 26, st.y + 16, 52, 5);
        ctx.fillStyle = '#e0b23a';
        ctx.fillRect(st.x - 26, st.y + 16, 52 * p / 100, 5);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(st.name || '').slice(0, 16), st.x, st.y + 34);
    }
    const walkers = [...sprites.values()].sort((a, b) => a.y - b.y);
    for (const sp of walkers) {
      const bob = sp.moving ? Math.sin(t / 90) * 2.2 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y + 12, 9, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsl(${sp.hue} 45% 38%)`;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y + bob, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(sp.face, sp.x, sp.y + bob + 4);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 11px system-ui';
      ctx.fillText(sp.name || '', sp.x, sp.y + 28);
      if (sp.bubble && now < sp.bubbleUntil) {
        ctx.font = '11px system-ui';
        const tw = Math.min(220, ctx.measureText(sp.bubble).width + 16);
        const bx = Math.max(4, Math.min(canvas.width - tw - 4, sp.x - tw / 2));
        ctx.fillStyle = 'rgba(20,28,24,0.92)';
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.roundRect(bx, sp.y - 42, tw, 22, 8);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.textAlign = 'left';
        ctx.fillText(sp.bubble, bx + 8, sp.y - 27, tw - 16);
      }
    }
  }
  raf = requestAnimationFrame(frame);

  function paintOffline(updatedAt) {
    grid.hidden = true;
    offline.hidden = false;
    const when = updatedAt ? new Date(updatedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    offline.innerHTML = `
      <div class="big">🏙️</div>
      <p><strong>The town is asleep.</strong></p>
      <p class="muted">Dyer Town runs on your Mac — start it there (<code>npm start</code> in the
      agent-town folder, with DASH_URL and TOWN_KEY set) and it appears here live.</p>
      ${when ? `<p class="muted">Last seen ${esc(when)}.</p>` : ''}`;
  }

  function paint(d) {
    if (!d.online || !d.state) { paintOffline(d.updatedAt); return; }
    grid.hidden = false;
    offline.hidden = true;
    const s = d.state;

    syncWorld(s);

    root.querySelector('#town-agents').innerHTML = (s.agents || []).map(a => {
      const ev = a.eval && a.eval.note
        ? `<div style="flex-basis:100%;font-size:12.5px;color:#e0b23a;margin-top:2px">${'★'.repeat(Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))}${'☆'.repeat(5 - Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))} ${esc(a.eval.by)}: “${esc(a.eval.note)}”</div>`
        : '';
      return `<div class="town-agent" style="flex-wrap:wrap"><span class="nm">${esc(a.name)}</span>
        <span class="rl">${esc(a.role)} · ${esc(a.loc)}</span><span class="co">${Number(a.coins) || 0}c</span>${ev}</div>`;
    }).join('');

    root.querySelector('#town-feed').innerHTML = (s.feed || []).map(e => `
      <div class="town-ev"><span class="t">t${Number(e.tick) || 0}</span><b>${esc(e.name)}</b> ${esc(e.text)}</div>`).join('');

    // work reports: what each agent has actually done, at a glance
    root.querySelector('#town-reports').innerHTML = (s.agents || []).map(a => {
      const t = a.tally || {};
      const line = [
        t.buildsFinished ? `${t.buildsFinished} build${t.buildsFinished === 1 ? '' : 's'} finished` : '',
        t.shifts ? `${t.shifts} shift${t.shifts === 1 ? '' : 's'}` : '',
        t.jobsTaken ? `${t.jobsTaken} job${t.jobsTaken === 1 ? '' : 's'} taken` : '',
        t.hires ? `${t.hires} hire${t.hires === 1 ? '' : 's'}` : '',
        t.earned ? `+${t.earned}c earned` : '',
        t.spent ? `−${t.spent}c spent` : '',
      ].filter(Boolean).join(' · ') || 'no work on record yet';
      const recent = (a.worklog || []).slice(-3).map(w =>
        `<div class="town-ev"><span class="t">t${Number(w.tick) || 0}</span>${esc(w.text)}</div>`).join('');
      return `<div style="padding:8px 0;border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent)">
        <div style="font-weight:700;color:var(--ink)">${esc(a.name)} <span style="font-weight:400;font-size:12.5px;color:var(--ink-2)">${esc(line)}</span></div>
        ${recent}</div>`;
    }).join('');

    const sig = (s.agents || []).map(a => a.id).join(',');
    if (sig !== agentsSig) {
      agentsSig = sig;
      root.querySelector('#town-who').innerHTML = (s.agents || [])
        .map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    }
  }

  // the corporate inbox is its own fetch — approvals live in D1, not the pushed
  // state, so a verdict is possible even while the town server is asleep
  async function refreshApprovals() {
    let data;
    try {
      const res = await fetch('/api/town/approvals', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error();
      data = await res.json();
    } catch { return; }
    const host = root.querySelector('#town-approvals');
    if (!host) return;
    const rows = data.approvals || [];
    if (!rows.length) { host.innerHTML = '<p class="muted" style="margin:0">Nothing awaiting your signature.</p>'; return; }
    host.innerHTML = rows.map(ap => {
      const open = !ap.decision;
      const verdict = ap.decision === 'approve' ? '✅ approved' : ap.decision === 'deny' ? '⛔ denied' : '';
      return `<div style="padding:9px 0;border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent)">
        <div style="font-size:13.5px;color:var(--ink)"><b style="color:var(--accent)">${esc(ap.agent)}</b> asks: “${esc(ap.question)}”</div>
        ${open
          ? `<div style="display:flex;gap:8px;margin-top:7px">
              <button class="btn small" data-approve="${ap.id}">✅ Approve</button>
              <button class="btn small danger" data-deny="${ap.id}">⛔ Deny</button>
            </div>`
          : `<div class="muted" style="font-size:12.5px;margin-top:3px">${verdict}${ap.note ? ` · “${esc(ap.note)}”` : ''}</div>`}
      </div>`;
    }).join('');
    host.querySelectorAll('[data-approve],[data-deny]').forEach(btn => btn.addEventListener('click', async () => {
      const approve = 'approve' in btn.dataset;
      const id = Number(approve ? btn.dataset.approve : btn.dataset.deny);
      const note = prompt(approve ? 'Any note for the team? (optional)' : 'Why not? (optional)') || '';
      try {
        await fetch('/api/town/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, decision: approve ? 'approve' : 'deny', note }),
        });
        showToast(approve ? 'Approved — the team will hear back' : 'Denied — the team will hear back');
        refreshApprovals();
      } catch { showToast('Could not send that decision'); }
    }));
  }

  async function refresh() {
    try {
      const res = await fetch('/api/town/state', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      if (alive) paint(d);
    } catch {
      if (alive) paintOffline(null);
    }
  }

  // send a message, then poll for the agent's answer — the Mac replies between
  // ticks, so a few seconds of patience with a visible "…" bubble
  async function sendChat() {
    const agentId = root.querySelector('#town-who').value;
    const input = root.querySelector('#town-say');
    const message = input.value.trim();
    if (!agentId || !message) return;
    input.value = '';
    const log = root.querySelector('#town-chatlog');
    log.insertAdjacentHTML('beforeend', `<div class="town-msg me">${esc(message)}</div>`);
    const bubble = document.createElement('div');
    bubble.className = 'town-msg them';
    bubble.textContent = '…';
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await fetch('/api/town/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, message }),
      });
      const { id } = await res.json();
      if (!res.ok || !id) throw new Error();
      for (let i = 0; i < 20 && alive; i++) {           // up to ~60s of polling
        await new Promise(r => setTimeout(r, 3000));
        const poll = await fetch(`/api/town/chat/${id}`).then(r => r.json()).catch(() => null);
        if (poll?.reply) { bubble.textContent = poll.reply; log.scrollTop = log.scrollHeight; return; }
      }
      bubble.textContent = '(no answer yet — the town may be paused)';
    } catch {
      bubble.textContent = '(could not reach the town)';
      showToast('Could not send that message');
    }
  }

  refreshBtn.addEventListener('click', refresh);
  root.querySelector('#town-send').addEventListener('click', sendChat);
  root.querySelector('#town-say').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  refresh();
  refreshApprovals();
  timer = setInterval(() => { refresh(); refreshApprovals(); }, 5000);

  return function unmount() {
    alive = false;
    clearInterval(timer);
    cancelAnimationFrame(raf);
  };
}
