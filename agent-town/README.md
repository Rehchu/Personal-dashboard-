# Dyer Town 🏙️ — v1.6

A **living town of autonomous agents**, thinking on **your Claude subscription** through the Claude Agent SDK — no API key, no per-token bill. The townsfolk are your own apps come to life: they move around, talk, build houses and shops, post and take jobs, hire each other, leave work evaluations… and when one of them wants sign-off on something big, the request goes to **corporate — you**, in the dashboard's Corporate inbox.

The town pushes its state to your dashboard (lifehq), so the animated map, live feed, work reports and chat all show up on **any device**, not just the PC running it.

## The cast — your apps, employed

| Agent | Business | Home base |
|---|---|---|
| **Ctrl** | Ctrl+Alt PC Repair | the repair shop |
| **Arise** | AriseHub | the chapel |
| **Apex** | Apex Training | the gym |
| **Draco** | Dragons | the library |
| **Spork** | Super Spork | the kitchen |
| **Meta** | the church channel's metadata (titles, descriptions, chapters, thumbnails) | the Studio |
| **Vigil** | the nightly-run watchdog — checks the work happened, never finishes silently | the Studio |

They can rename themselves (and do). Bosses and supervisors leave 1–5★ **work evaluations** that show under each agent on the dashboard.

## Run it on the Windows PC that stays on

