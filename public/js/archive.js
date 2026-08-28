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
  if (typeof m.content === 'string' && m.content) return m.content;
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

// Every text entry a dropped file can contribute, as lazy readers so only one
// entry's text is held in memory at a time (exports run to hundreds of MB).
async function listImportEntries(file) {
  if (!/\.zip$/i.test(file.name) && !/zip/i.test(file.type || '')) {
    return [{ name: file.name, read: () => file.text() }];
  }
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  return Object.keys(zip.files)
    .filter(n => !zip.files[n].dir && !/^__MACOSX\//.test(n) && /\.(jsonl?|md|txt)$/i.test(n))
    .map(n => ({ name: n, read: () => zip.files[n].async('string') }));
}

/* ---------- export shapes (filenames vary between exports, so classify by shape) ---------- */

function messageList(o) {
  const l = o.chat_messages || o.messages;
  return Array.isArray(l) ? l : null;
}

const isMessage = m => !!m && typeof m === 'object' && !!(m.sender || m.role) &&
  (typeof m.text === 'string' || typeof m.content === 'string' || Array.isArray(m.content));

// a chat. light_metadata rows land here too when they carry an empty array —
// they simply merge as bodiless records.
const isConvoRecord = o => {
  const l = messageList(o);
  return !!l && (!l.length || l.some(isMessage));
};

const isProjectRecord = o => !messageList(o) && !!(o.uuid || o.id) && !!(o.name || o.title) &&
  (Array.isArray(o.docs) || typeof o.prompt_template === 'string' || typeof o.description === 'string');

// title + timestamps and nothing else
const isLightRecord = o => !messageList(o) && !!(o.uuid || o.id) && !!(o.name || o.title || o.summary) &&
  !!(o.created_at || o.updated_at || o.created || o.updated);

// a rating pointing at some other record: named keys, a thumbs-ish verdict, or
// a bare pointer at a conversation with no title of its own
const isFeedbackRecord = o => !messageList(o) && (
  Object.keys(o).some(k => /feedback|rating|thumb|vote|flag|reaction/i.test(k)) ||
  /thumbs|upvote|downvote|positive|negative/i.test(String(o.type || o.kind || o.action || '')) ||
  (!!o.conversation_uuid && !o.name && !o.title));

const sampleRows = list => list.filter(r => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 50);

function classifyRecords(list) {
  const rows = sampleRows(list);
  if (!rows.length) return null;
  const votes = {
    conversations: rows.filter(isConvoRecord).length,
    projects: rows.filter(isProjectRecord).length,
    light: rows.filter(isLightRecord).length,
    feedback: rows.filter(isFeedbackRecord).length,
  };
  // ties resolve in this order: projects outrank light metadata because both are
  // bodiless but a project carries text worth keeping
  let best = null;
  for (const k of ['conversations', 'projects', 'light', 'feedback']) {
    if (votes[k] && (!best || votes[k] > votes[best])) best = k;
  }
  return best && votes[best] >= rows.length * 0.25 ? best : null;
}

// the list of records inside any wrapper shape
function recordList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return null;
  if ((raw.uuid || raw.id) && (raw.name || raw.title || messageList(raw))) return [raw];
  for (const k of ['conversations', 'projects', 'chats', 'items', 'records', 'data']) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return Object.values(raw).find(v => Array.isArray(v) && v.some(x => x && typeof x === 'object')) || null;
}

// projects become chat-like rows so categories, topics and search reach them
function projectRecords(list) {
  return list.filter(p => p && typeof p === 'object' && (p.uuid || p.id)).map(p => {
    const msgs = [];
    const head = [p.description, p.prompt_template].filter(t => typeof t === 'string' && t.trim());
    if (head.length) msgs.push({ s: 'a', t: head.join('\n\n') });
    for (const d of (Array.isArray(p.docs) ? p.docs : [])) {
      const t = [d?.filename || d?.name || '', d?.content || d?.text || ''].filter(Boolean).join('\n').trim();
      if (t) msgs.push({ s: 'a', t });
    }
    return {
      uuid: p.uuid || p.id,
      kind: 'project',
      name: p.name || p.title || '(untitled project)',
      created: p.created_at || p.created || '',
      updated: p.updated_at || p.updated || p.created_at || p.created || '',
      msgs,
    };
  });
}

