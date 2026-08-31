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
    // whichever way the key changed, the cached data belongs to the old one —
    // and so does the penalty box, since the quota is counted per key
    await dropCache(env, 'xbox').catch(() => {});
    await dropCache(env, COOLDOWN_KEY).catch(() => {});
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

// OpenXBL has published two base URLs over the years, and one of them can
// answer 200 with a body that carries no profile at all — which used to cache
// as an empty gamertag and read on the card as "your key is dead". Try both and
// keep whichever actually returns something usable.
const XBL_HOSTS = ['https://xbl.io/api/v2', 'https://api.xbl.io/v2'];

// The free tier allows 60 calls per 300s, counted per KEY — not per host. When
// it is blown, OpenXBL answers **HTTP 200** with the limit as the BODY:
//   {"content":{"currentRequests":70,"maxRequests":60,
//    "periodInSeconds":300,"limitType":"Rate"},"code":429}
// so `!res.ok` sails straight past it and the empty body reads as "no profile".
// Worse, walking on to the second host spends another call against the same
// blown quota — the retry was digging the hole deeper. Detect it in the body,
// mark the error, and let every caller STOP rather than retry.
class XblRateLimited extends Error {
  constructor(seconds) {
    super('rate limit reached');
    this.rateLimited = true;
    this.retryAfterMs = Math.min(Math.max(Number(seconds) || 300, 60), 3600) * 1000;
  }
}

const rateLimitOf = body => {
  const c = body?.content;
  if (Number(body?.code) === 429 || c?.limitType === 'Rate') {
    return Number(c?.periodInSeconds) || 300;
  }
  return 0;
};

async function fetchXbl(pathname, key, base = XBL_HOSTS[0]) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-Authorization': key, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (res.status === 429) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    throw new XblRateLimited(Number(res.headers.get('retry-after')) || 300);
  }
  // A key OpenXBL refuses is not a transient outage — it is the one failure the
  // owner can actually DO something about, so it gets its own kind and the card
  // offers the key form back. Same shape PSN's expired-NPSSO path already uses.
  if (res.status === 401 || res.status === 403) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    const err = new Error(`OpenXBL rejected the key (${res.status})`);
    err.reauth = true;
    throw err;
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    throw new Error(`OpenXBL returned ${res.status}`);
  }
  const body = await res.json();
  const period = rateLimitOf(body);
  if (period) throw new XblRateLimited(period);
  return body;
}

// A blown quota is remembered, so the NEXT tile open does not spend four more
// calls discovering the same thing. Kept in the same D1 table as the payloads:
// one row, holding the timestamp the penalty box opens again.
const COOLDOWN_KEY = 'xbox_cooldown';

async function xblCoolingDown(env) {
  const row = await readCache(env, COOLDOWN_KEY).catch(() => null);
  const until = Number(row?.data?.until) || 0;
  return until > Date.now() ? until : 0;
}

const startCooldown = (env, err) =>
  writeCache(env, COOLDOWN_KEY, { until: Date.now() + (err?.retryAfterMs || 300000) })
    .catch(() => { /* the request still answers without it */ });

