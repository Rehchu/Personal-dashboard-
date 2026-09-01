#!/usr/bin/env node
// Publish a Dyer Town agent's work to GitHub — and, when the project is
// deployable, give it the workflow that ships it to Cloudflare.
//
// WHY THIS EXISTS
// Villagers were committing into workshops with no git remote configured, so
// "Nothing shipped yet" was structurally true no matter how much work they did.
// This closes that gap.
//
// WHO RUNS IT
// The TOWN runs this, never an agent directly. Agents may read each other's
// workshops, so a token written into .git/config would be readable by every
// villager in the town. The token therefore:
//   * comes from MAIN_GITHUB_TOKEN in the town's own environment (strip it from
//     agent sessions in sessionEnv, exactly like the Cloudflare deploy token),
//   * is handed to git through a credential helper that reads the variable, so
//     it never lands in .git/config and never appears in a process argument
//     list where `ps` or a shell history would catch it,
//   * is never written to any file this script creates.
//
// USAGE
//   node scripts/agent-publish.mjs --agent meta --project edit-bay \
//        --dir "C:/dyer-town/workshop/meta/projects/edit-bay"
//
//   --private=false   make the new repo public (default: private)
//   --dry-run         do everything except create the repo and push
//
// Pushes to branch town/<agent>, never to main, and never force-pushes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER = 'Rehchu';
const API = 'https://api.github.com';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = process.argv.indexOf(hit);
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const die = msg => { console.error(`✗ ${msg}`); process.exit(1); };

const agent = String(arg('agent') || '').toLowerCase();
const project = String(arg('project') || '').toLowerCase();
const dir = arg('dir');
const dryRun = arg('dry-run') === true || arg('dry-run') === 'true';
const isPrivate = arg('private', 'true') !== 'false';

if (!AGENT_RE.test(agent)) die('--agent must be a short lowercase id, e.g. meta');
if (!SLUG_RE.test(project)) die('--project must be a lowercase repo-safe slug, e.g. edit-bay');
if (!dir || typeof dir !== 'string') die('--dir must point at the project folder');
if (!existsSync(dir)) die(`no such folder: ${dir}`);

const token = process.env.MAIN_GITHUB_TOKEN;
if (!token && !dryRun) {
  die('MAIN_GITHUB_TOKEN is not set. Create a fine-grained PAT scoped to the Rehchu\n'
    + '  repositories with Contents: read+write and Administration: read+write (needed to\n'
    + '  create a repo), then set it in the town\'s environment only.');
}

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

