import { bonusPoints } from './bonus.ts';
import { matchResult } from './results.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Member, Prediction } from './types.ts';

export interface PredictionScore {
  /** null, solange das Spiel kein Ergebnis hat. */
  points: number | null;
  correctWinner: boolean;
  exact: boolean;
}

/**
 * Punkte für einen Tipp:
 *   richtiger Sieger           → pointsWinner
 *   + exaktes Ergebnis (Bo3/5) → pointsExact zusätzlich
 */
export function scorePrediction(prediction: Prediction, match: Match, rules: LeagueRules): PredictionScore {
  const result = matchResult(match);
  if (!result) return { points: null, correctWinner: false, exact: false };
  if (prediction.winner !== result.winner) return { points: 0, correctWinner: false, exact: false };
  const exact =
    match.bestOf > 1 &&
    prediction.winnerWins === result.winnerWins &&
    prediction.loserWins === result.loserWins;
  return { points: rules.pointsWinner + (exact ? rules.pointsExact : 0), correctWinner: true, exact };
}

export interface StandingRow {
  rank: number;
  userId: string;
  displayName: string;
  points: number;
  correctWinners: number;
  exactResults: number;
  bonusPoints: number;
  predictionsMade: number;
}

export interface StandingsInput {
  members: Member[];
  matches: Match[];
  predictions: Prediction[];
  rules: LeagueRules;
  bonusQuestions?: BonusQuestion[];
  bonusAnswers?: BonusAnswer[];
}

/**
 * Rangliste einer Tipprunde.
 * Sortierung: Punkte, dann Anzahl exakter Ergebnisse, dann Name.
 * Gleiche Punkte und gleich viele exakte Ergebnisse → gleicher Platz.
 */
export function computeStandings(input: StandingsInput): StandingRow[] {
  const matchById = new Map(input.matches.map((m) => [m.id, m]));
  const questionById = new Map((input.bonusQuestions ?? []).map((q) => [q.id, q]));

  const rows = new Map<string, StandingRow>(
    input.members.map((m) => [
      m.userId,
      {
        rank: 0,
        userId: m.userId,
        displayName: m.displayName,
        points: 0,
        correctWinners: 0,
        exactResults: 0,
        bonusPoints: 0,
        predictionsMade: 0,
      },
    ]),
  );

  for (const p of input.predictions) {
    const row = rows.get(p.userId);
    const match = matchById.get(p.matchId);
    if (!row || !match) continue;
    row.predictionsMade++;
    const score = scorePrediction(p, match, input.rules);
    if (score.points === null) continue;
    row.points += score.points;
    if (score.correctWinner) row.correctWinners++;
    if (score.exact) row.exactResults++;
  }

  for (const a of input.bonusAnswers ?? []) {
    const row = rows.get(a.userId);
    const question = questionById.get(a.questionId);
    if (!row || !question) continue;
    const points = bonusPoints(a.answer, question);
    if (points) {
      row.bonusPoints += points;
      row.points += points;
    }
  }

  const sorted = [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.exactResults - a.exactResults ||
      a.displayName.localeCompare(b.displayName, 'de'),
  );
  sorted.forEach((row, i) => {
    const prev = sorted[i - 1];
    row.rank = prev && prev.points === row.points && prev.exactResults === row.exactResults ? prev.rank : i + 1;
  });
  return sorted;
}
