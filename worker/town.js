// Dyer Town bridge. The town itself — the agents, their thinking, the Claude
// calls — runs on the owner's Mac (the town server), because the Agent SDK
// rides his Claude subscription and that login lives there, not in a Worker.
// This file is the meeting point: the Mac pushes the town's state here and
// collects visitor messages; the dashboard's Dyer Town tile reads the state
// and drops messages in, from any device.
//
// Auth is split by direction. The Mac authenticates with the sync passphrase
// (X-Sync-Key — the same secret /api/sync already trusts, verified by the
// checkSyncKey function index.js passes in). The dashboard reads arrive behind
// the session gate in index.js, like every other /api route.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const MAX_STATE = 512 * 1024;   // a town snapshot is a few KB; half a MB is generous
const MAX_MSG = 500;

// Building art for the animated map. Generated once on Higgsfield, pulled by
// the Worker (this container of code never proxies arbitrary hosts — same
// allowlist discipline as bgimport.js) and kept in R2 under fixed keys.
const ART_KINDS = new Set([
  // structures the agents build
  'house', 'shop', 'landmark',
  // the districts' own businesses
  'repairshop', 'chapel', 'gym', 'library', 'kitchen', 'plaza',
  // the townsfolk themselves
  'char_ctrl', 'char_arise', 'char_apex', 'char_draco', 'char_spork',
  // one shared sprite for in-world hires (hue-shifted client-side) and the owner
  'char_hire', 'char_boss',
  // front/back walk sheets per villager (side view + flip covers left/right)
  'char_ctrl_front', 'char_ctrl_back', 'char_arise_front', 'char_arise_back',
  'char_apex_front', 'char_apex_back', 'char_draco_front', 'char_draco_back',
  'char_spork_front', 'char_spork_back',
  // the Studio district and its two townsfolk
  'studio', 'char_meta', 'char_meta_front', 'char_watch', 'char_watch_front',
]);
const MAX_ART = 8 * 1024 * 1024;   // a 1k PNG is ~1–2 MB
function artHostAllowed(host) {
  const h = host.toLowerCase();
  if (h === 'd8j0ntlcm91z4.cloudfront.net') return true;
  if (h === 'higgsfield.ai' || h.endsWith('.higgsfield.ai')) return true;
  return false;
}

// Created on first use so a deploy needs no migration step (gaming_cache pattern).
let ready = null;
function ensureTables(env) {
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS town_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT, updated_at INTEGER)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS town_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT, message TEXT, reply TEXT,
        created_at INTEGER, replied_at INTEGER)`),
      // corporate inbox: agents escalate, the owner rules, verdicts flow back.
      // id is the town's own approval id, so a re-pushed request can't duplicate.
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS town_approvals (
        id INTEGER PRIMARY KEY,
        agent TEXT, question TEXT,
        decision TEXT, note TEXT,
        delivered INTEGER DEFAULT 0,
        created_at INTEGER, decided_at INTEGER)`),
    ]).catch(err => { ready = null; throw err; });
  }
  return ready;
}

