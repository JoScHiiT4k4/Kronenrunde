import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingTips } from './missing.ts';
import type { Match } from './types.ts';

const now = new Date('2026-10-15T12:00:00Z');
const m = (id: string, at: string, teams = true): Match => ({
  id,
  bestOf: 3,
  scheduledAt: new Date(at),
  matchdayStartsAt: new Date(at),
  teamA: teams ? 'a' : null,
  teamB: teams ? 'b' : null,
  winsA: null,
  winsB: null,
});

test('missingTips: nur offene Spiele, sortiert nach Frist, ohne Tipp-Inhalt', () => {
  const matches = [m('m1', '2026-10-15T18:00:00Z'), m('m2', '2026-10-16T18:00:00Z'), m('alt', '2026-10-15T10:00:00Z'), m('offen', '2026-10-17T18:00:00Z', false)];
  const tipped = new Set(['anna:m1', 'anna:m2', 'ben:m2']);
  const r = missingTips(['anna', 'ben', 'cara'], matches, tipped, 'match', now);
  assert.deepEqual(r.map((x) => [x.userId, x.missing]), [['cara', 2], ['ben', 1]]);
  assert.equal(r[1].nextLock.toISOString(), '2026-10-15T18:00:00.000Z');
  assert.deepEqual(Object.keys(r[1]).sort(), ['missing', 'nextLock', 'userId'], 'keine Tipp-Inhalte');
});