const MEM_KEY = /^(memor(y|ies)|content|text|summary|body|notes?|value)$/i;

// memories json: any clearly-memory string field, however it is wrapped
function findMemoryText(data) {
  if (typeof data === 'string') return data.trim();
  const out = [];
  const visit = (v, key, depth) => {
    if (depth > 5 || out.length > 500) return;
    if (typeof v === 'string') {
      if (MEM_KEY.test(key) && v.trim().length >= 8) out.push(v.trim());
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
    }
  };
  visit(data, '', 0);
  return [...new Set(out)].join('\n\n');
}

function describeShape(data, list) {
  if (list) return list.length ? 'records were not chats, projects, memories or feedback' : 'the list inside was empty';
  const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 4).join(', ') : typeof data;
  return `no list of records found (top level: ${keys || 'empty object'})`;
}

const hasBody = r => !!(r && r.msgs && r.msgs.length);

// id-based merge. a bodiless light_metadata row may refresh a stored record's
// title and date but must never replace one that already holds a transcript.
function mergeRecord(old, next) {
  if (!old) return next;
  if (hasBody(next) && !hasBody(old)) return next;
  if (!hasBody(next) && hasBody(old)) {
    if ((next.updated || '') <= (old.updated || '')) return old;
    const named = next.name && next.name !== '(untitled chat)';
    return { ...old, name: named ? next.name : old.name, updated: next.updated };
  }
  return (next.updated || '') >= (old.updated || '') ? next : old;
}

// what one text entry holds. never throws on content it does not understand.
function ingestEntry(name, text) {
  if (!text || !text.trim()) return { kind: 'skip', note: `${name} is empty` };
  if (/\.(md|txt)$/i.test(name)) return { kind: 'memories', memory: text.trim() };
  let data;
  try {
    data = parseExportText(text);
  } catch {
    return { kind: 'skip', note: `${name} is not valid JSON` };
  }
  const list = recordList(data);
  const kind = list ? classifyRecords(list) : null;
  if (kind === 'conversations' || kind === 'light') {
    const convos = normalize(list);
    if (convos.length) return { kind: 'convos', convos };
  } else if (kind === 'projects') {
    const convos = projectRecords(list);
    if (convos.length) return { kind: 'projects', convos };
  } else if (kind === 'feedback') {
    return { kind: 'skip', note: `${name} is feedback` };
  }
  const memory = findMemoryText(data);
  if (memory) return { kind: 'memories', memory };
  if (/feedback/i.test(name)) return { kind: 'skip', note: `${name} is feedback` };
  return { kind: 'none', note: `${name}: ${describeShape(data, list)}` };
}

// one line per dropped file, so a file that landed nothing says why
function fileLine(o) {
  if (o.error) return `${o.file} — could not be read (${o.error})`;
  const many = (n, one, more) => `${n.toLocaleString()} ${n === 1 ? one : more}`;
  const bits = [];
  if (o.convos) bits.push(many(o.convos, 'conversation', 'conversations'));
  if (o.light) bits.push(many(o.light, 'chat title', 'chat titles'));
  if (o.projects) bits.push(many(o.projects, 'project', 'projects'));
  if (o.memories) bits.push('memories');
  if (!bits.length) return `${o.file} — skipped: ${o.notes.join('; ') || 'nothing recognisable inside'}`;
  return `${o.file} — ${bits.join(', ')}${o.notes.length ? ` (${o.notes.join('; ')})` : ''}`;
}

const kindTag = c => (c.kind === 'project' ? '📁 Project · ' : '');
const partsLabel = c => (c.kind === 'project'
  ? `${c.msgs.length} ${c.msgs.length === 1 ? 'doc' : 'docs'}`
  : `${c.msgs.length} messages`);

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

/* ---------- topic extraction (specific things inside the chats) ---------- */

