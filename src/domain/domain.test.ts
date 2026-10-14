import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBonusCorrect, normalizeAnswer, bonusPoints } from './bonus.ts';
import { arePredictionsPublic, computeMatchdayStarts, isOpen, lockTime } from './locking.ts';
import { isValidResult, matchResult, resultOptions } from './results.ts';
import { computeStandings, scorePrediction } from './scoring.ts';
import type { LeagueRules, Match, Prediction } from './types.ts';

const at = (iso: string) => new Date(iso);
const rules: LeagueRules = { pointsWinner: 1, pointsExact: 1, lockMode: 'matchday' };

function match(over: Partial<Match> & { id: string }): Match {
  return {
    bestOf: 5,
    scheduledAt: null,
    matchdayStartsAt: null,
    teamA: 'Karmine Corp',
    teamB: 'Cloud9',
    winsA: null,
    winsB: null,
    ...over,
  };
}

// ---------------------------------------------------------------- Ergebnisse

test('Auswahl je Format', () => {
  assert.deepEqual(resultOptions(1).map((o) => o.winner), ['A', 'B']);
  assert.deepEqual(
    resultOptions(3).map((o) => `${o.winner} ${o.winnerWins}:${o.loserWins}`),
    ['A 2:0', 'A 2:1', 'B 2:1', 'B 2:0'],
  );
  assert.equal(resultOptions(5).length, 6);
  assert.deepEqual(resultOptions(5)[2], { winner: 'A', winnerWins: 3, loserWins: 2 });
});

test('Ergebnis eines Spiels', () => {
  assert.equal(matchResult(match({ id: 'm' })), null);
  assert.deepEqual(matchResult(match({ id: 'm', winsA: 1, winsB: 3 })), { winner: 'B', winnerWins: 3, loserWins: 1 });
  assert.deepEqual(matchResult(match({ id: 'm', bestOf: 1, winsA: 1, winsB: 0 })), {
    winner: 'A', winnerWins: null, loserWins: null,
  });
});

test('Gültige Tipps je Format', () => {
  assert.ok(isValidResult(5, { winner: 'A', winnerWins: 3, loserWins: 2 }));
  assert.ok(!isValidResult(5, { winner: 'A', winnerWins: 2, loserWins: 1 }));
  assert.ok(!isValidResult(3, { winner: 'A', winnerWins: 2, loserWins: 2 }));
  assert.ok(isValidResult(1, { winner: 'B', winnerWins: null, loserWins: null }));
  assert.ok(!isValidResult(1, { winner: 'B', winnerWins: 1, loserWins: 0 }));
});

// ---------------------------------------------------------------- Tippschluss

test('Spieltage: über Mitternacht zusammen, nächster Abend getrennt', () => {
  const starts = computeMatchdayStarts([
    { id: 'pi1', scheduledAt: at('2026-10-15T20:00:00+02:00') },
    { id: 'pi2', scheduledAt: at('2026-10-16T01:00:00+02:00') }, // 5 h später → gleicher Spieltag
    { id: 'pi3', scheduledAt: at('2026-10-16T20:00:00+02:00') }, // 19 h später → neuer Spieltag
    { id: 'tbd', scheduledAt: null },
  ]);
  assert.equal(starts.get('pi1')?.toISOString(), at('2026-10-15T20:00:00+02:00').toISOString());
  assert.equal(starts.get('pi2')?.toISOString(), at('2026-10-15T20:00:00+02:00').toISOString());
  assert.equal(starts.get('pi3')?.toISOString(), at('2026-10-16T20:00:00+02:00').toISOString());
  assert.equal(starts.has('tbd'), false);
});

test('Spieltag: genau 6 Stunden Abstand beginnt einen neuen Spieltag', () => {
  const starts = computeMatchdayStarts([
    { id: 'a', scheduledAt: at('2026-10-23T19:00:00+02:00') },
    { id: 'b', scheduledAt: at('2026-10-24T01:00:00+02:00') },
  ]);
  assert.equal(starts.get('b')?.toISOString(), at('2026-10-24T01:00:00+02:00').toISOString());
});

