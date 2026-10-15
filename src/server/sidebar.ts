// Rangliste in der rechten Seitenleiste: auf jeder Seite die Tipprunde, in der man gerade ist (sonst die zuletzt beigetretene).

import type { StandingRow } from '../domain/scoring.ts';
import type { Db } from './db/index.ts';
import { loadStandings } from './routes/standings-data.ts';

export interface Sidebar {
  slug: string;
  leagueName: string;
  rows: StandingRow[];
  avatarOf: Map<string, Date | null>;
  possible: number;
  /** Chat stummgeschaltet (Standard) – false, wenn Push-Hinweise für Chat-Nachrichten an sind */
  chatMuted: boolean;
  /** Alle Tipprunden des Teilnehmers (für das Dropdown in der Kopfzeile) */
  leagues: { slug: string; name: string }[];
  /** Das Testspiel des Betreibers: dort gibt es nur die Teilnehmer-Ansicht */
  isTest: boolean;
}

interface LeagueRow {
  id: string;
  name: string;
  slug: string;
  points_winner: number;
  points_exact: number;
  lock_mode: 'auto' | 'match' | 'matchday';
  is_test: boolean;
}

export async function loadSidebar(db: Db, userId: string, slug: string | null): Promise<Sidebar | null> {
  const cols = 'l.id, l.name, l.slug, l.points_winner, l.points_exact, l.lock_mode, l.is_test';
  let league: LeagueRow | null = null;
  if (slug) {
    league = await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id and m.user_id = $2 where l.slug = $1`, [slug, userId]);
  }
  league ??= await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id where m.user_id = $1 and not l.is_test order by m.joined_at desc limit 1`, [userId]);
  if (!league) return null;
  const [s, prefs, leagues] = await Promise.all([
    loadStandings(db, league),
    db.one<{ chat_push: boolean }>('select chat_push from notification_prefs where user_id = $1', [userId]),
    db.query<{ slug: string; name: string }>('select l.slug, l.name from leagues l join league_members m on m.league_id = l.id where m.user_id = $1 order by l.name', [userId]),
  ]);
  return { slug: league.slug, leagueName: league.name, rows: s.rows, avatarOf: s.avatarOf, possible: s.possible, chatMuted: !prefs?.chat_push, leagues, isTest: league.is_test };
}
