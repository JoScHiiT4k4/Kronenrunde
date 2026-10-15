// Reiter "Turnierbaum": alle Phasen eines Turniers (Play-In, Swiss, K.-o.-Phase …) mit Begegnungen und Ergebnissen.
// Ausgeschiedene Teams sind ausgegraut. Die Berechnung steht in src/domain/bracket.ts.

import {
  type BracketMatch,
  type BracketTeam,
  buildPhases,
  currentPhase,
  markFor,
  outcome,
  type Phase,
  type TeamRecord,
} from '../../domain/bracket.ts';
import { BOX_H, BOX_W, layoutTree, META_H, ROW_H, type TreeLayout, type TreeNode } from '../../domain/bracket-layout.ts';
import type { Ctx } from '../app.ts';
import { formatDateTime } from '../format.ts';
import { type Html, html, nothing } from '../html.ts';
import { htmlResponse, type Res, type Router } from '../http.ts';
import { emptyState, layout } from '../views/layout.ts';
import { isUuid, loginRedirect, slugify } from './common.ts';
import { leagueTournaments, loadLeague } from './league-data.ts';

interface Row {
  id: string;
  stage: string | null;
  stage_position: number;
  best_of: number;
  scheduled_at: Date | null;
  status: BracketMatch['status'];
  wins_a: number | null;
  wins_b: number | null;
  ta_id: string | null;
  ta_name: string | null;
  ta_short: string | null;
  tb_id: string | null;
  tb_name: string | null;
  tb_short: string | null;
}

function toTeam(id: string | null, name: string | null, short: string | null): BracketTeam | null {
  return id && name ? { id, name, short } : null;
}

function toMatch(r: Row): BracketMatch {
  return {
    id: r.id,
    stage: r.stage,
    stagePosition: r.stage_position,
    bestOf: r.best_of,
    scheduledAt: r.scheduled_at,
    status: r.status,
    teamA: toTeam(r.ta_id, r.ta_name, r.ta_short),
    teamB: toTeam(r.tb_id, r.tb_name, r.tb_short),
    winsA: r.wins_a,
    winsB: r.wins_b,
  };
}

const phaseSlug = (name: string) => slugify(name) || 'phase';

const PHASE_NOTES: Record<Phase['kind'], string> = {
  swiss: 'Schweizer System: Wer 3 Siege hat, ist weiter, wer 3 Niederlagen hat, scheidet aus. Gespielt wird gegen Teams mit gleicher Bilanz.',
  doppel: 'Double Elimination: Wer im Upper Bracket verliert, fällt ins Lower Bracket. Wer zweimal verliert, scheidet aus. Nur der Sieger des Finals kommt weiter.',
  ko: 'Single Elimination: Wer verliert, scheidet aus.',
  offen: '',
};

function teamRow(side: 'a' | 'b', team: BracketTeam | null, wins: number | null, result: 'won' | 'lost' | null, mark: ReturnType<typeof markFor>): Html {
  const cls = ['bk-team', `bk-${side}`];
  if (result) cls.push(`bk-${result}`);
  if (mark === 'ausgeschieden') cls.push('bk-out');
  else if (mark) cls.push('bk-through');
  return html`<div class="${cls.join(' ')}">
    ${
      team
        ? html`<span class="bk-name" title="${team.name}">${team.short || team.name}</span>`
        : html`<span class="bk-name bk-tbd">offen</span>`
    }
    ${mark === 'weiter' ? html`<span class="bk-tag">weiter</span>` : nothing}
    ${mark === 'sieger' ? html`<span class="bk-tag">Sieger</span>` : nothing}
    ${mark === 'ausgeschieden' ? html`<span class="sr-only">(ausgeschieden)</span>` : nothing}
    <span class="bk-score">${wins ?? ''}</span>
  </div>`;
}

function matchBox(slug: string, phase: Phase, m: BracketMatch, tz: string): Html {
  const o = outcome(m);
  const markA = m.teamA ? markFor(phase, m.teamA.id, m.id) : null;
  const markB = m.teamB ? markFor(phase, m.teamB.id, m.id) : null;
  const showScore = o !== null;
  const inner = html`<div class="bk-meta">
    <span>${m.scheduledAt ? formatDateTime(m.scheduledAt, tz) : 'Termin offen'}</span>
    <span>${m.status === 'live' ? html`<span class="live">läuft</span> ` : nothing}<span class="bo">Bo${m.bestOf}</span></span>
  </div>
  ${teamRow('a', m.teamA, showScore ? m.winsA : null, o ? (o.winner.id === m.teamA?.id ? 'won' : 'lost') : null, markA)}
  ${teamRow('b', m.teamB, showScore ? m.winsB : null, o ? (o.winner.id === m.teamB?.id ? 'won' : 'lost') : null, markB)}`;
  const cls = `bk-match${m.status === 'live' ? ' bk-live' : ''}`;
  // Nur Begegnungen mit feststehenden Teams führen zur Spielseite
  return m.teamA && m.teamB
    ? html`<a class="${cls}" href="/r/${slug}/spiel/${m.id}" aria-label="${m.teamA.name} gegen ${m.teamB.name}">${inner}</a>`
    : html`<div class="${cls} bk-open">${inner}</div>`;
}

