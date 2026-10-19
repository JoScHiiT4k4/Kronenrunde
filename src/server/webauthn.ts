// Passkeys (WebAuthn Level 2): Anmelden ohne Passwort und ohne Code aus der Authenticator-App.
// Kein npm-Paket verfügbar, daher von Hand – nur der Teil, den ein Server wirklich braucht:
//   - Registrierung: clientDataJSON prüfen, attestationObject (CBOR) zerlegen, öffentlichen
//     Schlüssel (COSE) übernehmen. Die Attestierung selbst prüfen wir nicht (wie attestation: 'none').
//   - Anmeldung: clientDataJSON und authenticatorData prüfen, Signatur mit dem gespeicherten Schlüssel.
// Unterstützt ES256 (fast alle Geräte), EdDSA und RS256 (ältere Windows Hello).

import { createHash, createPublicKey, type KeyObject, timingSafeEqual, verify } from 'node:crypto';

export const ALG_ES256 = -7;
export const ALG_EDDSA = -8;
export const ALG_RS256 = -257;
export const SUPPORTED_ALGS = [ALG_ES256, ALG_EDDSA, ALG_RS256];

const FLAG_UP = 0x01; // Nutzer war anwesend (Berührung/Klick)
const FLAG_UV = 0x04; // Nutzer wurde geprüft (Fingerabdruck, Gesicht, PIN) – ersetzt den zweiten Faktor
const FLAG_AT = 0x40; // enthält einen neuen Schlüssel

export class WebAuthnError extends Error {}

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new WebAuthnError('Ungültige Kodierung');
  return Buffer.from(value, 'base64url');
}

// --- CBOR (RFC 8949), nur was attestationObject und COSE-Schlüssel brauchen ---

type Cbor = number | bigint | Buffer | string | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** Liest genau ein CBOR-Element ab `offset`; gibt den Wert und das Ende zurück. */
export function decodeCbor(buf: Buffer, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 16) throw new WebAuthnError('CBOR zu tief verschachtelt');
  const need = (n: number) => {
    if (offset + n > buf.length) throw new WebAuthnError('CBOR unvollständig');
  };
  need(1);
  const first = buf[offset++];
  const major = first >> 5;
  const info = first & 0x1f;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) {
    need(1);
    len = buf[offset];
    offset += 1;
  } else if (info === 25) {
    need(2);
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    need(4);
    len = buf.readUInt32BE(offset);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const big = buf.readBigUInt64BE(offset);
    offset += 8;
    if (major === 0) return { value: big, end: offset };
    if (major === 1) return { value: -1n - big, end: offset };
    throw new WebAuthnError('CBOR-Länge zu groß');
  } else throw new WebAuthnError('CBOR mit unbestimmter Länge wird nicht unterstützt');

  switch (major) {
    case 0:
      return { value: len, end: offset };
    case 1:
      return { value: -1 - len, end: offset };
    case 2:
      need(len);
      return { value: Buffer.from(buf.subarray(offset, offset + len)), end: offset + len };
    case 3:
      need(len);
      return { value: buf.toString('utf8', offset, offset + len), end: offset + len };
    case 4: {
      const arr: Cbor[] = [];
      for (let i = 0; i < len; i++) {
        const item = decodeCbor(buf, offset, depth + 1);
        arr.push(item.value);
        offset = item.end;
      }
      return { value: arr, end: offset };
    }
    case 5: {
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(buf, offset, depth + 1);
        const v = decodeCbor(buf, k.end, depth + 1);
        map.set(k.value, v.value);
        offset = v.end;
      }
      return { value: map, end: offset };
    }
    case 7:
      if (info === 20) return { value: false, end: offset };
      if (info === 21) return { value: true, end: offset };
      if (info === 22) return { value: null, end: offset };
      if (info === 23) return { value: undefined, end: offset };
      throw new WebAuthnError('CBOR-Fließkommazahlen werden nicht unterstützt');
    default:
      throw new WebAuthnError('CBOR-Tags werden nicht unterstützt');
  }
}

// --- COSE-Schlüssel → Node-KeyObject ---

function coseToKey(cose: Map<Cbor, Cbor>): { key: KeyObject; alg: number } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label: number) => {
    const v = cose.get(label);
    if (!Buffer.isBuffer(v)) throw new WebAuthnError('Schlüssel unvollständig');
    return b64url(v);
  };
  if (kty === 2 && alg === ALG_ES256 && cose.get(-1) === 1) {
    return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) }, format: 'jwk' }), alg };
  }
  if (kty === 1 && alg === ALG_EDDSA && cose.get(-1) === 6) {
    return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes(-2) }, format: 'jwk' }), alg };
  }
  if (kty === 3 && alg === ALG_RS256) {
    return { key: createPublicKey({ key: { kty: 'RSA', n: bytes(-1), e: bytes(-2) }, format: 'jwk' }), alg };
  }
  throw new WebAuthnError('Dieses Schlüsselverfahren wird nicht unterstützt');
}

