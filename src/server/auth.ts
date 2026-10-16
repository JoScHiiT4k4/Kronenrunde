// Anmeldung mit E-Mail und Passwort, Passwort-Links per E-Mail, Sitzungen.
//
// Sicherheit:
//   * Passwörter werden mit scrypt (Salz, hoher Rechenaufwand) gespeichert, nie im Klartext.
//   * Fehlversuche: höchstens 10 pro E-Mail-Adresse in 15 Minuten, 30 pro Internet-Adresse.
//   * Passwort-Links und Sitzungen sind lange Zufallswerte; in der Datenbank steht nur ein Hash davon.
//   * Ein Link gilt 20 Minuten und nur einmal; er öffnet erst ein Formular – so verbrauchen
//     Link-Vorschauen von Mail-Programmen den Link nicht.
//   * Begrenzung: höchstens 5 Links pro E-Mail-Adresse und 20 pro Internet-Adresse je Stunde.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { html } from './html.ts';
import type { Mailer } from './mail.ts';

export const LOGIN_TOKEN_MINUTES = 20;
export const SESSION_DAYS = 60;
const MAX_LINKS_PER_EMAIL_PER_HOUR = 5;
const MAX_LINKS_PER_IP_PER_HOUR = 20;
const MAX_FAILURES_PER_EMAIL = 10; // je 15 Minuten
const MAX_FAILURES_PER_IP = 30; // je 15 Minuten
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// ---------------------------------------------------------------------
// Passwörter
// ---------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Speicherform: scrypt$N$r$p$salz$hash (Base64url) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Gleich viel Rechenzeit wie bei einem echten Vergleich – verrät nicht, ob es das Konto gibt
    await scryptAsync(password, randomBytes(16));
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Prüft ein neues Passwort; gibt einen Hinweis zurück oder null, wenn es passt. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Das Passwort braucht mindestens ${PASSWORD_MIN} Zeichen.`;
  if (password.length > PASSWORD_MAX) return `Das Passwort darf höchstens ${PASSWORD_MAX} Zeichen haben.`;
  if (email && password.trim().toLowerCase() === email) return 'Bitte nimm nicht deine E-Mail-Adresse als Passwort.';
  return null;
}

const ipFailures = new Map<string, number[]>();

/** Zu viele Fehlversuche für diese E-Mail-Adresse oder Internet-Adresse? */
export async function loginBlocked(db: Db, email: string, ip: string): Promise<boolean> {
  const since = Date.now() - 15 * 60_000;
  if ((ipFailures.get(ip) ?? []).filter((t) => t > since).length >= MAX_FAILURES_PER_IP) return true;
  const row = await db.one<{ n: number }>(
    `select count(*)::int as n from login_failures where email = $1 and created_at > now() - interval '15 minutes'`,
    [email],
  );
  return (row?.n ?? 0) >= MAX_FAILURES_PER_EMAIL;
}

export async function recordLoginFailure(db: Db, email: string, ip: string) {
  const since = Date.now() - 15 * 60_000;
  ipFailures.set(ip, [...(ipFailures.get(ip) ?? []).filter((t) => t > since), Date.now()]);
  if (ipFailures.size > 10_000) ipFailures.clear();
  await db.run('insert into login_failures (email) values ($1)', [email]);
  await db.run(`delete from login_failures where created_at < now() - interval '1 day'`);
}

export type PasswordLogin =
  | { ok: true; user: User }
  | { ok: false; reason: 'wrong' | 'no-password' | 'blocked' };

/** Anmelden mit E-Mail und Passwort. */
export async function loginWithPassword(db: Db, email: string, password: string, ip: string): Promise<PasswordLogin> {
  if (await loginBlocked(db, email, ip)) return { ok: false, reason: 'blocked' };
  const row = await db.one<User & { password_hash: string | null }>(
    'select id, email, display_name, premium_until, password_hash from users where email = $1',
    [email],
  );
  if (row && !row.password_hash) return { ok: false, reason: 'no-password' };
  if (!(await verifyPassword(password, row?.password_hash ?? null))) {
    await recordLoginFailure(db, email, ip);
    return { ok: false, reason: 'wrong' };
  }
  await db.run('delete from login_failures where email = $1', [email]);
  const { password_hash: _, ...user } = row!;
  return { ok: true, user };
}

/** Passwort setzen; alle bisherigen Sitzungen enden (z. B. auf einem verlorenen Handy). */
export async function setPassword(db: Db, userId: string, password: string) {
  const hash = await hashPassword(password);
  await db.tx(async (q) => {
    await q.run('update users set password_hash = $2, password_changed_at = now() where id = $1', [userId, hash]);
    await q.run('delete from sessions where user_id = $1', [userId]);
  });
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  premium_until: Date | null;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Persönlicher Token fürs Live-Kalender-Abo: steht (anders als Sitzungs-/Reset-Token) im Klartext
 * in der Datenbank und wird direkt als Schlüssel benutzt – er muss login-frei abrufbar sein, damit
 * Kalender-Apps den Spielplan selbst regelmäßig neu holen können. Wirkt wie der Link selbst als
 * Geheimnis, genau wie Google Kalenders "private iCal-Adresse". Wird bei erstem Bedarf angelegt.
 */
export async function calendarToken(db: Db, userId: string): Promise<string> {
  const row = await db.one<{ calendar_token: string | null }>('select calendar_token from users where id = $1', [userId]);
  if (row?.calendar_token) return row.calendar_token;
  const token = newToken();
  await db.run('update users set calendar_token = $2 where id = $1', [userId, token]);
  return token;
}

/** Setzt den Token zurück (neuer Link, alter funktioniert danach nicht mehr). */
export async function resetCalendarToken(db: Db, userId: string): Promise<void> {
  await db.run('update users set calendar_token = $2 where id = $1', [userId, newToken()]);
}

/** Nutzer anhand des Kalender-Tokens (für die login-freie Abo-URL). */
export async function userByCalendarToken(db: Db, token: string): Promise<{ id: string } | null> {
  if (!token) return null;
  return db.one<{ id: string }>('select id from users where calendar_token = $1', [token]);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function sessionCookieName(config: Config): string {
  return config.secureCookies ? '__Host-sid' : 'sid';
}

export function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url').slice(0, 32);
}

export function csrfValid(secret: string, sessionId: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(csrfToken(secret, sessionId));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** Nur Adressen innerhalb der App als Ziel nach der Anmeldung zulassen. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

// In-Memory-Zähler pro Internet-Adresse (reicht für einen Server; wird bei Neustart geleert).
const ipHits = new Map<string, number[]>();

function ipAllowed(ip: string): boolean {
  const hourAgo = Date.now() - 3_600_000;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > hourAgo);
  if (hits.length >= MAX_LINKS_PER_IP_PER_HOUR) return false;
  hits.push(Date.now());
  ipHits.set(ip, hits);
  if (ipHits.size > 10_000) ipHits.clear();
  return true;
}

const ipRegistrations = new Map<string, number[]>();

/** Höchstens 10 neue Konten pro Internet-Adresse und Stunde. */
export function registrationAllowed(ip: string): boolean {
  const hourAgo = Date.now() - 3_600_000;
  const hits = (ipRegistrations.get(ip) ?? []).filter((t) => t > hourAgo);
  if (hits.length >= 10) return false;
  ipRegistrations.set(ip, [...hits, Date.now()]);
  if (ipRegistrations.size > 10_000) ipRegistrations.clear();
  return true;
}

export type LinkRequestResult = 'sent' | 'rate-limited';

/**
 * Schickt einen Link zum Festlegen eines (neuen) Passworts – nur, wenn es ein Konto gibt.
 * Die Antwort ist für die Seite in beiden Fällen gleich, damit niemand ausprobieren kann, wer ein Konto hat.
 */
export async function requestPasswordLink(
  deps: { db: Db; config: Config; mailer: Mailer },
  email: string,
  next: string,
  ip: string,
): Promise<LinkRequestResult> {
  const { db, config, mailer } = deps;
  if (!ipAllowed(ip)) return 'rate-limited';
  const recent = await db.one<{ n: number }>(
    `select count(*)::int as n from login_tokens where email = $1 and created_at > now() - interval '1 hour'`,
    [email],
  );
  if ((recent?.n ?? 0) >= MAX_LINKS_PER_EMAIL_PER_HOUR) return 'rate-limited';
  const user = await db.one<{ password_hash: string | null }>('select password_hash from users where email = $1', [email]);
  if (!user) return 'sent';

  const link = await createPasswordLink(db, config, email, next);
  await db.run(`delete from login_tokens where expires_at < now() - interval '1 day'`);
  const first = !user.password_hash;
  const subject = first ? `Passwort festlegen für ${config.appName}` : `Neues Passwort für ${config.appName}`;
  const intro = first
    ? `Hier legst du dein Passwort für ${config.appName} fest. Danach meldest du dich immer mit E-Mail und Passwort an:`
    : `Hier legst du ein neues Passwort für ${config.appName} fest:`;
  const text =
    `Hallo!\n\n${intro}\n\n${link}\n\n` +
    `Der Link gilt ${LOGIN_TOKEN_MINUTES} Minuten und nur einmal.\n` +
    `Falls du das nicht angefordert hast, kannst du diese E-Mail einfach ignorieren – dein Passwort bleibt dann, wie es ist.`;
  const body = html`<p>Hallo!</p>
