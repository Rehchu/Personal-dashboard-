// Sync API for the dashboard. Static assets are served by the assets binding;
// this Worker only handles /api/*. Single-user model: the first device to
// claim sets the passphrase (stored as a SHA-256 hash in D1); every sync call
// must present the same passphrase in X-Sync-Key. Same-origin only (no CORS
// headers on purpose — the app is served from this very Worker).

const COL_RE = /^[a-zA-Z0-9._-]{1,40}$/;
const MAX_BODY = 6 * 1024 * 1024; // 6 MB per collection is plenty for JSON

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish compare of two equal-length hex strings.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getAuthHash(env) {
  const row = await env.DB.prepare('SELECT key_hash FROM auth WHERE id = 1').first();
  return row?.key_hash || null;
}

async function requireAuth(request, env) {
  const key = request.headers.get('X-Sync-Key') || '';
  if (!key) return json({ error: 'missing key' }, 401);
  const stored = await getAuthHash(env);
  if (!stored) return json({ error: 'unclaimed', hint: 'POST /api/sync/claim first' }, 403);
  if (!safeEqual(await sha256hex(key), stored)) return json({ error: 'bad key' }, 403);
  return null; // authorized
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return undefined; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      // run_worker_first only routes /api/* here, but be safe
      return env.ASSETS.fetch(request);
    }

    if (path === '/api/health') return json({ ok: true });

    if (path === '/api/sync/claim' && request.method === 'POST') {
      const body = await readBody(request);
      const key = body?.key;
      if (typeof key !== 'string' || key.length < 6 || key.length > 200) {
        return json({ error: 'key must be 6–200 characters' }, 400);
      }
      const hash = await sha256hex(key);
      const stored = await getAuthHash(env);
      if (!stored) {
        await env.DB.prepare(
          'INSERT INTO auth (id, key_hash, created_at) VALUES (1, ?, ?)',
        ).bind(hash, Date.now()).run();
        return json({ claimed: true });
      }
      if (safeEqual(hash, stored)) return json({ claimed: false, ok: true });
      return json({ error: 'a different passphrase is already set' }, 403);
    }

    if (path === '/api/sync/state' && request.method === 'GET') {
      const denied = await requireAuth(request, env);
      if (denied) return denied;
      const { results } = await env.DB.prepare(
        'SELECT col, rev, updated_at FROM kv_sync',
      ).all();
      const cols = {};
      for (const r of results) cols[r.col] = { rev: r.rev, updated_at: r.updated_at };
      return json({ cols });
    }

    const colMatch = path.match(/^\/api\/sync\/col\/([^/]+)$/);
    if (colMatch) {
      const col = decodeURIComponent(colMatch[1]);
      if (!COL_RE.test(col)) return json({ error: 'bad collection name' }, 400);
      const denied = await requireAuth(request, env);
      if (denied) return denied;

      if (request.method === 'GET') {
        const row = await env.DB.prepare(
          'SELECT data, rev FROM kv_sync WHERE col = ?',
        ).bind(col).first();
        if (!row) return json({ rev: 0, data: null });
        return json({ rev: row.rev, data: JSON.parse(row.data) });
      }

      if (request.method === 'PUT') {
        const body = await readBody(request);
        if (body === null) return json({ error: 'body too large' }, 413);
        if (body === undefined || typeof body.baseRev !== 'number' || !('data' in body)) {
          return json({ error: 'expected {baseRev, data}' }, 400);
        }
        const row = await env.DB.prepare(
          'SELECT data, rev FROM kv_sync WHERE col = ?',
        ).bind(col).first();
        const currentRev = row?.rev || 0;
        if (body.baseRev < currentRev) {
          // client is behind — hand back the newer server copy to merge
          return json({ conflict: true, rev: currentRev, data: row ? JSON.parse(row.data) : null }, 409);
        }
        const nextRev = currentRev + 1;
        await env.DB.prepare(
          `INSERT INTO kv_sync (col, data, rev, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(col) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`,
        ).bind(col, JSON.stringify(body.data), nextRev, Date.now()).run();
        return json({ rev: nextRev });
      }

      return json({ error: 'method not allowed' }, 405);
    }

    return json({ error: 'not found' }, 404);
  },
};
