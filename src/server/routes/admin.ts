// Admin-Bereich (nur für ADMIN_EMAILS): Teams, Turniere, Phasen, Spiele und Ergebnisse.
// Das ist die "Datenquelle von Hand". Später kann ein Daten-Dienst (API) dieselben Tabellen füllen.

import { stageLabel } from '../../domain/bracket.ts';
import { resultOptions } from '../../domain/results.ts';
import type { BestOf } from '../../domain/types.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { backupLevel, databaseLevel, formatBytes, formatUptime, LIMITS, type Level, levelOf, nasLevel, percent, readBackups, readSystemInfo } from '../system-info.ts';
import { buildInfo, lastUpdateCheck, lastUpdateInstalled } from '../version.ts';
import { clearChat } from './chat.ts';
import { hideTestLeague, loadTestState, showTestLeague, syncTestLeague } from '../testspiel.ts';
import { runSync, SYNC_LABELS } from '../abgleich.ts';
import type { Ctx } from '../app.ts';
import { PgError } from '../db/index.ts';
import { dayKey, formatDateTime, formatDayLong, formatTime, isLocalInput, toLocalInput } from '../format.ts';
import { attr, type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, filterBar, layout, postButton, tabMenu } from '../views/layout.ts';
import { cleanName, isUuid, loginRedirect } from './common.ts';
import { LEGAL_FIELDS, type LegalKey, loadLegal } from './legal.ts';
import { leagueCreation, type MatchRow, oneMatch, shortA, shortB, tournamentMatches } from './league-data.ts';

function requireAdmin(ctx: Ctx) {
  if (!ctx.isAdmin) throw new HttpError(404, 'Diese Seite gibt es nicht.');
}

function page(ctx: Ctx, title: string, body: Html, error?: string): Res {
  return htmlResponse(layout(ctx, { title, body, error, noRank: true }), error ? 400 : 200);
}

interface Team {
  id: string;
  name: string;
  short_name: string | null;
  region: string | null;
}

function teams(ctx: Ctx) {
  return ctx.deps.db.query<Team>(`select id, name, short_name, region from teams order by region nulls last, name`);
}

function dbError(e: unknown): string {
  if (e instanceof PgError) {
    if (e.code === '23505') return 'Das gibt es schon (der Name ist bereits vergeben).';
    if (e.code === '23514') return 'Die Angaben passen nicht zusammen (z. B. zweimal dasselbe Team oder ein Ergebnis, das nicht zum Format passt).';
    if (e.code === '23503') return 'Das wird noch verwendet und kann deshalb nicht gelöscht werden.';
    if (e.code === 'P0001') return e.message;
  }
  throw e;
}

/** Ergebnis-Auswahl → Siege von Team A und B. */
function parseResult(value: string, bestOf: BestOf): { winsA: number; winsB: number } | null | 'invalid' {
  if (!value) return null;
  const m = /^([AB])(?:-(\d)-(\d))?$/.exec(value);
  if (!m) return 'invalid';
  const w = m[2] === undefined ? 1 : Number(m[2]);
  const l = m[3] === undefined ? 0 : Number(m[3]);
  const option = resultOptions(bestOf).find(
    (o) => o.winner === m[1] && (o.winnerWins ?? 1) === w && (o.loserWins ?? 0) === l,
  );
  if (!option) return 'invalid';
  return m[1] === 'A' ? { winsA: w, winsB: l } : { winsA: l, winsB: w };
}

function resultValue(m: MatchRow): string {
  if (m.wins_a === null || m.wins_b === null) return '';
  const winner = m.wins_a > m.wins_b ? 'A' : 'B';
  if (m.best_of === 1) return winner;
  return `${winner}-${Math.max(m.wins_a, m.wins_b)}-${Math.min(m.wins_a, m.wins_b)}`;
}

function resultSelect(m: MatchRow, name = 'ergebnis'): Html {
  const current = resultValue(m);
  return html`<select name="${name}" aria-label="Ergebnis ${m.team_a ?? ''} gegen ${m.team_b ?? ''}">
    <option value="">Kein Ergebnis</option>
    ${resultOptions(m.best_of).map((o) => {
      const v = o.winnerWins === null ? o.winner : `${o.winner}-${o.winnerWins}-${o.loserWins}`;
      const team = o.winner === 'A' ? shortA(m) : shortB(m);
      return html`<option value="${v}"${attr(v === current, 'selected')}>${team}${o.winnerWins === null ? '' : ` ${o.winnerWins}:${o.loserWins}`}</option>`;
    })}
  </select>`;
}

// ---------------------------------------------------------------------
// Administrator-Bereich der ganzen Seite (Betreiber), in Reitern
// ---------------------------------------------------------------------

const ADMIN_AREAS = [
  ['uebersicht', 'Übersicht'],
  ['nutzer', 'Nutzer'],
  ['system', 'Server'],
  ['backup', 'Backup'],
  ['abgleich', 'Datenabgleich'],
  ['test', 'Test'],
  ['impressum', 'Impressum'],
  ['datenschutz', 'Datenschutz'],
] as const;
type AdminArea = (typeof ADMIN_AREAS)[number][0];

function legalForm(ctx: Ctx, area: AdminArea, keys: LegalKey[], legal: Record<LegalKey, string>, view: string, intro: string): Html {
  return html`<section class="panel">
  <h2>${area === 'impressum' ? 'Impressum' : 'Datenschutzerklärung'}</h2>
  <p class="muted">${intro} <a href="${view}">Seite ansehen</a>. Die Texte sind Vorlagen und keine Rechtsberatung – bitte vor der Veröffentlichung prüfen.</p>
  <form method="post" action="/admin/rechtliches" class="stack">
    ${csrfField(ctx)}
    <input type="hidden" name="bereich" value="${area}">
    ${LEGAL_FIELDS.filter((f) => keys.includes(f.key)).map(
      (f) => html`<label class="field"><span>${f.label}${f.hint ? html` <small class="muted">${f.hint}</small>` : nothing}</span>
      <input type="text" name="${f.key}" value="${legal[f.key]}" maxlength="${f.max}"></label>`,
    )}
    <button type="submit" class="btn btn-primary">Speichern</button>
  </form>
</section>`;
}

