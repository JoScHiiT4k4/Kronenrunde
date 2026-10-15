// Web-Push ohne Zusatzpakete: VAPID (RFC 8292) und Nachrichtenverschlüsselung aes128gcm (RFC 8291) mit node:crypto.

import { createECDH, createCipheriv, createPrivateKey, hkdfSync, randomBytes, sign, generateKeyPairSync } from 'node:crypto';
import type { Queryable } from './db/index.ts';

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export interface Vapid {
  /** Öffentlicher Schlüssel (unkomprimiert, base64url) – wird dem Browser beim Abonnieren übergeben */
  publicKey: string;
  privateJwk: { kty: string; crv: string; x: string; y: string; d: string };
}

/** VAPID-Schlüssel aus der Datenbank; beim ersten Aufruf wird ein Paar erzeugt und gespeichert. */
export async function loadVapid(db: Queryable): Promise<Vapid> {
  const row = await db.one<{ value: string }>(`select value from app_settings where key = 'vapid'`);
  if (row) return JSON.parse(row.value) as Vapid;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Vapid['privateJwk'];
  const publicKey = b64(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const vapid: Vapid = { publicKey, privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
  await db.run(`insert into app_settings (key, value) values ('vapid', $1) on conflict (key) do nothing`, [JSON.stringify(vapid)]);
  const saved = await db.one<{ value: string }>(`select value from app_settings where key = 'vapid'`);
  return JSON.parse(saved!.value) as Vapid;
}

export function vapidJwt(vapid: Vapid, audience: string, subject: string, now = Date.now()): string {
  const head = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const data = `${head}.${claims}`;
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  return `${data}.${b64(sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

/** Nachricht für ein Gerät verschlüsseln (RFC 8291). */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string): Buffer {
  const ua = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** Nur https-Adressen von öffentlichen Rechnernamen – die App schickt sonst Anfragen an beliebige Ziele. */
export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || endpoint.length > 1000) return false;
    const h = u.hostname;
    return h.includes('.') && !/^[\d.]+$/.test(h) && !h.includes(':') && h !== 'localhost' && !h.endsWith('.local') && !h.endsWith('.internal');
  } catch {
    return false;
  }
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Ergebnis: 'ok', 'gone' (Abo ungültig, löschen) oder 'error'. */
export async function sendPush(vapid: Vapid, target: PushTarget, message: object, subject: string): Promise<'ok' | 'gone' | 'error'> {
  if (!validEndpoint(target.endpoint)) return 'gone';
  const jwt = vapidJwt(vapid, new URL(target.endpoint).origin, subject);
  try {
    const r = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '3600',
        urgency: 'high',
      },
      body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(message)), target.p256dh, target.auth)),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return 'ok';
    return r.status === 404 || r.status === 410 ? 'gone' : 'error';
  } catch {
    return 'error';
  }
}
