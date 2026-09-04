#!/usr/bin/env bash
# One-time (WSL/Linux/macOS): put each villager's REAL GitHub repo into their
# workshop, so their deep-work sessions are real development sessions. The WSL
# twin of setup-repos.bat. Run it from inside the agent-town folder:
#
#   ./setup-repos.sh
#
# Auth: the repos are private, so git needs credentials in this shell. Easiest is
# the GitHub CLI — `gh auth login` once — or a git credential helper. If a clone
# asks for a username/password and fails, that's what to set up first.
cd "$(dirname "$0")" || exit 1

command -v git >/dev/null 2>&1 || { echo "git is not installed (try: sudo apt install git)."; exit 1; }
mkdir -p workshop

# agent-id  repo-name  (one per line; draco owns three)
give() {
  local id="$1" repo="$2"
  mkdir -p "workshop/$id"
  if [ -d "workshop/$id/$repo/.git" ]; then
    echo "  $id already has $repo — leaving it alone."
    return
  fi
  echo "  cloning $repo into $id's workshop..."
  if ! git clone "https://github.com/rehchu/$repo.git" "workshop/$id/$repo"; then
    echo "  (could not clone $repo — check the name, your internet, and that git is signed in to GitHub)"
  fi
}

give ctrl  ctrl-alt-pc-repair
give arise arisehub
give apex  apextraining
give draco dragons
give draco 3d-models
give draco dark-assassin
give spork super-spork
give meta  arise-youtube
give watch arise-youtube

echo
echo "Done. Each villager now has their repo(s) in workshop/<name>/."
echo "They work on their own town/<name> branch — never main — so everything"
echo "they do lands on GitHub as a reviewable draft for you."
