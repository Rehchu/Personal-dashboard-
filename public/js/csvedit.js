// CSV viewer/editor — built for the worship song bank, useful for any sheet.
//
// The point is round-trip fidelity: a file that goes in and comes back out
// unedited must be byte-identical. That means remembering the things editors
// silently destroy — the UTF-8 BOM (drop it and Excel mangles © and accented
// names), CRLF line endings (flip them and every line looks changed), and
// minimal quoting (quote only the fields that need it, not every field).

import { load, save, uid, esc, showToast, softDelete, alive } from './store.js';

const FILES_KEY = 'csv.files';

/* ---------- parse / serialise (RFC 4180) ---------- */

export function sniffDialect(text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/\n/g) || []).length - crlf;
  return {
    bom,
    eol: crlf >= lf ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/.test(body),
  };
}

// The browser strips a UTF-8 BOM when it decodes, so the flag has to come from
// the raw bytes; passing it in keeps parseCsv usable on a plain string too.
export async function parseCsvFile(file) {
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const text = new TextDecoder('utf-8').decode(buf);
  const parsed = parseCsv(text);
  parsed.dialect.bom = bom; // authoritative: taken from the file itself
  return parsed;
}

export function parseCsv(text) {
  const dialect = sniffDialect(text);
  const s = dialect.bom ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r' && s[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (ch === '\n' || ch === '\r') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  // a trailing newline closes the last row; anything else is a final field
  if (field !== '' || row.length) endRow();

  return { rows, dialect };
}

