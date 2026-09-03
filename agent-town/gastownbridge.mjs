#!/usr/bin/env node
// Dyer Town × Gas Town — the bridge that renders a REAL gastown workspace in
// your pixel town.
//
// Gas Town (github.com/steveyegge/gastown, MIT) is a serious multi-agent
// orchestration engine: a Mayor coordinates Rigs (each a git repo) worked by
// Polecats and Crew, with Witness/Refinery keeping order and a Beads ledger
// tracking every work item. It already knows its whole live state — this bridge
// just READS it (`gt status --json`) and pushes it to your dashboard in the exact
// shape the Dyer Town tile paints. So the town you watch becomes a live cockpit
// over your actual gastown town: the Mayor's HQ is the pixel office, each rig is
// a building, and every agent is a villager standing at the rig they're working.
//
// It never touches models or your Claude subscription — it only shells out to the
// `gt` CLI and POSTs JSON. Nothing here vendors gastown's code; it drives the CLI
// you install. Run EITHER this OR the simulated town.mjs (both push to the same
// tile) — one town at a time.
//
//   DASH_URL=https://lifehq.dyer-hq.workers.dev TOWN_KEY=<dashboard passphrase> \
//     node gastown-bridge.mjs
//
// Needs a running gastown town on this machine (`gt up`). Env knobs:
//   GT_BIN            path to the gt binary (default: "gt" on PATH)
//   GT_POLL_SECONDS   how often to refresh (default 5, min 2)
//   TOWN_NAME         override the HQ label (default: the town's own name)

import { spawn } from 'node:child_process';

