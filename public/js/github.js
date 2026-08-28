// GitHub Projects module — public repos fetched client-side (no token),
// cached in localStorage for 10 minutes to stay well inside the rate limit.

import { load, save, esc } from './store.js';
import { GITHUB_USER } from './data.js';

const CACHE_KEY = 'gh.repos';
const CACHE_TTL = 10 * 60 * 1000;

const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26', CSS: '#663399',
  Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584', Java: '#b07219',
  'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Shell: '#89e051',
  Swift: '#F05138', Kotlin: '#A97BFF', Ruby: '#701516', PHP: '#4F5D95',
};

async function fetchRepos(force = false) {
  const cached = load(CACHE_KEY, null);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.repos;

  const res = await fetch(
    `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&sort=pushed`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) {
    if (cached) return cached.repos; // stale beats nothing
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = await res.json();
  const repos = data.map(r => ({
    name: r.name,
    desc: r.description,
    url: r.html_url,
    lang: r.language,
    stars: r.stargazers_count,
    pushed: r.pushed_at,
    fork: r.fork,
    archived: r.archived,
  }));
  save(CACHE_KEY, { at: Date.now(), repos });
  return repos;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
  return `${Math.floor(s / (86400 * 365))}y ago`;
}

function repoCard(r) {
  const lang = r.lang
    ? `<span><span class="lang-dot" style="background:${LANG_COLORS[r.lang] || 'var(--ink-3)'}"></span>${esc(r.lang)}</span>`
    : '';
  const stars = r.stars ? `<span>★ ${r.stars}</span>` : '';
  const flags = r.archived ? '<span>archived</span>' : (r.fork ? '<span>fork</span>' : '');
  return `
    <a class="card" href="${esc(r.url)}" target="_blank" rel="noopener">
      <div class="card-title">${esc(r.name)}</div>
      <div class="card-desc">${esc(r.desc || 'No description yet.')}</div>
      <div class="card-meta">${lang}${stars}<span>updated ${timeAgo(r.pushed)}</span>${flags}</div>
    </a>`;
}

export function mount(root, tools) {
  const refresh = document.createElement('button');
  refresh.className = 'btn small';
  refresh.textContent = '⟳ Refresh';
  tools.append(refresh);

  root.innerHTML = `<p class="muted" id="gh-status">Loading repositories from github.com/${esc(GITHUB_USER)}…</p><div class="cards" id="gh-cards"></div>`;
  const status = root.querySelector('#gh-status');
  const cards = root.querySelector('#gh-cards');

  async function render(force) {
    status.textContent = 'Loading repositories…';
    try {
      const repos = await fetchRepos(force);
      status.textContent = `${repos.length} repositories · sorted by last push`;
      cards.innerHTML = repos.map(repoCard).join('');
    } catch (err) {
      status.textContent = `Couldn't reach GitHub (${err.message}). Check the connection and refresh.`;
    }
  }

  refresh.addEventListener('click', () => render(true));
  render(false);
}