/** Anzeige mit Balken; die Farbe (grün/gelb/rot) kommt aus den Schwellwerten in system-info.ts. */
function gauge(label: string, p: number, lvl: Level, detail: string, note?: string): Html {
  return html`<div class="sys-card sys-${lvl}">
    <div class="sys-head"><span class="sys-label">${label}</span><span class="sys-pct">${p} %</span></div>
    <svg class="sys-bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${label}: ${p} Prozent belegt">
      <rect class="sys-track" x="0" y="0" width="100" height="10"/><rect class="sys-fill" x="0" y="0" width="${p}" height="10"/>
    </svg>
    <div class="sys-detail">${detail}</div>
    ${note ? html`<div class="sys-note">${note}</div>` : nothing}
    ${lvl === 'hot' ? html`<div class="sys-alert">Achtung: Schwellwert erreicht</div>` : nothing}
  </div>`;
}

const worst = (a: Level, b: Level): Level => (a === 'hot' || b === 'hot' ? 'hot' : a === 'warm' || b === 'warm' ? 'warm' : 'ok');

async function systemPanel(ctx: Ctx): Promise<Html> {
  const { db } = ctx.deps;
  const sys = readSystemInfo(ctx.deps.config.backupDir);
  const [dbSize, tables, chatRow] = await Promise.all([
    db.one<{ bytes: string }>('select pg_database_size(current_database())::text as bytes'),
    db.query<{ name: string; bytes: string }>(
      `select relname as name, pg_total_relation_size(c.oid)::text as bytes
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by pg_total_relation_size(c.oid) desc limit 6`,
    ),
    db.one<{ n: number }>('select count(*)::int as n from chat_messages'),
  ]);
  const chatCount = chatRow?.n ?? 0;
  const dbBytes = Number(dbSize?.bytes ?? 0);
  const maxTable = Math.max(1, ...tables.map((t) => Number(t.bytes)));
  const load1 = sys.load ? Math.round((sys.load[0] / sys.cores) * 100) : null;
  const temp = sys.temperature;
  const tempPct = temp === null ? 0 : Math.min(100, Math.round((temp / 85) * 100));
  const build = buildInfo();
  const checked = lastUpdateCheck();
  const installed = lastUpdateInstalled();
  const pending = existsSync(ctx.deps.config.updateRequestFile);
  const tz = ctx.deps.config.timeZone;
  // Heute nur die Uhrzeit, sonst mit Datum
  const day = (d: Date) => d.toLocaleDateString('sv', { timeZone: tz });
  const when = (d: Date) => (day(d) === day(ctx.now) ? html`um <strong>${formatTime(d, tz)} Uhr</strong>` : html`am <strong>${formatDateTime(d, tz)} Uhr</strong>`);
  return html`<section class="panel">
  <div class="panel-head">
    <h2>Version &amp; Update</h2>
    <a class="refresh-link" href="/admin?bereich=system" title="Seite aktualisieren" aria-label="Seite aktualisieren"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></a>
  </div>
  <p>Aktuelle Version: <strong>${build.version}</strong>.<br>
  ${checked ? html`Letzte Updatesuche ${when(checked)}.` : html`<span class="muted">Letzte Updatesuche: noch nicht bekannt.</span>`}<br>
  ${installed ? html`Letztes Update installiert ${when(installed)}.` : html`<span class="muted">Letztes Update installiert: noch nicht bekannt.</span>`}</p>
  ${pending ? html`<p class="notice notice-ok">Ein Update ist angefordert und wird gleich installiert.</p>` : nothing}
  <form method="post" action="/admin/update-erzwingen" class="stack">
    ${csrfField(ctx)}
    <button type="submit" class="btn">Jetzt aktualisieren</button>
  </form>
</section>
<section class="panel">
  <h2>Server</h2>
  <p class="muted">So ausgelastet ist der Raspberry Pi gerade. Die Seite zeigt den Stand beim Laden – mit dem Symbol oben bei „Version &amp; Update“ lässt sie sich aktualisieren.</p>
  <div class="sys-grid">
    ${sys.disk ? gauge('Speicherplatz', percent(sys.disk), levelOf(percent(sys.disk), LIMITS.disk), `${formatBytes(sys.disk.used)} von ${formatBytes(sys.disk.total)} belegt – ${formatBytes(sys.disk.total - sys.disk.used)} frei`, `Rot ab ${LIMITS.disk.hot} % – dann droht, dass Datenbank und Sicherungen keinen Platz mehr haben.`) : nothing}
    ${sys.memory ? gauge('Arbeitsspeicher', percent(sys.memory), worst(levelOf(percent(sys.memory), LIMITS.memory), sys.swap ? levelOf(percent(sys.swap), LIMITS.swap) : 'ok'), `${formatBytes(sys.memory.used)} von ${formatBytes(sys.memory.total)} belegt`, `${sys.swap ? `Auslagerung: ${formatBytes(sys.swap.used)} von ${formatBytes(sys.swap.total)}. ` : ''}Rot ab ${LIMITS.memory.hot} % Speicher oder ${LIMITS.swap.hot} % Auslagerung.`) : nothing}
    ${load1 !== null && sys.load ? gauge('Prozessor', Math.min(100, load1), levelOf(load1, LIMITS.cpu), `Last ${sys.load[0].toFixed(2)} (1 Min.) · ${sys.load[1].toFixed(2)} (5 Min.) · ${sys.load[2].toFixed(2)} (15 Min.)`, `${sys.cores} Prozessorkerne – 100 % heißt: alle Kerne voll ausgelastet. Rot ab ${LIMITS.cpu.hot} %.`) : nothing}
    ${temp !== null ? gauge('Temperatur', tempPct, levelOf(temp, LIMITS.temperature), `${temp.toFixed(1).replace('.', ',')} °C`, `Rot ab ${LIMITS.temperature.hot} °C – ab 80 °C drosselt der Pi sich selbst.`) : nothing}
  </div>
  <div class="sys-facts">
    ${sys.uptimeSeconds !== null ? html`<div><span class="muted">Läuft seit</span><strong>${formatUptime(sys.uptimeSeconds)}</strong></div>` : nothing}
    <div class="sys-fact-${databaseLevel(dbBytes, sys.disk ? sys.disk.total - sys.disk.used : null)}"><span class="muted">Datenbank</span><strong>${formatBytes(dbBytes)}</strong></div>
    ${sys.backupBytes !== null ? html`<div class="sys-fact-${backupLevel(sys.backupCount, sys.backupNewest, ctx.now)}"><span class="muted">Sicherungen</span><strong>${formatBytes(sys.backupBytes)} (${sys.backupCount})</strong>
      <small class="muted">${sys.backupNewest ? `Neueste: ${formatDateTime(sys.backupNewest, tz)} Uhr` : 'Noch keine Sicherung'} · rot, wenn älter als ${LIMITS.backupAgeHours.hot} Std.</small></div>` : nothing}
  </div>
  <h3 class="small-title">Größte Tabellen der Datenbank</h3>
  <ul class="sys-tables">
    ${tables.map(
      (t) => html`<li><span>${t.name}</span>
      <svg class="sys-bar sys-bar-thin" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="sys-track" x="0" y="0" width="100" height="6"/><rect class="sys-fill" x="0" y="0" width="${Math.max(1, Math.round((Number(t.bytes) / maxTable) * 100))}" height="6"/></svg>
      <span class="muted">${formatBytes(Number(t.bytes))}</span></li>`,
    )}
  </ul>
</section>
<section class="panel">
  <h2>Chat</h2>
  <p class="muted">Im Chat liegen aktuell ${chatCount} ${chatCount === 1 ? 'Nachricht' : 'Nachrichten'} (alle Tipprunden zusammen). Sie verschwinden nach 7 Tagen von selbst.</p>
  ${postButton(ctx, '/admin/chat-leeren', 'Alle Chatverläufe leeren', { cls: 'btn btn-danger', confirm: 'Wirklich die Chatverläufe ALLER Tipprunden löschen? Das lässt sich nicht rückgängig machen.' })}
</section>`;
}

