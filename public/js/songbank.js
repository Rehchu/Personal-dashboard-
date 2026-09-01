// The worship song bank — the record of what the team sings and who to credit.
//
// This is a curated dataset, not a spreadsheet. Every CCLI number in it was
// checked against SongSelect by hand, canonical titles were corrected against
// the hooks people actually sing ("Worthy", not "Worthy Is Your Name"), and the
// _-prefixed sections carry rules the owner wrote — which songs are NOT in the
// CCLI catalog, how a credit line must be formatted, what is still unresolved.
// So the guiding rule here is: A MERGE NEVER SILENTLY OVERWRITES VERIFIED DATA.
// An import can fill blanks and add songs. Anything that would change a value
// that is already there is surfaced as a conflict for a human to rule on.
//
// Duplicates are the other half. They are found, never auto-removed — deciding
// which of two records is the real one is a judgement about the music, and the
// owner is the one who knows.

import { load, save, esc, showToast } from './store.js';

const BANK_KEY = 'songbank.v1';
const SEED_URL = '/data/song-bank.json';

/* ---------- identity ---------- */

// Titles vary by punctuation, case, "feat.", and the parenthetical the team
// adds to tell two songs of the same name apart. Normalising for COMPARISON
// only — the stored title is always what the owner wrote.
export const normTitle = s => String(s || '')
  .toLowerCase()
  .replace(/[‘’“”]/g, "'")   // smart quotes
  .replace(/&/g, ' and ')
  .replace(/\(.*?\)/g, ' ')                       // (Torwalt), (Feat. …)
  .replace(/\bfeat(uring)?\b.*$/i, ' ')
  .replace(/[^a-z0-9]+/g, '');

// A CCLI number is the strongest identity there is: it is assigned by CCLI to
// one song. Two different titles sharing one is nearly always one song filed
// twice. Kept as a string — numbers here are identifiers, not quantities, and
// some are short enough that a leading zero would matter.
export const normCcli = v => String(v ?? '').replace(/[^0-9]/g, '');

/* ---------- CSV -> song records ---------- */

