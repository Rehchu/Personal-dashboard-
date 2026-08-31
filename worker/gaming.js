// Gaming bridge: Xbox (OpenXBL) and PlayStation (PSN mobile API) profiles and
// recently-played lists, normalized to one small shape the dashboard renders.
// Keys never leave the Worker — the client may POST them and may learn whether
// one is configured, but a stored key is never echoed back. Everything the
// consoles return is cached in D1 so the dashboard opens instantly and still
// shows something when an upstream is down (marked {stale: true}).
//
// Called from index.js AFTER the session gate — nothing here re-checks auth,
// so the route must never be wired in front of that check.

const CACHE_MS = 10 * 60 * 1000;   // upstreams are slow and rate-limited; ten minutes is plenty fresh for a dashboard tile
const FETCH_TIMEOUT = 10000;
const RECENT_LIMIT = 12;

// Sony's public mobile-app OAuth client. These are the same for every user of
// the official PlayStation app — they identify the app, not the account; the
// account is the NPSSO cookie the owner pastes in.
const PSN_CLIENT = '09515159-7237-4370-9b40-3806e67c0891';
const PSN_CLIENT_SECRET = 'ucPjka5tntB2KqsP';
const PSN_REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const PSN_AUTHORIZE =
  'https://ca.account.sony.com/api/authz/v3/oauth/authorize' +
  '?access_type=offline' +
  `&client_id=${PSN_CLIENT}` +
  '&redirect_uri=com.scee.psxandroid.scecompcall%3A%2F%2Fredirect' +
  '&response_type=code' +
  '&scope=psn%3Amobile.v2.core%20psn%3Aclientapp';
const PSN_TOKEN_URL = 'https://ca.account.sony.com/api/authz/v3/oauth/token';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// upstream numbers arrive as numbers, strings, or not at all
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = v => (typeof v === 'string' ? v : '');

/* ---------- secrets (same table the session secret lives in) ---------- */

async function readSecret(env, k) {
  const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind(k).first();
  return row?.v ?? null;
}

const upsertSecret = (env, k, v) =>
  env.DB.prepare(
    'INSERT INTO secrets (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).bind(k, v);

const dropSecret = (env, k) =>
  env.DB.prepare('DELETE FROM secrets WHERE k = ?').bind(k);

/* ---------- normalized-response cache ---------- */

// Created on first use rather than by a migration, so a fresh deploy needs no
// manual step. Memoized per isolate; reset on failure so a transient D1 error
// does not wedge the bridge for the isolate's lifetime.
let cacheReady = null;
function ensureCacheTable(env) {
  if (!cacheReady) {
    cacheReady = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS gaming_cache (k TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)',
    ).run().catch(err => { cacheReady = null; throw err; });
  }
  return cacheReady;
}

async function readCache(env, k) {
  await ensureCacheTable(env);
  const row = await env.DB.prepare('SELECT data, fetched_at FROM gaming_cache WHERE k = ?')
    .bind(k).first();
  if (!row?.data) return null;
  try {
    return { data: JSON.parse(row.data), age: Date.now() - (Number(row.fetched_at) || 0) };
  } catch {
    return null; // an unreadable row is the same as no cache
  }
}