// --- authenticatorData ---

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  cose?: Map<Cbor, Cbor>;
}

function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new WebAuthnError('authenticatorData zu kurz');
  const out: AuthData = { rpIdHash: data.subarray(0, 32), flags: data[32], signCount: data.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (data.length < 55) throw new WebAuthnError('authenticatorData zu kurz');
    const idLen = data.readUInt16BE(53);
    if (idLen > 1023 || data.length < 55 + idLen) throw new WebAuthnError('Schlüssel-ID ungültig');
    out.credentialId = data.subarray(55, 55 + idLen);
    const key = decodeCbor(data, 55 + idLen).value;
    if (!(key instanceof Map)) throw new WebAuthnError('Schlüssel ungültig');
    out.cose = key;
  }
  return out;
}

export interface Expected {
  challenge: string; // base64url, wie an den Browser geschickt
  origin: string; // z. B. https://kronenrunde.example.de
  rpId: string; // Hostname
}

function checkClientData(clientDataJSON: Buffer, type: string, exp: Expected) {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    client = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON ungültig');
  }
  if (client.type !== type) throw new WebAuthnError('Falscher Vorgang');
  const got = Buffer.from(String(client.challenge ?? ''));
  const want = Buffer.from(exp.challenge);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WebAuthnError('Challenge passt nicht');
  if (client.origin !== exp.origin) throw new WebAuthnError('Falsche Herkunft');
  if (client.crossOrigin === true) throw new WebAuthnError('Aus einem fremden Rahmen aufgerufen');
}

function checkAuthData(auth: AuthData, rpId: string) {
  const want = createHash('sha256').update(rpId).digest();
  if (!timingSafeEqual(auth.rpIdHash, want)) throw new WebAuthnError('Passkey gehört zu einer anderen Seite');
  if (!(auth.flags & FLAG_UP)) throw new WebAuthnError('Nutzer nicht anwesend');
  if (!(auth.flags & FLAG_UV)) throw new WebAuthnError('Gerät hat den Nutzer nicht geprüft (PIN, Fingerabdruck, Gesicht)');
}

export interface NewPasskey {
  credentialId: string; // base64url
  publicKey: Buffer; // SPKI (DER)
  alg: number;
  signCount: number;
}

/** Prüft die Antwort von navigator.credentials.create() und liefert den neuen Schlüssel. */
export function verifyRegistration(o: { clientDataJSON: Buffer; attestationObject: Buffer }, exp: Expected): NewPasskey {
  checkClientData(o.clientDataJSON, 'webauthn.create', exp);
  const att = decodeCbor(o.attestationObject).value;
  if (!(att instanceof Map)) throw new WebAuthnError('attestationObject ungültig');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('attestationObject ohne authData');
  const auth = parseAuthData(authData);
  checkAuthData(auth, exp.rpId);
  if (!auth.credentialId || !auth.cose) throw new WebAuthnError('Kein neuer Schlüssel enthalten');
  const { key, alg } = coseToKey(auth.cose);
  return {
    credentialId: b64url(auth.credentialId),
    publicKey: key.export({ type: 'spki', format: 'der' }),
    alg,
    signCount: auth.signCount,
  };
}

/**
 * Prüft die Antwort von navigator.credentials.get() gegen den gespeicherten Schlüssel.
 * Gibt den neuen Signaturzähler zurück. Ein Zähler, der nicht steigt, deutet auf einen
 * kopierten Schlüssel hin (Geräte, die immer 0 melden – z. B. synchronisierte Passkeys – sind ok).
 */
export function verifyAssertion(
  o: { clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer },
  stored: { publicKey: Buffer; alg: number; signCount: number },
  exp: Expected,
): number {
  checkClientData(o.clientDataJSON, 'webauthn.get', exp);
  const auth = parseAuthData(o.authenticatorData);
  checkAuthData(auth, exp.rpId);
  const key = createPublicKey({ key: stored.publicKey, format: 'der', type: 'spki' });
  const signed = Buffer.concat([o.authenticatorData, createHash('sha256').update(o.clientDataJSON).digest()]);
  const ok = stored.alg === ALG_EDDSA ? verify(null, signed, key, o.signature) : verify('sha256', signed, key, o.signature);
  if (!ok) throw new WebAuthnError('Signatur ungültig');
  if ((auth.signCount !== 0 || stored.signCount !== 0) && auth.signCount <= stored.signCount) {
    throw new WebAuthnError('Signaturzähler ist nicht gestiegen');
  }
  return auth.signCount;
}

/** rpId und Origin aus der öffentlichen Adresse der App (APP_URL). */
export function relyingParty(appUrl: string): { rpId: string; origin: string } {
  const url = new URL(appUrl);
  return { rpId: url.hostname, origin: url.origin };
}
