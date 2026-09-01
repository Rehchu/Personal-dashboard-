// Agent-scoped chat archive search.
//
// The town's villagers need the history in the Chat Archive — a lot of the
// decisions behind these projects only exist in old Claude/ChatGPT/Grok threads.
// What they must NOT have is the owner's sync key: that key is the master key
// here, because POST /api/auth/login accepts the very same value and hands back
// a full session cookie, which unlocks /api/ptz/access and the camera
// credentials along with everything else.
//
// So agents get their own credential and their own door. This route is
// read-only, per-agent, scoped to the topics that agent is actually assigned
// to, returns short excerpts rather than whole conversations, and writes every
// query to an audit table the owner can read.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const ARCHIVE_INDEX_KEY = 'archive/index.json';
const CHUNK_PREFIX = 'archive/chunk/';

// How much work one request may do. A chunk can be 25MB, so scanning the whole
// archive in one call would run the Worker out of memory. Callers page with
// ?offset= and the response always says whether more remain — never a silent cap.
const CHUNKS_PER_CALL = 6;
const MAX_HITS = 25;
const EXCERPT_RADIUS = 140;
const MAX_EXCERPTS = 2;

// Mirrors the category ids and keywords in public/js/archive.js. Duplicated on
// purpose: that module reaches for localStorage and IndexedDB at import time, so
// a Worker cannot import it. Keep the two lists in step when either changes.
const SCOPE_KEYWORDS = {
  dragons: ['dragon', 'stoker', 'wyvern', 'book', 'chapter', 'novel', 'manuscript', 'worldbuild', 'plot', 'character', 'scene', 'writing'],
  church: ['church', 'arise', 'bible', 'verse', 'sermon', 'ministry', 'worship', 'pastor', 'prayer', 'sunday', 'check-in', 'chms'],
  shop: ['repair', 'ctrl', 'pc build', 'ticket', 'invoice', 'customer', 'stripe', 'paypal', 'inventory', 'warranty', 'rma', 'prebuilt'],
  fitness: ['workout', 'gym', 'fitness', 'exercise', 'protein', 'weight', 'training', 'apex', 'coach', 'muscle', 'cardio'],
  code: ['code', 'javascript', 'typescript', 'react', 'cloudflare', 'worker', 'api', 'github', 'deploy', 'database', 'sql', 'css', 'html', 'bug', 'error', 'function', 'app', 'server', 'dashboard'],
  design: ['design', 'logo', 'blender', '3d model', 'render', 'canva', 'mockup', 'poster', 'artwork', 'glb'],
  business: ['business', 'marketing', 'price', 'pricing', 'tax', 'llc', 'revenue', 'sales', 'budget', 'money'],
};

// Each villager reaches only the topics they were actually assigned. Ctrl runs
// the repair shop, so he reads shop threads; he has no business in the book.
const AGENT_SCOPE = {
  arise: ['church', 'code'],
  ctrl: ['shop', 'business', 'code'],
  apex: ['fitness', 'code'],
  draco: ['dragons'],
  vigil: ['design', 'business'],
  meta: ['design', 'business'],
  spork: ['code', 'business'],
};

