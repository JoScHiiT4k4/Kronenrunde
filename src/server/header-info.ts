// Turnier-Anzeige im Kopf:
// - vor dem Turnier: "<Name> in <Countdown>" bis zum ersten Spiel
// - solange ein Spiel läuft: "Live"
// - sonst (auch zwischen zwei Spielen am selben Tag): Countdown bis zum Start des nächsten Spiels
// - nach dem Turnier: Countdown zum nächsten Turnier, sobald dessen Termin bekannt ist

import type { Db } from './db/index.ts';

export interface HeaderTournament {
  name: string;
  /** Start des ersten Spiels */
  startsAt: Date;
  /** Läuft gerade ein Spiel (oder müsste es laut Plan schon laufen)? */
  live: boolean;
  /** Turnier hat begonnen und ist noch nicht zu Ende */
  running: boolean;
  /** Läuft das Turnier und gerade kein Spiel: Start der nächsten Begegnung */
  nextStart: Date | null;
}

interface Row {
  id?: string;
  name: string;
  starts_at: Date;
  live: boolean;
  open: boolean;
}

export interface MatchTime {
  at: Date | null;
  status: string;
}

/** Ein Spiel, das laut Plan längst hätte laufen müssen, aber nie gewertet wurde (verschoben/vergessen), zählt nicht mehr. */
const STALE_MS = 6 * 3_600_000;

/**
 * Zustand eines laufenden Turniers: "live", solange ein Spiel läuft (oder angepfiffen sein müsste), sonst der Start des
 * nächsten Spiels – auch zwischen zwei Spielen am selben Tag (Countdown bis dahin).
 */
export function matchdayState(matches: MatchTime[], now: Date): { live: boolean; next: Date | null } {
  const open = matches.filter((m) => m.status === 'live' || (m.status === 'scheduled' && m.at && m.at.getTime() > now.getTime() - STALE_MS));
  if (open.some((m) => m.status === 'live' || (m.at !== null && m.at <= now))) return { live: true, next: null };
  const next = open.map((m) => m.at).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return { live: false, next };
}

/** Reihenfolge der Kandidaten: laufendes Spiel, dann begonnene Turniere, dann das nächste anstehende. Beendete fehlen. */
export function orderTournaments(rows: Row[], now: Date): Row[] {
  const live = rows.filter((r) => r.live);
  const running = rows.filter((r) => !r.live && r.open && r.starts_at <= now).sort((a, b) => b.starts_at.getTime() - a.starts_at.getTime());
  const upcoming = rows.filter((r) => r.starts_at > now).sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
  return [...live, ...running, ...upcoming];
}

/** Wählt das passende Turnier (ohne Spieltag-Zustand): laufendes Spiel, sonst begonnenes, sonst das nächste anstehende. */
export function pickTournament(rows: Row[], now: Date): HeaderTournament | null {
  const first = orderTournaments(rows, now)[0];
  return first ? make(first, now, null) : null;
}

function make(r: Row, now: Date, state: { live: boolean; next: Date | null } | null): HeaderTournament {
  const running = r.starts_at <= now;
  return { name: r.name, startsAt: r.starts_at, live: running ? (state?.live ?? r.live) : false, running, nextStart: running ? (state?.next ?? null) : null };
}

async function choose(db: Db, rows: Row[], now: Date): Promise<HeaderTournament | null> {
  const ordered = orderTournaments(rows, now);
  let fallback: HeaderTournament | null = null;
  for (const r of ordered) {
    if (r.starts_at > now) return make(r, now, null);
    const matches = await db.query<{ at: Date | null; status: string }>(
      `select coalesce(scheduled_at, live_at) as at, status from matches where tournament_id = $1 and status <> 'cancelled'`,
      [r.id],
    );
    const state = matchdayState(matches, now);
    // Ein begonnenes Turnier ohne Spieltag und ohne bekannten nächsten Termin macht Platz für das nächste Turnier
    if (state.live || state.next) return make(r, now, state);
    fallback ??= make(r, now, state);
  }
  return fallback;
}

/** Turniere der Tipprunden des Nutzers (oder der Tipprunde, die gerade offen ist); ohne Treffer alle. */
export async function loadHeaderTournament(db: Db, userId: string | null, leagueSlug: string | null, now: Date): Promise<HeaderTournament | null> {
  const sql = (filter: string) => `
    select t.id, t.name, tournament_start(t.id) as starts_at,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status = 'live') as live,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status in ('scheduled', 'live')) as open
      from tournaments t
     where tournament_start(t.id) is not null ${filter}`;
  if (leagueSlug) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join leagues l on l.id = lt.league_id where l.slug = $1)'), [leagueSlug]);
    if (rows.length) return choose(db, rows, now);
  }
  if (userId) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join league_members lm on lm.league_id = lt.league_id where lm.user_id = $1)'), [userId]);
    if (rows.length) return choose(db, rows, now);
  }
  return choose(db, await db.query<Row>(sql('')), now);
}
