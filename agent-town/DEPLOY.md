# Run Dyer Town in the cloud (Fly.io)

This moves the whole village off your PC onto one tiny always-on machine. It
runs on **your Claude subscription** (no per-token billing) and keeps running
whether your PC is on or not.

**What it costs:** roughly **$5–7 / month** for the machine + a 5 GB volume.
No extra Claude cost — it uses your existing plan.

**One rule up front:** run **only one town at a time**. The cloud town and the
PC town both push to the same dashboard and both draw on the same Claude usage
limit — if both run, they fight over the state and double-spend your allowance.
So when the cloud town is up, **stop the PC town** (close `run-town.bat` /
Ctrl-C the window).

---

## Fast path (one command)

If you're on Windows, you can skip the manual steps below. From the `agent-town`
folder, after running `claude setup-token` once to get your token:

```
.\deploy.ps1
```

It installs the Fly CLI if needed, logs you in, creates the app + volume, asks
for your two secrets (typed hidden), and deploys. The manual steps below are the
same thing spelled out, for when you want to see or change each piece.

---

## 0. Install the Fly CLI (one time)

- Windows (PowerShell): `iwr https://fly.io/install.ps1 -useb | iex`
- macOS/Linux: `curl -L https://fly.io/install.sh | sh`

Then: `fly auth signup` (or `fly auth login`). Fly requires a card on file.

## 1. Get your Claude subscription token (one time, on your PC)

On the PC that's already logged in to Claude:

```
claude setup-token
```

It opens a browser, then prints a token. **Copy it.** It's good for **one
year**. (This is what lets the cloud town use your subscription instead of a
paid API key.)

## 2. Create the app + its volume

From the `agent-town` folder (the one with `Dockerfile` and `fly.toml`):

```
fly apps create dyer-town-YOURNAME          # pick a unique name
```

Open `fly.toml` and set `app = "dyer-town-YOURNAME"` and `primary_region` to the
Fly region nearest you (e.g. `iad`, `ord`, `lax` — see `fly platform regions`).

Create the persistent volume **in that same region**:

```
fly volumes create town_data --size 5 --region iad --app dyer-town-YOURNAME
```

## 3. Set the secrets

```
fly secrets set ^
  CLAUDE_CODE_OAUTH_TOKEN="paste-the-token-from-step-1" ^
  TOWN_KEY="your-dashboard-sync-passphrase" ^
  --app dyer-town-YOURNAME
```

(On macOS/Linux use `\` for line continuation instead of `^`.)

- `CLAUDE_CODE_OAUTH_TOKEN` — from step 1. **Do NOT set `ANTHROPIC_API_KEY`** —
  the entrypoint removes it anyway, so the town can never bill per token.
- `TOWN_KEY` — the same sync passphrase your dashboard uses (so the town can push
  its state and read your real-life briefs, exactly as on the PC).

**Optional secrets:**
- `CF_TOKEN` — your scoped Cloudflare deploy token, if you want villagers to keep
  shipping their apps. Same token as `cloudflare-token.txt` on the PC.
- `GITHUB_TOKEN` — a **fine-grained** GitHub PAT limited to the town's repos with
  **contents: write**, if you want villagers to `git push` their work. Without
  it the town still runs; commits just stay local on the volume.

```
fly secrets set CF_TOKEN="…" GITHUB_TOKEN="…" --app dyer-town-YOURNAME
```

## 4. Deploy

```
fly deploy --app dyer-town-YOURNAME
```

Watch it boot:

```
fly logs --app dyer-town-YOURNAME
```

You should see `Dyer Town booting …`. Within a tick or two, open your dashboard's
**Dyer Town** tile — it should show the town **online**. Stop the PC town now.

---

## Keeping it running

- **It restarts itself.** If the process crashes, Fly restarts the machine; the
  volume keeps the town's world, so it wakes up where it left off.
- **Watch it:** `fly logs`. **Restart by hand:** `fly apps restart dyer-town-YOURNAME`.
- **Pause it:** `fly scale count 0` (and `fly scale count 1` to bring it back).

## Renew the token once a year

The `setup-token` token lasts ~365 days and does **not** auto-refresh. Set a
calendar reminder. To renew: run `claude setup-token` again on your PC, then:

```
fly secrets set CLAUDE_CODE_OAUTH_TOKEN="new-token" --app dyer-town-YOURNAME
```

(Setting a secret redeploys automatically.) If the token ever lapses, the
dashboard banner will say the town hit its Claude access — the same message you'd
see on the PC.

## If deep-work sessions get killed (out of memory)

Bump the machine, or slow the town down:

```
fly scale memory 2048 --app dyer-town-YOURNAME     # 2 GB
# or, in fly.toml [env]: TOWN_BENCHES = "1"  then re-deploy
```

## The guardrails are unchanged

Same as on the PC: free-tier only, your production (the `lifehq` Worker, your D1
databases, R2) is sacred, villagers may only push to `town/<agent-id>` branches,
never `main`, never force-push, and anything that could cost money goes to
corporate as an approval request instead.
