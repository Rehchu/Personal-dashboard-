// Offline support: stale-while-revalidate for same-origin static assets.
// /api/* is never cached (sync must always hit the network). Cross-origin
// requests (fonts, CDN, GitHub) pass through untouched.

const CACHE = 'dyerhq-v1';
const CORE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/base.css', '/css/themes.css', '/css/fx.css', '/css/xbox.css', '/css/polish.css',
  '/js/main.js', '/js/data.js', '/js/store.js', '/js/charts.js', '/js/github.js',
  '/js/fitness.js', '/js/writing.js', '/js/notebook.js', '/js/cloudflare.js',
  '/js/sfx.js', '/js/ambient.js', '/js/icons.js', '/js/achievements.js',
  '/js/activity.js', '/js/sync.js', '/js/capture.js', '/js/today.js',
  '/js/habits.js', '/js/dragons.js', '/js/archive.js', '/vendor/jszip.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // sync is network-only

  e.respondWith(
    caches.match(e.request).then(cached => {
      const refresh = fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached); // offline: fall back to cache (or fail as-is)
      return cached || refresh;
    }),
  );
});
