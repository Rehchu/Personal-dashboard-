// Dyer Town — the AI city, inside the dashboard. The town itself lives on the
// owner's Mac (agents think with his Claude subscription through the Agent SDK);
// the Mac pushes its state to the Worker and this module paints it: the map,
// who's where, what's been built, the live feed — and a chat that queues your
// message for an agent and shows their in-character answer when the town picks
// it up (a few seconds; the Mac polls between ticks).

import { load, save, esc, showToast } from './store.js';

const KIND_ICO = { house: '🏠', shop: '🏪', landmark: '🗼' };

// Pixel art, generated on Higgsfield in one farm-sim style pass: a building
// for every district business, the three structures agents can build, and a
// walking sprite per townsperson. The Worker pulls each file server-side into
// R2 the first time a signed-in browser asks for it (this module posts the
// source URL; the Worker's allowlist vets it), then serves it from R2 forever.
const HF = 'https://d8j0ntlcm91z4.cloudfront.net/user_3IckDDDwJI3D408OKE8QdQYJgqc/';
const TOWN_ART_SRC = {
  // agent-built structures
  house: `${HF}hf_20260831_013159_667a3d7f-6a3b-492e-a088-a981a010ea68.png`,
  shop: `${HF}hf_20260831_013159_2da96ad1-1d68-4870-bcaa-2e1a99fd80c6.png`,
  landmark: `${HF}hf_20260831_013158_5b30c53c-8df7-4742-a7ea-396c67a8dc91.png`,
  // the districts' businesses
  repairshop: `${HF}hf_20260831_013158_59eb17e2-6933-4648-9781-6ec14de54f78.png`,
  chapel: `${HF}hf_20260831_013159_2f94bb47-59ba-4b43-8203-ae01cc5aab0f.png`,
  gym: `${HF}hf_20260831_013158_ac9cab29-ee51-4a02-b699-62428c6b7cc1.png`,
  library: `${HF}hf_20260831_013159_462038e3-a9a3-45ac-ab06-1480ca77ff1d.png`,
  kitchen: `${HF}hf_20260831_013159_141466af-243d-4e88-8fe7-b17bcc1338cf.png`,
  plaza: `${HF}hf_20260831_013159_032b5a18-f94f-40bc-b493-af14758b0083.png`,
  // the townsfolk
  char_ctrl: `${HF}hf_20260831_013238_a909536b-cada-4a2f-89f5-bb2e68b0230b.png`,
  char_arise: `${HF}hf_20260831_013239_a1061fe4-347c-4a41-b7f0-810bd50e9575.png`,
  char_apex: `${HF}hf_20260831_013239_abf91edf-2bcb-4a70-9b62-7c03e148ca53.png`,
  char_draco: `${HF}hf_20260831_013239_8a9d6aa4-6a6b-4670-b994-19bb5a374f57.png`,
  char_spork: `${HF}hf_20260831_013239_bb6be375-b53c-4910-b17e-4f4f115ff3a0.png`,
  // one shared sprite for in-world hires (hue-shifted per person) and the owner
  char_hire: `${HF}hf_20260831_042858_d9ce3a7a-9a7b-4556-a6ed-9cb8765f2d0b.png`,
  char_boss: `${HF}hf_20260831_042858_a435ece7-0026-4234-b9fb-afb52907c232.png`,
  // front/back walk sheets per villager (side + a horizontal flip covers the rest)
  char_ctrl_front: `${HF}hf_20260831_045614_d2c6793a-84d2-40da-ac88-80a474878fc8.png`,
  char_ctrl_back: `${HF}hf_20260831_045828_13e00ae2-fb3e-490d-aa0a-e11c1cdb69cb.png`,
  char_arise_front: `${HF}hf_20260831_045828_b9f9ddce-7517-4a29-879e-bf6ef082760d.png`,
  char_arise_back: `${HF}hf_20260831_045614_900e1b6d-eeba-4311-a611-6b213af2d5a2.png`,
  char_apex_front: `${HF}hf_20260831_045614_e41bcdde-d69d-483e-acf4-1f8003463a58.png`,
  char_apex_back: `${HF}hf_20260831_045828_da021acf-6e32-4f3c-8849-e5e46c78b359.png`,
  char_draco_front: `${HF}hf_20260831_045614_8af1f17e-de88-4b30-b9b4-fa86b6e26a19.png`,
  char_draco_back: `${HF}hf_20260831_045614_4cb75ea5-6fc7-4127-96a6-3c0620030da7.png`,
  char_spork_front: `${HF}hf_20260831_045614_6b331bc8-9ebf-40e8-a5f5-c0a197f8ef2c.png`,
  char_spork_back: `${HF}hf_20260831_045614_ac91fafd-2d15-4bde-b1fe-738172348a51.png`,
  // the Studio district and its two: the metadata smith and the night watchman
  studio: `${HF}hf_20260831_091646_50182dd1-c2cd-4b49-85cc-c1c569d4b736.png`,
  char_meta: `${HF}hf_20260831_091550_28c0ccfb-7a5f-4abc-bed7-cc2c96047d37.png`,
  char_meta_front: `${HF}hf_20260831_091550_fe9b8097-419b-4f79-bc12-3d33594a8f28.png`,
  char_watch: `${HF}hf_20260831_091646_877caeb9-e0d3-4c9f-9e99-e071269a9705.png`,
  char_watch_front: `${HF}hf_20260831_091646_6e80b958-44f2-4743-9ad3-5a81177ed80c.png`,
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
  if (!img.naturalWidth) return null;
  const clean = stripAndCrop(img);
  URL.revokeObjectURL(img.src);
  return clean;
}

