import type { BestOf, Match, Side } from './types.ts';

export interface ResultOption {
  winner: Side;
  winnerWins: number | null;
  loserWins: number | null;
}

/** Siege, die ein Team für den Gesamtsieg braucht: Bo1 → 1, Bo3 → 2, Bo5 → 3. */
export function winsNeeded(bestOf: BestOf): number {
  return (bestOf + 1) / 2;
}

/**
 * Alle tippbaren Ergebnisse eines Spiels, in der Reihenfolge für die Auswahl:
 * Bo5 → A 3:0, A 3:1, A 3:2, B 3:2, B 3:1, B 3:0. Bo1 → A, B.
 */
export function resultOptions(bestOf: BestOf): ResultOption[] {
  if (bestOf === 1) {
    return [
      { winner: 'A', winnerWins: null, loserWins: null },
      { winner: 'B', winnerWins: null, loserWins: null },
    ];
  }
  const n = winsNeeded(bestOf);
  const options: ResultOption[] = [];
  for (let l = 0; l < n; l++) options.push({ winner: 'A', winnerWins: n, loserWins: l });
  for (let l = n - 1; l >= 0; l--) options.push({ winner: 'B', winnerWins: n, loserWins: l });
  return options;
}

/** Ergebnis eines beendeten Spiels aus Sicht des Siegers, oder null, solange keins feststeht. */
export function matchResult(match: Match): ResultOption | null {
  const { winsA, winsB } = match;
  if (winsA == null || winsB == null || winsA === winsB) return null;
  return {
    winner: winsA > winsB ? 'A' : 'B',
    winnerWins: match.bestOf === 1 ? null : Math.max(winsA, winsB),
    loserWins: match.bestOf === 1 ? null : Math.min(winsA, winsB),
  };
}

/** Prüft, ob ein Tipp zum Format des Spiels passt (wie die Datenbank-Regel). */
export function isValidResult(bestOf: BestOf, option: ResultOption): boolean {
  if (bestOf === 1) return option.winnerWins === null && option.loserWins === null;
  const n = winsNeeded(bestOf);
  return option.winnerWins === n && option.loserWins !== null && option.loserWins >= 0 && option.loserWins < n;
}