function treeNode(slug: string, phase: Phase, n: TreeNode, tz: string): Html {
  const m = n.match;
  const o = outcome(m);
  const row = (side: 'a' | 'b', team: BracketTeam | null, wins: number | null, i: number): Html => {
    const mark = team ? markFor(phase, team.id, m.id) : null;
    const result = o && team ? (o.winner.id === team.id ? 'won' : 'lost') : null;
    const cls = ['bk-row', `bk-${side}`];
    if (result) cls.push(`bk-${result}`);
    if (mark === 'ausgeschieden') cls.push('bk-out');
    else if (mark) cls.push('bk-through');
    const y = META_H + i * ROW_H;
    return html`<g class="${cls.join(' ')}">
      <rect class="bk-stripe" x="0" y="${y}" width="3" height="${ROW_H}"/>
      <text class="bk-t-name${team ? '' : ' bk-t-tbd'}" x="14" y="${y + ROW_H / 2 + 6}">${team ? team.short || team.name : 'offen'}</text>
      ${mark === 'weiter' || mark === 'sieger' ? html`<text class="bk-t-tag" x="${BOX_W - 40}" y="${y + ROW_H / 2 + 5}" text-anchor="end">${mark === 'sieger' ? 'Sieger' : 'weiter'}</text>` : nothing}
      <text class="bk-t-score" x="${BOX_W - 12}" y="${y + ROW_H / 2 + 6}" text-anchor="end">${o ? (wins ?? '') : ''}</text>
    </g>`;
  };
  const inner = html`<rect class="bk-box" width="${BOX_W}" height="${BOX_H}"/>
    <line class="bk-sep" x1="0" y1="${META_H + ROW_H}" x2="${BOX_W}" y2="${META_H + ROW_H}"/>
    <text class="bk-t-meta" x="12" y="${META_H - 9}">${m.scheduledAt ? formatDateTime(m.scheduledAt, tz) : 'Termin offen'}</text>
    <text class="bk-t-meta bk-t-bo" x="${BOX_W - 12}" y="${META_H - 9}" text-anchor="end">${m.status === 'live' ? 'läuft · ' : ''}Bo${m.bestOf}</text>
    ${row('a', m.teamA, m.winsA, 0)}${row('b', m.teamB, m.winsB, 1)}`;
  const label = m.teamA && m.teamB ? `${m.teamA.name} gegen ${m.teamB.name}${o ? ` – ${o.winner.name} gewinnt` : ''}` : 'Paarung noch offen';
  const cls = `bk-match${m.status === 'live' ? ' bk-live' : ''}`;
  const pos = `translate(${n.x} ${n.y})`;
  return m.teamA && m.teamB
    ? html`<a class="${cls}" href="/r/${slug}/spiel/${m.id}" transform="${pos}" aria-label="${label}">${inner}</a>`
    : html`<g class="${cls} bk-open" transform="${pos}" role="img" aria-label="${label}">${inner}</g>`;
}

function tree(slug: string, phase: Phase, t: TreeLayout, tz: string): Html {
  return html`<div class="bracket bracket-tree" tabindex="0" role="region" aria-label="Turnierbaum ${phase.name}">
  <svg class="bk-svg" width="${t.width}" height="${t.height}" viewBox="0 0 ${t.width} ${t.height}">
    ${t.edges.map((e) => html`<path class="bk-edge bk-edge-${e.kind}" d="${e.d}"/>${e.arrow ? html`<path class="bk-edge bk-edge-${e.kind} bk-arrow" d="${e.arrow}"/>` : nothing}`)}
    ${t.titles.map((x) => html`<text class="bk-rtitle" x="${x.x}" y="${x.y}">${x.text}</text>`)}
    ${t.nodes.map((n) => treeNode(slug, phase, n, tz))}
  </svg>
</div>`;
}

