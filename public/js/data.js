// The tile rail. kind: 'module' opens a built-in app, 'link' launches a site.
// accent tints the tile artwork; actions become hero buttons (first = primary).

export const GITHUB_USER = 'Rehchu';

export const TILES = [
  {
    id: 'projects',
    title: 'GitHub Projects',
    glyph: '📁',
    accent: '#4a5d86',
    kind: 'module',
    badge: 'LIVE',
    desc: 'Every repository on my GitHub, pulled live — status, language, last activity.',
    actions: [
      { label: 'Open', action: 'open' },
      { label: 'github.com/Rehchu', href: 'https://github.com/Rehchu' },
    ],
  },
  {
    id: 'fitness',
    title: 'Fitness',
    glyph: '💪',
    accent: '#1f7a4d',
    kind: 'module',
    desc: 'Personal fitness tracking — log workouts, weigh-ins, streaks and trends.',
    actions: [{ label: 'Open', action: 'open' }],
  },
  {
    id: 'writing',
    title: 'Book Writing',
    glyph: '🐉',
    accent: '#7a3b1f',
    kind: 'module',
    desc: 'The dragon book studio — chapters, word-count goals, markdown export.',
    actions: [
      { label: 'Open', action: 'open' },
      { label: 'Dragons repo', href: 'https://github.com/Rehchu/Dragons' },
    ],
  },
  {
    id: 'notebook',
    title: 'Notebook',
    glyph: '📝',
    accent: '#5b4a86',
    kind: 'module',
    badge: '✏ PENCIL',
    desc: 'Handwriting canvas built for Apple Pencil on iPad — pressure, pages, PNG export.',
    actions: [{ label: 'Open', action: 'open' }],
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare Fleet',
    glyph: '⚡',
    accent: '#9a5b16',
    kind: 'module',
    badge: '6 LIVE',
    desc: 'Everything running on my Cloudflare account — Workers, deploys, and where each one lives.',
    actions: [
      { label: 'Open', action: 'open' },
      { label: 'Cloudflare dash', href: 'https://dash.cloudflare.com' },
    ],
  },
  {
    id: 'arisehub',
    title: 'Arise Hub',
    glyph: '🔥',
    accent: '#a02730',
    kind: 'link',
    badge: '⚡ CF',
    url: 'https://arisehub.myfaithtech.com',
    desc: 'Church management for Arise Church — people, check-in, chat, services, Bible.',
    actions: [
      { label: 'Launch', href: 'https://arisehub.myfaithtech.com' },
      { label: 'GitHub', href: 'https://github.com/Rehchu/AriseHub' },
    ],
  },
  {
    id: 'arisechurch',
    title: 'Arise Church Website',
    glyph: '⛪',
    accent: '#8c5a18',
    kind: 'link',
    url: 'https://www.arisecenla.church/',
    desc: 'The public Arise Church site (Pineville & Alexandria, LA) — built as a Claude chat project, hosted on Wix.',
    actions: [{ label: 'Launch', href: 'https://www.arisecenla.church/' }],
  },
  {
    id: 'apexcoach',
    title: 'ApexCoach',
    glyph: '🏔️',
    accent: '#0f6e5c',
    kind: 'link',
    badge: '⚡ CF',
    url: 'https://apextraining.dev',
    desc: 'Trainer / client / solo fitness coaching platform with AI — live on Cloudflare.',
    actions: [
      { label: 'Launch', href: 'https://apextraining.dev' },
      { label: 'GitHub', href: 'https://github.com/Rehchu/ApexTraining' },
    ],
  },
  {
    id: 'superspork',
    title: 'Super Spork',
    glyph: '🥄',
    accent: '#43408f',
    kind: 'link',
    url: 'https://github.com/Rehchu/super-spork',
    badge: 'WIP',
    desc: 'Comprehensive fitness tracker built with Convex Chef — in the workshop.',
    actions: [{ label: 'GitHub', href: 'https://github.com/Rehchu/super-spork' }],
  },
  {
    id: 'ctrlalt',
    title: 'Ctrl+Alt PC Repair',
    glyph: '🖥️',
    accent: '#116273',
    kind: 'link',
    badge: '⚡ CF',
    url: 'https://ctrl-alt-pc-repair.dyer-hq.workers.dev',
    desc: 'PC repair storefront + full back office (POS, tickets, inventory) on Cloudflare Workers.',
    actions: [
      { label: 'Launch', href: 'https://ctrl-alt-pc-repair.dyer-hq.workers.dev' },
      { label: 'GitHub', href: 'https://github.com/Rehchu/ctrl-alt-pc-repair' },
    ],
  },
  {
    id: 'ariseit',
    title: 'Arise IT Portal',
    glyph: '🧰',
    accent: '#365a7a',
    kind: 'link',
    badge: '⚡ CF',
    url: 'https://itportal.myfaithtech.com',
    desc: 'IT tickets and operations for Arise Church — Hono + D1 on Workers.',
    actions: [{ label: 'Launch', href: 'https://itportal.myfaithtech.com' }],
  },
  {
    id: 'lifehq',
    title: 'LifeHQ',
    glyph: '🧭',
    accent: '#3d6b6b',
    kind: 'link',
    badge: '⚡ CF',
    url: 'https://lifehq.dyer-hq.workers.dev',
    desc: 'LifeHQ Worker on Cloudflare — live at lifehq.dyer-hq.workers.dev.',
    actions: [{ label: 'Launch', href: 'https://lifehq.dyer-hq.workers.dev' }],
  },
  {
    id: 'models',
    title: '3D Models',
    glyph: '🦅',
    accent: '#4c6b2f',
    kind: 'link',
    url: 'https://github.com/Rehchu/3d-models',
    desc: 'Worldbuilding assets for the dragon book — Stoker-class dragon, dragon egg, golden eagle.',
    actions: [{ label: 'GitHub', href: 'https://github.com/Rehchu/3d-models' }],
  },
];

