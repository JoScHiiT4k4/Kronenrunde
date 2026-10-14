// Ersatz für Riots Datenquellen in Tests: Data Dragon (Champions) und lolesports.com (Teams mit Kader).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchJson } from '../abgleich.ts';

export const lolesports = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lolesports-teams.json'), 'utf8'));

/** Antworten wie Data Dragon: Versionsliste und Champion-Datei */
export function fakeRiot(champions = 120): FetchJson {
  const data: Record<string, { id: string; name: string }> = {
    MonkeyKing: { id: 'MonkeyKing', name: 'Wukong' },
    Kaisa: { id: 'Kaisa', name: "Kai'Sa" },
  };
  for (let i = 1; data && Object.keys(data).length < champions; i++) data[`Test${i}`] = { id: `Test${i}`, name: `Testchampion ${i}` };
  return async (url, headers) => {
    if (url.endsWith('/api/versions.json')) return ['16.20.1', '16.19.1'];
    if (url.includes('/cdn/16.20.1/data/de_DE/champion.json')) return { type: 'champion', version: '16.20.1', data };
    if (url.includes('/getTeams')) {
      assert.ok(headers?.['x-api-key'], 'lolesports braucht den Schlüssel im Kopf der Anfrage');
      return lolesports;
    }
    throw new Error(`Unerwartete Adresse: ${url}`);
  };
}

