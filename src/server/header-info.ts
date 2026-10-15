// Turnier-Anzeige im Kopf: Countdown bis zum Start, danach Livestream-Links (und "Live", wenn gerade gespielt wird).

import type { Db } from './db/index.ts';

export interface HeaderTournament {
  name: string;
  /** Start des ersten Spiels */
  startsAt: Date;
  /** Läuft gerade ein Spiel? */
  live: boolean;
  /** Turnier hat begonnen und ist noch nicht zu Ende */
  running: boolean;
}

interface Row {
  name: string;
  starts_at: Date;
  live: boolean;
  open: boolean;
}

/** Wählt das passende Turnier: eins mit laufendem Spiel, sonst das nächste anstehende, sonst eines, das noch läuft. */
export function pickTournament(rows: Row[], now: Date): HeaderTournament | null {
  const mk = (r: Row): HeaderTournament => ({ name: r.name, startsAt: r.starts_at, live: r.live, running: r.starts_at <= now });
  const live = rows.find((r) => r.live);
  if (live) return mk(live);
  const upcoming = rows.filter((r) => r.starts_at > now).sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime());
  if (upcoming.length) return mk(upcoming[0]);
  const running = rows.filter((r) => r.open).sort((a, b) => b.starts_at.getTime() - a.starts_at.getTime());
  return running.length ? mk(running[0]) : null;
}

/** Turniere der Tipprunden des Nutzers (oder der Tipprunde, die gerade offen ist); ohne Treffer alle. */
export async function loadHeaderTournament(db: Db, userId: string | null, leagueSlug: string | null, now: Date): Promise<HeaderTournament | null> {
  const sql = (filter: string) => `
    select t.name, tournament_start(t.id) as starts_at,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status = 'live') as live,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status in ('scheduled', 'live')) as open
      from tournaments t
     where tournament_start(t.id) is not null ${filter}`;
  if (leagueSlug) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join leagues l on l.id = lt.league_id where l.slug = $1)'), [leagueSlug]);
    if (rows.length) return pickTournament(rows, now);
  }
  if (userId) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join league_members lm on lm.league_id = lt.league_id where lm.user_id = $1)'), [userId]);
    if (rows.length) return pickTournament(rows, now);
  }
  return pickTournament(await db.query<Row>(sql('')), now);
}