const BACKUP_PAGE = 10;
const BACKUP_KINDS = [['alle', 'Alle'], ['nacht', 'Nächtlich'], ['manuell', 'Von Hand'], ['update', 'Vor einem Update']] as const;
const KIND_LABEL = { nacht: 'Nächtlich', manuell: 'Von Hand', update: 'Vor einem Update' } as const;

/** Reiter "Backup": Zustand der Sicherungen und ein Knopf für eine Sicherung von Hand. */
async function backupPanel(ctx: Ctx): Promise<Html> {
  const tz = ctx.deps.config.timeZone;
  const sys = readSystemInfo(ctx.deps.config.backupDir);
  const files = readBackups(ctx.deps.config.backupDir);
  // Filter (Adresse ?von=…&bis=…&art=…&seite=…): nur gültige Werte, alles andere heißt "kein Filter"
  // Zeitraum: frühestens der Tag der Inbetriebnahme (erstes Konto bzw. älteste Sicherung), spätestens heute
  const dayOf = (d: Date) => d.toLocaleDateString('sv', { timeZone: tz });
  const firstUser = await ctx.deps.db.one<{ at: Date | null }>('select min(created_at) as at from users');
  const starts = [firstUser?.at, ...files.map((f) => f.at)].filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime());
  const minDay = starts.length ? dayOf(starts[0]) : '';
  const maxDay = dayOf(ctx.now);
  const dateParam = (name: string) => {
    const v = ctx.query.get(name) ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(v) && (!minDay || v >= minDay) && v <= maxDay ? v : '';
  };
  let von = dateParam('von');
  let bis = dateParam('bis');
  if (von && bis && von > bis) [von, bis] = [bis, von];
  const art = BACKUP_KINDS.some(([k]) => k === ctx.query.get('art')) ? ctx.query.get('art')! : 'alle';
  const shown = files.filter((f) => {
    if (art !== 'alle' && f.kind !== art) return false;
    const day = dayOf(f.at);
    return (!von || day >= von) && (!bis || day <= bis);
  });
  const pages = Math.max(1, Math.ceil(shown.length / BACKUP_PAGE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(ctx.query.get('seite'))) || 1));
  const pageItems = shown.slice((page - 1) * BACKUP_PAGE, page * BACKUP_PAGE);
  const filterActive = Boolean(von || bis || art !== 'alle');
  const pageHref = (n: number) => {
    const q = new URLSearchParams({ bereich: 'backup' });
    if (von) q.set('von', von);
    if (bis) q.set('bis', bis);
    if (art !== 'alle') q.set('art', art);
    if (n > 1) q.set('seite', String(n));
    return `/admin?${q}#sicherungen`;
  };
  // Seitenzahlen: erste, letzte und die Nachbarn der aktuellen Seite, dazwischen "…"
  const pageNumbers: (number | null)[] = [];
  for (let n = 1; n <= pages; n += 1) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 1) pageNumbers.push(n);
    else if (pageNumbers[pageNumbers.length - 1] !== null) pageNumbers.push(null);
  }
  const pending = existsSync(ctx.deps.config.backupRequestFile);
  const level = backupLevel(sys.backupCount, sys.backupNewest, ctx.now);
  const ageHours = sys.backupNewest ? Math.floor((ctx.now.getTime() - sys.backupNewest.getTime()) / 3_600_000) : null;
  const ago = ageHours === null ? '' : ageHours < 1 ? 'vor weniger als einer Stunde' : ageHours < 48 ? `vor ${ageHours} Std.` : `vor ${Math.floor(ageHours / 24)} Tagen`;
  return html`<section class="panel">
  <h2>Sicherung der Datenbank</h2>
  <div class="sys-facts">
    <div class="sys-fact-${level}"><span class="muted">Letzte Sicherung</span>
      <strong>${sys.backupNewest ? `${formatDateTime(sys.backupNewest, tz)} Uhr` : 'noch keine'}</strong>
      <small class="muted">${sys.backupNewest ? `${ago} · rot, wenn älter als ${LIMITS.backupAgeHours.hot} Std.` : 'Ohne Sicherung ist bei einem Defekt der SD-Karte alles weg.'}</small></div>
    <div><span class="muted">Auf dem Pi gespeichert</span><strong>${sys.backupBytes !== null ? `${sys.backupCount} (${formatBytes(sys.backupBytes)})` : 'unbekannt'}</strong>
      <small class="muted">nächtlich um 4 Uhr, die letzten 14 bleiben</small></div>
    ${
      sys.nas
        ? html`<div class="sys-fact-${nasLevel(sys.nas, ctx.now)}"><span class="muted">Kopie auf der MyCloud</span><strong>${sys.nas.ok ? 'in Ordnung' : 'fehlgeschlagen'}</strong>
      <small class="muted">${formatDateTime(sys.nas.at, tz)} Uhr${sys.nas.ok ? '' : ` · ${sys.nas.message}`}</small></div>`
        : html`<div><span class="muted">Kopie auf der MyCloud</span><strong>nicht eingerichtet</strong>
      <small class="muted">Einrichten auf dem Pi mit „tippspiel nas-einrichten“; kopiert wird täglich um 7 Uhr</small></div>`
    }
  </div>
  ${pending ? html`<p class="notice notice-ok">Eine Sicherung ist angefordert und wird gleich gemacht.</p>` : nothing}
  <form method="post" action="/admin/backup-erstellen" class="stack">
    ${csrfField(ctx)}
    <p class="muted">Sichert die Datenbank sofort, ohne auf die Nacht zu warten. Die Seite läuft dabei ganz normal weiter. Auf die MyCloud kopiert wird täglich um 7 Uhr die neueste Sicherung.</p>
    <button type="submit" class="btn btn-primary">Jetzt sichern</button>
  </form>
</section>
<section class="panel" id="sicherungen">
  <h2>Vorhandene Sicherungen (${files.length})</h2>
  ${
    files.length
      ? html`<form method="get" action="/admin#sicherungen" class="list-filter" data-auto-filter>
    <input type="hidden" name="bereich" value="backup">
    <label><span class="muted">Von</span>
      <input type="date" name="von" value="${von}" min="${minDay}" max="${bis || maxDay}"></label>
    <label><span class="muted">Bis</span>
      <input type="date" name="bis" value="${bis}" min="${von || minDay}" max="${maxDay}"></label>
    <label><span class="muted">Art</span>
      <select name="art">${BACKUP_KINDS.map(([k, label]) => html`<option value="${k}"${attr(k === art, 'selected')}>${label}</option>`)}</select></label>
    <noscript><button type="submit" class="btn btn-quiet">Filtern</button></noscript>
    ${filterActive ? html`<a class="btn btn-quiet" href="/admin?bereich=backup#sicherungen">Zurücksetzen</a>` : nothing}
  </form>
  ${
    pageItems.length
      ? html`<table class="table compact backup-table"><thead><tr><th>Zeitpunkt</th><th>Art</th><th class="num">Größe</th></tr></thead><tbody>
    ${pageItems.map((f) => html`<tr><td>${formatDateTime(f.at, tz)} Uhr</td><td>${KIND_LABEL[f.kind]}</td><td class="num">${formatBytes(f.bytes)}</td></tr>`)}
  </tbody></table>
  ${pages > 1 ? html`<nav class="pager" aria-label="Seiten">${pageNumbers.map((n) => (n === null ? html`<span class="pager-gap" aria-hidden="true">…</span>` : n === page ? html`<span class="pager-item current" aria-current="page">${n}</span>` : html`<a class="pager-item" href="${pageHref(n)}" aria-label="Seite ${n}">${n}</a>`))}</nav>` : nothing}`
      : html`<p class="muted">Keine Sicherung passt zu diesem Filter.</p>`
  }`
      : html`<p class="muted">Es gibt noch keine Sicherung.</p>`
  }
  <p class="muted">Zurückspielen geht nur auf dem Pi mit <code>tippspiel wiederherstellen</code>. Das ist Absicht, damit es nicht aus Versehen im Browser passiert.</p>
</section>`;
}

