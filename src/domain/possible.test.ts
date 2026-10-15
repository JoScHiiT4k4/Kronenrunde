import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gotPercent, possiblePoints } from './possible.ts';
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
