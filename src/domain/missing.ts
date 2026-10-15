// Wer hat die anstehenden Spiele noch nicht getippt? Nur Anzahl und Frist – nie der Inhalt der Tipps.

import { isOpen, lockTime } from './locking.ts';
import type { LockMode, Match } from './types.ts';

export interface MissingTips {
  userId: string;
  /** Anzahl offener Spiele ohne Tipp */
  missing: number;
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
    out.push({ userId, missing: todo.length, nextLock: new Date(Math.min(...locks)) });
  }
  return out.sort((a, b) => a.nextLock.getTime() - b.nextLock.getTime() || b.missing - a.missing);
}
