// Web Crypto helpers for end-to-end encrypted sync.
//
// Threat model: the Worker / KV store sees only ciphertext + a hash of the
// auth token. Knowing the salt + ciphertext is useless without the passphrase.
// The derivation is intentionally slow (PBKDF2 with 600k iterations) so a
// brute-force on the auth hash stays expensive.

const PBKDF2_ITERATIONS = 600_000;
const HASH = 'SHA-256';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
  return out;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return bytesToHex(buf);
}

export function randomSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// Derive raw bytes from passphrase + salt + label. Two labels — 'auth' and
// 'data' — are used so the bearer token and the encryption key are independent.
async function deriveBits(passphrase, salt, label, byteLen) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt + ':' + label),
      iterations: PBKDF2_ITERATIONS,
      hash: HASH,
    },
    baseKey,
    byteLen * 8,
  );
}

export async function deriveKeys(passphrase, salt) {
  const [authBytes, dataBytes] = await Promise.all([
    deriveBits(passphrase, salt, 'auth', 32),
    deriveBits(passphrase, salt, 'data', 32),
  ]);
  const dataKey = await crypto.subtle.importKey(
    'raw',
    dataBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  return {
    authToken: bytesToHex(authBytes),
    dataKeyHex: bytesToHex(dataBytes),
    dataKey,
  };
}

export async function importDataKey(hex) {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(hex),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(plaintext, dataKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dataKey,
    enc.encode(plaintext),
  );
  return { iv: bytesToHex(iv), ciphertext: bytesToHex(ct) };
}

export async function decrypt(ivHex, ciphertextHex, dataKey) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    dataKey,
    hexToBytes(ciphertextHex),
  );
  return dec.decode(pt);
}
