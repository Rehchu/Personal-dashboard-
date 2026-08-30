// Client-side encryption for the sync payload. Everything a device pushes to the
// cloud is encrypted with a key derived from the sync passphrase, so D1 only ever
// holds ciphertext — the camera password and the Cloudflare Access token included.
// The passphrase never leaves the browser; without it the stored blobs are noise.
//
// Backward compatible: data written before encryption existed is plain JSON, so
// decryptData passes any non-envelope value straight through. The next push
// re-writes it encrypted. Pure crypto, no storage dependency — unit-testable on
// its own (Web Crypto is available in browsers and in Node).

const SALT = 'dyerhq-sync-v1';        // single-user account: the passphrase is the secret, the salt is just domain separation
const ITERATIONS = 100000;

const enc = new TextEncoder();
const dec = new TextDecoder();

// base64 without spreading a big array into fromCharCode (which overflows the
// call stack on large notebook payloads)
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromB64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PBKDF2(passphrase) -> AES-GCM 256 key. Non-extractable; callers memoize it.
export async function deriveKey(passphrase) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// value -> { __enc:1, iv, ct }. A fresh 96-bit IV per write, as AES-GCM requires.
export async function encryptData(cryptoKey, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(JSON.stringify(value)));
  return { __enc: 1, iv: toB64(iv), ct: toB64(ct) };
}

// { __enc:1, ... } -> original value. Anything that isn't our envelope is legacy
// plaintext and returned unchanged. A tampered/wrong-key blob throws (GCM auth
// failure), which the caller treats as "skip this collection", never as data.
export async function decryptData(cryptoKey, blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob) || blob.__enc !== 1) return blob;
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.iv) },
    cryptoKey,
    fromB64(blob.ct),
  );
  return JSON.parse(dec.decode(pt));
}

// Is this value one of our encrypted envelopes? (used only for clarity in tests)
export const isEnvelope = v => !!v && typeof v === 'object' && !Array.isArray(v) && v.__enc === 1;