// quote only when the field would otherwise be ambiguous — matching how
// spreadsheets write CSV, so an untouched file serialises back unchanged
const needsQuotes = f => /[",\r\n]/.test(f);
const cell = f => (needsQuotes(f) ? `"${f.replace(/"/g, '""')}"` : f);

export function toCsv(rows, dialect = {}) {
  const eol = dialect.eol || '\r\n';
  let out = rows.map(r => r.map(cell).join(',')).join(eol);
  if (dialect.trailingNewline !== false) out += eol;
  return (dialect.bom ? '﻿' : '') + out;
}

/* ---------- the sheet's own look ----------
   Taken from the workbook this was built for: a dark banner, a red header
   row, and rows tinted by status. Rendered on a light sheet whatever the
   dashboard theme is, because that IS the document's appearance. */

const SHEET_INK = '#1f2430';
const HEADER_BG = '#d6222d';
const STATUS_TINT = {
  verified: '#e4f3e7',
  'not in ccli catalog': '#fdede7',
  'arrangement unclear': '#fff6db',
  unidentified: '#fde7ef',
};
// the workbook's widths, in characters, used as relative column weights
const DEFAULT_WIDTHS = [34, 13, 42, 54, 20, 24, 60, 30];

const STYLE = `
  #cs-wrap { background: #fff; color: ${SHEET_INK}; border-radius: 10px; overflow: hidden;
    font-family: Arial, Helvetica, sans-serif; box-shadow: 0 10px 30px -18px rgba(0,0,0,.7); }
  #cs-banner { background: ${SHEET_INK}; color: #fff; padding: 12px 16px; }
  #cs-banner h3 { margin: 0; font-size: 16px; font-weight: 700; color: #fff; }
  #cs-banner p { margin: 2px 0 0; font-size: 9.5pt; opacity: .85; }
  #cs-scroll { overflow: auto; max-height: 62vh; }
  table.cs { border-collapse: separate; border-spacing: 0; font-size: 10pt; width: max-content; min-width: 100%; }
  table.cs th { position: sticky; top: 0; z-index: 2; background: ${HEADER_BG}; color: #fff;
    font-weight: 700; text-align: left; padding: 6px 8px; white-space: normal;
    border-right: 1px solid rgba(255,255,255,.25); }
  table.cs td { padding: 5px 8px; vertical-align: top; border-bottom: 1px solid #e7e7ea;
    border-right: 1px solid #eeeef1; }
  table.cs td[contenteditable]:focus { outline: 2px solid ${HEADER_BG}; outline-offset: -2px; background: #fff; }
  table.cs tr.cs-hit td { box-shadow: inset 3px 0 0 ${HEADER_BG}; }
  .cs-rownum { color: #98989f; font-size: 9pt; user-select: none; text-align: right; }
  #cs-empty { padding: 26px; text-align: center; color: #6b6b73; }
  .cs-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
`;

export function mount(root, tools) {
  // `files` keeps replacement tombstones (see the import handler) so every save
  // carries them forward for sync; pickers and selection only see live entries.
  let files = load(FILES_KEY, []);
  const live0 = alive(files);
  let current = live0.find(f => f.id === load('csv.sel', null)) || live0[0] || null;
  let filter = '';

  tools.innerHTML = `
    <label class="btn small" style="cursor:pointer">＋ Open CSV
      <input id="cs-file" type="file" accept=".csv,text/csv" hidden>
    </label>
    <button class="btn small" id="cs-add">＋ Row</button>
    <button class="btn small" id="cs-save">⬇ Export</button>`;

  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="cs-bar">
      <select id="cs-pick" style="padding:6px 10px"></select>
      <input id="cs-find" placeholder="Filter rows…" style="flex:1;min-width:160px;padding:6px 10px">
      <span class="muted" id="cs-count"></span>
    </div>
    <div id="cs-wrap">
      <div id="cs-banner">
        <h3 id="cs-title">No sheet open</h3>
        <p id="cs-sub">Open a CSV to view and edit it. The file keeps its exact format.</p>
      </div>
      <div id="cs-scroll"><div id="cs-empty">Nothing loaded yet.</div></div>
    </div>`;

  const $ = sel => root.querySelector(sel);
  const scroll = $('#cs-scroll');

  const persist = () => {
    save(FILES_KEY, files);
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  };

  function renderPicker() {
    $('#cs-pick').innerHTML = alive(files).map(f =>
      `<option value="${f.id}"${f.id === current?.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')
      || '<option>—</option>';
  }

  function statusTint(row, headers) {
    const idx = headers.findIndex(h => /^status$/i.test(h));
    if (idx < 0) return '';
    return STATUS_TINT[String(row[idx] || '').trim().toLowerCase()] || '';
  }

  function render() {
    renderPicker();
    if (!current) {
      $('#cs-title').textContent = 'No sheet open';
      scroll.innerHTML = '<div id="cs-empty">Nothing loaded yet.</div>';
      $('#cs-count').textContent = '';
      return;
    }
    const [headers, ...body] = current.rows;
    $('#cs-title').textContent = current.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ');
    $('#cs-sub').textContent = `${body.length} rows · ${headers.length} columns · keeps ${current.dialect.eol === '\r\n' ? 'CRLF' : 'LF'} endings${current.dialect.bom ? ' and BOM' : ''}`;

    const needle = filter.trim().toLowerCase();
    const widths = headers.map((_, i) => DEFAULT_WIDTHS[i] || 24);
    let shown = 0;
    const rowsHtml = body.map((r, ri) => {
      const hit = !needle || r.some(f => String(f).toLowerCase().includes(needle));
      if (!hit) return '';
      shown += 1;
      const tint = statusTint(r, headers);
      const cells = headers.map((_, ci) =>
        `<td contenteditable="true" data-r="${ri}" data-c="${ci}">${esc(r[ci] ?? '')}</td>`).join('');
      return `<tr${tint ? ` style="background:${tint}"` : ''}>
        <td class="cs-rownum">${ri + 1}</td>${cells}
        <td><button class="btn small danger" data-del="${ri}" title="Delete row">✕</button></td></tr>`;
    }).join('');

    scroll.innerHTML = `<table class="cs">
      <thead><tr><th style="width:44px"></th>
        ${headers.map((h, i) => `<th style="min-width:${Math.min(widths[i] * 7, 420)}px">${esc(h)}</th>`).join('')}
        <th style="width:46px"></th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>`;
    $('#cs-count').textContent = needle ? `${shown} of ${body.length} rows` : `${body.length} rows`;

    scroll.querySelectorAll('td[contenteditable]').forEach(td => {
      td.addEventListener('blur', () => {
        const r = Number(td.dataset.r) + 1; // body index -> rows index
        const c = Number(td.dataset.c);
        const next = td.textContent;
        if (current.rows[r][c] === next) return;
        current.rows[r][c] = next;
        current.edited = true;
        persist();
        $('#cs-count').textContent = 'saved';
      });
      // Enter commits rather than inserting a newline into the cell
      td.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); td.blur(); }
      });
    });
    scroll.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      const ri = Number(btn.dataset.del);
      if (!confirm(`Delete row ${ri + 1}?`)) return;
      current.rows.splice(ri + 1, 1);
      current.edited = true;
      persist(); render();
    }));
  }

  // the file input lives in the toolbar, not the panel body
  tools.querySelector('#cs-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const { rows, dialect } = await parseCsvFile(file);
    if (!rows.length) { showToast('That file has no rows'); return; }
    const entry = { id: uid(), name: file.name, rows, dialect, edited: false, ts: Date.now() };
    // re-importing a file replaces the old copy — that IS a delete, so the old
    // entry becomes a tombstone or a sync merge would restore both side by side
    for (const f of alive(files)) if (f.name === file.name) files = softDelete(files, f.id);
    files = [entry, ...files];
    current = entry;
    save('csv.sel', entry.id);
    persist(); render();
    showToast(`${file.name}: ${rows.length - 1} rows`);
    e.target.value = '';
  });

  $('#cs-pick').addEventListener('change', e => {
    current = files.find(f => f.id === e.target.value) || null;
    if (current) save('csv.sel', current.id);
    render();
  });

  $('#cs-find').addEventListener('input', e => { filter = e.target.value; render(); });

  tools.querySelector('#cs-add').addEventListener('click', () => {
    if (!current) { showToast('Open a CSV first'); return; }
    current.rows.push(new Array(current.rows[0].length).fill(''));
    current.edited = true;
    persist(); render();
    scroll.scrollTop = scroll.scrollHeight;
  });

  tools.querySelector('#cs-save').addEventListener('click', () => {
    if (!current) { showToast('Open a CSV first'); return; }
    const text = toCsv(current.rows, current.dialect);
    // text/csv;charset=utf-8 keeps the BOM meaningful to Excel
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = current.name;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  render();
  return () => {};
}
