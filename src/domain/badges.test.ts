import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBadges, type BadgeInput } from './badges.ts';
import type { Match, Prediction } from './types.ts';

const rules = { pointsWinner: 1, pointsExact: 1, lockMode: 'auto' as const };
const members = ['anna', 'ben', 'cem', 'dora'].map((id) => ({ userId: id, displayName: id }));
let n = 0;

/** Spiel mit Ergebnis (A gewinnt 3:1 bzw. B gewinnt 3:0, je nach "winner") am gegebenen Tag und in der gegebenen Stunde */
function match(day: number, hour: number, winner: 'A' | 'B' = 'A', bestOf: 1 | 5 = 5): Match {
  n++;
  const start = new Date(Date.UTC(2026, 9, day, 10));
  return {
    id: `m${n}`,
    bestOf,
    scheduledAt: new Date(Date.UTC(2026, 9, day, hour)),
    matchdayStartsAt: start,
    teamA: 'A',
    teamB: 'B',
    winsA: bestOf === 1 ? (winner === 'A' ? 1 : 0) : winner === 'A' ? 3 : 1,
    winsB: bestOf === 1 ? (winner === 'B' ? 1 : 0) : winner === 'B' ? 3 : 1,
    finished: true,
  } as Match;
}
const tip = (userId: string, m: Match, winner: 'A' | 'B', exact = false): Prediction => ({
  matchId: m.id,
  userId,
  winner,
  winnerWins: m.bestOf === 1 ? null : 3,
  loserWins: m.bestOf === 1 ? null : exact ? 1 : 2,
});
const base = (over: Partial<BadgeInput>): BadgeInput => ({ userId: 'anna', members, matches: [], predictions: [], rules, bonusQuestions: [], bonusAnswers: [], rank: 4, points: 0, ...over });
const get = (r: ReturnType<typeof computeBadges>, key: string) => r.find((b) => b.key === key)!;

test('Abzeichen: ohne Tipps ist nichts erreicht', () => {
  const r = computeBadges(base({}));
  assert.equal(r.length, 8);
  assert.ok(r.every((b) => b.level === 0));
  assert.equal(get(r, 'volltreffer').next, 1);
});

test('Volltreffer, Serie und Vielspieler zählen nur gewertete Spiele', () => {
  n = 0;
  const ms = [match(15, 11, 'A', 5), match(15, 12, 'A', 5), match(15, 13, 'A', 5), match(15, 14, 'B', 5)];
  const predictions = [...ms.slice(0, 3).map((m) => tip('anna', m, 'A', true)), tip('anna', ms[3], 'A')]; // letzte falsch
  const r = computeBadges(base({ matches: ms, predictions }));
  assert.equal(get(r, 'volltreffer').value, 3);
  assert.equal(get(r, 'volltreffer').level, 1);
  assert.equal(get(r, 'serie').value, 3, 'drei richtige in Folge, dann ein falscher');
  assert.equal(get(r, 'serie').level, 1);
  assert.equal(get(r, 'vielspieler').value, 4);
});

test('Fehlender Tipp unterbricht die Serie', () => {
  n = 0;
  const ms = [match(15, 11), match(15, 12), match(15, 13), match(15, 14), match(15, 15)];
  const predictions = [0, 1, 3, 4].map((i) => tip('anna', ms[i], 'A'));
  const r = computeBadges(base({ matches: ms, predictions }));
  assert.equal(get(r, 'serie').value, 2);
});

test('Perfekter Spieltag braucht drei Spiele, alle fertig und alle richtig', () => {
  n = 0;
  const day1 = [match(15, 11), match(15, 12), match(15, 13)];
  const day2 = [match(16, 11), match(16, 12)]; // nur zwei Spiele
  const open = { ...match(17, 11), winsA: null, winsB: null, finished: false } as Match;
  const day3 = [match(17, 12), match(17, 13), open];
  const predictions = [...day1, ...day2, ...day3].filter((m) => m.id !== open.id).map((m) => tip('anna', m, 'A'));
  const r = computeBadges(base({ matches: [...day1, ...day2, ...day3], predictions }));
  assert.equal(get(r, 'spieltag').value, 1);
});

test('Tagessieger: die meisten Punkte, geteilter Sieg zählt für alle', () => {
  n = 0;
  const day = [match(15, 11), match(15, 12)];
  const predictions = [
    ...day.map((m) => tip('anna', m, 'A')), // 2 Punkte
    ...day.map((m) => tip('ben', m, 'A')), // 2 Punkte (geteilt)
    tip('cem', day[0], 'A'), // 1 Punkt
  ];
  const r = computeBadges(base({ matches: day, predictions }));
  assert.equal(get(r, 'tagessieger').value, 1);
  assert.equal(get(computeBadges(base({ userId: 'cem', matches: day, predictions })), 'tagessieger').value, 0);
});

test('Außenseiter: nur der Sieger, den höchstens ein Drittel getippt hat (ab 4 Tippern)', () => {
  n = 0;
  const m = match(15, 11, 'B');
  const predictions = [tip('anna', m, 'B'), tip('ben', m, 'A'), tip('cem', m, 'A'), tip('dora', m, 'A')]; // 1 von 4 auf B
  assert.equal(get(computeBadges(base({ matches: [m], predictions })), 'aussenseiter').value, 1);
  const crowd = [tip('anna', m, 'B'), tip('ben', m, 'B'), tip('cem', m, 'A'), tip('dora', m, 'A')]; // Hälfte
  assert.equal(get(computeBadges(base({ matches: [m], predictions: crowd })), 'aussenseiter').value, 0);
});

test('Sonderfragen und Platz in der Rangliste', () => {
  const q = { id: 'q1', points: 3, correctAnswers: ['Faker'] };
  const r = computeBadges(base({ bonusQuestions: [q], bonusAnswers: [{ questionId: 'q1', userId: 'anna', answer: 'faker' }, { questionId: 'q1', userId: 'ben', answer: 'Chovy' }], rank: 1, points: 5 }));
  assert.equal(get(r, 'sonderfragen').value, 1);
  assert.equal(get(r, 'sonderfragen').level, 1);
  assert.equal(get(r, 'spitze').level, 3, 'Platz 1 = Gold');
  assert.equal(get(computeBadges(base({ rank: 3, points: 2 })), 'spitze').level, 1);
  assert.equal(get(computeBadges(base({ rank: 1, points: 0 })), 'spitze').level, 0, 'ohne Punkte keine Spitze');
});
