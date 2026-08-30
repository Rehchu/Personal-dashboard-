// Service planner — the run of show for a Sunday, and the set list that feeds
// CCLI reporting.
//
// Two jobs in one module because they are one job on the day: the order of
// service drives the cameras, and the songs in it are what has to be reported.
// Segments recall a camera preset so a shot is one tap during the service
// instead of a pad you drive blind while it is happening.

import { load, save, uid, esc, todayISO, showToast, softDelete, alive } from './store.js';
import { send as sendPtz } from './ptz.js';

const SERVICES_KEY = 'services';
const CAMS_KEY = 'ptz.cams';
const CSV_KEY = 'csv.files';

// a plausible order of service, editable — most services are a variation on it
const DEFAULT_SEGMENTS = ['Countdown', 'Worship', 'Welcome', 'Offering', 'Message', 'Response'];

const getCams = () => alive(load(CAMS_KEY, [])); // removed cameras are tombstones

/* ---------- the song bank, read out of whatever CSV was imported ---------- */

const TITLE_RE = /^title$/i;
const CCLI_RE = /ccli/i;

export function songBank() {
  for (const file of alive(load(CSV_KEY, []))) {
    const rows = file?.rows;
    if (!Array.isArray(rows) || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h || '').trim());
    const ti = headers.findIndex(h => TITLE_RE.test(h));
    const ci = headers.findIndex(h => CCLI_RE.test(h));
    if (ti < 0) continue;
    const songs = rows.slice(1)
      .filter(r => String(r[ti] || '').trim())
      .map(r => ({ title: String(r[ti]).trim(), ccli: ci >= 0 ? String(r[ci] || '').trim() : '' }));
    if (songs.length) return { name: file.name, songs };
  }
  return null;
}

/* ---------- CCLI usage report ---------- */

// One row per time a song was used. That is what a usage report is: not the
// song list, but the occasions — the same song in three services is three rows.
export function usageRows(services, fromISO, toISO) {
  const rows = [['Title', 'CCLI Song No.', 'Date', 'Service']];
  // alive(): a deleted service is a tombstone and must not report song uses
  for (const svc of alive(services).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (fromISO && svc.date < fromISO) continue;
    if (toISO && svc.date > toISO) continue;
    for (const song of svc.songs || []) {
      rows.push([song.title, song.ccli || '', svc.date, svc.name || '']);
    }
  }
  return rows;
}

