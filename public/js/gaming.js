// Gaming — real Xbox and PlayStation, side by side. The Worker's /api/gaming/*
// bridges hold the keys and talk to OpenXBL and Sony's mobile API; this module
// paints the normalized shapes they return, and offers the one-time key setup.
// Nothing here ever sees a key after it's saved — the bridge only tells us
// whether one is configured.
//
// Last good payload is cached in localStorage (gaming.xbox / gaming.psn) so the
// profile chip and activity cards have something to show before the fetch lands.

import { load, save, esc, showToast } from './store.js';

const CACHE = { xbox: 'gaming.xbox', psn: 'gaming.psn' };

async function pull(path, cacheKey) {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const data = await res.json();
    if (cacheKey && data && data.configured && !data.error) save(cacheKey, { at: Date.now(), data });
    return data;
  } catch {
    const cached = cacheKey ? load(cacheKey, null) : null;
    return cached ? { ...cached.data, _stale: true } : { _error: true };
  }
}

const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0);

function injectStyle() {
  if (document.getElementById('gaming-style')) return;
  const style = document.createElement('style');
  style.id = 'gaming-style';
  style.textContent = `
    .gm-cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    @media (max-width:760px){ .gm-cols { grid-template-columns:1fr; } }
    .gm-card { border-radius:16px; border:1px solid var(--line,rgba(255,255,255,.1)); background:var(--surface-2); overflow:hidden; }
    .gm-head { padding:16px; display:flex; align-items:center; gap:14px; }
    .gm-head.xbox { background:linear-gradient(120deg,#107c10,#0b4d0b); }
    .gm-head.psn { background:linear-gradient(120deg,#0070d1,#003791); }
    .gm-avatar { width:52px; height:52px; border-radius:50%; object-fit:cover; background:rgba(0,0,0,.25); flex:none; }
    .gm-head .who { color:#fff; min-width:0; }
    .gm-head .tag { font:800 18px var(--font-display,system-ui); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gm-head .sub { font-size:13px; opacity:.9; }
    .gm-body { padding:14px 16px; }
    .gm-tiers { display:flex; gap:14px; margin-bottom:14px; }
    .gm-tier { text-align:center; }
    .gm-tier .n { font:800 1.3rem var(--font-display,system-ui); color:var(--ink); }
    .gm-tier .l { font-size:11px; color:var(--ink-2); text-transform:uppercase; letter-spacing:.04em; }
    .gm-tier.plat .n { color:#8ea9c1; } .gm-tier.gold .n { color:#e0b23a; }
    .gm-tier.silver .n { color:#b9c2cc; } .gm-tier.bronze .n { color:#c17a44; }
    .gm-game { display:flex; align-items:center; gap:11px; padding:9px 0; border-top:1px solid var(--line,rgba(255,255,255,.07)); }
    .gm-game:first-of-type { border-top:0; }
    .gm-box { width:46px; height:46px; border-radius:8px; object-fit:cover; background:var(--surface-3,rgba(255,255,255,.06)); flex:none; }
    .gm-box.fallback { display:flex; align-items:center; justify-content:center; font-size:20px; }
    .gm-game .info { min-width:0; flex:1; }
    .gm-game .nm { color:var(--ink); font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gm-game .pr { color:var(--ink-2); font-size:12.5px; margin-top:2px; }
    .gm-bar { height:5px; border-radius:3px; background:var(--surface-3,rgba(255,255,255,.1)); overflow:hidden; margin-top:5px; }
    .gm-bar i { display:block; height:100%; background:var(--accent); }
    .gm-setup { padding:18px 16px; }
    .gm-setup p { color:var(--ink-2); font-size:13.5px; line-height:1.5; margin:0 0 12px; }
    .gm-setup ol { color:var(--ink-2); font-size:13px; line-height:1.6; margin:0 0 12px; padding-left:20px; }
    .gm-setup a { color:var(--accent); }
    .gm-setup input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line,rgba(255,255,255,.15));
      background:var(--surface-3,rgba(0,0,0,.2)); color:var(--ink); font-size:14px; margin-bottom:10px; box-sizing:border-box; }
    .gm-setup button { padding:10px 18px; border-radius:10px; border:0; background:var(--accent); color:#fff; font-weight:700; cursor:pointer; }
    .gm-note { font-size:12.5px; color:var(--ink-3); margin:10px 0 0; }
    .gm-banner { padding:9px 14px; border-radius:10px; background:color-mix(in oklab,#e0913a 22%,var(--surface-2)); color:var(--ink); font-size:12.5px; margin-bottom:12px; }
    .gm-more { margin-top:12px; }
    .gm-lib-btn, .gm-back { padding:7px 13px; border-radius:9px; border:1px solid var(--line,rgba(255,255,255,.15));
      background:var(--surface-3,rgba(255,255,255,.06)); color:var(--ink); font-size:12.5px; font-weight:600; cursor:pointer; }
    .gm-row { cursor:pointer; }
    .gm-row:hover .nm { color:var(--accent); }
    .gm-ach { display:flex; align-items:flex-start; gap:11px; padding:9px 0; border-top:1px solid var(--line,rgba(255,255,255,.07)); }
    .gm-ach.locked { opacity:.45; }
    .gm-ach .ic { width:44px; height:44px; border-radius:8px; object-fit:cover; flex:none; background:var(--surface-3,rgba(255,255,255,.06)); }
    .gm-ach .nm { color:var(--ink); font-weight:600; font-size:13.5px; }
    .gm-ach .dt { color:var(--ink-2); font-size:12.5px; margin-top:2px; line-height:1.4; }
    .gm-ach .meta { color:var(--ink-3); font-size:11.5px; margin-top:3px; }
    .gm-bgbtn { margin-left:auto; flex:none; padding:5px 9px; border-radius:8px; border:1px solid var(--line,rgba(255,255,255,.15));
      background:transparent; color:var(--ink-2); font-size:12px; cursor:pointer; }
    .gm-bgbtn:hover { color:var(--accent); border-color:var(--accent); }
    .gm-trophy-type { font-size:14px; margin-right:4px; }
    @media (prefers-reduced-motion: no-preference){ .gm-card { animation:gm-in .35s ease both; } @keyframes gm-in { from { opacity:0; transform:translateY(6px);} } }`;
  document.head.append(style);
}

