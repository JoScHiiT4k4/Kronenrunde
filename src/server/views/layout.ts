// Seitenrahmen und kleine wiederkehrende Bausteine der Oberfläche.

import type { Ctx } from '../app.ts';
import { formatDateTime } from '../format.ts';
import { type Html, html, nothing } from '../html.ts';
import { gotPercent } from '../../domain/possible.ts';
import { buildInfo } from '../version.ts';

/** Kurze Hinweise nach einer Aktion (?hinweis=…). Nur feste Texte – nichts aus der Adresse wird angezeigt. */
const NOTICES: Record<string, { text: string; kind: 'ok' | 'warn' }> = {
  abgemeldet: { text: 'Du bist abgemeldet.', kind: 'ok' },
  'update-angefordert': { text: 'Update angefordert. In ein bis zwei Minuten ist die neue Version da – danach die Seite neu laden.', kind: 'ok' },
  'benachrichtigung-gespeichert': { text: 'Deine Benachrichtigungen sind gespeichert.', kind: 'ok' },
  'aenderung-angefragt': { text: 'Deine Änderung ist angefragt. Sie gilt, sobald dein Spielleiter sie bestätigt.', kind: 'ok' },
  'anfrage-zurueckgezogen': { text: 'Deine Anfrage ist zurückgezogen.', kind: 'ok' },
  'name-gespeichert': { text: 'Dein Name ist gespeichert.', kind: 'ok' },
  'passwort-gespeichert': { text: 'Dein neues Passwort ist gespeichert. Auf anderen Geräten meldest du dich damit neu an.', kind: 'ok' },
  'konto-geloescht': { text: 'Dein Konto und alle deine Daten sind gelöscht.', kind: 'ok' },
  'email-gesendet': { text: 'Wir haben dir eine Mail an die neue Adresse geschickt. Mit dem Link darin wird sie übernommen.', kind: 'ok' },
  'email-geaendert': { text: 'Deine E-Mail-Adresse ist geändert.', kind: 'ok' },
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
  'vorschlag-gesendet': { text: 'Danke! Dein Vorschlag ist per E-Mail unterwegs.', kind: 'ok' },
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
  active: 'tippen' | 'alle-tipps' | 'turnierbaum' | 'statistiken' | 'rangliste' | 'sonderfragen' | 'verwalten' | 'spiel';
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
${ctx.user && ctx.sidebar ? html`<link rel="stylesheet" href="${ctx.deps.asset('chat.css')}">
<script src="${ctx.deps.asset('chat.js')}" defer></script>` : nothing}
</head>
<body${ctx.user ? html` data-angemeldet="1"` : nothing}>
<header class="top">
  <a class="brand" href="/"><img src="${ctx.deps.asset('logo.svg')}" alt="" width="30" height="30">${appName}</a>
  ${tournamentBar(ctx)}
  <nav class="top-nav">
    ${ctx.isAdmin ? roleSwitch(ctx, o.league) : nothing}
    ${ctx.user ? html`<a href="/konto">${ctx.user.display_name}</a>
    <form method="post" action="/abmelden" class="top-logout">${csrfField(ctx)}<button type="submit" class="top-logout-btn">Abmelden</button></form>` : html`<a href="/anmelden">Anmelden</a>`}
  </nav>
</header>
${o.league ? leagueNav(o.league) : nothing}
<div class="page${o.wide ? ' page-wide' : ''}">
<div class="ad ad-ghost${ctx.sidebar ? ' ad-ghost-wide' : ''}" aria-hidden="true"></div>
<main class="main${o.wide ? ' main-wide' : ''}">
${notice ? html`<p class="notice notice-${notice.kind}" role="status">${notice.text}</p>` : nothing}
${o.error ? html`<p class="notice notice-error" role="alert">${o.error}</p>` : nothing}
${o.body}
</main>
${rankBox(ctx)}
</div>
${chatWidget(ctx)}
<footer class="foot">
  <p><strong>${appName}</strong> ist ein Fan-Projekt und wird von Riot Games weder unterstützt noch gesponsert.</p>
  <p>League of Legends ist eine Marke von Riot Games, Inc.</p>
  <p class="foot-links"><a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></p>
  ${versionNote(ctx)}
</footer>
</body>
</html>`;
}

const CHAT_ICON = html`<svg class="chat-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>`;

const SPEAKER_ON = html`<svg class="spk spk-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3Zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.500-8.800v2.100a7 7 0 0 1 0 13.400v2.100a9 9 0 0 0 0-17.600Z"/></svg>`;
const SPEAKER_OFF = html`<svg class="spk spk-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9H3Zm17.600 3 2.400-2.400-1.400-1.400-2.400 2.400-2.400-2.400-1.400 1.400 2.400 2.400-2.400 2.400 1.400 1.400 2.400-2.400 2.400 2.400 1.400-1.400-2.400-2.400Z"/></svg>`;

/** Chat der aktuellen Tipprunde: Sprechblase unten rechts, klappt auf und zu. Ohne JavaScript bleibt er verborgen. */
function chatWidget(ctx: Ctx): Html {
  if (!ctx.user || !ctx.sidebar) return nothing;
  return html`<div class="chat" data-chat data-slug="${ctx.sidebar.slug}" data-csrf="${ctx.csrf}" data-muted="${ctx.sidebar.chatMuted ? '1' : '0'}" hidden>
  <section class="chat-panel" id="chat-panel" aria-label="Chat" hidden>
    <header class="chat-head"><strong>Chat</strong><span class="muted">${ctx.sidebar.leagueName}</span>
      <button type="button" class="chat-mute" data-chat-mute aria-pressed="${ctx.sidebar.chatMuted ? 'true' : 'false'}" title="${ctx.sidebar.chatMuted ? 'Stumm – Benachrichtigungen einschalten' : 'Laut – stummschalten'}" aria-label="${ctx.sidebar.chatMuted ? 'Chat ist stumm, Benachrichtigungen einschalten' : 'Chat-Benachrichtigungen an, stummschalten'}">${SPEAKER_ON}${SPEAKER_OFF}</button>
      <button type="button" class="chat-close" data-chat-close aria-label="Chat schließen">×</button></header>
    <div class="chat-log" data-chat-log role="log" aria-live="polite"><p class="muted chat-empty">Noch keine Nachrichten.</p></div>
    <form class="chat-form" data-chat-form autocomplete="off">
      <input type="text" name="text" maxlength="500" placeholder="Nachricht schreiben …" aria-label="Nachricht" required>
      <button type="submit" class="btn btn-primary">Senden</button>
    </form>
    <p class="chat-note muted">Nachrichten werden nach 7 Tagen gelöscht.</p>
  </section>
  <button type="button" class="chat-toggle" data-chat-toggle aria-expanded="false" aria-controls="chat-panel" aria-label="Chat öffnen">
    ${CHAT_ICON}<span class="chat-label">Chat</span><span class="chat-badge" data-chat-badge hidden>0</span>
  </button>
</div>`;
}

/** Fußnote unten links: laufende Version und Zeitpunkt der letzten Änderung (Stand des Programms). */
function versionNote(ctx: Ctx): Html {
  const b = buildInfo();
  return html`<p class="foot-version">Version: ${b.version}${b.commit ? html` (${b.commit})` : nothing}${b.committedAt ? html`<br>Letztes Update: ${formatDateTime(b.committedAt, ctx.deps.config.timeZone)} Uhr` : nothing}</p>`;
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

/** Mitte im Kopf: Countdown bis zum Turnierstart (solange er läuft), dazu immer die Links zum Livestream – mit grünem „Live“, wenn gespielt wird. */
function tournamentBar(ctx: Ctx): Html {
  const t = ctx.headerTournament;
  if (!t) return nothing;
  const { twitch, youtube } = ctx.deps.config.streams;
  return html`<div class="tbar" aria-label="${t.name}">
    ${
      t.running
        ? nothing
        : html`<span class="tbar-label">${t.name} in</span>
    <time class="tbar-count" datetime="${t.startsAt.toISOString()}" data-countdown="${t.startsAt.toISOString()}">${countdownText(t.startsAt.getTime() - ctx.now.getTime())}</time>`
    }
    ${t.live ? html`<span class="tbar-live">Live</span>` : nothing}
    <a class="tbar-link" href="${twitch}" target="_blank" rel="noopener noreferrer">${TWITCH_ICON}Twitch</a>
    <a class="tbar-link" href="${youtube}" target="_blank" rel="noopener noreferrer">${YOUTUBE_ICON}YouTube</a>
  </div>`;
}

/** Platz für Werbung links und rechts neben dem Inhalt (nur auf breiten Bildschirmen sichtbar). */
function adBox(side: 'left' | 'right'): Html {
  return html`<aside class="ad ad-${side}" aria-label="Werbung"><div class="ad-box"><span class="ad-label">Anzeige</span></div></aside>`;
}

/** Grün/rote Skala: geholte Punkte im Verhältnis zu den bisher möglichen. */
export function scaleBar(points: number, possible: number): Html {
  const got = gotPercent(points, possible);
  const label = possible > 0 ? `${points} von ${possible} möglichen Punkten (${got} %)` : 'Noch keine Punkte vergeben';
  return html`<svg class="scale" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}">
    <title>${label}</title>
    ${possible > 0 ? html`<rect class="scale-got" x="0" y="0" width="${got}" height="8"/><rect class="scale-miss" x="${got}" y="0" width="${100 - got}" height="8"/>` : html`<rect class="scale-none" x="0" y="0" width="100" height="8"/>`}
  </svg>`;
}

/** Rechts neben dem Inhalt (breite Bildschirme): die Rangliste der aktuellen Tipprunde, klickbar zur Seite "Rangliste". */
function rankBox(ctx: Ctx): Html {
  const s = ctx.sidebar;
  if (!s) return adBox('right');
  const top = s.rows.slice(0, 8);
  const me = s.rows.find((r) => r.userId === ctx.user?.id);
  const shown = me && !top.includes(me) ? [...top, me] : top;
  return html`<aside class="ad ad-right rank-side" aria-label="Rangliste ${s.leagueName}">
    <div class="rank-box">
      <a class="rank-stretch rank-title" href="/r/${s.slug}/rangliste">Rangliste</a>
      <span class="rank-league">${s.leagueName}</span>
      <ol class="rank-list">
        ${shown.map(
          (r) => html`<li class="rank-row${r.userId === ctx.user?.id ? ' me' : ''}${r.rank <= 3 && r.points > 0 ? ` podium-${r.rank}` : ''}">
          <span class="rank-pos">${r.rank}</span>
          <span class="rank-name">${avatar(r.userId, r.displayName, s.avatarOf.get(r.userId) ?? null)}<a class="rank-n" href="/r/${s.slug}/spieler/${r.userId}">${r.displayName}</a></span>
          ${scaleBar(r.points, s.possible)}
          <span class="rank-pts">${r.points}</span>
        </li>`,
        )}
      </ol>
      <span class="rank-foot">${s.possible > 0 ? `${s.possible} Punkte bisher möglich` : 'Noch keine Spiele gewertet'}</span>
      <span class="rank-more">Zur ganzen Rangliste →</span>
    </div>
  </aside>`;
}

/** Nur für den Betreiber: Umschalter zwischen Spielleiter (Tipprunde verwalten) und Administrator (ganze Seite).
 *  Mit nur einer verfügbaren Rolle bleibt es ein einfacher Text ohne Aufklapp-Pfeil. */
function roleSwitch(ctx: Ctx, league: LeagueNav | undefined): Html {
  const admin = ctx.path.startsWith('/admin');
  const slug = league?.slug ?? ctx.sidebar?.slug ?? null;
  const roles: { label: string; href: string; current: boolean }[] = [];
  if (slug) roles.push({ label: 'Spielleiter', href: `/r/${slug}/verwalten`, current: !admin });
  roles.push({ label: 'Administrator', href: '/admin', current: admin || !slug });
  const current = roles.find((r) => r.current) ?? roles[0];
  if (roles.length < 2) return html`<a class="role-single" href="${current.href}">${current.label}</a>`;
  return html`<details class="role-switch">
    <summary>${current.label}</summary>
    <div class="role-menu">
      ${roles.map((r) => html`<a href="${r.href}"${r.current ? html` aria-current="true"` : nothing}>${r.label}</a>`)}
    </div>
  </details>`;
}

/** Ein Eintrag in einer Reiter-Leiste. */
export interface TabItem {
  href: string;
  label: string;
  current: boolean;
  /** Zusatz hinter dem Namen, z. B. eine Zahl für offene Tipps oder Anfragen */
  extra?: Html;
  /** Für Phasen, die noch nicht begonnen haben (gedämpft dargestellt) */
  later?: boolean;
}

/** Reiter-Leiste: im Browser wie gewohnt als Reiter, auf dem Handy (bis 640 px) als Dropdown mit dem aktuellen Eintrag.
 *  Beides steht im HTML, das CSS blendet je nach Bildschirmbreite eines aus – funktioniert also auch ohne JavaScript. */
export function tabMenu(cls: 'sub-tabs' | 'phase-tabs', ariaLabel: string, items: TabItem[]): Html {
  const link = (t: TabItem) =>
    html`<a href="${t.href}"${t.current ? html` aria-current="page"` : nothing}${t.later ? html` class="later"` : nothing}>${t.label}${t.extra ?? nothing}</a>`;
  return html`<nav class="${cls}" aria-label="${ariaLabel}">
  ${items.map(link)}
</nav>${mobileMenu(cls, ariaLabel, items, link)}`;
}

function mobileMenu(cls: string, ariaLabel: string, items: TabItem[], link: (t: TabItem) => Html): Html {
  if (!items.length) return nothing;
  const current = items.find((t) => t.current) ?? items[0];
  return html`<details class="m-menu m-menu-${cls}" data-m-menu>
  <summary aria-label="${ariaLabel}"><span class="m-menu-now">${current.label}</span>${current.extra ?? nothing}</summary>
  <div class="m-menu-list" role="navigation" aria-label="${ariaLabel}">${items.map(link)}</div>
</details>`;
}

function leagueNav(l: LeagueNav): Html {
  const tab = (key: LeagueNav['active'], label: string): TabItem => ({ href: `/r/${l.slug}/${key}`, label, current: l.active === key });
  const items: TabItem[] = [
    tab('tippen', 'Tippen'),
    tab('sonderfragen', 'Sonderfragen'),
    tab('rangliste', 'Rangliste'),
    tab('alle-tipps', 'Alle Tipps'),
    tab('turnierbaum', 'Turnierbaum'),
    tab('statistiken', 'Statistiken'),
    ...(l.canManage ? [tab('verwalten', 'Verwalten')] : []),
  ];
  const link = (t: TabItem) => html`<a href="${t.href}"${t.current ? html` aria-current="page"` : nothing}>${t.label}</a>`;
  return html`<nav class="league-nav" aria-label="${l.name}">
  <div class="league-name">${l.name}</div>
  <div class="tabs">
    ${items.map(link)}
  </div>
  ${mobileMenu('league-tabs', l.name, items, link)}
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

/** Live-Suche (und optional Regionsfilter) für eine Liste; bleibt ohne JavaScript verborgen. Zeilen brauchen data-item, data-text, ggf. data-region. */
export function filterBar(target: string, placeholder: string, regions: string[] = []): Html {
  return html`<div class="filter-bar" data-filter="${target}" hidden>
  <input type="search" class="filter-q" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off">
  ${regions.length ? html`<select class="filter-region" aria-label="Region"><option value="">Alle Regionen</option>${regions.map((r) => html`<option value="${r}">${r}</option>`)}</select>` : nothing}
</div>`;
}

export function emptyState(text: string, action?: Html): Html {
  return html`<div class="empty"><p>${text}</p>${action ?? nothing}</div>`;
}
