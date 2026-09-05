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
// CPU per request and a finished book is a lot of words to count. What keeps
// it small, whatever size the books grow to:
//   1. codeload honours If-None-Match. The last good summary (persisted in D1
//      with the tarball's ETag and commit) is re-validated with a conditional
//      request; an unchanged branch is a 304 with no body — nothing to gunzip
//      or count.
//   2. When the branch HAS changed, only files that changed are re-read: an
//      entry whose size and content fingerprint match the last good summary
//      keeps its title and count without being decoded at all.
//   3. Re-reading is budgeted by bytes of text per request. Past the budget, a
//      changed file is listed with an estimated count (marked inexact) and
//      the summary is flagged `converging`; the tile re-asks on its own, and
//      each later pass fills a few more counts from the raw-file CDN (one
//      small request per file, no archive to unpack) until every count is
//      exact. Only one archive is unpacked per request, across both books.
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

// Bump when the counting rule changes, so counts persisted under the old rule
// are recounted rather than mixed with new ones.
const WORDS_VERSION = 2;
// What a persisted summary was built with. If this differs, its entries are
// not reused and it is not revalidated — the book is read afresh.
const cfgOf = book => `${WORDS_VERSION}|${book.chapterDir}|${book.docs.join(',')}`;

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

// The token is optional, so a D1 hiccup here degrades to "no token" rather
// than failing a route whose primary path never touches D1.
async function token(env) {
  try {
    const row = await env.DB.prepare('SELECT v FROM secrets WHERE k = ?').bind('github_token').first();
    return row?.v || env.GITHUB_TOKEN || '';
  } catch { return env.GITHUB_TOKEN || ''; }
}