function boxArt(url, fallback) {
  const safe = typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
  if (!safe) return `<div class="gm-box fallback" aria-hidden="true">${fallback}</div>`;
  return `<img class="gm-box" src="${esc(safe)}" alt="" loading="lazy"
    onerror="this.outerHTML='<div class=\\'gm-box fallback\\' aria-hidden=\\'true\\'>${fallback}</div>'">`;
}

// Two ways in, and the Microsoft one leads because it is strictly better: it
// talks to Xbox Live directly, so there is no middleman account to activate, no
// phone verification, and no 60-per-5-minutes cap. The OpenXBL key still works
// and is kept for anyone who already has one, folded away under a summary.
function xboxSetup(again = false) {
  return `<div class="gm-setup">
    <p>${again
      ? 'Sign in again to reconnect Xbox — this replaces the old connection.'
      : `Show your real gamerscore, games and achievements. Signing in with
       Microsoft reads your own Xbox profile; nothing is posted and your password
       never reaches this dashboard.`}</p>
    <ol>
      <li>Open the <a href="#" data-msauth="open"><b>Xbox sign-in page</b></a> and sign in with your Microsoft account.</li>
      <li>You'll land on a <b>blank page</b>. That's expected — the part that matters
        is its <b>address</b>, which contains <code>?code=…</code>.</li>
      <li>Copy that whole address and paste it below.</li>
    </ol>
    <input type="text" id="gm-msurl" placeholder="https://login.live.com/oauth20_desktop.srf?code=…"
      autocomplete="off" spellcheck="false">
    <button data-msauth="finish">${again ? 'Reconnect Xbox' : 'Finish sign-in'}</button>
    <p class="gm-note">Only the sign-in token is kept, on the Worker — never in this browser.</p>

    <details style="margin-top:14px">
      <summary style="cursor:pointer;color:var(--ink-2);font-size:13px">Or use an OpenXBL key instead</summary>
      <div style="margin-top:10px">
    <ol>
      <li>Go to <a href="https://xbl.io" target="_blank" rel="noopener">xbl.io</a> and sign in with your Microsoft account.</li>
      <li><b>Activate the account</b> — xbl.io asks for a mobile number before it
        switches API access on. A key from an unactivated account saves fine here
        and then returns an empty profile, which looks exactly like a broken key.
        Virtual/VOIP numbers are refused.</li>
      <li>Open the <b>API Keys</b> page and copy your key.</li>
      <li>Paste it below — it's stored on the Worker, never in the browser.</li>
    </ol>
    <input type="password" id="gm-xbl" placeholder="OpenXBL API key" autocomplete="off" spellcheck="false">
    <button data-save="xbl_key" data-input="gm-xbl">${again ? 'Save new key' : 'Connect Xbox'}</button>
      </div>
    </details>
  </div>`;
}

