// Fachliche Grundtypen des Tippspiels – unabhängig von Datenbank und Oberfläche.

export type BestOf = 1 | 3 | 5;
export type Side = 'A' | 'B';
/**
 * Tippschluss:
 *  - auto:     jedes Spiel einzeln – beim Anstoß, oder früher, sobald das Spiel davor vorbei ist oder es läuft
 *  - matchday: alle Spiele eines Spieltags beim Anstoß des ersten
 *  - match:    jedes Spiel einzeln bei seinem (geschätzten) Anstoß
 */
export type LockMode = 'auto' | 'matchday' | 'match';

export interface Match {
  id: string;
  bestOf: BestOf;
  scheduledAt: Date | null;
  /** Anstoß des ersten Spiels des Spieltags (wird von der Datenbank berechnet). */
  matchdayStartsAt: Date | null;
  teamA: string | null;
  teamB: string | null;
  winsA: number | null;
  winsB: number | null;
  /** Seit wann das Spiel als „läuft“ gemeldet ist. */
  liveAt?: Date | null;
  /** Wann das vorherige Spiel desselben Spieltags vorbei war (Ergebnis eingetragen). */
  previousFinishedAt?: Date | null;
  /** Begegnung ist abgeschlossen – dann gibt es nichts mehr zu tippen. */
  finished?: boolean;
}

export interface Prediction {
  matchId: string;
  userId: string;
  winner: Side;
  /** Bei Bo3/Bo5 das getippte Ergebnis aus Sicht des Siegers, z. B. 3 und 1. Bei Bo1 null. */
  winnerWins: number | null;
  loserWins: number | null;
}

export interface LeagueRules {
  pointsWinner: number;
  pointsExact: number;
  lockMode: LockMode;
}

export interface BonusQuestion {
  id: string;
  points: number;
  correctAnswers: string[];
}

export interface BonusAnswer {
  questionId: string;
  userId: string;
  answer: string;
}

export interface Member {
  userId: string;
  displayName: string;
}