export function titleOf(markdown, file) {
  const line = String(markdown).split('\n').find(l => /^#\s+\S/.test(l));
  if (line) return line.replace(/^#\s+/, '').trim().slice(0, 120);
  return file.replace(/^\d+[-_]?/, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

// Word count as one pass over the text — a word is a run of letters, digits,
// apostrophes and hyphens that contains at least one letter or digit. A fenced
// code block (``` at the start of a line, with a closing fence somewhere
// after it) is skipped. This is the rule the old regex applied, at a fraction
// of the CPU: a finished novel counts in a few milliseconds instead of tens.
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
export function words(markdown) {
  const s = String(markdown);
  let n = 0, inWord = false, hasAlnum = false, fence = false;
  const endWord = () => { if (inWord && hasAlnum) n++; inWord = false; hasAlnum = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 96 && s.charCodeAt(i + 1) === 96 && s.charCodeAt(i + 2) === 96
        && (i === 0 || s.charCodeAt(i - 1) === 10)
        && (fence || s.indexOf('```', i + 3) !== -1)) {
      endWord(); fence = !fence; i += 2; continue;
    }
    if (fence) continue;
    let alnum, joins;
    if (c < 128) {
      alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      joins = alnum || c === 39 || c === 45;                // ' and - stay inside a word
    } else if (c >= 0x2010 && c <= 0x2030) {                // dashes, curly quotes, ellipsis — common in prose
      alnum = false;
      joins = c === 8217;                                   // ’ (curly apostrophe) joins
    } else if (c >= 0xd800 && c <= 0xdbff) {                // an astral letter is two UTF-16 units
      alnum = LETTER_OR_DIGIT.test(s.slice(i, i + 2));
      joins = alnum;
      i++;
    } else {
      alnum = LETTER_OR_DIGIT.test(s[i]);
      joins = alnum;
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

// A cheap fingerprint of a file's bytes (32-bit FNV-1a), so "unchanged" means
// the same content, not merely the same size — a one-word edit that leaves the
// byte count alone must still be re-counted. A whole novel hashes in about a
// millisecond.
function fingerprint(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

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
// Two pax records matter: the global header ('g') git archive opens with
// carries the commit id as `comment=`, and a file whose name does not fit the
// ustar fields gets an extended header ('x') carrying its real `path=`.
//
// Only the entries `want(path)` asks for keep their bytes, and nothing is
// decoded here: the caller decodes a file the moment it needs the text, so an
// unchanged chapter costs a header read and nothing more.
function walkTar(buf, want = () => true) {
  const dec = new TextDecoder();
  const str = (a, b) => dec.decode(buf.subarray(a, b)).replace(/\0[\s\S]*$/, '');
  const pax = (a, b) => {
    const out = {};
    for (const line of str(a, b).split('\n')) {
      const m = /^\d+ ([^=]+)=([\s\S]*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return out;
  };
  const files = new Map(); // repo-relative path -> { size, bytes|null }
  let top = null, off = 0, commit = '', pending = null;
  while (off + 512 <= buf.length) {
    const name = str(off, off + 100);
    if (!name) break;                                       // end-of-archive zero blocks
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = buf[off + 156];                            // '0' or NUL = regular file
    const dataStart = off + 512;
    if (type === 103) {                                     // 'g' — pax global header
      commit = pax(dataStart, dataStart + size).comment || commit;
    } else if (type === 120) {                              // 'x' — pax extended header for the NEXT entry
      pending = pax(dataStart, dataStart + size);
    } else {
      const prefix = str(off + 345, off + 500);
      const full = pending?.path || (prefix ? `${prefix}/${name}` : name);
      pending = null;
      // The top directory is the first real entry, never a pax header.
      if (top === null) top = full.split('/')[0];
      if ((type === 48 || type === 0) && full.startsWith(`${top}/`)) {
        const rel = full.slice(top.length + 1);
        if (/\.md$/i.test(rel)) files.set(rel, { size, bytes: want(rel) ? buf.subarray(dataStart, dataStart + size) : null });
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return { files, commit };
}

const textOf = f => (f.text ??= new TextDecoder().decode(f.bytes));

// Where a branch stands right now, from git's own ref advertisement — the
// same small answer a `git fetch` starts with, served by github.com with no
// API budget and no archive. '' means the branch does not exist; null means
// the answer could not be had.
const discard = res => res.body?.cancel().catch(() => {});
async function fetchRefs(book) {
  try {
    const res = await fetch(`https://github.com/${book.owner}/${book.repo}.git/info/refs?service=git-upload-pack`, { headers: { 'user-agent': UA } });
    if (!res.ok) { await discard(res); return null; }
    return await res.text();
  } catch { return null; }
}
function shaOfRef(refsText, branch) {
  if (refsText == null) return null;
  const ref = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`([0-9a-f]{40}) refs/heads/${ref}(?:\\n|$)`).exec(refsText);
  return m ? m[1] : '';
}

// The conditional request for one branch's archive. Returns { status: 304 }
// when `etag` still matches (nothing downloaded), { status } when codeload
// won't serve it (no such branch, throttled), null when unreachable, or the
// open response for the caller to unpack — or to cancel, if this request has
// no room for it. Accept-Encoding is pinned because codeload's ETag varies
// with it and the archive is never content-encoded anyway; the same ETag then
// comes back on every revalidation.
async function openTarball(book, branch, etag) {
  const url = `https://codeload.github.com/${book.owner}/${book.repo}/tar.gz/refs/heads/${branch}`;
  const headers = { 'user-agent': UA, 'accept-encoding': 'identity', ...(etag ? { 'if-none-match': etag } : {}) };
  const res = await fetch(url, { headers });
  if (res.status === 304) { await discard(res); return { status: 304 }; }
  if (!res.ok) { await discard(res); return { status: res.status }; }
  return { status: 200, etag: res.headers.get('etag') || '', res };
}

// A directory listing from github.com's own tree page, which answers as JSON
// when asked to — no API budget, and pinned to a commit it is exact. Returns
// the .md paths in that directory, or null (with the status) if the page
// would not answer or did not have the shape we know.
async function treeListing(book, ref, dir) {
  try {
    const res = await fetch(`https://github.com/${book.owner}/${book.repo}/tree/${ref}${dir ? `/${dir}` : ''}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    if (!res.ok) { await discard(res); return { status: res.status, paths: null }; }
    const j = await res.json().catch(() => null);
    const items = j?.payload?.codeViewTreeRoute?.tree?.items ?? j?.payload?.tree?.items;
    if (!Array.isArray(items)) return { status: 200, paths: null };
    return { status: 200, paths: items.filter(i => i && i.contentType === 'file' && /\.md$/i.test(String(i.name))).map(i => String(i.path)) };
  } catch { return { status: 0, paths: null }; }
}

async function unpackTarball(res, want) {
  const gz = res.body.pipeThrough(new DecompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(gz).arrayBuffer());
  return walkTar(buf, want);
}

// Chapter text from the last archive we actually decoded (or the last raw read),
// so opening a chapter that just landed costs nothing and shows the revision
// the listing was built from. Unchanged chapters are read from the raw CDN on
// demand instead.
const textCache = new Map(); // `${book.key}:${path}` -> { text, branch }

// One file from the raw CDN — no API budget, no archive. `ref` may be a
// branch (the CDN can lag a push by minutes) or a commit id (exact, always).
// Null if unavailable.
async function rawText(book, ref, path) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${book.owner}/${book.repo}/${ref}/${encodeURI(path)}`, { headers: { 'user-agent': UA } });
    if (!res.ok) { await discard(res); return null; }
    return await res.text();
  } catch { return null; }
}

// jsDelivr mirrors every public GitHub repo on its own network, with a file
// listing of its own — the one source here that needs nothing from GitHub's
// hosts at all. Pinned to a commit it is exact; addressed by branch it can
// be hours behind a push, which the summary says out loud.
async function mirrorListing(book, ref) {
  try {
    const res = await fetch(`https://data.jsdelivr.com/v1/package/gh/${book.owner}/${book.repo}@${ref}/flat`, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!res.ok) { await discard(res); return { status: res.status, files: null }; }
    const j = await res.json().catch(() => null);
    const list = Array.isArray(j?.files) ? j.files : null;
    if (!list) return { status: 200, files: null };
    const files = new Map(); // repo-relative path -> { size, mark }
    for (const f of list) {
      const name = String(f?.name || '');
      if (!name.startsWith('/') || !/\.md$/i.test(name)) continue;
      files.set(name.slice(1), { size: Number(f.size) || 0, mark: String(f.hash || '') });
    }
    return { status: 200, files };
  } catch { return { status: 0, files: null }; }
}
async function mirrorText(book, ref, path) {
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/gh/${book.owner}/${book.repo}@${ref}/${encodeURI(path)}`, { headers: { 'user-agent': UA } });
    if (!res.ok) { await discard(res); return null; }
    return await res.text();
  } catch { return null; }
}

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
// when the chapter is opened. The ratio is taken from the exact entries we
// already hold when there are any; the constant is a fallback.
const EST_BYTES_PER_WORD = 5.1;
function estimator(prev) {
  const exact = [...(prev?.chapters || []), ...(prev?.docs || [])].filter(e => e.exact && e.bytes && e.words);
  const bytes = exact.reduce((n, e) => n + e.bytes, 0), ws = exact.reduce((n, e) => n + e.words, 0);
  const ratio = bytes > 20000 && ws > 0 ? bytes / ws : EST_BYTES_PER_WORD;
  return size => Math.max(0, Math.round((Number(size) || 0) / ratio));
}
function entryEstimated(book, branch, path, file, size, hash, est) {
  return {
    book: book.key, path, file,
    title: titleOf('', file),
    words: est(size),
    exact: false,
    bytes: size,
    ...(hash ? { hash } : {}),
    url: blobUrl(book, branch, path),
  };
}
function entryFromListing(book, entry, est) {
  return {
    book: book.key, path: entry.path, file: entry.name,
    title: titleOf('', entry.name),
    words: est(entry.size),
    exact: false,
    bytes: entry.size, url: entry.html_url,
  };
}

// How much text one request will decode and count: about thirty thousand
// words, a few milliseconds even in a cold isolate. A whole novel landing at
// once converges over three or four quick passes.
const READ_BYTES = 160 * 1024;

// The last-commit line is one REST call that fails quietly under the shared
// anonymous rate limit. Try it once per revision per isolate, not every minute.
const commitTried = new Map(); // book.key -> etag it was last attempted for
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

const withCounts = (body, chapters, docs) => {
  const pending = [...chapters, ...docs].filter(e => !e.exact).length;
  const { converging, pending: _p, ...rest } = body;
  return { ...rest, chapters, docs, totals: totalsOf(chapters, docs), ...(pending ? { converging: true, pending } : {}) };
};

// A summary whose branch has not moved: refresh the stamp, drop the flags that
// described a moment, and give a zero-chapter body its note back.
function revalidatedBody(prev, checkedAt) {
  const { stale, note, cached, needsToken, ...clean } = prev;
  return { ...clean, checkedAt,
    ...(clean.chapters?.length ? {} : { note: 'Not started yet — no chapters on the working branch.' }) };
}

// Fill in estimated entries from the raw CDN, within the byte budget. Reads
// are pinned to the summary's commit when it is known, so they are exactly
// that revision; a branch read whose bytes do not match the listing's size and
// fingerprint (the CDN can lag a push by minutes) keeps its estimate for a
// later pass.
const PLAN_BYTES_UNKNOWN = 20 * 1024;   // budget planning for a file whose size is not known yet
async function fillFromRaw(book, body) {
  const branch = body.branch;
  const ref = body.commit || branch;
  const viaMirror = body.source === 'mirror';      // a summary from the mirror reads its files there too
  const read = viaMirror ? mirrorText : rawText;
  const picked = [];
  let planned = 0;
  for (const e of [...body.chapters, ...body.docs]) {
    if (e.exact) continue;
    const size = e.bytes || PLAN_BYTES_UNKNOWN;
    if (picked.length && planned + size > READ_BYTES) break;
    picked.push(e); planned += size;
  }
  if (!picked.length) return body;
  const texts = await Promise.all(picked.map(e => read(book, ref, e.path)));
  const filled = new Map();
  picked.forEach((e, i) => {
    const text = texts[i];
    if (text == null) return;
    const bytes = new TextEncoder().encode(text);
    const hash = fingerprint(bytes);
    if (!body.commit && !viaMirror && e.bytes && (bytes.length !== e.bytes || (e.hash && hash !== e.hash))) return;   // not this revision yet
    textCache.set(`${book.key}:${e.path}`, { text, branch });
    filled.set(e.path, { ...entryFromText(book, branch, e.path, e.file, text, bytes.length, hash), ...(e.mark ? { mark: e.mark } : {}) });
  });
  const swap = e => filled.get(e.path) || e;
  return withCounts(body, body.chapters.map(swap), body.docs.map(swap));
}

// { ok: true, body, fullPass?, revalidated?, changed } on success;
// { ok: true, deferred: true } when the book needs an archive unpacked and this
// request has no room left for one; { ok: false, note } when every live path
// failed so the caller can fall back to the last known good state. `prev` is
// that last good state (memory or D1), used to revalidate cheaply and to keep
// the counts of files that have not changed.
async function summarizeBook(env, book, tok, prev, { allowFull = true } = {}) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };
  const cfg = cfgOf(book);
  const chapterRe = new RegExp(`^${book.chapterDir}/[^/]+\\.md$`, 'i');
  const isManuscript = p => chapterRe.test(p) || book.docs.includes(p);
  const checkedAt = new Date().toISOString();
  const trusted = prev && prev.cfg === cfg ? prev : null;   // built the same way: its entries and ETag mean something
  const est = estimator(trusted);
  const attempts = new Set();                                // what each source answered, for the failure line
  const refsText = await fetchRefs(book);                    // one small request covers every branch
  if (refsText == null) attempts.add('git refs unreachable');

  for (const br of book.branches) {
    const sameBranch = trusted && trusted.branch === br;

    // Unchanged branch: keep everything, fill in any counts still owed.
    const unchanged = async (extra = {}) => {
      let body = { ...revalidatedBody(trusted, checkedAt), ...extra };
      const rev = body.commit || body.etag;
      if (body.lastCommit == null && commitTried.get(book.key) !== rev) {
        commitTried.set(book.key, rev);
        body.lastCommit = await lastCommitOf(env, book, br, tok);
      }
      const changed = Object.keys(extra).length > 0 || body.lastCommit !== trusted.lastCommit;
      if (!body.converging) return { ok: true, revalidated: true, changed, body };
      body = await fillFromRaw(book, body);
      return { ok: true, revalidated: true, changed: true, body };
    };

    // 0. Where the branch stands, from git itself. A summary built from this
    //    very commit needs nothing else fetched.
    const sha = shaOfRef(refsText, br);
    if (sha === '') continue;                                // no such branch — try the next
    if (sha && sameBranch && trusted.commit === sha) return unchanged();

    // 1. Tarball — the whole book in one budget-free request, or a 304 in none.
    let tar = null;
    try { tar = await openTarball(book, br, sameBranch && trusted.etag && !sha ? trusted.etag : ''); } catch { tar = null; }
    if (tar && tar.status === 404 && sha === null) continue; // codeload says no such branch, and git could not be asked
    if (tar && tar.status === 304) return unchanged();
    if (tar && tar.status === 200) {
      if (!allowFull) { await discard(tar.res); return { ok: true, deferred: true }; }
      const { files, commit } = await unpackTarball(tar.res, isManuscript);
      // Same commit under a different ETag (the header can vary with the
      // request's negotiation): nothing changed, so count nothing.
      if (sameBranch && commit && trusted.commit === commit) return unchanged({ etag: tar.etag });
      return fullPass(files, commit || sha || null, tar.etag, br);
    }
    attempts.add(`codeload ${tar ? tar.status : 'unreachable'}`);

    // 2. The tree page as JSON, pinned to the commit, with the files read from
    //    the raw CDN pinned the same way — no archive, no API budget.
    if (sha) {
      const [chapterTree, rootTree] = await Promise.all([treeListing(book, sha, book.chapterDir), treeListing(book, sha, '')]);
      const paths = chapterTree.paths;
      if (paths && (paths.length || !trusted?.chapters?.length)) {
        const known = new Map();
        for (const e of [...(trusted?.chapters || []), ...(trusted?.docs || [])]) known.set(e.path, e);
        // Nothing is known about a file from the tree page but its name, so
        // every entry starts inexact — the old count as its estimate where
        // there is one — and fillFromRaw makes them exact, budget by budget.
        const seed = (path) => {
          const file = chapterRe.test(path) ? path.slice(book.chapterDir.length + 1) : path;
          const old = known.get(path);
          return old
            ? { ...old, book: book.key, file, exact: false, hash: undefined, url: blobUrl(book, br, path) }
            : { book: book.key, path, file, title: titleOf('', file), words: 0, exact: false, bytes: 0, url: blobUrl(book, br, path) };
        };
        const chapters = paths.filter(p => chapterRe.test(p))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(seed);
        const rootPaths = new Set(rootTree.paths || []);
        const docs = book.docs.filter(name => rootPaths.has(name)).map(seed);
        let body = withCounts({ ...base, configured: true, branch: br,
          branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${br}`,
          etag: null, commit: sha, cfg, checkedAt, source: 'tree',
          ...(chapters.length ? {} : { note: 'Not started yet — no chapters on the working branch.' }) }, chapters, docs);
        body = await fillFromRaw(book, body);
        body.lastCommit = null;
        if (!body.converging) { commitTried.set(book.key, sha); body.lastCommit = await lastCommitOf(env, book, br, tok); }
        return { ok: true, changed: true, body };
      }
      attempts.add(`tree ${chapterTree.status}`);
    }

    // 3. The jsDelivr mirror: its own listing and its own copies of the files,
    //    on its own network. Pinned to the commit when git could tell us one;
    //    by branch name otherwise, which can trail a push by hours.
    {
      const ref = sha || br;
      const mirror = await mirrorListing(book, ref);
      const files = mirror.files;
      if (files && ([...files.keys()].some(p => chapterRe.test(p)) || !trusted?.chapters?.length)) {
        const known = new Map();
        for (const e of [...(trusted?.chapters || []), ...(trusted?.docs || [])]) known.set(e.path, e);
        // The mirror's own content mark says whether a file is what it was
        // last time we read it there; anything else is read again, budget by
        // budget, with the old count as its estimate meanwhile.
        const seed = (path) => {
          const f = files.get(path);
          const file = chapterRe.test(path) ? path.slice(book.chapterDir.length + 1) : path;
          const old = known.get(path);
          if (old && old.exact && old.mark && f.mark && old.mark === f.mark) return { ...old, book: book.key, file, url: blobUrl(book, br, path) };
          return old
            ? { ...old, book: book.key, file, exact: false, hash: undefined, bytes: f.size || old.bytes, mark: f.mark, url: blobUrl(book, br, path) }
            : { ...entryEstimated(book, br, path, file, f.size, undefined, est), mark: f.mark };
        };
        const chapters = [...files.keys()].filter(p => chapterRe.test(p))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(seed);
        const docs = book.docs.filter(name => files.has(name)).map(seed);
        let body = withCounts({ ...base, configured: true, branch: br,
          branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${br}`,
          etag: null, commit: sha || null, cfg, checkedAt, source: 'mirror', ...(sha ? {} : { mirrorLag: true }),
          ...(chapters.length ? {} : { note: 'Not started yet — no chapters on the working branch.' }) }, chapters, docs);
        body = await fillFromRaw(book, body);
        body.lastCommit = null;
        if (!body.converging && sha) { commitTried.set(book.key, sha); body.lastCommit = await lastCommitOf(env, book, br, tok); }
        return { ok: true, changed: true, body };
      }
      attempts.add(`mirror ${mirror.status}`);
    }
  }

  // Everything below is the REST API — the last resort.
  return restListing(env, book, tok, trusted, est, cfg, checkedAt, [...attempts]);

  async function fullPass(files, commit, etag, br) {
    // Entries whose bytes are what they were last time (same size, same
    // fingerprint) keep their exact count and title without a decode.
    // Everything else is read now, up to the budget; the remainder is
    // estimated and filled in on later passes.
    const known = new Map();
    for (const e of [...(trusted?.chapters || []), ...(trusted?.docs || [])]) if (e.exact && e.hash) known.set(e.path, e);
    let spent = 0;
    const entryFor = (path) => {
      const f = files.get(path);
      const file = chapterRe.test(path) ? path.slice(book.chapterDir.length + 1) : path;
      const hash = fingerprint(f.bytes);
      const old = known.get(path);
      if (old && old.bytes === f.size && old.hash === hash) return { ...old, book: book.key, file, url: blobUrl(book, br, path) };
      if (spent === 0 || spent + f.size <= READ_BYTES) {
        spent += f.size;
        const text = textOf(f);
        textCache.set(`${book.key}:${path}`, { text, branch: br });
        return entryFromText(book, br, path, file, text, f.size, hash);
      }
      textCache.delete(`${book.key}:${path}`);            // whatever we held is a previous revision
      return entryEstimated(book, br, path, file, f.size, hash, est);
    };
    const chapters = [...files.keys()]
      .filter(p => chapterRe.test(p))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(entryFor);
    const docs = book.docs.filter(name => files.has(name)).map(entryFor);
    const body = withCounts({ ...base, configured: true, branch: br,
      branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${br}`,
      etag, commit, cfg, checkedAt, source: 'tarball',
      ...(chapters.length ? {} : { note: 'Not started yet — no chapters on the working branch.' }) }, chapters, docs);
    // The commit line is one REST call; not worth spending while still
    // converging, and never fatal. A finished pass tries once.
    body.lastCommit = null;
    if (!body.converging) { commitTried.set(book.key, commit || etag); body.lastCommit = await lastCommitOf(env, book, br, tok); }
    return { ok: true, fullPass: true, changed: true, body };
  }
}

// 3. REST listing — only when neither the archive nor the tree page could be
//    read for any candidate branch. It is the one path with a rate limit.
async function restListing(env, book, tok, trusted, est, cfg, checkedAt, attempts) {
  const base = { key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}` };
  const tried = attempts.join(' · ');
  let branch = null, listing = null;
  for (const br of book.branches) {
    const res = await gh(env, `/repos/${book.owner}/${book.repo}/contents/${book.chapterDir}?ref=${encodeURIComponent(br)}`, tok);
    if (rateLimited(res)) return { ok: false, needsToken: true, note: `GitHub’s anonymous rate limit is spent (${tried} · api ${res.status}). A token with read access raises it.` };
    if (res.ok) { branch = br; listing = await res.json(); break; }
    await discard(res);
  }
  if (!branch) {
    // A private repo with no valid token 404s on its contents EXACTLY like a
    // missing directory — so probe the repo itself to tell "not started yet"
    // apart from "can't authenticate" apart from "GitHub is refusing us".
    const repoRes = await gh(env, `/repos/${book.owner}/${book.repo}`, tok);
    if (!repoRes.ok) {
      const rejected = tokenRejected ? ' The saved token was rejected (401) and is being ignored.' : '';
      if (repoRes.status === 404) {
        return { ok: false, needsToken: true,
          note: `GitHub says this repo does not exist for the dashboard (${tried} · api 404).${rejected} If it is private, paste a GitHub token with read access.` };
      }
      return { ok: false, needsToken: repoRes.status === 403 || repoRes.status === 429,
        note: `GitHub refused the read (${tried} · api ${repoRes.status}).${rejected}` };
    }
    return { ok: true, changed: true, body: { ...base, configured: true, branch: book.branches[0],
      branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${book.branches[0]}`,
      chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 }, cfg, checkedAt, source: 'listing',
      note: 'Not started yet — no chapters on the working branch.' } };
  }
  const files = (Array.isArray(listing) ? listing : [])
    .filter(f => f.type === 'file' && /\.md$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  // A listing carries sizes but no content, so an old count is only a good
  // guess here: keep it, marked inexact, for a file the listing shows the
  // same size. The next archive pass makes it exact again.
  const known = new Map();
  for (const e of [...(trusted?.chapters || []), ...(trusted?.docs || [])]) if (e.exact) known.set(e.path, e);
  const fromListing = f => {
    const old = known.get(f.path);
    return old && old.bytes === f.size
      ? { ...old, book: book.key, exact: false, hash: undefined, url: f.html_url }
      : entryFromListing(book, f, est);
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
  const body = withCounts({ ...base, configured: true, branch,
    branchUrl: `https://github.com/${book.owner}/${book.repo}/tree/${branch}`,
    etag: null, commit: null, cfg, checkedAt, source: 'listing' }, chapters, docs);
  // Every count here is inexact by construction; that is a listing, not a
  // convergence in progress, so don't have the tile hammer a throttled origin.
  delete body.converging; delete body.pending;
  body.listingOnly = true;
  body.lastCommit = await lastCommitOf(env, book, branch, tok);
  return { ok: true, changed: true, body };
}

// One chapter's text: the tarball cache first, then raw.githubusercontent.com
// (a CDN, no API budget), then the REST contents API as a last resort.
async function readOne(env, book, path, tok) {
  const hit = textCache.get(`${book.key}:${path}`);
  if (hit != null) return { text: hit.text, url: blobUrl(book, hit.branch, path) };
  for (const br of book.branches) {
    const text = await rawText(book, br, path);
    if (text != null) return { text, url: blobUrl(book, br, path) };
  }
  for (const br of book.branches) {
    const text = await mirrorText(book, br, path);
    if (text != null) return { text, url: blobUrl(book, br, path) };
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
// push shows up within a minute. A converging body is kept here too, with no
// serve-by time, so the next pass continues from it even if D1 is unwell.
const CACHE_MS = 60 * 1000;
const memCache = new Map(); // book.key -> { at, body }  (at = 0: hold as prev, never serve as cached)

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

const emptyBody = (book, extra) => ({
  key: book.key, title: book.title, voice: book.voice, repo: `${book.owner}/${book.repo}`,
  chapters: [], docs: [], totals: { chapters: 0, words: 0, loreWords: 0 }, ...extra,
});

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
    return json({ book: book.key, path: want, title: titleOf(file.text, want), words: words(file.text), text: file.text, url: file.url });
  }

  // GET /api/book — both books, each revalidated, each falling back to its
  // last good state rather than ever showing zero. At most one archive is
  // unpacked per request; a second book that would need one is served from
  // its last state and flagged converging, so the tile asks again in a beat.
  const summaries = [];
  let fullPassUsed = false;
  for (const book of BOOKS) {
    const cached = memCache.get(book.key);
    if (cached && cached.at && Date.now() - cached.at < CACHE_MS) {
      summaries.push({ ...cached.body, cached: true });
      continue;
    }
    const prev = cached?.body || await getPersisted(env, book.key);
    const fresh = await summarizeBook(env, book, tok, prev, { allowFull: !fullPassUsed })
      .catch(() => ({ ok: false, note: 'the manuscript bridge hit an error' }));
    if (fresh.ok && fresh.deferred) {
      summaries.push(prev && prev.totals?.chapters
        ? { ...revalidatedBody(prev, prev.checkedAt), converging: true, pending: prev.pending || 0 }
        : emptyBody(book, { converging: true, pending: 0, note: 'Reading the repo…' }));
      continue;
    }
    if (fresh.ok) {
      if (fresh.fullPass) fullPassUsed = true;
      const body = fresh.body;
      memCache.set(book.key, { at: body.converging ? 0 : Date.now(), body });
      if (fresh.changed) await setPersisted(env, book.key, body);
      summaries.push(body);
    } else {
      const good = prev;
      // Only fall back to a remembered body if it actually HAD chapters — a
      // remembered empty would just re-hide a real problem behind "0 chapters".
      if (good && good.totals && good.totals.chapters > 0) {
        const { converging, pending, ...rest } = revalidatedBody(good, good.checkedAt);
        summaries.push({ ...rest, stale: true, note: fresh.note });
      } else {
        summaries.push(emptyBody(book, { note: fresh.note || 'Temporarily unavailable.', needsToken: !!fresh.needsToken }));
      }
    }
  }

  const primary = summaries[0] || {};
  return json({ ...primary, books: summaries });
}
