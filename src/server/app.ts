// Die Web-App: verbindet Anfragen, Anmeldung, Routen und Antworten.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { loadHeaderTournament, type HeaderTournament } from './header-info.ts';
import { csrfToken, csrfValid, loadSession, sessionCookieName, SESSION_DAYS, type User } from './auth.ts';
import { type FetchJson, fetchJson } from './abgleich.ts';
import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import { html } from './html.ts';
import {
  clientIp,
  HttpError,
  htmlResponse,
  isSameOrigin,
  parseCookies,
  readForm,
  type Res,
  Router,
  send,
  serializeCookie,
  withCookie,
} from './http.ts';
import type { Mailer } from './mail.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBracketRoutes } from './routes/bracket.ts';
import { registerLeagueRoutes } from './routes/leagues.ts';
import { registerManageRoutes } from './routes/manage.ts';
import { layout } from './views/layout.ts';

export interface Deps {
  db: Db;
  config: Config;
  mailer: Mailer;
  /** Daten aus dem Internet holen (Champions, Spielerkader); in Tests ersetzbar */
  fetchJson: FetchJson;
  log: (msg: string) => void;
  /** Adresse einer Datei aus public/ mit Versionskennung, z. B. /static/app.css?v=1a2b3c4d */
  asset: (name: string) => string;
}

export interface Ctx {
  deps: Deps;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  form: URLSearchParams;
  ip: string;
  cookies: Record<string, string>;
  user: User | null;
  sessionId: string | null;
  /** Formular-Schutz (nur für angemeldete Nutzer). */
  csrf: string;
  /** Darf Turniere, Spiele und Ergebnisse pflegen (ADMIN_EMAILS). */
  isAdmin: boolean;
  /** Turnier für Countdown/Livestream im Kopf (nur bei Seitenaufrufen gefüllt). */
  headerTournament: HeaderTournament | null;
  now: Date;
}

export type Handler = (ctx: Ctx) => Promise<Res>;

interface StaticFile {
  body: Buffer;
  type: string;
  version: string;
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  for (const name of readdirSync(dir)) {
    const type = MIME[extname(name)];
    if (!type) continue;
    const body = readFileSync(join(dir, name));
    files.set(name, { body, type, version: createHash('sha256').update(body).digest('hex').slice(0, 10) });
  }
  return files;
}

export function errorPage(ctx: Ctx, status: number, message: string): Res {
  const titles: Record<number, string> = { 403: 'Kein Zugriff', 404: 'Nicht gefunden', 500: 'Fehler' };
  const body = html`<section class="panel">
  <h1>${titles[status] ?? 'Fehler'}</h1>
  <p>${message}</p>
  <p><a class="btn" href="/">Zur Startseite</a></p>
</section>`;
  return htmlResponse(layout(ctx, { title: titles[status] ?? 'Fehler', body }), status);
}

export function createApp(opts: { db: Db; config: Config; mailer: Mailer; publicDir: string; log?: (msg: string) => void; fetchJson?: FetchJson }) {
  const statics = loadStatic(opts.publicDir);
  const deps: Deps = {
    db: opts.db,
    fetchJson: opts.fetchJson ?? fetchJson,
    config: opts.config,
    mailer: opts.mailer,
    log: opts.log ?? ((m) => console.log(m)),
    asset: (name) => `/static/${name}?v=${statics.get(name)?.version ?? '0'}`,
  };
  const { config, db } = deps;

  const router = new Router<Ctx>();
  registerAuthRoutes(router);
  registerLeagueRoutes(router);
  registerBracketRoutes(router);
  registerManageRoutes(router);
  registerAdminRoutes(router);

  const manifest = JSON.stringify({
    name: config.appName,
    short_name: config.appName,
    start_url: '/',
    display: 'standalone',
    background_color: '#07111c',
    theme_color: '#07111c',
    lang: 'de',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: deps.asset('icon.svg'), sizes: 'any', type: 'image/svg+xml' },
    ],
  });

  // Hinweisseite ohne Internet (der Service Worker hält sie bereit)
  const appNameHtml = html`${config.appName}`.value;
  const offlinePage = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Keine Verbindung – ${appNameHtml}</title><meta name="theme-color" content="#07111c">
