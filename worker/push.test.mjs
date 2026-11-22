// Run with: node --test (from the project folder)
import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, makeVapid } from './push.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const raw = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

// The example of RFC 8291, section 5: these keys and this salt must give exactly this body.
test('a push message is encrypted as in the example of RFC 8291', async () => {
  const asPublic = raw('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: b64(asPublic.slice(1, 33)), y: b64(asPublic.slice(33)) };
  const local = {
    privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  const phone = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const body = await encrypt(phone, 'When I grow up, I want to be a watermelon', local, raw('DGv6ra1nlYgDCS1FRnbzlw'));
  assert.equal(b64(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('a VAPID key pair gives a raw public key phones can subscribe with', async () => {
  const { jwk, key } = await makeVapid();
  assert.equal(raw(key).length, 65);
  assert.equal(jwk.crv, 'P-256');
});
