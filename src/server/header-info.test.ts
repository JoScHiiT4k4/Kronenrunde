import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchdayState, orderTournaments } from './header-info.ts';

const now = new Date('2026-10-15T12:00:00Z');
const row = (name: string, start: string, live = false, open = true) => ({ name, starts_at: new Date(start), live, open });

test('orderTournaments: ein laufendes Turnier geht vor dem nächsten (MSI erst, wenn die Worlds vorbei sind)', () => {
  const rows = [row('MSI 2027', '2027-05-01T00:00:00Z'), row('Worlds 2026', '2026-10-14T00:00:00Z')];
  assert.deepEqual(orderTournaments(rows, now).map((r) => r.name), ['Worlds 2026', 'MSI 2027']);
  const over = [row('MSI 2027', '2027-05-01T00:00:00Z'), row('Worlds 2026', '2026-10-14T00:00:00Z', false, false)];
  assert.deepEqual(orderTournaments(over, now).map((r) => r.name), ['MSI 2027'], 'beendete Turniere fallen weg');
});

const at = (iso: string, status = 'scheduled') => ({ at: new Date(iso), status });

test('matchdayState: "live" nur solange ein Spiel läuft, dazwischen Countdown bis zum nächsten Spiel', () => {
  // Heute um 16 und 20 Uhr Berlin, morgen um 16 Uhr
  const day = (s1: string, s2: string) => [at('2026-10-15T14:00:00Z', s1), at('2026-10-15T18:00:00Z', s2), at('2026-10-16T14:00:00Z')];
  assert.deepEqual(matchdayState(day('scheduled', 'scheduled'), new Date('2026-10-15T11:00:00Z')), { live: false, next: new Date('2026-10-15T14:00:00Z') });
  // Anstoß erreicht (Status noch "scheduled") oder Spiel läuft: Live
  assert.deepEqual(matchdayState(day('scheduled', 'scheduled'), new Date('2026-10-15T14:00:30Z')), { live: true, next: null });
  assert.deepEqual(matchdayState(day('live', 'scheduled'), new Date('2026-10-15T15:00:00Z')), { live: true, next: null });
  // Erstes Spiel fertig, zweites erst um 20 Uhr: Countdown bis 20 Uhr (nicht "Live")
  assert.deepEqual(matchdayState(day('finished', 'scheduled'), new Date('2026-10-15T15:30:00Z')), { live: false, next: new Date('2026-10-15T18:00:00Z') });
  // Alle Spiele des Tages fertig: Countdown zum nächsten Spieltag
  assert.deepEqual(matchdayState(day('finished', 'finished'), new Date('2026-10-15T20:00:00Z')), { live: false, next: new Date('2026-10-16T14:00:00Z') });
  // Alles gespielt: nichts mehr anzuzeigen
  assert.deepEqual(matchdayState([at('2026-10-15T14:00:00Z', 'finished')], now), { live: false, next: null });
  // Vergessenes Spiel (Plan vor Tagen, nie gewertet) blockiert nichts
  assert.deepEqual(matchdayState([at('2026-10-10T14:00:00Z'), at('2026-10-16T14:00:00Z')], now), { live: false, next: new Date('2026-10-16T14:00:00Z') });
});