// Snapshot of the Cloudflare account fleet (pulled via the Cloudflare
// connector). lastDeploy = the Worker's modified_on date at snapshot time.
export const CF_SNAPSHOT_DATE = '2026-08-28';

export const CF_FLEET = {
  apps: [
    { name: 'arisehub', label: 'Arise Hub', platform: 'Worker', url: 'https://arisehub.myfaithtech.com', alt: 'arisehub.dyer-hq.workers.dev', repo: 'https://github.com/Rehchu/AriseHub', lastDeploy: '2026-08-13', desc: 'Church management PWA — Next.js on Workers via OpenNext.' },
    { name: 'ctrl-alt-pc-repair', label: 'Ctrl+Alt PC Repair', platform: 'Worker', url: 'https://ctrl-alt-pc-repair.dyer-hq.workers.dev', repo: 'https://github.com/Rehchu/ctrl-alt-pc-repair', lastDeploy: '2026-08-20', desc: 'Storefront + back office — Hono, D1, R2, Stripe/PayPal.' },
    { name: 'arise-it', label: 'Arise IT Portal', platform: 'Worker', url: 'https://itportal.myfaithtech.com', alt: 'arise-it.dyer-hq.workers.dev', repo: 'https://github.com/Rehchu/AriseHub', lastDeploy: '2026-08-09', desc: 'IT tickets & ops — Hono + D1.' },
    { name: 'lifehq', label: 'LifeHQ', platform: 'Worker', url: 'https://lifehq.dyer-hq.workers.dev', lastDeploy: '2026-07-11', desc: 'LifeHQ Worker.' },
    { name: 'apextraining', label: 'ApexCoach', platform: 'Pages', url: 'https://apextraining.dev', repo: 'https://github.com/Rehchu/ApexTraining', lastDeploy: '', statusNote: 'live', desc: 'Fitness coaching platform — Pages Functions, D1, R2, Workers AI.' },
    { name: 'personal-dashboard', label: 'This dashboard', platform: 'Worker', url: 'https://personal-dashboard.dyer-hq.workers.dev', repo: 'https://github.com/Rehchu/Personal-dashboard-', lastDeploy: '', statusNote: 'pending first deploy', desc: 'You are here (once deployed).' },
  ],
  infra: [
    { name: 'arisehub-cron', label: 'arisehub-cron', platform: 'Worker', desc: 'Scheduled jobs for Arise Hub.', lastDeploy: '2026-08-07' },
    { name: 'ctrl-alt-egress', label: 'ctrl-alt-egress', platform: 'Worker', desc: 'Stripe egress proxy for Ctrl+Alt.', lastDeploy: '2026-07-26' },
  ],
};
