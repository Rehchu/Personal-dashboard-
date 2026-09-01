// Mission Control — the live pulse of the two Dyer operations that run on their
// own stacks: Ctrl+Alt PC Repair (the shop) and Arise Church (its IT queue plus
// this Sunday's plan from AriseHub). The Worker's /api/biz/* bridges do the
// reading; this module only paints and links back into the real staff apps.
//
// Same discipline as github.js/today.js: last good payload is cached in
// localStorage so the view (and the rail badge, and the activity cards) paint
// instantly and still say something useful offline.

import { load, save, esc, showToast } from './store.js';

const SHOP_APP = 'https://ctrl-alt-pc-repair.dyer-hq.workers.dev/app';
const ARISE_APP = 'https://arisehub.myfaithtech.com';
const IT_APP = 'https://itportal.myfaithtech.com';

const CACHE = { shop: 'biz.shop', arise: 'biz.arise', it: 'biz.ariseit' };

// One fetch, folded into "no session / unreachable / here's the data". Callers
// never throw — a dead bridge shows a quiet note, never an error screen.
async function pull(path, cacheKey) {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (cacheKey) save(cacheKey, { at: Date.now(), data });
    return data;
  } catch {
    const cached = cacheKey ? load(cacheKey, null) : null;
    return cached ? { ...cached.data, _stale: true } : { _error: true };
  }
}

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0);
const money = n => `$${num(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ago = d => (d === null || d === undefined ? '' : d === 0 ? 'today' : `${d}d`);

// created_at arrives as SQLite's 'YYYY-MM-DD HH:MM:SS'. Safari refuses to parse
// that with a space in it, so normalise to ISO before measuring or the age
// silently reads as blank on the iPad.
const daysSince = ts => {
  if (!ts) return null;
  const t = Date.parse(String(ts).replace(' ', 'T'));
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
};

// The tile answers "how many people are waiting on me", not "how many rows are
// in the table". Internal notes are real work but nobody is sitting there
// wondering why the shop never wrote back, so they never set the alarm colour.
function leadTile(leads) {
  const waiting = num(leads.customer);
  const days = daysSince(leads.oldestCustomerAt);
  const label = waiting && days !== null
    ? (days === 0 ? 'waiting · came in today' : `waiting · oldest ${days}d`)
    : 'customers waiting';
  return statTile(waiting, label, waiting ? 'warn' : 'good');
}

const PRIORITY = { high: '#d64545', urgent: '#d64545', medium: '#c98a1a', normal: '#5a8f9a', low: '#5a8f9a' };
function prioChip(p) {
  const key = String(p || '').toLowerCase();
  const color = PRIORITY[key] || 'var(--ink-3)';
  return p ? `<span class="biz-chip" style="--c:${color}">${esc(p)}</span>` : '';
}

function injectStyle() {
  if (document.getElementById('biz-style')) return;
  const style = document.createElement('style');
  style.id = 'biz-style';
  style.textContent = `
    .biz-seg { display:flex; gap:8px; margin:0 0 16px; }
    .biz-seg button { flex:1; padding:10px; border-radius:12px; border:1px solid var(--line,rgba(255,255,255,.12));
      background:var(--surface-2); color:var(--ink-2); font:700 14px var(--font-display,system-ui);
      letter-spacing:.03em; cursor:pointer; transition:all .15s; }
    .biz-seg button.on { background:var(--accent); color:#fff; border-color:transparent; }
    .biz-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin-bottom:18px; }
    .biz-stat { padding:14px 16px; border-radius:14px; background:var(--surface-2); border:1px solid var(--line,rgba(255,255,255,.08)); }
    .biz-stat .n { font:800 1.9rem var(--font-display,system-ui); color:var(--ink); line-height:1; }
    .biz-stat .n.warn { color:#e0913a; }
    .biz-stat .n.good { color:#3fae6a; }
    .biz-stat .l { margin-top:6px; font-size:12.5px; color:var(--ink-2); }
    .biz-panel { padding:16px; border-radius:14px; background:var(--surface-2); border:1px solid var(--line,rgba(255,255,255,.08)); margin-bottom:16px; }
    .biz-panel h3 { margin:0 0 12px; font:700 15px var(--font-display,system-ui); color:var(--ink); display:flex; align-items:center; gap:8px; }
    .biz-panel h3 a { margin-left:auto; font:600 12.5px var(--font-body,system-ui); color:var(--accent); text-decoration:none; }
    .biz-row { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--line,rgba(255,255,255,.07)); }
    .biz-row:first-of-type { border-top:0; }
    .biz-row .main { min-width:0; flex:1; }
    .biz-row .t { color:var(--ink); font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .biz-row .s { color:var(--ink-2); font-size:12.5px; margin-top:2px; }
    .biz-row .r { color:var(--ink-3); font-size:12px; white-space:nowrap; }
    .biz-chip { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; color:var(--c); border:1px solid color-mix(in oklab, var(--c) 45%, transparent); white-space:nowrap; }
    .biz-clear { text-align:center; padding:26px 16px; color:var(--ink-2); }
    .biz-clear .big { font-size:2.4rem; }
    .biz-clear .msg { margin-top:8px; font:700 15px var(--font-display,system-ui); color:var(--ink); }
    .biz-note { font-size:12.5px; color:var(--ink-3); margin:2px 0 14px; }
    .biz-launch { display:inline-block; margin-top:4px; padding:9px 16px; border-radius:10px; background:var(--accent); color:#fff; text-decoration:none; font-weight:700; font-size:13.5px; }
    @media (prefers-reduced-motion: no-preference) { .biz-panel { animation:biz-in .35s ease both; } @keyframes biz-in { from { opacity:0; transform:translateY(6px); } } }`;
  document.head.append(style);
}

function statTile(n, label, tone) {
  return `<div class="biz-stat"><div class="n ${tone || ''}">${n}</div><div class="l">${label}</div></div>`;
}

function clearState(emoji, msg) {
  return `<div class="biz-clear"><div class="big">${emoji}</div><div class="msg">${msg}</div></div>`;
}

function renderShop(d) {
  if (d._error) return `<div class="biz-panel">${clearState('🔌', 'The shop bridge is unreachable.')}
    <p class="biz-note" style="text-align:center">Check that the SHOP_DB binding is deployed.</p></div>`;
  if (d.configured === false) return `<div class="biz-panel">${clearState('🖥️', 'Shop database not connected yet.')}</div>`;

  const tickets = d.tickets || [];
  const leads = d.leads || { count: 0, customer: 0, oldestCustomerAt: null, byType: {}, newest: [] };
  const invoices = d.unpaidInvoices || [];
  const appt = d.nextAppointment;
  const owed = invoices.reduce((s, i) => s + (num(i.total) - num(i.paid)), 0);

  const stale = d._stale ? '<p class="biz-note">⚠ showing the last cached snapshot — the shop bridge did not answer.</p>' : '';

  const stats = `<div class="biz-stats">
    ${statTile(tickets.length, 'open tickets', tickets.length ? 'warn' : 'good')}
    ${leadTile(leads)}
    ${statTile(invoices.length, invoices.length ? `unpaid · ${money(owed)}` : 'invoices clear', invoices.length ? 'warn' : 'good')}
    ${statTile(appt ? '1' : '—', 'next appointment')}
  </div>`;

  const ticketRows = tickets.length ? tickets.slice(0, 8).map(t => `
    <div class="biz-row">
      <div class="main">
        <div class="t">${esc(t.device || 'Device')}${t.customer ? ` · ${esc(t.customer)}` : ''}</div>
        <div class="s">#${esc(t.number || '—')} · ${esc(t.status || 'open')}</div>
      </div>
      ${prioChip(t.priority)}
      <span class="r">${ago(t.ageDays)}</span>
    </div>`).join('') : clearState('✅', 'No tickets in the queue.');

  const internalWaiting = num(leads.byType?.internal);
  const leadRows = ((leads.newest || []).length ? leads.newest.map(l => `
    <div class="biz-row">
      <div class="main">
        <div class="t">${esc(l.name || 'Someone')}${l.type === 'internal' ? '<span class="biz-chip" style="--c:var(--ink-3)">internal</span>' : ''}</div>
        <div class="s">${esc(l.subject || l.status || 'new inquiry')}</div>
      </div>
      ${prioChip(l.ai_priority)}
      <span class="r">${ago(daysSince(l.created_at))}</span>
    </div>`).join('') : clearState('📭', 'Nothing waiting — inbox is clear.'))
    + (internalWaiting ? `<p class="biz-note">${internalWaiting} internal note${internalWaiting === 1 ? '' : 's'} also open — not customers waiting on a reply.</p>` : '');

  const invoiceRows = invoices.length ? invoices.slice(0, 6).map(i => `
    <div class="biz-row">
      <div class="main">
        <div class="t">#${esc(i.number || '—')} · ${money(i.total)}</div>
        <div class="s">${i.due ? `due ${esc(i.due)}` : 'no due date'}${num(i.paid) ? ` · ${money(i.paid)} paid` : ''}</div>
      </div>
    </div>`).join('') : '';

  const apptCard = appt ? `<div class="biz-panel">
    <h3>Next appointment <a href="${SHOP_APP}/appointments" target="_blank" rel="noopener">Calendar ↗</a></h3>
    <div class="biz-row"><div class="main">
      <div class="t">${esc(appt.title || appt.type || 'Appointment')}${appt.customer_name ? ` · ${esc(appt.customer_name)}` : ''}</div>
      <div class="s">${esc(appt.date || '')}${appt.time ? ` · ${esc(appt.time)}` : ''}</div>
    </div></div></div>` : '';

  return `${stale}${stats}
    <div class="biz-panel"><h3>🎫 Open tickets <a href="${SHOP_APP}/tickets" target="_blank" rel="noopener">All tickets ↗</a></h3>${ticketRows}</div>
    <div class="biz-panel"><h3>📨 Leads waiting <a href="${SHOP_APP}/inquiries" target="_blank" rel="noopener">Inbox ↗</a></h3>${leadRows}</div>
    ${apptCard}
    ${invoices.length ? `<div class="biz-panel"><h3>💸 Unpaid invoices <a href="${SHOP_APP}/invoices" target="_blank" rel="noopener">Invoices ↗</a></h3>${invoiceRows}</div>` : ''}`;
}

function renderArise(it, hub) {
  const parts = [];

  // This Sunday, from AriseHub (Supabase). Configured separately from the IT DB.
  if (hub && hub.configured === false) {
    parts.push(`<div class="biz-panel">${clearState('⛪', 'Connect AriseHub to see this Sunday.')}
      <p class="biz-note" style="text-align:center">Add the AriseHub service key in the control center → Connections.</p></div>`);
  } else if (hub && hub.error === 'unreachable') {
    parts.push(`<div class="biz-panel"><h3>⛪ This Sunday</h3><p class="biz-note">AriseHub did not answer — try again shortly.</p></div>`);
  } else if (hub && hub.nextPlan) {
    const p = hub.nextPlan;
    const staffed = p.positions ? Math.round((p.accepted / p.positions) * 100) : 0;
    parts.push(`<div class="biz-panel">
      <h3>⛪ This Sunday <a href="${ARISE_APP}" target="_blank" rel="noopener">AriseHub ↗</a></h3>
      <div class="biz-row"><div class="main">
        <div class="t">${esc(p.title || 'Service plan')}</div>
        <div class="s">${esc(p.date || '')} · ${p.items} plan items</div>
      </div><span class="biz-chip" style="--c:${staffed >= 100 ? '#3fae6a' : staffed >= 60 ? '#c98a1a' : '#d64545'}">${p.accepted}/${p.positions} staffed</span></div>
    </div>`);
  } else if (hub && hub.configured) {
    parts.push(`<div class="biz-panel"><h3>⛪ This Sunday</h3><p class="biz-note">No upcoming service plan scheduled.</p></div>`);
  }

  // Announcements from AriseHub
  if (hub && Array.isArray(hub.announcements) && hub.announcements.length) {
    const rows = hub.announcements.map(a => `
      <div class="biz-row"><div class="main">
        <div class="t">${esc(a.title || 'Announcement')}</div>
        ${a.starts_on ? `<div class="s">${esc(a.starts_on)}</div>` : ''}
      </div></div>`).join('');
    parts.push(`<div class="biz-panel"><h3>📣 Announcements</h3>${rows}</div>`);
  }

  // Maintenance + prayer counts
  if (hub && hub.configured && !hub.error) {
    parts.push(`<div class="biz-stats">
      ${statTile(num(hub.openMaintenance), 'maintenance open', num(hub.openMaintenance) ? 'warn' : 'good')}
      ${statTile(num(hub.openPrayer), 'prayer requests')}
    </div>`);
  }

  // IT queue, from the Arise IT portal D1
  if (it && it._error) {
    parts.push(`<div class="biz-panel">${clearState('🧰', 'The IT bridge is unreachable.')}</div>`);
  } else if (it && it.configured === false) {
    parts.push(`<div class="biz-panel">${clearState('🧰', 'IT portal database not connected.')}</div>`);
  } else if (it) {
    const open = it.open || [];
    const stale = it._stale ? '<p class="biz-note">⚠ last cached snapshot.</p>' : '';
    const rows = open.length ? open.slice(0, 8).map(t => `
      <div class="biz-row">
        <div class="main">
          <div class="t">${esc(t.subject || 'Ticket')}</div>
          <div class="s">${esc(t.requester || 'someone')}${t.category ? ` · ${esc(t.category)}` : ''}</div>
        </div>
        ${prioChip(t.priority)}
        <span class="r">${ago(t.ageDays)}</span>
      </div>`).join('') : clearState('✅', 'IT queue is clear.');
    parts.push(`<div class="biz-panel">${stale}
      <h3>🧰 IT tickets <a href="${IT_APP}" target="_blank" rel="noopener">IT portal ↗</a></h3>${rows}</div>`);
  }

  return parts.join('') || `<div class="biz-panel">${clearState('⛪', 'Nothing to show yet.')}</div>`;
}

export function mount(root, tools) {
  injectStyle();

  let tab = load('biz.tab', 'shop');
  let shopData = null, itData = null, hubData = null;
  let alive = true;

  root.innerHTML = `
    <div class="biz-seg">
      <button data-tab="shop">🖥️ Ctrl+Alt Shop</button>
      <button data-tab="arise">⛪ Arise Church</button>
    </div>
    <div id="biz-body"><p class="muted">Loading the pulse…</p></div>`;

  const body = root.querySelector('#biz-body');
  const seg = root.querySelectorAll('.biz-seg button');

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn small';
  refreshBtn.textContent = '⟳ Refresh';
  tools.append(refreshBtn);

  function paint() {
    seg.forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (!alive) return;
    if (tab === 'shop') {
      body.innerHTML = shopData ? renderShop(shopData) : '<p class="muted">Loading…</p>';
    } else {
      body.innerHTML = (itData || hubData) ? renderArise(itData, hubData) : '<p class="muted">Loading…</p>';
    }
  }

  async function loadAll() {
    // paint whatever the cache has first, then live-update each as it lands
    shopData = load(CACHE.shop, null)?.data || null;
    itData = load(CACHE.it, null)?.data || null;
    hubData = load(CACHE.arise, null)?.data || null;
    paint();

    const [shop, it, hub] = await Promise.all([
      pull('/api/biz/shop', CACHE.shop),
      pull('/api/biz/ariseit', CACHE.it),
      pull('/api/biz/arise', CACHE.arise),
    ]);
    if (!alive) return;
    shopData = shop; itData = it; hubData = hub;
    paint();
  }

  seg.forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab; save('biz.tab', tab); paint();
  }));
  refreshBtn.addEventListener('click', () => { showToast('Refreshing…'); loadAll(); });

  loadAll();

  return function unmount() { alive = false; };
}