async function adminHome(ctx: Ctx, error?: string): Promise<Res> {
  const { db } = ctx.deps;
  const wanted = ctx.query.get('bereich');
  const area: AdminArea = ADMIN_AREAS.find(([k]) => k === wanted)?.[0] ?? 'uebersicht';
  const tz = ctx.deps.config.timeZone;
  let content: Html = nothing;

  if (area === 'uebersicht') {
    const [stats, creation] = await Promise.all([
      db.one<{ users: number; leagues: number; tips: number }>(
        'select (select count(*)::int from users) as users, (select count(*)::int from leagues) as leagues, (select count(*)::int from predictions) as tips',
      ),
      leagueCreation(db),
    ]);
    content = html`<section class="panel">
  <h2>Die Seite in Zahlen</h2>
  <table class="table compact"><tbody>
    <tr><td>Nutzer</td><td class="num">${stats!.users}</td></tr>
    <tr><td>Tipprunden</td><td class="num">${stats!.leagues}</td></tr>
    <tr><td>Abgegebene Tipps</td><td class="num">${stats!.tips}</td></tr>
  </tbody></table>
</section>
<section class="panel">
  <h2>Neue Tipprunden</h2>
  <form method="post" action="/admin/einstellungen" class="stack">
    ${csrfField(ctx)}
    <fieldset class="field">
      <legend>Wer darf neue Tipprunden anlegen?</legend>
      <label class="check"><input type="radio" name="league_creation" value="admins"${attr(creation === 'admins', 'checked')}>
        <span>Nur Administratoren <span class="muted">– für alle anderen ist „Tipprunde erstellen“ ausgeblendet; sie treten über den Einladungslink bei</span></span></label>
      <label class="check"><input type="radio" name="league_creation" value="alle"${attr(creation === 'alle', 'checked')}>
        <span>Jeder mit Konto</span></label>
    </fieldset>
    <button type="submit" class="btn">Speichern</button>
  </form>
</section>`;
  } else if (area === 'nutzer') {
    const users = await db.query<{ id: string; display_name: string; email: string; created_at: Date; leagues: number }>(
      `select u.id, u.display_name, u.email, u.created_at, (select count(*)::int from league_members lm where lm.user_id = u.id) as leagues
         from users u order by u.created_at desc limit 300`,
    );
    content = html`<section class="panel">
  <h2>Nutzer (${users.length})</h2>
  ${filterBar('user-list', 'Name oder E-Mail suchen …')}
  <table class="table compact" id="user-list">
    <thead><tr><th>Name</th><th>E-Mail</th><th class="num">Runden</th><th>Seit</th></tr></thead>
    <tbody>
    ${users.map((u) => html`<tr data-item data-text="${`${u.display_name} ${u.email}`.toLowerCase()}"><td>${u.display_name}</td><td>${u.email}</td><td class="num">${u.leagues}</td><td>${formatDateTime(u.created_at, tz)}</td></tr>`)}
    </tbody>
  </table>
  <p class="muted filter-empty" hidden>Keine Treffer.</p>
</section>`;
  } else if (area === 'system') {
    content = await systemPanel(ctx);
  } else if (area === 'backup') {
    content = await backupPanel(ctx);
  } else if (area === 'abgleich') {
    const [syncRows, counts] = await Promise.all([
      db.query<{ name: string; ok_at: Date | null; details: string | null; error: string | null }>('select name, ok_at, details, error from sync_status'),
      db.one<{ champions: number; players: number }>(
        'select (select count(*)::int from champions) as champions, (select count(*)::int from players where active) as players',
      ),
    ]);
    content = html`<section class="panel">
  <h2>Datenabgleich</h2>
  <p class="muted">Turniere, Spielpläne, Ergebnisse, Champions und Spielerkader kommen automatisch aus den Datenquellen (alle 6 Stunden).
    Bisher: ${counts!.champions} Champions, ${counts!.players} Spieler.</p>
  <table class="table compact"><tbody>
    ${Object.entries(SYNC_LABELS).map(([key, label]) => {
      const r = syncRows.find((x) => x.name === key);
      return html`<tr><td>${label}</td><td>${
        !r ? html`<span class="muted">noch nie</span>`
        : r.error ? html`<strong class="warn">Fehler: ${r.error}</strong>${r.ok_at ? html`<br><small class="muted">zuletzt gut: ${formatDateTime(r.ok_at, tz)} Uhr</small>` : nothing}`
        : html`${formatDateTime(r.ok_at!, tz)} Uhr<br><small class="muted">${r.details}</small>`
      }</td></tr>`;
    })}
  </tbody></table>
  <form method="post" action="/admin/abgleich" class="inline-form form-after">
    ${csrfField(ctx)}
    <button type="submit" class="btn">Jetzt abgleichen</button>
  </form>
</section>`;
  } else if (area === 'test') {
    const st = await loadTestState(db, ctx.user!.id);
    content = html`<section class="panel">
  <h2>Testspiel</h2>
  <p class="muted">Eine zweite Tipprunde nur für dich. Dort siehst du die Seite so, wie sie ein normaler Teilnehmer sieht – ohne Spielleiter- und Administrator-Auswahl. Zum Zurückwechseln nimmst du oben das Dropdown mit den Tipprunden.</p>
  <p>Hauptspiel: <strong>${st.main?.name ?? 'keines gefunden'}</strong><br>
  Testspiel: <strong>${st.visible ? 'eingeblendet' : st.exists ? 'ausgeblendet' : 'noch nicht angelegt'}</strong></p>
  <div class="btn-row">
    ${st.visible ? html`<a class="btn" href="/r/testspiel/tippen">Testspiel öffnen</a>` : nothing}
    ${st.main && !st.visible ? postButton(ctx, '/admin/test/einblenden', st.exists ? 'Testspiel einblenden' : 'Testspiel anlegen und einblenden') : nothing}
    ${st.visible ? postButton(ctx, '/admin/test/abgleichen', 'Mit Hauptspiel abgleichen', { confirm: 'Einstellungen, Turniere und Sonderfragen des Testspiels werden mit dem Hauptspiel überschrieben. Deine Test-Antworten auf Sonderfragen gehen dabei verloren. Fortfahren?' }) : nothing}
    ${st.visible ? postButton(ctx, '/admin/test/ausblenden', 'Testspiel ausblenden', { cls: 'btn btn-danger', confirm: 'Testspiel ausblenden? Deine Test-Tipps dort werden gelöscht.' }) : nothing}
  </div>
  <p class="muted">Abgeglichen werden Punkte, Tippschluss, Turniere und Sonderfragen – nie Teilnehmer, Tipps oder Antworten anderer.</p>
</section>`;
  } else {
    const legal = await loadLegal(ctx);
    content =
      area === 'impressum'
        ? legalForm(ctx, area, ['name', 'street', 'city', 'country', 'email', 'phone'], legal, '/impressum', 'Diese Angaben erscheinen im Impressum.')
        : legalForm(ctx, area, ['hosting'], legal, '/datenschutz', 'Name und Anschrift kommen aus dem Impressum; hier steht nur, wo die Seite läuft.');
  }

  const body = html`<h1 class="small-title">Administrator</h1>
${tabMenu('sub-tabs', 'Bereiche', ADMIN_AREAS.map(([key, label]) => ({ href: `/admin?bereich=${key}`, label, current: area === key })))}
${content}`;
  return page(ctx, 'Administrator', body, error);
}

