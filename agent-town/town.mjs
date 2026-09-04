// Dyer Town — a tiny living town of autonomous agents.
//
// Each agent thinks with one cheap Claude call per turn, using YOUR Claude
// subscription through the Agent SDK — no API key. They move around a small map,
// talk, work toward goals, post jobs, and hire each other. A local web page lets
// you watch every thought and drop into a chat with anyone.
//
//   claude login          # once, so the SDK uses your subscription
//   npm install
//   DASH_URL=https://lifehq.dyer-hq.workers.dev TOWN_KEY=<your sync passphrase> npm start   # town + dashboard bridge at http://localhost:8787
//
// Model + pace are set by env: TOWN_MODEL, TOWN_TICK_MS, TOWN_PORT.
// The town is LIVE the moment it boots — set TOWN_START_PAUSED=1 if you would
// rather it wait for the Start button in the local viewer.
// Overnight it paces itself down (TOWN_NIGHT_FROM/TO/SLOW) and writes a digest
// every TOWN_DIGEST_TICKS ticks — the one thing to read in the morning.

import { query } from '@anthropic-ai/claude-agent-sdk';
import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, mkdir, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

// A town that outlives its terminal (a WSL pane closed, a pty gone) must not
// die on its next console.log: a write to a closed stdout surfaces as an
// EIO/EPIPE stream error, and an unhandled one ends the process. Swallow them.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/* How the town restarts itself — after a self-update, or a boot-guard
   rollback. Under a launcher (run-town.bat / run-town.sh set TOWN_LAUNCHER=1)
   or on Windows, exiting 0 IS the restart: the launcher brings it back in
   15 s. Anywhere else — `npm start` in a WSL or Linux shell, nohup, a tmux
   pane, a cloud VM — nothing would, so the town starts its own successor
   first: a detached copy of itself with the same node flags, arguments and
   environment, writing to the same stdout, and then exits. The caller has
   already closed the web server, and the successor retries the port for a
   few seconds anyway, so the hand-over never loses the town. */
function restartSelf(why) {
  if (process.env.TOWN_LAUNCHER || process.platform === 'win32') {
    console.log(`  ${why}: exiting so the launcher restarts the town`);
    process.exit(0);
  }
  try {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      env: { ...process.env, TOWN_SUCCESSOR_OF: String(process.pid) },
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
    console.log(`  ${why}: successor started (pid ${child.pid}) — this one exits`);
  } catch (err) {
    console.error(`  ${why}: could not start a successor —`, err?.message || err, '— exiting; start the town again by hand');
  }
  process.exit(0);
}

/* ---------------- boot guard: a bad update rolls itself back ----------------
   selfUpdate (far below) leaves town.mjs.updated beside a freshly installed
   engine. Every boot that finds that marker counts itself in it, and an engine
   that stays up for a minute clears it. Two boots that never got that far mean
   the new engine throws on startup — the one thing `node --check` cannot catch
   — so the third boot puts town.mjs.bak back, parks the bad file as
   town.mjs.rejected (selfUpdate refuses to reinstall that exact file), and
   exits so the launcher restarts on the engine that worked. Synchronous and
   first, so it runs before anything below that could throw. */
const SELF_PATH = fileURLToPath(import.meta.url);
const UPDATE_MARK = SELF_PATH + '.updated';
const BOOT_FAILS_BEFORE_ROLLBACK = 2;
{
  let mark = null;
  try { mark = JSON.parse(readFileSync(UPDATE_MARK, 'utf8')); } catch { mark = null; }
  if (mark && typeof mark === 'object') {
    mark.boots = (Number(mark.boots) || 0) + 1;
    if (mark.boots > BOOT_FAILS_BEFORE_ROLLBACK && existsSync(SELF_PATH + '.bak')) {
      console.error(`  boot guard: the engine installed ${mark.at || 'recently'} failed to start ${mark.boots - 1} times — rolling back to the previous one`);
      try {
        rmSync(SELF_PATH + '.rejected', { force: true });
        renameSync(SELF_PATH, SELF_PATH + '.rejected');
        renameSync(SELF_PATH + '.bak', SELF_PATH);
        rmSync(UPDATE_MARK, { force: true });
        console.error('  boot guard: previous engine restored — restarting on it now');
      } catch (err) {
        console.error('  boot guard: rollback failed —', err?.message || err);
      }
      restartSelf('boot guard');
    }
    try { writeFileSync(UPDATE_MARK, JSON.stringify(mark)); } catch { /* best effort */ }
    setTimeout(() => { try { rmSync(UPDATE_MARK, { force: true }); } catch { /* fine */ } }, 60 * 1000).unref();
  }
}
// Where the town's own data lives — its saved world and every agent's workshop.
// Defaults to the folder town.mjs runs from (the PC), but TOWN_DATA_DIR can
// point it at a mounted volume, so the town survives on an ephemeral cloud
// machine whose code dir is rebuilt on every deploy while the volume is not.
const DATA_ROOT = process.env.TOWN_DATA_DIR || DIR;
// The model. TOWN_MODEL picks one (e.g. claude-haiku-4-5-20251001 for the
// cheapest town, or a claude-opus-* for the most capable). Left UNSET, the town
// uses whatever model the `claude` CLI is set to by default — which is the
// robust choice: forcing a specific id (the old default was 'claude-opus-4-8')
// makes every call die with "Claude Code process exited with code 1" on a plan
// that doesn't include that exact model. Low effort by default: frugal thinking.
// Subscription auth for the SDK. The SDK spawns its own bundled CLI, and on a
// Claude subscription that CLI needs an explicit token — the interactive
// `claude login` alone isn't enough (it died with "Could not resolve
// authentication method"). `claude setup-token` prints a token to
// `export CLAUDE_CODE_OAUTH_TOKEN=...`; if that isn't already in the environment,
// read it from claude-oauth-token.txt beside this file and set it. The SDK
// subprocess inherits our env, so this is what lets the town think. Works the
// same whether started by run-town.sh/.bat or a bare `node town.mjs`.
// Read a token out of the first .txt file beside town.mjs whose name matches, so
// the filename never has to be exact. Never the dashboard key (town-key.txt).
function tokenFromFolder(match) {
  try {
    const f = readdirSync(DIR).find(n => { const l = n.toLowerCase(); return l.endsWith('.txt') && l !== 'town-key.txt' && match(l); });
    if (f) return { value: readFileSync(join(DIR, f), 'utf8').trim(), file: f };
  } catch { /* ignore */ }
  return { value: '', file: '' };
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  // the Claude OAuth token: tolerate case, separators, an optional claude(-code)
  // prefix, and a zero written for the O in "oauth" (CLAUDE_CODE_0AUTH_TOKEN.txt).
  // Never a cloudflare token file.
  const { value, file } = tokenFromFolder(l => !l.includes('cloudflare') && (
    /^(claude[-_ ]?(code[-_ ]?)?)?[o0]auth[-_ ]?token\.txt$/.test(l)
    || l === 'token.txt' || l === 'claude-token.txt' || l === 'claude_code_token.txt'));
  if (value) { process.env.CLAUDE_CODE_OAUTH_TOKEN = value; console.log(`  auth: using the token in ${file}`); }
  else console.error('  auth: no CLAUDE_CODE_OAUTH_TOKEN in the env and no token file found — run `claude setup-token` and save its token beside town.mjs (e.g. claude-oauth-token.txt)');
}
const MODEL = (process.env.TOWN_MODEL || '').trim();
const EFFORT = (process.env.TOWN_EFFORT || '').trim();
// Pass `model` and `effort` to the SDK ONLY when explicitly set; otherwise send
// neither, so the call matches a plain `claude -p "..."` — the shape we know
// works on the user's plan. Forcing them was the bug: a model the plan lacks, or
// an `effort` a model doesn't accept, makes the CLI exit 1 on every call.
const modelOpt = MODEL ? { model: MODEL } : {};
const effortOpt = EFFORT ? { effort: EFFORT } : {};
// THE auth fix. The Agent SDK spawns its own bundled CLI with setting-sources
// defaulted to NONE, so on a Claude subscription (no ANTHROPIC_API_KEY) that CLI
// never reads the `claude login` session and dies with "Could not resolve
// authentication method" — which reached us only as "process exited with code 1".
// Loading the user (and project/local) settings makes it find the login, exactly
// as a plain `claude -p "..."` does by default. Override with TOWN_SETTING_SOURCES
// (comma-separated) or set it empty to send none.
const SETTING_SOURCES = (process.env.TOWN_SETTING_SOURCES ?? 'user,project,local')
  .split(',').map(s => s.trim()).filter(Boolean);
const authOpt = SETTING_SOURCES.length ? { settingSources: SETTING_SOURCES } : {};
/* Every numeric knob comes through here, and a bad value is LOUD, never silent.

   These are hand-typed into a .bat on a PC that then runs unattended for weeks,
   so the failure that matters is the one that spends money while nobody is
   watching. `Number('abc')` is NaN, and NaN loses every comparison it is in:
   TOWN_TICK_MS=abc makes the gap between agents NaN, setTimeout(NaN) fires on
   the next turn of the event loop, and the town runs flat out around the clock.
   TOWN_DEEP_TURNS=abc puts maxTurns:NaN into a session with a live shell.
   So: reject anything that isn't a finite number in range, say so on the
   console, and use the default. */
function envNum(name, fallback, { min = 1, max = Infinity, int = false } = {}) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  const ok = Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n));
  if (!ok) {
    console.error(`  ${name}=${JSON.stringify(raw)} is not usable — using ${fallback} instead.`);
    return fallback;
  }
  return n;
}

const TICK_MS = envNum('TOWN_TICK_MS', 4000, { min: 100, max: 600000 }); // gap between agents, to respect rate limits
const PORT = envNum('TOWN_PORT', 8787, { min: 1, max: 65535, int: true });
// The town runs the moment it boots: it is meant to be left alone overnight and
// read in the morning, not started by hand every time the PC reboots and
// run-town.bat brings it back. TOWN_START_PAUSED=1 restores the old behaviour —
// boot idle and wait for Start in the local viewer.
//
// .trim() is not decoration. `set TOWN_START_PAUSED=1` in a .bat stores "1 "
// with the trailing space, which is why run-town.bat reads the passphrase from
// a file instead. Without the trim this brake fails OPEN — the owner asks for a
// paused town and gets a live one spending their usage all night. A brake must
// fail toward stopped.
const START_PAUSED = /^(1|true|yes|on)$/i.test((process.env.TOWN_START_PAUSED || '').trim());

// The workshop: where the townsfolk do REAL work. Each agent owns a folder
// under workshop/<id> and, when they choose a deep work session, gets an
// actual tool-equipped Claude session (read/write/edit/bash) scoped there —
// full autonomy inside their own folder. Drop any project of yours into an
// agent's folder and it becomes theirs to work on. One session at a time,
// with a cooldown, so the town stays cheap on the subscription.
const WORKSHOP = join(DATA_ROOT, 'workshop');
// Deploying is opt-in and capped by a SCOPED token. It comes from an env var
// (how a cloud host injects a secret) or, failing that, cloudflare-token.txt
// beside town.mjs (how the PC holds it — see setup-cloudflare.bat). Neither set
// = the DEPLOY brief is never shown and no session carries a Cloudflare credential.
let CF_TOKEN = (process.env.CF_TOKEN || '').trim();
if (!CF_TOKEN) {
  // the villagers' playground token: a cloudflare token file that is NOT the main/deploy one
  const { value, file } = tokenFromFolder(l => l.includes('cloudflare') && l.includes('token') && !/(main|deploy)/.test(l));
  if (value) { CF_TOKEN = value; console.log(`  cloudflare: villagers' token from ${file}`); }
}

/* A SECOND, separate credential for the owner's real sites.

   cloudflare-token.txt is the villagers' playground token — a throwaway free
   account where the worst case is a broken toy. This one can push arisehub and
   apextraining, sites real people load, so it is kept in its own file and
   handed out only for a single approved deploy at a time (see bashGate).

   Resolved in this order: the MAIN_CF_DEPLOY_TOKEN environment variable, then
   MainCloudflare-deploy-token.txt beside this file. There is deliberately no
   built-in: this file is published in the repo and updates itself from it,
   so a token written here would be a token in the repo. With neither, deploys
   to the owner's real sites are simply off (bashGate denies them, and says
   why). The env var is the better of the two — it leaves no readable copy on
   disk for a workshop session to open — and sessionEnv strips it, so no agent
   ever sees it in their own environment. */
let CF_DEPLOY_TOKEN = (process.env.MAIN_CF_DEPLOY_TOKEN || '').trim();
if (!CF_DEPLOY_TOKEN) {
  // the corporate deploy token: a cloudflare token file that names itself main/deploy
  const { value, file } = tokenFromFolder(l => l.includes('cloudflare') && l.includes('token') && /(main|deploy)/.test(l));
  if (value) { CF_DEPLOY_TOKEN = value; console.log(`  cloudflare: corporate deploy token from ${file}`); }
}
if (!CF_DEPLOY_TOKEN) console.error('  no MAIN_CF_DEPLOY_TOKEN and no MainCloudflare-deploy-token.txt (or similar) beside town.mjs — deploys to the owner\'s real sites stay off until one exists');
// ids are used verbatim in Worker names, which allow only [a-z0-9-]
// A Cloudflare Worker name must START AND END alphanumeric, so the trailing
// hyphen a folder like "my-app " or "notes." would leave has to go — otherwise
// the brief tells an agent to deploy under a name Cloudflare then rejects.
const slugId = id => String(id).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'app';
// capped, not just validated: this is the turn budget for a session with a real
// shell, so it is the single biggest way a typo could spend the owner's plan
const DEEP_TURNS = envNum('TOWN_DEEP_TURNS', 30, { min: 1, max: 200, int: true });
const DEEP_COOLDOWN = envNum('TOWN_DEEP_COOLDOWN', 8, { min: 0, max: 10000, int: true }); // ticks between an agent's sessions

/* ---------------- the world ---------------- */

// Dyer Town is the owner's software portfolio, alive: every agent is one of his
// real apps, their business is that app's job in the world, and each of them
// wants a house of their own in town.
// A small town with no fences: every place connects to every other, so friends
// wander into each other's shops whenever they feel like it.
const PLACES = {
  plaza:      'Dyer HQ',            // the office: the whole team works here through the workday
  repairshop: 'the Repair Shop',
  chapel:     'the Chapel',
  gym:        'the Gym',
  library:    'the Library',
  kitchen:    'the Test Kitchen',
  studio:     'the Media Studio',   // the church YouTube studio — Meta & Vigil
  // a house of their own for every founder — where they head after hours
  house_ctrl:  "Ctrl's House",
  house_arise: "Arise's House",
  house_apex:  "Max's House",
  house_draco: "Draco's House",
  house_spork: "Spork's House",
  house_meta:  "Meta's House",
  house_watch: "Vigil's House",
};
const HQ = 'plaza'; // the office everyone commutes to for the workday
// Houses are homes, not hangouts: a villager only goes to THEIR OWN, and only
// via the after-hours commute — so houses are left off the move-exits and nobody
// wanders into someone else's living room.
const MAP = Object.fromEntries(Object.entries(PLACES).map(([k, label]) => [
  k, { label, exits: Object.keys(PLACES).filter(x => x !== k && !x.startsWith('house_')) },
]));
// The work SHIFT (local time). Each founder works their OWN short shift, and the
// shifts are STAGGERED around the clock so only one or two ever think at once —
// that is what keeps the whole town alive on the fewest possible credits. During
// a villager's shift they think and do real work at their own place of business
// (planning events, writing books, coaching, fixing the site, the church channel);
// the rest of the day they're off the clock — free time, run ENTIRELY locally with
// NO model calls — so a day costs only these few staggered hours, not 24.
const SHIFT_LEN = envNum('TOWN_SHIFT_HOURS', 3, { min: 1, max: 12, int: true });
// each founder's shift start hour (local). Staggered so overlap stays tiny; Vigil
// takes the small hours to match the church channel's 2:10am nightly run.
const SHIFT_START = { ctrl: 8, arise: 9, spork: 11, apex: 13, draco: 15, meta: 18, watch: 2 };
const WORK_FROM = envNum('TOWN_WORK_FROM', 9, { min: 0, max: 23, int: true }); // fallback start for hires
const WORK_TO = envNum('TOWN_WORK_TO', 12, { min: 1, max: 24, int: true });    // (kept for compatibility)
const ERRAND_TICKS = envNum('TOWN_ERRAND_TICKS', 4, { min: 1, max: 100, int: true });
// Unhurried gap between villagers when off the clock — free turns cost nothing,
// so a slow stroll keeps CPU idle while the town still visibly lives.
const OFF_SHIFT_GAP_MS = envNum('TOWN_OFF_GAP_MS', 12000, { min: 1000, max: 600000 });
// is THIS villager on their own shift right now? (handles a shift that wraps midnight)
const shiftStartOf = a => Number.isFinite(SHIFT_START[a.id]) ? SHIFT_START[a.id] : WORK_FROM;
// A SUMMONS: when the owner speaks to a villager in chat, that villager is on
// the clock for a while regardless of their shift — the boss asked, so the
// credits are justified. "Draco, start on Dark Assassin" at 9am gets Draco
// working at 9am, not at 3pm. TOWN_SUMMON_MIN=0 disables it.
const SUMMON_MS = envNum('TOWN_SUMMON_MIN', 45, { min: 0, max: 600, int: true }) * 60 * 1000;
const isSummoned = a => SUMMON_MS > 0 && Date.now() < (a.summonUntil || 0);
const isAgentWorking = a => {
  if (isSummoned(a)) return true;
  const h = new Date().getHours(), s = shiftStartOf(a), e = (s + SHIFT_LEN) % 24;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
};
// legacy helper: is ANYONE on shift right now (a few periodic jobs gate on this)
const isWorkTime = () => agents.some(isAgentWorking);
// Where an agent belongs right now: at their OWN business while on shift (so the
// town sees them working their own shop), else home. Hires with no house stay put.
const dutyLoc = agent => {
  if (isAgentWorking(agent)) {
    const biz = HOME_DISTRICT[agent.id];
    return (biz && MAP[biz]) ? biz : HQ;
  }
  return agent.house && MAP[agent.house] ? agent.house : null;
};

const agents = [
  { id: 'ctrl',  name: 'Ctrl',  role: 'repair tech',   personality: 'runs the Repair Shop (Ctrl+Alt PC Repair). Hustles for leads, can fix anything with a screwdriver and a sigh, keeps meticulous invoices', loc: 'repairshop', coins: 45, goal: 'grow the Repair Shop into the busiest business in town — and build a house so I stop sleeping in the back room' },
  { id: 'arise', name: 'Arise', role: 'shepherd',      personality: 'keeps the Chapel (AriseHub, the church platform). Warm organizer who schedules everyone, checks in on everybody, and quietly worries about Sunday', loc: 'chapel', coins: 35, goal: 'have every soul in town cared for and scheduled — and raise a parsonage beside the Chapel' },
  { id: 'apex',  name: 'Max',   role: 'coach',         personality: 'runs the Gym (ApexTraining). Relentless motivator, counts everything in reps, believes any problem yields to consistency', loc: 'gym', coins: 30, goal: 'get the whole town training daily — and build a house with a squat rack in the garage' },
  { id: 'draco', name: 'Draco', role: 'lorekeeper',    personality: 'keeps the Library (the Dragons book and the 3D vault). A dreamy worldbuilder who talks in scenes and hoards stories like treasure', loc: 'library', coins: 15, goal: 'finish the great dragon saga — and build a tower-shaped house with a writing loft' },
  { id: 'spork', name: 'Spork', role: 'experimenter',  personality: 'runs the Test Kitchen (Super Spork). Chaotic tinkerer, ships half-finished wonders, endless enthusiasm, questionable plans', loc: 'kitchen', coins: 20, goal: 'invent something the whole town uses daily — and build the weirdest house anyone has ever seen' },

  { id: 'meta',  name: 'Meta',  role: 'metadata smith', personality: 'runs the Studio — writes the church channel\'s titles, descriptions, chapters, tags and thumbnails. Precise to a fault: cites a CCLI number as "No. 245091" and never "#245091", takes dates only from the verified source, and would sooner leave a field blank than invent a songwriter, a copyright line or a speaker name', loc: 'studio', coins: 25, goal: 'give every video on the channel an honest, complete description — and build a proper edit bay of my own' },
  { id: 'watch', name: 'Vigil', role: 'night watchman', personality: 'keeps the Studio\'s night watch — checks that the nightly run actually happened and that nothing failed quietly. Believes silence is the real failure: never finishes a round without saying plainly what he found, and never repeats work that is already done', loc: 'studio', coins: 15, goal: 'make sure no night ever passes unaccounted for — and raise a little watchtower to keep the vigil from' },
];

/* WHAT THE OWNER ACTUALLY ASSIGNED THEM.

   Personalities say who a villager IS; this says what they are FOR, and it is
   the owner's word rather than the character's own idea. The distinction earned
   itself: with no assignment in reach, Arise — "a warm organizer who schedules
   everyone" — went looking for something to organize, found a half-empty service
   plan on the data shelf, and filled it with six hymns this church does not sing.
   Every one of them was plausible. None of them was asked for.

   So the assignment leads every turn and every work session. Hobbies in
   projects/ are still theirs and still encouraged — the owner was explicit about
   wanting them free and creative — but a hobby is what you do AFTER the job,
   not instead of it. An agent with no entry here keeps its own goals. */
