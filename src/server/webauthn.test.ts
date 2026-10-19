import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { encodeCbor, FakePasskey } from './testdaten/fake-passkey.ts';
import { b64url, decodeCbor, fromB64url, relyingParty, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.ts';

const rp = relyingParty('https://tipp.example.de');
const challenge = b64url(Buffer.alloc(32, 7));
const bytes = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fromB64url(v)])) as Record<string, Buffer>;

test('relyingParty: rpId ist der Hostname, origin ohne Pfad', () => {
  assert.deepEqual(relyingParty('https://tipp.example.de/'), { rpId: 'tipp.example.de', origin: 'https://tipp.example.de' });
  assert.deepEqual(relyingParty('http://localhost:3000'), { rpId: 'localhost', origin: 'http://localhost:3000' });
});

test('CBOR: Zahlen, Texte, Bytes, Listen, Maps', () => {
  const value = new Map<unknown, unknown>([[1, 2], [-7, 'abc'], ['x', [Buffer.from([1, 2]), 300, 70000]]]);
  const decoded = decodeCbor(encodeCbor(value as never)).value as Map<unknown, unknown>;
  assert.equal(decoded.get(1), 2);
  assert.equal(decoded.get(-7), 'abc');
  assert.deepEqual(decoded.get('x'), [Buffer.from([1, 2]), 300, 70000]);
  assert.throws(() => decodeCbor(Buffer.from([0x5a, 0, 0, 0, 9])), WebAuthnError, 'zu kurz');
  assert.throws(() => decodeCbor(Buffer.from([0x9f])), WebAuthnError, 'unbestimmte Länge');
});

test('Registrierung und Anmeldung mit einem Passkey (ES256)', () => {
  const device = new FakePasskey(rp.rpId, rp.origin);
  const created = bytes(device.create(challenge, Buffer.from('user-1')));
  const key = verifyRegistration({ clientDataJSON: created.clientDataJSON, attestationObject: created.attestationObject }, { challenge, ...rp });
  assert.equal(key.credentialId, b64url(device.id));
  assert.equal(key.alg, -7);

  const login = bytes(device.get(challenge));
  const stored = { publicKey: key.publicKey, alg: key.alg, signCount: key.signCount };
  assert.equal(verifyAssertion({ clientDataJSON: login.clientDataJSON, authenticatorData: login.authenticatorData, signature: login.signature }, stored, { challenge, ...rp }), 1);

  // Zähler, der nicht steigt → abgelehnt (kopierter Schlüssel)
  const replay = bytes(device.get(challenge, { bumpCounter: false }));
  assert.throws(
    () => verifyAssertion({ clientDataJSON: replay.clientDataJSON, authenticatorData: replay.authenticatorData, signature: replay.signature }, { ...stored, signCount: 1 }, { challenge, ...rp }),
    /Signaturzähler/,
  );
});

test('Abgelehnt: falsche Challenge, fremde Seite, ohne Nutzerprüfung, falsche Signatur', () => {
  const device = new FakePasskey(rp.rpId, rp.origin);
  const reg = (o: Parameters<FakePasskey['create']>[2], c = challenge) => {
    const r = bytes(device.create(c, Buffer.from('u'), o));
    return () => verifyRegistration({ clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject }, { challenge, ...rp });
  };
  assert.throws(reg({}, b64url(Buffer.alloc(32, 8))), /Challenge/);
  assert.throws(reg({ origin: 'https://boese.example.de' }), /Herkunft/);
  assert.throws(reg({ type: 'webauthn.get' }), /Vorgang/);
  assert.throws(reg({ flags: 0x01 }), /nicht geprüft/);

  const other = new FakePasskey('boese.example.de', rp.origin);
  const r = bytes(other.create(challenge, Buffer.from('u')));
  assert.throws(() => verifyRegistration({ clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject }, { challenge, ...rp }), /anderen Seite/);

  const key = verifyRegistration(bytes(device.create(challenge, Buffer.from('u'))) as never, { challenge, ...rp });
  const login = bytes(device.get(challenge));
  const wrongKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forged = sign('sha256', Buffer.from('irgendwas'), wrongKey.privateKey);
  assert.throws(
    () => verifyAssertion({ clientDataJSON: login.clientDataJSON, authenticatorData: login.authenticatorData, signature: forged }, { publicKey: key.publicKey, alg: key.alg, signCount: 0 }, { challenge, ...rp }),
    /Signatur ungültig/,
  );
});
