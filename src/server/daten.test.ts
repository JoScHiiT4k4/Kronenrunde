// Tests für Turnierdaten-Dateien (ohne Datenbank). Der Import selbst wird in app.test.ts mit Datenbank geprüft.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type TournamentData, validateTournamentData } from './daten.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'daten');
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as TournamentData;

test('Alle Dateien in db/daten sind fehlerfrei', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) assert.deepEqual(validateTournamentData(load(f)), [], f);
});

test('Worlds 2026: Teams, Phasen und Anstoßzeiten (deutsche Zeit) stimmen', () => {
  const d = load('worlds-2026.json');
  assert.equal(d.teams.length, 19);
  const utc = (key: string) => new Date(d.matches.find((x) => x.key === key)!.scheduled_at!).toISOString();
  // laut lolesports.com: Play-In 20:00 MESZ, Viertel-/Halbfinale 23:00 MEZ, Finale 20:00 MEZ
  assert.equal(utc('pi-oh-1'), '2026-10-15T18:00:00.000Z'); // 20:00 MESZ
  assert.equal(utc('pi-f'), '2026-10-18T18:00:00.000Z'); //    20:00 MESZ
  assert.equal(utc('vf-1'), '2026-11-03T22:00:00.000Z'); //    23:00 MEZ
  assert.equal(utc('hf-2'), '2026-11-08T22:00:00.000Z'); //    23:00 MEZ
  assert.equal(utc('finale'), '2026-11-14T19:00:00.000Z'); //  20:00 MEZ
  // Swiss laut lolesports.com: 8 + 8 Bo1, Runde 3 je 4 Bo1/Bo3, Runde 4 sechs Bo3, Runde 5 drei Bo3
  const swiss = d.matches.filter((m) => m.key.startsWith('swiss-'));
  assert.equal(swiss.length, 33);
  const runde = { r1: '11111111', r2: '11111111', r3: '11331133', r4: '333333', r5: '333' };
  assert.equal(swiss.map((m) => m.best_of).join(''), Object.values(runde).join(''));
  assert.equal(utc('swiss-1-1'), '2026-10-23T17:00:00.000Z'); // 19:00 MESZ
  assert.equal(utc('swiss-3-1'), '2026-10-25T17:00:00.000Z'); // 18:00 MEZ (Zeitumstellung)
  assert.equal(utc('swiss-5-3'), '2026-10-31T23:00:00.000Z'); // 0:00 MEZ
  const first = d.matches.find((x) => x.key === 'pi-oh-1')!;
  assert.deepEqual([first.team_a, first.team_b, first.best_of], ['KC', 'C9', 5]);
});

test('Fehler in einer Datei werden gefunden', () => {
  const base = (): TournamentData => ({
    tournament: { key: 'test-1', name: 'Test' },
    stages: ['Swiss'],
    teams: [{ key: 'A', name: 'Alpha' }, { key: 'B', name: 'Beta' }],
    matches: [{ key: 'm1', stage: 'Swiss', team_a: 'A', team_b: 'B', best_of: 3, scheduled_at: '2026-10-23T12:00:00-05:00' }],
  });
  assert.deepEqual(validateTournamentData(base()), []);

  const check = (change: (d: TournamentData) => void, pattern: RegExp) => {
    const d = base();
    change(d);
    const errors = validateTournamentData(d);
    assert.ok(errors.some((e) => pattern.test(e)), `erwartet ${pattern}, bekommen: ${errors.join(' | ')}`);
  };
  check((d) => { d.tournament.key = 'Mit Leerzeichen'; }, /tournament\.key/);
  check((d) => { d.teams.push({ key: 'A', name: 'Gamma' }); }, /key "A" doppelt/);
  check((d) => { d.teams.push({ key: 'C', name: 'alpha' }); }, /Name "alpha" doppelt/);
  check((d) => { d.matches[0].team_b = 'X'; }, /team_b "X" steht nicht in teams/);
  check((d) => { d.matches[0].team_b = 'A'; }, /gegen sich selbst/);
  check((d) => { d.matches[0].best_of = 2 as never; }, /best_of/);
  check((d) => { d.matches[0].stage = 'Gruppe'; }, /Phase "Gruppe"/);
  check((d) => { d.matches[0].scheduled_at = '2026-10-23 12:00'; }, /Zeitzone/);
  check((d) => { d.matches[0].scheduled_at = '2026-10-23T12:00:00'; }, /Zeitzone/);
  check((d) => { d.matches[0].result = [3, 1]; }, /passt nicht zu Bo3/);
  check((d) => { d.matches[0].result = [2, 2]; }, /passt nicht zu Bo3/);
  check((d) => { d.matches[0].team_a = null; d.matches[0].result = [2, 0]; }, /beide Teams/);
  check((d) => { d.matches.push({ ...d.matches[0] }); }, /key doppelt/);
  assert.deepEqual(validateTournamentData(null), ['Die Datei enthält keine Turnierdaten.']);
});