export async function handleTown(url, request, env, { authed, syncKeyOk }) {
  const path = url.pathname;
  if (!path.startsWith('/api/town/')) return null;
  await ensureTables(env);

  // ---- dashboard side (session cookie) ----

  if (path === '/api/town/state' && request.method === 'GET') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const row = await env.DB.prepare('SELECT data, updated_at FROM town_state WHERE id = 1').first();
    if (!row?.data) return json({ online: false });
    let state;
    try { state = JSON.parse(row.data); } catch { return json({ online: false }); }
    // "online" means the Mac pushed recently — two minutes covers a slow tick
    return json({ online: Date.now() - (row.updated_at || 0) < 120000, updatedAt: row.updated_at, state });
  }

  if (path === '/api/town/chat' && request.method === 'POST') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const body = await request.json().catch(() => null);
    const agentId = typeof body?.agentId === 'string' ? body.agentId.slice(0, 40) : '';
    const message = typeof body?.message === 'string' ? body.message.trim().slice(0, MAX_MSG) : '';
    if (!agentId || !message) return json({ error: 'expected {agentId, message}' }, 400);
    const r = await env.DB.prepare(
      'INSERT INTO town_chat (agent_id, message, created_at) VALUES (?, ?, ?)',
    ).bind(agentId, message, Date.now()).run();
    return json({ ok: true, id: r.meta?.last_row_id ?? null });
  }

  const pollMatch = path.match(/^\/api\/town\/chat\/(\d{1,12})$/);
  if (pollMatch && request.method === 'GET') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const row = await env.DB.prepare('SELECT reply, replied_at FROM town_chat WHERE id = ?')
      .bind(Number(pollMatch[1])).first();
    if (!row) return json({ error: 'no such message' }, 404);
    return json({ reply: row.reply ?? null, repliedAt: row.replied_at ?? null });
  }

  const artMatch = path.match(/^\/api\/town\/art\/([a-z0-9_]{1,20})$/);
  if (artMatch && request.method === 'GET') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    if (!ART_KINDS.has(artMatch[1])) return json({ error: 'unknown art kind' }, 404);
    const obj = await env.MEDIA.get(`town/art2/${artMatch[1]}`);
    if (!obj) return json({ error: 'no art yet' }, 404);
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType || 'image/png',
        'cache-control': 'private, max-age=86400',
      },
    });
  }

  if (path === '/api/town/art' && request.method === 'POST') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const body = await request.json().catch(() => null);
    const kind = ART_KINDS.has(body?.kind) ? body.kind : null;
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!kind || !raw) return json({ error: 'expected {kind, url}' }, 400);
    let target;
    try { target = new URL(raw); } catch { return json({ error: 'not a valid URL' }, 400); }
    if (target.protocol !== 'https:') return json({ error: 'only https URLs are allowed' }, 400);
    if (target.username || target.password) return json({ error: 'credentials in the URL are not allowed' }, 400);
    if (!artHostAllowed(target.hostname)) return json({ error: 'that host is not on the import allowlist' }, 400);
    let res;
    try {
      res = await fetch(target.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    } catch { return json({ error: 'could not reach the source' }, 502); }
    if (!res.ok || !res.body) return json({ error: `source returned ${res.status}` }, 502);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/[a-z0-9.+-]{1,30}$/.test(type)) return json({ error: 'that URL did not return an image' }, 415);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_ART) return json({ error: 'image too large' }, 413);
    const key = `town/art2/${kind}`;
    let obj;
    try {
      obj = await env.MEDIA.put(key, res.body, { httpMetadata: { contentType: type } });
    } catch { return json({ error: 'could not store the image' }, 502); }
    if ((obj?.size ?? 0) > MAX_ART || !obj?.size) {
      await env.MEDIA.delete(key);
      return json({ error: obj?.size ? 'image too large' : 'the source sent no data' }, obj?.size ? 413 : 502);
    }
    return json({ ok: true, kind, bytes: obj.size });
  }

  if (path === '/api/town/approvals' && request.method === 'GET') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const { results } = await env.DB.prepare(
      `SELECT id, agent, question, decision, note, created_at FROM town_approvals
       ORDER BY id DESC LIMIT 30`,
    ).all();
    return json({ approvals: results || [] });
  }

  if (path === '/api/town/decide' && request.method === 'POST') {
    if (!authed) return json({ error: 'sign in first' }, 401);
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    const decision = body?.decision === 'approve' ? 'approve' : body?.decision === 'deny' ? 'deny' : null;
    const note = typeof body?.note === 'string' ? body.note.slice(0, 200) : '';
    if (!Number.isInteger(id) || !decision) return json({ error: "expected {id, decision: 'approve'|'deny', note?}" }, 400);
    await env.DB.prepare(
      'UPDATE town_approvals SET decision = ?, note = ?, decided_at = ? WHERE id = ? AND decision IS NULL',
    ).bind(decision, note, Date.now(), id).run();
    return json({ ok: true });
  }

  // ---- town-server side (sync passphrase) ----

  if (path === '/api/town/approval' && request.method === 'POST') {
    if (!syncKeyOk) return json({ error: 'bad key' }, 401);
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    const agent = typeof body?.agent === 'string' ? body.agent.slice(0, 40) : '';
    const question = typeof body?.question === 'string' ? body.question.slice(0, 400) : '';
    if (!Number.isInteger(id) || !agent || !question) return json({ error: 'expected {id, agent, question}' }, 400);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO town_approvals (id, agent, question, created_at) VALUES (?, ?, ?, ?)',
    ).bind(id, agent, question, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/town/decisions' && request.method === 'GET') {
    if (!syncKeyOk) return json({ error: 'bad key' }, 401);
    const { results } = await env.DB.prepare(
      'SELECT id, decision, note FROM town_approvals WHERE decision IS NOT NULL AND delivered = 0 LIMIT 20',
    ).all();
    const decisions = results || [];
    if (decisions.length) {
      await env.DB.batch(decisions.map(d =>
        env.DB.prepare('UPDATE town_approvals SET delivered = 1 WHERE id = ?').bind(d.id)));
    }
    return json({ decisions });
  }

  if (path === '/api/town/state' && request.method === 'POST') {
    if (!syncKeyOk) return json({ error: 'bad key' }, 401);
    const text = await request.text();
    if (text.length > MAX_STATE) return json({ error: 'state too large' }, 413);
    try { JSON.parse(text); } catch { return json({ error: 'not JSON' }, 400); }
    await env.DB.prepare(
      `INSERT INTO town_state (id, data, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).bind(text, Date.now()).run();
    return json({ ok: true });
  }

  if (path === '/api/town/inbox' && request.method === 'GET') {
    if (!syncKeyOk) return json({ error: 'bad key' }, 401);
    const { results } = await env.DB.prepare(
      'SELECT id, agent_id, message FROM town_chat WHERE reply IS NULL ORDER BY id LIMIT 10',
    ).all();
    return json({ pending: (results || []).map(r => ({ id: r.id, agentId: r.agent_id, message: r.message })) });
  }

  if (path === '/api/town/reply' && request.method === 'POST') {
    if (!syncKeyOk) return json({ error: 'bad key' }, 401);
    const body = await request.json().catch(() => null);
    const id = Number(body?.id);
    const reply = typeof body?.reply === 'string' ? body.reply.slice(0, 2000) : '';
    if (!Number.isInteger(id) || !reply) return json({ error: 'expected {id, reply}' }, 400);
    await env.DB.prepare('UPDATE town_chat SET reply = ?, replied_at = ? WHERE id = ? AND reply IS NULL')
      .bind(reply, Date.now(), id).run();
    // old answered rows are of no further use; keep the table from growing forever
    await env.DB.prepare('DELETE FROM town_chat WHERE replied_at IS NOT NULL AND replied_at < ?')
      .bind(Date.now() - 7 * 24 * 3600 * 1000).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}
