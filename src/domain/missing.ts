// Wer hat die anstehenden Spiele noch nicht getippt? Nur Anzahl und Frist – nie der Inhalt der Tipps.

import { isOpen, lockTime } from './locking.ts';
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

/** Wie lange nach Tippschluss ein noch nicht beendetes Spiel als „läuft“ gilt (ältere ohne Ergebnis sind veraltet). */
export const CATCH_UP_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Darf der Administrator für dieses Spiel einen Tipp nachtragen (z. B. bei technischen Problemen)?
 * Teams stehen fest, das Spiel ist nicht beendet, und es ist entweder noch tippbar oder läuft gerade
 * (Tippschluss vor höchstens 12 Stunden). Der Tippschluss selbst spielt dabei keine Rolle.
 */
export function canCatchUp(match: Match, mode: LockMode, now: Date): boolean {
  if (match.finished || match.teamA === null || match.teamB === null) return false;
  const lock = lockTime(match, mode);
  return lock !== null && lock.getTime() > now.getTime() - CATCH_UP_WINDOW_MS;
}

export interface CatchUpTips {
  userId: string;
  /** Spiele ohne Tipp, für die nachgetragen werden darf – nach Anstoß sortiert */
  matchIds: string[];
}

/** Für wen und welche Spiele der Administrator einen Tipp nachtragen kann. `tipped` wie bei missingTips. */
export function catchUpTips(userIds: string[], matches: Match[], tipped: Set<string>, mode: LockMode, now: Date): CatchUpTips[] {
  const time = (m: Match) => lockTime(m, mode)?.getTime() ?? 0;
  const candidates = matches.filter((m) => canCatchUp(m, mode, now)).sort((a, b) => time(a) - time(b));
  const out: CatchUpTips[] = [];
  for (const userId of userIds) {
    const todo = candidates.filter((m) => !tipped.has(`${userId}:${m.id}`));
    if (todo.length) out.push({ userId, matchIds: todo.map((m) => m.id) });
  }
  return out;
}
