// Server-side background import.
//
// The owner generates a video on Higgsfield and wants it in the dashboard's
// background gallery. Rather than the phone downloading that file and pushing it
// back up through the multipart uploader, the Worker pulls it straight from the
// source into the SAME R2 bucket + index a normal upload lands in, so it becomes
// an ordinary gallery item with a fresh id. A still lands the same way — the
// Gaming tile points this at a game's cover or an unlocked achievement icon —
// so image/* is accepted alongside video/*, on its own much smaller ceiling.
//
// This is deliberately NOT an open proxy. Exactly like serveIcon's ICON_HOSTS
// and the camera endpoint's host gate in index.js, only a tight allowlist of
// hosts may be fetched — every other host is refused before any request leaves
// the Worker, so a signed-in session can never turn this into an SSRF pivot.

const MAX_IMPORT = 200 * 1024 * 1024;        // 200 MB ceiling; a generated loop is only a few MB
const MAX_IMPORT_IMAGE = 25 * 1024 * 1024;   // stills need far less: box art / a trophy icon is KBs
const IMPORT_TIMEOUT_MS = 30000;             // a stalled source must not hang the request forever

// The only content types that may be stored. Deliberately a fixed set, not a
// wildcard — see the note at the type check in handleBgImport for why SVG in
// particular must never be on it.
const IMPORT_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime',
  'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif',
]);

// Match index.js's json(): JSON body, never cached.
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

// The only hosts this endpoint will fetch. CloudFront is where Higgsfield serves
// the finished render; *.higgsfield.ai (and higgsfield.ai itself) covers the
// app's own delivery hosts in case a share link points there instead.
function importHostAllowed(host) {
  const h = host.toLowerCase();
  if (h === 'd8j0ntlcm91z4.cloudfront.net') return true;
  if (h === 'higgsfield.ai' || h.endsWith('.higgsfield.ai')) return true;
  // console art, so a game cover or an unlocked achievement can become a
  // background: Microsoft's store/Live image CDNs and Sony's trophy CDNs
  if (h === 'store-images.s-microsoft.com') return true;
  if (h.endsWith('.xboxlive.com')) return true;
  if (h === 'image.api.playstation.com') return true;
  if (h.endsWith('.playstation.net')) return true;
  return false;
}

// handleBgImport is handed the gallery's own storage helpers (readBgIndex /
// writeBgIndex / newBgId / bgKey / cleanBgName / MAX_BACKGROUNDS) rather than
// importing them from index.js. That keeps the two modules free of a circular
// import and means the import writes through the exact same compare-and-set
// index path an upload uses — one source of truth for the gallery.
export async function handleBgImport(request, env, deps) {
  const { readBgIndex, writeBgIndex, newBgId, bgKey, cleanBgName, MAX_BACKGROUNDS } = deps;

  const body = await request.json().catch(() => null);
  const raw = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!raw) return json({ error: 'expected { url }' }, 400);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'not a valid URL' }, 400);
  }
  // https only, and only a host we vet — both checked before any fetch goes out
  if (target.protocol !== 'https:') return json({ error: 'only https URLs are allowed' }, 400);
  if (target.username || target.password) return json({ error: 'credentials in the URL are not allowed' }, 400);
  if (!importHostAllowed(target.hostname)) return json({ error: 'that host is not on the import allowlist' }, 400);

  // the gallery has a ceiling; refuse before pulling bytes we would only reject
  const { index } = await readBgIndex(env);
  if (index.items.length >= MAX_BACKGROUNDS) {
    return json({ error: `the gallery holds ${MAX_BACKGROUNDS} backgrounds — delete one first` }, 409);
  }

  let res;
  try {
    res = await fetch(target.toString(), {
      redirect: 'follow',
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      headers: { accept: 'video/*,image/*,*/*' },
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return json({ error: timedOut ? 'the source took too long to answer' : 'could not reach the source' }, 502);
  }
  if (!res.ok || !res.body) return json({ error: `source returned ${res.status}` }, 502);

  // require a real video or image type — this endpoint stores backgrounds, not
  // arbitrary bytes. A still is a background too: game art or an unlocked
  // achievement icon is exactly what the Gaming tile sends here.
  //
  // The list is an ALLOWLIST of raster/clip types rather than a `image/*`
  // pattern, because /media/bg/<id> serves these bytes back from the
  // dashboard's OWN origin with the type recorded here. `image/svg+xml` is a
  // document, not a picture: it can carry <script>, and served same-origin that
  // is stored XSS with a session behind it. SVG never becomes a background.
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMPORT_TYPES.has(type)) {
    return json({ error: 'that URL did not return a supported video or image' }, 415);
  }
  // a still gets a much smaller ceiling than a clip; both messages name the kind
  // that was actually fetched so the toast reads true
  const isImage = type.startsWith('image/');
  const kind = isImage ? 'image' : 'video';
  const limit = isImage ? MAX_IMPORT_IMAGE : MAX_IMPORT;
  const tooBig = () => json({ error: `${kind} is larger than ${limit / (1024 * 1024)} MB` }, 413);
  // reject up front when the source declares an oversized length; the real check
  // is after the stream lands, since the header can be absent or wrong
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) return tooBig();

  // Stream straight into R2 — never buffer a 200 MB clip in the Worker's memory —
  // then read back the true size R2 stored. The contentType can only be set at
  // put time, so it is declared here from the vetted response type.
  const id = newBgId();
  const key = bgKey(id);
  let obj;
  try {
    obj = await env.MEDIA.put(key, res.body, { httpMetadata: { contentType: type } });
  } catch {
    return json({ error: `could not store the imported ${kind}` }, 502);
  }
  // the cap is only truly known once the whole stream is assembled
  if ((obj?.size ?? 0) > limit) {
    await env.MEDIA.delete(key);
    return tooBig();
  }
  if (!obj?.size) {
    await env.MEDIA.delete(key);
    return json({ error: 'the source sent no data' }, 502);
  }

  // name it from the request, else from the file's own name in the URL path
  const fromUrl = decodeURIComponent(target.pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const name = cleanBgName(body?.name || fromUrl, 'Imported background');

  const next = await writeBgIndex(env, i => {
    // a retried import must not create a second entry (id is fresh per call, but
    // guard anyway, mirroring the mpu/complete path)
    if (i.items.some(it => it.id === id)) return null;
    i.items.unshift({ id, key, name, type, bytes: obj.size, added: Date.now() });
    i.selected = id; // a background you just imported is the one you want to see
    return i;
  });

  return json({ ok: true, id, bytes: obj.size, index: next });
}
