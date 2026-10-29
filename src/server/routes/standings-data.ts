// Rangliste einer Tipprunde berechnen (für die Seite "Rangliste" und die Seitenleiste).

import { possiblePoints, type ScaleParts, scaleParts } from '../../domain/possible.ts';
import { type StandingRow, computeStandings } from '../../domain/scoring.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Member, Prediction } from '../../domain/types.ts';
import { matchResult } from '../../domain/results.ts';
import type { Queryable } from '../db/index.ts';
import { type League, leagueMatches, type PredictionRow, rulesOf, toDomainMatch, toDomainPrediction } from './league-data.ts';

export interface StandingsData {
  rows: StandingRow[];
  avatarOf: Map<string, Date | null>;
  /** Wann jeder zuletzt angemeldet eine Seite aufgerufen hat (für die Online-Anzeige) */
  lastSeenOf: Map<string, Date | null>;
  finished: number;
  /** Bisher überhaupt mögliche Punkte (gewertete Spiele + Sonderfragen mit Lösung) */
  possible: number;
  hasBonus: boolean;
  /** Aufteilung des farbigen Strahls je Person */
  parts: Map<string, ScaleParts>;
  /** Rohdaten der Berechnung (z. B. für die Abzeichen im Profil) */
  raw: { members: Member[]; matches: Match[]; predictions: Prediction[]; rules: LeagueRules; bonusQuestions: BonusQuestion[]; bonusAnswers: BonusAnswer[] };
}

export async function loadStandings(db: Queryable, league: Pick<League, 'id' | 'points_winner' | 'points_exact' | 'lock_mode'>): Promise<StandingsData> {
  const [members, matches, preds, questions, answers] = await Promise.all([
    db.query<{ user_id: string; display_name: string; avatar_updated_at: Date | null; last_seen_at: Date | null }>(
      `select u.id as user_id, u.display_name, u.avatar_updated_at, u.last_seen_at from league_members lm join users u on u.id = lm.user_id where lm.league_id = $1`,
      [league.id],
    ),
    leagueMatches(db, league.id),
    db.query<PredictionRow>(`select match_id, user_id, winner, winner_wins, loser_wins from predictions where league_id = $1`, [league.id]),
    db.query<{ id: string; points: number; correct_answers: string[] }>(
      `select q.id, q.points, q.correct_answers from bonus_questions q
         join league_tournaments lt on lt.league_id = q.league_id and lt.tournament_id = q.tournament_id
        where q.league_id = $1`,
      [league.id],
    ),
    db.query<{ question_id: string; user_id: string; answer: string }>(`select question_id, user_id, answer from bonus_answers where league_id = $1`, [league.id]),
  ]);
  const domainMatches = matches.map(toDomainMatch);
  const rules = rulesOf(league as League);
  const bonusQuestions = questions.map((q) => ({ id: q.id, points: q.points, correctAnswers: q.correct_answers }));
  const raw = {
    members: members.map((m) => ({ userId: m.user_id, displayName: m.display_name })),
    matches: domainMatches,
    predictions: preds.map(toDomainPrediction),
    rules,
    bonusQuestions,
    bonusAnswers: answers.map((a) => ({ questionId: a.question_id, userId: a.user_id, answer: a.answer })),
  };
  const rows = computeStandings(raw);
  return {
    rows,
    avatarOf: new Map(members.map((m) => [m.user_id, m.avatar_updated_at])),
    lastSeenOf: new Map(members.map((m) => [m.user_id, m.last_seen_at])),
    finished: domainMatches.filter((m) => matchResult(m)).length,
    possible: possiblePoints(domainMatches, rules, bonusQuestions),
    hasBonus: questions.some((q) => q.correct_answers.length > 0),
    parts: scaleParts(rows, domainMatches, raw.predictions, rules, bonusQuestions),
    raw,
  };
}
