// Globale Suche (Kopfzeile): Teams, Spieler (Kader), Teilnehmer, Champions – jeweils innerhalb der
// aktuellen Tipprunde bzw. ihrer Turniere. Team-Treffer führen auf eine eigene Team-Seite mit
// Statistik und Favoriten-Knopf; Spieler/Champions führen (noch) nur auf eine "Demnächst"-Seite.

import { teamStats, type StatMatch, type StatTeam } from '../../domain/statistics.ts';
import type { Ctx } from '../app.ts';
import { type Html, html, nothing } from '../html.ts';
import { HttpError, htmlResponse, redirect, type Res, type Router } from '../http.ts';
import { csrfField, emptyState, layout } from '../views/layout.ts';
import { isUuid, loginRedirect } from './common.ts';
import { leagueTournaments, loadLeague } from './league-data.ts';

const tile = (value: string | number, label: string): Html => html`<div class="st-tile"><strong>${value}</strong><span>${label}</span></div>`;

interface TeamHit {
  id: string;
  name: string;
  short_name: string | null;
  region: string | null;
}
interface PlayerHit {
  id: string;
  name: string;
  role: string | null;
  team_name: string;
  team_short: string | null;
}
interface ChampionHit {
  id: string;
  name: string;
}
interface MemberHit {
  id: string;
  display_name: string;
}

function navOf(access: { league: { slug: string; name: string; ended: boolean }; canManage: boolean }) {
  return { slug: access.league.slug, name: access.league.name, canManage: access.canManage, recap: access.league.ended, active: 'statistiken' as const };
}

/** Ergebnis-Gruppe als Liste klickbarer Zeilen. */
function resultList(items: { href: string; title: string; sub?: string }[]): Html {
  return html`<ul class="st-list search-hits">${items.map((i) => html`<li><a class="search-hit" href="${i.href}"><span>${i.title}</span>${i.sub ? html`<span class="muted">${i.sub}</span>` : nothing}</a></li>`)}</ul>`;
}

async function searchPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const q = (ctx.query.get('q') ?? '').trim().slice(0, 80);
  const nav = navOf(access);
  const header = html`<form method="get" action="/r/${league.slug}/suchen" class="filter-bar" role="search">
  <input type="search" name="q" class="filter-q" value="${q}" placeholder="Teams, Spieler, Teilnehmer, Champions …" aria-label="Suchen" autocomplete="off">
</form>`;

  if (!q) {
    const body = html`<h1 class="bk-title">Suche</h1>${header}<p class="muted">Bitte einen Suchbegriff eingeben.</p>`;
    return htmlResponse(layout(ctx, { title: `Suche – ${league.name}`, body, league: nav }));
  }

  const like = `%${q}%`;
  const [teams, players, champions, members] = await Promise.all([
    db.query<TeamHit>(
      `select distinct t.id, t.name, t.short_name, t.region
         from teams t
         join tournament_teams tt on tt.team_id = t.id
         join league_tournaments lt on lt.tournament_id = tt.tournament_id
        where lt.league_id = $1 and (t.name ilike $2 or t.short_name ilike $2)
        order by t.name limit 20`,
      [league.id, like],
    ),
    db.query<PlayerHit>(
      `select distinct p.id, p.name, p.role, t.name as team_name, t.short_name as team_short
         from players p
         join teams t on t.id = p.team_id
         join tournament_teams tt on tt.team_id = t.id
         join league_tournaments lt on lt.tournament_id = tt.tournament_id
        where lt.league_id = $1 and p.active and p.name ilike $2
        order by p.name limit 20`,
      [league.id, like],
    ),
    db.query<ChampionHit>(`select id, name from champions where name ilike $1 order by name limit 20`, [like]),
    db.query<MemberHit>(
      `select u.id, u.display_name from league_members lm join users u on u.id = lm.user_id
        where lm.league_id = $1 and u.display_name ilike $2 order by u.display_name limit 20`,
      [league.id, like],
    ),
  ]);

  const coming = (art: string, name: string) => `/r/${league.slug}/demnaechst?titel=${encodeURIComponent(name)}&art=${art}`;
  const sections: { title: string; body: Html }[] = [
    {
      title: 'Teams',
      body: teams.length
        ? resultList(teams.map((t) => ({ href: `/r/${league.slug}/team/${t.id}`, title: t.short_name ? `${t.name} (${t.short_name})` : t.name, sub: t.region ?? undefined })))
        : html`<p class="muted">Keine Teams gefunden.</p>`,
    },
    {
      title: 'Spieler',
      body: players.length
        ? resultList(players.map((p) => ({ href: coming('spieler', p.name), title: p.name, sub: `${p.team_short || p.team_name}${p.role ? ` · ${p.role}` : ''}` })))
        : html`<p class="muted">Keine Spieler gefunden.</p>`,
    },
    {
      title: 'Teilnehmer',
      body: members.length
        ? resultList(members.map((m) => ({ href: `/r/${league.slug}/spieler/${m.id}`, title: m.display_name })))
        : html`<p class="muted">Keine Teilnehmer gefunden.</p>`,
    },
    {
      title: 'Champions',
      body: champions.length
        ? resultList(champions.map((c) => ({ href: coming('champion', c.name), title: c.name })))
        : html`<p class="muted">Keine Champions gefunden.</p>`,
    },
  ];

  const body = html`<h1 class="bk-title">Suche</h1>${header}
${sections.map((s) => html`<section class="panel"><h2>${s.title}</h2>${s.body}</section>`)}`;
  return htmlResponse(layout(ctx, { title: `Suche „${q}“ – ${league.name}`, body, league: nav }));
}

