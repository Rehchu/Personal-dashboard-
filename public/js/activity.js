// PS5-style activity cards — tiny live stats under the focused tile.
// Pure read: computes from localStorage, renders static markup, no listeners.

import { load, esc } from './store.js';

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const words = text => (text && text.trim() ? text.trim().split(/\s+/).length : 0);

const kfmt = n =>
  n >= 10000 ? `${Math.round(n / 1000)}k` :
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function fitnessCards() {
  const workouts = load('fit.workouts', []);
  const weights = load('fit.weights', []);
  const week = new Set();
  for (let i = 0; i < 7; i++) week.add(dayKey(i));
  const inWeek = workouts.filter(w => week.has(w.date));
  const minutes = inWeek.reduce((s, w) => s + (Number(w.minutes) || 0), 0);

  const dates = new Set(workouts.map(w => w.date));
  let streak = 0;
  const start = dates.has(dayKey(0)) ? 0 : 1; // today counts; else streak may end yesterday
  while (dates.has(dayKey(start + streak))) streak++;

  const latest = weights.reduce((a, b) => (!a || b.date > a.date ? b : a), null);
  return [
    { v: String(inWeek.length), l: 'workouts this week' },
    { v: String(minutes), l: 'active min' },
    { v: String(streak), l: 'day streak' },
    { v: latest ? `${esc(latest.value)} lb` : '—', l: 'latest weight' },
  ];
}

function writingCards() {
  const books = load('books', []);
  let total = 0;
  let chapters = 0;
  for (const b of books) {
    chapters += b.chapters.length;
    for (const c of b.chapters) total += words(c.text);
  }
  const first = books[0];
  const target = (first && first.target) || 80000;
  const firstWords = first ? first.chapters.reduce((s, c) => s + words(c.text), 0) : 0;
  return [
    { v: kfmt(total), l: 'words' },
    { v: String(chapters), l: 'chapters' },
    { v: `${Math.min(100, Math.round((firstWords / target) * 100))}%`, l: 'of goal' },
    { v: String(books.length), l: books.length === 1 ? 'book' : 'books' },
  ];
}

function notebookCards() {
  const pages = load('nb.pages', []);
  const inked = pages.filter(p => p.strokes && p.strokes.length > 0).length;
  const idx = Math.max(0, Math.min(load('nb.page', 0), pages.length - 1));
  const cur = pages[idx];
  return [
    { v: String(pages.length), l: pages.length === 1 ? 'page' : 'pages' },
    { v: String(inked), l: 'with ink' },
    { v: String(cur && cur.strokes ? cur.strokes.length : 0), l: 'strokes here' },
  ];
}

function projectsCards() {
  const cached = load('gh.repos', null);
  if (!cached || !cached.repos || !cached.repos.length) {
    return [{ v: '…', l: 'repos' }, { v: '…', l: 'last push' }];
  }
  const latest = cached.repos.reduce((a, b) => (b.pushed > a.pushed ? b : a));
  return [
    { v: String(cached.repos.length), l: 'repos' },
    { v: esc(latest.name), l: 'last push' },
  ];
}

function cloudflareCards() {
  return [
    { v: '7', l: 'apps + infra workers' },
    { v: 'lifehq', l: '+ this dashboard' },
  ];
}

const BUILDERS = {
  fitness: fitnessCards,
  writing: writingCards,
  notebook: notebookCards,
  projects: projectsCards,
  cloudflare: cloudflareCards,
};

export function activityCards(tileId) {
  const build = BUILDERS[tileId];
  if (!build) return null;
  const el = document.createElement('div');
  el.className = 'activity-cards';
  el.innerHTML = build().map(c => `
    <div class="act-card">
      <div class="act-value">${c.v}</div>
      <div class="act-label">${c.l}</div>
    </div>`).join('');
  return el;
}
