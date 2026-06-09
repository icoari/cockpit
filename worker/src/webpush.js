// Web Push (RFC 8030 / 8291) — VAPID auth + aes128gcm payload encryption.
// Pure crypto.subtle implementation, no dependencies.

export async function sendWebPush({ subscription, payload, vapid, ttl = 86400, urgency = 'normal' }) {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error('Subscription invalide');
  }
  if (!vapid?.publicKey || !vapid?.privateKey || !vapid?.subject) {
    throw new Error('VAPID config manquante');
  }

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await signVapidJwt(vapid.privateKey, vapid.publicKey, audience, vapid.subject);

  const plaintext = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const uaPubRaw = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);
  const body = await encryptAes128Gcm(plaintext, uaPubRaw, authSecret);

  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(ttl),
      'Urgency': urgency,
    },
    body,
  });
  return resp;
}

// ---------- VAPID JWT (ES256) ----------

async function signVapidJwt(privateKeyB64Url, publicKeyB64Url, audience, subject) {
  const pubBytes = b64urlDecode(publicKeyB64Url);
  if (pubBytes[0] !== 0x04 || pubBytes.length !== 65) {
    throw new Error('VAPID public key invalide (attendu : point non compressé P-256, 65 octets, préfixe 0x04)');
  }
  const dBytes = b64urlDecode(privateKeyB64Url);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(dBytes),
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64urlEncode(strToBytes(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(strToBytes(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, strToBytes(unsigned));
  return `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ---------- aes128gcm encryption (RFC 8291) ----------

async function encryptAes128Gcm(plaintext, uaPubRaw, authSecret) {
  // Ephemeral keypair on the sender side.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256,
  ));
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // PRK_key = HKDF-Extract(auth_secret, shared)
  const prkKey = await hkdfExtract(authSecret, sharedSecret);
  // info1 = "WebPush: info\0" || ua_pub || as_pub
  const keyInfo = concat(strToBytes('WebPush: info'), new Uint8Array([0]), uaPubRaw, asPubRaw);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // salt = random(16); PRK = HKDF-Extract(salt, IKM)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);

  const cekBytes = await hkdfExpand(prk, concat(strToBytes('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce    = await hkdfExpand(prk, concat(strToBytes('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['encrypt']);

  // Pad with the single-record terminator (0x02) at the end.
  const recordSize = 4096;
  const maxPlain = recordSize - 16 - 1;
  if (plaintext.length > maxPlain) throw new Error('Payload trop volumineux');
  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext, 0);
  padded[plaintext.length] = 0x02;

  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, padded));

  // Binary header: salt(16) || rs(4 BE) || idlen(1) || keyid(idlen)
  const header = new Uint8Array(16 + 4 + 1 + asPubRaw.length);
  header.set(salt, 0);
  header[16] = (recordSize >>> 24) & 0xFF;
  header[17] = (recordSize >>> 16) & 0xFF;
  header[18] = (recordSize >>> 8)  & 0xFF;
  header[19] = (recordSize)        & 0xFF;
  header[20] = asPubRaw.length;
  header.set(asPubRaw, 21);

  const out = new Uint8Array(header.length + ct.length);
  out.set(header, 0);
  out.set(ct, header.length);
  return out;
}

// HKDF-Extract = HMAC-SHA256(salt, IKM)
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

// HKDF-Expand for output ≤ 32 bytes (single block).
async function hkdfExpand(prk, info, len) {
  if (len > 32) throw new Error('hkdfExpand: multi-block not implemented');
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = concat(info, new Uint8Array([0x01]));
  const t1 = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  return t1.slice(0, len);
}

// ---------- utils ----------

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function strToBytes(s) { return new TextEncoder().encode(s); }

function b64urlEncode(buf) {
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