// The one shape every Xbox route returns while throttled: the last good
// snapshot when there is one, and always a message that names the real cause.
function throttled(cached, until) {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  const error = `Xbox Live is rate-limiting this key — retrying in about ${mins} minute${mins === 1 ? '' : 's'}`;
  if (cached) return json({ ...cached.data, stale: true, rateLimited: true, error });
  return json({ configured: true, rateLimited: true, error });
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

// Achievements come back in the same shape from OpenXBL and from Xbox Live
// itself — OpenXBL proxies this endpoint — so both paths normalize through here.
function normalizeAchievements(body) {
  const list = Array.isArray(body?.achievements) ? body.achievements : [];
  return {
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
}

async function handleXboxGames(env) {
  const mode = await xboxMode(env);
  if (mode === 'none') return json({ configured: false });
  if (mode === 'ms') return handleXboxGamesMs(env);
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });
  const cached = await readCache(env, 'xbox_games').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  const cooling = await xblCoolingDown(env);
  if (cooling) return throttled(cached, cooling);

  try {
    let data = null;
    for (const base of XBL_HOSTS) {
      let body;
      try {
        body = await fetchXbl('/player/titleHistory', key, base);
      } catch (err) {
        if (err?.rateLimited) throw err; // never spend the second host on a blown quota
        continue;
      }
      const d = normalizeXboxLibrary(body);
      if (d.games.length) { data = d; break; }
    }
    if (!data) throw new Error('no titles from either host');
    await writeCache(env, 'xbox_games', data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch (err) {
    if (err?.rateLimited) {
      await startCooldown(env, err);
      return throttled(cached, Date.now() + err.retryAfterMs);
    }
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXboxAchievements(env, url) {
  const titleId = str(url.searchParams.get('titleId'));
  if (!/^\d{1,15}$/.test(titleId)) return json({ error: 'bad titleId' }, 400);
  const mode = await xboxMode(env);
  if (mode === 'none') return json({ configured: false });
  if (mode === 'ms') return handleXboxAchievementsMs(env, titleId);
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });

  const cacheKey = `xbox_a_${titleId}`;
  const cached = await readCache(env, cacheKey).catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  const cooling = await xblCoolingDown(env);
  if (cooling) return throttled(cached, cooling);

  try {
    const body = await fetchXbl(`/achievements/title/${titleId}`, key);
    const data = normalizeAchievements(body);
    await writeCache(env, cacheKey, data).catch(() => { /* fresh data still goes out */ });
    return json(data);
  } catch (err) {
    if (err?.rateLimited) {
      await startCooldown(env, err);
      return throttled(cached, Date.now() + err.retryAfterMs);
    }
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

// The Microsoft-signed-in versions of the three Xbox reads. Same normalizers,
// same cache keys, same response shape — only the transport differs, so the
// dashboard never has to know which way in is live.
async function handleXboxMs(env) {
  const cached = await readCache(env, 'xbox').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);
  try {
    const data = await withXbox(env, async auth => {
      const [account, history] = await Promise.all([
        msProfile(auth),
        msTitles(auth).catch(() => null), // a profile with no history still shows
      ]);
      // mode rides along so the card can offer the right way back out: a
      // Microsoft sign-in is disconnected, an OpenXBL key is replaced
      return { ...normalizeXbox(account, history), mode: 'ms' };
    });
    if (data.profile.gamertag || data.recent.length) {
      await writeCache(env, 'xbox', data).catch(() => {});
      return json(data);
    }
    if (cached) return json({ ...cached.data, stale: true, error: 'Xbox Live sent nothing usable' });
    return json({ configured: true, error: 'Xbox Live sent nothing usable' });
  } catch (err) {
    if (err?.reauth) return json({ ...(cached ? { ...cached.data, stale: true } : {}), configured: true, error: 'reauth', mode: 'ms' });
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXboxGamesMs(env) {
  const cached = await readCache(env, 'xbox_games').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);
  try {
    const data = await withXbox(env, async auth => normalizeXboxLibrary(await msTitles(auth)));
    if (!data.games.length) throw new Error('no titles');
    await writeCache(env, 'xbox_games', data).catch(() => {});
    return json(data);
  } catch (err) {
    if (err?.reauth) return json({ configured: true, error: 'reauth', mode: 'ms' });
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXboxAchievementsMs(env, titleId) {
  const cacheKey = `xbox_a_${titleId}`;
  const cached = await readCache(env, cacheKey).catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);
  try {
    const body = await withXbox(env, auth => msAchievements(auth, titleId));
    const data = normalizeAchievements(body);
    await writeCache(env, cacheKey, data).catch(() => {});
    return json(data);
  } catch (err) {
    if (err?.reauth) return json({ configured: true, error: 'reauth', mode: 'ms' });
    if (cached) return json({ ...cached.data, stale: true });
    return json({ configured: true, error: 'Xbox Live is unreachable right now' }, 502);
  }
}

async function handleXbox(env) {
  const mode = await xboxMode(env);
  if (mode === 'none') return json({ configured: false });
  if (mode === 'ms') return handleXboxMs(env);
  const key = await readSecret(env, 'xbl_key');
  if (!key) return json({ configured: false });

  const cached = await readCache(env, 'xbox').catch(() => null);
  if (cached && cached.age < CACHE_MS) return json(cached.data);

  // still in the penalty box — spend no calls at all
  const cooling = await xblCoolingDown(env);
  if (cooling) return throttled(cached, cooling);

  // whichever host answers with a real profile wins; an empty answer is a
  // FAILURE, never something to cache over good data
  let note = '';
  for (const base of XBL_HOSTS) {
    try {
      // sequential, not Promise.all: two in flight is two against the quota
      // even when the first one already came back rate-limited
      const account = await fetchXbl('/account', key, base);
      const history = await fetchXbl('/player/titleHistory', key, base).catch(err => {
        if (err?.rateLimited) throw err;
        return null; // a profile with no history is still worth showing
      });
      const data = normalizeXbox(account, history);
      if (data.profile.gamertag || data.recent.length) {
        await writeCache(env, 'xbox', data).catch(() => { /* fresh data still goes out */ });
        return json(data);
      }
      note = `${base} answered, but with no profile — ${JSON.stringify(account).slice(0, 180)}`;
    } catch (err) {
      // the quota is per key, so the other host shares it: trying it next is
      // what took this account from 60 to 70 requests. Stop here.
      if (err?.rateLimited) {
        await startCooldown(env, err);
        return throttled(cached, Date.now() + err.retryAfterMs);
      }
      // a rejected key is rejected on both hosts — asking the second one only
      // wastes a call and delays telling the owner the one thing they can fix
      if (err?.reauth) {
        return json({ ...(cached ? { ...cached.data, stale: true } : {}), configured: true, error: 'reauth' });
      }
      note = `${base} — ${err?.message || 'unreachable'}`;
    }
  }
  // A key from an xbl.io account that was never activated authenticates fine and
  // answers 200 with no profile in it — indistinguishable from a broken key, and
  // it cost the owner an afternoon. If a host actually ANSWERED and simply had no
  // profile to give, name that cause; a connection that never landed is a
  // different problem and gets no such hint.
  const answered = /answered, but with no profile/.test(note);
  const hint = answered
    ? 'If xbl.io still says "activate your account", API access is off until you verify a mobile number there — the key is fine, the account just is not switched on yet.'
    : '';
  if (cached) return json({ ...cached.data, stale: true, error: 'Xbox Live sent nothing usable', upstream: note, hint });
  // surfaced on the card: a silent empty profile is impossible to diagnose
  return json({ configured: true, error: 'Xbox Live sent nothing usable', upstream: note, hint });
}

/* ---------- Xbox, signed in with Microsoft directly ----------

   The second way in, and the better one. OpenXBL is a middleman that needs a
   phone-verified account before it will serve anything, and caps the free tier
   at 60 calls per 300s. This path talks to Microsoft and Xbox Live itself:
   no middleman, no phone verification, no cap.

   CLIENT_ID below is Microsoft's own public Xbox client id — the one the Xbox
   app uses. It identifies the app, never the account, exactly like the PSN
   mobile client id above it; the account is the sign-in the owner does. So
   there is no Azure app to register.

   The chain, four calls:
     1. code  -> Microsoft access + refresh token   (login.microsoftonline.com)
     2. access-> XBL user token                     (user.auth.xboxlive.com)
     3. XBL   -> XSTS token + user hash + XUID      (xsts.auth.xboxlive.com)
     4. call Xbox Live as  Authorization: XBL3.0 x=<uhs>;<xsts>

   Steps 2-4 are redone from the stored refresh token whenever the cached XSTS
   expires, so the owner signs in once and the refresh token (~90 days) carries
   it from there. Only the refresh token is persisted as a secret; the XSTS
   token is short-lived and lives in the same cache table as the payloads. */

const MS_CLIENT_ID = '000000004C12AE6F';
const MS_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const MS_SCOPES = 'XboxLive.signin offline_access';
const MS_AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_AUTH = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBOX_XSTS_CACHE = 'xbox_xsts';

// The URL the owner opens to sign in. They land on a blank page whose ADDRESS
// carries ?code=… and paste that address back — the same paste-the-URL shape the
// PSN setup already uses, and the reason no redirect URI needs registering.
const msAuthorizeUrl = () =>
  `${MS_AUTHORIZE}?client_id=${MS_CLIENT_ID}&response_type=code&approval_prompt=auto` +
  `&scope=${encodeURIComponent(MS_SCOPES)}&redirect_uri=${encodeURIComponent(MS_REDIRECT)}`;

// Pull the authorization code out of whatever the owner pasted: the whole
// redirected URL, or just the code. Never accept a code from another host —
// a URL from anywhere else is not a Microsoft redirect.
function msCodeFrom(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^[\w.-]{6,2048}$/.test(raw) && !raw.includes('://')) return raw; // a bare code
  let u;
  try { u = new URL(raw); } catch { return ''; }
  if (u.hostname.toLowerCase() !== 'login.live.com') return '';
  const code = u.searchParams.get('code') || '';
  return /^[\w.-]{6,2048}$/.test(code) ? code : '';
}

async function msTokenRequest(params) {
  const res = await fetch(MS_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, redirect_uri: MS_REDIRECT, scope: MS_SCOPES, ...params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    // an expired/consumed code and a dead refresh token both mean "sign in again"
    throw Object.assign(new Error(str(body?.error_description) || `Microsoft returned ${res.status}`), { reauth: true });
  }
  return body;
}

// Xbox Live's own two-step: the Microsoft token buys an XBL token, which buys
// an XSTS token. The XSTS response carries the user hash and XUID every later
// call needs.
async function xblExchange(accessToken) {
  const xblRes = await fetch(XBL_AUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${accessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const xbl = await xblRes.json().catch(() => null);
  if (!xblRes.ok || !xbl?.Token) {
    throw Object.assign(new Error(`Xbox Live refused the sign-in (${xblRes.status})`), { reauth: true });
  }

  const xstsRes = await fetch(XSTS_AUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-xbl-contract-version': '1' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'http://xboxlive.com',
      TokenType: 'JWT',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const xsts = await xstsRes.json().catch(() => null);
  if (!xstsRes.ok || !xsts?.Token) {
    // 2148916233 = the Microsoft account has no Xbox profile yet; 2148916238 =
    // a child account that must be added to a family. Both are the owner's to
    // fix and neither is worth retrying.
    const code = str(xsts?.XErr || '');
    const why = code === '2148916233'
      ? 'that Microsoft account has no Xbox profile — sign in at xbox.com once to create one'
      : code === '2148916238'
        ? 'that account is a child account and needs adding to a family group first'
        : `Xbox Live declined the token (${xstsRes.status})`;
    throw Object.assign(new Error(why), { reauth: true });
  }
  const claim = xsts?.DisplayClaims?.xui?.[0] || {};
  const uhs = str(claim.uhs);
  if (!uhs) throw Object.assign(new Error('Xbox Live returned no user hash'), { reauth: true });
  return {
    token: xsts.Token,
    uhs,
    xuid: str(claim.xid),
    // expire a minute early so a call never starts on a token about to die
    exp: Date.parse(str(xsts.NotAfter)) || (Date.now() + 3600000),
  };
}

// The live XSTS credential: cached until it expires, otherwise minted again from
// the stored refresh token. Mirrors withPsnAccess's shape below.
async function xboxAuth(env, force = false) {
  if (!force) {
    const cached = await readCache(env, XBOX_XSTS_CACHE).catch(() => null);
    const c = cached?.data;
    if (c?.token && c?.uhs && Number(c.exp) - 60000 > Date.now()) return c;
  }
  const refresh = await readSecret(env, 'xbl_ms_refresh');
  if (!refresh) throw Object.assign(new Error('not signed in with Microsoft'), { reauth: true });
  const tok = await msTokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  // Microsoft rotates the refresh token; storing the new one is what keeps the
  // ~90-day window rolling instead of expiring on the original
  if (tok.refresh_token && tok.refresh_token !== refresh) {
    await upsertSecret(env, 'xbl_ms_refresh', tok.refresh_token).run().catch(() => {});
  }
  const auth = await xblExchange(tok.access_token);
  await writeCache(env, XBOX_XSTS_CACHE, auth).catch(() => {});
  return auth;
}

async function fetchXboxLive(url, auth, contract = '2') {
  const res = await fetch(url, {
    headers: {
      authorization: `XBL3.0 x=${auth.uhs};${auth.token}`,
      'x-xbl-contract-version': contract,
      'accept-language': 'en-US',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* noop */ }
    throw Object.assign(new Error(`Xbox Live returned ${res.status}`), { status: res.status });
  }
  return res.json();
}

// One 401 is what a just-expired XSTS looks like: mint a new one and try once more.
async function withXbox(env, fn) {
  let auth = await xboxAuth(env);
  try {
    return await fn(auth);
  } catch (err) {
    if (err?.status !== 401) throw err;
    auth = await xboxAuth(env, true);
    return fn(auth);
  }
}

const PROFILE_SETTINGS = 'Gamertag,ModernGamertag,Gamerscore,GameDisplayPicRaw,AppDisplayPicRaw';

// Xbox Live's own shapes happen to be the ones OpenXBL proxies, so normalizeXbox
// and normalizeXboxLibrary are reused verbatim rather than written twice.
const msProfile = auth =>
  fetchXboxLive(`https://profile.xboxlive.com/users/me/profile/settings?settings=${PROFILE_SETTINGS}`, auth);

// The profile is read as /users/me, but titles and achievements are addressed by
// XUID. An absent one would build "xuid()" and come back a bewildering 404, so
// it is checked once, here, with a message that says what actually happened.
function requireXuid(auth) {
  if (!/^\d{1,20}$/.test(String(auth?.xuid || ''))) {
    throw Object.assign(new Error('Xbox Live did not return an account id — sign in again'), { reauth: true });
  }
  return auth.xuid;
}

const msTitles = auth =>
  fetchXboxLive(
    `https://titlehub.xboxlive.com/users/xuid(${requireXuid(auth)})/titles/titlehistory/decoration/achievement,scid`,
    auth);

const msAchievements = (auth, titleId) =>
  fetchXboxLive(
    `https://achievements.xboxlive.com/users/xuid(${requireXuid(auth)})/achievements?titleId=${encodeURIComponent(titleId)}&maxItems=1000`,
    auth);

// Which way in is live. Microsoft wins when both exist: it is the one without a
// rate limit, and the one the owner signed into most recently.
async function xboxMode(env) {
  if (await readSecret(env, 'xbl_ms_refresh')) return 'ms';
  if (await readSecret(env, 'xbl_key')) return 'openxbl';
  return 'none';
}

// POST /api/gaming/xbox/msauth — GET returns the sign-in URL, POST finishes it.
async function handleXboxMsAuth(request, env) {
  if (request.method === 'GET') return json({ url: msAuthorizeUrl() });
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    // "" clears the sign-in — the way back out, and what a Disconnect sends
    if (body && body.clear === true) {
      await env.DB.batch([dropSecret(env, 'xbl_ms_refresh')]);
      await dropCache(env, XBOX_XSTS_CACHE).catch(() => {});
      await dropCache(env, 'xbox').catch(() => {});
      await dropCache(env, 'xbox_games').catch(() => {});
      return json({ ok: true, signedIn: false });
    }
    const code = msCodeFrom(body?.url ?? body?.code);
    if (!code) return json({ error: 'paste the whole address of the page you landed on (it contains ?code=…)' }, 400);
    try {
      const tok = await msTokenRequest({ grant_type: 'authorization_code', code });
      if (!tok.refresh_token) return json({ error: 'Microsoft did not return a refresh token — try signing in again' }, 502);
      // prove the whole chain works before storing anything: a refresh token
      // that cannot reach Xbox Live is worse than none, because the card would
      // then show "signed in" and never load
      const auth = await xblExchange(tok.access_token);
      const profile = await msProfile(auth).catch(() => null);
      await env.DB.batch([upsertSecret(env, 'xbl_ms_refresh', tok.refresh_token)]);
      await writeCache(env, XBOX_XSTS_CACHE, auth).catch(() => {});
      // a fresh sign-in invalidates whatever the old path had cached
      await dropCache(env, 'xbox').catch(() => {});
      await dropCache(env, 'xbox_games').catch(() => {});
      await dropCache(env, COOLDOWN_KEY).catch(() => {});
      const user = Array.isArray(profile?.profileUsers) ? profile.profileUsers[0] : null;
      return json({ ok: true, signedIn: true, gamertag: xblSetting(user, ['Gamertag', 'ModernGamertag']) });
    } catch (err) {
      return json({ error: err?.message || 'could not complete the Microsoft sign-in' }, 400);
    }
  }
  return json({ error: 'method not allowed' }, 405);
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
    if (path === '/api/gaming/xbox/msauth') return await handleXboxMsAuth(request, env);
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
