// Sharing: one copy of the cards and bank data on the Kassa server, locked on the phone before it leaves.
// The server keeps locked bytes and never sees a key.
//
// The household has one random key. It locks the data, and a token made from it proves to the server that a
// phone belongs to the household. Each person's passkey (Face ID, kept in iCloud Keychain) gives a second key
// through the passkey's PRF extension; that key locks a copy of the household key, which the server keeps, so
// a new iPhone with the same passkey gets back in. An invite code locks one more copy for a day, until the
// invited phone has its own.

export const SERVER = 'https://kassa-sync.kassa-bf5a04.workers.dev';

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const SALT = enc.encode('kassa-household-v1'); // fixed: the same passkey must give the same key every time
export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// base64url without padding; built in chunks, as one call per byte would overflow the stack on large data
export function b64u(bytes) {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let at = 0; at < view.length; at += 0x8000) text += String.fromCharCode(...view.subarray(at, at + 0x8000));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const fromB64u = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const squeeze = async (text) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const unsqueeze = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

// An AES key for one purpose, made from a secret: the purpose (`info`) keeps the keys of one secret apart.
async function aes(secret, info) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode(info) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function lock(key, bytes) {
  const iv = rand(12);
  const box = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + box.length);
  out.set(iv);
  out.set(box, iv.length);
  return out;
}
const unlock = async (key, bytes) => new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));

// What a phone shows the server to be let in: made from the household key, so only the household has it.
export async function tokenOf(household) {
  const base = await subtle.importKey('raw', household, 'HKDF', false, ['deriveBits']);
  return hex(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: enc.encode('kassa auth') }, base, 256));
}
export const sealData = async (household, json) => b64u(await lock(await aes(household, 'kassa data'), await squeeze(json)));
export const openData = async (household, text) => unsqueeze(await unlock(await aes(household, 'kassa data'), fromB64u(text)));
// The household key, locked with a passkey's key ('kassa wrap') or an invite code ('kassa invite').
export const wrap = async (secret, info, household) => b64u(await lock(await aes(secret, info), household));
export const unwrap = async (secret, info, text) => unlock(await aes(secret, info), fromB64u(text));
// The server finds an invite by this; the code itself never reaches it.
export const inviteId = async (code) => hex(await subtle.digest('SHA-256', enc.encode(code)));
export const isCode = (text) => /^[\w-]{22}$/.test(text); // 16 random bytes

// ---------- passkeys ----------

// Makes a new passkey with Face ID. `secret` is its key when the phone hands it out at once, else null:
// then usePasskey(cred) gets it with a second Face ID.
export async function makePasskey() {
  const made = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Kassa' },
    user: { id: rand(16), name: 'Kassa', displayName: 'Kassa' },
    challenge: rand(32), // the server checks no signature: the key itself is the proof, so the challenge is not kept
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: { eval: { first: SALT } } },
  } });
  const prf = made.getClientExtensionResults().prf;
  if (prf?.enabled === false) throw Object.assign(new Error('no prf'), { code: 'noprf' });
  return { cred: b64u(made.rawId), secret: prf?.results?.first ? new Uint8Array(prf.results.first) : null };
}

// Face ID with a passkey that exists: `cred` picks it, else the phone lets the person choose.
export async function usePasskey(cred) {
  const got = await navigator.credentials.get({ publicKey: {
    challenge: rand(32),
    userVerification: 'required',
    allowCredentials: cred ? [{ type: 'public-key', id: fromB64u(cred) }] : [],
    extensions: { prf: { eval: { first: SALT } } },
  } });
  const first = got.getClientExtensionResults().prf?.results?.first;
  if (!first) throw Object.assign(new Error('no prf'), { code: 'noprf' });
  return { cred: b64u(got.rawId), secret: new Uint8Array(first) };
}

// ---------- the server ----------

// Calls the server; resolves with its JSON answer, or null for "nothing new". Throws with `status` when refused.
export async function api(method, path, { token, body } = {}) {
  const response = await fetch(SERVER + path, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    cache: 'no-store',
  });
  if (response.status === 204) return null;
  if (response.ok) return response.json();
  throw Object.assign(new Error(`server ${response.status}`), { status: response.status });
}

// ---------- joining two phones' changes ----------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = (list) => Array.isArray(list) && list.every((item) => isObject(item) && typeof item.id === 'string');

// Joins two copies of the same data that were both changed since `base`: `mine` (this phone) and `theirs`
// (the server). What one side changed is kept; lists of items with an id are joined item by item, so a card
// added here and a transaction sorted there both stay. Where both sides changed the same value, mine wins.
export function merge(base, mine, theirs) {
  if (same(mine, theirs) || same(theirs, base)) return mine;
  if (same(mine, base)) return theirs;
  if (byId(mine) && byId(theirs) && (base === undefined || byId(base))) {
    const index = (list) => new Map((list ?? []).map((item) => [item.id, item]));
    const [was, here, there] = [index(base), index(mine), index(theirs)];
    return [...new Set([...here.keys(), ...there.keys()])]
      .map((id) => merge(was.get(id), here.get(id), there.get(id)))
      .filter((item) => item !== undefined);
  }
  if (isObject(mine) && isObject(theirs)) {
    const out = {};
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = merge(isObject(base) ? base[key] : undefined, mine[key], theirs[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return mine;
}
