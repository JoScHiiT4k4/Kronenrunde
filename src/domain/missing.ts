// Wer hat die anstehenden Spiele noch nicht getippt? Nur Anzahl und Frist – nie der Inhalt der Tipps.

import { arePredictionsPublic, isOpen, lockTime } from './locking.ts';
import type { LockMode, Match } from './types.ts';

export interface MissingTips {
  userId: string;
  /** Anzahl offener Spiele ohne Tipp */
  missing: number;
  /** Die offenen Spiele ohne Tipp */
  matchIds: string[];
  /** Früheste Frist unter diesen Spielen */
  nextLock: Date;
}

/** `tipped` enthält Paare "userId:matchId". Es zählen nur Spiele, die noch tippbar sind. Die Liste ist nach dringendster Frist sortiert. */
export function missingTips(userIds: string[], matches: Match[], tipped: Set<string>, mode: LockMode, now: Date): MissingTips[] {
  const open = matches.filter((m) => isOpen(m, mode, now));
  const out: MissingTips[] = [];
  for (const userId of userIds) {
    const todo = open.filter((m) => !tipped.has(`${userId}:${m.id}`));
    if (!todo.length) continue;
    const locks = todo.map((m) => lockTime(m, mode)!.getTime());
    out.push({ userId, missing: todo.length, matchIds: todo.map((m) => m.id), nextLock: new Date(Math.min(...locks)) });
  }
  return out.sort((a, b) => a.nextLock.getTime() - b.nextLock.getTime() || b.missing - a.missing);
}

/**
 * Verpasste Tipps je Person: Spiele mit feststehenden Teams, bei denen der Tippschluss vorbei ist
 * (oder die schon abgeschlossen sind) und für die es keinen Tipp gibt. `tipped` wie bei missingTips.
 */
export function missedTips(userIds: string[], matches: Match[], tipped: Set<string>, mode: LockMode, now: Date): Map<string, number> {
  const closed = matches.filter((m) => m.teamA !== null && m.teamB !== null && (m.finished || arePredictionsPublic(m, mode, now)));
  return new Map(userIds.map((userId) => [userId, closed.filter((m) => !tipped.has(`${userId}:${m.id}`)).length]));
}

export interface MissingAnswers {
  userId: string;
  /** Texte der offenen Fragen ohne Antwort */
  questions: string[];
}

/** `answered` enthält Paare "userId:questionId". Gibt nur Personen zurück, denen noch Antworten fehlen. */
export function missingAnswers(userIds: string[], questions: { id: string; question: string }[], answered: Set<string>): MissingAnswers[] {
  const out: MissingAnswers[] = [];
  for (const userId of userIds) {
    const todo = questions.filter((q) => !answered.has(`${userId}:${q.id}`));
    if (todo.length) out.push({ userId, questions: todo.map((q) => q.question) });
  }
  return out;
}
