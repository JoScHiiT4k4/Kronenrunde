import type { LockMode, Match } from './types.ts';

/**
 * Tippschluss eines Spiels je nach Einstellung der Tipprunde. Muss zur Datenbank-Funktion
 * prediction_lock_time() passen – die Datenbank setzt den Tippschluss durch, hier geht es um die Anzeige.
 */
export function lockTime(
  match: Pick<Match, 'scheduledAt' | 'matchdayStartsAt' | 'liveAt' | 'previousFinishedAt'>,
  mode: LockMode,
): Date | null {
  if (mode === 'match') return match.scheduledAt;
  if (mode === 'auto') {
    // Das früheste von: Anstoß, "läuft", Ende des Spiels davor
    const times = [match.scheduledAt, match.liveAt ?? null, match.previousFinishedAt ?? null].filter((t): t is Date => t !== null);
    return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
  }
  return match.matchdayStartsAt ?? match.scheduledAt;
}

/** Darf (noch) getippt werden? */
export function isOpen(match: Match, mode: LockMode, now: Date): boolean {
  const lock = lockTime(match, mode);
  return !match.finished && lock !== null && match.teamA !== null && match.teamB !== null && now.getTime() < lock.getTime();
}

/** Ab Tippschluss sind die Tipps aller Mitspieler für alle sichtbar. */
export function arePredictionsPublic(match: Match, mode: LockMode, now: Date): boolean {
  const lock = lockTime(match, mode);
  return lock !== null && now.getTime() >= lock.getTime();
}
