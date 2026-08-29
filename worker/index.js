// Private dashboard Worker: cookie-gated app shell + static assets, sync API
// (passphrase header), and personal background-video storage streamed from R2.
// Single-user model: ONE passphrase (claimed on first login or first sync
// setup) unlocks both the login screen and sync. Sessions are HttpOnly
// cookies signed with a server-side secret kept in D1.

const COL_RE = /^[a-zA-Z0-9._-]{1,40}$/;
const ARCHIVE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const MAX_BODY = 6 * 1024 * 1024;        // sync payload cap
const MAX_VIDEO = 600 * 1024 * 1024;     // background video cap
const MAX_PART = 40 * 1024 * 1024;       // one multipart part; the edge caps a request body at 100 MB
const MAX_PARTS = 10000;                 // R2 multipart part-number ceiling
const MAX_CHUNK = 25 * 1024 * 1024;      // one archive chunk body
const MAX_CHUNKS = 512;                  // ids allowed in one archive index
const MAX_MEMORIES = 256 * 1024;         // memories text, in stored bytes
const MAX_INDEX_BODY = 512 * 1024;       // memories plus the id list
const SESSION_MS = 30 * 24 * 3600 * 1000;

// Paths that must work without a session (login itself, PWA niceties).
const PUBLIC_PATHS = [/^\/api\/health$/, /^\/api\/auth\//, /^\/manifest\.webmanifest$/, /^\/icons\//];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- passphrase (shared by login + sync) ---------- */

async function getAuthHash(env) {
  const row = await env.DB.prepare('SELECT key_hash FROM auth WHERE id = 1').first();
  return row?.key_hash || null;
}

// Returns 'claimed' | 'ok' | 'bad'
async function claimOrVerify(env, key) {
  const hash = await sha256hex(key);
  const stored = await getAuthHash(env);
  if (!stored) {
    await env.DB.prepare('INSERT INTO auth (id, key_hash, created_at) VALUES (1, ?, ?)')
      .bind(hash, Date.now()).run();
    return 'claimed';
  }
  return safeEqual(hash, stored) ? 'ok' : 'bad';
}

async function requireSyncKey(request, env) {
  const key = request.headers.get('X-Sync-Key') || '';
  if (!key) return json({ error: 'missing key' }, 401);
  const stored = await getAuthHash(env);
  if (!stored) return json({ error: 'unclaimed', hint: 'POST /api/sync/claim first' }, 403);
  if (!safeEqual(await sha256hex(key), stored)) return json({ error: 'bad key' }, 403);
  return null;
}

/* ---------- sessions ---------- */

async function getSecret(env) {
  let row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('session').first();
  if (!row) {
    const v = [...crypto.getRandomValues(new Uint8Array(32))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT OR IGNORE INTO secrets (k, v) VALUES (?, ?)').bind('session', v).run();
    row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('session').first();
  }
  return row.v;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sessionCookie(env) {
  const exp = Date.now() + SESSION_MS;
  const sig = await hmacHex(await getSecret(env), String(exp));
  return `pd_session=${exp}.${sig}; Max-Age=${Math.floor(SESSION_MS / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function hasSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)pd_session=(\d+)\.([a-f0-9]{64})/);
  if (!m) return false;
  const [, exp, sig] = m;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmacHex(await getSecret(env), exp));
}

/* ---------- login screen (self-contained; no assets needed) ---------- */

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Dyer HQ — Sign in</title><style>
  * { margin:0; box-sizing:border-box; }
  body { min-height:100vh; display:grid; place-items:center; font-family:system-ui,sans-serif;
    background: radial-gradient(120% 90% at 75% 10%, rgba(69,184,242,.14), transparent 60%),
      radial-gradient(100% 80% at 15% 90%, rgba(227,69,59,.08), transparent 55%), #05080f; color:#eef4fa; }
  form { width:min(360px, 92vw); text-align:center; }
  .mark { width:16px; height:16px; border-radius:4px; background:#45b8f2; box-shadow:0 0 18px #45b8f2; margin:0 auto 18px; }
  h1 { font-size:24px; letter-spacing:.3em; padding-left:.3em; margin-bottom:6px; }
  p { color:#74869a; font-size:14px; margin-bottom:26px; }
  input { width:100%; padding:14px 16px; font-size:17px; color:#eef4fa; background:#0c1420;
    border:1.5px solid #2a3a4e; border-radius:12px; text-align:center; }
  input:focus { outline:none; border-color:#45b8f2; box-shadow:0 0 0 3px rgba(69,184,242,.25); }
  button { width:100%; margin-top:14px; padding:13px; font-size:15px; font-weight:700; letter-spacing:.08em;
    text-transform:uppercase; color:#041019; background:#45b8f2; border:none; border-radius:999px; cursor:pointer; }
  #err { color:#ff8a92; font-size:14px; min-height:20px; margin-top:12px; }
</style></head><body>
<form id="f"><div class="mark"></div><h1>DYER HQ</h1>
<p>Private console — enter your passphrase.<br>First sign-in sets it.</p>
<input id="k" type="password" autocomplete="current-password" placeholder="Passphrase" autofocus minlength="6" required>
<button>Enter</button><div id="err"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const res = await fetch('/api/auth/login', { method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ key: document.getElementById('k').value }) });
    const body = await res.json();
    if (res.ok) location.replace('/');
    else err.textContent = body.error || 'Sign-in failed';
  } catch { err.textContent = 'Network error — try again'; }
});
</script></body></html>`;

const loginPage = () => new Response(LOGIN_HTML, {
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

/* ---------- background video (private, streamed from R2) ---------- */

function parseRange(request, size) {
  const h = request.headers.get('Range');
  const m = h && h.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[2] === '' || m[1] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1, start, end };
}

// R2 hands back an opaque id; only ever pass it straight back to R2.
const validUploadId = id => typeof id === 'string' && id.length >= 1 && id.length <= 300;

// a browser-trimmed clip is whatever MediaRecorder produced (webm on Chrome,
// mp4 on Safari), so store the uploaded type rather than assuming mp4
function videoType(request) {
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return /^video\/[a-z0-9.+-]{1,30}$/.test(ct) ? ct : 'video/mp4';
}

async function serveVideo(request, env) {
  const head = await env.MEDIA.head('bg.mp4');
  // no asset fallback: SPA not_found_handling would answer a video request with index.html at 200
  if (!head) return json({ error: 'no video' }, 404);
  const size = head.size;
  const range = parseRange(request, size);
  const obj = await env.MEDIA.get('bg.mp4', range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!obj) return new Response('gone', { status: 404 });
  const headers = {
    'content-type': head.httpMetadata?.contentType || 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    etag: head.httpEtag,
  };
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['content-length'] = String(range.length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['content-length'] = String(size);
  return new Response(obj.body, { status: 200, headers });
}

/* ---------- service marks for the app tiles ---------- */

// Each tile shows the real mark of the service it opens, fetched from that
// service's own site and cached privately. A fixed allowlist, never a
// caller-supplied URL: this endpoint must not become an open proxy.
const ICON_HOSTS = new Set([
  'github.com', 'dash.cloudflare.com', 'www.cloudflare.com', 'claude.ai', 'grok.com',
  'arisehub.myfaithtech.com', 'itportal.myfaithtech.com', 'www.arisecenla.church',
  'apextraining.dev', 'ctrl-alt-pc-repair.dyer-hq.workers.dev',
]);
const ICON_PATHS = ['/apple-touch-icon.png', '/favicon.svg', '/favicon.ico', '/favicon.png'];
const ICON_TTL = 30 * 24 * 3600 * 1000;
const ICON_MAX = 256 * 1024;

const iconResponse = (body, type) => new Response(body, {
  headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' },
});

async function serveIcon(env, url) {
  const host = (url.searchParams.get('host') || '').toLowerCase();
  if (!ICON_HOSTS.has(host)) return json({ error: 'unknown host' }, 400);

  const key = `icons/${host}`;
  const cached = await env.MEDIA.get(key);
  const age = Date.now() - Number(cached?.customMetadata?.at || 0);
  if (cached && age < ICON_TTL) {
    return iconResponse(cached.body, cached.httpMetadata?.contentType || 'image/png');
  }

  for (const path of ICON_PATHS) {
    try {
      const res = await fetch(`https://${host}${path}`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !type.startsWith('image/')) continue;
      const buf = await res.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > ICON_MAX) continue;
      await env.MEDIA.put(key, buf, {
        httpMetadata: { contentType: type },
        customMetadata: { at: String(Date.now()) },
      });
      return iconResponse(buf, type);
    } catch {
      // try the next candidate path
    }
  }

  // a stale copy beats no mark at all when the site is unreachable
  if (cached) return iconResponse(cached.body, cached.httpMetadata?.contentType || 'image/png');
  return json({ error: 'no icon' }, 404);
}

/* ---------- chat archive (private, chunked in R2) ---------- */

const ARCHIVE_INDEX_KEY = 'archive/index.json';
const CHUNK_PREFIX = 'archive/chunk/';

// R2 pages a listing at 1000 keys, so follow the cursor or a big archive is only half swept
async function listChunkKeys(env) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await env.MEDIA.list({ prefix: CHUNK_PREFIX, cursor });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) return keys;
    cursor = page.cursor;
  }
}

// R2 takes at most 1000 keys per delete call
async function deleteKeys(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
}

const EMPTY_INDEX = { rev: 0, count: 0, chunks: [], updatedAt: 0, memories: '' };

// Returns { index, etag }. Only a genuinely ABSENT object may read as empty:
// reporting rev 0 for a populated archive invites a baseRev-0 push that
// overwrites the index and sweeps away every chunk it named. A stream error or
// corrupt JSON therefore throws, and the route wrapper answers 500.
async function readArchiveIndex(env) {
  const obj = await env.MEDIA.get(ARCHIVE_INDEX_KEY);
  if (!obj) return { index: { ...EMPTY_INDEX }, etag: null };
  const text = await obj.text(); // outside the guard: an IO failure is not "empty"
  let stored;
  try {
    stored = JSON.parse(text);
  } catch {
    throw new Error('stored archive index is unreadable');
  }
  return {
    index: {
      rev: Number.isInteger(stored?.rev) && stored.rev >= 0 ? stored.rev : 0,
      count: Number.isInteger(stored?.count) && stored.count >= 0 ? stored.count : 0,
      chunks: Array.isArray(stored?.chunks)
        ? stored.chunks.filter(id => typeof id === 'string' && ARCHIVE_ID_RE.test(id)).slice(0, MAX_CHUNKS)
        : [],
      updatedAt: Number.isInteger(stored?.updatedAt) && stored.updatedAt >= 0 ? stored.updatedAt : 0,
      memories: typeof stored?.memories === 'string' ? stored.memories : '',
    },
    etag: obj.etag,
  };
}

// chunks the new index no longer names are leftovers from a bigger push
async function sweepChunks(env, keep) {
  const stale = (await listChunkKeys(env)).filter(k => !keep.has(k.slice(CHUNK_PREFIX.length)));
  await deleteKeys(env, stale);
}

function chunkType(request) {
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/gzip' || ct === 'application/json' ? ct : 'application/octet-stream';
}

/* ---------- PTZ camera control (PTZOptics HTTP-CGI) ----------
   A general URL forwarder inside a signed-in Worker is a liability: anything
   that reached this endpoint could probe hosts the Worker can see. So the
   client never supplies a path or query. It names a command, and the query
   string is assembled here from a fixed table with numeric arguments clamped
   to the ranges the cameras document. */

const PAN_MAX = 24;
const TILT_MAX = 20;
const ZOOM_MAX = 7;
const PRESET_MAX = 254;

// command -> how its query string is built
const PTZ_MOVES = new Set([
  'up', 'down', 'left', 'right',
  'leftup', 'rightup', 'leftdown', 'rightdown',
]);
const PTZ_BARE = new Set(['ptzstop', 'home', 'zoomstop', 'focusstop']);
const PTZ_ZOOM = new Set(['zoomin', 'zoomout', 'focusin', 'focusout']);
const PTZ_PRESET = new Set(['poscall', 'posset']);

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
};

function ptzQuery(cmd, args = {}) {
  if (PTZ_BARE.has(cmd)) return `ptzcmd&${cmd}`;
  if (PTZ_MOVES.has(cmd)) {
    return `ptzcmd&${cmd}&${clamp(args.pan, 1, PAN_MAX, 12)}&${clamp(args.tilt, 1, TILT_MAX, 12)}`;
  }
  if (PTZ_ZOOM.has(cmd)) return `ptzcmd&${cmd}&${clamp(args.zoom, 0, ZOOM_MAX, 3)}`;
  if (PTZ_PRESET.has(cmd)) return `ptzcmd&${cmd}&${clamp(args.preset, 0, PRESET_MAX, 1)}`;
  return null;
}

// A camera address may carry a path prefix, because one tunnel hostname can
// front several cameras (https://dyerhq.example.com/cam1). Anything the caller
// puts there is kept as a prefix only — the endpoint itself is always ours.
function parseCameraBase(base) {
  let target;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  const prefix = target.pathname.replace(/\/+$/, '');
  if (prefix && !/^(\/[A-Za-z0-9._-]{1,40}){1,4}$/.test(prefix)) return null;
  return { target, prefix };
}

// Where PTZOptics models keep their still image; they disagree, so try each in
// turn and tell the client which one answered so it can skip the search later.
const SNAPSHOT_PATHS = ['/snapshot.jpg', '/cgi-bin/snapshot.cgi', '/tmpfs/auto.jpg', '/tmpfs/snap.jpg'];
const MAX_SNAPSHOT = 8 * 1024 * 1024;

async function handlePtzSnapshot(request) {
  const body = await request.json().catch(() => null);
  const parsed = parseCameraBase(body?.base);
  if (!parsed) return json({ error: 'camera address must be an http or https URL' }, 400);
  const { target, prefix } = parsed;

  // a remembered path is still only ever a path, never a host or a scheme
  const asked = body?.path;
  if (asked !== undefined && (typeof asked !== 'string' || !/^\/[A-Za-z0-9._\-/]{0,64}$/.test(asked))) {
    return json({ error: 'bad snapshot path' }, 400);
  }
  const candidates = asked ? [asked, ...SNAPSHOT_PATHS.filter(p => p !== asked)] : SNAPSHOT_PATHS;

  const headers = {};
  const user = body?.auth?.user;
  if (typeof user === 'string' && user) {
    const pass = typeof body.auth.pass === 'string' ? body.auth.pass : '';
    headers.authorization = `Basic ${btoa(`${user}:${pass}`)}`;
  }

  let lastStatus = 0;
  for (const candidate of candidates) {
    target.pathname = `${prefix}${candidate}`;
    target.search = '';
    let res;
    try {
      res = await fetch(target.toString(), { headers, signal: AbortSignal.timeout(6000), redirect: 'manual' });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      return json({ error: timedOut ? 'camera did not answer (is the tunnel up?)' : 'could not reach the camera' }, 504);
    }
    lastStatus = res.status;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith('image/')) continue;
    const size = Number(res.headers.get('content-length') || 0);
    if (size > MAX_SNAPSHOT) return json({ error: 'snapshot too large' }, 413);
    return new Response(res.body, {
      headers: {
        'content-type': type,
        'cache-control': 'no-store',
        'x-snapshot-path': candidate, // so the client stops hunting next time
      },
    });
  }
  return json({ error: `no snapshot image on this camera (last status ${lastStatus})` }, 502);
}

