// Seitenrahmen und kleine wiederkehrende Bausteine der Oberfläche.

import type { Ctx } from '../app.ts';
import { type Html, html, nothing } from '../html.ts';

/** Kurze Hinweise nach einer Aktion (?hinweis=…). Nur feste Texte – nichts aus der Adresse wird angezeigt. */
const NOTICES: Record<string, { text: string; kind: 'ok' | 'warn' }> = {
  abgemeldet: { text: 'Du bist abgemeldet.', kind: 'ok' },
  'name-gespeichert': { text: 'Dein Name ist gespeichert.', kind: 'ok' },
  'passwort-gespeichert': { text: 'Dein neues Passwort ist gespeichert. Auf anderen Geräten meldest du dich damit neu an.', kind: 'ok' },
  'konto-geloescht': { text: 'Dein Konto und alle deine Daten sind gelöscht.', kind: 'ok' },
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