function psnSetup() {
  return `<div class="gm-setup">
    <p>Show your PlayStation trophy level and recent games. You'll paste your
       account's NPSSO token — Sony's own single-sign-on cookie.</p>
    <ol>
      <li>Sign in at <a href="https://playstation.com" target="_blank" rel="noopener">playstation.com</a>.</li>
      <li>In the same browser open
        <a href="https://ca.account.sony.com/api/v1/ssocookie" target="_blank" rel="noopener">ca.account.sony.com/api/v1/ssocookie</a>.</li>
      <li>Copy the 64-character <b>npsso</b> value and paste it below.</li>
    </ol>
    <input type="password" id="gm-npsso" placeholder="NPSSO token" autocomplete="off" spellcheck="false">
    <button data-save="psn_npsso" data-input="gm-npsso">Connect PlayStation</button>
  </div>`;
}

function xboxCard(d) {
  if (!d || d._error) return `<div class="gm-card"><div class="gm-head xbox"><div class="who"><div class="tag">Xbox</div><div class="sub">bridge unreachable</div></div></div></div>`;
  if (d.configured === false) return `<div class="gm-card">${xboxSetup()}</div>`;

  const p = d.profile || {};
  const recent = d.recent || [];
  // OpenXBL refused the key — the one failure the owner can actually fix, so
  // the form comes back, exactly as PSN does for an expired NPSSO
  const reauth = d.error === 'reauth';
  // a throttle is not a breakage — say so plainly, and don't invite a Refresh
  // that would only spend more of the quota that ran out. Anything else falls
  // through to the diagnostic banner.
  const banner = reauth
    ? `<div class="gm-banner">${d.mode === 'ms'
      ? 'Your Xbox sign-in expired. Sign in again below to reconnect.'
      : "Xbox Live wouldn't accept that key. Paste a fresh one below."}</div>`
    : d.rateLimited
      ? `<div class="gm-banner">⏳ ${esc(d.error || 'Xbox Live is rate-limiting this key.')}${
        d._stale || d.stale ? ' Showing the last snapshot.' : ''}</div>`
      : d.error
        ? `<div class="gm-banner">Xbox Live didn't answer${d._stale || d.stale ? ' — showing the last snapshot' : ''}.${
          d.hint ? `<br><b>${esc(String(d.hint).slice(0, 240))}</b>` : ''}${
          d.upstream ? `<br><span style="opacity:.8;font-size:11.5px">${esc(String(d.upstream).slice(0, 200))}</span>` : ''}</div>`
        : '';
  const games = recent.length ? recent.map(g => {
    const pct = g.total ? Math.round((num(g.earned) / num(g.total)) * 100) : 0;
    return `<div class="gm-game">
      ${boxArt(g.art, '🎮')}
      <div class="info">
        <div class="nm">${esc(g.name || 'Game')}</div>
        <div class="pr">${num(g.earned)}/${num(g.total)} achievements${g.score ? ` · ${num(g.score)}G` : ''}</div>
        ${g.total ? `<div class="gm-bar"><i style="width:${pct}%"></i></div>` : ''}
      </div>
    </div>`;
  }).join('') : '<p class="gm-note">No recently played titles.</p>';

  return `<div class="gm-card">
    <div class="gm-head xbox">
      ${p.avatar ? `<img class="gm-avatar" src="${esc(p.avatar)}" alt="" onerror="this.remove()">` : ''}
      <div class="who"><div class="tag">${esc(p.gamertag || 'Xbox')}</div>
        <div class="sub">${num(p.gamerscore).toLocaleString()} G</div></div>
    </div>
    <div class="gm-body">${banner}${games}
      <div class="gm-more" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="gm-lib-btn" data-lib="xbox">📚 Full library &amp; achievements</button>
        ${reauth ? '' : '<button class="gm-back" data-rekey="xbox">Reconnect</button>'}
        ${d.mode === 'ms' && !reauth ? '<button class="gm-back" data-msauth="disconnect">Disconnect</button>' : ''}
      </div>
      ${reauth ? xboxSetup(true) : ''}</div>
  </div>`;
}

