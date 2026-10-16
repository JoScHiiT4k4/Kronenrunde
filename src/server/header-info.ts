// Turnier-Anzeige im Kopf:
// - vor dem Turnier: "<Name> in <Countdown>" bis zum ersten Spiel
// - am Spieltag: "Live" (ab dem ersten Anstoß, bis alle Spiele des Tages vorbei sind)
// - zwischen den Spieltagen: Countdown bis zum Start des nächsten Spieltags
// - nach dem Turnier: Countdown zum nächsten Turnier, sobald dessen Termin bekannt ist

import type { Db } from './db/index.ts';

export interface HeaderTournament {
  name: string;
  /** Start des ersten Spiels */
  startsAt: Date;
  /** Läuft gerade ein Spieltag (ab dem ersten Anstoß, bis alle Spiele des Tages vorbei sind)? */
  live: boolean;
  /** Turnier hat begonnen und ist noch nicht zu Ende */
  running: boolean;
  /** Läuft das Turnier und ist gerade kein Spieltag: Start der nächsten Begegnungen */
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
const STALE_MS = 12 * 3_600_000;

/** Spieltag-Zustand eines laufenden Turniers: läuft gerade der Spieltag ("live") oder wann beginnt der nächste. */
export function matchdayState(matches: MatchTime[], now: Date, timeZone: string): { live: boolean; next: Date | null } {
  const dayOf = (d: Date) => d.toLocaleDateString('sv', { timeZone });
  const open = matches
    .filter((m) => m.status === 'live' || (m.status === 'scheduled' && m.at && m.at.getTime() > now.getTime() - STALE_MS))
    .sort((a, b) => (a.at ?? now).getTime() - (b.at ?? now).getTime());
  if (!open.length) return { live: false, next: null };
  const day = dayOf(open[0].at ?? now);
  const today = matches.filter((m) => m.status !== 'cancelled' && dayOf(m.at ?? now) === day);
  // Der Spieltag hat begonnen, sobald eines seiner Spiele läuft, fertig ist oder angepfiffen sein müsste
  const started = today.some((m) => m.status === 'live' || m.status === 'finished' || (m.at !== null && m.at <= now));
  if (started) return { live: true, next: null };
  const next = open.find((m) => m.at && dayOf(m.at) === day)?.at ?? null;
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

async function choose(db: Db, rows: Row[], now: Date, timeZone: string): Promise<HeaderTournament | null> {
  const ordered = orderTournaments(rows, now);
  let fallback: HeaderTournament | null = null;
  for (const r of ordered) {
    if (r.starts_at > now) return make(r, now, null);
    const matches = await db.query<{ at: Date | null; status: string }>(
      `select coalesce(scheduled_at, live_at) as at, status from matches where tournament_id = $1 and status <> 'cancelled'`,
      [r.id],
    );
    const state = matchdayState(matches, now, timeZone);
    // Ein begonnenes Turnier ohne Spieltag und ohne bekannten nächsten Termin macht Platz für das nächste Turnier
    if (state.live || state.next) return make(r, now, state);
    fallback ??= make(r, now, state);
  }
  return fallback;
}

/** Turniere der Tipprunden des Nutzers (oder der Tipprunde, die gerade offen ist); ohne Treffer alle. */
export async function loadHeaderTournament(db: Db, userId: string | null, leagueSlug: string | null, now: Date, timeZone = 'Europe/Berlin'): Promise<HeaderTournament | null> {
  const sql = (filter: string) => `
    select t.id, t.name, tournament_start(t.id) as starts_at,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status = 'live') as live,
           exists (select 1 from matches m where m.tournament_id = t.id and m.status in ('scheduled', 'live')) as open
      from tournaments t
     where tournament_start(t.id) is not null ${filter}`;
  if (leagueSlug) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join leagues l on l.id = lt.league_id where l.slug = $1)'), [leagueSlug]);
    if (rows.length) return choose(db, rows, now, timeZone);
  }
  if (userId) {
    const rows = await db.query<Row>(sql('and t.id in (select lt.tournament_id from league_tournaments lt join league_members lm on lm.league_id = lt.league_id where lm.user_id = $1)'), [userId]);
    if (rows.length) return choose(db, rows, now, timeZone);
  }
  return choose(db, await db.query<Row>(sql('')), now, timeZone);
}