async function handlePtz(request) {
  const body = await request.json().catch(() => null);
  const cmd = body?.cmd;
  if (typeof cmd !== 'string') return json({ error: 'missing command' }, 400);

  const query = ptzQuery(cmd, body?.args);
  if (!query) return json({ error: `unsupported command: ${cmd.slice(0, 24)}` }, 400);

  const parsed = parseCameraBase(body.base);
  if (!parsed) return json({ error: 'camera address must be an http or https URL' }, 400);
  const { target, prefix } = parsed;
  // the endpoint is ours; only the configured prefix survives, so one tunnel
  // hostname can route several cameras by path (…/cam1, …/cam2)
  target.pathname = `${prefix}/cgi-bin/ptzctrl.cgi`;
  target.search = query;

  const headers = {};
  const user = body?.auth?.user;
  if (typeof user === 'string' && user) {
    const pass = typeof body.auth.pass === 'string' ? body.auth.pass : '';
    headers.authorization = `Basic ${btoa(`${user}:${pass}`)}`;
  }

  try {
    const res = await fetch(target.toString(), {
      headers,
      signal: AbortSignal.timeout(6000),
      redirect: 'manual', // a redirect would take us off the vetted path
    });
    if (!res.ok) return json({ error: `camera returned ${res.status}` }, 502);
    return json({ ok: true, cmd });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return json({ error: timedOut ? 'camera did not answer (is the tunnel up?)' : 'could not reach the camera' }, 504);
  }
}

