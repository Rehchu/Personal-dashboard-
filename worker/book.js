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
// So the primary path is a repository TARBALL from codeload.github.com: one
// request per book returns the complete chapter directory AND every chapter's
// text, with no API rate limit and no token. Chapter counts and word counts
// are therefore always exact. The REST API is only used for the last-commit
// line (non-fatal if it fails) and as a fallback listing if codeload is
// unreachable. A token is still optional (POST /api/book/token) — it only
// raises the REST budget for that last-commit call; it lives in the D1 secrets
// table and is never returned.
//
// The work per request is BOUNDED, because a Worker gets a few milliseconds of
// CPU per request and a finished book is a lot of words to count. Three things
// keep it small, whatever size the books grow to:
//   1. codeload honours If-None-Match. The last good summary (persisted in D1
//      with the tarball's ETag) is re-validated with a conditional request; an
//      unchanged branch is a 304 with no body — nothing to gunzip or count.
//   2. When the branch HAS changed, only files that changed are re-read: an
//      entry whose path and size match the last good summary keeps its title
//      and count without being decoded at all.
//   3. Re-reading is budgeted per request. Past the budget, a changed file is
//      listed with an estimated count (marked inexact) and the summary is
//      flagged `converging`; the next request picks up where this one stopped,
//      and the tile re-asks on its own until every count is exact.
// The last GOOD summary of each book is served (marked stale, with the reason)
// if every live path fails, so the view never drops to zero because of a
// transient upstream problem.

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

