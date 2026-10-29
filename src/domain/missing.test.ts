import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missedTips, missingAnswers, missingTips } from './missing.ts';
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
  assert.deepEqual(Object.keys(r[1]).sort(), ['matchIds', 'missing', 'nextLock', 'userId'], 'keine Tipp-Inhalte');
});

test('missedTips: nur Spiele nach Tippschluss oder abgeschlossen, ohne Tipp', () => {
  const matches = [
    m('alt', '2026-10-15T10:00:00Z'),
    m('fertig', '2026-10-20T10:00:00Z'),
    m('offen', '2026-10-15T18:00:00Z'),
    m('ohneTeams', '2026-10-14T18:00:00Z', false),
  ];
  matches[1].finished = true;
  const tipped = new Set(['anna:alt', 'anna:fertig', 'ben:alt', 'ben:offen']);
  const r = missedTips(['anna', 'ben', 'cara'], matches, tipped, 'match', now);
  assert.deepEqual([...r], [['anna', 0], ['ben', 1], ['cara', 2]]);
});

test('missingAnswers: nur Personen mit offenen Fragen', () => {
  const qs = [{ id: 'q1', question: 'Wer wird Weltmeister?' }, { id: 'q2', question: 'Finals-MVP?' }];
  const r = missingAnswers(['anna', 'ben'], qs, new Set(['anna:q1', 'anna:q2', 'ben:q1']));
  assert.deepEqual(r, [{ userId: 'ben', questions: ['Finals-MVP?'] }]);
});
