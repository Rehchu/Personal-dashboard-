// The manuscript bridge — what Draco has actually written.
//
// The Book Writing tile has always been a local editor. Meanwhile the town's
// lorekeeper commits real chapters to GitHub, and this reads them back. Draco
// writes TWO books now, so this bridges both:
//   - The Dragon Saga  (Rehchu/Dragons, branch town/draco, chapters/)
//   - Dark Assassin     (Rehchu/Dark-Assassin, town/draco then main, book-1/)
//
// Both repos are PUBLIC, so no credential is needed. GitHub's anonymous budget
// is only 60 requests an hour, though, and reading two books' worth of chapters
// on every refresh can exhaust it — which used to blank the whole view to zero.
// Two defences make that impossible now:
//   1. Chapters are cached by their git blob SHA, so an unchanged chapter is
//      never fetched twice.
//   2. The last GOOD summary of each book is persisted to D1. If a refresh is
//      ever rate-limited, the bridge serves that last-known state (marked
//      stale) instead of showing nothing.
// A token is still optional (POST /api/book/token) and raises the limit to
// 5,000/hour; it lives in the D1 secrets table and is never returned.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

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

// A stored GitHub token that has EXPIRED or been revoked is worse than no token
// at all: GitHub answers every request from a bad credential with 401 — even a
// public repo that would have served fine anonymously. That is exactly what
// silently froze this bridge on a stale cache (dead token → every fresh read
// 401s → the summary falls back to the last good state, and a chapter open just
// 404s). Both manuscripts live in PUBLIC repos, so the token is strictly a
// budget booster: the moment a tokened request comes back 401 we mark the token
// bad for the life of this isolate and retry — and make every later call —
// anonymously, so a stale token can never again break a read.
let tokenRejected = false;

const ghFetch = (path, token) => fetch(`https://api.github.com${path}`, {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'dyer-hq-book-bridge',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});

const gh = async (env, path, token) => {
  const useToken = token && !tokenRejected;
  const res = await ghFetch(path, useToken ? token : '');
  if (res.status === 401 && useToken) {
    tokenRejected = true;       // stop paying the 401 round-trip on every call
    return ghFetch(path, '');   // public repos still read fine unauthenticated
  }
  return res;
};

async function token(env) {
  const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('github_token').first();
  return row?.v || env.GITHUB_TOKEN || '';
}

