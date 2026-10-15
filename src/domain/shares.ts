// Gewinnwahrscheinlichkeit aus den Tipps der Tipprunde: Anteil der Tipper, die ein Team als Sieger getippt haben.

export interface Shares {
  /** Prozent für Team A, ganze Zahl */
  a: number;
  /** Prozent für Team B (a + b = 100) */
  b: number;
  /** Anzahl der Tipps, auf denen das beruht */
  total: number;
}

/** Null, wenn niemand getippt hat. Die beiden Werte ergeben immer 100. */
export function winShares(votesA: number, votesB: number): Shares | null {
  const total = votesA + votesB;
  if (total <= 0) return null;
  const a = Math.round((votesA / total) * 100);
  return { a, b: 100 - a, total };
}
