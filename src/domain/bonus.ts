import type { BonusQuestion } from './types.ts';

/**
 * Vergleichbare Form einer Antwort: klein geschrieben, ohne Leerzeichen und Satzzeichen.
 * "Anyone's Legend" → "anyoneslegend", "K'Sante" → "ksante". Umlaute und Sonderbuchstaben (Ø) bleiben.
 */
export function normalizeAnswer(value: string): string {
  return value
    .toLocaleLowerCase('de')
    .replace(/[\s.,;:!?'’‘`´"„“()\-_/]/g, '');
}

/** Ist die Antwort richtig? Mehrere richtige Antworten (Gleichstand, Schreibweisen) sind möglich. */
export function isBonusCorrect(answer: string, question: Pick<BonusQuestion, 'correctAnswers'>): boolean {
  const normalized = normalizeAnswer(answer);
  if (normalized === '') return false;
  return question.correctAnswers.some((c) => normalizeAnswer(c) === normalized);
}

/** Punkte für eine Antwort. Solange keine richtige Antwort feststeht: null (noch nicht gewertet). */
export function bonusPoints(answer: string, question: BonusQuestion): number | null {
  if (question.correctAnswers.length === 0) return null;
  return isBonusCorrect(answer, question) ? question.points : 0;
}
