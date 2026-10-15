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
}

interface LeagueRow {
  id: string;
  name: string;
  slug: string;
  points_winner: number;
  points_exact: number;
  lock_mode: 'auto' | 'match' | 'matchday';
}

export async function loadSidebar(db: Db, userId: string, slug: string | null): Promise<Sidebar | null> {
  const cols = 'l.id, l.name, l.slug, l.points_winner, l.points_exact, l.lock_mode';
  let league: LeagueRow | null = null;
  if (slug) {
    league = await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id and m.user_id = $2 where l.slug = $1`, [slug, userId]);
  }
  league ??= await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id where m.user_id = $1 order by m.joined_at desc limit 1`, [userId]);
  if (!league) return null;
  const s = await loadStandings(db, league);
  return { slug: league.slug, leagueName: league.name, rows: s.rows, avatarOf: s.avatarOf, possible: s.possible };
}