// Import files come from SongSelect exports, Planning Center, and hand-made
// sheets, so the column names are never the same twice. Match on meaning.
const FIELD_PATTERNS = [
  ['title', /^(song|song\s*title|title|name)$/i],
  ['ccli', /(ccli|song\s*(no|number|#)|^no\.?$)/i],
  ['writers', /(writer|author|composer|artist)/i],
  ['copyright', /(copyright|publisher|©)/i],
  ['note', /(note|comment|remark)/i],
];

// header row -> { field: columnIndex }. Unmatched columns are ignored rather
// than guessed at.
export function mapColumns(header) {
  const map = {};
  header.forEach((raw, i) => {
    const h = String(raw || '').trim();
    if (!h) return;
    for (const [field, re] of FIELD_PATTERNS) {
      if (map[field] === undefined && re.test(h)) { map[field] = i; return; }
    }
  });
  return map;
}

// rows (from csvedit's parseCsv) -> song records. A row with neither a title
// nor a CCLI number is not a song and is dropped.
export function rowsToSongs(rows) {
  if (!rows.length) return { songs: [], map: {}, skipped: 0 };
  const map = mapColumns(rows[0]);
  const cell = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim());
  const songs = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const title = cell(r, 'title');
    const ccli = normCcli(cell(r, 'ccli'));
    if (!title && !ccli) { skipped++; continue; }
    const rec = {};
    if (ccli) rec.ccli = ccli;
    for (const f of ['writers', 'copyright', 'note']) {
      const v = cell(r, f);
      if (v) rec[f] = v;
    }
    songs.push({ title: title || `(CCLI ${ccli})`, rec });
  }
  return { songs, map, skipped };
}

/* ---------- merge ---------- */

// Find the existing entry an incoming song refers to: by CCLI first (exact
// identity), then by normalised title, then by an alias the owner recorded.
export function findExisting(bank, title, ccli) {
  const entries = Object.entries(bank);
  if (ccli) {
    const hit = entries.find(([, v]) => normCcli(v.ccli) === ccli);
    if (hit) return hit[0];
  }
  const n = normTitle(title);
  if (!n) return null;
  const byTitle = entries.find(([k]) => normTitle(k) === n);
  if (byTitle) return byTitle[0];
  const byAlias = entries.find(([, v]) => (v.aliases || []).some(a => normTitle(a) === n));
  return byAlias ? byAlias[0] : null;
}

/* Merge incoming songs into the bank.

   Three outcomes per song, and the third is the important one:
     added     — no existing match, filed as new
     filled    — matched, and the import supplied a field the bank had EMPTY
     conflict  — matched, and the import disagrees with a value already stored

   Conflicts are never applied. They are returned for a human to rule on,
   because the stored value was verified against SongSelect and an arbitrary
   CSV has not earned the right to overwrite that. */
export function mergeSongs(bank, incoming) {
  const merged = JSON.parse(JSON.stringify(bank));
  const added = [], filled = [], conflicts = [];
  for (const { title, rec } of incoming) {
    const ccli = normCcli(rec.ccli);
    const key = findExisting(merged, title, ccli);
    if (!key) {
      merged[title] = { ...rec, source: 'imported' };
      added.push(title);
      continue;
    }
    const cur = merged[key];
    for (const [f, v] of Object.entries(rec)) {
      if (!v) continue;
      const have = String(cur[f] ?? '').trim();
      if (!have) { cur[f] = v; filled.push({ title: key, field: f, value: v }); }
      else if (f === 'ccli' ? normCcli(have) !== normCcli(v) : have !== v) {
        conflicts.push({ title: key, field: f, stored: have, incoming: v });
      }
    }
    // an import that calls a known song by another name has taught us an alias
    if (normTitle(key) !== normTitle(title) && title !== key) {
      const aliases = cur.aliases || [];
      if (!aliases.some(a => normTitle(a) === normTitle(title))) {
        cur.aliases = [...aliases, title];
        filled.push({ title: key, field: 'aliases', value: title });
      }
    }
  }
  return { merged, added, filled, conflicts };
}

/* ---------- duplicates ---------- */

/* Groups of entries that look like the same song. Ordered strongest first, so
   the review list leads with the ones that are almost certainly real.

   Deliberately NOT flagged: two songs with the same title and DIFFERENT CCLI
   numbers. The bank already holds "You Are Good" (Israel Houghton, 3383788)
   and "You Are Good (Bethel)" (5191806) on purpose — distinct songs the team
   actually distinguishes. Calling those duplicates would invite deleting one. */
export function findDuplicates(bank) {
  const entries = Object.entries(bank);
  const groups = [];
  const seen = new Set();

  const byCcli = new Map();
  for (const [t, v] of entries) {
    const c = normCcli(v.ccli);
    if (!c) continue;
    if (!byCcli.has(c)) byCcli.set(c, []);
    byCcli.get(c).push(t);
  }
  for (const [c, titles] of byCcli) {
    if (titles.length < 2) continue;
    titles.forEach(t => seen.add(t));
    groups.push({ kind: 'ccli', why: `Both carry CCLI No. ${c} — one song, filed twice`, titles });
  }

  const byName = new Map();
  for (const [t] of entries) {
    const n = normTitle(t);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(t);
  }
  for (const [, titles] of byName) {
    if (titles.length < 2 || titles.every(t => seen.has(t))) continue;
    // same name but genuinely different songs — the bank distinguishes them
    const nums = new Set(titles.map(t => normCcli(bank[t].ccli)).filter(Boolean));
    if (nums.size > 1) continue;
    titles.forEach(t => seen.add(t));
    groups.push({ kind: 'title', why: 'The titles match once punctuation and parentheses are ignored', titles });
  }

  for (const [t, v] of entries) {
    for (const a of v.aliases || []) {
      const other = entries.find(([k]) => k !== t && normTitle(k) === normTitle(a));
      if (!other) continue;
      const pair = [t, other[0]];
      if (pair.every(x => seen.has(x))) continue;
      pair.forEach(x => seen.add(x));
      groups.push({ kind: 'alias', why: `"${a}" is recorded as an alias of one and the title of the other`, titles: pair });
    }
  }
  return groups;
}

/* ---------- the tile ---------- */

const cmpTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function mount(root, tools) {
  const ac = new AbortController();
  const { signal } = ac;
  let bank = load(BANK_KEY, null);
  let pending = null;   // a parsed import awaiting confirmation
  let view = 'songs';
  let q = '';

  const persist = () => save(BANK_KEY, bank);
  const songs = () => (bank?.songs) || {};
  const count = () => Object.keys(songs()).length;

  tools.innerHTML = `
    <label class="btn small" style="cursor:pointer">＋ Merge CSV
      <input id="sb-file" type="file" accept=".csv,text/csv" hidden>
    </label>
    <button class="btn small" id="sb-dupes">🔍 Duplicates</button>
    <button class="btn small" id="sb-export">⬇ Export</button>`;

  root.innerHTML = `<div id="sb-root"></div>`;
  const el = root.querySelector('#sb-root');

  function card(inner) { return `<div class="sb-card">${inner}</div>`; }

  function render() {
    if (!bank) { el.innerHTML = `<p class="muted">Loading the song bank…</p>`; return; }
    if (view === 'import' && pending) return renderImport();
    if (view === 'dupes') return renderDupes();
    renderSongs();
  }

  function renderSongs() {
    const all = Object.entries(songs()).sort((a, b) => cmpTitle(a[0], b[0]));
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? all.filter(([t, v]) => (t + ' ' + (v.writers || '') + ' ' + (v.ccli || '') +
          ' ' + (v.aliases || []).join(' ')).toLowerCase().includes(needle))
      : all;
    const rows = shown.map(([t, v]) => `
      <div class="sb-song">
        <div class="sb-t">${esc(t)}</div>
        <div class="sb-m">${v.ccli ? `CCLI No. ${esc(v.ccli)}` : '<em>no CCLI number</em>'}${
          v.writers ? ` · ${esc(v.writers)}` : ''}</div>
        ${v.copyright ? `<div class="sb-c">${esc(v.copyright)}</div>` : ''}
        ${(v.aliases || []).length ? `<div class="sb-a">also sung as: ${esc(v.aliases.join(' · '))}</div>` : ''}
      </div>`).join('');
    el.innerHTML = `
      <div class="sb-bar">
        <input id="sb-q" placeholder="Search title, writer or CCLI number" value="${esc(q)}">
        <span class="muted">${shown.length} of ${count()}</span>
      </div>
      ${rows || '<p class="muted">Nothing matches that.</p>'}`;
    const box = el.querySelector('#sb-q');
    box.addEventListener('input', () => { q = box.value; const at = box.selectionStart; render();
      const b2 = el.querySelector('#sb-q'); b2.focus(); b2.setSelectionRange(at, at); }, { signal });
  }

  function renderDupes() {
    const groups = findDuplicates(songs());
    el.innerHTML = `
      <div class="sb-bar"><button class="btn small" id="sb-back">← Songs</button>
        <span class="muted">${groups.length} possible duplicate${groups.length === 1 ? '' : 's'}</span></div>
      ${groups.length ? groups.map((g, i) => card(`
        <div class="sb-why">${esc(g.why)}</div>
        ${g.titles.map(t => `
          <label class="sb-pick">
            <input type="radio" name="dg${i}" value="${esc(t)}" ${t === g.titles[0] ? 'checked' : ''}>
            <span><b>${esc(t)}</b>${songs()[t]?.writers ? ` — ${esc(songs()[t].writers)}` : ''}
            ${songs()[t]?.verified ? '<br><small class="muted">verified against SongSelect</small>' : ''}</span>
          </label>`).join('')}
        <button class="btn small" data-keep="${i}">Keep the selected one, remove the rest</button>
      `)).join('') : '<p class="muted">No duplicates found.</p>'}`;

    el.querySelector('#sb-back')?.addEventListener('click', () => { view = 'songs'; render(); }, { signal });
    el.querySelectorAll('[data-keep]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.keep);
      const g = findDuplicates(songs())[i];
      if (!g) return;
      const keep = el.querySelector(`input[name="dg${i}"]:checked`)?.value;
      if (!keep) return;
      // the survivor inherits the others' titles as aliases — the name was in
      // use, and losing it would break a later import that still calls it that
      const kept = bank.songs[keep];
      const aliases = new Set(kept.aliases || []);
      for (const t of g.titles) {
        if (t === keep) continue;
        (bank.songs[t].aliases || []).forEach(a => aliases.add(a));
        aliases.add(t);
        delete bank.songs[t];
      }
      kept.aliases = [...aliases].filter(a => normTitle(a) !== normTitle(keep));
      if (!kept.aliases.length) delete kept.aliases;
      persist();
      showToast(`Kept “${keep}”`);
      render();
    }, { signal }));
  }

  function renderImport() {
    const { added, filled, conflicts, fileName, map, skipped } = pending;
    const unmapped = ['title', 'ccli', 'writers', 'copyright'].filter(f => map[f] === undefined);
    el.innerHTML = `
      <div class="sb-bar"><button class="btn small" id="sb-cancel">← Cancel</button>
        <span class="muted">${esc(fileName)}</span></div>
      ${unmapped.length ? card(`<div class="sb-why">No column matched: <b>${unmapped.join(', ')}</b>.
        Those fields will be left alone.</div>`) : ''}
      ${card(`
        <div class="sb-n"><b>${added.length}</b> new song${added.length === 1 ? '' : 's'} to add</div>
        <div class="sb-n"><b>${filled.length}</b> blank field${filled.length === 1 ? '' : 's'} to fill in</div>
        <div class="sb-n"><b>${conflicts.length}</b> disagreement${conflicts.length === 1 ? '' : 's'} with what is stored</div>
        ${skipped ? `<div class="sb-n muted">${skipped} row${skipped === 1 ? '' : 's'} had no title or number and were skipped</div>` : ''}
      `)}
      ${added.length ? card(`<div class="sb-why">New songs</div>${added.map(t => `<div class="sb-song"><div class="sb-t">${esc(t)}</div></div>`).join('')}`) : ''}
      ${conflicts.length ? card(`
        <div class="sb-why">These disagree with verified entries and will NOT be changed.
          The stored value stays; the import is only shown so you can judge it.</div>
        ${conflicts.map(c => `<div class="sb-song">
          <div class="sb-t">${esc(c.title)} — ${esc(c.field)}</div>
          <div class="sb-m">stored: ${esc(c.stored)}</div>
          <div class="sb-m">import: ${esc(c.incoming)}</div>
        </div>`).join('')}`) : ''}
      <div class="sb-bar"><button class="btn small go" id="sb-apply">Apply — add ${added.length}, fill ${filled.length}</button></div>`;

    el.querySelector('#sb-cancel').addEventListener('click', () => { pending = null; view = 'songs'; render(); }, { signal });
    el.querySelector('#sb-apply').addEventListener('click', () => {
      bank.songs = pending.merged;
      persist();
      const n = pending.added.length;
      pending = null; view = 'songs'; render();
      showToast(`Merged — ${n} added. Checking for duplicates…`);
      const dupes = findDuplicates(songs());
      if (dupes.length) { view = 'dupes'; render(); }
    }, { signal });
  }

  root.querySelector('#sb-root').closest('*');
  tools.querySelector('#sb-dupes').addEventListener('click', () => { view = 'dupes'; render(); }, { signal });
  tools.querySelector('#sb-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(bank, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'song_bank.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, { signal });

  tools.querySelector('#sb-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { parseCsvFile } = await import('./csvedit.js');
      const { rows } = await parseCsvFile(file);
      const { songs: incoming, map, skipped } = rowsToSongs(rows);
      if (!incoming.length) { showToast('No songs found in that file'); return; }
      pending = { ...mergeSongs(songs(), incoming), fileName: file.name, map, skipped };
      view = 'import';
      render();
    } catch (err) {
      showToast(err?.message || 'Could not read that CSV');
    }
  }, { signal });

  // Seed on first run from the file shipped with the dashboard, then never
  // again — after that the stored bank is the record and the seed is history.
  (async () => {
    if (!bank) {
      try {
        const res = await fetch(SEED_URL);
        bank = await res.json();
      } catch { bank = { version: 1, songs: {}, meta: {} }; }
      persist();
    }
    render();
  })();

  return function unmount() { ac.abort(); };
}