<p>${intro}</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#c8aa6e;color:#1c1407;text-decoration:none;font-weight:bold">Passwort festlegen</a></p>
<p style="color:#666">Der Link gilt ${LOGIN_TOKEN_MINUTES} Minuten und nur einmal. Falls du das nicht angefordert hast, kannst du diese E-Mail einfach ignorieren – dein Passwort bleibt dann, wie es ist.</p>`;
  await mailer.send({ to: email, subject, text, html: body.value });
  return 'sent';
}

/** Erzeugt einen Link zum Passwort-Festlegen (auch für  tippspiel login-link, falls Mails klemmen). */
export async function createPasswordLink(db: Db, config: Config, email: string, next = '/'): Promise<string> {
  const token = newToken();
  await db.run(
    `insert into login_tokens (token_hash, email, expires_at)
     values ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), email, LOGIN_TOKEN_MINUTES],
  );
  const params = new URLSearchParams({ token });
  if (next !== '/') params.set('weiter', next);
  return `${config.appUrl}/passwort-neu?${params}`;
}

/** Löst einen Link ein. Gibt die E-Mail-Adresse zurück oder null, wenn er ungültig/abgelaufen/benutzt ist. */
export async function consumeLoginToken(db: Db, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await db.one<{ email: string }>(
    `update login_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning email`,
    [hashToken(token)],
  );
  return row?.email ?? null;
}

