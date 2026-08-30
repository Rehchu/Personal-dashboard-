// Dyer Town — the AI city, inside the dashboard. The town itself lives on the
// owner's Mac (agents think with his Claude subscription through the Agent SDK);
// the Mac pushes its state to the Worker and this module paints it: the map,
// who's where, what's been built, the live feed — and a chat that queues your
// message for an agent and shows their in-character answer when the town picks
// it up (a few seconds; the Mac polls between ticks).

import { load, save, esc, showToast } from './store.js';

const KIND_ICO = { house: '🏠', shop: '🏪', landmark: '🗼' };

function injectStyle() {
  if (document.getElementById('town-style')) return;
  const style = document.createElement('style');
  style.id = 'town-style';
  style.textContent = `
    #town-grid { display:grid; grid-template-columns: 1.3fr 1fr; gap:16px; align-items:start; }
    @media (max-width: 860px){ #town-grid { grid-template-columns:1fr; } }
    .town-map { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
    .town-place { background:var(--surface-2); border:1px solid color-mix(in oklab,var(--ink-3) 28%,transparent);
      border-radius:12px; padding:10px 12px; min-height:78px; }
    .town-place .pn { font-size:11px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.08em; }
    .town-place .row { margin-top:6px; display:flex; flex-wrap:wrap; gap:5px; }
    .town-pill { font-size:12px; padding:2px 8px; border-radius:999px;
      background:color-mix(in oklab,var(--accent) 20%,transparent);
      border:1px solid color-mix(in oklab,var(--accent) 38%,transparent); color:var(--ink); }
    .town-pill.bld { background:color-mix(in oklab,#e0b23a 16%,transparent); border-color:color-mix(in oklab,#e0b23a 42%,transparent); }
    .town-feed { max-height:300px; overflow:auto; }
    .town-ev { padding:6px 0; border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); font-size:13.5px; color:var(--ink-2); }
    .town-ev:first-child { border-top:0; }
    .town-ev b { color:var(--accent); }
    .town-ev .t { color:var(--ink-3); font-size:11px; margin-right:6px; }
    .town-agent { display:flex; align-items:baseline; gap:8px; padding:8px 0;
      border-top:1px solid color-mix(in oklab,var(--ink-3) 18%,transparent); }
    .town-agent:first-child { border-top:0; }
    .town-agent .nm { font-weight:700; color:var(--ink); }
    .town-agent .rl { color:var(--ink-3); font-size:12.5px; }
    .town-agent .co { margin-left:auto; color:#e0b23a; font-size:13px; }
    .town-chatlog { margin-top:10px; max-height:180px; overflow:auto; display:flex; flex-direction:column; gap:6px; }
    .town-msg { padding:7px 11px; border-radius:10px; font-size:13.5px; max-width:85%; }
    .town-msg.me { align-self:flex-end; background:var(--surface-2); }
    .town-msg.them { align-self:flex-start; background:color-mix(in oklab,var(--accent) 15%,var(--surface-2)); }
    .town-chat-row { display:flex; gap:8px; margin-top:10px; }
    .town-chat-row select, .town-chat-row input { padding:8px 10px; font-size:15px; }
    .town-chat-row input { flex:1; min-width:0; }
    .town-off { text-align:center; padding:30px 16px; color:var(--ink-2); }
    .town-off .big { font-size:2.4rem; }`;
  document.head.append(style);
}

