// Reiter "Statistiken": Zahlen zum Turnier, zu den Teams, den Spielern/Rollen und den Champions.
// Berechnung der Spiel-Statistiken: src/domain/statistics.ts. Die Antworten auf Sonderfragen (Lieblings-Spieler, -Champions …)
// zeigen wir erst nach Ablauf der Frist – vorher bleiben sie geheim.

import { regionCounts, type StatMatch, type StatTeam, teamStats, tournamentStat } from '../../domain/statistics.ts';
import type { Ctx } from '../app.ts';
import { type Html, html, nothing } from '../html.ts';
import { htmlResponse, type Res, type Router } from '../http.ts';
import { emptyState, layout } from '../views/layout.ts';
import { isUuid, loginRedirect } from './common.ts';
import { leagueTournaments, loadLeague } from './league-data.ts';

interface Row {
  status: StatMatch['status'];
  best_of: number;
  wins_a: number | null;
  wins_b: number | null;
  scheduled_at: Date | null;
  ta_id: string | null;
  ta_name: string | null;
  ta_short: string | null;
  ta_region: string | null;
  tb_id: string | null;
  tb_name: string | null;
  tb_short: string | null;
  tb_region: string | null;
}

const team = (id: string | null, name: string | null, short: string | null, region: string | null): StatTeam | null => (id && name ? { id, name, short, region } : null);

const ROLES: [string, string][] = [
  ['top', 'Top'],
  ['jungle', 'Jungle'],
  ['mid', 'Mid'],
  ['bottom', 'Bottom'],
  ['support', 'Support'],
];

/** Waagerechter Balken (0–100 %) als SVG – ohne Inline-Styles */
function bar(pct: number, cls = ''): Html {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return html`<svg class="st-bar ${cls}" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="st-track" x="0" y="0" width="100" height="8"/><rect class="st-fill" x="0" y="0" width="${p}" height="8"/></svg>`;
}

const tile = (value: string | number, label: string): Html => html`<div class="st-tile"><strong>${value}</strong><span>${label}</span></div>`;

