// Live camera video, proxied. MediaMTX on the sound-booth Mac turns each
// camera's RTSP feed into low-latency HLS on localhost:8888; the church tunnel
// publishes that as stream.myfaithtech.com behind Cloudflare Access. Browsers
// can't present a service token, so the player fetches playlists and segments
// from THIS route instead, and the Worker attaches the stored Access token —
// the same one the PTZ proxy uses, pasted once and kept in the secrets table.
//
// Not an open proxy: the upstream is a single fixed origin, the path shape is
// pinned to what an HLS player legitimately asks for, and nothing else passes.

const STREAM_BASE = 'https://stream.myfaithtech.com';

// {stream}/{file} — stream names are the short camera labels MediaMTX is
// configured with (cam1..); files are HLS playlists and media segments only.
const STREAM_RE = /^\/api\/stream\/([a-z0-9_-]{1,24})\/([A-Za-z0-9_.-]{1,80}\.(?:m3u8|mp4|m4s|ts))$/;

// LL-HLS players poll with these; anything else is dropped from the query
const QUERY_OK = new Set(['_HLS_msn', '_HLS_part', '_HLS_skip']);

export async function handleStream(url, request, env, { getCamAccess }) {
  const m = url.pathname.match(STREAM_RE);
  if (!m) return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });

  const upstream = new URL(`${STREAM_BASE}/${m[1]}/${m[2]}`);
  for (const [k, v] of url.searchParams) if (QUERY_OK.has(k)) upstream.searchParams.set(k, v);

  const headers = {};
  const access = await getCamAccess(env);
  if (access) {
    headers['CF-Access-Client-Id'] = access.id;
    headers['CF-Access-Client-Secret'] = access.secret;
  }

  let res;
  try {
    res = await fetch(upstream.toString(), { headers, signal: AbortSignal.timeout(15000) });
  } catch {
    return new Response(JSON.stringify({ error: 'stream source unreachable' }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
  }

  const playlist = m[2].endsWith('.m3u8');
  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type')
        || (playlist ? 'application/vnd.apple.mpegurl' : 'video/mp4'),
      // playlists change every second; segments never change once named
      'cache-control': playlist ? 'no-store' : 'private, max-age=3600',
    },
  });
}