// Run a CLI with stdin CLOSED. gt/bd are built on terminal-UI libraries and will
// block waiting on an open (piped) stdin, which is exactly what execFile hands
// them — so the call would hang until the timeout and look like a failure. We
// also keep the full stderr so a real error is visible instead of "Command failed".
function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      if (done) return; done = true;
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${cmd} ${args.join(' ')} timed out after ${timeout / 1000}s`), { stdout: out, stderr: err }));
    }, timeout);
    child.on('error', e => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      if (code === 0) return resolve({ stdout: out, stderr: err });
      const tail = err.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || '(no error text)';
      reject(Object.assign(new Error(`${cmd} exited ${code}: ${tail}`), { stdout: out, stderr: err, code }));
    });
  });
}

const DASH_URL = (process.env.DASH_URL || 'https://lifehq.dyer-hq.workers.dev').replace(/\/+$/, '');
const TOWN_KEY = (process.env.TOWN_KEY || '').trim();
const GT = process.env.GT_BIN || 'gt';
const EVERY = Math.max(2, Number(process.env.GT_POLL_SECONDS) || 5) * 1000;

// Building sprites that already ship with the town map, so each rig renders as a
// real building instead of a bare emoji. 'plaza' is special: it is the HQ, and
// its interior is the pixel office — so the Mayor's HQ becomes the office view.
const RIG_ART = ['repairshop', 'studio', 'library', 'kitchen', 'chapel', 'shop', 'landmark', 'gym'];

// gastown role → a short label for a villager's role line.
const ROLE_LABEL = {
  mayor: 'coordinator', deacon: 'supervisor', boot: 'maintenance', dog: 'maintenance',
  polecat: 'worker', crew: 'crew', witness: 'watchdog', refinery: 'merge queue',
};

// YOUR cast — the seven residents of Dyer Town. They ALWAYS stand in town, each
// at their own building, whether or not Gas Town has a matching rig yet. When you
// DO add a rig named after one of them (`gt rig add draco <dragons repo>`), that
// resident lights up "busy" whenever the rig has live work. `sprite` is the art id
// (town.js draws char_<sprite>); `building` is a map sprite; `rigs` are the rig
// names (aliases) that count as this resident's work.
const ROSTER = [
  { sprite: 'ctrl',  name: 'Ctrl',  building: 'repairshop', biz: 'Repair Shop',  rigs: ['ctrl'] },
  { sprite: 'apex',  name: 'Max',   building: 'gym',        biz: 'Gym',          rigs: ['max', 'apex'] },
  { sprite: 'draco', name: 'Draco', building: 'library',    biz: 'Library',      rigs: ['draco'] },
  { sprite: 'spork', name: 'Spork', building: 'kitchen',    biz: 'Test Kitchen', rigs: ['spork'] },
  { sprite: 'arise', name: 'Arise', building: 'chapel',     biz: 'AriseHub',     rigs: ['arise'] },
  { sprite: 'meta',  name: 'Meta',  building: 'studio',     biz: 'Church Media Studio', rigs: ['meta'] },
  { sprite: 'watch', name: 'Vigil', building: 'landmark',   biz: 'Night Watch',         rigs: ['vigil', 'watch'] },
];
// every rig-name alias that belongs to a resident, so a Gas Town agent scoped to
// one isn't also drawn as a separate HQ villager
const CAST_RIG_NAMES = new Set(ROSTER.flatMap(m => m.rigs));
// Gas Town's own HQ agents get one of the two spare sprites so they aren't blank.
const HQ_SPRITE = { mayor: 'boss', deacon: 'hire', boot: 'hire', dog: 'hire' };

// The daily work SHIFT (local time), matching town.mjs: during it the residents
// are at work (and animate as working); off the clock they take free time.
// Default 9am–12pm; override with TOWN_WORK_FROM / TOWN_WORK_TO.
const SHIFT_FROM = Math.max(0, Math.min(23, Number(process.env.TOWN_WORK_FROM ?? 9)));
const SHIFT_TO = Math.max(1, Math.min(24, Number(process.env.TOWN_WORK_TO ?? 12)));
const inShift = () => { const h = new Date().getHours(); return h >= SHIFT_FROM && h < SHIFT_TO; };
// Spork is the boss's second — in charge of the town, not just the kitchen.
const ROLE = { spork: 'runs the Test Kitchen — the boss’s second, keeps the town running' };
// what each resident gets up to off the clock, flavored by their repo
const LEISURE = {
  ctrl: 'tinkering with a salvaged PC for the fun of it', apex: 'getting in an evening lift',
  draco: 'adding a chapter to the dragon saga', spork: 'cooking up something nobody asked for',
  arise: 'planning Sunday and checking in on everyone', meta: 'color-grading a thumbnail for the joy of it',
  watch: 'up the tower, scanning the quiet town',
};

let ticks = 0;
const cap = s => (s = String(s || 'agent'), s.charAt(0).toUpperCase() + s.slice(1));

async function gt(args) {
  const { stdout } = await run(GT, args, { timeout: 30000 });
  return JSON.parse(stdout);
}

async function readyJobs() {
  // The job board reads the Beads ledger via `bd`, which hits the same database
  // that can stall. Off by default; flip JOBS_ON=1 to re-enable it later.
  if (process.env.JOBS_ON !== '1') return [];
  for (const argv of [['ready', '--json', '--flat'], ['ready', '--json']]) {
    try { const j = await run('bd', argv, { timeout: 8000 }); return JSON.parse(j.stdout); }
    catch { /* try the next flag shape, then give up */ }
  }
  return [];
}

const rigActive = r => {
  const mq = r.mq || {};
  return Number(mq.in_flight || mq.inFlight || 0) > 0 || Number(mq.pending || 0) > 0
    || Number(r.polecat_count || 0) > 0 || (Array.isArray(r.agents) && r.agents.some(a => a.running));
};
const rigWork = r => {
  const w = (r.agents || []).find(a => a.running && (a.work_title || a.workTitle));
  return w ? (w.work_title || w.workTitle) : '';
};

export function toPublicState(st, ready, tickOverride) {
  if (typeof tickOverride === 'number') ticks = tickOverride;
  const townName = process.env.TOWN_NAME || 'Dyer Town';
  const rigs = Array.isArray(st.rigs) ? st.rigs : [];
  const rigNames = new Set(rigs.map(r => String(r.name).toLowerCase()));
  const rigByName = {};
  for (const r of rigs) rigByName[String(r.name).toLowerCase()] = r;

  const map = { plaza: `${townName} HQ` };
  const agents = [];
  const feed = [];
  const claimed = new Set();

  // The whole cast, ALWAYS in town — each resident at their own building. If a
  // Gas Town rig named after them exists, they go "busy" while it has live work;
  // if not, they're simply minding the shop. So the town is populated the moment
  // the bridge runs, with or without rigs.
  const working = inShift();   // the whole cast is on the clock only during the shift
  for (const m of ROSTER) {
    const rig = m.rigs.map(n => rigByName[n]).find(Boolean);
    if (rig) claimed.add(String(rig.name).toLowerCase());
    const work = rig ? rigWork(rig) : '';
    map[m.building] = `${m.name}'s ${m.biz}`;
    agents.push({
      id: m.sprite, name: m.name, role: ROLE[m.sprite] || `runs the ${m.biz}`, loc: m.building,
      busy: working,   // at work through the shift (drives the "working" animation), off after
      last: working
        ? (work ? `working on ${work}` : `hard at work in the ${m.biz}`)
        : `off the clock — ${LEISURE[m.sprite] || 'taking it easy'}`,
      goal: rig ? `the ${rig.name} repo` : m.biz, worklog: work ? [work] : [], energy: working ? 100 : 70,
      morale: { score: working ? 88 : 72, why: working ? 'on the job' : 'free time' }, tally: {}, diary: [],
    });
    if (working) feed.push({ name: m.name, text: work ? `is working on ${work}` : `is hard at work in the ${m.biz}`, at: Date.now() });
    else if (Math.random() < 0.22) feed.push({ name: m.name, text: LEISURE[m.sprite] || 'is taking it easy', at: Date.now() });
  }

  // Any extra rigs that aren't one of the cast become their own generic building.
  let generic = 0;
  for (const r of rigs) {
    if (claimed.has(String(r.name).toLowerCase())) continue;
    const active = rigActive(r), work = rigWork(r);
    const base = RIG_ART[generic % RIG_ART.length];
    const key = generic < RIG_ART.length ? base : `${base}_${generic}`;
    generic++;
    map[key] = `${r.name} rig`;
    if (active) feed.push({ name: `${r.name} rig`, text: work ? `— ${work}` : 'has work in flight', at: Date.now() });
  }

  // HQ agents (Mayor, Deacon, …). Skip rig-scoped agents — their rig's character
  // represents them — and skip any town agent already named after a cast member.
  for (const a of (st.agents || [])) {
    const seg = String(a.address || '').split('/')[0].toLowerCase();
    if (rigNames.has(seg)) continue;
    const key = String(a.name || 'agent').toLowerCase();
    if (CAST_RIG_NAMES.has(key)) continue;
    const running = !!a.running, work = a.work_title || '';
    agents.push({
      id: HQ_SPRITE[key] || 'hire', name: cap(a.name), role: ROLE_LABEL[key] || 'agent', loc: 'plaza',
      busy: running && !!work, last: work ? `working on ${work}` : (running ? 'on shift' : 'holding the fort'),
      goal: '', worklog: work ? [work] : [], energy: running ? 100 : 50,
      morale: { score: running ? 80 : 60, why: running ? 'on the job' : 'steady' }, tally: {}, diary: [],
    });
  }

  // Ready work items → the town job board.
  const jobs = (Array.isArray(ready) ? ready : []).slice(0, 12).map(b => ({
    id: b.id, title: b.title || b.id, pay: 0,
    by: b.assignee || b.owner || b.created_by || '', holder: b.assignee || null, done: false,
  }));

  const sum = st.summary || {};
  return {
    tick: ticks,
    running: true,
    alert: (st.daemon && st.daemon.running === false) ? { text: 'Gas Town daemon is down — run `gt up`.' } : null,
    map,
    agents,
    laws: [],
    proposals: [],
    weather: 'clear',
    events: [],
    morale: agents.length ? Math.round(agents.filter(a => a.busy).length / agents.length * 100) : 60,
    notes: [
      `Gas Town: ${sum.rig_count ?? rigs.length} rigs, ${sum.polecat_count ?? '?'} polecats, ${sum.crew_count ?? '?'} crew, ${sum.active_hooks ?? '?'} active hooks.`,
    ],
    digests: [],
    approvals: [],
    structures: [],
    deploys: [],
    interiors: {},
    jobs,
    feed: feed.slice(0, 60),
    updated: Date.now(),
    source: 'gastown',
  };
}