async function statisticsPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db } = ctx.deps;
  const nav = { slug: league.slug, name: league.name, canManage: access.canManage, active: 'statistiken' as const };

  const tournaments = await leagueTournaments(db, league.id);
  if (!tournaments.length) {
    const body = emptyState('Diese Tipprunde hat noch kein Turnier.', access.canManage ? html`<a class="btn" href="/r/${league.slug}/verwalten?bereich=turniere">Turnier auswählen</a>` : undefined);
    return htmlResponse(layout(ctx, { title: `Statistiken – ${league.name}`, body, league: nav }));
  }
  const wanted = ctx.query.get('turnier');
  const tournament = (isUuid(wanted) && tournaments.find((t) => t.id === wanted)) || tournaments[0];

  const [rows, teamRows, roleRows, champs, answers] = await Promise.all([
    db.query<Row>(
      `select m.status, m.best_of, m.wins_a, m.wins_b, m.scheduled_at,
              ta.id as ta_id, ta.name as ta_name, ta.short_name as ta_short, ta.region as ta_region,
              tb.id as tb_id, tb.name as tb_name, tb.short_name as tb_short, tb.region as tb_region
         from matches m left join teams ta on ta.id = m.team_a_id left join teams tb on tb.id = m.team_b_id
        where m.tournament_id = $1 and m.status <> 'cancelled'`,
      [tournament.id],
    ),
    db.query<{ id: string; name: string; short_name: string | null; region: string | null }>(
      `select t.id, t.name, t.short_name, t.region from tournament_teams tt join teams t on t.id = tt.team_id where tt.tournament_id = $1`,
      [tournament.id],
    ),
    db.query<{ role: string | null; n: number }>(
      `select p.role, count(*)::int as n from players p join tournament_teams tt on tt.team_id = p.team_id
        where tt.tournament_id = $1 and p.active group by p.role`,
      [tournament.id],
    ),
    db.one<{ n: number }>('select count(*)::int as n from champions'),
    tournament.bonus_deadline_at && ctx.now >= tournament.bonus_deadline_at
      ? db.query<{ question: string; answer: string; n: number }>(
          `select q.question, a.answer, count(*)::int as n
             from bonus_questions q join bonus_answers a on a.question_id = q.id
            where q.league_id = $1 and q.tournament_id = $2
            group by q.id, q.position, q.question, a.answer order by q.position, q.id, n desc, a.answer`,
          [league.id, tournament.id],
        )
      : Promise.resolve(null),
  ]);

  const matches: StatMatch[] = rows.map((r) => ({
    teamA: team(r.ta_id, r.ta_name, r.ta_short, r.ta_region),
    teamB: team(r.tb_id, r.tb_name, r.tb_short, r.tb_region),
    winsA: r.wins_a,
    winsB: r.wins_b,
    status: r.status,
    bestOf: r.best_of,
    time: r.scheduled_at?.getTime() ?? Number.MAX_SAFE_INTEGER,
  }));
  const teams: StatTeam[] = teamRows.map((t) => ({ id: t.id, name: t.name, short: t.short_name, region: t.region }));
  const t = tournamentStat(matches);
  const table = teamStats(matches, teams);
  const regions = regionCounts(table.map((r) => r.team));
  const maxRegion = Math.max(1, ...regions.map((r) => r.count));
  const roleCount = new Map(roleRows.map((r) => [r.role ?? '', r.n]));
  const players = roleRows.reduce((s, r) => s + r.n, 0);
  const maxRole = Math.max(1, ...ROLES.map(([k]) => roleCount.get(k) ?? 0));

  // Sonderfragen: je Frage die drei beliebtesten Antworten
  const byQuestion = new Map<string, { answer: string; n: number }[]>();
  for (const a of answers ?? []) byQuestion.set(a.question, [...(byQuestion.get(a.question) ?? []), { answer: a.answer, n: a.n }]);

  const tabs =
    tournaments.length > 1
      ? html`<nav class="phase-tabs" aria-label="Turniere">${tournaments.map((x) => html`<a href="/r/${league.slug}/statistiken?turnier=${x.id}"${x.id === tournament.id ? html` aria-current="page"` : nothing}>${x.name}</a>`)}</nav>`
      : nothing;

  const body = html`${tabs}
<h1 class="bk-title">Statistiken – ${tournament.name}</h1>

<section class="panel">
  <h2>Das Turnier in Zahlen</h2>
  <div class="st-tiles">
    ${tile(t.finished, t.finished === 1 ? 'Serie gespielt' : 'Serien gespielt')}
    ${tile(t.live + t.open, 'noch offen')}
    ${tile(t.maps, 'Maps gespielt')}
    ${tile(t.mapsPerSeries === null ? '–' : String(t.mapsPerSeries).replace('.', ','), 'Maps pro Serie')}
    ${tile(t.sweeps, 'Sweeps (Bo3/Bo5 ohne Map-Gewinn des Gegners)')}
    ${tile(t.fullDistance, 'Serien über die volle Distanz')}
  </div>
</section>

<section class="panel">
  <h2>Teams</h2>
  ${
    table.length
      ? html`<table class="table compact st-table">
    <thead><tr><th>Team</th><th>Region</th><th class="num">Serien</th><th class="num">Maps</th><th class="st-quote">Siegquote</th><th>Serie</th></tr></thead>
    <tbody>
    ${table.map(
      (r) => html`<tr>
      <td title="${r.team.name}"><strong>${r.team.short || r.team.name}</strong></td>
      <td class="muted">${r.team.region ?? ''}</td>
      <td class="num">${r.wins}–${r.losses}</td>
      <td class="num">${r.mapsWon}–${r.mapsLost}</td>
      <td class="st-quote">${r.winRate === null ? html`<span class="muted">–</span>` : html`${bar(r.winRate)}<span class="st-pct">${r.winRate} %</span>`}</td>
      <td>${r.streak ? html`<span class="st-streak ${r.streak.win ? 'st-win' : 'st-loss'}">${r.streak.length}${r.streak.win ? 'S' : 'N'}</span>` : html`<span class="muted">–</span>`}</td>
    </tr>`,
    )}
    </tbody>
  </table>
  <p class="muted st-hint">Serien = gewonnene–verlorene Begegnungen, Maps = gewonnene–verlorene Einzelspiele. Serie: S = Siege in Folge, N = Niederlagen in Folge.</p>`
      : html`<p class="muted">Noch keine Teams eingetragen.</p>`
  }
  ${
    regions.length > 1
      ? html`<h3 class="small-title">Teams nach Region</h3>
  <ul class="st-list">${regions.map((r) => html`<li><span>${r.region}</span>${bar((r.count / maxRegion) * 100)}<span class="muted">${r.count}</span></li>`)}</ul>`
      : nothing
  }
</section>

<section class="panel">
  <h2>Spieler</h2>
  ${
    players
      ? html`<p class="muted">${players} Spieler in ${teams.length} Teams. Verteilung auf die Rollen:</p>
  <ul class="st-list">${ROLES.map(([k, label]) => html`<li><span>${label}</span>${bar(((roleCount.get(k) ?? 0) / maxRole) * 100)}<span class="muted">${roleCount.get(k) ?? 0}</span></li>`)}</ul>`
      : html`<p class="muted">Die Kader sind noch nicht abgeglichen.</p>`
  }
</section>

<section class="panel">
  <h2>Champions & Tipps der Runde</h2>
  <p class="muted">${champs?.n ? `${champs.n} Champions im aktuellen Pool.` : 'Der Champion-Pool ist noch nicht abgeglichen.'} Zu einzelnen Spielen und Champions liefert die Datenquelle bisher keine Zahlen – hier siehst du, was deine Runde bei den Sonderfragen tippt.</p>
  ${
    answers === null
      ? html`<p class="muted">Die Antworten der anderen sind ab dem Start des ersten Spiels sichtbar.</p>`
      : byQuestion.size
        ? [...byQuestion].map(([q, list]) => {
            const max = Math.max(1, ...list.map((x) => x.n));
            return html`<h3 class="small-title">${q}</h3>
    <ul class="st-list">${list.slice(0, 3).map((x) => html`<li><span>${x.answer}</span>${bar((x.n / max) * 100)}<span class="muted">${x.n}×</span></li>`)}</ul>`;
          })
        : html`<p class="muted">Noch keine Antworten abgegeben.</p>`
  }
</section>`;
  return htmlResponse(layout(ctx, { title: `Statistiken – ${league.name}`, body, league: nav }));
}

export function registerStatisticsRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/statistiken', statisticsPage);
}
