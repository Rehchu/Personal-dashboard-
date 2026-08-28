// Claude Archive — organized, searchable local archive of exported claude.ai
// history, plus the memories text. Everything stays on this device (IndexedDB
// + localStorage); nothing is uploaded anywhere.

import { load, save, esc, showToast } from './store.js';

const DB_NAME = 'pd-archive';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('convos')) {
        db.createObjectStore('convos', { keyPath: 'uuid' }).createIndex('updated', 'updated');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db, store, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(store, mode);
  const result = fn(t.objectStore(store));
  t.oncomplete = () => resolve(result);
  t.onerror = () => reject(t.error);
});

function msgText(m) {
  if (typeof m.text === 'string' && m.text) return m.text;
  if (Array.isArray(m.content)) return m.content.map(c => c?.text || '').filter(Boolean).join('\n');
  return '';
}

function normalize(raw) {
  // Tolerate every export shape seen so far: a bare array, {conversations:[…]},
  // or any wrapper object whose values include the conversations array.
  let list = Array.isArray(raw) ? raw : raw?.conversations;
  if (!Array.isArray(list) && raw && typeof raw === 'object') {
    list = Object.values(raw).find(v =>
      Array.isArray(v) && v.length && typeof v[0] === 'object' && (v[0].chat_messages || v[0].messages));
  }
  if (!Array.isArray(list)) throw new Error('no conversations found in this file');
  return list.filter(c => c && (c.uuid || c.id)).map(c => ({
    uuid: c.uuid || c.id,
    name: c.name || c.title || c.summary || '(untitled chat)',
    created: c.created_at || c.created || '',
    updated: c.updated_at || c.updated || c.created_at || c.created || '',
    msgs: (c.chat_messages || c.messages || []).map(m => ({
      s: (m.sender || m.role) === 'human' || (m.sender || m.role) === 'user' ? 'h' : 'a',
      t: msgText(m),
    })).filter(m => m.t),
  }));
}

function parseExportText(text) {
  try {
    return JSON.parse(text);
  } catch {
    // JSONL fallback: one conversation object per line
    const rows = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
    return rows;
  }
}

let jszipLoading = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipLoading) {
    jszipLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('could not load the zip reader (offline?)'));
      document.head.append(s);
    });
  }
  return jszipLoading;
}

// Returns { convosText, memoriesText } from a claude.ai export zip.
async function readExportZip(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  const convoEntry =
    names.find(n => /conversation/i.test(n) && /\.jsonl?$/i.test(n)) ||
    names.filter(n => /\.jsonl?$/i.test(n)).sort((a, b) => zip.files[b]._data?.uncompressedSize - zip.files[a]._data?.uncompressedSize)[0];
  const memEntry = names.find(n => /memor/i.test(n) && /\.(json|md|txt)$/i.test(n));
  return {
    convosText: convoEntry ? await zip.files[convoEntry].async('string') : null,
    memoriesText: memEntry ? await zip.files[memEntry].async('string') : null,
  };
}

const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const monthKey = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Undated');

/* ---------- auto-categorization (on-device, keyword-scored) ---------- */

const CATS = [
  { id: 'dragons', name: 'Dragon Book', emoji: '🐉', kw: ['dragon', 'stoker', 'wyvern', 'book', 'chapter', 'novel', 'manuscript', 'worldbuild', 'plot', 'character', 'scene', 'writing'] },
  { id: 'church', name: 'Church & Arise', emoji: '⛪', kw: ['church', 'arise', 'bible', 'verse', 'sermon', 'ministry', 'worship', 'pastor', 'prayer', 'sunday', 'check-in', 'chms'] },
  { id: 'shop', name: 'PC Repair Shop', emoji: '🖥️', kw: ['repair', 'ctrl', 'pc build', 'ticket', 'invoice', 'customer', 'stripe', 'paypal', 'inventory', 'pos ', 'warranty', 'rma', 'prebuilt'] },
  { id: 'fitness', name: 'Fitness', emoji: '💪', kw: ['workout', 'gym', 'fitness', 'exercise', 'protein', 'weight', 'training', 'apex', 'coach', 'muscle', 'cardio'] },
  { id: 'code', name: 'Coding & Projects', emoji: '💻', kw: ['code', 'javascript', 'typescript', 'react', 'cloudflare', 'worker', 'api', 'github', 'deploy', 'database', 'sql', 'css', 'html', 'bug', 'error', 'function', 'app', 'server', 'dashboard'] },
  { id: 'design', name: 'Design & 3D', emoji: '🎨', kw: ['design', 'logo', 'blender', '3d model', 'render', 'canva', 'mockup', 'poster', 'artwork', 'glb'] },
  { id: 'business', name: 'Business & Money', emoji: '📈', kw: ['business', 'marketing', 'price', 'pricing', 'tax', 'llc', 'revenue', 'sales', 'budget', 'money'] },
  { id: 'life', name: 'Life & Home', emoji: '🏠', kw: ['recipe', 'cook', 'car', 'house', 'home', 'family', 'travel', 'trip', 'health', 'doctor', 'insurance', 'gift'] },
];