/** Swiss: eine Zeile je Spiel statt großer Kästen; die Runden klappen auf und zu (die aktuelle ist offen). */
function swissRounds(slug: string, phase: Phase, tz: string): Html {
  const isOpen = (r: Phase['rounds'][number]) => r.matches.some((m) => m.status === 'live');
  // Aufgeklappt: Runde mit laufendem Spiel, sonst die erste mit offenen Spielen, sonst die letzte
  const target = phase.rounds.find(isOpen) ?? phase.rounds.find((r) => r.matches.some((m) => m.status === 'scheduled')) ?? phase.rounds.at(-1);
  const line = (m: BracketMatch): Html => {
    const o = outcome(m);
    const side = (t: BracketTeam | null, cls: 'a' | 'b'): Html => {
      const mark = t ? markFor(phase, t.id, m.id) : null;
      const result = o && t ? (o.winner.id === t.id ? ' sw-won' : ' sw-lost') : '';
      return html`<span class="sw-team sw-${cls}${result}${mark === 'ausgeschieden' ? ' bk-out' : ''}">${t ? html`<span class="sw-name" title="${t.name}">${t.short || t.name}</span>` : html`<span class="sw-name bk-tbd">offen</span>`}</span>`;
    };
    const score = o ? html`<span class="sw-score">${m.winsA}<i>:</i>${m.winsB}</span>` : html`<span class="sw-score sw-vs">vs</span>`;
    const meta = html`<span class="sw-meta">${m.status === 'live' ? html`<span class="live">läuft</span> ` : nothing}${m.scheduledAt ? formatDateTime(m.scheduledAt, tz) : 'Termin offen'} · Bo${m.bestOf}</span>`;
    const inner = html`${side(m.teamA, 'a')}${score}${side(m.teamB, 'b')}${meta}`;
    return m.teamA && m.teamB
      ? html`<a class="sw-match${m.status === 'live' ? ' sw-live' : ''}" href="/r/${slug}/spiel/${m.id}" aria-label="${m.teamA.name} gegen ${m.teamB.name}">${inner}</a>`
      : html`<div class="sw-match sw-open">${inner}</div>`;
  };
  return html`<div class="swiss-rounds" aria-label="Spiele ${phase.name}">
  ${phase.rounds.map((r) => {
    const done = r.matches.filter((m) => outcome(m)).length;
    return html`<details class="sw-round"${r === target ? html` open` : nothing}>
    <summary><span class="sw-title">${r.name}</span><span class="sw-count">${done}/${r.matches.length} gespielt</span></summary>
    <div class="sw-list">${r.matches.map(line)}</div>
  </details>`;
  })}
</div>`;
}

function rounds(slug: string, phase: Phase, tz: string): Html {
  if (phase.kind === 'swiss') return swissRounds(slug, phase, tz);
  const layout = layoutTree(phase);
  if (layout) return tree(slug, phase, layout, tz);
  const flow = phase.kind === 'offen';
  return html`<div class="bracket${flow ? ' is-flow' : ''}" tabindex="0" role="region" aria-label="Turnierbaum ${phase.name}">
  ${phase.rounds.map(
    (r) => html`<section class="bk-round">
    <h3 class="bk-round-title">${r.name}</h3>
    <div class="bk-round-list">${r.matches.map((m) => matchBox(slug, phase, m, tz))}</div>
  </section>`,
  )}
</div>`;
}

function stateLabel(r: TeamRecord): string {
  return r.state === 'ausgeschieden' ? 'ausgeschieden' : r.state === 'weiter' ? 'weiter' : r.state === 'sieger' ? 'Sieger' : 'dabei';
}

/** Swiss: Tabelle mit Bilanz (Siege–Niederlagen) und Stand je Team. */
function swissTable(phase: Phase): Html {
  if (!phase.records.length) return nothing;
  return html`<table class="table compact bk-table">
  <thead><tr><th>Team</th><th class="num">Bilanz</th><th>Stand</th></tr></thead>
  <tbody>
  ${phase.records.map(
    (r) => html`<tr class="${r.state === 'ausgeschieden' ? 'bk-out' : r.state === 'weiter' ? 'bk-through' : ''}">
    <td title="${r.team.name}">${r.team.short ? html`${r.team.short} <span class="muted">${r.team.name}</span>` : r.team.name}</td>
    <td class="num">${r.wins}–${r.losses}</td>
    <td>${stateLabel(r)}</td>
  </tr>`,
  )}
  </tbody>
</table>`;
}

/** Play-In und K.-o.-Phase: Teams als Schilder, ausgeschiedene grau. */
function teamChips(phase: Phase): Html {
  if (!phase.records.length) return nothing;
  return html`<ul class="bk-teams" aria-label="Teams">
  ${phase.records.map(
    (r) => html`<li class="bk-chip${r.state === 'ausgeschieden' ? ' bk-out' : r.state === 'aktiv' ? '' : ' bk-through'}" title="${r.team.name}">${r.team.short || r.team.name}<span class="sr-only"> (${stateLabel(r)})</span></li>`,
  )}
</ul>`;
}