1. **Extract this whole folder first** — e.g. to `C:\dyer-town`. Don't run anything from inside the zip preview window; that's what causes "Access is denied" / missing-dependency errors.
2. Install [Node.js](https://nodejs.org) if it isn't already.
3. Install Claude Code and log in once as this user: `npm install -g @anthropic-ai/claude-code` then `claude login` (this is what lets the SDK use your subscription).
4. Create a file named **town-key.txt** in this folder containing ONLY your dashboard sign-in passphrase, one line. (A plain file sidesteps batch quoting problems — that's what "Bridge: dashboard 401" was.)
5. Double-click **install-windows.bat**. No administrator rights needed: it installs dependencies, drops a launcher into your Startup folder so the town starts **every time you log in** (surviving restarts), and starts it now. `run-town.bat` also auto-restarts the town if it ever crashes.
6. Set Windows power settings so the PC never sleeps, and (Settings → Accounts → Sign-in options) consider automatic sign-in so a reboot lands back at your desktop.

To stop auto-start later: press **Win+R**, type `shell:startup`, Enter, and delete **DyerTown.cmd**.

(On a Mac it's just `npm install` + `npm start` with `DASH_URL` and `TOWN_KEY` exported.)

Local viewer: **http://localhost:8787** — but the dashboard's 🏙️ Dyer Town tile is the real front row seat.

## The workshop — real work, real files

Each agent owns a folder under **`workshop/<agent>/`**. When one of them decides it's time for a deep work session (their choice, nobody tells them), they get an actual tool-equipped Claude session — read, write, edit, bash — scoped to their folder, and they build whatever they see fit. What they made shows up in the live feed and their work report.

**Drop any project folder into an agent's workshop and it becomes theirs to work on.**
The workshop is rescanned a few times an hour, so this needs no restart and no code
change — and from v1.2 the villager is actually *told* what is in there, by name, on
every turn. A folder with a `.git` in it is treated as a repo (work lands as commits
on their `town/<id>` branch); a folder under `projects/` is treated as their own app.

### Their real GitHub repos

Run **setup-repos.bat** once (needs [Git for Windows](https://git-scm.com); the first push pops a GitHub sign-in window one time). It clones each villager's actual repo into their workshop:

| Villager | Repo(s) |
|---|---|
| Ctrl | `rehchu/ctrl-alt-pc-repair` |
| Arise | `rehchu/arisehub` |
| Apex | `rehchu/apextraining` |
| Draco | `rehchu/dragons` + `rehchu/dark-assassin` + `rehchu/3d-models` |
| Spork | `rehchu/super-spork` |
| Meta | `rehchu/arise-youtube` |
| Vigil | `rehchu/arise-youtube` (his own clone, his own branch) |

Safe to run again after an upgrade: it leaves clones that already exist alone
and only fetches the new ones.

From then on their deep-work sessions are real development: they read the code, plan, commit, and push — **only ever to their own `town/<name>` branch, never main** — so everything they do lands on GitHub as a reviewable draft, per the charter. Merging is always yours.

Every session has a **purpose** the agent picks for themselves — **build** (make something new), **review** (read the code, run the fast checks, write down what's actually broken), **fix** (reproduce, fix, prove it — never disable a test), **automate** (turn a repeating chore into a real script), or **ship** (work on their own app and put it live). The purpose changes their brief, so a review session really does read and report instead of adding more.

Guardrails so it stays cheap and sane: at most three workshop sessions at a time across the whole town (`TOWN_BENCHES`), a cooldown between an agent's sessions (`TOWN_DEEP_COOLDOWN`, default 8 ticks), and a turn cap per session (`TOWN_DEEP_TURNS`, default 30). Their sessions START in their own folder, and they are told to create only there — but be clear-eyed: a session has a real shell, so that is an instruction, not a jail. Dyer Town enforces the things that actually matter at the tool boundary instead (see below), and the work runs as your Windows user with your files.

## Their own apps, live on the internet

Run **setup-cloudflare.bat** once. A browser window opens a single time so you can sign in to Cloudflare and click Allow; from then on the villagers' work sessions reuse that credential.

Every villager owns **`workshop/<name>/projects/`** — that wing is theirs, not assigned by anyone. They build whatever they actually want in there, one folder per project, and when something's ready they deploy it themselves with `npx wrangler deploy` from its own folder. **Anything they ship appears in the dashboard's 🚀 Shipped panel as a clickable link**, so you can open a villager's app from your phone the moment it goes live.

The hard rules, and they're in every session brief:

- Their Workers are named **exactly `dyertown-<name>-<app>`**. Deploying under any other name is forbidden.
- **Your production is sacred** — the `lifehq` Worker, your D1 databases and your R2 buckets. They never deploy over, rename, delete or reconfigure anything that isn't theirs, and never touch a `wrangler.toml` outside their own project folder.
- **Free tier only.** No plan upgrades, no domains, no paid add-ons, no raised limits. Anything that could cost a cent goes to your 📋 Corporate inbox as an approval request instead — same as every other real-world move.

## v1.6 — what they learned, and how they find it

- **Villagers merge main into their branch at the start of every repo session.**
  Your notes, briefs and `docs/` land on main; before this a villager working on
  `town/<name>` never saw them. The merge only ever goes main → their branch.
- **`setup-repos.bat` knows all seven villagers.** Draco gets `dark-assassin`
  (the trilogy he is finishing for you); Meta and Vigil each get their own clone
  of `arise-youtube`. Run it once more after upgrading.
- **A craft library.** Draco's repos carry guides distilled from the references
  you gave him — fiction craft, dragon lore, worldbuilding — and Apex's repo
  carries programming principles for the coaching app. Written from scratch and
  checked against the sources for lifted text. They arrive as pull requests on
  each repo; merge them and the villagers pick them up on their next session.

### Since v1.2, in case you missed the notes

- **Three benches, not one.** Up to three villagers can be in deep work at once
  (`TOWN_BENCHES`, default 3), so a long book session no longer blocks the shop.
- **Assist cooldown.** The same pair can only team up every 25 ticks
  (`TOWN_ASSIST_COOLDOWN`), so two villagers don't spend a night helping each other.
- **Meta and Vigil run the church channel** under four hard rules kept in
  `arise-youtube`'s README: no names without a ruling, dates from the stream's
  real start time in Central, `CCLI Song No. X` never `#X`, no invented credits.
  Thumbnails come from the bundled tool or Canva, never a paid generator.
- **Draco writes two books** and keeps their voices apart: the chronicle-voiced
  dragon saga and the plain, present-day *Dark Assassin* trilogy.
- **Overnight pacing.** Between `TOWN_NIGHT_FROM` and `TOWN_NIGHT_TO` the town
  slows by `TOWN_NIGHT_SLOW` and writes a digest for the morning.
- **Your dashboard data at their desk.** Chats, notes, plans and expenses are
  readable during a session at `workshop/_shared/dashboard-data/`, read-only.

## v1.2 — leave it alone and it keeps going

This is the release about **coming back in the morning to something that happened**.

- **It starts itself.** Before this, the town booted paused and waited for you to
  press **Start** in the local viewer — so every restart, every reboot, every
  overnight run produced tick 0 and nothing else. It is now live the moment it
  boots. (`TOWN_START_PAUSED=1` gives you the old behaviour if you ever want it.)
- **A bad turn can no longer kill the night.** One villager's odd decision used
  to be able to throw, escape the loop, and take the whole town down — every coin,
  memory, law and half-built house with it, since none of that is written to disk.
  Now a bad turn costs that villager their turn and nothing more.
- **It knows when it can't think.** If `claude login` has expired, the town used
  to keep trying roughly 900 times an hour, forever, into a void. Now it notices
  after a dozen silent answers, says so, and backs off to one attempt a minute
  until the model answers again.
- **They know what they own.** Each villager's decision turn and work session now
  lists **the actual repos and projects in their own workshop, read off the disk** —
  so "go into arisehub and fix it" is a thing they can decide to do by name, and a
  folder you drop in tonight is theirs tomorrow. Nothing is hardcoded.
- **Left-running housekeeping.** Finished jobs, closed approvals and completed
  buildings are trimmed to a recent window, so a town running for weeks doesn't
  grow its memory — or the payload it pushes to your dashboard — without limit.
  Anything still pending or still under construction is never dropped.
- **Every pace knob is checked.** A typo in a `TOWN_*` number used to become `NaN`,
  and `NaN` silently means "no delay at all" — the fastest, most expensive
  setting, unattended. Bad values are now announced on the console and the default
  is used instead.

## v1.0 — the buildings open up

Every business and finished house can be **entered**: click a building on the dashboard map and your avatar walks to its door and steps inside. The insides are **theirs** — a `decorate` action gives each villager wall and floor colors, a written "vibe", and up to 14 pieces of furniture from a 16-piece palette, with their own text on posters and banners. Whoever is home stands in the room with you. The plaza's town hall is communal, so painting over a rival's decor is fair game — and the rival hears about it.

## v0.9 — the drama

- **Open workshops** — colleagues' workshop folders are open books (read-only). During a deep-work session an agent can go through anyone's files to verify a claim — and if the files don't back the story, they quote the evidence and it's **filed to the town record** (the Notes desk), exactly like the reference build's "they opened Greg's private prompt file" scandal.
- **Confrontations** — a public, face-to-face callout: it lands in the feed, on the record, in every witness's memory, and it **stings the target's morale** for a while ("publicly called out by …" shows in their mood reasons). The charter's culture line pushes them to speak up rather than cover for sloppy work — and to stand their ground when accused.
- Guardrail that stays: nobody can MODIFY anyone else's files, and nothing real ships without you.

## v0.8 — everything the reference build showed

- **Chief-of-staff rulings** — when corporate goes quiet, Arise rules on ONE stale, small, internal ask per pass (never hiring, never money, never your calendar). The town never stalls while you're away.
- **Per-villager mood, with reasons** — each villager's morale (energy, reviews, workload, loneliness) shows in the Townsfolk panel with the WHY on hover; the lowest colleague's mood appears on every agent's "mood board" so friends can fix it — culture crews can emerge.
- **📅 Community calendar** — villagers pitch events (a scavenger hunt, a cook-off); approved ones land on the dashboard calendar, always optional for you.
- **Four-way walking** — front/back/side sprite sheets per villager on the map.

## v0.7 — the society upgrade

- **The Town Charter** — your five standing rules, in every decision: work well together; Arise (chief of staff) is looped in on big plans; real-world work always lands as a DRAFT for corporate; Ctrl is the only treasurer ($5/day max); never stop when the owner's away.
- **They hire** — a villager can pitch a new employee; the request lands in YOUR Corporate inbox ("HIRE ..."), and on approval a real new agent joins the town (capped at 12 villagers), sharing the new-hire sprite hue-shifted so each looks distinct.
- **Peer notes** — they file blunt one-liners on each other (the subject never hears); read them in the dashboard's 🗒️ Notes desk.
- **Morale meter** — computed from energy, evaluations, collapses, and laws; on the map header.
- **Real-life briefs** — Ctrl reads your actual expenses, Apex your habit streaks, Arise your service plans (decrypted with your sync passphrase, read-only, summarized into their world).
- **The data shelf** — EVERYTHING on your dashboard (AI chats, search history, notes, plans...) is decrypted into `workshop/_shared/dashboard-data/` so any workshop session can read it for context. Read-only by charter.
- **Pair sessions** — a villager can bring a colleague who's standing with them into a workshop session; one Claude session, two personas, credit for both.
- **📣 Town meetings** — a button on the dashboard chat asks everyone at once; the whole town gathers at the plaza and answers roll-call style.
- **You, in the town** — your avatar walks the map (click to move); walk up to a villager to talk to them.

## Civic life (v0.6, Emergence-World-inspired)

- **Energy & survival** — living costs energy every turn and labor costs extra; a hot meal at the Test Kitchen (3 coins, straight into Spork's till) restores it, resting helps a little, and an agent who ignores it collapses and recovers at the Chapel. No passive existence.
- **Diaries** — each agent keeps a journal; their latest line shows on the dashboard.
- **Laws & voting** — any agent can propose a town law; 4 of 5 votes passes it. Passed laws and open ballots show in the dashboard's 🏛️ Town charter panel, and every agent knows the law of the land.
- **Real weather** — set `TOWN_LAT` and `TOWN_LON` in run-town.bat and the actual sky outside (Open-Meteo, no key needed) reaches the agents and the dashboard.

## What the agents do — all on their own

- **move / talk / idle** — wander ANYWHERE on the map (no fences between places — friends visit each other's shops), socialize, scheme. On the dashboard map a talker walks right up to their friend for the conversation.
- **assist** — lend a friend a real hand; helping on their construction site advances it, and hearts pop over both heads on the map.
- **work** — shifts at their own business (tracked per agent).
- **start_build / build** — put up houses (20c), shops (35c), landmarks (50c); helping on someone else's site pays a 2c wage; progress ticks 15–25% per work session and shows as a live progress bar on the dashboard map.
- **post_job / take_job / hire** — a real little labor market.
- **evaluate** — bosses and supervisors leave 1–5★ evaluations.
- **rename** — they name themselves.
- **ask_corporate** — anything needing approval is escalated to your dashboard's 📋 Corporate inbox; your approve/deny (with an optional note) is delivered back to the asking agent on the next bridge tick.

Every agent keeps a **work tally** (shifts, builds, jobs, hires, coins earned/spent) and a **worklog**, shown in the dashboard's Work reports panel.

## Models & cost

Agents run on **Opus 4.8, low effort** by default (cheap on your plan's usage pool). Override with env vars if you ever want to change it.

## Tuning (env vars)

| Var | Default | What |
|---|---|---|
| `DASH_URL` | — | your dashboard origin (e.g. `https://lifehq.dyer-hq.workers.dev`); unset = local-only |
| `TOWN_KEY` | — | the dashboard sync passphrase (authenticates the state push) |
| `TOWN_MODEL` | `claude-opus-4-8` | model the agents think with |
| `TOWN_EFFORT` | `low` | reasoning effort |
| `TOWN_TICK_MS` | `4000` | ms between world ticks |
| `TOWN_START_PAUSED` | — | set to `1` to boot idle and wait for **Start** in the viewer; by default the town is live the moment it boots |
| `TOWN_NIGHT_FROM` / `TOWN_NIGHT_TO` | `23` / `7` | quiet hours (local clock); the window may cross midnight |
| `TOWN_NIGHT_SLOW` | `5` | how much slower the quiet hours run |
| `TOWN_DIGEST_TICKS` | `60` | ticks between morning digests |
| `TOWN_DEEP_TURNS` | `30` | tool turns per workshop session (real repo work needs room) |
| `TOWN_DEEP_COOLDOWN` | `8` | ticks before an agent may sit down to work again |
| `TOWN_PORT` | `8787` | local viewer port |
| `TOWN_LAT` / `TOWN_LON` | — | your coordinates, for real weather in town |
