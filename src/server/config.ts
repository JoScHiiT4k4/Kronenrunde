// Einstellungen aus Umgebungsvariablen (bzw. der Datei .env). Vorlage: .env.example

import { randomBytes } from 'node:crypto';

export type MailMode = 'console' | 'memory' | 'smtp' | 'brevo' | 'resend';

export interface Config {
  appName: string;
  /** Öffentliche Adresse ohne / am Ende, z. B. https://tippspiel.example.de */
  appUrl: string;
  port: number;
  /** Nur auf dieser Netzwerk-Adresse lauschen, z. B. 127.0.0.1 hinter einem Proxy. Leer = überall. */
  host: string | undefined;
  databaseUrl: string;
  /** Geheimer Schlüssel für Formular-Schutz (CSRF). Muss in Produktion fest gesetzt sein. */
  secret: string;
  /** Diese E-Mail-Adressen dürfen Turniere, Teams, Spiele und Ergebnisse pflegen. */
  adminEmails: Set<string>;
  timeZone: string;
  /** Offizielle Livestreams (Links im Kopf, sobald ein Turnier läuft). */
  streams: { twitch: string; youtube: string };
  mail: {
    mode: MailMode;
    from: string;
    fromName: string;
    apiKey: string;
    /** Für MAIL_MODE=smtp, z. B. Gmail: smtp.gmail.com, Port 465, Gmail-Adresse, App-Passwort */
    smtp: { host: string; port: number; user: string; password: string };
  };
  /** Hierhin gehen Vorschläge für neue Sonderfragen (Standard: die Absenderadresse der App) */
  suggestionsTo: string;
  /** Läuft hinter einem Proxy (Caddy, nginx, Cloudflare)? Dann zählt X-Forwarded-For als Adresse. */
  trustProxy: boolean;
  secureCookies: boolean;
  /** Fehlende Datenbank-Migrationen beim Start automatisch einspielen. */
  autoMigrate: boolean;
  /** Champions und Spielerkader regelmäßig von Riot holen (DATENABGLEICH=1/0; in Produktion standardmäßig an). */
  dataSync: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const appUrl = (env.APP_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL fehlt (siehe .env.example)');

  let secret = env.APP_SECRET ?? '';
  if (!secret) {
    if (appUrl.startsWith('https://')) throw new Error('APP_SECRET fehlt (siehe .env.example)');
    secret = randomBytes(32).toString('hex');
  }

  const mode = (env.MAIL_MODE ?? 'console') as MailMode;
  if (!['console', 'memory', 'smtp', 'brevo', 'resend'].includes(mode)) throw new Error(`Unbekannter MAIL_MODE: ${mode}`);

  return {
    appName: env.APP_NAME ?? 'LoL-Tippspiel',
    appUrl,
    port,
    host: env.HOST?.trim() || undefined,
    databaseUrl,
    secret,
    adminEmails: new Set(
      (env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    timeZone: env.APP_TIMEZONE ?? 'Europe/Berlin',
    streams: {
      twitch: env.STREAM_TWITCH_URL?.trim() || 'https://www.twitch.tv/lolesports',
      youtube: env.STREAM_YOUTUBE_URL?.trim() || 'https://www.youtube.com/@lolesports',
    },
    mail: {
      mode,
      from: (env.MAIL_FROM || (mode === 'smtp' ? env.SMTP_USER : '') || '').trim(),
      fromName: env.MAIL_FROM_NAME ?? env.APP_NAME ?? 'LoL-Tippspiel',
      apiKey: env.MAIL_API_KEY ?? '',
      smtp: {
        host: env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(env.SMTP_PORT || 465),
        user: (env.SMTP_USER ?? '').trim(),
        password: env.SMTP_PASSWORD ?? '',
      },
    },
    suggestionsTo: (env.SUGGESTIONS_TO || env.MAIL_FROM || (mode === 'smtp' ? env.SMTP_USER : '') || '').trim(),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    secureCookies: appUrl.startsWith('https://'),
    autoMigrate: env.AUTO_MIGRATE !== '0' && env.AUTO_MIGRATE !== 'false',
    dataSync: env.DATENABGLEICH ? env.DATENABGLEICH === '1' || env.DATENABGLEICH === 'true' : env.NODE_ENV === 'production',
  };
}
