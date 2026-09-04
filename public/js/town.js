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
  // agent-built structures — one matched 16-bit set (Recraft, Sept 3 2026)
  // (background already removed on Higgsfield, so these arrive transparent)
  house: `${HF}hf_20260903_061822_bb3dafd4-4c54-4182-9c31-decabbffe061.png`,
  shop: `${HF}hf_20260903_061829_76e4b0a1-c48a-4c73-b58e-3123a7ccf807.png`,
  landmark: `${HF}hf_20260903_061733_42681479-765b-488c-82c5-9083b861e3c0.png`,
  // the districts' businesses (same set)
  repairshop: `${HF}hf_20260903_061719_934dec88-e929-4076-bd03-ff12e6ab9e26.png`,
  chapel: `${HF}hf_20260903_061756_1e0cc216-188a-4437-b84a-f3e254b86b0d.png`,
  gym: `${HF}hf_20260903_061725_15b50d5e-ead9-4f8a-9648-f364372b12fd.png`,
  library: `${HF}hf_20260903_061740_3975abd8-c9fa-4e3c-887e-81c06903149c.png`,
  kitchen: `${HF}hf_20260903_061748_5ab0a5b5-5822-4b8b-93cf-82f53f823868.png`,
  plaza: `${HF}hf_20260903_061812_e52bc46d-ec35-476a-8014-b2d1a600dd33.png`,
  // the townsfolk
  // (the same matched 16-bit set as the buildings; side view, transparent)
  char_ctrl: `${HF}hf_20260903_062543_5b6f7781-2f69-4ea5-9350-84eb221ea927.png`,
  char_arise: `${HF}hf_20260903_062615_e6e6f212-b147-4c14-8e2b-558cb0bfec95.png`,
  char_apex: `${HF}hf_20260831_013239_abf91edf-2bcb-4a70-9b62-7c03e148ca53.png`,   // overridden by LOCAL_ART (Max's real likeness)
  char_draco: `${HF}hf_20260903_062838_8c679066-7b45-4be2-af41-1d1806c9eb35.png`,
  char_spork: `${HF}hf_20260903_062657_1ef7f7d2-f2c0-449d-ab06-c6db543c8379.png`,
  // one shared sprite for in-world hires (hue-shifted per person) and the owner
  char_hire: `${HF}hf_20260831_042858_d9ce3a7a-9a7b-4556-a6ed-9cb8765f2d0b.png`,
  char_boss: `${HF}hf_20260831_042858_a435ece7-0026-4234-b9fb-afb52907c232.png`,
  // front/back walk sheets per villager (side + a horizontal flip covers the rest)
  char_ctrl_front: `${HF}hf_20260903_062551_772266ba-eec7-44b4-8f73-56cfaa25c3c5.png`,
  char_ctrl_back: `${HF}hf_20260903_062602_78629f6c-b263-4bcd-8d9e-c9c6339ae607.png`,
  char_arise_front: `${HF}hf_20260903_062629_92b80ab5-7b9b-44f4-9097-257a4ba0a414.png`,
  char_arise_back: `${HF}hf_20260903_062826_f18462bc-f924-425f-b4cd-3a69eb445297.png`,
  char_apex_front: `${HF}hf_20260831_045614_e41bcdde-d69d-483e-acf4-1f8003463a58.png`,   // overridden by LOCAL_ART
  char_apex_back: `${HF}hf_20260831_045828_da021acf-6e32-4f3c-8849-e5e46c78b359.png`,    // overridden by LOCAL_ART
  char_draco_front: `${HF}hf_20260903_062639_415a52a8-38d1-45a1-a7ea-472af7a3c38a.png`,
  char_draco_back: `${HF}hf_20260903_062649_50974da2-5eb9-4343-b618-3900b2b5149f.png`,
  char_spork_front: `${HF}hf_20260903_062846_97541171-7007-46ec-b40b-1ed2063ad867.png`,
  char_spork_back: `${HF}hf_20260903_062858_b221f5ae-97a0-45dd-b633-16c45908d11f.png`,
  // the Studio district and its two: the metadata smith and the night watchman
  studio: `${HF}hf_20260903_061803_e0ebcfa5-2160-469b-b3af-7d9478f5287b.png`,   // the church Media Studio (same set, transparent)
  char_meta: `${HF}hf_20260903_062707_0caa46e1-e5f6-41d2-99cc-20173cfb5ace.png`,
  char_meta_front: `${HF}hf_20260903_062715_4d94e672-4e8b-46a7-88aa-b5e5105bd090.png`,
  char_meta_back: `${HF}hf_20260903_062724_b3d0a0cf-855f-46a2-9c2e-7030465e9ab1.png`,
  char_watch: `${HF}hf_20260903_062731_8e610fe8-c527-4708-8c4a-1c9cb67df45c.png`,
  char_watch_front: `${HF}hf_20260903_062742_adc1f1cc-9f30-4236-8ef7-fdcc82365c24.png`,
  char_watch_back: `${HF}hf_20260903_062758_ce9f20b5-2658-423a-9a92-ecd5c7b67e2e.png`,
};

// Villager sprites that ship WITH the app — a real person's likeness drawn as
// pixel art — rather than being generated. Apex is Bradly's actual personal
// trainer. These load straight from /public, already background-free, so they
// skip the R2 import path the generated sprites use.
const LOCAL_ART = {
  char_apex: '/townart/apex_side.png',        // base (side profile; renderer mirrors it)
  char_apex_front: '/townart/apex_front.png', // walking toward you
  char_apex_back: '/townart/apex_back.png',   // walking away
};

