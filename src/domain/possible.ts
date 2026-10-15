// Wie viele Punkte waren bisher überhaupt zu holen? Grundlage für die grün/rote Skala in der Rangliste:
// grün = geholte Punkte, rot = liegen gelassen.

import { matchResult } from './results.ts';
import type { BonusQuestion, LeagueRules, Match } from './types.ts';

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

/** Anteil geholter Punkte in ganzen Prozent (0–100); ohne mögliche Punkte 0. */
export function gotPercent(points: number, possible: number): number {
  if (possible <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((points / possible) * 100)));
}