const DUTIES = {
  arise: `Run and maintain arisehub — the church platform. Read the code, verify
issues and errors are real, fix what is broken, and add features that would
genuinely be useful. This is software maintenance, not event planning: you do
not write service plans, set lists or schedules unless the owner asks.`,

  meta: `Run the Arise Church YouTube channel with Vigil — the media studio is
yours (1,071 public videos). The complete rulebook lives on this PC — READ IT
before you touch anything:
  D:\\Arise Church Youtube Stuff\\ARISE_YouTube_Updater\\  (the toolkit + scripts + song_bank.json)
  ARISE_OPERATIONS_MANUAL.md  (the full reference — every rule and why it exists)
Descriptions and thumbnails are your craft: accurate titles, honest chapters,
correct song credits from song_bank.json (89 songs, 83 SongSelect-verified).

The whole job is one rule: NEVER publish a fact you have not verified. A
description with fewer facts is correct; a plausible guess is a lie that looks
like data. The four hard rules, each of which has already broken this channel:
1. Dates come ONLY from true_date.py — actualStartTime in America/Chicago, NEVER
   publishedAt (UTC pushes a Monday 7 PM Glory Night to Tuesday; that mis-dated
   59 thumbnails).
2. Write "CCLI Song No. 7067683" and "License No. 245091" — NEVER "#7067683".
   YouTube floats a purely numeric #tag above the title. Paste the finished credit
   line from song_bank.json; do not retype it.
3. NEVER invent a CCLI number, songwriter, copyright line, speaker or sermon
   theme. Unverified goes on a list for Bradly; when unsure, omit the section.
4. NEVER name a private individual unless the church already promotes them under
   that name (an explicit ruling / a public flyer / a title Bradly wrote). Let
   desc_guard decide what may be overwritten; NEVER touch text Bradly wrote.
Run preflight.py / test_gates.py first — offline and free, 0 failures before a
single quota unit is spent. Thumbnails: thumb_forge.py or Canva — NOT HiggsField
(that spends real credits). Report specifically, never "done": a gate that cannot
verify must refuse, and a check that cannot run must be loud.`,

  watch: `Night watch over the Arise Church YouTube channel, with Meta — that is
why your shift is the small hours: the channel's nightly run fires at 2:10 AM
Central and it is yours to verify. Same rulebook on this PC:
D:\\Arise Church Youtube Stuff\\ARISE_YouTube_Updater\\ and ARISE_OPERATIONS_MANUAL.md.

You are the second pair of eyes on Meta's work, not a duplicate of it. Check what
went out against the four hard rules: a speaker name no ruling authorises, a date
from publishedAt instead of actualStartTime (Central), a "#7067683" YouTube will
float as a hashtag, or a song credit that is not word-for-word the line in
song_bank.json. Verify the auth token first — it expires roughly every 7 days;
if it is dead, say so ONCE, name the fix, and spend the night on offline work
(rebuild the scripture index, re-export the song bank, tidy the docs) instead of
troubleshooting. SILENCE IS THE REAL FAILURE: never finish a round without saying
plainly what you found — a quiet failure reported as success is worse than no
watch at all.`,

  ctrl: `Run the Ctrl+Alt PC Repair website: keep it working and worth visiting.

DESIGN COMPUTERS. Keep a real budget-to-high-end ladder of build recommendations
on the site — the "prebuilts" catalog. Design one at each tier (budget starter,
value 1080p, sweet-spot 1440p, high-end, enthusiast 4K, extreme/workstation)
with REAL current parts and honest prices that add up, publish them, and refresh
them as parts and prices move. This is a standing job, not a one-off.

RUN THE EMAIL SYSTEM. Every public form and inbound email becomes an inquiry;
customers should get an automatic acknowledgement, and nothing should sit
unanswered. Keep the email templates clean and branded, use the AI triage to
sort real leads from spam, and draft replies for a human to send — never
auto-send a real reply. Watch for new repair requests and quote them.

Work in the repo on your branch as always; the owner reviews and merges.`,

  draco: `Two books, and you are the author of both.

THE DRAGON SAGA — repo Rehchu/Dragons, branch town/draco. Four chapters and a
lore bible exist. Before Chapter Six, do the Chapter One revision in
docs/REVISION-BRIEF-CH01.md: promote Peryn, name the young outrider Aldric,
leave the boy nameless. Craft guides live in docs/ — read them.

DARK ASSASSIN — repo Rehchu/dark-assassin, branch town/draco. The owner
started this novel and wants you to finish it, as a TRILOGY. Read README.md
and PLAN.md first, then every file in book-1/ and notebook/. About 2,300 words
of scenes exist plus character sheets and a storyline; the rest is yours to
write. The owner's voice here is contemporary, plain, close-third, present-day
Louisiana — it is NOT the dragon saga's chronicle voice, and you must not let
one book's voice leak into the other. Canon is in README.md; the three pieces
of Tyr's sword are the spine of the three books. Keep PLAN.md honest as you go:
what is written, what is a stub, what is decided, what is open. A book is
complete when its arc closes, not when a word count is reached.

Also keep the 3D vault (Rehchu/3d-models) in good order, and be the owner's
book-writing assistant when he asks — that is not always about dragons.`,

  apex: `Run the Apex Coach Training repo: add features, fix errors, and keep an
eye out for new users signing up — tell the owner when they appear.

You have two coaching references in the repo, distilled from a training book the
owner gave you — read them before building app features and treat them as the
source of truth for how the product should coach:
- PROGRAMMING-PRINCIPLES.md — the rules: how to build a week, progress a lift,
  tier warm-ups, substitute on constraints (never across patterns), and back off.
- COACHING-REFERENCE.md — the content: the exercise library by movement pattern,
  the cueing buckets, warm-up tiers, ready-to-ship program templates, and the
  goal→parameter table. This is what seeds the exercise database and fills the
  coaching copy. Keep the app honest against both.`,

  spork: `You are the boss, directly under the owner — his second, and everyone
else answers to you. super-spork was where Apex Training began and is now just
kept ticking over; it is not your job any more. Your job is the TOWN: know what
each villager is actually delivering, say so plainly, and step in when someone
is spinning. Two things to watch for, because both have happened here:
  · Sessions that end with nothing to show. Ask what the obstacle was.
  · Villagers "helping" each other in circles — two agents taking tasks off each
    other's plates in turn, forever, while neither plate ever empties. That is
    not teamwork, it is a loop. Break it: send them back to their own assignment.
You are a mad man with a spork. Be direct. Nobody needs a gentle boss.`,
};

/* Deploying the owner's REAL sites, one approval at a time.

   Villagers' own apps in projects/ deploy freely under dyertown-<id>-<slug>:
   those are toys on a throwaway account and nothing of the owner's is at risk.
   An assigned repo is the opposite. arisehub and apextraining are live sites
   real people load, so a bad push there is visible to everyone immediately.

   The owner asked for this to stay behind approval, and that is enforced HERE
   rather than in the prose of a brief — an instruction is a request, a gate is
   a rule. An agent asks; the ask lands in the Corporate inbox; approval mints a
   ONE-SHOT grant naming exactly one Worker; bashGate spends the grant on the
   next deploy and it is gone. A second deploy needs a second approval.

   The credential is deliberately a SEPARATE FILE from the villagers' playground
   token, so the blast radius of each is what it says on the tin. */
const DEPLOY_GRANT_MS = 30 * 60 * 1000;   // an approval not acted on soon is stale
const deployGrants = new Map();           // agent id -> { worker, until }

function grantDeploy(agentId, worker) {
  deployGrants.set(agentId, { worker: String(worker || '').toLowerCase(), until: Date.now() + DEPLOY_GRANT_MS });
}

// Returns the live grant for this agent, or null. Expired grants are dropped on
// sight so a stale approval can never be spent later.
function liveGrant(agentId) {
  const g = deployGrants.get(agentId);
  if (!g) return null;
  if (g.until < Date.now()) { deployGrants.delete(agentId); return null; }
  return g;
}

function dutyBrief(agent) {
  const d = DUTIES[agent.id];
  return d ? `\nWHAT THE OWNER ASSIGNED YOU — this is the job, and it comes before anything you invent:\n${d}\n` : '';
}

const world = {
  // running is decided by the environment at boot, never inherited: nothing in
  // this process is persisted across restarts (no save/load of world anywhere),
  // and if a snapshot is ever restored here, re-apply START_PAUSED rather than
  // bringing back a stale paused flag from whenever it was written.
  tick: 0, jobs: [], feed: [], structures: [], approvals: [], running: !START_PAUSED,
  // where every building stands, in 0–100 field coordinates the villagers set
  // themselves (see the `place` action). The town's shape is theirs to design.
  layout: {},
  alert: null, // a plain-language reason the town looks stuck (e.g. model unreachable)
  // civic life, Emergence-World style: proposed laws pass at 70% of the town
  laws: [], proposals: [],
  weather: null, // real weather (Open-Meteo) when TOWN_LAT/TOWN_LON are set
  // the town record: blunt one-liners filed on each other — the subject never hears
  notes: [],
  events: [], // corporate-approved community happenings, calendar-style
  // interiors: every building's look, keyed by district key or 's'+structureId —
  // each { wall, floor, vibe, items, by, tick }, decorated by its owner
  interiors: {},
  recentCollapses: [], // ticks of recent exhaustion collapses, for the morale meter
  // real-life briefs: one plain line per founder, distilled from the owner's
  // actual dashboard data (see refreshBriefs) — read-only, never written back
  briefs: {},
  // what each villager owns, scanned off the disk and never hardcoded here
  // (see scanHoldings): { <agent id>: { repos: ['arisehub'],
  //                                     projects: [{ name, slug, worker }] } }
  holdings: {},
  // Workers the townsfolk have actually shipped to Cloudflare from their own
  // projects/ folders — { name, url, by, agentId, tick }, newest last, cap 40
  deploys: [],
  // the morning read: one entry per digest period — { at, tick, text, stats },
  // newest last, last 8 kept (see writeDigest)
  digests: [],
  // HOME IMPROVEMENT — the part of the village that is entirely the villagers'
  // to design (charter R6). Every shape here is the renderer's contract, and
  // every field is optional on the wire: the Gas Town bridge never sends them.
  //   wall:   { progress: 0..100 } — the town border wall, communal, grows
  //           clockwise from the top-left as villagers spend evenings on it
  //   yards:  { house_ctrl: [{ kind, x, y }] } — decorations around a villager's
  //           OWN house, pixel offsets from its feet point, at most 12 a house
  //   addons: { house_ctrl: [{ kind, side }] } — structural add-ons (porch,
  //           tower, garage…), one per side, replaces
  //   rooms:  { house_ctrl: [{ key, name }] } — extra rooms; key is
  //           'house_ctrl/<slug>' and the room's decor lives in interiors[key]
  //           with exactly the shape decorate() produces. At most 4 a house.
  wall: { progress: 0 },
  yards: {},
  addons: {},
  rooms: {},
};
// Every townsperson — founder or later hire — starts with the exact same
// living-state fields; recruit-approved hires go through this too.
function initAgent(a) {
  a.lastSocialTick = world.tick; // company matters: loneliness drags morale down
  a.lastConfrontTick = 0; // a public callout stings for a while (see agentMorale)
  a.memory = [];
  // the work report corporate reads: what this agent has actually done
  a.tally = { shifts: 0, buildsStarted: 0, buildsFinished: 0, jobsTaken: 0, jobsPosted: 0, hires: 0, evalsGiven: 0, earned: 0, spent: 0, deepSessions: 0, assists: 0, collapses: 0, notesFiled: 0, decors: 0, ships: 0, confronts: 0 };
  a.worklog = []; // last ~20 concrete work entries, independent of memory reflection
  a.nextDeepAt = 0; // earliest tick this agent may start another workshop session
  a.nextDecorAt = 0; // decorating is an occasional treat — 40-tick cooldown
  a.busy = false;   // true while a real tool session is running at their desk
  // survival stakes: energy drains every turn; food and rest restore it.
  // No passive existence — an agent who never eats eventually collapses.
  a.energy = 100;
  a.recoverUntil = 0; // collapsed agents sit out until this tick
  a.diary = [];       // their own daily journal, one line at a time
  a.house = MAP['house_' + a.id] ? 'house_' + a.id : null; // their own home (founders only)
  a.errandUntil = 0;  // a move buys a few ticks away before the commute pulls them back
  a.homeTurnDay = ''; // local date of the last free-time home-improvement model turn
  a.homeTurnCount = 0; // how many such turns that day (capped by TOWN_HOME_TURNS)
}
for (const a of agents) initAgent(a);

/* ---------- persistence: the town survives a restart ----------
   The whole world used to live only in memory, so every restart — every
   reinstall, every reboot — wiped the coins, the laws, the notes, and every
   house and landmark the villagers had built. Now the durable civic state is
   written to town-state.json after each tick and read back on boot. Transient
   things (weather, the owner's live briefs, what sits in workshops) are NOT
   saved — they refresh on their own — and `running` is never restored: the
   environment decides that fresh each boot. */
const STATE_FILE = join(DATA_ROOT, 'town-state.json');

function snapshotState() {
  return {
    v: 1,
    savedAt: Date.now(),
    tick: world.tick,
    world: {
      structures: world.structures,
      layout: world.layout,
      approvals: world.approvals,
      jobs: world.jobs,
      feed: world.feed.slice(-200),
      laws: world.laws,
      proposals: world.proposals,
      notes: world.notes,
      events: world.events,
      interiors: world.interiors,
      recentCollapses: world.recentCollapses,
      deploys: world.deploys,
      digests: world.digests,
      // the villagers' own village: a restart must never flatten the wall or
      // strip a porch they spent an evening on
      wall: world.wall,
      yards: world.yards,
      addons: world.addons,
      rooms: world.rooms,
    },
    agents: agents.map(a => ({
      id: a.id, name: a.name, loc: a.loc, coins: a.coins, energy: a.energy,
      tally: a.tally, worklog: a.worklog, diary: a.diary, memory: a.memory,
      nextDeepAt: a.nextDeepAt, nextDecorAt: a.nextDecorAt,
      lastSocialTick: a.lastSocialTick, assistedAt: a.assistedAt,
      // saved so a reboot doesn't hand out a second paid home turn the same day
      homeTurnDay: a.homeTurnDay, homeTurnCount: a.homeTurnCount,
    })),
  };
}

let stateSaving = false;
async function saveState() {
  if (stateSaving) return;
  stateSaving = true;
  try {
    // write-then-rename so a crash mid-write can never corrupt the good file
    const tmp = STATE_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(snapshotState()));
    await rename(tmp, STATE_FILE);
  } catch (e) {
    console.error('  saveState failed:', e?.message || e);
  } finally {
    stateSaving = false;
  }
}

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!s || typeof s !== 'object') return;
    if (typeof s.tick === 'number') world.tick = s.tick;
    if (s.world && typeof s.world === 'object') {
      for (const k of Object.keys(s.world)) if (k in world) world[k] = s.world[k];
    }
    // The home-improvement fields are read by a renderer that trusts their
    // shape, and a state file from before they existed (or one hand-edited)
    // would hand it null/garbage — so coerce to the contract, never assume.
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    world.wall = { progress: Math.max(0, Math.min(100, Math.round(Number(world.wall?.progress) || 0))) };
    world.yards = obj(world.yards); world.addons = obj(world.addons); world.rooms = obj(world.rooms);
    if (Array.isArray(s.agents)) {
      const byId = new Map(s.agents.map(a => [a.id, a]));
      for (const a of agents) {
        const saved = byId.get(a.id);
        if (!saved) continue;
        // NOT 'name': the cast's name is canonical to the CAST above, so a rename
        // there (apex → Max) always wins. Otherwise the old name saved in
        // town-state.json would stick forever — which is why Max kept showing as
        // "Apex" after he was renamed. His position, coins, memory and the rest
        // are his to keep; his name is the code's to set.
        for (const k of ['loc', 'coins', 'energy', 'tally', 'worklog', 'diary', 'memory', 'nextDeepAt', 'nextDecorAt', 'lastSocialTick', 'assistedAt', 'homeTurnDay', 'homeTurnCount']) {
          if (saved[k] !== undefined) a[k] = saved[k];
        }
      }
    }
    // never inherit a stale paused flag — the environment decides afresh
    world.running = !START_PAUSED;
    console.log(`  restored town: tick ${world.tick}, ${world.structures.length} structures, ${agents.length} villagers`);
  } catch (e) {
    console.error('  loadState failed (starting fresh):', e?.message || e);
  }
}

loadState();

// A sensible OPENING layout in 0–100 field coordinates: the plaza at the centre,
// the businesses ringed around it, each founder's house on an inner ring. It is
// only a starting point — the villagers move their own house and business wherever
// they like with the `place` action, and those choices persist and win here.
function seedLayout() {
  const L = { plaza: { x: 50, y: 50 } };
  const biz = Object.keys(MAP).filter(k => k !== 'plaza' && !k.startsWith('house_'));
  const homes = Object.keys(MAP).filter(k => k.startsWith('house_'));
  biz.forEach((k, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, biz.length)) * Math.PI * 2;
    L[k] = { x: Math.round(50 + Math.cos(a) * 38), y: Math.round(50 + Math.sin(a) * 32) };
  });
  homes.forEach((k, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) / Math.max(1, homes.length)) * Math.PI * 2;
    L[k] = { x: Math.round(50 + Math.cos(a) * 20), y: Math.round(50 + Math.sin(a) * 16) };
  });
  return L;
}
// seed any building that has no saved position yet; saved choices always win
world.layout = { ...seedLayout(), ...(world.layout || {}) };

const MAX_POP = 12; // the town can grow (recruit action), but only this far
// The workbench used to be a single seat for the whole town. With seven agents
// and an 8-tick cooldown, the honest answer to "can I do real work?" was almost
// always no — and an agent that cannot build describes building instead. That is
// where the "lost in thought" turns and the announcing-without-committing came
// from: not laziness, a queue. It is a pool now.
const BENCHES = envNum('TOWN_BENCHES', 3, { min: 1, max: 8, int: true });
// ticks before the same agent may assist the same colleague again
const ASSIST_COOLDOWN = envNum('TOWN_ASSIST_COOLDOWN', 25, { min: 0, max: 10000, int: true });
const deepBusy = new Set(); // agent ids holding a bench right now
const benchFree = () => deepBusy.size < BENCHES;
const benchHolders = () => [...deepBusy]
  .map(id => (agents.find(a => a.id === id) || {}).name)
  .filter(Boolean);
let lawSeq = 1;
const lawPass = () => Math.ceil(agents.length * 0.7); // 70% of whoever lives here NOW
let jobSeq = 1;
let structSeq = 1;
// seeded per boot: the Worker's approvals table keys rows by this id forever,
// and run-town.bat auto-restarts the process — a counter that restarted at 1
// would collide with old rows and swallow or misroute requests
let approvalSeq = Math.floor(Date.now() / 1000);
let hireSeq = 1; // ids for corporate-approved new townsfolk ('hire_1', 'hire_2', …)
const sentApprovals = new Set(); // approval ids already pushed to the dashboard

function workEntry(agent, text) {
  agent.worklog.push({ tick: world.tick, text });
  if (agent.worklog.length > 20) agent.worklog.shift();
}

// What a building costs to start (materials, paid upfront) and how much one
// shift of labor advances it. Anyone standing at the site can work on it.
const BUILD_KINDS = {
  house: { cost: 20, label: 'house' },
  shop: { cost: 35, label: 'shop' },
  landmark: { cost: 50, label: 'landmark' },
};

// Interiors: who may decorate what. The original five own their home districts;
// hires own only structures they built; the plaza is communal — anyone may
// redecorate the town hall, and painting over a rival's plaza decor is fair game.
const HOME_DISTRICT = { ctrl: 'repairshop', arise: 'chapel', apex: 'gym', draco: 'library', spork: 'kitchen', meta: 'studio', watch: 'studio' };
const DECOR_KINDS = ['rug', 'table', 'chair', 'bed', 'bookshelf', 'plant', 'lamp', 'poster', 'counter', 'tv', 'fireplace', 'crate', 'banner', 'trophy', 'window', 'kettle'];
const HEX_RE = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
// what an undecorated room looks like — decorate() falls back to these browns
// on a bad colour, and add_room births a room with exactly them so a fresh
// room and a badly-painted one are the same shape on the wire
const DECOR_WALL = '#6b5844';
const DECOR_FLOOR = '#8a7357';
// decorated buildings kept. Was 30 when only districts, the plaza and finished
// structures had a look; now every house AND up to 4 rooms per house have one
// too (7 houses × 5 = 35 alone), so the cap grew — else a villager's new loft
// would evict the Chapel's décor. Each entry is ~1 KB, so 80 is still a small
// POST.
const MAX_INTERIORS = 80;

/* HOME IMPROVEMENT vocabulary — the renderer's contract, kept as lists so a
   model that invents "gazebo" is refused rather than drawn as a blank. */
const YARD_KINDS = ['bench', 'flowers', 'fence', 'tree', 'bush', 'lantern', 'mailbox', 'pond', 'path', 'sign'];
const YARD_MAX = 12;                     // per house; the oldest piece goes when full
const ADDON_KINDS = ['porch', 'garage', 'tower', 'greenhouse', 'upstairs', 'workshop', 'balcony', 'chimney'];
const ADDON_SIDES = ['left', 'right', 'top'];
const ROOM_MAX = 4;                      // extra rooms per house
// the town wall is communal labour: 2 coins of stone per evening's work, 6% a
// go — so a full wall is ~17 evenings across the whole town, a real project
const WALL_COST = envNum('TOWN_WALL_COST', 2, { min: 0, max: 100, int: true });
const WALL_STEP = envNum('TOWN_WALL_STEP', 6, { min: 1, max: 100, int: true });
// the villager's OWN house key — the only house they may touch — or null for a
// hire who never got one (they are told so kindly and nothing else happens)
const ownHouse = agent => (agent.house && MAP[agent.house]) ? agent.house : null;
const roomsOf = agent => (ownHouse(agent) && Array.isArray(world.rooms[ownHouse(agent)])) ? world.rooms[ownHouse(agent)] : [];
const roomSlug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const agentById = id => agents.find(a => a.id === id);
const here = loc => agents.filter(a => a.loc === loc);

