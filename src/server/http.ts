// Kleiner HTTP-Unterbau: Anfragen lesen, Routen zuordnen, Antworten schreiben.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Html } from './html.ts';

export interface Res {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function htmlResponse(body: Html | string, status = 200): Res {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: body instanceof Html ? body.value : body,
  };
}

/** Nach einem Formular immer weiterleiten, damit "Neu laden" nichts doppelt abschickt. */
export function redirect(location: string, status = 303): Res {
  return { status, headers: { location, 'cache-control': 'no-store' }, body: '' };
}

export function withCookie(res: Res, cookie: string): Res {
  const existing = res.headers['set-cookie'];
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  return { ...res, headers: { ...res.headers, 'set-cookie': [...list, cookie] } };
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  httpOnly?: boolean;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (o.httpOnly !== false) c += '; HttpOnly';
  if (o.secure) c += '; Secure';
  if (o.maxAgeSeconds !== undefined) c += `; Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}`;
  return c;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // kaputter Cookie wird ignoriert
    }
  }
  return out;
}

/** Liest den Body unverändert (für Webhooks, deren Signatur über die rohen Bytes läuft) mit Größenbegrenzung. */
export function readRaw(req: IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Liest einen Formular-Body (application/x-www-form-urlencoded) mit Größenbegrenzung. */
export function readForm(req: IncomingMessage, limitBytes = 100_000): Promise<URLSearchParams> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Formular zu groß'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve(new URLSearchParams());
      if (type !== 'application/x-www-form-urlencoded') return reject(new HttpError(415, 'Formularformat nicht unterstützt'));
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------

export interface RouteMatch<C> {
  handler: (ctx: C) => Promise<Res>;
  params: Record<string, string>;
}

interface Route<C> {
  method: string;
  regex: RegExp;
  names: string[];
  handler: (ctx: C) => Promise<Res>;
}

export class Router<C> {
  private routes: Route<C>[] = [];

  add(method: 'GET' | 'POST', pattern: string, handler: (ctx: C) => Promise<Res>) {
    const names: string[] = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          names.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), names, handler });
  }

  get(pattern: string, handler: (ctx: C) => Promise<Res>) {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: (ctx: C) => Promise<Res>) {
    this.add('POST', pattern, handler);
  }

  /** Passende Route; 'method' = Adresse gibt es, aber nicht für diese Methode. */
  match(method: string, path: string): RouteMatch<C> | 'method' | null {
    let pathExists = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params: Record<string, string> = {};
      try {
        r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      } catch {
        return null;
      }
      return { handler: r.handler, params };
    }
    return pathExists ? 'method' : null;
  }
}

/**
 * Internet-Adresse des Besuchers. Hinter einem Proxy (TRUST_PROXY=1) zählt der LETZTE Eintrag in
 * X-Forwarded-For – den hat unser Proxy eingetragen. Frühere Einträge kann jeder Besucher selbst
 * mitschicken (z. B. um die Begrenzung für Anmelde-Links zu umgehen).
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const all = (Array.isArray(fwd) ? fwd.join(',') : (fwd ?? '')).split(',');
    const last = all[all.length - 1]?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? '';
}

/** Kommt das Formular von unserer eigenen Seite? (Schutz gegen fremde Seiten, die Formulare abschicken) */
export function isSameOrigin(headers: IncomingHttpHeaders, appUrl: string): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (!origin || origin === 'null') return true; // ältere Browser: dann schützt das Formular-Token
  const allowed = new Set([new URL(appUrl).origin]);
  const host = headers.host;
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return allowed.has(origin);
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

export function send(res: ServerResponse, r: Res, method: string, hsts: boolean) {
  const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS, ...r.headers };
  if (hsts) headers['strict-transport-security'] = 'max-age=31536000';
  const body = typeof r.body === 'string' ? Buffer.from(r.body, 'utf8') : r.body;
  headers['content-length'] = String(body.length);
  res.writeHead(r.status, headers);
  res.end(method === 'HEAD' ? undefined : body);
}