// The generator doesn't always honor "transparent background" — pieces can
// arrive on a white or checkerboard card. Flood-fill from the edges and erase
// only the light background CONNECTED to the border, so white highlights
// inside a sprite survive; then crop to the pixels that remain so every piece
// draws at its true size instead of floating in a big empty square.
function stripAndCrop(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  let d;
  try { d = x.getImageData(0, 0, c.width, c.height); } catch { return img; }
  const { data } = d;
  const w = c.width, h = c.height;
  const isBg = i => {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 40) return true;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx > 198 && mx - mn < 16;      // white and checkerboard greys alike
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let px = 0; px < w; px++) { stack.push(px, (h - 1) * w + px); }
  for (let py = 0; py < h; py++) { stack.push(py * w, py * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    if (!isBg(p * 4)) continue;
    data[p * 4 + 3] = 0;
    const px = p % w, py = (p / w) | 0;
    if (px > 0) stack.push(p - 1);
    if (px < w - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - w);
    if (py < h - 1) stack.push(p + w);
  }
  // tight bounding box of what's left
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let p = 0; p < w * h; p++) {
    if (data[p * 4 + 3] > 8) {
      const px = p % w, py = (p / w) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
  }
  if (x1 <= x0 || y1 <= y0) return img;   // stripped everything? keep the original
  x.putImageData(d, 0, 0);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
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
      background:#74b64e; border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent);
      image-rendering:pixelated; }
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
    .town-off .big { font-size:2.4rem; }
    #town-morale { display:inline-flex; align-items:center; gap:6px; margin-left:8px;
      font-weight:400; font-size:11px; color:var(--ink-3); vertical-align:middle; }
    #town-morale[hidden] { display:none; }
    #town-morale .bar { width:120px; height:8px; border-radius:5px; overflow:hidden;
      background:color-mix(in oklab,var(--ink-3) 24%,transparent);
      border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent); }
    #town-morale .fill { display:block; height:100%; border-radius:5px; }`;
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
        <div class="panel"><h3>The town <span id="town-wx" style="font-weight:400;font-size:12px;color:var(--ink-3)"></span><span id="town-morale" hidden><span class="lbl"></span><span class="bar"><span class="fill"></span></span></span></h3><canvas id="town-canvas"></canvas></div>
        <div class="panel" style="margin-top:16px"><h3>Live feed</h3><div class="town-feed" id="town-feed"></div></div>
      </div>
      <div>
        <div class="panel"><h3>📋 Corporate inbox</h3><div id="town-approvals"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Townsfolk</h3><div id="town-agents"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Work reports</h3><div id="town-reports"></div></div>
        <div class="panel" id="town-ships-panel" style="margin-top:16px" hidden><h3>🚀 Shipped by the town</h3><div id="town-ships"></div></div>
        <div class="panel" style="margin-top:16px"><h3>🏛️ Town charter</h3><div id="town-laws"></div></div>
        <div class="panel" id="town-notes-panel" style="margin-top:16px" hidden><h3>🗒️ Notes desk</h3><div id="town-notes"></div></div>
        <div class="panel" id="town-cal-panel" style="margin-top:16px" hidden><h3>📅 Community calendar</h3><div id="town-cal"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Talk to someone</h3>
          <div class="town-chat-row">
            <select id="town-who"></select>
            <input id="town-say" placeholder="Say something…" autocomplete="off" maxlength="500">
            <button class="btn small" id="town-send">Send</button>
            <button class="btn small" id="town-meet" title="📣 Call a town meeting — everyone gathers and answers">📣</button>
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

  const CELL_H = 210;
  let districts = {};      // loc key -> {x,y,w,h,label,key}
  let placedStructs = [];  // structures with computed x/y
  let decor = [];          // grass tufts and flowers, fixed per layout
  const sprites = new Map();
  const bubblesShown = new Set();
  let puffs = [];      // short-lived particles: chimney smoke, walking dust
  let lastSmoke = 0;
  let mapReady = false;
  let raf = 0;
  // going indoors: click a building and the owner walks to its door, then the
  // view steps inside. Rooms are decorated by the engine (state.interiors,
  // keyed by district key or 's'+structureId); old engines just get bare rooms.
  let interiors = {};      // building key -> {wall,floor,vibe,items,by,tick}
  let pendingEnter = null; // the building we're walking toward, until we arrive
  let inside = null;       // set = the view is IN that building, not on the map

  // the owner walks the town too — a purely client-side avatar (the engine
  // never hears about it); where you stood last is remembered per device
  const me = (() => {
    const p = load('town.me', null);
    const x = Number(p?.x), y = Number(p?.y);
    return { name: 'You', artKey: 'char_boss', face: '👑', hue: 42, isMe: true,
      x, y, tx: x, ty: y, moving: false };
  })();

  // bottom-center anchored, aspect preserved — art pieces are cropped to their
  // true pixels now, so each scales to fit its slot instead of a fixed square
  function drawSprite(img, cx, bottom, maxH, maxW = maxH) {
    const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k, h = img.height * k;
    ctx.drawImage(img, cx - w / 2, bottom - h, w, h);
  }

  // deterministic scatter — the same tuft grows in the same spot every frame
  function makeDecor() {
    decor = [];
    for (const [key, d] of Object.entries(districts)) {
      for (let i = 0; i < 9; i++) {
        const h = hashStr(`${key}:${i}`);
        decor.push({
          x: d.x + 12 + h % Math.max(1, d.w - 24),
          y: d.y + 34 + (h >> 7) % Math.max(1, d.h - 46),
          kind: i < 6 ? 'tuft' : 'flower',
          tint: ['#ffd94a', '#ff8bb3', '#fdfdf4'][h % 3],
        });
      }
    }
  }

  const randIn = d => ({
    x: d.x + 24 + Math.random() * (d.w - 48),
    y: d.y + 64 + Math.random() * (d.h - 92),
  });

  function syncWorld(s) {
    // room decor rides along with every state push — a viewer standing inside
    // sees redecoration live, and never gets kicked out by the 5s refresh
    interiors = s.interiors || {};
    const keys = Object.keys(s.map || {});
    if (!keys.length) { mapReady = false; return; }
    const cols = keys.length > 4 ? 3 : 2;
    const rows = Math.ceil(keys.length / cols);
    const W = 900, H = rows * CELL_H;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    districts = {};
    keys.forEach((k, i) => {
      districts[k] = {
        key: k,
        x: (i % cols) * (W / cols) + 6, y: Math.floor(i / cols) * CELL_H + 6,
        w: W / cols - 12, h: CELL_H - 12, label: s.map[k],
      };
    });
    makeDecor();

    // the owner spawns by the plaza fountain — first visit, or a saved spot
    // that no longer fits the map
    if (!Number.isFinite(me.x) || !Number.isFinite(me.y) || me.x < 0 || me.x > W || me.y < 0 || me.y > H) {
      me.x = W / 2 + 34; me.y = H / 2 + 22; me.tx = me.x; me.ty = me.y;
    }

    // agent-built structures line the bottom of their district's plot; the
    // district's own business building holds the top-center spot
    const perLoc = {};
    placedStructs = (s.structures || []).map(st => {
      const d = districts[st.loc] || districts[keys[0]];
      const i = (perLoc[st.loc] = (perLoc[st.loc] || 0) + 1) - 1;
      return { ...st, x: d.x + 40 + (i % 4) * 62, y: d.y + d.h - 44 - Math.floor(i / 4) * 18 };
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
      // in-world hires share one sprite, hue-shifted per person at draw time
      sp.isHire = String(a.id).startsWith('hire_');
      sp.artKey = sp.isHire ? 'char_hire'
        : `char_${a.id}` in TOWN_ART_SRC ? `char_${a.id}` : null;
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
      // friendship, visibly: a talker walks over to whoever they're talking to,
      // and a helping hand puts hearts over both heads
      const talk = /^to ([^:]{1,24}):/.exec(e.text || '');
      const help = /^lends (.{1,24}?) a hand/.exec(e.text || '');
      const otherName = (talk?.[1] || help?.[1] || '').trim();
      if (otherName) {
        const speaker = [...sprites.values()].find(s => s.name === e.name);
        const friend = [...sprites.values()].find(s => s.name === otherName);
        if (speaker && friend) {
          speaker.tx = friend.x + (speaker.x < friend.x ? -26 : 26);
          speaker.ty = friend.y + 4;
          speaker.wanderAt = performance.now() + 6000;   // stay with them a moment
          if (help) speaker.heartUntil = friend.heartUntil = performance.now() + 3200;
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
        if (Math.abs(dx) > 2) sp.dir = dx < 0 ? -1 : 1;    // face where you walk
        sp.axis = Math.abs(dy) > Math.abs(dx) * 1.2 ? (dy > 0 ? 'down' : 'up') : 'side';
      } else if (sp.moving || !sp.wanderAt) {
        sp.moving = false;
        sp.wanderAt = now + 1200 + Math.random() * 3500;   // linger, then wander
      } else if (now > sp.wanderAt) {
        const d = districts[sp.loc];
        if (d) { const p = randIn(d); sp.tx = p.x; sp.ty = p.y; }
        sp.wanderAt = now + 1200 + Math.random() * 3500;
      }
      // little dust kicks behind a walking villager
      if (sp.moving && now - (sp.lastDust || 0) > 170) {
        sp.lastDust = now;
        puffs.push({ kind: 'dust', x: sp.x - (sp.dir || 1) * 7 + (Math.random() * 6 - 3), y: sp.y + 10, born: now });
      }
    }
    // the owner strolls like everyone else, minus the wandering — walk where
    // clicked, then stand; the spot is saved once the walk ends
    if (Number.isFinite(me.x)) {
      const dx = me.tx - me.x, dy = me.ty - me.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        const speed = 55;
        me.x += (dx / dist) * speed * dt;
        me.y += (dy / dist) * speed * dt;
        me.moving = true;
        if (Math.abs(dx) > 2) me.dir = dx < 0 ? -1 : 1;
        if (now - (me.lastDust || 0) > 170) {
          me.lastDust = now;
          puffs.push({ kind: 'dust', x: me.x - (me.dir || 1) * 7 + (Math.random() * 6 - 3), y: me.y + 10, born: now });
        }
      } else if (me.moving) {
        me.moving = false;
        save('town.me', { x: Math.round(me.x), y: Math.round(me.y) });
      }
      // reached the door of the building we were headed for? step inside
      if (pendingEnter && !inside
        && Math.hypot(me.x - pendingEnter.door.x, me.y - pendingEnter.door.y) < 14) {
        inside = pendingEnter;
        pendingEnter = null;
      }
    }
    // the Test Kitchen's chimney smokes while the town is awake
    const kd = districts.kitchen;
    if (kd && now - lastSmoke > 750) {
      lastSmoke = now;
      puffs.push({ kind: 'smoke', x: kd.x + kd.w / 2 + 20 + (Math.random() * 6 - 3), y: kd.y + 22, born: now });
    }
    puffs = puffs.filter(p => now - p.born < (p.kind === 'smoke' ? 2400 : 550));
    if (inside) drawRoom(now, t); else draw(now, t);
  }

  // farm-sim daylight scene: grass field, dirt paths meeting at the plaza,
  // pixel buildings on their plots, and the townsfolk strolling in front
  function label(text, x, y, size = 11) {
    ctx.font = `700 ${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(253,253,244,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#33281a';
    ctx.fillText(text, x, y);
  }

  function draw(now, t) {
    const { width: W, height: H } = canvas;
    ctx.imageSmoothingEnabled = false;   // crisp chunky pixels when scaling
    ctx.fillStyle = '#74b64e';
    ctx.fillRect(0, 0, W, H);

    // plots — a slightly brighter green with a soft edge
    for (const d of Object.values(districts)) {
      ctx.fillStyle = '#7fbf58';
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.beginPath();
      ctx.roundRect(d.x, d.y, d.w, d.h, 12);
      ctx.fill(); ctx.stroke();
    }

    // dirt paths from every plot to the town center
    ctx.strokeStyle = '#d9b380';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    for (const d of Object.values(districts)) {
      ctx.beginPath();
      ctx.moveTo(d.x + d.w / 2, d.y + d.h / 2);
      ctx.lineTo(W / 2, H / 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#d9b380';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    // the plaza fountain: a pool with slow ripples
    ctx.fillStyle = '#5aa7c7';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 12, 0, Math.PI * 2);
    ctx.fill();
    for (let k = 0; k < 2; k++) {
      const r = 3 + ((t / 22 + k * 11) % 12);
      ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, 0.55 - r / 24)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // grass tufts and flowers
    for (const g of decor) {
      if (g.kind === 'tuft') {
        ctx.fillStyle = '#5da33c';
        ctx.fillRect(g.x, g.y, 3, 5);
        ctx.fillRect(g.x + 4, g.y + 2, 3, 4);
      } else {
        ctx.fillStyle = g.tint;
        ctx.fillRect(g.x, g.y, 4, 4);
        ctx.fillStyle = '#5da33c';
        ctx.fillRect(g.x + 1, g.y + 4, 2, 3);
      }
    }

    // each district's own business building, then its label
    for (const d of Object.values(districts)) {
      const img = art[d.key];
      const cx = d.x + d.w / 2;
      if (img) {
        drawSprite(img, cx, d.y + 112, 100, 128);
      } else {
        ctx.font = '40px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('🏛️', cx, d.y + 66);
      }
      label(d.label.toUpperCase(), cx, d.y + d.h - 10, 10);
    }

    // structures the agents put up (or are still putting up)
    for (const st of placedStructs) {
      const done = (Number(st.progress) || 0) >= 100;
      const img = done && art[st.kind];
      if (img) {
        drawSprite(img, st.x, st.y + 14, 56, 64);
      } else {
        ctx.font = '24px system-ui';
        ctx.textAlign = 'center';
        ctx.globalAlpha = done ? 1 : 0.6;
        ctx.fillText(done ? (KIND_ICO[st.kind] || '🏘️') : '🏗️', st.x, st.y + 4);
        ctx.globalAlpha = 1;
      }
      if (!done) {
        const p = Math.max(0, Math.min(100, Number(st.progress) || 0));
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(st.x - 24, st.y + 10, 48, 5);
        ctx.fillStyle = '#e8a33d';
        ctx.fillRect(st.x - 24, st.y + 10, 48 * p / 100, 5);
      }
      label(String(st.name || '').slice(0, 14), st.x, st.y + 26, 9);
    }

    // particles under the people: smoke drifts up, dust settles
    for (const p of puffs) {
      const age = (now - p.born) / (p.kind === 'smoke' ? 2400 : 550);
      if (p.kind === 'smoke') {
        ctx.fillStyle = `rgba(240,240,235,${0.5 * (1 - age)})`;
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(p.born + now / 400) * 3, p.y - age * 26, 2.5 + age * 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(190,155,105,${0.5 * (1 - age)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y + age * 3, 1.5 + age * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // townsfolk (and the owner), back-to-front so nearer ones overlap farther ones
    const walkers = [...sprites.values(), ...(Number.isFinite(me.x) ? [me] : [])].sort((a, b) => a.y - b.y);
    for (const sp of walkers) {
      // a real walk: step rhythm in the bounce, a waddle in the shoulders,
      // slow breathing when standing still
      const step = Math.sin(t / 85);
      const bob = sp.moving ? Math.abs(Math.cos(t / 85)) * 2.8 : Math.sin(t / 650 + sp.hue) * 0.8;
      const tilt = sp.moving ? step * 0.085 : Math.sin(t / 900 + sp.hue) * 0.015;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y + 12, sp.moving ? 9 + Math.abs(step) * 2 : 10, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // four-way walk: the front sheet coming toward you, the back sheet
      // going away, the side sheet (flipped for left) otherwise; idle faces
      // front. Directions without a sheet fall back to the side sprite.
      let img = sp.artKey && art[sp.artKey];
      let flip = sp.dir === -1;
      if (sp.artKey && !sp.isHire) {
        const axis = sp.moving ? sp.axis : 'down';
        if (axis === 'down' && art[`${sp.artKey}_front`]) { img = art[`${sp.artKey}_front`]; flip = false; }
        else if (axis === 'up' && art[`${sp.artKey}_back`]) { img = art[`${sp.artKey}_back`]; flip = false; }
      }
      if (img) {
        ctx.save();
        ctx.translate(sp.x, sp.y + 12);        // pivot at the feet
        ctx.rotate(tilt);
        if (flip) ctx.scale(-1, 1);            // side sprites face right natively
        // hires share one sprite — a per-person hue shift keeps them distinct
        // hue-rotate is silently ignored where 2D-canvas filters are missing
        // (older Safari); those browsers fall back to identical untinted hires
        if (sp.isHire && 'filter' in ctx) ctx.filter = `hue-rotate(${sp.hue}deg)`;
        drawSprite(img, 0, -bob, 46, 42);
        if (sp.isHire) ctx.filter = 'none';
        ctx.restore();
      } else {
        ctx.fillStyle = sp.isMe ? '#8a5bd6' : `hsl(${sp.hue} 45% 38%)`;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y + bob, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(sp.face, sp.x, sp.y + bob + 4);
      }
      label(sp.name || '', sp.x, sp.y + 28);
      if (sp.heartUntil && now < sp.heartUntil) {
        const rise = (1 - (sp.heartUntil - now) / 3200) * 10;
        ctx.font = '12px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('💛', sp.x + 13, sp.y - 34 - rise);
      }
      if (sp.bubble && now < sp.bubbleUntil) {
        ctx.font = '11px system-ui';
        const tw = Math.min(220, ctx.measureText(sp.bubble).width + 16);
        const bx = Math.max(4, Math.min(canvas.width - tw - 4, sp.x - tw / 2));
        ctx.fillStyle = 'rgba(253,253,244,0.95)';
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.roundRect(bx, sp.y - 44, tw, 22, 8);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#33281a';
        ctx.textAlign = 'left';
        ctx.fillText(sp.bubble, bx + 8, sp.y - 29, tw - 16);
      }
    }
  }

  // ---- inside a building ----
  // same chunky-pixel language as the map: a wall band up top, a checkered
  // floor below, the engine's furniture on a 12×8 grid, and whoever's home
  const leaveChip = () => ({ x: 10, y: 10, w: 84, h: 26 });
  function roomDoorRect() {
    const { width: W, height: H } = canvas;
    return { x: W / 2 - 26, y: H - 66, w: 52, h: 60 };
  }

  // one small fillRect sketch per palette kind — 4-10 rects reads perfectly at
  // this scale. item.c tints where a tint makes sense; wall pieces (poster,
  // banner, window) ignore their y and hang on the wall band instead.
  function drawItem(item, gx, gy, now) {
    // an invalid color string is a silent no-op on fillStyle (the PREVIOUS
    // color would leak through) — accept only real hex, else use each default
    const c = (typeof item.c === 'string' && /^#[0-9a-f]{3,8}$/i.test(item.c)) ? item.c : '';
    switch (item.kind) {
      case 'rug':
        ctx.fillStyle = c || '#c96a5a'; ctx.fillRect(gx - 34, gy - 16, 68, 32);
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(gx - 26, gy - 10, 52, 20);
        ctx.fillStyle = c || '#c96a5a'; ctx.fillRect(gx - 18, gy - 6, 36, 12);
        break;
      case 'table':
        ctx.fillStyle = '#6b4a2f'; ctx.fillRect(gx - 24, gy - 4, 5, 16); ctx.fillRect(gx + 19, gy - 4, 5, 16);
        ctx.fillStyle = c || '#8a6540'; ctx.fillRect(gx - 28, gy - 12, 56, 10);
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(gx - 28, gy - 12, 56, 3);
        break;
      case 'chair':
        ctx.fillStyle = c || '#8a6540';
        ctx.fillRect(gx - 8, gy - 24, 5, 22);                                  // backrest
        ctx.fillRect(gx - 8, gy - 6, 18, 6);                                   // seat
        ctx.fillStyle = '#5d3f28';
        ctx.fillRect(gx - 8, gy, 4, 10); ctx.fillRect(gx + 6, gy, 4, 10);      // legs
        break;
      case 'bed':
        ctx.fillStyle = '#6b4a2f'; ctx.fillRect(gx - 30, gy - 14, 60, 30);     // frame
        ctx.fillStyle = '#f2ead8'; ctx.fillRect(gx - 27, gy - 11, 54, 22);     // mattress
        ctx.fillStyle = c || '#5a7fc9'; ctx.fillRect(gx - 27, gy - 2, 54, 13); // blanket
        ctx.fillStyle = '#fdfdf4'; ctx.fillRect(gx - 24, gy - 9, 14, 7);       // pillow
        break;
      case 'bookshelf':
        ctx.fillStyle = '#6b4a2f'; ctx.fillRect(gx - 18, gy - 42, 36, 48);
        ctx.fillStyle = '#4c3520'; ctx.fillRect(gx - 15, gy - 38, 30, 12); ctx.fillRect(gx - 15, gy - 22, 30, 12);
        ctx.fillStyle = c || '#c96a5a'; ctx.fillRect(gx - 13, gy - 36, 6, 10); ctx.fillRect(gx - 1, gy - 20, 6, 10);
        ctx.fillStyle = '#5a8f5a'; ctx.fillRect(gx - 5, gy - 36, 6, 10);
        ctx.fillStyle = '#5a7fc9'; ctx.fillRect(gx + 3, gy - 36, 6, 10); ctx.fillRect(gx - 11, gy - 20, 6, 10);
        break;
      case 'plant':
        ctx.fillStyle = c || '#b3562e'; ctx.fillRect(gx - 7, gy - 6, 14, 10);  // pot
        ctx.fillStyle = '#3f7d33'; ctx.fillRect(gx - 2, gy - 18, 4, 12);       // stem
        ctx.fillStyle = '#57a344';
        ctx.fillRect(gx - 10, gy - 26, 9, 9); ctx.fillRect(gx + 2, gy - 24, 9, 9); ctx.fillRect(gx - 4, gy - 31, 9, 9);
        break;
      case 'lamp': {
        const g = ctx.createRadialGradient(gx, gy - 26, 4, gx, gy - 26, 40);   // soft glow
        g.addColorStop(0, 'rgba(255,236,160,0.45)');
        g.addColorStop(1, 'rgba(255,236,160,0)');
        ctx.fillStyle = g; ctx.fillRect(gx - 40, gy - 66, 80, 80);
        ctx.fillStyle = '#5d5d5d'; ctx.fillRect(gx - 7, gy + 2, 14, 4); ctx.fillRect(gx - 2, gy - 22, 4, 24);
        ctx.fillStyle = c || '#e8c86a'; ctx.fillRect(gx - 10, gy - 32, 20, 12);
        break;
      }
      case 'poster':
        ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(gx - 20, gy - 14, 44, 32);
        ctx.fillStyle = c || '#fdfdf4'; ctx.fillRect(gx - 22, gy - 16, 44, 32);
        ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(gx - 22, gy - 16, 44, 3);
        if (item.text) label(String(item.text).slice(0, 12), gx, gy + 4, 9);
        break;
      case 'counter':
        ctx.fillStyle = '#5d3f28'; ctx.fillRect(gx - 32, gy - 6, 64, 18);      // front
        ctx.fillStyle = c || '#9a774c'; ctx.fillRect(gx - 34, gy - 12, 68, 8); // top
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(gx - 34, gy - 12, 68, 2);
        break;
      case 'tv':
        ctx.fillStyle = '#2b2b2b'; ctx.fillRect(gx - 20, gy - 26, 40, 26);
        ctx.fillStyle = c || '#3f6f8f'; ctx.fillRect(gx - 17, gy - 23, 34, 20);
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(gx - 15, gy - 21, 8, 6);
        ctx.fillStyle = '#2b2b2b'; ctx.fillRect(gx - 4, gy, 8, 4); ctx.fillRect(gx - 10, gy + 4, 20, 3);
        break;
      case 'fireplace': {
        ctx.fillStyle = c || '#8d8d8d'; ctx.fillRect(gx - 24, gy - 30, 48, 40);
        ctx.fillStyle = '#4c4c4c'; ctx.fillRect(gx - 26, gy - 34, 52, 6);      // mantel
        ctx.fillStyle = '#241b14'; ctx.fillRect(gx - 14, gy - 18, 28, 24);     // firebox
        const f = Math.abs(Math.sin(now / 130 + gx)) * 6;                      // flicker
        ctx.fillStyle = '#e8642e'; ctx.fillRect(gx - 8, gy - 4 - f, 16, 8 + f);
        ctx.fillStyle = '#f2b13a'; ctx.fillRect(gx - 4, gy - 1 - f * 0.6, 8, 5 + f * 0.6);
        break;
      }
      case 'crate':
        ctx.fillStyle = c || '#9a774c'; ctx.fillRect(gx - 13, gy - 20, 26, 26);
        ctx.fillStyle = '#6b4a2f';
        ctx.fillRect(gx - 13, gy - 20, 26, 3); ctx.fillRect(gx - 13, gy + 3, 26, 3);
        ctx.fillRect(gx - 13, gy - 20, 3, 26); ctx.fillRect(gx + 10, gy - 20, 3, 26);
        ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(gx - 10, gy - 9, 20, 3);
        break;
      case 'banner':
        ctx.fillStyle = '#6b4a2f'; ctx.fillRect(gx - 26, gy - 20, 52, 4);      // rod
        ctx.fillStyle = c || '#b0483f'; ctx.fillRect(gx - 22, gy - 16, 44, 26);
        ctx.fillRect(gx - 22, gy + 10, 14, 6); ctx.fillRect(gx + 8, gy + 10, 14, 6);
        if (item.text) label(String(item.text).slice(0, 10), gx, gy, 9);
        break;
      case 'trophy':
        ctx.fillStyle = '#e0b23a';
        ctx.fillRect(gx - 8, gy - 22, 16, 12);                                 // cup
        ctx.fillRect(gx - 12, gy - 20, 4, 6); ctx.fillRect(gx + 8, gy - 20, 4, 6);
        ctx.fillRect(gx - 2, gy - 10, 4, 6);                                   // stem
        ctx.fillStyle = '#8a6540'; ctx.fillRect(gx - 8, gy - 4, 16, 5);        // base
        ctx.fillStyle = `rgba(255,255,255,${0.45 + Math.sin(now / 260) * 0.35})`;
        ctx.fillRect(gx - 5, gy - 20, 3, 5);                                   // gleam
        break;
      case 'window':
        ctx.fillStyle = '#fdfdf4'; ctx.fillRect(gx - 18, gy - 20, 36, 40);
        ctx.fillStyle = '#8fd0e8'; ctx.fillRect(gx - 15, gy - 17, 30, 34);     // sky
        ctx.fillStyle = '#fdfdf4'; ctx.fillRect(gx - 2, gy - 17, 4, 34); ctx.fillRect(gx - 15, gy - 2, 30, 4);
        break;
      case 'kettle':
        ctx.fillStyle = c || '#6f7f8a';
        ctx.fillRect(gx - 8, gy - 10, 16, 12);                                 // body
        ctx.fillRect(gx - 13, gy - 8, 5, 4);                                   // spout
        ctx.fillRect(gx - 3, gy - 14, 6, 4);                                   // lid
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(gx - 4, gy - 18, 8, 3);
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(gx - 6, gy - 8, 3, 6);
        break;
    }
  }

  // a villager standing indoors: their front-facing sheet when it's loaded,
  // their base sprite otherwise, the tinted circle as the last resort
  function drawOccupant(sp, ox, oy, t) {
    const bob = Math.sin(t / 650 + (sp.hue || 0)) * 1.2;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(ox, oy + 12, 10, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    const img = sp.artKey && (art[`${sp.artKey}_front`] || art[sp.artKey]);
    if (img) {
      if (sp.isHire && 'filter' in ctx) ctx.filter = `hue-rotate(${sp.hue}deg)`;
      drawSprite(img, ox, oy + 12 - bob, 46, 42);
      if (sp.isHire) ctx.filter = 'none';
    } else {
      ctx.fillStyle = sp.isMe ? '#8a5bd6' : `hsl(${sp.hue} 45% 38%)`;
      ctx.beginPath();
      ctx.arc(ox, oy + bob, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(sp.face || '🙂', ox, oy + bob + 4);
    }
    label(sp.name || '', ox, oy + 28);
  }

  function drawRoom(now, t) {
    const { width: W, height: H } = canvas;
    ctx.imageSmoothingEnabled = false;   // same crisp pixels indoors
    const it = interiors[inside.key];
    const wall = it?.wall || '#b9a68d';
    const floor = it?.floor || '#96826a';
    const wallH = Math.max(64, Math.floor(H / 3));

    // wall band with a darker baseboard, then the checkered floor
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, wallH);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, wallH - 7, W, 7);
    ctx.fillStyle = floor;
    ctx.fillRect(0, wallH, W, H - wallH);
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    const tile = 30;
    for (let cy = wallH; cy < H; cy += tile) {
      for (let cx = ((cy - wallH) / tile) % 2 ? tile : 0; cx < W; cx += tile * 2) {
        ctx.fillRect(cx, cy, tile, Math.min(tile, H - cy));
      }
    }

    // the way out, bottom-center — clicking it (or the chip, or Escape) leaves
    const dr = roomDoorRect();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(dr.x - 5, dr.y - 5, dr.w + 10, dr.h + 5);
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(dr.x, dr.y, dr.w, dr.h);
    ctx.fillStyle = '#8a6540';
    ctx.fillRect(dr.x + 4, dr.y + 4, dr.w - 8, dr.h - 4);
    ctx.fillStyle = '#e8d9a0';
    ctx.fillRect(dr.x + dr.w - 12, dr.y + dr.h / 2 - 2, 4, 4);

    // the vibe the decorator set — or the nudge that nobody has yet
    const caption = it?.vibe ? String(it.vibe).slice(0, 64) : (it ? '' : 'Nobody’s decorated this place yet.');
    if (caption) label(caption, W / 2, 22, 11);

    // the plaque: whose place this is
    const pw = 240;
    ctx.fillStyle = '#7a5a38';
    ctx.fillRect(W / 2 - pw / 2, wallH - 48, pw, 34);
    ctx.fillStyle = '#9a774c';
    ctx.fillRect(W / 2 - pw / 2 + 3, wallH - 45, pw - 6, 28);
    label(String(inside.name || '').slice(0, 26), W / 2, wallH - 33, 12);
    // a structure's owner field is an agent ID — show their current name
    const ownerSp = inside.type === 'struct' ? sprites.get(inside.owner) : null;
    const ownerName = inside.type === 'struct' ? (ownerSp?.name || '') : String(inside.owner || '');
    if (ownerName) label(ownerName.slice(0, 26), W / 2, wallH - 20, 9);

    // furniture on the 12×8 grid mapped over the floor (rugs first, so
    // everything else sits on top); wall pieces hang on the band up top
    const fx = 40, fw = W - 80;
    const fy = wallH + 12, fh = Math.max(40, H - wallH - 84);
    const onWall = k => k === 'poster' || k === 'banner' || k === 'window';
    const items = (Array.isArray(it?.items) ? it.items.filter(o => o && typeof o === 'object') : []).slice()
      .sort((a, b) => (a.kind === 'rug' ? 0 : 1) - (b.kind === 'rug' ? 0 : 1));
    for (const item of items) {
      const gx = fx + (Math.max(0, Math.min(11, Number(item.x) || 0)) + 0.5) * (fw / 12);
      const gy = onWall(item.kind)
        ? wallH * 0.5
        : fy + (Math.max(0, Math.min(7, Number(item.y) || 0)) + 0.5) * (fh / 8);
      drawItem(item, gx, gy, now);
    }

    // who's home: everyone whose loc is this district (a structure gets just
    // its owner, if they're around) — and you, by the door you came in through
    const occ = inside.type === 'struct'
      ? (ownerSp && ownerSp.loc === inside.loc ? [ownerSp] : [])
      : [...sprites.values()].filter(sp => sp.loc === inside.key);
    occ.forEach((sp, i) => {
      const ox = fx + ((i + 1) / (occ.length + 1)) * fw;
      const oy = fy + fh * (0.45 + (i % 2) * 0.22);
      drawOccupant(sp, ox, oy, t);
    });
    drawOccupant(me, dr.x - 36, dr.y + 24, t);

    // the way back to town, drawn last so nothing covers it
    const chip = leaveChip();
    ctx.fillStyle = 'rgba(253,253,244,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.roundRect(chip.x, chip.y, chip.w, chip.h, 8);
    ctx.fill(); ctx.stroke();
    label('⬅ leave', chip.x + chip.w / 2, chip.y + 17, 11);
  }
  raf = requestAnimationFrame(frame);

  // click (or tap) to walk the owner there — the canvas is CSS-scaled, so map
  // pointer coords back into its internal pixels first. Clicking close to a
  // villager means "go talk to them": walk over AND aim the chat box at them.
  // Clicking a building means "go in": walk to its door, then step inside.
  canvas.addEventListener('click', e => {
    if (!mapReady) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    // indoors, the only clickables are the ways out: the chip and the door
    if (inside) {
      const chip = leaveChip();
      const dr = roomDoorRect();
      if ((x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h)
        || (x >= dr.x - 8 && x <= dr.x + dr.w + 8 && y >= dr.y - 8)) {
        inside = null;                     // back to town, right where we stood
      }
      return;
    }
    let nearId = null, nearSp = null, nearD = 30;
    for (const [id, sp] of sprites) {
      if (Math.abs(sp.x - x) > 21 || y < sp.y - 40 || y > sp.y + 16) continue; // drawn body only
      const d = Math.hypot(sp.x - x, (sp.y - 14) - y); // distance to the torso
      if (d < nearD) { nearD = d; nearId = id; nearSp = sp; }
    }
    if (nearSp) {
      pendingEnter = null;
      me.tx = nearSp.x + (me.x < nearSp.x ? -22 : 22);
      me.ty = nearSp.y + 4;
      const who = root.querySelector('#town-who');
      if ([...who.options].some(o => o.value === nearId)) who.value = nearId;
      root.querySelector('#town-say').focus();
      return;
    }
    // a business building (or a FINISHED structure — scaffolding keeps you
    // out) near the click? walk to a door point just below it, enter on arrival
    let hit = null, hitD = Infinity;
    for (const d of Object.values(districts)) {
      const bx = d.x + d.w / 2, by = d.y + 70;
      const dd = Math.hypot(x - bx, y - by);
      if (dd < 52 && dd < hitD) {
        hitD = dd;
        hit = { type: 'district', key: d.key, name: d.label, owner: 'Dyer Town',
          loc: d.key, door: { x: bx, y: d.y + 124 } };
      }
    }
    for (const st of placedStructs) {
      if ((Number(st.progress) || 0) < 100) continue;
      const dd = Math.hypot(x - st.x, y - st.y);
      if (dd < 30 && dd < hitD) {
        hitD = dd;
        hit = { type: 'struct', key: st.id != null ? `s${st.id}` : `s:${st.loc}:${st.name || ''}`,
          name: st.name || st.kind,
          owner: st.owner || '', loc: st.loc, door: { x: st.x, y: st.y + 30 } };  // owner is the agent ID
      }
    }
    if (hit) {
      pendingEnter = hit;
      me.tx = hit.door.x; me.ty = hit.door.y;
      return;
    }
    pendingEnter = null;
    me.tx = x; me.ty = y;
  });

  // Escape steps back outside too
  const onKeydown = e => {
    if (e.key === 'Escape' && inside) { inside = null; pendingEnter = null; }
  };
  window.addEventListener('keydown', onKeydown);

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

    root.querySelector('#town-wx').textContent = s.weather ? `· ${s.weather}` : '';

    // town morale, when the engine reports it (older engines don't — no meter then)
    const moraleEl = root.querySelector('#town-morale');
    const morale = s.morale == null ? NaN : Number(s.morale);
    if (Number.isFinite(morale)) {
      const m = Math.max(0, Math.min(100, morale));
      moraleEl.hidden = false;
      moraleEl.querySelector('.lbl').textContent = `morale ${Math.round(m)}`;
      const fill = moraleEl.querySelector('.fill');
      fill.style.width = `${m}%`;
      fill.style.background = m >= 65 ? '#57b86a' : m >= 35 ? '#e0b23a' : '#ff8a92';
    } else {
      moraleEl.hidden = true;
    }

    root.querySelector('#town-agents').innerHTML = (s.agents || []).map(a => {
      const ev = a.eval && a.eval.note
        ? `<div style="flex-basis:100%;font-size:12.5px;color:#e0b23a;margin-top:2px">${'★'.repeat(Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))}${'☆'.repeat(5 - Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))} ${esc(a.eval.by)}: “${esc(a.eval.note)}”</div>`
        : '';
      const mo = a.morale && Number.isFinite(Number(a.morale.score))
        ? `<span title="${esc(a.morale.why || '')}" style="font-size:12px;cursor:help;color:${a.morale.score < 35 ? '#ff8a92' : a.morale.score < 65 ? '#e0b23a' : 'var(--ink-2)'}">${a.morale.score < 35 ? '😟' : a.morale.score < 65 ? '😐' : '😊'}${Number(a.morale.score)}</span>`
        : '';
      const en = Number.isFinite(Number(a.energy))
        ? `<span title="energy" style="font-size:12px;color:${a.energy < 35 ? '#ff8a92' : 'var(--ink-2)'}">⚡${Number(a.energy)}</span>`
        : '';
      const dy = a.diary?.length
        ? `<div style="flex-basis:100%;font-size:12px;color:var(--ink-3);font-style:italic;margin-top:2px">📖 “${esc(a.diary[a.diary.length - 1].text)}”</div>`
        : '';
      return `<div class="town-agent" style="flex-wrap:wrap"><span class="nm">${esc(a.name)}</span>
        <span class="rl">${esc(a.role)} · ${esc(a.loc)}${a.busy ? ' · 🔧 at their desk' : ''}</span>${mo}${en}<span class="co">${Number(a.coins) || 0}c</span>${ev}${dy}</div>`;
    }).join('');

    // civic life: passed laws and the ballots still open
    const lawsHost = root.querySelector('#town-laws');
    const laws = s.laws || [];
    const props = s.proposals || [];
    lawsHost.innerHTML = (laws.length || props.length)
      ? [
        ...props.map(p => `<div class="town-ev">🗳️ <b>ballot #${Number(p.id) || 0}</b> “${esc(p.text)}” — ${esc(p.by)} · ${Number(p.yes) || 0} for, ${Number(p.no) || 0} against</div>`),
        ...laws.slice().reverse().map(l => `<div class="town-ev">📜 “${esc(l.text)}” <span class="t">— ${esc(l.by)}, t${Number(l.tick) || 0}</span></div>`),
      ].join('')
      : '<p class="muted" style="margin:0">No laws yet — the town runs on goodwill.</p>';

    // the notes desk: what the townsfolk have written up about each other —
    // only engines that file notes get a desk at all
    const notesPanel = root.querySelector('#town-notes-panel');
    if (Array.isArray(s.notes)) {
      notesPanel.hidden = false;
      root.querySelector('#town-notes').innerHTML = s.notes.length
        ? s.notes.slice(-6).reverse().map(n => `<div class="town-ev"><span class="t">t${Number(n.tick) || 0}</span><b>${esc(n.by || '?')}</b> on ${esc(n.about || '?')}: “${esc(n.text || '')}”</div>`).join('')
        : '<p class="muted" style="margin:0">No notes filed yet.</p>';
    } else {
      notesPanel.hidden = true;
    }

    // community happenings the town pitched and corporate approved — always
    // marked optional for the owner, but you'd better believe he's coming
    const calPanel = root.querySelector('#town-cal-panel');
    if (Array.isArray(s.events)) {
      calPanel.hidden = false;
      root.querySelector('#town-cal').innerHTML = s.events.length
        ? s.events.slice().reverse().map(ev => `<div class="town-ev">📅 <b>${esc(ev.title || '')}</b> — ${esc(ev.date || 'soon')} <span class="t">pitched by ${esc(ev.by || '?')}</span></div>`).join('')
        : '<p class="muted" style="margin:0">Nothing planned yet — the town will think of something.</p>';
    } else {
      calPanel.hidden = true;
    }

    root.querySelector('#town-feed').innerHTML = (s.feed || []).map(e => `
      <div class="town-ev"><span class="t">t${Number(e.tick) || 0}</span><b>${esc(e.name)}</b> ${esc(e.text)}</div>`).join('');

    // work reports: what each agent has actually done, at a glance
    root.querySelector('#town-reports').innerHTML = (s.agents || []).map(a => {
      const t = a.tally || {};
      const line = [
        t.deepSessions ? `${t.deepSessions} workshop session${t.deepSessions === 1 ? '' : 's'}` : '',
        t.assists ? `${t.assists} assist${t.assists === 1 ? '' : 's'}` : '',
        t.buildsFinished ? `${t.buildsFinished} build${t.buildsFinished === 1 ? '' : 's'} finished` : '',
        t.shifts ? `${t.shifts} shift${t.shifts === 1 ? '' : 's'}` : '',
        t.jobsTaken ? `${t.jobsTaken} job${t.jobsTaken === 1 ? '' : 's'} taken` : '',
        t.hires ? `${t.hires} hire${t.hires === 1 ? '' : 's'}` : '',
        t.notesFiled ? `${t.notesFiled} note${t.notesFiled === 1 ? '' : 's'} filed` : '',
        t.ships ? `${t.ships} shipped` : '',
        t.earned ? `+${t.earned}c earned` : '',
        t.spent ? `−${t.spent}c spent` : '',
      ].filter(Boolean).join(' · ') || 'no work on record yet';
      const recent = (a.worklog || []).slice(-3).map(w =>
        `<div class="town-ev"><span class="t">t${Number(w.tick) || 0}</span>${esc(w.text)}</div>`).join('');
      return `<div style="padding:8px 0;border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent)">
        <div style="font-weight:700;color:var(--ink)">${esc(a.name)} <span style="font-weight:400;font-size:12.5px;color:var(--ink-2)">${esc(line)}</span></div>
        ${recent}</div>`;
    }).join('');

    // apps the villagers built and shipped to Cloudflare themselves — only
    // engines that ship get a panel. A link is a real href, so the URL has to
    // be a workers.dev address of their own; anything else is dropped, never
    // rendered as a link the owner could click.
    const shipsPanel = root.querySelector('#town-ships-panel');
    if (Array.isArray(s.deploys)) {
      shipsPanel.hidden = false;
      const rows = s.deploys.slice().reverse().filter(dp =>
        /^https:\/\/[a-z0-9.-]+\.workers\.dev(\/|$)/i.test(String(dp?.url || '')));
      root.querySelector('#town-ships').innerHTML = rows.length
        ? rows.map(dp => `<div class="town-ev">🚀 <b>${esc(dp.name || 'an app')}</b> by ${esc(dp.by || '?')} — <a href="${esc(dp.url)}" target="_blank" rel="noopener noreferrer">${esc(dp.url)}</a></div>`).join('')
        : '<p class="muted" style="margin:0">Nothing shipped yet.</p>';
    } else {
      shipsPanel.hidden = true;
    }

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
  async function sendChat(toAll = false) {
    const agentId = toAll ? 'all' : root.querySelector('#town-who').value;
    const input = root.querySelector('#town-say');
    const message = input.value.trim();
    if (!agentId || !message) return;
    input.value = '';
    const log = root.querySelector('#town-chatlog');
    log.insertAdjacentHTML('beforeend',
      `<div class="town-msg me">${toAll ? '📣 ' : ''}${esc(message)}</div>`);
    const bubble = document.createElement('div');
    bubble.className = 'town-msg them';
    bubble.style.whiteSpace = 'pre-line'; // a meeting reply is one line per villager
    bubble.textContent = toAll ? 'the town is gathering at the plaza…' : '…';
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
      // a meeting takes as long as the whole town answering — poll patiently
      const polls = toAll ? 80 : 20;
      for (let i = 0; i < polls && alive; i++) {
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
  root.querySelector('#town-meet').addEventListener('click', () => {
    const input = root.querySelector('#town-say');
    if (!input.value.trim()) { input.placeholder = 'Type what to ask the whole town, then 📣'; input.focus(); return; }
    sendChat(true);
  });
  root.querySelector('#town-send').addEventListener('click', () => sendChat());
  root.querySelector('#town-say').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  refresh();
  refreshApprovals();
  timer = setInterval(() => { refresh(); refreshApprovals(); }, 5000);

  return function unmount() {
    alive = false;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeydown);
  };
}