test('Tippschluss je Einstellung', () => {
  const m = match({
    id: 'pi2',
    scheduledAt: at('2026-10-16T01:00:00+02:00'),
    matchdayStartsAt: at('2026-10-15T20:00:00+02:00'),
  });
  assert.equal(lockTime(m, 'matchday')?.toISOString(), at('2026-10-15T20:00:00+02:00').toISOString());
  assert.equal(lockTime(m, 'match')?.toISOString(), at('2026-10-16T01:00:00+02:00').toISOString());

  const vorher = at('2026-10-15T19:59:00+02:00');
  const nachher = at('2026-10-15T20:00:00+02:00');
  assert.ok(isOpen(m, 'matchday', vorher));
  assert.ok(!isOpen(m, 'matchday', nachher));
  assert.ok(isOpen(m, 'match', nachher));
  assert.ok(!arePredictionsPublic(m, 'matchday', vorher));
  assert.ok(arePredictionsPublic(m, 'matchday', nachher));
});

test('Tippschluss automatisch: Anstoß, oder früher, sobald das Spiel davor vorbei ist oder es läuft', () => {
  const zweites = (extra: Partial<Parameters<typeof match>[0]> = {}) =>
    match({ id: 'pi2', scheduledAt: at('2026-10-16T01:00:00+02:00'), matchdayStartsAt: at('2026-10-15T20:00:00+02:00'), ...extra });
  // Spiel davor läuft noch: offen bis zum angesetzten Anstoß
  assert.equal(lockTime(zweites(), 'auto')?.toISOString(), at('2026-10-16T01:00:00+02:00').toISOString());
  assert.ok(isOpen(zweites(), 'auto', at('2026-10-15T23:30:00+02:00')));
  // Spiel davor um 23:10 vorbei → ab dann zu, obwohl der Anstoß erst für 01:00 angesetzt war
  const frueh = zweites({ previousFinishedAt: at('2026-10-15T23:10:00+02:00') });
  assert.equal(lockTime(frueh, 'auto')?.toISOString(), at('2026-10-15T23:10:00+02:00').toISOString());
  assert.ok(!isOpen(frueh, 'auto', at('2026-10-15T23:30:00+02:00')));
  assert.ok(arePredictionsPublic(frueh, 'auto', at('2026-10-15T23:30:00+02:00')));
  // Spiel davor läuft über die Zeit → spätestens zum angesetzten Anstoß zu (Sicherheitsnetz)
  assert.ok(!isOpen(zweites({ previousFinishedAt: at('2026-10-16T01:30:00+02:00') }), 'auto', at('2026-10-16T01:00:00+02:00')));
  // Als "läuft" gemeldet → zu
  assert.ok(!isOpen(zweites({ liveAt: at('2026-10-15T23:50:00+02:00') }), 'auto', at('2026-10-15T23:55:00+02:00')));
});

test('Ohne Teams oder ohne Anstoßzeit kann nicht getippt werden', () => {
  const jetzt = at('2026-10-14T12:00:00+02:00');
  assert.ok(!isOpen(match({ id: 'x', teamA: null, scheduledAt: at('2026-10-20T20:00:00+02:00') }), 'matchday', jetzt));
  assert.ok(!isOpen(match({ id: 'y', scheduledAt: null }), 'matchday', jetzt));
});

// ---------------------------------------------------------------- Sonderfragen

test('Antworten vergleichen: Schreibweise egal, mehrere richtige möglich', () => {
  assert.equal(normalizeAnswer(" Anyone's Legend "), 'anyoneslegend');
  assert.ok(isBonusCorrect("K'Sante", { correctAnswers: ['KSante', 'Rumble'] }));
  assert.ok(isBonusCorrect('rumble', { correctAnswers: ['KSante; ', 'Rumble'] }));
  assert.ok(isBonusCorrect('løs', { correctAnswers: ['LØS'] }));
  assert.ok(!isBonusCorrect('', { correctAnswers: [''] }));
  assert.equal(bonusPoints('T1', { id: 'q', points: 4, correctAnswers: [] }), null);
  assert.equal(bonusPoints('T1', { id: 'q', points: 4, correctAnswers: ['Gen.G'] }), 0);
  assert.equal(bonusPoints('t1', { id: 'q', points: 4, correctAnswers: ['T1'] }), 4);
});

// ---------------------------------------------------------------- Punkte

