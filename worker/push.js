// Web Push from the Kassa server with nothing but WebCrypto: the message is encrypted for the one phone that
// subscribed (RFC 8291), and the request is signed with the server's VAPID key (RFC 8292), which the push service
// (Apple's, on an iPhone) checks. The push service sees neither the text nor the household's data.

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);
  return out;
};
async function hkdf(salt, secret, info, length) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// A new VAPID key pair: the server keeps the private half; phones subscribe with the public half (raw, base64url).
export async function makeVapid() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), key: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

// The body of one message for a phone's subscription { p256dh, auth }, in the aes128gcm format.
// `local` (an ECDH key pair) and `salt` are fresh every time; the tests pass the ones of the RFC's example.
export async function encrypt(phone, text, local, salt = crypto.getRandomValues(new Uint8Array(16))) {
  local ??= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const theirs = fromB64u(phone.p256dh);
  const ours = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const them = await crypto.subtle.importKey('raw', theirs, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: them }, local.privateKey, 256));
  const secret = await hkdf(fromB64u(phone.auth), shared, join(enc.encode('WebPush: info\0'), theirs, ours), 32);
  const key = await crypto.subtle.importKey('raw', await hkdf(salt, secret, enc.encode('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt']);
  const iv = await hkdf(salt, secret, enc.encode('Content-Encoding: nonce\0'), 12);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, join(enc.encode(text), new Uint8Array([2])))); // 2: the last record
  return join(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([ours.length]), ours, box); // record size 4096
}

// Sends `message` ({ title, body }) to one phone. Resolves with the push service's status: 404 and 410 mean the
// phone turned notifications off.
export async function send(phone, message, vapid, subject) {
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (value) => b64u(enc.encode(JSON.stringify(value)));
  const claims = { aud: new URL(phone.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: subject };
  const signed = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const signature = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signed)));
  const response = await fetch(phone.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${signed}.${signature}, k=${vapid.key}`,
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(24 * 60 * 60),
    },
    body: await encrypt(phone, JSON.stringify(message)),
  });
  return response.status;
}
