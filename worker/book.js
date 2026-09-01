// The manuscript bridge — what Draco has actually written.
//
// The Book Writing tile has always been a local editor: you type, it saves to
// this browser. Meanwhile the town's lorekeeper has been committing real
// chapters to Rehchu/Dragons on branch town/draco, and the dashboard had no
// idea. Four chapters and a lore bible existed with nothing to show for them.
//
// This reads that branch through the GitHub API and hands the tile a summary.
//
// Rehchu/Dragons is a PUBLIC repo, so no credential is needed and the tile
// works out of the box. A token is optional: set one and the rate limit goes
// from GitHub's 60 requests an hour for anonymous callers to 5,000, and the
// bridge keeps working if the repo is ever made private. When a token is
// present it stays in the D1 secrets table beside the camera credentials and is
// never returned by any route — which is also why this runs in the Worker
// rather than the browser.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const OWNER = 'Rehchu';
const REPO = 'Dragons';
const BRANCH = 'town/draco';
const CHAPTER_DIR = 'chapters';

// Draco's own working notes live beside the prose. They are worth listing —
// a lore bible IS the work — but they are not chapters and must not be counted
// as though the book were longer than it is.
const DOC_FILES = ['LORE.md', 'LORE_TIMELINE.md', 'TIMELINE.md', 'GAP-MAP.md', 'AUDIT.md'];

// A full refresh costs roughly a dozen API calls. Anonymous callers get 60 an
// hour from GitHub, so cache far longer when there is no token to spend.
const CACHE_MS = 5 * 60 * 1000;
const ANON_CACHE_MS = 15 * 60 * 1000;
let cache = null; // { at, body }

// The authorization header is omitted entirely when there is no token — sending
// `Bearer ` with nothing after it makes GitHub reject the request outright,
// which would be a worse failure than simply being anonymous.
const gh = (env, path, token) => fetch(`https://api.github.com${path}`, {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'dyer-hq-book-bridge',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});

async function token(env) {
  const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('github_token').first();
  return row?.v || env.GITHUB_TOKEN || '';
}

// "# The Ashford Breach" -> "The Ashford Breach"; falls back to the filename so
// a chapter always has something to show even before it has a heading.
export function titleOf(markdown, file) {
  const line = String(markdown).split('\n').find(l => /^#\s+\S/.test(l));
  if (line) return line.replace(/^#\s+/, '').trim().slice(0, 120);
  return file.replace(/^\d+[-_]?/, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

// Prose word count: strip fenced code and markdown syntax first, so headings and
// emphasis markers do not inflate the number a writer is watching.
export function words(markdown) {
  const text = String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[#>\-*+]+\s*/gm, ' ')
    .replace(/[*_`~[\]()]/g, ' ');
  const m = text.match(/\b[\p{L}\p{N}'’-]+\b/gu);
  return m ? m.length : 0;
}

const b64 = s => {
  // GitHub wraps base64 at 60 chars; atob rejects the newlines.
  const bin = atob(String(s).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

async function readFile(env, path, tok) {
  const res = await gh(env, `/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(BRANCH)}`, tok);
  if (!res.ok) return null;
  const j = await res.json();
  if (j?.encoding !== 'base64' || typeof j.content !== 'string') return null;
  return { text: b64(j.content), size: j.size, sha: j.sha, url: j.html_url };
}

export async function handleBook(url, request, env) {
  const path = url.pathname;

  if (path === '/api/book/token' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const t = String(body?.token || '').trim();
    if (t.length < 20 || t.length > 300) return json({ error: 'that does not look like a token' }, 400);
    await env.DB.prepare(
      `INSERT INTO secrets (k, v) VALUES ('github_token', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(t).run();
    cache = null;
    return json({ ok: true });
  }

  // No token is not an error: the repo is public. It only means a smaller rate
  // budget, which the longer cache below absorbs.
  const tok = await token(env);

  if (path === '/api/book/read') {
    const want = url.searchParams.get('path') || '';
    // Only ever inside the manuscript: no traversal, no reaching other repos.
    const ok = (want.startsWith(`${CHAPTER_DIR}/`) && /^[\w./-]+\.md$/i.test(want) && !want.includes('..'))
      || DOC_FILES.includes(want);
    if (!ok) return json({ error: 'not part of the manuscript' }, 400);
    const file = await readFile(env, want, tok);
    if (!file) return json({ error: 'could not read that file' }, 404);
    return json({ path: want, title: titleOf(file.text, want), words: words(file.text), text: file.text, url: file.url });
  }

  if (cache && Date.now() - cache.at < (tok ? CACHE_MS : ANON_CACHE_MS)) {
    return json({ ...cache.body, cached: true });
  }

  const listRes = await gh(env, `/repos/${OWNER}/${REPO}/contents/${CHAPTER_DIR}?ref=${encodeURIComponent(BRANCH)}`, tok);
  if (listRes.status === 404) {
    return json({ configured: true, repo: `${OWNER}/${REPO}`, branch: BRANCH, chapters: [], docs: [], totals: { chapters: 0, words: 0 }, note: 'no chapters/ directory on that branch yet' });
  }
  if (listRes.status === 403 && !tok) {
    // Anonymous callers get 60 an hour. Say so plainly rather than reporting a
    // bare 403, which reads like a permissions problem and is not one.
    return json({ error: 'GitHub rate-limited this anonymous request. It resets within the hour, or POST a token to /api/book/token to raise the limit.' }, 429);
  }
  if (!listRes.ok) return json({ error: `github said ${listRes.status}` }, 502);

  const listing = await listRes.json();
  const files = (Array.isArray(listing) ? listing : [])
    .filter(f => f.type === 'file' && /\.md$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const chapters = [];
  for (const f of files) {
    const file = await readFile(env, f.path, tok);
    if (!file) continue;
    chapters.push({
      path: f.path,
      file: f.name,
      title: titleOf(file.text, f.name),
      words: words(file.text),
      bytes: file.size,
      url: file.url,
    });
  }

  // The supporting bible, listed but counted separately from the prose.
  const docs = [];
  for (const name of DOC_FILES) {
    const file = await readFile(env, name, tok);
    if (file) docs.push({ path: name, file: name, words: words(file.text), bytes: file.size, url: file.url });
  }

  let last = null;
  const commits = await gh(env, `/repos/${OWNER}/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&per_page=1`, tok);
  if (commits.ok) {
    const c = (await commits.json())[0];
    if (c) last = { message: String(c.commit?.message || '').split('\n')[0].slice(0, 140), at: c.commit?.author?.date || null, url: c.html_url };
  }

  const body = {
    configured: true,
    repo: `${OWNER}/${REPO}`,
    branch: BRANCH,
    branchUrl: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    chapters,
    docs,
    totals: {
      chapters: chapters.length,
      words: chapters.reduce((n, c) => n + c.words, 0),
      loreWords: docs.reduce((n, d) => n + d.words, 0),
    },
    lastCommit: last,
  };
  cache = { at: Date.now(), body };
  return json(body);
}
