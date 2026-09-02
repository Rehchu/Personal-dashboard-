# Pixel Office — vendored pixel-agents webview

This is the ACTUAL pixel-agents web UI (github.com/pixel-agents-hq/pixel-agents,
MIT, © 2026 Pablo De Lucca — see LICENSE-pixel-agents.txt), built to a static SPA
and served here. Dyer Town embeds it in an iframe (public/js/town.js) and feeds it
the villagers as "agents" over window.postMessage, so the real office renders our
own town.

Minimal fork of upstream to make it embeddable + externally driven (built from
webview-ui with `vite build --base=/pixeloffice/`):
- src/main.tsx, src/App.tsx: run browserMock's asset/layout bootstrap in the
  production browser build, not only Vite dev.
- src/transport/index.ts: keep the window-message bridge in production, so the
  parent page can post agent messages into the office.
Everything else is upstream, unmodified.