async function writeCache(env, k, data) {
  await ensureCacheTable(env);
  await env.DB.prepare(
    `INSERT INTO gaming_cache (k, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  ).bind(k, JSON.stringify(data), Date.now()).run();
}

async function dropCache(env, k) {
  await ensureCacheTable(env);
  await env.DB.prepare('DELETE FROM gaming_cache WHERE k = ?').bind(k).run();
}

/* ---------- keys ---------- */

const PSN_TOKEN_KEYS = ['psn_access', 'psn_access_exp', 'psn_refresh', 'psn_refresh_exp'];

async function handleKeys(request, env) {
  if (request.method === 'GET') {
    const [xbl, npsso] = await Promise.all([
      readSecret(env, 'xbl_key'), readSecret(env, 'psn_npsso'),
    ]);
    return json({ xbox: !!xbl, psn: !!npsso });
  }
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ error: 'expected {xbl_key?, psn_npsso?}' }, 400);
  }

  const stmts = [];

  if ('xbl_key' in body) {
    if (typeof body.xbl_key !== 'string' || body.xbl_key.length > 200) {
      return json({ error: 'bad xbl_key' }, 400);
    }
    const v = body.xbl_key.trim();
    stmts.push(v ? upsertSecret(env, 'xbl_key', v) : dropSecret(env, 'xbl_key'));
    // whichever way the key changed, the cached data belongs to the old one
    await dropCache(env, 'xbox').catch(() => {});
  }

  if ('psn_npsso' in body) {
    if (typeof body.psn_npsso !== 'string' || body.psn_npsso.length > 1024) {
      return json({ error: 'bad psn_npsso' }, 400);
    }
    const v = body.psn_npsso.trim();
    stmts.push(v ? upsertSecret(env, 'psn_npsso', v) : dropSecret(env, 'psn_npsso'));
    // a new NPSSO means a fresh sign-in (possibly a different account): the
    // old access/refresh tokens and the data fetched with them are dead weight
    for (const k of PSN_TOKEN_KEYS) stmts.push(dropSecret(env, k));
    await dropCache(env, 'psn').catch(() => {});
  }

  if (stmts.length) await env.DB.batch(stmts);

  const [xbl, npsso] = await Promise.all([
    readSecret(env, 'xbl_key'), readSecret(env, 'psn_npsso'),
  ]);
  return json({ ok: true, xbox: !!xbl, psn: !!npsso });
}

/* ---------- Xbox via OpenXBL ---------- */

async function fetchXbl(pathname, key) {
  const res = await fetch(`https://xbl.io/api/v2${pathname}`, {
    headers: { 'X-Authorization': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    throw new Error(`OpenXBL returned ${res.status}`);
  }
  return res.json();
}

// Profile fields live in a settings array of {id, value} pairs, and OpenXBL
// has moved them around before — hunt by id and never assume presence.
function xblSetting(user, ids) {
  const settings = Array.isArray(user?.settings) ? user.settings : [];
  for (const id of ids) {
    const hit = settings.find(s => s?.id === id && typeof s.value === 'string');
    if (hit) return hit.value;
  }
  return '';
}

function normalizeXbox(account, history) {
  const user = Array.isArray(account?.profileUsers) ? account.profileUsers[0] : account;
  const profile = {
    gamertag: xblSetting(user, ['Gamertag', 'ModernGamertag']),
    gamerscore: num(xblSetting(user, ['Gamerscore'])),
    avatar: xblSetting(user, ['GameDisplayPicRaw', 'AppDisplayPicRaw', 'DisplayPicRaw']),
  };
  const titles = Array.isArray(history?.titles) ? history.titles : [];
  const recent = titles
    .filter(t => t && typeof t.name === 'string')
    .map(t => {
      const ach = (t.achievement && typeof t.achievement === 'object') ? t.achievement : {};
      return {
        name: t.name,
        art: str(t.displayImage),
        lastPlayed: str(t.titleHistory?.lastTimePlayed) || str(t.lastTimePlayed) || null,
        earned: num(ach.currentAchievements),
        total: num(ach.totalAchievements),
        score: num(ach.currentGamerscore),
      };
    })
    .sort((a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')))
    .slice(0, RECENT_LIMIT);
  return { configured: true, profile, recent };
}

// The full shelf, not just the recent twelve: every title Xbox has history
// for, newest-played first, with the ids the achievements view needs.
function normalizeXboxLibrary(history) {
  const titles = Array.isArray(history?.titles) ? history.titles : [];
  return {
    configured: true,
    games: titles
      .filter(t => t && typeof t.name === 'string')
      .map(t => {
        const ach = (t.achievement && typeof t.achievement === 'object') ? t.achievement : {};
        return {
          id: str(t.titleId),
          name: t.name,
          art: str(t.displayImage),
          lastPlayed: str(t.titleHistory?.lastTimePlayed) || str(t.lastTimePlayed) || null,
          earned: num(ach.currentAchievements),
          total: num(ach.totalAchievements),
          score: num(ach.currentGamerscore),
          maxScore: num(ach.totalGamerscore),
        };
      })
      .sort((a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || ''))),
  };
}

async function handleXboxGames(env) {
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });
  const cached = await readCache(env, 'xbox_games').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);
  try {
    const data = normalizeXboxLibrary(await fetchXbl('/player/titleHistory', key));
    await writeCache(env, 'xbox_games', data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch {
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXboxAchievements(env, url) {
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });
  const titleId = str(url.searchParams.get('titleId'));
  if (!/^\d{1,15}$/.test(titleId)) return json({ error: 'bad titleId' }, 400);

  const cacheKey = `xbox_a_${titleId}`;
  const cached = await readCache(env, cacheKey).catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  try {
    const body = await fetchXbl(`/achievements/title/${titleId}`, key);
    const list = Array.isArray(body?.achievements) ? body.achievements : [];
    const data = {
      configured: true,
      achievements: list.map(a => ({
        name: str(a?.name),
        detail: str(a?.description) || str(a?.lockedDescription),
        icon: str(Array.isArray(a?.mediaAssets) ? a.mediaAssets[0]?.url : ''),
        score: num(Array.isArray(a?.rewards) ? a.rewards.find(r => r?.type === 'Gamerscore')?.value : 0),
        unlocked: a?.progressState === 'Achieved',
        unlockedAt: str(a?.progression?.timeUnlocked) || null,
        rarity: num(a?.rarity?.currentPercentage),
      })).sort((a, b) => Number(b.unlocked) - Number(a.unlocked)),
    };
    await writeCache(env, cacheKey, data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch {
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXbox(env) {
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });

  const cached = await readCache(env, 'xbox').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  try {
    const [account, history] = await Promise.all([
      fetchXbl('/account', key),
      fetchXbl('/player/titleHistory', key),
    ]);
    const data = normalizeXbox(account, history);
    await writeCache(env, 'xbox', data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch {
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

/* ---------- PlayStation ---------- */

// The NPSSO cookie is effectively single-use for the code exchange and expires
// on its own schedule, so it is spent as rarely as possible: a stored access
// token is used until near expiry, then the refresh token (~2 months) mints a
// new one, and only when refresh fails is the NPSSO burned on a full exchange.

const reauthError = () => Object.assign(new Error('reauth'), { reauth: true });

async function psnTokenRequest(params) {
  const res = await fetch(PSN_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${PSN_CLIENT}:${PSN_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    return null;
  }
  const tok = await res.json().catch(() => null);
  return typeof tok?.access_token === 'string' ? tok : null;
}

// NPSSO -> one-time auth code, carried home in the Location header of a
// redirect we deliberately do not follow (the target is an app-scheme URL).
async function psnAuthCode(npsso) {
  const res = await fetch(PSN_AUTHORIZE, {
    headers: { cookie: `npsso=${npsso}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  try { await res.body?.cancel(); } catch { /* noop */ }
  const m = (res.headers.get('location') || '').match(/[?&]code=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function storePsnTokens(env, tok) {
  const now = Date.now();
  const stmts = [
    upsertSecret(env, 'psn_access', tok.access_token),
    upsertSecret(env, 'psn_access_exp', String(now + num(tok.expires_in) * 1000)),
  ];
  // a refresh response may omit the refresh token; keep the one we have
  if (typeof tok.refresh_token === 'string') {
    stmts.push(
      upsertSecret(env, 'psn_refresh', tok.refresh_token),
      upsertSecret(env, 'psn_refresh_exp', String(now + num(tok.refresh_token_expires_in) * 1000)),
    );
  }
  await env.DB.batch(stmts);
  return tok.access_token;
}

// Returns a usable access token or throws a .reauth error meaning the whole
// chain — stored tokens, refresh, and the NPSSO itself — is spent.
async function psnAccessToken(env, npsso, force = false) {
  const now = Date.now();

  if (!force) {
    const [access, exp] = await Promise.all([
      readSecret(env, 'psn_access'), readSecret(env, 'psn_access_exp'),
    ]);
    if (access && num(exp) > now + 60000) return access;
  }

  const [refresh, refreshExp] = await Promise.all([
    readSecret(env, 'psn_refresh'), readSecret(env, 'psn_refresh_exp'),
  ]);
  if (refresh && num(refreshExp) > now + 60000) {
    const tok = await psnTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      token_format: 'jwt',
      scope: 'psn:mobile.v2.core psn:clientapp',
    }).catch(() => null);
    if (tok) return storePsnTokens(env, tok);
  }

  // last resort: spend the NPSSO
  const code = await psnAuthCode(npsso).catch(() => null);
  if (!code) throw reauthError();
  const tok = await psnTokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: PSN_REDIRECT,
    token_format: 'jwt',
  }).catch(() => null);
  if (!tok) throw reauthError();
  return storePsnTokens(env, tok);
}

async function fetchPsn(pathname, access) {
  const res = await fetch(`https://m.np.playstation.com/api/trophy/v1${pathname}`, {
    headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    const err = new Error(`PSN returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const psnTrophyCounts = t => ({
  platinum: num(t?.platinum), gold: num(t?.gold), silver: num(t?.silver), bronze: num(t?.bronze),
});

function normalizePsn(summary, titlesBody) {
  const titles = Array.isArray(titlesBody?.trophyTitles) ? titlesBody.trophyTitles : [];
  return {
    configured: true,
    summary: { level: num(summary?.trophyLevel), ...psnTrophyCounts(summary?.earnedTrophies) },
    recent: titles
      .filter(t => t && typeof t.trophyTitleName === 'string')
      .slice(0, RECENT_LIMIT)
      .map(t => ({
        name: t.trophyTitleName,
        art: str(t.trophyTitleIconUrl),
        progress: num(t.progress),
        earned: psnTrophyCounts(t.earnedTrophies),
      })),
  };
}

async function handlePsn(env) {
  const npsso = await readSecret(env, 'psn_npsso');
  if (!npsso) return json({ configured: false });

  const cached = await readCache(env, 'psn').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  const reauthBody = { configured: true, error: 'reauth', hint: 'paste a fresh NPSSO' };

  let access;
  try {
    access = await psnAccessToken(env, npsso);
  } catch {
    // stale data is still worth showing under the reauth banner
    return json(cached ? { ...cached.data, stale: true, ...reauthBody } : reauthBody);
  }

  const pull = tok => Promise.all([
    fetchPsn('/users/me/trophySummary', tok),
    fetchPsn(`/users/me/trophyTitles?limit=${RECENT_LIMIT}`, tok),
  ]);

  try {
    let summary, titles;
    try {
      [summary, titles] = await pull(access);
    } catch (err) {
      // a 401 here means Sony invalidated the token early — one forced
      // refresh/re-auth, then give up rather than loop
      if (err?.status !== 401) throw err;
      access = await psnAccessToken(env, npsso, true);
      [summary, titles] = await pull(access);
    }
    const data = normalizePsn(summary, titles);
    await writeCache(env, 'psn', data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch (err) {
    if (err?.reauth || err?.status === 401) {
      return json(cached ? { ...cached.data, stale: true, ...reauthBody } : reauthBody);
    }
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'PlayStation Network is unreachable right now' }, 502);
  }
}

// Run a PSN pull with the stored access token, retrying once through a forced
// refresh on a 401 — the same dance handlePsn does, shared by the new views.
async function withPsnAccess(env, npsso, fn) {
  let access = await psnAccessToken(env, npsso);
  try {
    return await fn(access);
  } catch (err) {
    if (err?.status !== 401) throw err;
    access = await psnAccessToken(env, npsso, true);
    return fn(access);
  }
}

async function handlePsnGames(env) {
  const npsso = await readSecret(env, 'psn_npsso');
  if (!npsso) return json({ configured: false });
  const cached = await readCache(env, 'psn_games').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);
  try {
    const body = await withPsnAccess(env, npsso, tok =>
      fetchPsn('/users/me/trophyTitles?limit=200', tok));
    const titles = Array.isArray(body?.trophyTitles) ? body.trophyTitles : [];
    const data = {
      configured: true,
      games: titles
        .filter(t => t && typeof t.trophyTitleName === 'string')
        .map(t => ({
          id: str(t.npCommunicationId),
          platform: str(t.trophyTitlePlatform),
          name: t.trophyTitleName,
          art: str(t.trophyTitleIconUrl),
          progress: num(t.progress),
          earned: psnTrophyCounts(t.earnedTrophies),
          defined: psnTrophyCounts(t.definedTrophies),
        })),
    };
    await writeCache(env, 'psn_games', data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch (err) {
    if (err?.reauth || err?.status === 401) {
      return json({ configured: true, error: 'reauth', hint: 'paste a fresh NPSSO' });
    }
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'PlayStation Network is unreachable right now' }, 502);
  }
}

async function handlePsnTrophies(env, url) {
  const npsso = await readSecret(env, 'psn_npsso');
  if (!npsso) return json({ configured: false });
  const id = str(url.searchParams.get('id'));
  const platform = str(url.searchParams.get('platform'));
  if (!/^[A-Z0-9_]{6,24}$/.test(id)) return json({ error: 'bad id' }, 400);
  // PS5-era titles speak the default service; everything older needs the
  // legacy npServiceName=trophy suffix on both calls
  const svc = /PS5/i.test(platform) ? '' : '?npServiceName=trophy';

  const cacheKey = `psn_t_${id}`;
  const cached = await readCache(env, cacheKey).catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  try {
    const [defs, mine] = await withPsnAccess(env, npsso, tok => Promise.all([
      fetchPsn(`/npCommunicationIds/${id}/trophyGroups/all/trophies${svc}`, tok),
      fetchPsn(`/users/me/npCommunicationIds/${id}/trophyGroups/all/trophies${svc}`, tok),
    ]));
    const byId = new Map();
    for (const t of Array.isArray(mine?.trophies) ? mine.trophies : []) byId.set(num(t?.trophyId), t);
    const data = {
      configured: true,
      trophies: (Array.isArray(defs?.trophies) ? defs.trophies : []).map(t => {
        const own = byId.get(num(t?.trophyId)) || {};
        return {
          name: str(t?.trophyName),
          detail: str(t?.trophyDetail),
          icon: str(t?.trophyIconUrl),
          type: str(t?.trophyType),
          earned: !!own.earned,
          earnedAt: str(own.earnedDateTime) || null,
          rarity: Number.isFinite(Number(own.trophyEarnedRate)) ? Number(own.trophyEarnedRate) : null,
        };
      }).sort((a, b) => Number(b.earned) - Number(a.earned)),
    };
    await writeCache(env, cacheKey, data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch (err) {
    if (err?.reauth || err?.status === 401) {
      return json({ configured: true, error: 'reauth', hint: 'paste a fresh NPSSO' });
    }
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'PlayStation Network is unreachable right now' }, 502);
  }
}

/* ---------- entry ---------- */

export async function handleGaming(url, request, env) {
  const path = url.pathname;
  if (!path.startsWith('/api/gaming/')) return null;
  try {
    if (path === '/api/gaming/keys') return await handleKeys(request, env);
    if (path === '/api/gaming/xbox') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handleXbox(env);
    }
    if (path === '/api/gaming/psn') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handlePsn(env);
    }
    if (path === '/api/gaming/xbox/games') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handleXboxGames(env);
    }
    if (path === '/api/gaming/xbox/achievements') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handleXboxAchievements(env, url);
    }
    if (path === '/api/gaming/psn/games') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handlePsnGames(env);
    }
    if (path === '/api/gaming/psn/trophies') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handlePsnTrophies(env, url);
    }
    return json({ error: 'not found' }, 404);
  } catch (err) {
    return json({ error: err?.message || 'gaming bridge unavailable' }, 500);
  }
}
