// Cloudflare Fleet module — everything running on the account, from a
// connector snapshot in data.js. (Live status would need an API token on the
// Worker; the fleet list is refreshed whenever the dashboard is rebuilt.)

import { CF_FLEET, CF_SNAPSHOT_DATE } from './data.js';
import { esc } from './store.js';

function fmtDate(w) {
  if (!w.lastDeploy) return w.statusNote || 'deploy date n/a';
  const [y, m, d] = w.lastDeploy.split('-').map(Number);
  return 'deployed ' + new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function card(w) {
  const inner = `
    <div class="card-title">⚡ ${esc(w.label)}</div>
    <div class="card-desc">${esc(w.desc || '')}</div>
    <div class="card-meta">
      <span>${esc(w.platform)}</span>
      <span>${esc(fmtDate(w))}</span>
      ${w.repo ? `<span class="cf-repo" data-href="${esc(w.repo)}">repo ↗</span>` : ''}
    </div>
    ${w.url ? `<div class="card-meta"><span>${esc(w.url.replace('https://', ''))}</span></div>` : ''}`;
  if (w.url) {
    return `<a class="card" href="${esc(w.url)}" target="_blank" rel="noopener">${inner}</a>`;
  }
  return `<div class="card" style="cursor:default">${inner}</div>`;
}

export function mount(root, tools) {
  tools.innerHTML = `
    <a class="btn small" href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare dash ↗</a>`;

  root.innerHTML = `
    <p class="muted" style="margin-bottom:14px">
      Account fleet snapshot · ${esc(CF_SNAPSHOT_DATE)} · ${CF_FLEET.apps.length} apps + ${CF_FLEET.infra.length} infra workers
    </p>
    <div class="panel" style="margin-bottom:18px">
      <h3>Apps</h3>
      <div class="cards">${CF_FLEET.apps.map(card).join('')}</div>
    </div>
    <div class="panel">
      <h3>Infrastructure</h3>
      <div class="cards">${CF_FLEET.infra.map(card).join('')}</div>
    </div>`;

  // repo chips inside anchor cards: navigate without triggering the card link
  root.querySelectorAll('.cf-repo').forEach(chip => {
    chip.style.textDecoration = 'underline';
    chip.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      window.open(chip.dataset.href, '_blank', 'noopener');
    });
  });
}
