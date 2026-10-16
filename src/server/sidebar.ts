// Rangliste in der rechten Seitenleiste: auf jeder Seite die Tipprunde, in der man gerade ist (sonst die zuletzt beigetretene).

import type { StandingRow } from '../domain/scoring.ts';
import type { Db } from './db/index.ts';
import { loadStandings } from './routes/standings-data.ts';

export interface Sidebar {
  slug: string;
  leagueName: string;
  rows: StandingRow[];
  avatarOf: Map<string, Date | null>;
  /** Wann jeder zuletzt angemeldet eine Seite aufgerufen hat (für die Online-Anzeige) */
  lastSeenOf: Map<string, Date | null>;
  possible: number;
  /** Chat stummgeschaltet (Standard) – false, wenn Push-Hinweise für Chat-Nachrichten an sind */
  chatMuted: boolean;
  /** Alle Tipprunden des Teilnehmers (für das Dropdown in der Kopfzeile) */
  leagues: { slug: string; name: string }[];
  /** Das Testspiel des Betreibers: dort gibt es nur die Teilnehmer-Ansicht */
  isTest: boolean;
  /** Ergebnisse hinter dem Spoilerschutz verdecken (Standard) */
  spoilerProtection: boolean;
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

export async function loadSidebar(db: Db, userId: string, slug: string | null, isAdmin = false): Promise<Sidebar | null> {
  const cols = 'l.id, l.name, l.slug, l.points_winner, l.points_exact, l.lock_mode, l.is_test';
  let league: LeagueRow | null = null;
  if (slug) {
    league = await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id and m.user_id = $2 where l.slug = $1`, [slug, userId]);
  }
  league ??= await db.one<LeagueRow>(`select ${cols} from leagues l join league_members m on m.league_id = l.id where m.user_id = $1 and not l.is_test order by m.joined_at desc limit 1`, [userId]);
  // Der Betreiber sieht die Rangliste auch dort, wo er nicht mitspielt: erst die Tipprunde aus der Adresse, sonst die neueste
  if (!league && isAdmin) {
    if (slug) league = await db.one<LeagueRow>(`select ${cols} from leagues l where l.slug = $1`, [slug]);
    league ??= await db.one<LeagueRow>(`select ${cols} from leagues l where not l.is_test order by l.created_at desc limit 1`);
  }
  if (!league) return null;
  const [s, prefs, leagues] = await Promise.all([
    loadStandings(db, league),
    db.one<{ chat_push: boolean; spoiler_protection: boolean }>('select chat_push, spoiler_protection from notification_prefs where user_id = $1', [userId]),
    db.query<{ slug: string; name: string }>('select l.slug, l.name from leagues l join league_members m on m.league_id = l.id where m.user_id = $1 order by l.name', [userId]),
  ]);
  return {
    slug: league.slug,
    leagueName: league.name,
    rows: s.rows,
    avatarOf: s.avatarOf,
    lastSeenOf: s.lastSeenOf,
    possible: s.possible,
    chatMuted: !prefs?.chat_push,
    leagues,
    isTest: league.is_test,
    spoilerProtection: prefs?.spoiler_protection ?? true,
  };
}