function psnCard(d) {
  if (!d || d._error) return `<div class="gm-card"><div class="gm-head psn"><div class="who"><div class="tag">PlayStation</div><div class="sub">bridge unreachable</div></div></div></div>`;
  if (d.configured === false) return `<div class="gm-card">${psnSetup()}</div>`;

  const s = d.summary || {};
  const recent = d.recent || [];
  const reauth = d.error === 'reauth';
  const banner = reauth
    ? `<div class="gm-banner">Your PlayStation sign-in expired. ${d._stale || d.stale ? 'Showing the last snapshot — ' : ''}re-connect below with a fresh NPSSO.</div>`
    : (d.error ? `<div class="gm-banner">PSN didn't answer${d._stale || d.stale ? ' — showing the last snapshot' : ''}.</div>` : '');

  const tiers = `<div class="gm-tiers">
    <div class="gm-tier plat"><div class="n">${num(s.platinum)}</div><div class="l">Plat</div></div>
    <div class="gm-tier gold"><div class="n">${num(s.gold)}</div><div class="l">Gold</div></div>
    <div class="gm-tier silver"><div class="n">${num(s.silver)}</div><div class="l">Silver</div></div>
    <div class="gm-tier bronze"><div class="n">${num(s.bronze)}</div><div class="l">Bronze</div></div>
  </div>`;

  const games = recent.length ? recent.map(g => `
    <div class="gm-game">
      ${boxArt(g.art, '🏆')}
      <div class="info">
        <div class="nm">${esc(g.name || 'Game')}</div>
        <div class="pr">${num(g.progress)}% complete</div>
        <div class="gm-bar"><i style="width:${num(g.progress)}%"></i></div>
      </div>
    </div>`).join('') : '<p class="gm-note">No recent trophy titles.</p>';

  return `<div class="gm-card">
    <div class="gm-head psn">
      <div class="who"><div class="tag">Trophy Level ${num(s.level)}</div>
        <div class="sub">${num(s.platinum)} platinum${num(s.platinum) === 1 ? '' : 's'}</div></div>
    </div>
    <div class="gm-body">${banner}${tiers}${games}
      <div class="gm-more" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="gm-lib-btn" data-lib="psn">📚 Full library &amp; trophies</button>
        ${reauth ? '' : '<button class="gm-back" data-rekey="psn">Change token</button>'}
      </div>
      ${reauth ? psnSetup() : ''}</div>
  </div>`;
}