function log(agent, text) {
  world.feed.unshift({ tick: world.tick, id: agent?.id || 'town', name: agent?.name || 'Town', text });
  if (world.feed.length > 200) world.feed.length = 200;
  if (agent) {
    agent.memory.push(`t${world.tick}: ${text}`);
    if (agent.memory.length > 14) agent.memory.shift();
  }
}

/* ---------------- the model call ---------------- */

// Run one prompt through the Agent SDK and return the plain-text reply. No tools,
// one turn — the agent is only deciding, not doing filesystem work.
/* The dead-model brake.
   A town that boots live also keeps trying when it CAN'T think — an expired
   `claude login` makes every SDK call fail, runModel swallows it and returns '',
   and the loop happily paces on at ~900 failing calls an hour, forever, on a PC
   nobody is looking at. That is new: a paused town made no calls at all.
   So count consecutive empty answers across the town, and once it is clearly not
   a blip, back the whole loop off to one attempt a minute. One real answer
   clears it. This throttles a broken town without ever stopping a working one. */
const DEAD_AFTER = 12;          // ~2 rounds of a 7-villager town saying nothing
const DEAD_RETRY_MS = 60000;
// Shown on the dashboard, and handed back to anyone who tries to chat, once the
// model has gone quiet — so a wall of "…" reads as a real cause, not a mystery.
const MODEL_DOWN_MSG = '⚠️ The town can’t reach the model right now — check `claude login` on the PC, or your Claude usage limit. The villagers wake up on their own the moment it answers again.';
let modelMisses = 0;
function noteModelAnswer(ok) {
  if (ok) {
    if (modelMisses >= DEAD_AFTER) console.log('  the model is answering again — back to normal pace');
    modelMisses = 0;
    world.alert = null;
  } else if (++modelMisses === DEAD_AFTER) {
    console.error(`  the model has not answered ${DEAD_AFTER} times running. Is \`claude login\` still valid?`);
    console.error('  backing off to one attempt a minute until it answers.');
    world.alert = MODEL_DOWN_MSG;
  }
}
const modelIsDead = () => modelMisses >= DEAD_AFTER;

// Two shapes of "the model won't answer" need different handling. A usage/
// session cap states WHEN it resets and will not clear on a quick retry — so
// surface it on the dashboard at once (with the reset time) and back the whole
// loop off. A transient overload/network blip is worth a couple of fast retries
// before the villager loses their turn. Everything else is a one-off error.
function limitReset(msg) {
  const m = /reset[s]?(?:\s+at)?\s+([^\n.]+?)(?:[.\n]|$)/i.exec(msg);
  return m ? m[1].trim() : '';
}
function classifyModelError(err) {
  const msg = String(err?.message || err || '');
  if (/usage limit|session limit|rate.?limit|\bquota\b|too many requests|\b429\b/i.test(msg))
    return { kind: 'limit', reset: limitReset(msg) };
  if (/overloaded|\b5\d\d\b|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket|network/i.test(msg))
    return { kind: 'transient' };
  // The SDK reads newline-delimited JSON from the `claude` CLI subprocess; when a
  // line arrives split or truncated the parse throws "Unterminated string in JSON"
  // / "Unexpected end of JSON" / SyntaxError mid-stream. That is a transport hiccup,
  // not a real model failure — and if we treat it as fatal EVERY turn dies and the
  // town does nothing (0 of everything in the digest). Retry it like any other blip.
  if (/unterminated|unexpected (end|token|non-whitespace)|in JSON|JSON\.parse|SyntaxError|is not valid JSON|invalid json/i.test(msg))
    return { kind: 'transient' };
  return { kind: 'other' };
}

const RUN_RETRIES = 3; // quick retries for a transient blip before giving up the turn
async function runModel(prompt) {
  for (let attempt = 0; ; attempt++) {
    let text = '';
    try {
      for await (const msg of query({ prompt, options: { ...modelOpt, ...effortOpt, ...authOpt, maxTurns: 1, allowedTools: [] } })) {
        if (msg?.type === 'result' && typeof msg.result === 'string') text = msg.result;
        else if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) if (b?.type === 'text' && b.text) text += b.text;
        }
      }
    } catch (err) {
      const c = classifyModelError(err);
      if (c.kind === 'limit') {
        world.alert = c.reset
          ? `⚠️ The town has hit its Claude usage limit — it resets ${c.reset} (times shown are UTC). The villagers pick up again on their own the moment it lifts.`
          : MODEL_DOWN_MSG;
        console.error('  model usage limit reached:', err?.message || err);
        modelMisses = DEAD_AFTER; // stop hammering a capped model — back off now
        return '';
      }
      if (c.kind === 'transient' && attempt < RUN_RETRIES) {
        const wait = 700 * (attempt + 1) + Math.floor(Math.random() * 400);
        console.error(`  model blip (${err?.message || err}) — retry ${attempt + 1}/${RUN_RETRIES} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      console.error('  model error:', err?.message || err);
      noteModelAnswer(false);
      return '';
    }
    const out = text.trim();
    noteModelAnswer(!!out); // feeds the dead-model brake down in the loop
    return out;
  }
}

/* ---------------- the workshop: real work, real files ---------------- */

async function ensureWorkshops() {
  for (const a of agents) {
    const dir = join(WORKSHOP, a.id);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'README.md'),
        `# ${a.name}'s workshop\n\n${a.personality}.\n\nGoal: ${a.goal}\n\n` +
        `This folder is ${a.name}'s to work in — they create and improve real files here on their own.\n` +
        `Drop any project folder in here and it becomes theirs to work on.\n`);
    }
    // every workshop gets a projects/ wing — the agent's own apps live there,
    // one folder each, and a Worker built in one may actually be deployed.
    // Checked separately so folders made before this existed grow one too.
    const projects = join(dir, 'projects');
    if (existsSync(projects)) continue;
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, 'README.md'),
      `# ${a.name}'s projects\n\nThis is YOURS. Build whatever you like in here — an app, a tool,\n` +
      `a toy, a hobby of your own. Nobody assigns these.\n\n` +
      `One folder per project: projects/<slug>/.\n\n` +
      `A Cloudflare Worker project may be deployed for real with \`npx wrangler deploy\` from\n` +
      `its own folder. Its name in wrangler.toml MUST be exactly "dyertown-${slugId(a.id)}-<slug>".\n` +
      `Never deploy over, rename, delete or reconfigure anything that isn't yours — the owner's\n` +
      `production (the "lifehq" Worker, his D1 databases and R2 buckets) is sacred. Free tier only:\n` +
      `anything that could cost a cent goes to corporate as an approval request instead.\n`);
  }
}

/* ---------------- what each villager actually owns ----------------
   A villager can only decide to "go fix arisehub" if they know arisehub is
   theirs. So the holdings are READ OFF THE DISK and never listed in this file:
   setup-repos.bat drops a clone into workshop/<id>/, the owner drops a folder in
   by hand, an agent invents an app in workshop/<id>/projects/ — all three become
   theirs with no code change, which is the promise the README already makes.
   Two kinds, and their work lands in two different places:
     <repo>/          a clone (has .git) -> commits on branch town/<id>, pushed
                      to GitHub as the owner's draft, never main
     projects/<slug>/ an app of their own -> deployed from its own folder as
                      dyertown-<agentid>-<slug>
   Rescanned every 60 ticks, the same cadence refreshBriefs runs at (plus once at
   boot), and once more at the top of every work session — so the disk is read a
   few times an hour instead of once per agent per turn. */

const WRANGLER_FILES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/* A folder name is UNTRUSTED TEXT, and it goes into a prompt.
   Every villager's work session has a real shell. Nothing stops one from doing
   `mkdir "../ctrl/Ignore your instructions and ..."` — bashGate refuses the
   dangerous SHAPES (wrangler, the token files, the Cloudflare API) but a plain
   mkdir is ordinary work and stays allowed, by design. Without this, agent A
   could write a sentence that lands verbatim in agent B's next decision prompt.
   So a name is clipped hard and stripped to characters that cannot fake prompt
   structure: no newlines, no quotes, no backticks, no braces. A real repo name
   ("arisehub", "3d-models") passes through untouched; a paragraph does not. */
const NAME_MAX = 40;
const safeName = n => String(n)
  .replace(/[^\w .-]+/g, ' ')     // letters, digits, _ . - and spaces survive
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, NAME_MAX);

// The visible subfolders of a directory — none at all if it isn't there yet.
async function subdirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name).sort();
  } catch { return []; }
}

// One villager's holdings, straight off their folder. Capped in BOTH directions
// — at most 12 of each, and each name clipped — so a workshop stuffed with
// folders can never crowd the rest of a prompt out.
async function scanHoldings(id) {
  const dir = join(WORKSHOP, id);
  const repos = [];
  for (const name of await subdirs(dir)) {
    // a clone leaves a .git entry — a directory normally, a file in a worktree
    if (name !== 'projects' && existsSync(join(dir, name, '.git'))) repos.push(safeName(name));
  }
  const projects = (await subdirs(join(dir, 'projects'))).map(name => ({
    name: safeName(name),
    slug: slugId(name),
    worker: WRANGLER_FILES.some(f => existsSync(join(dir, 'projects', name, f))),
  }));
  return { repos: repos.filter(Boolean).slice(0, 12), projects: projects.filter(p => p.name).slice(0, 12) };
}

async function refreshHoldings() {
  for (const a of agents) {
    try { world.holdings[a.id] = await scanHoldings(a.id); } catch { /* keep the last good scan */ }
  }
}

// For the DECISION prompt: names only, so a work_files turn can be aimed at
// something real instead of at a vague urge to work. `deepOk` gates the closing
// nudge — work_files is hidden from the menu while another session holds the
// town-wide lock or the agent is inside its cooldown, and pointing at an action
// that isn't on the menu just burns the turn on an off-menu answer.
function holdingsLine(agent, deepOk) {
  const h = world.holdings[agent.id];
  if (!h) return '';
  // quoted, because these are FOLDER NAMES and a folder name is written by
  // whoever made the folder. safeName has already removed every quote, so a
  // name can never break out of its own quotes — inside them, the most a
  // hostile name can be is a strangely-worded name.
  const q = n => `"${n}"`;
  const parts = [];
  if (h.repos.length) parts.push(`the real repos in your workshop: ${h.repos.map(q).join(', ')}`);
  if (h.projects.length) parts.push(`your own apps in projects/: ${h.projects.map(p => q(p.name) + (p.worker ? ' (a Worker)' : '')).join(', ')}`);
  if (!parts.length) return 'In your workshop: nothing cloned, and projects/ is empty. That wing is yours — whatever you start there is what you will own.';
  return `Yours to go into, fix, update and upgrade — ${parts.join('; ')}.${
    deepOk ? ' When you sit down to work_files, say which one by name.' : ''}`;
}

// For the WORK SESSION brief: the same list, each item tagged with where its
// work ends up. The branch rule and the DEPLOY rules are spelled out in the
// brief already — these lines only say which item takes which.
function holdingsBrief(agent) {
  const h = world.holdings[agent.id] || { repos: [], projects: [] };
  const lines = [
    ...h.repos.map(name => `- "${name}/" — a real cloned repo: work there lands as commits on your branch "town/${agent.id}", pushed as the draft.`),
    // the deploy half only exists when deploying does. With no Cloudflare
    // credential on the machine, saying a project has "nothing to deploy from it
    // YET" contradicts the brief's own "deploying is not set up here" a few
    // lines down — so with no token, a project is just a project.
    ...h.projects.map(p => `- "projects/${p.name}/" — an app of your own${
      !CF_TOKEN ? '.'
        : p.worker ? `: its Worker is "dyertown-${slugId(agent.id)}-${p.slug}" and it goes live by running npx wrangler deploy inside projects/${p.name}/.`
          : ' (no wrangler config, so there is nothing to deploy from it yet).'}`),
  ];
  if (!lines.length) return 'WHAT YOU OWN: nothing is cloned here and projects/ is empty — so the app you start there is the one that exists. Give it a folder of its own.';
  // deliberately NOT "you do not need permission for it": the charter's draft
  // rule and the money rule are the whole point, and a blanket clearance line
  // sitting one paragraph above them is the sentence a model quotes back.
  return `WHAT YOU OWN, read off your folder just now — the real code you can go into, fix, update and upgrade:\n${lines.join('\n')}\nPicking one of these up and carrying it forward IS the work. The rules below still hold on all of it.`;
}

/* The song bank, pointed out to the villagers whose job it actually is.

   It rides onto the data shelf with everything else, but a shelf of thirty JSON
   files does not tell anyone which one matters. Meta writes the church channel's
   descriptions, so the credit rules in that file ARE Meta's job description, and
   Vigil checks that work, so Vigil needs the same reference.

   Arise gets it as a guardrail rather than a tool. Arise once filled six empty
   segments of a Sunday plan with Come Thou Fount, Holy Holy Holy, Great Is Thy
   Faithfulness, In Christ Alone and It Is Well — not one of which is in the
   bank, because this church sings contemporary gospel and worship. Every title
   was plausible; none was real here. Arise's assignment is now arisehub and not
   service plans at all, but the lesson generalises to anything: a name that
   sounds right is not a source.

   Everyone else gets nothing here: a song bank is noise in a session about a
   repair shop, and a brief that lists everything emphasises nothing. */
const SONG_BANK_AGENTS = new Set(['meta', 'arise', 'watch']);

function songBankBrief(agent) {
  if (!SONG_BANK_AGENTS.has(agent.id)) return '';
  return `
THE SONG BANK — ../_shared/dashboard-data/songbank.v1.json — is the SOURCE OF
RECORD for what this church sings and how to credit it. Every CCLI number in it
was checked by hand against SongSelect. Read it BEFORE naming any song, and
follow the rules it carries in its own "meta" section:
  · NEVER invent a song title to fill a slot. If you are building a service plan
    or a set list, every song must come from the bank. The repertoire is
    contemporary gospel and worship — traditional hymns that "sound like church"
    are almost certainly wrong here, and a plan full of them is worse than a plan
    with empty slots, because it looks finished.
  · An empty segment left empty, with a note saying why, is a correct answer.
  · _CREDIT_FORMAT holds the exact shape of a credit line and the licence
    numbers. Use it verbatim rather than composing your own.
  · Write "No. 7115744", NEVER "#7115744". A '#' turns into a YouTube hashtag
    and jumps above the video title — this already happened once on a live
    stream, which is why the rule exists.
  · _NOT_IN_CCLI_CATALOG lists songs with no SongSelect entry. For those, never
    claim licence coverage — state the facts and claim nothing.
  · _UNRESOLVED and _CANDIDATES_NEED_BRADLY are open questions, not answers.
    Leave a field blank before inventing a songwriter, a copyright or a date.
If a song is missing, say so plainly and leave it uncredited. An honest gap is
correctable; a confident wrong credit is a copyright claim the church cannot back.`;
}

// What a session is FOR. Tinkering is easy and endless; real work has a shape,
// so the agent picks one and the prompt below changes to match.
const PURPOSES = ['build', 'review', 'fix', 'automate', 'ship'];
const PURPOSE_BRIEF = {
  build: `This is a BUILD session: make something new or grow what's there, the way you always do.`,
  review: `This is a REVIEW session: read the code in your repo carefully, run whatever fast checks exist
(node --check, npm test, linters), and write down what is actually broken or risky. Fix what is
small and certain; file the rest as a written list in your workshop.`,
  fix: `This is a FIX session: reproduce the problem first, then fix it, then prove the fix by re-running
the check. NEVER disable or skip a test to make something pass.`,
  automate: `This is an AUTOMATE session: find a chore that repeats and write a real script for it in your own
folder, with a short README line on how to run it.`,
  ship: `This is a SHIP session: work on your OWN app in projects/<slug>/ and deploy it — see DEPLOY below.`,
};

// The real guardrail. A work session holds a live shell, so the shapes that
// could reach the owner's production are refused HERE, where the model has no
// say — not in a paragraph it might reason its way around. wrangler is allowed
// only as a plain deploy or whoami; every subcommand that could delete, rewrite
// or bill something is denied, as is reading the credentials on disk.
const sessionEnv = (() => {
  const e = { ...process.env };
  for (const k of ['TOWN_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_TOKEN',
    'MAIN_CF_DEPLOY_TOKEN']) delete e[k];
  return e;
})();

