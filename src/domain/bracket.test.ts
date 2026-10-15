import { test } from 'node:test';
import assert from 'node:assert/strict';

import { type BracketMatch, type BracketTeam, buildPhases, currentPhase, markFor, phaseKind, phaseOf, roundOf } from './bracket.ts';

const team = (id: string): BracketTeam => ({ id, name: `Team ${id}`, short: id });
const T = Object.fromEntries(['KC', 'C9', 'FUR', 'MVK', 'GEN', 'T1', 'HLE', 'G2'].map((id) => [id, team(id)]));

let n = 0;
/** Ein Spiel: result "3-1" = Team A gewinnt 3:1; ohne result noch nicht gespielt. */
function match(stage: string | null, pos: number, a: string | null, b: string | null, result?: string, hour = n): BracketMatch {
  n++;
  const [wa, wb] = result ? result.split('-').map(Number) : [null, null];
  return {
    id: `m${n}`,
    stage,
    stagePosition: pos,
    bestOf: 5,
    scheduledAt: new Date(Date.UTC(2026, 9, 15, 12 + hour)),
    status: result ? 'finished' : 'scheduled',
    teamA: a ? T[a] : null,
    teamB: b ? T[b] : null,
    winsA: wa,
    winsB: wb,
  };
}

test('Phase und Runde aus dem Abschnittsnamen', () => {
  assert.equal(phaseOf('Play-In: oberes Halbfinale'), 'Play-In');
  assert.equal(roundOf('Play-In: oberes Halbfinale'), 'Oberes Halbfinale');
  assert.equal(phaseOf('Swiss: Runde 3'), 'Swiss');
  assert.equal(roundOf('Swiss: Runde 3'), 'Runde 3');
  for (const s of ['Viertelfinale', 'Halbfinale', 'Finale', 'Achtelfinale']) assert.equal(phaseOf(s), 'K.-o.-Phase');
  assert.equal(roundOf('Viertelfinale'), 'Viertelfinale');
  assert.equal(phaseOf(null), 'Weitere Spiele');
  assert.equal(phaseOf('Gruppenphase'), 'Gruppenphase');
  assert.deepEqual(['Play-In', 'Swiss', 'K.-o.-Phase', 'Gruppenphase'].map(phaseKind), ['doppel', 'swiss', 'ko', 'offen']);
});

test('Play-In (doppeltes K.o.): zweimal verloren oder Finale verloren = ausgeschieden', () => {
  n = 0;
  const m = {
    oh1: match('Play-In: oberes Halbfinale', 0, 'KC', 'C9', '3-1'), // C9 → unteres Halbfinale
    oh2: match('Play-In: oberes Halbfinale', 0, 'FUR', 'MVK', '0-3'), // FUR → unteres Halbfinale
    uh: match('Play-In: unteres Halbfinale', 1, 'C9', 'FUR', '3-2'), // FUR hat 2 Niederlagen
    of: match('Play-In: oberes Finale', 2, 'KC', 'MVK', '1-3'), // KC verliert, fällt ins untere Finale
    uf: match('Play-In: unteres Finale', 3, 'KC', 'C9', '3-0'), // C9 hat 2 Niederlagen
    f: match('Play-In: Finale', 4, 'MVK', 'KC', '2-3'), // MVK verliert das Finale, KC ist weiter
  };
  const [phase] = buildPhases(Object.values(m));
  const state = Object.fromEntries(phase.records.map((r) => [r.team.id, r.state]));
  assert.deepEqual(state, { KC: 'weiter', C9: 'ausgeschieden', FUR: 'ausgeschieden', MVK: 'ausgeschieden' });
  assert.deepEqual(phase.rounds.map((r) => r.name), ['Oberes Halbfinale', 'Unteres Halbfinale', 'Oberes Finale', 'Unteres Finale', 'Finale']);

  // Gekennzeichnet wird erst ab dem Spiel, mit dem ein Team ausgeschieden ist
  assert.equal(markFor(phase, 'C9', m.oh1.id), null, 'C9 hat das erste Spiel verloren, ist dort aber noch dabei');
  assert.equal(markFor(phase, 'C9', m.uh.id), null);
  assert.equal(markFor(phase, 'C9', m.uf.id), 'ausgeschieden');
  assert.equal(markFor(phase, 'FUR', m.uh.id), 'ausgeschieden');
  assert.equal(markFor(phase, 'MVK', m.f.id), 'ausgeschieden', 'Finale verloren, obwohl erst eine Niederlage');
  assert.equal(markFor(phase, 'KC', m.f.id), 'weiter');
  assert.equal(markFor(phase, 'KC', m.of.id), null);
});

test('Play-In: Zwischenstand – wer einmal verloren hat, ist noch dabei', () => {
  n = 0;
  const [phase] = buildPhases([
    match('Play-In: oberes Halbfinale', 0, 'KC', 'C9', '3-1'),
    match('Play-In: oberes Halbfinale', 0, 'FUR', 'MVK'),
    match('Play-In: unteres Halbfinale', 1, null, null),
  ]);
  const state = Object.fromEntries(phase.records.map((r) => [r.team.id, r.state]));
  assert.deepEqual(state, { KC: 'aktiv', C9: 'aktiv', FUR: 'aktiv', MVK: 'aktiv' });
});