async function handleArchive(request, env, path) {
  if (path === '/api/archive') {
    if (request.method !== 'DELETE') return json({ error: 'method not allowed' }, 405);
    const keys = await listChunkKeys(env);
    const index = await env.MEDIA.head(ARCHIVE_INDEX_KEY);
    await deleteKeys(env, keys);
    if (index) await env.MEDIA.delete(ARCHIVE_INDEX_KEY);
    return json({ ok: true, deleted: keys.length + (index ? 1 : 0) });
  }

  if (path === '/api/archive/index') {
    if (request.method === 'GET') return json((await readArchiveIndex(env)).index);
    if (request.method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_INDEX_BODY) return json({ error: 'body too large' }, 413);
      const body = await request.json().catch(() => null);
      if (!body || !Number.isInteger(body.baseRev) || body.baseRev < 0) {
        return json({ error: 'expected {baseRev, count, chunks, updatedAt, memories}' }, 400);
      }
      if (!Number.isInteger(body.count) || body.count < 0) return json({ error: 'bad count' }, 400);
      const chunks = body.chunks;
      if (!Array.isArray(chunks) || chunks.length > MAX_CHUNKS ||
          !chunks.every(id => typeof id === 'string' && ARCHIVE_ID_RE.test(id))) {
        return json({ error: 'bad chunk list' }, 400);
      }
      if (body.memories !== undefined && typeof body.memories !== 'string') {
        return json({ error: 'bad memories' }, 400);
      }

      const { index: current, etag } = await readArchiveIndex(env);
      if (body.baseRev !== current.rev) return json({ conflict: true, ...current }, 409);

      // an omitted field must not erase the stored text
      const memories = body.memories === undefined ? current.memories : body.memories;
      // the char length short-circuits so an oversized string is never encoded
      if (memories.length > MAX_MEMORIES ||
          new TextEncoder().encode(memories).length > MAX_MEMORIES) {
        return json({ error: 'memories too large' }, 400);
      }
      const updatedAt = Number.isInteger(body.updatedAt) && body.updatedAt >= 0
        ? body.updatedAt : Date.now();

      const next = { rev: current.rev + 1, count: body.count, chunks, updatedAt, memories };
      // compare-and-set in R2, not in JS: the rev check above is a read followed
      // by a write, so two devices pushing at once would both pass it and one
      // push would be lost along with the chunks the other's sweep deletes
      const written = await env.MEDIA.put(ARCHIVE_INDEX_KEY, JSON.stringify(next), {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
      });
      if (!written) {
        const fresh = await readArchiveIndex(env);
        return json({ conflict: true, ...fresh.index }, 409);
      }
      try {
        await sweepChunks(env, new Set(chunks));
      } catch {
        // the index is already written; a failed sweep only leaves garbage behind
      }
      return json({ rev: next.rev });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  const m = path.match(/^\/api\/archive\/chunk\/([^/]+)$/);
  if (m) {
    // the id charset never needs percent-encoding, so the raw segment is matched as-is
    const id = m[1];
    if (!ARCHIVE_ID_RE.test(id)) return json({ error: 'bad chunk id' }, 400);
    const key = CHUNK_PREFIX + id;

    if (request.method === 'GET') {
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: 'no chunk' }, 404);
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    }
    if (request.method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_CHUNK) return json({ error: 'chunk larger than 25 MB' }, 413);
      // buffered so the cap holds even when the request declares no length
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_CHUNK) return json({ error: 'chunk larger than 25 MB' }, 413);
      await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: chunkType(request) } });
      return json({ ok: true, bytes: bytes.byteLength });
    }
    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}