async function comingSoonPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const titel = (ctx.query.get('titel') ?? '').trim().slice(0, 80) || 'Demnächst verfügbar';
  const body = html`<p class="muted page-note"><a href="/r/${league.slug}/suchen">← Zur Suche</a></p>
<section class="panel">
  <h1>${titel}</h1>
  <p class="muted">Diese Funktion ist noch nicht fertig – schau bald wieder vorbei!</p>
</section>`;
  return htmlResponse(layout(ctx, { title: `Demnächst – ${league.name}`, body, league: navOf(access) }));
}

async function teamPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const teamId = ctx.params.teamId;
  if (!isUuid(teamId)) throw new HttpError(404, 'Nicht gefunden.');

  const team = await db.one<{ id: string; name: string; short_name: string | null; region: string | null }>(
    `select distinct t.id, t.name, t.short_name, t.region
       from teams t join tournament_teams tt on tt.team_id = t.id join league_tournaments lt on lt.tournament_id = tt.tournament_id
      where lt.league_id = $1 and t.id = $2`,
    [league.id, teamId],
  );
  if (!team) throw new HttpError(404, 'Dieses Team gibt es in dieser Tipprunde nicht.');

  const [matchRows, players, favorited] = await Promise.all([
    db.query<{ status: StatMatch['status']; best_of: number; wins_a: number | null; wins_b: number | null; scheduled_at: Date | null;
      ta_id: string | null; ta_name: string | null; ta_short: string | null; ta_region: string | null;
      tb_id: string | null; tb_name: string | null; tb_short: string | null; tb_region: string | null }>(
      `select m.status, m.best_of, m.wins_a, m.wins_b, m.scheduled_at,
              ta.id as ta_id, ta.name as ta_name, ta.short_name as ta_short, ta.region as ta_region,
              tb.id as tb_id, tb.name as tb_name, tb.short_name as tb_short, tb.region as tb_region
         from matches m
         join league_tournaments lt on lt.tournament_id = m.tournament_id
         left join teams ta on ta.id = m.team_a_id
         left join teams tb on tb.id = m.team_b_id
        where lt.league_id = $1 and m.status <> 'cancelled' and (m.team_a_id = $2 or m.team_b_id = $2)`,
      [league.id, teamId],
    ),
    db.query<{ id: string; name: string; role: string | null }>(`select id, name, role from players where team_id = $1 and active order by role, name`, [teamId]),
    db.one(`select 1 from team_favorites where user_id = $1 and team_id = $2`, [ctx.user.id, teamId]),
  ]);

  const asTeam = (id: string | null, name: string | null, short: string | null, region: string | null): StatTeam | null => (id && name ? { id, name, short, region } : null);
  const matches: StatMatch[] = matchRows.map((r) => ({
    teamA: asTeam(r.ta_id, r.ta_name, r.ta_short, r.ta_region),
    teamB: asTeam(r.tb_id, r.tb_name, r.tb_short, r.tb_region),
    winsA: r.wins_a,
    winsB: r.wins_b,
    status: r.status,
    bestOf: r.best_of,
    time: r.scheduled_at?.getTime() ?? Number.MAX_SAFE_INTEGER,
  }));
  const stat = teamStats(matches, [{ id: team.id, name: team.name, short: team.short_name, region: team.region }]).find((r) => r.team.id === team.id)!;

  const title = team.short_name ? `${team.name} (${team.short_name})` : team.name;
  const body = html`<p class="muted page-note"><a href="/r/${league.slug}/suchen">← Zur Suche</a></p>
<section class="panel profile-head">
  <div class="profile-head-info">
    <h1>${title}</h1>
    <p class="muted">${team.region ?? 'Region unbekannt'}</p>
  </div>
  <form method="post" action="/r/${league.slug}/team/${team.id}/favorit">${csrfField(ctx)}
    <button type="submit" class="btn${favorited ? ' btn-primary' : ''}" aria-pressed="${favorited ? 'true' : 'false'}">${favorited ? '★ Favorit' : '☆ Als Favorit markieren'}</button>
  </form>
</section>
<section class="panel">
  <h2>Bilanz in dieser Tipprunde</h2>
  <div class="st-tiles">
    ${tile(`${stat.wins}–${stat.losses}`, 'Siege–Niederlagen')}
    ${tile(stat.winRate === null ? '–' : `${stat.winRate} %`, 'Siegquote')}
    ${tile(`${stat.mapsWon}:${stat.mapsLost}`, 'Maps')}
    ${stat.streak ? tile(`${stat.streak.length}${stat.streak.win ? 'S' : 'N'}`, 'aktuelle Serie') : nothing}
  </div>
  ${favorited ? html`<p class="muted">Du bekommst 1 Stunde vor dem nächsten Spiel dieses Teams eine Push-Benachrichtigung – sofern Push in deinem Konto aktiviert ist.</p>` : nothing}
</section>
<section class="panel">
  <h2>Kader</h2>
  ${
    players.length
      ? html`<ul class="st-list">${players.map((p) => html`<li><span>${p.name}</span><span class="muted">${p.role ?? ''}</span></li>`)}</ul>`
      : html`<p class="muted">Der Kader ist noch nicht abgeglichen.</p>`
  }
</section>`;
  return htmlResponse(layout(ctx, { title: `${title} – ${league.name}`, body, league: navOf(access) }));
}

async function toggleFavorite(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const teamId = ctx.params.teamId;
  if (!isUuid(teamId)) throw new HttpError(404, 'Nicht gefunden.');
  const exists = await db.one(`select 1 from team_favorites where user_id = $1 and team_id = $2`, [ctx.user.id, teamId]);
  if (exists) await db.run(`delete from team_favorites where user_id = $1 and team_id = $2`, [ctx.user.id, teamId]);
  else await db.run(`insert into team_favorites (user_id, team_id) values ($1, $2) on conflict do nothing`, [ctx.user.id, teamId]);
  return redirect(`/r/${league.slug}/team/${teamId}?hinweis=${exists ? 'favorit-entfernt' : 'favorit-gespeichert'}`);
}

export function registerSearchRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/suchen', searchPage);
  router.get('/r/:slug/demnaechst', comingSoonPage);
  router.get('/r/:slug/team/:teamId', teamPage);
  router.post('/r/:slug/team/:teamId/favorit', toggleFavorite);
}