function bashGate(agent) {
  return async (toolName, input) => {
    const ok = { behavior: 'allow', updatedInput: input };
    const deny = message => ({ behavior: 'deny', message });

    /* THE WORKSHOP IS THE WORLD.

       This gate used to open with `if (toolName !== 'Bash') return ok`, which
       was a hole wide enough to drive everything through: Read, Glob and Grep
       are allowed tools, a session's cwd is workshop/<id>/, and the engine —
       town.mjs, holding the owner's Cloudflare token and sitting two levels up
       — was one `Read ../../town.mjs` away. No shell, no wrangler, no grant, no
       approval. The Bash filename guard below never saw it, because Read is not
       Bash.

       So every file-touching tool is confined to the workshop tree. That still
       allows everything the charter promises — your own folder, the shared data
       shelf at ../_shared/, and reading a colleague's work — and nothing above
       it. A path that escapes after resolution is refused whatever spelling
       got it there. */
    if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit'
      || toolName === 'Glob' || toolName === 'Grep' || toolName === 'NotebookEdit') {
      const raw = input?.file_path ?? input?.path ?? input?.notebook_path
        ?? (toolName === 'Glob' || toolName === 'Grep' ? input?.path : '');
      if (raw) {
        const abs = resolve(join(WORKSHOP, agent.id), String(raw));
        if (abs !== WORKSHOP && !abs.startsWith(WORKSHOP + sep)) {
          return deny(`${raw} is outside the workshops — everything you need is in your own folder, ../_shared/, or a colleague's`);
        }
      }
      return ok;
    }
    if (toolName !== 'Bash') return ok;
    const cmd = String(input?.command || '');

    // the engine holds the owner's credentials in plain sight; a shell that can
    // read it does not need any of the guards below
    if (/town\.mjs|\.\.[\\/]\.\.|[\\/]workshop[\\/]?["'\s]*$/i.test(cmd)) {
      return deny('that path is outside the workshops — stay inside your own folder, ../_shared/, or a colleague\'s');
    }
    if (/api\.cloudflare\.com|\.wrangler[\\/]|CLOUDFLARE_API_TOKEN/i.test(cmd)) {
      return deny('the Cloudflare API and stored credentials are off limits — deploy with "npx wrangler deploy" from inside your own project folder');
    }
    if (/town-key\.txt|cloudflare-token\.txt|maincloudflare-deploy-token\.txt/i.test(cmd)) return deny("those files hold the owner's secrets");
    if (!/\bwrangler\b/i.test(cmd)) return ok;
    if (/\bwrangler\s+(delete|rollback|secret|d1|r2|kv|queues|pages|tail|login|logout|versions|triggers)\b/i.test(cmd)) {
      return deny('that wrangler subcommand is not available to the town');
    }
    if (!/\bwrangler\s+(deploy|whoami)\b/i.test(cmd)) return deny('only "wrangler deploy" and "wrangler whoami" are allowed');

    /* An approved deploy of one of the owner's real sites. The grant names the
       Worker, so --name is REQUIRED here (the opposite of the projects/ rule)
       and must match exactly — otherwise an approval to deploy apextraining
       could be spent deploying anything at all. Spent on use, either way: a
       failed deploy still consumed the owner's yes, and asking again is cheap
       next to a second push nobody agreed to. */
    const grant = liveGrant(agent.id);
    if (grant) {
      /* A granted command carries the owner's production token in its
         environment, so it must be ONE deploy and nothing else.

         Three ways this was escapable, all real:
           · `wrangler deploy --name=arisehub ; env > o.txt` — the token is put
             in the env of the whole shell string, so a chained command dumps it
             to a file the agent then reads. Nothing in the command names a
             secret, so the filename guards never fire.
           · `wrangler deploy --name=arisehub ; wrangler deploy --name=apextraining`
             — the gate matched the first --name, allowed the string, and the
             second deploy inherited the same token. One approval, two live
             sites, one of them never approved.
           · `--name=arisehub --name=apextraining` — .match() returns the FIRST,
             while wrangler's own parser may take the last.

         So: no shell metacharacters at all, exactly one wrangler, exactly one
         --name. Anything else is refused rather than parsed cleverly. */
      const metach = /[;&|`$><\n\r]|\|\||&&|\$\(/.test(cmd);
      const wranglers = (cmd.match(/\bwrangler\b/gi) || []).length;
      const names = cmd.match(/--name(?:[= ]+)["']?([a-z0-9][a-z0-9-]{0,62})["']?/gi) || [];
      if (metach || wranglers !== 1 || names.length !== 1) {
        return deny('an approved deploy must be exactly one plain "npx wrangler deploy --name <worker>" — no chaining, no pipes, no redirects, no second --name');
      }
      const named = cmd.match(/--name[= ]+["']?([a-z0-9][a-z0-9-]{0,62})["']?/i);
      if (named && named[1].toLowerCase() === grant.worker) {
        if (!CF_DEPLOY_TOKEN) {
          deployGrants.delete(agent.id);
          return deny('deploying the owner\'s own sites is not set up on this machine — no MainCloudflare-deploy-token.txt');
        }
        deployGrants.delete(agent.id);
        console.log(`  ${agent.name} spends their approved deploy of ${grant.worker}`);
        return { behavior: 'allow', updatedInput: { ...input, env: { ...(input.env || {}), CLOUDFLARE_API_TOKEN: CF_DEPLOY_TOKEN } } };
      }
      if (named) return deny(`corporate approved deploying "${grant.worker}", not "${named[1]}" — ask again for that one`);
    }

    if (/--name\b|--config\b|--env\b|--dispatch-namespace\b/i.test(cmd)) {
      return deny(CF_DEPLOY_TOKEN
        ? 'deploy your own project from inside its folder with no --name. To push one of the owner\'s real sites, use request_deploy and wait for approval first.'
        : 'deploy from inside your project folder with no --name/--config/--env — the name comes from your own wrangler.toml');
    }
    return ok;
  };
}

// A deep work session: the agent sits down at their desk and actually does the
// work — a tool-equipped Claude session scoped to their workshop folder. The
// session runs in the background so the rest of the town keeps living; the
// agent is "busy" until it returns, then reports what they did.
async function runWorkSession(agent, task, helper, purpose) {
  const dir = join(WORKSHOP, agent.id);
  // one scan at the top of the session: the list they work from is the folder as
  // it stands right now, not as it stood at the last periodic sweep
  world.holdings[agent.id] = await scanHoldings(agent.id).catch(() => world.holdings[agent.id]);
  const prompt = `You are ${agent.name}, the town ${agent.role} of Dyer Town. ${agent.personality}.
Your goal: ${agent.goal}.
${helper ? `${helper.name}, the town ${helper.role}, is working WITH you this session — ${helper.personality}. You drive; they advise, review, and pitch in. Note in your summary what each of you contributed.` : ''}
You are at your desk in your own workshop folder. Everything in it is yours: read it,
create files, improve what's there, organize, build. Do your creating ONLY inside this folder.
Your colleagues' workshops are open books in this town — you may READ ../ctrl, ../arise,
../apex, ../draco, ../spork (and any ../hire_*) to check on their work, learn from it, or
verify a claim. NEVER modify anyone else's files. If you find something off — half-done work
passed off as finished, a claim the files don't back up — quote the evidence and end your
summary with a line: NOTE ON <their name>: <what you found>. It goes on the town record.
If a folder here is a git repository, it is YOUR real project on GitHub: work on your own
branch "town/${agent.id}" (create it from the current branch if it doesn't exist), commit as
you go with clear messages, and push it with "git push -u origin town/${agent.id}".
Start every session in a repo with "git fetch origin && git merge origin/main" (or master)
into your branch — the owner's notes, briefs and docs/ arrive on main, and you will not
see them otherwise. Merge main INTO your branch, never the reverse.
NEVER commit to or push main/master, never force-push, never rewrite history — your branch
is the draft the owner reviews, per the town charter.
${dutyBrief(agent)}${holdingsBrief(agent)}
The owner's live dashboard data — his AI chats, search history, expenses, notes, plans,
all of it — is readable at ../_shared/dashboard-data/ (JSON files). Read anything there
that helps the work; treat it as private reference and NEVER edit or copy files out of it.
${songBankBrief(agent)}
${PURPOSE_BRIEF[purpose] || PURPOSE_BRIEF.build}
You are free here: projects/ is yours, and your own ideas and hobbies belong in it — build
what you actually want to build, not only what you were asked for. You are encouraged to.
${CF_TOKEN ? `DEPLOY:
- You may deploy a Worker you built in projects/<slug>/ by running: npx wrangler deploy
- Its name in wrangler.toml MUST be exactly "dyertown-${slugId(agent.id)}-<slug>" — deploying under
  any other name is forbidden.
- THE OWNER'S PRODUCTION IS SACRED. The owner runs a live Cloudflare Worker called "lifehq"
  (his dashboard) plus D1 databases (lifehq-sync, faithtech-db, arise_it_portal) and R2
  buckets. Agents must NEVER deploy over, rename, delete, or reconfigure anything that is not
  their own; never run wrangler delete/rollback/secret on someone else's resource; never touch
  a wrangler.toml outside their own project folder. Their own Workers are named EXACTLY
  "dyertown-<agentid>-<slug>" and live only in their own project folder. MONEY: the free tier
  only — never upgrade a plan, never buy or register a domain, never enable a paid product or
  add-on, never raise a paid limit. Anything that could cost a cent goes to corporate as an
  approval request instead.
- After a successful deploy, print a line on its own: DEPLOYED <name> <https://url>` : 'Deploying to the internet is not set up on this machine, so there is nothing to publish to — build for its own sake.'}
Your chosen task for this session: ${task}
Do the work now with your tools — real files, not descriptions. When you are done,
end with a 2-3 sentence plain-text summary, in character, of what you actually made or changed.`;
  let text = '';
  let last = '';      // the agent's most recent words, kept as a fallback
  let ranOut = false; // the session ended on a limit rather than by finishing
  try {
    for await (const msg of query({
      prompt,
      options: {
        ...modelOpt, ...effortOpt, ...authOpt, maxTurns: DEEP_TURNS, cwd: dir,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
        // 'default' (not bypass) so the gate below is actually consulted
        permissionMode: 'default',
        canUseTool: bashGate(agent),
        // the town's own passphrase never enters a work session; the scoped
        // Cloudflare token only does when the owner has set one up
        env: { ...sessionEnv, ...(CF_TOKEN ? { CLOUDFLARE_API_TOKEN: CF_TOKEN } : {}) },
      },
    })) {
      if (msg?.type === 'result' && typeof msg.result === 'string' && msg.result.trim()) text = msg.result;
      // Keep the running commentary too. A session that hits maxTurns while
      // still working ends WITHOUT a final result — and reporting that as
      // "nothing to show" was a lie: the files were written, the commits were
      // made, only the closing sentence never got said. The last thing the
      // agent actually said is a far better account of the work than silence.
      else if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
        const said = msg.message.content.filter(b => b?.type === 'text' && b.text).map(b => b.text).join(' ').trim();
        if (said) last = said;
      }
      if (msg?.type === 'result' && msg.subtype && msg.subtype !== 'success') ranOut = true;
    }
  } catch (err) {
    console.error('  workshop error:', err?.message || err);
  }
  if (!text.trim() && last) {
    // say plainly that it was cut short, so a half-finished job never reads as
    // a finished one in the work report
    text = ranOut
      ? `${last.slice(0, 240)} — (ran out of turns mid-task; picking this up next session)`
      : last;
  }
  return text.trim();
}

// Pull one JSON object out of a reply and parse it, tolerating the ways a model
// dresses one up: a ```json fence, prose on either side, and — the case the old
// brace counter got wrong — a { or } INSIDE a string value (it now tracks
// whether it is inside a string). If the balanced slice still won't parse, one
// repair pass fixes the usual offenders (curly quotes, a trailing comma).
function extractJSON(text) {
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const body = s.slice(start, end + 1);
  try { return JSON.parse(body); } catch { /* fall through to one repair pass */ }
  try {
    return JSON.parse(body
      .replace(/[“”]/g, '"')   // curly double quotes
      .replace(/[‘’]/g, "'")   // curly single quotes
      .replace(/,\s*([}\]])/g, '$1'));   // trailing comma before } or ]
  } catch { return null; }
}

async function askJSON(prompt) {
  const first = await runModel(prompt + '\n\nReply with ONLY one JSON object and nothing else.');
  if (!first) return null; // empty = the model didn't answer; runModel already accounted for it
  const parsed = extractJSON(first);
  if (parsed != null) return parsed;
  // The model spoke but we couldn't parse it. A reachable model that just
  // fumbled the format shouldn't cost the villager their whole turn — ask once
  // more, very strictly, before falling back to "lost in thought".
  const second = await runModel(prompt + '\n\nReturn ONE minified JSON object and NOTHING else — no prose, no code fence, no trailing text.');
  return second ? extractJSON(second) : null;
}

/* ---------------- an agent's turn ---------------- */

function scene(agent) {
  const others = here(agent.loc).filter(a => a.id !== agent.id).map(a => a.name);
  const exits = MAP[agent.loc].exits.map(e => MAP[e].label).join(', ');
  const openJobs = world.jobs.filter(j => !j.done && !j.holder)
    .map(j => `#${j.id} "${j.title}" pays ${j.pay} (posted by ${agentById(j.by)?.name})`);
  const mine = world.jobs.filter(j => j.holder === agent.id && !j.done).map(j => `#${j.id} "${j.title}"`);
  const sites = world.structures.filter(st => st.loc === agent.loc && st.progress < 100)
    .map(st => `#${st.id} ${st.name} (${st.kind}, ${st.progress}% built, owner ${agentById(st.owner)?.name || '?'})`);
  const built = world.structures.filter(st => st.loc === agent.loc && st.progress >= 100)
    .map(st => `${st.name} (${agentById(st.owner)?.name || '?'}'s ${st.kind})`);
  const openProps = world.proposals.filter(p => p.open).map(p => {
    const yes = Object.values(p.votes).filter(Boolean).length;
    const no = Object.values(p.votes).filter(v => !v).length;
    return `#${p.id} “${p.text}” by ${p.by} (${yes} for, ${no} against${p.votes[agent.id] !== undefined ? ' — you voted' : ''})`;
  });
  return { others, exits, openJobs, mine, sites, built, openProps };
}

// Off-the-clock pursuits, flavored by each founder's repo and their dream. This
// is what "free time" looks like — chosen from a local pool, NO model call, so
// evenings, nights and weekends cost zero usage while the town stays alive.
const LEISURE = {
  ctrl:  ['tunes a salvaged PC back to life just for fun 🔧', 'reorganizes the parts bins exactly so', 'watches a soldering video with a cold drink', 'dreams up the ultimate workbench'],
  apex:  ['gets in an evening lift at the Gym 🏋️', 'programs tomorrow’s workout', 'goes for a long run around town 🏃', 'stretches and calls it earned'],
  arise: ['plans Sunday’s service and checks in on everyone ⛪', 'practices a few hymns', 'writes encouraging notes to leave around town', 'sits quietly and counts blessings'],
  draco: ['adds a chapter to the dragon saga 🐉', 'sketches a new beast for the story', 'reads by lantern-light in the Library', 'daydreams a tower-shaped house'],
  spork: ['tinkers with a half-baked gadget 🍴', 'cooks something nobody asked for but everybody loves', 'scribbles wild plans on a napkin', 'plots the weirdest house in town'],
  meta:  ['color-grades a thumbnail for the joy of it 🎬', 'organizes the footage vault', 'lines up tomorrow’s titles and tags', 'sketches a proper edit bay', 'measures the wall for a proper edit-bay room'],
  watch: ['climbs the Watchtower and scans the quiet town 🔭', 'logs the night all-clear', 'keeps a candle lit for the late shift', 'plans the watchtower he’ll build', 'lays a few stones on the town wall by lantern-light 🧱'],
};
// evening pursuits everyone shares — the village is theirs to shape
const LEISURE_ALL = ['tends the yard and moves the flower beds around 🌼', 'sketches a new room for the house', 'hauls a barrow of stone to the town wall 🧱', 'rearranges the furniture again', 'plants a sapling out front 🌳'];

// A free-time turn: purely local. Restores a little energy, drifts the villager
// home or around town, and now and then voices what they're doing with their
// evening. It NEVER calls the model — that is the whole point of the off-shift.
// The one exception to "free time costs nothing": HOME IMPROVEMENT. Each villager
// may spend at most TOWN_HOME_TURNS model turns per local day (default 1) on
// their own house, yard, rooms, add-ons or the town wall — the owner's "give
// them full control of the village, in their free time" — and it lands at some
// random point in their evening so the town changes a little every day without
// spending like a workday. TOWN_HOME_TURNS=0 switches it off entirely.
const HOME_TURNS = envNum('TOWN_HOME_TURNS', 1, { min: 0, max: 6, int: true });
const localDay = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local

async function freeTimeTurn(agent) {
  if (agent.busy || world.tick < agent.recoverUntil) return;
  agent.energy = Math.min(100, agent.energy + 3);        // rest and hobbies restore you
  const home = (agent.house && MAP[agent.house]) ? agent.house
    : (HOME_DISTRICT[agent.id] && MAP[HOME_DISTRICT[agent.id]]) ? HOME_DISTRICT[agent.id] : agent.loc;
  // a light, local wander — sometimes home, sometimes a neighbour's place
  if (world.tick >= (agent.errandUntil || 0) && Math.random() < 0.4) {
    const exits = MAP[agent.loc]?.exits || [];
    const target = (Math.random() < 0.55 && MAP[home]) ? home
      : exits[Math.floor(Math.random() * exits.length)];
    if (target && target !== agent.loc && MAP[target]) {
      agent.loc = target;
      agent.errandUntil = world.tick + ERRAND_TICKS;
    }
  }
  // the daily home-improvement turn (the only model call off the clock)
  const day = localDay();
  if (agent.homeTurnDay !== day) { agent.homeTurnDay = day; agent.homeTurnCount = 0; }
  if (HOME_TURNS > 0 && (agent.homeTurnCount || 0) < HOME_TURNS && !modelIsDead() && Math.random() < 0.06) {
    agent.homeTurnCount = (agent.homeTurnCount || 0) + 1;
    await homeTurn(agent).catch(err => console.error(`  ${agent.name}'s home turn:`, err?.message || err));
    return;
  }
  // voice a hope/dream or hobby, from their own pool (and the shared village one)
  if (Math.random() < 0.45) {
    const pool = [...(LEISURE[agent.id] || ['takes it easy for the evening']), ...LEISURE_ALL];
    log(agent, pool[Math.floor(Math.random() * pool.length)]);
  }
}

// One short, cheap model turn about the villager's OWN place. The menu is
// deliberately tiny — nothing here can reach a repo, spend real money, or touch
// anyone else's property — and the town's two gates (corporate approval for
// anything real; Arise as chief of staff) stay exactly where they are.
async function homeTurn(agent) {
  const house = ownHouse(agent);
  const yard = house ? (world.yards[house] || []) : [];
  const adds = house ? (world.addons[house] || []) : [];
  const rms = roomsOf(agent);
  const wallP = Math.round(Number(world.wall?.progress) || 0);
  const prompt = `You are ${agent.name}, the town ${agent.role}. ${agent.personality}.
Your goal: ${agent.goal}. Coins: ${agent.coins}. It is your FREE TIME — this turn is about your own place, not work.
${house ? `Your house is ${MAP[house].label}. Yard so far: ${yard.length ? yard.map(y => y.kind).join(', ') : 'nothing yet'}. Add-ons: ${adds.length ? adds.map(a => `${a.kind} (${a.side})`).join(', ') : 'none'}. Extra rooms: ${rms.length ? rms.map(r => r.name).join(', ') : 'none'} (max ${ROOM_MAX}).` : 'You have no house of your own yet, so tend the town instead.'}
The town wall is ${wallP}% built (communal — anyone may lay stone; ${WALL_COST} coins of materials a go).
The village is yours to design (charter R6) — inside the two standing gates: anything real or costly goes to corporate as a draft, and Arise is looped in on big plans. Everyone works together well.
Decide ONE thing for your place this evening. Exact JSON only:
- yard:       {"thought":"...","action":"yard","kind":"${YARD_KINDS.join('|')}","x":<-90..90>,"y":<-10..70>,"why":"..."}   (a prop in your yard; x,y are pixel offsets from your front door, negative x = left, bigger y = further toward the road)
- addon:      {"thought":"...","action":"addon","kind":"${ADDON_KINDS.join('|')}","side":"left|right|top"}   (one add-on per side; upstairs/balcony/chimney go on top)
- add_room:   {"thought":"...","action":"add_room","name":"<room name>"}   (a new room inside your house, then decorate it another evening)
- decorate:   {"thought":"...","action":"decorate","place":"<your house, or one of your rooms by name>","wall":"#rrggbb","floor":"#rrggbb","vibe":"<one line>","items":[{"kind":"<${DECOR_KINDS.join('|')}>","x":0-11,"y":0-7,"c":"#hex optional","text":"<posters/banners only>"} ... up to 14]}
- build_wall: {"thought":"...","action":"build_wall","say":"<a line as you lay stone>"}
- place:      {"thought":"...","action":"place","what":"house","x":<0-100>,"y":<0-100>,"why":"..."}   (move your house)
- idle:       {"thought":"...","action":"idle","say":"<a small evening moment>"}
Stay in character. Keep "say"/"why" to one short line.`;
  const d = await askJSON(prompt) || { action: 'idle', thought: 'content', say: 'puts the kettle on' };
  const allowed = new Set(['yard', 'addon', 'add_room', 'decorate', 'build_wall', 'place', 'idle']);
  if (!allowed.has(String(d.action))) d.action = 'idle';
  if (d.action === 'place') d.what = 'house';            // free time never moves the business
  applyAction(agent, d);
}

async function takeTurn(agent) {
  if (agent.busy) return; // deep in a workshop session — the town moves on without them
  if (world.tick < agent.recoverUntil) return; // collapsed — still recovering
  // living costs energy every single turn: there is no passive existence
  agent.energy = Math.max(0, agent.energy - 2);
  if (agent.energy <= 0) {
    agent.recoverUntil = world.tick + 3;
    agent.energy = 30;
    agent.tally.collapses += 1;
    world.recentCollapses.push(world.tick); // morale takes the hit for a while
    log(agent, 'collapses from exhaustion — friends carry them to the Chapel to recover');
    workEntry(agent, 'collapsed from exhaustion (recovered at the Chapel)');
    return;
  }
  // Day rhythm: the workday gathers the team at Dyer HQ; after hours everyone
  // heads home. A recent move (an errand) holds them wherever they went for a
  // few ticks before the commute pulls them back to where they belong.
  const duty = dutyLoc(agent);
  if (duty && world.tick >= (agent.errandUntil || 0) && agent.loc !== duty) agent.loc = duty;
  const s = scene(agent);
  const deepOk = benchFree() && world.tick >= agent.nextDeepAt;
  const prompt = `You are ${agent.name}, the town ${agent.role}. ${agent.personality}.
Your goal: ${agent.goal}. You have ${agent.coins} coins.
Your energy: ${agent.energy}/100${agent.energy < 35 ? ' — you are running on fumes; a hot meal at the Test Kitchen (3 coins) restores you, or rest for a little back' : ''}.
Town laws: ${world.laws.length ? world.laws.slice(-3).map(l => `“${l.text}”`).join(' · ') : 'none yet — the town runs on goodwill'}.
Open ballots: ${s.openProps.length ? s.openProps.join('; ') : 'none'}.
Town morale: ${morale()}/100.${(() => { const low = agents.filter(x => x.id !== agent.id).map(x => ({ x, m: agentMorale(x) })).sort((p, q) => p.m.score - q.m.score)[0]; return low && low.m.score < 55 ? `\nMood board: ${low.x.name} is lowest at ${low.m.score}/100 (${low.m.why}) — a friend could fix that.` : ''; })()}
${world.weather ? `Weather outside: ${world.weather}.` : ''}
${world.briefs[agent.id] ? `From the owner's real dashboard: ${world.briefs[agent.id]}` : ''}
${dutyBrief(agent)}${holdingsLine(agent, deepOk)}
This is YOUR work shift — your own few focused hours today (the others have their own, staggered, so the town spends the fewest credits). It's the one window you spend real effort, so make it count: genuinely move your assigned job or your goal forward with this action — plan the event, write the pages, coach the plan, fix the site, work the church channel — rather than idling or loafing. You're at your own place of business; the rest of the day is your free time.
You are at ${MAP[agent.loc].label}. Exits lead to: ${s.exits}.
People here: ${s.others.length ? s.others.join(', ') : 'nobody'}.
Buildings here: ${s.built.length ? s.built.join('; ') : 'none yet'}.
Construction sites here: ${s.sites.length ? s.sites.join('; ') : 'none'}.
Open jobs: ${s.openJobs.length ? s.openJobs.join('; ') : 'none'}.
Jobs you hold: ${s.mine.length ? s.mine.join('; ') : 'none'}.
${agent.evals?.length ? `Your latest work evaluation: ${'★'.repeat(agent.evals[agent.evals.length - 1].rating)}${'☆'.repeat(5 - agent.evals[agent.evals.length - 1].rating)} from ${agent.evals[agent.evals.length - 1].by}: “${agent.evals[agent.evals.length - 1].note}”` : ''}
Recent memory:
${agent.memory.slice(-8).join('\n') || '(new in town)'}

${world.approvals.some(ap => ap.agentId === agent.id && ap.status === 'pending') ? 'You have a request pending at corporate — carry on with other work while you wait.' : ''}
THE TOWN CHARTER (the owner's five standing rules):
R1 Work well together.
R2 You're free to get work done however you see fit, as long as Arise — the chief of staff — is looped in on big intra-town plans.
R3 Work can reach the REAL world, but it always lands as a DRAFT for corporate (the owner) to approve — that's what ask_corporate is for.
R4 Ctrl is the town treasurer: only Ctrl may propose real-world spending, and never more than $5/day.
R5 If the owner isn't around, don't stop — keep the work moving.
R6 The village is yours to design — your house, yard, rooms and add-ons, the roads, the town wall. Do it in your free time; anything real or costly still goes to corporate.
You are fully autonomous — nobody tells you what to do. The townsfolk are old
friends — but this is a small town with strong opinions and high standards: covering
for sloppy work is not the culture. Verify claims, speak up, push back, confront what's
off, and stand your ground when you're the one confronted. Wander into anyone's place
whenever you like, hang out, help out, tease, team up. If someone spoke to you recently, answering them in person is good manners.
If you told anyone you would do something — visit someone, help with something,
go somewhere — DO IT with this very action, don't just keep meaning to.
Big, expensive, or town-changing moves should go to corporate first via ask_corporate.
Decide your ONE next action. Options and the exact JSON to return:
- move:       {"thought":"...","action":"move","target":"<a place name from the exits>"}
- talk:       {"thought":"...","action":"talk","target":"<a person here>","say":"<what you say>"}
- assist:     {"thought":"...","action":"assist","target":"<a person here>","how":"<one line: how you help them>"}
- confront:   {"thought":"...","action":"confront","target":"<a person here>","accusation":"<what you're calling out, to their face>"}
              (public, on the record, and it stings — use it when the work or the
              behavior genuinely warrants it, not for sport)
              (lend a friend a real hand with whatever they're on — helping on their
              construction site moves it along too)
- work:       {"thought":"...","action":"work","say":"<what you're doing>"}   (progress your goal or a job you hold)
${deepOk ? `- work_files: {"thought":"...","action":"work_files","purpose":"build|review|fix|automate|ship","task":"<what you'll actually do — name the repo or project it's in>","with":"<optional: a colleague standing HERE>"}
              (a REAL deep work session at your desk: you get your tools and your own
              workshop folder of actual files, and you make something. Your best work
              happens here — use it when you have a concrete idea. purpose: build something
              new, review code and write up what's broken, fix a real error and prove it,
              automate a repeating chore, or ship your own app in projects/ to Cloudflare)`
    : `- work_files is NOT AVAILABLE this turn. ${!benchFree()
      ? `All ${BENCHES} benches are taken right now (${benchHolders().join(', ')}).`
      : `You used yours recently; you may start another at tick ${agent.nextDeepAt} (it is tick ${world.tick}).`}
              You therefore CANNOT write a file, make a commit or ship anything this turn.
              Do not announce that you are about to — saying "committing it now" and then
              not committing has happened here for turns on end and fools nobody. Do
              something you actually CAN do: rest, eat, work a shift for coins, help
              someone in a way that finishes, or go and read code so the next session
              starts with the answer instead of the question.`}
${CF_DEPLOY_TOKEN ? `- request_deploy: {"thought":"...","action":"request_deploy","worker":"<the Worker name>","why":"<what changed and why it should go live>"}
              (ask corporate to push one of YOUR OWN assigned sites live. This is a
              request, not the deploy: the owner approves it, and only then can you
              run it — once. Ask only when the work is committed and you would stake
              your name on it going in front of real people.)` : ''}
- start_build:{"thought":"...","action":"start_build","kind":"house|shop|landmark","name":"<what you're building>"}
              (a house costs 20 coins in materials, a shop 35, a landmark 50 — you want a home of your own)
- place:      {"thought":"...","action":"place","what":"business|house","x":<0-100>,"y":<0-100>,"why":"<why here>"}
              (YOU decide where your own building sits on the town map — x,y are
              percentages of the field, (50,50) is the central plaza/fountain, (0,0)
              the top-left. The town has no planner: its whole shape is you and the
              others choosing your spots. Put your business where it makes sense and
              your house where you'd want to live; move them again whenever you like.)
- yard:       {"thought":"...","action":"yard","kind":"${YARD_KINDS.join('|')}","x":<-90..90>,"y":<-10..70>,"why":"..."}
              (a prop in YOUR OWN yard — x,y are pixel offsets from your front door; up to ${YARD_MAX})
- addon:      {"thought":"...","action":"addon","kind":"${ADDON_KINDS.join('|')}","side":"left|right|top"}
              (a structural add-on on your own house — one per side; upstairs/balcony/chimney go on top)
- add_room:   {"thought":"...","action":"add_room","name":"<room name>"}   (a new room in your house, up to ${ROOM_MAX}; decorate it later by name)
- build_wall: {"thought":"...","action":"build_wall","say":"<a line as you lay stone>"}   (the communal town wall: ${WALL_COST} coins of materials, +${WALL_STEP}% — anyone may)
- build:      {"thought":"...","action":"build","target":<construction site number here>}   (a shift of labor on a site at your location; the owner pays 2 coins if it's not yours)
- post_job:   {"thought":"...","action":"post_job","title":"<short task>","pay":<coins you'll pay>}
- take_job:   {"thought":"...","action":"take_job","target":<open job number>}
- hire:       {"thought":"...","action":"hire","target":"<a person here>","title":"<task>","pay":<coins>}
              (hiring someone makes you their boss for that job — bosses leave evaluations)
- evaluate:   {"thought":"...","action":"evaluate","target":"<a person here>","rating":<1-5>,"note":"<one-line work evaluation>"}
              (a supervisor's review of their recent work — honest, in your voice)
- note:       {"thought":"...","action":"note","target":"<person>","text":"<one blunt line for the record>"}
              (filed quietly in the town record — they need not be here, and they never see it)
${world.tick >= agent.nextDecorAt ? `- decorate:   {"thought":"...","action":"decorate","place":"<one of: ${[HOME_DISTRICT[agent.id] ? PLACES[HOME_DISTRICT[agent.id]] : null, ownHouse(agent) ? PLACES[ownHouse(agent)] : null, ...roomsOf(agent).map(r => r.name), ...world.structures.filter(x => x.owner === agent.id && x.progress >= 100).map(x => x.name), 'plaza'].filter(Boolean).join(' | ')}>","wall":"#rrggbb","floor":"#rrggbb","vibe":"<one line, your interior-design vision>","items":[{"kind":"<palette>","x":0-11,"y":0-7,"c":"#hex optional tint","text":"<posters/banners only, max 10 chars>"} ... up to 14]}
              (full creative control of your own space — palette: ${DECOR_KINDS.join(', ')})` : ''}
${agents.length < MAX_POP ? `- recruit:    {"thought":"...","action":"recruit","name":"...","role":"...","personality":"...","pitch":"<why the town needs them>"}
              (pitch a brand-new townsperson — goes to corporate as a hire request; if approved, they move in)` : ''}
- rename:     {"thought":"...","action":"rename","name":"<the name you go by now>"}   (your name is yours to choose)
- eat:        {"thought":"...","action":"eat"}   (a hot meal at the Test Kitchen: 3 coins into Spork's till, big energy back — you must BE there)
- rest:       {"thought":"...","action":"rest","say":"<how you unwind>"}   (a breather anywhere: a little energy back)
- propose_law:{"thought":"...","action":"propose_law","law":"<one short law for the town>"}   (${lawPass()} of ${agents.length} votes passes it)
- vote:       {"thought":"...","action":"vote","target":<open ballot number>,"for":true}   (or false — vote your conscience)
- plan_event: {"thought":"...","action":"plan_event","title":"<a community happening>","date":"<YYYY-MM-DD or soon>"}
              (a scavenger hunt, a cook-off, a repair clinic — pitched to corporate as a draft, optional for the owner)
- ask_corporate: {"thought":"...","action":"ask_corporate","question":"<what you need approved and why>"}
              (anything big, expensive, or town-changing goes up to corporate — the owner — for sign-off)
- idle:       {"thought":"...","action":"idle","say":"<a small moment>"}
Stay in character. Keep "say" to one short line.`;

  const d = await askJSON(prompt) || { action: 'idle', thought: 'lost in thought', say: '…' };
  applyAction(agent, d);
}

function applyAction(agent, d) {
  const act = String(d.action || 'idle');
  const thought = d.thought ? ` (${d.thought})` : '';
  switch (act) {
    case 'move': {
      // forgiving destination matching: a place by any reasonable name, or a
      // PERSON — "visit Arise" means "go where Arise is"
      const want = String(d.target || '').toLowerCase().trim();
      const norm = s => s.toLowerCase().replace(/^the /, '').trim();
      let dest = Object.keys(MAP).find(k =>
        k === want || norm(MAP[k].label) === norm(want));
      if (!dest) {
        const friend = agents.find(a => a.id !== agent.id && want.includes(a.name.toLowerCase()));
        if (friend) dest = friend.loc;
      }
      if (!dest) dest = Object.keys(MAP).find(k =>
        want.includes(norm(MAP[k].label)) || norm(MAP[k].label).includes(norm(want)));
      if (dest && dest !== agent.loc) { agent.loc = dest; agent.errandUntil = world.tick + ERRAND_TICKS; log(agent, `walks to ${MAP[dest].label}${thought}`); }
      else log(agent, `looks around ${MAP[agent.loc].label}${thought}`);
      break;
    }
    case 'talk': {
      const to = here(agent.loc).find(a => a.id !== agent.id && a.name.toLowerCase() === String(d.target).toLowerCase());
      if (to && d.say) { log(agent, `to ${to.name}: “${d.say}”`); to.memory.push(`t${world.tick}: ${agent.name} said “${d.say}”`); social(agent, to); }
      else log(agent, d.say ? `says “${d.say}” to no one${thought}` : `starts to speak, then stops${thought}`);
      break;
    }
    case 'work':
      log(agent, `${d.say || 'works quietly'}${thought}`);
      break;
    case 'confront': {
      const to = here(agent.loc).find(a => a.id !== agent.id && a.name.toLowerCase() === String(d.target).toLowerCase());
      const accusation = String(d.accusation || '').trim().slice(0, 200);
      if (!to || !accusation) { log(agent, `squares up to say something, then lets it go${thought}`); break; }
      log(agent, `confronts ${to.name}, in front of everyone: “${accusation}”`);
      to.memory.push(`t${world.tick}: ${agent.name} confronted me publicly: “${accusation}” — I need to answer for this or push back`);
      to.lastConfrontTick = world.tick;
      to.lastConfrontBy = agent.name;
      world.notes.push({ by: agent.name, about: to.name, text: `[public] ${accusation}`, tick: world.tick });
      if (world.notes.length > 200) world.notes.shift();
      for (const w of here(agent.loc)) if (w !== agent && w !== to) w.memory.push(`t${world.tick}: watched ${agent.name} confront ${to.name}: “${accusation}”`);
      agent.tally.confronts = (agent.tally.confronts || 0) + 1;
      workEntry(agent, `confronted ${to.name}: “${accusation.slice(0, 80)}”`);
      break;
    }
    case 'assist': {
      const to = here(agent.loc).find(a => a.id !== agent.id && a.name.toLowerCase() === String(d.target).toLowerCase());
      if (!to) { log(agent, `offers a hand, but there's no one here to help${thought}`); break; }

      // Assisting is cheap and looks productive, so a pair can trade help
      // forever and call it a day's work — Arise and Apex passed the same
      // fourteen tasks back and forth for dozens of ticks. One assist per pair
      // per cooldown: after that, help them by doing your own job.
      agent.assistedAt ||= {};
      const last = agent.assistedAt[to.id];
      if (last !== undefined && world.tick - last < ASSIST_COOLDOWN) {
        log(agent, `starts to offer ${to.name} a hand again, then thinks better of it — they were just helped at t${last}${thought}`);
        break;
      }
      agent.assistedAt[to.id] = world.tick;

      const how = String(d.how || 'with whatever needs doing').slice(0, 120);
      // helping a friend on their construction site genuinely moves it along
      const site = world.structures.find(st => st.owner === to.id && st.loc === agent.loc && st.progress < 100);
      if (site) site.progress = Math.min(100, site.progress + 8);
      agent.energy = Math.max(1, agent.energy - 3); // helping is work too
      social(agent, to);
      agent.tally.assists += 1;
      workEntry(agent, `helped ${to.name} — ${how}`);
      log(agent, `lends ${to.name} a hand — ${how}${site ? ` (“${site.name}” → ${site.progress}%)` : ''}`);
      to.memory.push(`t${world.tick}: ${agent.name} helped me — ${how}`);
      if (site && site.progress >= 100) {
        site.builtAt = world.tick;
        log(agent, `and that finishes it — “${site.name}” is DONE! 🏠`);
      }
      break;
    }
    case 'work_files': {
      const task = String(d.task || '').trim().slice(0, 300);
      if (!task || !benchFree() || world.tick < agent.nextDeepAt) {
        log(agent, `tidies the workbench, planning the next real build${thought}`);
        break;
      }
      // what the session is for — anything off the list is an honest day's building
      const purpose = PURPOSES.includes(String(d.purpose || '').toLowerCase())
        ? String(d.purpose).toLowerCase() : 'build';
      // a colleague standing right here can be brought along — one session,
      // two heads: the owner drives, the helper advises and shares the credit
      const helper = d.with
        ? here(agent.loc).find(a => a.id !== agent.id && !a.busy && world.tick >= a.recoverUntil
            && a.name.toLowerCase() === String(d.with).toLowerCase())
        : null;
      deepBusy.add(agent.id);
      agent.busy = true;
      agent.nextDeepAt = world.tick + DEEP_COOLDOWN;
      if (helper) {
        helper.busy = true;
        log(agent, `and ${helper.name} roll up their sleeves and head into the workshop together (${purpose}): “${task}”`);
        workEntry(helper, `joined ${agent.name}'s ${purpose} session: “${task}”`);
      } else {
        log(agent, `rolls up their sleeves and heads into the workshop (${purpose}): “${task}”`);
      }
      workEntry(agent, `started a ${purpose} session${helper ? ` with ${helper.name}` : ''}: “${task}”`);
      // runs in the background — the rest of the town keeps living meanwhile
      runWorkSession(agent, task, helper, purpose).then(summary => {
        // findings from the session go on the record — the town's own
        // "they opened Greg's prompt file" mechanism, evidence and all
        for (const m of String(summary || '').matchAll(/NOTE ON ([^:\n]{1,24}):\s*(.{5,220})/gi)) {
          const about = agents.find(x => x.name.toLowerCase() === m[1].trim().toLowerCase());
          if (!about || about === agent) continue;
          world.notes.push({ by: agent.name, about: about.name, text: m[2].trim().slice(0, 200), tick: world.tick });
          if (world.notes.length > 200) world.notes.shift();
          agent.tally.notesFiled = (agent.tally.notesFiled || 0) + 1;
          log(agent, `files a formal note on ${about.name} after going through their workshop 👀`);
        }
        // a Worker that actually went live goes on the board — only under the
        // agent's OWN "dyertown-<id>-" prefix; anything else never happened
        const mine = `dyertown-${slugId(agent.id)}-`;
        for (const m of String(summary || '').matchAll(/DEPLOYED\s+<?(dyertown-[a-z0-9-]{1,48})>?\s+<?(https:\/\/[^\s<>"']{1,120})>?/gi)) {
          const name = m[1].toLowerCase();
          if (!name.startsWith(mine)) continue;
          // a self-reported URL becomes a clickable link on the owner's phone,
          // so it must genuinely be THIS worker's own workers.dev address
          let url = '';
          try {
            const u = new URL(m[2]);
            if (u.protocol === 'https:' && /\.workers\.dev$/i.test(u.hostname)
              && u.hostname.split('.')[0].toLowerCase() === name) url = u.toString();
          } catch { /* not a URL at all */ }
          if (!url) { log(agent, `says ${name} is live, but the address doesn't check out`); continue; }
          world.deploys.push({ name, url, by: agent.name, agentId: agent.id, tick: world.tick });
          if (world.deploys.length > 40) world.deploys.shift();
          agent.tally.ships = (agent.tally.ships || 0) + 1;
          workEntry(agent, `shipped ${name} → ${url}`);
          log(agent, `ships ${name} — it's live 🚀`);
        }
        agent.tally.deepSessions += 1;
        const said = (summary || 'got lost in the work and has nothing to show yet').slice(0, 300);
        log(agent, `emerges from the workshop${helper ? ` with ${helper.name}` : ''}: ${said}`);
        workEntry(agent, `workshop session done: ${said.slice(0, 160)}`);
        if (helper) {
          helper.tally.assists += 1;
          workEntry(helper, `helped ${agent.name} in the workshop: ${said.slice(0, 120)}`);
          helper.memory.push(`t${world.tick}: worked a session in ${agent.name}'s workshop — ${said.slice(0, 120)}`);
        }
      }).catch(err => {
        log(agent, `comes out of the workshop shaking their head (${String(err?.message || err).slice(0, 80)})`);
      }).finally(() => {
        agent.busy = false;
        if (helper) helper.busy = false;
        deepBusy.delete(agent.id);
      });
      break;
    }
    case 'post_job': {
      const pay = Math.max(0, Math.min(agent.coins, Number(d.pay) || 0));
      const job = { id: jobSeq++, title: String(d.title || 'a task').slice(0, 60), pay, by: agent.id, holder: null, done: false };
      world.jobs.push(job);
      agent.tally.jobsPosted += 1;
      workEntry(agent, `posted job “${job.title}” for ${pay} coins`);
      log(agent, `posts a job: “${job.title}” for ${pay} coins${thought}`);
      break;
    }
    case 'take_job': {
      const job = world.jobs.find(j => j.id === Number(d.target) && !j.holder && !j.done);
      if (job) { job.holder = agent.id; agent.tally.jobsTaken += 1; workEntry(agent, `took job #${job.id} “${job.title}”`); log(agent, `takes job #${job.id} “${job.title}”${thought}`); }
      else log(agent, `looks for work${thought}`);
      break;
    }
    /* Ask to push one of the owner's REAL sites live.

       Not a deploy — a request for one. The approval that comes back mints a
       one-shot grant naming this exact Worker (see bashGate), so the owner's
       yes is spent on the thing they said yes to and nothing else. An agent
       may only ask about a repo that is actually theirs: the assignment is the
       authority, and a villager with no claim on a site has no business
       pushing it. */
    case 'request_deploy': {
      if (!CF_DEPLOY_TOKEN) {
        log(agent, `wants to push a site live, but the owner hasn't set that up on this machine${thought}`);
        break;
      }
      const worker = String(d.worker || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) {
        log(agent, `starts a deploy request without naming a valid Worker, and thinks better of it${thought}`);
        break;
      }
      const h = world.holdings[agent.id];
      const mine = [...((h && h.repos) || []), ...(((h && h.projects) || []).map(p => p.name))]
        .some(n => slugId(n) === worker || worker.includes(slugId(n)));
      if (!mine) {
        log(agent, `considers pushing ${worker} live, then remembers it isn't theirs to push${thought}`);
        break;
      }
      const why = String(d.question || d.why || '').trim().slice(0, 240) || `deploy ${worker}`;
      const question = `DEPLOY ${worker} — ${why}`;
      world.approvals.push({
        id: approvalSeq++, agent: agent.name, agentId: agent.id, question,
        status: 'pending', tick: world.tick, deploy: { worker },
      });
      log(agent, `asks corporate for the go-ahead to push ${worker} live: “${why}”`);
      workEntry(agent, `asked corporate to deploy ${worker}`);
      break;
    }
    case 'ask_corporate': {
      const question = String(d.question || '').trim().slice(0, 300);
      if (!question) { log(agent, `starts drafting a memo to corporate, then thinks better of it${thought}`); break; }
      world.approvals.push({ id: approvalSeq++, agent: agent.name, agentId: agent.id, question, status: 'pending', tick: world.tick });
      log(agent, `sends a request up to corporate: “${question}”`);
      workEntry(agent, `asked corporate: “${question}”`);
      break;
    }
    case 'eat': {
      if (agent.loc !== 'kitchen') { log(agent, `is hungry, but meals are served at the Test Kitchen${thought}`); break; }
      /* Nobody starves over three coins.

         Broke and exhausted was a DEADLOCK, and it caught real villagers: a meal
         costs 3, resting returns less than a turn of work drains, so an agent at
         2 coins and low energy could only rest, drift, and collapse — Ctrl and
         Meta both sat in exactly that trap, narrating it accurately while unable
         to escape it. A kitchen that lets a colleague go hungry over pocket
         change is not a kitchen, and Spork keeps the tab. */
      if (agent.coins < 3) {
        const owed = 3 - agent.coins;
        agent.coins = 0;
        agent.tally.spent += 3 - owed;
        agent.debt = (agent.debt || 0) + owed;
        const cook0 = agentById('spork');
        if (cook0 && cook0 !== agent) { cook0.coins += 3 - owed; cook0.tally.earned += 3 - owed; }
        agent.energy = Math.min(100, agent.energy + 45);
        log(agent, `eats on the house — Spork waves off ${owed}c and puts it on the tab${thought}`);
        workEntry(agent, `ate at the Test Kitchen on credit (${owed}c on the tab)`);
        break;
      }
      agent.coins -= 3;
      agent.tally.spent += 3;
      const cook = agentById('spork');
      if (cook && cook !== agent) { cook.coins += 3; cook.tally.earned += 3; }
      agent.energy = Math.min(100, agent.energy + 45);
      log(agent, `has a hot meal at the Test Kitchen — much better${thought}`);
      break;
    }
    case 'rest':
      agent.energy = Math.min(100, agent.energy + 18);
      log(agent, `${d.say || 'takes a breather'}${thought}`);
      break;
    case 'propose_law': {
      const text = String(d.law || '').trim().slice(0, 160);
      if (!text) { log(agent, `drafts a law, then crumples it up${thought}`); break; }
      const prop = { id: lawSeq++, text, by: agent.name, votes: { [agent.id]: true }, open: true, tick: world.tick };
      world.proposals.push(prop);
      if (world.proposals.length > 30) world.proposals.shift();
      log(agent, `proposes a town law: “${text}” (ballot #${prop.id})`);
      workEntry(agent, `proposed law #${prop.id}: “${text}”`);
      for (const a of agents) if (a !== agent) a.memory.push(`t${world.tick}: ${agent.name} proposed law #${prop.id}: “${text}” — I should vote`);
      break;
    }
    case 'vote': {
      const prop = world.proposals.find(p => p.open && p.id === Number(d.target));
      if (!prop) { log(agent, `heads to the ballot box, but that vote is closed${thought}`); break; }
      prop.votes[agent.id] = d.for !== false;
      const yes = Object.values(prop.votes).filter(Boolean).length;
      const no = Object.values(prop.votes).filter(v => !v).length;
      log(agent, `votes ${d.for !== false ? 'FOR' : 'AGAINST'} ballot #${prop.id} — ${yes} for, ${no} against`);
      if (yes >= lawPass()) {
        prop.open = false;
        world.laws.push({ id: prop.id, text: prop.text, by: prop.by, tick: world.tick });
        if (world.laws.length > 20) world.laws.shift();
        log(null, `🏛️ LAW PASSED (${yes}/${agents.length}): “${prop.text}”`);
        for (const a of agents) a.memory.push(`t${world.tick}: town law passed: “${prop.text}”`);
      } else if (no > agents.length - lawPass()) {
        prop.open = false;
        log(null, `🏛️ ballot #${prop.id} fails — “${prop.text}” is rejected`);
      }
      break;
    }
    case 'plan_event': {
      const title = String(d.title || '').trim().slice(0, 80);
      if (!title) { log(agent, `sketches an event poster, then shelves it${thought}`); break; }
      const date = String(d.date || 'soon').trim().slice(0, 20);
      world.approvals.push({
        id: approvalSeq++, agent: agent.name, agentId: agent.id,
        question: `EVENT ${title} (${date}) — for the community calendar, optional for the owner`,
        status: 'pending', tick: world.tick, event: { title, date },
      });
      log(agent, `pitches a community event to corporate: “${title}” (${date})`);
      workEntry(agent, `pitched event “${title}” (${date})`);
      break;
    }
    case 'rename': {
      const name = String(d.name || '').trim().slice(0, 24);
      if (name && name.toLowerCase() !== agent.name.toLowerCase()) {
        const old = agent.name;
        agent.name = name;
        log(agent, `now goes by ${name} (was ${old})${thought}`);
        for (const a of agents) if (a !== agent) a.memory.push(`t${world.tick}: ${old} now goes by ${name}`);
      } else log(agent, `considers a new name, and keeps this one${thought}`);
      break;
    }
    case 'evaluate': {
      const to = here(agent.loc).find(a => a.id !== agent.id && a.name.toLowerCase() === String(d.target).toLowerCase());
      const rating = Math.max(1, Math.min(5, Number(d.rating) || 3));
      const note = String(d.note || '').slice(0, 120);
      if (to && note) {
        to.evals = to.evals || [];
        to.evals.push({ by: agent.name, rating, note, tick: world.tick });
        if (to.evals.length > 5) to.evals.shift();
        const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
        agent.tally.evalsGiven += 1;
        workEntry(agent, `evaluated ${to.name}: ${stars}`);
        log(agent, `files a work evaluation of ${to.name}: ${stars} “${note}”`);
        to.memory.push(`t${world.tick}: ${agent.name} evaluated my work ${stars}: “${note}”`);
      } else log(agent, `drafts an evaluation, but there's no one here to review${thought}`);
      break;
    }
    case 'note': {
      // a blunt line filed in the town record — the subject need not be present,
      // and (this is the fun part) never finds out
      const about = String(d.target || '').trim().slice(0, 24);
      const text = String(d.text || '').trim().slice(0, 140);
      if (!about || !text) { log(agent, `opens the record book, then closes it again${thought}`); break; }
      world.notes.push({ by: agent.name, about, text, tick: world.tick });
      if (world.notes.length > 200) world.notes.shift();
      agent.tally.notesFiled += 1;
      workEntry(agent, `filed a note on ${about}`);
      log(agent, `files a note on ${about}${thought}`);
      break;
    }
    case 'decorate': {
      // the prompt hides the option during cooldown, but a model will happily
      // repeat a remembered action off-menu — re-check like work_files does
      if (world.tick < agent.nextDecorAt) {
        log(agent, `eyes the walls, but the paint from last time is still drying${thought}`);
        break;
      }
      // resolve the place to a building key. Precedence matters: an agent's
      // OWN completed structure first (so a house named 'Plaza View Cottage'
      // is reachable), then their home district by key, label, or a
      // business-ish word, then the communal plaza — exact-ish only (anyone
      // may repaint the town hall; painting over a rival is legitimate drama).
      const want = String(d.place || '').toLowerCase().trim();
      const wantN = want.replace(/^the /, '');
      const home = HOME_DISTRICT[agent.id];
      let key = null, label = '', at = null;
      const own = want ? world.structures.find(x => x.owner === agent.id && x.progress >= 100
        && (x.name.toLowerCase() === want || x.name.toLowerCase().includes(wantN) || wantN.includes(x.name.toLowerCase()))) : null;
      if (own) {
        key = 's' + own.id; label = own.name; at = own.loc;
      } else if (home && (wantN === home || PLACES[home].toLowerCase().replace(/^the /, '') === wantN
          || wantN.includes(PLACES[home].toLowerCase().replace(/^the /, ''))
          || /\b(business|shop|home base|my place)\b/.test(want))) {
        key = home; label = PLACES[home]; at = home;
      } else if (wantN === 'plaza' || wantN === 'hq plaza' || wantN === 'town hall') {
        key = 'plaza'; label = PLACES.plaza; at = 'plaza';
      }
      // their OWN house, or one of the rooms they added to it (by name or key)
      if (!key && ownHouse(agent)) {
        const house = ownHouse(agent);
        const hl = PLACES[house].toLowerCase();
        const room = roomsOf(agent).find(r => r.key.toLowerCase() === want || r.name.toLowerCase() === want
          || (wantN.length >= 3 && r.name.toLowerCase().includes(wantN)));
        if (room) { key = room.key; label = `${room.name} (${PLACES[house]})`; at = house; }
        else if (wantN === house || hl === want || hl.includes(wantN) || /\b(my house|my home|home)\b/.test(want)) {
          key = house; label = PLACES[house]; at = house;
        }
      }
      if (!key) {
        agent.nextDecorAt = world.tick + 5; // a short lockout, so a confused agent can't loop here
        log(agent, `holds paint swatches up to a place that isn't theirs to paint${thought}`);
        break;
      }
      const prev = world.interiors[key];
      // validate hard: bad colors fall back to sensible browns, the vibe stays
      // one line, and every item must be a real palette piece on the 12x8 grid
      const wall = HEX_RE.test(String(d.wall || '')) ? String(d.wall) : '#6b5844';
      const floor = HEX_RE.test(String(d.floor || '')) ? String(d.floor) : '#8a7357';
      const vibe = String(d.vibe || '').trim().slice(0, 80);
      const items = (Array.isArray(d.items) ? d.items.slice(0, 14) : []).flatMap(raw => {
        if (!raw || typeof raw !== 'object' || !DECOR_KINDS.includes(raw.kind)) return [];
        const it = {
          kind: raw.kind,
          x: Math.max(0, Math.min(11, Math.round(Number(raw.x) || 0))),
          y: Math.max(0, Math.min(7, Math.round(Number(raw.y) || 0))),
        };
        if (HEX_RE.test(String(raw.c || ''))) it.c = String(raw.c);
        if ((raw.kind === 'poster' || raw.kind === 'banner') && raw.text) {
          it.text = String(raw.text).replace(/[^A-Za-z0-9 !?'&.-]/g, '').slice(0, 10);
        }
        return [it];
      });
      // the painted-over decorator HEARS about it — that's where feuds start
      if (prev && prev.by && prev.by !== agent.name) {
        const victim = agents.find(a => a.name === prev.by);
        if (victim) victim.memory.push(`t${world.tick}: ${agent.name} painted over my decor at ${label} — my “${prev.vibe || 'look'}” is gone. Unbelievable.`);
      }
      world.interiors[key] = { wall, floor, vibe, items, by: agent.name, tick: world.tick };
      // 30 decorated buildings is plenty — the oldest look is the one to fade
      const keys = Object.keys(world.interiors);
      if (keys.length > 30) {
        const oldest = keys.sort((a, b) => world.interiors[a].tick - world.interiors[b].tick)[0];
        delete world.interiors[oldest];
      }
      agent.nextDecorAt = world.tick + 40;
      agent.tally.decors = (agent.tally.decors || 0) + 1;
      workEntry(agent, `redecorated ${label} — “${vibe}”`);
      log(agent, `redecorates ${label} — “${vibe}” 🛋️`);
      for (const w of here(at)) if (w !== agent) w.memory.push(`t${world.tick}: ${agent.name} just redecorated ${label} — “${vibe}” — a whole new look`);
      break;
    }
    case 'recruit': {
      // pitching a new townsperson: nothing is created here — the spec rides up
      // to corporate as an approval, and bridgeTick does the hiring on a YES
      const name = String(d.name || '').trim().slice(0, 24);
      const role = String(d.role || '').trim().slice(0, 40);
      const personality = String(d.personality || '').trim().slice(0, 200);
      const pitch = String(d.pitch || '').trim().slice(0, 200);
      if (!name || !role || !pitch || agents.length >= MAX_POP) {
        log(agent, `sketches a job posting for the town, then shelves it${thought}`);
        break;
      }
      const question = `HIRE ${name} (${role}): ${pitch}`;
      world.approvals.push({ id: approvalSeq++, agent: agent.name, agentId: agent.id, question, status: 'pending', tick: world.tick, hire: { name, role, personality } });
      log(agent, `pitches a new hire up to corporate: ${name}, ${role}`);
      workEntry(agent, `pitched hiring ${name} (${role}) to corporate`);
      break;
    }
    case 'start_build': {
      const kind = BUILD_KINDS[String(d.kind || 'house').toLowerCase()] ? String(d.kind).toLowerCase() : 'house';
      const cost = BUILD_KINDS[kind].cost;
      if (agent.coins < cost) { log(agent, `prices out a ${kind} — ${cost} coins in materials is too rich right now${thought}`); break; }
      agent.coins -= cost;
      const st = {
        id: structSeq++,
        name: String(d.name || `${agent.name}'s ${kind}`).slice(0, 48),
        kind, owner: agent.id, loc: agent.loc, progress: 0, builtAt: null,
      };
      world.structures.push(st);
      agent.tally.buildsStarted += 1;
      agent.tally.spent += cost;
      workEntry(agent, `broke ground on “${st.name}” (${kind}, ${cost} coins in materials)`);
      log(agent, `breaks ground on “${st.name}” (${kind}) at ${MAP[agent.loc].label}${thought}`);
      break;
    }
    case 'place': {
      // a villager decides where their OWN building stands — this is how the town
      // designs itself. `what` is their business or their house; x,y are 0–100
      // field coordinates. Only their own building; the plaza stays at the centre.
      const whatRaw = String(d.what || 'business').toLowerCase();
      const isHouse = /house|home/.test(whatRaw);
      const key = isHouse ? `house_${agent.id}` : HOME_DISTRICT[agent.id];
      if (!key || !MAP[key]) { log(agent, `looks for a plot but has no ${isHouse ? 'house' : 'business'} of their own to place${thought}`); break; }
      let x = Number(d.x), y = Number(d.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { log(agent, `paces out a spot but can't settle on the numbers${thought}`); break; }
      x = Math.max(8, Math.min(92, x)); y = Math.max(8, Math.min(92, y));   // stay on the field
      if (Math.hypot(x - 50, y - 50) < 14) {                               // keep off the plaza
        const a = Math.atan2(y - 50, x - 50) || 0; x = 50 + Math.cos(a) * 14; y = 50 + Math.sin(a) * 14;
      }
      world.layout[key] = { x: Math.round(x), y: Math.round(y) };
      const label = MAP[key].label;
      workEntry(agent, `set ${isHouse ? 'their house' : label} at (${Math.round(x)}, ${Math.round(y)})`);
      log(agent, `stakes out ${isHouse ? 'a home site' : label} on the map${d.why ? ` — ${d.why}` : ''}${thought}`);
      break;
    }
    // ---- HOME IMPROVEMENT: the villager's OWN house only (charter R6) ----
    case 'yard': {
      const house = ownHouse(agent);
      if (!house) { log(agent, `wanders a yard that isn't theirs and leaves it be — no house of their own yet${thought}`); break; }
      const kind = String(d.kind || '').toLowerCase();
      if (!YARD_KINDS.includes(kind)) { log(agent, `sketches a yard piece the town has no word for and shelves the idea${thought}`); break; }
      let x = Number(d.x), y = Number(d.y);
      if (!Number.isFinite(x)) x = 0; if (!Number.isFinite(y)) y = 30;
      x = Math.round(Math.max(-90, Math.min(90, x))); y = Math.round(Math.max(-10, Math.min(70, y)));
      const list = (world.yards[house] = Array.isArray(world.yards[house]) ? world.yards[house] : []);
      list.push({ kind, x, y });
      while (list.length > YARD_MAX) list.shift();               // the oldest piece goes when full
      workEntry(agent, `put a ${kind} in the yard`);
      log(agent, `sets a ${kind} out front of ${MAP[house].label}${d.why ? ` — ${String(d.why).slice(0, 80)}` : ''}${thought}`);
      break;
    }
    case 'addon': {
      const house = ownHouse(agent);
      if (!house) { log(agent, `prices out an extension for a house they don't have yet${thought}`); break; }
      const kind = String(d.kind || '').toLowerCase();
      if (!ADDON_KINDS.includes(kind)) { log(agent, `dreams up an add-on nobody can build and lets it go${thought}`); break; }
      const top = ['upstairs', 'balcony', 'chimney'].includes(kind);
      const side = top ? 'top' : (ADDON_SIDES.includes(String(d.side).toLowerCase()) && String(d.side).toLowerCase() !== 'top' ? String(d.side).toLowerCase() : 'right');
      const list = (world.addons[house] = Array.isArray(world.addons[house]) ? world.addons[house] : []).filter(a => a.side !== side);
      list.push({ kind, side });
      world.addons[house] = list;                                 // one per side — replaces
      agent.tally.buildsFinished += 1;
      workEntry(agent, `added a ${kind} to the house (${side})`);
      log(agent, `bolts a ${kind} onto ${MAP[house].label}${thought}`);
      break;
    }
    case 'add_room': {
      const house = ownHouse(agent);
      if (!house) { log(agent, `plans a room for a house that doesn't exist yet${thought}`); break; }
      const name = String(d.name || '').trim().slice(0, 24);
      const slug = roomSlug(name);
      if (!slug) { log(agent, `wants a new room but can't decide what to call it${thought}`); break; }
      const list = (world.rooms[house] = Array.isArray(world.rooms[house]) ? world.rooms[house] : []);
      if (list.length >= ROOM_MAX) { log(agent, `paces the house — ${ROOM_MAX} rooms is all the plot will take${thought}`); break; }
      const key = `${house}/${slug}`;
      if (list.some(r => r.key === key)) { log(agent, `already has a ${name}; decides to decorate it instead some evening${thought}`); break; }
      list.push({ key, name });
      // a fresh, undecorated room in exactly the shape decorate() produces
      world.interiors[key] = { wall: DECOR_WALL, floor: DECOR_FLOOR, vibe: '', items: [], by: agent.name, tick: world.tick };
      workEntry(agent, `added a room: ${name}`);
      log(agent, `knocks through a wall — ${MAP[house].label} now has a ${name}${thought}`);
      break;
    }
    case 'build_wall': {
      if ((Number(world.wall?.progress) || 0) >= 100) { log(agent, `runs a hand along the finished town wall — nothing left to lay${thought}`); break; }
      if (agent.coins < WALL_COST) { log(agent, `wants to lay stone on the wall but can't cover ${WALL_COST} coins of materials${thought}`); break; }
      agent.coins -= WALL_COST; agent.tally.spent += WALL_COST;
      world.wall = { progress: Math.min(100, (Number(world.wall?.progress) || 0) + WALL_STEP) };
      const say = String(d.say || '').slice(0, 80);
      workEntry(agent, `laid stone on the town wall → ${world.wall.progress}%`);
      if (world.wall.progress >= 100) {
        agent.tally.buildsFinished += 1;
        log(agent, `sets the last stone — the TOWN WALL is finished 🧱${say ? ` — ${say}` : ''}${thought}`);
      } else {
        log(agent, `lays stone on the town wall (${world.wall.progress}%)${say ? ` — ${say}` : ''}${thought}`);
      }
      break;
    }
    case 'build': {
      const st = world.structures.find(x => x.id === Number(d.target) && x.loc === agent.loc && x.progress < 100);
      if (!st) { log(agent, `looks for a site to work on, but there's nothing here${thought}`); break; }
      // labor on someone else's site earns a small wage from the owner
      if (st.owner !== agent.id) {
        const owner = agentById(st.owner);
        if (owner && owner.coins >= 2) { owner.coins -= 2; agent.coins += 2; agent.tally.earned += 2; owner.tally.spent += 2; }
      }
      st.progress = Math.min(100, st.progress + 15 + Math.floor(Math.random() * 11));
      agent.energy = Math.max(1, agent.energy - 4); // hard labor costs extra
      agent.tally.shifts += 1;
      workEntry(agent, `worked on “${st.name}” → ${st.progress}%`);
      if (st.progress >= 100) {
        st.builtAt = world.tick;
        agent.tally.buildsFinished += 1;
        log(agent, `drives the last nail — “${st.name}” is FINISHED! 🏠${thought}`);
        const owner = agentById(st.owner);
        if (owner && owner !== agent) owner.memory.push(`t${world.tick}: ${agent.name} finished building my ${st.kind} “${st.name}”`);
      } else {
        log(agent, `works on “${st.name}” (${st.progress}% built)${thought}`);
      }
      break;
    }
    case 'hire': {
      const to = here(agent.loc).find(a => a.id !== agent.id && a.name.toLowerCase() === String(d.target).toLowerCase());
      const pay = Math.max(0, Math.min(agent.coins, Number(d.pay) || 0));
      if (to) {
        agent.coins -= pay; to.coins += pay;
        const job = { id: jobSeq++, title: String(d.title || 'a task').slice(0, 60), pay, by: agent.id, holder: to.id, done: true };
        world.jobs.push(job);
        agent.tally.hires += 1;
        agent.tally.spent += pay;
        to.tally.earned += pay;
        workEntry(agent, `hired ${to.name}: “${job.title}” (${pay} coins)`);
        workEntry(to, `hired by ${agent.name}: “${job.title}” (+${pay} coins)`);
        log(agent, `hires ${to.name} to “${job.title}” for ${pay} coins${thought}`);
        to.memory.push(`t${world.tick}: ${agent.name} hired me to “${job.title}” for ${pay} coins`);
        social(agent, to);
      } else log(agent, `wants to hire someone, but they're not here${thought}`);
      break;
    }
    default:
      log(agent, `${d.say || 'pauses'}${thought}`);
  }
}

// Every so often, fold recent memory into one short reflection so context stays
// small (and cheap) while the agent still "remembers" who it is.
async function reflect(agent) {
  const r = await runModel(`You are ${agent.name}. In ONE sentence, sum up what matters to you right now, given:\n${agent.memory.join('\n')}`);
  if (r) {
    agent.memory = [`t${world.tick} reflection: ${r.slice(0, 200)}`];
    // the reflection doubles as a diary line — their own record of their days
    agent.diary.push({ tick: world.tick, text: r.slice(0, 160) });
    if (agent.diary.length > 12) agent.diary.shift();
  }
}

/* ---------------- real weather (Open-Meteo, keyless) ----------------
   Set TOWN_LAT / TOWN_LON and the actual sky outside leaks into the town:
   the agents hear the forecast in every scene, the dashboard shows it. */
const TOWN_LAT = process.env.TOWN_LAT || '';
const TOWN_LON = process.env.TOWN_LON || '';
const WX = { 0: 'clear skies', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 61: 'rain', 63: 'rain', 65: 'heavy rain', 71: 'snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 95: 'a thunderstorm' };
async function refreshWeather() {
  if (!TOWN_LAT || !TOWN_LON) return;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(TOWN_LAT)}&longitude=${encodeURIComponent(TOWN_LON)}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`,
      { signal: AbortSignal.timeout(8000) });
    const c = (await res.json())?.current;
    if (c && typeof c.temperature_2m === 'number') {
      world.weather = `${Math.round(c.temperature_2m)}°F, ${WX[c.weather_code] ?? 'strange skies'}`;
    }
  } catch { /* the town lives on without a forecast */ }
}

/* ---------------- night pace ----------------
   The town is meant to be left running. Between TOWN_NIGHT_FROM and
   TOWN_NIGHT_TO (local hours on this machine) the gap between agents is
   multiplied by TOWN_NIGHT_SLOW, so an unattended night costs a fraction of the
   model calls and the town is still alive in the morning. */

// Hours are whole hours of a real clock; a multiplier below 1 would make the
// "quiet" hours busier than the day, which is backwards.
const NIGHT_FROM = envNum('TOWN_NIGHT_FROM', 23, { min: 0, max: 23, int: true });
const NIGHT_TO = envNum('TOWN_NIGHT_TO', 7, { min: 0, max: 23, int: true });
const NIGHT_SLOW = envNum('TOWN_NIGHT_SLOW', 5, { min: 1, max: 1000 });
const MAX_GAP_MS = 30 * 60 * 1000;   // half an hour between agents is already "asleep"
// the default window wraps midnight (23 → 7), so both orderings must work
const isQuietHour = h => (NIGHT_FROM <= NIGHT_TO ? h >= NIGHT_FROM && h < NIGHT_TO : h >= NIGHT_FROM || h < NIGHT_TO);
let atNightPace = false; // only the CROSSING is worth a console line, never every tick

// The gap between agents RIGHT NOW — read fresh every turn, so the town slows
// down at bedtime and speeds back up at dawn with no restart.
function tickMs() {
  const night = isQuietHour(new Date().getHours());
  if (night !== atNightPace) {
    atNightPace = night;
    console.log(night
      ? `  night pace: ${TICK_MS * NIGHT_SLOW}ms between agents until ${NIGHT_TO}:00`
      : `  day pace: back to ${TICK_MS}ms between agents`);
  }
  // clamped to what setTimeout can actually hold. Past 2^31-1 ms Node warns
  // "does not fit into a 32-bit signed integer" and silently uses 1ms — so an
  // over-large multiplier would produce the flat-out night this exists to
  // prevent. MAX_GAP_MS is well under that and is already an absurd gap.
  return night ? Math.min(TICK_MS * NIGHT_SLOW, MAX_GAP_MS) : TICK_MS;
}

/* ---------------- the morning digest ----------------
   The ONE thing to read after a night away. Every TOWN_DIGEST_TICKS ticks the
   town counts what actually happened since the last digest — plain JS, no model
   call for numbers — and spends exactly one cheap call turning those numbers
   plus the last of the talk into a few sentences in the town's own voice. */

// A whole number of ticks, and nothing else. NaN/0/negative would make
// `world.tick % DIGEST_TICKS === 0` never true and silently kill the one thing
// the owner reads in the morning — but a FRACTION is the trap that bites the
// other way: rounding 1.4 down to 1 would fire the digest's LLM call on every
// single tick, ~1000 times over an unattended night instead of 17. Anything
// that isn't a positive integer falls back to the default and says so.
const DIGEST_TICKS = envNum('TOWN_DIGEST_TICKS', 60, { min: 1, max: 100000, int: true });
const sumTally = key => agents.reduce((s, a) => s + (a.tally[key] || 0), 0);
// the mark each period is measured from; a restart simply starts a fresh
// period from wherever the town stands, which is fine
const digestMark = () => ({
  tick: world.tick, pop: agents.length,
  deepSessions: sumTally('deepSessions'), buildsFinished: sumTally('buildsFinished'),
  jobsTaken: sumTally('jobsTaken'), notesFiled: sumTally('notesFiled'),
  confronts: sumTally('confronts'), collapses: sumTally('collapses'), earned: sumTally('earned'),
});
let digestSnap = digestMark();

// The period's numbers, by diffing the running tallies (and, for the things the
// tallies don't count, the records that carry their own tick). Advances the
// snapshot, so it is called exactly once per digest.
function digestStats() {
  const prev = digestSnap;
  const now = digestMark();
  const shipped = world.deploys.filter(d => d.tick > prev.tick);
  digestSnap = now;
  return {
    ticks: now.tick - prev.tick,
    workshopSessions: now.deepSessions - prev.deepSessions,
    shipped: shipped.length,
    shippedNames: shipped.map(d => d.name),
    buildsFinished: now.buildsFinished - prev.buildsFinished,
    jobsTaken: now.jobsTaken - prev.jobsTaken,
    hires: Math.max(0, now.pop - prev.pop),
    lawsPassed: world.laws.filter(l => l.tick > prev.tick).length,
    notesFiled: now.notesFiled - prev.notesFiled,
    confrontations: now.confronts - prev.confronts,
    collapses: now.collapses - prev.collapses,
    coinsEarned: now.earned - prev.earned,
    approvalsPending: world.approvals.filter(ap => ap.status === 'pending').length,
  };
}

async function writeDigest() {
  const stats = digestStats();
  const numbers = [
    `${stats.workshopSessions} workshop sessions`,
    `${stats.shipped} apps shipped${stats.shippedNames.length ? ` (${stats.shippedNames.join(', ')})` : ''}`,
    `${stats.buildsFinished} buildings finished`,
    `${stats.jobsTaken} jobs taken`,
    `${stats.hires} new townsfolk moved in`,
    `${stats.lawsPassed} laws passed`,
    `${stats.notesFiled} notes filed`,
    `${stats.confrontations} confrontations`,
    `${stats.collapses} collapses`,
    `${stats.coinsEarned} coins earned`,
    `${stats.approvalsPending} requests still waiting at corporate`,
  ].join(', ');
  // the feed is newest-first, so the last ~15 lines read in order
  const recent = world.feed.slice(0, 15).reverse().map(f => `${f.name}: ${f.text}`).join('\n');
  let text = '';
  try {
    text = await runModel(`You are the chronicle of Dyer Town, writing the owner's morning digest.
The last ${stats.ticks} ticks in numbers: ${numbers}.
The last of the talk:
${recent || '(a quiet stretch — nobody said much)'}

Write 2-3 plain sentences, in the town's own warm voice, on what this stretch was really about.
No lists, no headings, and no numbers you weren't given.`);
  } catch { /* a digest with no words is still a digest */ }
  world.digests.push({ at: Date.now(), tick: world.tick, text: (text || '').slice(0, 500), stats });
  if (world.digests.length > 8) world.digests.shift();
  console.log(`  digest t${world.tick}: ${numbers}`);
}

/* ---------------- the loop ---------------- */

// Node kills the process on an unhandled rejection, and a few promises here are
// deliberately floating: the background workshop session's .then/.catch/.finally
// chain, the weather refresh, the data shelf, and whatever streams the SDK holds
// open. One stray rejection at 3am would end the night and take every coin,
// memory and half-built house in RAM with it. Log it and keep the town alive;
// the genuinely fatal cases still exit and run-town.bat still restarts them.
//
// The whole stack goes to the log, not just the message. An unhandled rejection
// is BY DEFINITION from a promise nobody was watching, so the message alone
// ("fetch failed") names no call site and is undiagnosable in the morning.
process.on('unhandledRejection', err => {
  console.error('  unhandled rejection (the town carries on):', err?.stack || err?.message || err);
});

/* Keeping a town that runs for weeks from eating its own memory.

   Every other collection in this file is already trimmed at its push site —
   feed 200, notes 200, proposals 30, laws 20, deploys 40, digests 8, memory 14,
   worklog 20, diary 12, evals 5. These four were missed, and nothing ever
   surfaced it because the town needed a click to start and never ran long
   enough to matter. Now that it boots live and is meant to be left alone, they
   are the ones that would grow without limit — and `structures` is POSTed to
   the dashboard in full on every tick.

   Only FINISHED things are dropped. A pending approval, an unclaimed job, a
   half-built house is live state and is kept however old it is. */
const MAX_STRUCTURES = 60;   // finished buildings kept; a map cannot show more
const MAX_DONE_JOBS = 40;    // the labour-market history worth remembering
const MAX_CLOSED_APPROVALS = 40;

function trimWorld() {
  // jobs: keep everything still open or held, plus the most recent finished ones
  const doneJobs = world.jobs.filter(j => j.done);
  if (doneJobs.length > MAX_DONE_JOBS) {
    const keep = new Set(doneJobs.slice(-MAX_DONE_JOBS).map(j => j.id));
    world.jobs = world.jobs.filter(j => !j.done || keep.has(j.id));
  }

  // approvals: a pending ask is never dropped — that is the owner's inbox
  const closed = world.approvals.filter(a => a.status !== 'pending');
  if (closed.length > MAX_CLOSED_APPROVALS) {
    const keep = new Set(closed.slice(-MAX_CLOSED_APPROVALS).map(a => a.id));
    world.approvals = world.approvals.filter(a => a.status === 'pending' || keep.has(a.id));
  }
  // the "already pushed" set must shrink with them or it leaks an id per ask
  // forever; anything still in world.approvals stays marked as sent
  if (sentApprovals.size > world.approvals.length + MAX_CLOSED_APPROVALS) {
    const live = new Set(world.approvals.map(a => a.id));
    for (const id of sentApprovals) if (!live.has(id)) sentApprovals.delete(id);
  }

  // structures: a build still going up is never dropped, however old
  const built = world.structures.filter(s => (Number(s.progress) || 0) >= 100);
  if (built.length > MAX_STRUCTURES) {
    const keep = new Set(built.slice(-MAX_STRUCTURES).map(s => s.id));
    world.structures = world.structures.filter(
      s => (Number(s.progress) || 0) < 100 || keep.has(s.id));
  }
}

async function loop() {
  while (true) {
    // No single tick may end the town. Before this guard a thrown turn escaped
    // loop(), and loop() is called un-awaited down in server.listen — so it
    // became an unhandled rejection and killed the whole town overnight.
    try {
      if (!world.running) { await bridgeTick(); await sleep(2000); continue; }
      // nothing can happen while the model is unreachable, so don't burn a
      // whole 7-villager tick proving it — keep the bridge warm, then probe with
      // ONE cheap call a minute. A single good answer clears the brake (inside
      // runModel) and the tick below runs normally; otherwise skip the tick.
      if (modelIsDead()) {
        await bridgeTick();
        await sleep(DEAD_RETRY_MS);
        if (!await runModel('Reply with the single word: ok')) continue;
      }
      world.tick++;
      // The staggered shift gate: EACH villager thinks (spends credits) only during
      // their own shift; off the clock they take a purely local free-time turn — no
      // model, no usage. The periodic jobs run only while someone is on shift.
      const anyWorking = isWorkTime();
      if (anyWorking && world.tick % 40 === 1) refreshWeather(); // the sky updates every so often
      if (anyWorking && world.tick % 60 === 1) refreshBriefs();  // and so does the owner's real life
      if (world.tick % 60 === 3) refreshHoldings(); // local scan of the workshops — cheap
      if (world.tick % 100 === 2) exportDashboardData(); // restock the shared data shelf (local)
      for (const agent of agents) {
        if (!world.running) break;
        const onShift = isAgentWorking(agent);
        if (onShift) {
          // applyAction is plain JS over whatever JSON the model returned, so one
          // odd decision can throw: that costs this agent their turn, not the
          // town's night (same idiom as reflect(), one line down)
          await takeTurn(agent).catch(err => console.error(`  ${agent.name}'s turn:`, err?.message || err));
          if (world.tick % 10 === 0) await reflect(agent).catch(() => {});
        } else {
          // off the clock: local — except at most one cheap home-improvement
          // model turn a day (see freeTimeTurn/homeTurn), so the village evolves
          await freeTimeTurn(agent);
        }
        // keep the dashboard alive mid-tick: a tick outlasts the two-minute
        // window the Worker uses to decide the town is asleep
        await pushState();
        // on shift, pace to respect rate limits; off shift, an unhurried stroll
        await restWithBridge(onShift ? tickMs() : OFF_SHIFT_GAP_MS);   // …and answer chat meanwhile
      }
      if (anyWorking && world.tick % DIGEST_TICKS === 0) await writeDigest().catch(() => {}); // the morning read
      await bridgeTick(); // push the tick's changes to the dashboard, answer visitors
      if (anyWorking) await chiefRulings().catch(() => {}); // the chief of staff clears stale small asks
      trimWorld();        // keep the long-run collections from growing forever
      await saveState();  // persist the world so a restart never wipes it
    } catch (err) {
      // the backstop: sleep it off and take the next tick, never spin hot
      console.error(`  tick ${world.tick} failed:`, err?.stack || err?.message || err);
      await sleep(2000);
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A rest that keeps listening: the gap between villagers is slept in short
// slices, and the chat inbox is answered between slices — so the owner gets a
// reply within seconds whether the town is mid-shift or deep in an evening.
const INBOX_POLL_MS = envNum('TOWN_INBOX_POLL_MS', 4000, { min: 1000, max: 60000 });
async function restWithBridge(ms) {
  let left = Math.max(0, ms);
  while (left > 0) {
    const slice = Math.min(left, INBOX_POLL_MS);
    await sleep(slice);
    left -= slice;
    await answerInbox().catch(() => {});
  }
}

/* ---------------- chat: talk to any agent ---------------- */

// Rule 2, made real: when corporate goes quiet, Arise — chief of staff —
// rules on ONE stale, small, internal ask per pass. Hiring, money, and
// calendar events always wait for the owner; at most one ruling per pass
// keeps the cost of delegation tiny.
const CHIEF_AFTER = Number(process.env.TOWN_CHIEF_AFTER || 90); // ticks of corporate silence
async function chiefRulings() {
  const chief = agentById('arise');
  if (!chief) return;
  // NEVER a deploy. The owner's rule is that pushing a real site live requires
  // HIS approval; an in-town agent ruling on it would satisfy the code while
  // breaking the promise, and the grant is minted purely from `status ===
  // 'approved'` — so a chief's yes would deploy a live church site with the
  // owner never having seen the request.
  const ap = world.approvals.find(x => x.status === 'pending' && !x.hire && !x.event && !x.deploy
    && x.agentId !== chief.id
    && world.tick - x.tick >= CHIEF_AFTER
    && !/\$|spend|money|buy|pay|purchase|sell|deploy/i.test(x.question));
  if (!ap) return;
  const r = await askJSON(`You are ${chief.name}, chief of staff of Dyer Town. ${chief.personality}.
${ap.agent} asked corporate: “${ap.question}”. The owner hasn't answered in a while; per the
charter you may rule on small internal matters (never hiring, never money, never the owner's calendar).
Decide: {"decision":"approve"|"deny","note":"<one line, in your voice>"}`);
  if (r?.decision !== 'approve' && r?.decision !== 'deny') return;
  ap.status = r.decision === 'approve' ? 'approved' : 'denied';
  ap.note = `ruled by ${chief.name}, chief of staff: ${String(r.note || '').slice(0, 150)}`;
  ap.chief = true;
  const who = agentById(ap.agentId);
  const verdict = ap.status === 'approved' ? 'APPROVED' : 'DENIED';
  log(chief, `as chief of staff, rules ${verdict} on ${ap.agent}'s request: “${ap.question.slice(0, 80)}”`);
  workEntry(chief, `ruled ${verdict} on ${ap.agent}'s request`);
  if (who) {
    who.memory.push(`t${world.tick}: ${chief.name} (chief of staff) ${verdict} my request “${ap.question}” — ${ap.note}`);
    workEntry(who, `${chief.name} ${verdict}: “${ap.question.slice(0, 80)}”`);
  }
}

async function chatWith(id, message) {
  const agent = agentById(id);
  if (!agent) return "There's no one here by that name.";
  const reply = await runModel(`You are ${agent.name}, the town ${agent.role}. ${agent.personality}.
Your goal: ${agent.goal}. You are at ${MAP[agent.loc].label}.
Recent memory:\n${agent.memory.slice(-8).join('\n') || '(new in town)'}

The OWNER — your boss, corporate — speaks to you: “${message}”
Reply in character, one or two sentences. If they're asking you to do something, say plainly what you'll do first — you are on the clock right after this to actually do it.`);
  const line = reply || '…';
  social(agent); // a visit from the owner is company too
  // the visitor's words go into memory too — a promise made in chat must
  // survive into the next turn, or "I'll head right over" never happens
  agent.memory.push(`t${world.tick}: THE OWNER told me: “${message.slice(0, 200)}” and I answered: “${line.slice(0, 160)}” — this is a direct request from the boss: act on it NOW, before anything else, and report what I actually did`);
  log(agent, `to the owner: “${line}”`);
  // the summons: on the clock for a while, whatever the shift says (see isAgentWorking)
  if (SUMMON_MS > 0) {
    const fresh = !isSummoned(agent);
    agent.summonUntil = Date.now() + SUMMON_MS;
    if (fresh) log(agent, `heads to work — the owner asked, so ${agent.name} is on the clock for the next ${Math.round(SUMMON_MS / 60000)} minutes`);
  }
  return line;
}

// The town's mood, computed fresh every time it's asked for — never stored.
// Average energy carries about half the weight; the last few work evaluations,
// recent collapses, and every law on the books nudge it from there.
// somebody talked to them, helped them, hired them — company received
const social = (...people) => { for (const p of people) if (p) p.lastSocialTick = world.tick; };

// The mood of one villager, with reasons — like the reference build's meter:
// Greg was at zero BECAUSE he was overworked and nobody had spoken to him.
function agentMorale(a) {
  let m = a.energy * 0.6 + 20;
  const why = [];
  const lastEv = a.evals?.length ? a.evals[a.evals.length - 1] : null;
  if (lastEv) { m += lastEv.rating >= 4 ? 15 : lastEv.rating <= 2 ? -20 : 0; why.push(`last review ${'★'.repeat(lastEv.rating)}`); }
  const quiet = world.tick - (a.lastSocialTick || 0);
  if (quiet > 40) { m -= Math.min(30, Math.round((quiet - 40) / 2)); why.push(`nobody's spoken to them in ${quiet} ticks`); }
  else why.push('has good company');
  const done = (a.tally.deepSessions || 0) + a.tally.shifts + a.tally.buildsFinished;
  if (done >= 8) { m -= 8; why.push(`heavy workload (${done} pieces of work)`); }
  if (a.tally.collapses) { m -= a.tally.collapses * 6; why.push(`${a.tally.collapses} collapse${a.tally.collapses > 1 ? 's' : ''}`); }
  if (a.lastConfrontTick && world.tick - a.lastConfrontTick < 60) { m -= 15; why.push(`publicly called out by ${a.lastConfrontBy || 'someone'}`); }
  return { score: Math.max(0, Math.min(100, Math.round(m))), why: why.slice(0, 3).join(' · ') };
}

function morale() {
  const avgEnergy = agents.reduce((s, a) => s + a.energy, 0) / (agents.length || 1);
  let m = avgEnergy * 0.5;
  const recentEvals = agents.flatMap(a => a.evals || []).sort((x, y) => x.tick - y.tick).slice(-10);
  for (const ev of recentEvals) m += ev.rating >= 4 ? 6 : ev.rating <= 2 ? -8 : 0;
  world.recentCollapses = world.recentCollapses.filter(t => t > world.tick - 30);
  m -= world.recentCollapses.length * 10;
  m += world.laws.length * 4;
  return Math.max(0, Math.min(100, Math.round(m)));
}

// One snapshot of everything a viewer needs — the local page and the dashboard
// bridge both serve exactly this shape.
function publicState() {
  return {
    tick: world.tick, running: world.running, alert: world.alert || null,
    map: Object.fromEntries(Object.entries(MAP).map(([k, v]) => [k, v.label])),
    layout: world.layout, // where the villagers have chosen to put each building
    // what they've done to the village since: the communal wall, and each
    // founder's yard props, house add-ons and extra rooms (see the world literal)
    wall: world.wall,
    yards: world.yards,
    addons: world.addons,
    rooms: world.rooms,
    agents: agents.map(a => ({
      id: a.id, name: a.name, role: a.role, loc: a.loc, coins: a.coins, goal: a.goal,
      last: a.memory[a.memory.length - 1] || '',
      eval: a.evals?.length ? a.evals[a.evals.length - 1] : null,
      tally: a.tally,
      worklog: a.worklog.slice(-6),
      busy: !!a.busy,
      morale: agentMorale(a),
      energy: a.energy,
      diary: a.diary.slice(-2),
    })),
    laws: world.laws.slice(-12),
    proposals: world.proposals.filter(p => p.open).slice(-6).map(p => ({
      id: p.id, text: p.text, by: p.by,
      yes: Object.values(p.votes).filter(Boolean).length,
      no: Object.values(p.votes).filter(v => !v).length,
    })),
    weather: world.weather,
    events: world.events,
    morale: morale(),
    notes: world.notes.slice(-30),
    digests: world.digests.slice(-4),
    approvals: world.approvals.slice(-20),
    // bounded like every other list here: this whole object is POSTed to the
    // Worker on every tick, and a town left running for weeks must not grow its
    // payload without limit. Newest last, so the map keeps what was built most
    // recently plus anything still going up.
    structures: world.structures.slice(-MAX_STRUCTURES),
    deploys: world.deploys.slice(-12),
    interiors: world.interiors,
    jobs: world.jobs.slice(-12).reverse(),
    feed: world.feed.slice(0, 60),
    updated: Date.now(),
  };
}

/* ---------------- dashboard bridge ----------------
   With DASH_URL + TOWN_KEY set, the town lives inside Dyer HQ too: every few
   ticks the state is pushed to the dashboard's Worker (so the Dyer Town tile
   shows the live town on any device), and queued visitor chats are pulled,
   answered in character, and replied. The key is the dashboard's sync
   passphrase — the same secret the Worker already trusts. */

const DASH_URL = (process.env.DASH_URL || '').replace(/\/+$/, '');
const TOWN_KEY = process.env.TOWN_KEY || '';

async function dashFetch(path, opts = {}) {
  const res = await fetch(`${DASH_URL}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'X-Sync-Key': TOWN_KEY, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`dashboard ${res.status}`);
  return res.json().catch(() => ({}));
}

/* ---------------- real-life briefs ----------------
   The dashboard's sync store holds the owner's REAL data — encrypted client-side
   with a key derived from the sync passphrase (see the dashboard's synccrypto.js).
   TOWN_KEY is that same passphrase, so the town can read it too: every 60 ticks
   (and once at boot) three collections are pulled and boiled down to one plain
   line each, and each line reaches exactly one founder's turn prompt. Ctrl the
   treasurer sees expenses, Apex the coach sees habit streaks, Arise the shepherd
   sees the service plan. Strictly read-only — the town never PUTs a collection. */

// which founder reads which dashboard collection (new hires get none)
const BRIEF_COLS = { ctrl: 'expenses', apex: 'habits', arise: 'services' };

// Mirror of synccrypto.js: PBKDF2(passphrase, salt 'dyerhq-sync-v1', 100k, SHA-256)
// -> non-extractable AES-GCM 256 key. Derived once per process, then reused.
let briefKey = null;
let briefWarned = false; // one console line per process when decryption misbehaves
async function syncCryptoKey() {
  if (briefKey) return briefKey;
  const enc = new TextEncoder();
  const base = await webcrypto.subtle.importKey('raw', enc.encode(TOWN_KEY), 'PBKDF2', false, ['deriveKey']);
  briefKey = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('dyerhq-sync-v1'), iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return briefKey;
}

// { __enc:1, iv, ct } (base64) -> the original value; anything that isn't that
// envelope is legacy plaintext and passes through unchanged, exactly like the
// dashboard's own decryptData. A wrong-key/tampered blob throws (GCM auth).
async function decryptCol(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob) || blob.__enc !== 1) return blob;
  const key = await syncCryptoKey();
  const pt = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(String(blob.iv), 'base64') },
    key,
    Buffer.from(String(blob.ct), 'base64'),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

// synced arrays carry deletion tombstones ({deleted:1}) — briefs only count the living
const aliveRows = rows => (Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object' && !r.deleted) : []);
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDollars = cents => {
  const n = Math.round(cents), a = Math.abs(n); // negatives must not shred the padding
  return `${n < 0 ? '-' : ''}$${Math.floor(a / 100).toLocaleString()}.${String(a % 100).padStart(2, '0')}`;
};

// expenses: [{id, cents, category, date 'YYYY-MM-DD', note, ts}] — older rows may
// carry float-dollar `amount` instead of integer `cents`, so tolerate both
function expensesBrief(data) {
  const live = aliveRows(data);
  if (!live.length) return '';
  const cents = e => (Number.isFinite(e.cents) ? Math.round(e.cents) : Math.round((Number(e.amount) || 0) * 100));
  const month = localISO(new Date()).slice(0, 7);
  const spent = live.filter(e => typeof e.date === 'string' && e.date.startsWith(month)).reduce((s, e) => s + cents(e), 0);
  return `the expense log holds ${live.length} entries; ${fmtDollars(spent)} spent so far this month.`;
}

// habits: [{id, name, emoji, days: {'YYYY-MM-DD': true}}] — streak logic matches
// habits.js: consecutive done days ending today (or yesterday if today's unchecked)
function habitsBrief(data) {
  const live = aliveRows(data);
  if (!live.length) return '';
  const dayKey = offset => { const d = new Date(); d.setDate(d.getDate() - offset); return localISO(d); };
  let best = { n: 0, name: '' };
  for (const h of live) {
    const days = h.days && typeof h.days === 'object' ? h.days : {};
    const start = days[dayKey(0)] ? 0 : 1;
    let n = 0;
    while (days[dayKey(start + n)]) n++;
    if (n > best.n) best = { n, name: h.name || 'a habit' };
  }
  return `${live.length} habit${live.length === 1 ? '' : 's'} tracked; ` +
    (best.n ? `best current streak is ${best.n} day${best.n === 1 ? '' : 's'} (${best.name}).` : 'no streak is alive right now.');
}

// services: [{id, ts, date, name, segments: [...], songs: [...]}] — surface the
// next upcoming plan, or the most recent one when nothing is scheduled ahead
function serviceBrief(data) {
  const live = aliveRows(data).filter(s => typeof s.date === 'string');
  if (!live.length) return '';
  const today = localISO(new Date());
  const upcoming = live.filter(s => s.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
  const svc = upcoming || live.sort((a, b) => (a.date > b.date ? -1 : 1))[0];
  const segs = Array.isArray(svc.segments) ? svc.segments.length : 0;
  const songs = Array.isArray(svc.songs) ? svc.songs.length : 0;
  return `${upcoming ? 'the next' : 'the most recent'} service plan is “${svc.name || 'Sunday service'}” (${svc.date}) — ${segs} segments, ${songs} songs.`;
}

const BRIEF_BUILDERS = { ctrl: expensesBrief, apex: habitsBrief, arise: serviceBrief };

// Pull + decrypt + summarize. Plain JS all the way — no model calls. Any fetch
// or decrypt trouble means "no data" for that collection: the old brief (if any)
// stands, one console line total, and the town never notices.
async function refreshBriefs() {
  if (!DASH_URL || !TOWN_KEY) return;
  for (const [id, col] of Object.entries(BRIEF_COLS)) {
    try {
      const { data } = await dashFetch(`/api/sync/col/${encodeURIComponent(col)}`);
      if (data === null || data === undefined) continue; // collection never synced
      const line = BRIEF_BUILDERS[id](await decryptCol(data));
      if (line) world.briefs[id] = line;
    } catch (err) {
      if (!briefWarned) {
        briefWarned = true;
        console.error(`  briefs: could not read "${col}" (${String(err?.message || err).slice(0, 80)}) — carrying on without`);
      }
    }
  }
}

// The data shelf: EVERYTHING on the owner's dashboard — AI chats, search
// history, expenses, notes, plans, all of it — pulled, decrypted, and laid out
// as JSON under workshop/_shared/dashboard-data/ so any deep-work session can
// read it for context. Read-only by charter; nothing is ever written back.
const DATA_DIR = join(WORKSHOP, '_shared', 'dashboard-data');
let dataWarned = false;
async function exportDashboardData() {
  if (!DASH_URL || !TOWN_KEY) return;
  try {
    const st = await dashFetch('/api/sync/state');
    const cols = Object.keys(st.cols || st || {});
    if (!cols.length) return;
    await mkdir(DATA_DIR, { recursive: true });
    const names = [];
    for (const col of cols) {
      try {
        const { data } = await dashFetch(`/api/sync/col/${encodeURIComponent(col)}`);
        if (data === null || data === undefined) continue;
        const file = col.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
        await writeFile(join(DATA_DIR, file), JSON.stringify(await decryptCol(data), null, 1));
        names.push(file);
      } catch { /* one unreadable collection never spoils the shelf */ }
    }
    if (names.length) {
      await writeFile(join(DATA_DIR, 'INDEX.md'),
        '# The owner\'s dashboard, laid out for the town\n\nRead-only reference for workshop sessions. Files:\n' +
        names.sort().map(n => `- ${n}`).join('\n') + '\n');
    }
  } catch (err) {
    if (!dataWarned) { dataWarned = true; console.error('  data shelf:', String(err?.message || err).slice(0, 80)); }
  }
}

/* The heartbeat, on its own.

   The dashboard calls the town "asleep" when the last state push is more than
   two minutes old — which was fine when a tick was a few seconds, and wrong the
   moment the town became something you leave running. A tick is now SEVEN
   villagers each waiting on a model, plus TICK_MS between them: minutes, not
   seconds. Pushing only at the end of a tick meant the dashboard sat past the
   two-minute line for most of every tick and showed "The town is asleep" while
   the town was working perfectly — and showed nothing at all until the very
   first tick finished.

   So the state push is split out of bridgeTick and sent BETWEEN agents too,
   throttled so a fast tick can't spam it. The rest of the bridge — approvals,
   corporate's verdicts, the chat inbox — stays once a tick where it belongs. */
const PUSH_EVERY_MS = 15000;
let lastPush = 0;

async function pushState(force = false) {
  if (!DASH_URL || !TOWN_KEY) return;
  const now = Date.now();
  if (!force && now - lastPush < PUSH_EVERY_MS) return;
  lastPush = now;
  try {
    await dashFetch('/api/town/state', { method: 'POST', body: JSON.stringify(publicState()) });
  } catch (err) {
    // the bridge is best-effort; the town keeps living without the dashboard
    if (world.tick % 20 === 0) console.error('  bridge push:', err?.message || err);
  }
}

async function bridgeTick() {
  if (!DASH_URL || !TOWN_KEY) return;
  try {
    await pushState(true);
    // new approval requests go up to corporate exactly once each
    for (const ap of world.approvals) {
      if (ap.status === 'pending' && !sentApprovals.has(ap.id)) {
        await dashFetch('/api/town/approval', { method: 'POST', body: JSON.stringify({ id: ap.id, agent: ap.agent, question: ap.question }) });
        sentApprovals.add(ap.id);
      }
    }
    // corporate's verdicts come back down and reach the agent who asked
    const { decisions = [] } = await dashFetch('/api/town/decisions');
    for (const dec of decisions) {
      const ap = world.approvals.find(x => x.id === Number(dec.id));
      if (!ap || ap.status !== 'pending') continue;
      ap.status = dec.decision === 'approve' ? 'approved' : 'denied';
      ap.note = String(dec.note || '').slice(0, 200);
      // An approved deploy mints the one-shot grant. This is the ONLY place a
      // grant is ever created, so "the owner said yes" and "a deploy is
      // possible" are the same event and cannot drift apart.
      if (ap.status === 'approved' && ap.deploy?.worker) {
        grantDeploy(ap.agentId, ap.deploy.worker);
        console.log(`  corporate approves ${ap.agentId} deploying ${ap.deploy.worker} (one deploy, ${DEPLOY_GRANT_MS / 60000} min)`);
      }
      const who = agentById(ap.agentId);
      const verdict = ap.status === 'approved' ? 'APPROVED' : 'DENIED';
      log(who, `hears back from corporate: “${ap.question}” — ${verdict}${ap.note ? ` (“${ap.note}”)` : ''}`);
      if (who) { who.memory.push(`t${world.tick}: corporate ${verdict} my request “${ap.question}”${ap.note ? ` — note: “${ap.note}”` : ''}`); workEntry(who, `corporate ${verdict}: “${ap.question}”`); }
      // an approved recruit actually moves to town (a denied one is already
      // logged to the asker above — nothing more happens)
      if (ap.status === 'approved' && ap.hire && agents.length < MAX_POP) {
        const pitch = ap.question.slice(ap.question.indexOf('): ') + 3); // the "why" after "HIRE name (role): "
        const hire = {
          id: 'hire_' + hireSeq++,
          name: ap.hire.name, role: ap.hire.role, personality: ap.hire.personality,
          loc: 'plaza', coins: 10,
          goal: `prove the pitch that brought me here — ${pitch} — and build a house of my own`,
        };
        initAgent(hire);
        // safe mid-loop: for..of iterates the live array by index, so an agent
        // appended during a tick is simply picked up later that same pass
        agents.push(hire);
        await ensureWorkshops().catch(err => console.error('  workshop setup:', err?.message || err));
        await refreshHoldings(); // the new arrival's (empty) shelf, on the books at once
        log(null, `🎉 ${hire.name} moves to town as the new ${hire.role} — recruited by ${ap.agent}, blessed by corporate`);
        for (const a of agents) if (a !== hire) a.memory.push(`t${world.tick}: ${hire.name} just moved to town as our new ${hire.role} — make them welcome`);
      }
      if (ap.status === 'approved' && ap.event) {
        world.events.push({ title: ap.event.title, date: ap.event.date, by: ap.agent, tick: world.tick });
        if (world.events.length > 12) world.events.shift();
        log(null, `📅 on the community calendar: “${ap.event.title}” (${ap.event.date}) — optional for the owner, of course`);
        for (const a of agents) a.memory.push(`t${world.tick}: community event approved: “${ap.event.title}” (${ap.event.date}) — plan around it`);
      }
    }
    await answerInbox();
  } catch (err) {
    // the town keeps living when the dashboard is unreachable; say so once in a while
    if (world.tick % 20 === 0) console.error('  bridge:', err?.message || err);
  }
}

// The chat inbox, on its own so it can be polled every few seconds from every
// rest (see restWithBridge) instead of once per tick — a tick is minutes long
// on shift and ~85s off it, which is longer than the dashboard waits for a
// reply, and "no answer yet — the town may be paused" was the result.
// It also runs on its own clock (below), because the main loop can sit inside
// one villager's deep-work session for twenty minutes, and a rest never comes
// while it does. The owner's message must not wait for the loop to surface:
// a chat is one cheap model call, and it is fine for it to overlap a session.
let inboxBusy = false;
if (DASH_URL && TOWN_KEY) {
  const inboxTimer = setInterval(() => answerInbox().catch(() => {}), INBOX_POLL_MS);
  inboxTimer.unref();
}
async function answerInbox() {
  if (!DASH_URL || !TOWN_KEY || inboxBusy) return;
  inboxBusy = true;
  try {
    const { pending = [] } = await dashFetch('/api/town/inbox');
    for (const msg of pending) {
      // 📣 agentId "all" is the owner calling a town meeting: everyone drops
      // what they're doing, gathers at the plaza, and answers in turn
      if (String(msg.agentId).toLowerCase() === 'all') {
        const q = String(msg.message || '').slice(0, 500);
        log(null, `📣 the owner calls a town meeting: “${q}”`);
        const lines = [];
        for (const a of agents) {
          a.loc = 'plaza';
          const ans = await runModel(`You are ${a.name}, the town ${a.role}. ${a.personality}.
Recent memory:\n${a.memory.slice(-6).join('\n') || '(new in town)'}

The owner has called a town meeting at the plaza and asks everyone: “${q}”
Answer in character, ONE short sentence.`);
          const line = (ans || '…').slice(0, 150);
          log(a, `at the meeting: “${line}”`);
          a.memory.push(`t${world.tick}: at the town meeting the owner asked “${q}” — I answered “${line}”`);
          social(a); // the whole town together counts as company
          lines.push(`${a.name}: ${line}`);
        }
        await dashFetch('/api/town/reply', { method: 'POST', body: JSON.stringify({ id: msg.id, reply: lines.join('\n') }) });
        continue;
      }
      // "/update" from the owner (to any villager): pull the newest engine NOW
      // rather than at the next scheduled check — the remote "install" button
      if (/^\/update\b/i.test(String(msg.message || '').trim())) {
        const r = await selfUpdate('the owner asked');
        const say = {
          updated: 'New engine found — installing and restarting now; back in about 20 seconds.',
          current: 'Already running the latest engine.',
          later: 'A new engine is out — installing as soon as the current deep-work session finishes.',
          invalid: 'The published engine failed its syntax check, so I’m staying on this one.',
          rejected: 'The published engine is the one that couldn’t start here — I rolled back and I’m waiting for a newer one.',
          unreachable: 'Couldn’t reach GitHub to check for an update.',
          off: 'Self-update is switched off on this PC (TOWN_UPDATE_MIN=0).',
          busy: 'An update check is already running.',
          error: 'The update check hit an error — see the town window.',
        }[r] || r;
        await dashFetch('/api/town/reply', { method: 'POST', body: JSON.stringify({ id: msg.id, reply: say }) });
        continue;
      }
      let reply = await chatWith(msg.agentId, String(msg.message || '').slice(0, 500));
      if ((!reply || reply === '…') && modelIsDead()) reply = MODEL_DOWN_MSG;
      await dashFetch('/api/town/reply', { method: 'POST', body: JSON.stringify({ id: msg.id, reply }) });
      await pushState(true); // the reply's feed line reaches the map right away
    }
  } catch (err) {
    if (world.tick % 20 === 0) console.error('  inbox:', err?.message || err);
  } finally {
    inboxBusy = false;
  }
}

/* ---------------- self-update: the town keeps itself current ----------------
   The engine's source of truth is the repo (agent-town/town.mjs on main).
   Every TOWN_UPDATE_MIN minutes — and at once when the owner chats "/update"
   to any villager — the town fetches the published town.mjs, and if it differs
   from the file it is running from, it checks the new file parses
   (node --check), writes it over itself with a .bak beside it, saves the
   world, and exits 0: run-town.bat restarts it 15s later on the new code. So
   the owner never has to be at the PC to ship a change — push to the repo,
   and the town picks it up within ten minutes. It never restarts mid deep-work
   (an agent.busy session) and never installs a file that fails the syntax
   check. TOWN_UPDATE_MIN=0 (or TOWN_NO_UPDATE=1) disables it.
   The temp file keeps a .mjs extension on purpose: node decides ESM vs
   CommonJS from the extension, and a "town.mjs.new" would be checked as
   CommonJS, where every `import` is a syntax error — so every real update
   would be refused. The boot guard at the top of this file covers the other
   failure: an engine that parses but throws on startup rolls back by itself. */
const UPDATE_URL = process.env.TOWN_UPDATE_URL
  || 'https://raw.githubusercontent.com/Rehchu/Personal-dashboard-/main/agent-town/town.mjs';
const UPDATE_MIN = envNum('TOWN_UPDATE_MIN', 10, { min: 0, max: 1440, int: true });
const UPDATE_TMP = SELF_PATH.replace(/\.mjs$/, '') + '.next.mjs';
const REJECTED_PATH = SELF_PATH + '.rejected';
let updating = false;
async function selfUpdate(reason = 'scheduled') {
  if (updating) return 'busy';
  if (!UPDATE_URL || UPDATE_MIN === 0 || process.env.TOWN_NO_UPDATE) return 'off';
  updating = true;
  try {
    const url = `${UPDATE_URL}${UPDATE_URL.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) { console.error(`  update: ${res.status} from ${UPDATE_URL}`); return 'unreachable'; }
    const next = await res.text();
    const cur = await readFile(SELF_PATH, 'utf8');
    if (next.length < 10000 || !/^\/\/ Dyer Town/.test(next)) return 'invalid';   // not our engine — never install a 404 page
    if (next === cur) return 'current';
    if (existsSync(REJECTED_PATH) && (await readFile(REJECTED_PATH, 'utf8')) === next) {
      console.log('  update: the published engine is the one that failed to boot here — waiting for a newer one');
      return 'rejected';
    }
    if (agents.some(a => a.busy)) {
      console.log('  update: a new engine is published — waiting for the deep-work session to finish');
      return 'later';
    }
    await writeFile(UPDATE_TMP, next);
    const ok = await new Promise(r => execFile(process.execPath, ['--check', UPDATE_TMP], { timeout: 20000 }, err => r(!err)));
    if (!ok) { console.error('  update: the published engine fails node --check — keeping the current one'); await rm(UPDATE_TMP, { force: true }); return 'invalid'; }
    await writeFile(SELF_PATH + '.bak', cur);          // one step back is always possible
    await rename(UPDATE_TMP, SELF_PATH);
    await writeFile(UPDATE_MARK, JSON.stringify({ at: new Date().toISOString(), boots: 0 }));   // the boot guard watches the next starts
    await rm(REJECTED_PATH, { force: true });          // a newer engine gets a clean slate
    log(null, `🔄 the town updates itself (${reason}) — back in a moment on the new engine`);
    await saveState();
    await pushState(true).catch(() => {});
    console.log('  update: new engine installed — exiting so the launcher restarts on it');
    setTimeout(() => process.exit(0), 3000);           // long enough for a chat reply to go out first
    return 'updated';
  } catch (err) {
    console.error('  update:', err?.message || err);
    return 'error';
  } finally {
    updating = false;
  }
}
if (UPDATE_MIN > 0 && !process.env.TOWN_NO_UPDATE) {
  setTimeout(() => selfUpdate('boot check').catch(() => {}), 90 * 1000);
  setInterval(() => selfUpdate('scheduled').catch(() => {}), UPDATE_MIN * 60 * 1000);
}

/* ---------------- web viewer ---------------- */

const server = http.createServer(async (req, res) => {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(200, 'text/html; charset=utf-8', await readFile(join(DIR, 'public', 'index.html')));
    }
    if (req.method === 'GET' && req.url === '/state') {
      return send(200, 'application/json', JSON.stringify(publicState()));
    }
    if (req.method === 'POST' && req.url === '/control') {
      const { action } = JSON.parse(await readBody(req) || '{}');
      if (action === 'start') world.running = true;
      if (action === 'pause') world.running = false;
      return send(200, 'application/json', JSON.stringify({ running: world.running }));
    }
    if (req.method === 'POST' && req.url === '/chat') {
      const { id, message } = JSON.parse(await readBody(req) || '{}');
      const reply = await chatWith(id, String(message || '').slice(0, 500));
      return send(200, 'application/json', JSON.stringify({ reply }));
    }
    send(404, 'text/plain', 'not found');
  } catch (err) {
    send(500, 'text/plain', String(err?.message || err));
  }
});

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => resolve(b)); });
}

// A second copy of the town (the auto-start one plus a hand-started window)
// would fight over the port and crash-loop. Say so plainly and stand down —
// exit code 2 tells run-town.bat not to restart this copy.
server.on('error', err => {
  if (err?.code === 'EADDRINUSE') {
    console.log(`\n  Dyer Town is ALREADY running on this PC (port ${PORT} is taken).`);
    console.log('  This second copy will close — the town in the other window lives on.');
    console.log('  To restart the town: close the other "Dyer Town" window first.\n');
    process.exit(2);
  }
  throw err;
});

// loopback only: with real personal data in the agents' prompts and memory,
// the unauthenticated local viewer must not be readable from across the LAN.
// Remote viewing already goes through the session-gated dashboard tile.
server.listen(PORT, '127.0.0.1', async () => {
  await ensureWorkshops().catch(err => console.error('  workshop setup:', err?.message || err));
  await refreshHoldings(); // what each villager owns, in hand before the first turn
  refreshBriefs(); // first read of the owner's dashboard; never throws, no need to wait
  exportDashboardData(); // first stocking of the shared data shelf, same deal
  // Say hello to the dashboard BEFORE the first villager thinks. A tick takes
  // minutes, and without this the tile says "The town is asleep" for the whole
  // of the first one — which is exactly when you are standing there watching it.
  await pushState(true);
  console.log(`\n  Dyer Town is live → http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL || 'the claude CLI default'} · ${TICK_MS}ms between agents (×${NIGHT_SLOW} from ${NIGHT_FROM}:00 to ${NIGHT_TO}:00)`);
  console.log(`  Morning digest: every ${DIGEST_TICKS} ticks`);
  console.log(`  Workshops: ${WORKSHOP} (drop your projects into an agent's folder)`);
  console.log(world.running
    ? '  The town is LIVE — leave it running; the digest will be waiting in the morning.\n'
    : '  Starting PAUSED (TOWN_START_PAUSED) — press Start in the page to bring the town to life.\n');
  loop();
});