test('Punkte für einen Tipp', () => {
  const m = match({ id: 'm', winsA: 3, winsB: 1 });
  const tipp = (winner: 'A' | 'B', w: number | null, l: number | null): Prediction => ({
    matchId: 'm', userId: 'u', winner, winnerWins: w, loserWins: l,
  });
  assert.deepEqual(scorePrediction(tipp('A', 3, 1), m, rules), { points: 2, correctWinner: true, exact: true });
  assert.deepEqual(scorePrediction(tipp('A', 3, 2), m, rules), { points: 1, correctWinner: true, exact: false });
  assert.deepEqual(scorePrediction(tipp('B', 3, 1), m, rules), { points: 0, correctWinner: false, exact: false });
  assert.equal(scorePrediction(tipp('A', 3, 1), match({ id: 'm' }), rules).points, null);

  const bo1 = match({ id: 'm', bestOf: 1, winsA: 0, winsB: 1 });
  assert.deepEqual(scorePrediction(tipp('B', null, null), bo1, rules), { points: 1, correctWinner: true, exact: false });

  const eigeneRegeln: LeagueRules = { pointsWinner: 2, pointsExact: 3, lockMode: 'match' };
  assert.equal(scorePrediction(tipp('A', 3, 1), m, eigeneRegeln).points, 5);
});

test('Rangliste wie im bisherigen Tippspiel', () => {
  const matches = [
    match({ id: 'm1', winsA: 3, winsB: 1 }),                      // Karmine Corp 3:1
    match({ id: 'm2', teamA: 'MVK Esports', teamB: 'FURIA', winsA: 0, winsB: 3 }),
    match({ id: 'm3', bestOf: 1, teamA: 'Gen.G', teamB: 'Team Liquid', winsA: 1, winsB: 0 }),
    match({ id: 'm4', bestOf: 3, teamA: 'T1', teamB: 'G2 Esports' }), // noch kein Ergebnis
  ];
  const p = (userId: string, matchId: string, winner: 'A' | 'B', w: number | null = null, l: number | null = null): Prediction =>
    ({ userId, matchId, winner, winnerWins: w, loserWins: l });
  const predictions = [
    p('anna', 'm1', 'A', 3, 1), p('anna', 'm2', 'B', 3, 0), p('anna', 'm4', 'A', 2, 0),
    p('ben', 'm1', 'A', 3, 1),
    p('cem', 'm2', 'A', 3, 2), p('cem', 'm3', 'A'),
    p('fremd', 'm1', 'A', 3, 1), // kein Mitglied → zählt nicht
  ];
  const standings = computeStandings({
    members: [
      { userId: 'anna', displayName: 'Anna' },
      { userId: 'ben', displayName: 'Ben' },
      { userId: 'cem', displayName: 'Cem' },
      { userId: 'dana', displayName: 'Dana' },
    ],
    matches,
    predictions,
    rules,
    bonusQuestions: [
      { id: 's1', points: 4, correctAnswers: ['T1'] },
      { id: 's2', points: 3, correctAnswers: [] }, // noch offen
    ],
    bonusAnswers: [
      { questionId: 's1', userId: 'ben', answer: 't1' },
      { questionId: 's2', userId: 'ben', answer: 'Faker' },
      { questionId: 's1', userId: 'cem', answer: 'Gen.G' },
    ],
  });

  assert.deepEqual(
    standings.map((r) => [r.rank, r.displayName, r.points, r.correctWinners, r.exactResults, r.bonusPoints, r.predictionsMade]),
    [
      [1, 'Ben', 6, 1, 1, 4, 1],
      [2, 'Anna', 4, 2, 2, 0, 3],
      [3, 'Cem', 1, 1, 0, 0, 2],
      [4, 'Dana', 0, 0, 0, 0, 0],
    ],
  );
});

test('Gleichstand: gleiche Punkte und gleich viele exakte Ergebnisse → gleicher Platz', () => {
  const standings = computeStandings({
    members: [
      { userId: 'a', displayName: 'Anna' },
      { userId: 'b', displayName: 'Ben' },
      { userId: 'c', displayName: 'Cem' },
    ],
    matches: [match({ id: 'm', winsA: 3, winsB: 0 })],
    predictions: [
      { userId: 'a', matchId: 'm', winner: 'A', winnerWins: 3, loserWins: 0 },
      { userId: 'b', matchId: 'm', winner: 'A', winnerWins: 3, loserWins: 0 },
    ],
    rules,
  });
  assert.deepEqual(standings.map((r) => [r.rank, r.displayName]), [[1, 'Anna'], [1, 'Ben'], [3, 'Cem']]);
});