test('Swiss: 3 Siege = weiter, 3 Niederlagen = ausgeschieden', () => {
  n = 0;
  const swiss = (round: number, a: string, b: string, r?: string) => match(`Swiss: Runde ${round}`, 4 + round, a, b, r);
  const ms = [
    swiss(1, 'GEN', 'T1', '1-0'),
    swiss(2, 'GEN', 'HLE', '1-0'),
    swiss(3, 'GEN', 'G2', '1-0'), // GEN: 3 Siege
    swiss(1, 'G2', 'HLE', '0-1'),
    swiss(2, 'T1', 'G2', '0-1'),
    swiss(4, 'T1', 'HLE', '0-1'), // T1: 3 Niederlagen (G2, GEN, HLE)
    swiss(4, 'KC', 'C9'),
  ];
  const [phase] = buildPhases(ms);
  assert.equal(phase.kind, 'swiss');
  const rec = Object.fromEntries(phase.records.map((r) => [r.team.id, `${r.wins}-${r.losses} ${r.state}`]));
  assert.equal(rec.GEN, '3-0 weiter');
  assert.equal(rec.T1, '0-3 ausgeschieden');
  assert.equal(rec.HLE, '2-1 aktiv');
  assert.equal(rec.G2, '1-2 aktiv');
  assert.equal(rec.KC, '0-0 aktiv');
  assert.deepEqual(phase.records.map((r) => r.team.id), ['GEN', 'HLE', 'G2', 'C9', 'KC', 'T1'], 'beste Bilanz zuerst, Ausgeschiedene am Ende');
  // GEN ist erst im dritten Sieg "weiter", T1 erst in der dritten Niederlage "ausgeschieden"
  assert.equal(markFor(phase, 'GEN', ms[1].id), null);
  assert.equal(markFor(phase, 'GEN', ms[2].id), 'weiter');
  assert.equal(markFor(phase, 'T1', ms[4].id), null);
  assert.equal(markFor(phase, 'T1', ms[5].id), 'ausgeschieden');
});

test('K.-o.-Phase: jede Niederlage scheidet aus, das Finale gewinnt der Sieger', () => {
  n = 0;
  const vf1 = match('Viertelfinale', 10, 'GEN', 'KC', '3-0');
  const vf2 = match('Viertelfinale', 10, 'T1', 'HLE', '1-3');
  const hf1 = match('Halbfinale', 11, 'GEN', 'HLE', '3-2');
  const finale = match('Finale', 12, 'GEN', 'G2');
  const [phase] = buildPhases([vf1, vf2, hf1, finale]);
  assert.equal(phase.name, 'K.-o.-Phase');
  assert.deepEqual(phase.rounds.map((r) => r.name), ['Viertelfinale', 'Halbfinale', 'Finale']);
  const state = Object.fromEntries(phase.records.map((r) => [r.team.id, r.state]));
  assert.deepEqual(state, { GEN: 'aktiv', KC: 'ausgeschieden', T1: 'ausgeschieden', HLE: 'ausgeschieden', G2: 'aktiv' });
  assert.equal(markFor(phase, 'HLE', vf2.id), null, 'HLE gewinnt das Viertelfinale und ist dort nicht ausgegraut');
  assert.equal(markFor(phase, 'HLE', hf1.id), 'ausgeschieden');

  // Nach dem Finale
  const done = { ...finale, status: 'finished' as const, winsA: 3, winsB: 1 };
  const [after] = buildPhases([vf1, vf2, hf1, done]);
  assert.equal(after.records.find((r) => r.team.id === 'GEN')!.state, 'sieger');
  assert.equal(after.records.find((r) => r.team.id === 'G2')!.state, 'ausgeschieden');
});

test('K.-o.-Phase ohne Finale in den Daten: niemand wird zum Sieger erklärt', () => {
  n = 0;
  const [phase] = buildPhases([match('Viertelfinale', 10, 'GEN', 'KC', '3-0')]);
  assert.equal(phase.records.find((r) => r.team.id === 'GEN')!.state, 'aktiv');
});

test('Unbekannte Phasen: keine Markierung, Phasen nach Reihenfolge, abgesagte Spiele fehlen', () => {
  n = 0;
  const g = match('Gruppenphase: Gruppe A', 0, 'GEN', 'T1', '3-0');
  const cancelled = { ...match('Gruppenphase: Gruppe A', 0, 'GEN', 'KC'), status: 'cancelled' as const };
  const phases = buildPhases([match('Swiss: Runde 1', 5, 'GEN', 'T1', '1-0'), g, cancelled]);
  assert.deepEqual(phases.map((p) => p.name), ['Gruppenphase', 'Swiss']);
  assert.equal(phases[0].matches.length, 1);
  assert.ok(phases[0].records.every((r) => r.state === 'aktiv'));
});

test('Spiele ohne Ergebnis oder ohne Teams verändern nichts', () => {
  n = 0;
  const noResult = { ...match('Viertelfinale', 10, 'GEN', 'KC'), status: 'finished' as const };
  const [phase] = buildPhases([noResult, match('Viertelfinale', 10, null, null)]);
  assert.deepEqual(phase.records.map((r) => r.state), ['aktiv', 'aktiv']);
});

test('Welche Phase zuerst: laufendes Spiel, sonst nächstes offenes, sonst die letzte', () => {
  n = 0;
  const done = (stage: string, pos: number) => match(stage, pos, 'GEN', 'T1', '3-0');
  const phases = buildPhases([done('Play-In: Finale', 0), match('Swiss: Runde 1', 5, 'GEN', 'T1')]);
  assert.equal(currentPhase(phases)!.name, 'Swiss');
  const live = { ...match('Play-In: Finale', 0, 'GEN', 'T1'), status: 'live' as const };
  assert.equal(currentPhase(buildPhases([live, match('Swiss: Runde 1', 5, 'GEN', 'T1')]))!.name, 'Play-In');
  assert.equal(currentPhase(buildPhases([done('Play-In: Finale', 0), done('Swiss: Runde 1', 5)]))!.name, 'Swiss');
  assert.equal(currentPhase([]), undefined);
});
