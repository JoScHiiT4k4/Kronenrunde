import { test } from 'node:test';
import assert from 'node:assert/strict';

import { regionCounts, type StatMatch, type StatTeam, teamStats, tournamentStat } from './statistics.ts';

const T = (id: string, region = 'LCK'): StatTeam => ({ id, name: `Team ${id}`, short: id, region });
const [a, b, c] = [T('A'), T('B'), T('C', 'LEC')];
let n = 0;
const m = (x: StatTeam | null, y: StatTeam | null, wx: number | null, wy: number | null, bestOf = 3, status: StatMatch['status'] = wx === null ? 'scheduled' : 'finished'): StatMatch => ({
  teamA: x, teamB: y, winsA: wx, winsB: wy, status, bestOf, time: n++,
});

test('Turnier in Zahlen: Maps, Sweeps und volle Distanz', () => {
  const s = tournamentStat([m(a, b, 2, 0), m(a, c, 2, 1), m(b, c, 1, 0, 1), m(a, b, null, null), m(b, c, null, null, 3, 'live'), m(a, c, 0, 0, 3, 'cancelled')]);
  assert.deepEqual(s, { total: 5, finished: 3, live: 1, open: 1, maps: 6, mapsPerSeries: 2, sweeps: 1, fullDistance: 1 });
  assert.equal(tournamentStat([]).mapsPerSeries, null);
});

test('Teams: Bilanz, Maps, Quote, Serie; Teams ohne Spiel stehen mit dabei', () => {
  const rows = teamStats([m(a, b, 2, 0), m(a, c, 1, 2), m(b, c, 2, 1)], [a, b, c, T('D')]);
  assert.deepEqual(rows.map((r) => r.team.id), ['A', 'C', 'B', 'D']);
  const A = rows.find((r) => r.team.id === 'A')!;
  assert.deepEqual([A.wins, A.losses, A.mapsWon, A.mapsLost, A.winRate], [1, 1, 3, 2, 50]);
  assert.deepEqual(A.streak, { win: false, length: 1 });
  assert.deepEqual(rows[1].streak, { win: false, length: 1 }, 'C hat zuletzt verloren');
  assert.equal(rows[3].winRate, null);
  assert.equal(rows[3].streak, null);
});

test('Regionen zählen', () => {
  assert.deepEqual(regionCounts([a, b, c, { ...c, id: 'X', region: null }]), [
    { region: 'LCK', count: 2 },
    { region: 'LEC', count: 1 },
    { region: 'Unbekannt', count: 1 },
  ]);
});
