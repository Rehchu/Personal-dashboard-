#!/usr/bin/env bash
# Start the Gas Town → Dyer Town bridge from inside WSL.
#   bash /mnt/d/projects/Dashboard/agent-town/rungastownbridge.sh
#
# Reads your dashboard passphrase from town-key.txt (next to this script), and
# runs `gt` from INSIDE the town (~/gt) so it reliably finds it. The bridge has
# no npm deps — it only calls the `gt` CLI and pushes JSON to your dashboard.
#
# IMPORTANT: stop the Windows town.mjs first — one town at a time on the tile.

# Where this script (and town-key.txt + gastownbridge.mjs) live:
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/usr/local/go/bin:$HOME/go/bin:$HOME/.local/bin:$PATH"

# The town itself:
TOWN="${GT_TOWN_ROOT:-$HOME/gt}"
export GT_TOWN_ROOT="$TOWN"

if ! command -v gt >/dev/null 2>&1; then
  echo "gt is not on PATH. Run setupgastown.sh first, then 'exec bash'."; exit 1
fi

# Run everything with the town as the working dir so `gt` finds it by walking up.
cd "$TOWN" 2>/dev/null || { echo "Town folder not found at $TOWN — run 'gt install ~/gt --shell --git' first."; exit 1; }

# Soft check: gt status can exit non-zero just from beads warnings even when the
# town is fine, so only warn — never bail.
if ! gt status >/dev/null 2>&1; then
  echo "Note: 'gt status' returned a warning (probably the beads notices) — bridging anyway."
fi

KEY=""
[ -f "$SCRIPT_DIR/town-key.txt" ] && KEY="$(tr -d '\r\n' < "$SCRIPT_DIR/town-key.txt")"
if [ -z "$KEY" ]; then
  echo "Put your dashboard passphrase in town-key.txt (one line) in: $SCRIPT_DIR"; exit 1
fi

export DASH_URL="${DASH_URL:-https://lifehq.dyer-hq.workers.dev}"
export TOWN_KEY="$KEY"
echo "Bridging your Gas Town → $DASH_URL  (Ctrl-C to stop)"
exec node "$SCRIPT_DIR/gastownbridge.mjs"
