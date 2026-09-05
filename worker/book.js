// The manuscript bridge — what Draco has actually written.
//
// The Book Writing tile has always been a local editor. Meanwhile the town's
// lorekeeper commits real chapters to GitHub, and this reads them back. Draco
// writes TWO books now, so this bridges both:
//   - The Dragon Saga  (Rehchu/Dragons, branch town/draco, chapters/)
//   - Dark Assassin     (Rehchu/Dark-Assassin, town/draco then main, book-1/)
//
// Both repos are PUBLIC, and that is the whole design: the bridge never NEEDS
// a GitHub credential. It used to read through the REST API, which was fragile
// in two ways that each blanked the tile to zero at some point — the anonymous
// budget is only 60 requests an hour per IP (and a Worker's egress IP is shared
// with the rest of Cloudflare, so it is often already spent), and an EXPIRED
// saved token makes GitHub answer 401 to everything, even public content.
//
// So the primary path is now a repository TARBALL from codeload.github.com:
// one request per book returns the complete chapter directory AND every
// chapter's text, with no API rate limit and no token. Chapter counts and word
// counts are therefore always exact, and opening a chapter is served from the
// text we already hold. The REST API is only used for the last-commit line
// (non-fatal if it fails) and as a fallback listing if codeload is unreachable.
// A token is still optional (POST /api/book/token) — it only raises the REST
// budget for that last-commit call; it lives in the D1 secrets table and is
// never returned. The last GOOD summary of each book is persisted to D1 and
// served (marked stale) if every live path fails, so the view never drops to
// zero because of a transient upstream problem.

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

const UA = 'dyer-hq-book-bridge';

// ---------------------------------------------------------------------------
// GitHub REST — used only for the last-commit line and as a listing fallback.
//
// A stored token that has expired or been revoked is worse than no token at
// all: GitHub answers every request from a bad credential with 401, even a
// public repo that would have served fine anonymously. So the token is treated
// as strictly optional: the moment a tokened request comes back 401 we mark it
// bad for the life of this isolate and retry — and make every later call —
// anonymously.
let tokenRejected = false;

