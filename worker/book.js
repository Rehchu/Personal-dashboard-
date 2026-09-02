// The manuscript bridge — what Draco has actually written.
//
// The Book Writing tile has always been a local editor: you type, it saves to
// this browser. Meanwhile the town's lorekeeper has been committing real
// chapters to GitHub, and the dashboard had no idea. This reads those repos
// through the GitHub API and hands the tile a summary.
//
// Draco writes TWO books now, so this bridges both:
//   - The Dragon Saga  (Rehchu/Dragons, branch town/draco, chapters/)
//   - Dark Assassin     (Rehchu/Dark-Assassin, branch town/draco, book-1/)
// Both repos are PUBLIC, so no credential is needed and the tile works out of
// the box. A token is optional: set one and the rate limit goes from GitHub's
// 60 requests an hour for anonymous callers to 5,000. When present it stays in
// the D1 secrets table beside the camera credentials and is never returned by
// any route — which is also why this runs in the Worker, not the browser.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Each book: where it lives, which branch(es) to try (Draco's working branch
// first, then the default so a freshly-merged seed still shows), where its
// chapters live, and which supporting files are the bible rather than prose.
const BOOKS = [
  {
    key: 'dragons', title: 'The Dragon Saga', voice: 'chronicle',
    owner: 'Rehchu', repo: 'Dragons', branches: ['town/draco'],
    chapterDir: 'chapters',
    docs: ['LORE.md', 'LORE_TIMELINE.md', 'TIMELINE.md', 'GAP-MAP.md', 'AUDIT.md'],
  },
  {
    key: 'dark-assassin', title: 'Dark Assassin', voice: 'contemporary',
    owner: 'Rehchu', repo: 'Dark-Assassin', branches: ['town/draco', 'main'],
    chapterDir: 'book-1',
    docs: ['README.md', 'PLAN.md'],
  },
];

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

async function readFile(env, book, branch, path, tok) {
  const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`, tok);
  if (!res.ok) return null;
  const j = await res.json();
  if (j?.encoding !== 'base64' || typeof j.content !== 'string') return null;
  return { text: b64(j.content), size: j.size, sha: j.sha, url: j.html_url };
}

// Summarise one book: find the first branch that actually has its chapter
// directory, then count the prose and the bible. A book Draco has not started
// is not an error — it is a book with no chapters yet, and says so.
async function summarizeBook(env, book, tok) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };

  let branch = null;
  let listing = null;
  for (const br of book.branches) {
    const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${book.chapterDir}?ref=${encodeURIComponent(br)}`, tok);
    if (res.status === 403 && !tok) {
      return { ...base, branch: book.branches[0], chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 }, rateLimited: true, note: 'GitHub rate-limited this anonymous request. It resets within the hour, or add a token to raise the limit.' };
    }
    if (res.ok) { branch = br; listing = await res.json(); break; }
    // 404 just means "not on that branch" — try the next one.
  }

  if (!branch) {
    return { ...base, branch: book.branches[0], branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${book.branches[0]}`, chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 }, note: 'Not started yet — no chapters on the working branch.' };
  }

  const files = (Array.isArray(listing) ? listing : [])
    .filter(f => f.type === 'file' && /\.md$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const chapters = [];
  for (const f of files) {
    const file = await readFile(env, book, branch, f.path, tok);
    if (!file) continue;
    chapters.push({ book: book.key, path: f.path, file: f.name, title: titleOf(file.text, f.name), words: words(file.text), bytes: file.size, url: file.url });
  }

  const docs = [];
  for (const name of book.docs) {
    const file = await readFile(env, book, branch, name, tok);
    if (file) docs.push({ book: book.key, path: name, file: name, words: words(file.text), bytes: file.size, url: file.url });
  }

  let last = null;
  const commits = await gh(env, `/repos/${book.owner}/${book.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, tok);
  if (commits.ok) {
    const c = (await commits.json())[0];
    if (c) last = { message: String(c.commit?.message || '').split('\n')[0].slice(0, 140), at: c.commit?.author?.date || null, url: c.html_url };
  }

  return {
    ...base,
    configured: true,
    branch,
    branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${branch}`,
    chapters,
    docs,
    totals: { chapters: chapters.length, words: chapters.reduce((n, c) => n + c.words, 0), loreWords: docs.reduce((n, d) => n + d.words, 0) },
    lastCommit: last,
  };
}

// A full refresh costs a dozen API calls per book. Anonymous callers get 60 an
// hour, so cache far longer when there is no token to spend. Cached per book.
const CACHE_MS = 5 * 60 * 1000;
const ANON_CACHE_MS = 15 * 60 * 1000;
const caches = new Map(); // book.key -> { at, body }

export async function handleBook(url, request, env) {
  const path = url.pathname;

  if (path === '/api/book/token' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const t = String(body?.token || '').trim();
    if (t.length < 20 || t.length > 300) return json({ error: 'that does not look like a token' }, 400);
    await env.DB.prepare(
      `INSERT INTO secrets (k, v) VALUES ('github_token', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(t).run();
    caches.clear();
    return json({ ok: true });
  }

  // No token is not an error: the repos are public. It only means a smaller rate
  // budget, which the longer cache below absorbs.
  const tok = await token(env);

  if (path === '/api/book/read') {
    const bookKey = url.searchParams.get('book') || 'dragons';
    const book = BOOKS.find(b => b.key === bookKey) || BOOKS[0];
    const want = url.searchParams.get('path') || '';
    // Only ever inside that book's manuscript: no traversal, no reaching other repos.
    const ok = (want.startsWith(`${book.chapterDir}/`) && /^[\w./-]+\.md$/i.test(want) && !want.includes('..'))
      || book.docs.includes(want);
    if (!ok) return json({ error: 'not part of the manuscript' }, 400);
    let file = null;
    for (const br of book.branches) { file = await readFile(env, book, br, want, tok); if (file) break; }
    if (!file) return json({ error: 'could not read that file' }, 404);
    return json({ book: book.key, path: want, title: titleOf(file.text, want), words: words(file.text), text: file.text, url: file.url });
  }

  // GET /api/book — both books, each cached independently.
  const summaries = [];
  for (const book of BOOKS) {
    const cached = caches.get(book.key);
    if (cached && Date.now() - cached.at < (tok ? CACHE_MS : ANON_CACHE_MS)) {
      summaries.push({ ...cached.body, cached: true });
      continue;
    }
    const body = await summarizeBook(env, book, tok);
    caches.set(book.key, { at: Date.now(), body });
    summaries.push(body);
  }

  // Return both under `books`, and spread the primary (the saga) at the top
  // level so any older caller that reads d.totals / d.chapters still works.
  const primary = summaries[0] || {};
  return json({ ...primary, books: summaries });
}
