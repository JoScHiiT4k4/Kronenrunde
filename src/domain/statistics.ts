// Statistiken zu einem Turnier: aus den Ergebnissen der Spiele berechnet (reine Logik, ohne Datenbank).

export interface StatTeam {
  id: string;
  name: string;
  short: string | null;
  region: string | null;
}

export interface StatMatch {
  teamA: StatTeam | null;
  teamB: StatTeam | null;
  winsA: number | null;
  winsB: number | null;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  bestOf: number;
  /** Anstoß in ms (für die Reihenfolge der Serie) */
  time: number;
}

export interface TeamStat {
  team: StatTeam;
  wins: number;
  losses: number;
  mapsWon: number;
  mapsLost: number;
  /** Siegquote der Serien in ganzen Prozent; null ohne gespielte Serie */
  winRate: number | null;
  /** Aktuelle Serie: z. B. { win: true, length: 3 } = drei Siege in Folge */
  streak: { win: boolean; length: number } | null;
}

export interface TournamentStat {
  total: number;
  finished: number;
  live: number;
  open: number;
  /** Alle gespielten Maps (Summe der Siege beider Seiten) */
  maps: number;
  /** Maps pro Serie, eine Nachkommastelle; null ohne gespielte Serie */
  mapsPerSeries: number | null;
  /** Serien, bei denen der Verlierer keine Map geholt hat (nur Bo3/Bo5) */
  sweeps: number;
  /** Serien über die volle Distanz (z. B. 3:2 im Bo5) */
  fullDistance: number;
}

const decided = (m: StatMatch) =>
  m.status === 'finished' && m.teamA && m.teamB && m.winsA !== null && m.winsB !== null && m.winsA !== m.winsB;

export function tournamentStat(matches: StatMatch[]): TournamentStat {
  const live = matches.filter((m) => m.status !== 'cancelled');
  const done = live.filter(decided);
  let maps = 0;
  let sweeps = 0;
  let fullDistance = 0;
  for (const m of done) {
    const hi = Math.max(m.winsA!, m.winsB!);
    const lo = Math.min(m.winsA!, m.winsB!);
    maps += hi + lo;
    if (m.bestOf > 1 && lo === 0) sweeps++;
    if (m.bestOf > 1 && hi + lo === m.bestOf) fullDistance++;
  }
  return {
    total: live.length,
    finished: done.length,
    live: live.filter((m) => m.status === 'live').length,
    open: live.filter((m) => m.status === 'scheduled').length,
    maps,
    mapsPerSeries: done.length ? Math.round((maps / done.length) * 10) / 10 : null,
    sweeps,
    fullDistance,
  };
}

/** Bilanz je Team, sortiert: Siege ↓, Niederlagen ↑, Map-Differenz ↓, Name. Teams ohne Spiel stehen mit 0:0 dabei. */
export function teamStats(matches: StatMatch[], teams: StatTeam[] = []): TeamStat[] {
  const rows = new Map<string, TeamStat & { results: boolean[] }>();
  const row = (t: StatTeam) => {
    let r = rows.get(t.id);
    if (!r) rows.set(t.id, (r = { team: t, wins: 0, losses: 0, mapsWon: 0, mapsLost: 0, winRate: null, streak: null, results: [] }));
    return r;
  };
  for (const t of teams) row(t);
  for (const m of matches) {
    if (m.teamA) row(m.teamA);
    if (m.teamB) row(m.teamB);
  }
  for (const m of [...matches].filter(decided).sort((a, b) => a.time - b.time)) {
    const aWon = m.winsA! > m.winsB!;
    const a = row(m.teamA!);
    const b = row(m.teamB!);
    a.mapsWon += m.winsA!;
    a.mapsLost += m.winsB!;
    b.mapsWon += m.winsB!;
    b.mapsLost += m.winsA!;
    if (aWon) (a.wins++, b.losses++);
    else (b.wins++, a.losses++);
    a.results.push(aWon);
    b.results.push(!aWon);
  }
  const out = [...rows.values()].map(({ results, ...r }): TeamStat => {
    const played = r.wins + r.losses;
    let streak: TeamStat['streak'] = null;
    if (results.length) {
      const win = results[results.length - 1];
      let length = 0;
      for (let i = results.length - 1; i >= 0 && results[i] === win; i--) length++;
      streak = { win, length };
    }
    return { ...r, winRate: played ? Math.round((r.wins / played) * 100) : null, streak };
  });
  return out.sort(
    (x, y) =>
      y.wins - x.wins ||
      x.losses - y.losses ||
      y.mapsWon - y.mapsLost - (x.mapsWon - x.mapsLost) ||
      x.team.name.localeCompare(y.team.name, 'de'),
  );
}

/** Teams je Region, größte Region zuerst */
export function regionCounts(teams: StatTeam[]): { region: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of teams) m.set(t.region?.trim() || 'Unbekannt', (m.get(t.region?.trim() || 'Unbekannt') ?? 0) + 1);
  return [...m.entries()].map(([region, count]) => ({ region, count })).sort((a, b) => b.count - a.count || a.region.localeCompare(b.region, 'de'));
}
