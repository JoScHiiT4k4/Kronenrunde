// Zwei-Faktor-Authentifizierung: TOTP nach RFC 6238 (HMAC-SHA1, 6-stellig, 30-Sekunden-Schritte –
// die Einstellung, die jede verbreitete Authenticator-App ohne weitere Konfiguration versteht).
// Kein npm-Paket verfügbar, daher von Hand: Base32 (RFC 4648) fürs Secret/die QR-URI, HOTP (RFC 4226)
// als Baustein für TOTP. Der QR-Code selbst kommt aus ../domain/qrcode.ts.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 ohne Füllzeichen (für das Secret in der otpauth://-URI und zur Anzeige). */
export function base32Encode(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  const rest = bits.length % 5;
  if (rest) out += BASE32_ALPHABET[parseInt(bits.slice(bits.length - rest).padEnd(5, '0'), 2)];
  return out;
}

export function base32Decode(value: string): Buffer {
  const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) {
    const idx = BASE32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

/** HOTP nach RFC 4226: HMAC-SHA1 über den Zähler, dynamische Kürzung auf TOTP_DIGITS Stellen. */
function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

function totpCounter(time: number, step = TOTP_STEP_SECONDS): number {
  return Math.floor(time / 1000 / step);
}

/**
 * Erzeugt ein neues, zufälliges Secret: 16 Byte (128 Bit) – das von RFC 4226 geforderte Minimum
 * (empfohlen sind 160 Bit/20 Byte). Wir bleiben bewusst beim Minimum, weil die otpauth://-URI
 * sonst bei langen E-Mail-Adressen nicht mehr in unseren QR-Encoder passt (höchstens Version 6,
 * siehe ../domain/qrcode.ts) – 128 Bit sind für TOTP nach wie vor praktisch nicht zu erraten.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(16));
}

/**
 * otpauth://-URI zum Einscannen in einer Authenticator-App. Ohne algorithm/digits/period (das
 * sind ohnehin die Vorgaben, die jede verbreitete App annimmt, wenn sie fehlen) und ohne den
 * separaten issuer-Parameter (steht schon im Label) – das hält die URI so kurz wie möglich, da
 * sie bei einer langen E-Mail-Adresse sonst nicht mehr in unseren QR-Encoder passt.
 */
export function totpProvisioningUri(secretBase32: string, accountLabel: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretBase32}`;
}

/** Der aktuell gültige 6-stellige Code für ein Secret (zum Prüfen/Testen, nicht für den Login-Vergleich). */
export function totpCode(secretBase32: string, now = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpCounter(now));
}

/**
 * Prüft einen eingegebenen Code gegen das Secret. Toleriert ±1 Zeitschritt (30s) für kleine
 * Uhr-Abweichungen zwischen Server und Handy – wie bei praktisch jeder TOTP-Umsetzung üblich.
 */
export function totpValid(secretBase32: string, code: string, now = Date.now()): boolean {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretBase32);
  const counter = totpCounter(now);
  for (const delta of [0, -1, 1]) {
    const expected = hotp(secret, counter + delta);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return true;
  }
  return false;
}

const BACKUP_CODE_COUNT = 8;

function normalizeBackupCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(normalizeBackupCode(code)).digest('base64url');
}

/** Erzeugt frische Einmal-Codes (für den Fall, dass die Authenticator-App nicht greifbar ist). */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(randomBytes(5)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}