// ---------------------------------------------------------------------
// Ein Turnier: Phasen und Spiele
// ---------------------------------------------------------------------

async function tournamentPage(ctx: Ctx, error?: string): Promise<Res> {
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const id = ctx.params.id;
  const t = isUuid(id)
    ? await db.one<{ id: string; name: string; starts_on: string | null; ends_on: string | null }>(
        'select id, name, starts_on, ends_on from tournaments where id = $1',
        [id],
      )
    : null;
  if (!t) throw new HttpError(404, 'Dieses Turnier gibt es nicht.');
  const [stages, matches, teamList, entered] = await Promise.all([
    db.query<{ id: string; name: string; position: number }>('select id, name, position from stages where tournament_id = $1 order by position, name', [id]),
    tournamentMatches(db, id),
    teams(ctx),
    db.query<{ team_id: string }>('select team_id from tournament_teams where tournament_id = $1', [id]),
  ]);
  const inTournament = new Set(entered.map((r) => r.team_id));
  const playing = new Set(matches.flatMap((m) => [m.team_a_id, m.team_b_id]).filter((x): x is string => !!x));

  const days = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const k = m.scheduled_at ? dayKey(m.scheduled_at, tz) : 'ohne';
    days.set(k, [...(days.get(k) ?? []), m]);
  }

  const base = `/admin/turnier/${t.id}`;
  const body = html`<section class="panel">
  <p><a href="/admin">Zurück zum Administrator-Bereich</a></p>
  <h1>${t.name}</h1>
  <form method="post" action="${base}" class="stack">
    ${csrfField(ctx)}
    <label class="field"><span>Name</span><input type="text" name="name" value="${t.name}" required maxlength="80"></label>
    <div class="row">
      <label class="field small"><span>Beginn</span><input type="date" name="starts_on" value="${t.starts_on ?? ''}"></label>
      <label class="field small"><span>Ende</span><input type="date" name="ends_on" value="${t.ends_on ?? ''}"></label>
    </div>
    <button type="submit" class="btn">Speichern</button>
  </form>
  <h2>Phasen</h2>
  <p>${stages.map((s, i) => html`${i ? ', ' : ''}${stageLabel(s.name)}`)}${stages.length ? '' : html`<span class="muted">Keine</span>`}</p>
  <form method="post" action="${base}/phase" class="team-row">
    ${csrfField(ctx)}
    <input type="text" name="name" required maxlength="60" placeholder="Neue Phase" aria-label="Neue Phase">
    <button type="submit" class="btn">Hinzufügen</button>
  </form>
</section>

<section class="panel">
  <h2>Teams im Turnier (${new Set([...inTournament, ...playing]).size})</h2>
  <p class="muted">Diese Teams stehen bei Sonderfragen wie „Wer wird Weltmeister?“ zur Auswahl. Teams mit einem Spiel gehören immer dazu.</p>
  ${
    teamList.length
      ? html`<form method="post" action="${base}/teams" class="stack">
    ${csrfField(ctx)}
    <div class="team-checks">
      ${teamList.map(
        (tm) => html`<label class="check"><input type="checkbox" name="team" value="${tm.id}"${attr(inTournament.has(tm.id) || playing.has(tm.id), 'checked')}${attr(playing.has(tm.id), 'disabled')}>
        <span>${tm.name}${tm.region ? html` <small class="muted">${tm.region}</small>` : nothing}</span></label>`,
      )}
    </div>
    <button type="submit" class="btn">Teams speichern</button>
  </form>`
      : html`<p class="muted">Noch keine Teams angelegt.</p>`
  }
</section>

<section class="panel">
  <h2>Spiele (${matches.length})</h2>
  <p class="muted">Ergebnis auswählen und speichern. Spiele mit weniger als 6 Stunden Abstand bilden automatisch einen Spieltag.</p>
  ${[...days.entries()].map(
    ([k, ms]) => html`<h3>${k === 'ohne' ? 'Ohne Termin' : formatDayLong(ms[0].scheduled_at!, tz)}</h3>
    <div class="admin-matches">
    ${ms.map(
      (m) => html`<div class="admin-match${m.wins_a === null && m.scheduled_at && m.scheduled_at < ctx.now ? ' needs-result' : ''}">
      <div><strong>${m.team_a ?? 'offen'} – ${m.team_b ?? 'offen'}</strong>
        <small class="muted">${m.scheduled_at ? formatDateTime(m.scheduled_at, tz) : 'ohne Termin'}, Bo${m.best_of}${m.stage ? `, ${stageLabel(m.stage)}` : ''}${m.status === 'cancelled' ? ', abgesagt' : ''}</small></div>
      ${
        m.team_a_id && m.team_b_id
          ? html`<form method="post" action="/admin/spiel/${m.id}/ergebnis" class="inline-form">
        ${csrfField(ctx)}
        ${resultSelect(m)}
        <button type="submit" class="btn">Speichern</button>
      </form>`
          : nothing
      }
      <a href="/admin/spiel/${m.id}">Bearbeiten</a>
    </div>`,
    )}
    </div>`,
  )}
</section>

<section class="panel">
  <h2>Spiel hinzufügen</h2>
  <form method="post" action="${base}/spiel" class="stack">
    ${csrfField(ctx)}
    ${matchFields(ctx, null, stages, teamList)}
    <button type="submit" class="btn btn-primary">Spiel anlegen</button>
  </form>
</section>`;
  return page(ctx, `${t.name} – Administrator`, body, error);
}

