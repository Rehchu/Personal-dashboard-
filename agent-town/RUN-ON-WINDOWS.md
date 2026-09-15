# Run Dyer Town on your always-on desktop

No cloud, no tokens, no monthly bill. Your PC is already on and already
`claude login`'d, so the town runs on your Claude **subscription** and pushes
its state to your dashboard — which is public, so you can still watch the town
from your phone anywhere. Only **one** town runs at a time, so if you ever start
a cloud one, stop this one first (and vice-versa).

Your folder: `D:\projects\Dashboard\agent-town`

---

## One-time setup (about 2 minutes)

1. **Drop in the latest `town.mjs`** (the one with the HQ office + houses
   day-cycle). Overwrite the old one in the folder.

2. **Set your passphrase.** In the folder, make a file called **`town-key.txt`**
   containing ONLY your dashboard sign-in passphrase — one line, no quotes, no
   spaces. (This is what lets the town push to your dashboard. A plain file
   avoids every quoting pitfall that causes "Bridge: dashboard 401".)

3. **Make sure Node is installed.** If `node -v` prints a version in a Command
   Prompt, you're set. If not, install it from https://nodejs.org (LTS), then
   open a **new** window.

4. **Double-click `install-windows.bat`.** It installs dependencies, adds a
   launcher to your Startup folder so the town starts every time you log in, and
   starts it right now. No administrator rights needed.

That's it. A minimized "Dyer Town" window appears and the town comes to life.

---

## Keep it truly always-on

- **Stop the PC from sleeping:** Settings → System → Power → **Screen and sleep**
  → set *"When plugged in, put my device to sleep after"* to **Never**. (Sleep is
  the one thing that pauses the town.)
- **Reboots:** the town auto-starts when you **log in**. If your PC reboots on its
  own, just log back in and it's running again. (It relies on your logged-in
  session because that's where your `claude login` lives — that's also why we
  don't run it as a background system service.)

## Watch it / run it / stop it

- **Watch from anywhere:** open your dashboard and click the **Dyer Town** tile.
  The tile flips to *online* within a minute of the town starting.
- **See it live on the PC:** the minimized "Dyer Town" window shows each tick.
- **Restart it now:** double-click `run-town.bat` (the newest launcher always wins
  — it stops any older copy still holding the port and takes over).
- **Stop it for good:** close the "Dyer Town" window, then delete `DyerTown.cmd`
  from your Startup folder (press **Win+R**, type `shell:startup`, Enter).

## If something looks off

- **Tile stays offline** → check `town-key.txt` holds the exact dashboard
  passphrase (one line, nothing else), then double-click `run-town.bat` again.
- **Window flashes and closes** → open Command Prompt, `cd /d D:\projects\Dashboard\agent-town`,
  run `node town.mjs`, and read the error. Usually it's Node not installed or a
  missing `town-key.txt`.
- **"Another copy is already running"** → that's the safety net; one town at a
  time. Wait ~15s and it sorts itself out, or reboot.

You never need `claude setup-token`, an API key, or a cloud account for this —
those were only for running it on a server. Here it just rides your subscription.

## Running it inside WSL instead

The town runs the same way inside WSL (Ubuntu on the desktop); only the
launcher differs. Everything below happens in the WSL shell, inside the
`agent-town` folder.

**Install or update — one paste:**

```
curl -fsSL -o town.mjs https://raw.githubusercontent.com/Rehchu/Personal-dashboard-/main/agent-town/town.mjs \
 && curl -fsSL -o run-town.sh https://raw.githubusercontent.com/Rehchu/Personal-dashboard-/main/agent-town/run-town.sh \
 && chmod +x run-town.sh && node --check town.mjs && echo "engine OK"
```

Then stop the old town (Ctrl+C in its pane, or `fuser -k 8787/tcp`) and start
the launcher:

```
./run-town.sh                        # in a tmux pane, or
nohup ./run-town.sh >> town.log 2>&1 &
```

- `town-key.txt` (your dashboard passphrase) and
  `MainCloudflare-deploy-token.txt` (the corporate deploy token) sit beside
  `town.mjs`, exactly as on Windows.
- `run-town.sh` restarts the town after a crash or a self-update. If you start
  the engine some other way (`npm start`, `node town.mjs`) it still updates
  itself: on Linux it starts its own successor before it exits, so nothing is
  lost — the launcher is just tidier.
- The Windows steps above (Startup folder, `run-town.bat`) don't apply in
  WSL. To survive a reboot, start it from a tmux session you re-attach to, or,
  if your WSL has systemd enabled, `./setup-vm.sh` installs it as a service.

## Pushing from anywhere

