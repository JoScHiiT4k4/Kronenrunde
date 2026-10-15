import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';

import { encryptPayload, validEndpoint, vapidJwt, type Vapid } from './webpush.ts';

test('Push-Nachricht lässt sich mit dem Schlüssel des Geräts entschlüsseln (RFC 8291)', () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const msg = Buffer.from(JSON.stringify({ title: 'Tipps fehlen', body: 'ä ö ü' }));
  const out = encryptPayload(msg, ua.getPublicKey().toString('base64url'), auth.toString('base64url'));

  const salt = out.subarray(0, 16);
  assert.equal(out.readUInt32BE(16), 4096);
  const idlen = out[20];
  const asPublic = out.subarray(21, 21 + idlen);
  const cipher = out.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(plain.subarray(0, plain.length - 1).toString(), msg.toString());
});

test('VAPID-Token ist mit dem öffentlichen Schlüssel prüfbar', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Vapid['privateJwk'];
  const vapid: Vapid = { publicKey: '', privateJwk: jwk };
  const jwt = vapidJwt(vapid, 'https://push.example.com', 'mailto:a@b.de', 1_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { aud: 'https://push.example.com', exp: 1000 + 43200, sub: 'mailto:a@b.de' });
  const pub = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('Nur öffentliche https-Adressen sind als Push-Ziel erlaubt', () => {
  assert.ok(validEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  for (const bad of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://pi.local/x', 'nonsense'])
    assert.equal(validEndpoint(bad), false, bad);
});