function matchFields(ctx: Ctx, m: MatchRow | null, stages: { id: string; name: string }[], teamList: Team[]): Html {
  const tz = ctx.deps.config.timeZone;
  const teamSelect = (name: string, current: string | null, label: string) => html`<label class="field"><span>${label}</span>
    <select name="${name}">
      <option value="">Steht noch nicht fest</option>
      ${teamList.map((t) => html`<option value="${t.id}"${attr(t.id === current, 'selected')}>${t.name}${t.region ? ` (${t.region})` : ''}</option>`)}
    </select></label>`;
  return html`
    <div class="row">
      ${teamSelect('team_a_id', m?.team_a_id ?? null, 'Team A (links, blaue Seite)')}
      ${teamSelect('team_b_id', m?.team_b_id ?? null, 'Team B (rechts, rote Seite)')}
    </div>
    <div class="row">
      <label class="field small"><span>Format</span>
        <select name="best_of">${[1, 3, 5].map((b) => html`<option value="${b}"${attr((m?.best_of ?? 5) === b, 'selected')}>Bo${b}</option>`)}</select></label>
      <label class="field"><span>Anstoß (deutsche Zeit)</span>
        <input type="datetime-local" name="scheduled_at" value="${toLocalInput(m?.scheduled_at ?? null, tz)}"></label>
    </div>
    <label class="field"><span>Phase</span>
      <select name="stage_id">
        <option value="">Keine</option>
        ${stages.map((s) => html`<option value="${s.id}"${attr(m?.stage === s.name, 'selected')}>${stageLabel(s.name)}</option>`)}
      </select></label>`;
}

interface MatchInput {
  team_a_id: string | null;
  team_b_id: string | null;
  best_of: BestOf;
  scheduled_at: string;
  stage_id: string | null;
}

function readMatch(f: URLSearchParams): MatchInput | string {
  const opt = (k: string) => {
    const v = f.get(k) || null;
    if (v !== null && !isUuid(v)) throw new HttpError(400, 'Ungültige Auswahl.');
    return v;
  };
  const best_of = Number(f.get('best_of')) as BestOf;
  if (![1, 3, 5].includes(best_of)) return 'Bitte wähle das Format (Bo1, Bo3 oder Bo5).';
  const scheduled_at = f.get('scheduled_at') ?? '';
  if (scheduled_at && !isLocalInput(scheduled_at)) return 'Bitte gib Datum und Uhrzeit vollständig an.';
  const input = { team_a_id: opt('team_a_id'), team_b_id: opt('team_b_id'), best_of, scheduled_at, stage_id: opt('stage_id') };
  if (input.team_a_id && input.team_a_id === input.team_b_id) return 'Ein Team kann nicht gegen sich selbst spielen.';
  return input;
}