// The token reaches git through the environment, not through argv or config.
const gitAuthed = args => git([
  '-c', 'credential.helper=',
  '-c', `credential.helper=!f() { echo username=x-access-token; echo "password=$MAIN_GITHUB_TOKEN"; }; f`,
  ...args,
], { env: { ...process.env, MAIN_GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0' } });

async function gh(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dyer-town-agent-publish',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/* ---------- the deploy workflow a new project gets ---------- */

// Two shapes, because they are not interchangeable: a Pages project sets
// pages_build_output_dir and deploys with `pages deploy`, a Worker sets main
// and deploys with `deploy`. Picking the wrong one fails at deploy time with a
// message that does not explain itself, so detect it here instead.
function detectKind(projectDir) {
  const cfg = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
    .map(f => join(projectDir, f)).find(existsSync);
  if (!cfg) return { kind: 'none' };
  const text = readFileSync(cfg, 'utf8');
  if (text.includes('pages_build_output_dir')) return { kind: 'pages', cfg };
  return { kind: 'worker', cfg };
}

function nodeShape(projectDir) {
  const p = join(projectDir, 'package.json');
  if (!existsSync(p)) return { pkg: false, build: false, lock: false };
  let build = false;
  try { build = Boolean(JSON.parse(readFileSync(p, 'utf8')).scripts?.build); } catch { /* unreadable package.json — treat as no build */ }
  return { pkg: true, build, lock: existsSync(join(projectDir, 'package-lock.json')) };
}

function workflowFor(kind, name, { pkg, build, lock }) {
  // Install before building, or `npm run build` reaches for a vite that was
  // never installed. `npm ci` needs a lockfile; without one it hard-fails, so
  // fall back to `npm install`.
  const installStep = pkg
    ? `
      - name: Install
        if: env.HAS_CF_TOKEN == 'true'
        run: npm ${lock ? 'ci' : 'install'}
`
    : '';
  const buildStep = build
    ? `
      - name: Build
        if: env.HAS_CF_TOKEN == 'true'
        run: npm run build
`
    : '';
  const deploy = kind === 'pages'
    ? `          wranglerVersion: '4.121.0'\n          command: pages deploy --project-name=${name}\n`
    : '';
  return `name: Deploy to Cloudflare

# Written by scripts/agent-publish.mjs when this project was created.
#
# Skips green until CLOUDFLARE_API_TOKEN is set, so it can never turn this
# repo's checks red before anyone has configured it.
#
#   CLOUDFLARE_API_TOKEN  — ${kind === 'pages' ? 'needs the Cloudflare Pages Edit permission' : '"Edit Cloudflare Workers" template'}
#   CLOUDFLARE_ACCOUNT_ID — f8622d4d3948b292b1069375575aa39a
${kind === 'pages' ? `#\n# First run needs the Pages project to exist:\n#   npx wrangler pages project create ${name} --production-branch=main\n` : ''}
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    name: ${name}
    runs-on: ubuntu-latest
    env:
      HAS_CF_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN != '' }}
    steps:
      - name: Skip (no Cloudflare token configured)
        if: env.HAS_CF_TOKEN != 'true'
        run: echo "CLOUDFLARE_API_TOKEN is not set — skipping the deploy, not failing it."

      - uses: actions/checkout@v4
        if: env.HAS_CF_TOKEN == 'true'

      - uses: actions/setup-node@v4
        if: env.HAS_CF_TOKEN == 'true'
        with:
          node-version: 22${pkg && lock ? '\n          cache: npm' : ''}
${installStep}${buildStep}
      - name: Deploy
        if: env.HAS_CF_TOKEN == 'true'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
${deploy}`;
}

/* ---------- run ---------- */

const branch = `town/${agent}`;
const repoUrl = `https://github.com/${OWNER}/${project}.git`;

console.log(`· agent ${agent} · project ${project} · ${dir}`);

if (!existsSync(join(dir, '.git'))) {
  git(['init', '-q']);
  console.log('· git init');
}
// Identity is set per-repo so the town never depends on a global git config.
git(['config', 'user.name', `${agent} (Dyer Town)`]);
git(['config', 'user.email', 'dyerbradly2@gmail.com']);

const { kind } = detectKind(dir);
if (kind !== 'none') {
  const wf = join(dir, '.github', 'workflows');
  const file = join(wf, 'deploy.yml');
  if (existsSync(file)) {
    console.log('· deploy workflow already present, left alone');
  } else {
    mkdirSync(wf, { recursive: true });
    writeFileSync(file, workflowFor(kind, project, nodeShape(dir)));
    console.log(`· wrote .github/workflows/deploy.yml (${kind})`);
  }
} else {
  console.log('· no wrangler config — nothing to deploy, skipping the workflow');
}

git(['checkout', '-B', branch]);
git(['add', '-A']);
// An empty commit is not worth pushing; a nothing-to-commit exit is fine.
try {
  git(['commit', '-q', '-m', `${agent}: publish ${project}`]);
  console.log('· committed');
} catch {
  console.log('· nothing new to commit');
}

if (dryRun) {
  console.log(`\n(dry run) would ensure ${OWNER}/${project} exists and push ${branch}`);
  process.exit(0);
}

const found = await gh(`/repos/${OWNER}/${project}`);
if (found.status === 404) {
  const made = await gh('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: project,
      private: isPrivate,
      description: `Dyer Town — ${project}, built by ${agent}`,
      auto_init: false,
    }),
  });
  if (!made.ok) die(`could not create ${OWNER}/${project}: ${made.status} ${made.body?.message || ''}`);
  console.log(`· created ${OWNER}/${project} (${isPrivate ? 'private' : 'public'})`);
} else if (!found.ok) {
  die(`could not reach ${OWNER}/${project}: ${found.status} ${found.body?.message || ''}`);
} else {
  console.log(`· ${OWNER}/${project} already exists`);
}

// Plain URL, no credentials baked in — the helper supplies them per push.
const remotes = git(['remote']).split('\n').filter(Boolean);
if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', repoUrl]);
else git(['remote', 'add', 'origin', repoUrl]);
console.log(`· origin → ${repoUrl}`);

gitAuthed(['push', '-u', 'origin', branch]);
console.log(`· pushed ${branch}`);
console.log(`\n→ open a PR: https://github.com/${OWNER}/${project}/compare/${branch}?expand=1`);
