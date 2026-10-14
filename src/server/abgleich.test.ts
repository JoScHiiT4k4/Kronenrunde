// Tests für den Datenabgleich (ohne Datenbank und ohne Internet). Mit Datenbank: app.test.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchChampions, fetchLolesportsTeams, type LolTeam, matchScheduleTeam, matchTeam } from './abgleich.ts';
import { fakeRiot, lolesports } from './testdaten/fake-riot.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const worlds = JSON.parse(readFileSync(join(root, 'db', 'daten', 'worlds-2026.json'), 'utf8'));

test('Champions: deutsche Namen von Data Dragon, neueste Version', async () => {
  const list = await fetchChampions(fakeRiot());
  assert.equal(list.length, 120);
  assert.ok(list.some((c) => c.id === 'MonkeyKing' && c.name === 'Wukong'));
  // Kaputte oder zu kurze Antwort: lieber Fehler als die Liste zu leeren
  await assert.rejects(fetchChampions(fakeRiot(10)), /nur 10 Champions/);
  await assert.rejects(fetchChampions(async () => ({ nichts: true })), /keine Versionsliste/);
});

test('Spieler: alle 19 Worlds-Teams werden eindeutig ihrem Team bei lolesports zugeordnet', async () => {
  const all = await fetchLolesportsTeams(fakeRiot());
  const expected: Record<string, string> = {
    GEN: 'geng', HLE: 'hanwha-life-esports', T1: 't1', DK: 'dwg-kia', AL: 'anyones-legend', BLG: 'bilibili-gaming',
    TES: 'top-esports', IG: 'invictus-gaming', G2: 'g2-esports', MKOI: 'mad-lions', KC: 'karmine-corp', TL: 'team-liquid',
    LYON: 'lyon-gaming', C9: 'cloud9', TSW: 'team-secret-whales', CFO: 'ctbc-flying-oyster', MVK: 'saigon-buffalo-esports',
    LOS: 'los', FUR: 'furia',
  };
  for (const t of worlds.teams as { key: string; name: string; short_name: string; region: string }[]) {
    const found = matchTeam({ name: t.name, short_name: t.short_name, region: t.region, external_id: null }, all);
    assert.equal(found?.slug, expected[t.key], `${t.name} → ${found?.slug ?? 'nicht gefunden'}`);
  }
  const t1 = matchTeam({ name: 'T1', short_name: 'T1', region: 'LCK', external_id: null }, all)!;
  assert.ok(t1.players!.some((p) => p.summonerName === 'Faker' && p.role === 'mid'));
});

test('Spieler: Akademie-Teams, archivierte Teams und unklare Fälle', () => {
  const all = lolesports.data.teams as LolTeam[];
  // Ohne Liga-Angabe gewinnt das Hauptteam gegen die Akademie mit gleichem Kürzel
  assert.equal(matchTeam({ name: 'FURIA', short_name: 'FUR', region: null, external_id: null }, all)?.slug, 'furia');
  // Bekannte Kennung geht vor
  assert.equal(matchTeam({ name: 'Irgendwas', short_name: null, region: null, external_id: '100205573495116443' }, all)?.slug, 'geng');
  // Archivierte Teams nie
  assert.equal(matchTeam({ name: 'T1 Rookies', short_name: 'T1', region: null, external_id: null }, all)?.slug, 't1');
  // Zwei gleich gute Treffer: lieber keiner
  const twins: LolTeam[] = [
    { id: '1', code: 'AB', name: 'Alpha Beta', status: 'active', homeLeague: { name: 'LEC' } },
    { id: '2', code: 'AB', name: 'Alpha Beta', status: 'active', homeLeague: { name: 'LEC' } },
  ];
  assert.equal(matchTeam({ name: 'Alpha Beta', short_name: 'AB', region: 'LEC', external_id: null }, twins), null);
  // Falsche Liga: nicht zuordnen
  assert.equal(matchTeam({ name: 'Gen.G', short_name: 'GEN', region: 'LEC', external_id: null }, all), null);
});

test('Spielplan: Teams aus dem Spielplan werden den Turnier-Teams zugeordnet', () => {
  const ours = (worlds.teams as { key: string; name: string; short_name: string }[]).map((t) => ({ id: t.key, name: t.name, short_name: t.short_name }));
  assert.equal(matchScheduleTeam({ name: 'Team Liquid Alienware', code: 'TLAW' }, ours), 'TL');
  assert.equal(matchScheduleTeam({ name: 'Cloud9 Kia', code: 'C9' }, ours), 'C9');
  assert.equal(matchScheduleTeam({ name: 'Gen.G Esports', code: 'GEN' }, ours), 'GEN');
  assert.equal(matchScheduleTeam({ name: 'BILIBILI GAMING', code: 'BLG' }, ours), 'BLG');
  assert.equal(matchScheduleTeam({ name: 'TBD', code: 'TBD' }, ours), null);
  assert.equal(matchScheduleTeam({ name: 'Unbekannt Esports', code: 'UNB' }, ours), null);
});