const STOP = new Set(('the a an and or but if then else for with without from into onto this that these those there here ' +
  'is are was were be been being have has had do does did will would can could should shall may might must not no yes ' +
  'i you he she it we they me him her us them my your his its our their mine yours what which who whom when where why how ' +
  'about above after again against all am any because before below between both down during each few further more most ' +
  'other some such only own same so than too very just also like get got make made want need know think going go really ' +
  'help please thanks thank hey okay ok sure right now new one two way thing things something anything everything nothing ' +
  'lets let does doing done use using used tell told say said see look looking looked good great well much many lot bit ' +
  'claude assistant chat question answer').split(' '));

const tokenize = s => s.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(Boolean);

const topicCache = new Map();

function topicsOf(c) {
  if (Array.isArray(c.topics)) return c.topics;
  if (topicCache.has(c.uuid)) return topicCache.get(c.uuid);
  const title = tokenize(c.name);
  const body = tokenize(c.msgs.map(m => m.t).join(' ').slice(0, 3000));
  const score = new Map();
  const bump = (w, n) => score.set(w, (score.get(w) || 0) + n);
  const usable = w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w);
  title.filter(usable).forEach(w => bump(w, 5));
  body.filter(usable).forEach(w => bump(w, 1));
  // bigrams ("dragon egg", "check in") from the title carry the most identity
  for (let i = 0; i < title.length - 1; i++) {
    if (usable(title[i]) && usable(title[i + 1])) bump(`${title[i]} ${title[i + 1]}`, 8);
  }
  for (let i = 0; i < body.length - 1; i++) {
    if (usable(body[i]) && usable(body[i + 1])) bump(`${body[i]} ${body[i + 1]}`, 1.5);
  }
  const topics = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .filter(([, v]) => v >= 4)
    .map(([w]) => w);
  topicCache.set(c.uuid, topics);
  return topics;
}

