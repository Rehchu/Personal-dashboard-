// Dragon Vault — 3D viewer for the book's worldbuilding assets (.glb files
// streamed from a public GitHub repo, 12–17 MB each). Renders via Google's
// <model-viewer> web component, lazy-loaded from jsDelivr exactly once.
// Note: model-viewer markup is built from constants only — nothing here is
// user-entered, and the element itself must NOT be wrapped in esc().

const STYLE_ID = 'dragons-style';
const VIEWER_SRC = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js';
const REPO_URL = 'https://github.com/Rehchu/3d-models';

const MODELS = [
  {
    id: 'stoker',
    name: 'Stoker-class Dragon',
    src: 'https://raw.githubusercontent.com/Rehchu/3d-models/main/StokerClassDragon.glb',
    page: 'https://github.com/Rehchu/3d-models/blob/main/StokerClassDragon.glb',
  },
  {
    id: 'egg',
    name: 'Dragon Egg',
    src: 'https://raw.githubusercontent.com/Rehchu/3d-models/main/Green%20dragon%20egg.glb',
    page: 'https://github.com/Rehchu/3d-models/blob/main/Green%20dragon%20egg.glb',
  },
];

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .drg-model-btn.active { border-color: var(--accent); color: var(--ink); background: color-mix(in oklab, var(--accent) 18%, transparent); }
    .drg-stage model-viewer { display: block; border-radius: var(--tile-radius); }
    .drg-note { margin: 0 0 8px; }
    .drg-foot { margin: 10px 0 0; }
    .drg-foot a { color: var(--accent); }`;
  document.head.append(style);
}

// Inject the <model-viewer> module script exactly once, no matter how many
// times this module mounts. onFail fires only if the CDN script itself dies.
function ensureModelViewer(onFail) {
  if (customElements.get('model-viewer')) return;
  if (document.querySelector(`script[src="${VIEWER_SRC}"]`)) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = VIEWER_SRC;
  script.addEventListener('error', onFail);
  document.head.append(script);
}

export function mount(root, tools) {
  ensureStyle();

  root.innerHTML = `
    <section class="panel">
      <h3>Dragon Vault</h3>
      <p class="muted drg-note"></p>
      <div class="drg-stage"></div>
      <p class="muted drg-foot">Worldbuilding assets for the book · models live at
        <a href="${REPO_URL}" target="_blank" rel="noopener">github.com/Rehchu/3d-models</a></p>
    </section>`;

  const note = root.querySelector('.drg-note');
  const stage = root.querySelector('.drg-stage');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let current = MODELS[0];

  // One long-lived viewer element; selection just swaps its src. The element
  // upgrades in place once the lazy-loaded component definition arrives.
  const viewer = document.createElement('model-viewer');
  viewer.setAttribute('camera-controls', '');
  viewer.setAttribute('rotation-per-second', '18deg');
  viewer.setAttribute('shadow-intensity', '1');
  viewer.setAttribute('exposure', '1');
  viewer.style.cssText = 'width:100%;height:min(62vh,640px);background:var(--surface)';
  stage.append(viewer);

  function applyMotion() {
    if (motion.matches) viewer.removeAttribute('auto-rotate');
    else viewer.setAttribute('auto-rotate', '');
  }

  function showOffline() {
    note.hidden = false;
    note.innerHTML = `Couldn't stream ${current.name} — you may be offline.
      Grab the file on <a href="${current.page}" target="_blank" rel="noopener">GitHub</a> instead.`;
  }

  const onLoad = () => { note.hidden = true; };
  const onError = () => showOffline();

  function select(model) {
    current = model;
    for (const b of tools.querySelectorAll('.drg-model-btn')) {
      const on = b.dataset.model === model.id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    note.hidden = false;
    note.textContent = 'Streaming dragon… ~12–17 MB, give it a moment.';
    viewer.setAttribute('alt', `3D model: ${model.name}`);
    viewer.setAttribute('src', model.src);
  }

  const buttons = MODELS.map(m => {
    const b = document.createElement('button');
    b.className = 'btn small drg-model-btn';
    b.dataset.model = m.id;
    b.textContent = m.name;
    b.addEventListener('click', () => select(m));
    tools.append(b);
    return b;
  });

  viewer.addEventListener('load', onLoad);
  viewer.addEventListener('error', onError);
  motion.addEventListener('change', applyMotion);

  ensureModelViewer(showOffline);
  applyMotion();
  select(current);

  return function unmount() {
    motion.removeEventListener('change', applyMotion);
    viewer.removeEventListener('load', onLoad);
    viewer.removeEventListener('error', onError);
    viewer.remove(); // detaching the element halts auto-rotate + rendering
    buttons.forEach(b => b.remove());
  };
}
