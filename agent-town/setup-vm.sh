#!/usr/bin/env bash
# Set up Dyer Town on any always-on Ubuntu/Debian machine — for FREE 24/7 cloud:
#   • Oracle Cloud "Always Free"  (best: 4 ARM cores / 24 GB RAM, free forever)
#   • Google Cloud e2-micro free tier  (1 GB RAM — see the swap note in FREE-CLOUD.md)
#   • A spare PC / Raspberry Pi at home or the shop  (electricity only)
# Runs under systemd: 24/7, auto-restarts on crash or reboot, on your Claude
# subscription (no per-token cost).  Run it FROM INSIDE the agent-town folder.
set -euo pipefail

[ -f town.mjs ] || { echo "Run this from inside the agent-town folder (the one with town.mjs)."; exit 1; }
TOWN_DIR="$(pwd)"
RUN_USER="$(id -un)"
export DEBIAN_FRONTEND=noninteractive

echo "== Node.js 22, git, curl =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git ca-certificates curl

echo "== Claude CLI (the Agent SDK's runtime — needed on ARM boxes) =="
curl -fsSL https://code.claude.com/install.sh | sh || true

echo "== Town dependencies =="
npm install --omit=dev --no-audit --no-fund

echo
echo "== Secrets — typed hidden, stored root-only in /etc/dyer-town.env =="
read -rsp "CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token'): " CLAUDE_TOKEN; echo
read -rsp "TOWN_KEY (your dashboard passphrase): "                 TOWN_KEY;     echo
read -rsp "CF_TOKEN (optional Cloudflare deploy token; Enter to skip): " CF_TOKEN; echo
read -rsp "GITHUB_TOKEN (optional; lets villagers push their work; Enter to skip): " GH_TOKEN; echo
[ -n "$CLAUDE_TOKEN" ] && [ -n "$TOWN_KEY" ] || { echo "Both the Claude token and TOWN_KEY are required."; exit 1; }

{
  echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN"
  echo "TOWN_KEY=$TOWN_KEY"
  echo "DASH_URL=https://lifehq.dyer-hq.workers.dev"
  [ -n "$CF_TOKEN" ] && echo "CF_TOKEN=$CF_TOKEN"
  [ -n "$GH_TOKEN" ] && echo "GITHUB_TOKEN=$GH_TOKEN"
  echo "HOME=$HOME"
  echo "PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
} | sudo tee /etc/dyer-town.env >/dev/null
sudo chmod 600 /etc/dyer-town.env

# git identity (needed even for local commits) + optional push credentials
git config --global user.name  "Dyer Town"          2>/dev/null || true
git config --global user.email "town@dyer-hq.local" 2>/dev/null || true
if [ -n "$GH_TOKEN" ]; then
  git config --global credential.helper store
  printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
fi

echo "== systemd service (24/7, auto-restart) =="
sudo tee /etc/systemd/system/dyer-town.service >/dev/null <<EOF
[Unit]
Description=Dyer Town (autonomous agent village)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$TOWN_DIR
EnvironmentFile=/etc/dyer-town.env
# Subscription only: strip any stray API key so the town can never bill per-token.
UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
ExecStart=/usr/bin/node town.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now dyer-town

echo
echo "Dyer Town is now running 24/7 for free."
echo "  Watch it:  journalctl -u dyer-town -f"
echo "  Restart:   sudo systemctl restart dyer-town"
echo "  Stop:      sudo systemctl stop dyer-town"
echo "Open your dashboard's Dyer Town tile — then STOP the PC town so only one runs."
