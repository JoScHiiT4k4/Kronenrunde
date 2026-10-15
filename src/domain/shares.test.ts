import assert from 'node:assert/strict';
import { test } from 'node:test';
import { winShares } from './shares.ts';

test('winShares: Prozent aus Tipps, Summe immer 100', () => {
  assert.equal(winShares(0, 0), null);
  assert.deepEqual(winShares(3, 1), { a: 75, b: 25, total: 4 });
  assert.deepEqual(winShares(1, 2), { a: 33, b: 67, total: 3 });
  assert.deepEqual(winShares(1, 1), { a: 50, b: 50, total: 2 });
  assert.deepEqual(winShares(5, 0), { a: 100, b: 0, total: 5 });
});
