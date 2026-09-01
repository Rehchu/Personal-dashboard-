// Business bridges: read-only pulse endpoints for the other Dyer operations.
// Ctrl+Alt PC Repair (SHOP_DB) and the Arise IT portal (ARISE_IT_DB) are
// OTHER apps' production D1 databases — this file only ever SELECTs from
// them, and only the columns a dashboard card needs. AriseHub lives in
// Supabase and is reached over its REST API with a service-role key kept in
// the secrets table, never in the client.
//
// handleBiz(url, request, env) answers everything under /api/biz/ and
// returns null for any other path; index.js calls it AFTER the session
// check, so nothing here re-verifies the cookie.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/* ---------- per-isolate cache ----------
   The rail polls these badges, and every poll would otherwise land on
   another app's production database. A minute of staleness is invisible on
   a dashboard card; a query per poll is not invisible on the shop's D1. */

const CACHE_MS = 60 * 1000;
const cache = new Map(); // path -> { at, data }

function cached(path) {
  const hit = cache.get(path);
  return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
}

function remember(path, data) {
  cache.set(path, { at: Date.now(), data });
  return data;
}

/* ---------- shared helpers ---------- */

// A dashboard reads "3d" faster than a timestamp; anything unparseable
// (D1 dates are strings in whatever shape the app wrote) reads as unknown.
function ageDays(...candidates) {
  for (const c of candidates) {
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }
  return null;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/* ---------- Ctrl+Alt PC Repair (SHOP_DB) ---------- */

// The shop app grows statuses over time; a ticket is DONE only when it says
// so, and open otherwise — a status this list has never seen stays visible
// rather than silently vanishing from the queue.
const DONE = "('completed','cancelled','closed','picked_up')";

// The same rule for inquiries: a lead is waiting until a status says somebody
// dealt with it, and an unrecognised status stays in the queue rather than
// quietly vanishing. This used to be a bare COUNT(*) over every inquiry ever
// received, so the card read "15 leads waiting" and would have kept saying 15
// no matter how many got answered.
const LEAD_DONE = "('answered','replied','responded','closed','converted','won','lost','archived','spam','resolved','completed','cancelled')";

// 'internal' inquiries are the shop talking to itself. They are still waiting
// work, so they stay in `count`, but a real person expecting a reply is the
// number worth acting on — kept separate so twelve internal notes can never
// bury two customers asking for a repair quote.
function leadSummary(groups, newest) {
  const rows = (groups || []).map(r => ({ type: r.type || 'other', n: r.n || 0, oldest: r.oldest || null }));
  const sum = list => list.reduce((n, r) => n + r.n, 0);
  const earliest = list => list.reduce((m, r) => (r.oldest && (!m || r.oldest < m) ? r.oldest : m), null);
  const customer = rows.filter(r => r.type !== 'internal');

  return {
    count: sum(rows),
    customer: sum(customer),
    oldestCustomerAt: earliest(customer),
    byType: Object.fromEntries(rows.map(r => [r.type, r.n])),
    newest: (newest || []).map(l => ({
      name: l.name, subject: l.subject, type: l.type, ai_priority: l.ai_priority,
      status: l.status, created_at: l.created_at,
    })),
  };
}

async function shopPulse(env) {
  const hit = cached('shop');
  if (hit) return json(hit);
  if (!env.SHOP_DB) return json({ configured: false });

  // one batch, one round trip to the shop's D1
  const [tickets, leadGroups, leads, appt, invoices, taskCount, customerCount] =
    await env.SHOP_DB.batch([
      env.SHOP_DB.prepare(
        `SELECT t.ticket_number, t.status, t.priority,
                t.device_type, t.device_make, t.device_model,
                t.date_received, t.created_at,
                c.first_name, c.last_name
         FROM tickets t LEFT JOIN customers c ON c.id = t.customer_id
         WHERE lower(COALESCE(t.status,'')) NOT IN ${DONE}
         ORDER BY t.created_at DESC LIMIT 20`),
      // grouped, so one round trip yields the waiting count, the split between
      // real customers and the shop's own internal notes, and how long the
      // oldest of each has been sitting there
      env.SHOP_DB.prepare(
        `SELECT COALESCE(NULLIF(TRIM(type),''),'other') AS type,
                COUNT(*) AS n, MIN(created_at) AS oldest
         FROM inquiries
         WHERE lower(COALESCE(status,'')) NOT IN ${LEAD_DONE}
         GROUP BY COALESCE(NULLIF(TRIM(type),''),'other')`),
      env.SHOP_DB.prepare(
        `SELECT name, subject, type, ai_priority, status, created_at
         FROM inquiries
         WHERE lower(COALESCE(status,'')) NOT IN ${LEAD_DONE}
         ORDER BY created_at DESC LIMIT 5`),
      // date is 'YYYY-MM-DD' text, so string comparison IS date comparison
      env.SHOP_DB.prepare(
        `SELECT customer_name, title, type, date, time, duration_minutes, status
         FROM appointments
         WHERE date >= ? AND lower(COALESCE(status,'')) NOT IN ('cancelled','completed')
         ORDER BY date, time LIMIT 1`).bind(todayISO()),
      // unpaid means money still owed, whatever the status label says —
      // except statuses that mean the invoice no longer counts
      env.SHOP_DB.prepare(
        `SELECT invoice_number, total, amount_paid, due_date, status
         FROM invoices
         WHERE COALESCE(amount_paid, 0) < COALESCE(total, 0)
           AND lower(COALESCE(status,'')) NOT IN ('cancelled','void','draft','paid')
         ORDER BY due_date LIMIT 10`),
      env.SHOP_DB.prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE lower(COALESCE(status,'')) NOT IN ('completed','done','cancelled')`),
      env.SHOP_DB.prepare('SELECT COUNT(*) AS n FROM customers'),
    ]);

  const body = {
    configured: true,
    tickets: (tickets.results || []).map(t => ({
      number: t.ticket_number,
      status: t.status,
      priority: t.priority,
      device: [t.device_make, t.device_model].filter(Boolean).join(' ') || t.device_type || 'Device',
      customer: [t.first_name, t.last_name].filter(Boolean).join(' ') || null,
      ageDays: ageDays(t.date_received, t.created_at),
    })),
    leads: leadSummary(leadGroups.results, leads.results),
    nextAppointment: appt.results?.[0] || null,
    unpaidInvoices: (invoices.results || []).map(i => ({
      number: i.invoice_number, total: i.total, paid: i.amount_paid,
      due: i.due_date, status: i.status,
    })),
    openTasks: taskCount.results?.[0]?.n ?? 0,
    customers: customerCount.results?.[0]?.n ?? 0,
  };
  return json(remember('shop', body));
}

/* ---------- Arise IT portal (ARISE_IT_DB) ---------- */

async function ariseItPulse(env) {
  const hit = cached('ariseit');
  if (hit) return json(hit);
  if (!env.ARISE_IT_DB) return json({ configured: false });

  const [open, recent, byStatus] = await env.ARISE_IT_DB.batch([
    env.ARISE_IT_DB.prepare(
      `SELECT id, subject, requester_name, category, priority, status, due_at, created_at
       FROM tickets
       WHERE lower(COALESCE(status,'')) NOT IN ('closed','resolved','cancelled','done')
       ORDER BY created_at DESC LIMIT 15`),
    env.ARISE_IT_DB.prepare(
      `SELECT id, subject, requester_name, status, created_at
       FROM tickets ORDER BY created_at DESC LIMIT 10`),
    env.ARISE_IT_DB.prepare(
      'SELECT status, COUNT(*) AS n FROM tickets GROUP BY status'),
  ]);

  const counts = {};
  for (const r of byStatus.results || []) counts[r.status] = r.n;

  const body = {
    configured: true,
    open: (open.results || []).map(t => ({
      id: t.id, subject: t.subject, requester: t.requester_name,
      category: t.category, priority: t.priority, status: t.status,
      due_at: t.due_at, ageDays: ageDays(t.created_at),
    })),
    recent: recent.results || [],
    counts,
  };
  return json(remember('ariseit', body));
}

/* ---------- AriseHub (Supabase REST) ---------- */

const ARISE_BASE = 'https://luzmqpfsylpqxbwzyjcz.supabase.co/rest/v1';

async function getAriseKey(env) {
  const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('arise_key').first();
  return row?.v || null;
}

// One PostgREST read. The whole endpoint fails soft, so a single slow table
// must not hang the card — each call gets its own short timeout.
function sbFetch(key, path, { head = false } = {}) {
  return fetch(`${ARISE_BASE}/${path}`, {
    method: head ? 'HEAD' : 'GET',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...(head ? { prefer: 'count=exact' } : {}),
    },
    signal: AbortSignal.timeout(5000),
  });
}

// PostgREST answers a HEAD + count=exact with Content-Range: 0-24/137 —
// the number after the slash is the count without shipping any rows.
async function sbCount(key, path) {
  const res = await sbFetch(key, path, { head: true });
  if (!res.ok) return null;
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

async function sbRows(key, path) {
  const res = await sbFetch(key, path);
  if (!res.ok) throw new Error(`supabase ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function arisePulse(env) {
  const key = await getAriseKey(env);
  if (!key) return json({ configured: false });

  try {
    // the next Sunday's plan first, because the other reads hang off its id
    const plans = await sbRows(key,
      `service_plans?select=id,title,service_date&service_date=gte.${todayISO()}&order=service_date.asc&limit=1`);
    const plan = plans[0] || null;

    let planDetail = null;
    if (plan) {
      const [itemCount, assignments] = await Promise.all([
        sbCount(key, `plan_items?select=id&plan_id=eq.${plan.id}`),
        sbRows(key, `plan_assignments?select=status&plan_id=eq.${plan.id}&limit=200`),
      ]);
      planDetail = {
        title: plan.title,
        date: plan.service_date,
        items: itemCount ?? 0,
        accepted: assignments.filter(a => a.status === 'accepted').length,
        positions: assignments.length,
      };
    }

    // open + in_progress is the maintenance queue as the app itself defines
    // it (its own "active" index covers exactly those two statuses)
    const [maintenance, prayer, announcements] = await Promise.all([
      sbCount(key, 'maintenance_requests?select=id&status=in.(open,in_progress)'),
      sbCount(key, 'prayer_requests?select=id&status=eq.open'),
      sbRows(key,
        'announcements?select=title,starts_on,created_at&status=eq.approved&show_in_app=is.true&order=created_at.desc&limit=5'),
    ]);

    return json({
      configured: true,
      nextPlan: planDetail,
      openMaintenance: maintenance ?? 0,
      openPrayer: prayer ?? 0,
      announcements,
    });
  } catch {
    // Supabase down, key revoked, or a timeout: the card shows "unreachable"
    // instead of the whole dashboard erroring
    return json({ configured: true, error: 'unreachable' });
  }
}

/* ---------- key management ----------
   The client may set the AriseHub key and may learn whether one is stored.
   A stored key never travels back to the browser. */

async function handleKeys(request, env) {
  if (request.method === 'GET') {
    return json({ arise: !!(await getAriseKey(env)) });
  }
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const key = body?.arise_key;
    if (typeof key !== 'string' || key.length > 2000) {
      return json({ error: 'expected {arise_key} (empty string clears it)' }, 400);
    }
    if (key === '') {
      await env.DB.prepare('DELETE FROM secrets WHERE k = ?').bind('arise_key').run();
      return json({ arise: false });
    }
    await env.DB.prepare(
      `INSERT INTO secrets (k, v) VALUES ('arise_key', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(key).run();
    return json({ arise: true });
  }
  return json({ error: 'method not allowed' }, 405);
}

/* ---------- router ---------- */

export async function handleBiz(url, request, env) {
  const path = url.pathname;
  if (!path.startsWith('/api/biz/')) return null;

  if (path === '/api/biz/keys') return handleKeys(request, env);

  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  try {
    if (path === '/api/biz/shop') return await shopPulse(env);
    if (path === '/api/biz/ariseit') return await ariseItPulse(env);
    if (path === '/api/biz/arise') return await arisePulse(env);
  } catch {
    // a bridge failing must read as "unreachable", never take the shell down
    return json({ error: 'unreachable' }, 502);
  }

  return json({ error: 'not found' }, 404);
}