<link rel="icon" href="${deps.asset('icon.svg')}" type="image/svg+xml"><link rel="stylesheet" href="${deps.asset('app.css')}">
</head><body><header class="top"><span class="brand"><img src="${deps.asset('logo.svg')}" alt="" width="30" height="30">${appNameHtml}</span></header>
<main class="main"><section class="panel"><h1>Keine Verbindung</h1>
<p>Gerade gibt es keine Verbindung zum Internet. Sobald sie wieder da ist, lade die Seite neu.</p>
<p><a class="btn btn-primary" href="/">Neu laden</a></p></section></main></body></html>`;

  async function handle(req: IncomingMessage): Promise<Res> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Statische Dateien
    if (path.startsWith('/static/') && (method === 'GET' || method === 'HEAD')) {
      const file = statics.get(path.slice('/static/'.length));
      if (!file) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Nicht gefunden' };
      const versioned = url.searchParams.get('v') === file.version;
      return {
        status: 200,
        headers: {
          'content-type': file.type,
          'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        },
        body: file.body,
      };
    }
    if (path === '/manifest.webmanifest') {
      return { status: 200, headers: { 'content-type': MIME['.webmanifest'], 'cache-control': 'public, max-age=3600' }, body: manifest };
    }
    if (path === '/sw.js') {
      // Service Worker: muss im Hauptverzeichnis liegen, damit er für die ganze Seite gilt
      const sw = statics.get('sw.js')!;
      return { status: 200, headers: { 'content-type': sw.type, 'cache-control': 'no-cache' }, body: sw.body };
    }
    if (path === '/offline') {
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body: offlinePage };
    }
    if (path === '/favicon.ico') return { status: 301, headers: { location: deps.asset('icon.svg') }, body: '' };
    if (path === '/robots.txt') {
      return { status: 200, headers: { 'content-type': MIME['.txt'] }, body: 'User-agent: *\nDisallow: /r/\nDisallow: /beitreten/\nDisallow: /anmelden/\n' };
    }
    if (path === '/gesund') {
      await db.one('select 1');
      return { status: 200, headers: { 'content-type': MIME['.txt'], 'cache-control': 'no-store' }, body: 'ok' };
    }

    const cookies = parseCookies(req.headers.cookie);
    const cookieName = sessionCookieName(config);
    const session = await loadSession(db, cookies[cookieName]);
    const user = session?.user ?? null;

    const ctx: Ctx = {
      deps,
      method,
      path,
      query: url.searchParams,
      params: {},
      form: new URLSearchParams(),
      ip: clientIp(req, config.trustProxy),
      cookies,
      user,
      sessionId: session?.sessionId ?? null,
      csrf: session ? csrfToken(config.secret, session.sessionId) : '',
      isAdmin: !!user && config.adminEmails.has(user.email.toLowerCase()),
      headerTournament: null,
      now: new Date(),
    };

    const route = router.match(method, path);
    if (route === null) return errorPage(ctx, 404, 'Diese Seite gibt es nicht.');
    if (route === 'method') return errorPage(ctx, 405, 'Diese Aktion ist hier nicht möglich.');
    ctx.params = route.params;
    if (method === 'GET' && ctx.user) {
      const slug = /^\/r\/([^/]+)/.exec(path)?.[1] ?? null;
      ctx.headerTournament = await loadHeaderTournament(db, ctx.user.id, slug, ctx.now);
    }

    if (method === 'POST') {
      ctx.form = await readForm(req);
      if (!isSameOrigin(req.headers, config.appUrl)) {
        return errorPage(ctx, 403, 'Das Formular kam nicht von dieser Seite. Bitte lade die Seite neu und versuche es noch einmal.');
      }
      if (session && !csrfValid(config.secret, session.sessionId, ctx.form.get('_csrf'))) {
        return errorPage(ctx, 403, 'Das Formular ist abgelaufen. Bitte lade die Seite neu und versuche es noch einmal.');
      }
    }

    let res: Res;
    try {
      res = await route.handler(ctx);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      return errorPage(ctx, err.status, err.message);
    }
    if (session?.renewed && !res.headers['set-cookie']) {
      res = withCookie(res, serializeCookie(cookieName, cookies[cookieName], { secure: config.secureCookies, maxAgeSeconds: SESSION_DAYS * 86_400 }));
    }
    return res;
  }

  /** Für node:http – createServer(app.listener) */
  function listener(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? 'GET';
    handle(req)
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) deps.log(`Fehler bei ${method} ${req.url}: ${(err as Error)?.stack ?? err}`);
        const message = err instanceof HttpError ? err.message : 'Da ist etwas schiefgelaufen. Bitte versuche es gleich noch einmal.';
        return { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: message } as Res;
      })
      .then((r) => send(res, r, method, config.secureCookies))
      .catch(() => res.destroy());
  }

  return { listener, handle, deps };
}
