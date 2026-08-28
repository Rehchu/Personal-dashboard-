// Book Writing module — books → chapters → editor, word goals, .md export.
// Seeded with the Dragons project. Autosaves to localStorage as you type.

import { load, save, uid, debounce, esc } from './store.js';

function seed() {
  return [{
    id: uid(),
    title: 'Dragons',
    target: 80000,
    chapters: [{
      id: uid(),
      title: 'Chapter 1',
      text: '',
      updated: Date.now(),
    }],
  }];
}

const getBooks = () => {
  const books = load('books', null);
  if (books && books.length) return books;
  const s = seed();
  save('books', s);
  return s;
};

const words = text => (text.trim() ? text.trim().split(/\s+/).length : 0);
const bookWords = book => book.chapters.reduce((s, c) => s + words(c.text), 0);

export function mount(root, tools) {
  let books = getBooks();
  let sel = load('writing.sel', {});
  let book = books.find(b => b.id === sel.book) || books[0];
  let chapter = book.chapters.find(c => c.id === sel.chapter) || book.chapters[0];

  const persist = () => save('books', books);
  const remember = () => save('writing.sel', { book: book.id, chapter: chapter?.id });

  tools.innerHTML = `
    <a class="btn small" href="https://github.com/Rehchu/Dragons" target="_blank" rel="noopener">Dragons repo ↗</a>
    <a class="btn small" href="https://github.com/Rehchu/3d-models" target="_blank" rel="noopener">3D models ↗</a>
    <button class="btn small" id="wr-export">⬇ Export .md</button>`;

  root.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(230px, 290px) 1fr;gap:18px;align-items:start" id="wr-grid">
      <div>
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
      </div>
      <div class="panel">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <input id="wr-ch-title" style="flex:1;min-width:180px;font-family:var(--font-display);font-weight:700;font-size:18px" aria-label="Chapter title">
          <span class="muted" id="wr-counts"></span>
          <button class="btn small danger" id="wr-del-ch" title="Delete chapter">✕ chapter</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
          <div class="progress" style="flex:1"><div id="wr-progress" style="width:0%"></div></div>
          <label class="muted" style="white-space:nowrap">goal <input id="wr-target" type="number" min="1000" step="1000" style="width:90px;padding:4px 8px"> words</label>
        </div>
        <textarea id="writing-editor" placeholder="Write. The Stoker-class dragons aren't going to document themselves." spellcheck="true"></textarea>
        <p class="muted" id="wr-saved" style="margin-top:8px">&nbsp;</p>
      </div>
    </div>`;

  if (matchMedia('(max-width: 860px)').matches) {
    root.querySelector('#wr-grid').style.gridTemplateColumns = '1fr';
  }

  const editor = root.querySelector('#writing-editor');
  const titleInput = root.querySelector('#wr-ch-title');
  const targetInput = root.querySelector('#wr-target');
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

  function renderEditor() {
    const has = Boolean(chapter);
    editor.disabled = !has;
    titleInput.disabled = !has;
    editor.value = has ? chapter.text : '';
    titleInput.value = has ? chapter.title : '';
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

  function renderAll() { renderLists(); renderEditor(); }

  // Immediate commit + debounced wrapper. commitNow() MUST run before any
  // handler reassigns `book`/`chapter`, or the last <600ms of typing is lost.
  function commitNow() {
    book.target = Number(targetInput.value) || book.target;
    if (chapter) {
      chapter.text = editor.value;
      chapter.title = titleInput.value.trim() || chapter.title;
      chapter.updated = Date.now();
    }
    const ok = persist();
    savedNote.textContent = ok
      ? `Saved ${new Date().toLocaleTimeString()}`
      : '⚠ Storage full — recent changes are NOT saved';
    renderLists();
  }
  const commit = debounce(commitNow, 600);

  editor.addEventListener('input', () => { updateCounts(); commit(); });
  titleInput.addEventListener('input', commit);
  targetInput.addEventListener('input', () => { updateCounts(); commit(); });

  root.querySelector('#wr-add-book').addEventListener('click', () => {
    commitNow();
    const title = prompt('Book title?', 'New book');
    if (!title) return;
    const b = { id: uid(), title: title.trim(), target: 80000, chapters: [{ id: uid(), title: 'Chapter 1', text: '', updated: Date.now() }] };
    books.push(b); book = b; chapter = b.chapters[0];
    persist(); remember(); renderAll();
  });

  root.querySelector('#wr-add-ch').addEventListener('click', () => {
    commitNow();
    const c = { id: uid(), title: `Chapter ${book.chapters.length + 1}`, text: '', updated: Date.now() };
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
    const md = [`# ${book.title}`, '', ...book.chapters.flatMap(c => [`## ${c.title}`, '', c.text, ''])].join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${book.title.replace(/[^\w-]+/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  renderAll();
}