Every `/push` of a `town/<villager>` branch also moves a slash-free alias
(`town/draco` → `draco`) to the same commit. The dashboard's book tile reads
that alias through the jsDelivr mirror when GitHub's own hosts refuse it; a
branch name with a slash cannot be addressed there. Nobody works on the
alias, and it is force-updated on every push.

A villager's "I committed it" is only true on GitHub once the push goes
through — and a headless PC has no git credential, so every push fails until
it has one. Set it once, from the dashboard, by messaging any villager:

- `/token <your GitHub token>` — saves it to `github-token.txt` beside
  `town.mjs`; every villager's `git push` uses it from then on. Use a classic
  token with the `repo` scope (or a fine-grained one with Contents: read &
  write on their repos). `/token` alone says whether one is set; `/token clear`
  removes it. The token is never echoed back or written to the feed.
- `/git` — every villager's repos: the branch, how many commits are still
  unpushed, how many files are uncommitted, and the last local commit.
  `/git draco` for one villager.
- `/push` — pushes each villager's unpushed commits on their own `town/<id>`
  branch (never `main`, never forced). `/push draco` for one villager.

At the PC, `GITHUB_TOKEN` in the environment or the same file works too.

## Ctrl's key to the live shop

Ctrl can work the real technician portal at myfaithtech.com — tickets,
inquiries, invoices, email threads, the dashboard — with an API key you create
in **Settings → API Keys**. The key is shown once, so send it to the town the
same way you send a GitHub token, by messaging any villager:

- `/key <the cak_… key>` — saves it to `ctrl-portal-key.txt` beside `town.mjs`.
  `/key` alone says whether one is set; `/key clear` removes it from this PC
  (revoke it in Settings → API Keys as well, or it is still live elsewhere).
  The key is never echoed back and never written to the feed.
  `CTRL_ALT_API_KEY` in the environment works too, at the PC.

**Ctrl never holds the key.** It stays inside `town.mjs`. What he gets is a door:
the engine serves `http://127.0.0.1:8787/portal/...`, he calls it with an
ordinary URL and a one-boot ticket, and the engine attaches the real key and
forwards the request. So the key cannot be printed, copied into a file, committed
to a repo, or posted anywhere — it is never in his process to begin with. It also
means `/key clear` genuinely stops him, including mid-session.

**He reads and drafts on his own; he never sends on his own.** The portal itself
refuses a `tech` key the photo ID records, refunds, and making more keys. The
door adds the part the portal leaves open: anything that emails a real customer,
charges a card, buys a postage label, or changes a ticket status with a truthy
`notify` is refused unless you approved that exact call. Ctrl asks, the ask lands
in your approval inbox naming the path and what it would do in plain words
("PORTAL /invoices/42/email — would email an invoice, its PDF and a pay link"),
and your yes is good for that one call within 30 minutes. A second send needs a
second yes, and the chief of staff can never rule on one of these in your place.

The decision is made on the parsed request — the real method, the real path, the
real body — not on the text of whatever shell command produced it. That matters:
the first version of this read his commands, and `curl -d @body.json` (the flag
sits in a file), a helper script run as `node send.js`, `notify:1` instead of
`notify:true`, and a path that came out as `//email//send` all walked straight
past it. Those aren't attacks, they're Tuesday. The door sees the request itself,
so there is no spelling of a send that gets through it.

So the shape of his day is: triage the inbox, analyze inquiries, quote repairs,
update tickets, write the reply with `/inquiries/:id/draft-reply` — and leave it
sitting ready for you.

## It updates itself

`town.mjs` checks the repo (`agent-town/town.mjs` on `main`) every 10 minutes.
When a newer engine is published it validates it (`node --check`), swaps it in
with a `town.mjs.bak` beside it, saves the world, and restarts on the new code:
under `run-town.bat` or `run-town.sh` it exits and the launcher brings it back
15 seconds later; started by hand on Linux/WSL, it launches its own successor
first. You never need to be at the PC to ship a change.

- **Update right now:** in the dashboard, message any villager `/update`.
- **Turn it off:** set `TOWN_UPDATE_MIN=0` (or `TOWN_NO_UPDATE=1`).
- **Different source:** set `TOWN_UPDATE_URL` to any raw URL of a `town.mjs`.
- It never restarts in the middle of a villager's deep-work session, and never
  installs a file that fails the syntax check.
- **It rolls itself back.** If a new engine passes the syntax check but can't
  start, the boot guard notices after two failed starts, puts `town.mjs.bak`
  back, parks the bad file as `town.mjs.rejected`, and refuses to reinstall
  that exact file until a newer one is pushed. (`town.mjs.updated` is the
  marker it counts starts in — it disappears once the engine has been up a
  minute.) To roll back by hand, rename `town.mjs.bak` to `town.mjs` and
  restart.