export async function findOrCreateUser(db: Db, email: string): Promise<{ user: User; created: boolean }> {
  const existing = await db.one<User>('select id, email, display_name, premium_until from users where email = $1', [email]);
  if (existing) return { user: existing, created: false };
  const suggested = email.split('@')[0].replace(/[._+-]+/g, ' ').trim().slice(0, 40) || 'Tipper';
  const user = await db.one<User>(
    `insert into users (email, display_name) values ($1, $2)
     on conflict (email) do update set email = excluded.email
     returning id, email, display_name, premium_until`,
    [email, suggested],
  );
  return { user: user as User, created: true };
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = newToken();
  await db.run(
    `insert into sessions (id, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  await db.run(`delete from sessions where expires_at < now()`);
  return token;
}

export interface SessionInfo {
  user: User;
  sessionId: string;
  /** true, wenn die Sitzung verlängert wurde – dann wird der Cookie neu gesetzt. */
  renewed: boolean;
}

export async function loadSession(db: Db, token: string | undefined): Promise<SessionInfo | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const sessionId = hashToken(token);
  const row = await db.one<User & { expires_at: Date }>(
    `select u.id, u.email, u.display_name, u.premium_until, s.expires_at
       from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.expires_at > now()`,
    [sessionId],
  );
  if (!row) return null;
  let renewed = false;
  if (row.expires_at.getTime() - Date.now() < (SESSION_DAYS / 2) * 86_400_000) {
    await db.run(`update sessions set expires_at = now() + make_interval(days => $2) where id = $1`, [sessionId, SESSION_DAYS]);
    renewed = true;
  }
  const { expires_at: _, ...user } = row;
  return { user, sessionId, renewed };
}

export async function destroySession(db: Db, sessionId: string) {
  await db.run('delete from sessions where id = $1', [sessionId]);
}
