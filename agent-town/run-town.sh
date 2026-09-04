#!/usr/bin/env bash
# Dyer Town launcher for WSL / Linux / macOS — keeps the town running and
# restarts it whenever it stops: a crash, a reboot of the shell, or the town
# updating itself (it exits 0 on purpose after installing a new engine).
#
#   cd agent-town && ./run-town.sh              # in a tmux pane, or
#   nohup ./run-town.sh >> town.log 2>&1 &      # in the background
#
# The sync passphrase is read from town-key.txt next to this script (one line,
# nothing else). DASH_URL / TOWN_MODEL / TOWN_EFFORT / TOWN_PORT can be set in
# the environment before running; the defaults below match the Windows launcher.
cd "$(dirname "$0")" || exit 1

export DASH_URL="${DASH_URL:-https://lifehq.dyer-hq.workers.dev}"
# Leave TOWN_MODEL unset to use the claude CLI's own default model (robust — it
# always exists on your plan). Export a specific id to force one, e.g.
# TOWN_MODEL=claude-haiku-4-5-20251001 (cheapest) or a claude-opus-* (most capable).
export TOWN_MODEL="${TOWN_MODEL:-}"
export TOWN_EFFORT="${TOWN_EFFORT:-low}"
export TOWN_PORT="${TOWN_PORT:-8787}"
# Tells town.mjs a launcher will restart it, so it never forks a successor of
# its own after a self-update (that is only for towns started by hand).
export TOWN_LAUNCHER=1
# Auth: use whatever this shell already has — a `claude login` session OR an
# ANTHROPIC_API_KEY, whichever is present. (An earlier version always cleared
# the key to force subscription-only; that broke shells that authenticate with
# a key, with "Claude Code process exited with code 1" on every call.) To force
# subscription-only and hide any key, set TOWN_SUBSCRIPTION_ONLY=1 — but only if
# `claude login` is set up in THIS shell, or every model call will fail.
if [ -n "${TOWN_SUBSCRIPTION_ONLY:-}" ]; then
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
fi

if [ -z "${TOWN_KEY:-}" ] && [ -f town-key.txt ]; then
  TOWN_KEY="$(head -n1 town-key.txt | tr -d '\r\n')"
fi
export TOWN_KEY
if [ -z "$TOWN_KEY" ]; then
  echo "No passphrase found. Put your dashboard sign-in passphrase in town-key.txt"
  echo "(one line, nothing else) next to this script, then run it again."
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "node is not installed in this shell (try: sudo apt install nodejs, or nvm)."; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund

# The newest launcher wins: stop an older town still holding the port (one
# whose pane you closed), then take over.
if command -v fuser >/dev/null 2>&1 && fuser "$TOWN_PORT/tcp" >/dev/null 2>&1; then
  echo "  stopping the older town still on port $TOWN_PORT..."
  fuser -k "$TOWN_PORT/tcp" >/dev/null 2>&1
  sleep 3
fi

while true; do
  echo "[$(date '+%F %T')] starting Dyer Town..."
  node town.mjs
  code=$?
  if [ "$code" = "2" ]; then
    # the port is taken by something this launcher could not stop — stand
    # down rather than crash-loop against it
    echo "Another copy of Dyer Town is already running — this launcher stands down."
    exit 0
  fi
  echo "[$(date '+%F %T')] town stopped (exit $code) — restarting in 15s. Ctrl+C to stop."
  sleep 15
done
