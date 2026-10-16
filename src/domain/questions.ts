// Katalog der Sonderfragen, aus denen die Leitung einer Tipprunde auswählen kann.
// Die Antwortart ist je Frage fest vorgegeben: Teams, Spieler und Champions kommen automatisch aus den Turnierdaten.

export type AnswerType = 'text' | 'team' | 'choice' | 'champion' | 'player';

export interface CatalogQuestion {
  /** Dauerhafte Kennung (bleibt gleich, auch wenn der Fragetext später geändert wird) */
  key: string;
  question: string;
  /** Vorschlag für die Punkte – die Leitung kann ihn ändern */
  points: number;
  type: AnswerType;
  /** Zusätzliche feste Auswahl zur Liste, z. B. „Kein Pentakill“ */
  choices: string[];
}

export const QUESTION_CATALOG: CatalogQuestion[] = [
  { key: 'weltmeister', question: 'Wer wird Weltmeister?', points: 5, type: 'team', choices: [] },
  { key: 'finals-mvp', question: 'Wer wird Finals-MVP?', points: 3, type: 'player', choices: [] },
  { key: 'meistgebannt', question: 'Welcher Champion wird am häufigsten gebannt?', points: 3, type: 'champion', choices: [] },
  { key: 'kuerzestes-spiel', question: 'Welches Team verliert das kürzeste Spiel?', points: 3, type: 'team', choices: [] },
  { key: 'pentakill-team', question: 'Welches Team holt den ersten Pentakill?', points: 3, type: 'team', choices: ['Kein Pentakill'] },
  { key: 'pentakill-spieler', question: 'Welcher Spieler holt den ersten Pentakill?', points: 3, type: 'player', choices: ['Kein Pentakill'] },
];

export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  team: 'Team aus dem Turnier',
  player: 'Spieler aus den Turnier-Teams',
  champion: 'Champion',
  choice: 'Aus eigener Liste',
  text: 'Freitext',
};
