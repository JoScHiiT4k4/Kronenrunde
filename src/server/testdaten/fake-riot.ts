// Ersatz für Riots Datenquellen in Tests: Data Dragon (Champions) und lolesports.com (Teams mit Kader).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchJson } from '../abgleich.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const lolesports = JSON.parse(readFileSync(join(here, 'lolesports-teams.json'), 'utf8'));
/** Spielplan der Worlds 2026 (40 Spiele, Stand 14.10.2026) im Format von getSchedule */
export const worldsSchedule = JSON.parse(readFileSync(join(here, 'lolesports-schedule-worlds.json'), 'utf8'));

/** Antworten wie Data Dragon: Versionsliste und Champion-Datei */
export function fakeRiot(champions = 120, schedule = worldsSchedule): FetchJson {
  const data: Record<string, { id: string; name: string }> = {
    MonkeyKing: { id: 'MonkeyKing', name: 'Wukong' },
    Kaisa: { id: 'Kaisa', name: "Kai'Sa" },
  };
  for (let i = 1; data && Object.keys(data).length < champions; i++) data[`Test${i}`] = { id: `Test${i}`, name: `Testchampion ${i}` };
  return async (url, headers) => {
    if (url.endsWith('/api/versions.json')) return ['16.20.1', '16.19.1'];
    if (url.includes('/cdn/16.20.1/data/de_DE/champion.json')) return { type: 'champion', version: '16.20.1', data };
    if (url.includes('/getLeagues')) return { data: { leagues: [{ id: '98767975604431411', slug: 'worlds', name: 'WM' }, { id: '1', slug: 'lec', name: 'LEC' }] } };
    if (url.includes('/getSchedule')) {
      // Zwei Seiten wie bei lolesports: die zweite über pages.newer
      assert.ok(url.includes('leagueId=98767975604431411'));
      const events = schedule.data.schedule.events;
      const second = url.includes('pageToken=seite2');
      return {
        data: {
          schedule: {
            pages: { older: second ? null : 'seite0', newer: second ? null : 'seite2' },
            events: second ? events.slice(25) : events.slice(0, 25),
          },
        },
      };
    }
    if (url.includes('/getTeams')) {
      assert.ok(headers?.['x-api-key'], 'lolesports braucht den Schlüssel im Kopf der Anfrage');
      return lolesports;
    }
    throw new Error(`Unerwartete Adresse: ${url}`);
  };
}

