import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointHistory } from './history.ts';
import type { BonusAnswer, BonusQuestion, LeagueRules, Match, Prediction } from './types.ts';

const rules: LeagueRules = { pointsWinner: 2, pointsExact: 1, lockMode: 'auto' };

const match = (id: string, scheduledAt: string | null, winsA: number | null, winsB: number | null, bestOf: 1 | 3 | 5 = 1): Match => ({
  id,
  bestOf,
  scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  matchdayStartsAt: null,
  teamA: 'A',
  teamB: 'B',
  winsA,
  winsB,
});

const now = new Date('2026-11-01T00:00:00Z');

test('pointHistory: nur gewertete, eigene Tipps fließen ein, chronologisch sortiert', () => {
  const matches: Match[] = [
    match('m1', '2026-10-20T17:00:00Z', 1, 0),
    match('m2', '2026-10-18T17:00:00Z', 0, 1),
    match('m3', '2026-10-22T17:00:00Z', null, null), // noch kein Ergebnis
  ];
  const predictions: Prediction[] = [
    { matchId: 'm1', userId: 'u1', winner: 'A', winnerWins: null, loserWins: null },
    { matchId: 'm2', userId: 'u1', winner: 'A', winnerWins: null, loserWins: null }, // falsch getippt
    { matchId: 'm3', userId: 'u1', winner: 'A', winnerWins: null, loserWins: null },
  ];
  const steps = pointHistory({ userId: 'u1', matches, predictions, rules, now });
  assert.equal(steps.length, 2);
  // m2 (18.10.) kommt vor m1 (20.10.)
  assert.equal(steps[0].at.toISOString(), '2026-10-18T17:00:00.000Z');
  assert.equal(steps[0].gained, 0);
  assert.equal(steps[0].total, 0);
  assert.equal(steps[1].at.toISOString(), '2026-10-20T17:00:00.000Z');
  assert.equal(steps[1].gained, 2);
  assert.equal(steps[1].total, 2);
});

test('pointHistory: fremde Tipps und Spiele ohne Anstoßzeit zählen nicht', () => {
  const matches: Match[] = [match('m1', null, 1, 0), match('m2', '2026-10-20T17:00:00Z', 1, 0)];
  const predictions: Prediction[] = [
    { matchId: 'm1', userId: 'u1', winner: 'A', winnerWins: null, loserWins: null },
    { matchId: 'm2', userId: 'u2', winner: 'A', winnerWins: null, loserWins: null },
  ];
  const steps = pointHistory({ userId: 'u1', matches, predictions, rules, now });
  assert.deepEqual(steps, []);
});

test('pointHistory: Sonderfragen-Punkte kommen als ein Schritt "jetzt" dazu', () => {
  const matches: Match[] = [match('m1', '2026-10-20T17:00:00Z', 1, 0)];
  const predictions: Prediction[] = [{ matchId: 'm1', userId: 'u1', winner: 'A', winnerWins: null, loserWins: null }];
  const bonusQuestions: BonusQuestion[] = [
    { id: 'q1', points: 5, correctAnswers: ['T1'] },
    { id: 'q2', points: 3, correctAnswers: ['G2'] },
  ];
  const bonusAnswers: BonusAnswer[] = [
    { questionId: 'q1', userId: 'u1', answer: 'T1' }, // richtig: +5
    { questionId: 'q2', userId: 'u1', answer: 'KC' }, // falsch: +0
    { questionId: 'q1', userId: 'u2', answer: 'T1' }, // anderer Nutzer
  ];
  const steps = pointHistory({ userId: 'u1', matches, predictions, rules, bonusQuestions, bonusAnswers, now });
  assert.equal(steps.length, 2);
  assert.equal(steps[1].label, 'Sonderfragen');
  assert.equal(steps[1].gained, 5);
  assert.equal(steps[1].total, 7);
  assert.equal(steps[1].at.toISOString(), now.toISOString());
});

test('pointHistory: ohne Daten eine leere Liste', () => {
  assert.deepEqual(pointHistory({ userId: 'u1', matches: [], predictions: [], rules, now }), []);
});