const CAT_BY_ID = Object.fromEntries(CATS.map(c => [c, c] && [c.id, c]));
const OTHER = { id: 'other', name: 'Everything Else', emoji: '💬' };

function categorize(c) {
  const title = c.name.toLowerCase();
  // titles carry most signal; sample the first chunk of the transcript too
  const body = c.msgs.map(m => m.t).join(' ').slice(0, 2000).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const cat of CATS) {
    let score = 0;
    for (const k of cat.kw) {
      if (title.includes(k)) score += 3;
      else if (body.includes(k)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return bestScore >= 2 ? best.id : 'other';
}

const catOf = c => CAT_BY_ID[c.cat] || (c.cat === 'other' ? OTHER : CAT_BY_ID[categorize(c)] || OTHER);

export function mount(root, tools) {
  let db = null;
  let count = load('archive.count', 0);
  let msgCount = load('archive.msgs', 0);
  let dead = false;

  tools.innerHTML = `
    <span class="muted" id="ar-count"></span>
    <label class="btn small" style="cursor:pointer">⬆ Import
      <input id="ar-file" type="file" accept=".json,.jsonl,.zip,application/json,application/zip" hidden></label>`;

  root.innerHTML = `
    <style id="archive-style">
      .ar-row { display:block; width:100%; text-align:left; padding:10px 14px; border-radius: var(--panel-radius);
        margin-bottom:6px; background: color-mix(in oklab, var(--surface) 88%, transparent);
        border:1px solid color-mix(in oklab, var(--ink-3) 20%, transparent); }
      .ar-row:hover { border-color: var(--accent); }
      .ar-row .t { font-family: var(--font-display); font-weight:700; }
      .ar-row .m { color: var(--ink-3); font-size: 13px; margin-top:2px; }
      .ar-row .snip { color: var(--ink-2); font-size: 14px; margin-top:4px; }
      .ar-month { font-family: var(--font-display); font-size:13px; letter-spacing:.1em; text-transform:uppercase;
        color: var(--ink-3); margin: 16px 0 8px; }
      .ar-msg { max-width: 72ch; padding: 10px 14px; border-radius: 12px; margin-bottom: 10px;
        white-space: pre-wrap; overflow-wrap: break-word; font-size: 15px; line-height:1.55; }
      .ar-msg.h { margin-left:auto; background: color-mix(in oklab, var(--accent) 20%, var(--surface)); }
      .ar-msg.a { margin-right:auto; background: color-mix(in oklab, var(--surface-2) 92%, transparent); }
    </style>
    <div id="ar-main"></div>`;

  const main = root.querySelector('#ar-main');
  const countEl = tools.querySelector('#ar-count');
  const setCount = () => { countEl.textContent = count ? `${count.toLocaleString()} chats` : ''; };
  setCount();

  let activeCat = 'all'; // category menu selection

  function browseHTML() {
    return `
      <div class="stat-row">
        <div class="stat-tile"><div class="stat-value">${count.toLocaleString()}</div><div class="stat-label">conversations</div></div>
        <div class="stat-tile"><div class="stat-value">${msgCount.toLocaleString()}</div><div class="stat-label">messages</div></div>
        <div class="stat-tile"><div class="stat-value">🔒</div><div class="stat-label">on-device only</div></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <h3>Categories</h3>
        <div id="ar-cats" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <h3>Search ${activeCat === 'all' ? 'everything' : 'this category'}</h3>
        <input id="ar-q" placeholder="Search your Claude history and memories…" style="width:100%">
        <div id="ar-results"></div>
      </div>
      <div class="grid-2">
        <div class="panel"><h3>Conversations</h3><div id="ar-list" class="muted">Loading…</div></div>
        <div class="panel"><h3>Memories</h3>
          <p class="muted" style="margin-bottom:8px">Paste what Claude remembers about you (claude.ai → Settings → Memory). Searched along with your chats.</p>
          <textarea id="ar-mem" style="width:100%;min-height:140px">${esc(load('memories', ''))}</textarea>
          <button class="btn small" id="ar-mem-save" style="margin-top:8px">Save memories</button>
        </div>
      </div>
      ${count ? '<p style="margin-top:16px"><button class="btn small danger" id="ar-del">✕ Delete archive from this device</button></p>' : ''}
      ${count ? '' : `
      <div class="panel" style="margin-top:16px"><h3>How to fill this</h3>
        <p class="muted"><strong>claude.ai → Settings → Privacy → Export data</strong> gives you download links (works on your phone too). Download <code>conversations-000.zip</code> and import it here as-is — no unzipping needed. The <code>memories-000.zip</code> imports the same way. Re-import any time — chats merge by ID, nothing duplicates.</p>
      </div>`}`;
  }

  async function renderCats() {
    const tally = { all: 0 };
    await tx(db, 'convos', 'readonly', store => {
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        const id = catOf(cur.value).id;
        tally[id] = (tally[id] || 0) + 1;
        tally.all++;
        cur.continue();
      };
    });
    if (dead) return;
    const el = main.querySelector('#ar-cats');
    if (!el) return;
    const chips = [{ id: 'all', name: 'All', emoji: '🗂️' }, ...CATS, OTHER]
      .filter(c => c.id === 'all' || tally[c.id])
      .map(c => `<button class="btn small" data-cat="${c.id}"
        style="${activeCat === c.id ? 'border-color:var(--accent);color:var(--ink);' : ''}">
        ${c.emoji} ${esc(c.name)}${c.id === 'all' ? '' : ` · ${tally[c.id]}`}</button>`);
    el.innerHTML = chips.join('') || '<span class="muted">Import chats to see categories.</span>';
    // feed the dashboard activity cards
    const top = Object.entries(tally).filter(([k]) => k !== 'all').sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const cat = CAT_BY_ID[top[0]] || OTHER;
      save('archive.topcat', `${cat.emoji} ${cat.name}`);
      save('archive.catcount', Object.keys(tally).length - 1);
    }
    el.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => {
      activeCat = b.dataset.cat;
      renderBrowse();
    }));
  }

  const inCat = c => activeCat === 'all' || catOf(c).id === activeCat;

  async function listNewest() {
    const rows = [];
    await tx(db, 'convos', 'readonly', store => {
      const idx = store.index('updated');
      idx.openCursor(null, 'prev').onsuccess = e => {
        const cur = e.target.result;
        if (!cur || rows.length >= 30) return;
        if (inCat(cur.value)) rows.push(cur.value);
        cur.continue();
      };
    });
    if (dead) return;
    const listEl = main.querySelector('#ar-list');
    if (!rows.length) { listEl.textContent = count ? 'Nothing in this category yet.' : 'Nothing imported yet.'; return; }
    let lastMonth = '';
    listEl.classList.remove('muted');
    listEl.innerHTML = rows.map(c => {
      const mk = monthKey(c.updated);
      const head = mk !== lastMonth ? `<div class="ar-month">${esc(mk)}</div>` : '';
      lastMonth = mk;
      const cat = catOf(c);
      return `${head}<button class="ar-row" data-open="${esc(c.uuid)}">
        <div class="t">${esc(c.name)}</div>
        <div class="m">${cat.emoji} ${esc(cat.name)} · ${esc(fmtDate(c.updated))} · ${c.msgs.length} messages</div></button>`;
    }).join('');
  }

  async function search(q) {
    const needle = q.toLowerCase();
    const hits = [];
    const mem = load('memories', '');
    if (activeCat === 'all' && mem.toLowerCase().includes(needle)) {
      const i = mem.toLowerCase().indexOf(needle);
      hits.push({ mem: true, snip: mem.slice(Math.max(0, i - 40), i + 90) });
    }
    await tx(db, 'convos', 'readonly', store => {
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur || hits.length >= 50) return;
        const c = cur.value;
        if (!inCat(c)) { cur.continue(); return; }
        if (c.name.toLowerCase().includes(needle)) {
          hits.push({ c, snip: '' });
        } else {
          for (const m of c.msgs) {
            const i = m.t.toLowerCase().indexOf(needle);
            if (i >= 0) { hits.push({ c, snip: m.t.slice(Math.max(0, i - 40), i + 90) }); break; }
          }
        }
        cur.continue();
      };
    });
    if (dead) return;
    main.querySelector('#ar-results').innerHTML = hits.length
      ? hits.map(h => h.mem
        ? `<button class="ar-row"><div class="t">🧠 Memory</div><div class="snip">…${esc(h.snip)}…</div></button>`
        : `<button class="ar-row" data-open="${esc(h.c.uuid)}">
            <div class="t">${esc(h.c.name)}</div><div class="m">${esc(fmtDate(h.c.updated))}</div>
            ${h.snip ? `<div class="snip">…${esc(h.snip)}…</div>` : ''}</button>`).join('')
      : '<p class="muted" style="margin-top:8px">No matches.</p>';
  }

  async function openConvo(uuid) {
    const c = await tx(db, 'convos', 'readonly', s => {
      const out = {};
      s.get(uuid).onsuccess = e => { out.v = e.target.result; };
      return out;
    }).then(o => o.v);
    if (!c || dead) return;
    main.innerHTML = `
      <p><button class="btn small" id="ar-back">‹ Archive</button>
        <a class="btn small" target="_blank" rel="noopener" href="https://claude.ai/chat/${esc(c.uuid)}">↗ open on claude.ai</a></p>
      <h3 style="font-family:var(--font-display);margin:14px 0 4px">${esc(c.name)}</h3>
      <p class="muted" style="margin-bottom:16px">${esc(fmtDate(c.created))} · ${c.msgs.length} messages</p>
      ${c.msgs.map(m => `<div class="ar-msg ${m.s}">${esc(m.t)}</div>`).join('')}`;
    main.querySelector('#ar-back').addEventListener('click', renderBrowse);
    root.closest('#appview-body')?.scrollTo(0, 0);
  }

  function wireBrowse() {
    main.querySelector('#ar-q').addEventListener('input', e => {
      const q = e.target.value.trim();
      if (q.length >= 2) search(q);
      else main.querySelector('#ar-results').innerHTML = '';
    });
    main.querySelector('#ar-mem-save').addEventListener('click', () => {
      save('memories', main.querySelector('#ar-mem').value);
      showToast('Memories saved (on-device)');
    });
    main.querySelector('#ar-del')?.addEventListener('click', async () => {
      if (!confirm('Delete the whole archive from this device?')) return;
      await tx(db, 'convos', 'readwrite', s => s.clear());
      count = 0; msgCount = 0;
      save('archive.count', 0); save('archive.msgs', 0);
      setCount(); renderBrowse();
    });
    main.addEventListener('click', e => {
      const btn = e.target.closest('[data-open]');
      if (btn) openConvo(btn.dataset.open);
    });
  }

  function renderBrowse() {
    main.innerHTML = browseHTML();
    wireBrowse();
    renderCats();
    listNewest();
  }

  tools.querySelector('#ar-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Importing… large exports can take a minute');
    try {
      let text;
      if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
        const { convosText, memoriesText } = await readExportZip(file);
        if (memoriesText) {
          save('memories', memoriesText);
          const mem = main.querySelector('#ar-mem');
          if (mem) mem.value = memoriesText;
          showToast('Memories imported from the zip');
        }
        if (!convosText) {
          if (memoriesText) { e.target.value = ''; return; }
          throw new Error('no conversations file inside this zip');
        }
        text = convosText;
      } else {
        text = await file.text();
      }
      const convos = normalize(parseExportText(text));
      for (const c of convos) c.cat = categorize(c);
      let fresh = 0;
      await tx(db, 'convos', 'readwrite', store => {
        for (const c of convos) {
          const req = store.get(c.uuid);
          req.onsuccess = () => {
            const old = req.result;
            if (!old) fresh++;
            if (!old || (c.updated || '') >= (old.updated || '')) store.put(c);
          };
        }
      });
      count = await tx(db, 'convos', 'readonly', s => { const o = {}; s.count().onsuccess = e2 => { o.v = e2.target.result; }; return o; }).then(o => o.v);
      msgCount = convos.reduce((s, c) => s + c.msgs.length, 0);
      save('archive.count', count); save('archive.msgs', msgCount);
      setCount();
      showToast(`Imported ${convos.length.toLocaleString()} conversations (${fresh} new)`);
      renderBrowse();
      window.dispatchEvent(new CustomEvent('pd:data-changed'));
    } catch (err) {
      showToast(`Import failed: ${err.message}`);
    }
    e.target.value = '';
  });

  openDB()
    .then(d => { db = d; if (!dead) renderBrowse(); })
    .catch(() => { main.innerHTML = '<p class="muted">This browser blocks IndexedDB (private mode?) — the archive needs it.</p>'; });

  return () => { dead = true; db?.close(); };
}
