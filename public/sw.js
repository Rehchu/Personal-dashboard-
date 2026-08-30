// Offline support: stale-while-revalidate for same-origin static assets.
// /api/* is never cached (sync must always hit the network). Cross-origin
// requests (fonts, CDN, GitHub) pass through untouched.

const CACHE = 'dyerhq-v8';
const CORE = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/base.css', '/css/themes.css', '/css/fx.css', '/css/xbox.css', '/css/polish.css',
  '/js/main.js', '/js/data.js', '/js/store.js', '/js/charts.js', '/js/github.js',
  '/js/fitness.js', '/js/writing.js', '/js/notebook.js', '/js/cloudflare.js',
  '/js/sfx.js', '/js/ambient.js', '/js/icons.js', '/js/achievements.js',
  '/js/activity.js', '/js/sync.js', '/js/capture.js', '/js/today.js',
  '/js/habits.js', '/js/dragons.js', '/js/archive.js', '/vendor/jszip.min.js', '/vendor/hls.light.min.js',
  // church + workshop modules and their helpers
  '/js/ptz.js', '/js/csvedit.js', '/js/service.js', '/js/expenses.js',
  '/js/videoclip.js', '/js/grok.js', '/js/openai.js', '/js/google.js',
  // Mission Control + Gaming + Dyer Town
  '/js/biz.js', '/js/gaming.js', '/js/town.js',
  '/css/game/assassins.css', '/css/game/cyberpunk.css', '/css/game/gtav.css',
  '/css/game/minecraft.css', '/css/game/xboxhome.css', '/css/game/ps5home.css', '/css/mobile.css', '/js/storm.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(results => {
        // A signed-out install 401s every CORE fetch; allSettled swallows that
        // and the install "succeeds" with an empty cache, so it never retries —
        // the app then has no offline support even after signing in. Count the
        // fulfilled adds and, if most failed, throw so the browser fails this
        // install and retries it on a later (signed-in) visit.
        const ok = results.filter(r => r.status === 'fulfilled').length;
        if (ok < results.length / 2) {
          throw new Error(`precache incomplete: only ${ok}/${results.length} cached`);
        }
      })
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
  if (url.pathname.startsWith('/api/')) return;   // sync/auth are network-only
  if (url.pathname.startsWith('/media/')) return; // video streams (Range) — never cache

  // The shell and its modules go network-first: cache-first served STALE CODE
  // for a whole load after every deploy, so a new feature appeared to be
  // missing until the page was reloaded a second time. Styles, fonts and
  // images stay stale-while-revalidate — they are cheap to be a beat behind.
  if (url.pathname === '/' || /\.(html|js)$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && res.headers.get('X-App-Shell')) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(hit => hit || Promise.reject(new Error('offline')))),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      const refresh = fetch(e.request)
        .then(res => {
          // Only cache authed app-shell responses — the login page (no
          // X-App-Shell header, no-store) must never overwrite the app.
          if (res.ok && res.headers.get('X-App-Shell')) {
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