export function titleOf(markdown, file) {
  const line = String(markdown).split('\n').find(l => /^#\s+\S/.test(l));
  if (line) return line.replace(/^#\s+/, '').trim().slice(0, 120);
  return file.replace(/^\d+[-_]?/, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

export function words(markdown) {
  const text = String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[#>\-*+]+\s*/gm, ' ')
    .replace(/[*_`~[\]()]/g, ' ');
  const m = text.match(/\b[\p{L}\p{N}'’-]+\b/gu);
  return m ? m.length : 0;
}

const b64 = s => {
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

// Word counts keyed by git blob sha: a chapter that has not changed since we
// last read it is never fetched again. This is what keeps the anonymous budget
// from being spent on prose that hasn't moved.
const fileCache = new Map(); // sha -> { words, title }

const EST_BYTES_PER_WORD = 5.6; // markdown prose — good enough for a live counter
const estWords = bytes => Math.max(0, Math.round((Number(bytes) || 0) / EST_BYTES_PER_WORD));

// Build a chapter/doc entry from a directory LISTING alone — no per-file fetch.
// The count of chapters is therefore always exact; each word count is estimated
// from file size, and becomes exact once that chapter has been opened (its real
// count is then cached by sha). A full refresh costs ~3 GitHub calls per book,
// so the anonymous 60/hour budget can never blank the view again — and there is
// no per-file read that could half-fail and cache an empty book as "good".
function entryFromListing(book, entry) {
  const hit = entry.sha && fileCache.get(entry.sha);
  return {
    book: book.key, path: entry.path, file: entry.name,
    title: hit?.title || titleOf('', entry.name),
    words: hit?.words ?? estWords(entry.size),
    exact: !!hit,
    bytes: entry.size, url: entry.html_url,
  };
}

// { ok: true, ...summary } on success; { ok: false, note } when rate-limited so
// the caller can fall back to the last known good state.
async function summarizeBook(env, book, tok) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };

  let branch = null, listing = null;
  for (const br of book.branches) {
    const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${book.chapterDir}?ref=${encodeURIComponent(br)}`, tok);
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0')
      return { ok: false, note: 'GitHub rate limit reached — showing the last known state.' };
    if (res.ok) { branch = br; listing = await res.json(); break; }
    // 404 (branch or directory absent) — try the next branch.
  }
  if (!branch) {
    // A private repo with no valid token 404s on its contents EXACTLY like a
    // missing directory — so probe the repo itself to tell "not started yet"
    // apart from "can't authenticate". Otherwise an expired/absent token reads
    // as "Draco wrote nothing", which is a lie: the chapters are there, we just
    // can't see them.
    const repoRes = await gh(env, `/repos/${book.owner}/${book.repo}`, tok);
    if (!repoRes.ok) {
      return { ok: false, needsToken: true,
        note: tok
          ? 'The saved GitHub token can’t read this private repo — it may be expired or missing Contents access. Paste a fresh one to read the manuscript.'
          : 'No GitHub token is set, so this private repo can’t be read yet. Paste a token with read access to see the chapters Draco has committed.' };
    }
    return { ok: true, ...base, configured: true, branch: book.branches[0],
      branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${book.branches[0]}`,
      chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 },
      note: 'Not started yet — no chapters on the working branch.' };
  }

  const files = (Array.isArray(listing) ? listing : [])
    .filter(f => f.type === 'file' && /\.md$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const chapters = files.map(f => entryFromListing(book, f));

  // The lore/plan docs live at the repo root, so ONE listing of the root
  // directory covers them all — no per-doc fetch, same budget-safe rule.
  const docs = [];
  const rootRes = await gh(env, `/repos/${book.owner}/${book.repo}/contents?ref=${encodeURIComponent(branch)}`, tok);
  if (rootRes.ok) {
    const root = await rootRes.json();
    const byName = new Map((Array.isArray(root) ? root : []).map(e => [e.name, e]));
    for (const name of book.docs) {
      const e = byName.get(name);
      if (e && e.type === 'file') docs.push(entryFromListing(book, e));
    }
  }

  let last = null;
  const commits = await gh(env, `/repos/${book.owner}/${book.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, tok);
  if (commits.ok) {
    const c = (await commits.json())[0];
    if (c) last = { message: String(c.commit?.message || '').split('\n')[0].slice(0, 140), at: c.commit?.author?.date || null, url: c.html_url };
  }

  return { ok: true, ...base, configured: true, branch,
    branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${branch}`,
    chapters, docs,
    totals: { chapters: chapters.length, words: chapters.reduce((n, c) => n + c.words, 0), loreWords: docs.reduce((n, d) => n + d.words, 0) },
    lastCommit: last };
}

const CACHE_MS = 5 * 60 * 1000;
const ANON_CACHE_MS = 15 * 60 * 1000;
const memCache = new Map(); // book.key -> { at, body }  (a GOOD body)

// The last good body of each book, persisted so it survives a Worker restart or
// redeploy — that is what stops a redeploy-plus-rate-limit from blanking the view.
async function getPersisted(env, key) {
  try {
    const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('bookcache_' + key).first();
    return row ? JSON.parse(row.v) : null;
  } catch { return null; }
}
async function setPersisted(env, key, body) {
  try {
    await env.DB.prepare("INSERT INTO secrets (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .bind('bookcache_' + key, JSON.stringify(body)).run();
  } catch { /* persistence is best-effort */ }
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
    memCache.clear();
    return json({ ok: true });
  }

  const tok = await token(env);

  if (path === '/api/book/read') {
    const bookKey = url.searchParams.get('book') || 'dragons';
    const book = BOOKS.find(b => b.key === bookKey) || BOOKS[0];
    const want = url.searchParams.get('path') || '';
    const ok = (want.startsWith(`${book.chapterDir}/`) && /^[\w./-]+\.md$/i.test(want) && !want.includes('..'))
      || book.docs.includes(want);
    if (!ok) return json({ error: 'not part of the manuscript' }, 400);
    let file = null;
    for (const br of book.branches) { file = await readFile(env, book, br, want, tok); if (file) break; }
    if (!file) return json({ error: 'could not read that file' }, 404);
    // Reading a chapter is the moment we learn its real count and title — cache
    // both by blob sha so the next summary shows them exactly instead of the
    // size estimate, without spending another request.
    const wc = words(file.text), ttl = titleOf(file.text, want);
    if (file.sha) fileCache.set(file.sha, { words: wc, title: ttl });
    return json({ book: book.key, path: want, title: ttl, words: wc, text: file.text, url: file.url });
  }

  // GET /api/book — both books, each cached, each falling back to its last good
  // state rather than ever showing zero.
  const summaries = [];
  for (const book of BOOKS) {
    const cached = memCache.get(book.key);
    if (cached && Date.now() - cached.at < (tok ? CACHE_MS : ANON_CACHE_MS)) {
      summaries.push({ ...cached.body, cached: true });
      continue;
    }
    const fresh = await summarizeBook(env, book, tok).catch(() => ({ ok: false, note: 'the manuscript bridge hit an error' }));
    if (fresh.ok) {
      const { ok, ...body } = fresh;
      memCache.set(book.key, { at: Date.now(), body });
      await setPersisted(env, book.key, body);
      summaries.push(body);
    } else {
      const good = cached?.body || await getPersisted(env, book.key);
      // Only fall back to a remembered body if it actually HAD chapters — a
      // remembered empty would just re-hide a token problem behind "0 chapters".
      if (good && good.totals && good.totals.chapters > 0) {
        summaries.push({ ...good, stale: true, note: fresh.note });
      } else {
        summaries.push({ key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}`,
          chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 },
          note: fresh.note || 'Temporarily unavailable.', needsToken: !!fresh.needsToken });
      }
    }
  }

  const primary = summaries[0] || {};
  return json({ ...primary, books: summaries });
}
