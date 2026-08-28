// Shared quick-capture inbox — one composer + one list, reusable anywhere
// (dragon book ideas, life admin). Data lives in 'inbox' as {id, text, ts},
// newest first. Both factories return elements with an el.destroy() that
// releases their window/mic hooks — call it when you remove the element.

import { load, save, uid, esc, showToast } from './store.js';

const STYLE_ID = 'capture-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .cap-box textarea { width: 100%; min-height: 64px; resize: vertical; }
    .cap-row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 8px; }
    .cap-mic.rec { border-color: var(--accent); color: var(--accent); }
    @media (prefers-reduced-motion: no-preference) {
      .cap-mic.rec { animation: cap-pulse 1.2s ease-in-out infinite; }
    }
    @keyframes cap-pulse { 50% { opacity: .55; } }
    .cap-item { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--surface-2); }
    .cap-item:last-child { border-bottom: 0; }
    .cap-time { display: block; font-size: 11px; }
    .cap-text { overflow-wrap: anywhere; white-space: pre-wrap; }
    .cap-actions { display: flex; gap: 6px; flex-shrink: 0; }`;
  document.head.append(style);
}

const getInbox = () => load('inbox', []);

const notify = () => window.dispatchEvent(new CustomEvent('pd:data-changed'));

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

const joinText = (a, b) => (a && !/\s$/.test(a) ? a + ' ' : a) + b;

// Compact composer: textarea + optional 🎙 dictation + Add.
// Returns an element; call el.destroy() on teardown (stops any live mic).
export function captureBox() {
  ensureStyle();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const el = document.createElement('div');
  el.className = 'cap-box';
  el.innerHTML = `
    <textarea placeholder="Capture an idea…" aria-label="Capture an idea"></textarea>
    <div class="cap-row">
      ${SR ? '<button class="btn small cap-mic" title="Dictate" aria-label="Dictate" aria-pressed="false">🎙</button>' : ''}
      <button class="btn small primary cap-add">Add</button>
    </div>`;

  const ta = el.querySelector('textarea');
  const micBtn = el.querySelector('.cap-mic');
  let rec = null;
  let listening = false;
  let base = ''; // committed text; interim results render on top of this

  function stopDictation() {
    if (!rec) return;
    listening = false;
    try { rec.stop(); } catch { /* already stopped */ }
    rec = null;
    if (micBtn) {
      micBtn.classList.remove('rec');
      micBtn.setAttribute('aria-pressed', 'false');
    }
  }

  function startDictation() {
    base = ta.value;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) base = joinText(base, t.trim());
        else interim += t;
      }
      ta.value = interim ? joinText(base, interim.trim()) : base;
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') showToast('Mic access denied');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') showToast('Dictation error');
      stopDictation();
    };
    rec.onend = () => { if (listening) stopDictation(); }; // browser gave up on its own
    try {
      rec.start();
      listening = true;
      micBtn.classList.add('rec');
      micBtn.setAttribute('aria-pressed', 'true');
    } catch {
      rec = null;
      showToast('Dictation unavailable');
    }
  }

  if (micBtn) micBtn.addEventListener('click', () => (listening ? stopDictation() : startDictation()));

  // Keep dictation's committed base in sync with manual edits mid-session.
  ta.addEventListener('input', () => { if (listening) base = ta.value; });

  function add() {
    const text = ta.value.trim();
    if (!text) return;
    stopDictation();
    const ok = save('inbox', [{ id: uid(), text, ts: Date.now() }, ...getInbox()]);
    ta.value = '';
    base = '';
    showToast(ok ? 'Captured' : 'Storage full — not saved');
    notify();
  }

  el.querySelector('.cap-add').addEventListener('click', add);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); }
  });

  el.destroy = stopDictation; // no window listeners; just release the mic
  return el;
}

// Live inbox list. Options: limit (max entries shown), onUse(entry) + useLabel
// for a per-entry action button (entry is removed after onUse runs).
// Listens to window 'pd:data-changed' — call el.destroy() on teardown.
export function inboxList({ limit, onUse, useLabel } = {}) {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'cap-list';
  let wasConnected = false;

  function render() {
    const items = getInbox();
    const shown = limit ? items.slice(0, limit) : items;
    if (!shown.length) {
      el.innerHTML = '<p class="muted">Inbox zero — capture something.</p>';
      return;
    }
    el.innerHTML = shown.map(en => `
      <div class="cap-item">
        <div>
          <span class="cap-time muted">${timeAgo(en.ts)}</span>
          <span class="cap-text">${esc(en.text)}</span>
        </div>
        <div class="cap-actions">
          ${onUse ? `<button class="btn small" data-use="${en.id}">${esc(useLabel || '→ use')}</button>` : ''}
          <button class="btn small danger" data-del="${en.id}" title="Delete" aria-label="Delete entry">✕</button>
        </div>
      </div>`).join('');
  }

  function removeEntry(id) {
    save('inbox', getInbox().filter(i => i.id !== id));
    notify(); // re-renders every live list, this one included
  }

  el.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    const use = e.target.closest('[data-use]');
    if (del) removeEntry(del.dataset.del);
    else if (use) {
      const entry = getInbox().find(i => i.id === use.dataset.use);
      if (entry) { onUse(entry); removeEntry(entry.id); }
    }
  });

  const onChanged = () => {
    if (el.isConnected) wasConnected = true;
    else if (wasConnected) { el.destroy(); return; } // safety net if destroy() was missed
    render();
  };
  window.addEventListener('pd:data-changed', onChanged);
  el.destroy = () => window.removeEventListener('pd:data-changed', onChanged);

  render();
  return el;
}
