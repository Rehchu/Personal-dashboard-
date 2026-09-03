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

## It updates itself

`town.mjs` checks the repo (`agent-town/town.mjs` on `main`) every 10 minutes.
When a newer engine is published it validates it (`node --check`), swaps it in
with a `town.mjs.bak` beside it, saves the world, and exits — `run-town.bat`
restarts it 15 seconds later on the new code. You never need to be at the PC
to ship a change.

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
