// Book Writing module — books → chapters → editor, plus the Manuskript-style
// working tools: an outline corkboard with per-chapter status and synopsis, a
// cast/worldbuilding card deck, and a distraction-free focus mode.
// Seeded with the Dragons project. Autosaves to localStorage as you type.

import { load, save, uid, debounce, esc, todayISO, showToast } from './store.js';
import { inboxList } from './capture.js';

const STATUSES = ['todo', 'draft', 'revised', 'done'];
const STATUS_LABEL = { todo: 'To do', draft: 'Draft', revised: 'Revised', done: 'Done' };
const STATUS_TINT = {
  todo: 'var(--ink-3)',
  draft: '#c98a2e',
  revised: '#3f8fd0',
  done: '#3f9d5a',
};
const KIND_LABEL = { character: 'Character', place: 'Place', lore: 'Lore' };

function seed() {
  return [{
    id: uid(),
    title: 'Dragons',
    target: 80000,
    chapters: [{
      id: uid(),
      title: 'Chapter 1',
      text: '',
      summary: '',
      status: 'todo',
      pov: '',
      updated: Date.now(),
    }],
    cards: [],
  }];
}

// older saves predate summary/status/pov/cards; fill them in rather than
// letting undefined reach the renderers
function migrate(books) {
  for (const b of books) {
    if (!Array.isArray(b.cards)) b.cards = [];
    for (const c of b.chapters || []) {
      if (typeof c.summary !== 'string') c.summary = '';
      if (!STATUSES.includes(c.status)) c.status = c.text && c.text.trim() ? 'draft' : 'todo';
      if (typeof c.pov !== 'string') c.pov = '';
    }
  }
  return books;
}

const getBooks = () => {
  const books = load('books', null);
  if (books && books.length) return migrate(books);
  const s = seed();
  save('books', s);
  return s;
};

const words = text => (text.trim() ? text.trim().split(/\s+/).length : 0);
const bookWords = book => book.chapters.reduce((s, c) => s + words(c.text), 0);

const STYLE = `
  #wr-views { display: flex; gap: 6px; }
  #wr-outline { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .wr-card { text-align: left; padding: 13px 14px; border-radius: 10px; cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--ink-3) 30%, transparent);
    background: color-mix(in oklab, var(--surface-2) 70%, transparent); display: block; width: 100%; }
  .wr-card.current { border-color: var(--accent); }
  .wr-card h4 { margin: 0 0 6px; font-family: var(--font-display); font-size: 15px; }
  .wr-card .wr-syn { color: var(--ink-2); font-size: 13px; line-height: 1.45; min-height: 34px; }
  .wr-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    letter-spacing: .06em; text-transform: uppercase; margin-top: 9px; color: var(--ink-2); }
  .wr-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  /* focus mode: the page falls away and only the words remain */
  html.wr-focus #appview-bar, html.wr-focus #wr-side, html.wr-focus #pill-nav { display: none; }
  html.wr-focus #appview-body { padding: 0; }
  html.wr-focus #wr-grid { grid-template-columns: 1fr; }
  html.wr-focus #wr-editor-panel { border: none; background: none; box-shadow: none;
    max-width: 46rem; margin: 0 auto; padding-top: 24px; }
  html.wr-focus #writing-editor { min-height: 78vh; font-size: 18px; line-height: 1.7; }
  html.wr-focus #wr-focus-exit { display: inline-flex; }
  #wr-focus-exit { display: none; position: fixed; top: 12px; right: 14px; z-index: 40; }
`;

