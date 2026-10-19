// Nachgebautes Passkey-Gerät für die Tests: erzeugt Schlüssel, attestationObject und Signaturen
// wie ein echter Authenticator (ES256, Attestierung "none").

import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { b64url } from '../webauthn.ts';

type CborIn = number | string | Buffer | CborIn[] | Map<CborIn, CborIn>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encodeCbor(v: CborIn): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
}

const FLAGS_UP_UV = 0x05;

export class FakePasskey {
  readonly id = createHash('sha256').update(String(Math.random())).digest().subarray(0, 16);
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  counter = 0;
  userHandle: Buffer = Buffer.alloc(0);

  readonly rpId: string;
  readonly origin: string;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = pair.privateKey;
    this.pub = pair.publicKey;
  }

  private authData(flags: number, extra: Buffer = Buffer.alloc(0)): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), count, extra]);
  }

  /** Wie navigator.credentials.create(); Ergebnis base64url, wie es das Formular schickt. */
  create(challenge: string, userHandle: Buffer, o: { flags?: number; type?: string; origin?: string } = {}) {
    this.userHandle = userHandle;
    const jwk = this.pub.export({ format: 'jwk' });
    const cose = new Map<CborIn, CborIn>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.id, encodeCbor(cose)]);
    const authData = this.authData((o.flags ?? FLAGS_UP_UV) | 0x40, attested);
    const attestationObject = encodeCbor(new Map<CborIn, CborIn>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.create', challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    return { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) };
  }

  /** Wie navigator.credentials.get(). */
  get(challenge: string, o: { flags?: number; origin?: string; bumpCounter?: boolean } = {}) {
    if (o.bumpCounter !== false) this.counter++;
    const authenticatorData = this.authData(o.flags ?? FLAGS_UP_UV);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? this.origin }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), this.key);
    return {
      id: b64url(this.id),
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
      userHandle: b64url(this.userHandle),
    };
  }
}
