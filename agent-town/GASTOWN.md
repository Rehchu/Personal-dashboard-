# Dyer Town × Gas Town

Your pixel town can render a **real** [Gas Town](https://github.com/steveyegge/gastown)
workspace. Gas Town (MIT © Steve Yegge) is a serious multi-agent orchestration
engine — a **Mayor** coordinates **Rigs** (each a git repo) worked by **Polecats**
and **Crew**, with a **Witness** and **Refinery** keeping order and a **Beads**
ledger tracking every work item. `gastown-bridge.mjs` reads that live state
(`gt status --json`) and pushes it to your dashboard in the exact shape the Dyer
Town tile paints. So the town you already watch becomes a live cockpit over your
actual Gas Town:

- the **Mayor's HQ** → the pixel **office** (`plaza`),
- each **rig** → a building on the map (labelled with the rig's name),
- every **agent** → a villager standing at the rig they're working, with a work
  bubble when they're on a task,
- each rig's **merge queue** and the **ready work** → the live feed and job board.

The bridge never touches models or your Claude subscription — it only shells out
to the `gt` CLI and POSTs JSON. It doesn't copy any Gas Town code; it drives the
CLI you install.

---

## What you need

Gas Town itself, running on the machine:

- Install it: macOS `brew install gastown` (bundles `gt` + `bd` + `dolt`); Linux
  `go install github.com/steveyegge/gastown/cmd/gt@latest` **and**
  `github.com/steveyegge/beads/cmd/bd@latest`, plus **Dolt** and **tmux 3.0+**.
- Start a town: `gt init` then `gt up` (brings up the daemon, Dolt, and the Mayor).
- Add a rig and put an agent on some work: `gt rig add <name> <repo-url>` then
  `gt sling <bead-id> <name>`.
- Confirm it's alive: `gt status` should list your rigs and agents.

> **Windows note.** Gas Town leans on tmux and a Unix shell, so on your desktop
> run it inside **WSL2** (Ubuntu). Install `gt`/`bd`/`dolt`/`tmux` in WSL, run
> `gt up` there, and run the bridge **in the same WSL shell** (Node in WSL). The
> dashboard is reached over the internet, so nothing else changes.

## Run the bridge

From this folder, once a Gas Town town is up:

```bash
DASH_URL=https://lifehq.dyer-hq.workers.dev TOWN_KEY=<your dashboard passphrase> \
  node gastown-bridge.mjs
# or, with the passphrase already in the environment:  npm run gastown
```

Open your dashboard's **Dyer Town** tile — it flips to online and shows your real
Gas Town: the Mayor at HQ, polecats at their rigs, work bubbles, the feed.

**One town at a time.** The simulated `town.mjs` and this bridge both push to the
same tile, so run **one or the other** — stop the pixel-village town before you
start the Gas Town bridge (and vice-versa).

## Knobs (all optional)

| Env | Default | What |
| --- | --- | --- |
| `TOWN_KEY` | — (required) | your dashboard sign-in passphrase |
| `DASH_URL` | `https://lifehq.dyer-hq.workers.dev` | where to push |
| `GT_BIN` | `gt` (on PATH) | path to the `gt` binary |
| `GT_POLL_SECONDS` | `5` (min 2) | how often to refresh |
| `TOWN_NAME` | the town's own name | override the HQ label |

## Good to know

- **Read-only for now.** The bridge visualizes Gas Town; it doesn't send commands
  back. Wiring the dashboard chat to `gt mail send` (so you can message an agent
  from the tile) is a clean next step if you want it — say the word.
- **Rigs beyond eight** reuse building sprites with a numeric suffix, so they
  still render; the label always shows the real rig name.
- If the tile stays offline: check `gt status` works in that shell, and that
  `TOWN_KEY` matches your dashboard passphrase exactly.
