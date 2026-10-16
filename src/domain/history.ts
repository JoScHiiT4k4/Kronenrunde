// Tippverlauf eines Spielers: wie sich seine Gesamtpunktzahl über die Zeit entwickelt hat.

import { bonusPoints } from './bonus.ts';
import { scorePrediction } from './scoring.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Prediction } from './types.ts';

export interface HistoryStep {
  /** Zeitpunkt des Punktgewinns: Anstoß des Spiels, bei Sonderfragen "jetzt" (kein genauerer Zeitpunkt bekannt). */
  at: Date;
  /** Punkte, die bei diesem Schritt dazugekommen sind (kann 0 sein, z. B. falscher Tipp). */
  gained: number;
  /** Gesamtpunktzahl nach diesem Schritt. */
  total: number;
  /** Kurzbeschreibung, z. B. "Gen.G vs T1" oder "Sonderfragen". */
  label: string;
}

/**
 * Punkteverlauf eines Spielers, chronologisch nach Spielanstoß sortiert.
 * Nur gewertete Spiele (mit Ergebnis und Anstoßzeit) fließen ein; Sonderfragen-Punkte
 * kommen – weil kein Zeitpunkt pro Antwort gespeichert ist – als ein Schritt "jetzt" dazu.
 */
export function pointHistory(o: {
  userId: string;
  matches: Match[];
  predictions: Prediction[];
  rules: LeagueRules;
  bonusQuestions?: BonusQuestion[];
  bonusAnswers?: BonusAnswer[];
  now: Date;
}): HistoryStep[] {
  const ownPrediction = new Map(o.predictions.filter((p) => p.userId === o.userId).map((p) => [p.matchId, p]));

  const steps: { at: Date; gained: number; label: string }[] = [];
  for (const match of o.matches) {
    if (!match.scheduledAt) continue;
    const prediction = ownPrediction.get(match.id);
    if (!prediction) continue;
    const score = scorePrediction(prediction, match, o.rules);
    if (score.points === null) continue;
    steps.push({ at: match.scheduledAt, gained: score.points, label: `${match.teamA ?? '?'} vs ${match.teamB ?? '?'}` });
  }

  let bonusTotal = 0;
  for (const answer of o.bonusAnswers ?? []) {
    if (answer.userId !== o.userId) continue;
    const question = (o.bonusQuestions ?? []).find((q) => q.id === answer.questionId);
    if (!question) continue;
    const points = bonusPoints(answer.answer, question);
    if (points) bonusTotal += points;
  }
  if (bonusTotal > 0) steps.push({ at: o.now, gained: bonusTotal, label: 'Sonderfragen' });

  steps.sort((a, b) => a.at.getTime() - b.at.getTime());

  let total = 0;
  return steps.map((s) => {
    total += s.gained;
    return { ...s, total };
  });
}
