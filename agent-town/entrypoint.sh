#!/bin/sh
# Boot the cloud village.
set -e

# --- money guard -------------------------------------------------------------
# The town runs on the Claude SUBSCRIPTION token only. Both of these, if set,
# take precedence over CLAUDE_CODE_OAUTH_TOKEN and would silently bill per token
# — so remove them before the town ever makes a call. A brake must fail safe.
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN

# --- persistent dirs on the mounted volume -----------------------------------
mkdir -p "${TOWN_DATA_DIR:-/data}" "${HOME:-/data/home}"

# --- git identity (needed even for the villagers' LOCAL commits) --------------
git config --global user.name  "Dyer Town"            >/dev/null 2>&1 || true
git config --global user.email "town@dyer-hq.local"   >/dev/null 2>&1 || true
git config --global init.defaultBranch main           >/dev/null 2>&1 || true

# --- optional: let villagers PUSH their work to GitHub ------------------------
# Set GITHUB_TOKEN (a fine-grained PAT limited to the town's repos, contents:write)
# to enable `git push`. Without it the town still runs — commits just stay local
# on the volume. town.mjs's own rules still cap them to town/<agent-id> branches.
if [ -n "${GITHUB_TOKEN}" ]; then
  git config --global credential.helper store >/dev/null 2>&1 || true
  printf 'https://x-access-token:%s@github.com\n' "${GITHUB_TOKEN}" > "${HOME}/.git-credentials"
  chmod 600 "${HOME}/.git-credentials" || true
fi

echo "Dyer Town booting — data in ${TOWN_DATA_DIR:-/data}, HOME ${HOME}"
exec node town.mjs