/* ---------- main ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* --- public endpoints --- */
    if (path === '/api/health') return json({ ok: true });

    if (path === '/api/auth/login' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const key = body?.key;
      if (typeof key !== 'string' || key.length < 6 || key.length > 200) {
        return json({ error: 'passphrase must be 6–200 characters' }, 400);
      }
      const result = await claimOrVerify(env, key);
      if (result === 'bad') return json({ error: 'wrong passphrase' }, 403);
      return json({ ok: true, claimed: result === 'claimed' },
        200, { 'set-cookie': await sessionCookie(env) });
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      return json({ ok: true }, 200, {
        'set-cookie': 'pd_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      });
    }

    if (PUBLIC_PATHS.some(re => re.test(path))) return env.ASSETS.fetch(request);

    /* --- sync API keeps its own passphrase-header auth (works headless) --- */
    if (path === '/api/sync/claim' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const key = body?.key;
      if (typeof key !== 'string' || key.length < 6 || key.length > 200) {
        return json({ error: 'key must be 6–200 characters' }, 400);
      }
      const result = await claimOrVerify(env, key);
      if (result === 'bad') return json({ error: 'a different passphrase is already set' }, 403);
      return json(result === 'claimed' ? { claimed: true } : { claimed: false, ok: true });
    }

    if (path === '/api/sync/state' && request.method === 'GET') {
      const denied = await requireSyncKey(request, env);
      if (denied) return denied;
      const { results } = await env.DB.prepare('SELECT col, rev, updated_at FROM kv_sync').all();
      const cols = {};
      for (const r of results) cols[r.col] = { rev: r.rev, updated_at: r.updated_at };
      return json({ cols });
    }

    const colMatch = path.match(/^\/api\/sync\/col\/([^/]+)$/);
    if (colMatch) {
      const col = decodeURIComponent(colMatch[1]);
      if (!COL_RE.test(col)) return json({ error: 'bad collection name' }, 400);
      const denied = await requireSyncKey(request, env);
      if (denied) return denied;

      if (request.method === 'GET') {
        const row = await env.DB.prepare('SELECT data, rev FROM kv_sync WHERE col = ?').bind(col).first();
        if (!row) return json({ rev: 0, data: null });
        return json({ rev: row.rev, data: JSON.parse(row.data) });
      }
      if (request.method === 'PUT') {
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_BODY) return json({ error: 'body too large' }, 413);
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: 'body too large' }, 413);
        let body;
        try { body = JSON.parse(text); } catch { body = undefined; }
        if (body === undefined || typeof body.baseRev !== 'number' || !('data' in body)) {
          return json({ error: 'expected {baseRev, data}' }, 400);
        }
        const row = await env.DB.prepare('SELECT data, rev FROM kv_sync WHERE col = ?').bind(col).first();
        const currentRev = row?.rev || 0;
        if (body.baseRev < currentRev) {
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

    /* --- everything below needs a session cookie --- */
    const authed = await hasSession(request, env);

    if (path === '/api/icon' && request.method === 'GET') {
      if (!authed) return json({ error: 'sign in first' }, 401);
      try {
        return await serveIcon(env, url);
      } catch {
        return json({ error: 'icon unavailable' }, 502);
      }
    }

    if (path.startsWith('/api/media/')) {
      if (!authed) return json({ error: 'sign in first' }, 401);
      if (path === '/api/media/bg' && request.method === 'PUT') {
        const len = Number(request.headers.get('content-length') || 0);
        if (!len) return json({ error: 'missing content-length' }, 411);
        if (len > MAX_VIDEO) return json({ error: 'video larger than 600 MB' }, 413);
        await env.MEDIA.put('bg.mp4', request.body, {
          httpMetadata: { contentType: videoType(request) },
        });
        return json({ ok: true, bytes: len });
      }
      if (path === '/api/media/bg' && request.method === 'DELETE') {
        await env.MEDIA.delete('bg.mp4');
        return json({ ok: true });
      }

      // multipart upload: the only way past the 100 MB edge limit on a request body
      if (path === '/api/media/bg/mpu/start' && request.method === 'POST') {
        // contentType can only be set when the upload is created, not at complete(),
        // so a browser-trimmed webm has to declare its container up front
        const started = await request.json().catch(() => null);
        const declared = (started?.type || '').split(';')[0].trim().toLowerCase();
        const contentType = /^video\/[a-z0-9.+-]{1,30}$/.test(declared) ? declared : 'video/mp4';
        try {
          const mpu = await env.MEDIA.createMultipartUpload('bg.mp4', {
            httpMetadata: { contentType },
          });
          return json({ uploadId: mpu.uploadId });
        } catch {
          return json({ error: 'could not start upload' }, 500);
        }
      }

      if (path === '/api/media/bg/mpu/part' && request.method === 'PUT') {
        const uploadId = url.searchParams.get('uploadId');
        if (!validUploadId(uploadId)) return json({ error: 'bad uploadId' }, 400);
        const raw = url.searchParams.get('part');
        const partNumber = Number(raw);
        if (!raw || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
          return json({ error: 'bad part number' }, 400);
        }
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_PART) return json({ error: 'part larger than 40 MB' }, 413);
        if (!request.body) return json({ error: 'missing part body' }, 400);
        try {
          const mpu = env.MEDIA.resumeMultipartUpload('bg.mp4', uploadId);
          const part = await mpu.uploadPart(partNumber, request.body);
          return json({ partNumber: part.partNumber, etag: part.etag });
        } catch {
          return json({ error: 'part upload failed' }, 400);
        }
      }

      if (path === '/api/media/bg/mpu/complete' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!validUploadId(body?.uploadId)) return json({ error: 'bad uploadId' }, 400);
        if (!Array.isArray(body.parts) || !body.parts.length) {
          return json({ error: 'expected {uploadId, parts}' }, 400);
        }
        const parts = [];
        for (const p of body.parts) {
          const n = p?.partNumber;
          const etag = p?.etag;
          if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS || typeof etag !== 'string' || !etag) {
            return json({ error: 'bad part list' }, 400);
          }
          parts.push({ partNumber: n, etag });
        }
        parts.sort((a, b) => a.partNumber - b.partNumber);
        try {
          const mpu = env.MEDIA.resumeMultipartUpload('bg.mp4', body.uploadId);
          const obj = await mpu.complete(parts);
          // the cap can only be checked once the parts are assembled
          if (obj?.size > MAX_VIDEO) {
            await env.MEDIA.delete('bg.mp4');
            return json({ error: 'video larger than 600 MB' }, 413);
          }
          return json({ ok: true, bytes: obj?.size ?? 0 });
        } catch {
          return json({ error: 'could not complete upload' }, 400);
        }
      }

      if (path === '/api/media/bg/mpu/abort' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!validUploadId(body?.uploadId)) return json({ error: 'bad uploadId' }, 400);
        try {
          await env.MEDIA.resumeMultipartUpload('bg.mp4', body.uploadId).abort();
        } catch {
          // an unknown or already-aborted upload leaves nothing to clean up
        }
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    }

    if (path === '/api/archive' || path.startsWith('/api/archive/')) {
      if (!authed) return json({ error: 'sign in first' }, 401);
      try {
        return await handleArchive(request, env, path);
      } catch {
        return json({ error: 'archive storage unavailable' }, 500);
      }
    }

    if (path === '/api/ptz' || path === '/api/ptz/snapshot') {
      if (!authed) return json({ error: 'sign in first' }, 401);
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return path === '/api/ptz' ? handlePtz(request) : handlePtzSnapshot(request);
    }

    if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

    if (!authed) {
      // navigations get the login screen; subresource requests get a plain 401
      const wantsHTML = (request.headers.get('Accept') || '').includes('text/html');
      return wantsHTML ? loginPage() : new Response('sign in first', { status: 401, headers: { 'cache-control': 'no-store' } });
    }

    if (path === '/media/bg.mp4') return serveVideo(request, env);

    // authed static assets, tagged so the service worker knows they're cacheable
    const res = await env.ASSETS.fetch(request);
    const tagged = new Response(res.body, res);
    tagged.headers.set('X-App-Shell', '1');
    return tagged;
  },
};
