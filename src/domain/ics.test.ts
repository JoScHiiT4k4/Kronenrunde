import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIcs } from './ics.ts';

const base = { now: new Date('2026-10-16T12:00:00Z'), calendarName: 'Die Rift-Runde – Kronenrunde', matchUrl: (id: string) => `https://kronenrunde.example.de/r/die-rift-runde/spiel/${id}` };

test('buildIcs: ein Termin je Spiel, UTC-Zeitstempel, CRLF-Zeilenenden', () => {
  const ics = buildIcs({
    ...base,
    matches: [
      { id: 'm1', teamA: 'Gen.G', teamB: 'T1', bestOf: 5, scheduledAt: new Date('2026-11-14T19:00:00Z'), stage: 'Finale', tournament: 'Worlds 2026' },
      { id: 'm2', teamA: 'G2', teamB: 'KC', bestOf: 3, scheduledAt: new Date('2026-10-20T17:00:00Z'), stage: null, tournament: 'Worlds 2026' },
    ],
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(ics, /UID:m1@kronenrunde\r\n/);
  assert.match(ics, /DTSTART:20261114T190000Z\r\n/);
  // Bo5 → 150 Minuten Dauer
  assert.match(ics, /DTEND:20261114T213000Z\r\n/);
  assert.match(ics, /SUMMARY:Gen\.G vs T1 \(Bo5\)\r\n/);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /DESCRIPTION:Worlds 2026 · Finale\\n\\nYouTube: https:\/\/www\.youtube\.com\/@lolesports\\nTwitch: https:\/\/www\.twitch\.tv\/riotgames\r\n/);
  // Ohne Phase kein leerer Trenner
  assert.doesNotMatch(unfolded, /DESCRIPTION:Worlds 2026 ·\\n/);
  assert.match(unfolded, /DESCRIPTION:Worlds 2026\\n\\nYouTube:/);
  // Erinnerung 1 Stunde vorher, je Termin
  assert.equal((ics.match(/BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:[^\r]+\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\nEND:VEVENT/g) ?? []).length, 2);
  // Alle Zeilen enden mit \r\n (keine nackten \n)
  assert.ok(!/[^\r]\n/.test(ics), 'nur CRLF, kein nacktes LF');
});

test('buildIcs: Sonderzeichen in Namen werden maskiert', () => {
  const ics = buildIcs({
    ...base,
    matches: [{ id: 'm3', teamA: 'Team; A, "X"', teamB: 'Team\\B', bestOf: 1, scheduledAt: new Date('2026-10-20T17:00:00Z'), stage: null, tournament: 'Test, Cup' }],
  });
  assert.match(ics, /SUMMARY:Team\\; A\\, "X" vs Team\\\\B \(Bo1\)\r\n/);
});

test('buildIcs: lange Zeilen werden nach 75 Oktetten gefaltet (RFC 5545)', () => {
  const longName = 'Ein sehr langer Teamname, der eine Zeile über fünfundsiebzig Oktette hinaus verlängert';
  const ics = buildIcs({ ...base, matches: [{ id: 'm4', teamA: longName, teamB: 'T1', bestOf: 1, scheduledAt: new Date('2026-10-20T17:00:00Z'), stage: null, tournament: 'Cup' }] });
  const summaryLines = ics.split('\r\n').filter((l, i, arr) => l.startsWith('SUMMARY:') || (i > 0 && arr[i - 1].startsWith('SUMMARY:') && l.startsWith(' ')));
  assert.ok(summaryLines.length > 1, 'SUMMARY sollte über mehrere Zeilen gefaltet sein');
  for (const l of ics.split('\r\n')) {
    if (l.startsWith('BEGIN') || l.startsWith('END')) continue;
    assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `Zeile zu lang (${Buffer.byteLength(l, 'utf8')} Oktette): ${l}`);
  }
  // Wieder zusammengesetzt (Folgezeilen beginnen mit einem Leerzeichen, das entfernt wird) ergibt den Originaltext
  // (das Komma im Namen wird nach RFC 5545 als "\," maskiert)
  const joined = ics.replace(/\r\n /g, '');
  const escapedName = longName.replace(/,/g, '\\,');
  assert.match(joined, new RegExp(`SUMMARY:${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} vs T1 \\(Bo1\\)\r\n`));
});

test('buildIcs: ohne Spiele nur Rahmen, kein VEVENT', () => {
  const ics = buildIcs({ ...base, matches: [] });
  assert.doesNotMatch(ics, /VEVENT/);
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/);
});