export function mount(root, tools) {
  injectStyle();
  let alive = true;
  let timer = 0;
  let agentsSig = '';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn small';
  refreshBtn.textContent = '⟳ Refresh';
  tools.append(refreshBtn);

  root.innerHTML = `
    <div id="town-grid">
      <div>
        <div class="panel"><h3>The town</h3><div class="town-map" id="town-map"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Live feed</h3><div class="town-feed" id="town-feed"></div></div>
      </div>
      <div>
        <div class="panel"><h3>Townsfolk</h3><div id="town-agents"></div></div>
        <div class="panel" style="margin-top:16px"><h3>Talk to someone</h3>
          <div class="town-chat-row">
            <select id="town-who"></select>
            <input id="town-say" placeholder="Say something…" autocomplete="off" maxlength="500">
            <button class="btn small" id="town-send">Send</button>
          </div>
          <div class="town-chatlog" id="town-chatlog"></div>
        </div>
      </div>
    </div>
    <div id="town-offline" class="town-off" hidden></div>`;

  const grid = root.querySelector('#town-grid');
  const offline = root.querySelector('#town-offline');

  function paintOffline(updatedAt) {
    grid.hidden = true;
    offline.hidden = false;
    const when = updatedAt ? new Date(updatedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    offline.innerHTML = `
      <div class="big">🏙️</div>
      <p><strong>The town is asleep.</strong></p>
      <p class="muted">Dyer Town runs on your Mac — start it there (<code>npm start</code> in the
      agent-town folder, with DASH_URL and TOWN_KEY set) and it appears here live.</p>
      ${when ? `<p class="muted">Last seen ${esc(when)}.</p>` : ''}`;
  }

  function paint(d) {
    if (!d.online || !d.state) { paintOffline(d.updatedAt); return; }
    grid.hidden = false;
    offline.hidden = true;
    const s = d.state;

    const byLoc = {};
    for (const a of s.agents || []) (byLoc[a.loc] ||= []).push(a.name);
    const stByLoc = {};
    for (const st of s.structures || []) (stByLoc[st.loc] ||= []).push(st);

    root.querySelector('#town-map').innerHTML = Object.entries(s.map || {}).map(([k, label]) => `
      <div class="town-place"><div class="pn">${esc(label)}</div>
        <div class="row">${(byLoc[k] || []).map(n => `<span class="town-pill">${esc(n)}</span>`).join('')}</div>
        <div class="row">${(stByLoc[k] || []).map(st =>
          `<span class="town-pill bld" title="${esc(st.name)}">${KIND_ICO[st.kind] || '🏗️'} ${st.progress < 100 ? `${esc(st.name)} ${Number(st.progress) || 0}%` : esc(st.name)}</span>`).join('')}</div>
      </div>`).join('');

    root.querySelector('#town-agents').innerHTML = (s.agents || []).map(a => {
      const ev = a.eval && a.eval.note
        ? `<div style="flex-basis:100%;font-size:12.5px;color:#e0b23a;margin-top:2px">${'★'.repeat(Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))}${'☆'.repeat(5 - Math.max(1, Math.min(5, Number(a.eval.rating) || 3)))} ${esc(a.eval.by)}: “${esc(a.eval.note)}”</div>`
        : '';
      return `<div class="town-agent" style="flex-wrap:wrap"><span class="nm">${esc(a.name)}</span>
        <span class="rl">${esc(a.role)} · ${esc(a.loc)}</span><span class="co">${Number(a.coins) || 0}c</span>${ev}</div>`;
    }).join('');

    root.querySelector('#town-feed').innerHTML = (s.feed || []).map(e => `
      <div class="town-ev"><span class="t">t${Number(e.tick) || 0}</span><b>${esc(e.name)}</b> ${esc(e.text)}</div>`).join('');

    const sig = (s.agents || []).map(a => a.id).join(',');
    if (sig !== agentsSig) {
      agentsSig = sig;
      root.querySelector('#town-who').innerHTML = (s.agents || [])
        .map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/town/state', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      if (alive) paint(d);
    } catch {
      if (alive) paintOffline(null);
    }
  }

  // send a message, then poll for the agent's answer — the Mac replies between
  // ticks, so a few seconds of patience with a visible "…" bubble
  async function sendChat() {
    const agentId = root.querySelector('#town-who').value;
    const input = root.querySelector('#town-say');
    const message = input.value.trim();
    if (!agentId || !message) return;
    input.value = '';
    const log = root.querySelector('#town-chatlog');
    log.insertAdjacentHTML('beforeend', `<div class="town-msg me">${esc(message)}</div>`);
    const bubble = document.createElement('div');
    bubble.className = 'town-msg them';
    bubble.textContent = '…';
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await fetch('/api/town/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, message }),
      });
      const { id } = await res.json();
      if (!res.ok || !id) throw new Error();
      for (let i = 0; i < 20 && alive; i++) {           // up to ~60s of polling
        await new Promise(r => setTimeout(r, 3000));
        const poll = await fetch(`/api/town/chat/${id}`).then(r => r.json()).catch(() => null);
        if (poll?.reply) { bubble.textContent = poll.reply; log.scrollTop = log.scrollHeight; return; }
      }
      bubble.textContent = '(no answer yet — the town may be paused)';
    } catch {
      bubble.textContent = '(could not reach the town)';
      showToast('Could not send that message');
    }
  }

  refreshBtn.addEventListener('click', refresh);
  root.querySelector('#town-send').addEventListener('click', sendChat);
  root.querySelector('#town-say').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  refresh();
  timer = setInterval(refresh, 5000);

  return function unmount() {
    alive = false;
    clearInterval(timer);
  };
}