const csvCell = f => (/[",\r\n]/.test(f) ? `"${String(f).replace(/"/g, '""')}"` : String(f));
const toCsv = rows => `﻿${rows.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const STYLE = `
  #sv-grid { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; gap: 18px; align-items: start; }
  .sv-seg { display: flex; gap: 8px; align-items: center; padding: 10px 12px; margin-bottom: 8px;
    border: 1px solid color-mix(in oklab, var(--ink-3) 30%, transparent); border-radius: 10px;
    background: color-mix(in oklab, var(--surface-2) 60%, transparent); }
  .sv-seg .sv-name { flex: 1; font-weight: 600; }
  .sv-live { display: grid; gap: 10px; }
  .sv-live button { padding: 18px 16px; font-size: 17px; font-weight: 700; text-align: left;
    border-radius: 12px; border: 1px solid color-mix(in oklab, var(--ink-3) 34%, transparent);
    background: color-mix(in oklab, var(--surface-2) 70%, transparent); color: var(--ink); }
  .sv-live button.on { background: var(--accent); color: #04121b; }
  .sv-live .sv-hint { display: block; font-size: 12px; font-weight: 500; opacity: .75; margin-top: 3px; }
  .sv-song { display: flex; gap: 8px; align-items: center; padding: 7px 10px; margin-bottom: 6px;
    border-radius: 8px; background: color-mix(in oklab, var(--surface-2) 55%, transparent); }
  .sv-song .sv-t { flex: 1; }
  .sv-song .sv-n { font-size: 12px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
`;

export function mount(root, tools) {
  // `services` keeps deletion tombstones so saves carry them forward for sync;
  // the list UI, selection, and reports only ever see alive() entries.
  let services = load(SERVICES_KEY, []);
  const live0 = alive(services);
  let current = live0.find(s => s.id === load('services.sel', null)) || live0[0] || null;
  let live = false;
  let activeSeg = null;

  const bank = songBank();
  const cams = getCams();

  tools.innerHTML = `
    <button class="btn small" id="sv-new">＋ Service</button>
    <button class="btn small" id="sv-live">▶ Live</button>
    <button class="btn small" id="sv-ccli">⬇ CCLI report</button>`;

  root.innerHTML = `
    <style>${STYLE}</style>
    <div id="sv-grid">
      <div>
        <div class="panel" style="margin-bottom:14px">
          <h3>Services</h3>
          <div id="sv-list"></div>
        </div>
        <div class="panel">
          <h3>Add a song</h3>
          <input id="sv-find" placeholder="${bank ? 'Search the song bank…' : 'Import the song bank CSV first'}"
                 style="width:100%;padding:7px 10px" ${bank ? '' : 'disabled'}>
          <div id="sv-results" style="margin-top:10px;max-height:260px;overflow:auto"></div>
          <p class="muted" style="margin-top:10px;font-size:12px">
            ${bank ? `From ${esc(bank.name)} · ${bank.songs.length} songs` :
              'Open the Song Bank module and import your CSV — this reads from it.'}
          </p>
        </div>
      </div>
      <div class="panel" id="sv-main"></div>
    </div>`;

  if (matchMedia('(max-width: 860px)').matches) {
    root.querySelector('#sv-grid').style.gridTemplateColumns = '1fr';
  }

  const $ = sel => root.querySelector(sel);
  const persist = () => {
    save(SERVICES_KEY, services);
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  };

  function newService() {
    const svc = {
      id: uid(),
      ts: Date.now(), // lets the sync merge order this service against a tombstone
      date: todayISO(),
      name: 'Sunday service',
      segments: DEFAULT_SEGMENTS.map(n => ({ id: uid(), name: n, camId: '', preset: '' })),
      songs: [],
    };
    services = [svc, ...services];
    current = svc;
    save('services.sel', svc.id);
    persist();
    renderAll();
  }

  function renderList() {
    const liveSvcs = alive(services);
    $('#sv-list').innerHTML = liveSvcs.length
      ? liveSvcs.map(s => `
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <button class="btn small" data-svc="${s.id}" style="flex:1;text-align:left;${s.id === current?.id ? 'border-color:var(--accent);' : ''}">
            ${esc(s.name)}<br><span class="muted" style="font-size:11.5px">${esc(s.date)} · ${(s.songs || []).length} songs</span>
          </button>
          <button class="btn small danger" data-delsvc="${s.id}">✕</button>
        </div>`).join('')
      : '<p class="muted">No services yet.</p>';

    $('#sv-list').querySelectorAll('[data-svc]').forEach(b => b.addEventListener('click', () => {
      current = services.find(s => s.id === b.dataset.svc);
      save('services.sel', current.id);
      renderAll();
    }));
    $('#sv-list').querySelectorAll('[data-delsvc]').forEach(b => b.addEventListener('click', () => {
      const svc = services.find(s => s.id === b.dataset.delsvc);
      if (!svc || !confirm(`Delete "${svc.name}" (${svc.date})?`)) return;
      // tombstone, not a splice: the sync merge unions by id and would bring it back
      services = softDelete(services, svc.id);
      if (current?.id === svc.id) current = alive(services)[0] || null;
      persist(); renderAll();
    }));
  }

  function camOptions(sel) {
    return `<option value="">no camera</option>` + cams.map(c =>
      `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }

  function renderPlan() {
    const main = $('#sv-main');
    if (!current) { main.innerHTML = '<p class="muted">Make a service to start planning.</p>'; return; }

    main.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <input id="sv-name" value="${esc(current.name)}" style="flex:1;min-width:160px;font-weight:700;padding:6px 10px">
        <input id="sv-date" type="date" value="${esc(current.date)}" style="padding:6px 10px">
      </div>
      <h3 style="margin-bottom:10px">Run of show</h3>
      <div id="sv-segs"></div>
      <button class="btn small" id="sv-addseg" style="margin-top:4px">＋ Segment</button>
      <h3 style="margin:18px 0 10px">Set list</h3>
      <div id="sv-songs"></div>`;

    $('#sv-name').addEventListener('input', e => { current.name = e.target.value; persist(); renderList(); });
    $('#sv-date').addEventListener('input', e => { current.date = e.target.value; persist(); renderList(); });

    $('#sv-segs').innerHTML = current.segments.map(seg => `
      <div class="sv-seg">
        <input class="sv-name" value="${esc(seg.name)}" data-segname="${seg.id}" style="background:none;border:none;color:inherit">
        <select data-segcam="${seg.id}" style="padding:4px 6px">${camOptions(seg.camId)}</select>
        <input data-segpre="${seg.id}" type="number" min="0" max="254" placeholder="preset"
               value="${esc(seg.preset)}" style="width:74px;padding:4px 6px">
        <button class="btn small danger" data-segdel="${seg.id}">✕</button>
      </div>`).join('') || '<p class="muted">No segments.</p>';

    $('#sv-segs').querySelectorAll('[data-segname]').forEach(el => el.addEventListener('input', () => {
      const seg = current.segments.find(s => s.id === el.dataset.segname);
      if (seg) { seg.name = el.value; persist(); }
    }));
    $('#sv-segs').querySelectorAll('[data-segcam]').forEach(el => el.addEventListener('change', () => {
      const seg = current.segments.find(s => s.id === el.dataset.segcam);
      if (seg) { seg.camId = el.value; persist(); }
    }));
    $('#sv-segs').querySelectorAll('[data-segpre]').forEach(el => el.addEventListener('input', () => {
      const seg = current.segments.find(s => s.id === el.dataset.segpre);
      if (seg) { seg.preset = el.value; persist(); }
    }));
    $('#sv-segs').querySelectorAll('[data-segdel]').forEach(el => el.addEventListener('click', () => {
      current.segments = current.segments.filter(s => s.id !== el.dataset.segdel);
      persist(); renderPlan();
    }));

    $('#sv-addseg').addEventListener('click', () => {
      current.segments.push({ id: uid(), name: 'New segment', camId: '', preset: '' });
      persist(); renderPlan();
    });

    $('#sv-songs').innerHTML = current.songs.length
      ? current.songs.map((s, i) => `
        <div class="sv-song">
          <span class="muted" style="width:18px">${i + 1}</span>
          <span class="sv-t">${esc(s.title)}</span>
          <span class="sv-n">${esc(s.ccli || '—')}</span>
          <button class="btn small" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small danger" data-songdel="${i}">✕</button>
        </div>`).join('')
      : '<p class="muted">No songs yet — search the bank on the left.</p>';

    $('#sv-songs').querySelectorAll('[data-songdel]').forEach(b => b.addEventListener('click', () => {
      current.songs.splice(Number(b.dataset.songdel), 1);
      persist(); renderPlan();
    }));
    $('#sv-songs').querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.up);
      [current.songs[i - 1], current.songs[i]] = [current.songs[i], current.songs[i - 1]];
      persist(); renderPlan();
    }));
  }

  function renderLive() {
    const main = $('#sv-main');
    if (!current) return;
    main.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0">${esc(current.name)} · live</h3>
        <span class="muted" id="sv-status">tap a segment</span>
      </div>
      <div class="sv-live">
        ${current.segments.map(seg => {
          const cam = cams.find(c => c.id === seg.camId);
          const hint = cam && seg.preset ? `${esc(cam.name)} · preset ${esc(seg.preset)}` : 'no camera move';
          return `<button data-go="${seg.id}"${seg.id === activeSeg ? ' class="on"' : ''}>
            ${esc(seg.name)}<span class="sv-hint">${hint}</span></button>`;
        }).join('')}
      </div>
      ${current.songs.length ? `<h3 style="margin:18px 0 10px">Set list</h3>${
        current.songs.map((s, i) => `<div class="sv-song"><span class="muted" style="width:18px">${i + 1}</span><span class="sv-t">${esc(s.title)}</span></div>`).join('')}` : ''}`;

    main.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', async () => {
      const seg = current.segments.find(s => s.id === btn.dataset.go);
      activeSeg = seg.id;
      renderLive();
      const cam = cams.find(c => c.id === seg.camId);
      const status = $('#sv-status');
      if (!cam || !seg.preset) { status.textContent = `${seg.name} — no camera move`; return; }
      status.textContent = `${seg.name} — moving ${cam.name}…`;
      try {
        await sendPtz(cam, 'poscall', { preset: Number(seg.preset) });
        status.textContent = `${seg.name} — ${cam.name} on preset ${seg.preset}`;
      } catch (err) {
        status.textContent = err.message;
      }
    }));
  }

  function renderAll() {
    renderList();
    if (live) renderLive(); else renderPlan();
  }

  /* ---------- song search ---------- */
  if (bank) {
    const results = $('#sv-results');
    const draw = needle => {
      const hits = needle
        ? bank.songs.filter(s => s.title.toLowerCase().includes(needle)).slice(0, 40)
        : bank.songs.slice(0, 40);
      results.innerHTML = hits.map(s =>
        `<button class="btn small" data-add="${esc(s.title)}" data-ccli="${esc(s.ccli)}"
           style="display:block;width:100%;text-align:left;margin-bottom:5px">
          ${esc(s.title)} <span class="muted">${esc(s.ccli || '—')}</span></button>`).join('')
        || '<p class="muted">No match.</p>';
      results.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
        if (!current) { showToast('Make a service first'); return; }
        current.songs.push({ title: b.dataset.add, ccli: b.dataset.ccli });
        persist(); renderPlan(); renderList();
      }));
    };
    $('#sv-find').addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
    draw('');
  }

  tools.querySelector('#sv-new').addEventListener('click', newService);

  tools.querySelector('#sv-live').addEventListener('click', () => {
    if (!current) { showToast('Make a service first'); return; }
    live = !live;
    activeSeg = null;
    tools.querySelector('#sv-live').textContent = live ? '✎ Plan' : '▶ Live';
    renderAll();
  });

  tools.querySelector('#sv-ccli').addEventListener('click', () => {
    if (!alive(services).length) { showToast('No services to report'); return; }
    const rows = usageRows(services);
    if (rows.length < 2) { showToast('No songs logged in any service yet'); return; }
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ccli-usage-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`${rows.length - 1} song uses exported`);
  });

  if (!alive(services).length) newService(); else renderAll();

  return () => {};
}