export function mount(root, tools) {
  injectStyle();
  let alive = true;
  // #appview-body is ONE element every module mounts into, so a listener left
  // bound here outlives this tile and fires under the next one. Everything this
  // module binds goes through this signal, and unmount aborts it.
  const ac = new AbortController();
  const { signal } = ac;
  let xbox = load(CACHE.xbox, null)?.data || null;
  let psn = load(CACHE.psn, null)?.data || null;

  root.innerHTML = `<div class="gm-cols">
    <div id="gm-xbox"><p class="muted">Loading Xbox…</p></div>
    <div id="gm-psn"><p class="muted">Loading PlayStation…</p></div>
  </div>`;

  const xboxEl = root.querySelector('#gm-xbox');
  const psnEl = root.querySelector('#gm-psn');

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn small';
  refreshBtn.textContent = '⟳ Refresh';
  tools.append(refreshBtn);

  function paint() {
    if (!alive) return;
    xboxEl.innerHTML = xboxCard(xbox);
    psnEl.innerHTML = psnCard(psn);
    wireSetup();
  }

  // save handlers for whichever setup form is showing
  // The Microsoft sign-in, both halves. "open" fetches the authorize URL from
  // the bridge (the client never builds it, so the client id and scopes live in
  // one place) and opens it in a new tab. "finish" posts back whatever address
  // the owner landed on; the bridge pulls the code out and does the exchange.
  async function msAuth(step, el) {
    if (step === 'open') {
      try {
        const { url } = await (await fetch('/api/gaming/xbox/msauth')).json();
        if (url) window.open(url, '_blank', 'noopener');
        else showToast('Could not start the Xbox sign-in');
      } catch { showToast('Could not start the Xbox sign-in'); }
      return;
    }
    if (step === 'disconnect') {
      const res = await fetch('/api/gaming/xbox/msauth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }).catch(() => null);
      if (res?.ok) { showToast('Xbox disconnected'); await loadAll(); }
      else showToast('Could not disconnect');
      return;
    }
    // finish
    const input = el.closest('.gm-setup')?.querySelector('#gm-msurl');
    const val = (input?.value || '').trim();
    if (!val) { showToast('Paste the address of the page you landed on'); return; }
    el.disabled = true; el.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/gaming/xbox/msauth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: val }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || '');
      showToast(body.gamertag ? `Signed in as ${body.gamertag}` : 'Xbox connected');
      await loadAll();
    } catch (err) {
      // the bridge's message names the real cause (expired code, no Xbox
      // profile on the account, a child account) — say it rather than "failed"
      showToast(err.message || 'Could not complete the sign-in');
      el.disabled = false; el.textContent = 'Try again';
    }
  }

  function wireSetup() {
    root.querySelectorAll('[data-save]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const field = btn.dataset.save;
        // The input that belongs to THIS button, resolved in a way that survives
        // both traps this form has already hit: a bare id can collide with a
        // CONTAINER's id (which once ate every pasted PSN key), and the Xbox form
        // now holds two inputs, so "the first input in the form" is wrong too.
        // So: take the named one, but only if it really is an input; otherwise
        // fall back to the single-input case.
        const byId = btn.dataset.input ? root.querySelector('#' + btn.dataset.input) : null;
        const input = (byId && byId.tagName === 'INPUT') ? byId
          : btn.closest('.gm-setup')?.querySelector('input');
        const val = (input?.value || '').trim();
        if (!val) { showToast('Paste a key first'); return; }
        btn.disabled = true; btn.textContent = 'Connecting…';
        try {
          const res = await fetch('/api/gaming/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [field]: val }),
          });
          if (!res.ok) throw new Error();
          showToast('Connected — loading your games');
          await loadAll();
        } catch {
          showToast('Could not save that key');
          btn.disabled = false; btn.textContent = 'Try again';
        }
      }, { signal });
    });
  }

  // ---- the full shelf: library view, then one game's achievements/trophies.
  // Any cover or unlocked-achievement icon can become a dashboard background —
  // the Worker's importer pulls it into the gallery and selects it. ----
  const TROPHY_ICO = { platinum: '💠', gold: '🥇', silver: '🥈', bronze: '🥉' };
  const colFor = c => (c === 'xbox' ? xboxEl : psnEl);
  const libCache = {};

  function bgButton(url, name) {
    const safe = typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
    if (!safe) return '';
    return `<button class="gm-bgbtn" data-bg="${esc(encodeURIComponent(safe))}" data-bgname="${esc(name || 'Game art')}" title="Make this a dashboard background">🖼</button>`;
  }

  async function setBg(url, name) {
    // never let a non-URL reach the importer — that is a bug on this side, and
    // the toast for it reads like the art was at fault
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
    try {
      const res = await fetch('/api/media/bg/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '');
      showToast('Added to your backgrounds — and set as the active one');
      // the shell read its gallery at boot; tell it to pick the new one up now
      // rather than on the next reload
      window.dispatchEvent(new CustomEvent('pd:bg-imported', { detail: { id: body.id } }));
    } catch (err) {
      showToast(`Couldn't import that art${err.message ? ` — ${err.message}` : ''}`);
    }
  }

  async function renderLib(c) {
    const el = colFor(c);
    el.innerHTML = '<div class="gm-card"><div class="gm-body"><p class="gm-note">Loading the shelf…</p></div></div>';
    const d = libCache[c] || await pull(`/api/gaming/${c}/games`);
    if (!alive) return;
    if (!d?.games?.length) {
      el.innerHTML = `<div class="gm-card"><div class="gm-body">
        <p class="gm-note">${esc(d?.hint || d?.error || 'Nothing on the shelf yet.')}</p>
        <div class="gm-more"><button class="gm-back" data-back="1">← Back</button></div></div></div>`;
      return;
    }
    libCache[c] = d;
    const rows = d.games.map((g, i) => `
      <div class="gm-game gm-row" data-game="${i}" data-console="${c}">
        ${boxArt(g.art, c === 'xbox' ? '🎮' : '🏆')}
        <div class="info">
          <div class="nm">${esc(g.name)}</div>
          <div class="pr">${c === 'xbox'
            ? `${num(g.earned)}/${num(g.total)} achievements · ${num(g.score)}G`
            : `${num(g.progress)}% · ${num(g.earned?.platinum)}💠 ${num(g.earned?.gold)}🥇 ${num(g.earned?.silver)}🥈 ${num(g.earned?.bronze)}🥉`}</div>
        </div>
        ${bgButton(g.art, g.name)}
      </div>`).join('');
    el.innerHTML = `<div class="gm-card"><div class="gm-body">
      <div class="gm-more" style="margin:0 0 10px;display:flex;justify-content:space-between;align-items:center">
        <button class="gm-back" data-back="1">← Back</button>
        <span class="gm-note" style="margin:0">${d.games.length} titles${d.stale || d._stale ? ' · snapshot' : ''}</span>
      </div>${rows}</div></div>`;
  }

  async function renderGame(c, g) {
    const el = colFor(c);
    el.innerHTML = `<div class="gm-card"><div class="gm-body"><p class="gm-note">Opening ${esc(g.name)}…</p></div></div>`;
    const d = await pull(c === 'xbox'
      ? `/api/gaming/xbox/achievements?titleId=${encodeURIComponent(g.id)}`
      : `/api/gaming/psn/trophies?id=${encodeURIComponent(g.id)}&platform=${encodeURIComponent(g.platform || '')}`);
    if (!alive) return;
    const list = (c === 'xbox' ? d?.achievements : d?.trophies) || [];
    const rows = list.length ? list.map(a => {
      const got = a.unlocked || a.earned;
      return `
      <div class="gm-ach${got ? '' : ' locked'}">
        ${/^https:\/\//.test(a.icon || '') ? `<img class="ic" src="${esc(a.icon)}" alt="" loading="lazy" onerror="this.remove()">` : '<div class="ic"></div>'}
        <div class="info" style="min-width:0;flex:1">
          <div class="nm">${c === 'psn' ? `<span class="gm-trophy-type">${TROPHY_ICO[a.type] || '🏆'}</span>` : ''}${esc(a.name || '???')}</div>
          ${a.detail ? `<div class="dt">${esc(a.detail)}</div>` : ''}
          <div class="meta">${got
            ? `✓ unlocked${a.unlockedAt || a.earnedAt ? ` · ${new Date(a.unlockedAt || a.earnedAt).toLocaleDateString()}` : ''}`
            : 'locked'}${a.rarity ? ` · ${a.rarity}% of players` : ''}${a.score ? ` · ${num(a.score)}G` : ''}</div>
        </div>
        ${got ? bgButton(a.icon, a.name) : ''}
      </div>`;
    }).join('')
      : `<p class="gm-note">${esc(d?.hint || d?.error || 'Nothing to show for this title.')}</p>`;
    const done = list.filter(a => a.unlocked || a.earned).length;
    el.innerHTML = `<div class="gm-card"><div class="gm-body">
      <div class="gm-more" style="margin:0 0 10px;display:flex;gap:8px;align-items:center">
        <button class="gm-back" data-lib="${c}">← Library</button>
        <span class="gm-note" style="margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)} · ${done}/${list.length}</span>
        ${bgButton(g.art, g.name)}
      </div>${rows}</div></div>`;
  }

  // Every hit below is matched by CLASS as well as data-attribute, and only
  // inside this tile. A bare [data-bg] climbs the tree past the tile and lands
  // on <html data-bg="video|storm|off"> — applyBg() puts it there — so it
  // matched every click on the page and fired the importer with "video".
  const own = el => el && root.contains(el) ? el : null;
  root.addEventListener('click', e => {
    const bg = own(e.target.closest('button.gm-bgbtn[data-bg]'));
    if (bg) {
      e.stopPropagation();
      let url = '';
      try { url = decodeURIComponent(bg.dataset.bg || ''); } catch { url = ''; }
      setBg(url, bg.dataset.bgname);
      return;
    }
    // the Microsoft sign-in: open the page, then finish with the pasted address
    const ms = own(e.target.closest('[data-msauth]'));
    if (ms) {
      e.preventDefault();
      msAuth(ms.dataset.msauth, ms);
      return;
    }
    // "Change key" — without this there is NO way back to the key form once a
    // key is stored, so a dead or wrong key locks the tile permanently
    const rekey = own(e.target.closest('button[data-rekey]'));
    if (rekey) {
      colFor(rekey.dataset.rekey).innerHTML =
        `<div class="gm-card">${rekey.dataset.rekey === 'xbox' ? xboxSetup(true) : psnSetup()}</div>`;
      wireSetup();
      return;
    }
    const lib = own(e.target.closest('button[data-lib]'));
    if (lib) { renderLib(lib.dataset.lib); return; }
    if (own(e.target.closest('button[data-back]'))) { paint(); return; }
    const row = own(e.target.closest('.gm-row[data-game]'));
    if (row) {
      const g = libCache[row.dataset.console]?.games?.[Number(row.dataset.game)];
      if (g) renderGame(row.dataset.console, g);
    }
  }, { signal });

  async function loadAll() {
    paint(); // paint cache first
    const [x, p] = await Promise.all([
      pull('/api/gaming/xbox', CACHE.xbox),
      pull('/api/gaming/psn', CACHE.psn),
    ]);
    if (!alive) return;
    xbox = x; psn = p;
    paint();
    window.dispatchEvent(new Event('pd:data-changed')); // refresh the profile chip
  }

  refreshBtn.addEventListener('click', () => loadAll(), { signal });
  loadAll();

  return function unmount() { alive = false; ac.abort(); };
}

// Compact profile-chip line: gamerscore + trophy level, from the cached
// payloads only (no fetch — the chip updates whenever the module refreshes).
export function chipSummary() {
  const x = load(CACHE.xbox, null)?.data;
  const p = load(CACHE.psn, null)?.data;
  const bits = [];
  if (x?.profile?.gamerscore) bits.push(`🟢 ${num(x.profile.gamerscore).toLocaleString()}`);
  if (p?.summary?.level) bits.push(`🔵 L${num(p.summary.level)}`);
  return bits.join(' · ');
}
