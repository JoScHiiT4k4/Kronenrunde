import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickTournament } from './header-info.ts';

const now = new Date('2026-10-15T12:00:00Z');
const row = (name: string, start: string, live = false, open = true) => ({ name, starts_at: new Date(start), live, open });

test('pickTournament: laufendes Spiel gewinnt, sonst nächster Start, sonst laufendes Turnier', () => {
  assert.equal(pickTournament([], now), null);
  assert.equal(pickTournament([row('MSI', '2026-05-01T00:00:00Z', false, false)], now), null, 'beendet');
  const next = pickTournament([row('A', '2026-11-01T00:00:00Z'), row('B', '2026-10-20T00:00:00Z')], now)!;
  assert.deepEqual([next.name, next.running, next.live], ['B', false, false]);
  const running = pickTournament([row('Worlds', '2026-10-14T00:00:00Z')], now)!;
  assert.deepEqual([running.running, running.live], [true, false]);
  const live = pickTournament([row('A', '2026-10-20T00:00:00Z'), row('Worlds', '2026-10-14T00:00:00Z', true)], now)!;
  assert.deepEqual([live.name, live.live], ['Worlds', true]);
});
