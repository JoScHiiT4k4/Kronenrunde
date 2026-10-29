// Wie viele Punkte waren bisher überhaupt zu holen? Grundlage für den farbigen Strahl in der Rangliste:
// gold = exakte Ergebnisse, grün = richtige Sieger, grau = nicht getippt, rot = liegen gelassen.

import { matchResult } from './results.ts';
import { scorePrediction, type StandingRow } from './scoring.ts';
import type { BonusQuestion, LeagueRules, Match, Prediction } from './types.ts';

/** Punkte, die bei allen bisher gewerteten Spielen (und Sonderfragen mit richtiger Antwort) maximal möglich waren. */
export function possiblePoints(matches: Match[], rules: LeagueRules, bonusQuestions: BonusQuestion[] = []): number {
  let total = 0;
  for (const m of matches) {
    if (!matchResult(m)) continue;
    total += rules.pointsWinner + (m.bestOf > 1 ? rules.pointsExact : 0);
  }
  for (const q of bonusQuestions) if (q.correctAnswers.length) total += q.points;
  return total;
}

/** Aufteilung der bisher möglichen Punkte einer Person für den farbigen Strahl der Rangliste. */
export interface ScaleParts {
  /** Gold: Punkte aus exakt richtigen Ergebnissen */
  exact: number;
  /** Grün: Punkte aus richtigen Siegern (ohne exaktes Ergebnis) und aus Sonderfragen */
  winner: number;
  /** Grau: mögliche Punkte aus gewerteten Spielen, die nicht getippt wurden */
  skipped: number;
  /** Rot: getippt, aber liegen gelassen */
  lost: number;
}

/** Strahl-Aufteilung je Person; die vier Teile ergeben zusammen possiblePoints(). */
export function scaleParts(
  rows: Pick<StandingRow, 'userId' | 'bonusPoints'>[],
  matches: Match[],
  predictions: Prediction[],
  rules: LeagueRules,
  bonusQuestions: BonusQuestion[] = [],
): Map<string, ScaleParts> {
  const bonusPossible = bonusQuestions.reduce((sum, q) => sum + (q.correctAnswers.length ? q.points : 0), 0);
  const tips = new Map(predictions.map((p) => [`${p.userId}:${p.matchId}`, p]));
  const scored = matches.filter((m) => matchResult(m));
  const out = new Map<string, ScaleParts>();
  for (const row of rows) {
    const parts: ScaleParts = { exact: 0, winner: row.bonusPoints, skipped: 0, lost: bonusPossible - row.bonusPoints };
    for (const m of scored) {
      const value = rules.pointsWinner + (m.bestOf > 1 ? rules.pointsExact : 0);
      const tip = tips.get(`${row.userId}:${m.id}`);
      if (!tip) {
        parts.skipped += value;
        continue;
      }
      const score = scorePrediction(tip, m, rules);
      if (score.exact) parts.exact += value;
      else if (score.correctWinner) {
        parts.winner += rules.pointsWinner;
        parts.lost += value - rules.pointsWinner;
      } else parts.lost += value;
    }
    out.set(row.userId, parts);
  }
  return out;
}

/** Anteil geholter Punkte in ganzen Prozent (0–100); ohne mögliche Punkte 0. */
export function gotPercent(points: number, possible: number): number {
  if (possible <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((points / possible) * 100)));
}
