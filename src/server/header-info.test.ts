import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchdayState, orderTournaments, pickTournament } from './header-info.ts';

const now = new Date('2026-10-15T12:00:00Z');
const row = (name: string, start: string, live = false, open = true) => ({ name, starts_at: new Date(start), live, open });

test('pickTournament: laufendes Spiel, dann begonnenes Turnier, dann nächster Start', () => {
  assert.equal(pickTournament([], now), null);
  assert.equal(pickTournament([row('MSI', '2026-05-01T00:00:00Z', false, false)], now), null, 'beendet');
  const next = pickTournament([row('A', '2026-11-01T00:00:00Z'), row('B', '2026-10-20T00:00:00Z')], now)!;
  assert.deepEqual([next.name, next.running, next.live], ['B', false, false]);
  const running = pickTournament([row('Worlds', '2026-10-14T00:00:00Z')], now)!;
  assert.deepEqual([running.running, running.live], [true, false]);
  const live = pickTournament([row('A', '2026-10-20T00:00:00Z'), row('Worlds', '2026-10-14T00:00:00Z', true)], now)!;
  assert.deepEqual([live.name, live.live], ['Worlds', true]);
});

test('orderTournaments: ein laufendes Turnier geht vor dem nächsten (MSI erst, wenn die Worlds vorbei sind)', () => {
  const rows = [row('MSI 2027', '2027-05-01T00:00:00Z'), row('Worlds 2026', '2026-10-14T00:00:00Z')];
  assert.deepEqual(orderTournaments(rows, now).map((r) => r.name), ['Worlds 2026', 'MSI 2027']);
  const over = [row('MSI 2027', '2027-05-01T00:00:00Z'), row('Worlds 2026', '2026-10-14T00:00:00Z', false, false)];
  assert.deepEqual(orderTournaments(over, now).map((r) => r.name), ['MSI 2027'], 'beendete Turniere fallen weg');
});

const at = (iso: string, status = 'scheduled') => ({ at: new Date(iso), status });
const tz = 'Europe/Berlin';

test('matchdayState: Countdown bis zum nächsten Spieltag, am Spieltag "live", danach wieder Countdown', () => {
  // Heute (15.10.) um 16 und 18 Uhr Berlin, morgen um 16 Uhr
  const day = (status1: string, status2: string) => [at('2026-10-15T14:00:00Z', status1), at('2026-10-15T16:00:00Z', status2), at('2026-10-16T14:00:00Z')];
  const before = new Date('2026-10-15T11:00:00Z');
  assert.deepEqual(matchdayState(day('scheduled', 'scheduled'), before, tz), { live: false, next: new Date('2026-10-15T14:00:00Z') });
  // Erster Anstoß war, der Status steht noch auf "scheduled": trotzdem Live
  assert.deepEqual(matchdayState(day('scheduled', 'scheduled'), new Date('2026-10-15T14:00:30Z'), tz), { live: true, next: null });
  // Erstes Spiel fertig, zweites noch nicht angepfiffen: der Spieltag läuft noch
  assert.deepEqual(matchdayState(day('finished', 'scheduled'), new Date('2026-10-15T15:30:00Z'), tz), { live: true, next: null });
  // Alle Spiele des Tages fertig: Countdown zum nächsten Spieltag
  assert.deepEqual(matchdayState(day('finished', 'finished'), new Date('2026-10-15T18:00:00Z'), tz), { live: false, next: new Date('2026-10-16T14:00:00Z') });
  // Alles gespielt: nichts mehr anzuzeigen
  assert.deepEqual(matchdayState([at('2026-10-15T14:00:00Z', 'finished')], now, tz), { live: false, next: null });
  // Vergessenes Spiel (Plan vor Tagen, nie gewertet) blockiert nichts
  assert.deepEqual(matchdayState([at('2026-10-10T14:00:00Z'), at('2026-10-16T14:00:00Z')], now, tz), { live: false, next: new Date('2026-10-16T14:00:00Z') });
});
