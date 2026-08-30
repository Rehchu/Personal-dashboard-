// PS5-style activity cards — tiny live stats under the focused tile.
// Pure read: computes from localStorage, renders static markup, no listeners.

import { load, esc, alive } from './store.js';
import { CF_FLEET } from './data.js';

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
  // alive(): deleted entries persist as sync tombstones and must not count
  const workouts = alive(load('fit.workouts', []));
  const weights = alive(load('fit.weights', []));
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
  const pages = alive(load('nb.pages', [])); // deleted pages are tombstones
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
  // computed from the data file, so adding a worker there updates this card
  return [
    { v: String(CF_FLEET.apps.length + CF_FLEET.infra.length), l: 'apps + infra workers' },
    { v: 'lifehq', l: '+ this dashboard' },
  ];
}

function archiveCards() {
  const count = load('archive.count', 0);
  // the archive syncs to the owner's private R2 now — "on-device only" was stale copy
  if (!count) return [{ v: '⬆', l: 'import your export' }, { v: '🔒', l: 'private · synced' }];
  return [
    { v: count.toLocaleString(), l: 'conversations' },
    { v: load('archive.msgs', 0).toLocaleString(), l: 'messages' },
    { v: esc(load('archive.topcat', '💬')), l: `top of ${load('archive.catcount', 0)} categories` },
  ];
}

function opsCards() {
  const shop = load('biz.shop', null)?.data;
  const it = load('biz.ariseit', null)?.data;
  if (!shop && !it) return [{ v: '🛰️', l: 'open to sync' }, { v: '…', l: 'shop + church' }];
  const cards = [];
  if (shop && shop.configured !== false) {
    cards.push({ v: String(shop.tickets?.length || 0), l: 'open tickets' });
    cards.push({ v: String(shop.leads?.count || 0), l: 'leads waiting' });
  }
  if (it && it.configured !== false) {
    cards.push({ v: String(it.open?.length || 0), l: 'IT tickets' });
  }
  const plan = load('biz.arise', null)?.data?.nextPlan;
  if (plan) cards.push({ v: `${plan.accepted}/${plan.positions}`, l: 'Sunday staffed' });
  return cards.length ? cards : [{ v: '✅', l: 'all clear' }];
}

function gamingCards() {
  const x = load('gaming.xbox', null)?.data;
  const p = load('gaming.psn', null)?.data;
  if (!x?.profile && !p?.summary) return [{ v: '🎮', l: 'connect a console' }, { v: 'XB · PS', l: 'gamerscore + trophies' }];
  const cards = [];
  if (x?.profile?.gamerscore) cards.push({ v: kfmt(x.profile.gamerscore), l: 'gamerscore' });
  if (p?.summary?.level) cards.push({ v: String(p.summary.level), l: 'trophy level' });
  if (p?.summary?.platinum) cards.push({ v: String(p.summary.platinum), l: 'platinums' });
  return cards.length ? cards : [{ v: '🎮', l: 'no data yet' }];
}

const BUILDERS = {
  fitness: fitnessCards,
  writing: writingCards,
  notebook: notebookCards,
  projects: projectsCards,
  cloudflare: cloudflareCards,
  archive: archiveCards,
  ops: opsCards,
  gaming: gamingCards,
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
