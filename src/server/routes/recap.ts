// Reiter "Rückblick": erscheint, sobald alle Spiele des Turniers gespielt sind. Höhepunkte der Runde und eine Karte je Mitspieler.

import { computeRecap, type PlayerRecap, type TipNote } from '../../domain/recap.ts';
import type { Ctx } from '../app.ts';
import { html, nothing } from '../html.ts';
import { HttpError, htmlResponse, type Res, type Router } from '../http.ts';
import { badgeIcon } from '../views/badges.ts';
import { avatar, layout } from '../views/layout.ts';
import { loginRedirect } from './common.ts';
import { leagueMatches, loadLeague, toDomainMatch } from './league-data.ts';
import { loadStandings } from './standings-data.ts';

const percent = (share: number) => `${Math.round(share * 100)} %`;

function tipLine(label: string, t: TipNote | null, good: boolean) {
  if (!t) return nothing;
  return html`<li><span class="rc-label">${label}</span><span class="rc-what">${t.match}: <strong>${t.picked}</strong>${good ? html` <span class="pts pts-hit">+${t.points}</span>` : nothing}<small class="muted"> · ${percent(t.share)} der Runde ${t.share === 1 ? 'sah es genauso' : 'sahen es genauso'}</small></span></li>`;
}

function playerCard(ctx: Ctx, slug: string, p: PlayerRecap, avatarAt: Date | null) {
  const empty = !p.bestTip && !p.worstTip;
  return html`<li class="rc-card${p.rank === 1 ? ' rc-first' : ''}">
  <header class="rc-head">
    <span class="rc-rank">${p.rank}.</span>
    <a class="who who-link" href="/r/${slug}/spieler/${p.userId}">${avatar(p.userId, p.displayName, avatarAt)}<span>${p.displayName}</span></a>
    <span class="rc-points"><strong>${p.points}</strong> ${p.points === 1 ? 'Punkt' : 'Punkte'}</span>
  </header>
  <p class="muted rc-sub">Richtige Sieger: ${p.correctWinners} · Exakte Ergebnisse: ${p.exactResults} · Gewertete Tipps: ${p.tips}</p>
  ${
    empty
      ? html`<p class="muted">Keine gewerteten Tipps.</p>`
      : html`<ul class="rc-facts">
    ${tipLine('Bester Tipp', p.bestTip, true)}
    ${tipLine('Pechvogel', p.worstTip, false)}
    ${p.bestPhase ? html`<li><span class="rc-label">Stärkste Phase</span><span class="rc-what"><strong>${p.bestPhase.stage}</strong> <small class="muted">· ${p.bestPhase.points} ${p.bestPhase.points === 1 ? 'Punkt' : 'Punkte'}</small></span></li>` : nothing}
    ${p.favoriteTeam ? html`<li><span class="rc-label">Lieblingsteam</span><span class="rc-what"><strong>${p.favoriteTeam.team}</strong> <small class="muted">· ${p.favoriteTeam.count}× als Sieger getippt</small></span></li>` : nothing}
  </ul>`
  }
  ${p.badges.length ? html`<p class="rc-badges" aria-label="Abzeichen">${p.badges.map((b) => html`<span title="${b.title}">${badgeIcon(b.key, b.level)}</span>`)}</p>` : nothing}
</li>`;
}

async function recapPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  if (!league.ended) throw new HttpError(404, 'Der Rückblick gibt es erst, wenn alle Spiele des Turniers gespielt sind.');
  const { db } = ctx.deps;
  const [standings, rows] = await Promise.all([loadStandings(db, league), leagueMatches(db, league.id)]);
  const info = new Map(rows.map((m) => [m.id, { teamA: m.team_a, teamB: m.team_b, stage: m.stage }]));
  const recap = computeRecap({ ...standings.raw, info, matches: rows.map(toDomainMatch) });

  const names = (list: string[]) => list.join(', ');
  const body = html`<section class="panel rc-winner">
  <h1>Rückblick</h1>
  ${
    recap.champions.length && recap.champions[0].points > 0
      ? html`<p class="rc-crown">${recap.champions.length > 1 ? 'Die Sieger der Tipprunde' : 'Sieger der Tipprunde'}</p>
  <p class="rc-champion">${names(recap.champions.map((c) => c.name))}</p>
  <p class="muted">mit ${recap.champions[0].points} ${recap.champions[0].points === 1 ? 'Punkt' : 'Punkten'} – ${league.name}</p>`
      : html`<p class="muted">Das Turnier ist vorbei. Punkte wurden nicht vergeben.</p>`
  }
  ${
    recap.highlights.length
      ? html`<ul class="rc-highlights">${recap.highlights.map((h) => html`<li><strong>${h.title}</strong><span>${names(h.names)}</span><small class="muted">${h.unit}: ${h.value}</small></li>`)}</ul>`
      : nothing
  }
</section>
<ul class="rc-cards">${recap.players.map((p) => playerCard(ctx, league.slug, p, standings.avatarOf.get(p.userId) ?? null))}</ul>`;
  return htmlResponse(layout(ctx, { title: `Rückblick – ${league.name}`, body, league: { slug: league.slug, name: league.name, canManage: access.canManage, recap: true, active: 'rueckblick' } }));
}

export function registerRecapRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/rueckblick', recapPage);
}