async function pushOnce() {
  let st;
  try {
    // --fast skips the mail lookup, which queries the beads DB and can hang.
    st = await gt(['status', '--json', '--fast']);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/ENOENT|not found/i.test(msg)) console.error('Could not run `gt` — is Gas Town installed and on PATH? (set GT_BIN to its path)');
    else if (/town|marker|GT_TOWN_ROOT/i.test(msg)) console.error('No gastown town found here — run `gt init` && `gt up`, or run this from inside the town (or set GT_TOWN_ROOT).');
    else console.error('gt status failed:', msg.split('\n')[0]);
    return;
  }
  const ready = await readyJobs();
  const state = toPublicState(st, ready);
  ticks++;
  try {
    const res = await fetch(`${DASH_URL}/api/town/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Sync-Key': TOWN_KEY },
      body: JSON.stringify(state),
    });
    if (!res.ok) console.error(`Bridge: dashboard ${res.status} — check TOWN_KEY matches your dashboard passphrase.`);
    else console.log(`[${new Date().toLocaleTimeString()}] pushed ${state.agents.length} agents across ${Object.keys(state.map).length - 1} rigs`);
  } catch (e) {
    console.error('Bridge: could not reach the dashboard —', String(e && e.message || e).split('\n')[0]);
  }
}

// Only run the polling loop when invoked directly (so tests can import the mapper).
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  console.log(`Dyer Town × Gas Town bridge → ${DASH_URL}  (every ${EVERY / 1000}s)`);
  await pushOnce();
  setInterval(pushOnce, EVERY);
}
