import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeRecap, type MatchInfo } from './recap.ts';
import type { Match, Prediction } from './types.ts';

const rules = { pointsWinner: 1, pointsExact: 1, lockMode: 'auto' as const };
const members = ['anna', 'ben', 'cem', 'dora'].map((id) => ({ userId: id, displayName: id }));

function match(id: string, hour: number, winner: 'A' | 'B', done = true): Match {
  return {
    id,
    bestOf: 5,
    scheduledAt: new Date(Date.UTC(2026, 9, 20, hour)),
    matchdayStartsAt: new Date(Date.UTC(2026, 9, 20, 8)),
    teamA: 'a',
    teamB: 'b',
    winsA: done ? (winner === 'A' ? 3 : 1) : null,
    winsB: done ? (winner === 'B' ? 3 : 1) : null,
    finished: done,
  };
}
const tip = (userId: string, matchId: string, winner: 'A' | 'B', loser = 2): Prediction => ({ matchId, userId, winner, winnerWins: 3, loserWins: loser });
const info = new Map<string, MatchInfo>([
  ['m1', { teamA: 'T1', teamB: 'Gen.G', stage: 'Viertelfinale' }],
  ['m2', { teamA: 'BLG', teamB: 'HLE', stage: 'Finale' }],
]);

test('Rückblick: Sieger, bester und schlechtester Tipp, beste Phase, Lieblingsteam, Höhepunkte', () => {
  const matches = [match('m1', 10, 'A'), match('m2', 11, 'B')];
  const predictions = [
    // m1 gewinnt A (3:1): Anna exakt, Ben richtig, Cem und Dora falsch
    tip('anna', 'm1', 'A', 1), tip('ben', 'm1', 'A'), tip('cem', 'm1', 'B'), tip('dora', 'm1', 'B'),
    // m2 gewinnt B (3:1): Anna falsch (allein), die anderen richtig
    tip('anna', 'm2', 'A'), tip('ben', 'm2', 'B'), tip('cem', 'm2', 'B'), tip('dora', 'm2', 'B', 1),
  ];
  const r = computeRecap({ members, matches, info, predictions, rules, bonusQuestions: [], bonusAnswers: [] });
  // Anna und Dora: 2 Punkte, 1 exaktes Ergebnis – gleicher Platz
  assert.deepEqual(r.champions, [{ name: 'anna', points: 2 }, { name: 'dora', points: 2 }]);
  const anna = r.players.find((p) => p.userId === 'anna')!;
  assert.equal(anna.points, 2);
  assert.equal(anna.bestTip?.match, 'T1 – Gen.G');
  assert.equal(anna.bestTip?.points, 2);
  assert.equal(anna.worstTip?.match, 'BLG – HLE');
  assert.equal(anna.worstTip?.share, 0.25);
  assert.deepEqual(anna.bestPhase, { stage: 'Viertelfinale', points: 2 });
  assert.equal(anna.favoriteTeam, null); // je Team nur einmal getippt
  const dora = r.players.find((p) => p.userId === 'dora')!;
  assert.deepEqual(dora.bestPhase, { stage: 'Finale', points: 2 });
  assert.equal(dora.worstTip?.picked, 'Gen.G');
  const volltreffer = r.highlights.find((h) => h.key === 'exakt')!;
  assert.equal(volltreffer.value, 1);
  assert.ok(volltreffer.names.includes('anna') && volltreffer.names.includes('dora'));
});

test('Rückblick: ohne Tipps keine Höhepunkte und keine Kartenangaben', () => {
  const r = computeRecap({ members, matches: [match('m1', 10, 'A')], info, predictions: [], rules, bonusQuestions: [], bonusAnswers: [] });
  assert.deepEqual(r.highlights, []);
  assert.ok(r.players.every((p) => p.bestTip === null && p.worstTip === null && p.bestPhase === null));
});
