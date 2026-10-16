import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shareCard } from './share-card.ts';
import type { BadgeResult } from '../../domain/badges.ts';

const badge = (over: Partial<BadgeResult> = {}): BadgeResult => ({
  key: 'volltreffer',
  title: 'Volltreffer',
  what: 'exakte Ergebnisse getippt',
  tiers: [1, 5, 15],
  value: 6,
  level: 2,
  next: 15,
  ...over,
});

const base = {
  appName: 'Kronenrunde',
  leagueName: 'Die Rift-Runde',
  displayName: 'Ben',
  avatarB64: null,
  rank: 2,
  memberCount: 12,
  points: 47,
  earnedBadges: [] as BadgeResult[],
  dateText: '16.10.2026',
};

test('shareCard: eigenständiges, gültig aussehendes 1080×1080-SVG mit den Kerndaten', () => {
  const svg = shareCard(base);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="1080" viewBox="0 0 1080 1080"/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, />Ben<\/text>/);
  assert.match(svg, />2\. Platz von 12<\/text>/);
  assert.match(svg, />47<\/text>/);
  assert.match(svg, />16\.10\.2026 · Kronenrunde<\/text>/);
});

test('shareCard: Name und Rundenname werden maskiert (kein HTML/SVG-Einschleusen)', () => {
  const svg = shareCard({ ...base, displayName: '<script>alert(1)</script>', leagueName: 'A & B' });
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(svg, /A &amp; B/);
});

test('shareCard: ohne Profilbild ein Platzhalter mit dem Anfangsbuchstaben, sonst das eingebettete Bild', () => {
  const withoutAvatar = shareCard({ ...base, avatarB64: null });
  assert.doesNotMatch(withoutAvatar, /<image /);
  assert.match(withoutAvatar, />B<\/text>/);

  const withAvatar = shareCard({ ...base, avatarB64: 'AAAA' });
  assert.match(withAvatar, /<image href="data:image\/jpeg;base64,AAAA"/);
  assert.match(withAvatar, /<clipPath id="av">/);
});

test('shareCard: ohne Abzeichen keine Abzeichen-Kacheln, mit welchen höchstens 2', () => {
  const none = shareCard({ ...base, earnedBadges: [] });
  assert.doesNotMatch(none, /badge|Bronze|Silber|Gold/i);

  const many = shareCard({
    ...base,
    earnedBadges: [badge({ title: 'Erstes', level: 3 }), badge({ title: 'Zweites', level: 2 }), badge({ title: 'Drittes', level: 1 })],
  });
  assert.match(many, />Erstes<\/text>/);
  assert.match(many, />Zweites<\/text>/);
  assert.doesNotMatch(many, />Drittes<\/text>/);
  assert.match(many, />Gold<\/text>/);
  assert.match(many, />Silber<\/text>/);
});

test('shareCard: ein einzelnes Pünktchen', () => {
  const svg = shareCard({ ...base, points: 1 });
  assert.match(svg, />Punkt<\/text>/);
  assert.doesNotMatch(svg, />Punkte<\/text>/);
});