async function matchPage(ctx: Ctx, error?: string): Promise<Res> {
  const { db, config } = ctx.deps;
  const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
  if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
  const [stages, teamList, tips] = await Promise.all([
    db.query<{ id: string; name: string }>('select id, name from stages where tournament_id = $1 order by position, name', [m.tournament_id]),
    teams(ctx),
    db.one<{ n: number }>('select count(*)::int as n from predictions where match_id = $1', [m.id]),
  ]);
  const body = html`<section class="panel">
  <p><a href="/admin/turnier/${m.tournament_id}">Zurück zu ${m.tournament}</a></p>
  <h1>${m.team_a ?? 'offen'} – ${m.team_b ?? 'offen'}</h1>
  ${tips?.n ? html`<p class="notice notice-warn">Für dieses Spiel gibt es schon ${tips.n} ${tips.n === 1 ? 'Tipp' : 'Tipps'}. Tausche die Teams nur, wenn sie falsch eingetragen waren – Tipps beziehen sich auf Team A bzw. B.</p>` : nothing}
  <form method="post" action="/admin/spiel/${m.id}" class="stack">
    ${csrfField(ctx)}
    ${matchFields(ctx, m, stages, teamList)}
    <div class="row">
      <label class="field"><span>Ergebnis</span>${resultSelect(m)}</label>
      <label class="field"><span>Status</span>
        <select name="status">
          ${(['scheduled', 'live', 'finished', 'cancelled'] as const).map(
            (s) => html`<option value="${s}"${attr(m.status === s, 'selected')}>${{ scheduled: 'Geplant', live: 'Läuft', finished: 'Beendet', cancelled: 'Abgesagt' }[s]}</option>`,
          )}
        </select></label>
    </div>
    <button type="submit" class="btn btn-primary">Speichern</button>
  </form>
  ${postButton(ctx, `/admin/spiel/${m.id}/loeschen`, 'Spiel löschen', {
    cls: 'btn btn-quiet',
    confirm: 'Spiel mit allen Tipps dazu löschen?',
  })}
  <p class="muted">Anstoß: ${m.scheduled_at ? `${formatDateTime(m.scheduled_at, config.timeZone)} Uhr` : 'offen'}</p>
</section>`;
  return page(ctx, 'Spiel bearbeiten – Administrator', body, error);
}

