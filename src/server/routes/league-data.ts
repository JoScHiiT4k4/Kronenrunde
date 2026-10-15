// Daten einer Tipprunde laden (gemeinsam für Tippen, Rangliste, Sonderfragen, Verwaltung).

import type { Ctx } from '../app.ts';
import type { Queryable } from '../db/index.ts';
import type { BestOf, LockMode, Match } from '../../domain/types.ts';
import { HttpError } from '../http.ts';

/** Wer neue Tipprunden anlegen darf (Admin-Bereich): 'admins' oder 'alle' */
export type LeagueCreation = 'admins' | 'alle';

export async function leagueCreation(db: Queryable): Promise<LeagueCreation> {
  const row = await db.one<{ value: string }>(`select value from app_settings where key = 'league_creation'`);
  return row?.value === 'alle' ? 'alle' : 'admins';
}

/** Darf diese Person eine neue Tipprunde anlegen? Admins immer; ohne eingetragene Admins jeder (sonst könnte es niemand freigeben). */
export async function canCreateLeague(ctx: Ctx): Promise<boolean> {
  if (!ctx.user) return false;
  if (ctx.isAdmin || !ctx.deps.config.adminEmails.size) return true;
  return (await leagueCreation(ctx.deps.db)) === 'alle';
}

export interface League {
  id: string;
  name: string;
  slug: string;
  owner_id: string | null;
  invite_code: string;
  points_winner: number;
  points_exact: number;
  lock_mode: LockMode;
  /** Rolle des aktuellen Nutzers oder null (z. B. Admin ohne Mitgliedschaft). */
  role: 'owner' | 'admin' | 'member' | null;
}

export interface LeagueAccess {
  league: League;
  isMember: boolean;
  canManage: boolean;
  isOwner: boolean;
}

/** Tipprunde laden. Nicht-Mitglieder sehen nichts (404), außer Admins mit allowAdmin. */
export async function loadLeague(ctx: Ctx, slug: string, o: { allowAdmin?: boolean } = {}): Promise<LeagueAccess> {
  const league = await ctx.deps.db.one<League>(
    `select l.id, l.name, l.slug, l.owner_id, l.invite_code, l.points_winner, l.points_exact, l.lock_mode, m.role
       from leagues l
       left join league_members m on m.league_id = l.id and m.user_id = $2
      where l.slug = $1`,
    [slug, ctx.user?.id ?? null],
  );
  const isMember = !!league?.role;
  if (!league || (!isMember && !(o.allowAdmin && ctx.isAdmin))) {
    throw new HttpError(404, 'Diese Tipprunde gibt es nicht, oder du bist noch kein Mitglied. Frag nach dem Einladungslink.');
  }
  return {
    league,
    isMember,
    canManage: league.role === 'owner' || league.role === 'admin' || ctx.isAdmin,
    isOwner: league.role === 'owner' || ctx.isAdmin,
  };
}

export interface LeagueTournament {
  id: string;
  name: string;
  /** Frist der Sonderfragen: automatisch der Start des ersten Spiels; null, solange noch kein Spiel mit Termin feststeht */
  bonus_deadline_at: Date | null;
}

export function leagueTournaments(db: Queryable, leagueId: string): Promise<LeagueTournament[]> {
  return db.query<LeagueTournament>(
    `select t.id, t.name, tournament_start(t.id) as bonus_deadline_at
       from league_tournaments lt join tournaments t on t.id = lt.tournament_id
      where lt.league_id = $1
      order by t.starts_on desc nulls last, t.name`,
    [leagueId],
  );
}

export interface MatchRow {
  id: string;
  tournament_id: string;
  tournament: string;
  stage: string | null;
  best_of: BestOf;
  scheduled_at: Date | null;
  matchday_starts_at: Date | null;
  wins_a: number | null;
  wins_b: number | null;
  status: string;
  team_a_id: string | null;
  team_b_id: string | null;
  team_a: string | null;
  team_b: string | null;
  team_a_short: string | null;
  team_b_short: string | null;
  live_at: Date | null;
  /** Ende des vorherigen Spiels desselben Spieltags (für den Tippschluss "automatisch") */
  prev_finished_at: Date | null;
  /** Gibt es an diesem Spieltag ein Spiel davor? */
  has_prev: boolean;
}

const MATCH_SELECT = `
  select m.id, m.tournament_id, t.name as tournament, s.name as stage, m.best_of, m.scheduled_at,
         m.matchday_starts_at, m.wins_a, m.wins_b, m.status, m.team_a_id, m.team_b_id,
         m.live_at, previous_match_finished_at(m.id) as prev_finished_at,
         exists (select 1 from matches p where p.tournament_id = m.tournament_id and p.matchday_starts_at = m.matchday_starts_at
                   and p.status <> 'cancelled' and (p.scheduled_at, p.id) < (m.scheduled_at, m.id)) as has_prev,
         ta.name as team_a, tb.name as team_b, ta.short_name as team_a_short, tb.short_name as team_b_short
    from matches m
    join tournaments t on t.id = m.tournament_id
    left join stages s on s.id = m.stage_id
    left join teams ta on ta.id = m.team_a_id
    left join teams tb on tb.id = m.team_b_id`;

/** Alle Spiele der Turniere einer Tipprunde (ohne abgesagte), nach Anstoß sortiert. */
export function leagueMatches(db: Queryable, leagueId: string): Promise<MatchRow[]> {
  return db.query<MatchRow>(
    `${MATCH_SELECT}
      join league_tournaments lt on lt.tournament_id = m.tournament_id and lt.league_id = $1
     where m.status <> 'cancelled'
     order by m.scheduled_at nulls last, m.id`,
    [leagueId],
  );
}

export function oneMatch(db: Queryable, matchId: string): Promise<MatchRow | null> {
  return db.one<MatchRow>(`${MATCH_SELECT} where m.id = $1`, [matchId]);
}

export function tournamentMatches(db: Queryable, tournamentId: string): Promise<MatchRow[]> {
  return db.query<MatchRow>(`${MATCH_SELECT} where m.tournament_id = $1 order by m.scheduled_at nulls last, m.id`, [tournamentId]);
}

export function toDomainMatch(m: MatchRow): Match {
  return {
    id: m.id,
    bestOf: m.best_of,
    scheduledAt: m.scheduled_at,
    matchdayStartsAt: m.matchday_starts_at,
    teamA: m.team_a_id,
    teamB: m.team_b_id,
    winsA: m.wins_a,
    winsB: m.wins_b,
    liveAt: m.live_at,
    previousFinishedAt: m.prev_finished_at,
  };
}

/** Kurzname eines Teams für knappe Anzeigen (Kürzel, sonst Name). */
export function shortA(m: MatchRow): string {
  return m.team_a_short || m.team_a || 'offen';
}

export function shortB(m: MatchRow): string {
  return m.team_b_short || m.team_b || 'offen';
}

export interface PredictionRow {
  match_id: string;
  user_id: string;
  winner: 'A' | 'B';
  winner_wins: number | null;
  loser_wins: number | null;
}

export function toDomainPrediction(p: PredictionRow) {
  return { matchId: p.match_id, userId: p.user_id, winner: p.winner, winnerWins: p.winner_wins, loserWins: p.loser_wins };
}

export function rulesOf(league: League) {
  return { pointsWinner: league.points_winner, pointsExact: league.points_exact, lockMode: league.lock_mode };
}