export function mount(root, tools) {
  let books = getBooks();
  let sel = load('writing.sel', {});
  let book = books.find(b => b.id === sel.book) || books[0];
  let chapter = book.chapters.find(c => c.id === sel.chapter) || book.chapters[0];
  let view = load('writing.view', 'write');

  const persist = () => save('books', books);
  const remember = () => save('writing.sel', { book: book.id, chapter: chapter?.id });

  tools.innerHTML = `
    <span id="wr-views">
      <button class="btn small" data-view="write">Write</button>
      <button class="btn small" data-view="outline">Outline</button>
      <button class="btn small" data-view="cast">Cast</button>
    </span>
    <button class="btn small" id="wr-focus">◑ Focus</button>
    <button class="btn small" id="wr-sprint">⏱ Sprint</button>
    <button class="btn small" id="wr-export">⬇ Export .md</button>`;

  root.innerHTML = `
    <style>${STYLE}</style>
    <button class="btn small" id="wr-focus-exit">✕ Exit focus</button>
    <div style="display:grid;grid-template-columns:minmax(230px, 290px) 1fr;gap:18px;align-items:start" id="wr-grid">
      <div id="wr-side">
        <div class="panel" style="margin-bottom:14px">
          <h3>Books</h3>
          <div id="wr-books"></div>
          <button class="btn small" id="wr-add-book" style="margin-top:10px">＋ New book</button>
        </div>
        <div class="panel">
          <h3>Chapters</h3>
          <div id="wr-chapters"></div>
          <button class="btn small" id="wr-add-ch" style="margin-top:10px">＋ New chapter</button>
        </div>
        <div class="panel" style="margin-top:14px">
          <h3>Idea inbox</h3>
          <div id="wr-inbox"></div>
        </div>
      </div>
      <div>
        <div class="panel" id="wr-editor-panel">
          <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
            <input id="wr-ch-title" style="flex:1;min-width:180px;font-family:var(--font-display);font-weight:700;font-size:18px" aria-label="Chapter title">
            <span class="muted" id="wr-counts"></span>
            <button class="btn small danger" id="wr-del-ch" title="Delete chapter">✕ chapter</button>
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
            <div class="progress" style="flex:1;min-width:120px"><div id="wr-progress" style="width:0%"></div></div>
            <label class="muted" style="white-space:nowrap">goal <input id="wr-target" type="number" min="1000" step="1000" style="width:90px;padding:4px 8px"> words</label>
            <label class="muted" style="white-space:nowrap">status
              <select id="wr-status" style="padding:4px 8px">
                ${STATUSES.map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}
              </select>
            </label>
          </div>
          <textarea id="writing-editor" placeholder="Write. The Stoker-class dragons aren't going to document themselves." spellcheck="true"></textarea>
          <p class="muted" id="wr-saved" style="margin-top:8px">&nbsp;</p>
        </div>

        <div class="panel" id="wr-outline-panel" hidden>
          <h3>Outline</h3>
          <p class="muted" style="margin-bottom:12px">One card per chapter. Write the synopsis here, click a card to open it.</p>
          <div id="wr-outline"></div>
        </div>

        <div class="panel" id="wr-cast-panel" hidden>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
            <h3 style="flex:1;margin:0">Cast &amp; world</h3>
            ${Object.keys(KIND_LABEL).map(k =>
              `<button class="btn small" data-add-card="${k}">＋ ${KIND_LABEL[k]}</button>`).join('')}
          </div>
          <div id="wr-cast"></div>
        </div>
      </div>
    </div>`;

  if (matchMedia('(max-width: 860px)').matches) {
    root.querySelector('#wr-grid').style.gridTemplateColumns = '1fr';
  }

  const editor = root.querySelector('#writing-editor');
  const titleInput = root.querySelector('#wr-ch-title');
  const targetInput = root.querySelector('#wr-target');
  const statusSel = root.querySelector('#wr-status');
  const savedNote = root.querySelector('#wr-saved');

  function renderLists() {
    root.querySelector('#wr-books').innerHTML = books.map(b => `
      <button class="btn small" data-book="${b.id}" style="display:block;width:100%;text-align:left;margin-bottom:6px;${b.id === book.id ? 'border-color:var(--accent);' : ''}">
        ${esc(b.title)} <span class="muted">· ${bookWords(b).toLocaleString()}w</span>
      </button>`).join('');
    root.querySelector('#wr-chapters').innerHTML = book.chapters.map(c => `
      <button class="btn small" data-ch="${c.id}" style="display:block;width:100%;text-align:left;margin-bottom:6px;${c.id === chapter?.id ? 'border-color:var(--accent);' : ''}">
        ${esc(c.title)} <span class="muted">· ${words(c.text).toLocaleString()}w</span>
      </button>`).join('');

    root.querySelectorAll('[data-book]').forEach(btn => btn.addEventListener('click', () => {
      commitNow();
      book = books.find(b => b.id === btn.dataset.book);
      chapter = book.chapters[0] || null;
      remember(); renderAll();
    }));
    root.querySelectorAll('[data-ch]').forEach(btn => btn.addEventListener('click', () => {
      commitNow();
      chapter = book.chapters.find(c => c.id === btn.dataset.ch);
      remember(); renderEditor(); renderLists();
    }));
  }

  function renderOutline() {
    const host = root.querySelector('#wr-outline');
    host.innerHTML = book.chapters.map(c => `
      <div class="wr-card${c.id === chapter?.id ? ' current' : ''}" data-outline="${c.id}">
        <h4>${esc(c.title)}</h4>
        <div class="wr-syn" contenteditable="true" data-syn="${c.id}"
             data-placeholder="What happens in this chapter?">${esc(c.summary)}</div>
        <span class="wr-chip">
          <span class="wr-dot" style="background:${STATUS_TINT[c.status]}"></span>
          <button data-cycle="${c.id}" style="color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit">${STATUS_LABEL[c.status]}</button>
          · ${words(c.text).toLocaleString()}w
        </span>
      </div>`).join('');

    host.querySelectorAll('[data-syn]').forEach(el => {
      el.addEventListener('input', () => {
        const c = book.chapters.find(x => x.id === el.dataset.syn);
        if (c) { c.summary = el.textContent; commit(); }
      });
      // typing in a synopsis must not also open the chapter
      el.addEventListener('click', e => e.stopPropagation());
    });
    host.querySelectorAll('[data-cycle]').forEach(btn => btn.addEventListener('click', e => {
      e.stopPropagation();
      const c = book.chapters.find(x => x.id === btn.dataset.cycle);
      if (!c) return;
      c.status = STATUSES[(STATUSES.indexOf(c.status) + 1) % STATUSES.length];
      persist(); renderOutline(); if (c.id === chapter?.id) statusSel.value = c.status;
    }));
    host.querySelectorAll('[data-outline]').forEach(el => el.addEventListener('click', () => {
      commitNow();
      chapter = book.chapters.find(c => c.id === el.dataset.outline);
      remember(); setView('write'); renderAll();
    }));
  }

  function renderCast() {
    const host = root.querySelector('#wr-cast');
    if (!book.cards.length) {
      host.innerHTML = '<p class="muted">No cards yet. Add a character, a place, or a piece of lore.</p>';
      return;
    }
    host.innerHTML = `<div id="wr-outline-cards" style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">
      ${book.cards.map(card => `
        <div class="wr-card" data-card="${card.id}">
          <h4>${esc(card.name)}</h4>
          <p class="muted" style="margin:0 0 6px;font-size:12px">${KIND_LABEL[card.kind] || 'Card'}${card.role ? ` · ${esc(card.role)}` : ''}</p>
          <div class="wr-syn" contenteditable="true" data-note="${card.id}">${esc(card.notes)}</div>
          <span class="wr-chip"><button data-del-card="${card.id}" style="color:inherit;font:inherit">✕ remove</button></span>
        </div>`).join('')}
    </div>`;

    host.querySelectorAll('[data-note]').forEach(el => el.addEventListener('input', () => {
      const card = book.cards.find(c => c.id === el.dataset.note);
      if (card) { card.notes = el.textContent; commit(); }
    }));
    host.querySelectorAll('[data-del-card]').forEach(btn => btn.addEventListener('click', () => {
      const card = book.cards.find(c => c.id === btn.dataset.delCard);
      if (!card || !confirm(`Remove "${card.name}"?`)) return;
      book.cards = book.cards.filter(c => c.id !== card.id);
      persist(); renderCast();
    }));
  }

  function setView(next) {
    view = next;
    save('writing.view', view);
    root.querySelector('#wr-editor-panel').hidden = view !== 'write';
    root.querySelector('#wr-outline-panel').hidden = view !== 'outline';
    root.querySelector('#wr-cast-panel').hidden = view !== 'cast';
    tools.querySelectorAll('[data-view]').forEach(b => {
      b.style.borderColor = b.dataset.view === view ? 'var(--accent)' : '';
    });
    if (view === 'outline') renderOutline();
    if (view === 'cast') renderCast();
  }

  function renderEditor() {
    const has = Boolean(chapter);
    editor.disabled = !has;
    titleInput.disabled = !has;
    statusSel.disabled = !has;
    editor.value = has ? chapter.text : '';
    titleInput.value = has ? chapter.title : '';
    statusSel.value = has ? chapter.status : 'todo';
    targetInput.value = book.target || 80000;
    updateCounts();
  }

  function updateCounts() {
    const cw = chapter ? words(editor.value) : 0;
    const total = bookWords(book) - (chapter ? words(chapter.text) : 0) + cw;
    const target = Number(targetInput.value) || book.target || 80000;
    const pct = Math.min(100, (total / target) * 100);
    root.querySelector('#wr-counts').textContent =
      `${cw.toLocaleString()} words in chapter · ${total.toLocaleString()} in book`;
    root.querySelector('#wr-progress').style.width = `${pct}%`;
  }

  function renderAll() { renderLists(); renderEditor(); setView(view); }

  // Immediate commit + debounced wrapper. commitNow() MUST run before any
  // handler reassigns `book`/`chapter`, or the last <600ms of typing is lost.
  function commitNow() {
    book.target = Number(targetInput.value) || book.target;
    if (chapter) {
      chapter.text = editor.value;
      chapter.title = titleInput.value.trim() || chapter.title;
      if (STATUSES.includes(statusSel.value)) chapter.status = statusSel.value;
      chapter.updated = Date.now();
    }
    const ok = persist();
    savedNote.textContent = ok
      ? `Saved ${new Date().toLocaleTimeString()}`
      : '⚠ Storage full — recent changes are NOT saved';
    // daily word log (feeds the Today briefing's "words today")
    const totalAll = books.reduce((s, b) => s + bookWords(b), 0);
    const daylog = load('writing.daylog', {});
    if (daylog[todayISO()] !== totalAll) {
      daylog[todayISO()] = totalAll;
      save('writing.daylog', daylog);
    }
    renderLists();
    window.dispatchEvent(new CustomEvent('pd:data-changed'));
  }
  const commit = debounce(commitNow, 600);

  editor.addEventListener('input', () => { updateCounts(); commit(); });
  titleInput.addEventListener('input', commit);
  targetInput.addEventListener('input', () => { updateCounts(); commit(); });
  statusSel.addEventListener('change', commit);

  tools.querySelectorAll('[data-view]').forEach(btn =>
    btn.addEventListener('click', () => { commitNow(); setView(btn.dataset.view); }));

  root.querySelectorAll('[data-add-card]').forEach(btn => btn.addEventListener('click', () => {
    const kind = btn.dataset.addCard;
    const name = prompt(`${KIND_LABEL[kind]} name?`);
    if (!name || !name.trim()) return;
    const role = kind === 'character' ? (prompt('Role? (optional)', '') || '') : '';
    book.cards.push({ id: uid(), kind, name: name.trim(), role: role.trim(), notes: '' });
    persist(); renderCast();
  }));

  /* ---------- focus mode ---------- */
  const focusBtn = tools.querySelector('#wr-focus');
  const exitBtn = root.querySelector('#wr-focus-exit');
  function setFocus(on) {
    document.documentElement.classList.toggle('wr-focus', on);
    if (on) { setView('write'); editor.focus(); }
  }
  focusBtn.addEventListener('click', () => setFocus(!document.documentElement.classList.contains('wr-focus')));
  exitBtn.addEventListener('click', () => setFocus(false));
  const onKey = e => {
    if (e.key === 'Escape' && document.documentElement.classList.contains('wr-focus')) {
      e.stopPropagation(); // Escape belongs to focus mode before the module host
      setFocus(false);
    }
  };
  document.addEventListener('keydown', onKey, true);

  root.querySelector('#wr-add-book').addEventListener('click', () => {
    commitNow();
    const title = prompt('Book title?', 'New book');
    if (!title) return;
    const b = {
      id: uid(), title: title.trim(), target: 80000, cards: [],
      chapters: [{ id: uid(), title: 'Chapter 1', text: '', summary: '', status: 'todo', pov: '', updated: Date.now() }],
    };
    books.push(b); book = b; chapter = b.chapters[0];
    persist(); remember(); renderAll();
  });

  root.querySelector('#wr-add-ch').addEventListener('click', () => {
    commitNow();
    const c = {
      id: uid(), title: `Chapter ${book.chapters.length + 1}`,
      text: '', summary: '', status: 'todo', pov: '', updated: Date.now(),
    };
    book.chapters.push(c); chapter = c;
    persist(); remember(); renderAll();
    titleInput.focus(); titleInput.select();
  });

  root.querySelector('#wr-del-ch').addEventListener('click', () => {
    if (!chapter) return;
    commitNow();
    if (!confirm(`Delete "${chapter.title}"? This can't be undone.`)) return;
    book.chapters = book.chapters.filter(c => c.id !== chapter.id);
    chapter = book.chapters[0] || null;
    persist(); remember(); renderAll();
  });

  tools.querySelector('#wr-export').addEventListener('click', () => {
    commitNow();
    const cast = book.cards.length
      ? ['', '---', '', '## Cast & world', '',
        ...book.cards.map(c => `- **${c.name}**${c.role ? ` (${c.role})` : ''} — ${KIND_LABEL[c.kind]}${c.notes ? `: ${c.notes}` : ''}`)]
      : [];
    const md = [
      `# ${book.title}`, '',
      ...book.chapters.flatMap(c => [
        `## ${c.title}`,
        ...(c.summary ? ['', `> ${c.summary}`] : []),
        '', c.text, '',
      ]),
      ...cast,
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${book.title.replace(/[^\w-]+/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // idea inbox → append captured thoughts into the open chapter
  const inboxEl = inboxList({
    limit: 8,
    useLabel: '→ chapter',
    onUse: entry => {
      if (!chapter) return;
      editor.value += (editor.value.trim() ? '\n\n' : '') + entry.text;
      updateCounts();
      commitNow();
    },
  });
  root.querySelector('#wr-inbox').append(inboxEl);

  // writing sprint timer
  const sprintBtn = tools.querySelector('#wr-sprint');
  let sprint = null; // {end, minutes, startWords, timer}
  const totalWords = () => books.reduce((s, b) => s + bookWords(b), 0);

  function endSprint(finished) {
    clearInterval(sprint.timer);
    const gained = Math.max(0, totalWords() - sprint.startWords);
    if (finished) {
      const log = load('writing.sprints', []);
      log.push({ id: uid(), ts: Date.now(), minutes: sprint.minutes, words: gained });
      save('writing.sprints', log);
      showToast(`Sprint done — ${gained} words in ${sprint.minutes} min 🐉`);
      window.dispatchEvent(new CustomEvent('pd:data-changed'));
    }
    sprint = null;
    sprintBtn.textContent = '⏱ Sprint';
  }

  sprintBtn.addEventListener('click', () => {
    if (sprint) {
      if (confirm('End this sprint early?')) endSprint(false);
      return;
    }
    const minutes = Number(prompt('Sprint length in minutes?', '20'));
    if (!minutes || minutes < 1 || minutes > 180) return;
    commitNow();
    sprint = { end: Date.now() + minutes * 60_000, minutes, startWords: totalWords() };
    sprint.timer = setInterval(() => {
      const left = sprint.end - Date.now();
      if (left <= 0) { endSprint(true); return; }
      const m = Math.floor(left / 60_000);
      const s = Math.floor((left % 60_000) / 1000);
      sprintBtn.textContent = `⏱ ${m}:${String(s).padStart(2, '0')} · +${Math.max(0, totalWords() - sprint.startWords)}w`;
    }, 1000);
    showToast(`Sprint started — ${minutes} minutes. Go.`);
  });

  renderAll();

  return () => {
    if (sprint) endSprint(false);
    commitNow(); // closing the module must not lose the last 600ms of typing
    document.documentElement.classList.remove('wr-focus'); // never leak focus mode
    document.removeEventListener('keydown', onKey, true);
    inboxEl.destroy?.();
  };
}
