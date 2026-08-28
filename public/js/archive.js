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
  const list = Array.isArray(raw) ? raw : raw?.conversations;
  if (!Array.isArray(list)) throw new Error('not a claude.ai conversations export');
  return list.filter(c => c && c.uuid).map(c => ({
    uuid: c.uuid,
    name: c.name || '(untitled chat)',
    created: c.created_at || '',
    updated: c.updated_at || c.created_at || '',
    msgs: (c.chat_messages || []).map(m => ({
      s: m.sender === 'human' ? 'h' : 'a',
      t: msgText(m),
    })).filter(m => m.t),
  }));
}

const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const monthKey = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Undated');

export function mount(root, tools) {
  let db = null;
  let count = load('archive.count', 0);
  let msgCount = load('archive.msgs', 0);
  let dead = false;

  tools.innerHTML = `
    <span class="muted" id="ar-count"></span>
    <label class="btn small" style="cursor:pointer">⬆ Import
      <input id="ar-file" type="file" accept="application/json,.json" hidden></label>`;

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

  function browseHTML() {
    return `
      <div class="stat-row">
        <div class="stat-tile"><div class="stat-value">${count.toLocaleString()}</div><div class="stat-label">conversations</div></div>
        <div class="stat-tile"><div class="stat-value">${msgCount.toLocaleString()}</div><div class="stat-label">messages</div></div>
        <div class="stat-tile"><div class="stat-value">🔒</div><div class="stat-label">on-device only</div></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <h3>Search everything</h3>
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
        <p class="muted">The export only works from a computer: <strong>claude.ai → Settings → Privacy → Export data</strong> → Anthropic emails a download link → unzip it → import <code>conversations.json</code> here with the ⬆ Import button. Re-import any time — chats merge by ID, nothing duplicates.</p>
      </div>`}`;
  }

  async function listNewest() {
    const rows = [];
    await tx(db, 'convos', 'readonly', store => {
      const idx = store.index('updated');
      idx.openCursor(null, 'prev').onsuccess = e => {
        const cur = e.target.result;
        if (!cur || rows.length >= 30) return;
        rows.push(cur.value);
        cur.continue();
      };
    });
    if (dead) return;
    const listEl = main.querySelector('#ar-list');
    if (!rows.length) { listEl.textContent = 'Nothing imported yet.'; return; }
    let lastMonth = '';
    listEl.classList.remove('muted');
    listEl.innerHTML = rows.map(c => {
      const mk = monthKey(c.updated);
      const head = mk !== lastMonth ? `<div class="ar-month">${esc(mk)}</div>` : '';
      lastMonth = mk;
      return `${head}<button class="ar-row" data-open="${esc(c.uuid)}">
        <div class="t">${esc(c.name)}</div>
        <div class="m">${esc(fmtDate(c.updated))} · ${c.msgs.length} messages</div></button>`;
    }).join('');
  }

  async function search(q) {
    const needle = q.toLowerCase();
    const hits = [];
    const mem = load('memories', '');
    if (mem.toLowerCase().includes(needle)) {
      const i = mem.toLowerCase().indexOf(needle);
      hits.push({ mem: true, snip: mem.slice(Math.max(0, i - 40), i + 90) });
    }
    await tx(db, 'convos', 'readonly', store => {
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur || hits.length >= 50) return;
        const c = cur.value;
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
    listNewest();
  }

  tools.querySelector('#ar-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    showToast('Importing… large exports can take a minute');
    try {
      const convos = normalize(JSON.parse(await file.text()));
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
