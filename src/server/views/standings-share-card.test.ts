import assert from 'node:assert/strict';
import { test } from 'node:test';
import { standingsShareCard, type StandingsShareRow } from './standings-share-card.ts';

const row = (rank: number, displayName: string, points: number): StandingsShareRow => ({ rank, displayName, points });

const base = {
  appName: 'Kronenrunde',
  leagueName: 'Die Rift-Runde',
  rows: [row(1, 'Anna', 47), row(2, 'Ben', 44), row(3, 'Clara', 40)],
  memberCount: 3,
  dateText: '16.10.2026',
};

test('standingsShareCard: eigenständiges, gültig aussehendes 1080×1080-SVG mit allen Zeilen', () => {
  const svg = standingsShareCard(base);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="1080" viewBox="0 0 1080 1080"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, />Rangliste – Die Rift-Runde<\/text>/);
  assert.match(svg, />Anna<\/text>/);
  assert.match(svg, />Ben<\/text>/);
  assert.match(svg, />Clara<\/text>/);
  assert.match(svg, />47<\/text>/);
  assert.match(svg, />16\.10\.2026 · Kronenrunde<\/text>/);
});

test('standingsShareCard: Namen und Rundenname werden maskiert (kein HTML/SVG-Einschleusen)', () => {
  const svg = standingsShareCard({ ...base, leagueName: 'A & B', rows: [row(1, '<script>alert(1)</script>', 9)] });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(svg, /A &amp; B/);
});

test('standingsShareCard: höchstens 10 Zeilen, Rest als Hinweis "+ N weitere"', () => {
  const many = Array.from({ length: 14 }, (_, i) => row(i + 1, `Spieler ${i + 1}`, 50 - i));
  const svg = standingsShareCard({ ...base, rows: many, memberCount: 14 });
  assert.match(svg, />Spieler 10<\/text>/);
  assert.doesNotMatch(svg, />Spieler 11<\/text>/);
  assert.match(svg, />\+ 4 weitere<\/text>/);
});

test('standingsShareCard: ohne weitere Mitglieder kein Hinweis', () => {
  const svg = standingsShareCard(base);
  assert.doesNotMatch(svg, /weitere/);
});
