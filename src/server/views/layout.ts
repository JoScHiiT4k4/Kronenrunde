// Seitenrahmen und kleine wiederkehrende Bausteine der Oberfläche.

import type { Ctx } from '../app.ts';
import { type Html, html, nothing } from '../html.ts';

/** Kurze Hinweise nach einer Aktion (?hinweis=…). Nur feste Texte – nichts aus der Adresse wird angezeigt. */
const NOTICES: Record<string, { text: string; kind: 'ok' | 'warn' }> = {
  abgemeldet: { text: 'Du bist abgemeldet.', kind: 'ok' },
  'name-gespeichert': { text: 'Dein Name ist gespeichert.', kind: 'ok' },
  'passwort-gespeichert': { text: 'Dein neues Passwort ist gespeichert. Auf anderen Geräten meldest du dich damit neu an.', kind: 'ok' },
  'konto-geloescht': { text: 'Dein Konto und alle deine Daten sind gelöscht.', kind: 'ok' },
  'avatar-gespeichert': { text: 'Dein Profilbild ist gespeichert.', kind: 'ok' },
  'avatar-geloescht': { text: 'Dein Profilbild ist entfernt.', kind: 'ok' },
  'avatar-fehler': { text: 'Das Bild konnte nicht gespeichert werden. Bitte wähle ein anderes Bild (JPG, PNG oder WebP).', kind: 'warn' },
  gespeichert: { text: 'Gespeichert.', kind: 'ok' },
  abgeglichen: { text: 'Champions und Spielerkader sind auf dem neuesten Stand.', kind: 'ok' },
  beigetreten: { text: 'Willkommen in der Tipprunde!', kind: 'ok' },
  erstellt: { text: 'Die Tipprunde ist angelegt. Lade jetzt deine Leute mit dem Einladungslink ein.', kind: 'ok' },
  'tipps-gespeichert': { text: 'Deine Tipps sind gespeichert.', kind: 'ok' },
  'tipps-teilweise': { text: 'Einige Tipps kamen zu spät: Der Tippschluss für diese Spiele ist vorbei.', kind: 'warn' },
  'keine-aenderung': { text: 'Keine Änderungen.', kind: 'ok' },
  'antworten-gespeichert': { text: 'Deine Antworten sind gespeichert.', kind: 'ok' },
  'antworten-zu-spaet': { text: 'Die Sonderfragen sind schon geschlossen.', kind: 'warn' },
  'link-erneuert': { text: 'Neuer Einladungslink erstellt. Der alte funktioniert nicht mehr.', kind: 'ok' },
  verlassen: { text: 'Du hast die Tipprunde verlassen.', kind: 'ok' },
  'runde-geloescht': { text: 'Die Tipprunde ist gelöscht.', kind: 'ok' },
  'ergebnis-gespeichert': { text: 'Ergebnis gespeichert.', kind: 'ok' },
  'spiel-geloescht': { text: 'Spiel gelöscht.', kind: 'ok' },
};

export interface LeagueNav {
  slug: string;
  name: string;
  canManage: boolean;
  active: 'tippen' | 'alle-tipps' | 'turnierbaum' | 'rangliste' | 'sonderfragen' | 'verwalten' | 'spiel';
}

export interface PageOptions {
  title: string;
  body: Html;
  league?: LeagueNav;
  /** Breitere Seite (z. B. für den Turnierbaum, der seitlich scrollt). */
  wide?: boolean;
  /** Zusätzliche Fehlermeldung über dem Inhalt. */
  error?: string;
}

