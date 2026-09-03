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

## Post-build patch (assets/index-*.js)

Upstream's transport still *also* opens a WebSocket to `wss://<host>/ws` in
browser mode and drives the connection-status banner from it. There is no such
socket server behind the dashboard, so the office sat forever on "Reconnecting…"
even though our window-message bridge was already delivering the villagers. So
the built transport factory `C()` is patched directly in the bundle to skip the
socket entirely and return an always-"connected" transport that delivers `window`
`message` events (Dyer HQ's villager feed + browserMock's office assets) straight
to its handlers. If this SPA is ever rebuilt from source, make the same change in
src/transport/index.ts (return the postMessage transport in browser mode) instead
of re-patching the minified output.
