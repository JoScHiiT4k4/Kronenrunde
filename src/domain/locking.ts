import type { LockMode, Match } from './types.ts';

/**
 * Spiele, deren Anstoß weniger als so viele Stunden auseinander liegt, gehören zum selben Spieltag.
 * Muss zur Datenbank-Funktion refresh_matchdays() passen.
 */
export const MATCHDAY_GAP_HOURS = 6;

/**
 * Berechnet für jedes Spiel den Beginn seines Spieltags (gleiche Regel wie in der Datenbank).
 * Nützlich für Vorschauen, bevor gespeichert wurde. Maßgeblich ist der Wert aus der Datenbank.
 */
export function computeMatchdayStarts(
  matches: Pick<Match, 'id' | 'scheduledAt'>[],
): Map<string, Date> {
  const result = new Map<string, Date>();
  const timed = matches
    .filter((m): m is Pick<Match, 'id'> & { scheduledAt: Date } => m.scheduledAt !== null)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.id.localeCompare(b.id));
  let dayStart: Date | null = null;
  let previous: Date | null = null;
  for (const m of timed) {
    if (previous === null || m.scheduledAt.getTime() - previous.getTime() >= MATCHDAY_GAP_HOURS * 3_600_000) {
      dayStart = m.scheduledAt;
    }
    result.set(m.id, dayStart as Date);
    previous = m.scheduledAt;
  }
  return result;
}

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
  return lock !== null && match.teamA !== null && match.teamB !== null && now.getTime() < lock.getTime();
}

/** Ab Tippschluss sind die Tipps aller Mitspieler für alle sichtbar. */
export function arePredictionsPublic(match: Match, mode: LockMode, now: Date): boolean {
  const lock = lockTime(match, mode);
  return lock !== null && now.getTime() >= lock.getTime();
}
