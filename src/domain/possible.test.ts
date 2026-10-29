import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gotPercent, possiblePoints, scaleParts } from './possible.ts';
import type { Match } from './types.ts';

const m = (bestOf: 1 | 3 | 5, done: boolean): Match =>
  ({ id: String(Math.random()), bestOf, scheduledAt: null, matchdayStartsAt: null, teamA: 'a', teamB: 'b', winsA: done ? bestOf === 1 ? 1 : 2 : null, winsB: done ? 0 : null, liveAt: null, previousFinishedAt: null }) as Match;
const rules = { pointsWinner: 1, pointsExact: 2, lockMode: 'auto' as const };

test('mögliche Punkte: nur gewertete Spiele, Bo1 ohne Exakt-Bonus, Sonderfragen mit Lösung', () => {
  assert.equal(possiblePoints([m(3, true), m(1, true), m(5, false)], rules), 3 + 1);
  assert.equal(possiblePoints([m(3, true)], rules, [{ id: 'q', points: 5, correctAnswers: ['x'] }, { id: 'r', points: 3, correctAnswers: [] }]), 3 + 5);
  assert.equal(possiblePoints([], rules), 0);
});

test('Prozent geholt', () => {
  assert.equal(gotPercent(0, 0), 0);
  assert.equal(gotPercent(3, 4), 75);
  assert.equal(gotPercent(9, 4), 100);
});

test('Strahl: gold exakt, grün Sieger und Sonderfragen, grau nicht getippt, rot liegen gelassen', () => {
  const ms = [m(3, true), m(3, true), m(1, true), m(3, true), m(5, false)];
  const [exakt, sieger, bo1, offen, laufend] = ms;
  const tip = (matchId: string, winnerWins: number | null, loserWins: number | null) => ({ matchId, userId: 'anna', winner: 'A' as const, winnerWins, loserWins });
  const preds = [tip(exakt.id, 2, 0), tip(sieger.id, 2, 1), tip(bo1.id, null, null), tip(laufend.id, 3, 0)];
  const questions = [{ id: 'q', points: 5, correctAnswers: ['x'] }];
  const parts = scaleParts([{ userId: 'anna', bonusPoints: 5 }, { userId: 'ben', bonusPoints: 0 }], ms, preds, rules, questions);
  assert.deepEqual(parts.get('anna'), { exact: 3, winner: 1 + 1 + 5, skipped: 3, lost: 2 });
  assert.deepEqual(parts.get('ben'), { exact: 0, winner: 0, skipped: 3 + 3 + 1 + 3, lost: 5 });
  const sum = (p: { exact: number; winner: number; skipped: number; lost: number }) => p.exact + p.winner + p.skipped + p.lost;
  assert.equal(sum(parts.get('anna')!), possiblePoints(ms, rules, questions));
});