export function layout(ctx: Ctx, o: PageOptions): Html {
  const { appName } = ctx.deps.config;
  const notice = NOTICES[ctx.query.get('hinweis') ?? ''];
  const title = o.title === appName ? appName : `${o.title} – ${appName}`;
  return html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="theme-color" content="#07111c">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="${ctx.deps.asset('icon.svg')}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<link rel="stylesheet" href="${ctx.deps.asset('app.css')}">
<script src="${ctx.deps.asset('app.js')}" defer></script>
</head>
<body${ctx.user ? html` data-angemeldet="1"` : nothing}>
<header class="top">
  <a class="brand" href="/"><img src="${ctx.deps.asset('logo.svg')}" alt="" width="30" height="30">${appName}</a>
  ${tournamentBar(ctx)}
  <nav class="top-nav">
    ${ctx.isAdmin ? html`<a href="/admin">Admin</a>` : nothing}
    ${ctx.user ? html`<a href="/konto">${ctx.user.display_name}</a>` : html`<a href="/anmelden">Anmelden</a>`}
  </nav>
</header>
${o.league ? leagueNav(o.league) : nothing}
<main class="main${o.wide ? ' main-wide' : ''}">
${notice ? html`<p class="notice notice-${notice.kind}" role="status">${notice.text}</p>` : nothing}
${o.error ? html`<p class="notice notice-error" role="alert">${o.error}</p>` : nothing}
${o.body}
</main>
<footer class="foot">
  <p><strong>${appName}</strong> ist ein Fan-Projekt und wird von Riot Games weder unterstützt noch gesponsert.</p>
  <p>League of Legends ist eine Marke von Riot Games, Inc.</p>
</footer>
</body>
</html>`;
}

const TWITCH_ICON = html`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3 2.5 7v13H7v3h3l3-3h4l5-5V3H4Zm15 11-3 3h-4l-3 3v-3H6V5h13v9Zm-3-6h-2v5h2V8Zm-5 0H9v5h2V8Z"/></svg>`;
const YOUTUBE_ICON = html`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2C2 8.800 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.800 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8C22 15.2 22 12 22 12s0-3.2-.4-4.8ZM10 15V9l5.200 3L10 15Z"/></svg>`;

function countdownText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d} Tg ${two(h)}:${two(m)}:${two(sec)}` : `${two(h)}:${two(m)}:${two(sec)}`;
}

/** Mitte im Kopf: Countdown bis zum Turnierstart, danach Links zum Livestream (mit grünem „Live“, wenn gespielt wird). */
function tournamentBar(ctx: Ctx): Html {
  const t = ctx.headerTournament;
  if (!t) return nothing;
  if (!t.running) {
    return html`<div class="tbar" aria-label="Countdown ${t.name}">
    <span class="tbar-label">${t.name} in</span>
    <time class="tbar-count" datetime="${t.startsAt.toISOString()}" data-countdown="${t.startsAt.toISOString()}">${countdownText(t.startsAt.getTime() - ctx.now.getTime())}</time>
  </div>`;
  }
  const { twitch, youtube } = ctx.deps.config.streams;
  return html`<div class="tbar" aria-label="Livestream ${t.name}">
    ${t.live ? html`<span class="tbar-live">Live</span>` : nothing}
    <a class="tbar-link" href="${twitch}" target="_blank" rel="noopener noreferrer">${TWITCH_ICON}Twitch</a>
    <a class="tbar-link" href="${youtube}" target="_blank" rel="noopener noreferrer">${YOUTUBE_ICON}YouTube</a>
  </div>`;
}

function leagueNav(l: LeagueNav): Html {
  const tab = (key: LeagueNav['active'], label: string) =>
    html`<a href="/r/${l.slug}/${key}"${l.active === key ? html` aria-current="page"` : nothing}>${label}</a>`;
  return html`<nav class="league-nav" aria-label="${l.name}">
  <div class="league-name">${l.name}</div>
  <div class="tabs">
    ${tab('tippen', 'Tippen')}
    ${tab('sonderfragen', 'Sonderfragen')}
    ${tab('rangliste', 'Rangliste')}
    ${tab('alle-tipps', 'Alle Tipps')}
    ${tab('turnierbaum', 'Turnierbaum')}
    ${l.canManage ? tab('verwalten', 'Verwalten') : nothing}
  </div>
</nav>`;
}

/** Kleines rundes Profilbild; ohne Bild der Anfangsbuchstabe. */
export function avatar(userId: string, name: string, version: Date | null, size: 'sm' | 'lg' = 'sm'): Html {
  return version
    ? html`<img class="avatar avatar-${size}" src="/avatar/${userId}?v=${String(version.getTime())}" alt="" width="${size === 'lg' ? 96 : 28}" height="${size === 'lg' ? 96 : 28}" loading="lazy">`
    : html`<span class="avatar avatar-${size} avatar-ph" aria-hidden="true">${[...name][0]?.toUpperCase() ?? '?'}</span>`;
}

export function csrfField(ctx: Ctx): Html {
  return ctx.csrf ? html`<input type="hidden" name="_csrf" value="${ctx.csrf}">` : nothing;
}

/** Ein Knopf, der ein kleines Formular abschickt (für Aktionen wie Löschen). */
export function postButton(
  ctx: Ctx,
  action: string,
  label: string,
  o: { cls?: string; confirm?: string; fields?: Record<string, string> } = {},
): Html {
  return html`<form method="post" action="${action}" class="inline-form"${o.confirm ? html` data-confirm="${o.confirm}"` : nothing}>
  ${csrfField(ctx)}
  ${Object.entries(o.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
  <button type="submit" class="${o.cls ?? 'btn'}">${label}</button>
</form>`;
}

export function emptyState(text: string, action?: Html): Html {
  return html`<div class="empty"><p>${text}</p>${action ?? nothing}</div>`;
}