async function bracketPage(ctx: Ctx): Promise<Res> {
  if (!ctx.user) return loginRedirect(ctx);
  const access = await loadLeague(ctx, ctx.params.slug);
  const { league } = access;
  const { db, config } = ctx.deps;
  const tz = config.timeZone;
  const nav = { slug: league.slug, name: league.name, canManage: access.canManage, active: 'turnierbaum' as const };

  const tournaments = await leagueTournaments(db, league.id);
  if (!tournaments.length) {
    const body = emptyState(
      'Diese Tipprunde hat noch kein Turnier.',
      access.canManage ? html`<a class="btn" href="/r/${league.slug}/verwalten?bereich=turniere">Turnier auswählen</a>` : undefined,
    );
    return htmlResponse(layout(ctx, { title: `Turnierbaum – ${league.name}`, body, league: nav }));
  }

  // Nur Turniere dieser Tipprunde sind wählbar; ohne Auswahl das jüngste
  const wanted = ctx.query.get('turnier');
  const tournament = (isUuid(wanted) && tournaments.find((t) => t.id === wanted)) || tournaments[0];
  const rows = await db.query<Row>(
    `select m.id, s.name as stage, coalesce(s.position, 0) as stage_position, m.best_of, m.scheduled_at, m.status,
            m.wins_a, m.wins_b,
            ta.id as ta_id, ta.name as ta_name, ta.short_name as ta_short,
            tb.id as tb_id, tb.name as tb_name, tb.short_name as tb_short
       from matches m
       left join stages s on s.id = m.stage_id
       left join teams ta on ta.id = m.team_a_id
       left join teams tb on tb.id = m.team_b_id
      where m.tournament_id = $1 and m.status <> 'cancelled'
      order by m.scheduled_at nulls last, m.id`,
    [tournament.id],
  );
  const phases = buildPhases(rows.map(toMatch));
  const current = phases.find((p) => phaseSlug(p.name) === ctx.query.get('phase')) ?? currentPhase(phases);

  const href = (phase: Phase) =>
    `/r/${league.slug}/turnierbaum?${tournaments.length > 1 ? `turnier=${tournament.id}&` : ''}phase=${phaseSlug(phase.name)}`;
  const tournamentTabs =
    tournaments.length > 1
      ? html`<nav class="phase-tabs" aria-label="Turniere">
    ${tournaments.map((t) => html`<a href="/r/${league.slug}/turnierbaum?turnier=${t.id}"${t.id === tournament.id ? html` aria-current="page"` : nothing}>${t.name}</a>`)}
  </nav>`
      : nothing;
  const phaseTabs =
    phases.length > 1
      ? html`<nav class="phase-tabs" aria-label="Phasen">
    ${phases.map((p) => html`<a href="${href(p)}"${p === current ? html` aria-current="page"` : nothing}>${p.name}</a>`)}
  </nav>`
      : nothing;

  const hasMarks = !!current && current.kind !== 'offen';
  const body = html`
${tournamentTabs}
<h1 class="bk-title">${tournament.name}</h1>
${
  !current
    ? emptyState('Für dieses Turnier sind noch keine Spiele eingetragen.')
    : html`${phaseTabs}
${PHASE_NOTES[current.kind] ? html`<p class="bk-note">${PHASE_NOTES[current.kind]}</p>` : nothing}
${
  hasMarks
    ? html`<p class="bk-legend" aria-hidden="true"><span class="bk-key bk-key-through">weiter / Sieger</span><span class="bk-key bk-key-out">ausgeschieden</span>${current.kind === 'doppel' ? html`<span class="bk-key bk-key-line">Sieger</span><span class="bk-key bk-key-line bk-key-dash">Verlierer</span>` : nothing}</p>`
    : nothing
}
${current.kind === 'swiss' ? swissTable(current) : current.kind === 'doppel' || current.kind === 'ko' ? teamChips(current) : nothing}
${rounds(league.slug, current, tz)}
<p class="muted bk-hint">Tippe auf eine Begegnung, um das Spiel zu öffnen. Noch offene Paarungen füllen sich, sobald die Teams feststehen.</p>`
}`;
  return htmlResponse(layout(ctx, { title: `Turnierbaum – ${league.name}`, body, league: nav, wide: true }));
}

export function registerBracketRoutes(router: Router<Ctx>) {
  router.get('/r/:slug/turnierbaum', bracketPage);
}