async function loadTownArt(kind) {
  const local = LOCAL_ART[kind];
  if (local) {
    const img = new Image();
    img.src = local;
    await img.decode().catch(() => {});
    if (!img.naturalWidth) return null;
    // These frames are ALREADY background-free and tightly cropped, so we do NOT
    // run stripAndCrop on them: its "near-black is background" rule would flood in
    // from the edges and eat the trainer's black pants and shoes. Just hand back
    // a canvas of the image as-is.
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }
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
// only the background CONNECTED to the border, then crop to the pixels that
// remain so every piece draws at its true size instead of floating in a square.
//
// The knockout keys off ONE card colour, decided from the border. A white or
// checkerboard card knocks out light only; a black card knocks out near-black
// only. This matters: with both rules always on, the flood would leak from a
// light card THROUGH a dark edge and eat the sprite's own dark parts — that is
// what left the villagers' houses with their roofs/bases missing (and Apex's
// black pants before them).
function stripAndCrop(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  let d;
  try { d = x.getImageData(0, 0, c.width, c.height); } catch { return img; }
  const { data } = d;
  const w = c.width, h = c.height;
  // Sample the border ring to decide the card colour. Bias to the light case —
  // only a clearly dark border is treated as a black card — so a stray dark
  // frame can never turn on near-black knockout and eat a sprite's dark pixels.
  let lightEdge = 0, darkEdge = 0, clearEdge = 0;
  const edgeLum = (px, py) => {
    const i = (py * w + px) * 4;
    if (data[i + 3] < 40) { clearEdge++; return; }   // a transparent edge tells us nothing about colour
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    if (mx > 170) lightEdge++; else if (mx < 80) darkEdge++;
  };
  for (let px = 0; px < w; px++) { edgeLum(px, 0); edgeLum(px, h - 1); }
  for (let py = 0; py < h; py++) { edgeLum(0, py); edgeLum(w - 1, py); }
  const darkCard = darkEdge > lightEdge * 3;
  // A genuinely transparent card (background already removed upstream) needs NO
  // colour knockout at all — only alpha decides. Without this, a white building
  // (the chapel) that touches the transparent edge would have its walls flooded
  // away just like a white card, because white is "light". A real white/black/
  // checker card has ZERO transparent border samples, so any transparent
  // majority proves the background was removed — a sprite whose base touches
  // the bottom edge must not flip this off (a 90% bar would).
  const transparentCard = clearEdge > lightEdge + darkEdge;
  const isBg = i => {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 40) return true;
    if (transparentCard) return false;              // opaque pixels are all sprite
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (darkCard) return mx < 64 && mx - mn < 22;   // black card → near-black only
    return mx > 198 && mx - mn < 16;                // white / checkerboard card → light only
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
    /* ONE HUD frame holds everything — the header band, the map, and a tabbed
       side panel. Nothing sprawls outside it (the reference town UI): on desktop
       the map sits beside the tabs; on a phone the tabs stack under the map. */
    /* an author display rule would defeat the hidden attribute (base.css has the
       same note for #appview) — so every element we toggle with .hidden gets an
       explicit [hidden] guard: the grid (offline), the canvas and the office. */
    #town-grid[hidden] { display:none; }
    .town-hud-shell { border-radius:16px; overflow:hidden; background:var(--surface);
      border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent);
      box-shadow:0 1px 3px rgba(0,0,0,0.10); }
    .town-title { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0;
      font-weight:800; font-size:15px; color:var(--ink); }
    @media (max-width:480px){ #town-morale .bar { width:72px; } }
    .town-title .wx { font-weight:400; font-size:12px; color:var(--ink-3); }
    .town-body { display:grid; grid-template-columns: minmax(0,1.35fr) minmax(280px,1fr); align-items:stretch; }
    .town-view { min-width:0; padding:10px;
      border-right:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); }
    .town-side { min-width:0; display:flex; flex-direction:column; }
    #town-canvas { display:block; width:100%; height:auto; border-radius:12px;
      background:#74b64e; border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent);
      image-rendering:pixelated; }
    #town-canvas[hidden] { display:none; }
    #town-pixeloffice { display:block; width:100%; height:440px; border:0; border-radius:12px; background:#141a26; }
    #town-pixeloffice[hidden] { display:none; }
    .town-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:8px 8px 0;
      border-bottom:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); }
    .town-tab { flex:0 0 auto; display:inline-flex; align-items:center; gap:5px; padding:8px 11px;
      border-radius:10px 10px 0 0; font-weight:700; font-size:11.5px; letter-spacing:.04em;
      text-transform:uppercase; color:var(--ink-3); background:transparent; cursor:pointer;
      border:1px solid transparent; border-bottom:0; white-space:nowrap; }
    .town-tab:hover { color:var(--ink); background:color-mix(in oklab,var(--ink) 5%,transparent); }
    .town-tab.on { color:var(--ink); margin-bottom:-1px;
      background:color-mix(in oklab,var(--accent) 14%,var(--surface));
      border-color:color-mix(in oklab,var(--ink-3) 24%,transparent);
      border-bottom:1px solid color-mix(in oklab,var(--accent) 14%,var(--surface)); }
    .town-tab .badge { display:inline-flex; align-items:center; justify-content:center; min-width:17px;
      height:17px; padding:0 5px; border-radius:9px; font-size:10px; font-weight:800; color:#fff; background:#e0533a; }
    .town-tab .badge[hidden] { display:none; }
    .town-pane { padding:12px; overflow:auto; max-height:560px; }
    .town-pane[hidden] { display:none; }
    .town-pane h4 { margin:14px 0 6px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
    .town-feed { max-height:none; }
    @media (max-width: 860px){
      .town-body { grid-template-columns:1fr; }
      .town-view { border-right:0; border-bottom:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); }
      .town-pane { max-height:340px; }
    }
    @media (max-width: 480px){ .town-tab span { display:none; } .town-tab { padding:8px 10px; font-size:14px; } }
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
    #town-morale .fill { display:block; height:100%; border-radius:5px; }
    /* the village HUD: a game-style header band of stat chips + action buttons,
       sitting over the map like the reference town */
    #town-hud { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:0;
      padding:10px 12px; border-radius:0;
      background:linear-gradient(180deg, color-mix(in oklab,var(--accent) 12%,var(--surface-2)), var(--surface-2));
      border:0; border-bottom:1px solid color-mix(in oklab,var(--ink-3) 26%,transparent);
      box-shadow:inset 0 1px 0 color-mix(in oklab,#fff 22%,transparent); }
    #town-stats { display:flex; flex-wrap:wrap; gap:8px; flex:1 1 280px; margin:0; }
    #town-stats .stat { flex:0 1 auto; min-width:58px; display:flex; flex-direction:column;
      gap:2px; padding:5px 9px; border-radius:10px;
      background:color-mix(in oklab,var(--ink) 6%,var(--surface));
      border:1px solid color-mix(in oklab,var(--ink-3) 20%,transparent); }
    #town-stats .stat .k { font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); }
    #town-stats .stat .v { font-size:16px; font-weight:800; line-height:1; color:var(--ink);
      font-variant-numeric:tabular-nums; }
    #town-stats .stat .v small { font-size:11px; font-weight:600; color:var(--ink-3); }
    #town-stats .stat.work .v { color:#57b86a; }
    #town-stats .stat.open .v { color:#e0b23a; }
    #town-hud-actions { display:flex; flex-wrap:wrap; gap:8px; margin-left:auto; }
    .town-hud-btn { display:inline-flex; align-items:center; gap:6px; padding:8px 12px; border-radius:10px;
      font-weight:700; font-size:11.5px; letter-spacing:.04em; text-transform:uppercase; cursor:pointer;
      color:var(--ink); background:color-mix(in oklab,var(--ink) 8%,var(--surface));
      border:1px solid color-mix(in oklab,var(--ink-3) 32%,transparent);
      box-shadow:inset 0 1px 0 color-mix(in oklab,#fff 25%,transparent); transition:transform .06s, background .15s; }
    .town-hud-btn:hover { background:color-mix(in oklab,var(--accent) 22%,var(--surface)); }
    .town-hud-btn:active { transform:translateY(1px); }
    .town-hud-btn.on { background:color-mix(in oklab,var(--accent) 32%,var(--surface)); border-color:var(--accent); }
    @media (max-width:560px){ #town-hud-actions .town-hud-btn span { display:none; } }
    .town-flash { animation:townFlash 1.1s ease-out; }
    @keyframes townFlash { 0%{ box-shadow:0 0 0 3px var(--accent); } 100%{ box-shadow:0 0 0 3px transparent; } }`;
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

  // One HUD frame: the header band (title · stat chips · actions), the map, and a
  // single tabbed side panel — Feed · Folks · Inbox · Reports · Charter · Talk.
  // Every element id the painters use is preserved; only the framing changed.
  root.innerHTML = `
    <div id="town-grid">
      <div class="town-hud-shell">
        <div id="town-hud">
          <div class="town-title">🏘️ The town <span id="town-wx" class="wx"></span><span id="town-morale" hidden><span class="lbl"></span><span class="bar"><span class="fill"></span></span></span></div>
          <div id="town-stats"></div>
          <div id="town-hud-actions">
            <button class="town-hud-btn" id="hud-who" title="Who's who — the townsfolk">👥 <span>Who's Who</span></button>
            <button class="town-hud-btn" id="hud-meet" title="Call a town meeting — everyone gathers and answers">📣 <span>Call Meeting</span></button>
            <button class="town-hud-btn" id="hud-cmd" title="Command Center — the pixel office view">🏢 <span>Command Center</span></button>
          </div>
        </div>
        <div id="town-alert" hidden style="margin:10px 10px 0;padding:8px 11px;border-radius:8px;font-size:13px;line-height:1.45;background:color-mix(in oklab,#ff8a2b 16%,transparent);border:1px solid color-mix(in oklab,#ff8a2b 45%,transparent);color:var(--ink)"></div>
        <div class="town-body">
          <div class="town-view">
            <canvas id="town-canvas"></canvas>
            <iframe id="town-pixeloffice" title="Pixel Office" hidden></iframe>
          </div>
          <div class="town-side">
            <div class="town-tabs" role="tablist">
              <button class="town-tab" role="tab" data-tab="feed">📡 <span>Feed</span></button>
              <button class="town-tab" role="tab" data-tab="folks">👥 <span>Folks</span></button>
              <button class="town-tab" role="tab" data-tab="inbox">📋 <span>Inbox</span> <span class="badge" id="tab-badge-inbox" hidden>0</span></button>
              <button class="town-tab" role="tab" data-tab="reports">📝 <span>Reports</span></button>
              <button class="town-tab" role="tab" data-tab="charter">🏛️ <span>Charter</span></button>
              <button class="town-tab" role="tab" data-tab="talk">💬 <span>Talk</span></button>
            </div>
            <div class="town-pane" data-pane="feed"><div class="town-feed" id="town-feed"></div></div>
            <div class="town-pane" data-pane="folks" hidden><div id="town-agents"></div></div>
            <div class="town-pane" data-pane="inbox" hidden><div id="town-approvals"></div></div>
            <div class="town-pane" data-pane="reports" hidden>
              <div id="town-reports"></div>
              <section id="town-ships-panel" hidden><h4>🚀 Shipped by the town</h4><div id="town-ships"></div></section>
            </div>
            <div class="town-pane" data-pane="charter" hidden>
              <div id="town-laws"></div>
              <section id="town-notes-panel" hidden><h4>🗒️ Notes desk</h4><div id="town-notes"></div></section>
              <section id="town-cal-panel" hidden><h4>📅 Community calendar</h4><div id="town-cal"></div></section>
            </div>
            <div class="town-pane" data-pane="talk" hidden>
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
      </div>
    </div>
    <div id="town-offline" class="town-off" hidden></div>`;

  const grid = root.querySelector('#town-grid');
  const offline = root.querySelector('#town-offline');

  // ---- the living map ----
  // A little game world, Smallville-style: one open field of a village with a
  // building for every district, and each agent as a sprite that actually
  // WALKS — over to their district when the engine moves them, and free-roaming
  // the whole village in between, drawn home by a bias toward their own patch.
  // State arrives every 5s; everything between polls is animated locally.
  const canvas = root.querySelector('#town-canvas');

  // ---- Pixel Office: the REAL pixel-agents web app (public/pixeloffice), embedded
  // and fed the villagers as "agents" over postMessage, so they render at their
  // desks in its own engine. The 🏢 button swaps it for the map. ----
  const pixelFrame = root.querySelector('#town-pixeloffice');
  const officeBtn = document.createElement('button');
  officeBtn.className = 'btn small';
  officeBtn.textContent = '🏢 Pixel Office';
  tools.append(officeBtn);
  let officeOn = false, pixelReady = false, lastState = null;
  const pixelSeen = new Set();
  const pixelPost = m => { try { pixelFrame.contentWindow?.postMessage(m, '*'); } catch { /* frame gone */ } };
  function feedPixelOffice(state) {
    if (!officeOn || pixelFrame.hidden || !pixelReady) return;
    const agents = Array.isArray(state?.agents) ? state.agents : [];
    const live = new Set();
    agents.forEach((a, i) => {
      const id = i + 1; live.add(id);
      if (!pixelSeen.has(id)) {
        pixelSeen.add(id);
        pixelPost({ type: 'agentCreated', id, folderName: String(a.name || `Agent ${id}`), palette: i % 6, hueShift: hashStr(String(a.name || a.id || id)) % 360 });
      }
      pixelPost({ type: 'agentStatus', id, status: 'active', awaitingInput: false });
      if (a.busy) pixelPost({ type: 'agentToolStart', id, toolId: `t${id}`, status: 'running', toolName: 'Edit' });
      else pixelPost({ type: 'agentToolsClear', id });
    });
    for (const id of [...pixelSeen]) if (!live.has(id)) { pixelPost({ type: 'agentClosed', id }); pixelSeen.delete(id); }
  }
  pixelFrame.addEventListener('load', () => { pixelReady = true; pixelSeen.clear(); feedPixelOffice(lastState); });
  officeBtn.addEventListener('click', () => {
    officeOn = !officeOn;
    officeBtn.classList.toggle('on', officeOn);
    canvas.hidden = officeOn;
    pixelFrame.hidden = !officeOn;
    if (officeOn) {
      // lazy: only fetch the app on demand. The ?v tag busts a cached index.html
      // so a new office build (e.g. the transport fix) is always picked up.
      if (!pixelFrame.src) pixelFrame.src = '/pixeloffice/index.html?v=2';
      feedPixelOffice(lastState);
    }
  });

  // ---- the village HUD buttons (over the map, like the reference town) ----
  const flash = el => { if (!el) return; el.classList.remove('town-flash'); void el.offsetWidth; el.classList.add('town-flash'); };
  // ---- the HUD tabs: one side panel switched by the tab bar; the choice sticks ----
  const tabBtns = [...root.querySelectorAll('.town-tab[data-tab]')];
  const panes = [...root.querySelectorAll('.town-pane[data-pane]')];
  function showTab(name) {
    if (!panes.some(p => p.dataset.pane === name)) name = 'feed';
    tabBtns.forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panes.forEach(p => { p.hidden = p.dataset.pane !== name; });
    // persist only a real change — the initial restore must not write (every
    // save fires the store hooks, and a no-op write on every mount is churn)
    if (load('town.tab', 'feed') !== name) save('town.tab', name);
  }
  tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  showTab(load('town.tab', 'feed'));
  root.querySelector('#hud-who')?.addEventListener('click', () => {
    showTab('folks');
    const side = root.querySelector('.town-side');
    if (window.innerWidth <= 860) side?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash(side);
  });
  root.querySelector('#hud-meet')?.addEventListener('click', () => {
    showTab('talk');                                    // the meeting plays out in the Talk pane
    root.querySelector('#town-meet')?.click();
  });
  const hudCmd = root.querySelector('#hud-cmd');
  hudCmd?.addEventListener('click', () => {
    officeBtn.click();                                  // reuse the real toggle
    hudCmd.classList.toggle('on', officeOn);
    hudCmd.querySelector('span').textContent = officeOn ? 'Back to Map' : 'Command Center';
  });

  const ctx = canvas.getContext('2d');
  const art = {};
  for (const kind of Object.keys(TOWN_ART_SRC)) loadTownArt(kind).then(img => { if (img) art[kind] = img; });
  // Dyer HQ's interior is a real pixel office, built from the pixel-agents tile
  // set (MIT, © Pablo De Lucca — see public/townart/office/LICENSE). These load
  // straight from /public and draw crisp (nearest-neighbour) at each desk.
  const HQ_KEY = 'plaza';
  const office = {};
  for (const name of ['floor', 'wall', 'desk', 'pc', 'chair', 'plant', 'whiteboard']) {
    const img = new Image();
    img.src = `/townart/office/${name}.png`;
    img.decode().then(() => { if (img.naturalWidth) office[name] = img; }).catch(() => {});
  }

  let districts = {};      // loc key -> {x,y,label,key,clearing} — x/y is where its building stands
  let townCenter = { x: 470, y: 318 };  // the fountain/plaza the town rings — set by syncWorld
  let placedStructs = [];  // structures with computed x/y
  // where the nth structure of a district sits, relative to that district's point
  const STRUCT_OFF = [[-84, 30], [84, 30], [-106, 62], [106, 62], [-44, 78], [44, 78], [-128, 4], [128, 4]];
  let decor = [];          // flat ground litter (flower clusters, grass tufts), painted under everything
  let greenery = [];       // trees and shrubs — they STAND, so they sort into the depth pass with the walkers
  let groundTex = null;    // the grass texture, painted once per world sync onto an offscreen canvas
  // what the residents have done to the town. All four are OPTIONAL in state —
  // the Gas Town bridge and older engines never send them — and the map must
  // look exactly as before when they're missing.
  let wallProgress = 100;  // s.wall.progress, 0-100: how much of the town wall the villagers have built
  let rooms = {};          // s.rooms: house key -> extra rooms; their decor lives in interiors['<house>/<slug>']
  let roomKey = null;      // which interiors[] key drawRoom paints while inside a house that has rooms
  let roomTabs = [];       // hit-rects of the room tabs along the top of a room, for the click handler
  // yards[key] props and addons[key] structures hang off each house's district
  // entry (d.yard, d.addons), validated once in syncWorld
  const YARD_KINDS = new Set(['bench', 'flowers', 'fence', 'tree', 'bush', 'lantern', 'mailbox', 'pond', 'path', 'sign']);
  const ADDON_KINDS = new Set(['porch', 'garage', 'tower', 'greenhouse', 'workshop', 'upstairs', 'balcony', 'chimney']);
  const TOP_KINDS = new Set(['upstairs', 'balcony', 'chimney']);   // these only make sense on top
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

  // deterministic scatter — the same tuft grows in the same spot every frame,
  // now over the WHOLE field instead of inside a plot
  // Everything green is precomputed here, once per world sync, never per frame:
  // the grass texture (an offscreen canvas), the flat ground litter, and the
  // trees and shrubs. Placement is deterministic (hashStr) so the same bush
  // grows in the same spot every frame — and kept OFF the plaza disc, off every
  // building's footprint, and off the wall band, so nothing sprouts on a roof.
  function makeDecor() {
    decor = []; greenery = [];
    const { width: W, height: H } = canvas;
    const cx = townCenter.x, cy = townCenter.y;
    // hashStr is a plain string hash, so sequential seeds land on a diagonal and
    // everything clumps; a finalizer mix spreads them evenly across the field
    const mix = n => { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; };
    const clear = (x, y, pad = 0) => {
      if (Math.hypot(x - cx, y - cy) < 96 + pad) return false;               // the plaza + fountain
      if (x < WALL + 8 + pad || x > W - WALL - 8 - pad || y < WALL + 8 + pad || y > H - WALL - 8 - pad) return false;
      for (const d of Object.values(districts)) {                            // every building's footprint
        if (Math.abs(x - d.x) < 58 + pad && y > d.y - 100 - pad && y < d.y + 24 + pad) return false;
      }
      return true;
    };
    // the grass itself: a subtle two-tone checker of 14px cells, two greens close
    // in value so it reads as texture rather than a grid, with a few darker specks
    const g = document.createElement('canvas');
    g.width = W; g.height = H;
    const gx = g.getContext('2d');
    gx.fillStyle = '#74b64e'; gx.fillRect(0, 0, W, H);
    const tones = ['#72b44c', '#78ba52', '#6fb049', '#7bbd55'];
    for (let y = 0; y < H; y += 14) for (let x = 0; x < W; x += 14) {
      const h = hashStr(`cell:${x}:${y}`);
      gx.fillStyle = tones[h % tones.length];
      gx.fillRect(x, y, 14, 14);
      if (h % 23 === 0) { gx.fillStyle = 'rgba(60,120,45,0.30)'; gx.fillRect(x + (h >>> 4) % 12, y + (h >>> 8) % 12, 2, 2); }  // a rare darker fleck, not a rash of them
    }
    groundTex = g;
    // flat litter: grass tufts and the odd flower cluster. Kept SPARSE — a field
    // of confetti reads as clutter, not meadow — and biased to plain green tufts
    // with only an occasional flower, so the eye rests on the buildings.
    const outer = Math.min(W, H) * 0.40;   // the calm inner village; decoration lives beyond it
    const n = Math.max(18, Math.round(W * H / 11000));
    for (let i = 0; i < n; i++) {
      const h = hashStr(`grass:${i}`);
      const x = 6 + mix(h) % Math.max(1, W - 12), y = 6 + mix(h ^ 0x9e3779b9) % Math.max(1, H - 12);
      if (!clear(x, y, 6)) continue;
      if (Math.hypot(x - cx, y - cy) < outer * 0.7) continue;   // keep the plaza and house ring clear
      decor.push({ x, y, kind: i % 6 === 0 ? 'flowers' : 'tuft', seed: h });
    }
    // standing greenery: trees and shrubs, thinned and pushed to a border ring
    // around the edge of the field so the middle of town stays uncluttered and
    // they frame it instead of crowding between the houses.
    const m = Math.max(14, Math.round(W * H / 13000));
    for (let i = 0; i < m; i++) {
      const h = hashStr(`green:${i}`);
      const x = 20 + mix(h) % Math.max(1, W - 40), y = 40 + mix(h ^ 0x9e3779b9) % Math.max(1, H - 60);
      if (!clear(x, y, 18)) continue;
      if (Math.hypot(x - cx, y - cy) < outer) continue;         // trees ring the town, they don't fill it
      const tree = i % 3 !== 1;
      greenery.push({ x, y, kind: tree ? 'tree' : 'shrub', size: tree ? 0.85 + (h % 5) * 0.09 : 0.8 + (h % 4) * 0.12 });
    }
  }

  // a soft clearing of slightly brighter grass around a district's point — an
  // irregular blob with no edges, so the ground still reads as one field
  function makeClearing(key, cx, cy) {
    const pts = [];
    const n = 14;
    for (let i = 0; i < n; i++) {
      const h = hashStr(`clearing:${key}:${i}`);
      const a = (i / n) * Math.PI * 2;
      const r = 88 + h % 38;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + 8 + Math.sin(a) * r * 0.62 });
    }
    return pts;
  }

  // villagers roam the whole canvas; the margin keeps them (and their name
  // plates and bubbles) inside the town wall that rings the field
  const WALL = 22;         // stone wall thickness around the field
  const FIELD = WALL + 16;
  const onField = (x, y) => ({
    x: Math.max(FIELD, Math.min(canvas.width - FIELD, x)),
    y: Math.max(FIELD + 22, Math.min(canvas.height - FIELD, y)),
  });

  // FREE ROAM. A district is a point, never a pen, so a target may be anywhere
  // in the village — but with a home bias: 65% a short amble around their own
  // district, 20% a ramble into the neighbouring blocks, 15% clear across town.
  // homeOnly (a fresh arrival) always lands in the short-amble ring.
  function roamTarget(d, homeOnly = false) {
    const roll = homeOnly ? 0 : Math.random();
    if (d && roll < 0.85) {
      const rad = roll < 0.65 ? 26 + Math.random() * 62 : 90 + Math.random() * 150;
      const a = Math.random() * Math.PI * 2;
      return onField(d.x + Math.cos(a) * rad, d.y + 18 + Math.sin(a) * rad * 0.7);
    }
    return onField(Math.random() * canvas.width, Math.random() * canvas.height);
  }

  function syncWorld(s) {
    // room decor rides along with every state push — a viewer standing inside
    // sees redecoration live, and never gets kicked out by the 5s refresh
    interiors = s.interiors || {};
    const keys = Object.keys(s.map || {});
    if (!keys.length) { mapReady = false; return; }
    // A village square, not a spreadsheet: the plaza (HQ) stands at the town
    // centre by the fountain, and every other district rings it, evenly spaced
    // on an ellipse. The canvas is a fixed landscape so the ring always reads.
    const W = 940, H = 620;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    townCenter = { x: W / 2, y: H / 2 + 10 };
    districts = {};
    // The villagers design the town: `layout[key] = {x,y}` (0–100 field coords)
    // is where they chose to put a building. We honor it; anything not yet placed
    // falls back to a tidy ring around the plaza.
    const layout = (s.layout && typeof s.layout === 'object') ? s.layout : {};
    const padX = 66, topY = WALL + 104, botY = H - WALL - 30;   // keep roofs and name plates on-canvas
    const toPx = p => ({
      x: Math.max(padX, Math.min(W - padX, (Number(p.x) || 50) / 100 * W)),
      y: Math.max(topY, Math.min(botY, (Number(p.y) || 50) / 100 * H)),
    });

    // the plaza (HQ) always stands just above the central fountain — the one
    // fixed point the square is built around; agents move everything else
    const hasPlaza = keys.includes('plaza');
    if (hasPlaza) {
      const cx = townCenter.x, cy = townCenter.y - 104;
      districts.plaza = { key: 'plaza', x: cx, y: cy, label: s.map.plaza, clearing: makeClearing('plaza', cx, cy) };
    }
    // ring only the buildings nobody has placed yet
    const ring = keys.filter(k => k !== 'plaza' && !layout[k]);
    const n = ring.length;
    const rx = Math.max(200, Math.min(360, 150 + n * 24));
    const ry = Math.max(140, Math.min(188, 100 + n * 16));   // capped so a roof clears the top wall
    let ri = 0;
    for (const k of keys) {
      if (k === 'plaza') continue;
      let cx, cy;
      if (layout[k]) {
        const p = toPx(layout[k]); cx = p.x; cy = p.y;         // the spot its resident chose
      } else {
        const a = -Math.PI / 2 + ((ri + 0.5) / Math.max(1, n)) * Math.PI * 2; ri++;
        cx = townCenter.x + Math.cos(a) * rx; cy = townCenter.y + Math.sin(a) * ry;
      }
      districts[k] = { key: k, x: cx, y: cy, label: s.map[k] };
    }
    // Tidy the ring so buildings never stack. The villagers place their own
    // houses, and saved spots can pile onto one corner — which is what "houses
    // on top of each other" was. Keep the plaza fixed above the fountain and lay
    // every other building on one evenly-spaced ellipse around it, ordered by the
    // angle each resident chose, so a house moved to the east stays in the east —
    // it just gets elbow room. Spacing is by equal arc LENGTH, not equal angle,
    // or the wide sides of the ellipse bunch up again.
    {
      const others = Object.values(districts).filter(d => d.key !== 'plaza');
      const ang0 = d => (Math.atan2(d.y - townCenter.y, d.x - townCenter.x) + Math.PI * 2.5) % (Math.PI * 2);
      others.sort((a, b) => ang0(a) - ang0(b));
      const rx = 388, ry = 212, GAP = 52 * Math.PI / 180;        // GAP at the top leaves room for the plaza/HQ
      const a0 = -Math.PI / 2 + GAP / 2, a1 = a0 + (Math.PI * 2 - GAP);
      const SAMP = 1200, cum = [0]; let L = 0;                    // cumulative arc-length table along the ellipse
      for (let i = 1; i <= SAMP; i++) {
        const t0 = a0 + (a1 - a0) * (i - 1) / SAMP, t1 = a0 + (a1 - a0) * i / SAMP;
        L += Math.hypot(rx * (Math.cos(t1) - Math.cos(t0)), ry * (Math.sin(t1) - Math.sin(t0)));
        cum.push(L);
      }
      const angAt = u => { const target = u * L; let lo = 0; while (lo < SAMP && cum[lo] < target) lo++; return a0 + (a1 - a0) * lo / SAMP; };
      const n = others.length || 1;
      others.forEach((d, i) => {
        const a = angAt((i + 0.5) / n);
        d.x = Math.max(padX, Math.min(W - padX, townCenter.x + Math.cos(a) * rx));
        d.y = Math.max(topY, Math.min(botY, townCenter.y + Math.sin(a) * ry));
      });
      for (const d of Object.values(districts)) d.clearing = makeClearing(d.key, d.x, d.y);   // clearings follow to the tidy spot
    }
    // What the residents have done to the town — every field OPTIONAL (the Gas
    // Town bridge and older engines send none of them), validated once here so
    // the per-frame drawers never see a bad kind or an off-map offset.
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const wp = Number(s.wall && s.wall.progress);
    wallProgress = Number.isFinite(wp) ? Math.max(0, Math.min(100, wp)) : 100;   // no field → the finished wall
    rooms = {};
    for (const [hk, list] of Object.entries(obj(s.rooms))) {
      if (!districts[hk] || !Array.isArray(list)) continue;
      rooms[hk] = list.filter(r => r && typeof r.key === 'string').slice(0, 4)
        .map(r => ({ key: r.key, name: String(r.name || 'Room').slice(0, 18) }));
    }
    const yards = obj(s.yards), addons = obj(s.addons);
    for (const d of Object.values(districts)) {
      if (!d.key.startsWith('house_')) continue;
      d.yard = (Array.isArray(yards[d.key]) ? yards[d.key] : [])
        .filter(it => it && YARD_KINDS.has(it.kind) && Number.isFinite(Number(it.x)) && Number.isFinite(Number(it.y)))
        .slice(0, 12)
        .map(it => ({ kind: it.kind, x: Math.max(-90, Math.min(90, Number(it.x))), y: Math.max(-10, Math.min(70, Number(it.y))) }));
      const bySide = {};
      for (const a of (Array.isArray(addons[d.key]) ? addons[d.key] : [])) {
        if (!a || !ADDON_KINDS.has(a.kind)) continue;
        const side = TOP_KINDS.has(a.kind) ? 'top' : (a.side === 'left' || a.side === 'right' || a.side === 'top') ? a.side : 'right';
        bySide[side] = { kind: a.kind, side };
      }
      d.addons = Object.values(bySide);
    }
    makeDecor();

    // the owner spawns by the plaza fountain — first visit, or a saved spot
    // that no longer fits the map
    if (!Number.isFinite(me.x) || !Number.isFinite(me.y) || me.x < 0 || me.x > W || me.y < 0 || me.y > H) {
      me.x = townCenter.x + 40; me.y = townCenter.y + 30; me.tx = me.x; me.ty = me.y;
    }

    // agent-built structures cluster around their district's point, off to the
    // sides and below so they never sit on the district's own building
    const perLoc = {};
    placedStructs = (s.structures || []).map(st => {
      const d = districts[st.loc] || districts[keys[0]];
      const i = (perLoc[st.loc] = (perLoc[st.loc] || 0) + 1) - 1;
      const [ox, oy] = STRUCT_OFF[i % STRUCT_OFF.length];
      return { ...st, x: d.x + ox, y: d.y + oy + Math.floor(i / STRUCT_OFF.length) * 22 };
    });

    const seen = new Set();
    for (const a of s.agents || []) {
      seen.add(a.id);
      let sp = sprites.get(a.id);
      const d = districts[a.loc] || districts[keys[0]];
      if (!sp) {
        const p = roamTarget(d, true);
        sp = { x: p.x, y: p.y, tx: p.x, ty: p.y, loc: a.loc, wanderAt: 0, bubble: null, bubbleUntil: 0 };
        sprites.set(a.id, sp);
      } else if (sp.loc !== a.loc) {
        sp.loc = a.loc;                    // walk across town to the new district
        const p = roamTarget(d, true);     // heading for its vicinity, not a box
        sp.tx = p.x; sp.ty = p.y;
      }
      sp.name = a.name;
      sp.busy = !!a.busy;
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
        const p = roamTarget(districts[sp.loc]);   // anywhere in the village, home-biased
        sp.tx = p.x; sp.ty = p.y;
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
        roomKey = null; roomTabs = [];     // always arrive in the main room
      }
    }
    // the Test Kitchen's chimney smokes while the town is awake
    const kd = districts.kitchen;
    if (kd && now - lastSmoke > 750) {
      lastSmoke = now;
      puffs.push({ kind: 'smoke', x: kd.x + 20 + (Math.random() * 6 - 3), y: kd.y - 90, born: now });
      // and every house whose resident built a chimney add-on puffs too
      for (const d of Object.values(districts)) {
        if (Array.isArray(d.addons) && d.addons.some(a => a.kind === 'chimney')) {
          puffs.push({ kind: 'smoke', x: d.x + 23 + (Math.random() * 4 - 2), y: d.y - 124, born: now });
        }
      }
    }
    puffs = puffs.filter(p => now - p.born < (p.kind === 'smoke' ? 2400 : 550));
    if (inside) drawRoom(now, t); else draw(now, t);
  }

  // farm-sim daylight scene: one open grass field, dirt paths meeting at the
  // plaza, pixel buildings dotted about it, and the townsfolk strolling anywhere
  function label(text, x, y, size = 11) {
    ctx.font = `700 ${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(253,253,244,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#33281a';
    ctx.fillText(text, x, y);
  }

  // the central fountain: a stone basin, a raised inner bowl of water, a little
  // spout at the top and rings of ripple spreading out across the pool
  function drawFountain(cx, cy, t) {
    // outer basin rim
    ctx.fillStyle = '#8f887b';
    ctx.beginPath(); ctx.ellipse(cx, cy + 2, 46, 34, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a7a094';
    ctx.beginPath(); ctx.ellipse(cx, cy, 46, 34, 0, 0, Math.PI * 2); ctx.fill();
    // water
    ctx.fillStyle = '#4f9fc4';
    ctx.beginPath(); ctx.ellipse(cx, cy, 37, 26, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#63b4d6';
    ctx.beginPath(); ctx.ellipse(cx, cy - 1, 33, 22, 0, 0, Math.PI * 2); ctx.fill();
    // ripples spreading out over the pool
    for (let k = 0; k < 3; k++) {
      const r = (t / 30 + k * 8) % 24;
      ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, 0.5 - r / 32)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(cx, cy, 6 + r * 1.3, 4 + r * 0.9, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // stone pedestal + a bobbing spout of water
    ctx.fillStyle = '#8f887b';
    ctx.fillRect(cx - 5, cy - 20, 10, 20);
    ctx.fillStyle = '#a7a094';
    ctx.beginPath(); ctx.ellipse(cx, cy - 20, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    const spout = 8 + Math.sin(t / 160) * 2;
    ctx.fillStyle = 'rgba(150,210,235,0.85)';
    ctx.fillRect(cx - 2, cy - 20 - spout, 4, spout);
    ctx.beginPath(); ctx.arc(cx, cy - 20 - spout, 3, 0, Math.PI * 2); ctx.fill();
    // droplets arcing out of the spout on little parabolas, phase-offset so the
    // fountain is always mid-splash somewhere; they fade as they meet the pool
    for (let i = 0; i < 8; i++) {
      const ph = ((t / 900) + i / 8) % 1;
      const side = i % 2 ? 1 : -1, spread = 14 + (i % 4) * 4;
      const x = cx + side * ph * spread;
      const y = (cy - 24 - spout) + ph * 26 - 4 * 15 * ph * (1 - ph);
      ctx.fillStyle = `rgba(190,230,250,${0.9 - ph * 0.7})`;
      ctx.beginPath(); ctx.arc(x, y, 1.6 + ph, 0, Math.PI * 2); ctx.fill();
    }
    // a shimmering surface: short highlight dashes that drift across the pool
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 5; i++) {
      const dx = ((t / 60 + i * 37) % 52) - 26, dy = Math.sin(t / 400 + i) * 6 + (i - 2) * 5;
      ctx.beginPath(); ctx.moveTo(cx + dx - 4, cy + dy); ctx.lineTo(cx + dx + 4, cy + dy); ctx.stroke();
    }
  }

  // The town wall is something the villagers BUILD (state.wall.progress, 0-100).
  // It grows clockwise from the top-left corner around the perimeter, with a
  // permanent gate gap centred on the bottom edge. 0 → an open field with only a
  // faint survey line; 100 → the full crenellated stone wall. No field → 100, so
  // the Gas Town bridge and older engines keep the finished look.
  const GATE = 90;
  function wallEdges(W, H) {
    const s = WALL, g = GATE / 2;
    return [
      { h: true,  y: 0,     from: 0,         to: W,          top: true },
      { h: false, x: W - s, from: 0,         to: H },
      { h: true,  y: H - s, from: W,         to: W / 2 + g },        // bottom, right of the gate
      { h: true,  y: H - s, from: W / 2 - g, to: 0 },                // bottom, left of the gate
      { h: false, x: 0,     from: H,         to: 0 },
    ];
  }
  function drawWall(W, H) {
    const s = WALL, p = wallProgress;
    if (p <= 0) {                                   // nothing built yet: just the survey line
      ctx.save();
      ctx.setLineDash([6, 8]); ctx.strokeStyle = 'rgba(40,40,30,0.22)'; ctx.lineWidth = 2;
      ctx.strokeRect(s / 2, s / 2, W - s, H - s);
      ctx.restore();
      return;
    }
    const edges = wallEdges(W, H);
    const total = edges.reduce((n, e) => n + Math.abs(e.to - e.from), 0);
    let left = total * Math.min(100, p) / 100;
    ctx.strokeStyle = 'rgba(60,55,48,0.35)'; ctx.lineWidth = 1;
    for (const e of edges) {
      if (left <= 0) break;
      const len = Math.abs(e.to - e.from), seg = Math.min(left, len), dir = Math.sign(e.to - e.from);
      const a = e.from, b = e.from + dir * seg;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      ctx.fillStyle = '#8a8378';
      if (e.h) {
        ctx.fillRect(lo, e.y, hi - lo, s);
        for (let x = lo - (lo % 16); x < hi; x += 16) { ctx.beginPath(); ctx.moveTo(x, e.y); ctx.lineTo(x, e.y + s); ctx.stroke(); }
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        if (e.top) ctx.fillRect(lo, s, hi - lo, 4);
        if (e.top) { ctx.fillStyle = '#9a9286'; for (let x = lo + 6; x < hi - 12; x += 26) ctx.fillRect(x, s - 5, 14, 5); }
      } else {
        ctx.fillRect(e.x, lo, s, hi - lo);
        for (let y = lo - (lo % 16); y < hi; y += 16) { ctx.beginPath(); ctx.moveTo(e.x, y); ctx.lineTo(e.x + s, y); ctx.stroke(); }
        if (e.x === 0) { ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(s, lo, 4, hi - lo); }
      }
      left -= seg;
    }
    // gate posts once the wall has reached the gate, and a progress note while building
    const reached = total * p / 100 >= W + H + (W / 2 - GATE / 2);
    if (reached) {
      ctx.fillStyle = '#6f6a60';
      ctx.fillRect(W / 2 - GATE / 2 - 8, H - s - 10, 8, s + 10);
      ctx.fillRect(W / 2 + GATE / 2, H - s - 10, 8, s + 10);
    }
    if (p < 100) label(`town wall ${Math.round(p)}% built`, W / 2, H - s - 14, 10);
  }

  // ---- the greenery and the residents' yard props, all drawn from primitives ----
  function drawTree(x, y, k = 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, 14 * k, 5 * k, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7a5230'; ctx.fillRect(x - 3 * k, y - 16 * k, 6 * k, 17 * k);
    ctx.fillStyle = '#3f8f3a'; ctx.beginPath(); ctx.arc(x, y - 24 * k, 16 * k, 0, TAU); ctx.fill();
    ctx.fillStyle = '#56ac48'; ctx.beginPath(); ctx.arc(x - 4 * k, y - 29 * k, 12 * k, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7fcb66'; ctx.beginPath(); ctx.arc(x - 8 * k, y - 34 * k, 5 * k, 0, TAU); ctx.fill();
  }
  function drawShrub(x, y, k = 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath(); ctx.ellipse(x, y + 2, 13 * k, 4 * k, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3d8a38'; ctx.beginPath(); ctx.ellipse(x, y - 4 * k, 14 * k, 9 * k, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#55a847'; ctx.beginPath(); ctx.ellipse(x - 2 * k, y - 8 * k, 11 * k, 8 * k, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#7fc86a'; ctx.beginPath(); ctx.ellipse(x - 5 * k, y - 12 * k, 5 * k, 3 * k, 0, 0, TAU); ctx.fill();
  }
  function drawFlowers(x, y, seed) {
    const cols = ['#ff6b6b', '#ffd94a', '#ff8bb3', '#fdfdf4', '#a78bfa'];
    ctx.fillStyle = '#5da33c';
    ctx.fillRect(x - 3, y + 1, 2, 3); ctx.fillRect(x + 2, y, 2, 4);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = cols[(seed + i * 7) % cols.length];
      ctx.fillRect(x - 5 + ((seed >>> (i * 3)) % 10), y - 4 + ((seed >>> (i * 2 + 1)) % 5), 3, 3);
    }
  }
  function drawYardItem(kind, x, y, now, t) {
    ctx.save();
    switch (kind) {
      case 'bench':
        ctx.fillStyle = '#7a5230'; ctx.fillRect(x - 12, y - 6, 3, 8); ctx.fillRect(x + 9, y - 6, 3, 8);
        ctx.fillStyle = '#a67c52'; ctx.fillRect(x - 14, y - 9, 28, 4); ctx.fillRect(x - 14, y - 15, 28, 3);
        break;
      case 'flowers': drawFlowers(x, y, hashStr(`yf:${x}:${y}`)); drawFlowers(x + 9, y + 3, hashStr(`yg:${x}:${y}`)); break;
      case 'fence':
        ctx.fillStyle = '#d9c7a3';
        for (let i = -2; i <= 2; i++) ctx.fillRect(x + i * 9 - 1, y - 14, 3, 14);
        ctx.fillRect(x - 20, y - 9, 40, 2); ctx.fillRect(x - 20, y - 4, 40, 2);
        break;
      case 'tree': drawTree(x, y, 0.9); break;
      case 'bush': drawShrub(x, y, 0.9); break;
      case 'lantern': {
        const g = ctx.createRadialGradient(x, y - 18, 2, x, y - 18, 22);
        g.addColorStop(0, 'rgba(255,214,130,0.35)'); g.addColorStop(1, 'rgba(255,214,130,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 18, 22, 0, TAU); ctx.fill();
        ctx.fillStyle = '#4a4a4a'; ctx.fillRect(x - 1, y - 16, 3, 16);
        ctx.fillStyle = (now % 1400) < 1100 ? '#ffd27a' : '#f4b95a'; ctx.fillRect(x - 4, y - 22, 9, 7);
        break;
      }
      case 'mailbox':
        ctx.fillStyle = '#6b5030'; ctx.fillRect(x - 1, y - 14, 3, 14);
        ctx.fillStyle = '#3b6fb6'; ctx.fillRect(x - 6, y - 20, 13, 7);
        ctx.fillStyle = '#e0533a'; ctx.fillRect(x + 6, y - 24, 2, 5);
        break;
      case 'pond':
        ctx.fillStyle = '#7fc0dc'; ctx.beginPath(); ctx.ellipse(x, y, 18, 10, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#4f9fc4'; ctx.beginPath(); ctx.ellipse(x, y, 15, 8, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x - 6 + Math.sin(t / 500) * 3, y - 3, 6, 1.5);
        break;
      case 'path':
        ctx.fillStyle = '#d9b380'; ctx.beginPath(); ctx.ellipse(x, y, 16, 7, 0, 0, TAU); ctx.fill();
        break;
      case 'sign':
        ctx.fillStyle = '#6b5030'; ctx.fillRect(x - 1, y - 16, 3, 16);
        ctx.fillStyle = '#a67c52'; ctx.fillRect(x - 10, y - 24, 21, 10);
        ctx.fillStyle = '#3a2a18'; ctx.fillRect(x - 7, y - 21, 14, 1.5); ctx.fillRect(x - 7, y - 17.5, 10, 1.5);
        break;
    }
    ctx.restore();
  }
  // structural add-ons adjoining a house: side lean-tos are drawn BEFORE the
  // house sprite (so the house overlaps their inner edge and they read as
  // attached); top pieces sit on the roof line and are drawn after it
  function drawAddon(kind, side, hx, hy) {
    ctx.save();
    if (side === 'top') {
      if (kind === 'upstairs') {
        ctx.fillStyle = '#b98a63'; ctx.fillRect(hx - 34, hy - 122, 68, 24);
        ctx.fillStyle = '#7a4d2e'; ctx.beginPath(); ctx.moveTo(hx - 40, hy - 122); ctx.lineTo(hx, hy - 138); ctx.lineTo(hx + 40, hy - 122); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe9a8'; ctx.fillRect(hx - 22, hy - 116, 10, 10); ctx.fillRect(hx + 12, hy - 116, 10, 10);
      } else if (kind === 'balcony') {
        ctx.fillStyle = '#8a6a48'; ctx.fillRect(hx - 30, hy - 58, 60, 5);
        ctx.fillStyle = '#c9a87c'; for (let i = -3; i <= 3; i++) ctx.fillRect(hx + i * 9 - 1, hy - 70, 2, 12);
        ctx.fillRect(hx - 30, hy - 70, 60, 2);
      } else if (kind === 'chimney') {
        ctx.fillStyle = '#8a4a3a'; ctx.fillRect(hx + 18, hy - 120, 10, 24);
        ctx.fillStyle = '#5a3028'; ctx.fillRect(hx + 16, hy - 124, 14, 5);
      }
    } else {
      const dir = side === 'left' ? -1 : 1, x0 = hx + dir * 46;           // the lean-to's near edge
      const bx = dir === -1 ? x0 - 36 : x0;                                // its left edge
      const roof = () => { ctx.fillStyle = '#7a4d2e'; ctx.beginPath(); ctx.moveTo(bx - 3, hy - 40); ctx.lineTo(bx + 18, hy - 52); ctx.lineTo(bx + 39, hy - 40); ctx.closePath(); ctx.fill(); };
      if (kind === 'porch') {
        ctx.fillStyle = '#a67c52'; ctx.fillRect(bx, hy - 6, 36, 6);
        ctx.fillStyle = '#c9a87c'; ctx.fillRect(bx + 3, hy - 40, 4, 34); ctx.fillRect(bx + 29, hy - 40, 4, 34);
        roof();
      } else if (kind === 'garage') {
        ctx.fillStyle = '#b98a63'; ctx.fillRect(bx, hy - 40, 36, 40);
        ctx.fillStyle = '#5a4a3a'; ctx.fillRect(bx + 5, hy - 26, 26, 26);
        ctx.fillStyle = '#8a7a6a'; for (let i = 0; i < 4; i++) ctx.fillRect(bx + 5, hy - 22 + i * 6, 26, 1);
        roof();
      } else if (kind === 'greenhouse') {
        ctx.fillStyle = 'rgba(207,233,221,0.9)'; ctx.fillRect(bx, hy - 40, 36, 40);
        ctx.strokeStyle = 'rgba(70,110,90,0.5)'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(bx + i * 9, hy - 40); ctx.lineTo(bx + i * 9, hy); ctx.stroke(); }
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(bx, hy - i * 10); ctx.lineTo(bx + 36, hy - i * 10); ctx.stroke(); }
        ctx.fillStyle = 'rgba(120,180,140,0.9)'; ctx.beginPath(); ctx.moveTo(bx - 3, hy - 40); ctx.lineTo(bx + 18, hy - 52); ctx.lineTo(bx + 39, hy - 40); ctx.closePath(); ctx.fill();
      } else if (kind === 'workshop') {
        ctx.fillStyle = '#9c7a58'; ctx.fillRect(bx, hy - 40, 36, 40);
        ctx.fillStyle = '#ffe9a8'; ctx.fillRect(bx + 6, hy - 30, 10, 10);
        ctx.fillStyle = '#5a3a2a'; ctx.fillRect(bx + 22, hy - 20, 10, 20);
        ctx.fillStyle = '#d9c7a3'; ctx.fillRect(bx + 20, hy - 34, 14, 6);
        roof();
      } else if (kind === 'tower') {
        const tx = dir === -1 ? x0 - 22 : x0;
        ctx.fillStyle = '#a8a29a'; ctx.fillRect(tx, hy - 92, 22, 92);
        ctx.fillStyle = '#7a4d2e'; ctx.beginPath(); ctx.moveTo(tx - 4, hy - 92); ctx.lineTo(tx + 11, hy - 116); ctx.lineTo(tx + 26, hy - 92); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe9a8'; ctx.fillRect(tx + 8, hy - 80, 6, 9); ctx.fillRect(tx + 8, hy - 50, 6, 9);
      }
    }
    ctx.restore();
  }

  // a small looping animation at each building that says what its resident does —
  // Max's barbell at the gym, steam over Spork's kitchen, sparks at Ctrl's bench,
  // and so on. `active` (the resident is busy on the job) makes it livelier; even
  // idle it keeps a gentle motion so the town always feels lived-in.
  const TAU = Math.PI * 2;
  function drawActivity(key, x, y, now, t, active) {
    const amp = active ? 1 : 0.5;
    ctx.save();
    if (key === 'gym') {                       // Max doing reps: a bobbing barbell
      const by = y - 30 + Math.sin(t / 170) * 8 * amp;
      ctx.strokeStyle = '#3a3f4a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 13, by); ctx.lineTo(x + 13, by); ctx.stroke();
      ctx.fillStyle = '#e0533a';
      ctx.beginPath(); ctx.arc(x - 13, by, 5, 0, TAU); ctx.arc(x + 13, by, 5, 0, TAU); ctx.fill();
    } else if (key === 'kitchen') {            // Spork cooking: steam off the pot
      for (let k = 0; k < 3; k++) {
        const p = ((t / 22 + k * 8) % 26) / 26;
        ctx.fillStyle = `rgba(240,240,235,${(1 - p) * 0.55 * amp})`;
        ctx.beginPath(); ctx.arc(x + Math.sin(now / 300 + k) * 4, y - 14 - p * 26, 2.5 + p * 3, 0, TAU); ctx.fill();
      }
    } else if (key === 'repairshop') {         // Ctrl at the bench: solder sparks
      if (Math.random() < (active ? 0.55 : 0.18)) {
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = ['#ffd94a', '#ff9a3a', '#ffffff'][k % 3];
          ctx.fillRect(x + 6 + Math.random() * 12 - 6, y - 18 + Math.random() * 10 - 5, 2, 2);
        }
      }
    } else if (key === 'library') {            // Draco writing: a page drifting up
      const p = ((t / 26) % 34) / 34;
      ctx.fillStyle = `rgba(250,244,220,${(1 - p) * 0.9})`;
      ctx.fillRect(x + 15, y - 26 - p * 24, 6, 8);
    } else if (key === 'studio') {             // Meta editing: a spinning cube + REC
      const a = now / 600, s = 6, w = s * Math.abs(Math.cos(a));
      ctx.strokeStyle = '#8ab4ff'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 14 - w, y - 26 - s, w * 2, s * 2);
      if ((now % 1300) < 750) { ctx.fillStyle = '#ff5a5a'; ctx.beginPath(); ctx.arc(x - 16, y - 26, 3, 0, TAU); ctx.fill(); }
    } else if (key === 'chapel') {             // Arise: a warm glow over the chapel
      const g = (0.22 + Math.sin(now / 520) * 0.12) * amp;
      const grd = ctx.createRadialGradient(x, y - 42, 2, x, y - 42, 30);
      grd.addColorStop(0, `rgba(255,222,150,${g})`); grd.addColorStop(1, 'rgba(255,222,150,0)');
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y - 42, 30, 0, TAU); ctx.fill();
    } else if (key === 'landmark') {           // Vigil: a sweeping lantern beam
      const a = Math.sin(now / 750) * 0.55 - 0.8;
      ctx.fillStyle = 'rgba(255,240,180,0.16)';
      ctx.beginPath(); ctx.moveTo(x, y - 72);
      ctx.lineTo(x + Math.cos(a - 0.28) * 48, y - 72 + Math.sin(a - 0.28) * 48);
      ctx.lineTo(x + Math.cos(a + 0.28) * 48, y - 72 + Math.sin(a + 0.28) * 48);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function draw(now, t) {
    const { width: W, height: H } = canvas;
    const cx = townCenter.x, cy = townCenter.y;
    // which buildings have their resident on the job right now → livelier animation
    const activeKeys = new Set();
    for (const sp of sprites.values()) if (sp.busy && sp.loc) activeKeys.add(sp.loc);
    ctx.imageSmoothingEnabled = false;   // crisp chunky pixels when scaling
    // the grass: a precomputed two-tone texture (see makeDecor), one blit
    if (groundTex) ctx.drawImage(groundTex, 0, 0);
    else { ctx.fillStyle = '#74b64e'; ctx.fillRect(0, 0, W, H); }

    // curved dirt paths spoking out from the plaza to every ringed district —
    // a gentle bow gives the square its village feel instead of straight rays
    const paths = Object.values(districts).filter(d => d.key !== 'plaza');
    const drawPaths = (width, colour) => {
      ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.lineCap = 'round';
      for (const d of paths) {
        const mx = (cx + d.x) / 2, my = (cy + d.y) / 2;
        const nx = -(d.y - cy), ny = (d.x - cx);              // perpendicular, for the bow
        const nl = Math.hypot(nx, ny) || 1, bow = 26;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(mx + (nx / nl) * bow, my + (ny / nl) * bow, d.x, d.y + 8);
        ctx.stroke();
      }
    };
    drawPaths(34, 'rgba(140,200,100,0.55)');   // worn, lighter grass along the verges
    drawPaths(20, '#c79b68');   // dirt border
    drawPaths(13, '#e2c08a');   // lighter, worn centre

    // a worn, slightly brighter clearing around each building
    ctx.fillStyle = '#7bbb53';
    for (const d of Object.values(districts)) {
      const p = d.clearing;
      ctx.beginPath();
      ctx.moveTo((p[p.length - 1].x + p[0].x) / 2, (p[p.length - 1].y + p[0].y) / 2);
      for (let i = 0; i < p.length; i++) {
        const nx = p[(i + 1) % p.length];
        ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + nx.x) / 2, (p[i].y + nx.y) / 2);
      }
      ctx.fill();
    }

    // the paved plaza: a ring of stone flags around the central fountain
    ctx.fillStyle = '#b9b2a6';
    ctx.beginPath(); ctx.arc(cx, cy, 64, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a49d90';
    ctx.beginPath(); ctx.arc(cx, cy, 64, 0, Math.PI * 2);
    ctx.arc(cx, cy, 52, 0, Math.PI * 2); ctx.fill('evenodd');
    // flagstone seams
    ctx.strokeStyle = 'rgba(90,84,74,0.35)'; ctx.lineWidth = 1.5;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 34, cy + Math.sin(a) * 34);
      ctx.lineTo(cx + Math.cos(a) * 63, cy + Math.sin(a) * 63);
      ctx.stroke();
    }
    drawFountain(cx, cy, t);

    // flat ground litter: grass tufts and little flower clusters
    for (const g of decor) {
      if (g.kind === 'tuft') {
        ctx.fillStyle = '#4e9a34';                 // a shade darker than the turf so it reads
        ctx.fillRect(g.x, g.y, 3, 5);
        ctx.fillRect(g.x + 4, g.y + 2, 3, 4);
        ctx.fillStyle = '#8fd46a';                 // a lit tip
        ctx.fillRect(g.x + 2, g.y - 2, 2, 4);
      } else {
        drawFlowers(g.x, g.y, g.seed);
      }
    }

    // ONE depth-sorted pass over everything that stands on the ground. Now that
    // villagers roam the whole field instead of a plot, they walk BEHIND the
    // buildings as often as in front of them — so a building can't have its own
    // earlier pass any more or every walker would stroll over its roof. Each
    // entry sorts on the y its feet touch, and draws when its turn comes.
    const scene = [];

    // each district's own business building on its point — a house also draws
    // the add-ons its resident bolted on (lean-tos before the sprite so it
    // overlaps them and they read as attached; roof pieces after)
    for (const d of Object.values(districts)) {
      scene.push({ y: d.y, draw: () => {
        // a house district ("house_<id>") reuses the one house building; every
        // other district has its own art keyed by its name.
        const isHouse = d.key.startsWith('house_');
        const adds = Array.isArray(d.addons) ? d.addons : [];
        for (const a of adds) if (a.side !== 'top') drawAddon(a.kind, a.side, d.x, d.y);
        const img = art[d.key] || (isHouse ? art.house : null);
        if (img) {
          drawSprite(img, d.x, d.y, 100, 128);
        } else {
          ctx.font = '40px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText(isHouse ? '🏠' : '🏛️', d.x, d.y - 46);
        }
        for (const a of adds) if (a.side === 'top') drawAddon(a.kind, 'top', d.x, d.y);
        // the building's own little activity animation, over its roof
        drawActivity(d.key, d.x, d.y, now, t, activeKeys.has(d.key));
      } });
      // the resident's yard: each prop sorts on its own feet so walkers weave through
      for (const it of (Array.isArray(d.yard) ? d.yard : [])) {
        const px = d.x + it.x, py = d.y + it.y;
        scene.push({ y: py, draw: () => drawYardItem(it.kind, px, py, now, t) });
      }
    }
    // the trees and shrubs stand in the same pass — a villager walks behind an
    // oak as naturally as behind a house
    for (const g of greenery) {
      scene.push({ y: g.y, draw: () => (g.kind === 'tree' ? drawTree(g.x, g.y, g.size) : drawShrub(g.x, g.y, g.size)) });
    }

    // structures the agents put up (or are still putting up)
    for (const st of placedStructs) {
      scene.push({ y: st.y + 14, draw: () => {
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
      } });
    }

    // townsfolk (and the owner), sorting among the buildings on the same axis
    const walkers = [...sprites.values(), ...(Number.isFinite(me.x) ? [me] : [])];
    for (const sp of walkers) scene.push({ y: sp.y, draw: () => drawWalker(sp, now, t) });

    scene.sort((a, b) => a.y - b.y);
    for (const e of scene) e.draw();

    // particles over the rooftops: smoke rises out of the kitchen chimney and
    // must not be hidden by the roof it comes out of
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

    // Names, signs, hearts and speech last, over the whole scene. They are
    // labels ABOUT the world rather than things standing in it, so a villager
    // walking past a shop must never cut its sign in half.
    for (const d of Object.values(districts)) label(d.label.toUpperCase(), d.x, d.y + 14, 10);
    for (const st of placedStructs) label(String(st.name || '').slice(0, 14), st.x, st.y + 26, 9);
    for (const sp of walkers) {
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

    // the enclosing town wall frames everything, drawn last so grass, paths and
    // strays never bleed onto the stone
    drawWall(W, H);
  }

  // one villager, drawn where they stand — called from the depth-sorted pass
  function drawWalker(sp, now, t) {
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

  // Dyer HQ from the inside: a pixel office (pixel-agents tiles) where the whole
  // team sits at desks and works through the day. One desk per villager; whoever
  // is clocked in at HQ is seated at theirs, the rest sit empty until they return.
  function drawOffice(now, t) {
    const { width: W, height: H } = canvas;
    ctx.imageSmoothingEnabled = false;
    const wallH = Math.max(64, Math.floor(H / 3));

    // floor tiles
    if (office.floor) {
      const s = 4, tw = office.floor.width * s, th = office.floor.height * s;
      for (let y = wallH; y < H; y += th) for (let x = 0; x < W; x += tw) ctx.drawImage(office.floor, x, y, tw, th);
    } else { ctx.fillStyle = '#8a8f98'; ctx.fillRect(0, wallH, W, H - wallH); }
    // wall band
    if (office.wall) {
      const ww = office.wall.width * (wallH / office.wall.height);
      for (let x = 0; x < W; x += ww) ctx.drawImage(office.wall, x, 0, ww, wallH);
    } else { ctx.fillStyle = '#cfc3ad'; ctx.fillRect(0, 0, W, wallH); }
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, wallH - 7, W, 7);

    // wall + corner decor
    const put = (img, cx, bottom, s) => { if (img) ctx.drawImage(img, cx - img.width * s / 2, bottom - img.height * s, img.width * s, img.height * s); };
    put(office.whiteboard, W * 0.5, wallH * 0.86, 3);
    put(office.plant, 34, wallH + 46, 4);
    put(office.plant, W - 34, wallH + 46, 4);

    // plaque: whose place this is + how many are in
    const roster = [...sprites.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const working = roster.filter(sp => sp.loc === HQ_KEY).length;
    const pw = 240;
    ctx.fillStyle = '#7a5a38'; ctx.fillRect(W / 2 - pw / 2, wallH - 48, pw, 34);
    ctx.fillStyle = '#9a774c'; ctx.fillRect(W / 2 - pw / 2 + 3, wallH - 45, pw - 6, 28);
    label('Dyer HQ', W / 2, wallH - 33, 12);
    label(working ? `${working} at work` : 'the office is quiet after hours', W / 2, wallH - 20, 9);

    // desks: a bullpen, one per villager. Row-major draw order means a front
    // row is painted after the row behind it, so it overlaps correctly.
    const n = Math.max(roster.length, 1);
    const cols = Math.min(4, n), rows = Math.ceil(n / cols);
    const areaY = wallH + 30, areaH = H - wallH - 84, cellW = W / cols, cellH = areaH / rows;
    roster.forEach((sp, i) => {
      const cx = (i % cols) * cellW + cellW / 2;
      const deskBottom = areaY + Math.floor(i / cols) * cellH + cellH * 0.72;
      drawWorkstation(sp, cx, deskBottom, cellW, t);
    });

    // the way out (same rect the click handler leaves through) + you by the door
    const dr = roomDoorRect();
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(dr.x - 5, dr.y - 5, dr.w + 10, dr.h + 5);
    ctx.fillStyle = '#6b4a2f'; ctx.fillRect(dr.x, dr.y, dr.w, dr.h);
    ctx.fillStyle = '#8a6540'; ctx.fillRect(dr.x + 4, dr.y + 4, dr.w - 8, dr.h - 4);
    ctx.fillStyle = '#e8d9a0'; ctx.fillRect(dr.x + dr.w - 12, dr.y + dr.h / 2 - 2, 4, 4);
    drawOccupant(me, dr.x - 36, dr.y + 24, t);
    const chip = leaveChip();
    ctx.fillStyle = 'rgba(253,253,244,0.92)'; ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.roundRect(chip.x, chip.y, chip.w, chip.h, 8); ctx.fill(); ctx.stroke();
    label('⬅ leave', chip.x + chip.w / 2, chip.y + 17, 11);
  }

  // one desk: chair behind, the villager (if clocked in) seated, the desk in
  // front of their legs, a PC on top with its screen on — busy at work.
  function drawWorkstation(sp, cx, deskBottom, cellW, t) {
    const dw = office.desk ? office.desk.width : 48, dh = office.desk ? office.desk.height : 32;
    const s = Math.min(cellW * 0.72, 150) / dw;
    const dW = dw * s, dH = dh * s, deskY = deskBottom - dH;
    if (office.chair) { const cs = s * 1.3, cw = office.chair.width * cs, ch = office.chair.height * cs;
      ctx.drawImage(office.chair, cx - cw / 2, deskY - ch * 0.35, cw, ch); }
    if (sp.loc === HQ_KEY) {
      const img = art[`${sp.artKey}_front`] || (sp.artKey && art[sp.artKey]);
      if (img) {
        const vh = dH * 2.0, vw = img.width * vh / img.height;
        const bob = Math.sin((t + sp.hue * 40) / 260) * 1.5;   // a little "typing"
        ctx.drawImage(img, cx - vw / 2, deskY - vh * 0.60 + bob, vw, vh);
      } else {
        ctx.fillStyle = `hsl(${sp.hue} 45% 45%)`;
        ctx.beginPath(); ctx.arc(cx, deskY - dH * 0.6, 12, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (office.desk) ctx.drawImage(office.desk, cx - dW / 2, deskY, dW, dH);
    else { ctx.fillStyle = '#8a6540'; ctx.fillRect(cx - dW / 2, deskY, dW, dH); }
    if (office.pc) { const pw = office.pc.width * s, ph = office.pc.height * s;
      ctx.drawImage(office.pc, cx - pw / 2, deskY - ph * 0.5, pw, ph); }
    label(String(sp.name || '').slice(0, 12), cx, deskBottom + 12, 9);
  }

  function drawRoom(now, t) {
    if (inside && inside.key === HQ_KEY) return drawOffice(now, t);
    const { width: W, height: H } = canvas;
    ctx.imageSmoothingEnabled = false;   // same crisp pixels indoors
    // a house with extra rooms paints whichever room's tab is active (roomKey);
    // the main room is the house's own interior entry
    const it = interiors[roomKey || inside.key];
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

    // a house with extra rooms gets a row of room tabs along the top of the wall:
    // the main room first, then each room the resident added. Their hit-rects
    // are kept for the click handler.
    roomTabs = [];
    const extra = (inside.type === 'district' && Array.isArray(rooms[inside.key])) ? rooms[inside.key] : [];
    if (extra.length) {
      const tabs = [{ key: inside.key, name: 'Main room' }, ...extra];
      let tx = 10;
      ctx.font = '700 11px system-ui'; ctx.textAlign = 'left';
      for (const tab of tabs) {
        const on = (roomKey || inside.key) === tab.key;
        const w = ctx.measureText(tab.name).width + 18;
        ctx.fillStyle = on ? 'rgba(253,253,244,0.92)' : 'rgba(0,0,0,0.28)';
        ctx.beginPath(); ctx.roundRect(tx, 8, w, 22, 7); ctx.fill();
        ctx.fillStyle = on ? '#33281a' : 'rgba(255,255,255,0.9)';
        ctx.fillText(tab.name, tx + 9, 23);
        roomTabs.push({ x: tx, y: 8, w, h: 22, key: tab.key });
        tx += w + 6;
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
      // a room tab along the top switches which room is painted
      const tab = roomTabs.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
      if (tab) { roomKey = tab.key === inside.key ? null : tab.key; return; }
      const chip = leaveChip();
      const dr = roomDoorRect();
      if ((x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h)
        || (x >= dr.x - 8 && x <= dr.x + dr.w + 8 && y >= dr.y - 8)) {
        inside = null; roomKey = null; roomTabs = [];   // back to town, right where we stood
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
      showTab('talk');                       // the chat box lives in the Talk pane now
      root.querySelector('#town-say').focus();
      return;
    }
    // a business building (or a FINISHED structure — scaffolding keeps you
    // out) near the click? walk to a door point just below it, enter on arrival
    let hit = null, hitD = Infinity;
    for (const d of Object.values(districts)) {
      const dd = Math.hypot(x - d.x, y - (d.y - 42));   // the building's middle
      if (dd < 52 && dd < hitD) {
        hitD = dd;
        hit = { type: 'district', key: d.key, name: d.label, owner: 'Dyer Town',
          loc: d.key, door: { x: d.x, y: d.y + 12 } };
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
      <p class="muted">Dyer Town runs on your own PC — start it there
      (<code>run-town.bat</code>, or <code>npm start</code> in the agent-town folder)
      and it appears here live.</p>
      ${when ? `<p class="muted">Last seen ${esc(when)}.</p>` : ''}
      <p class="muted">If it IS running, give it a few seconds — the town checks in
      about every 15 seconds.</p>`;
  }

  let townAlert = null; // last plain-language status pushed by the town (or null)
  function paint(d) {
    if (!d.online || !d.state) { paintOffline(d.updatedAt); return; }
    grid.hidden = false;
    offline.hidden = true;
    const s = d.state;

    // a plain-language reason the town looks stuck (model unreachable, etc.)
    townAlert = s.alert || null;
    const alertEl = root.querySelector('#town-alert');
    if (alertEl) { alertEl.textContent = townAlert || ''; alertEl.hidden = !townAlert; }

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

    // the status strip: a village at a glance — headcount, who's on the job,
    // open work on the board, morale and the town clock
    const statsEl = root.querySelector('#town-stats');
    if (statsEl) {
      const ags = s.agents || [];
      const working = ags.filter(a => a.busy).length;
      const openJobs = (s.jobs || []).filter(j => !j.done && !j.holder).length;
      const now = new Date();
      const clock = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const mPct = Number.isFinite(morale) ? Math.round(Math.max(0, Math.min(100, morale))) : null;
      const cell = (k, v, cls = '') => `<div class="stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
      statsEl.innerHTML =
        cell('Villagers', ags.length) +
        cell('Working', `${working}<small>/${ags.length}</small>`, 'work') +
        cell('Open work', openJobs, 'open') +
        (mPct == null ? '' : cell('Morale', mPct)) +
        cell('Time', clock);
    }
    // the Inbox tab wears a badge while corporate has something waiting
    const inboxBadge = root.querySelector('#tab-badge-inbox');
    if (inboxBadge) {
      const pending = (s.approvals || []).filter(a => a && a.status === 'pending').length;
      inboxBadge.textContent = String(pending);
      inboxBadge.hidden = !pending;
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
      if (alive) { paint(d); lastState = d.state; feedPixelOffice(d.state); if (d.updatedAt) lastSeenAt = d.updatedAt; }
    } catch {
      if (alive) paintOffline(null);
    }
  }

  /* Chat. The Worker keeps an unanswered message until the engine answers it
     (and an answered one for a week), so a late answer can always be fetched
     by id. The old version polled for two minutes and then gave up — and the
     engine, mid way through a villager's twenty-minute work session, answers
     later than that. So: keep listening for half an hour with an honest
     status line, remember what is still unanswered across reloads, and pick
     the answer up whenever it lands. */
  const PENDING_KEY = 'town.pendingChats';
  const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } };
  const writePending = list => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-20))); } catch { /* storage unavailable — this tab still listens */ } };
  const forgetPending = id => writePending(readPending().filter(p => p.id !== id));
  let lastSeenAt = null; // when the town last pushed state, from /api/town/state
  const ago = ts => {
    const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
    return !Number.isFinite(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const scrollLog = () => { const log = root.querySelector('#town-chatlog'); if (log) log.scrollTop = log.scrollHeight; };

  function waitingText(p, elapsedMs) {
    if (elapsedMs < 120000) return p.toAll ? 'the town is gathering at the plaza…' : '…';
    const who = p.toAll ? 'the town' : (p.name || 'they');
    const mins = Math.round(elapsedMs / 60000);
    const seen = lastSeenAt ? ` The town last checked in ${ago(lastSeenAt)}.` : ' The town has not checked in since this page opened.';
    return `(still waiting — your message is queued at the town, and ${who} will answer when the current task lets go. ${mins} min so far.${seen} This keeps listening, even after a reload.)`;
  }

  // poll one message until its answer lands: every 3s for two minutes, then
  // every 10s, for up to 30 minutes (45 for a town meeting)
  async function awaitReply(p, bubble) {
    const start = new Date(p.at || Date.now()).getTime();
    const limit = (p.toAll ? 45 : 30) * 60000;
    while (alive) {
      const poll = await fetch(`/api/town/chat/${p.id}`)
        .then(r => r.ok ? r.json() : (r.status === 404 ? { gone: true } : null))
        .catch(() => null);
      if (poll?.reply) { bubble.textContent = poll.reply; forgetPending(p.id); scrollLog(); return; }
      if (poll?.gone) { bubble.textContent = '(that message is no longer on file at the town)'; forgetPending(p.id); return; }
      const elapsed = Date.now() - start;
      if (elapsed > limit) {
        // still on file at the town; a reload asks again, and the Feed shows the answer when it comes
        bubble.textContent = townAlert || `(no answer after ${Math.round(limit / 60000)} minutes — the town is not picking up chat right now. Your message stays queued: ${p.toAll ? 'the town' : (p.name || 'they')} will answer the next time the inbox is read, and the Feed will show it.)`;
        return;
      }
      bubble.textContent = waitingText(p, elapsed);
      await new Promise(r => setTimeout(r, elapsed < 120000 ? 3000 : 10000));
    }
  }

  function addChatRow(p) {
    const log = root.querySelector('#town-chatlog');
    log.insertAdjacentHTML('beforeend',
      `<div class="town-msg me">${p.toAll ? '📣 ' : (p.name ? `<b>${esc(p.name)}</b> · ` : '')}${esc(p.message)}</div>`);
    const bubble = document.createElement('div');
    bubble.className = 'town-msg them';
    bubble.style.whiteSpace = 'pre-line'; // a meeting reply is one line per villager
    bubble.textContent = p.toAll ? 'the town is gathering at the plaza…' : '…';
    log.append(bubble);
    scrollLog();
    return bubble;
  }

  // messages still unanswered when the page was last closed come back with
  // their bubbles and keep listening (anything older than a day is let go)
  function restorePending() {
    const keep = readPending().filter(p => p && p.id && Date.now() - new Date(p.at || 0).getTime() < 24 * 3600000);
    writePending(keep);
    for (const p of keep) awaitReply(p, addChatRow(p));
  }

  // send a message, then keep listening for the villager's answer
  async function sendChat(toAll = false) {
    const who = root.querySelector('#town-who');
    const agentId = toAll ? 'all' : who.value;
    const name = toAll ? '' : (who.selectedOptions?.[0]?.textContent || '').trim();
    const input = root.querySelector('#town-say');
    const message = input.value.trim();
    if (!agentId || !message) return;
    input.value = '';
    const bubble = addChatRow({ toAll, name, message });
    try {
      const res = await fetch('/api/town/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, message }),
      });
      const { id } = await res.json();
      if (!res.ok || !id) throw new Error();
      const p = { id, agentId, name, message, toAll, at: Date.now() };
      writePending([...readPending(), p]);
      await awaitReply(p, bubble);
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
  restorePending();
  timer = setInterval(() => { refresh(); refreshApprovals(); }, 5000);

  return function unmount() {
    alive = false;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeydown);
  };
}
