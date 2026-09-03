# Run Dyer Town in the cloud for $0

Fly.io (see DEPLOY.md) is one command but ~$5/mo. If you want **completely free**,
run the town on an always-free VM instead. The town itself doesn't change — you
just point `setup-vm.sh` at a free Linux box and it runs 24/7 under systemd.

Same rules as always: your **Claude subscription** powers it (no per-token cost),
it pushes state to your dashboard, and only one town runs at a time.

---

## Pick a free box

### 1. Oracle Cloud "Always Free"  ← best free option
A **permanently free** VM — not a 12-month trial. The Ampere ARM shape gives you
up to **4 cores / 24 GB RAM**, plenty for the town's deep-work sessions.

1. Sign up at **cloud.oracle.com** (a card is required for identity; Always Free
   resources are never charged).
2. Create a **Compute instance**:
   - Image: **Ubuntu 22.04** (or 24.04).
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM) — set **2 OCPU / 12 GB** (well
     within Always Free). If A1 says "out of capacity", try another
     Availability Domain/region, or use the always-free **VM.Standard.E2.1.Micro**
     (AMD, 1 GB — then read the swap note below).
   - Add your SSH key.
3. In the instance's **VCN security list**, nothing extra is needed — the town
   makes only outbound connections.
4. SSH in: `ssh ubuntu@<public-ip>`.

### 2. Google Cloud e2-micro (free tier)
Free forever in `us-west1` / `us-central1` / `us-east1`, but only **1 GB RAM** —
fine with the swap note below and `TOWN_BENCHES=1`.

### 3. A spare machine at home / the shop
An old PC or a Raspberry Pi (4/5) that stays on is the simplest $0 option — same
script, no cloud account. (If you later want to reach its local page from outside,
a free Cloudflare Tunnel does it — but you don't need to: the town pushes to your
dashboard, which is already public.)

---

## Set it up (any of the above)

On the box (Ubuntu/Debian), once you're SSH'd in:

```bash
# 1) get the town onto the box (scp the agent-town folder up, or git clone it)
cd agent-town

# 2) get a subscription token — run this on a machine logged in to Claude,
#    then paste the token when the script asks. (You can install the Claude CLI
#    on the VM and run `claude setup-token` there, or generate it on your PC.)
#    claude setup-token

# 3) one script does the rest: installs Node + git + the Claude CLI, sets up a
#    systemd service that runs 24/7 and restarts on crash/reboot.
bash setup-vm.sh
```

It asks for your **CLAUDE_CODE_OAUTH_TOKEN** and **TOWN_KEY** (your dashboard
passphrase), plus optional `CF_TOKEN` / `GITHUB_TOKEN`. Then:

```bash
journalctl -u dyer-town -f          # watch it boot ("Dyer Town booting…")
```

Open your dashboard's **Dyer Town** tile — it flips to online. **Stop the PC town.**

---

## Low-RAM boxes (1 GB: GCP e2-micro, Oracle E2 Micro, Pi 3)

Give it a swap cushion and fewer concurrent deep sessions:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
Then add `TOWN_BENCHES=1` to `/etc/dyer-town.env` and `sudo systemctl restart dyer-town`.

## Housekeeping

- **Timezone:** the workday is 8–18 by the box's clock (cloud VMs default to UTC).
  Add `TOWN_WORK_FROM` / `TOWN_WORK_TO` (in the box's time) to `/etc/dyer-town.env`.
- **Update the token yearly:** re-run `claude setup-token`, edit the value in
  `/etc/dyer-town.env`, then `sudo systemctl restart dyer-town`.
- **Update the town's code:** replace `town.mjs`, then `sudo systemctl restart dyer-town`.
- **Guardrails unchanged:** free-tier only, your production is sacred, villagers
  push only to `town/<agent-id>` branches, and the service strips any stray API
  key so it can only ever run on the subscription.