// Word count as one pass over the text — a word is a run of letters, digits,
// apostrophes and hyphens that contains at least one letter or digit; fenced
// code blocks are skipped. This is the same rule the old regex applied and it
// gives the same counts on every chapter of both books, at a fraction of the
// CPU: a finished novel counts in a few milliseconds instead of tens.
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
export function words(markdown) {
  const s = String(markdown);
  let n = 0, inWord = false, hasAlnum = false, fence = false;
  const endWord = () => { if (inWord && hasAlnum) n++; inWord = false; hasAlnum = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 96 && s.charCodeAt(i + 1) === 96 && s.charCodeAt(i + 2) === 96) { // ``` toggles a code fence
      endWord(); fence = !fence; i += 2; continue;
    }
    if (fence) continue;
    let alnum, joins;
    if (c < 128) {
      alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      joins = alnum || c === 39 || c === 45;                // ' and - stay inside a word
    } else {
      alnum = LETTER_OR_DIGIT.test(s[i]);
      joins = alnum || c === 8217;                          // ’ (curly apostrophe) too
    }
    if (joins) { inWord = true; if (alnum) hasAlnum = true; } else endWord();
  }
  endWord();
  return n;
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
//
// Only the entries `want(path)` asks for keep their bytes, and nothing is
// decoded here: the caller decodes a file the moment it needs the text, so an
// unchanged chapter costs a header read and nothing more.
function walkTar(buf, want = () => true) {
  const dec = new TextDecoder();
  const str = (a, b) => dec.decode(buf.subarray(a, b)).replace(/\0[\s\S]*$/, '');
  const files = new Map(); // repo-relative path -> { size, bytes|null }
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
      if (/\.md$/i.test(rel)) files.set(rel, { size, bytes: want(rel) ? buf.subarray(dataStart, dataStart + size) : null });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

const textOf = f => (f.text ??= new TextDecoder().decode(f.bytes));

// A cheap fingerprint of a file's bytes (32-bit FNV-1a), so "unchanged" means
// the same content, not merely the same size — a one-word edit that leaves the
// byte count alone must still be re-counted. A whole novel hashes in about a
// millisecond.
function fingerprint(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// One branch's tarball: { status: 304 } when `etag` still matches (nothing was
// downloaded), { status: 200, etag, files } for a fresh archive, or null when
// codeload can't serve it (no such branch, throttled, unreachable).
async function fetchTarball(book, branch, etag, want) {
  const url = `https://codeload.github.com/${book.owner}/${book.repo}/tar.gz/refs/heads/${branch}`;
  const headers = { 'user-agent': UA, ...(etag ? { 'if-none-match': etag } : {}) };
  const res = await fetch(url, { headers });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) return null;
  const gz = res.body.pipeThrough(new DecompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(gz).arrayBuffer());
  return { status: 200, etag: res.headers.get('etag') || '', files: walkTar(buf, want) };
}

// Chapter text from the last tarball we actually decoded, so opening a chapter
// that just landed costs nothing and shows the revision the listing was built
// from. Unchanged chapters are read from the raw CDN on demand instead.
const textCache = new Map(); // `${book.key}:${path}` -> text

const blobUrl = (book, branch, path) => `https://github.com/${book.owner}/${book.repo}/blob/${branch}/${path}`;

function entryFromText(book, branch, path, file, text, size, hash) {
  return {
    book: book.key, path, file,
    title: titleOf(text, file),
    words: words(text),
    exact: true,
    bytes: size,
    ...(hash ? { hash } : {}),
    url: blobUrl(book, branch, path),
  };
}

// The size-based estimate: for the REST-listing fallback and for a changed
// file past this request's read budget. It becomes exact on a later pass or
// when the chapter is opened.
const EST_BYTES_PER_WORD = 5.6;
const estWords = bytes => Math.max(0, Math.round((Number(bytes) || 0) / EST_BYTES_PER_WORD));
function entryEstimated(book, branch, path, file, size) {
  return {
    book: book.key, path, file,
    title: titleOf('', file),
    words: estWords(size),
    exact: false,
    bytes: size,
    url: blobUrl(book, branch, path),
  };
}
function entryFromListing(book, entry) {
  return {
    book: book.key, path: entry.path, file: entry.name,
    title: titleOf('', entry.name),
    words: estWords(entry.size),
    exact: false,
    bytes: entry.size, url: entry.html_url,
  };
}

// How many changed files one request will decode and count. Twelve chapters
// is a whole act of a novel — comfortably inside a request's CPU allowance —
// and a book that lands all at once converges in two or three passes.
const READ_BUDGET = 12;

async function lastCommitOf(env, book, branch, tok) {
  try {
    const commits = await gh(env, `/repos/${book.owner}/${book.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, tok);
    if (!commits.ok) return null;
    const c = (await commits.json())[0];
    return c ? { message: String(c.commit?.message || '').split('\n')[0].slice(0, 140), at: c.commit?.author?.date || null, url: c.html_url } : null;
  } catch { return null; }
}

const totalsOf = (chapters, docs) => ({
  chapters: chapters.length,
  words: chapters.reduce((n, c) => n + c.words, 0),
  loreWords: docs.reduce((n, d) => n + d.words, 0),
});

// { ok: true, ...summary } on success; { ok: false, note } when every live path
// failed so the caller can fall back to the last known good state. `prev` is
// that last good state (memory or D1), used to revalidate cheaply and to keep
// the counts of files that have not changed.
async function summarizeBook(env, book, tok, prev) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };
  const chapterRe = new RegExp(`^${book.chapterDir}/[^/]+\\.md$`, 'i');
  const isManuscript = p => chapterRe.test(p) || book.docs.includes(p);
  const checkedAt = new Date().toISOString();

  // 1. Tarball — the whole book in one budget-free request, or a 304 in none.
  for (const br of book.branches) {
    // Revalidate only a COMPLETE summary of this same branch: a converging one
    // must fetch the archive again to keep counting.
    const canRevalidate = prev && prev.branch === br && prev.etag && !prev.converging;
    let tar = null;
    try { tar = await fetchTarball(book, br, canRevalidate ? prev.etag : '', isManuscript); } catch { tar = null; }
    if (!tar) continue;                                     // branch absent or codeload down — try the next
    if (tar.status === 304) {
      const { stale, note, cached, ...clean } = prev;       // the flags describe a moment, not the book
      return { ok: true, ...clean, checkedAt };
    }
    const { files, etag } = tar;

    // Entries whose bytes are what they were last time (same size, same
    // fingerprint) keep their exact count and title without a decode.
    // Everything else is read now, up to the budget; the remainder is
    // estimated and picked up next pass.
    const known = new Map();
    for (const e of [...(prev?.chapters || []), ...(prev?.docs || [])]) if (e.exact && e.hash) known.set(e.path, e);
    let budget = READ_BUDGET, deferred = 0;
    const entryFor = (path) => {
      const f = files.get(path);
      const file = chapterRe.test(path) ? path.slice(book.chapterDir.length + 1) : path;
      const hash = fingerprint(f.bytes);
      const old = known.get(path);
      if (old && old.bytes === f.size && old.hash === hash) return { ...old, book: book.key, file, url: blobUrl(book, br, path) };
      if (budget > 0) {
        budget--;
        const text = textOf(f);
        textCache.set(`${book.key}:${path}`, text);
        return entryFromText(book, br, path, file, text, f.size, hash);
      }
      deferred++;
      return entryEstimated(book, br, path, file, f.size);
    };
    const chapters = [...files.keys()]
      .filter(p => chapterRe.test(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(entryFor);
    const docs = book.docs.filter(name => files.has(name)).map(entryFor);
    const converging = deferred > 0;
    return { ok: true, ...base, configured: true, branch: br,
      branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${br}`,
      chapters, docs,
      totals: totalsOf(chapters, docs),
      etag, checkedAt,
      ...(converging ? { converging: true, pending: deferred } : {}),
      // The commit line is one REST call; not worth spending while still
      // converging, and never fatal. A finished pass tries once.
      lastCommit: converging ? null : await lastCommitOf(env, book, br, tok),
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
      chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 }, checkedAt,
      note: 'Not started yet — no chapters on the working branch.' };
  }
  const files = (Array.isArray(listing) ? listing : [])
    .filter(f => f.type === 'file' && /\.md$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // Keep exact counts we already have for files the listing shows unchanged.
  const known = new Map();
  for (const e of [...(prev?.chapters || []), ...(prev?.docs || [])]) if (e.exact) known.set(e.path, e);
  const fromListing = f => {
    const old = known.get(f.path);
    return old && old.bytes === f.size ? { ...old, book: book.key, url: f.html_url } : entryFromListing(book, f);
  };
  const chapters = files.map(fromListing);
  const docs = [];
  const rootRes = await gh(env, `/repos/${book.owner}/${book.repo}/contents?ref=${encodeURIComponent(branch)}`, tok);
  if (rootRes.ok) {
    const root = await rootRes.json();
    const byName = new Map((Array.isArray(root) ? root : []).map(e => [e.name, e]));
    for (const name of book.docs) {
      const e = byName.get(name);
      if (e && e.type === 'file') docs.push(fromListing(e));
    }
  }
  return { ok: true, ...base, configured: true, branch,
    branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${branch}`,
    chapters, docs,
    totals: totalsOf(chapters, docs),
    etag: null, checkedAt,
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

// A revalidation is one conditional request that usually answers 304 with no
// body, so the in-memory copy only needs to cover a burst of tile loads — a
// push shows up within a minute.
const CACHE_MS = 60 * 1000;
const memCache = new Map(); // book.key -> { at, body }  (a GOOD, complete body)

// The last good body of each book, persisted so it survives a Worker restart or
// redeploy — that is what stops a redeploy-plus-outage from blanking the view,
// and what carries the ETag and per-file counts between isolates.
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

  // GET /api/book — both books, each revalidated, each falling back to its
  // last good state rather than ever showing zero.
  const summaries = [];
  for (const book of BOOKS) {
    const cached = memCache.get(book.key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      summaries.push({ ...cached.body, cached: true });
      continue;
    }
    const prev = cached?.body || await getPersisted(env, book.key);
    const fresh = await summarizeBook(env, book, tok, prev).catch(() => ({ ok: false, note: 'the manuscript bridge hit an error' }));
    if (fresh.ok) {
      const { ok, ...body } = fresh;
      // A converging body is progress, not a resting state: persist it so the
      // next pass continues from here, but don't let it sit in memory for a
      // minute — the tile is about to ask again.
      if (!body.converging) memCache.set(book.key, { at: Date.now(), body });
      else memCache.delete(book.key);
      await setPersisted(env, book.key, body);
      summaries.push(body);
    } else {
      const good = prev;
      // Only fall back to a remembered body if it actually HAD chapters — a
      // remembered empty would just re-hide a real problem behind "0 chapters".
      if (good && good.totals && good.totals.chapters > 0) {
        const { converging, pending, ...rest } = good;
        summaries.push({ ...rest, stale: true, note: fresh.note, needsToken: !!fresh.needsToken });
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
