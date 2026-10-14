// Anmeldung per E-Mail-Link (ohne Passwort) und Sitzungen.
//
// Sicherheit:
//   * Links und Sitzungen sind lange Zufallswerte; in der Datenbank steht nur ein Hash davon.
//   * Ein Link gilt 20 Minuten und nur einmal.
//   * Der Link öffnet erst eine Bestätigungsseite – so verbrauchen Link-Vorschauen von
//     Mail-Programmen den Link nicht.
//   * Begrenzung: höchstens 5 Links pro E-Mail-Adresse und 20 pro Internet-Adresse je Stunde.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { html } from './html.ts';
import type { Mailer } from './mail.ts';

export const LOGIN_TOKEN_MINUTES = 20;
export const SESSION_DAYS = 60;
const MAX_LINKS_PER_EMAIL_PER_HOUR = 5;
const MAX_LINKS_PER_IP_PER_HOUR = 20;

export interface User {
  id: string;
  email: string;
  display_name: string;
  premium_until: Date | null;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
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

export type LinkRequestResult = 'sent' | 'rate-limited';

export async function requestLoginLink(
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

  const token = newToken();
  await db.run(
    `insert into login_tokens (token_hash, email, expires_at)
     values ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), email, LOGIN_TOKEN_MINUTES],
  );
  await db.run(`delete from login_tokens where expires_at < now() - interval '1 day'`);

  const params = new URLSearchParams({ token });
  if (next !== '/') params.set('weiter', next);
  const link = `${config.appUrl}/anmelden/bestaetigen?${params}`;
  const existing = await db.one('select 1 from users where email = $1', [email]);
  const subject = existing ? `Dein Anmelde-Link für ${config.appName}` : `Willkommen bei ${config.appName}`;
  const text =
    `Hallo!\n\nMit diesem Link meldest du dich bei ${config.appName} an:\n\n${link}\n\n` +
    `Der Link gilt ${LOGIN_TOKEN_MINUTES} Minuten und nur einmal.\n` +
    `Falls du das nicht warst, kannst du diese E-Mail einfach ignorieren.`;
  const body = html`<p>Hallo!</p>
<p>Mit diesem Link meldest du dich bei ${config.appName} an:</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#c89b3c;color:#111;border-radius:8px;text-decoration:none;font-weight:bold">Jetzt anmelden</a></p>
<p style="color:#666">Der Link gilt ${LOGIN_TOKEN_MINUTES} Minuten und nur einmal. Falls du das nicht warst, kannst du diese E-Mail einfach ignorieren.</p>`;
  await mailer.send({ to: email, subject, text, html: body.value });
  return 'sent';
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