const ghFetch = (path, token) => fetch(`https://api.github.com${path}`, {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': UA,
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

const rateLimited = res =>
  (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';

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

// ---------------------------------------------------------------------------
// Tarball reader — the primary path.
//
// codeload.github.com serves a gzipped tar of any public branch with no API
// budget at all. A minimal ustar walk is all we need: 512-byte headers, the
// name at 0..100, the octal size at 124..136, the type flag at 156, and the
// ustar path prefix at 345..500. Every entry — regular file or not, pax header
// or not — is skipped by advancing over its size rounded up to the block, so
// we never misread a header. The archive's top directory is "<repo>-<ref>",
// which is stripped so paths match the repo ("chapters/01-foo.md").
function walkTar(buf) {
  const dec = new TextDecoder();
  const str = (a, b) => dec.decode(buf.subarray(a, b)).replace(/\0[\s\S]*$/, '');
  const files = new Map(); // repo-relative path -> { text, size }
  let top = null, off = 0;
  while (off + 512 <= buf.length) {
    const name = str(off, off + 100);
    if (!name) break;                                       // end-of-archive zero blocks
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = buf[off + 156];                            // '0' or NUL = regular file
    const prefix = str(off + 345, off + 500);
    const full = prefix ? `${prefix}/${name}` : name;
    const dataStart = off + 512;
    // The archive opens with a pax global header (type 'g', no slash) — the
    // top directory is the first REAL entry, never that one or a pax 'x'.
    if (top === null && type !== 103 && type !== 120) top = full.split('/')[0];
    if ((type === 48 || type === 0) && top !== null && full.startsWith(`${top}/`)) {
      const rel = full.slice(top.length + 1);
      if (/\.md$/i.test(rel)) files.set(rel, { text: dec.decode(buf.subarray(dataStart, dataStart + size)), size });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

// { files } for the first branch that exists, or null if codeload can't serve
// the book (unreachable, or no such branch on any candidate).
async function fetchTarball(book, branch) {
  const url = `https://codeload.github.com/${book.owner}/${book.repo}/tar.gz/refs/heads/${branch}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) return null;
  const gz = res.body.pipeThrough(new DecompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(gz).arrayBuffer());
  return walkTar(buf);
}

// Chapter text from the last tarball, so opening a chapter costs nothing and
// always shows the same revision the listing was built from.
const textCache = new Map(); // `${book.key}:${path}` -> text

function entryFromText(book, branch, path, file, text, size) {
  return {
    book: book.key, path, file,
    title: titleOf(text, file),
    words: words(text),
    exact: true,
    bytes: size,
    url: `https://github.com/${book.owner}/${book.repo}/blob/${branch}/${path}`,
  };
}

// The REST-listing fallback keeps the old size-based estimate so the tile
// still shows a count if codeload is unreachable; it becomes exact once the
// chapter is opened.
const EST_BYTES_PER_WORD = 5.6;
const estWords = bytes => Math.max(0, Math.round((Number(bytes) || 0) / EST_BYTES_PER_WORD));
function entryFromListing(book, entry) {
  return {
    book: book.key, path: entry.path, file: entry.name,
    title: titleOf('', entry.name),
    words: estWords(entry.size),
    exact: false,
    bytes: entry.size, url: entry.html_url,
  };
}

async function lastCommitOf(env, book, branch, tok) {
  try {
    const commits = await gh(env, `/repos/${book.owner}/${book.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, tok);
    if (!commits.ok) return null;
    const c = (await commits.json())[0];
    return c ? { message: String(c.commit?.message || '').split('\n')[0].slice(0, 140), at: c.commit?.author?.date || null, url: c.html_url } : null;
  } catch { return null; }
}

// { ok: true, ...summary } on success; { ok: false, note } when every live path
// failed so the caller can fall back to the last known good state.
async function summarizeBook(env, book, tok) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };
  const chapterRe = new RegExp(`^${book.chapterDir}/[^/]+\\.md$`, 'i');

  // 1. Tarball — the whole book in one budget-free request.
  for (const br of book.branches) {
    let files = null;
    try { files = await fetchTarball(book, br); } catch { files = null; }
    if (!files) continue;                                   // branch absent or codeload down — try the next
    const chapters = [...files.entries()]
      .filter(([p]) => chapterRe.test(p))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([p, f]) => entryFromText(book, br, p, p.slice(book.chapterDir.length + 1), f.text, f.size));
    const docs = book.docs
      .filter(name => files.has(name))
      .map(name => entryFromText(book, br, name, name, files.get(name).text, files.get(name).size));
    for (const [p, f] of files) textCache.set(`${book.key}:${p}`, f.text);
    return { ok: true, ...base, configured: true, branch: br,
      branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${br}`,
      chapters, docs,
      totals: { chapters: chapters.length, words: chapters.reduce((n, c) => n + c.words, 0), loreWords: docs.reduce((n, d) => n + d.words, 0) },
      lastCommit: await lastCommitOf(env, book, br, tok),
      ...(chapters.length ? {} : { note: 'Not started yet — no chapters on the working branch.' }) };
  }

  // 2. REST listing — only if codeload could not serve any candidate branch.
  let branch = null, listing = null;
  for (const br of book.branches) {
    const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${book.chapterDir}?ref=${encodeURIComponent(br)}`, tok);
    if (rateLimited(res)) return { ok: false, note: 'GitHub rate limit reached — showing the last known state.' };
    if (res.ok) { branch = br; listing = await res.json(); break; }
  }
  if (!branch) {
    // A private repo with no valid token 404s on its contents EXACTLY like a
    // missing directory — so probe the repo itself to tell "not started yet"
    // apart from "can't authenticate".
    const repoRes = await gh(env, `/repos/${book.owner}/${book.repo}`, tok);
    if (!repoRes.ok) {
      return { ok: false, needsToken: true,
        note: tok
          ? 'The saved GitHub token can’t read this repo — it may be expired or missing Contents access. Paste a fresh one to read the manuscript.'
          : 'This repo can’t be read right now. If it is private, paste a GitHub token with read access to see the chapters Draco has committed.' };
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
  return { ok: true, ...base, configured: true, branch,
    branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${branch}`,
    chapters, docs,
    totals: { chapters: chapters.length, words: chapters.reduce((n, c) => n + c.words, 0), loreWords: docs.reduce((n, d) => n + d.words, 0) },
    lastCommit: await lastCommitOf(env, book, branch, tok) };
}

// One chapter's text: the tarball cache first, then raw.githubusercontent.com
// (a CDN, no API budget), then the REST contents API as a last resort.
async function readOne(env, book, path, tok) {
  const hit = textCache.get(`${book.key}:${path}`);
  if (hit != null) return { text: hit, url: null };
  for (const br of book.branches) {
    const res = await fetch(`https://raw.githubusercontent.com/${book.owner}/${book.repo}/${br}/${encodeURI(path)}`, { headers: { 'user-agent': UA } });
    if (res.ok) return { text: await res.text(), url: `https://github.com/${book.owner}/${book.repo}/blob/${br}/${path}` };
  }
  for (const br of book.branches) {
    const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(br)}`, tok);
    if (!res.ok) continue;
    const j = await res.json();
    if (j?.encoding === 'base64' && typeof j.content === 'string') return { text: b64(j.content), url: j.html_url };
  }
  return null;
}

const CACHE_MS = 5 * 60 * 1000;
const memCache = new Map(); // book.key -> { at, body }  (a GOOD body)

// The last good body of each book, persisted so it survives a Worker restart or
// redeploy — that is what stops a redeploy-plus-outage from blanking the view.
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
    tokenRejected = false;      // a fresh token deserves a fresh try
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
    const file = await readOne(env, book, want, tok).catch(() => null);
    if (!file) return json({ error: 'could not read that file' }, 404);
    return json({ book: book.key, path: want, title: titleOf(file.text, want), words: words(file.text), text: file.text,
      url: file.url || `https://github.com/${book.owner}/${book.repo}/blob/${book.branches[0]}/${want}` });
  }

  // GET /api/book — both books, each cached, each falling back to its last good
  // state rather than ever showing zero.
  const summaries = [];
  for (const book of BOOKS) {
    const cached = memCache.get(book.key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
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
      // remembered empty would just re-hide a real problem behind "0 chapters".
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