export function registerAdminRoutes(router: Router<Ctx>) {
  const guard = (fn: (ctx: Ctx) => Promise<Res>) => async (ctx: Ctx) => {
    if (!ctx.user) return loginRedirect(ctx);
    requireAdmin(ctx);
    if (ctx.params.id !== undefined && !isUuid(ctx.params.id)) throw new HttpError(404, 'Diese Seite gibt es nicht.');
    return fn(ctx);
  };
  const get = (path: string, fn: (ctx: Ctx) => Promise<Res>) => router.get(path, guard(fn));
  const post = (path: string, fn: (ctx: Ctx) => Promise<Res>) => router.post(path, guard(fn));

  get('/admin', (ctx) => adminHome(ctx));

  post('/admin/einstellungen', async (ctx) => {
    const value = ctx.form.get('league_creation') === 'alle' ? 'alle' : 'admins';
    await ctx.deps.db.run(
      `insert into app_settings (key, value) values ('league_creation', $1)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [value],
    );
    return redirect('/admin?bereich=uebersicht&hinweis=gespeichert');
  });
  get('/admin/turnier/:id', (ctx) => tournamentPage(ctx));
  get('/admin/spiel/:id', (ctx) => matchPage(ctx));

  post('/admin/turnier', async (ctx) => {
    const f = ctx.form;
    const name = cleanName(f.get('name'), 80);
    if (!name) return adminHome(ctx, 'Bitte gib einen Namen ein.');
    const date = (k: string) => (/^\d{4}-\d\d-\d\d$/.test(f.get(k) ?? '') ? f.get(k) : null);
    const stages = (f.get('stages') ?? '').split(/\r?\n/).map((s) => cleanName(s, 60)).filter((s): s is string => !!s);
    const id = await ctx.deps.db.tx(async (q) => {
      const t = await q.one<{ id: string }>(
        'insert into tournaments (name, starts_on, ends_on) values ($1, $2, $3) returning id',
        [name, date('starts_on'), date('ends_on')],
      );
      for (const [i, s] of [...new Set(stages)].entries()) {
        await q.run('insert into stages (tournament_id, name, position) values ($1, $2, $3)', [t!.id, s, i + 1]);
      }
      return t!.id;
    });
    return redirect(`/admin/turnier/${id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id', async (ctx) => {
    const f = ctx.form;
    const name = cleanName(f.get('name'), 80);
    if (!name) return tournamentPage(ctx, 'Bitte gib einen Namen ein.');
    const date = (k: string) => (/^\d{4}-\d\d-\d\d$/.test(f.get(k) ?? '') ? f.get(k) : null);
    await ctx.deps.db.run('update tournaments set name = $2, starts_on = $3, ends_on = $4 where id = $1', [
      ctx.params.id,
      name,
      date('starts_on'),
      date('ends_on'),
    ]);
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id/phase', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 60);
    if (!name) return tournamentPage(ctx, 'Bitte gib einen Namen für die Phase ein.');
    try {
      await ctx.deps.db.run(
        `insert into stages (tournament_id, name, position)
         values ($1, $2, (select coalesce(max(position), 0) + 1 from stages where tournament_id = $1))`,
        [ctx.params.id, name],
      );
    } catch (e) {
      return tournamentPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/test/einblenden', async (ctx) => redirect(`/admin?bereich=test&hinweis=${(await showTestLeague(ctx.deps.db, ctx.user!.id)) ? 'test-eingeblendet' : 'test-fehlt'}`));
  post('/admin/test/abgleichen', async (ctx) => redirect(`/admin?bereich=test&hinweis=${(await syncTestLeague(ctx.deps.db, ctx.user!.id)) ? 'test-abgeglichen' : 'test-fehlt'}`));
  post('/admin/test/ausblenden', async (ctx) => {
    await hideTestLeague(ctx.deps.db, ctx.user!.id);
    return redirect('/admin?bereich=test&hinweis=test-ausgeblendet');
  });

  post('/admin/chat-leeren', async (ctx) => {
    await clearChat(ctx.deps.db);
    return redirect('/admin?bereich=system&hinweis=chat-geleert');
  });

  post('/admin/update-erzwingen', async (ctx) => {
    // Die App darf selbst nichts installieren – sie legt nur eine Anfrage ab; der Pi beobachtet die Datei (deploy/install.sh)
    try {
      writeFileSync(ctx.deps.config.updateRequestFile, `${ctx.now.toISOString()}\n`);
    } catch {
      return adminHome(ctx, 'Das Update konnte nicht angefordert werden. Der Update-Dienst ist auf diesem Server nicht eingerichtet (Version erst von Hand mit "tippspiel update" installieren).');
    }
    return redirect('/admin?bereich=system&hinweis=update-angefordert');
  });

  post('/admin/backup-erstellen', async (ctx) => {
    // Wie beim Update: Die App legt nur eine Anfrage ab, die Sicherung macht der Pi als root (deploy/install.sh)
    try {
      writeFileSync(ctx.deps.config.backupRequestFile, `${ctx.now.toISOString()}\n`);
    } catch {
      return adminHome(ctx, 'Die Sicherung konnte nicht angefordert werden. Der Sicherungs-Dienst ist auf diesem Server nicht eingerichtet (von Hand: "tippspiel sicherung" auf dem Pi).');
    }
    return redirect('/admin?bereich=backup&hinweis=backup-angefordert');
  });

  post('/admin/abgleich', async (ctx) => {
    const results = await runSync(ctx.deps.db, ctx.deps.fetchJson);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) return adminHome(ctx, `Abgleich fehlgeschlagen: ${failed.map((r) => `${SYNC_LABELS[r.name]} – ${r.details}`).join('; ')}`);
    return redirect('/admin?bereich=abgleich&hinweis=abgeglichen');
  });

  post('/admin/turnier/:id/teams', async (ctx) => {
    const id = ctx.params.id;
    if (!isUuid(id)) throw new HttpError(404, 'Dieses Turnier gibt es nicht.');
    const ids = [...new Set(ctx.form.getAll('team').filter(isUuid))];
    try {
      await ctx.deps.db.tx(async (q) => {
        // Abgewählte entfernen – außer Teams, die im Turnier schon ein Spiel haben
        await q.run(
          `delete from tournament_teams tt
            where tt.tournament_id = $1 and not (tt.team_id = any($2::uuid[]))
              and not exists (select 1 from matches m where m.tournament_id = $1 and tt.team_id in (m.team_a_id, m.team_b_id))`,
          [id, ids],
        );
        await q.run('insert into tournament_teams (tournament_id, team_id) select $1, unnest($2::uuid[]) on conflict do nothing', [id, ids]);
      });
    } catch (e) {
      return tournamentPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${id}?hinweis=gespeichert`);
  });

  post('/admin/turnier/:id/spiel', async (ctx) => {
    const input = readMatch(ctx.form);
    if (typeof input === 'string') return tournamentPage(ctx, input);
    try {
      await ctx.deps.db.run(
        `insert into matches (tournament_id, stage_id, team_a_id, team_b_id, best_of, scheduled_at)
         values ($1, $2, $3, $4, $5, case when $6 = '' then null else ($6::timestamp at time zone $7) end)`,
        [ctx.params.id, input.stage_id, input.team_a_id, input.team_b_id, input.best_of, input.scheduled_at, ctx.deps.config.timeZone],
      );
    } catch (e) {
      return tournamentPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${ctx.params.id}?hinweis=gespeichert`);
  });

  post('/admin/spiel/:id', async (ctx) => {
    const { db, config } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    const input = readMatch(ctx.form);
    if (typeof input === 'string') return matchPage(ctx, input);
    const result = parseResult(ctx.form.get('ergebnis') ?? '', input.best_of);
    if (result === 'invalid') return matchPage(ctx, 'Das Ergebnis passt nicht zum Format.');
    let status = ctx.form.get('status') ?? 'scheduled';
    if (!['scheduled', 'live', 'finished', 'cancelled'].includes(status)) status = 'scheduled';
    if (result && status !== 'cancelled') status = 'finished';
    if (!result && status === 'finished') status = 'scheduled';
    try {
      await db.run(
        `update matches set stage_id = $2, team_a_id = $3, team_b_id = $4, best_of = $5,
                scheduled_at = case when $6 = '' then null else ($6::timestamp at time zone $7) end,
                wins_a = $8, wins_b = $9, status = $10
          where id = $1`,
        [m.id, input.stage_id, input.team_a_id, input.team_b_id, input.best_of, input.scheduled_at, config.timeZone,
          result?.winsA ?? null, result?.winsB ?? null, status],
      );
    } catch (e) {
      return matchPage(ctx, dbError(e));
    }
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=gespeichert`);
  });

  post('/admin/spiel/:id/ergebnis', async (ctx) => {
    const { db } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    const result = parseResult(ctx.form.get('ergebnis') ?? '', m.best_of);
    if (result === 'invalid') throw new HttpError(400, 'Das Ergebnis passt nicht zum Format.');
    await db.run(
      `update matches set wins_a = $2::smallint, wins_b = $3::smallint,
              status = case when $4 then 'finished' when status = 'finished' then 'scheduled' else status end
        where id = $1`,
      [m.id, result?.winsA ?? null, result?.winsB ?? null, !!result],
    );
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=ergebnis-gespeichert`);
  });

  post('/admin/spiel/:id/loeschen', async (ctx) => {
    const { db } = ctx.deps;
    const m = isUuid(ctx.params.id) ? await oneMatch(db, ctx.params.id) : null;
    if (!m) throw new HttpError(404, 'Dieses Spiel gibt es nicht.');
    await db.run('delete from matches where id = $1', [m.id]);
    return redirect(`/admin/turnier/${m.tournament_id}?hinweis=spiel-geloescht`);
  });

  post('/admin/team', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 80);
    if (!name) return adminHome(ctx, 'Bitte gib einen Teamnamen ein.');
    try {
      await ctx.deps.db.run('insert into teams (name, short_name, region) values ($1, $2, $3)', [
        name,
        cleanName(ctx.form.get('short_name'), 8),
        cleanName(ctx.form.get('region'), 20),
      ]);
    } catch (e) {
      return adminHome(ctx, dbError(e));
    }
    return redirect('/admin?bereich=uebersicht&hinweis=gespeichert');
  });

  post('/admin/team/:id', async (ctx) => {
    const name = cleanName(ctx.form.get('name'), 80);
    if (!name || !isUuid(ctx.params.id)) return adminHome(ctx, 'Bitte gib einen Teamnamen ein.');
    try {
      await ctx.deps.db.run('update teams set name = $2, short_name = $3, region = $4 where id = $1', [
        ctx.params.id,
        name,
        cleanName(ctx.form.get('short_name'), 8),
        cleanName(ctx.form.get('region'), 20),
      ]);
    } catch (e) {
      return adminHome(ctx, dbError(e));
    }
    return redirect('/admin?bereich=uebersicht&hinweis=gespeichert');
  });
}
