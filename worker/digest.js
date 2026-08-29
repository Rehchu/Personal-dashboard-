// HTTP Digest authentication (RFC 7616) for talking to the cameras.
//
// PTZOptics firmware answers Basic with a flat 401 and offers Digest instead:
//
//   www-authenticate: Digest realm="ignored-for-authn-tkt", charset="UTF-8",
//                     algorithm="SHA-256", nonce="…", qop="auth"
//
// so the Worker has to speak it. crypto.subtle covers SHA-256; it has no MD5,
// which older firmware still uses, so MD5 is implemented here.

/* ---------- MD5 (RFC 1321) ---------- */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i += 1) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export function md5(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = msg.length;
  // message + 0x80 + zero padding + 8-byte little-endian bit length, to a multiple of 64
  const padded = new Uint8Array(((((len + 8) >> 6) + 1) << 6));
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = len * 8;
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  for (let off = 0; off < padded.length; off += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + view.getInt32(off + g * 4, true)) | 0;
      a = d; d = c; c = b;
      const s = MD5_S[i];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  let out = '';
  for (const word of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i += 1) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

/* ---------- challenge parsing ---------- */

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// Pull the Digest challenge out of a WWW-Authenticate header. A server may
// offer several schemes in one header, so read from the Digest token onward and
// keep the FIRST value for each key — a later "Basic realm=…" must not overwrite
// the realm we are about to hash.
export function parseDigestChallenge(header) {
  if (typeof header !== 'string') return null;
  const at = header.search(/(^|[,\s])Digest\s/i);
  if (at < 0) return null;
  const rest = header.slice(header.toLowerCase().indexOf('digest', Math.max(0, at)) + 6);
  const params = {};
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let m = re.exec(rest);
  while (m) {
    const key = m[1].toLowerCase();
    if (!(key in params)) {
      params[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
      // PTZOptics sends algorithm="SHA-256" quoted, which the spec says is a
      // bare token. Keep the form it used so the echo back is byte-for-byte
      // what its own parser expects.
      if (key === 'algorithm') params.algorithmRaw = m[0].slice(m[0].indexOf('=') + 1).trim();
    }
    m = re.exec(rest);
  }
  return params.nonce ? params : null;
}

// MD5 and SHA-256 only. SHA-512-256 is not SHA-512 truncated — it uses different
// initial values and crypto.subtle cannot produce it — so it is refused rather
// than answered with a wrong hash the camera would reject anyway.
export async function digestHash(algorithm, text) {
  const algo = String(algorithm || 'MD5').toUpperCase().replace(/-SESS$/, '');
  if (algo === 'MD5') return md5(text);
  if (algo === 'SHA-256') {
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }
  return null;
}

const quote = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/* ---------- response ---------- */

// Build the Authorization header for one request. `uri` is the request-target
// exactly as it goes on the wire (path plus query) — hashing anything else
// makes the camera reject a response that is otherwise correct.
export async function digestAuthHeader({ user, pass = '', method = 'GET', uri, challenge, nc = 1, cnonce }) {
  if (!challenge?.nonce) return null;
  const algorithm = challenge.algorithm || 'MD5';
  const sess = /-SESS$/i.test(algorithm);
  const realm = challenge.realm || '';

  let ha1 = await digestHash(algorithm, `${user}:${realm}:${pass}`);
  if (ha1 === null) return null;

  // qop may be a list ("auth,auth-int"); we implement auth only
  const offered = String(challenge.qop || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const useQop = offered.length === 0 || offered.includes('auth');
  if (!useQop) return null; // auth-int only: would need the request body hashed

  const ncHex = String(nc).padStart(8, '0');
  const clientNonce = cnonce || hex(crypto.getRandomValues(new Uint8Array(8)));
  if (sess) ha1 = await digestHash(algorithm, `${ha1}:${challenge.nonce}:${clientNonce}`);

  const ha2 = await digestHash(algorithm, `${method}:${uri}`);
  const hasQop = offered.includes('auth');
  const response = await digestHash(
    algorithm,
    hasQop
      ? `${ha1}:${challenge.nonce}:${ncHex}:${clientNonce}:auth:${ha2}`
      : `${ha1}:${challenge.nonce}:${ha2}`,
  );

  const parts = [
    `username=${quote(user)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithmRaw || challenge.algorithm}`);
  if (hasQop) parts.push('qop=auth', `nc=${ncHex}`, `cnonce=${quote(clientNonce)}`);
  if (challenge.opaque) parts.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}
