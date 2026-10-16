import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, base32Encode, generateBackupCodes, generateTotpSecret, hashBackupCode, totpCode, totpProvisioningUri, totpValid } from './totp.ts';

test('base32: Hin- und Rückweg ergibt wieder die Ausgangsbytes', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'Hallo Welt!']) {
    const bytes = Buffer.from(text, 'utf8');
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('base32: nur Großbuchstaben A–Z und Ziffern 2–7, keine Füllzeichen', () => {
  const encoded = base32Encode(Buffer.from('ein Secret mit 20 Byte!'));
  assert.match(encoded, /^[A-Z2-7]+$/);
  assert.doesNotMatch(encoded, /=/);
});

test('generateTotpSecret: 16 Byte (128 Bit, das Minimum nach RFC 4226), jedes Mal anders', () => {
  const a = generateTotpSecret();
  const b = generateTotpSecret();
  assert.notEqual(a, b);
  assert.equal(base32Decode(a).length, 16);
});

test('totpCode/totpValid: der aktuell erzeugte Code wird akzeptiert', () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.ok(totpValid(secret, code));
});

test('totpValid: lehnt einen falschen Code ab', () => {
  const secret = generateTotpSecret();
  const code = totpCode(secret);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.ok(!totpValid(secret, wrong));
});

test('totpValid: toleriert ±1 Zeitschritt (Uhr-Abweichung), aber nicht ±2', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const prevStep = totpCode(secret, now - 30_000);
  assert.ok(totpValid(secret, prevStep, now));
  const twoStepsAgo = totpCode(secret, now - 60_000);
  // Nur wenn der 2-Schritte-Code nicht zufällig gleich einem der ±1-Codes ist
  if (twoStepsAgo !== totpCode(secret, now) && twoStepsAgo !== prevStep) {
    assert.ok(!totpValid(secret, twoStepsAgo, now));
  }
});

test('totpValid: lehnt Codes ab, die keine 6 Ziffern sind', () => {
  const secret = generateTotpSecret();
  assert.ok(!totpValid(secret, '12345'));
  assert.ok(!totpValid(secret, 'abcdef'));
  assert.ok(!totpValid(secret, ''));
});

test('totpProvisioningUri: otpauth://-URI mit Secret, Ausgeber und Konto im Label', () => {
  const uri = totpProvisioningUri('JBSWY3DPEHPK3PXP', 'ben@example.de', 'Kronenrunde');
  assert.equal(uri, 'otpauth://totp/Kronenrunde%3Aben%40example.de?secret=JBSWY3DPEHPK3PXP');
});

test('totpProvisioningUri: bleibt auch bei langer E-Mail-Adresse kurz genug für unseren QR-Encoder (max. Version 6)', () => {
  const uri = totpProvisioningUri(generateTotpSecret(), 'ziemlich.lange.spielername@example.de', 'Kronenrunde');
  assert.ok(new TextEncoder().encode(uri).length <= 106, `${uri.length} Byte`);
});

test('generateBackupCodes: acht unterschiedliche Codes im Format XXXX-XXXX', () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
});

test('hashBackupCode: Groß-/Kleinschreibung und Bindestriche spielen keine Rolle', () => {
  const a = hashBackupCode('ABCD-2345');
  const b = hashBackupCode('abcd2345');
  const c = hashBackupCode('abcd-2345');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('hashBackupCode: unterschiedliche Codes ergeben unterschiedliche Hashes', () => {
  assert.notEqual(hashBackupCode('ABCD-2345'), hashBackupCode('ABCD-2346'));
});