const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compare hashes without leaking where they first differ.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function ensureAudit(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS archive_queries (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agent_id TEXT NOT NULL, q TEXT, hits INTEGER, at INTEGER NOT NULL)`).run();
}

// Returns the agent id when the credential checks out, else null. The token is
// stored only as a hash, so a leak of the secrets table does not hand anyone a
// working key.
async function whichAgent(request, env) {
  const agent = (request.headers.get('X-Archive-Agent') || '').trim().toLowerCase();
  const token = request.headers.get('X-Archive-Key') || '';
  if (!AGENT_RE.test(agent) || !token || !AGENT_SCOPE[agent]) return null;
  const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind(`agentkey_${agent}`).first();
  if (!row?.v) return null;
  return safeEqual(await sha256hex(token), row.v) ? agent : null;
}

const textOf = rec =>
  `${rec?.name || ''}\n${(Array.isArray(rec?.msgs) ? rec.msgs : []).map(m => m?.t || '').join('\n')}`;

// A record is in scope if it was already categorised into one of the agent's
// topics, or — for records saved before categories existed — if its text reads
// like one. Scope is a filter, never a search: the query still has to match.
function inScope(rec, hay, cats) {
  if (rec?.cat && cats.includes(rec.cat)) return true;
  if (rec?.cat) return false;
  return cats.some(c => (SCOPE_KEYWORDS[c] || []).some(k => hay.includes(k)));
}

function excerptsFor(hay, raw, needle) {
  const out = [];
  let from = 0;
  while (out.length < MAX_EXCERPTS) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    const start = Math.max(0, i - EXCERPT_RADIUS);
    const end = Math.min(raw.length, i + needle.length + EXCERPT_RADIUS);
    const text = `${start ? '…' : ''}${raw.slice(start, end).replace(/\s+/g, ' ').trim()}${end < raw.length ? '…' : ''}`;
    if (!out.includes(text)) out.push(text);
    // step past the window just emitted: a second hit inside it would otherwise
    // come back as a byte-identical excerpt
    from = Math.max(i + needle.length, end);
  }
  return out;
}

export async function handleAgentArchiveSearch(url, request, env) {
  if (!env.MEDIA || !env.DB) return json({ error: 'archive storage unavailable' }, 500);

  const agent = await whichAgent(request, env);
  // One message for a bad agent and a bad token alike — no probing which half
  // was wrong.
  if (!agent) return json({ error: 'unknown agent or bad key' }, 403);

  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) return json({ error: 'q must be at least 3 characters' }, 400);
  if (q.length > 120) return json({ error: 'q must be 120 characters or fewer' }, 400);

  const offsetRaw = Number(url.searchParams.get('offset') || 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const idxObj = await env.MEDIA.get(ARCHIVE_INDEX_KEY);
  if (!idxObj) return json({ agent, q, hits: [], scanned: 0, totalChunks: 0, done: true });

  let index;
  try {
    index = JSON.parse(await idxObj.text());
  } catch {
    return json({ error: 'stored archive index is unreadable' }, 500);
  }
  const chunks = Array.isArray(index?.chunks) ? index.chunks : [];
  const slice = chunks.slice(offset, offset + CHUNKS_PER_CALL);

  const cats = AGENT_SCOPE[agent];
  const needle = q.toLowerCase();
  const hits = [];
  let scanned = 0;

  for (const id of slice) {
    if (hits.length >= MAX_HITS) break;
    const obj = await env.MEDIA.get(CHUNK_PREFIX + id);
    if (!obj) continue;
    scanned++;
    let records;
    try {
      records = JSON.parse(await obj.text());
    } catch {
      continue; // one unreadable chunk must not fail the whole search
    }
    for (const rec of Array.isArray(records) ? records : []) {
      if (hits.length >= MAX_HITS) break;
      const raw = textOf(rec);
      const hay = raw.toLowerCase();
      if (!hay.includes(needle)) continue;
      if (!inScope(rec, hay, cats)) continue;
      hits.push({
        uuid: rec.uuid || null,
        title: rec.name || '(untitled chat)',
        created: rec.created || '',
        updated: rec.updated || '',
        messages: Array.isArray(rec.msgs) ? rec.msgs.length : 0,
        excerpts: excerptsFor(hay, raw, needle),
      });
    }
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= chunks.length || hits.length >= MAX_HITS;

  try {
    await ensureAudit(env);
    await env.DB.prepare('INSERT INTO archive_queries (agent_id, q, hits, at) VALUES (?, ?, ?, ?)')
      .bind(agent, q.slice(0, 120), hits.length, Date.now()).run();
  } catch {
    // an audit failure must not swallow the answer, but it is worth surfacing
  }

  return json({
    agent,
    scope: cats,
    q,
    hits,
    scanned,
    totalChunks: chunks.length,
    nextOffset: done ? null : nextOffset,
    // said out loud so a partial sweep can never read as "that's everything"
    truncated: hits.length >= MAX_HITS,
    done,
  });
}

// Owner-only: mint (or rotate) an agent's token. Returned exactly once — only
// its hash is kept, so a lost token is reissued, never recovered.
export async function handleAgentKeyIssue(request, env) {
  const body = await request.json().catch(() => null);
  const agent = String(body?.agent || '').trim().toLowerCase();
  if (!AGENT_RE.test(agent) || !AGENT_SCOPE[agent]) {
    return json({ error: 'unknown agent', known: Object.keys(AGENT_SCOPE) }, 400);
  }
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO secrets (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(`agentkey_${agent}`, await sha256hex(token)).run();
  return json({ agent, token, scope: AGENT_SCOPE[agent], note: 'stored hashed — copy it now, it will not be shown again' });
}

// Owner-only: what the agents have been reading.
export async function handleAgentQueryLog(env) {
  await ensureAudit(env);
  const { results } = await env.DB.prepare(
    'SELECT agent_id, q, hits, at FROM archive_queries ORDER BY at DESC LIMIT 100').all();
  return json({ queries: results || [] });
}