export function mount(root, tools) {
  let db = null;
  let count = load('archive.count', 0); // chats only, so the dashboard cards stay honest
  let msgCount = load('archive.msgs', 0);
  let projCount = load('archive.projects', 0);
  let dead = false;

  tools.innerHTML = `
    <span class="muted" id="ar-count"></span>
    <label class="btn small" style="cursor:pointer">⬆ Import
      <input id="ar-file" type="file" multiple accept=".json,.jsonl,.zip,application/json,application/zip" hidden></label>`;

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
      #ar-main mark { background: color-mix(in oklab, var(--accent) 45%, transparent); color: var(--ink); border-radius: 3px; padding: 0 2px; }
    </style>
    <div id="ar-main"></div>`;

  const main = root.querySelector('#ar-main');
  const countEl = tools.querySelector('#ar-count');
  const setCount = () => { countEl.textContent = count ? `${count.toLocaleString()} chats` : ''; };
  setCount();

  let activeCat = 'all'; // category menu selection
  let lastReport = null; // per-file outcome of the most recent import

  function browseHTML() {
    const stocked = count || projCount;
    return `
      ${lastReport ? `
      <div class="panel" style="margin-bottom:16px"><h3>Last import</h3>
        <p style="margin-bottom:6px">${esc(lastReport.summary)}</p>
        <ul class="muted" style="margin:0;padding-left:18px">
          ${lastReport.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>` : ''}
      <div class="stat-row">
        <div class="stat-tile"><div class="stat-value">${count.toLocaleString()}</div><div class="stat-label">conversations</div></div>
        <div class="stat-tile"><div class="stat-value">${msgCount.toLocaleString()}</div><div class="stat-label">messages</div></div>
        ${projCount ? `<div class="stat-tile"><div class="stat-value">${projCount.toLocaleString()}</div><div class="stat-label">projects</div></div>` : ''}
        <div class="stat-tile"><div class="stat-value">🔒</div><div class="stat-label">on-device only</div></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <h3>Categories</h3>
        <div id="ar-cats" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <h3>Topics ${activeCat === 'all' ? '' : 'in this category'}</h3>
        <div id="ar-topics" class="muted">Scanning…</div>
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
      ${stocked ? '<p style="margin-top:16px"><button class="btn small danger" id="ar-del">✕ Delete archive from this device</button></p>' : ''}
      ${stocked ? '' : `
      <div class="panel" style="margin-top:16px"><h3>How to fill this</h3>
        <p class="muted"><strong>claude.ai → Settings → Privacy → Export data</strong> gives you a link per zip — <code>conversations</code>, <code>design_chats</code>, <code>projects</code>, <code>light_metadata</code>, <code>memories</code>, <code>feedback</code>. Those links are one-time-use, so download them all while they last, then select every zip here at once and import them as-is — no unzipping needed. Everything is read in this browser: the data never leaves this device. Re-import any time — records merge by ID, nothing duplicates.</p>
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
  let lastQuery = ''; // carried into the reader for highlighting

  async function renderTopics() {
    const tally = new Map(); // topic → convo count
    await tx(db, 'convos', 'readonly', store => {
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        if (inCat(cur.value)) {
          for (const t of topicsOf(cur.value)) tally.set(t, (tally.get(t) || 0) + 1);
        }
        cur.continue();
      };
    });
    if (dead) return;
    const el = main.querySelector('#ar-topics');
    if (!el) return;
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const repeated = sorted.filter(([, n]) => n >= 2);
    // prefer topics shared across chats; fall back to the strongest singles
    const top = (repeated.length >= 4 ? repeated : sorted).slice(0, 18);
    if (!top.length) { el.textContent = 'Topics appear once chats are imported.'; return; }
    el.classList.remove('muted');
    el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
      top.map(([t, n]) => `<button class="btn small" data-topic="${esc(t)}">${esc(t)} · ${n}</button>`).join('') + '</div>';
    el.querySelectorAll('[data-topic]').forEach(b => b.addEventListener('click', () => {
      const q = b.dataset.topic;
      const input = main.querySelector('#ar-q');
      input.value = q;
      search(q);
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  const mark = (text, needle) => {
    const safe = esc(text);
    const escNeedle = esc(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(`(${escNeedle})`, 'gi'), '<mark>$1</mark>');
  };

  function snippetAround(text, needle) {
    const i = text.toLowerCase().indexOf(needle);
    if (i < 0) return null;
    return (i > 45 ? '…' : '') + text.slice(Math.max(0, i - 45), i + 110) + '…';
  }

  // hits: [{c, snips:[string]} | {mem:true, snip}] → grouped by category
  function renderGrouped(hits, needle) {
    const box = main.querySelector('#ar-results');
    if (!hits.length) { box.innerHTML = '<p class="muted" style="margin-top:8px">No matches.</p>'; return; }
    const groups = new Map();
    for (const h of hits) {
      const key = h.mem ? 'mem' : catOf(h.c).id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    let html = '';
    for (const [key, list] of groups) {
      const cat = key === 'mem' ? { emoji: '🧠', name: 'Memories' } : (CAT_BY_ID[key] || OTHER);
      html += `<div class="ar-month">${cat.emoji} ${esc(cat.name)} · ${list.length}</div>`;
      for (const h of list) {
        if (h.mem) {
          html += `<button class="ar-row"><div class="t">🧠 Memory</div><div class="snip">${mark(h.snip, needle)}</div></button>`;
        } else {
          html += `<button class="ar-row" data-open="${esc(h.c.uuid)}">
            <div class="t">${esc(h.c.name)}</div>
            <div class="m">${kindTag(h.c)}${esc(fmtDate(h.c.updated))} · ${partsLabel(h.c)}</div>
            ${h.snips.map(s => `<div class="snip">${mark(s, needle)}</div>`).join('')}</button>`;
        }
      }
    }
    box.innerHTML = html;
  }

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
    if (!rows.length) { listEl.textContent = (count || projCount) ? 'Nothing in this category yet.' : 'Nothing imported yet.'; return; }
    let lastMonth = '';
    listEl.classList.remove('muted');
    listEl.innerHTML = rows.map(c => {
      const mk = monthKey(c.updated);
      const head = mk !== lastMonth ? `<div class="ar-month">${esc(mk)}</div>` : '';
      lastMonth = mk;
      const cat = catOf(c);
      return `${head}<button class="ar-row" data-open="${esc(c.uuid)}">
        <div class="t">${esc(c.name)}</div>
        <div class="m">${kindTag(c)}${cat.emoji} ${esc(cat.name)} · ${esc(fmtDate(c.updated))} · ${partsLabel(c)}</div></button>`;
    }).join('');
  }

  async function search(q) {
    const needle = q.toLowerCase();
    lastQuery = needle;
    const hits = [];
    const mem = load('memories', '');
    if (activeCat === 'all' && mem.toLowerCase().includes(needle)) {
      const i = mem.toLowerCase().indexOf(needle);
      hits.push({ mem: true, snip: mem.slice(Math.max(0, i - 45), i + 110) });
    }
    await tx(db, 'convos', 'readonly', store => {
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur || hits.length >= 60) return;
        const c = cur.value;
        if (!inCat(c)) { cur.continue(); return; }
        const snips = [];
        if (c.name.toLowerCase().includes(needle)) snips.push(''); // title hit
        for (const m of c.msgs) {
          if (snips.length >= 4) break;
          const s = snippetAround(m.t, needle);
          if (s) snips.push(s);
        }
        const clean = snips.filter(Boolean);
        if (snips.length) hits.push({ c, snips: clean.slice(0, 3), titleHit: snips[0] === '' });
        cur.continue();
      };
    });
    if (dead) return;
    hits.sort((a, b) => (b.titleHit ? 1 : 0) - (a.titleHit ? 1 : 0));
    renderGrouped(hits, needle);
  }

  async function openConvo(uuid) {
    const c = await tx(db, 'convos', 'readonly', s => {
      const out = {};
      s.get(uuid).onsuccess = e => { out.v = e.target.result; };
      return out;
    }).then(o => o.v);
    if (!c || dead) return;
    const cat = catOf(c);
    const paint = t => (lastQuery ? mark(t, lastQuery) : esc(t));
    const link = c.kind === 'project'
      ? `https://claude.ai/project/${esc(c.uuid)}`
      : `https://claude.ai/chat/${esc(c.uuid)}`;
    main.innerHTML = `
      <p><button class="btn small" id="ar-back">‹ Archive</button>
        <a class="btn small" target="_blank" rel="noopener" href="${link}">↗ open on claude.ai</a></p>
      <h3 style="font-family:var(--font-display);margin:14px 0 4px">${esc(c.name)}</h3>
      <p class="muted" style="margin-bottom:6px">${kindTag(c)}${cat.emoji} ${esc(cat.name)} · ${esc(fmtDate(c.created))} · ${partsLabel(c)}</p>
      <p style="margin-bottom:16px">${topicsOf(c).map(t => `<button class="btn small" data-topicjump="${esc(t)}">${esc(t)}</button>`).join(' ')}</p>
      ${c.msgs.length ? '' : '<p class="muted">Only this chat\'s title and dates were in the export — open it on claude.ai for the transcript, or import the conversations zip.</p>'}
      ${c.msgs.map(m => `<div class="ar-msg ${m.s}">${paint(m.t)}</div>`).join('')}`;
    main.querySelector('#ar-back').addEventListener('click', renderBrowse);
    main.querySelectorAll('[data-topicjump]').forEach(b => b.addEventListener('click', () => {
      renderBrowse();
      const input = main.querySelector('#ar-q');
      input.value = b.dataset.topicjump;
      search(b.dataset.topicjump);
    }));
    const scroller = root.closest('#appview-body');
    scroller?.scrollTo(0, 0);
    const first = main.querySelector('mark');
    if (first) first.scrollIntoView({ block: 'center' });
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
      count = 0; msgCount = 0; projCount = 0;
      lastReport = null;
      save('archive.count', 0); save('archive.msgs', 0); save('archive.projects', 0);
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
    renderTopics();
    listNewest();
  }

  tools.querySelector('#ar-file').addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    showToast(files.length > 1
      ? `Importing ${files.length} files… large exports can take a minute`
      : 'Importing… large exports can take a minute');

    // one file failing must never sink the rest, so every step is contained
    const batch = new Map(); // uuid → record merged across all of these files
    const memories = [];
    const outcomes = [];
    for (const file of files) {
      const out = { file: file.name, convos: 0, light: 0, projects: 0, memories: 0, notes: [] };
      outcomes.push(out);
      let entries;
      try {
        entries = await listImportEntries(file);
      } catch (err) {
        out.error = err.message;
        continue;
      }
      if (!entries.length) { out.notes.push('no json, md or txt entries inside'); continue; }
      for (const entry of entries) {
        let res;
        try {
          res = ingestEntry(entry.name, await entry.read());
        } catch (err) {
          out.notes.push(`${entry.name}: ${err.message}`);
          continue;
        }
        if (res.kind === 'convos' || res.kind === 'projects') {
          for (const c of res.convos) batch.set(c.uuid, mergeRecord(batch.get(c.uuid), c));
          if (res.kind === 'projects') out.projects += res.convos.length;
          else {
            out.convos += res.convos.filter(hasBody).length;
            out.light += res.convos.filter(c => !hasBody(c)).length;
          }
        } else if (res.kind === 'memories') {
          memories.push(res.memory);
          out.memories++;
        } else if (res.note) {
          out.notes.push(res.note);
        }
      }
    }
    e.target.value = '';
    if (dead) return;

    const records = [...batch.values()];
    let freshConvos = 0;
    let saveError = '';
    if (records.length) {
      for (const c of records) {
        c.cat = categorize(c);
        topicCache.delete(c.uuid); // a full transcript must not inherit a title-only scan
        c.topics = topicsOf({ ...c, topics: undefined });
      }
      try {
        await tx(db, 'convos', 'readwrite', store => {
          for (const c of records) {
            const req = store.get(c.uuid);
            req.onsuccess = () => {
              const old = req.result;
              if (!old && hasBody(c) && c.kind !== 'project') freshConvos++;
              store.put(mergeRecord(old, c));
            };
          }
        });
        // totals come from the store, not the batch, so a titles-only import
        // cannot reset the counters the dashboard cards read
        const totals = await tx(db, 'convos', 'readonly', store => {
          const o = { n: 0, m: 0, p: 0 };
          store.openCursor().onsuccess = e2 => {
            const cur = e2.target.result;
            if (!cur) return;
            if (cur.value.kind === 'project') o.p++;
            else o.n++;
            o.m += cur.value.msgs?.length || 0;
            cur.continue();
          };
          return o;
        });
        count = totals.n;
        msgCount = totals.m;
        projCount = totals.p;
        save('archive.count', count); save('archive.msgs', msgCount); save('archive.projects', projCount);
        setCount();
      } catch (err) {
        saveError = err.message || 'could not write to this device';
      }
    }
    if (memories.length) save('memories', [...new Set(memories)].join('\n\n'));
    if (dead) return;

    // summary counts the merged batch, so a chat present in two zips counts once
    const landed = test => records.filter(test).length;
    const chats = landed(c => c.kind !== 'project' && hasBody(c));
    const titles = landed(c => c.kind !== 'project' && !hasBody(c));
    const projects = landed(c => c.kind === 'project');
    const skipped = outcomes.filter(o => !o.error && !o.convos && !o.light && !o.projects && !o.memories).length;
    const failed = outcomes.filter(o => o.error).length;
    const many = (n, one, more) => `${n.toLocaleString()} ${n === 1 ? one : more}`;
    const bits = [];
    if (chats) bits.push(`${many(chats, 'conversation', 'conversations')} (${freshConvos.toLocaleString()} new)`);
    if (titles) bits.push(many(titles, 'chat title', 'chat titles'));
    if (projects) bits.push(many(projects, 'project', 'projects'));
    if (memories.length) bits.push('memories updated');
    if (skipped) bits.push(`${many(skipped, 'file', 'files')} skipped`);
    if (failed) bits.push(`${many(failed, 'file', 'files')} unreadable`);
    const lines = outcomes.map(fileLine);
    if (saveError) {
      lines.push(`saving to this device failed — ${saveError}`);
      bits.length = 0;
      bits.push(`Import failed while saving: ${saveError}`);
    }
    lastReport = { summary: bits.join(', ') || 'Nothing recognisable in these files', lines };
    showToast(lastReport.summary);
    renderBrowse();
    if (!saveError && (records.length || memories.length)) window.dispatchEvent(new CustomEvent('pd:data-changed'));
  });

  openDB()
    .then(d => { db = d; if (!dead) renderBrowse(); })
    .catch(() => { main.innerHTML = '<p class="muted">This browser blocks IndexedDB (private mode?) — the archive needs it.</p>'; });

  return () => { dead = true; db?.close(); };
}
